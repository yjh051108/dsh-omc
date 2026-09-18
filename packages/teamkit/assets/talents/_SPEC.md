# Talent 规范（对齐 OMC 原版 `profile.yaml`，落在 DSH 上）

原版的 Talent 是一个**目录包**：`profile.yaml`（18 字段）+ `skills/*/SKILL.md` + `tools/`，
**自带 `llm_model` / `api_provider` / `temperature` / `hosting`**，由 Vessel 容器跑起来。

DSH 的 `spawn_teammate` **没有 model / tools 参数**，成员绑不了后端 —— 所以这里的 Talent 是**身份契约**：
把"这个人是谁、认什么判据、写哪、上岗读什么、怎么被评"写死，**执行绑定交回 DSH**。

## 字段
| 字段 | 必填 | 说明 | 原版对应 |
|---|---|---|---|
| `name` | ✅ | 唯一 id，kebab-case，**必须等于文件名** | `id` |
| `role` | ✅ | **封闭枚举**（`lib/roles.js:ROLES`）：`research` / `engineering` / `writing` / `review` / `coordination` / **`marketing`** / **`execution`** | `role` |
| `level` | ✅ | `lead` / `ic` / `coo` / `ceo` —— 决定它适合被派什么活 | 无（原版是 Lv.1–5） |
| `description` | ✅ | 一句话职责。**不许写"擅长一切"** | `description` |
| `skills` | ✅ | 能力标签，**用于 Market 检索**（`TALENTS.yml` 按它过滤） | `skills[]` |
| `tools` | ✅ | 它该用的 DSH 工具子集 | `tools/` |
| `write_scope` | ✅ | 只允许写哪（**advisory，不锁**） | 新增（原版靠 file_editor 路径权限） |
| `gate_policy` | ✅ | `review`（默认）/ `strict` | 新增 |
| `acceptance_style` | ✅ | **它认什么样的完成判据** —— 这一条决定它交付的质量 | 新增（原版散在 prompt 里） |
| `duties` | ✅ | **这个岗位该做什么**（3–5 条）。★ **每条必须带理由指针**（`（依据：<文件> §<节>）`）—— **指不到真实事故 ⇒ 判红**，防写成口号 | 新增（`task-104` 职责层） |
| `boundaries` | ✅ | ★★ **这个岗位【不该做什么】**（3–5 条）—— **委托方点名的原话形式**：「这个 ceo 该做什么，**不该做什么**」。同样**每条带理由指针** | 新增（`task-104` 职责层） |
| `reports_to` | ⬜ | ★ **直接上级的成员名**（与文件名/`name` 同域）—— 委托方四问之一「**领导者该做什么**」的**关系**半边。<br>⚠️ **可选**：`chief` 上面没有人 ⇒ 必填会逼出"假上级或空串"（**那是编数据**）⇒ 正解是**未声明时渲染成「未声明」**。<br>★ **"手下有谁"不另设字段** —— 它是本字段的**反向索引**，运行时从全部角色档算（`R10`：同一事实只存一处） | 新增（`task-114` 编制卡） |
| `onboarding` | ✅ | 上岗时**先读什么**（路径或模板） | 新增（原版由 `execute_hire` 灌注） |
| `personality_tags` | ⬜ | 工作风格标签 | `personality_tags` |
| `principles` | ⬜ | `principles/<name>.md` —— **自演化**位：复盘结论沉淀在这，下次上岗带上 | `work_principles.md` |
| `hosting` / `llm_model` / `api_provider` / `temperature` / `auth_method` | ❌ | **DSH 不承载**：`spawn_teammate` 没有这些参数。写了也只是声明，**别假装它生效** | `hosting` 等 |

## 两条硬规矩
1. **判据先行**：`acceptance_style` 必须能落成**可观察**的判据；写"高质量"等于没写。
2. **别绑后端**：不放模型名 / 供应商 / 密钥 —— 那是执行层的事，写进来只会变成骗人的声明。

## 第三条硬规矩（`task-104` 起）：**职责必须带理由指针**
`duties` / `boundaries` **每一条**都要写清"为什么有这条" —— 指向**真实事故或成文法**（`ORG.md` / `AGENTS.md` 硬规矩 0 / `AI-COMPANY-FORM.md` §9 / `MANAGEMENT.md`）。
**指不到 ⇒ 判红**（`selftest` 的 `H51` 会查）。
> **为什么这条与别的字段不一样**：职责最容易写成**口号**（"要负责""要高质量"），
> 而口号**无法证伪、也拦不住任何人**。本项目**最该硬的那条约束（CEO 不动手）过去是靠
> `tools` 里没有 `write` 隐含表达的**，而工具面自陈 **advisory** ——
> ⇒ **最该硬的约束用了最软的表达**。理由指针就是把它从"软表达"拉回"有账可查"。

⚠️ **写法约束（生成器限制）**：`duties`/`boundaries` 是**内联数组**（`[a, b, c]`），
而生成器按**逗号**切分 ⇒ **条目正文里不要出现半角逗号**（用顿号·或分号；），否则会被切成两条。

## 自演化（抄原版最值钱的一格）
原版每个员工有一份 `work_principles.md`：教练一次 → 永久写盘 → **此后每次任务注入上下文**。
这里对应 `principles/<name>.md`：**第一次复盘时创建**，写"这个人在这个项目里学到的工作原则"。
上岗材料里必须带上它（`teamkit-assemble` §6）。**没写进文件的复盘等于没复盘。**
