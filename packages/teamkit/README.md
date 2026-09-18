# dsh-teamkit

> **Agent Teams 的组织层插件**：把「上游 / fork / PR 三件套」做成**别人能装、我们能维护**的一个包。
> 零运行时依赖 · 零硬编码路径 · 离线三态自测 · 可卸净。

设计来源：`runs/005-role-skills/`（那 7 个 `teamkit*` 方法 skill + 四个实验件）。
本包把它们从「`exp/**` 下的实验件」收敛成**一个可安装插件** —— 依据委托方 2026-09-13 的北极星：
> 「**要记住我们做的是插件** —— 一定是**越方便开源后其他用户安装越好**，一定是**越好维护越好**。」

---

## 它是什么（30 秒）

你的 agent 团队里每个成员读到的「方法技能」，本来**只有一份公共的**：谁改都是改所有人的。
本插件给每个成员**一份只属于它自己的工作副本**（fork），并让上游（= 所有成员的"前辈"）保持可更新：

| 概念 | 是什么 | 谁能改 | 影响范围 |
|---|---|---|---|
| **上游** | 共享的通用技能（`$DSH_HOME/skills` 等磁盘根） | 你（`teamkit promote`） | **所有成员** |
| **fork** | 每个成员**自己的**工作副本（`<state>/forks/<member>/skills/`） | **它想怎么改就怎么改** | **只有它自己** |
| **PR** | fork 里"觉得对大家也有用"的改动 | 成员提，你合 | 合并后所有 fork |

**关键性质（overlay）**：fork **只存差异**。它没改过的条**根本不在 fork 里** ⇒ 由上游提供
⇒ **上游一更新，所有成员自动跟着变，零同步动作**。
而它**改过**的那条会被"上游更新通知"告知：附上**你写的更新说明** + 改后正文 + **三条可比路径**
（让它自己跑 `diff`）+ 五项动作菜单（含**部分采纳**）。

---

## 30 秒上手：**从"装好"到"开起一家公司"**

> ★★ **先看这个**：**从零建立一家公司、怎么让它发展** —— 全过程在
> [`assets/org/COMPANY-GUIDE.md`](assets/org/COMPANY-GUIDE.md)（**装上之后**它在
> `$DSH_HOME/teamkit/COMPANY-GUIDE.md`，**就在你手边**）。
> 下面这一节是**怎么把它跑起来**；那份指南是**跑起来之后怎么用**——
> **一个讲"装"，一个讲"建"**，别混。
>
> ★★ **怎么开一家这样的公司** ⇒ <https://github.com/yjh051108/dsh-company>
> （**成文法 / 踩坑集 / 马克思主义理论稿 / 判据对照表 K1–K25**）
> —— 那是**读的东西**（方法论）；本包是**装的东西**（插件）。**三个仓分开，是因为你打开时要立刻知道该读哪个、装哪个。**
>
> ★★ **想让"公司"看得见**（**侧边栏 · 办公室面板**）⇒ <https://github.com/yjh051108/dsh-org-panel>
> ⚠️ **注意前置**：它需要一个**完整 profile**
> （`dsh --profile <你的 profile> --from-default-profile web`），否则会报
> `1 entry did not activate` —— **面板 README 开头有这条前置说明**。
> ★ 三条命令看清三件东西：**本包** = 公司层（能开公司）· **`dsh-org-panel`** = 看得到公司 · **`dsh-company`** = 怎么开公司。

> 这一节是**操作手册**；下面 `## 装` 是**完整版本与维护细节**。
> 如果你只想让它跑起来，照这 6 步做（**顺序不能换**）。

```bash
# ⓪ ★ **先把它拿到手**（clone 到任意目录）—— 没有这一步，①里的路径你不会有
git clone https://github.com/yjh051108/dsh-teamkit
#    ⇒ **下一步里的 `<你 clone 的>` 就是这一步的落点**（默认是当前目录下的 `dsh-teamkit/`）
#    ⚠️ **没有 git** ⇒ 到 https://github.com/yjh051108/dsh-teamkit 点 "Code → Download ZIP" 解压也行。

# ① 装插件本体（bundle 进 profile；web 为例）
#    ⚠️ **给绝对路径**（不是 `file:./plugin`）—— 见下面那条实测。
dsh plugin --profile web add "<你 clone 的>/plugin"
#    Linux/macOS： dsh plugin --profile web add "/你 clone 的/plugin"
#    ⚠️ **前提：`pnpm` 必须在 PATH 上**（`dsh plugin` 是转发给 pnpm 的）——
#       pnpm 不在 PATH 时它只会报 `'pnpm' is not recognized`，看不出是缺前置。

# ② 装"资产"—— 插件只是机制，开公司还需要数据（skills / talents / roles / preset）
#    ⚠️ **要在"插件装到的那个目录"里跑**（profile 目录），不是在你的项目目录里：
#       `dsh plugin --profile web add` 会把包装到 <DSH_HOME>/profiles/<profile>/node_modules/ 下。
cd "%USERPROFILE%\.dsh\profiles\web"     # Linux/macOS: cd ~/.dsh/profiles/web
node node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs
node node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs --check   # 应全绿；⚠️ 报"待更新"就重跑一遍

# ③ 新建一个会话，**预设选 `omc`**（GUI 里选，或把 `settings.yaml` 的 agent-presets.default 设成 omc）
#    选它 = 以开公司的方式做这件事；其它预设（含官方 standard）不受影响。
```

> **② 为什么必须先 `cd`**（2026-09-14 / Round 62 实测）：
> 上面那条 `node node_modules/...` 是**相对路径** ⇒ 在**你自己的项目目录**里跑会 `Cannot find module`
> （那里没有 `node_modules`）。**它只在 profile 目录里成立。**
> 不想 `cd` 就用**绝对路径**：`node "<DSH_HOME>/profiles/web/node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs"`。
> 在**源仓里开发**时用：`node tools/install-teamkit.mjs`（从 `plugin/` 目录跑）。
> ⚠️ **本包尚未发布到 npm ⇒ 别用 `npx teamkit-install`**（会 404）。等发布后它才成立。

> **① 的两条实测坑**（2026-09-14 / Round 56，在一个**一次性 profile** 里真跑出来的）：
> 1. **`file:./plugin` 会失败** —— `dsh plugin` 把参数**转发给该 profile 目录下的 pnpm**，
>    而 pnpm 按**profile 目录**（不是你的 cwd）解析相对路径 ⇒
>    `ENOENT: scandir '…\profiles\web\D:\path\to\plugin'`。**要给绝对路径**（不加 `file:`）。
> 2. **`pnpm` 必须在 PATH 上**。不在时逐字错误是 `'pnpm' is not recognized as an internal or external command`
>    —— **看不出"缺前置"**，容易误判成"这个包坏了"。

**④ 在该会话里，直接说你要做成什么**，然后它会照 `teamkit` 技能的五步走：
```
判据先行 → 切单元 → 选人 → 定层 → 铺板 + 开人
```
**⑤ 验收信号（跑对了你会看到）**：
```
· 日志有 ROLES-LOADED {n:7} / ROLE-PERSONA-OK {member:…} ⇒ 公司层装上了
· 日志有 FORK-REGISTER-OK member=…                        ⇒ 成员拿到自己的工作副本
· 团队工具有 team_task_create / list_agents / send_message ⇒ 板与 A2A 可用
· 成员各有自己的 SOUL（$DSH_HOME/.teamkit/soul/<名字>.md） ⇒ 它能自我迭代
```
**不用自己去 grep 日志** —— `teamkit status` 会把**「装上就有效果」那五件事**（含第⑤步的信号）
**真实出现次数**直接数出来：
```
$ teamkit status
  公司层（= README「装上就有效果」那五件事；从日志里现数）
  OK  SKILLS-SYNC        264 次  插件自带的方法技能被同步到上游根（成员据此才有方法可用）
  OK  ROLES-LOADED       264 次  角色档被读进来（`n=8` = 八份都在；含**总监档** `director`）
  OK  ROLE-PERSONA-OK     18 次  成员被装上了岗位人格段（有岗位、有原则位）
  OK  FORK-REGISTER-OK    22 次  成员拿到了自己的 fork（它想怎么改就怎么改）
  OK  SOUL-INJECT         17 次  成员自己的 SOUL 被注进上下文（下一步生效）
  OK  NOTIFY-LISTENING    34 次  通知监听器装上了（没有它，后面的"检测到变"与"推送"都不会发生）
  OK  INJECT              18 次  真推了通知给成员；**为 0 = 上游还没变过，不代表没工作**
  （拿到过 fork 的成员名：…）
  OK  SOUL 落点   <stateDir>/soul（…）
```
> ⚠️ **一条都没出现 ≠ 一定坏了**：可能只是**还没起过 `omc` 会话**。
> 若你已经起了 `omc` 会话却一条都没有 ⇒ 那是**没装上**（回去跑第②步的安装器）。
> 日志读不到 ⇒ 报 **`??` 未验证**（**读不到 ≠ 没发生**，见 `LANDMINES §6`）。
**⑥ 一条命令自查**：`node node_modules/@dsh-external/dsh-teamkit/bin/teamkit.mjs selftest`
（**退出码 0 = 全过**；2 = 有未验证；1 = 有失败）。
> ⚠️ 这条同样是**相对路径** ⇒ 要么**先 `cd` 到 profile 目录**（见第②步），
> 要么用**绝对路径** `node "<DSH_HOME>/profiles/web/node_modules/@dsh-external/dsh-teamkit/bin/teamkit.mjs" selftest`。

> ⚠️ **最容易漏的是第 ② 步**（装资产）。不装它 ⇒ **插件在跑，但"公司层"是空的**：
> 成员只是个普通 teammate，没有岗位、没有角色技能、没有原则。
> 这也是为什么它**不是可选的**。

---

## 装（完整版本）

### ① 先装插件本体

```bash
# 先把本包拿到手（若还没 clone）
git clone https://github.com/yjh051108/dsh-teamkit
# 再把本包作为 bundle 装进你的 profile（web 为例）
dsh plugin --profile web add "<你 clone 的>/plugin"    # ← 绝对路径，别用 file:./plugin
```
> 装完**重启或热重载**才生效（见下面 §③）。
> ⚠️ **`file:./plugin` 会失败**、**`pnpm` 必须在 PATH 上** —— 两条都有逐字错误与原因，见上面「30 秒上手」那节的两个坑。

### ② 再装"装资产"—— 否则装了没反应（**这一步最容易漏**）

插件本体只是**机制**；「开公司」还需要几样**数据**，它们由安装器搬到 `$DSH_HOME` 下的稳定位置：

```bash
# ① 装到 profile 后，**先 cd 到那个 profile 目录**（相对路径才成立）：
cd "%USERPROFILE%\.dsh\profiles\web"          # Linux/macOS: cd ~/.dsh/profiles/web
node node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs

# ② 不想 cd ⇒ 用**绝对路径**（把 <DSH_HOME> 换成你的，通常 ~/.dsh）：
node "<DSH_HOME>/profiles/web/node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs"

# ③ 在**源仓**里开发时（从 `plugin/` 目录跑）：
node tools/install-teamkit.mjs

# 四个开关都支持（对上面任一种形态都一样）
node <安装器> --help        # 参数表（**只打印、不写盘**）
node <安装器> --check       # 只看状态，不写
node <安装器> --uninstall   # 只删本包装的（靠 .teamkit 标记）—— 你写的 Talent / principles **不动**
node <安装器> --force       # 覆盖已存在的同名预设（默认跳过，不冲掉你改过的）
```
> ⚠️ **本包尚未发布到 npm** ⇒ **`npx teamkit-install` 现在会 404**（Round 62 实测）。
> 它写在 `package.json` 的 `bin` 里，**发布后**才成立；在那之前用上面三种之一。

> ★ **想在真机上试 `--uninstall` 又怕弄坏东西？用 `DSH_HOME` 把落点定向到临时目录**（实测可用）：
> ```bash
> DSH_HOME=/tmp/probe node <安装器>            # 全装到 /tmp/probe
> DSH_HOME=/tmp/probe node <安装器> --uninstall # 全删在 /tmp/probe —— **真机一点没碰**
> ```
> 这是**唯一安全的破坏性测试姿势**（2026-09-14 / Round 77 补：我 R76 那次就是因为没这门路，
> **在真机上跑了 `--uninstall`**，把 `skills/` `roles/` `upstream/` 预设全清了，靠重跑安装器才复原）。
> ⚠️ 同理：`--help` **只打印不写盘**（`LANDMINES §7` 同族的事故：脚本不看参数就动手）。

> **安装器读哪里**：它**同时支持两种布局**（判据是"哪个真的存在"）——
> ① **仓内**：`<repo>/{skills,talents,runs/005-role-skills/roles,presets,TALENTS.yml}`
> ② **包内**：`<pkg>/{skills,assets/{talents,roles,presets,org}}`
> `assets/**` 由 `scripts/sync-assets.mjs` 从仓内同步（**单一事实来源仍是仓**）：
> ```bash
> npm run sync-assets          # 仓 → 包内副本
> npm run sync-assets:check    # 漂移 ⇒ 退出码 1；源读不到 ⇒ 2
> ```
> ⚠️ **改了仓里的资产（预设/角色档/talents/安装器）必须重跑 `npm run sync-assets`**，
> 否则 **tgz 里带的是旧副本**（自测 `H4` 组会盯着"资产进没进包、包内副本齐不齐"）。

它装 6 样（**逐条给落点，全部可复核**）：

| # | 装什么 | 落点 | 不装会怎样 |
|---|---|---|---|
| 1 | 7 条方法技能 | `$DSH_HOME/skills/` | 模型没有"怎么组队"的方法包 |
| 2 | `talents/`（含 `principles/`） | `$DSH_HOME/teamkit/talents/` | 没有岗位档案与自演化位 |
| 3 | 组织层 `TALENTS.yml` / `RULES.yml` | `$DSH_HOME/teamkit/` | 没有市场索引与治理 |
| 4 | **角色档 `roles/*.json`** | `$DSH_HOME/teamkit/roles/` | **公司层读不到"人"** ⇒ `ROLES-LOADED {n:0}` |
| 5 | **上游根**（自带方法包的一份） | `$DSH_HOME/teamkit/skills-upstream/` | 上游链没有起点（`promote` 无处可写） |
| 6 | **`omc` 预设** | `$DSH_HOME/.agent-presets/omc/` | **没有"开公司"的入口**（新建会话时选不到它） |

> ★★★ **第 1 项与第 5 项是同一批 7 条技能，装了两份 —— 这不是重复劳动，是"兼容两种装法"**
> （2026-09-14 / Round 85 查清并写明；我一开始也以为哪里错了）：
> ```
> 装法 A｜用 omc 预设      ：模型读 `teamkit/skills-upstream`（预设的 customSkillDirs 指它，
>                           且 includeDefaultRoots:false ⇒ 明确不扫 $DSH_HOME/skills）
> 装法 B｜只 dsh plugin add：upstream.root 默认 = $DSH_HOME/skills，
>                           且 dsh-base 的全局 skill-filesystem 也扫它 ⇒ **那份就是模型读的**
> ```
> ⇒ **两种装法要的落点不同**，而安装器**无法事先知道你会用哪种**（你可能先装、后建 `omc` 会话）
>   ⇒ **两个都装**是正解。**缺任一份，都有一种装法下模型读不到技能。**
>
> ⚠️ **已知副作用（讲清楚，不藏）**：`$DSH_HOME/skills` 是**公共技能根** ⇒
>   用**别的预设**（如官方 `standard`）的 agent **也会看到这 7 条**。
>   这正是 `omc` 预设用 `includeDefaultRoots:false` 想避开的，但"bundle 装法"**没别处可放**。
>   ⇒ **想要"只有 `omc` 看得见"：用 `omc` 预设那套装法**（本安装器会装它）。
>   ⚠️ 这也解释了"为什么 `standard` 下还能看到 7 条 teamkit 技能"——
>   **是安装器放在公共根的那份**，不是预设泄漏。
>
> ⚠️ **预设不覆盖已存在的同名项**（你可能自己改过）；要覆盖加 `--force`。
> ⚠️ `--uninstall` **只删带 `.teamkit` 标记的**，不会误删你自己写的预设。
> ⚠️ 预设里的路径**全部走 `!!js` 表达式读 `$DSH_HOME`**，不含任何写死的开发机路径 ⇒ 换机器可用。

### ③ 重启让它生效（这一步别忘）

```bash
# 重启 dsh web 让补丁层生效
```

> **两条必须知道的**（都是实测坑）：
> 1. **别用 `link:` 装**。`link:` 是符号链接，Node 的 ESM 按**真实路径**解析 ⇒ 包自己的相对 import 会找错地方
>    ⇒ **每个会话 exit=1**。要装就用**真的落到 profile `node_modules` 里**的形态（相对 `file:`）。
>    本项目自己的 `tools/` 脚本用的就是这个形态。
> 2. `dsh plugin add` 会把包按它声明的真名写进 `dsh.profile.bundles`
>    （判据是包的 `package.json` 里有 `dsh.bundle.patch` —— 本包有）。

**改完插件代码后不用重启**（实测）：让宿主换到磁盘新版——
```
dev_reload_package {"packageName": "<你的插件目录子串>/plugin"}
  ⇒ OK: 热重载完成（清缓存 N 模块，重建 M fiber）
```
（原理：它走注入器的 `purgeCache`，直接清 `ctx.loader.internal.loadCache` ⇒ 绕开 Node 全局 ESM 缓存。
 ⚠️ **顺序很要紧**：**先热重载、再改预设** —— 反过来，宿主会用**旧代码**去校验**新配置键** ⇒ 预设挂载失败。）

### ④ 然后：**选 `omc` 预设**

新建会话时把预设选成 **OMC 开公司模式（Agent Teams）**（或把 `agent-presets.default` 设成它）。
**选它 = 以开公司的方式做这个项目**；其它预设（含官方 `standard`）**不受影响**（已实测：
`SKIP-FOREIGN-PRESET {got:"standard", want:"omc"}`）。

### ⑤（可选）不重启、立刻试（开发/试用）

在装了 `dsh-super-injector` 的环境里：

```
dev_inject_plugin {"dir": "<本包的绝对路径>"}
```

卸载（**可卸净**）：

```
dev_uninject_plugin {"match": "dsh-teamkit"}
```

### ⑥（可选）离线用（不装进 DSH 也能跑）

```bash
node bin/teamkit.mjs doctor      # 环境体检（node / 包内文件 / 可写性 / 上游根 / **dsh·pnpm·npm 前置** / omc 预设）
node bin/teamkit.mjs status      # 当前配置会落到哪些路径（只读）
node bin/teamkit.mjs selftest    # 三态自测（沙盒里跑，不碰真上游）
node bin/teamkit.mjs list --source <你的技能仓>
node bin/teamkit.mjs promote --all --source <你的技能仓> --note "这次主要改了什么、为什么"
```

### 装上就有效果（默认配置，零配置）

装完**立刻**发生五件事 —— 这是刻意的（"装了没反应 = 差体验"）：

1. **插件自带 7 条方法技能**装到上游根 ⇒ 你和你的成员马上有方法可用；
2. **每个 roster teammate 拿到一份 fork 目录**（开始时是**空的**，纯透传，行为零变化，但它**看得见**"我自己有一份"）；
3. **上游变更通知**开始工作 —— 每步按 `sha1` 轮询上游（几十字节磁盘读，**零 token**），
   **只在真的变了、且该成员持有覆盖**时才推一条。
4. **每个成员拿到自己的「岗位人格段」** —— 按它的名字找 `roles/<name>.json`，渲染成一段
   **系统提示词**（`systemPrompt.section`，段名 `teamkit:role:<role>`，order 100）：
   里面有**岗位职责 / 验收口径 / 写范围 / 常用工具 / 评审门**，以及**它自己的工作原则**
   （`talents/principles/<name>.md`，**若已存在** ⇒ 这就是"自演化位"：
   成员做完活把自己的增量原则写进去，**下一次上岗自动带上**）。
   > **真宿主读数**：`ROLE-PERSONA-OK {"member":"reviewer","role":"reviewer","section":"teamkit:role:reviewer","order":100}`
   > **⚠️ 这一条只在 `roles.dir` 配对了的时候有** —— `omc` 预设里配好了（指向 `$DSH_HOME/teamkit/roles`）；
   > **不配 ⇒ 成员只是个普通 teammate**（没有岗位、没有原则）。判据看启动日志的
   > `SCOPE-GATE` / `ROLES-LOADED` / `ROLE-PERSONA-OK` 三行。

   #### 4.1 ★★ 职责层：**"该做什么 / 不该做什么"**（开箱即有，不用再交代一遍）

   > **这一节回答一个具体问题**：*新开一家公司，我是不是还要把"CEO 该做什么、不该做什么"再说一遍？*
   > **不需要。** 每个角色的 `roles/<name>.json` 里带了两个字段，渲染进上面那段系统提示词：

   | 字段 | 含义 | 谁写的 |
   |---|---|---|
   | `duties` | **该做什么**（3–5 条） | `talents/<name>.md` 的 frontmatter（权威源） |
   | `boundaries` | ★ **不该做什么**（3–5 条，**与上一条同等重要**） | 同上 |

   **每条都带「理由指针」（`依据：…`）** —— 指向我们自己的真实事故或成文法（例：`ORG.md §1.2.1`）。
   这是刻意的：**没有理由的规则是口号，拦不住任何人**。

   成员开箱看到的就是这段（真读数，非示意）：

   ```
   **你该做什么（职责）**：
   - 对委托方交接 · 定编制 · 批预算 · 裁分歧——其中开人/改派/设别人的任务依赖只有 Lead 能做（依据：ORG.md §2）
   - 抽查「读数够不够支撑结论」——只看读数不出手（依据：ORG.md §1.2）
   **你不该做什么（边界；与上一条同等重要）**：
   - ★ 不写任何代码或脚本——唯一例外是只有 Lead 能做的事（依据：ORG.md §1.2；账：写完后【又越权 2 次】并引发 P0 事故）
   - 不做 verification（依据：ORG.md §1.2.1 外部依据+我们的账）
   ```

   **8 份角色档**（`chief` / `coo` / `director` / `engineer` / `marketer` / `research-lead` / `reviewer` / `writer`）
   **都带这两个字段**；新增角色**必须**带（`talents/_SPEC.md` 里标为必填，生成器会拒写）。
   `director` 是**总监层**档（`level: lead`），对应"领导者该做什么、不该做什么"。

   **怎么验**（两条命令，都在仓内可跑；开源用户装完也能跑第 2 条）：

   ```bash
   node tools/verify-shipped-roles.mjs       # 发货态：真机 roles 与源一致 + personaFor 真拼出职责
   node tools/verify-clean-install-e2e.mjs   # 干净环境端到端：空 home 装一次 ⇒ 成员上下文里已有职责
   ```

   > **⚠️ 为什么单列这两个脚本**：这个功能的判据**不是**"仓里写了字段"，
   > 而是**"陌生人装完就有"** —— 所以你可以在一个**干净目录**里自己验一遍（两个脚本都不碰你的 `$DSH_HOME`）。
   > 对应的"能红"证据：删掉某份角色档的 `duties` ⇒ 两个脚本都会报红（不是"看起来有检查"）。

   #### 4.2 ★★ 编制层：**我向谁报 / 我手下有谁**

   > **和 4.1 回答的是同一件事的两半**：4.1 是**内容**（我该做什么），这里是**关系**（谁归谁管）。
   > 委托方原话要的「**领导者该做什么**」—— ★ **"管谁"就是它的一半**。

   **一个字段，两个方向**：

   | | 存在哪 | 说明 |
   |---|---|---|
   | **我向谁报** | 角色档的 `reports_to`（**单值**，填上级的成员名） | 权威源是 `talents/<name>.md` 的 frontmatter |
   | **我手下有谁** | ❌ **不另存字段** | ★ 它是 `reports_to` 的**反向索引**，运行时从全部角色档算出来（`R10`：同一事实只存一处 —— 两边都写，改一处忘一处必然不一致） |

   **成员开箱看到的就是这段**（真读数，非示意）：

   ```
   **你的编制（关系；与职责同等重要）**：
   - 直接上级：`chief`
   - 你手下有：`director`
   （编制决定"谁该向谁回报、谁的结论由谁复核"；越级不是禁止，但要说清为什么。依据：ORG.md §2 编制图）
   ```

   ★★ **"没有上级"与"没声明上级"是两件事** —— `chief` 上面没有人，它渲染成：

   ```
   - 直接上级：**未声明**（这一档就是"未声明"——不编一个上级给你）
   ```

   > 这一档是**故意留的**：编造一个上级比留空更坏（`chief` 的字段是**可选**的，正是为了这个）。
   > ⇒ 所以它**明写"未声明"**，而不是静默跳过那一行。

   **默认编制**（8 份角色档）：`chief`（未声明）← `coo` ← `director` ← 5 名执行者
   （`engineer` / `marketer` / `research-lead` / `reviewer` / `writer`）。依据 `ORG.md §2` 编制图。

   **怎么验**（与 4.1 同两个脚本，都**不碰**你的 `$DSH_HOME`）：

   ```bash
   node tools/verify-shipped-roles.mjs       # 发货态：真机 roles 有 reports_to 且 personaFor 渲染出上级
   node tools/verify-clean-install-e2e.mjs   # 干净环境：空 home 装一次 ⇒ 提示词里有"直接上级" + chief 的"未声明"
   ```

   > "能红"证据：删掉某份角色档的 `reports_to` ⇒ 干净环境那条断言会报红。

5. **每步读一眼 `<stateDir>/soul/<name>.md`（SOUL）** —— 若它存在，就作为**一条 user message**
   注入该成员**这一步的上下文**（`agent/pre-step`）。这是**成员的自我迭代**：
   它（或被判决点名后）把"我答应改什么"写进自己的 SOUL，**下一步就生效**。
   > **为什么单开一条通道，不并进上面第 4 件**：第 4 件走**系统提示词**，那是**装配期一次性**的
   > ⇒ 本会话内改了**不生效**；而绩效闭环要求"**改了 → 下一轮用同一条读数复检**"。
   > SOUL 走**每步的 user message**，所以**改了下一步就进上下文**（真宿主读数：
   > `SOUL-INJECT member=coo #1 step#1 sha=… bytes=49 why=first-read`）。
   > **按 sha256 去重**：文件没改就**不重复注入**（避免每步白灌稀释注意力）；
   > **没有文件时什么也不做、不报错**（"这人不写 SOUL"是正常状态）。
   > 路径：`$DSH_HOME/.teamkit/soul/<name>.md`（`soul.dir` 可覆盖）。

---

## 配置（**每一项都给默认值和理由**）

配置唯一的落点是插件的 `config`（profile patch 或 `loader.create` 的 config）。
**不认识的键会被拒绝**（不是静默忽略 —— 那正是"失败不静默"要防的）。

> ⚠️ **在 profile patch 里覆盖 `config` 必须把要保留的键写全**：patch 的覆盖语义是
> **按顶层键赋值，不是深合并**。只写一个键会把整个 config 对象换掉。

| 键 | 默认值 | 为什么是这个默认值 |
|---|---|---|
| `workspace` | `$DSH_TEAMKIT_WORKSPACE` → `process.cwd()` | cwd 是"用户在哪想用这套"的唯一无盘符信号；不猜仓名 |
| `dshHome` | `$DSH_HOME` → `~/.dsh` | DSH 自己的口径。⚠️ 本机 `os.homedir()` 返回的是**一个非真实家的账户名**（不是你的家目录）⇒ **env 优先** |
| `stateDir` | `$DSH_HOME/.teamkit` | ⚠️ **task-57 改**：**全局一份**的状态根（history / CHANGELOG / log 都在它下面）。旧默认 `<workspace>/.teamkit` 在真宿主里 = `process.cwd()` ⇒ **多项目串台**（实测：`D:\dsh\.teamkit` 里同时躺着两个项目的成员 fork）。必须在 6 个技能扫描根之外 |
| `agent.stateTemplate` | `{cwd}/.teamkit` | ⚠️ **task-57 新增**：**按 agent 分**的状态根模板。`{cwd}` = 该 agent 的 `session.header.cwd` ⇒ 每个项目各有自己的 fork 落点。**这是修串台的正解** |
| `fork.perAgent` | `true` | ⚠️ **task-57 新增**：fork 落点是否按 `agent.cwd` 分。`false` = 退回旧的"跟 workspace"行为（逃生开关） |
| `forkRootTemplate` | `<stateDir>/forks/{member}/skills` | **全局兜底**（拿不到 agent cwd 时用）。`{member}` 槽位是必须的（多成员不能互相踩）；放 stateDir 下 ⇒ 永不被当上游技能 |
| `historyDir` | `<stateDir>/history` | **全局一份**：快照的是**上游**版本（`upstream.js:189-194` 拷的是上游根文件）⇒ 属于上游、不属于任何成员。深度 3 已实测**不污染**技能扫描 |
| `changelogPath` | `<stateDir>/CHANGELOG.md` | **全局一份**：记的是**上游更新史**（`upstream.js:214`）。⚠️ **不能放技能根**：技能根下深度 1 的 `*.md` 会**当场变成一条技能**（已实测） |
| `logFile` | `<stateDir>/teamkit.log` | **全局一份**：宿主级事件只有一份，跨项目可对照。插件的 stderr 在会话里看不见 ⇒ **盘上日志是唯一事后可审计的面** |
| `preset.id` | `''`（= **不过滤**） | ⚠️ **task-58 预留键**：**「我这次挂载属于哪个预设」**。未配置 ⇒ 不过滤（向后兼容，现有行为零变化）；配了 ⇒ 只接管 `composedPreset(agent.ctx) === preset.id` 的成员。⚠️ **过滤逻辑由 task-58 实现在 `lib/index.js`**；本表只声明这个键**存在且被校验**（不注册它会被判"未知键"，反而伤体验） |
| `roles.dir` | `''`（= **角色层不生效**） | ⚠️ **公司层的角色档目录**。`''` ⇒ `index.js` 打 `ROLE-SKIPPED` 说明"**这一项没生效，不是装好了**"（不静默）。**`omc` 预设已把它配成 `$DSH_HOME/teamkit/roles`** ⇒ 用 `omc` 时不用管；自己配别的预设时要给。**默认不猜任何绝对路径**（照"零硬编码"那条北极星 —— 路径形状由用户/预设给） |
| `principles.dir` | `''`（= 自动找） | ⚠️ **自演化位（工作原则）的目录**。`''` ⇒ 用**候选列表**去找（从 `roles.dir` 逐级向上 / workspace 下）；一个都没命中 ⇒ `PRINCIPLES-DIR-NOT-FOUND` 警告 + 人格段**明说"还没写"**（不静默）。⚠️ **别用"往上的层数"硬推**：`roles.dir` 的形状取决于用户怎么配，**层数不是不变量**（我第一版推错过一层，导致"7 份角色全部没写过原则"） |
| `upstream.root` | `$DSH_HOME/skills`（**`omc` 预设覆盖成 `$DSH_HOME/teamkit/skills-upstream`**） | `dsh-skill-filesystem` 的 user 根（rank 400）；`promote` 的默认落点。⚠️ **这个默认值只在"bundle 装法（不选预设）"下生效**；`omc` 预设显式把它指到 `teamkit/skills-upstream`（与 `customSkillDirs` 同指一处，保"上游链闭合 + 技能隔离"）。**两套装法各读各的** ⇒ 安装器把 7 条**两份都装**（见上面「装 6 样」那节的说明） |
| `upstream.sources` | `[<workspace>/skills]` | "仓内源" = 你要合并进上游的那份技能仓。**开源用户把它指向自己的仓** |
| `upstream.extraRoots` | `[<workspace>/.agents/skills, <workspace>/.dsh/skills]` | 另两个项目级上游根（rank 200/100），供**通知**监视 |
| `skills.enabled` | `true` | "装上就有效果"：把插件自带的 7 条方法技能装到上游根 |
| `skills.sourceDir` | `<插件包>/skills` | 自带技能的源（**包的一部分**，不是你的仓 —— 别和 `upstream.sources` 搞混） |
| `skills.overwrite` | `false` | 默认**只补缺、不覆盖**：你已有的同名技能不该被插件悄悄换掉 |
| `fork.enabled` | `true` | fork 是这套东西的承重件；关掉就只剩"大家读同一份公共技能" |
| `fork.members` | `['*']` | `'*'` = 全部 roster teammate。这是"零配置就有效果"的那一档 |
| `fork.providerName` | `teamkit-fork` | 出现在诊断里；同 scope 重名会抛错（有意的，不许静默） |
| `fork.rank` | `250` | 比上游根（100–600）**靠前**，这样 fork 覆盖才赢；与 DSH 内置 runtime rank 同值无妨（不同层） |
| `fork.createDirs` | `true` | 建空 fork 目录 ⇒ 成员**看得见**自己那份在哪（认知是控制点） |
| `notify.enabled` | `true` | 上游更新通知；只对**持有覆盖**的成员推 ⇒ 零配置也不会吵 |
| `notify.minIntervalMs` | `60000` | 每成员每分钟至多一条。⚠️ 超限**不丢**：进 pending 队列，窗口过后补推 |
| `notify.maxNoticeBytes` | `4000` | 通知正文上限。超限**截断并明说**（不是整条不推） |
| `notify.maxBodyExcerpt` | `900` | 改后正文的摘录长度；超长给路径 |
| `notify.tracked` | `'auto'` | `'auto'` = 只跟踪"该成员在 fork 里真的改过"的条（零配置且天然"只推该推的"） |
| `guard.enabled` | **`false`** | **默认关** —— 见下面的"诚实口径"。它只是误操作护栏，不是安全边界 |
| `guard.writers` | `[]` | 白名单（成员名）。只有 `guard.enabled: true` 时才有意义 |
| `guard.extraProtected` | `[]` | 除上游根外额外受保护目录 |
| `soul.enabled` | **`true`** | **SOUL 注入**（成员的自我迭代，走每步 user message）。没文件时**什么也不做** |
| `soul.dir` | `''` | `''` ⇒ `<stateDir>/soul/`（`$DSH_HOME/.teamkit/soul/<name>.md`） |
| `soul.seed` | **`true`** | ★ **SOUL 骨架播种**（task-101）：新成员上岗时**先种一份空骨架**（显式「未填」占位 + 写明绝对路径该往哪写），**绝不编人格**、**绝不出现第一人称承诺句**（那要它自己写）。**幂等**：已有 SOUL ⇒ 一个字节都不动。**逃生开关**：设 `false` ⇒ 日志显式打「**未播种（显式关闭）**」 |
| `memberRelease.enabled` | **`true`** | **破坏性**：释放成员（名单不再列出 + 名额真释放）。⚠️ **默认【开】** —— 2026-09-14 委托方定向：「**能够撤人的功能，要默认打开**」。三道闸兜底：`requireReason`（必须写理由）/ `unrelease_member`（可撤销）/ 台账落盘。**不想要**就显式设 `false` |
| `memberRelease.readonlyTools` | `true` | 只读的 `list_zombies` **单独一档**（"先看得见再动手"） |
| `memberRelease.requireReason` | `true` | 释放**必须写理由**（拒绝时 `code=2`） |
| `memberRelease.trackingFile` | `member-release.jsonl` | 侧车台账（**重启后靠它重建**） |
| `crashGuard.enabled` | **`true`** | ★★ **保命网**：给**宿主进程**的 `process.stdout`/`stderr` 装 `'error'` 监听，**只吞管道断开**（`code` = `EOF`/`EPIPE`）⇒ 宿主不会因"壳不再读它的 stdio"而**自杀**（`Error: write EOF` / `errno -4095`）。⚠️ **别的 error 一律重新抛**（**不掩盖任何别的错误**）；⛔ **不装 `process.on('uncaughtException')`**。★ **可卸**（卸载后监听器计数回原值）· ★ 装/关/失败**各有一条日志**（`grep CRASH-GUARD`）。⚠️ **诚实口径**：它治的是**已证的那一类**（管道断开 —— 对照实验：**pipe 崩、TTY 不崩**）；对现场那次崩溃**未必对症**。**不想要**就设 `false` |
| `e2r.enabled` | **`false`** | **`E²R` 风险档总闸**：它是本插件里**唯一"可能打断任务板"**的能力 —— 漏放一个 agent scope 的出口 schema ⇒ 那个成员一调 `team_task_list` 就报 `additionalProperties: false`。**默认关** |
| `e2r.structure` | **`true`** | **零风险**那一档：台账（`e2r.jsonl`）+ `description` 摘要 + 三件工具（`set_task_structure` / `review_task` / `team_structure`）。**只写我们自己的文件、只用底座已有的 `edit` action** ⇒ 装上就有效果 |
| `e2r.schemaPatch` | **`false`** | 路径 A 的**下级开关**（与 `e2r.enabled` **都 true** 才动）：放开 4 个 team task 工具的 `output.schema`。装完**立刻验**、验不过**整段回滚**（绝不半装） |
| `e2r.trackingFile` | `e2r.jsonl` | `E²R` 侧车台账（**按 Team root 分桶**；包装在内存 ⇒ 重启即失效 ⇒ 靠它重建结构） |
| `probeGate.enabled` | **`true`** | ★★ **探针闸门（`R2` 在线拦）**：装 `dev_stage_add` 之前校验"有没有往**会被持久化的共享对象**写字段/改原型且**无回读校验**" ⇒ 违规**拒装**（报错自带修法）。**逃生开关**：设 `false` ⇒ 日志显式打「**这道闸已关**」，违规探针可装。<br>⚠️ **生效范围：挂载它的那个 preset realm**（真宿主读数：当前 = `omc` 那层）—— **`standard` 预设的 agent 未被覆盖**，这是**已知缺口**（准确说法是「**`standard` 成员的坏探针目前没人拦**」，**不是**「全宿主都有保护」）。<br>⚠️ **liveness**：它在 `guardReason` 热路径上（**每一次工具调用**都要过，落哪层都一样）⇒ 实现上**第一行 O(1) 短路 / fail-open / 不 await / 不读盘**（否则误杀 = 该链上停摆）。<br>⚠️ **覆盖范围有限**：只拦 `dev_stage_add` 这条路；**`pwsh`/`node -e` 内联改共享对象看不到**、注册前已 staged 的没检过。⇒ 准确说法是「**把两次事故走的那条路拦住了**」，**不是**「`R2` 机械化了」。详见仓根 `RULES.yml` 的 **R8**（不是 `runs/...`；`RULES.yml` 在仓根） |

环境变量（都可覆盖）：

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 家目录 |
| `DSH_TEAMKIT_WORKSPACE` | 工作区（`workspace` 的默认来源） |
| `DSH_TEAMKIT_STATE` | 状态目录 |
| `DSH_TEAMKIT_LOG` | 日志路径 |
| `DSH_TEAMKIT_DISABLE` | **药停文件**路径：该文件存在 ⇒ guard 立即放行（建文件即停药，不用重载插件） |
| `DSH_AGENTS_HOME` | ⚠️ **本插件不读它** —— 它是 **DSH 原生**的技能根（rank **500**，由 `dsh-skill-filesystem` 自己扫 `$DSH_AGENTS_HOME/skills`）。列在这里只是**告诉你生态里有这个变量**；`teamkit status` 的返回值里**没有** `agentsHome` 字段（别去找） |
| `DSH_PACKAGES` | （仅自测 / 真注册表探针用）含 `@deepseek-ai/dsh-skill` 的 `node_modules` |
| `DSH_CHECKOUT` | （仅探针用）DSH 源码 checkout，用于找 `node_modules` |

> **判据**：`grep` 一个变量名时，**"它出现在某张表里" ≠ "它被用了"**。
> 要确认"谁在读"，得看**调用点**（`process.env[…]`），不是看表。
> （2026-09-14 / Round 73：`ENV.agentsHome` **声明了但没人读** —— 我第一次看表时也以为六个都在用。）

---

## 命令

```bash
teamkit selftest [--json] [--keep]   # 三态自测（沙盒里跑，不碰真上游）
teamkit status                       # 当前配置解析结果 + 各件开关 + guard 的诚实口径
teamkit list   [--source <dir>]      # 上游待合并清单（只读）
teamkit promote (--skill X | --all) --note "说明" [--source <dir>] [--upstream <dir>] [--dry-run]
teamkit rollback <skill>             # 回到该技能的最近一次快照
teamkit fork-init <member> <skill>   # 把上游某条带进该成员的 fork（"我要改它"的起点）
teamkit doctor                       # 环境体检
teamkit version                      # 报版本（读 package.json，不写盘）—— 报 bug 时带上它
teamkit preset-new <name> [--template <t>] [--out <dir>] [--role <r>] [--persona <text>] [--description <text>] [--order <n>]
                                     # 用**模板 + 参数**生成一个新预设（**完整文件**）；模板：lite（轻量小队）/ full（全公司）
teamkit orphans --snapshot <file>    # 孤儿任务巡检：`in_progress` 但 **owner 不活跃/不在名单** ⇒ **exit=1（红）**
teamkit resume  --snapshot <file>    # ★ **重启后的续接**：列出孤儿任务 / 失联成员 / 被 disarm 的 goal（**只列，不发送**）
teamkit wake    --snapshot <file> [--yes]
                                     # ★ **真的重新点名**（给失联成员发消息）—— 默认 **dry-run**，`--yes` 才真发
teamkit goals   [--snapshot <file>]  # ★ **goal 的落盘状态**（含被 `disarm` 的）—— 对应「把 goal 重新打开」
teamkit board-replay --snapshot <f>  # 任务板重放（journal 是 event-sourced ⇒ 核对重放后与当前板是否一致）
teamkit probe-check <file> | --stdin  # 探针源码静态检查（"写共享对象且无回读" ⇒ 判红）
teamkit verify-route <member> [--provider <p>] [--route-map <file>] [--usable a,b] [--blocked c,d]
                                     # 派验证岗**之前**核"它在不在可用链上" ⇒ 402 链 ⇒ **exit=1（红）**
teamkit help                         # 本页（不写盘）
```
> ★★ **`resume` 的"快照怎么来"**（**这一句很要紧，写错了会出假绿**）：
> `--snapshot` 里的 `members` / `live` **必须来自进程内 `list_agents`** ——
> **不要用 journal 的 `phase` 去推断**（那是重放出来的历史态：**看着"有人在做"，其实会话早没了**）。
> 快照的产生方式与逐条说明见 `runs/005-role-skills/RESUME-USER-VIEW.md`。
> ⚠️ **退出码说真话**（2026-09-14 / Round 78 修）：
> `help` / `--help` / `-h` / `version` / `status` / `list` ⇒ **0**；
> **无参数**（"你没给子命令"）与**未知子命令** ⇒ **1**（对照 `git`/`npm`）。
> 以前无参数返回 0 —— 根因是 `const cmd = argv[0] ?? 'help'` 那个兜底**让"没给子命令"永远走不到自己的分支**。
```

> ⚠️ **`fork-init` 只作用于「全局」fork 根**（task-57 裁定）
> 它是**离线路径**：没有 agent ⇒ 拿不到 `session.header.cwd` ⇒ **无法按项目分**。
> 如果你给某个成员的 fork 播种，而那个成员属于**某个具体项目**，那粒种子会落在
> **全局** fork 根（`$DSH_HOME/.teamkit/forks/<member>/skills`），**而它实际读的是 `<它的 cwd>/.teamkit/...`**
> ⇒ **对不上**。运行时它会打一行 `FORK-SEED-GLOBAL` 明说这件事（**不静默**）。
> **在项目里要播种**：直接用文件工具把上游那份 `SKILL.md` 写到该成员**实际的** fork 目录
> （路径见通知里的"你那一份"，或日志里的 `FORK-REGISTER-OK … dir=`）。
> 要把它做成机制（例如给 CLI 加 `--cwd`）是**新功能**，见 `runs/005-role-skills/STATE-LOCATION.md` §6。

> ★ **`preset-new` —— "手抄预设"变成"一次命令生成"**（task-99）
> ```
> teamkit preset-new my-team --template lite     # 生成 <$DSH_HOME>/.agent-presets/my-team/
> ```
> · **生成的是完整文件**（`agent.cordis.yml` + `preset.yml`），**不是"只存差异"** ——
>   理由：技能 fork 的"只存差异"依赖一条**已存在的 overlay 机制**（nearest layer wins），
>   而 **DSH 的预设是整体挂载、没有逐行合并语义** ⇒ 要"只存差异"就得**新造一层合并语义**
>   ⇒ **不许发明**（会和 DSH 机制打架）。
> · **不复制基线、不引用基线** ⇒ 生成物**自足**；与 `omc` 不共享任何字节（改模板不影响 `omc`）。
> · ⚠️ **可复跑**：**手改过生成物之后，再跑一次 `preset-new` 会把它覆盖回模板的样子**。
>   要保留手改 ⇒ 改模板（`presets/_templates/<模板>/agent.cordis.yml.tmpl`），或换个名字生成。
> · ⚠️ **永不覆盖已有预设**：目标目录已存在 ⇒ **拒绝**（贴出路径与建议）。
> · 名字必须符合 DSH 的预设 id 规则 `/^[a-z0-9][a-z0-9-]*$/`（小写字母/数字/连字符）；不合法 ⇒ **拒绝**。
> · `--out` 缺省 = **`$DSH_HOME/.agent-presets/`**（DSH 真正读用户预设的那个根；
>   常量 `USER_PRESET_DIR = '.agent-presets'` 在 **`dsh-agent-presets`** 包的
>   `lib/types/discovery.js` 里）。**不要**指向包内目录 —— 那里没人读。
> · `--role <r>` **只写进 `preset.yml` 的显示元数据**（作标签），**绝不内联岗位数据** ——
>   岗位数据的事实来源是 `talents/*.md`（→ `roles/*.json`），预设只做**装配**。

> ★ **`orphans` / `verify-route` —— 把两件"靠人记得看"变成能红的命令**（task-107）
> ```
> teamkit orphans --snapshot snap.json       # 有孤儿 ⇒ exit=1
> teamkit verify-route reviewer --provider deepseek-official   # 402 链 ⇒ exit=1
> ```
> · **`orphans` 查什么**：`status === 'in_progress'`（板上说"有人在做"）**且 owner 已不活跃**。
>   **★ 活跃性只认进程内（`list_agents` / `memberView.list()`），不认 `journal.phase`** ——
>   `phase` 是**写入时快照**，进程死了它不变（"僵尸活跃"）；实测同一时刻
>   `phase===active` 有 22、进程内只解析得出 7 ⇒ 用 `phase` 会算出"0 孤儿"的**假绿**。
>   ⇒ 快照里的 `members` **必须来自宿主进程内**。
> · **三态**：`0` 无孤儿 ／ `1` **有孤儿（红）** ／ `2` **未获取**（读不到快照/成员列表）。
>   ⚠️ **"读不到"绝不静默成 `0`** —— 读不到人 ≠ 没有人。
> · **`verify-route`**：派验证岗之前先核"它在不在可用链上"（402 链上的成员 =
>   **叫一个不会答的人答题 = 假机制**）。可用/坏链名单可用 `--usable` / `--blocked` 覆盖
>   （**不写死**：开源用户的路由不是本部署那两条）。
>
> ⚠️ **已知限制（"装了才发现"类，请先读）**：
> **`orphans` 不会自己取数、也不会自己周期性地红** —— 它是**离线命令**，看不到宿主内存，
> 必须有人**喂一份快照**（`--snapshot`）。⇒ 它把"人肉比对 `team_task_list` × `list_agents`"
> 降成"喂一份快照 + 看退出码"，但**不等于自动巡检**：**"谁定时喂"仍需另行安排**。



**`--source` 不是可选项**（我写测试时踩到的真坑）：CLI 是**离线**跑的（没有 profile ⇒ 配置只能来自 env/参数）。
不给 `--source`，它会对你配置里的源干活 —— 如果你没配，它会看向**插件自带的 `skills/`**，
于是 `promote --all` 会把插件自带那几条合上去，而**你想合的一条也没动，且不退错**。
所以 CLI 显式提供 `--source` / `--upstream` / `--state` 三个覆盖。

## 运行时的工具（**模型自己会调的那些**）

上面那节是**你在终端敲的**；这一节是**装进 DSH 之后、agent 自己能调的工具**。
（`tools` 面上还有 `read` / `pwsh` / `send_message` / `team_task_*` 等官方工具，本节只列**本插件加的**。）

| 工具 | 什么时候出现 | 干什么 | 判据 |
|---|---|---|---|
| `list_zombies` | **默认就有**（只读、零风险） | 列出"看得见、用不了、还占名额"的成员：`phase=failed` 的、长期没活动的 | 只读；**拿不到名单时返回「未获取」而不是"没有僵尸"** |
| `release_member` | 只在 `memberRelease.enabled=true` 时 | 释放一个成员：名单不再列出、**名额真释放**、发给它找不到 | **`reason` 必填**（schema 层 `required`）+ **必须能确定是哪个 Team** |
| `unrelease_member` | 同上 | 撤销一次释放（误操作回退），幂等 | 只影响**调用方所在的那个 Team** |
| `read_self` | **默认就有**（只读） | 读**你自己**的那几份落盘文件（SOUL / 岗位原则 / 角色技能） | **宿主侧代读** ⇒ 绕开 agent 沙箱（那几份在 `$DSH_HOME`，**在工作区之外**） |
| `write_self` | **默认就有** | 写**你自己**的那几份。**默认追加**；整篇重写要显式 `mode:"replace"` | **宿主侧代写** + **写完回读校验**；`target` **只允许三个**（不接受任意路径 ⇒ 不是沙箱后门） |
| `set_task_structure` | **默认就有**（`e2r.structure !== false`） | 设任务的**分解边**（`E_tree`：它从哪个任务切出来），并把摘要写进 `description`。**传空 `parent_task` = 清掉**这条结构 | 零风险：只用底座**已有的** `edit` action，**不碰任何 schema** |
| `review_task` | **默认就有**（同上） | 写**评审判决** `accept` / `reject` / `none` + 理由 | **`note` 必填**（schema 层 `required`）+ **必须能确定是哪个 Team** |
| `team_structure` | **默认就有**（同上，只读） | 读结构视图：`parentTask` / `reviewState` / **`accepted`**（= `completed` **且** accept） | **我们自己的读口** ⇒ 看结构**不需要**动底座的 `team_task_list` |

> ⚠️ **`review_task` 不是强制点**（诚实口径，别读成"会拦住你"）：
> 底座**不认** `reviewState` 这个字段 —— **没有任何底座代码因为它而拒绝什么**。
> 真拦住"没评审就往下走"的**只有**：**把评审建成任务 + 让下游 `blocked_by` 它**
> （那条 `claim` 被宿主**硬拒**：`team task "…" is not ready to claim`）。
> ⇒ `review_task` 做的是**把判决落到盘上、并让它出现在板上**，不是"拒绝谁继续"。
> **分解边同理**：它**不是**底座的 `blocked_by`（那是**依赖边** `E_dep`，管"先做谁"）；
> `parentTask` 管"**由谁组成**"。同一对节点上两者**方向可能相反** ⇒ 是**近似**，不是等价。
> 详见 `teamkit-review` 的「哪部分是机制、哪部分是协议」。

> **为什么 `read_self` / `write_self` 也在这里**（2026-09-14 / Round 66 补）：
> 它们**默认就注册**（不像 `release_member` 要开开关）—— 因为"**自我迭代**"（写自己的 SOUL / 原则）
> **不该被一个破坏性开关挡住**；它们**不在** `memberRelease` 闸门里（**闸门独立**）。
> ⚠️ **为什么必须由插件代写**：那几份文件装在 `$DSH_HOME`（**agent 工作区之外**）⇒
> 用 `write` 工具会被**沙箱拒**（`[sandbox: file access denied under workspace-write mode]`，实测）。
> `target` **三选一**：`soul` / `principles` / `role-skill`（要带 `skill` 名）。
> 详见 `teamkit-escalate` 的「S2 怎么真写下去」那一节。

**为什么 `list_zombies` 与两个写工具分开**：把"看得见"绑在"能动手"后面，
会让你**想看一眼有没有僵尸就得先打开破坏性能力** —— 与"先看得见、再决定动谁"正好相反。
⇒ 所以**只读的默认开**；**写工具默认也开**（⚠️ **2026-09-14 起**：委托方定向「**撤人必须默认打开**」，
不是本 README 早前写的"默认关" —— 那**已过期**）。

```jsonc
// 释放成员：**默认已开**，通常不用配。若你显式关掉过，想再打开就写：
{ "memberRelease": { "enabled": true, "readonlyTools": true, "requireReason": true } }
// ⚠️ 想关掉（不接受"招错人可撤"这个能力）⇒ 显式设 enabled: false
```

**四条必须知道的边界**（细节与真宿主读数见下面「限制 §1」）：
1. **只影响一个 Team** —— 同一进程里可能有好几个 Team，`standard` 与 `omc` **可以有同名成员**
   （实测：`engineer` 同时在 4 个 Team 里）⇒ 过滤器**按 Team root 分桶**，不会误伤别队。
2. **名字不可复用** —— 释放后招人**要换新名**。
3. **重启后靠台账重建**（`<stateDir>/member-release.jsonl`）—— 包装在内存里，台账在盘上。
4. **日志里抹不掉**（也不该抹）—— journal 是 event-sourced，**抹掉等于伪造历史**。

> ⚠️ **它不是"仅 Lead 可调"**：底座没有"工具级角色门" ⇒ 同进程里**别的 agent 也看得见**这两个写工具
> （只要 config 开了）。**这是如实口径**，别把它当成权限系统。

### `promote` 的四件事（顺序不可换）

1. **快照**旧版 → `<state>/history/<skill>/<sha8>/SKILL.md`（供成员自己 diff）
2. **合并**：源覆盖上游
3. **记账**：往 `<state>/CHANGELOG.md` 追加说明 + 前后 sha256 + 回退命令
4. **复核**：**回读校验**说明真的落盘（缺了就退出码 3，绝不假装成功）

**⚠️ 说明是硬门**：没有 `--note "…"` ⇒ **退出码 2，一行都不写**。
为什么做成硬门：委托方要「每次 push 都要发个主要做了什么」，而**写手是模型** ——
**最不可靠的恰好就是仪式**。而且说明挂在"写"这个动作上，所以不受"按步轮询会折叠突发提交"
那个缺陷影响（一步内连改多次时，中间的版本连同说明会一起被跳过）。

**退出码**：`0` 成功 / `1` 失败 / `2` 缺说明或无事可做 / `3` 写进去了但回读校验失败。

---

## 测试（离线三态）

```bash
node bin/teamkit.mjs selftest          # 人读
node bin/teamkit.mjs selftest --json   # 机器读
```

**三态约定**（照 `tools/verify-handoff.mjs`）：

| 状态 | 含义 | 退出码 |
|---|---|---|
| **PASS** | 实测成立 | — |
| **FAIL** | 本插件自己的逻辑错了（可修） | 1 |
| **UNVERIFIED** | **读不到 ≠ 不成立**：没测过就不算过，也不算失败 | 2 |

`selftest` **默认沙盒化**（`DSH_HOME` 与 workspace 都指向 `os.tmpdir()` 下的临时目录），跑完默认清场
（`--keep` 保留）。它**不碰**真上游、不碰真 profile、不改 `process.env`。

**当前读数**：**自己跑一下，别看这里写死的数字** ——
```bash
node bin/teamkit.mjs selftest
```
> ⚠️ **这里故意不写死通过数**（2026-09-14 / Round 27 更正）。
> 原因：原来这里写着「90 通过」，而**同一天实测已经是 153 通过** ——
> 断言数每轮都在加，**写死的数字必然过期**，而过期的数字会让人以为"是不是我装坏了"。
> ⇒ 判据是**退出码**与**三态**，不是数字：
> **`0` = 全 PASS；`2` = 有 UNVERIFIED（不是失败，也不是通过）；`1` = 有 FAIL（这条才要管）。**
>
> **那几条 UNVERIFIED 现在到底什么状态？** 见 `runs/005-role-skills/UNVERIFIED-LEDGER.md` ——
> 逐条给三列（是什么 / 有没有真读数 / 读数在哪）。**判据**：要么给指针，要么承认"没有"。
> ⚠️ **本行不写"已补验几条"**（那种数字会随每轮变，与上面的通过数同理）——
> **以那份台账为准**（它是单一事实来源）。

那 6 条 UNVERIFIED 是**缺真 DSH 现场**的（真的要起 `dsh web` 宿主 / 真 spawn teammate 才能测）——
它们不是失败，也**不许当成通过**。清单见 `runs/005-role-skills/PLUGIN-PACKAGE.md` §I。

**真注册表探针**（把"用自造合并器模拟"升级成"驱动真 `dsh-skill`"）：

```bash
node scripts/probe-real-registry.mjs     # 独立子进程，只读，不碰正在跑的 dsh
```

它 `import()` 真的 `@deepseek-ai/dsh-skill`、`new Context()` + `new SkillRegistry(ctx)`，
注册两个 provider，然后调**真的** `list()` / `get()` 断言 overlay 的承重假设。
**退出码**：`0` = 真读数拿到且语义成立 / `1` = 拿到但语义不成立 / `2` = 拿不到（**未验证**，不是失败）。

---

## 更新（**已经装过的人，怎么拿到新版**）

> ★★ **先看你的版本**（判断"我拿到的是不是新版"的**唯一硬判据** —— 没有它，"更新了"只是感觉）：
> ```bash
> node <你的安装位置>/bin/teamkit.mjs version     # 或 `teamkit version`
> #   ⇒ 打印 `@dsh-external/dsh-teamkit <版本号>`（本版是 0.1.2）
> ```

### 一条能照抄的更新命令

```bash
# ① 拉最新（公开仓）
git clone https://github.com/yjh051108/dsh-teamkit.git /tmp/dsh-teamkit   # 或 git pull（已 clone 过）
#    ⚠️ 没有 git ⇒ 到 https://github.com/yjh051108/dsh-teamkit 点 "Code → Download ZIP" 解压也行。

# ② 重新装插件（**先卸载旧版更干净**）
dsh plugin --profile web remove @dsh-external/dsh-teamkit      # 卸旧（可选，但推荐）
dsh plugin --profile web add "/tmp/dsh-teamkit"                # 装新（**绝对路径**，不是 file:）

# ③ 重装"资产"（角色档/技能/组织层/预设 —— 插件只是机制，这些才是内容）
cd /tmp/dsh-teamkit && node tools/install-teamkit.mjs

# ④ 重启 DSH（或新开一个会话）⇒ 让新代码生效
```

> ⚠️ **两个已实测的坑**（会在第 ② 步撞到，且报错**看不出是缺前置**）：
> · **`pnpm` 必须在 PATH 上** —— `dsh plugin` 是**转发给 pnpm** 的；不在时只报
>   `'pnpm' is not recognized`。
> · **给绝对路径，不要 `file:./…`** —— 实测 `file:D:/…` 报
>   `ENOENT: scandir '…\profiles\web\D:\…'`（pnpm 按 **profile 目录**解析相对路径）。

### 怎么知道"我更新成功了"

| 判据 | 读法 |
|---|---|
| **版本号变了** | `teamkit version` ⇒ **`0.1.2`** 是本版 |
| **新文件在了** | 安装目录下 `lib/crash-guard.js`（**0.1.1 起**） |
| **新命令可用** | `teamkit init` 有输出（**0.1.1 起**）· 且它**实时查 GitHub**（**0.1.2 起**，不再写死） |
| **预设提示词带"不空等"** | `presets/omc/agent.cordis.yml` 里搜 `Do not idle-wait`（**0.1.2 新增**） |
| **自测三态** | `node <安装位置>/bin/teamkit.mjs selftest` ⇒ `PASS` 或 `UNVERIFIED`（**不许 FAIL**） |

> ★ **若 `version` 还是旧号** ⇒ 第 ② 步没真装上新包（多半是路径或 pnpm 那条坑）。

## ⚠️ 已知问题（**如实记，不藏**）

### 1. `v0.1.0 – v0.1.2` 的 `bin/teamkit.mjs` 含 2 处**本机用户名**（`0.1.3` 起已脱敏）

```
那两处逐字是 `C:\Users\<用户名>\...`（注释里的**本机实测路径**，不是凭据）：
  · 一处记的是 SOUL 落点（"与真 Lead 落点逐字相同"）
  · 一处记的是本机 `pnpm` 的绝对路径
⇒ ★ **它们在 `v0.1.0`–`v0.1.2` 的公开仓历史里**（`git clone` 过的人会看到）。
  **`v0.1.3` 起已改成占位符**（`<用户目录>` / `<npm 全局目录>`）。
⇒ ⚠️ **没有改写历史**（force-push）—— 那是**机器名，不是凭据**，
  而改写历史的代价（已 clone / 缓存 / fork 收不回）不成比例。
⇒ ★ **若你在意 ⇒ 更新到 `0.1.3` 即可**（[见上面"更新"一节](#更新已经装过的人怎么拿到新版)）。
```
> ★ **为什么写在这里**：**"已经泄露"是一个事实，把它藏起来才是第二个错。**
> 这也与本插件执行的纪律一致（`RULES.yml` `R5`：**结论与解释都不许超出读数能支撑的范围**）。

## 维护

### ★★ 发布：**唯一入口是 `release-push`**（**不许直接跑 push 脚本**）

> **为什么强制**：**"推了" 与 "验了" 是两件事** ——
> 现场：我们推完 `crash-guard.js`，公开仓只拿到一个**残版**，**而没人发现**（直到对手方复核）。
> ⇒ 所以 `push-all-via-api.mjs` / `push-big-file-via-api.mjs` **没有 `DSH_RELEASE_PUSH=1` 就拒绝运行**。

```bash
# ★ 唯一入口：推 + **自动回读**（一条命令）
node tools/release-push.mjs --repo=teamkit --message="改了什么"
node tools/release-push.mjs --repo=company --files=BUILD.md --message="改了什么"

# 它做三件：
#   ① 转发器内推 → 停（443 释放）
#   ② 转发器内跑 release-verify（R1–R7 逐条读）
#   ③ ★ R5（443 = 0）由它【在转发器之外】测 —— 这是唯一能测它的位置
#      （release-verify 自己必须跑在转发器内 ⇒ 它**不可能**自测 R5）
# 读数落盘：仓根 RELEASE-READINGS.md
```

**`release-verify` 的七条判据**（`--slug=<o/r> --local=<本地目录>`）：

| 判据 | 它核什么 |
|---|---|
| **R1** | trees 可读（未认证 API）· blob 总数 |
| **R2** | 禁目录 = 0（`runs/` `notes/` `.git` `node_modules` …） |
| **R3** | PII 逐文件取（**落盘**，非管道）+ ★ **版本自证**（比 git blob sha —— `raw` 有 CDN 缓存，会骗人） |
| **R4** | 本地 ↔ 远端逐字节（**双向**：远端多出来的也会列出来，别把"全一致"读成"全对上了"） |
| **R5** | 443 = 0（**只能**由 `release-push` 在转发器之外测） |
| **R6** | ★ **三方一致**（工作区 / `git HEAD` / 远端）—— 抓"HEAD 漂移" |
| **R7** | ★ **公开仓历史**扫描（`--history`，**很贵**，默认不开）—— 抓"HEAD 干净但历史里留着" |

> ★★ **另外三条不在这张表里、但同样由发布流程跑**（它们**要网络** ⇒ 不进 `check-all` 的常规快跑）：
> · **`check-push-drift.mjs`** —— ★ **专抓"提交了但没推"**
>   （`B25`/`B28` 两次都是这个形态：本地改完 → `git commit` → ★ **忘了 `release-push`** ⇒ 用户拿到旧版）
>   ⇒ **提交后顺手跑一次就知道**（不必等到发布）：
>   `node tools/check-push-drift.mjs --slug=yjh051108/dsh-teamkit --local=plugin`
> · **`check-remote-blob.mjs`** —— 用**认证 API** 逐个核 blob sha（不烧未认证的 60/h 配额）
> · **`verify-history-three-state.mjs`** —— **离线**自检 R7 的三态口径（不需要网络）

> ⚠️ **核"推没推上去"只许用 API 的 trees / `blob` 本体 / git blob sha** ——
> **`raw.githubusercontent.com` 一律不可信**（它今晚骗过我们三次：截断 · CDN 旧 · CDN 新）。
> ⚠️ **逃生口**：`DSH_ALLOW_RAW_PUSH=1`（应急用，**显式越权**，**没有自动回读**）。

### 单一事实来源（7 条方法技能）

**技能的维护入口只有一个：仓内 `../skills/`。** 本包 `skills/` 是它的**打包副本**，
**只许由脚本生成，不许手改**：

```bash
node scripts/sync-skills.mjs           # 同步（源 → 包）
node scripts/sync-skills.mjs --check   # 只检查漂移（CI 用；漂移 ⇒ 退出码 1，读不到 ⇒ 2）
```

`selftest` 的 H 组会**逐字节比对**两边并断言一致 —— 漂移就是 FAIL。

### 改这个包

| 想改什么 | 改哪里 |
|---|---|
| 路径/默认值/配置项 | `lib/config.js`（**唯一的路径事实来源**；别在别处再写一遍） |
| 技能条读写 | `lib/skills.js`（frontmatter / 发现 / 无 BOM 写入） |
| fork provider | `lib/fork.js`（**只读 fork 目录，绝不复制上游**） |
| 通知 | `lib/notify.js`（**pending 补推的判定顺序不可换**） |
| 上游合并/回退 | `lib/upstream.js`（**源 = `upstream.sources`，不是 `skills.sourceDir`**） |
| 护栏 | `lib/guard.js`（诚实口径写在文件头，别改口径） |
| 插件挂载点 | `lib/index.js` |
| 命令 | `bin/teamkit.mjs` |

**四条不许破的纪律**（都有实测来源）：

1. **零裸 import**：运行时注入的插件目录**没有 `node_modules`** —— 任何 `import 'x'` 都会让插件加载失败。
   本包**只用 `node:` 内置模块**，`Config` 校验也是自己实现的 `~standard` 形状（不依赖 `schemastery`）。
2. **fork 绝不"复制全量上游"**：一旦复制，未改的条变成静态副本，**"上游更新自动下发"立刻失效**。
3. **写 `SKILL.md` 必须无 BOM**：PS 5.1 的 `Set-Content -Encoding UTF8` 会带 BOM
   ⇒ frontmatter 解析失败 ⇒ **整条技能静默消失**（不报错、不崩溃）。本包只走 `node:fs` 并在写后**回读校验首字节**。
4. **pending 补推必须放在"没变更就早退"之前**：放后面会让 `lastDigest` 已前进 ⇒ pending 永不被消费
   ⇒ **复现"永久丢通知"**。

---

## 限制（**开源必读 —— 装了才发现最难受**）

### 0. ★★ 本插件给宿主进程装了一层「**仅针对管道断开**」的保命网

> **背景（实测事故，2026-09-15）**：桌面壳用 **pipe** 抓 dsh 子进程的 stdout/stderr
> （`D:\dsh\desktop\main.js:169` 的 `spawn(...)` **不给 `stdio`** ⇒ Node 默认 `'pipe'`），
> 而**壳只给它自己装了防护**（`:17 for (const s of [process.stdout, process.stderr]) s.on('error', () => {})`），
> **没有保护它 spawn 出去的 dsh 子进程** ⇒ 管道被关后，子进程下一次 write 抛**未捕获 `'error'`** ⇒
> **进程自杀**（`Error: write EOF` / `Emitted 'error' event on Socket instance` / `errno -4095, code 'EOF'`）。
> **实测 5 起**（`09-12×2` · `09-14×1` · `09-15×2`）。
>
> **本插件做什么**（**两层**）：
> ```
> 【第 1 层】给 `process.stdout` / `process.stderr` 装 `'error'` 监听，
>   只吞管道断开那一族（`code === 'EOF' | 'EPIPE'`，或 `errno === -4095` 且栈含 `Socket`/`WriteWrap`）。
>   **别的 error 一律重新抛** ⇒ 不掩盖任何别的错误（普通 bug 照样崩）。
> 【第 2 层】★ **进程级兜底**（2026-09-16 追加）—— `process.on('uncaughtException')`，
>   但★**只兜同一族**（`isPipeBroken`）；★ 并且**必须记一条日志**
>   `UNCAUGHT-PIPE-EOF-SWALLOWED`（不许"吞了没人知道"）。
>   ⚠️ **非管道异常 ⇒ 显式复现 Node 默认行为**（打栈 + `process.exit(1)`）⇒ **不掩盖我们自己的 bug**。
> ```
> **为什么加第 2 层**（实测事故，2026-09-16）：装了第 1 层 **2.5 小时之后宿主照样崩**，
> 而日志里**"吞掉"命中 = 0** ⇒ ★ 证明**崩的不是 stdout/stderr** ——
> 是 `dsh-host-webserver/lib/index.js:260-269` 的 **upgrade socket**：
> `:265 socket.on("error", onError)` · **`:267 socket.off("error", onError)`（`close` 时撤监听）**
> ⇒ close 之后该 socket 上**没有任何 error 监听** ⇒ 之后的写 ⇒ **未捕获 EOF ⇒ 进程死**。
> ★ 那个 socket 在**官方包里（= DSH 本体）** ⇒ 我们不能改（硬规矩 1）⇒ **第 2 层是我们唯一够得到它的位置**。
> ⛔ **但【不要】把"补了保命网"当成"装配期也安全了"** ——
> **装配期致命错误**（例：包缺 `dsh.bundle` 却进了 `bundles` ⇒ `loadProfileDirectory` 抛）
> 发生在**插件自己的 `ctx.effect` 之前** ⇒ 那时**这两层网都还没装上** ⇒ **兜不了**。
> 装配期的问题看 [`INSTALL-PITFALLS.md`](https://github.com/yjh051108/dsh-company/blob/master/INSTALL-PITFALLS.md)。
> ★ **可卸**：卸载插件后两个监听器计数都回到原值（`stdout.listenerCount('error')` + `process.listenerCount('uncaughtException')`）。
> 关掉它的开关：配置 `crashGuard.enabled = false`。
>
> **边界（诚实口径）**：
> · 它**只治症状**（宿主不因管道断开而自杀）；**第 1 层的根因在桌面壳那一侧**（给 `spawn` 传 `stdio` 或先 detach 再关读端）——
>   **那是 `D:\dsh\desktop`，不是本仓**，我们**不越界去改**，只上报。
> · **第 2 层的根因在 `dsh-host-webserver`（官方包）** ⇒ 同样**只上报，不改**。
> · 我的复现**产出的是 `EPIPE: broken pipe, write`**，而现场是 **`write EOF`** ——
>   两者是**同一族**（往已断的管道写），Node 在不同时机给不同 errno ⇒ 判据按**族**判。
> · 能红证据（**三条，都要自己跑，别抄数**）：
>   · `tools/crash-guard-test.mjs` —— 第 1 层（装/不装 · 管道断/`TypeError` · 计数 · 非管道 `EBADF` 照旧抛）
>   · `tools/crash-guard-uncaught-test.mjs` —— ★ **第 2 层双向**（见下）
> · ★★ **第 2 层的双向判据**（缺一不可）：
>   ① 造**别处 socket** 的 `write EOF`（**模拟 webserver 那个 socket**，不是 stdout）⇒ **进程不死** + 日志一条
>   ①-b **不装网** ⇒ **照旧崩**（证明是网在起作用）
>   ② ★★ 造普通 `TypeError` ⇒ **照旧崩 exit=1** + **栈打出来** ← **这才是"没有掩盖错误"**
>   ③ 卸网 ⇒ `uncaughtException` 计数回 0

### 1. 成员**只增不删**（底座限制，不是本插件的选择）

> **快照时间**：本节事实的读取时间是 **2026-09-13 03:15 (Asia/Shanghai)**，来源是
> `$DSH_HOME/profiles/web/node_modules/@deepseek-ai/dsh-experimental-agent-team/` 下的**已安装**包。
> **凡是"本部署现状"的结论都必须带快照时间与复核命令** —— 底座升级后请重跑这条（本机实测输出见下）：
> ```bash
> node -e "const r=require('fs').readFileSync(process.env.DSH_HOME+'/profiles/web/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.d.ts','utf8');console.log('有移除方法吗？',/remove|delete|retire|fire/i.test(r));console.log('方法：',(r.match(/^\s{4}(\w+)\s*\(/gm)||[]).map(s=>s.trim().replace('(','')).join(' '))"
> # 实测输出：
> #   有移除方法吗？ false
> #   方法： constructor membership tryMembership list spawn pendingCreations recoverFor interrupt liveChildrenByRoot stopTeammates
> #（去掉构造器 = 9 个公开方法，与 P-34 的"只有 9 个"一致）
> ```
> ✅ **【已解决 · 2026-09-14】"能不能删人"这条已经落实**（**早期是"待探究"，现在是可以**）：
> **成员名额可以释放**（`memberRelease` **默认开**，见配置表）——
> 早期底座**没有任何移除方法**（`roster` 9 个公开方法里没有 remove/delete/fire），
> 本插件用**包装 `journal.state`** 实现了；⚠️ **但"名字仍不可复用"**（底座限制，`invariant.js:353` 拒写）。
> ★ **这段留在这里是有意的**：**从"底座根本不能删"到"插件层可以释放名额"，本身就是本插件的一项成果**
> （不是"还没做的计划"）。若你在别的文档里看到"此项待探究"的说法，**那是过期表述，以本节为准**。
>
> ✅ **【2026-09-14 Lead 复核结论】那条实验成立，而且我独立复核了它的两条承重链** —— 下面是**结论**，
> 细节与原始读数见 `runs/005-role-skills/MEMBER-RELEASE.md`：
> * **能"释放名额"（＝你要的"能删"）**：做法是**在我们的 fiber 里包一层 `ctx.agentTeams.journal.state`**，
>   让它返回的 `members` 过滤掉"已释放"的 id。
>   为什么它**真能释放名额**（不是只改视图）：`roster` 与 `journal` 是**同一个实例** ——
>   `this.roster = new TeamRoster(ctx, this.journal, …)`（`dsh-experimental-agent-team/lib/types/index.js:107`，
>   打包副本 `lib/index.js:1693`）⇒ **roster 的重名/名额检查也走被包的那一层**。
>   **成立的三件**：① 名单不再列出；② 名额**真**释放（不是只过滤视图：过滤后 `spawn` 能写入）；
>   ③ 被释放者**无法再寻址**（发给它 = `TEAM_MEMBER_NOT_FOUND`）。
> * **不能"抹掉"（也不该做）**：`applyCurrentTeamEvent` **只有 4 个分支**
>   （`team/member` / `team/task` / `team/message/queued` / `team/message/delivered`），
>   **没有任何移除分支**（`types/projection.js:175-233`；`state.members.push` 在 `:198`）
>   ⇒ **日志是 event-sourced，抹掉等于伪造历史**。**名字不可复用**同样不成立
>   （写入时被拒 —— ⚠️ **具体位置是 `types/roster.js:243-244`**
>    （`state.members.some(m => m.name === name)` ⇒ `throw … 'TEAM_MEMBER_NAME_TAKEN'`）。
>    **2026-09-14 / Round 79 更正**：本条原先写的是 `invariant.js:353` —— **那是错的**：
>    那个位置是 `session/event` 的**总钩子**（`invariant.js:349-356`，拿 state 跑投影校验），
>    **不专门管名字唯一性**；`types/invariant.js` 里也**没有** unique/duplicate 相关校验。
>    ⇒ 引用来源要指到**真正抛错的那一行**，否则读者按图索骥会**找到一段无关代码**（R42 同族：看错落点）。）
>   ⇒ 所以本插件的承诺应当是「**释放名额 + 视图干净 + 不可寻址**」，
>     **不承诺**「名字可复用 / 日志里没有它」。
> * ✅ **【2026-09-14 / Round 33 已实现】这条能力现在就在插件里** —— `plugin/lib/release.js`。
>   **怎么开**（默认**关**，因为这是破坏性动作）：
>   ```jsonc
>   { "memberRelease": { "enabled": true, "requireReason": true } }
>   ```
>   **它做了什么**：包一层 `TeamJournal.prototype.state`，让返回的 `members` 过滤掉"已释放"的人。
>   **为什么能真释放名额**：`roster` 与 `journal` **是同一个实例**
>   （`this.roster = new TeamRoster(ctx, this.journal, …)`，`dsh-experimental-agent-team/lib/types/index.js:107`）
>   ⇒ roster 的重名/名额检查**也走被包的那层**。
>   **真宿主读数**（从当前进程包装真 `TeamJournal`、过滤一个真实成员）：
>   ```
>   加工前: [judge-paper, judge-model]   2 人
>   包装后: [judge-model]                1 人   ← 被释放者真从 Team 状态消失
>   membership(被释放者) → "is not a member of an active Agent Team"  ← 不可再寻址
>   还原后: 2 人回来了                        ← 卸载即净
>   ```
>   **判据**：离线 `selftest` 的 **`R` 组**（**自己跑，别抄数** —— 条数每轮都在加；
>   它至少覆盖：过滤生效 / **不动底座数据源** / 还原干净 / **台账重放** / 无理由拒绝 / `unrelease` 幂等 / 失败给 `why`
>   / **跨 Team 隔离** / 多实例登记簿 / 原型方法干净还原）。
>   **⚠️ 三条必须知道的约束**：
>   1. **名字仍不可复用** ⇒ 释放后招人**只能换新名**；
>   2. **重启后靠台账重建**（`journal.state` 的包装在内存里）⇒ 释放记录写进
>      `<stateDir>/member-release.jsonl`，下次 apply 时重放；
>   3. **依赖 TS `private` 属性 `journal`**（编译期私有、运行时可达）⇒ 底座改名即失效；
>      失效时**不静默**（会打 `RELEASE-NOT-READY` + `why`）。
>   **无理由不释放**（`requireReason`，拒绝时 `code=2`，与 `promote` 的"说明是硬门"同口径）。
>   本节上方那段"底座本身没有移除方法"**依然成立** —— 我们做的是**插件层绕过**，不是底座新增了方法。

我们已经用代码逐处核实过（行号见下）。**原文如下，请原样相信**：

- **roster 没有任何移除方法** —— 公开方法只有 9 个（`membership` / `tryMembership` / `list` / `spawn` /
  `pendingCreations` / `recoverFor` / `interrupt` / `liveChildrenByRoot` / `stopTeammates`），
  **没有 `remove` / `delete` / `retire` / `fire`**（`types/roster.d.ts:47-97`）；
- **journal 没有成员移除事件** —— 只有 4 种：`team/member` / `team/task` / `team/message/queued` /
  `team/message/delivered`（`types/journal.d.ts:6`、`types/projection.d.ts:30`）；
- **`stopTeammates` 只停会话，不释放名额**（`types/roster.js:218-219` → `drainContinuableChildren`）；
- **`phase='failed'` 的成员照样占名额、照样占名字**（重名检查 `types/roster.js:243` **无 phase 过滤**；
  名额按 `state.members.length` 算，`:246`），**还会在 `list_agents` 里显示成一个 `failed` 成员**
  （`types/roster.js:115` 遍历全部 members）；
  但它**发消息找不到**（`resolveActiveMember` 只认 `active`，`:22-25`）、
  **连 Team 身份都没了**（`tryMembership` 只认 `active` / `provisioning`，`:73-75`）
  ⇒ **一个"看得见、用不了、删不掉"的僵尸**。

> ⚠️ **路径要带 `types/`**（2026-09-14 / Round 79 修）：`lib/` 下是 `index.js` / `invariant.js` /
> `typert.*.js`，而 **roster / journal / projection / mailbox 这些都在 `lib/types/` 里**。
> 我原先那 8 处引用**只写文件名**（`roster.js:243`）⇒ **读者去 `lib/roster.js` grep 会找不到文件**。
> ⇒ 每条引用都补上 `types/`（**行号本身当时是对的，错的只是目录**）。


⇒ **"招错一个人" = 永久少一个名额。**
**唯一"重开一局"的办法**：**新开一个 Lead 会话**（名额是 per Team root，`types/journal.js:20-21`），
代价是旧 Team 的任务/消息在新 root 看不到。

**我们提供的缓解（不提供"移除/退休"功能，因为底座不允许）**：

1. **默认 `maxMembers` 给足 —— 但我们不替你决定**：本包**不**在 `cordis.patch.yml` 里改
   `agent-team` 的配置（那是**改别的插件** = 隐藏耦合，而且"名额给多少"是**你的成本决策**）。
   `patches/lenient-max-members.yml` 是一份**可选的**补丁片段（五个 config 键写全 + 三条警告 + 粘法），
   **要你自己粘进 profile 的用户补丁层** —— 为什么不做成默认，那个文件头部逐条写了；
2. **可回滚的 fork** —— 成员改坏了只影响它自己，回退 = 删掉它 fork 里那一条；
3. **可审计的招募** —— 日志里每次 `FORK-REGISTER-OK` / `SKILLS-SYNC` / `FORK-SKIP` 都有行；
4. **`teamkit doctor` / `teamkit status`** 让你装之前就能看到会发生什么。

⇒ **一句话**：**不要招错**（先 `plan` 再招）+ **重开一局**（新 Lead 会话）。

### 2. ★ A2A 的**真实边界**（**我们实测过**，不是推断）

> **§2 的存在性判据**：`H49` 会 grep README 里有没有这一节（缺 ⇒ 报红）——
> 因为"我们有真读数却不在 README 里写"，等于把诚实留给自己、把坑留给用户。

**哪些方向真通**（`runs/005-role-skills/A2A-BOUNDARY.md`，7 条**真调**，非读源码）：

| 方向 | 结果 | 原始返回（节选） |
|---|---|---|
| 执行者 → **上级** | ✅ 通 | `{"messageId":"…","status":"accepted"}` |
| 执行者 → **同事** | ✅ 通 | 同上（**同级可直达，不必经上级**） |
| 执行者 → **Lead** | ✅ 通 | 同上（**可越级上报**） |
| 读板 / 建板 | ✅ 通 | `team_task_list` 有内容+分页；`team_task_create` 能建 |
| 执行者 → **向下招人** | 🚫 **被硬拦** | `Error: only the Team Lead can create teammates`（`.../agent-team/lib/index.js:546`） |
| 改**别人拥有**的任务 | 🚫 **被硬拦** | `Error: task mutation requires its owner or Team Lead`（`.../types/task-board.js:109`） |

⇒ **一句话**：**横向与向上真通；向下的"招人"与"改别人的任务"只有 Lead 有。**
⚠️ **你会撞到的地方**：**manager 角色的成员"能派活、不能扩编"** ——
它可以用 `team_task_create` / `send_message`，**但招人只有 Lead 能做**（`spawn_teammate` 对 teammate 报 `TEAM_LEAD_REQUIRED`）。
⇒ **这是能力，不是缺陷**（权限边界清楚）；但**不写出来 = 用户会以为是 bug**。

### 3. A 层护栏**不是安全边界**（诚实口径）

`guard` 是**误操作护栏**，且**默认关闭**。它：
- **只覆盖 `write` / `edit` 两个工具名**；
- **`pwsh` 绕得过、实测零审计**（`Set-Content` / `node -e` / 任何外部进程都不经过它）；
- 出错时 **fail-open**（不拦）—— 宁可漏一次手滑，也不许把自己锁死在"什么都写不了"。

委托方的口径是「**他能不能改无所谓……他都不知道可以改，那他改啥呢？**」
⇒ 控制点在**认知**（他改的是**哪一份**），不在文件系统。
**本插件不做什么**：不设硬门、不做拦截、不做重装防护、不做披露面穷举、不做威胁模型。
**依据**：`plugin/lib/guard.js:209`（`coverTools: ['write','edit']`）/ `:210`（`bypassableBy` 自陈含 `pwsh`）/
`:170` 的 `guard.enabled` 默认值；原始判决见 `runs/005-role-skills/DECISIONS.md` P-15/P-16。

### 4. 通知的**送达不保证**（投递形态的固有代价）

通知是**搭车**形态：在**该成员本来就要走的那一步**里追加一条 message
⇒ 边际成本 = 一条消息的字节数（实测 669–2735 B），**不额外触发任何轮次**。
**代价**：一个**做完活就 idle** 的成员**永远收不到**通知。
要"保证送达"就得上**唤醒**形态，代价是**一整步**（约 8.8 KB system prompt + 技能目录 + 139 个工具表 + 它那一轮）。
本包选**搭车**（成本差一个量级），并把这条缺口写在这里 —— **不藏**。
**依据**：字节数读数见 `runs/005-role-skills/DECISIONS.md:516`；"投递只能由 Lead 做"的定案见
`runs/005-role-skills/UNVERIFIED-LEDGER.md` §③（`assertAdmitting` + `holdOwnership` 要求调用者是直接父）。

### 5. `rollback` 只能退**一步**

`rollback` 取的是"最近一次 promote 之前那一版"。连续 promote 两次，只能退最近一步。
快照**不会自动清理**（长期会累积）。要更完整的版本史，用真 git 管你的技能仓
（已实测：在技能根里建 `.git` **零副作用** —— `.git` 不进技能目录、5 个 git 操作 0 次重扫）。
**依据**：实现见 `plugin/lib/upstream.js:258`（`rollback`）与 `:266`（取 `snaps` 最后一版 ⇒ **只退一步**）；
"`.git` 零副作用"的实测读数见 `runs/005-role-skills/DECISIONS.md:523`。

### 6. 上游**删一条** = 对全员生效

fork 里**没改**该条的成员会**立刻也失去它**（overlay 的必然结果）。改过该条的成员保住自己那份。
⇒ **删上游条目比改上游条目危险得多。**
**依据**：overlay 语义（*nearest layer wins outright*）的实测读数见
`runs/005-role-skills/TWO-CHANNEL-DELIVERY.md`（A-3）；裁决见 `DECISIONS.md:273` / `:288`。

### 7. `promote` 的"每次都有说明"有粒度限制

察觉上游变是按步轮询 `sha1`。**一个步内连改多次会被折叠成最后一次**。
**依据**：裁决与代价分析见 `runs/005-role-skills/DECISIONS.md:526` / `:534`（P-32）；
`promote` 的四步（快照→合并→记 CHANGELOG→复核）见 `tools/promote-upstream.mjs:1`（文件头逐条说明）。

### 8. **组织资产装在 `$DSH_HOME` ⇒ 成员用 `write` 写不了它**（沙箱）

**角色的 SOUL / 工作原则 / 角色技能**都装在 `$DSH_HOME`（**agent 工作区之外**）。
成员跑在 `workspace-write` 沙箱里 ⇒ 它用内置 `write` 工具会**被拒**（实测逐字错误）：
```
Error: [sandbox: file access denied under workspace-write mode]
       [sandbox: escalation available — … the approval prompt asks the user]
```
⇒ **能读（插件注入到上下文），但不能用 `write` 写回去。**
**这是本插件提供 `read_self` / `write_self` 的全部理由**（**宿主侧代读代写**，绕开 agent 沙箱）。
⚠️ **要靠 `write_soul` 那条路**，别指望成员自己 `write`；`teamkit-escalate` 的「S2 怎么真写下去」有照做步骤。

### 9. `fork-init` **只作用于「全局」fork 根**（离线路径没有 agent）

`fork-init` 是**离线 CLI**：没有 agent ⇒ 拿不到 `session.header.cwd` ⇒ **无法按项目分**。
如果你给某个成员的 fork 播种，而那个成员属于**某个具体项目**，那粒种子会落在
**全局** fork 根（`$DSH_HOME/.teamkit/forks/<member>/skills`），**而它实际读的是 `<它的 cwd>/.teamkit/...`**
⇒ **对不上**。运行时它会打一行 `FORK-SEED-GLOBAL` 明说这件事（**不是报错，是有意为之**）。
**依据**：可见信号实现见 `plugin/lib/fork.js:201` / `:214`（`FORK-SEED-GLOBAL` 那一行）；
离线路径拿不到 agent ⇒ 拿不到 `session.header.cwd`（同文件注释与 `plugin/lib/config.js` 的 `agentCwdOf`）。
> **在项目里要播种**：直接用文件工具把上游那份 `SKILL.md` 写到该成员**实际的** fork 目录
> （路径见通知里的"你那一份"，或日志里的 `FORK-REGISTER-OK … dir=`）。
`promote` 本身没有这个问题（说明挂在"写"上），但如果你**绕过 `promote` 直接手改上游**，就会有。

---

## 目录结构

```
plugin/
  package.json                 # dsh.bundle.patch + peerDeps（只声明范围）+ files 白名单 + 零 dependencies
  cordis.patch.yml             # bundle 层：插入一条插件行
  README.md                    # 本文件
  LICENSE                      # BSD-3-Clause 全文（`license` 字段声明的正文）
  bin/teamkit.mjs              # CLI（selftest / status / list / promote / rollback / doctor / fork-init / preset-new / help）
  lib/
    config.js                  # ★ 唯一的路径事实来源 + 配置 schema（零依赖的 ~standard 形状）
    preset-gen.js              # ★ 预设生成器**内核**（纯函数：模板+参数 → 完整文件；拒绝规则都在这里）
    skills.js                  # 技能条读写原语（frontmatter / 发现 / 无 BOM 写入 / **我们装的旧版自动更新**）
    fork.js                    # fork provider（agent-scoped，只存差异）
    notify.js                  # 上游更新通知（含 pending 补流 + 四项说明 + 五项动作）
    upstream.js                # 上游合并 / 回退 / 清单（说明是硬门）
    guard.js                   # A 层误操作护栏（默认关，诚实口径）
    log.js                     # 可观察信号（行式日志 + 三态判定 + 写后回读）
    roles.js                   # ★ 岗位档案：读角色档 + 渲染**岗位人格段** + 读工作原则
    release.js                 # ★ 成员释放：包 `journal.state` 过滤已释放者（**名额真释放**）
    release-tools.js           # ★ 运行时工具：list_zombies / release_member / unrelease_member / read_self / write_self
    soul.js                    # ★ SOUL：每步注入自己的承诺（`agent/pre-step` → user message，按 sha 去重）
    self-write.js              # ★ 宿主侧代写：`soul` / `principles` / `role-skill` 三个白名单落点
    e2r.js                     # ★ E²R：分解边（`E_tree`）+ 评审判决（`q_v`）落到视图/台账（路径 A 默认关）
    e2r-tools.js               # ★ 运行时工具：set_task_structure / review_task / team_structure
    probe-source.js            # ★ R2 判据本体（`checkProbeSource`）—— **单一事实来源**，离线检与在线拦共用
    probe-gate.js              # ★ R2 在线拦：注册 `ctx.tools.guard()`，装 dev_stage_add 前必过闸（默认开）
    recover.js                 # ★ 重启后恢复（`task-106` B 段）：板重放比对 + goal 只读清单 + 活跃度适配器
    orphans.js                 # ★ 孤儿任务规则本体（`task-107`）：`analyzeOrphans` / `crossCheckLiveness`（纯函数）
    crash-guard.js             # ★★ 保命网：给本进程 stdout/stderr 装"仅管道断开(EOF/EPIPE)"的 error 监听（可卸）
    index.js                   # 插件入口（agent/created + agent/pre-step + ctx.effect）
  tools/
    install-teamkit.mjs        # ★ 用户侧安装器：skills / talents / roles / 组织层文件 / preset（幂等、可卸净）
  scripts/
    sync-skills.mjs            # 仓内 skills/ → 包内 skills/（含 --check 漂移检测）
    sync-assets.mjs            # 仓内 talents/ roles/ presets/ → 包内 assets/（含 --check）
    e2e-tarball.mjs            # 交付形态端到端：npm pack → npm install → 安装器 → 落点 + **功能断言**
    probe-real-registry.mjs    # 真 dsh-skill 注册表探针（独立进程，只读）
    preset-new.mjs             # ★ `teamkit preset-new` 的实现体（薄壳：解析参数 → 落盘 → 回读自证）
    gen-roles.mjs              # ★ `talents/*.md` → `roles/*.json` 的**单向生成器**（权威源是 talents/）
    check-preset-overlap.mjs   # ★ "三件套不许重叠"四条机械判据 + `--self-test`（证明判据能红）
    check-orphans-rule.mjs     # ★ 孤儿巡检规则的能红断言（含**变异测试**：把规则改坏 ⇒ 必须当场报红）
    verify-templates.mjs       # ★ 两个模板形态的端到端验证（fakeHome 真装 + 真 discovery + 真 mountPreset）
  patches/
    lenient-max-members.yml    # **可选**：给开源用户的"招错不心疼"档（要自己粘，默认不生效）
  assets/                      # 打包副本（由 sync-assets.mjs 生成，别手改）
    presets/omc/               #   `omc` 预设（agent.cordis.yml + preset.yml）
    presets/_templates/        #   ★ 预设模板：lite（轻量小队）/ full（全公司）—— **`.tmpl` 后缀 ⇒ 不会被当预设装**
    roles/                     #   8 份角色档 + 每角色的技能
    talents/                   #   8 份 Talent + `_SPEC.md` + `principles/`
    org/                       #   TALENTS.yml（Market 索引）+ RULES.yml（治理）
  skills/                      # 打包副本（由 sync-skills.mjs 生成，别手改）
```
> ⚠️ **这份树由断言盯着**（`selftest` 的 `H26`）：`lib/` 与 `scripts/` 里**每个文件**都要在这里出现。
> （2026-09-14 / Round 67 实测：它此前**漏了 6 个 lib、2 个 scripts、整个 `tools/` 与 `assets/`** ——
> 因为每加一个模块都没回头更新它。）

## 许可

BSD-3-Clause（与生态内其它 `@dsh-external/*` 包一致）。
