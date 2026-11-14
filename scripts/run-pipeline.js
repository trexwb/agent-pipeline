#!/usr/bin/env node
/**
 * 多 Agent 流水线主编排器（便携版）—— 通过 CLI 适配层运行在任意 agent 环境
 *
 * 用法：
 *   node scripts/run-pipeline.js --project-name demo-app [--dry-run]
 *   node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test
 *   node scripts/run-pipeline.js --project-name demo-app --interactive          # 交互引导（confirm 阶段暂停审阅）
 *   node scripts/run-pipeline.js --project-name demo-app --remote               # 远程确认（confirm 后写状态文件并 exit 42）
 *   node scripts/run-pipeline.js --project-name demo-app --from 03-architecture --amend "修订意见"
 *   node scripts/run-pipeline.js --project-name demo-app --project-dir ./app \
 *     --pipeline fix --requirement "登录页 Safari 下提交报错"                    # 修复流水线（5 阶段）
 *
 * 原理：按所选流水线（--pipeline feature|fix，或 --pipeline-config 指定配置）阶段顺序，
 *       每阶段经适配器（codebuddy/claude/codex/plain）调用一次 agent CLI，
 *       组装 prompt（模板 + 前序产物上下文 + 修订意见）→ 执行 → 产物落盘 artifacts/；
 *       配置含 retry 块时，验证阶段产物命中失败标记自动回炉重修（--fix-rounds 覆盖轮数）；
 *       角色知识库（默认开启）：执行时注入该角色历史经验，完成后从回复末尾抽取
 *       KNOWLEDGE APPEND 标记段沉淀新知识（--knowledge-dir 指定目录，--no-knowledge 关闭）；
 *       角色记忆（默认开启）：任务过程上下文（执行摘要/交接便签/用户修订意见自动入记忆），
 *       重跑同阶段自动带出，写在 <work-dir>/memory/（--no-memory 关闭）；
 *       动态委托（默认开启）：角色可声明本阶段更适合其他角色执行（DELEGATE 标记段），
 *       编排器自动换目标角色重跑本阶段，每阶段最多一次（--no-delegate 关闭）。
 * 可移植性：零 npm 依赖；路径全部相对 skill 根或 --work-dir；无平台硬编码；
 *          --work-dir 可把产物/日志/自定义模板与 config 放到任意工作目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const adapter = require('./lib/adapter');

const ROOT = path.resolve(__dirname, '..');

// 角色知识库：子 Agent 在回复末尾用该标记段沉淀新知识，编排器抽取后追加进 knowledge/<agent>.md
const KNOWLEDGE_INJECT_LIMIT = 4000; // 单角色注入 prompt 的历史知识上限（取文件末尾，最近经验最相关）
const KNOWLEDGE_BLOCK_RE = /===== KNOWLEDGE APPEND =====\r?\n([\s\S]*?)===== KNOWLEDGE END =====/g;
// 角色记忆：summary/handoff 两行式标记段，编排器解析后分别写 memory/<agent>.md 与 memory/handoffs.md
const MEMORY_BLOCK_RE = /===== MEMORY APPEND =====\r?\n([\s\S]*?)===== MEMORY END =====/g;
const MEMORY_HANDOFF_LIMIT = 2000; // 前序交接便签注入上限（取文件末尾）
// 动态委托：target/reason/handoff 标记段，编排器换目标角色重跑本阶段
const DELEGATE_BLOCK_RE = /===== DELEGATE =====\r?\n([\s\S]*?)===== DELEGATE END =====/g;
const DELEGATE_MAX_HOPS = 1; // 每阶段最多换一次执行角色，防 A→B→A 循环

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function replacePlaceholders(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

function usage() {
  console.log(`多 Agent 流水线编排器（便携版）

用法：node scripts/run-pipeline.js --project-name <项目名> [选项]

选项：
  --project-name <n>    必填。项目名，注入各阶段 prompt 的 {projectName}
  --project-dir <dir>   项目代码目录（开发/测试/部署阶段的工作目录）
  --project-root <dir>  项目根目录；--project-dir 缺省时取 <project-root>/<project-name>，默认当前目录
  --work-dir <dir>      工作目录：artifacts/、logs/ 与自定义模板/配置的根，默认当前目录
  --pipeline <name>     流水线预设：feature=开发流水线（默认，config/pipeline.json）；
                        fix=修复流水线（config/issue-pipeline.json）。与 --pipeline-config 互斥
  --requirement "<文本>" 需求原文，写入 artifacts/00-requirement.md 作为首个阶段的输入
                        （新功能需求与修复需求通用；已有该文件时会被覆盖）
  --from <stageId>      起始阶段 id，默认第一个阶段
  --to <stageId>        结束阶段 id，默认最后一个阶段
  --interactive         交互模式：confirm 阶段产出后暂停审阅，可输入修订意见重跑
  --remote              远程确认模式：confirm 阶段产出后写 artifacts/.confirm-state.json 并 exit 42
  --init-only           只跑前置段（到最后一个需确认的阶段）即退出
  --amend "<意见>"      把修订意见追加进 --from 指定阶段重新生成产物
  --fix-rounds <n>      修复回炉轮数，覆盖流水线配置 retry.maxRounds；0=关闭回炉
  --knowledge-dir <dir> 角色知识库目录（执行时注入历史经验、完成后沉淀新知识），
                        默认 <work-dir>/knowledge；指向固定目录可跨项目积累
  --no-knowledge        关闭角色知识库（不注入、不沉淀）
  --no-memory           关闭角色记忆（任务过程上下文：执行摘要/交接便签/用户修订入记忆）
  --no-delegate         关闭动态委托（角色声明本阶段更适合其他角色时换角色重跑）
  --dry-run             只打印将要执行的命令，不真正调用 CLI
  --pipeline-config <p> 流水线配置路径，默认 config/pipeline.json（与 --pipeline 互斥）
  --agents-config <p>   子代理配置路径，默认 config/agents.json
  --cli-config <p>      CLI 适配配置路径，默认 config/cli.json
  --adapter <name>      强制指定适配器（codebuddy/claude/codex/plain），覆盖配置
  --timeout-ms <n>      单阶段 CLI 超时毫秒数，覆盖 cli.json 的 timeoutMs

宿主环境变量：
  AGENT_PIPELINE_HOST      声明当前宿主（workbuddy/codebuddy/zcode/qoder/marvis）
  AGENT_PIPELINE_ADAPTER   强制适配器，优先级高于 --adapter
  *_CLI_CMD                覆盖宿主 CLI 路径（CODE_BUDDY_CMD/WORK_BUDDY_CMD/
                           ZCODE_CLI_CMD/QODER_CLI_CMD/MARVIS_CLI_CMD 等）

演练模式（--dry-run）下若未探测到宿主 CLI，只告警不退出，仍可校验阶段与提示词配置。`);
}

// 演练占位 runner：本机没有可用 agent CLI 时，仍能校验阶段链、提示词与参数组装
function dryRunRunner(reason) {
  return {
    name: 'plain',
    placeholder: true,
    reason,
    label: () => '<未探测到 agent CLI>',
    capabilities: { model: false, agents: false },
    supportsFallbackFlag: false,
    extraModels: () => [],
    probe: () => ({ status: 0 }),
    run: () => ({ status: 1, stderr: reason }),
  };
}

// ---------- 主编排 ----------
// 流水线预设：修复需求（现有功能故障/报错/行为不符）走 fix 五阶段，不必先提 GitHub Issue
const PIPELINE_PRESETS = {
  feature: 'config/pipeline.json',
  fix: 'config/issue-pipeline.json',
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectName = args['project-name'];
  if (!projectName) { usage(); process.exit(1); }

  // 流水线选择：--pipeline 预设与 --pipeline-config 完整路径互斥
  let pipelineConfigRel = args['pipeline-config'] || 'config/pipeline.json';
  if (args.pipeline !== undefined) {
    if (args['pipeline-config']) {
      console.error('错误：--pipeline 与 --pipeline-config 不可同时使用（前者是预设名，后者是完整配置路径）。');
      process.exit(1);
    }
    const preset = PIPELINE_PRESETS[args.pipeline];
    if (!preset) {
      console.error(`错误：--pipeline 取值应为 ${Object.keys(PIPELINE_PRESETS).join(' | ')}，收到：${args.pipeline}`);
      process.exit(1);
    }
    pipelineConfigRel = preset;
  }

  // 工作目录：artifacts/logs/确认状态的根；默认当前目录，与 skill 安装目录分离（安装目录可只读）
  const workRoot = path.resolve(args['work-dir'] || process.cwd());
  const projectRoot = args['project-root'] || process.cwd();
  const projectDir = args['project-dir'] || path.join(projectRoot, projectName);
  fs.mkdirSync(projectDir, { recursive: true });

  // 角色知识库：执行时注入历史经验、完成后沉淀新知识；--no-knowledge 全局关闭
  const knowledgeOff = !!args['no-knowledge'];
  const knowledgeDir = knowledgeOff ? null : path.resolve(args['knowledge-dir'] || path.join(workRoot, 'knowledge'));
  // 角色记忆：任务过程上下文（执行摘要/交接便签/用户修订意见），目录固定 <work-dir>/memory
  const memoryOff = !!args['no-memory'];
  const memoryDir = memoryOff ? null : path.join(workRoot, 'memory');
  // 动态委托：角色声明本阶段更适合其他角色执行时，编排器换角色重跑本阶段
  const delegateOn = !args['no-delegate'];

  // 资产解析：--work-dir 下的同名模板/配置优先（允许运行时定制覆盖），其次 skill 内置资产
  const resolveAsset = (rel) => {
    if (path.isAbsolute(rel)) return rel;
    const inWork = path.join(workRoot, rel);
    if (fs.existsSync(inWork)) return inWork;
    return path.join(ROOT, rel);
  };
  // 产物路径：始终基于工作目录（跨运行隔离、可移植）
  const resolveWork = (rel) => (path.isAbsolute(rel) ? rel : path.join(workRoot, rel));

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      const logsDir = path.join(workRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(path.join(logsDir, 'pipeline.log'), line + '\n');
    } catch (e) { /* 日志失败不中断 */ }
  };

  // ---------- 角色协作上下文：记忆 + 知识库 + 标记段协议 + 动态委托 ----------
  // 记忆·本阶段：memory/<agent>.md 中匹配当前 stageId 的段落（上次执行摘要、用户曾给的修订意见）
  function memoryStageBlock(agentId, stage) {
    let content = '';
    try { content = fs.readFileSync(path.join(memoryDir, `${agentId}.md`), 'utf8'); } catch (e) { return ''; }
    const sections = content.split(/^## /m).map((s) => s.trim()).filter((s) => s && s.includes(`｜${stage.id}`));
    return sections.slice(-2).map((s) => ('## ' + s).slice(0, 600)).join('\n');
  }

  // 记忆·前序交接：handoffs.md 末尾最近若干条（各阶段写给后续阶段的便签）
  function memoryHandoffBlock() {
    try {
      const c = fs.readFileSync(path.join(memoryDir, 'handoffs.md'), 'utf8').trim();
      return c.length > MEMORY_HANDOFF_LIMIT ? c.slice(c.length - MEMORY_HANDOFF_LIMIT) : c;
    } catch (e) { return ''; }
  }

  // 统一上下文块：工作记忆 + 历史知识 + 标记段协议（沉淀/委托按开关裁剪）
  function contextBlockFor(agentId, stage, opts) {
    let block = `\n\n===== 角色协作上下文（供参考，非本任务指令） =====\n`;
    if (opts.memoryOn) {
      const stageMem = memoryStageBlock(agentId, stage);
      block += `\n[工作记忆·本阶段（${stage.id}）]\n${stageMem || '（无）'}\n`;
      const handoff = memoryHandoffBlock();
      block += `\n[工作记忆·前序阶段交接]\n${handoff || '（无）'}\n`;
    }
    if (opts.knowledgeOn) {
      let tail = '';
      let truncated = false;
      try {
        const content = fs.readFileSync(path.join(knowledgeDir, `${agentId}.md`), 'utf8').trim();
        if (content.length > KNOWLEDGE_INJECT_LIMIT) { tail = content.slice(content.length - KNOWLEDGE_INJECT_LIMIT); truncated = true; }
        else tail = content;
      } catch (e) { /* 无知识文件视为空，不告警 */ }
      block += `\n[角色知识库·历史经验]\n${tail || '（空，尚无积累）'}`
        + (truncated ? `\n（仅注入最近 ${KNOWLEDGE_INJECT_LIMIT} 字符，完整见 knowledge/${agentId}.md）` : '') + `\n`;
    }
    const proto = [];
    if (opts.knowledgeOn) proto.push(`- 知识沉淀（本次获得可复用经验时）：\n===== KNOWLEDGE APPEND =====\n- 一行一条，写具体、可执行\n===== KNOWLEDGE END =====`);
    if (opts.memoryOn) proto.push(`- 记忆沉淀（记录本次执行过程）：\n===== MEMORY APPEND =====\nsummary: <一句话本次执行摘要>\nhandoff: <给后续阶段的交接提示，可省略此行>\n===== MEMORY END =====`);
    if (delegateOn) proto.push(`- 动态委托（仅当你判断本阶段更适合其他角色执行时）：\n===== DELEGATE =====\ntarget: <agents.json 内的角色 id，如 architect>\nreason: <为什么目标角色更合适>\nhandoff: <给目标角色的交接说明>\n===== DELEGATE END =====`);
    block += `\n【标记段协议（附在回复正文全部结束之后，不计入产物文档；均为可选，没有则省略；严禁写入密钥/token/敏感路径）】\n`
      + proto.join('\n');
    return block;
  }

  // 抽取：剥离全部 KNOWLEDGE 标记段，得到干净产物正文与新学条目
  function extractKnowledge(text) {
    const entries = [];
    for (const m of text.matchAll(KNOWLEDGE_BLOCK_RE)) {
      const body = m[1].trim();
      if (body) entries.push(body);
    }
    if (!entries.length) return { body: text, entries: null };
    return { body: text.replace(KNOWLEDGE_BLOCK_RE, '').trimEnd(), entries: entries.join('\n') };
  }

  // 沉淀：条目带时间/项目/阶段元数据头追加进 knowledge/<agentId>.md（追加式，可人工修剪）
  function appendKnowledge(agentId, stage, entries) {
    const file = path.join(knowledgeDir, `${agentId}.md`);
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const header = `## ${new Date().toISOString()}｜${projectName}｜${stage.id} ${stage.name}\n`;
    fs.appendFileSync(file, header + entries + '\n');
    return file;
  }

  // 抽取：解析 MEMORY 标记段的 summary / handoff 两行式字段
  function extractMemory(text) {
    const sections = [...text.matchAll(MEMORY_BLOCK_RE)];
    if (!sections.length) return { body: text, memory: null };
    const body = text.replace(MEMORY_BLOCK_RE, '').trimEnd();
    const pick = (key) => {
      const m = sections[0][1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const memory = { summary: pick('summary'), handoff: pick('handoff') };
    return { body, memory: memory.summary || memory.handoff ? memory : null };
  }

  // 沉淀：summary → memory/<agentId>.md；handoff → memory/handoffs.md（带来源阶段头）
  function appendMemory(agentId, stage, memory) {
    fs.mkdirSync(memoryDir, { recursive: true });
    const now = new Date().toISOString();
    if (memory.summary) {
      fs.appendFileSync(path.join(memoryDir, `${agentId}.md`), `## ${now}｜${stage.id}\n- 摘要：${memory.summary}\n`);
    }
    if (memory.handoff) {
      fs.appendFileSync(path.join(memoryDir, 'handoffs.md'), `## ${now}｜${stage.id}（${agentId}）→ 后续阶段\n- ${memory.handoff}\n`);
    }
  }

  // 用户修订意见自动入记忆（交互 amend / --amend / 回炉验证报告），重跑同阶段自动带出
  function appendMemoryEvent(stage, amendText) {
    fs.mkdirSync(memoryDir, { recursive: true });
    const flat = amendText.replace(/\n+/g, ' ');
    const short = flat.length > 500 ? flat.slice(0, 500) + '…（截断）' : flat;
    fs.appendFileSync(path.join(memoryDir, `${stage.agent}.md`), `## ${new Date().toISOString()}｜${stage.id}\n- 用户修订：${short}\n`);
  }

  // 抽取：解析 DELEGATE 标记段的 target / reason / handoff
  function extractDelegate(text) {
    const sections = [...text.matchAll(DELEGATE_BLOCK_RE)];
    if (!sections.length) return { body: text, delegate: null };
    const body = text.replace(DELEGATE_BLOCK_RE, '').trimEnd();
    const pick = (key) => {
      const m = sections[0][1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    return { body, delegate: { target: pick('target'), reason: pick('reason'), handoff: pick('handoff') } };
  }

  // 委托块：注入给目标角色的交接上下文（原角色初步产出供参考）
  function delegateBlock(ctx) {
    return `\n\n===== 委托执行 =====\n本阶段原定角色为 ${ctx.from}，其判断本阶段更适合你（${ctx.target}）执行。\n理由：${ctx.reason || '（未注明）'}\n`
      + `${ctx.from} 的初步产出（供参考，可推翻）：\n${ctx.priorOutput}\n`
      + `交接说明：${ctx.handoff || '（无）'}\n请以你的专长完成本阶段任务（任务要求见上），产物要求不变。\n`;
  }

  // ---------- 需求原文注入 ----------
  // 与 req-builder --select 的产物同构：写 artifacts/00-requirement.md，由各流水线首阶段以 input 引用
  if (args.requirement !== undefined) {
    const reqText = String(args.requirement).trim();
    if (!reqText) { console.error('错误：--requirement 不能为空。'); process.exit(1); }
    const reqAbs = resolveWork('artifacts/00-requirement.md');
    fs.mkdirSync(path.dirname(reqAbs), { recursive: true });
    if (fs.existsSync(reqAbs)) log('警告：artifacts/00-requirement.md 已存在，将被 --requirement 覆盖');
    fs.writeFileSync(reqAbs, `# 需求输入（命令行 --requirement）\n\n${reqText}\n`);
    log(`需求原文已写入 artifacts/00-requirement.md（${reqText.length} 字符）`);
  }

  // ---------- 配置与适配器 ----------
  let cliCfg, pipeline, agentsConfig, agentsJson;
  try {
    cliCfg = adapter.loadCliConfig(ROOT, resolveAsset(args['cli-config'] || 'config/cli.json'), { adapter: args['adapter'] });
    pipeline = readJson(resolveAsset(pipelineConfigRel));
    agentsConfig = readJson(resolveAsset(args['agents-config'] || 'config/agents.json'));
  } catch (e) {
    console.error('错误：读取配置失败：' + e.message);
    process.exit(1);
  }
  agentsJson = JSON.stringify(agentsConfig.agents);

  // 向后兼容：旧版 pipeline.json 内嵌 cli 块
  if (pipeline.cli) {
    if (pipeline.cli.timeoutMs) cliCfg.timeoutMs = pipeline.cli.timeoutMs;
    if (pipeline.cli.permissions) cliCfg.permissions = pipeline.cli.permissions;
    if (pipeline.cli.outputFormat) cliCfg.outputFormat = pipeline.cli.outputFormat;
  }
  const timeoutOverride = parseInt(args['timeout-ms'], 10);
  if (Number.isFinite(timeoutOverride) && timeoutOverride > 0) cliCfg.timeoutMs = timeoutOverride;

  const dryRun = !!args['dry-run'];
  const interactive = !!args['interactive'];
  const remote = !!args['remote'];
  const initOnly = !!args['init-only'];
  const amend = args['amend'] || null;

  const stages = pipeline.stages;
  const fromId = args['from'] || stages[0].id;
  const toId = args['to'] || stages[stages.length - 1].id;
  const startIdx = stages.findIndex((s) => s.id === fromId);
  const endIdx = stages.findIndex((s) => s.id === toId);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    console.error(`错误：阶段范围无效 from=${fromId} to=${toId}，可用阶段：${stages.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  let runner;
  try {
    runner = adapter.createRunner(cliCfg);
  } catch (e) {
    if (!dryRun) { console.error('错误：' + e.message); process.exit(1); }
    runner = dryRunRunner(e.message); // 告警统一在下方 CLI 探测段输出
  }

  // 探测 CLI 可用性（dry-run 也探测，便于提前发现问题；plain 适配器宽松处理）
  const probe = runner.probe();
  if (runner.placeholder) {
    log(`警告：${runner.reason}；演练模式仅校验阶段与提示词配置`);
  } else if (probe.error || probe.status !== 0) {
    const detail = String((probe.stderr || '') || (probe.stdout || '') || (probe.error && probe.error.message) || '').trim().slice(0, 300);
    if (runner.name === 'plain') {
      log(`警告：plain 适配器探测未通过（--version），继续尝试执行：${runner.label()}${detail ? '；详情：' + detail : ''}`);
    } else if (dryRun) {
      log(`警告：agent CLI 探测未通过（演练模式继续）：${runner.label()}${detail ? '；详情：' + detail.replace(/\n+/g, ' ').trim() : ''}`);
    } else {
      console.error(`错误：agent CLI 不可用（适配器=${runner.name}，命令=${runner.label()}）。`);
      if (detail) console.error('详情：' + detail.replace(/\n+/g, ' ').trim());
      console.error('请安装对应 CLI 或修复其运行环境；也可用 AGENT_PIPELINE_HOST 指定宿主，'
        + '或通过 config/cli.json / AGENT_PIPELINE_ADAPTER 指定其他适配器');
      process.exit(1);
    }
  } else {
    log(`CLI 就绪：适配器=${runner.name}，命令=${runner.label()} ${String(probe.stdout || '').trim()}`);
  }

  const vars = { projectName, projectDir };
  // 回炉配置：验证阶段产物命中失败标记时自动回 resumeStage 重修；--fix-rounds 覆盖轮数，0=关闭
  const retryCfg = pipeline.retry || null;
  const fixRoundsArg = parseInt(args['fix-rounds'], 10);
  let retryMaxRounds = retryCfg && Number.isFinite(retryCfg.maxRounds) ? retryCfg.maxRounds : 0;
  if (Number.isFinite(fixRoundsArg) && fixRoundsArg >= 0) retryMaxRounds = fixRoundsArg;
  log(`开始流水线：${projectName} @ ${projectDir}（配置 ${pipelineConfigRel}，阶段 ${fromId} → ${toId}${dryRun ? '，演练模式' : ''}${retryMaxRounds > 0 ? `，验证未通过自动回炉≤${retryMaxRounds}轮` : ''}）`);
  if (knowledgeDir) log(`角色知识库已启用：${knowledgeDir}（--no-knowledge 可关闭）`);
  if (memoryDir) log(`角色记忆已启用：${memoryDir}（--no-memory 可关闭）`);
  if (delegateOn) log(`动态委托已启用：角色可声明换更合适的角色执行本阶段，每阶段最多一次（--no-delegate 可关闭）`);

  // 交互确认：审阅阶段产物，可输入修改意见让 agent 重跑该阶段
  // 实现说明：readline 的 question 是一次性注册，若输入行在下一个 question 注册前到达（管道/expect
  // 一次性喂入、或 agent 自动驱动）会被丢弃。改为常驻 line 监听 + 行队列，任意节奏到达都不丢。
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lineQueue = [];
  let lineWaiter = null;
  rl.on('line', (line) => {
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
    else lineQueue.push(line);
  });
  function nextLine() {
    return new Promise((resolve) => {
      if (lineQueue.length) resolve(lineQueue.shift());
      else lineWaiter = resolve;
    });
  }
  async function askUser(stage) {
    console.log(`\n===== 阶段 ${stage.id}（${stage.name}）产物预览 =====`);
    if (stage.output) {
      const outAbs = resolveWork(stage.output);
      if (fs.existsSync(outAbs)) {
        const content = fs.readFileSync(outAbs, 'utf8');
        console.log(content.length > 3000 ? content.slice(0, 3000) + `\n...(截断，完整见 ${stage.output})` : content);
      }
    }
    process.stdout.write('\n[y] 确认继续  |  输入修改意见（多行，以 !done 结束）\n> ');
    const first = await nextLine();
    if (first.trim() === 'y') { return { action: 'continue' }; }
    const lines = [first];
    process.stdout.write('> ');
    for (;;) {
      const line = await nextLine();
      if (line.trim() === '!done') { return { action: 'amend', text: lines.join('\n').trim() }; }
      lines.push(line);
      process.stdout.write('> ');
    }
  }

  // 执行单个阶段：组装 prompt → 经适配器调用 CLI → 产物落盘；限额/过载自动切换模型重跑；
  // 角色输出 DELEGATE 标记段时换目标角色重跑本阶段（每阶段最多 DELEGATE_MAX_HOPS 次）
  function runStage(stage, extraAmend) {
    const baseAgentDef = agentsConfig.agents[stage.agent];
    if (!baseAgentDef) { log(`[${stage.id}] 跳过：未找到 agent ${stage.agent}`); return { ok: true, skipped: true }; }

    let template;
    try {
      template = fs.readFileSync(resolveAsset(stage.promptFile), 'utf8');
    } catch (e) {
      log(`[${stage.id}] 失败：提示词模板不存在 ${stage.promptFile}`);
      return { ok: false, errText: e.message };
    }
    const basePrompt = replacePlaceholders(
      template.replace(/^---\r?\nAIGC:[\s\S]*?\r?\n---\r?\n/, ''), // 剥离可能存在的 AIGC 水印 frontmatter
      vars,
    );

    // 用户修订意见自动入记忆（交互 amend / --amend / 回炉报告），重跑同阶段时自动带出
    if (extraAmend && memoryDir && baseAgentDef.memory !== false) appendMemoryEvent(stage, extraAmend);

    let agentId = stage.agent; // 当前执行角色（委托后变化，知识/记忆随最终执行者）
    let delegateCtx = null;    // 委托上下文（来自前一角色的交接）
    let hops = 0;              // 本阶段已委托次数

    for (;;) { // 委托循环：DELEGATE 生效时换角色重跑本阶段
      const agentDef = agentsConfig.agents[agentId] || baseAgentDef;
      let prompt = basePrompt;

      const contextParts = [];
      for (const inputRel of stage.input || []) {
        const inputAbs = resolveWork(inputRel);
        if (fs.existsSync(inputAbs)) {
          contextParts.push(`\n\n===== 上下文输入：${inputRel} =====\n` + fs.readFileSync(inputAbs, 'utf8'));
        } else {
          log(`[${stage.id}] 警告：输入产物缺失 ${inputRel}，继续执行`);
        }
      }
      if (contextParts.length) prompt += contextParts.join('');
      if (extraAmend) prompt += `\n\n===== 用户修订意见（请据此更新产物，其余内容保持一致） =====\n` + extraAmend;
      // 角色协作上下文：记忆 + 知识库 + 标记段协议（agent 级 knowledge/memory:false 或全局开关关闭）
      const knowledgeOn = !!knowledgeDir && agentDef.knowledge !== false;
      const memoryOn = !!memoryDir && agentDef.memory !== false;
      if (knowledgeOn || memoryOn) prompt += contextBlockFor(agentId, stage, { knowledgeOn, memoryOn });
      if (delegateCtx) prompt += delegateBlock(delegateCtx);

      // 模型候选链：阶段级显式模型 > 代理级模型 > 阶段/代理 fallbackModels > 适配器动态模型 > auto
      const canModel = !!(runner.capabilities && runner.capabilities.model);
      const explicitPrimary = (stage.model && stage.model !== 'auto')
        ? stage.model
        : ((agentDef.model && agentDef.model !== 'auto') ? agentDef.model : null);
      const candidates = [];
      if (explicitPrimary) candidates.push(explicitPrimary);
      for (const m of [].concat(stage.fallbackModels || [], agentDef.fallbackModels || [])) {
        if (m && m !== 'auto' && !candidates.includes(m)) candidates.push(m);
      }
      if (canModel) {
        for (const m of runner.extraModels()) {
          if (m && !candidates.includes(m)) candidates.push(m);
        }
        if (candidates.length && !candidates.includes('auto')) candidates.push('auto');
      }
      const modelList = candidates.length ? candidates : [null];

      const timeoutMs = cliCfg.timeoutMs || 600000;
      let finalStdout = null;
      for (let ci = 0; ci < modelList.length; ci++) {
        const current = modelList[ci];
        const next = modelList[ci + 1] || null;
        const fb = runner.supportsFallbackFlag ? next : null;

        log(`[${stage.id}] ${stage.name}（agent=${agentId}${agentId !== stage.agent ? '(委托)' : ''}@${runner.name}）开始，模型=${current || '默认'}${fb ? `，CLI回退=${fb}` : ''}`);
        log(`[${stage.id}] 命令：${runner.label()} -p <prompt ${prompt.length} 字符> ...`);

        if (dryRun) { log(`[${stage.id}] [演练] 不实际执行`); return { ok: true, dry: true }; }

        const result = runner.run({
          prompt,
          agentId,
          agentDef,
          agentsJson,
          model: current,
          fallbackModel: fb,
          cwd: projectDir,
          timeoutMs,
          permissions: cliCfg.permissions,
          outputFormat: cliCfg.outputFormat,
        });

        const stdout = (result.stdout || '').trim();
        const stderr = (result.stderr || '').trim();
        if (result.status === 0) { finalStdout = stdout; break; }

        const errText = `${stderr}\n${stdout}`;
        const canSwitch = adapter.isQuotaError(errText) && ci < modelList.length - 1;
        log(`[${stage.id}] 执行失败：exit=${result.status} signal=${result.signal || '-'}`);
        if (canSwitch) {
          log(`[${stage.id}] 检测到模型限额/过载（${current || '默认'}），自动切换候选模型 → ${modelList[ci + 1]}`);
          if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 1500)}`);
          continue;
        }
        if (result.error) log(`[${stage.id}] error: ${result.error.message}`);
        if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 2000)}`);
        if (stdout) log(`[${stage.id}] stdout 尾部: ${stdout.slice(-2000)}`);
        return { ok: false, errText };
      }

      // 产物后处理：知识/记忆沉淀（归属当前执行者）→ 委托判定 → 落盘
      let body = finalStdout || '';
      if (knowledgeOn && body) {
        const extracted = extractKnowledge(body);
        body = extracted.body;
        if (extracted.entries) {
          const kFile = appendKnowledge(agentId, stage, extracted.entries);
          const count = extracted.entries.split('\n').filter((l) => l.trim()).length;
          log(`[${stage.id}] 知识沉淀：${count} 条 → ${path.relative(workRoot, kFile) || kFile}`);
        }
      }
      if (memoryOn && body) {
        const extracted = extractMemory(body);
        body = extracted.body;
        if (extracted.memory) {
          appendMemory(agentId, stage, extracted.memory);
          log(`[${stage.id}] 记忆沉淀：summary${extracted.memory.summary ? '✓' : '✗'}${extracted.memory.handoff ? ' + 交接便签' : ''} → memory/`);
        }
      }
      if (body) {
        const del = extractDelegate(body);
        body = del.body;
        if (del.delegate && del.delegate.target) {
          const t = del.delegate.target;
          const valid = delegateOn && !!agentsConfig.agents[t] && t !== agentId && hops < DELEGATE_MAX_HOPS;
          if (valid) {
            hops++;
            log(`[${stage.id}] 动态委托：${agentId} → ${t}（${del.delegate.reason || '未注明原因'}），由 ${t} 重跑本阶段`);
            delegateCtx = {
              from: agentId,
              target: t,
              reason: del.delegate.reason,
              handoff: del.delegate.handoff,
              priorOutput: body.slice(0, 4000),
            };
            agentId = t;
            continue; // 换目标角色重跑本阶段
          }
          log(`[${stage.id}] 委托标记未生效（${!delegateOn ? '已 --no-delegate 关闭' : !agentsConfig.agents[t] ? `未知角色：${t}` : t === agentId ? '目标即当前角色' : '本阶段委托次数已用尽'}），按当前产物继续`);
        }
      }

      if (stage.output) {
        const outAbs = resolveWork(stage.output);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
        fs.writeFileSync(outAbs, body || '(空输出)\n');
        log(`[${stage.id}] 完成，产物已写入 ${stage.output}${agentId !== stage.agent ? `（由 ${agentId} 委托执行）` : ''}`);
      } else {
        log(`[${stage.id}] 完成（无产物文件，输出长度 ${body.length}）`);
      }
      return { ok: true, agent: agentId };
    }
  }

  (async () => {
    let retryAmend = null; // 回炉注入的修订意见，作用于 resumeStage 重跑的首轮
    let retryUsed = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const stage = stages[i];
      let extraAmend = retryAmend || (amend && stage.id === fromId ? amend : null);
      retryAmend = null;
      let stageResult;
      do {
        stageResult = runStage(stage, extraAmend);
        if (!stageResult.ok) {
          console.error(`\n阶段 ${stage.id} 失败，可用 --from ${stage.id} 断点重跑。`);
          process.exit(2);
        }
        if (stageResult.skipped || stageResult.dry) break;
        if (!((interactive || remote) && stage.confirm)) break;
        if (remote) {
          // 远程确认模式：不等待终端输入，落状态文件并退出，由外部（IM/机器人）中转确认/收集意见
          const nextId = i + 1 <= endIdx ? stages[i + 1].id : null;
          const stateAbs = resolveWork('artifacts/.confirm-state.json');
          fs.mkdirSync(path.dirname(stateAbs), { recursive: true });
          fs.writeFileSync(stateAbs, JSON.stringify({
            projectName, projectDir,
            stageId: stage.id, stageName: stage.name,
            output: stage.output || null,
            nextStageId: nextId,
            action: 'pending',
            updatedAt: new Date().toISOString(),
          }, null, 2));
          log(`[${stage.id}] 远程确认模式：已暂停（状态文件 ${path.relative(workRoot, stateAbs) || stateAbs}）`);
          console.log('\nREMOTE_CONFIRM_NEEDED');
          process.exit(42);
        }
        const answer = await askUser(stage);
        if (answer.action === 'continue') break;
        extraAmend = answer.text;
        log(`[${stage.id}] 收到修订意见（${answer.text.length} 字符），重新执行`);
      } while (true);

      // 回炉检查：checkStage 产物命中失败标记且轮数未用尽 → 带验证报告回 resumeStage 重修
      if (retryCfg && retryMaxRounds > 0 && stage.id === retryCfg.checkStage && stage.output && !stageResult.dry) {
        let report = null;
        try {
          report = fs.readFileSync(resolveWork(stage.output), 'utf8');
        } catch (e) {
          log(`[${stage.id}] 回炉检查：产物读取失败，视为通过（${e.message}）`);
        }
        if (report !== null && new RegExp(retryCfg.failPattern).test(report)) {
          if (retryUsed >= retryMaxRounds) {
            log(`[${stage.id}] 验证未通过（命中 ${retryCfg.failPattern}），回炉轮数已用尽（${retryMaxRounds}），继续推进；失败明细见 ${stage.output}`);
          } else {
            const resumeIdx = stages.findIndex((s) => s.id === retryCfg.resumeStage);
            if (resumeIdx === -1 || resumeIdx >= i) {
              log(`[${stage.id}] 回炉配置无效：resumeStage=${retryCfg.resumeStage} 不存在或不在 checkStage 之前，跳过回炉`);
            } else {
              retryUsed++;
              retryAmend = `【第 ${retryUsed} 轮修复验证未通过（最多 ${retryMaxRounds} 轮）。以下是验证报告全文，请针对失败项完成修复，再重新执行本阶段任务】\n\n` + report.slice(0, 6000);
              log(`[${stage.id}] 验证未通过（命中 ${retryCfg.failPattern}），自动回炉 → ${retryCfg.resumeStage}（第 ${retryUsed}/${retryMaxRounds} 轮）`);
              i = resumeIdx - 1; // for 自增后落到 resumeStage
              continue;
            }
          }
        }
      }

      if (initOnly && stage.confirm) {
        const nextId = i + 1 <= endIdx ? stages[i + 1].id : null;
        log(`[${stage.id}] 交互引导结束（--init-only）`);
        rl.close();
        console.log(nextId
          ? `\n需求已确认。继续自动执行：node scripts/run-pipeline.js --project-name ${projectName} --project-dir "${projectDir}" --from ${nextId}`
          : '\n需求已确认，流水线完成。');
        return;
      }
    }
    log(`流水线完成：${projectName}`);
    rl.close();
    console.log('\n全部阶段执行完毕。产物见 artifacts/，日志见 logs/pipeline.log');
  })().catch((e) => { console.error(e); process.exit(1); });
}

main();
