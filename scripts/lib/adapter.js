#!/usr/bin/env node
/**
 * CLI 适配层 —— 让流水线编排器运行在任意宿主的 agent CLI 之上（零 npm 依赖，Node >= 18）
 *
 * 内置适配器（命令行参数方言）：
 *   codebuddy  CodeBuddy / WorkBuddy CLI（原生 --agent/--agents 多代理、--fallback-model 回退）
 *   claude     Claude Code CLI（--append-system-prompt 注入角色系统提示词）
 *   codex      OpenAI Codex CLI（codex exec 非交互，角色提示词拼入任务头部）
 *   plain      任意自定义命令（宿主默认命令或 plain.command，提示词走参数或 stdin）
 *
 * 宿主与适配器分离：
 *   host    当前加载 skill 的 IDE（AGENT_PIPELINE_HOST），决定调用哪个 CLI 命令与读哪份模型配置
 *   adapter 参数方言（AGENT_PIPELINE_ADAPTER / --adapter / cli.json）
 *   hostCommands 把 workbuddy / zcode / qoder / marvis 映射到方言与默认命令，可在 cli.json 覆盖
 *
 * 选择顺序：AGENT_PIPELINE_HOST（显式宿主）> AGENT_PIPELINE_ADAPTER / --adapter（显式方言）
 *          > 跨运行轮询（本机探测到的全部 CLI 轮流选用，游标写 rotation.stateFile）。
 * 轮询解决「装了多个 CLI 却永远命中 autoDetect 第一项」：池内每个 CLI 都会成为某次运行的主角，
 * 而单次运行仍只用一个适配器（流水线级约束不变）。
 * 统一接口：
 *   runner.name / label() / probe() / run(opts) / extraModels() / supportsFallbackFlag
 *   runner.host = { key, bin, adapter, poolKeys, index, total }（池大小与本次位次，供编排层打印）
 *   run(opts)：opts = { prompt, agentId, agentDef, agentsJson, model, fallbackModel,
 *                      cwd, timeoutMs, permissions, outputFormat }
 *   classifyFailure(result, text)：把失败判为 timeout/quota/model-unavailable/connection，
 *   命中即可换下一个候选模型；ENOENT 等「CLI 本身不可用」不返回可切换类别。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

// ---------- 默认配置 ----------
const DEFAULTS = {
  adapter: 'auto',
  host: 'auto',
  autoDetect: ['codebuddy', 'cbc', 'workbuddy', 'zcode', 'qoder', 'marvis', 'claude', 'codex'],
  timeoutMs: 600000,
  // 单个「显式命名的模型」的尝试上限：卡死的自定义模型到此即判失败换下一个候选，
  // 不必等完整阶段超时。auto / 不指定模型（用 CLI 自带模型）不受此限，独占 timeoutMs。
  modelAttemptTimeoutMs: 180000,
  permissions: 'skip',
  outputFormat: 'text',
  plain: { command: '', promptMode: 'arg', extraArgs: [] },
  // 跨运行轮询：stateFile 由编排层注入到 --work-dir 下（安装目录可能只读）
  rotation: { enabled: true, stateFile: 'cli-rotation.json' },
  // WorkBuddy 内置 CLI 与 CodeBuddy 同源，复用 codebuddy 方言；
  // zCode / Qoder / Marvis 未提供等价的多代理参数，默认用 plain（角色提示词拼进 prompt）。
  // autoDetect 顺序即轮询池顺序；claude / codex 不在 hostCommands 内，由 autoDetect 兜底探测。
  hostCommands: {
    codebuddy: { commands: ['codebuddy', 'cbc'], env: 'CODE_BUDDY_CMD', adapter: 'codebuddy', configDir: '.codebuddy' },
    cbc: { commands: ['cbc'], env: 'CODE_BUDDY_CMD', adapter: 'codebuddy', configDir: '.codebuddy' },
    workbuddy: { commands: ['workbuddy'], env: 'WORK_BUDDY_CMD', adapter: 'codebuddy', configDir: '.workbuddy' },
    zcode: { commands: ['zcode'], env: 'ZCODE_CLI_CMD', adapter: 'plain', configDir: '.zcode' },
    qoder: { commands: ['qoder', 'qoder-cli'], env: 'QODER_CLI_CMD', adapter: 'plain', configDir: '.qoder' },
    marvis: { commands: ['marvis'], env: 'MARVIS_CLI_CMD', adapter: 'plain', configDir: '.marvis' },
  },
};

function loadCliConfig(root, cliConfigPath, overrides) {
  let fileCfg = {};
  const p = cliConfigPath || path.join(root, 'config', 'cli.json');
  try {
    fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* 配置缺失/损坏时使用默认值 */ }
  // 过滤 undefined，避免覆盖文件配置中的有效值
  const ov = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null) ov[k] = v;
  }
  const cfg = Object.assign({}, DEFAULTS, fileCfg, ov);
  cfg.plain = Object.assign({}, DEFAULTS.plain, fileCfg.plain || {}, ov.plain || {});
  cfg.rotation = Object.assign({}, DEFAULTS.rotation, fileCfg.rotation || {}, ov.rotation || {});
  cfg.hostCommands = Object.assign({}, DEFAULTS.hostCommands, fileCfg.hostCommands || {}, ov.hostCommands || {});
  return cfg;
}

// ---------- 跨平台探测与执行 ----------
function which(bin) {
  try {
    const probe = process.platform === 'win32'
      ? spawnSync('where', [bin], { encoding: 'utf8' })
      : spawnSync('which', [bin], { encoding: 'utf8' });
    return probe.status === 0 && (probe.stdout || '').trim().length > 0;
  } catch (e) { return false; }
}

// Windows：npm 全局包的 .cmd 包装器不能被 spawn 直接执行，改为用 node 直跑 JS 入口
function resolveNodeEntry(pkgName, binNames) {
  if (process.platform !== 'win32') return null;
  try {
    const globalRoot = execSync('npm root -g', {
      encoding: 'utf8',
      shell: process.env.ComSpec || 'cmd.exe',
    }).trim();
    const pkgDir = path.join(globalRoot, pkgName);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin && binNames.map((b) => pkg.bin[b]).find(Boolean));
    const entry = bin ? path.join(pkgDir, bin) : '';
    if (entry && fs.existsSync(entry)) return { node: process.execPath, entry };
  } catch (e) { /* 忽略，回退 .cmd */ }
  return null;
}

function shellQuote(a) {
  return /[\s"^&|<>%]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

// 统一执行入口：binSpec 为字符串命令或 { node, entry }（Windows node 直跑）
function spawnCli(binSpec, args, opts) {
  const base = {
    encoding: 'utf8',
    timeout: (opts && opts.timeoutMs) || 0,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts && opts.cwd,
    input: opts && opts.input,
  };
  if (typeof binSpec === 'object' && binSpec.node) {
    return spawnSync(binSpec.node, [binSpec.entry].concat(args), base);
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binSpec)) {
    const line = [binSpec].concat(args).map(shellQuote).join(' ');
    return spawnSync(line, Object.assign({}, base, { shell: true }));
  }
  return spawnSync(binSpec, args, base);
}

// ---------- 失败分类：命中即可换下一个候选模型继续跑 ----------
// 文本判定配合 failureText 的 stderr 优先裁剪，避免把角色产物里的关键词当成 CLI 失败。
const FAILURE_PATTERNS = {
  quota: /quota|rate\s*limit|429|too many requests|insufficient|overload|limit\s*exceeded|过载|限额|超限|额度不足/i,
  timeout: /\betimedout\b|\btime[d]?\s*-?\s*out\b|deadline\s+exceeded|i\/o\s+timeout|超时/i,
  modelUnavailable: /model[^.\n]{0,32}?(?:not\s*found|not\s*available|unavailable|does\s*not\s*exist|is\s*invalid)'?|(?:invalid|unknown|unsupported|no\s+such)[^.\n]{0,16}?model|模型(?:不存在|不可用|未找到|不支持|已下架)|参数(?:错误|非法|校验失败)/i,
  connection: /econnrefused|econnreset|econnaborted|ehostunreach|enetunreach|epipe|enotfound|eai_again|socket\s*hang\s*up|connection\s+(?:refused|reset|closed)|bad\s*gateway|service\s+(?:temporarily\s+)?unavailable|gateway\s+time-?out|internal\s+server\s+error|连接(?:失败|被重置|中断)|网络(?:异常|错误|不可达)/i,
};
// 5xx 需带上下文词，避免把产物里的「500 条记录」当成网关错误
const HTTP_5XX = /\b(?:http|https|status|code|error|resp)[\s:/=#-]*50[0234]\b|\b50[234]\s+(?:bad\s*gateway|service|gateway)/i;
const FAILURE_LABELS = {
  timeout: '超时',
  quota: '限额/过载',
  'model-unavailable': '模型不可用/参数错',
  connection: '连接异常',
};

function isQuotaError(text) {
  return FAILURE_PATTERNS.quota.test(text || '');
}

/**
 * 判定一次 CLI 调用失败是否值得换模型重试。
 * @returns {'timeout'|'quota'|'model-unavailable'|'connection'|null} null=换模型无意义，按阶段失败处理
 */
function classifyFailure(result, text) {
  const r = result || {};
  const code = String((r.error && r.error.code) || '');
  // CLI 本身跑不起来（未安装 / 无权限）：换候选模型不会有任何改善
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return null;
  if (code === 'ETIMEDOUT') return 'timeout';
  if (FAILURE_PATTERNS.connection.test(code)) return 'connection';
  // spawnSync 超时用 killSignal（默认 SIGTERM）终止子进程，status 为 null
  if (r.status === null && r.signal === 'SIGTERM') return 'timeout';
  // 其他信号（SIGINT/SIGKILL）多为人为中断，不自动切换
  if (r.status === null && r.signal) return null;
  const tail = String(text || '');
  if (FAILURE_PATTERNS.timeout.test(tail)) return 'timeout';
  if (FAILURE_PATTERNS.quota.test(tail)) return 'quota';
  if (FAILURE_PATTERNS.modelUnavailable.test(tail) || HTTP_5XX.test(tail)) return 'model-unavailable';
  if (FAILURE_PATTERNS.connection.test(tail)) return 'connection';
  return null;
}

// 供编排层裁剪扫描文本：stderr 有内容时只信 stderr——stdout 多半是角色产物，
// 里面出现 timeout / 超时 / connection refused 并不代表 CLI 失败。
function failureText(stderr, stdout) {
  const err = String(stderr || '').trim();
  if (err) return err.length > 4000 ? err.slice(err.length - 4000) : err;
  const out = String(stdout || '').trim();
  // 只有短 stdout 才当作 CLI 自身的报错；长 stdout 是产物，不参与关键词判定
  return out.length > 1500 ? '' : out;
}

// ---------- 自定义模型候选：优先读当前宿主配置目录，再回退 CodeBuddy ----------
function loadCodebuddyCustomModels(cfg) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const dirs = [];
  if (cfg && cfg.hostConfigDir) dirs.push(cfg.hostConfigDir);
  dirs.push('.codebuddy');
  const out = [];
  for (const dir of dirs) {
    const p = path.join(home, dir, 'models.json');
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const m of (data.models || [])) {
        if (!m || !m.id) continue;
        const id = m.id.startsWith('custom-local:') ? m.id : 'custom-local:' + m.id;
        if (!out.includes(id)) out.push(id);
      }
    } catch (e) { /* 单份配置损坏不影响其余 */ }
  }
  return out;
}

// ---------- 宿主池探测与跨运行轮询 ----------
// 探测只依据宿主专属环境变量与系统命令；通用 AGENT_CLI_CMD 不参与，
// 否则一旦设置它，所有宿主都会被误判为可用。
const STANDALONE_HOSTS = {
  claude: { env: 'CLAUDE_CLI_CMD', configDir: '.claude' },
  codex: { env: 'CODEX_CLI_CMD', configDir: '.codex' },
};

function resolveHostBin(def) {
  if (def.env && process.env[def.env]) return process.env[def.env];
  for (const c of def.commands || []) if (which(c)) return c;
  return null;
}

function hostPack(key, def, bin) {
  return { key, bin, adapter: def.adapter || 'plain', configDir: def.configDir || '', env: def.env || '' };
}

// 本机装了哪些 agent CLI：按 autoDetect 顺序**全部**列出（旧实现命中第一个就返回，
// 于是 codebuddy 永远霸占，其他 CLI 再装也不会被调用）。
// 别名按「方言 + 宿主专属环境变量」去重：codebuddy 与 cbc 共用 CODE_BUDDY_CMD，只算一个池位。
function detectHosts(cfg) {
  const map = cfg.hostCommands || {};
  const out = [];
  const seen = new Set();
  for (const cand of cfg.autoDetect || DEFAULTS.autoDetect) {
    let pack = null;
    if (map[cand]) {
      const bin = resolveHostBin(map[cand]);
      if (bin) pack = hostPack(cand, map[cand], bin);
    } else if (STANDALONE_HOSTS[cand]) {
      const def = STANDALONE_HOSTS[cand];
      const bin = (process.env[def.env] || '').trim() || (which(cand) ? cand : null);
      if (bin) pack = hostPack(cand, { adapter: cand, configDir: def.configDir, env: def.env }, bin);
    }
    if (!pack) continue;
    const id = pack.adapter + '|' + (pack.env || pack.bin);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(pack);
  }
  return out;
}

// 显式声明宿主时即使命令不存在也返回，便于后续给出明确的路径配置提示
function resolveExplicitHost(cfg, requested) {
  const map = cfg.hostCommands || {};
  if (map[requested]) return hostPack(requested, map[requested], resolveHostBin(map[requested]));
  const standalone = STANDALONE_HOSTS[requested];
  if (standalone) {
    const bin = (process.env[standalone.env] || '').trim() || (which(requested) ? requested : null);
    return hostPack(requested, { adapter: requested, configDir: standalone.configDir, env: standalone.env }, bin);
  }
  return null;
}

function readRotationState(file) {
  if (!file) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : null;
  } catch (e) { return null; } // 缺失/损坏都退回从池首开始
}

function writeRotationState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  } catch (e) { /* 游标写失败只影响下次起点，不阻断本次运行 */ }
}

// 轮询游标存在 rotation.stateFile（编排层注入到 --work-dir）。用自增 cursor 取模，
// 用户增删 CLI 导致池大小变化时仍能均匀铺开。
function pickHost(cfg, pool) {
  const rot = cfg.rotation || {};
  const meta = { pool: pool.map((h) => h.key), total: pool.length, index: -1, rotated: false };
  if (!pool.length) return Object.assign(meta, { host: null });
  if (!rot.enabled || pool.length === 1) return Object.assign(meta, { host: pool[0], index: 0 });
  const state = readRotationState(rot.stateFile);
  const prev = Number.isInteger(state && state.cursor) ? state.cursor : 0;
  const index = ((prev % pool.length) + pool.length) % pool.length;
  const picked = pool[index];
  const uses = Object.assign({}, (state && state.uses) || {});
  uses[picked.key] = (uses[picked.key] || 0) + 1;
  writeRotationState(rot.stateFile, {
    updatedAt: new Date().toISOString(),
    cursor: index + 1,
    lastKey: picked.key,
    lastAdapter: picked.adapter,
    pool: meta.pool,
    uses,
  });
  return Object.assign(meta, { host: picked, index, rotated: true });
}

function resolveAdapterName(cfg, host) {
  const forced = process.env.AGENT_PIPELINE_ADAPTER || cfg.adapter;
  if (forced && forced !== 'auto') return forced;
  return host ? host.adapter : null;
}

// 角色提示词头部（无原生角色机制的适配器使用）
function roleHeader(agentDef) {
  return agentDef && agentDef.prompt
    ? `# 角色设定\n${agentDef.prompt}\n\n# 任务\n`
    : '';
}

// ---------- 各适配器 ----------
function codebuddyRunner(cfg) {
  function bin() {
    // 宿主探测命中的命令优先（如 WorkBuddy 的 workbuddy / cbc 别名）
    if (cfg && cfg.hostBin) return cfg.hostBin;
    const envCmd = process.env.CODE_BUDDY_CMD || process.env.AGENT_CLI_CMD;
    if (envCmd) return envCmd;
    const entry = resolveNodeEntry('@tencent-ai/codebuddy-code', ['codebuddy', 'cbc']);
    if (entry) return entry;
    if (process.platform === 'win32') {
      if (which('codebuddy.cmd')) return 'codebuddy.cmd';
      if (which('cbc.cmd')) return 'cbc.cmd';
      return 'codebuddy.cmd';
    }
    return which('codebuddy') ? 'codebuddy' : (which('cbc') ? 'cbc' : 'codebuddy');
  }
  function build(o) {
    const args = [];
    if (o.agentId) args.push('--agent', o.agentId, '--agents', o.agentsJson || '{}');
    args.push('-p', o.prompt, '--output-format', o.outputFormat || 'text');
    if (o.model && o.model !== 'auto') args.push('--model', o.model);
    if (o.fallbackModel && o.fallbackModel !== 'auto') args.push('--fallback-model', o.fallbackModel);
    if (o.permissions !== 'ask') args.push('--dangerously-skip-permissions');
    return args;
  }
  return {
    name: 'codebuddy',
    supportsFallbackFlag: true,
    capabilities: { model: true, agents: true },
    extraModels: () => loadCodebuddyCustomModels(cfg),
    label() { const b = bin(); return typeof b === 'object' ? `${b.node} ${b.entry}` : b; },
    probe() { return spawnCli(bin(), ['--version'], { timeoutMs: 15000 }); },
    run(o) { return spawnCli(bin(), build(o), { cwd: o.cwd, timeoutMs: o.timeoutMs }); },
  };
}

function claudeRunner() {
  function bin() {
    const envCmd = process.env.CLAUDE_CLI_CMD || process.env.AGENT_CLI_CMD;
    if (envCmd) return envCmd;
    const entry = resolveNodeEntry('@anthropic-ai/claude-code', ['claude']);
    if (entry) return entry;
    if (process.platform === 'win32') return which('claude.cmd') ? 'claude.cmd' : 'claude.cmd';
    return 'claude';
  }
  function build(o) {
    const args = ['-p', o.prompt, '--output-format', 'text'];
    if (o.agentDef && o.agentDef.prompt) args.push('--append-system-prompt', o.agentDef.prompt);
    if (o.agentDef && o.agentDef.maxTurns) args.push('--max-turns', String(o.agentDef.maxTurns));
    if (o.model && o.model !== 'auto') args.push('--model', o.model);
    if (o.permissions !== 'ask') args.push('--dangerously-skip-permissions');
    return args;
  }
  return {
    name: 'claude',
    supportsFallbackFlag: false,
    capabilities: { model: true, agents: false },
    extraModels() { return []; },
    label() { const b = bin(); return typeof b === 'object' ? `${b.node} ${b.entry}` : b; },
    probe() { return spawnCli(bin(), ['--version'], { timeoutMs: 15000 }); },
    run(o) { return spawnCli(bin(), build(o), { cwd: o.cwd, timeoutMs: o.timeoutMs }); },
  };
}

function codexRunner() {
  function bin() {
    const envCmd = process.env.CODEX_CLI_CMD || process.env.AGENT_CLI_CMD;
    if (envCmd) return envCmd;
    if (process.platform === 'win32') return which('codex.cmd') ? 'codex.cmd' : 'codex.cmd';
    return 'codex';
  }
  function build(o) {
    // --skip-git-repo-check：新项目目录尚未 git init 时，codex exec 默认会拒绝执行
    const args = ['exec', '--skip-git-repo-check'];
    if (o.permissions !== 'ask') args.push('--full-auto');
    if (o.model && o.model !== 'auto') args.push('-m', o.model);
    args.push(roleHeader(o.agentDef) + o.prompt);
    return args;
  }
  return {
    name: 'codex',
    supportsFallbackFlag: false,
    capabilities: { model: true, agents: false },
    extraModels() { return []; },
    label() { return bin(); },
    probe() { return spawnCli(bin(), ['--version'], { timeoutMs: 15000 }); },
    run(o) { return spawnCli(bin(), build(o), { cwd: o.cwd, timeoutMs: o.timeoutMs }); },
  };
}

function plainRunner(cfg) {
  const plain = cfg.plain || {};
  // 宿主默认命令优先，其次才是用户手填的 plain.command
  const cmdStr = String(cfg.hostBin || plain.command || '').trim();
  if (!cmdStr) {
    throw new Error('未找到可用的宿主 agent CLI：请在 config/cli.json 配置 plain.command（如 "my-agent --run"），'
      + '或设置对应宿主的 *_CLI_CMD 环境变量；当前 host=' + (cfg.hostKey || 'auto'));
  }
  const parts = cmdStr.split(/\s+/);
  const binSpec = parts[0];
  const baseArgs = parts.slice(1).concat(plain.extraArgs || []);
  const stdinMode = plain.promptMode === 'stdin';
  return {
    name: 'plain',
    supportsFallbackFlag: false,
    capabilities: { model: false, agents: false },
    extraModels() { return []; },
    label() { return [binSpec].concat(baseArgs).join(' ') + (stdinMode ? ' (prompt via stdin)' : ''); },
    probe() { return spawnCli(binSpec, ['--version'], { timeoutMs: 15000 }); },
    run(o) {
      const finalPrompt = roleHeader(o.agentDef) + o.prompt;
      if (stdinMode) {
        return spawnCli(binSpec, baseArgs, { cwd: o.cwd, timeoutMs: o.timeoutMs, input: finalPrompt });
      }
      return spawnCli(binSpec, baseArgs.concat([finalPrompt]), { cwd: o.cwd, timeoutMs: o.timeoutMs });
    },
  };
}

// ---------- 工厂 ----------
function availableHosts(cfg) {
  return Object.keys(DEFAULTS.hostCommands)
    .concat(Object.keys((cfg && cfg.hostCommands) || {}))
    .concat(Object.keys(STANDALONE_HOSTS))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

function rotationMeta(pool, index, rotated, reason) {
  return { pool: pool.map((h) => h.key), total: pool.length, index, rotated, reason };
}

function createRunner(cfg) {
  const pool = detectHosts(cfg);
  const requested = String(process.env.AGENT_PIPELINE_HOST || cfg.host || 'auto').toLowerCase();
  const forced = process.env.AGENT_PIPELINE_ADAPTER || cfg.adapter;
  let host = null;
  let rotation;

  if (requested !== 'auto') {
    // 显式点名宿主时不参与轮询
    host = resolveExplicitHost(cfg, requested);
    if (host) {
      rotation = rotationMeta(pool, pool.findIndex((h) => h.key === requested), false, 'explicit-host');
    } else {
      cfg.hostWarning = `AGENT_PIPELINE_HOST=${requested} 不是已知宿主，已忽略该声明改用自动选择。可用宿主：${availableHosts(cfg).join(' / ')}。`;
      const picked = pickHost(cfg, pool);
      host = picked.host;
      rotation = rotationMeta(pool, picked.index, picked.rotated, 'round-robin');
    }
  } else if (forced && forced !== 'auto') {
    // 显式点名方言时不参与轮询；池中无该方言时由 runner 自行回退到默认命令
    const at = pool.findIndex((h) => h.adapter === forced);
    host = at === -1 ? null : pool[at];
    rotation = rotationMeta(pool, at, false, 'explicit-adapter');
  } else {
    const picked = pickHost(cfg, pool);
    host = picked.host;
    rotation = rotationMeta(pool, picked.index, picked.rotated,
      pool.length > 1 ? 'round-robin' : (pool.length ? 'single' : 'none'));
  }

  const name = resolveAdapterName(cfg, host);
  if (!name) {
    throw new Error('未探测到受支持的 agent CLI'
      + '（codebuddy/cbc/workbuddy/zcode/qoder/marvis/claude/codex）。'
      + '请安装其一，或设置 AGENT_PIPELINE_HOST / AGENT_PIPELINE_ADAPTER=plain'
      + ' 并在 config/cli.json 填写 plain.command');
  }
  // 仅当宿主映射的方言与实际适配器一致时注入宿主命令，
  // 避免把 plain 方言的命令塞给 codebuddy 参数（或反之）。
  cfg.hostBin = (host && host.adapter === name) ? host.bin : null;
  cfg.hostConfigDir = host ? host.configDir : '';
  cfg.hostKey = host ? host.key : '';
  let runner;
  switch (name) {
    case 'codebuddy': runner = codebuddyRunner(cfg); break;
    case 'claude': runner = claudeRunner(cfg); break;
    case 'codex': runner = codexRunner(cfg); break;
    case 'plain': runner = plainRunner(cfg); break;
    default: throw new Error('未知适配器：' + name + '（可用：codebuddy/claude/codex/plain）');
  }
  runner.rotation = rotation;
  return runner;
}

module.exports = {
  loadCliConfig, createRunner, detectHosts, resolveAdapterName, pickHost,
  isQuotaError, classifyFailure, failureText, FAILURE_LABELS,
  spawnCli, which, DEFAULTS,
};
