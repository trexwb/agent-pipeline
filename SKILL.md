---
name: agent-pipeline
version: 1.3.0
display_name: 多 Agent 开发流水线
description: 多 Agent 软件开发流水线编排器，把一条需求自动推进到可交付代码。提供两条流水线：新功能走「产品规划、需求拆解、架构设计、开发编码、代码审查、测试、部署」7 阶段；功能修复（bug/报错/行为不符）走「分析、方案、修复、验证、PR 描述」5 阶段，手动修复需求或 GitHub Issue 自动触发均可，验证不通过自动回炉重修。阶段间用 artifacts 传递产物，支持人工确认、远程确认、断点续跑与限额自动换模型；每个角色自带持久知识库（跨任务可复用经验）、过程记忆（执行摘要/交接便签/用户修订自动入记忆）与动态委托能力（发现本阶段更适合其他角色时自动换人重跑）。This skill should be used when 用户想从一个想法自动走到部署、要求按阶段编排多个 AI agent 协作、想让不同阶段使用不同角色或模型、要让角色积累复用经验或记住任务过程、要跑需求构建器生成 A/B 双版本需求、要修复现有功能的故障、或需要 GitHub Issue 自动修复循环。触发词包括 自动编排、流水线、pipeline、从需求到开发完成、多 Agent 协作、阶段化开发、功能修复、修复需求、bug 修复流水线、角色知识库、角色记忆、动态委托、issue 自动修复。适用于 WorkBuddy、CodeBuddy、zCode、Qoder、Marvis、Claude Code、Codex 及任意兼容 Agent Skills 的宿主或自定义 agent CLI。不用于单文件小改动、简单问答或直接的代码片段生成。
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# 多 Agent 开发流水线（agent-pipeline）

把软件开发拆成多个阶段，每个阶段由独立子 Agent（角色 + 系统提示词 + 模型 + 工具白名单）执行，阶段间通过 `artifacts/` 传递产物。编排器负责组装 prompt → 调用宿主 agent CLI → 落盘产物 → 人工确认 / 断点续跑 / 限额自动切换模型。

本 skill 是**纯 Node.js 编排壳**（Node >= 18，零 npm 依赖），自身不实现 AI 能力，AI 能力来自当前宿主的 agent CLI。

## 技能契约

> 本节定义技能的行为规范。宿主 Agent 加载本 skill 后**必须**遵守；`scripts/` 是实现层，不改变契约。

### 目标

帮助用户「从一个想法自动走到部署」或「一条修复需求自动走到可发布修复」：把用户需求拆分为固定阶段，每个阶段交由指定角色/模型完成，阶段之间顺序衔接，直至全流程完成。

### 输入

- 用户在自定义 agent CLI 工具中输入的需求描述。
- 未提供需求描述时不得启动流水线：列出缺失项并请用户补充。

### 需求路由（先判定，再启动）

按需求性质二选一，两条流水线不得混用：

- **开发流水线**：从零构建新功能 / 新产品，或对现有系统做增量演进 → 7 阶段（下表一）。
- **修复流水线**：现有功能出现故障、报错、行为与预期不符、需要回退或修补 → 5 阶段（下表二）。修复需求可由用户直接描述（`--pipeline fix --requirement "<描述>"`），也可由 GitHub Issue 自动触发。

### 工作流与角色

在同一条流水线内严格按照阶段顺序执行，前一阶段完成后再进入下一阶段。每个阶段只由表中指定的角色执行，不得跳过或调换阶段顺序。

**表一：开发流水线（7 阶段，默认）**

| 序号 | 阶段 | 当前执行角色 | agent id | 阶段产出 |
|------|------|--------------|----------|----------|
| 1 | 产品规划 | 产品规划引导师 | `product-manager` | `artifacts/01-prd.md` |
| 2 | 需求拆解 | 需求拆解与功能点呈现专员 | `requirement-analyst` | `artifacts/02-tasks.md` |
| 3 | 架构设计 | 架构师 | `architect` | `artifacts/03-architecture.md` |
| 4 | 开发编码 | 全栈开发工程师 | `developer` | `artifacts/04-implementation.md` + 代码写入项目目录 |
| 5 | 代码审查 | 代码审查工程师 | `code-reviewer` | `artifacts/05-review.md` |
| 6 | 测试 | 测试工程师 | `tester` | `artifacts/06-test-report.md` |
| 7 | 部署 | 运维工程师 | `devops` | `artifacts/07-deploy.md` |

**表二：修复流水线（5 阶段，`--pipeline fix`）**

| 序号 | 阶段 | 当前执行角色 | agent id | 阶段产出 |
|------|------|--------------|----------|----------|
| 1 | 修复需求分析 | 代码审查工程师 | `code-reviewer` | `artifacts/issue-analysis.md` |
| 2 | 修复方案设计（需确认） | 架构师 | `architect` | `artifacts/issue-fix-plan.md` |
| 3 | 开发修复 | 全栈开发工程师 | `developer` | `artifacts/issue-fix-done.md` + 代码写入项目目录 |
| 4 | 修复验证 | 测试工程师 | `tester` | `artifacts/issue-test-report.md`（末行 `VERDICT: PASS|FAIL`） |
| 5 | PR 描述 | 运维工程师 | `devops` | `artifacts/issue-pr.md` |

修复验证产物末行标记 `VERDICT: FAIL` 且轮数未用尽时，编排器自动携带验证报告回到「开发修复」阶段重修（默认最多 2 轮，`--fix-rounds` 可调，`0` 关闭）；轮数用尽则如实推进并在汇报中注明未通过。

> 提示词模板中「·架构方案推荐师」等后缀是对该角色能力的补充说明，不构成额外角色。

### 角色记忆与协作（知识库 · 记忆 · 动态委托）

每个角色默认同时具备三种能力，同一工作目录下的重复运行持续积累：

**1. 知识库（跨任务的可复用事实经验）**

- 注入：该角色 `knowledge/<agent-id>.md` 末尾最近 4000 字符拼进 prompt；沉淀：`KNOWLEDGE APPEND` 标记段抽取入库，产物自动剥离。
- 位置默认 `<work-dir>/knowledge/`；`--knowledge-dir` 指向固定目录可跨项目共享；`--no-knowledge` 全局关闭，角色 `knowledge: false` 按角色关闭。

**2. 记忆（任务过程上下文，与知识库互补）**

- 注入：执行阶段时自动带出 `[工作记忆·本阶段]`（该角色上次执行本阶段的摘要、用户曾给的修订意见）与 `[工作记忆·前序阶段交接]`（其他角色写给后续阶段的便签）——断点续跑、`--from` 重跑、修订后重跑不再失忆。
- 沉淀：角色输出 `MEMORY APPEND` 标记段（`summary:` 本次执行摘要 + `handoff:` 给后续阶段的交接提示），分别写入 `memory/<agent-id>.md` 与 `memory/handoffs.md`；**用户修订意见（交互 amend / `--amend` / 回炉报告）由编排器自动记入记忆**，重跑同阶段时自动提醒「用户曾要求…」。
- `--no-memory` 全局关闭；角色 `memory: false` 按角色关闭；目录固定 `<work-dir>/memory/`。

**3. 动态委托（角色可插手其他角色的工作）**

- 角色执行中发现本阶段更适合其他角色时，输出 `DELEGATE` 标记段（`target:`/`reason:`/`handoff:`）；编排器自动**换目标角色重跑本阶段**，原角色的初步产出与交接说明作为上下文带入，知识/记忆沉淀归属最终执行者。
- 边界：只能委托给 `agents.json` 内的角色；每阶段最多换一次执行角色（防循环）；**只换执行者，不改变阶段顺序、产物路径与验收要求**；确认责任仍在原阶段。
- `--no-delegate` 全局关闭。

三种能力的标记段均附在回复正文之后、不计入产物文档；知识/记忆文件均为追加式 Markdown，可人工编辑修剪。

### 执行步骤

1. 接收用户输入的需求。
2. 按「需求路由」判定流水线类型（开发 / 修复），并向用户说明判定结果。
3. 按所选流水线的阶段顺序逐一调用对应角色推进任务。
4. 每个阶段完成后，输出该阶段的产出，再进入下一阶段。
5. 全部阶段完成后，汇总整条流水线的执行结果。

实现层映射：每阶段对应 `run-pipeline.js` 的一次 CLI 调用，产物由编排器从 stdout 落盘。宿主默认带 `--interactive`，开发流水线阶段 1/2、修复流水线阶段 2（修复方案）的确认点会把产物与「待定假设」一并转述给用户，得到确认后再继续；后续阶段输入出现歧义时应暂停，用 `--from <阶段> --amend "<意见>"` 重跑，不得擅自推进。`--from` / `--to` 仅用于失败续跑或用户明确指定的阶段范围，不得用来默认跳过阶段。修复验证的回炉重修由编排器自动完成，无需宿主介入。

### 输出格式

按阶段分条输出，每条包含**阶段序号与名称、当前执行角色、该阶段产出**；最终输出**一条全流程汇总**，按实际执行的流水线覆盖全部阶段：

```text
【阶段 1｜产品规划】
执行角色：产品规划引导师
阶段产出：<产物摘要 + artifacts/01-prd.md 路径>

（后续阶段同格式）

【全流程汇总｜开发流水线】
1 产品规划 ✓ / 2 需求拆解 ✓ / 3 架构设计 ✓ / 4 开发编码 ✓ / 5 代码审查 ✓ / 6 测试 ✓ / 7 部署 ✓
代码目录：<projectDir>；日志：logs/pipeline.log；未实际执行的部署动作说明
```

修复流水线同格式，汇总行为：

```text
【全流程汇总｜修复流水线】
1 修复需求分析 ✓ / 2 修复方案设计 ✓ / 3 开发修复 ✓（重修 N 轮）/ 4 修复验证 ✓（VERDICT: PASS）/ 5 PR 描述 ✓
代码目录：<projectDir>；日志：logs/pipeline.log；验证未通过时注明剩余风险与失败明细位置
```

### 约束

- **输出语言**：简体中文；英文术语、代码、命令与专名保持原样。
- **阶段与角色**：每个阶段只由工作流中指定的角色执行，不得跳过或调换阶段顺序。
- **流水线路由**：修复类需求（现有功能故障/报错/行为不符）必须走修复流水线，不得用 7 阶段开发流硬套；从零构建必须走开发流水线。路由不确定时向用户确认。
- **信息缺失**：列出缺失项并请用户补充后再继续，不得自行编造业务规则、数据或结论。
- **超出范围**：说明超出范围的原因，返回可用的阶段与角色清单供用户选择，不启动流水线。
- **歧义与不确定**：标注假设点并请求用户确认后再执行对应阶段。
- **知识库与记忆安全**：知识库只沉淀可复用的事实性经验，记忆只记录任务过程上下文；两者均严禁记录密钥、token、凭据与敏感路径。
- **委托边界**：动态委托只换本阶段执行者，不得用于跳过阶段、合并阶段或转交人工确认责任；产物验收标准不因委托放松。

## 何时使用

| 场景 | 入口 |
|------|------|
| 新功能需求已明确，想一次跑完规划到部署 | `scripts/run-pipeline.js`（默认开发流水线） |
| 现有功能出了故障/报错/行为不符，想直接描述问题走「分析→方案→修复→验证→PR 描述」 | `scripts/run-pipeline.js --pipeline fix --requirement "<问题描述>"` |
| 需求还没想清楚，需要先澄清并生成双版本需求 | `scripts/req-builder.js` |
| 已有仓库，希望新 Issue 自动分析、修复、验证、出 PR 描述 | `scripts/watch-issues.js`（内部走 `--pipeline fix`） |
| 想先把远端项目拉到开发分支再跑流水线 | `scripts/init-project.js` |

不要在只需要改一个函数、回答一个问题时启动流水线；全流程会多次调用 CLI，成本与时间较高。请求超出编排范围时，按「约束」说明原因并返回上面两条流水线的阶段清单供用户选择，不要启动流水线。

## 在宿主中如何执行

本节是给加载了本 skill 的宿主 Agent 的操作指令。所有路径以 **skill 根目录**（`SKILL.md` 所在目录，下称 `<SKILL_DIR>`）为基准；安装后的目录可能只读，**所有运行时产物必须写在工作目录而非 `<SKILL_DIR>`**。

1. **定位**。确定 `<SKILL_DIR>` 绝对路径，并确定工作目录 `<WORK_DIR>`：优先使用用户指定的目录，否则用当前项目根目录。执行 `node --version` 确认 Node >= 18。
2. **确认宿主 CLI**。运行 `node <SKILL_DIR>/scripts/run-pipeline.js --dry-run --project-name <项目名>` 查看探测到的适配器。宿主可通过 `AGENT_PIPELINE_HOST` 指定（取值 `workbuddy` / `codebuddy` / `zcode` / `qoder` / `marvis`），未指定时按环境变量与系统命令自动探测。若探测失败，引导用户安装该宿主的 CLI，或改用 `--adapter plain` 并配置 `plain.command`。
3. **选择入口**。
   - 需求模糊：先 `node <SKILL_DIR>/scripts/req-builder.js --guide` 取得 7 维度引导，收集用户回答后 `--build "<需求文本>"` 生成 A/B 双版本，把两个版本呈现给用户选择，再用 `--select A|B` 写入 `artifacts/00-requirement.md`。可加 `--auto-run --project-name <项目名>` 自动续跑。
   - 新功能需求明确：直接 `node <SKILL_DIR>/scripts/run-pipeline.js --project-name <项目名> --interactive`。
   - 修复需求（现有功能故障/报错/行为不符）：`node <SKILL_DIR>/scripts/run-pipeline.js --project-name <项目名> --project-dir <代码目录> --pipeline fix --requirement "<问题描述>" --interactive`。修复方案（阶段 2）产出后暂停确认；验证不通过由编排器自动回炉重修。
4. **处理确认**。`--interactive` 需要人在终端输入；当宿主是 IDE/聊天界面、无法等待 stdin 时，改用 `--remote`：编排器在确认点写 `artifacts/.confirm-state.json`、打印 `REMOTE_CONFIRM_NEEDED` 并以 exit 42 退出。宿主 Agent 应读取该状态文件，把阶段产物转述给用户，收集「确认 / 修改意见」：
   - 确认 → 以 `--from <nextStageId>` 续跑；
   - 修改意见 → 以 `--from <stageId> --amend "<意见>"` 重跑该阶段。
   - 协议细节与状态文件 schema 见 `references/remote-confirm.md`。
5. **失败与续跑**。阶段失败 exit 2，用 `--from <失败阶段>` 续跑，前序产物保留不浪费；退出码 0 成功、1 配置或 CLI 错误、42 等待远程确认。
6. **交付汇报**。严格按「输出格式」章节输出：逐阶段分条列出阶段序号与名称、当前执行角色、该阶段产出（含产物路径），最后给出覆盖 7 个阶段的全流程汇总，并注明代码目录 `<projectDir>`、日志 `logs/pipeline.log` 与编排器未实际执行的部署动作。

## 快速开始

前置：Node.js >= 18；已安装并登录当前宿主的 agent CLI。以下命令中 `node scripts/...` 均相对于 `<SKILL_DIR>`；在 skill 目录外执行时换成绝对路径，并用 `--work-dir <WORK_DIR>` 指定产物位置。

```bash
# 0. 演练：只打印各阶段命令，同时校验 CLI 可用
node scripts/run-pipeline.js --project-name demo-app --dry-run

# 1. 交互引导（推荐）：01/02 产出后暂停审阅；y 确认，或输入修改意见（!done 结束）让 agent 重跑
node scripts/run-pipeline.js --project-name demo-app --interactive

# 2. 只跑前置段（产品分析 + 需求细化），确认后退出
node scripts/run-pipeline.js --project-name demo-app --interactive --init-only

# 3. 需求确认后自动跑完（架构 → 开发 → 审查 → 测试 → 部署）
node scripts/run-pipeline.js --project-name demo-app --from 03-architecture

# 4. 全自动；或指定阶段范围
node scripts/run-pipeline.js --project-name demo-app
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test

# 5. 远程确认（适合 IDE / IM 机器人 / 聊天宿主）
node scripts/run-pipeline.js --project-name demo-app --remote
```

需求构建器与功能修复：

```bash
node scripts/req-builder.js --guide
node scripts/req-builder.js --build "<你的需求文本>"
node scripts/req-builder.js --select A
node scripts/req-builder.js --select A --auto-run --project-name demo-app

# 手动修复需求：直接描述故障，走「分析→方案→修复→验证→PR 描述」5 阶段
node scripts/run-pipeline.js --project-name demo-app --project-dir ./demo-app \
  --pipeline fix --requirement "登录页在 Safari 下提交报错 XXX" --interactive
# 验证不通过自动回炉重修，最多 N 轮（默认 2，0=关闭）
node scripts/run-pipeline.js --project-name demo-app --pipeline fix \
  --requirement "..." --fix-rounds 3

# 编辑 config/github.json（owner/repo/localProjectDir，token 走 GITHUB_TOKEN 环境变量）
node scripts/watch-issues.js --once        # 单轮，配 cron / 计划任务
node scripts/watch-issues.js               # 默认常驻轮询（不带 --once 即常驻）
```

## 参数速查（run-pipeline.js）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--project-name` | 项目名，注入 prompt 的 `{projectName}` | 必填 |
| `--project-dir` | 项目代码目录（开发/测试/部署的工作目录） | `<project-root>/<project-name>` |
| `--project-root` | 项目根目录 | 当前目录 |
| `--work-dir` | 工作目录：artifacts/、logs/、状态文件与自定义模板的根 | 当前目录 |
| `--pipeline feature\|fix` | 流水线预设：开发 7 阶段 / 修复 5 阶段，与 `--pipeline-config` 互斥 | `feature` |
| `--requirement "<文本>"` | 需求原文，写入 `artifacts/00-requirement.md` 作首阶段输入 | 无 |
| `--from` / `--to` | 起止阶段 id | 首/末阶段 |
| `--interactive` | confirm 阶段产出后暂停审阅，可回灌修订意见 | false |
| `--remote` | confirm 阶段产出后写状态文件并 exit 42 | false |
| `--init-only` | 跑到最后一个需确认的阶段即退出 | false |
| `--amend "<意见>"` | 修订意见追加进 `--from` 阶段重跑 | 无 |
| `--fix-rounds <n>` | 修复验证未通过的自动回炉轮数，`0`=关闭 | 流水线配置 `retry.maxRounds`（修复流默认 2） |
| `--knowledge-dir <dir>` | 角色知识库目录（注入历史经验 + 沉淀新知识） | `<work-dir>/knowledge` |
| `--no-knowledge` | 关闭角色知识库（不注入、不沉淀） | false |
| `--no-memory` | 关闭角色记忆（执行摘要/交接便签/用户修订入记忆） | false |
| `--no-delegate` | 关闭动态委托（角色声明换更合适角色执行本阶段） | false |
| `--dry-run` | 只打印命令不执行 | false |
| `--pipeline-config` / `--agents-config` / `--cli-config` | 配置路径覆盖 | `config/` 下默认值 |
| `--adapter` | 强制适配器 | auto |
| `--timeout-ms` | 单阶段 CLI 超时 | `config/cli.json` 的 `timeoutMs` |

## 多平台兼容与安装

本 skill 遵循 **Agent Skills 开放标准**：目录内 `SKILL.md` 的 `name` + `description` 是五个宿主的唯一必需字段；其余 frontmatter 字段与元数据文件按宿主能力可选，未知字段会被忽略。安装目录名必须与 `name` 一致，即 `agent-pipeline`（小写 kebab-case，zCode 强制要求）。

| 宿主 | 用户级目录 | 项目级目录 | 附加元数据 |
|------|-----------|-----------|-----------|
| WorkBuddy | `~/.workbuddy/skills/agent-pipeline/` | `.workbuddy/skills/agent-pipeline/` | `_skillhub_meta.json` |
| CodeBuddy | `~/.codebuddy/skills/agent-pipeline/` | `.codebuddy/skills/agent-pipeline/` | `_skillhub_meta.json` |
| zCode | `~/.zcode/skills/agent-pipeline/` 或 `~/.agents/skills/agent-pipeline/` | `.zcode/skills/agent-pipeline/` 或 `.agents/skills/agent-pipeline/` | 无 |
| Marvis | `~/.marvis/skills/custom/agent-pipeline/` | 不支持项目级 | `meta.json`（必需） |
| Qoder | `~/.qoder/skills/agent-pipeline/`（国内版 `~/.qoder-cn/skills/agent-pipeline/`） | `.qoder/skills/agent-pipeline/` | `metadata.json`（可选） |

一键安装（在 skill 源码目录执行）：

```bash
# 查看将要安装到哪些位置，不写任何文件
node scripts/install.js --dry-run

# 只给本机已检测到的宿主做用户级安装
node scripts/install.js --platform auto --scope user

# 指定宿主、项目级安装（复制而非软链）
node scripts/install.js --platform codebuddy,workbuddy,qoder,zcode,marvis --scope project --project-root /path/to/repo

# 开发模式：建立软链，改源码即时生效
node scripts/install.js --platform auto --scope user --link

# 卸载
node scripts/install.js --platform auto --scope user --uninstall
```

各宿主的发现优先级、frontmatter 差异、CLI 兼容性与已知限制见 `references/platform-compat.md`。

## CLI 适配层

`scripts/lib/adapter.js` 把统一的「prompt + 角色 + 模型」翻译成具体 CLI 参数，`run-pipeline.js` 每阶段只经这一层调用一次 CLI。

| 适配器 | CLI 命令 | 角色注入 | 模型 | 限额回退 | 备注 |
|--------|----------|----------|------|----------|------|
| `codebuddy` | `codebuddy` / `cbc` / `workbuddy` | 原生 `--agent --agents` | `--model` | `--fallback-model` + 换模型重跑 | 唯一支持工具白名单、`effort`、`maxTurns`；WorkBuddy 内置 CLI 与 CodeBuddy 同源，自动归入此适配器 |
| `claude` | `claude` | `--append-system-prompt` | `--model` | 仅换模型重跑 | 无原生多代理 |
| `codex` | `codex` | 角色拼进任务头部 | `-m` | 仅换模型重跑 | `codex exec --skip-git-repo-check` |
| `plain` | `plain.command` 或宿主默认命令 | 角色拼进 prompt | 不支持 | 不支持 | zCode / Qoder / Marvis 等 CLI 的通用兜底 |

选择优先级：`AGENT_PIPELINE_ADAPTER` 环境变量 > `--adapter` > `config/cli.json` 的 `adapter` > `autoDetect` 依次探测。宿主专属命令可用 `AGENT_PIPELINE_HOST` 指定，或用 `*_CLI_CMD` 环境变量覆盖。

约束：**适配器是流水线级的**，一次运行只用一个适配器，不支持按阶段混用；可按阶段覆盖的只有 `model` 与 `fallbackModels`。

## 定制与扩展

- **改阶段**：编辑 `config/pipeline.json`，增删 `stages` 项；`confirm: true` 标记需确认；`input` 指向前序产物；`output: null` 表示不落盘该阶段 stdout。
- **改角色/模型**：编辑 `config/agents.json`；`model` 填 `auto` 或具体模型 ID，`fallbackModels` 为限额回退候选；阶段级配置优先于代理级。
- **改提示词**：编辑 `prompts/*.md`，支持 `{projectName}` / `{projectDir}` / `{userNeed}` 占位符。把同名文件放 `--work-dir` 下可覆盖内置模板，无需改动只读的安装目录。
- **管知识库与记忆**：`knowledge/<agent-id>.md`、`memory/<agent-id>.md`、`memory/handoffs.md` 均为追加式 Markdown，可随时人工修剪过时条目；知识库跨项目共享用 `--knowledge-dir ~/.agent-pipeline/knowledge`；按角色关闭改 `agents.json` 的 `knowledge` / `memory` 字段；`--no-knowledge` / `--no-memory` / `--no-delegate` 全局关闭对应能力。
- **换 CLI**：改 `config/cli.json` 的 `adapter` 或 `hostCommands`，详见 `references/platform-compat.md`。

## 目录

```
agent-pipeline/
├── SKILL.md                 # 本文件（给宿主 Agent 的指令）
├── meta.json                # Marvis / WorkBuddy 展示元数据（版本号唯一权威来源）
├── CHANGELOG.md             # 版本历史、待办问题与迭代闭环
├── README.md                # 仓库说明与安装入口
├── config/                  # cli / agents / pipeline / issue-pipeline / github 五份配置
├── prompts/                 # 13 个阶段提示词模板
├── references/
│   ├── platform-compat.md   # 五平台路径、元数据、CLI 差异
│   └── remote-confirm.md    # 远程确认协议（exit 42 状态文件 schema）
└── scripts/
    ├── install.js           # 一键安装到五个宿主
    ├── version.js           # 版本号管理 CLI（记录问题 / 发版 / 校验 / 盘点）
    ├── run-pipeline.js      # 主编排器
    ├── req-builder.js       # 需求构建器
    ├── init-project.js      # git 拉取项目
    ├── watch-issues.js      # GitHub Issue 监听
    └── lib/
        ├── adapter.js       # CLI 适配层
        ├── platforms.js     # 五宿主安装位置共享定义
        └── version.js       # 版本权威读取、同步、发版与盘点
```

> 运行时产物 `artifacts/`、`logs/`、`data/` 与状态文件一律写入 `--work-dir`（默认当前目录），不写入 skill 安装目录。

## 注意事项

1. **权限**：`permissions: skip`（默认）会携带跳过权限确认的参数（如 `--dangerously-skip-permissions` / `--full-auto`），仅在可信项目使用；改 `cli.json` 为 `ask` 可关闭。
2. **产物上下文**：每阶段自动把 `input` 指定的产物全文拼进 prompt；缺失仅告警不中断。提示词模板要求子 Agent 把文档正文输出到 stdout，由编排器统一落盘，严禁子 Agent 自行写产物文件。
3. **Windows**：npm 全局 `.cmd` 包装器会自动改为 node 直跑 JS 入口，规避 spawn EINVAL 与 shell 转义问题。
4. **只读安装目录**：市场安装的 skill 目录可能只读；配置覆盖用 `--work-dir`，不要用编辑安装目录的方式定制。
5. **退出码**：0 成功；1 配置/CLI 错误；2 阶段执行失败；42 远程确认挂起。

## 版本

1.3.0（唯一权威来源：`meta.json` 的 `version` 字段）

维护者用 `node scripts/version.js` 记录使用中问题、发版与校验一致性；版本历史与迭代流程见 `CHANGELOG.md`。升级各宿主已安装副本用 `node scripts/install.js --force`。
