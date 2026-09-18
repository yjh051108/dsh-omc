# @dsh-external/dsh-tool-output-guard

**工具结果的「消息契约」守卫**：把不合形的 `output.render` 返回值在 `tools/post-execute`
边界归一成 `ContentBlock[]`，让一个插件的渲染疏忽不再能摧毁整个会话。

## 为什么存在（2026-09-10 案底 · session-852e1d99）

官方 `dsh-tools` 只校验 execute 的 **value**（按 `tool.output.schema`），
**不校验 `render` 的返回值**；而 render 的返回值被**原样**写进 durable 的
tool-result 块 `content`。于是一个插件回裸字符串：

```jsonc
// 落盘的非法消息（会话档里真实出现过）
{ "type": "tool-result", "toolCallId": "call_…", "content": "Browser ready (1 tab).", "isError": false }
```

连环后果：

1. **会话重载被拒** —— 官方校验器 `assertMessageEventShape`：
   `session event at seq 679 message must contain one tool-result block`
   （GUI：`历史加载失败: … is corrupt …`）；
2. **活着的会话每轮都死** —— 下一次请求在文本投影 `contentHasImage(block.content)`
   里递归 `.some` → `TypeError: content.some is not a function`
   → `turn/end { reason: error }`（GUI：`本轮运行失败 content.some is not a function`）；
   脏消息一直在上下文里，所以**每一轮都在模型开工前死**。

一个插件的疏忽 = 一个会话报废。这道守卫把后果降级为**一行日志**。

## 做什么 / 不做什么

- **做**：`tools/post-execute`（waterfall 最外层）拿最终 content →
  `normalizeToolContent()` 归一（裸字符串→文本块；`tool-result` 块的 content 非数组→包成块数组；
  缺 `type` 的对象→JSON 文本块；空数组→补空文本块；嵌套 tool-result 递归处理）。
- **做**：留痕 —— `ctx.logger.warn` + `$DSH_HOME/tool-output-guard.log`
  （点名工具 + 违规形态 + 修法），推动源头修好。
- **不做**：不抛错、不阻断。工具结果进模型上下文是主链路，宁可控损不断链。
- **零开销**：合法输入原引用返回，不复制不改写（`test/guard.test.mjs` i2/i8 钉死）。

## 契约（写插件的记住这一条）

```ts
output: {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],  // 必须回 ContentBlock[]
}
```

`render` 回裸值 = 写脏会话档。守卫是兜底，不是许可。

## 构建 / 装配

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh      # tsc → lib/
node --test test/guard.test.mjs                     # 纯函数单测（8 条）
# 注入器环境：dev_build_plugin <dir> → dev_install_package <dir> web（进 bundles，重启后仍在）
```

### ⚠️ 陌生人怎么装（**上面那条只对"有 DSH 源码检出"的人成立**）

```
★ `scripts/build.sh` 需要 `DSH_CHECKOUT` 指向 **DSH【源码】检出**（它要 `packages/` 与 `vendor/`）。
  ⇒ 若你只有 **npm 装的 dsh**（`node_modules/@deepseek-ai/dsh`）⇒ **没有源码检出 ⇒ build 走不通**
  ⇒ 那时请用下面【方式 A】。
```
**方式 A：Release 包（推荐，免构建）**
```
从 Releases 下载 `dsh-external-dsh-tool-output-guard-0.0.1.tgz` ⇒ 解压得到**含 `lib/` 的目录**，然后：
  # 官方装配（重启后由 bundles 接管）—— ★ 本包**带 `dsh.bundle`** ⇒ 这条有效
  dsh plugin --profile web add <解压目录>
  # 或运行时注入（免重启）
  # 对 AI 说：dev_inject_plugin <解压目录>
```
> ★ 本包与某些同类包的区别：**它 `package.json` 里有 `dsh.bundle` 声明**（指向 `cordis.patch.yml`）
> ⇒ **"官方装配"这条路在本包上是有效的**（有些包没有该声明，装进 bundles 会不生效）。

**方式 B：git（需先构建）**
```
git clone https://github.com/yjh051108/dsh-tool-output-guard.git
DSH_CHECKOUT=<你的源码检出> bash scripts/build.sh
# 然后：dsh plugin --profile web add <clone 目录>  或  dev_inject_plugin <clone 目录>
```


## 实测验证（2026-09-10）

1. 故意把 `dsh-agent-browser` 的构建产物改回裸字符串 → 重载 → 调 `browser_open`：
   会话档落的是 `tool-result<arr1>`（合法），守卫日志记下
   `tool "browser_open"(call …) 的 output.render 违反消息契约 → 已归一：render 回了 string(53 chars)…`。
2. 还原正确构建 → 再调 `browser_open`：记录合法且守卫日志**不新增行**（对合法输出零干扰）。
3. 全库 1017 个会话档扫描：中招 2 个（`852e1d99` / `c291914e`），均已按官方判据修复并备份
   `*.corrupt-bak`。
