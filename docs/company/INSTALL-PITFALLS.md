# 插件装不上的两类死法（**实测现场**）

> **为什么单列一份**：这不是"经验"，是**两族确定性故障** —— 一类让**宿主根本起不来**，
> 另一类让**装了像没装**。两者都**不会给你一句像样的报错**（或只在日志深处），
> 所以**必须靠机械检查**，不能靠"记得核"。
>
> **判据**：`dsh.profile.bundles` 里的**每一个**包，它的 `package.json` **必须**声明 `dsh.bundle`。

---

## A 类 · 缺 `dsh.bundle` 却进了 `bundles` ⇒ ☠️ **致命：宿主起不来**

### 现场（逐字，不是转述）

```
Error: dsh: profile bundle "@dsh-external/dsh-blender-plugin" declares no dsh.bundle in its package.json
    at loadProfileDirectory (…/dsh/lib/…)
⇒ dsh exited code=1
```

**后果链**（实测）：

```
壳自愈重启 → 仍崩 → 连崩 6 次 → 壳报
  `ERROR 连续 6 次启动后即退出，已停止自动重启（防崩溃循环）`
⇒ ★ 用户被迫手动点 `user clicked retry` —— 而"重启"正是用户最痛的那件事
```

### 机制（为什么是**致命**而不是"某个功能不灵"）

```
rc.2 的装配顺序：`loadProfileDirectory()` 在**读 profile 的 bundles 列表时**就校验声明
  ⇒ 声明缺失 ⇒ **抛异常** ⇒ **profile 被拒绝加载**
⇒ 而这一步在**插件自己的 `ctx.effect` 之前**
  ⇒ ★★ **任何"插件层的保命网"都兜不到它**（那时我们的代码还没被装载）
⇒ 结论：**这个错只有一个解 —— 别把缺声明的包放进 `bundles`**
```

### 正确接法（**本次现场就是范本**）

该包**不是 bundle**，但**确实需要一个装配位** ⇒ 走**用户 patch 层 `insert`**，**不是** `bundles`：

```yaml
# <profile>/cordis.patch.yml
# ── 装配 <包名>（修正启动故障）──
# 该插件**不是 bundle**（package.json 无 dsh.bundle），却一度被列进 package.json 的 dsh.profile.bundles。
# rc.2 对「列进 bundles 但无 dsh.bundle 声明」是**致命错误**（dsh-app-boot/lib/index.js:852）
# ⇒ 正确接法：**用户 patch 层 insert**。已从 package.json 的 bundles 列表移除该包。
- insert:
    - id: dsh-blender-plugin
      name: '@dsh-external/dsh-blender-plugin'
      config: {}
```

**判据**：照上面做 ⇒ **profile 起得来**（本次修复后宿主稳定运行）。

---

## B 类 · 缺 `dsh.bundle` 且**没进** `bundles` ⇒ 😶 **静默：装了像没装**

### 现场

```
CLI 原话：`declares no dsh.bundle — installed as a plain dependency, not a profile layer`
⇒ 包**装上了**（`node_modules` 里有它）· `dependencies` 里也**写了它**
⇒ 但它**不进 profile 层** ⇒ **不激活** ⇒ 用户以为"装好了"，其实**什么都没发生**
```

**为什么它更阴**：**没有任何报错**。用户看到"安装成功"，然后发现**功能不存在**，
只会怀疑"这个插件是不是坏的"。

### 正确接法

- 若它**确实**该作为一个 profile 层 ⇒ **给它加 `dsh.bundle`**（指向它自己的 `cordis.patch.yml`）：

```json
{
  "name": "@your-scope/your-plugin",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- 若它**只是**一个客户端/工具包（**不是** profile 层）⇒ **保持不进 `bundles`**，改走它该走的路
  （例：**客户端插件**只声明 `dsh.client`，由宿主在渲染进程侧装载）。

---

## ★ 机械检查（**别靠记性**）

**一句话判据**：**逐个核对 `dsh.profile.bundles` 里每个包有没有 `dsh.bundle`**。

```bash
# `dsh-teamkit` 自带这条检查（只读，不动 profile）
node <安装位置>/tools/check-profile-bundles.mjs --profile web
#   exit 0 = 无 A 类致命
#   exit 1 = ★ 有 A 类致命（宿主会起不来）—— 输出里会点名是哪个包 + 正确接法
#   exit 2 = 拿不到 profile（未获取，不猜）
```

**它同时给 B 类提示**：`@dsh-external/*` 里"有 `dsh.client` 却没进 `bundles` 且无 `dsh.bundle`"
⇒ 通报（**不报红** —— 它不是致命，否则闸会天天红）。

**能红证明**（我们自己的变异测试，不是"应该会红"）：

```
造一个"进了 bundles + 无 dsh.bundle"的假包 ⇒ 报红 exit=1（且点名「A 类致命」+ 引 rc.2 原话）
造一个正常包（有 dsh.bundle）        ⇒ exit=0   （证明它不恒红）
造一个 B 类包（有 client、没进 bundles）⇒ exit=0 但有提示（证明不是静默放过）
```

---

## ★ 两条更一般的教训（**比这个坑本身值钱**）

```
① **"="我写下来了" ≠ "它会执行"** —— 这条坑我们**在前一个插件上就遇到过**
   （缺 `dsh.bundle` ⇒ 装上了不激活），当时也诊断对了、也写了结论 ——
   ★ 但knowledge**只活在那一次对话里**，**没有变成别人能拿到的东西**
   ⇒ 于是**另一个团队独立踩了同一个坑**，代价是 6 连崩 + 用户手动 retry。
   ⇒ **正解**：把"经验"变成**别人能跑的一条命令**（本份的机械检查就是这一步）。

② **报"没有"之前，先证明"我搜够了"** ——
   本检查的第一版只搜 `profile/node_modules` 与 `$DSH_HOME/node_modules`
   ⇒ `@deepseek-ai/dsh-base` / `dsh-web-app` 报"未获取"，而它们**确实存在**（在**宿主安装树**里）
   ⇒ ★ **"我找不到" ≠ "它不存在"**；报"未获取"要附**搜过哪些地方**。
```
