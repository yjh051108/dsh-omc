# 设计：OMC 内化到 DSH Agent Teams

来源：*From Skills to Talent: Organising Heterogeneous Agents as a Real-World Company*（arXiv 2604.22446）。
论文原话要点：多智能体受限于**固定团队结构 / 耦合的协调逻辑 / 会话内学习**；缺的是**组织层**；提供 Talents、Talent Market、**E²R** 树搜索（自顶向下分解、自底向上汇总评审）。

> **2026-09-12 校正（对着论文全文与 `<原版 OMC 目录>` 原版核过，取证见 `notes/omc-paper.md`）**
> 摘要里那句「formal guarantees on termination and deadlock freedom」**在正文没有对应定理**：全文 Theorem/Proposition/Lemma/Proof 零命中。真实原材料只有两处：
> ① §2.2.3 一句 —— *"every search episode terminates in bounded time and cost **under the assumption that the underlying executor (LLM, tool calls, external services) respects the timeout contract**"*；前提是三条熔断（k_rev=3、T_max=3600s、Σc>B ⟹ pause）；**边界是有界时间/成本，不含成功与质量**。
> ② §2.2.4 七条不变量：DAG 无环 / `|running(e)|≤1` / 调度幂等 / 评审轮 ≤ k_rev / 级联取消闭包 / 依赖完整 / 崩溃恢复。
> 「无死锁」的实际落点是**死锁探测器**：*"if all non-root nodes are in terminal or blocked states but the root has not resolved, the project is marked as failed"* —— **把停滞判为失败，不是证明不死锁**。
> 另：论文**无任何消融实验**（§5 自陈 "not yet quantitatively ablated"），PRDBench 基线是引用他人报告值而非复跑，且**无层深/token 收益读数**。
> 所以本文件下面「落成硬规矩」那一列是**我们的设计选择**，不是论文的保证——引用时不要写成「论文已证」。

## 1. 四构件 → DSH 映射
| OMC | 在 DSH 上 |
|---|---|
| **Talent**（skills+tools+runtime → 可移植身份） | 一份 Markdown：职责/技能/工具/写范围/上岗材料/gate 偏好。**文件即身份**，跨会话跨项目可复用 |
| **Typed organisational interfaces**（组织接口与后端解耦） | `team_task_create` / `spawn_teammate` / `send_message` / `team_task_update`；Talent 里只写职责与判据，**不绑后端** |
| **Talent Market**（按需招募、执行中重构） | 先翻 `talents/`；缺口就现写并**落盘**；招/撤/换切分随时可做 |
| **E²R** | 分解 = 板上任务 + `blocked_by`；执行 = 队友；评审 = 三态判决。**每轮必须出三态**，不许空转 |
| 形式保证（termination / deadlock-free） | 论文只有 §2.2.3 那句「执行器遵守超时契约」假设下的有界终止 + §2.2.4 七不变量；落成硬规矩：层数 ≤3、每线轮次上限、每轮三态、依赖无环、每次等待**必须有主** |
| **原版的硬数字**（⚠️ **R91 更正出处**：原先只写 `config.py:358-361` 与 `vessel_config.py` —— 而"空转重试 2"**不在这两处**，它在 `core/vessel.py:175`） | 子节点上限 **10** / 树深 **6** / 挂起超时 **1800s** ← `config.py:358-361`；驳回重试 **3** + 执行器重试 **3** 次 / `[5,15,30]s` ← `vessel_config.py:62-63`；**空转重试 2** ← `core/vessel.py:175` `MAX_STALL_RETRIES`；单节点执行 **3600s** ← `acp/backends/script_backend.py:26` 与 `agents/tree_tools.py:234`。**七个都逐条核过"真有拦点"**（不只看常量存在） |

## 2. 编制三档（默认别超过第二档）
1. **1 层 · 平铺**：Lead + N 执行者 —— 绝大多数活。
2. **2 层 · 主管**：每条线一个主管 —— 多条线各自有大块活时。
3. **3 层 · 组织**：只有出现「线间资源冲突需要持续裁决 / 需要对外统一口径 / 有不可逆动作」才值得。
**每加一层必须写清它唯一的职责**；写不出来就是纯开销，撤掉。
⚠️ **「层数（Tier）」不是成长阶梯**：加层是**组织分层**（谁向谁上报、谁在什么范围里裁决、资源怎么分），
与"某个 agent 变强了"**没有关系**。**本区不设"晋升"** —— 成长只有两轴（**垂直深度** + **交接质量**），
详见 `runs/005-role-skills/GROWTH.md`。**别把"层级"和"成长"混成一件事。**
`coo` = 跨线裁决 + 改切分 + 汇总证据上报；`chief`(ceo) = 对外口径 + 最终裁决 + 什么时候停。**别为了像公司而设岗。**

## 3. 循环（E²R）
- **Explore**：自顶向下分解，每步产出「谁负责 + 可观察的完成判据」。分解完就停，别顺手写实现。
- **Execute**：执行者只对自己那块负责；卡住先回报，**不许自己改判据**。
- **Review**：自底向上汇总证据 → 三态判决（接受 / 驳回+具体差在哪+下一步 / 升级）。

## 4. 门禁旋钮（这条是立场，不是实现细节）
`gate: off | review | strict`
- `off`：轻任务直接干。
- **`review`（默认）**：模型评审当门禁 —— 要证据、可驳回、可升级。它比硬门禁强的地方是**能认没被写进去的坏情况**。
- `strict`：点火 <另一个项目> 硬门禁（verify-gate 那一套）。只在**对外交付 / 契约敏感 / 不可逆**时用。
> 契约写多了会压住模型「看情况改做法」的能力 —— 这是委托方的明确判断，别默认 strict。

## 5. A2A 契约（层间怎么说话）
- **向下**：给判据 + 边界，**不给步骤**（写死步骤，执行者就没法应对它实际遇到的情况）。
- **向上**：给证据 + 自评 + **一个明确请求**（要裁决/授权/改判据）。
- **同级**：只交换**可验证事实**（路径、读数）。「我觉得/应该/大概」一律换成「我看到…」。
- **反模式**：别让两个人在同一条推理上互相确认 —— 那只要对方客气就永远通过。
模板见 `skills/teamkit-a2a/SKILL.md`。

## 6. 与 <另一个项目> 的分工
<另一个项目> 退到两个用途：① `strict` 时的硬门禁后端；② **上岗材料生成器**（`gsd_brief` 的落盘简报）。
它那 98 个 bin / 58 条命令**不该出现在默认可见面**上 —— 需要时再列。

## 7. 技能的三件套：**上游 / fork / PR**（2026-09-12 委托方裁定 + 实测，**取代旧的「A 层 / B 层 / C 通道」口径**）

> 旧口径的三层（A 层 preset 通用模板 / B 层 agent 自写 / C 沉淀通道）**只在"谁写哪一份"上是对的**，
> 但把控制点放错了地方（放到"能不能写"）。**委托方裁定**：「**A 层是上游，从上游拉下来的是一个 fork，它可以想怎么改就怎么改，改完觉得有公共价值就发一个 PR 上去，上游再更新**。」
> ⇒ **控制点在"他改的是哪一份"，不在"他改不改得到"**（`runs/005-role-skills/DECISIONS.md` P-16 → P-17）。

| 角色 | 是什么 | 谁能改 | 影响范围 | DSH 承载面 |
|---|---|---|---|---|
| **上游**（旧称 A 层） | 共享的通用技能 = **前辈**（它的准则是学来的，不是自己定的） | **只有 Lead / PR 合并** | **所有 fork** | preset 层那个 `skill-filesystem` 扫的 **6 个公共磁盘根**；**不是** per-preset 私有目录 |
| **fork**（每个 teammate 一份） | 它自己的工作副本，**只存差异** | **它想怎么改就怎么改** | **只有它自己** | 插件在 `agent/created` 按 roster name 给该 agent 的 scope 注册 provider（task-32/37 实测真隔离） |
| **PR**（旧称"沉淀通道"） | fork 里"觉得对大家也有用"的改动 | **它提，Lead 合** | 合并后进上游 → **所有 fork 自动拿到** | 提案落盘 + Lead 写上游（**协议，不是机制**） |

**读时是 overlay，不是复制**（实测胜负手，`TWO-CHANNEL-DELIVERY.md` A-3）：
同名条 **nearest layer wins outright**（rank 只在同层内比，`dsh-skill:109-115/:298-311`）⇒ **fork 里改过的条覆盖上游；没改的条来自上游** ⇒ **上游一更新，所有 fork 自动跟着变，零同步动作**。

**三条纪律（每条都由实测推出，别漏）**
1. **fork 绝不能"复制全量上游"** —— 一旦复制，未改的条变成静态副本，**自动跟随立刻失效**。
2. **fork 里改过该条的人不会自动拿到上游新版** ⇒ 合并后要**通知它删掉自己那份以跟随上游**（唯一的 "rebase" 动作）。
3. **上游"删除"会立刻透传给所有未改的 fork** ⇒ **删上游条目 = 对全员生效的破坏性操作**，比改更谨慎。

**通知通道（任务-45/46 实测 + 委托方四次细化）**：上游一更新 → 主动通知**有该条 fork 覆盖的人**「上游更新了，看你是否需要更新」。通知必须带**更新情况说明**（= push message）、能看到**改动本身**、让**它自己 diff**、并支持**部分采纳**（不是"删掉/保留"二选一）。
**已实测**：能推 / 只推给该推的 / **只在上游真的变了时才推**（12 步 / 2 次上游改动 / 1 次注入）；**已知缺陷**：朴素频率上限会**永久丢通知**（限流分支没入 pending 而 digest 已前进）——正解是 `pendingNotices` 队列，**设计已给、未实测**（`UPSTREAM-NOTIFY.md` / `DECISIONS.md` P-20/P-21/P-22）。

⚠️ **诚实标注**：「只有 Lead 写上游」是**协议，不是机制** —— `pwsh` 绕得过任何写限制（task-43 实测）。它的实际约束力来自「**只有 Lead 会去写 + 落盘可审计**」，不是「别人写不了」。
⚠️ **不可兼得**：fork **没改的**条，`skill` 工具打印的 base dir **就是上游目录** —— "完全不暴露上游"与"A-3 自动跟随"**二者取一**，裁定取 A-3（`DECISIONS.md` P-18）。

## 8. 编制：**上限 100（配置层），但名额不可回收、名字不可复用**

| 事实 | 读数 |
|---|---|
| 上限**不是**本体硬编码 | `DEFAULT_MAX_MEMBERS = 8` 只是默认值（`dsh-experimental-agent-team\lib\types\index.js:49`）；本部署在 profile **用户补丁层**覆盖成 `maxMembers: 100` |
| **已生效（实测）** | 重启后 `spawn_teammate {name:"upstream-keeper"}` **成功**（第 9 个 teammate）⇒ 不是"看文件时间"，是"招得进"（`DECISIONS.md` P-25） |
| **不可回收 / 不可复用（仍在）** | `roster.js:243-244` 用过的 name → `TEAM_MEMBER_NAME_TAKEN`；`roster.js:246-247` 超限 → `TEAM_MEMBER_LIMIT`；`roster.d.ts:39` *"maximum **immutable** roster entries per Team"*；**无 remove/retire/fire/delete 方法、无成员移除事件**（`roster.d.ts:47-97`） |
| **作用域** | 名额 **per Team root（= per Lead 会话）**，不是 per machine（`reviews/005-verdict.md` §1） |

**口径定死**（委托方裁定）：**名额不是约束，预算是约束** —— 取舍由 Lead 按预算做，不靠人为卡名额。
⚠️ 但**"辞退重招"这条路仍然断着**：抬上限只让"招得起"，**不会让"辞得掉"**。原文读数见 `runs/005-role-skills/TWO-TIER.md` §7。
