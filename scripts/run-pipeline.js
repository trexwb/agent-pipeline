#!/usr/bin/env node
/**
 * 多 Agent 流水线主编排器（便携版）—— 通过 CLI 适配层运行在任意 agent 环境
 *
 * 用法：
 *   node scripts/run-pipeline.js --project-name demo-app [--dry-run]
 *   node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test
 *   node scripts/run-pipeline.js --project-name demo-app --interactive          # 项目经理升级人工时终端应答
 *   node scripts/run-pipeline.js --project-name demo-app --resume-human <id> --amend "人工决定"
 *   node scripts/run-pipeline.js --project-name demo-app --from 03-architecture --amend "修订意见"
 *   node scripts/run-pipeline.js --project-name demo-app --project-dir ./app \
 *     --pipeline fix --requirement "登录页 Safari 下提交报错"                    # 修复流水线（5 阶段）
 *
 * 原理：专业阶段经适配器调用 agent CLI，输出正文 + REPORT；项目经理派活/验收并输出 DECISION，
 *       编排器执行继续、返工、退回上游、人工升级或最终验收；旧配置回退人工确认/自动回炉。
 *       角色知识库、记忆与动态委托默认开启；项目经理门禁禁止委托。
 * 可移植性：零 npm 依赖；路径全部相对 skill 根或 --work-dir；无平台硬编码；
 *          --work-dir 可把产物/日志/自定义模板与 config 放到任意工作目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const adapter = require('./lib/adapter');
const managerProtocol = require('./lib/manager-protocol');
const managerRouter = require('./lib/manager-router');

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
  --interactive         项目经理升级人工时终端应答；旧配置用于 confirm 阶段审阅
  --remote              旧配置 confirm 阶段远程确认；项目经理升级始终支持非交互退出
  --init-only           旧配置到最后一个 confirm 阶段；项目经理模式到本次范围内最后一个 confirm 阶段
  --amend "<意见>"      把修订意见追加进 --from 指定阶段重新生成产物
  --resume-human <id>   读取 pm-escalation.json 中对应决策包，携 --amend 恢复项目经理模式
  --fix-rounds <n>      仅旧配置修复回炉轮数，覆盖 retry.maxRounds；0=关闭回炉
  --knowledge-dir <dir> 角色知识库目录（执行时注入历史经验、完成后沉淀新知识），
                        默认 <work-dir>/knowledge；指向固定目录可跨项目积累
  --no-knowledge        关闭角色知识库（不注入、不沉淀）
  --no-memory           关闭角色记忆（任务过程上下文：执行摘要/交接便签/用户修订入记忆）
  --no-delegate         关闭动态委托（角色声明本阶段更适合其他角色时换角色重跑）
  --dry-run             只打印将要执行的命令，不真正调用 CLI
  --pipeline-config <p> 流水线配置路径，默认 config/pipeline.json（与 --pipeline 互斥）
  --agents-config <p>   子代理配置路径，默认 config/agents.json
  --cli-config <p>      CLI 适配配置路径，默认 config/cli.json
  --adapter <name>      强制指定适配器（codebuddy/claude/codex/plain），同时关闭跨运行轮询
  --timeout-ms <n>      单阶段 CLI 超时毫秒数，覆盖 cli.json 的 timeoutMs
  --model-timeout-ms <n> 单个命名模型的尝试超时毫秒数，覆盖 cli.json 的 modelAttemptTimeoutMs
                        （默认 180000）：自定义模型卡死到此即换下一候选，不影响 CLI 自带模型的整段预算

宿主环境变量：
  AGENT_PIPELINE_HOST      固定宿主（workbuddy/codebuddy/zcode/qoder/marvis/claude/codex），同时关闭轮询
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
    if (opts.delegateOn) proto.push(`- 动态委托（仅当你判断本阶段更适合其他角色执行时）：\n===== DELEGATE =====\ntarget: <agents.json 内的角色 id，如 architect>\nreason: <为什么目标角色更合适>\nhandoff: <给目标角色的交接说明>\n===== DELEGATE END =====`);
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
  function appendMemoryEvent(stage, amendText, source = '用户修订') {
    fs.mkdirSync(memoryDir, { recursive: true });
    const flat = amendText.replace(/\n+/g, ' ');
    const short = flat.length > 500 ? flat.slice(0, 500) + '…（截断）' : flat;
    fs.appendFileSync(path.join(memoryDir, `${stage.agent}.md`), `## ${new Date().toISOString()}｜${stage.id}\n- ${source}：${short}\n`);
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
  const modelTimeoutOverride = parseInt(args['model-timeout-ms'], 10);
  if (Number.isFinite(modelTimeoutOverride) && modelTimeoutOverride > 0) cliCfg.modelAttemptTimeoutMs = modelTimeoutOverride;
  // 跨运行轮游标写在 --work-dir 下：安装目录可能只读，不同项目各转各的
  cliCfg.rotation = Object.assign({ enabled: true, stateFile: 'cli-rotation.json' }, cliCfg.rotation || {});
  if (!path.isAbsolute(cliCfg.rotation.stateFile)) cliCfg.rotation.stateFile = resolveWork(cliCfg.rotation.stateFile);

  // 运行内模型健康度：本轮已超时/不可用的模型排到候选链末尾，后续阶段不重复踩同一个坑
  const modelHealth = new Map();
  const healthKey = (m) => (m === null || m === undefined ? '<cli-default>' : String(m));
  function markModelFailure(model, kind) {
    const key = healthKey(model);
    const prev = modelHealth.get(key) || { fails: 0, kinds: [] };
    prev.fails += 1;
    if (!prev.kinds.includes(kind)) prev.kinds.push(kind);
    modelHealth.set(key, prev);
  }
  function rankByHealth(list) {
    if (!modelHealth.size || list.length < 2) return list;
    const failed = list.filter((m) => modelHealth.has(healthKey(m)));
    if (!failed.length) return list;
    return list.filter((m) => !modelHealth.has(healthKey(m))).concat(failed);
  }

  const dryRun = !!args['dry-run'];
  const interactive = !!args['interactive'];
  const remote = !!args['remote'];
  const initOnly = !!args['init-only'];
  const amend = args['amend'] || null;

  const stages = pipeline.stages;
  let managerCfg = null;
  let managerState = null;
  let managerStateFile = null;
  let managerKickoff = false;
  let managerResumeWorkOrder = null;
  let fromId = args['from'] || stages[0].id;
  const toId = args['to'] || stages[stages.length - 1].id;
  let startIdx = stages.findIndex((s) => s.id === fromId);
  const endIdx = stages.findIndex((s) => s.id === toId);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    console.error(`错误：阶段范围无效 from=${fromId} to=${toId}，可用阶段：${stages.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  if (pipeline.projectManager && pipeline.projectManager.enabled) {
    managerCfg = Object.assign({
      kickoff: true,
      maxReworkRounds: 2,
      maxTotalReworks: 6,
      stateFile: 'artifacts/pm-project-state.json',
      handoffOutput: 'artifacts/pm-handoff.md',
      decisionLog: 'artifacts/pm-decisions.md',
      escalationState: 'artifacts/pm-escalation.json',
      acceptanceOutput: 'artifacts/99-acceptance.md',
    }, pipeline.projectManager);
    for (const key of ['agent', 'promptFile', 'stateFile', 'handoffOutput', 'decisionLog', 'escalationState', 'acceptanceOutput']) {
      if (typeof managerCfg[key] !== 'string' || !managerCfg[key]) {
        console.error(`错误：projectManager.${key} 必须是非空字符串。`);
        process.exit(1);
      }
    }
    if (!agentsConfig.agents[managerCfg.agent]) {
      console.error(`错误：agents.json 未找到项目经理角色 ${managerCfg.agent}。`);
      process.exit(1);
    }
    if (!Number.isInteger(managerCfg.maxReworkRounds) || managerCfg.maxReworkRounds < 0
      || !Number.isInteger(managerCfg.maxTotalReworks) || managerCfg.maxTotalReworks < 0) {
      console.error('错误：项目经理返工预算必须是非负整数。');
      process.exit(1);
    }
    managerStateFile = resolveWork(managerCfg.stateFile);
    const expected = { projectName, projectDir, pipelineConfigRel };
    const existing = managerRouter.loadState(managerStateFile, expected);
    if (existing && args.requirement === undefined && args.from === undefined) {
      managerState = existing;
      managerResumeWorkOrder = existing.nextWorkOrder || null;
      if (args['resume-human']) {
        const pending = managerState.pending;
        if (!pending || pending.decisionId !== args['resume-human']) {
          console.error('错误：--resume-human 的决策 ID 与当前待处理升级包不匹配。');
          process.exit(1);
        }
        if (!amend) {
          console.error('错误：--resume-human 必须同时提供 --amend "<人工决策原文>"。');
          process.exit(1);
        }
        if (pending.reasonType === 'rework-budget') managerRouter.approveExtraRework(managerState);
        managerResumeWorkOrder = pending.workOrder || null;
        managerState.pending = null;
        managerState.status = 'running';
        managerState.resumeStageId = pending.resumeStageId;
        const escalationFile = resolveWork(managerCfg.escalationState);
        fs.writeFileSync(escalationFile, JSON.stringify({
          projectName,
          action: 'resolved',
          decisionId: pending.decisionId,
          humanResponse: amend,
          resolvedAt: new Date().toISOString(),
        }, null, 2) + '\n');
      }
      const resumeIdx = stages.findIndex((stage) => stage.id === managerState.resumeStageId);
      if (managerState.status === 'complete') {
        log(`项目经理模式：项目已完成，验收单见 ${managerCfg.acceptanceOutput}；使用 --from <阶段> 可重新执行指定范围。`);
        process.exit(0);
      }
      if (managerState.pending) {
        startIdx = resumeIdx;
      } else if (resumeIdx !== -1) {
        startIdx = resumeIdx;
      }
      if (startIdx === -1 || startIdx > endIdx) {
        console.error(`错误：项目经理恢复阶段 ${managerState.resumeStageId} 不在本次执行范围内。`);
        process.exit(1);
      }
      fromId = stages[startIdx].id;
    } else {
      managerState = managerRouter.freshState(projectName, projectDir, pipelineConfigRel, stages[startIdx].id, managerCfg);
      managerRouter.invalidateFrom(managerState, stages, startIdx);
      managerKickoff = !!managerCfg.kickoff && startIdx === 0;
    }
    if (!dryRun) {
      managerRouter.saveState(managerStateFile, managerState);
      const escalationFile = resolveWork(managerCfg.escalationState);
      if (!managerState.pending && fs.existsSync(escalationFile)) {
        fs.writeFileSync(escalationFile, JSON.stringify({ projectName, action: 'idle', updatedAt: new Date().toISOString() }, null, 2) + '\n');
      }
    }
    log(`项目经理模式已启用：角色=${managerCfg.agent}，单阶段返工≤${managerCfg.maxReworkRounds}，总返工≤${managerCfg.maxTotalReworks}`);
  }

  let runner;
  try {
    runner = adapter.createRunner(cliCfg);
  } catch (e) {
    if (!dryRun) { console.error('错误：' + e.message); process.exit(1); }
    runner = dryRunRunner(e.message); // 告警统一在下方 CLI 探测段输出
  }
  if (cliCfg.hostWarning) log('警告：' + cliCfg.hostWarning);

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

  // 轮询可见性：让用户看清「这次用的是哪个 CLI、池里还有谁、怎么固定」
  const rot = runner.rotation;
  if (!runner.placeholder && rot && rot.total > 1) {
    if (rot.rotated && rot.index >= 0) {
      const cursorRel = path.relative(workRoot, cliCfg.rotation.stateFile) || cliCfg.rotation.stateFile;
      log(`宿主 CLI 轮询：本机池 [${rot.pool.join(', ')}] → 本次 ${rot.pool[rot.index]}（第 ${rot.index + 1}/${rot.total}），游标 ${cursorRel}；要固定宿主用 AGENT_PIPELINE_HOST 或 --adapter`);
    } else {
      log(`宿主 CLI 固定为 ${cliCfg.hostKey || runner.name}（${rot.reason === 'explicit-host' ? 'AGENT_PIPELINE_HOST' : '--adapter'} 指定），池 [${rot.pool.join(', ')}] 本轮不参与轮询`);
    }
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

  function persistManagerState() {
    if (!dryRun) managerRouter.saveState(managerStateFile, managerState);
  }

  function writeHandoff(decision, stage) {
    const file = resolveWork(managerCfg.handoffOutput);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# 项目经理任务书\n\n目标阶段：${stage.id}（${stage.name}）\n\n${managerProtocol.formatWorkOrder(decision.workOrder)}\n`);
  }

  function appendDecisionLog(mode, stage, decision, body) {
    const file = resolveWork(managerCfg.decisionLog);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const heading = mode === 'dispatch' ? '启动派活' : `阶段验收 ${stage.id}（${stage.name}）`;
    fs.appendFileSync(file, `\n## ${new Date().toISOString()}｜${heading}｜${decision.verdict}\n\n${body || decision.reason}\n`);
  }

  function runManagerGate(mode, currentStage, targetStage, stageResult) {
    const gateStage = {
      id: mode === 'dispatch' ? 'pm-dispatch' : `pm-review-${currentStage.id}`,
      name: mode === 'dispatch' ? '项目经理启动派活' : '项目经理阶段验收',
      agent: managerCfg.agent,
      promptFile: managerCfg.promptFile,
      input: [],
      output: null,
      confirm: false,
    };
    const inputs = ['artifacts/00-requirement.md', managerCfg.stateFile, managerCfg.decisionLog];
    if (mode === 'review') {
      inputs.push(managerCfg.handoffOutput, ...(currentStage.input || []));
    }
    gateStage.input = [...new Set(inputs)];
    let currentOutput = '（演练模式无当前产物）';
    if (mode === 'review' && currentStage.output && fs.existsSync(resolveWork(currentStage.output))) {
      currentOutput = fs.readFileSync(resolveWork(currentStage.output), 'utf8');
    }
    const context = {
      mode,
      currentStageId: currentStage ? currentStage.id : targetStage.id,
      targetStageId: targetStage.id,
      targetStageName: targetStage.name,
      nextStageId: mode === 'review' && stages[stages.indexOf(currentStage) + 1]
        ? stages[stages.indexOf(currentStage) + 1].id : null,
      isFinalFull: mode === 'review' && currentStage.id === stages[stages.length - 1].id && endIdx === stages.length - 1,
      actualAgent: stageResult ? stageResult.agent : null,
      report: stageResult ? stageResult.report : null,
      rework: managerState.rework,
    };
    const appendix = `===== 项目经理执行模式 =====\n${mode === 'dispatch' ? '启动派活：为指定阶段生成任务书。' : '阶段验收：审查当前阶段产物与 REPORT，并决定下一步。'}\n\n===== 项目经理路由上下文 =====\n${JSON.stringify(context, null, 2)}${mode === 'review' ? `\n\n===== 当前阶段产物 =====\n${currentOutput}` : ''}`;
    const result = runStage(gateStage, null, { appendix, managerGate: true, allowDelegate: false });
    if (!result.ok) return result;
    if (result.dry) return { ok: true, dry: true };
    try {
      const parsed = managerProtocol.parseManagerDecision(result.body, {
        ...context,
        stages,
        report: stageResult ? stageResult.report : null,
      });
      managerState.history.push({
        at: new Date().toISOString(),
        action: mode,
        stageId: currentStage ? currentStage.id : targetStage.id,
        verdict: parsed.decision.verdict,
        reason: parsed.decision.reason,
        nextStageId: parsed.decision.nextStageId || null,
      });
      appendDecisionLog(mode, currentStage || targetStage, parsed.decision, parsed.body);
      persistManagerState();
      return { ok: true, decision: parsed.decision, body: parsed.body };
    } catch (error) {
      managerState.status = 'failed';
      persistManagerState();
      return { ok: false, errText: error.message };
    }
  }

  function createBudgetEscalation(stage, resumeStageId, priorDecision) {
    return {
      verdict: 'ESCALATE',
      reason: '返工预算已用尽，需要人工决定是否追加预算或停止项目。',
      escalation: {
        question: `是否批准为阶段 ${stage.id}（${stage.name}）额外增加一轮返工？`,
        whyCannotDecide: '连续返工未达到验收标准，继续投入会改变已配置的预算，项目经理无权自行扩大。',
        options: ['批准额外一轮返工并继续验证', '停止项目并保留当前产物与失败证据'],
        recommendation: '如果失败原因明确且修复范围可控，批准一轮；否则停止并重新评估方案。',
        impact: `当前单阶段返工 ${managerState.rework.byStage[resumeStageId] || 0} 次，总返工 ${managerState.rework.total} 次。`,
        evidence: [priorDecision.reason, `当前产物：${stage.output || '无'}`],
        resumeStageId,
        recommendedAmend: '人工批准额外一轮返工。请针对上一轮问题清单修复，并重新提交可复现证据。',
        workOrder: priorDecision.workOrder || null,
      },
    };
  }

  async function askHumanDecision(pending) {
    console.log(`\n===== 需要人工决策 =====\n${managerProtocol.formatEscalation(pending)}\n`);
    process.stdout.write('[y] 采纳推荐方案并继续  |  输入其他决策（多行，以 !done 结束）  |  输入“停止”取消\n> ');
    const first = await nextLine();
    const normalized = first.trim().toLowerCase();
    if (['stop', 'cancel', '停止', '放弃'].includes(normalized)) return { action: 'stop' };
    if (normalized === 'y') return { action: 'resume', text: pending.recommendedAmend };
    const lines = [first];
    process.stdout.write('> ');
    for (;;) {
      const line = await nextLine();
      if (line.trim() === '!done') return { action: 'resume', text: lines.join('\n').trim() };
      lines.push(line);
      process.stdout.write('> ');
    }
  }

  async function pauseForHuman(decision, currentStage, mode, reasonType = 'manager-escalation') {
    const escalation = decision.escalation;
    const pending = Object.assign({}, escalation, {
      decisionId: `human-${Date.now()}`,
      currentStageId: currentStage.id,
      mode,
      reasonType,
      action: 'pending',
      createdAt: new Date().toISOString(),
    });
    managerRouter.setPending(managerState, pending);
    persistManagerState();
    const file = resolveWork(managerCfg.escalationState);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      projectName,
      projectDir,
      pipelineConfigRel,
      stateFile: managerCfg.stateFile,
      pending,
    }, null, 2) + '\n');
    log(`[${currentStage.id}] 项目经理升级人工：${escalation.question}`);
    if (!interactive) {
      console.log('\nHUMAN_DECISION_NEEDED');
      console.log(`决策包：${managerCfg.escalationState}`);
      console.log(`续跑：node scripts/run-pipeline.js --project-name "${projectName}" --project-dir "${projectDir}" --work-dir "${workRoot}" --resume-human ${pending.decisionId} --amend "<人工决策原文>"`);
      process.exit(42);
    }
    const answer = await askHumanDecision(pending);
    if (answer.action === 'stop') {
      managerState.status = 'cancelled';
      managerState.pending = null;
      persistManagerState();
      fs.writeFileSync(file, JSON.stringify({ projectName, action: 'cancelled', updatedAt: new Date().toISOString() }, null, 2) + '\n');
      log('用户停止项目，当前产物与证据已保留。');
      return null;
    }
    if (reasonType === 'rework-budget') managerRouter.approveExtraRework(managerState);
    managerState.pending = null;
    managerState.status = 'running';
    persistManagerState();
    fs.writeFileSync(file, JSON.stringify({
      projectName,
      action: 'resolved',
      humanResponse: answer.text,
      resolvedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    return answer;
  }

  async function runManagedPipeline() {
    let i = startIdx;
    let workOrder = managerResumeWorkOrder;
    let managerAmend = null;
    managerResumeWorkOrder = null;

    if (managerState.pending) {
      const pending = managerState.pending;
      const resumeIdx = stages.findIndex((stage) => stage.id === pending.resumeStageId);
      const currentStage = stages[resumeIdx];
      if (!currentStage) throw new Error(`人工升级包中的续跑阶段不存在：${pending.resumeStageId}`);
      const answer = await pauseForHuman({ escalation: pending }, currentStage, pending.mode, pending.reasonType);
      if (!answer) return;
      i = resumeIdx;
      managerAmend = pending.workOrder
        ? `${answer.text}\n\n${managerProtocol.formatWorkOrder(pending.workOrder)}`
        : answer.text;
    }

    if (managerKickoff) {
      const gate = await runManagerGate('dispatch', null, stages[i], null);
      if (!gate.ok) {
        console.error(`\n项目经理启动派活失败：${gate.errText}`);
        process.exit(2);
      }
      if (!gate.dry) {
        if (gate.decision.verdict === 'ESCALATE') {
          const answer = await pauseForHuman(gate.decision, stages[i], 'dispatch');
          if (!answer) return;
          managerAmend = gate.decision.escalation.workOrder
            ? `${answer.text}\n\n${managerProtocol.formatWorkOrder(gate.decision.escalation.workOrder)}`
            : answer.text;
        } else {
          workOrder = gate.decision.workOrder;
          managerState.nextWorkOrder = workOrder;
          persistManagerState();
          log(`[pm-dispatch] 已派发 ${stages[i].id}（${stages[i].name}）`);
        }
      }
    }

    while (i <= endIdx) {
      const stage = stages[i];
      const userAmend = amend && i === startIdx ? amend : null;
      const stageAmend = managerAmend || userAmend;
      const result = runStage(stage, stageAmend, {
        workOrder,
        amendLabel: workOrder ? '项目经理返工' : '用户修订意见',
      });
      workOrder = null;
      managerAmend = null;
      if (!result.ok) {
        managerState.status = 'failed';
        persistManagerState();
        console.error(`\n阶段 ${stage.id} 失败：${result.errText || '未知错误'}`);
        console.error(`可用 --from ${stage.id} 断点重跑。`);
        process.exit(2);
      }
      if (result.dry) {
        const gate = runManagerGate('review', stage, stage, result);
        if (!gate.ok) {
          console.error(`\n项目经理验收演练失败：${gate.errText}`);
          process.exit(2);
        }
        i++;
        continue;
      }

      managerRouter.recordReport(managerState, stage, result.agent, result.report);
      persistManagerState();
      const gate = runManagerGate('review', stage, stage, result);
      if (!gate.ok) {
        managerState.status = 'failed';
        persistManagerState();
        console.error(`\n项目经理验收 ${stage.id} 失败：${gate.errText}`);
        console.error(`可用 --from ${stage.id} 断点重跑。`);
        process.exit(2);
      }
      const decision = gate.decision;
      if (decision.verdict === 'ESCALATE') {
        const resumeIdx = stages.findIndex((item) => item.id === decision.escalation.resumeStageId);
        if (resumeIdx === -1 || resumeIdx > i) throw new Error(`人工升级包的续跑阶段无效：${decision.escalation.resumeStageId}`);
        if (resumeIdx < i) managerRouter.invalidateFrom(managerState, stages, resumeIdx);
        persistManagerState();
        const answer = await pauseForHuman(decision, stage, 'review');
        if (!answer) return;
        i = resumeIdx;
        managerAmend = decision.escalation.workOrder
          ? `${answer.text}\n\n${managerProtocol.formatWorkOrder(decision.escalation.workOrder)}`
          : answer.text;
        continue;
      }
      if (decision.verdict === 'PROCEED') {
        managerRouter.recordProceed(managerState, stage, decision.nextStageId, decision.workOrder);
        if (decision.nextStageId) writeHandoff(decision, stages.find((item) => item.id === decision.nextStageId));
        workOrder = decision.workOrder;
        persistManagerState();
        log(`[pm-review-${stage.id}] 验收通过 → ${decision.nextStageId}`);
        const hasLaterConfirm = stages.slice(i + 1, endIdx + 1).some((item) => item.confirm);
        if (initOnly && stage.confirm && !hasLaterConfirm) {
          const nextId = stages[i + 1] ? stages[i + 1].id : null;
          log('项目经理模式：前置引导段结束（--init-only）');
          rl.close();
          console.log(nextId
            ? `\n继续执行：node scripts/run-pipeline.js --project-name ${projectName} --project-dir "${projectDir}" --work-dir "${workRoot}" --from ${nextId}`
            : '\n流水线完成。');
          return;
        }
        i++;
        continue;
      }
      if (decision.verdict === 'COMPLETE') {
        const acceptanceFile = resolveWork(managerCfg.acceptanceOutput);
        fs.mkdirSync(path.dirname(acceptanceFile), { recursive: true });
        const acceptance = [
          `# 最终验收报告\n`,
          `项目：${projectName}`,
          `验收阶段：${stage.id}（${stage.name}）`,
          `验收时间：${new Date().toISOString()}`,
          `交付状态：可交付；未实际执行的部署动作不得标记为已上线。\n`,
          gate.body || decision.reason,
          `\n## 验收结论\n\n${decision.acceptance.summary}\n`,
          `## 剩余风险\n\n${decision.acceptance.remainingRisks.map((item) => `- ${item}`).join('\n') || '- 无'}\n`,
        ].join('\n');
        fs.writeFileSync(acceptanceFile, acceptance);
        managerRouter.recordProceed(managerState, stage, null);
        managerState.status = 'complete';
        persistManagerState();
        log(`项目经理验收完成：${acceptanceFile}`);
        rl.close();
        console.log(`\n全部阶段执行完毕。验收单：${managerCfg.acceptanceOutput}；日志：logs/pipeline.log`);
        return;
      }

      const targetId = decision.verdict === 'REWORK' ? stage.id : decision.nextStageId;
      const targetIdx = stages.findIndex((item) => item.id === targetId);
      const targetStage = stages[targetIdx];
      if (!targetStage) throw new Error(`项目经理路由目标不存在：${targetId}`);
      if (!managerRouter.canRework(managerState, targetId)) {
        const budgetDecision = createBudgetEscalation(targetStage, targetId, decision);
        const answer = await pauseForHuman(budgetDecision, targetStage, 'review', 'rework-budget');
        if (!answer) return;
        i = targetIdx;
        managerAmend = budgetDecision.escalation.workOrder
          ? `${answer.text}\n\n${managerProtocol.formatWorkOrder(budgetDecision.escalation.workOrder)}`
          : answer.text;
        continue;
      }
      managerRouter.recordRework(managerState, targetId, decision.verdict, decision.reason);
      if (decision.verdict === 'RETURN_UPSTREAM') managerRouter.invalidateFrom(managerState, stages, targetIdx);
      managerState.resumeStageId = targetId;
      workOrder = decision.workOrder;
      managerState.nextWorkOrder = workOrder;
      persistManagerState();
      log(`[pm-review-${stage.id}] ${decision.verdict} → ${targetId}（总返工 ${managerState.rework.total}）`);
      i = targetIdx;
    }
    log(`项目经理模式完成指定阶段范围：${fromId} → ${toId}`);
    rl.close();
  }

  // 执行单个阶段：组装 prompt → 经适配器调用 CLI → 产物落盘；限额/超时/模型不可用自动切换候选重跑；
  // 角色输出 DELEGATE 标记段时换目标角色重跑本阶段（每阶段最多 DELEGATE_MAX_HOPS 次）
  function runStage(stage, extraAmend, opts = {}) {
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
    if (extraAmend && memoryDir && baseAgentDef.memory !== false) appendMemoryEvent(stage, extraAmend, opts.amendLabel || '用户修订');

    let agentId = stage.agent; // 当前执行角色（委托后变化，知识/记忆随最终执行者）
    let delegateCtx = null;    // 委托上下文（来自前一角色的交接）
    let hops = 0;              // 本阶段已委托次数

    for (;;) { // 委托循环：DELEGATE 生效时换角色重跑本阶段
      const agentDef = agentsConfig.agents[agentId] || baseAgentDef;
      let prompt = basePrompt;

      const contextParts = [];
      for (const inputRel of stage.input || []) {
        const inputAbs = resolveWork(inputRel);
        if (managerState && managerState.invalidatedOutputs.includes(inputRel)) {
          log(`[${stage.id}] 跳过已失效输入产物 ${inputRel}`);
        } else if (fs.existsSync(inputAbs)) {
          contextParts.push(`\n\n===== 上下文输入：${inputRel} =====\n` + fs.readFileSync(inputAbs, 'utf8'));
        } else {
          log(`[${stage.id}] 警告：输入产物缺失 ${inputRel}，继续执行`);
        }
      }
      if (contextParts.length) prompt += contextParts.join('');
      if (opts.workOrder) prompt += `\n\n===== 项目经理任务书 =====\n` + managerProtocol.formatWorkOrder(opts.workOrder);
      if (extraAmend) prompt += `\n\n===== ${opts.amendLabel || '用户修订意见'}（请据此更新产物，其余内容保持一致） =====\n` + extraAmend;
      if (opts.appendix) prompt += `\n\n` + opts.appendix;
      // 角色协作上下文：记忆 + 知识库 + 标记段协议（agent 级 knowledge/memory:false 或全局开关关闭）
      const knowledgeOn = !!knowledgeDir && agentDef.knowledge !== false;
      const memoryOn = !!memoryDir && agentDef.memory !== false;
      if (knowledgeOn || memoryOn) prompt += contextBlockFor(agentId, stage, { knowledgeOn, memoryOn, delegateOn: delegateOn && opts.allowDelegate !== false });
      if (delegateCtx) prompt += delegateBlock(delegateCtx);

      // 模型候选链：阶段级显式模型 > 代理级模型 > 阶段/代理 fallbackModels > 适配器动态模型 > auto
      // 无自定义模型的适配器（claude/codex/plain）候选链为空 → [null] → 不拼 --model，直接用 CLI 自带模型
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
      const modelList = rankByHealth(candidates.length ? candidates : [null]);
      const modelLabel = (m) => (m === null ? 'CLI自带' : String(m));

      const stageTimeoutMs = cliCfg.timeoutMs || 600000;
      const namedCapMs = cliCfg.modelAttemptTimeoutMs || 0;
      let finalStdout = null;
      for (let ci = 0; ci < modelList.length; ci++) {
        const current = modelList[ci];
        const next = modelList[ci + 1] || null;
        const fb = runner.supportsFallbackFlag ? next : null;
        // 命名模型（含自定义模型）单独限时，卡死就快速换候选；CLI 自带模型独占整段预算
        const named = current !== null && current !== 'auto';
        const timeoutMs = (named && namedCapMs > 0 && namedCapMs < stageTimeoutMs) ? namedCapMs : stageTimeoutMs;

        log(`[${stage.id}] ${stage.name}（agent=${agentId}${agentId !== stage.agent ? '(委托)' : ''}@${runner.name}）开始，模型=${modelLabel(current)}${fb ? `，CLI回退=${fb}` : ''}，超时=${Math.round(timeoutMs / 1000)}s`);
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
        // 超时 / 限额 / 模型不可用 / 连接异常都算「换个候选也许就行」，其余按阶段失败处理
        const kind = adapter.classifyFailure(result, adapter.failureText(stderr, stdout));
        log(`[${stage.id}] 执行失败：exit=${result.status} signal=${result.signal || '-'}${kind ? `（${adapter.FAILURE_LABELS[kind]}）` : ''}`);
        if (kind) markModelFailure(current, kind);
        if (kind && ci < modelList.length - 1) {
          log(`[${stage.id}] 模型 ${modelLabel(current)} ${adapter.FAILURE_LABELS[kind]}，自动切换候选 → ${modelLabel(modelList[ci + 1])}`);
          if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 1500)}`);
          continue;
        }
        if (result.error) log(`[${stage.id}] error: ${result.error.message}`);
        if (stderr) log(`[${stage.id}] stderr: ${stderr.slice(0, 2000)}`);
        if (stdout) log(`[${stage.id}] stdout 尾部: ${stdout.slice(-2000)}`);
        if (kind) log(`[${stage.id}] 候选模型已用尽（最后失败：${adapter.FAILURE_LABELS[kind]}），本阶段按失败处理`);
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

      let report = null;
      if (managerCfg && !opts.managerGate) {
        try {
          const parsed = managerProtocol.parseSpecialistReport(body);
          body = parsed.body;
          report = parsed.report;
        } catch (error) {
          log(`[${stage.id}] 失败：${error.message}`);
          return { ok: false, errText: error.message };
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
      return { ok: true, agent: agentId, body, report };
    }
  }

  (async () => {
    if (managerCfg) {
      await runManagedPipeline();
      return;
    }
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
      if (retryCfg && stage.id === retryCfg.checkStage && stage.output && !stageResult.dry) {
        let report = null;
        try {
          report = fs.readFileSync(resolveWork(stage.output), 'utf8');
        } catch (error) {
          log(`[${stage.id}] 回炉检查：产物读取失败，验证未通过（${error.message}）`);
          process.exit(2);
        }
        if (!/VERDICT:\s*(PASS|FAIL)/.test(report)) {
          log(`[${stage.id}] 回炉检查：验证报告缺少 VERDICT: PASS/FAIL，验证未通过`);
          process.exit(2);
        }
        if (new RegExp(retryCfg.failPattern).test(report)) {
          if (retryUsed >= retryMaxRounds) {
            log(`[${stage.id}] 验证未通过（命中 ${retryCfg.failPattern}），回炉轮数已用尽（${retryMaxRounds}），项目阻塞；失败明细见 ${stage.output}`);
            process.exit(2);
          } else {
            const resumeIdx = stages.findIndex((s) => s.id === retryCfg.resumeStage);
            if (resumeIdx === -1 || resumeIdx >= i) {
              log(`[${stage.id}] 回炉配置无效：resumeStage=${retryCfg.resumeStage} 不存在或不在 checkStage 之前，项目阻塞`);
              process.exit(2);
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
