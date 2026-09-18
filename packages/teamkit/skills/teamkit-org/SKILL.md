---
name: teamkit-org
description: OMC（OneManCompany）的组织层怎么落在 DSH 上：四构件映射、原版真正被代码强制的硬数字、以及哪些只能是协议。用来把"一堆 agent"变成"一个组织"。
whenToUse: 你要组织超过 2 个 agent 的协作、要在运行中招募/裁撤/加层、或要引用 OMC 的说法时。
---

# OMC 内化 —— 组织层（不是流程层）

来源：*From Skills to Talent: Organising Heterogeneous Agents as a Real-World Company*（arXiv 2604.22446）
+ 原版仓库 `1mancompany/OneManCompany`。**下面每一条都对着论文原文与源码核过**；
完整取证见本区 `notes/omc-paper.md`、`notes/omc-engine.md`、`notes/omc-talent-market.md`。

## 1. 先钉死一件事：论文的"形式保证"不是定理
摘要写 *formal guarantees on termination and deadlock freedom*，但**正文没有任何编号定理、命题或证明**。真实原材料只有三处：
- **§2.2.3**：*"every search episode terminates in bounded time and cost **under the assumption that the underlying executor (LLM, tool calls, external services) respects the timeout contract**"*
  —— 靠三条熔断（评审轮 3 / 单节点 3600s / 成本超预算则 pause）。**边界是"有界时间与成本"，不含成功与质量。**
- **§2.2.4 七条不变量**：DAG 无环 / 单执行者互斥 / 调度幂等 / 评审轮上限 / 级联取消闭包 / 依赖完整 / 崩溃恢复。
- **"无死锁"的落点是死锁探测器**：全部非根节点处于终态或 blocked 而根未 resolve → **判项目失败**。
  这是"把停滞判为失败"，**不是证明不死锁**；最强措辞只是"每个任务都到终态"（到终态 ≠ 成功）。

**引用时不要写成"论文已证"。** 另：论文**没有任何消融实验**（§5 自陈 not yet quantitatively ablated），
PRDBench 基线是引用他人报告值而非复跑，**没有层深/成本收益读数** —— 所以"层级到底值不值"要靠你自己跑 A/B。

## 2. 原版真正被代码强制的硬数字（内化时的锚点）
> ★ **R90 逐条复核**（对着 `D:\app\omc` 真读源码；"强制"的判据 = **有函数真的拦/抛/截断**，不只看常量存在）：
> 四行常量在 `core/config.py:358-361`（`MAX_REVIEW_ROUNDS=3` / `MAX_CHILDREN_PER_NODE=10` /
> `MAX_TREE_DEPTH=6` / `MAX_HOLD_SECONDS=1800`）；**另一份副本**（`<原版 OMC 检出目录>`）
> 的同一文件里值**逐字一致**、行号在 `:351-354` —— 恰好**差 7 行**（`EVIDENCE.md:106` 的说法**成立**）。

| 闸 | 值 | 原版出处（**含"真的在哪拦"**） |
|---|---|---|
| 每节点子任务上限 | **10** | 常量 `core/config.py:359`；**拦点** `agents/tree_tools.py:327-330`（`>= MAX_CHILDREN_PER_NODE` ⇒ 直接返回 `"Child task limit reached"`） |
| 树深上限 | **6** | 常量 `core/config.py:360`；**拦点** `agents/tree_tools.py:341-344`（`depth+1 >= MAX_TREE_DEPTH` ⇒ 返回 `"maximum depth"`） |
| 每节点评审轮上限 | **3** | 常量 `core/config.py:358`；**拦点** `core/vessel.py:3177`（`review_count >= MAX_REVIEW_ROUNDS` ⇒ 升级 CEO） |
| 挂起（HOLDING）超时 | **1800s** | 常量 `core/config.py:361`；**拦点** `core/vessel.py:2108-2119`（超时 ⇒ 判超时并写 `HOLDING timeout`），扫描器 `core/system_cron.py:514` |
| 单节点执行超时 | 3600s | `acp/backends/script_backend.py:26`（`_TIMEOUT_SECONDS`）与 `agents/tree_tools.py:234`（`dispatch_child(timeout_seconds=3600)`）；**超时直接 terminate + 返回错误结果，不重试**（`script_backend.py:142-153`）—— ⚠️ **R90 更正**：原写"`vessel.py`"，**指错了文件** |
| 驳回重试 / 执行器重试 | 3 次 / 3 次 `[5,15,30]s` | `core/vessel_config.py:63,130-131`（`retry_delays=[5,15,30]`、`max_retries=3`）；同值也见 `core/default_vessel.yaml:15`、`core/vessel.py:81` |
| 状态机 | 9 态 + 邻接表；**唯一写入口** `set_status()`，违规抛 `TaskTransitionError` | `task_lifecycle.py` / `task_tree.py` |

## 3. 四构件 → DSH 映射（诚实版）
| OMC 构件 | 原版实体 | 在 DSH 上 | 缺口（别假装没有） |
|---|---|---|---|
| **Talent** | **目录包**：`profile.yaml`（18 字段，**自带 `llm_model`/`api_provider`/`temperature`**）+ `skills/*/SKILL.md` + `tools/` | `talents/<name>.md` 身份契约（字段规范 `talents/_SPEC.md`，含 `acceptance_style` / `onboarding` / `principles` 位）+ `TALENTS.yml` 索引 | `spawn_teammate` **连 model 参数都没有**，成员不能绑后端 → Talent 只能当"身份契约"；`llm_model` 等字段**写了也不生效，别假装**。**但"版本化/继承"现在有物理形态了**：**上游 / fork / PR**（见 §3.1） |
| **Vessel / Harness** | 执行容器：`limits` / `hooks` / `context` / 6 个 Harness 协议 | **无对应物** | **明确舍弃**，不要假装有 |
| **Talent Market** | 独立服务 + registry + MCP 检索（`search_candidates` 等）；录用最后一公里是 `execute_hire()` **全程确定性、不调模型**（`onboarding.py:867-1122`） | `TALENTS.yml` 索引 + `teamkit-assemble` §3 的三步 | 无检索服务、无排名、无候选池、无面试 → **手工版**（但"缺口现写并注册回来"这条机制保留了）。⚠️ R88 更正：原写"**23 步**纯代码"，那个数**核不出来**（原版全仓无此说法；指到的那段里注释 22 条/调用 18 行/赋值 30 处） |
| **E²R** | 任务树 + 9 态 FSM + **评审门**（completed→accepted）+ 熔断 | `team_task_create` + `blocked_by` + CAS + 三态判决 | **板是平的**：无父子、无 `accepted` 语义、无 transition 校验 → 只能靠协议 |
| **治理** | 职级 Lv.1–5、试用/PIP/**原版的 promotion 档**、`permissions.yaml` 规则引擎、文件改动审批 | `write_scopes`（advisory） | 无权限引擎。⚠️ **R87/R89 更正**：原写"**原版自己也没接线**（ACP 分支无 caller）"—— **那半句是错的**：引擎完整、有 7 个单元测试、**有真实 caller**（`acp/client.py` 的 `request_permission`）；但**它取的工具名恒为空、两个实参都是 `{}`** ⇒ 三条规则全不命中 ⇒ `default: allow` **恒允许**（详见本节末"原版的缺口"）。⇒ 结论不变（**别抄引擎、抄规则文本**），但理由要写对：**不是"上游虚"，是"上游喂进去的是空的"**。**原版那个 promotion 档我们不要**：本区**不设"晋升"**，成长只有两轴（垂直深度 + 交接质量），见 `runs/005-role-skills/GROWTH.md` |
| **自演化** | 每人一份 `work_principles.md`：教练一次永久生效，此后**每次任务注入上下文** | **fork 里的自写 + 提案（PR）**（见 §3.1） | **值得抄**：把复盘结论落进 **自己的 fork**（只影响自己）；**觉得对同角色别人也有用** → 写成提案交 Lead 合并进**上游**（合并后各 fork 自动拿到）。旧写法"落进 `talents/` 与 skill"要拆开：`talents/` 是上游资产、skill 有上下游之分 |

### 3.1 技能的 **上游 / fork / PR**（2026-09-12 已实测；取代旧的"A 层 / B 层 / C 通道"口径）

| 角色 | 是什么 | 谁能改 | 影响范围 |
|---|---|---|---|
| **上游**（旧称 A 层） | 共享的通用技能 = **前辈**（准则是学来的，不是自己定的） | **只有 Lead / PR 合并** | **所有 fork** |
| **fork**（每个 teammate 一份） | 它自己的工作副本，**只存差异**（只放"改过/新增的条"） | **它想怎么改就怎么改** | **只有它自己** |
| **PR**（旧称"沉淀通道"） | fork 里"觉得对大家也有用"的改动 | **它提，Lead 合** | 合并后进上游 → **所有 fork 自动拿到** |

- **DSH 承载面**：**上游** = preset 那个 `skill-filesystem` 扫的 **6 个公共磁盘根**（**不是 per-preset 私有目录**）；**fork** = 插件在 `agent/created` 给该 agent 自己的 scope 注册 provider（task-32/37 实测真隔离）。
- **读时是 overlay，不是复制**：同名条 **nearest layer wins outright**（rank 只在同层内比）⇒ **fork 里改过的条覆盖上游；没改的条来自上游** ⇒ **上游一更新，所有 fork 自动跟着变，零同步动作**（实测 `UP-KEEP-v1 → v2` 当步流入 fork；上游删除也透传）。
- **纪律**：① **fork 绝不能"复制全量上游"**（会毁掉自动跟随）；② fork 里改过该条的人**不会自动拿到上游新版**，合并后要通知它删掉自己那份；③ **删上游条目 = 对全员生效的破坏性操作**。
- ⚠️ **"只有 Lead 写上游"是协议，不是机制**（`pwsh` 绕得过任何写限制）——约束力来自"只有 Lead 会去写 + 落盘可审计"。
- 详见 `runs/005-role-skills/TWO-CHANNEL-DELIVERY.md`（A-3 胜负手）与 `DECISIONS.md` P-17/P-18。

⚠️ **口径提醒**：**PR 不是"晋升"** —— 本区**不设"晋升"**。PR 的语义是"**把个人踩过的坑变成全行业可复用的技能**"（经验通用化），不是爬等级；成长只有两轴（垂直深度 + 交接质量），见 `runs/005-role-skills/GROWTH.md`。

## 4. 硬 vs 软（DSH 实测，别越界承诺）
- **硬的**：成员/任务/消息 id 唯一性 · CAS `expected_revision` · **依赖环检测**（三色 DFS）· 任务数 256 / 消息 64KiB 等上限 · **成员上限（本部署已由 profile 配置抬到 100；`DEFAULT_MAX_MEMBERS = 8` 是默认值）** · **名额不可回收、名字不可复用**（硬）· 三个 Lead-only 动作（`spawn_teammate`/`interrupt_agent`/`reassign`）。
- **软的（advisory）**：写范围（只发 warning，bash 能绕过）· 判据 · 评审 · A2A 纪律 · **预算（DSH 根本没有）**。
- **结论**：组织层的"硬"只能来自「**落盘可审计 + 下一轮真的会去查**」，不能来自 DSH 本身。

## 5. 原版自己的坑（别一起抄过来）
- 父节点汇总结论**写死** `"All child tasks accepted."`（没有综合）；
- `task_contract.py` / `drift_detector.py` 是**死代码**（全仓库零调用）；
- `permissions.yaml` 规则引擎**在生产路径上恒允许** —— ⚠️ **R89 精确化**：原写"未接线（3 条里 2 条永不可能命中）"，
  **两处都不够准**。实测（真跑 Python 验的）：
  ```
  调用点 acp/client.py:143-144：
    tool_name = getattr(tool_call, "tool", "")        ← 而 tool_call 的类型是 **ToolCallUpdate**
    decision  = engine.decide(tool=tool_name, args={}, context={})
  ToolCallUpdate 的字段只有：content / field_meta / kind / locations / raw_input /
                              raw_output / status / title / tool_call_id —— **没有 `tool`**
  ⇒ `getattr(..., "tool", "")` **恒为 `""`**（真跑验证：`hasattr=False`, 取回 `''`；
     即便 JSON 里带 `"tool"` 也会被 Pydantic 丢掉 —— `model_config` 没有 `extra="allow"`）
  ⇒ 三条规则**逐条**：
      {tool:"write", target_exists:…}   → `"" != "write"` ⇒ 不命中
      {tool:"external_api"}             → `"" != "external_api"` ⇒ 不命中
      {cost_usd_gt:10.0}                → `cost_usd` 不存在 ⇒ 取 0.0 ⇒ `0 > 10` 假 ⇒ 不命中
  ⇒ **三条全不命中** ⇒ `default: allow` ⇒ **恒允许**
  ```
  ⇒ **真相不是"未接线"（它有 caller），而是"输入全是空的"**：工具名恒空 + 两个实参都是 `{}`。
    （**"有引擎 / 有 7 个单测 / 有真实 caller"三样都真，唯独喂进去的东西是空的** —— R87/R88 同族的第三种形态。）
- 评审是**派活者自审**（`review_node.employee_id = parent_node.employee_id`）；
- `no_watchdog` 豁免恰好放过最需要保护的两类挂起（等子节点、等 CEO）；
- **撤人不搬活**：`execute_fire()` 完全不碰任务树 → 孤儿节点永久卡住。

## 6. 编制三档（默认别超过第二档）
1 层平铺 → 绝大多数活；2 层主管 → 多条线各自有大块活；3 层组织 → 只有出现**线间资源冲突需持续裁决 / 需对外统一口径 / 有不可逆动作**才值得。
`coo` = 跨线裁决 + 改切分 + 汇总证据；`chief` = 对外口径 + 最终裁决 + 什么时候停。
**别为了像公司而设岗。** 定层与切单元的可执行步骤见 `teamkit-assemble`。

## 7. 与 <上游适配器> 的关系（它退居**可选**）
默认：**模型评审当门禁**（`gate: review`）。只在"对外交付 / 多域交叉 / 不可逆"时才 `gate: strict`，
那时才点火 <上游适配器> 的硬门禁（`gsd_workflow verify` 等）。<上游适配器> 在这里的主用途其实是**上岗材料生成器**。
