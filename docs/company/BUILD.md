# 建立：从零开一家公司

> **前置**：你已经装了 [`dsh-teamkit`](https://github.com/yjh051108/dsh-teamkit)。
> **这份文档的目标**：**照抄能跑通**。每步都给**预期读数**；对不上 ⇒ 停下来查，别往下走。
> ⚠️ **凡"我看到的是…"，都是真跑出来的**；拿不到的一律标「未获取」，不写"应该会…"。

---

## 第 0 步：先知道它**不**做什么（**读这一段能省你一小时**）

```
① **装上 ≠ 自动运行**。没有任何东西会自己开工 —— 任务就绪**不会**自动唤醒负责人。
   活**要你派**。（底座行为，不是我们的设计选择）
② **两个总闸默认关**：`e2r.enabled=false` · `guard.enabled=false`。
   而 `memberRelease.enabled=true`（**能撤人**）· `probeGate.enabled=true`（**探针闸**）默认开。
③ **成员"只增不删"是底座限制**：名额可以在插件层**真释放**，
   但**名字不可复用** ⇒ 释放后招人要**换新名**。
```
> **为什么放最前面**：这套东西最容易让人失望的**不是功能少，是预期错**。

---

## 第 1 步：装（三步）

```bash
# ⓪ ★ 前提 1：profile 必须是【完整的】—— 这一步最容易漏，漏了会报一句看不懂的错
#    ⚠️ 裸 profile 会停在：Error: dsh: 1 entry did not activate
#                          @dsh-external/dsh-org-panel: pending (waiting for service: webServer)
#    ⇒ ★ 那是**缺 `@deepseek-ai/dsh-web-app`**（它提供 `webServer` 服务），**不是插件坏了**。
#    ⇒ 正解：用 `--from-default-profile` 从**官方 web 模板**建一个**新** profile：
dsh --profile myco --from-default-profile web
#    ★ 语法 = `--profile <【新】名字> --from-default-profile <【模板】名>`
#      · `myco` 必须是**你还没用过的名字**（`web` 已存在 ⇒ 别再拿它当新名）
#      · 模板名是 **`web`**（DSH 官方帮助里只有这一个：`create rescue from the shipped web template`）
#    ⚠️ **别写 `--profile web`**（那是"启动已有的 web"）· **别写 `--from-default-profile default`**（没有这个模板）

# ① 先把它拿到手（clone 到任意目录）
git clone https://github.com/yjh051108/dsh-teamkit
#    ⇒ 下一步里的 `<你 clone 的>` 就是这一步的落点

# ② 装插件本体（让底座认识这个插件）
#    ⚠️ 前提：pnpm 必须在 PATH 上（dsh plugin 会把参数转发给 pnpm）
dsh plugin --profile myco add "<你 clone 的>/plugin"     # ★ 绝对路径，不带 file:
#    ★ `myco` = 你在 ⓪ 建的那个 profile 名（**下面每一步都用同一个名字**）

# ② 装"资产" —— 插件只是机制，开公司还需要数据（方法包 / 角色档 / 预设）
#    ⚠️ 必须在"插件装到的那个目录"里跑，不是在你的项目目录里
cd "%USERPROFILE%\.dsh\profiles\myco"        # Linux/macOS: cd ~/.dsh/profiles/myco
node node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs
node node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs --check

# ③ 新建一个会话 ⇒ **预设选 `omc`**（GUI 里选，或把 agent-presets.default 设成 omc）
```

> ⛔ **别用下面这条去补 `webServer`**（我们撞过）：
> ```bash
> dsh plugin --profile myco add "@deepseek-ai/dsh-web-app"    # ⇒ ERR_PNPM_FETCH_404
> ```
> **原因**：rc 版依赖**不在 npm registry 上** ⇒ 拿不到。**唯一正解是 ⓪ 那条**（建完整 profile）。
>
> ★ **这条前置的完整说明在面板仓**：[`dsh-org-panel` README](https://github.com/yjh051108/dsh-org-panel#readme)
> （**同一事实只写一处** —— 那边有完整四条，这里只给判据与正解）。

### 1.1 装完你会看到什么（**真跑出来的原文**）

在**干净环境**（把 `DSH_HOME` 指向空目录）跑安装器，逐字输出：
```
teamkit 交接包 · 安装
  源 <包>/skills
  落点 <DSH_HOME>/skills  与  <DSH_HOME>/teamkit
  ->  teamkit（待装） / teamkit-a2a / teamkit-assemble / teamkit-escalate
  ->  teamkit-meeting / teamkit-org / teamkit-review
  talents：9 份（含 principles/）
  组织层：TALENTS.yml RULES.yml
  上游根：<DSH_HOME>/teamkit/skills-upstream（种入 7 条，已存在的不覆盖）
  角色档：9 份 → <DSH_HOME>/teamkit/roles
  预设  ：omc → <DSH_HOME>/.agent-presets  [omc]
```
**落点实测**：
```
<DSH_HOME>/skills/teamkit{,-a2a,-assemble,-escalate,-meeting,-org,-review}   ← 7 个方法包
<DSH_HOME>/teamkit/{roles, skills-upstream, talents, RULES.yml, TALENTS.yml, COMPANY-GUIDE.md}
```
> ⚠️ **口径**：安装器说"角色档 **9 份**"= `roles/` 目录里的 **json 文件数**（含 `INDEX.json`）；
> **真岗位档 = 8 份**。**计数要说清单位**，否则两个数会看起来像矛盾。

**⇒ 每步的判据**：
```
① `dsh plugin add` ⇒ **exit=0**（用相对路径会 ENOENT；缺 pnpm 会只报 "not recognized"）
② 安装器 ⇒ **exit=0** 且上面那份输出
③ `--check` ⇒ **exit=0**（报"待更新"是正常的：源新了、落点旧了 ⇒ 再跑一遍安装）
```

---

## 第 2 步：起第一支队（**别一次招满**）

```
1 人（你自己）→ 2–3 人 → 再考虑分层
```
**为什么**：**上下文 = 生产力**（见 [`WHY.md`](WHY.md) §1）。人多**不会**自动更产出；
**每个成员都要吃上下文**，而"派活 + 验收"也吃**你的**上下文。

### 2.1 招第一个成员

```
· 名字（唯一，**不可复用**）
· 一句话职责（我要它专做哪一类事）
· **完整的第一件活**（含判据 —— 见下）
```
**⇒ 判据（缺一不可）**：
```
① **它的第一件活有判据吗？**（"做成什么样算完成"能一句话说清）
   ⇒ 说不清 ⇒ **先别招**（招了也是返工）
② **它知道边界吗？**（该做什么 / **不该做什么**）
③ ★ **它的上级是"声明"的还是"推"的？** ⇒ **推的 ⇒ 显示"未声明"**（假归属比没有更坏）
```

---

## 第 3 步：铺第一块板（**这是全流程最关键的一步**）

```
每条任务必须写清三件：**要什么** · **判据是什么** · **依赖谁**
```
**⇒ 为什么写判据是硬要求**（不是形式）：
```
★ **"完成"与"被批准"是两件事。**
  ⇒ 写清判据 ⇒ 下游的"评审"才能变成一个**真门禁**（见 [`RUN.md`](RUN.md)）
  ⇒ 没判据 ⇒ 你只能靠"我觉得做完了" ⇒ 而**那是返工的主要来源**
```
**⇒ 判据自查（铺完当场问自己）**：
```
· 这条任务**产出什么可交付物**？（答不出 ⇒ 见 `CRITERIA.md` K1：**不该做**）
· 它的判据**能在一次会话里被回答**吗？（若判据本身是一句口号 ⇒ 重写）
· **下游有没有在等它？** ⇒ 有 ⇒ ★ **不许让它无人认领**
  （现场教训：上游被释放 owner 而下游 `blocked_by` 它 ⇒ **永久卡死** —— 见 `RUN.md` §2）
```

---

## 第 4 步：派第一件活（最短路径）

```
① 铺一条任务（判据 + 负责人 + 依赖）
② 招一个成员（或指派现有的）—— 把**完整任务**给它，别只说"你去做 X"
③ 它会：列任务 → 取 → 认领 → 做 → 交
④ **你验收**：看它的**交付物**（文件 / 读数 / 判据），**不是**看它说"做完了"
```
**你会看到什么**：
```
· 成员列表里出现它
· 任务板上那条从"待办"变"进行中"
· 它回报时**带它跑的原始输出**（本方法论的第一条纪律：**只报实测读数**）
```

---

## 第 5 步：什么时候该加人 / 该分层

| 你现在的规模 | 该做什么 |
|---|---|
| 1–2 人 | **别分**。你自己盯判据 |
| 3–5 人 | 你 + 1 个协调者（**专门**做"梳理判据 + 排人 + 排节奏"） |
| 5–20 人 | 你 + 若干负责人（**每个负责人的直接下属 ≤ 3**，见 [`CRITERIA.md`](CRITERIA.md) K9） |
| 更多 | ★ **先别加** —— 先问「**哪一步在吃我的上下文**」 |

**⇒ 判据**：
```
· **这个管理层减少了谁的哪一步动作？**（答不出 ⇒ 这一层该砍）
· **你停了 30 分钟，全公司会不会停？**（会 ⇒ 先解决"你不在也能推进"）
```

---

## 第 6 步：第一周的"最小健康检查"

```
① `--check` ⇒ exit=0（资产没漂移）
② 抽一条已完成的任务 ⇒ **它的判据是否真的被回答过**（还是"我说做完了"）
③ 抽一个成员 ⇒ **它的第一条提示词里有没有它的边界**（职责/编制卡）
④ 你的板子上 ⇒ **有没有"owner 空着但下游在等"的任务**（有 ⇒ 立刻补人）
```
**⇒ 这一步的产出**：一份**你公司现状**的诚实读数（不是"看起来挺好"）。

---

## 诚实边界

```
· **上面那份安装器输出**是我在**干净 `DSH_HOME`** 里跑出来的**真实输出**（不是示例）。
· 但 **`git clone` / `dsh plugin add` 两步**，在我写这份文档的机器上**没跑通**
  （本机网络策略 + 缺 pnpm）⇒ ★ 这两步**标「未获取」**
  ⇒ **若你跑通了、而我这里没跑通 ⇒ 以你的读数为准**（欢迎回报）。
· 我**没有**"外部用户首次安装成功率"这个数（**还没有外部用户**）。
```

**下一步**：[`RUN.md`](RUN.md)（怎么运营）· [`WEEKLY.md`](WEEKLY.md)（怎么复盘）· [`CRITERIA.md`](CRITERIA.md)（判据全集）
