# MANAGEMENT.md —— CEO 的作业本（**学来的，不是想出来的**）

> **为什么有这份文件**：委托方 2026-09-14 说：
> > 「**多去网上学学怎么当 CEO 组建公司，自己也沉淀沉淀。**」
>
> 我承认：前 100 多轮我一直在「出事 → 补救」，**没有停下来学过**。
> 这份文件是**外部一手材料的摘录 + 对我们自己的映射** ——
> 每一条都注明**来源**，并写明**我们在哪一条上栽过**。

---

## 一 ★★★ 那条直接解释了我全部错误的框架：**6 级授权**

**来源**：[6 Levels of AI Delegation: A Framework for AI Management](https://www.metaltoad.com/blog/6-levels-of-ai-delegation-a-framework-for-ai-management)（Metal Toad，2026-03）

| 级 | 授权语 | 谁该用 |
|---|---|---|
| 1 | 「去查，报告，**我来决定**」 | 高风险决策 |
| 2 | 「去查，报**备选 + 利弊 + 你的建议**」 | 重要但需第二视角 |
| 3 | 「告诉我你打算怎么做，**我不点头就别动**」 | 有行动权但要闸 |
| 4 | 「告诉我你打算怎么做，**我没说不行就做**」 | 已建立信任 |
| 5 | 「去做，**做完告诉我**」 | 低风险、可回退 |
| 6 | 「去做，**不用再联系我**」 | 重复、无足轻重 |

**原文那句核心**（**这就是我的病根**）：
> 「**It's important to be clear and direct about what you expect because not all people have the same skill set
> and not all tasks are created equal.**
> （必须**明确说清你要的是哪一级** —— 因为人不一样、任务也不一样。）」

### 我们栽在哪（**逐条对应**）
```
· 「不要亲力亲为」是一句**没说级数**的话 ⇒ 我和下属都只能猜
· 我默认对自己用了【5 级】（去做，做完告诉他）⇒ 所以我改代码、跑探针、改盘上数据
· 而我对下属**没有指定任何级数** ⇒ 他们自由裁量 ⇒ 出现"总监自己跑探针"（我事后才定性）
· 更糟：我对**破坏性动作**（改盘上数据）也用了 5 级 ⇒ **P0 事故**
```

### 定死（写进 `ORG.md`，**按角色给级数**）
| 角色 | 对**谁** | 级数 | 说明 |
|---|---|---|---|
| **CEO** | **对一切** | **不使用 1–6 级的"自理"权** | CEO **不自己动手**；动手必须是「只有 Lead 能做的」（见 `ORG.md` 例外清单） |
| **CEO** | 对总监 | **2 级** | 要"备选 + 利弊 + 建议"，**不是"你决定"**，也不是"我看着你干" |
| **总监** | 对其辖区执行者 | **3–4 级**（按风险） | 非破坏性 ⇒ 4 级；**破坏性/不可逆 ⇒ 3 级（先报再动）** |
| **执行者** | 对**自己辖区内的常规活** | **4–5 级** | 做完报读数即可 |
| **任何人** | **对"会被持久化的共享对象 / 生产数据 / 宿主"** | **3 级，且必须有回退物** | ⚠️ **P0 就是在这里破的规矩** |

⚠️ **"级数"必须在派活时写明**（写在任务描述里）——**不写 = 默认 3 级**（最保守）。

---

## 二 ★★ 层级组织**有实证优势**（不只是"像公司"）

**来源**：[OrgAgent: Organize Your Multi-Agent System like a Company](https://arxivlens.com/paperview/details/orgagent-organize-your-multi-agent-system-like-a-company-4838-640a1508)（arXiv [2604.01020](https://arxiv.org/abs/2604.01020v1)，2026-04）

**它是 OMC 那条路线的直接后继研究**（我们内化的 OMC 是 arXiv 2604.22446）。三层：
```
governance（规划与资源分配） / execution（执行与评审） / compliance（最终输出把关）
```
**关键实证**：
> 分层协调**持续优于平铺与单 agent**；GPT-OSS-120B 在 SQuAD2.0 上
> **相对提升 102.73%，同时 token 用量减少 74.52%**。
> 「**层级带来清晰的岗位专精**……**受控的信息流**……**分层校验**」。

**它给我们的三条判据**（原文）：
1. hierarchy helps most when tasks benefit from **stable skill assignment**（**稳定的技能分配**）
2. …and **controlled information flow**（**受控的信息流**）
3. …and **layered verification**（**分层校验**）
⇒ **满足这三条时才上分层**；不满足（例如答案空间受限的选择题）**收益有限**。

### 对我们意味着什么
```
✅ 我们的「CEO → COO → 总监 → 执行者」**方向是对的**（有实证支撑，且省 token）
✅ 「总监不预先下诊断结论」（D-2）= **受控的信息流**
✅ 「执行者出诊断、总监验收、CEO 抽查」= **分层校验**
⚠️ 但委托方反复提醒的「**不要太细**」= 论文说的"层级在**某些任务上收益有限**"
⇒ **判据：一个层级若只是转发、不增加判据或校验 ⇒ 该砍**
```

---

## 三 ★★ 事故复盘：我们做得不对（对着标准逐条核）

**来源**：
[postmortem-writing（blameless 模板 + 5 Whys + 反模式）](https://skilld.dev/gh/wshobson/agents/postmortem-writing/-/references/details.md)
· [How to Write an Incident Postmortem（七字段 + 行动项五要素）](https://www.augmentcode.com/guides/incident-postmortem-template)
· [GitLab Incident Review](https://handbook.gitlab.com/handbook/engineering/infrastructure-platforms/incident-review/)

### 「blameless」的准确含义（**不是"不追究"，是"追究系统"**）
| 有责式 | 无责式 |
|---|---|
| 「**谁**造成的？」 | 「**什么条件**允许它发生？」 |
| 「有人犯了错」 | 「**系统**允许了这个错」 |
| 惩罚个人 | 改进系统 |
| 藏信息 | 共享教训 |

⚠️ **注意这把我们的两条规矩区分开了**：
```
· 「责任要明确」= 组织责任（谁的辖区、谁批）        ← 委托方的要求，**保留**
· 「blameless」  = **不追究个人动机与品格**，追系统    ← 外部标准，**新加**
⇒ 两者不矛盾：**责任归角色，反思归系统。**
```
**这正是 P0 该怎么写**：`责任人 = CEO`（组织责任，我认），但复盘要问
**「什么条件允许 CEO 的这一手动作一路落到生产数据上？」**（系统原因）——
而不是停在「CEO 不该动手」（那只是禁令，不是修复）。

### 行动项必须**五要素齐全**（我们缺的就是这个）
```
① owner（**具名的人，不许写团队**）
② verifiable verb（**add / remove / change / update / test / deploy** ——
   ⚠️ **不许用 review / explore / investigate**）
③ measurable outcome（可量的结果）
④ tracker entry（进板子 —— 本项目已有 `team_task_create`）
⑤ deadline
```
⚠️ **「Investigate monitoring」是反例，「Add alerting for all cases where error rate > 1%」才是正例。**
⇒ 我们过去写的「请你核一下…」**全部不合格**。

### 还有三条我们没做的
```
· **区分"止血"与"防复发"**（mitigative vs preventative）—— 我们只写了"已修"
· **contributing factors 列 2–5 条**（原文强调：真实事故通常是**多个必要条件**,
  **别急着只给一个"root cause"**）
· ★「**postmortem 不算完成，直到 runbook 更新被合并**」
  ⇒ 对我们 = **复查完不算完，直到纪律/断言进了 `RULES.yml` 且断言真的会拦**
```

### 反模式（**我们全犯了**）
| 反模式 | 我们犯过 |
|---|---|
| 浅层分析（停在第一个症状） | 「改掉 `e2rProbe` 就行」 |
| 无行动项 | 「已修复」就完了 |
| 行动项不可验证 | 「以后注意」 |
| 无跟进 | 同类事故**发生 3 次**（R75 / R95 / R108） |

---

## 四 ★ 五个层级的控制幅度（span of control）

**来源**：[Three Levels of Management](https://execed.isb.edu/executive-perspectives/directory/how-effective-management-drives-performance-and-sustainable-growth) ·
[How to Build a Startup Executive Team](https://sahin.io/ko/blog/how-to-build-a-startup-executive-team)

**通用口径**：一线管理者 **5–9 个直接下属**（经典 span of control）；
高层管理者**更少**（3–6），因为每个下属的**协调成本**更高。

### 对我们（AI 组织）的修正
```
· 我们的"协调成本"远高于人类 —— 每次跨人交流都要**重新载入上下文**（AI 的上下文最贵）
  ⇒ **层级要浅、每层管辖要少**
· 现在的编制：CEO → COO → 2 总监 → 各自 1–2 执行者
  ⇒ **每个管理者的直接下属 ≤ 3** —— 这是对的（AI 组织应比人类更窄）
· ⚠️ 但 COO 只管 **2 个**总监 ⇒ 偏少 ⇒ **它应该同时管跨辖区协调**（这正是它现在的职责）
```

---

## 五 我要改的三件（**具体、可验、有主**）

| # | 行动（**verifiable verb**） | 判据 | 谁 | 期限 |
|---|---|---|---|---|
| **A-1** | **在 `ORG.md` 加一张"授权级数表"**（按角色×风险），并在**派活模板里加一行「授权级数：N」** | `ORG.md` 里能查到该表；**任一新任务描述里含"授权级数"字段** | **CEO** | 本轮 |
| **A-2** | **给事故报告加"行动项五要素"机械检查**：`owner` 具名 / 动词在白名单 / 有可量结果 / 有 deadline | 写一个断言：事故报告里的行动项若用 `review\|explore\|investigate` 作动词 ⇒ **判红** | 总工程师 | 下轮 |
| **A-3** | **把 P0 复盘按 blameless 重写**：区分**组织责任**（写明角色）与**系统条件**（第 1–5 问）；**contributing factors 列 2–5 条**；行动项五要素齐全 | `INCIDENT-P0-BOARD-CORRUPTION.md` 里有「系统条件」一节（≥3 条）且行动项五要素齐全 | 总工程师（COO 协调） | 下轮 |

---

## 六 来源（**别人写的，我引用**）

- https://www.metaltoad.com/blog/6-levels-of-ai-delegation-a-framework-for-ai-management —— 6 级授权
- https://arxivlens.com/paperview/details/orgagent-organize-your-multi-agent-system-like-a-company-4838-640a1508 · https://arxiv.org/abs/2604.01020v1 —— 公司式层级多 agent 的实证
- https://skilld.dev/gh/wshobson/agents/postmortem-writing/-/references/details.md —— blameless 复盘模板、5 Whys、反模式
- https://www.augmentcode.com/guides/incident-postmortem-template —— 七字段、行动项五要素、动词白名单
- https://handbook.gitlab.com/handbook/engineering/infrastructure-platforms/incident-review/ —— 事故复盘流程
- https://sre.google/workbook/postmortem-culture/ —— **SRE 事后总结文化（本机取不到，标注未获取）**
