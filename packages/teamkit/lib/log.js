/**
 * log.js —— **可观察信号**（task-51 B.4「失败不静默」）。
 *
 * 为什么必须单独一个件：本插件里出现过的"静默失败"有三类，全都是实测踩出来的：
 *  ① **该生效却没生效**：`install-teamkit.mjs` 把"读不到落点"误判成"没装"（`verify-handoff.mjs:39-60`
 *     的三态注释就是为这条写的）；同理"通知该推而没推"、"fork 该装而没装"都会**无声无息**。
 *  ② **消耗型失败**：`task-45` 实测——被限流的那条通知 `lastDigest` 已前进 ⇒ 永远不再判为"新"
 *     ⇒ **永久丢失**（`UPSTREAM-NOTIFY.md` §C.3）。这类失败必须**入队并留痕**，不能只 `return`。
 *  ③ **写入未校验**：`promote-upstream.mjs:150-153` 立了规矩——写完 CHANGELOG 要**回读确认
 *     说明真在里面**，否则 `exit 3`。
 *
 * 本模块给三样东西（都很便宜）：
 *  · `makeLogger(path)` —— **行式 append-only** 日志，每条带动作名与结果；
 *  · `counters` —— 关键计数（该发生的 / 实际发生的），供 `--selftest` 与 `--status` 断言；
 *  · `expect` —— **写入后回读校验**的通用形态（`promote-upstream.mjs` 那条规矩抽出来）。
 *
 * 为什么不用 `console.log`：插件的 stderr 在会话里看不见，而**盘上的日志是插件里唯一
 * 事后可审计的面**（所有实验件都靠 `raw/*.log` 下的逐字读数定案）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 内存计数器：键由调用方定（如 `notify.injected` / `notify.skipped`）。 */
function makeCounters() {
  const map = new Map()
  return {
    bump(key, by = 1) {
      map.set(key, (map.get(key) ?? 0) + by)
      return map.get(key)
    },
    get(key) {
      return map.get(key) ?? 0
    },
    snapshot() {
      return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    },
  }
}

/**
 * 行式日志器。**路径为空 = 只计数不写盘**（`--selftest` 之外也允许关盘上日志）。
 * @param file 绝对路径
 * @param opts.prefix 行前缀（默认 `[teamkit]`）
 */
export function makeLogger(file, opts = {}) {
  const prefix = opts.prefix ?? 'teamkit'
  let writeFailed = 0
  let writeCount = 0
  const counters = makeCounters()

  const line = (level, event, detail) => {
    const ts = new Date().toISOString()
    const d = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    return `[${ts}] ${prefix} ${level} ${event}${d}`
  }

  const emit = (level, event, detail) => {
    const text = line(level, event, detail)
    counters.bump(`log.${level.toLowerCase()}`)
    if (typeof file === 'string' && file !== '') {
      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, text + '\n', 'utf8')
        writeCount += 1
      } catch (err) {
        // 日志写不进去**本身**就是一个要能被看见的事实（但不许拖垮插件）。
        writeFailed += 1
        process.stderr.write(`${prefix}: LOG-WRITE-FAIL file=${file} err=${err?.message ?? String(err)}\n`)
      }
    }
    if (opts.echo === true) process.stderr.write(text + '\n')
    return text
  }

  return {
    counters,
    info: (event, detail) => emit('INFO', event, detail),
    warn: (event, detail) => emit('WARN', event, detail),
    error: (event, detail) => emit('ERROR', event, detail),
    /** 插件自身健康读数（供 `--status` 与 `--selftest` 断言）。 */
    health: () => ({ logFile: file || null, writes: writeCount, writeFailures: writeFailed }),
  }
}

/**
 * **写入后回读校验**（`promote-upstream.mjs:150-153` 的规矩）。
 * 为什么必要：「写过了」不等于「写进去了」——`promote-upstream.mjs` 的 CHANGELOG 写入校验
 * 与 `LANDMINES §9`（字段存在 ≠ 值正确）是同一条纪律。
 * @returns `{ok, why}`；`ok=false` 时 why 带可执行信息（路径 + 找的是什么）。
 */
export function expectContains(file, needle) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.includes(needle)
      ? { ok: true, why: 'found' }
      : { ok: false, why: `回读校验失败：${file} 里找不到刚写入的内容（needle 前 40 字：${String(needle).slice(0, 40)}）` }
  } catch (err) {
    return { ok: false, why: `回读校验失败：读不到 ${file}（${err?.code ?? err?.message}）` }
  }
}
