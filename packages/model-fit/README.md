# @dsh-external/dsh-model-fit — 模型适配层

按 **DeepSeek-V4.1-Flash 技术报告**的实测结论改造 harness 身体：**每次干预自带证据，被忽略自动静默**。

> 判据不是仿真数字，是**用起来烦不烦、对不对**。所有设计取舍都来自亲身挨过的干预。

## 两个模块

### M1 尺子闸（v0.1）

**治的病**：会话 790752d3 实测——335 步（41%）/ 441 次调用 / 51 分钟 / 58% 的文件手术，全花在一个**坏掉的测量通道**上；13 次自承「测量坏了」仍继续用。

**检测**：
- 信号 A `sensor-stuck`：**不同输入 → 同一读回**（尺子卡住）
- 信号 B `sensor-loop`：**同一输入 → 同一读回**反复（原地打转）
- ★ **硬条件**：这段读数之间**必须真的动过手**（`writesBetween ≥ 1`）。
  否则只是「重复观测同一件事」——幂等验证、健康检查、轮询状态都长这样，报它就是烦。

**首测踩到的坑（已修）**：v0.1 没有硬条件，三条不同命令同一输出、期间零改动，照样响了 → **自判误报**，加条件。

**注入示例**：
```
📏 疑似尺子卡住：期间动过 1 次手，但最近 3 次读数结果完全相同、输入各不相同（工具 pwsh）。
最近一次输入「…」，读回「…」。要不要先喂一个已知一定会变的输入，确认这条读数通道还在反映实况。
```

### M2 压缩锚点（v0.2）

**论文依据**：
- §3.2.2：SWA 有界重放「**重建出的状态是近似的…依赖缓存命中位置**」
- §2.3.2：CSA2 稀疏检索按**块级打分建候选池**，没进池的信息后续层找不回来
- §6：作者自标风险区为「**长上下文上的稀疏检索**」

**机制**：压缩事件自带 `shadowedSeqs`——精确告诉我们哪些事件刚被埋掉。
据此把**刚被埋掉的开发者原话**重贴回近场（**原话，不是复述**）。

**本会话 7 次真实压缩的回放验证**：

| 压缩 | 被埋原话 | 重贴 |
|---|---|---|
| 09-10 08:30 | 18 条 | 「现在把meta和optimal详细对比给个雷达图」「放弃meta，回到optimal，先安装回来试试」「你去云端找我的完整推送云仓库…」 |
| 09-08 16:45 | 19 条 | 「你这个做法太傻逼了，我不认可…」 |
| 09-08 08:40 | 47 条 | 「下一步都别问我了，我已经看不懂了，自己迭代吧」 |
| 09-06 22:18 | 41 条 | 「我很讨厌导演这个词，以后还是叫开发者吧」 |

**质量过滤（回放调出来的）**：剥路径 + 剔一次性命令（「修改」「发个0.3.19的release包」「渲染完了没？」）+ ≥12 字。
一次过滤剔除 47 条噪声。

**踩过的坑**：`{kind:'intervene', ...entry}` 里 `entry.kind` 会覆盖类型标记 → 盘上 3 条、报告只认 1 条。
改用 `rec` 字段。**这是对账对出来的，不是看出来的。**

## 工具

| 工具 | 用途 |
|---|---|
| `fit_report` | 台账：M1 干预与裁定（adopted/ignored/未结）、M2 压缩与重贴记录、已知原话条数、当前上下文 |
| `fit_anchor_now` | 立即重贴一次最近的开发者原话（等效于刚压缩过）。感觉漂移时随时用 |

## 待验预言（本插件自己就是仪表）

**背景**：会话 55c5cf09 跨 5 天、5192 步，实测 7 次压缩的触发点全部落在 **715k / 786k / 792k / 791k / 793k / 796k / 794k**——高度聚集在 790–796k，**符合宿主默认 `thresholdRatio = 0.8`**（`dsh-compaction-basic` L15 `DEFAULT_THRESHOLD_RATIO=.8`，L111 `thresholdTokens = floor(contextWindow × ratio)`，窗口声明 1M）。

**⚠ 但不能据此说「配置没生效」**：这 7 次**全部早于** patch 改动时间（`profiles/web/cordis.patch.yml` 的 `compaction-basic` 条目被另一会话在 **09-10T17:41** 改过），而最后一次压缩在 **09-10T16:30**。`thresholdRatio: 0.6` **从未被行使过** → 是否生效 **UNKNOWN**。

**可证伪预言**：

> 下一次压缩，若 `0.6` 生效 → 在 **600k** 触发；若仍用默认 → 在 **800k** 触发。

**验证方式**：本插件每次压缩都记 `preCtx`（压缩前上下文真值）到台账 → 压缩一发生，`fit_report` 即可判定。
**这条预言的用法**：它同时是 M2 自然路径的验收——压缩一到，M2 的「事件→选原话→重贴」也一并跑通。

## 状态持久化（热重载是开发常态）

落 `~/.dsh/model-fit/<sid>.state.json`：`fired / lastFireAt / ignoredStreak / firedKeys / restatedSeqs / lastCtx / compactions / pending`。

**动机**：不持久化就会丢——M1 未结裁定永远悬着、M2 已贴标记丢失导致同一批原话反复重贴、上下文读数归零。

**往返实测**：锚定 3 条 → `restatedSeqs=[28776,28814,28926]` 落盘 → 重载 → 再锚定，**给出的是更早的、完全不同的 3 条** ✓

**未结裁定如实标注**：重载后判定期读数组已丢，无法裁定 → 记 `unresolved`，**不冒充 adopted/ignored**。

## 「不烦」的五条纪律

1. **自带证据**：每条干预写明凭什么，模型可据此判断对错
2. **不命令**：陈述事实 + 提议动作，用「要不要」而非祈使
3. **有上限**：M1 每会话最多 5 条，条间冷却 120s
4. **会闭嘴**：干预后读数仍不动 → 记 ignored；连续 2 次 → 本会话静默
5. **全程 try-catch 静默**：闸故障绝不碰主路

## 落点

`~/.dsh/model-fit/<sid>.jsonl`（追加式台账，含 verdict，供事后判对错）

## 宿主缝（实测确认）

| 缝 | 签名 | 备注 |
|---|---|---|
| `tools/result` | emit，`(exec, result)` | exec 有 `{name, arguments, agent}` |
| `session/event` | `(session, event)` | **真人原话在 `session.log`，不在 `session.events`** |
| `agent/pre-step` | waterfall，可 append messages | 消息须走 `createUserMessage` 完整契约 |
| `system-prompt/assemble` | waterfall，可 filter `assembled.tools` | 工具面收窄备用（未启用） |
| `agent.ctx.tools.restrict` | `{allow,deny}` → disposer | 官方零使用，工具面收窄备用（未启用） |

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```

### ⚠️ 陌生人怎么装（**上面那条只对"有 DSH 源码检出"的人成立**）

```
★ `scripts/build.sh` 需要 `DSH_CHECKOUT` 指向 **DSH【源码】检出**（它要 `packages/` 与 `vendor/`）。
  ⇒ 若你只有 **npm 装的 dsh**（`node_modules/@deepseek-ai/dsh`）⇒ **没有源码检出 ⇒ build 走不通**
  ⇒ 那时请用下面【方式 A】。
```
**方式 A：Release 包（推荐，免构建）**
```
从 Releases 下载 `dsh-external-dsh-model-fit-0.0.1.tgz` ⇒ 解压得到**含 `lib/` 的目录**，然后：
  # 运行时注入（免重启）—— ★ 本包**不带 `dsh.bundle`** ⇒ 推荐走这条
  # 对 AI 说：dev_inject_plugin <解压目录>
```
> ★ **本包 `package.json` 没有 `dsh.bundle` 声明** ⇒ 走「装配成 profile bundle」**不会激活**（不是报错，是不生效）。
> 也就是说：**"装了没反应"通常就是这个原因** —— 请用注入路径。

**方式 B：git（需先构建）**
```
git clone https://github.com/yjh051108/dsh-model-fit.git
DSH_CHECKOUT=<你的源码检出> bash scripts/build.sh
# 然后：dev_inject_plugin <clone 目录>
```

