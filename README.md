# agent-pipeline

多 Agent 软件开发流水线编排器：把一条需求自动推进到可交付代码。按七个阶段（产品规划 → 需求拆解 → 架构设计 → 开发编码 → 代码审查 → 测试 → 部署）驱动独立子 Agent 协作，阶段间用 `artifacts/` 传递产物；支持人工确认、远程确认、断点续跑、限额自动切换模型，并附带需求构建器与 GitHub Issue 自动修复循环。

遵循 **Agent Skills 开放标准**，一份 `SKILL.md` 可安装到 **WorkBuddy / CodeBuddy / zCode / Marvis / Qoder** 及任意兼容宿主。编排器本身是纯 Node.js 脚本（**Node.js >= 18、零 npm 依赖、macOS / Linux / Windows 通用**），AI 能力来自当前宿主的 agent CLI。

当前版本：**2.1.0**（唯一权威来源：`meta.json` 的 `version`；用 `node scripts/version.js` 管理，历史见 `CHANGELOG.md`）。

**内容导航**：[快速开始](#1-快速开始) · [安装](#2-安装到五个宿主) · [配置 CLI](#3-配置宿主-cli) · [运行流水线](#4-运行流水线) · [辅助入口](#5-三个辅助入口) · [定制](#6-定制不改动安装目录) · [故障排查](#7-故障排查) · [约定与退出码](#8-运行时约定与退出码) · [目录](#9-目录结构) · [版本管理](#10-版本管理与迭代) · [文档索引](#11-文档索引)

---

## 1. 快速开始

前置：Node.js >= 18；已安装并登录当前宿主的 agent CLI（如 CodeBuddy Code）。

```bash
# 1) 预览安装位置 → 安装到本机已检测到的宿主
node scripts/install.js --dry-run
node scripts/install.js --platform auto --scope user

# 2) 演练：校验阶段链、提示词与 CLI 探测（不调用模型）
node scripts/run-pipeline.js --project-name demo-app --project-root ./pipeline-run --work-dir ./pipeline-run --dry-run

# 3) 正式运行：01/02 产出后暂停审阅，可回灌修改意见
node scripts/run-pipeline.js --project-name demo-app --project-root ./pipeline-run --work-dir ./pipeline-run --interactive
```

`--project-root` 决定代码目录（默认 `<project-root>/<project-name>`），`--work-dir` 决定产物与日志；两者一起指定可把所有输出集中在一个目录、不污染当前工作区。

演练时若本机没有可用的 agent CLI，只会打印告警并继续校验阶段链，不会报错退出。安装后重启宿主或执行 `/skills reload`，在对话里说「帮我把这个需求自动编排到开发完成」即可触发 skill。

> 在 skill 目录外执行时，把 `scripts/...` 换成绝对路径；所有产物建议用 `--work-dir` 明确指定，避免写进只读的安装目录。

---

## 2. 安装到五个宿主

安装目录名固定为 `agent-pipeline`，与 `SKILL.md` frontmatter 的 `name` 一致（zCode 强制要求小写 kebab-case 且与目录名相同）。

| 宿主 | 用户级目录 | 项目级目录 | 安装时写入的元数据 |
|------|-----------|-----------|-------------------|
| WorkBuddy | `~/.workbuddy/skills/agent-pipeline/` | `.workbuddy/skills/agent-pipeline/` | `meta.json`、`_skillhub_meta.json`、`metadata.json` |
| CodeBuddy | `~/.codebuddy/skills/agent-pipeline/` | `.codebuddy/skills/agent-pipeline/` | 同上 |
| zCode | `~/.zcode/skills/agent-pipeline/` | `.zcode/skills/agent-pipeline/` | 同上（多余文件会被忽略） |
| Marvis | `~/.marvis/skills/custom/agent-pipeline/` | 不支持项目级 | 同上，`meta.json` 为必需项 |
| Qoder | `~/.qoder/skills/agent-pipeline/`；国内版 `~/.qoder-cn/skills/agent-pipeline/` | `.qoder/skills/agent-pipeline/` | 同上 |
| 通用 | `~/.agents/skills/agent-pipeline/` | `.agents/skills/agent-pipeline/` | 跨工具发现点，见下方 `common` |

### 安装器参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `--platform <列表>` | `workbuddy` / `codebuddy` / `zcode` / `marvis` / `qoder` / `common` / `auto` / `all`，逗号分隔可组合 | `auto` |
| `--scope <范围>` | `user` / `project` / `both` | `user` |
| `--project-root <路径>` | 项目级安装的根目录 | 当前目录 |
| `--link` | 建立目录软链而非复制（开发模式，改源码即时生效） | 关闭 |
| `--force` | 覆盖已存在的同名安装 | 关闭 |
| `--uninstall` | 卸载（仅删除含本 skill `SKILL.md` 的目录） | 关闭 |
| `--dry-run` | 只打印计划，不写任何文件 | 关闭 |

- `auto` = 只安装到本机已检测到的宿主配置目录；`all` = 五个主宿主（不含 `common`）；`common` = 通用 `.agents/skills`，一份安装可被 zCode / Codex / Cursor 等共同发现。
- Qoder 会自动识别 `~/.qoder` 与 `~/.qoder-cn`，两者都存在时各装一份。
- Marvis 自建 skill 必须放 `skills/custom/`（`skills/market/` 留给市场包），且无项目级目录。
- 项目级目标不能落在 skill 源码目录内，安装器会直接拒绝并提示换 `--project-root`。

### 常用安装命令

```bash
node scripts/install.js --platform all,common --scope user          # 全部宿主 + 通用发现点
node scripts/install.js --platform all --scope project --project-root /path/to/repo   # 团队共享
node scripts/install.js --platform auto --scope user --link         # 开发模式软链
node scripts/install.js --platform auto --scope user --force        # 升级覆盖旧版本
node scripts/install.js --platform all,common --scope user --uninstall
```

### 安装验收

```bash
node scripts/install.js --dry-run                                   # 目标路径是否正确
node scripts/run-pipeline.js --project-name smoke --project-root /tmp/ap-smoke --work-dir /tmp/ap-smoke --dry-run
```

1. 每个目标目录存在 `SKILL.md`，`name: agent-pipeline` 且与目录名一致；
2. Marvis 目标存在 `meta.json`，WorkBuddy / CodeBuddy 目标存在 `_skillhub_meta.json`；
3. `artifacts/`、`logs/`、`data/` 只出现在 `--work-dir`，安装目录保持干净。

各宿主的发现优先级、frontmatter 差异、CLI 方言与已知限制见 [`references/platform-compat.md`](references/platform-compat.md)。

---

## 3. 配置宿主 CLI

流水线每阶段通过 `scripts/lib/adapter.js` 调用一次宿主 CLI。这里有两个独立概念：

| 概念 | 变量 | 作用 |
|------|------|------|
| **宿主 host** | `AGENT_PIPELINE_HOST` | 决定调用哪个 CLI 命令、读哪份 `<configDir>/models.json` |
| **适配器 adapter** | `AGENT_PIPELINE_ADAPTER` / `--adapter` | 决定命令行参数方言 |

探测优先级：`AGENT_PIPELINE_ADAPTER` > `--adapter` > `config/cli.json` 的 `adapter` > 宿主探测 > `autoDetect` 依次探测。

### 方言对照

| 适配器 | 命令 | 角色注入 | 模型 / 回退 | 适用宿主 |
|--------|------|----------|-------------|----------|
| `codebuddy` | `codebuddy` / `cbc` / `workbuddy` | 原生 `--agent --agents` | `--model` + `--fallback-model` | CodeBuddy、WorkBuddy（两者 CLI 同源） |
| `claude` | `claude` | `--append-system-prompt` | `--model` | Claude Code |
| `codex` | `codex` | 角色拼进任务头 | `-m` | Codex CLI |
| `plain` | 宿主默认命令或 `plain.command` | 角色拼进 prompt | 不支持 | zCode、Qoder、Marvis、任意自定义 CLI |

### 环境变量

| 变量 | 用途 |
|------|------|
| `AGENT_PIPELINE_HOST` | `workbuddy` / `codebuddy` / `zcode` / `qoder` / `marvis` |
| `AGENT_PIPELINE_ADAPTER` | `codebuddy` / `claude` / `codex` / `plain` |
| `CODE_BUDDY_CMD`、`WORK_BUDDY_CMD` | 覆盖 CodeBuddy / WorkBuddy CLI 路径 |
| `ZCODE_CLI_CMD`、`QODER_CLI_CMD`、`MARVIS_CLI_CMD` | 覆盖对应宿主 CLI 路径 |
| `CLAUDE_CLI_CMD`、`CODEX_CLI_CMD`、`AGENT_CLI_CMD` | Claude / Codex / 通用兜底 |

```bash
# 显式声明宿主并指定 CLI 路径（macOS 上 WorkBuddy 内置 CLI 示例）
AGENT_PIPELINE_HOST=workbuddy \
WORK_BUDDY_CMD="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" \
node scripts/run-pipeline.js --project-name demo-app --dry-run
```

### 自定义命令（plain）

编辑 `config/cli.json`（或把它复制到 `--work-dir/config/cli.json` 后修改，不触碰安装目录）：

```json
{
  "adapter": "plain",
  "plain": {
    "command": "my-agent --run",
    "promptMode": "arg",
    "extraArgs": []
  }
}
```

- `command`：`adapter=plain` 且未命中宿主命令时必填，为空会直接报错；
- `promptMode`：`arg` = 提示词作为最后一个参数，`stdin` = 提示词写入标准输入；
- `extraArgs`：插在提示词之前的附加参数。

各宿主的默认命令、环境变量与方言写在 `config/cli.json` 的 `hostCommands` 里，可单独覆盖。例如某宿主 CLI 后续支持了 `--agent/--agents`，把对应 `adapter` 从 `plain` 改成 `codebuddy` 即可复用原生多代理能力，无需改代码。

> 默认 `config/agents.json` 的 `model` 为 `auto`（交给宿主 CLI 决定，跨宿主可移植）；限额回退候选由编排器从当前宿主 `<configDir>/models.json` 动态发现。需要固定模型时，用 `--agents-config` 指向自己的配置文件。

---

## 4. 运行流水线

```bash
# 全自动，或指定阶段范围
node scripts/run-pipeline.js --project-name demo-app --work-dir ./run
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --to 06-test --work-dir ./run

# 只跑前置段（产品规划 + 需求拆解），确认后退出
node scripts/run-pipeline.js --project-name demo-app --interactive --init-only --work-dir ./run

# 阶段失败 exit 2 后断点续跑；带修改意见重跑某阶段
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --work-dir ./run
node scripts/run-pipeline.js --project-name demo-app --from 04-develop --amend "补充登录校验" --work-dir ./run

# IDE / 聊天宿主：确认点写状态文件并 exit 42，交给外部转述与收集意见
node scripts/run-pipeline.js --project-name demo-app --remote --work-dir ./run
```

### 参数速查（`run-pipeline.js`）

| 参数 | 说明 | 默认 |
|------|------|------|
| `--project-name` | 必填，注入 prompt 的 `{projectName}` | — |
| `--project-dir` | 代码目录（开发/测试/部署阶段的工作目录） | `<project-root>/<project-name>` |
| `--project-root` | 项目根目录 | 当前目录 |
| `--work-dir` | `artifacts/`、`logs/`、状态文件与自定义模板/配置的根 | 当前目录 |
| `--from` / `--to` | 起止阶段 id | 首 / 末阶段 |
| `--interactive` | confirm 阶段暂停审阅，可输入修改意见重跑 | 关闭 |
| `--remote` | confirm 阶段写 `.confirm-state.json` 并 exit 42 | 关闭 |
| `--init-only` | 跑到最后一个需确认的阶段即退出 | 关闭 |
| `--amend "<意见>"` | 修订意见追加进 `--from` 阶段重跑 | — |
| `--dry-run` | 只打印命令，不调用 CLI | 关闭 |
| `--pipeline-config` / `--agents-config` / `--cli-config` | 配置路径覆盖 | `config/` 下默认值 |
| `--adapter` | 强制适配器 | `auto` |
| `--timeout-ms` | 单阶段 CLI 超时（毫秒） | `config/cli.json` 的 `timeoutMs`（3600000） |

### 阶段与产物

| 阶段 id | 角色 | 产物 | 需确认 |
|---------|------|------|--------|
| `01-product-plan` | 产品经理 | `artifacts/01-prd.md` | 是 |
| `02-requirements` | 产品经理 | `artifacts/02-tasks.md` | 是 |
| `03-architecture` | 架构师 | `artifacts/03-architecture.md` | 否 |
| `04-develop` | 开发 | `artifacts/04-implementation.md`（代码写入 `--project-dir`） | 否 |
| `05-code-review` | 审查 | `artifacts/05-review.md` | 否 |
| `06-test` | 测试 | `artifacts/06-test-report.md` | 否 |
| `07-deploy` | DevOps | `artifacts/07-deploy.md` | 否 |

`artifacts/00-requirement.md` 是可选的需求输入（由需求构建器生成），缺失时仅告警。每阶段会把 `input` 列出的前序产物全文拼进 prompt；提示词模板要求子 Agent 把文档正文输出到 stdout，由编排器统一落盘，禁止子 Agent 自行写产物文件。

### 确认机制

- `--interactive`：终端里 `y` 继续，或输入多行修改意见并以 `!done` 结束，让该阶段重跑；
- `--remote`：写 `artifacts/.confirm-state.json`、打印 `REMOTE_CONFIRM_NEEDED`、`exit 42`；外部读取后「确认 → `--from <nextStageId>`」或「修改 → `--from <stageId> --amend "<意见>"`」续跑；
- 协议细节与状态文件 schema 见 [`references/remote-confirm.md`](references/remote-confirm.md)。

---

## 5. 三个辅助入口

### 需求构建器（需求还模糊时）

```bash
node scripts/req-builder.js --guide                                  # 7 维度需求引导
node scripts/req-builder.js --build "<需求文本>" --work-dir ./run     # AI 生成精简版 A / 顶配版 B
node scripts/req-builder.js --select A --work-dir ./run              # 写入 artifacts/00-requirement.md
node scripts/req-builder.js --select A --auto-run --project-name demo-app --work-dir ./run --interactive
```

`--auto-run` 会把 `project-root` / `project-dir` / `work-dir` / `from` / `to` / `adapter` / `remote` / `interactive` 等参数透传给 `run-pipeline.js`。`--remote` 会额外写 `artifacts/.req-state.json`。

### GitHub Issue 自动修复

先编辑 `config/github.json`（或设置 `GITHUB_TOKEN` 环境变量）：

| 字段 | 说明 |
|------|------|
| `owner` / `repo` | 仓库坐标 |
| `token` | PAT，留空时读 `GITHUB_TOKEN` |
| `localProjectDir` | 本地仓库路径（必须已存在） |
| `intervalMs` | 轮询间隔，默认 300000 |
| `pipelineConfig` | 默认 `config/issue-pipeline.json` |
| `processExisting` | 是否处理存量 Issue，默认 `false` |
| `maxFixRounds` | 最大修复轮数，默认 2 |

```bash
export GITHUB_TOKEN=ghp_xxx
node scripts/watch-issues.js --once --work-dir ./run       # 单轮，适合 cron / 计划任务
node scripts/watch-issues.js --work-dir ./run              # 默认常驻轮询（不带 --once 即常驻）
```

首次运行只建立基线、不处理存量 Issue。修复流五阶段：Issue 分析 → 修复方案 → 修复开发 → 修复验证 → PR 描述，产物为 `artifacts/issue-*.md`。状态文件与流水线产物都写在 `--work-dir`。

### 拉取项目代码

```bash
node scripts/init-project.js --url git@github.com:org/repo.git --name demo-app --root /path/to/work --dry-run
node scripts/init-project.js --url git@github.com:org/repo.git --name demo-app --root /path/to/work
```

支持 `--dir` 指定目标目录、`--branch` 指定分支；未指定分支时优先 `DEV` / `dev` / `develop`。已有 git 仓库则 `fetch + checkout`，否则 `clone --single-branch`。

---

## 6. 定制（不改动安装目录）

市场安装的 skill 目录通常是只读的。编排器按「**`--work-dir` 下的同名文件优先 → skill 内置文件兜底**」解析模板与配置：

```text
<work-dir>/
├── config/
│   ├── pipeline.json        # 增删阶段、调整 confirm / input / output
│   ├── agents.json          # 角色提示词、模型、fallbackModels
│   └── cli.json             # 适配器、hostCommands、超时、权限
├── prompts/
│   └── 04-develop.md        # 覆盖单个阶段提示词
└── artifacts/               # 产物
```

也可用 `--pipeline-config` / `--agents-config` / `--cli-config` 直接指向自定义文件。提示词支持 `{projectName}` / `{projectDir}` / `{userNeed}` 占位符；阶段级 `model` / `fallbackModels` 优先于代理级配置。

> `config/cli.json` 默认 `permissions: skip`，会携带 `--dangerously-skip-permissions`（或 `--full-auto`）。仅在可信项目使用，改为 `ask` 可关闭。

---

## 7. 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| `未探测到受支持的 agent CLI` | CLI 不在 `PATH` 或未登录。设 `AGENT_PIPELINE_HOST` + 对应 `*_CLI_CMD`，或改 `config/cli.json` 的 `hostCommands` / `plain.command` |
| `agent CLI 不可用（--version 探测失败）` | 命令存在但无法执行（如 Node 版本过低、OAuth 过期）。先手动跑一次该 CLI 的 `--version` |
| `plain.command 为空` | 显式声明的宿主没有默认命令。配置 `plain.command` 或设置该宿主的 `*_CLI_CMD` |
| `未找到宿主默认命令` / 阶段一直用错 CLI | 检查 `AGENT_PIPELINE_HOST` 是否与 `config/cli.json` 的 `hostCommands` 键一致；`AGENT_PIPELINE_ADAPTER` 会覆盖方言 |
| 模型报 400 / 限额 | `config/agents.json` 默认 `auto`；若自定义了无效模型 ID，改回 `auto` 或替换 `fallbackModels`。编排器命中 quota/429/过载会自动切下一候选模型 |
| 阶段产物为空或只有 `(空输出)` | 子 Agent 把文档写进了文件而非 stdout。检查自定义提示词是否保留「输出方式（强约束）」段落 |
| 阶段失败 `exit 2` | 用 `--from <失败阶段>` 续跑；日志见 `logs/pipeline.log`，前序产物不会重算 |
| 安装时提示「目标目录位于 skill 源码目录内」 | `--project-root` 指向了 skill 源码目录，换一个真实项目根目录 |
| Skill 没被自动触发 | 重启宿主或执行 `/skills reload`；确认安装目录名与 `name` 一致；检查 `SKILL.md` 的 `description` 是否被宿主读取 |
| 项目级与用户级 skill 冲突 | 项目级通常优先（zCode 的 `.zcode/skills` 还优先于 `.agents/skills`），用 `--uninstall` 清理多余那份 |
| `version check` 报版本不一致 | 运行 `node scripts/version.js sync`；若刚改过代码，确认是否漏跑 `bump` |
| 宿主里仍是旧版功能 | `node scripts/version.js installed` 找出过期副本，用 `install.js --force` 升级后重启宿主 / `/skills reload` |

---

## 8. 运行时约定与退出码

- 产物 `artifacts/`、日志 `logs/`、状态文件 `data/`、`.confirm-state.json` / `.req-state.json` 一律写 `--work-dir`（默认当前目录），安装目录可保持只读，且这些路径已被 `.gitignore` 忽略。
- 适配器是**流水线级**的：一次运行只用一个 CLI 方言，不支持按阶段混用；可按阶段覆盖的只有 `model` / `fallbackModels`。
- 阶段失败时 `exit 2`，前序产物保留；远程确认挂起时 `exit 42`。

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 配置或 CLI 错误 |
| `2` | 阶段执行失败 |
| `42` | 等待远程确认（`REMOTE_CONFIRM_NEEDED`） |

---

## 9. 目录结构

```text
agent-pipeline/
├── SKILL.md                     给宿主 Agent 的指令（触发条件与执行流程）
├── README.md                    本文档：面向人的安装、配置与排障
├── CHANGELOG.md                 版本历史、待办问题与迭代闭环
├── meta.json                    Marvis / WorkBuddy 展示元数据（版本号唯一权威来源）
├── config/
│   ├── cli.json                 适配器、hostCommands、超时、权限
│   ├── agents.json              6 个子代理角色与模型
│   ├── pipeline.json            主流水线 7 阶段
│   ├── issue-pipeline.json      Issue 修复流 5 阶段
│   └── github.json              Issue 监听配置模板
├── prompts/                     13 个阶段提示词模板
├── references/
│   ├── platform-compat.md       五平台路径、元数据、CLI 差异与验收清单
│   └── remote-confirm.md        远程确认协议（exit 42 状态文件 schema）
└── scripts/
    ├── install.js               一键安装 / 卸载到五个宿主
    ├── version.js               版本号管理 CLI
    ├── run-pipeline.js          主编排器
    ├── req-builder.js           需求构建器
    ├── init-project.js          git 拉取项目
    ├── watch-issues.js          GitHub Issue 监听
    └── lib/
        ├── adapter.js           CLI 适配层（宿主探测与方言翻译）
        ├── platforms.js         五宿主安装位置共享定义
        └── version.js           版本权威读取、同步、发版与盘点
```

---

## 10. 版本管理与迭代

**版本号唯一权威来源是 `meta.json` 的 `version`。** `SKILL.md`、`README.md` 和安装时生成的 `_skillhub_meta.json` / `metadata.json` 都是派生位置，由 `scripts/version.js` 自动同步，不要手工修改。

### 语义化版本规则

| 级别 | 适用变更 | 例子 |
|------|----------|------|
| `patch` | 向后兼容的问题修复，不改变用法 | 使用中发现的 bug、提示词措辞、文档错字 |
| `minor` | 向后兼容的新能力 | 新脚本、新阶段、新宿主支持、新配置项 |
| `major` | 破坏性变更，使用者需调整 | 参数 / 目录 / 产物路径重命名、移除适配器、阶段 id 变更 |

### 迭代闭环

使用中发现问题时按固定流程逐步修复升级，避免「改了代码但版本号没动、各宿主副本版本不一致」：

```bash
# 1) 记录问题（写入 CHANGELOG.md 的 Unreleased 待办区，不改版本号）
node scripts/version.js note "在 Qoder 上 --remote 确认后状态文件路径不对"

# 2) 修复代码 / 提示词 / 配置 / 文档

# 3) 发版：递增版本 → 同步派生位置 → 把待办问题归档进新版本段落
node scripts/version.js bump patch --reason "修复 Qoder 远程确认路径" \
  --fixed "状态文件统一写 --work-dir"

# 4) 校验一致性、找出仍是旧版的宿主副本
node scripts/version.js check && node scripts/version.js installed

# 5) 升级安装（部分宿主需重启或执行 /skills reload）
node scripts/install.js --platform auto --scope user --force
```

### 命令速查

| 命令 | 作用 |
|------|------|
| `node scripts/version.js` | 版本总览：当前版本、一致性、待办问题、副本概览 |
| `node scripts/version.js check` | 校验所有位置一致；不一致 `exit 1`（适合提交前 / CI） |
| `node scripts/version.js sync` | 把派生位置同步到权威版本 |
| `node scripts/version.js note "<问题>"` | 记录使用中发现的问题 |
| `node scripts/version.js bump <level> --reason "<摘要>"` | 发版，支持 `--added` / `--changed` / `--fixed` / `--dry-run` |
| `node scripts/version.js installed` | 盘点五宿主副本版本；发现过期副本 `exit 2` |
| `node scripts/version.js log` | 查看完整版本历史 |

`--link` 软链安装会自动跟随源码版本，无需重复升级。完整历史与规则见 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 11. 文档索引

| 文档 | 读者 | 内容 |
|------|------|------|
| [`SKILL.md`](SKILL.md) | 宿主 Agent | 触发条件、在宿主中的执行步骤、参数速查、平台兼容摘要 |
| `README.md` | 使用者 | 安装、CLI 配置、完整命令、产物链、故障排查、版本管理 |
| [`CHANGELOG.md`](CHANGELOG.md) | 维护者 | 版本历史、待办问题区、SemVer 规则与迭代闭环 |
| [`references/platform-compat.md`](references/platform-compat.md) | 维护者 | 五平台发现路径、frontmatter 差异、CLI 方言、安装验收清单 |
| [`references/remote-confirm.md`](references/remote-confirm.md) | 集成方 | 远程确认状态文件 schema 与外部驱动循环 |

作者：trexwb · 源码：<https://github.com/trexwb/workflows>
