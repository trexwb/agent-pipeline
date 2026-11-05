# 更新日志

本文件记录 agent-pipeline 的版本迭代。**版本号的唯一权威来源是 `meta.json` 的 `version` 字段**；`SKILL.md`、`README.md` 与安装时生成的元数据文件都是派生位置，由 `scripts/version.js` 自动同步，不要手工改。

所有版本遵循语义化版本 `主版本.次版本.修订号`（SemVer）。

## 版本号规则

| 级别 | 适用变更 | 典型场景 |
|------|----------|----------|
| `patch` | 向后兼容的问题修复，不改变用法 | 使用中发现的 bug、提示词措辞、文档错字、配置默认值修正 |
| `minor` | 向后兼容的新能力 | 新脚本、新阶段、新宿主支持、新配置项、新文档 |
| `major` | 破坏性变更，使用者需调整 | 参数或目录重命名、产物路径变化、移除适配器、frontmatter 必填字段变化、阶段 id 变更 |

一次发布只表达一个主题；若同时包含新能力和破坏性变更，按 `major` 发版。

**版本线重置**：`bump` 只允许递增。需要回到低版本重新迭代时用 `reset <x.y.z> --reason "<原因>"`（允许降级），它会同步所有派生位置，并把旧版本段落降级收进文末「历史归档（重置前）」区，不丢弃历史。当前版本线自 `1.0.0`（2026-11-05）重新开始。

## 迭代闭环

使用过程中发现问题后，按固定流程逐步修复升级，避免「改了代码但版本号没动、各平台副本版本不一致」：

```bash
# 1. 记录问题（写入下方 Unreleased 待办区，不会改变版本号）
node scripts/version.js note "在 Qoder 上 --remote 确认后状态文件路径不对"

# 2. 修复代码 / 提示词 / 配置 / 文档

# 3. 发版：递增版本号 → 同步所有派生位置 → 把待办问题归档进新版本段落
node scripts/version.js bump patch --reason "修复 Qoder 远程确认路径" --fixed "状态文件统一写 --work-dir"

# 4. 校验一致性、找出仍是旧版的宿主副本
node scripts/version.js check && node scripts/version.js installed

# 5. 升级安装（部分宿主需重启或执行 /skills reload）
node scripts/install.js --platform auto --scope user --force
```

`check` 适合放在提交前或 CI 中：版本位置不一致时以 `exit 1` 失败。`installed` 发现过期副本时以 `exit 2` 提示。软链安装（`--link`）会自动跟随源码版本，不需要重复升级。

重置版本线是独立操作，不走上面的递增流程：

```bash
node scripts/version.js reset 1.0.0 --reason "重置版本线，从 1.0.0 重新迭代"
node scripts/version.js check
node scripts/install.js --platform auto --scope user --force
```

## [Unreleased]

使用中发现的问题先记在这里；修复后运行 `bump`，这些条目会自动归档到新版本的「本次归档的待办记录」。

<!-- NOTES:START -->
<!-- 用 node scripts/version.js note "问题描述" 追加 -->
<!-- NOTES:END -->

## [1.0.0] - 2026-11-05

> 重置版本线，从 1.0.0 重新迭代

### Changed
- 此前 1.0.0–2.1.2 的变更记录保留在「历史归档（重置前）」区

## 历史归档（重置前）

> 以下条目属于重置前的版本线，仅作追溯，不参与当前版本线；标题已降级以免与当前版本冲突。

### [2.1.2] - 2026-11-05

> 确认角色名为产品规划引导师，统一订正规格笔误并修复 SKILL.md 版本不一致

### Fixed
- 角色名统一为产品规划引导师，移除 SKILL.md / README.md 的漏字待确认说明与 agents.json 的括号备注
- SKILL.md frontmatter 的 version 被手工改成 0.1.1，按权威 meta.json 同步回 2.1.1

### 本次归档的待办记录
- SKILL.md frontmatter 的 version 被手工改成 0.1.1，与权威 meta.json 2.1.1 不一致
- 确认阶段 1 角色名应为「产品规划引导师」，规格中的角色名漏字，需统一订正

### [2.1.1] - 2026-11-05

> 按技能契约对齐 7 阶段与 7 角色，补齐目标、输入、执行步骤、输出格式与约束

### Added
- SKILL.md 新增技能契约章节：目标、输入、工作流与角色、执行步骤、输出格式、约束

### Changed
- config/agents.json 的 7 个角色名对齐规格，角色提示词加入不编造、缺失项与假设点约束
- README.md 阶段表增加当前执行角色与 agent id 列

### Fixed
- 01-product-plan 与 02-requirements 原共用 product-manager，新增 requirement-analyst 专用于需求拆解
- 交付汇报未按阶段分条输出，补齐分阶段输出格式与覆盖 7 阶段的全流程汇总

### 本次归档的待办记录
- 工作流要求每个阶段由指定角色执行，但 01-product-plan 与 02-requirements 共用 product-manager，与规格不符
- SKILL.md 缺少目标/输入/工作流与角色/执行步骤/输出格式/约束的完整技能契约，且交付汇报未按阶段分条输出

### [2.1.0] - 2026-11-05

> 新增版本号管理与迭代机制，支持使用中问题记录、语义化发版与多宿主副本盘点

### Added
- scripts/version.js 与 scripts/lib/version.js：check/sync/note/bump/installed/log
- CHANGELOG.md：SemVer 规则、Unreleased 待办区与迭代闭环
- scripts/lib/platforms.js：五宿主安装位置共享定义

### Changed
- 安装器改为从 meta.json 读取唯一权威版本，并在版本不一致时给出警告

### Fixed
- SKILL.md 与 watch-issues.js 中无效的 --daemon 示例参数

### 本次归档的待办记录
- SKILL.md 与 watch-issues.js 注释仍写 --daemon，但实现从未解析该参数，容易误导使用者

### [2.0.0] - 2026-11-05

> 多平台兼容升级：让同一份 skill 可安装到 WorkBuddy / CodeBuddy / zCode / Marvis / Qoder 并被各宿主正确驱动。

### Added

- 新增 `scripts/install.js`：五宿主用户级 / 项目级一键安装、`--link` / `--force` / `--uninstall` / `--dry-run`，自动生成各平台元数据
- 新增 `references/platform-compat.md`：五平台发现路径、frontmatter 差异、CLI 方言与安装验收清单
- 适配层引入「宿主 host / 适配器 adapter」分离，支持 `AGENT_PIPELINE_HOST` 与 `*_CLI_CMD` 覆盖，新增 WorkBuddy、zCode、Qoder、Marvis 命令映射
- 新增 `--timeout-ms` 参数；演练模式在缺少 agent CLI 时降级为占位 runner，只告警不退出
- `README.md` 扩充为完整使用手册

### Changed

- `SKILL.md` 改用多平台公共 frontmatter，新增「在宿主中如何执行」章节，移除宿主专属变量占位符
- `config/agents.json` 默认模型改为跨宿主可移植的 `auto`，回退候选改由宿主 `models.json` 动态发现
- `watch-issues.js` 状态文件与流水线产物迁出 skill 安装目录，统一写 `--work-dir`
- `.gitignore` 补充运行时产物与状态文件

### Fixed

- 五个 Issue 修复流提示词要求「写入输出文件」与编排器 stdout 落盘冲突，统一为 stdout 输出
- `config/agents.json` 注释声称模型已改回 `auto` 但数据仍是 `custom-local:*`，注释与数据对齐
- 项目级安装目标若落在源码目录内会递归复制，安装器增加拒绝检查
- `--platform all,common` 组合报「未知平台」，改为支持 `all` / `auto` 与具体平台混合

### [1.0.0] - 2026-10-16（重置前版本线，与当前 1.0.0 无关联）

> 初始版本。

### Added

- 七阶段主流水线编排（产品规划 → 需求拆解 → 架构设计 → 开发编码 → 代码审查 → 测试 → 部署）
- CLI 适配层：CodeBuddy / Claude Code / Codex / plain 四种方言
- 人工确认、远程确认（exit 42）、断点续跑、限额自动切换模型
- 需求构建器（7 维度引导 → A/B 双版本）、GitHub Issue 自动修复循环、git 拉取项目辅助脚本
