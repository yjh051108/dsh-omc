# dsh-omc —— 一家 AI 公司，一个仓

> **一句话**：**装它，你就有一家公司** —— 公司层（角色档 / 技能 / 组织层 / 指南）+ 看得见的侧边栏 + 运行时注入器 + 自带工具。

---

## 〇 · 这个仓是什么（**与别的仓的关系 · 先读这段**）

```
★ **本仓（`dsh-omc`）是【OMC 套件】的唯一真源**：
  预设 / 侧边栏 / 运行时注入器 / 自带工具 —— **全部在这一个仓里演进**。
  ⇒ 原先散在 8 个仓里的东西，现已合并到这里（**分仓已标"已并入"归档，不删**）
⇒ ⚠️ **两处例外（它们是"依赖"，源码不在本仓）** —— `install.sh` 会自动装上：
  · **`dsh-super-injector`**（运行时注入器）—— 它**同时**是 `dsh-routing-suite/injector`
    ⇒ ★ **那是【另一条独立发布线】**（`dsh-routing-suite` 自己的 README 逐字：
      「三个组件随本仓库统一演进…**上游独立仓库保留用于独立发布**」）
    ⇒ **若两处不一致 ⇒ 以本仓 `packages/super-injector/` 为准**
  · **`dsh-engram-relay`**（记忆图谱）—— 从它的既有仓装
```
> ★ **为什么不把它们也放进来**：**"一个仓" ≠ "一条命令"**。
> 你要的是**敲一条命令装完** —— 而 **`install.sh` 内部装 11 项**（9 个包 + 2 个依赖）。
> ⇒ 类比：`npm install express` 时，express 的源码不在你的仓里，**但你只敲了 `npm install`**。

---

## 一 · 这是什么（**第一段就说清**）

```
· **公司层**（`packages/teamkit`）—— 角色档 · 方法技能 · 组织层（`RULES.yml` / `TALENTS.yml`）· 建造指南
· **看得见**（`packages/org-panel`）—— 侧边栏里的"办公室"：谁在工位、谁在开会
· **运行时注入**（`packages/super-injector`）—— DSH 生态的 BepInEx：运行时注入插件 + 热重载
· **记忆图谱**（`packages/engram-relay`）—— 跨会话记忆（engram）
· **自带工具**（5 个）—— 输出护栏 · issue 监视 · 模型适配 · 网页工具 · 共生体盘档
· **要读的文档**（`docs/company/`）—— 为什么这么设计 · 怎么开 · 怎么运营 · 怎么复盘 · 判据全集
```
**⇒ 一个仓，因为它们是【一个产品】**（不是 8 个零件）。

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
[1/5] 逐包装配 packages/ 下的 9 个插件包（**幂等**，可重跑）
[2/5] 两个依赖（super-injector · engram-relay）—— **拿不到会明说"缺哪个能力"**（不静默跳过）
[3/5] 公司层资产 → $DSH_HOME/teamkit（角色档 / 技能 / 组织层 / 指南）
[4/5] 自检（--check）
[5/5] 汇总：**装了 N 个 · 跳过 · 失败 · 下一步**（一张表）
```
**可选参数**：`PROFILE=myco ./install.sh`（装到别的 profile）· `DRY_RUN=1 ./install.sh`（只看不装）

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
   · **有**（`teamkit` · `org-panel` · `super-injector` · `engram-relay` ·
     `tool-output-guard` · `web-tools`）⇒ **官方装配路径有效**，装上就生效
   · **没有**（`issue-watch` · `model-fit` · `symbiote`）⇒
     ★ **走"装配成 bundle"不会激活**（**不是报错，是不生效**）⇒ 请走**注入**路径：
     `dev_inject_plugin <该包目录>`（需环境里常驻注入器 ⇒ **而 `super-injector` 已随本套装装好**）
   · ★★ **而有 `dsh.client` 的（`org-panel` · `super-injector` · `engram-relay`）
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
  LICENSE            ← ★ 根：各包许可证不同 ⇒ 以各包 `package.json` 为准（文件里列了表）
  install.sh         ← 一键安装（Linux/macOS）
  install.ps1        ← 一键安装（Windows）
  packages/          ← ★ **要装的包**（每个都有 `package.json`）
    teamkit/                公司层本体
    org-panel/              侧边栏"办公室"（`dsh.client` ⇒ **要刷新页面**）
    super-injector/         运行时注入器（dev_* 工具全家桶 + 热重载）
    engram-relay/           记忆图谱（engram · 跨会话记忆）
    tool-output-guard/      工具输出护栏
    issue-watch/            issue 监视
    model-fit/              模型适配
    web-tools/              网页工具
    symbiote/               共生体盘档
  docs/
    company/         ← ★ **要读的文档**（16 份 · **先读 `INDEX.md`** —— 有"先读顺序"）
```
> ★★ **为什么 `docs/company/` 不在 `packages/` 里**：**`packages/` 的语义是"要装的包"**，
> 而它是**给人读的 Markdown**（**没有 `package.json`**）⇒ 放进去会误导读的人。
> ⇒ 这正是本项目的"**仓 ≠ 包**"：**同一棵树里，既有"要装的包"，也有"要读的文档"**。

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
· ★ LICENSE：**根放一个说明 + 表**（因为各包不同：6 个 BSD-3-Clause · `web-tools` 是 Apache-2.0）
  ⇒ **以各包 `package.json` 的 `license` 字段为准**（各自 `LICENSE` 文件也在各包里）
· ⛔ 本套装**不改** DSH 本体 —— 只用官方的 `dsh plugin add` 与注入端口
· ⛔ 本套装**不碰**会话日志 / 投影缓存 / profile 私有格式
```

