/**
 * crash-guard.js —— ★★★ **保命网**：给本进程的 `stdout`/`stderr` 装 `'error'` 监听，
 *   只吞**管道断开**那一族（`EOF` / `EPIPE`）；**别的 error 照旧抛**。
 *
 * ## 现场（逐字，取自 `D:\dsh\desktop\web.log`，2026-09-15）
 * ```
 * node:events:497  throw er; // Unhandled 'error' event
 * Error: write EOF
 *     at WriteWrap.onWriteComplete (node:internal/stream_base_commons:87:19)
 * Emitted 'error' event on Socket instance at: emitErrorNT (node:internal/streams/destroy:170:8)
 * errno: -4095, code: 'EOF', syscall: 'write'
 * ⇒ dsh exited code=1 signal=null   ⇒ service died, restarting in 800ms (第 1/5 次)
 * ```
 * ★ **5 起**：`09-12 07:09:42` · `09-12 10:39:32` · `09-14 11:37:48` · `09-15 12:42:55` · `09-15 12:45:39`
 *   ⇒ ★★ `teamkit` 在该日志里**最早出现于 `09-14 06:37:56`** ⇒ **09-12 那两起不是我们**
 *     （`R5`：**能解释全部 5 起的才是真因**）
 *
 * ## 根因链（CEO 逐行核过；我独立复核源码）
 * ```
 * 【第 1 环】桌面壳 `D:\dsh\desktop\main.js:169`
 *     `child = spawn(DSH_NODE, [DSH_CLI, ...cliArgs], { env, windowsHide: true, cwd })`
 *   ⇒ ★ **没给 `stdio` ⇒ Node 默认 `'pipe'`** ⇒ `child.stdout` / `child.stderr` 是 **net.Socket**
 *     `:177 child.stdout.on('data', onData)` · `:178 child.stderr.on('data', …)` ⇒ **壳在读**
 * 【第 2 环】★★★ **壳自己知道这个坑，并给自己装了防护 —— 但那只保护【壳】**
 *     `:14 // 防 EPIPE：主进程的 stdout/stderr 管道可能被外部关闭…任何 console 输出都会变成未捕获异常。`
 *     `:17 for (const s of [process.stdout, process.stderr]) s.on('error', () => {})`
 *   ⇒ ★★ **壳保护了自己，却没保护它 spawn 的 dsh 子进程**
 * 【第 3 环】管道被关 ⇒ 子进程 write ⇒ **未捕获 `'error'`** ⇒ **进程自杀 `code=1`**
 * ```
 * ⇒ ★★★ **一句话**：**dsh 子进程的 stdout/stderr 是 pipe；管道被关后任何 write 抛未捕获 EOF ⇒ 自杀。**
 *
 * ## 本网做什么（**范围最小，边界可证**）
 * ```
 * · **只**给 `process.stdout` / `process.stderr` 装 `'error'` 监听 ——
 *   ★ **这是把桌面壳 `main.js:17` 对它自己做过的事，应用到子进程侧**（同一个已知补救）
 * · ★★ **只吞管道类**：`code === 'EOF'` / `'EPIPE'`（或 `errno === -4095` 且栈含 `Socket`/`WriteWrap`）
 *   ⇒ ⚠️ **别的 error 一律重新抛**（→ 未捕获 → 走 Node 默认行为 → 崩）⇒ **不掩盖任何别的错误**
 * · ⛔ **不装 `process.on('uncaughtException')`** —— 那会吞掉**所有**异常（含我们自己的 bug）
 *   （★ 我第一版写过它，**已按 CEO §④③ 的硬边界撤掉** —— 那条边界是对的）
 * · ★ **可卸净**：`dispose()` 移除监听 ⇒ `listenerCount('error')` 回到原值（`R22`）
 * ```
 *
 * ## 能红证据（`tools/crash-guard-test.mjs` ⇒ **PASS 12/12**，四条判据全双向）
 * ```
 * ① 装网 + 管道断 ⇒ **不死**（exit 0） · **不装网** ⇒ **照旧崩**（`Emitted error event on Socket instance`）
 * ② ★ 装网 + 普通 `TypeError` ⇒ **照旧崩** ← **这条才是"没有掩盖错误"**
 * ③ 监听器计数：装前 **0** / 装后 **1** / 卸后 **0**
 * ④ 非管道类 error（伪造 `code:'EBADF'`）⇒ **照旧抛**（不是"什么都吞"）
 * ⑤ 装上后 `console.log` **仍照常出去**（不许静默）
 * ```
 *
 * ⚠️ **诚实边界**：我的复现产出的是 **`EPIPE: broken pipe, write`**，而现场是 **`write EOF`** ——
 *   两者是**同一族**（往已断的管道写），Node 在不同时机给不同 errno ⇒ 判据按**族**判。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★★ **2026-09-16 追加：进程级兜底（`uncaughtException`），但【只兜这一族】**
 * ```
 * 【为什么加（CEO 裁定，我先前否掉过这一条 —— 现在改判）】
 *   09-16 13:12 宿主**又崩了一次**（`write EOF`），而我们装了 2.5 小时的网**一次都没兑现**
 *   （`teamkit.log` 里"吞掉"命中 = **0**）。
 *   ⇒ ★★ 根因（CEO 定位到行）：**崩的不是 stdout/stderr，是别处的 socket** ——
 *     `<dsh>/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:260-269`：
 *     `:265 socket.on("error", onError)` · `:267 socket.off("error", onError)`（**`close` 时撤监听**）
 *     ⇒ close 之后**该 socket 上没有 error 监听** ⇒ 之后的写入 ⇒ **未捕获 `'error'` ⇒ 进程死**
 *   ⇒ ★ 那个 socket 在**官方包**里（= DSH 本体）⇒ **我们不能改**（硬规矩 1）
 *   ⇒ ★★ 所以**唯一的插件层补救**就是**进程级兜底**。
 * 【★ 但边界必须窄（这是加它的前提）】
 *   · **只兜 `isPipeBroken(err)`**（`EOF` / `EPIPE` / `errno === -4095` + Socket/WriteWrap）
 *   · ★★ **别的异常 ⇒ 走 Node 默认行为**（打印栈 + `exit(1)`）⇒ **不掩盖任何我们自己的 bug**
 *   · ★ **并且记一条日志** `UNCAUGHT-PIPE-EOF-SWALLOWED` —— **不许"吞了没人知道"**
 * 【⚠️ 为什么不能"只 return 不 exit"】
 *   `uncaughtException` 一旦有监听，Node **就不再**默认退出 ⇒
 *   若我们对"非管道异常"只是 `return`，那就**真的吞掉了我们的 bug**（比不加更糟）。
 *   ⇒ 所以非管道分支**显式复现默认行为**：best-effort 写栈到 stderr，然后 `process.exit(1)`。
 * ```
 */

/** ★ 只认"管道断开"这一族 —— **窄到不能再窄** */
export const isPipeBroken = (err) => {
  if (err === null || typeof err !== 'object') return false
  const code = err.code
  const errno = err.errno
  // ★ 主判据：code 必须是 EOF / EPIPE
  if (code === 'EOF' || code === 'EPIPE') return true
  // ★ 次判据：`errno === -4095`（EOF 的 Windows 值）+ 栈/消息里能看出是 socket 写
  if (errno === -4095) {
    const stack = typeof err.stack === 'string' ? err.stack : ''
    const msg = typeof err.message === 'string' ? err.message : ''
    return /\bSocket\b|WriteWrap/.test(stack) || /write EOF|EPIPE/.test(msg)
  }
  return false
}

/**
 * 装上保命网（**只装 stdout/stderr 的 `'error'` 监听**）。
 * @param {{log?: (m: string) => void}} [opts]
 * @returns {{dispose: () => void, stats: () => object}}
 */
export const installCrashGuard = ({ log = () => {}, uncaught = true } = {}) => {
  const stats = { caught: 0, rethrown: 0, uncaughtCaught: 0, uncaughtFatal: 0, details: [] }
  const streams = [process.stdout, process.stderr]
  const before = streams.map((s) => s.listenerCount('error'))
  const beforeUncaught = process.listenerCount('uncaughtException')

  const makeHandler = (name) => (err) => {
    if (isPipeBroken(err)) {
      stats.caught += 1
      stats.details.push({
        at: new Date().toISOString(),
        stream: name,
        code: err?.code,
        errno: err?.errno,
        message: String(err?.message ?? '').slice(0, 80),
      })
      log(`吞掉 ${name} 的管道断开：code=${err?.code} errno=${err?.errno}（宿主本该继续跑）`)
      return // ★ **不抛 ⇒ 不自杀**
    }
    stats.rethrown += 1
    // ★★ **别的 error ⇒ 重新抛**（→ 未捕获 → Node 默认行为 ⇒ 崩）
    throw err
  }

  const handlers = streams.map((s, i) => {
    const h = makeHandler(i === 0 ? 'stdout' : 'stderr')
    s.on('error', h)
    return { s, h }
  })

  // ── ★★★ 进程级兜底（2026-09-16）：**只兜管道族，别的照旧死** ──────────────────
  // ```
  // ⚠️ **为什么必须有这一条**：09-16 那次崩在 `dsh-host-webserver` 的 upgrade socket 上 ——
  //   而那个 socket **不是** `process.stdout/stderr` ⇒ 上面的监听**够不到它** ⇒ "吞掉 = 0"。
  // ⇒ 这条网是**我们唯一够得到它的位置**（进程级）。
  // ```
  const onUncaught = (err) => {
    if (isPipeBroken(err)) {
      stats.uncaughtCaught += 1
      stats.details.push({
        at: new Date().toISOString(),
        where: 'uncaughtException',
        code: err?.code,
        errno: err?.errno,
        message: String(err?.message ?? '').slice(0, 80),
        stack: String(err?.stack ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 300),
      })
      // ★★ **必须记日志**（否则"吞了没人知道" = 第二种错）
      log(
        `★ UNCAUGHT-PIPE-EOF-SWALLOWED —— 兜住一次进程级管道断开：` +
          `code=${err?.code} errno=${err?.errno} msg=${String(err?.message ?? '').slice(0, 60)}` +
          `（宿主继续跑；**这不是"没有错误"，是"这个错误不该杀进程"**）`,
      )
      return // ★ **不退出 ⇒ 宿主活着**
    }
    // ★★★ **非管道异常 ⇒ 显式复现 Node 默认行为**（否则我们就真把它吞了）
    stats.uncaughtFatal += 1
    stats.details.push({
      at: new Date().toISOString(),
      where: 'uncaughtException',
      fatal: true,
      code: err?.code,
      message: String(err?.message ?? '').slice(0, 120),
    })
    log(`★★ 未捕获的【非管道】异常 ⇒ **按默认行为退出**（不掩盖）：${String(err?.message ?? err).slice(0, 120)}`)
    try {
      // best-effort 打栈（管道可能已断 ⇒ 这里也要防二次抛）
      process.stderr.write(`UNCAUGHT (not pipe-family) ⇒ exiting 1\n${String(err?.stack ?? err)}\n`)
    } catch {
      /* 管道也断了就写不出去 —— 那不影响"要退出"这个决定 */
    }
    process.exit(1)
  }
  if (uncaught) process.on('uncaughtException', onUncaught)

  return {
    dispose: () => {
      for (const { s, h } of handlers) s.removeListener('error', h)
      if (uncaught) process.removeListener('uncaughtException', onUncaught)
    },
    stats: () => ({
      ...stats,
      before,
      after: streams.map((s) => s.listenerCount('error')),
      beforeUncaught,
      afterUncaught: process.listenerCount('uncaughtException'),
    }),
  }
}
