# 上报材料 · `dsh-host-webserver` upgrade socket 的 `close` 竞态

> **给谁**：DSH 本体/官方维护者（**这个 bug 在我们够不到的包里**）。
> **我们的立场**：我们**不改本体**（硬规矩 1）⇒ 插件层只能**加一张网兜住**（`crash-guard.js` 第 2 层）。
> **事实状态**：**根因已定位到行，端到端复现未获取**（见 §4 诚实边界）。

---

## 1. 现场（逐字，非转述）

```
node:events:497  throw er; // Unhandled 'error' event
Error: write EOF
    at WriteWrap.onWriteComplete (node:internal/stream_base_commons:87:19)
Emitted 'error' event on Socket instance at:
    emitErrorNT (node:internal/streams/destroy:170:8)
errno: -4095, code: 'EOF', syscall: 'write'
⇒ dsh exited code=1 signal=null  ⇒ service died, restarting in 800ms（第 1/5 次）
⇒ 连崩 6 次后壳报：连续 6 次启动后即退出，已停止自动重启（防崩溃循环）
⇒ 用户被迫手动点 retry
```

**发生频次（实测）**：`09-12 ×2` · `09-14 ×1` · `09-15 ×2` · **`09-16 ×1`**（装了我们的网之后仍崩）。

---

## 2. 根因（行级）

`<dsh>/node_modules/@deepseek-ai/**dsh-host-webserver**/lib/index.js`

```js
:260  this.server.on("upgrade", (req, socket, head) => {
:261    const onError = (error) => { this.ctx.logger.warn(error); socket.destroy() }
       ...
:265    socket.on("error", onError)            // ← 装了监听
:266    socket.once("close", () => {
:267      socket.off("error", onError)          // ← ★★★ close 时把它【撤掉】
:268      this.upgradedSockets.delete(socket)
:269    })
```

### 为什么这是竞态

```
① `close` 与"最后一次写完成"**没有顺序保证** —— `close` 事件先到，而写还在队列里
② `:267` 把 `onError` 撤掉之后，**该 socket 上没有任何 `'error'` 监听**
③ 之后任何对该 socket 的写失败（对端已关 ⇒ `EOF`）⇒ Node 的 `'error'` 事件**无人接**
④ Node 对"无监听的 `'error'`"的默认行为 = **throw**（`node:events:497`）⇒ **进程退出**
```

**关键点**：`close` 只表示"**不会再收到数据**"，**不表示"socket 不会再报错"** ——
写侧的错误常在 `close` **之后**才到达。`off` 的时机因此过早。

### 建议修法（任选，按侵入性排序）

```js
// 方案 A（最小）：用 `once` 之外的方式，让监听【活到 socket 被 GC/彻底销毁】
//   —— 不要因 `close` 就撤；撤监听的理由是"防止泄漏"，而 socket 已从 set 里删了（`:268`）就够
:266  socket.once("close", () => {
         this.upgradedSockets.delete(socket)
-        socket.off("error", onError)
       })

// 方案 B：撤之前先确认它【真的不会再写】
:267  if (socket.destroyed || socket.writableEnded) socket.off("error", onError)

// 方案 C（最稳，但要小心）：给 socket 一个【不抛的】error 处理
//   例：`socket.on("error", onError)` 且 onError 内部永不 rethrow（现状已经是 warn + destroy ✅）
```

★ **方案 A 最省事**，且**改动量最小**（删一行）。
⚠️ 若担心"监听器泄漏" ⇒ **方案 B**（只有当 socket 已 destroyed/writableEnded 才撤）。

---

## 3. 为什么它值得修（影响面）

```
· **用户可见**：宿主进程死 ⇒ 桌面壳重启 ⇒ 连崩 6 次后**停止自愈** ⇒ **用户必须手动点 retry**
· **不是边缘路径**：`upgrade` 是 **WebSocket / SSE 一类长连接的必经之路**
  —— 我们有多个插件用 `sidebar.right.pane.tab`（浏览器面板 / 组织面板）⇒ 每次连接关闭都可能触发
· **对我们的代价**：这是委托方点名的 **#1 痛点**（「先解决个重启的问题」）
```

---

## 4. ⚠️ 诚实边界（**别把这些当已证实**）

```
· **根因是"定位到行 + 机制自洽"，不是"端到端复现"** ——
  我们**没能**造出与现场**逐字一致**的 `EOF/-4095`（我们的管道复现给的是 `EPIPE/-4047`）。
  ⇒ 判据：**"能解释全部现场" ≠ "已复现"**。请以贵方仓库里的复现为准。
· 我们**没有**改本体（硬规矩），因此**没有**对 `dsh-host-webserver` 做过任何写入验证。
· 插件层那张网（`crash-guard.js` 第 2 层）**只兜 pipe/EOF 族**；
  ★ 它**不是**"问题解决了" —— 它是**"宿主不再因此自杀"**。**根因仍在上面那两行。**
```

---

## 5. 我们这边的对应动作（供对照）

```
① 插件层兜底：`crash-guard.js` 第 2 层（`process.on('uncaughtException')`，**只兜 pipe/EOF 族**，
   非管道异常**照旧 exit(1)** —— 证明见 `tools/crash-guard-uncaught-test.mjs`，双向判据全过）
② ⛔ **不改本体**（只在插件的开放扩展端口上做）
③ ★ 本上报材料：`dsh-company` 仓里留存，供后人复核
```

> **一句话**：**"宿主不要因为一个 socket 的写错误而自杀"是插件的责任；"那个 socket 不该在 close 时就撤监听"是本体的责任。**
