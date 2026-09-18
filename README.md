# dsh-omc —— 一家 AI 公司，一个仓

> **一句话**：**装它，你就有一家公司** —— 公司层（角色档 / 技能 / 组织层 / 指南）+ 看得见的侧边栏「办公室」+ 怎么开公司的方法论。

---

## 〇 · 这个仓是什么（**与别的仓的关系 · 先读这段**）

```
★★ **本仓（`dsh-omc`）= 【OMC 公司套件】** —— 只有三样：
   · `packages/teamkit`    —— **公司层本体**（角色档 / 技能 / 组织层 / 指南）
   · `packages/org-panel`  —— **看得见公司**（侧边栏「办公室」）
   · `docs/company/`       —— **怎么开公司**（方法论 · 先读 `INDEX.md`）
⇒ ★ 一个仓，因为**它们是【一个产品】**。
⇒ ★★ **而"装"与"属于"是两件事** —— `install.sh` 内部还会装【两个依赖】，
   而**它们不在本仓**（**各有自己的仓**）：
   · **`dsh-super-injector`**（运行时注入器 —— **服务所有插件**，不只公司）
   · **`dsh-engram-relay`**（记忆图谱 —— **通用记忆层**）
   ⇒ ★ 它们**不属于 OMC**（委托方 2026-09-18 定向：
     「**我没让你把仓库合并，我让你做的是把【公司相关的】合并 omc**」）
     ⇒ 而**用户仍只敲一条命令**（本脚本内部把它们一并装）✅
   ⇒ 类比：`npm install express` 时，express 的源码不在你的仓里，**但你只敲了 `npm install`**。
```

---

## 一 · 这是什么（**第一段就说清**）

```
· **公司层**（`packages/teamkit`）—— 角色档 · 方法技能 · 组织层（`RULES.yml` / `TALENTS.yml`）· 建造指南
· **看得见**（`packages/org-panel`）—— 侧边栏里的"办公室"：谁在工位、谁在开会
· **要读的文档**（`docs/company/`）—— 为什么这么设计 · 怎么开 · 怎么运营 · 怎么复盘 · 判据全集
```
**⇒ 一个仓，因为它们是【一个产品】**（**不是一堆零件**）。

> ★ **其余那几件也在各自的仓里**（**它们不属于 OMC**）：
> · `model-fit` + `symbiote` ⇒ **[`dsh-model-optimum`](https://github.com/yjh051108/dsh-model-optimum)**
>   （**"模型单步执行最优"那一套**）
> · `tool-output-guard` · `issue-watch` · `web-tools` ⇒ **各自独立的仓**
> ⇒ ★ 而**注入器与记忆层**是**依赖** ⇒ 由 `install.sh` 自动装（见 §〇）。

---

## 二 · 怎么装（**一条命令**）

```bash
git clone https://github.com/yjh051108/dsh-omc
cd dsh-omc
./install.sh          # Windows: .\install.ps1
```

它内部做的事（**你只敲上面那一条流程**）：
```
[0/5] 环境预检（node / dsh 在不在）
[1/5] 逐包装配本仓 packages/ 下的公司包（**2 个**：teamkit · org-panel · 幂等可重跑）
[2/5] 两个依赖（super-injector · engram-relay）—— **拿不到会明说"缺哪个能力"**（不静默跳过）
[3/5] ★ 自检：**装到 profile 里的**注入器含 R1–R7 兜底吗（**#1 痛点的机械判据**）
[4/5] 公司层资产 → $DSH_HOME/teamkit（角色档 / 技能 / 组织层 / 指南）
[5/5] 汇总：**装了 N 个 · 跳过 · 失败 · 下一步**（一张表）
```
**可选参数**：`PROFILE=myco ./install.sh`（装到别的 profile）· `DRY_RUN=1 ./install.sh`（只看不装）·
`SKIP_DEPS=1 ./install.sh`（只装本仓 · 不装两个依赖）

> ⚠️ **装多个包不等于要多敲命令** —— 用户的负担是"敲几条"，不是"装几个"。

---

## 三 · 装完要做什么（**两条 · 别漏**）

```
① ★ 新开一个会话 ⇒ 预设选 `omc`（**已经开着的会话看不到新预设**）
② ★★ **若你装了侧边栏面板（`org-panel`）⇒ 请【刷新页面】**
   ⇒ 它是 `dsh.client` 客户端插件 ⇒ **不刷新 ⇒ 侧边栏不会有"办公室"**（体感是"装了没反应"）
```
想看"公司还差什么"：在新会话里说 **`teamkit init`**（它会**实时查**、**逐条报"拿到/拿不到 + 为什么"**）。

---

## 四 · 装不上怎么办（**三档 · 按症状对号**）

### 档 1：`dsh plugin add` 报 `'pnpm' is not recognized`
```
⇒ 根因：`dsh plugin` 把参数**转发给 profile 目录下的 pnpm** ⇒ **pnpm 是硬前置**
⇒ 修：先装 pnpm（`npm i -g pnpm`）· 或确认它在 PATH 上
```
### 档 2：某个包装上了，但"没反应"
```
⇒ ★★ **先看它有没有 `dsh.bundle` 声明**：
   · **本仓两个都有**（`teamkit` · `org-panel`）⇒ **官方装配路径有效**，装上就生效
   · ★★ **两个依赖也有**（`super-injector` · `engram-relay`）⇒ 同上
   · ★★ **有 `dsh.client` 的（`org-panel` · `super-injector` · `engram-relay`）
     ⇒ 它们是【客户端插件】⇒ 装完必须【刷新页面】**（见 §三②）
```
### 档 3：`packages/<包>/lib/` 不存在
```
⇒ 说明你拿到的是**源码形态**（而正常发布是**带 `lib/` 的**）
⇒ 修：各包 `scripts/build.sh` ⇒ **需要 DSH【源码】检出**：
     `DSH_CHECKOUT=<checkout> bash packages/<包>/scripts/build.sh`
⇒ ⚠️ 若你只有 npm 装的 dsh（**没有源码检出**）⇒ **这条走不通** ⇒
   请改用**该包的 Release 包**（免构建）· 见各包 README 的"取件"节
```

---

## 五 · 目录结构

```
dsh-omc/
  README.md          ← 你正在读的（装什么 · 一条命令 · 装不上怎么办）
  VERSION            ← 版本号（`0.1.0-beta.1` · tag 与 release 标题与它一致）
  LICENSE            ← ★ 根：各包许可证不同 ⇒ 以各包 `package.json` 为准（文件里列了表）
  install.sh         ← 一键安装（Linux/macOS）
  install.ps1        ← 一键安装（Windows）
  packages/          ← ★ **公司包**（本仓只有 2 个）
    teamkit/                公司层本体（角色档 / 技能 / 组织层 / 指南）
    org-panel/              侧边栏"办公室"（`dsh.client` ⇒ **要刷新页面**）
  docs/
    company/         ← ★ **要读的文档**（**先读 `INDEX.md`** —— 有"先读顺序"）
```
> ★★ **为什么 `docs/company/` 不在 `packages/` 里**：**`packages/` 的语义是"要装的包"**，
> 而它是**给人读的 Markdown**（**没有 `package.json`**）⇒ 放进去会误导读的人。
> ⇒ 这正是本项目的"**仓 ≠ 包**"：**同一棵树里，既有"要装的包"，也有"要读的文档"**。
>
> ★ **两个依赖**（`super-injector` · `engram-relay`）**不在本仓** ⇒ 由 `install.sh` 从**它们各自的仓**装。

### 5.1 ★ 每个包里有什么（**源码 + 产物都在**）
```
· `lib/`       —— 编译产物（**clone 即用**，装的时候不需要构建）
· `src/`       —— 源码（**你可以改** —— 「越好维护越好」）
· `LICENSE`    —— 各包自己的许可文件
```
> ⚠️ **没有 `notes/` / `shots/`**（那些是开发过程的内部工作件，**不进开源仓**）。

---

## 六 · 许可证 · 边界

```
· ★ LICENSE：**根放一个说明 + 表**（本仓 2 个包都是 **BSD-3-Clause**）
  ⇒ **以各包 `package.json` 的 `license` 字段为准**（各自 `LICENSE` 文件也在各包里）
  ⇒ ★★ **两个依赖的许可证在它们各自的仓**（`dsh-super-injector` · `dsh-engram-relay`）
· ⛔ 本套装**不改** DSH 本体 —— 只用官方的 `dsh plugin add` 与注入端口
· ⛔ 本套装**不碰**会话日志 / 投影缓存 / profile 私有格式
```

---

## 七 · 这一版（`0.1.0-beta.1`）修了什么

> ★ 详见 [`RELEASE-NOTES`](docs/company/RELEASE-NOTES-v0.1.0-beta.1.md)（**逐条带读数**）：
> · ★★ **宿主崩溃循环**（委托方 #1 痛点）⇒ `unhandledRejection` **常驻兜底**（`self-heal.log` 里 `rejection-shield` **×43**）
> · ★ **`.sh` 的 shebang 被 BOM 弄坏**（**Linux/macOS 完全装不上**）⇒ 已修（第 1 字节 = `#`）
> · ★★ **侧边栏不随会话切换** ⇒ 修 `client.js` + `bridge.js`（`office.js` 一字节未动）
> · ★★ **仓的边界**：**本仓只放"公司相关"**（其余在各自的仓）


