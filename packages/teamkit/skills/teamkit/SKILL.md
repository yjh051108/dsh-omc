---
name: teamkit
description: 用 Agent Teams 组队干活的通用方法包：判据 → 切单元 → 选人 → 分层 → 铺板 → 评审门 → 开会。不分领域，研究与开发同用。
whenToUse: 任务需要**持续存在的负责人**、多角色协作、或跨多轮时（研究/写作/开发/审计/运维都算）。纯扇出扫描这类无状态活别用它。
---

# teamkit —— Agent Teams 的用法（不是流程，是判断）

## 什么时候该开团队
一句话判据：**这件事需要一个"记得住上下文、能被追问、跨多轮一直在"的负责人吗？**
要 → 团队；不要（一次性、高扇出、脚本可确定编排）→ workflow / 单个 subagent。
**反判据**：只为"看起来更专业"而开团队，是纯开销。

## 底座是 DSH 原生那 9 个工具 —— 别另造团队机制
`spawn_teammate`（录用）· `send_message`（A2A）· `team_task_create / get / list / update`（板）·
`list_agents` · `wait_agent` · `interrupt_agent`。
**DSH 实测的硬边界**：只有 id 唯一性、CAS `expected_revision`、依赖环检测是硬的；
写范围、判据、评审、A2A 纪律**全是 advisory**（没有强制钩子）。
所以下面所有规矩都是**协议**，不是保证 —— 别当门用，也别以为写了就不会被绕过。

## 五件事（按顺序做）
1. **判据先行**：写不出可观察的完成判据 = 活没想清，先别开人。→ `teamkit-assemble` §0
2. **切单元**：一个单元 = 一次能被独立评审的交付（owner + 判据 + 写范围 + 依赖）。
3. **选人**：先翻 `$DSH_HOME/teamkit/TALENTS.yml` + `$DSH_HOME/teamkit/talents/`，缺口现写并落盘。→ `teamkit-assemble` §3
4. **定层**：默认 2 层。**层级是成本，不是排面**；每加一层必须写清它唯一的职责。
5. **铺板 + 开人**：`team_task_create` 落依赖与写范围；`spawn_teammate` 的提示词只放判据与**落盘的上岗材料**。

## 循环（E²R：Explore → Execute → Review）
- **Explore**：自顶向下分解，每步产出「谁负责 + 可观察的判据」。**分解完就停**，别顺手写实现。
- **Execute**：执行者只对自己那块负责；卡住先回报，**不许自己改判据**。
- **Review**：自底向上汇总证据 → 三态判决。**`complete` 不等于被批准**，见 `teamkit-review` 的评审门。

## 门禁只有一个旋钮
`gate: off | review | strict`
- `off`：轻任务直接干。
- `review`（**默认**）：模型评审当门禁 —— 要证据、可驳回、可升级。
- `strict`：外部硬门禁（<上游适配器> 的 verify-gate）—— **只在**契约敏感/多域交叉/交付对外时点火。
**不要默认 strict。** 硬约束写多了反而压住"看情况改做法"的能力。

## 相关
| 要做什么 | 读哪篇 |
|---|---|
| 组队、切单元、铺板、开人 | `teamkit-assemble` |
| 评审、三态判决、评审门、熔断 | `teamkit-review` |
| 多角色同步对齐（开会） | `teamkit-meeting` |
| 招人/换人/升级/退出、终止与无死锁、**做得不够好时怎么纠正** | `teamkit-escalate` |
| 队友之间怎么说话（层间消息契约） | `teamkit-a2a` |
| OMC 原版对着的机制、硬数字、哪些只是协议 | `teamkit-org` |

## 组织层文件（装到 `$DSH_HOME/teamkit/`）
**下表每条都写全绝对路径** —— 别自己拼（我实测踩过：按仓内相对路径拼出的那份**不会被读**，
见 `teamkit-a2a` 的"绝对不要自己拼路径"）。`<DSH>` = `$DSH_HOME`（没设 = `~/.dsh`）。
| 文件 | 是什么 | 原版对应 |
|---|---|---|
| `<DSH>/teamkit/TALENTS.yml` | **Talent Market 索引**：按 role / skills / use_when 过滤找人；缺口现写并**注册回来** | registry.json + `search_candidates` |
| `<DSH>/teamkit/talents/<name>.md` | **Talent 身份契约**（字段规范见 `<DSH>/teamkit/talents/_SPEC.md`）| `profile.yaml` |
| `<DSH>/teamkit/talents/principles/<name>.md` | 这个人的**工作原则**（复盘沉淀，下次上岗带上）| `work_principles.md` |
| `<DSH>/teamkit/RULES.yml` | **治理**：必须上报的四类 / never 清单 / 下游交接 / 成本阀 | `permissions.yaml` + `company_culture.yaml` |
| `<DSH>/teamkit/roles/<name>.json` | **岗位档案**：职责 / 验收口径 / 写范围 / gate（插件按它渲染**岗位人格段**）| — |
| `ROSTER.yml`（**在项目里，不在 `<DSH>`**） | 本次任务的**编制**（目标 / 判据 / gate / 预算 / 线） | — |
**注意**：原版 `permissions.yaml` 是能执行的规则引擎，**但在生产路径上恒允许**
（⚠️ **R89 更正**：原写"虽然它自己没接线"—— **不准**：它有真实 caller，**是喂进去的输入全空**
—— 工具名取的是 `ToolCallUpdate.tool`，而该类型**没有 `tool` 字段** ⇒ 恒为 `""`；
外加两个实参都是 `{}` ⇒ **3 条规则全部不命中** ⇒ 落到 `default: allow`）；
这里是**要人读的规则文本**。
DSH 没有权限钩子，别把 `RULES.yml` 当门用。
