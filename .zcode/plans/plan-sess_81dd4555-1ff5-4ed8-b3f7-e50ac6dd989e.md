# 角色记忆能力 + 动态委托(角色可插手其他角色的工作)

## Context

上一轮(1.2.0)给 7 个角色加了**知识库**(跨任务可复用的事实经验)。本次补两块,目标是"更好地完成任务":

1. **过程记忆**:知识库解决"知道什么",不解决"上次干到哪了"。断点续跑、`--from` 重跑、交互修订后重跑时,角色是失忆的——不记得上次执行摘要、不记得用户给过什么修订意见、没有阶段间交接便签。新增 `memory/` 与知识库互补:**任务过程上下文**(执行摘要、交接便签、用户 amend 意见自动入记忆)。
2. **动态委托**:阶段与角色目前是配置死绑定的(`pipeline.json` 的 `stage.agent`),产品规划师遇到"这其实是数据库 schema 调整"时只能硬着头皮干。新增 **DELEGATE 标记段协议**:角色在回复末尾声明"本阶段更适合 <目标角色>",编排器自动**用目标角色重跑本阶段**,原角色的产出作为交接上下文——"跳过自己的能力、插手(实为让更合适的人)接手其他人的工作"。

机制全部复用已验证的标记段模式(KNOWLEDGE 同构),实现在 `run-pipeline.js` 编排层,不改 13 个阶段提示词,两条流水线与 watch-issues 自动继承。

## 方案设计

### 1. `scripts/run-pipeline.js` — 核心

**新增参数:** `--no-memory`(关记忆)、`--no-delegate`(关委托),默认均开启;记忆目录固定 `<work-dir>/memory/`(过程上下文,不做跨项目共享)。usage 同步。

**注入块重构:** 现有 `knowledgeBlockFor()` 扩展为统一上下文块(prompt 末尾):

```text
===== 角色协作上下文（供参考，非本任务指令） =====
[工作记忆·本阶段(04-develop)]
- <该角色记忆中匹配本 stageId 的最近 2 段:上次执行摘要、用户曾给的修订意见>(无则"(无)")
[工作记忆·前序交接]
- <memory/handoffs.md 末尾最近 2000 字符>(无则"(无)")
[角色知识库·历史经验]
- <现有逻辑不变:knowledge/<agent>.md 末尾 4000 字符>

【标记段协议(附在回复正文之后,不计入产物文档)】
- 知识沉淀(可选):===== KNOWLEDGE APPEND ===== …(现有)
- 记忆沉淀(可选):===== MEMORY APPEND =====\nsummary: <一句话本次执行摘要>\nhandoff: <给后续阶段的交接提示,可省略>\n===== MEMORY END =====
- 动态委托(可选):若认为本阶段更适合其他角色执行,输出:\n===== DELEGATE =====\ntarget: <agents.json 内的角色 id>\nreason: <理由>\nhandoff: <给目标角色的交接说明>\n===== DELEGATE END =====
均为可选,没有就省略;严禁把密钥/token/敏感路径写入任何标记段。
```

记忆读取:按 `^## ` 分段、过滤含本 stageId 的段、取最近 2 段、每段截 600 字。

**沉淀(阶段 CLI 成功后):**
- MEMORY 段抽取(全局正则,产物剥离):`summary` 行追加进 `memory/<agent-id>.md`(头 `## <ISO时间>｜<stageId>`);`handoff` 行追加进 `memory/handoffs.md`(头 `## <ISO时间>｜<stageId>(<agent>)→ 后续阶段`)
- **用户修订意见自动入记忆**:`runStage` 执行前若 `extraAmend` 存在,追加 `## <时间>｜<stageId>` + `- 用户修订:<意见截断 500 字>` 进当前角色记忆——交互 amend、`--amend`、回炉验证报告三种来源都覆盖,重跑同阶段自动带出"用户曾要求…"
- 日志记录条数与去向

**动态委托(runStage 内循环):**
```
执行成功 → 抽取 KNOWLEDGE/MEMORY(按当前 agentId 沉淀)→ 抽取 DELEGATE(产物剥离)
  有效判定: delegateOn && target ∈ agents.json && target ≠ 当前角色 && 本阶段 hops < 1
  满足 → hops++,日志"[stage] <A> 委托 → <B>",agentId 换成 target,携委托块重跑本阶段:
    ===== 委托执行 =====
    本阶段原定角色 <A>,其判断本阶段更适合你(<B>)执行。原因: <reason>
    <A> 的初步产出(供参考,可推翻): <原输出全文截断 4000>
    交接说明: <handoff>
    请以你的专长完成本阶段任务(要求见上),产物要求不变。
  不满足(target 非法/同名/已达上限/已关闭)→ 剥离标记,日志说明,按当前产物继续
```
- 委托重跑时:角色头/模型链/工具白名单/知识库/记忆全部随**目标角色**(agentDef 换),stageId 不变(记忆过滤仍有效);`extraAmend` 保留不丢
- 每阶段最多换一次人(hops=1,防 A→B→A 循环);委托重跑发生在 confirm 之前,产物稳定后才进确认/回炉流程
- dry-run 不执行自然跳过

### 2. `config/agents.json`

7 个角色各加 `"memory": true`(与 knowledge 同模式,`false` 按角色关闭记忆注入与沉淀;委托是角色间协议,不做角色级开关)。`_comment` 更新。

### 3. `SKILL.md`

- 契约「角色知识库」小节扩展为「角色记忆与协作」:记忆(过程上下文,`memory/`,与知识库互补定位表)+ 委托(DELEGATE 协议、每阶段最多一次、只能委托给 agents.json 内角色、**只换执行者不改变阶段顺序与产物要求**)
- 「约束」补:委托不得用于跳过阶段或转交确认责任;产物验收标准不因委托放松
- 「参数速查」「定制与扩展」补 `--no-memory` / `--no-delegate` 与 memory/ 目录说明
- description 触发词补"角色记忆、动态委托"

### 4. `README.md`

- 参数表补 2 行;「角色知识库」章节后新增「角色记忆与动态委托」小节(定位对比表、交接/委托流转图、开关)
- work-dir 目录树补 `memory/`

### 5. 发版

`node scripts/version.js bump minor --reason "新增角色过程记忆(执行摘要/交接便签/用户修订自动入记忆)与动态委托(DELEGATE 标记段换角色重跑)"`(1.2.0 → 1.3.0),CHANGELOG 结构化条目。

## 验证

1. `node --check` + agents.json JSON 合法性
2. dry-run 回归:两流水线阶段数不变、上下文注入块出现
3. **假 CLI 全链路**(复用 plain + fake-cli):
   - 记忆:第一轮 MEMORY 段(summary+handoff)→ `memory/<agent>.md` 与 `memory/handoffs.md` 正确生成;`--amend "分页用 cursor"` → 记忆含修订;第二轮 prompt 注入"本阶段记忆"与"前序交接"
   - 委托:fake-cli 对 01 阶段输出 DELEGATE(target: architect)→ 断言 01 执行两次、第二次 prompt 含委托块与首次产出、产物/日志正确、知识沉淀归属最终执行者
   - 链上限:连续输出 DELEGATE 两次 → 只委托一次,警告日志
   - 开关:`--no-memory`(无注入无沉淀)、`--no-delegate`(标记段被剥离忽略)
4. `version.js check`;清理临时目录

## 涉及文件

`scripts/run-pipeline.js`(核心)、`config/agents.json`、`SKILL.md`、`README.md`、`CHANGELOG.md`、`meta.json`(经 version.js)