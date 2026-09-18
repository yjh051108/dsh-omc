/**
 * check-orphans-rule.mjs —— **孤儿巡检规则的能红断言**（task-107 §五）。
 *
 * ## 为什么要有它（CEO 的原话）
 * > 「请把 `teamkit orphans` 做成【**能红的东西**】……否则永远只是"COO 记得去看"」
 * ⇒ **没有红输出 = 没交付**。本文件就是那个"红"的**可复跑**来源。
 *
 * ## 它守的三条不变量（都是本项目栽过的形态）
 * ```
 * ① ★★ 活跃性只能用 agents.list()，**不能用 journal.phase**
 *    （phase 是写入时快照 ⇒ 进程死了它不变 ⇒ 用它会算出"0 孤儿"的**假绿**）
 *    ⇒ 变异：造"phase=active 但不在 list 里" ⇒ **必须红**
 * ② 三态不许混：有孤儿 exit=1 / 无孤儿 exit=0 / **读不到 exit=2（不许静默 0）**
 * ③ verify-route：402 链上的成员 ⇒ **必须红**
 * ```
 * ## ★ 为什么这些用例必须"相对判据"（COO 明确提醒）
 * 分叉数（22 vs 7）是**某一刻**的读数，**会变**。
 * ⇒ 断言里**不写死任何数字**，只写"分叉必须为空 / 该红就红"。
 *   （写死数字 ⇒ 下次真读数一变，断言就假红 ⇒ 人就把断言关掉 ⇒ 比没有更坏。）
 *
 * 用法：
 * ```
 * node plugin/scripts/check-orphans-rule.mjs              # 全部用例（人类可读）
 * node plugin/scripts/check-orphans-rule.mjs --json        # 机器可读
 * ```
 * 退出码：`0` 全过 / `1` 有用例没按预期 ⇒ **那是本规则自身的缺陷，必须修**
 *
 * 零依赖：只用 node 内置。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const asJson = process.argv.includes('--json')
// ⚠️ **必须防递归**：变异测试会用 `--json` **再跑一次本文件**来观察断言红不红；
//    子进程若也跑变异测试 ⇒ 无限递归。⇒ 子进程带 `--no-mutation` 跳过。
const noMutation = process.argv.includes('--no-mutation')

// ── ★★ 被测模块：**可由 `--module=<path>` 指到副本**（变异测试的核心机制）────────
// 为什么是**命令行参数**而不是环境变量（CEO 建议，我采纳）：
//   环境变量**会被子进程继承、也可能被别的进程看到** ⇒ 并发脚本可能**串味**；
//   `--module=<path>` 是**显式的、局部的、只作用于这一个子进程**。
const moduleArg = (() => {
  for (const a of process.argv) if (a.startsWith('--module=')) return a.slice('--module='.length)
  return undefined
})()
const MODULE_PATH = moduleArg ?? fileURLToPath(new URL('../lib/orphans.js', import.meta.url))
// 动态 import：这样变异测试能让本脚本从**临时副本**加载规则，而**产品文件全程只读**。
const { analyzeOrphans, classifyTask, crossCheckLiveness, routeVerdict, EXIT } = await import(pathToFileURL(MODULE_PATH).href)
const MODULE_IS_PRODUCT = moduleArg === undefined

const cases = []

/**
 * 跑一个用例。
 * @param name 用例名
 * @param expect 期望的判定：'red'（必须报红）| 'green'（必须不红）| 'unverified'（必须未获取）
 * @param fn 返回 `{exitCode, verdict, why}` 或 `{problems:[...]}` 的 thunk
 */
function check(name, expect, fn) {
  let got
  let err
  try {
    got = fn()
  } catch (e) {
    err = String(e?.message ?? e)
  }
  if (err !== undefined) {
    cases.push({ name, expect, got: `threw: ${err}`, ok: false, why: '' })
    return
  }
  // 统一成 {code, verdict, why}
  const code = got?.exitCode
  const verdict = got?.verdict ?? (Array.isArray(got?.problems) && got.problems.length > 0 ? 'red' : 'ok')
  const why = got?.why ?? (Array.isArray(got?.problems) ? (got.problems[0] ?? '') : '')
  let ok
  if (expect === 'red') ok = code === EXIT.red || verdict === 'red'
  else if (expect === 'green') ok = code === EXIT.ok && verdict !== 'red'
  else ok = code === EXIT.unverified || verdict === 'unverified'
  const label = code === EXIT.red || verdict === 'red' ? 'red' : code === EXIT.unverified || verdict === 'unverified' ? 'unverified' : 'green'
  cases.push({ name, expect, got: label, ok, why: String(why).slice(0, 170) })
}

// ── 固定装置（**两个世界**，别拿真读数当装置）──────────────────────────────
//
// ⚠️⚠️ **装置里的 `status` 只能用底座真实取值**（`idle` / `running`）——
//   底座源码（`dsh-agent-loop:773-775`）**只有这两个值**。我原来在装置里写了 `'inactive'`，
//   那是个**根本不存在的取值** ⇒ 修完"idle 不是孤儿"之后，那两条用例立刻变成**假装置**
//   （`inactive` 落进 `ok-unknown-status`，于是"有孤儿"的用例反而绿了）。
//   ⇒ **教训**：**装置里的值必须是真实词汇表里的**，否则用例测的是"我编的世界"，不是底座。
const LIVE = [
  { id: 'm-1', name: 'alive-dev', status: 'running' },   // 真在跑
  { id: 'm-2', name: 'idle-dev', status: 'idle' },       // 回合之间的**常态**（**不是孤儿**）
]
const JOURNAL = [
  { id: 'm-1', name: 'alive-dev', phase: 'active' },
  { id: 'm-2', name: 'idle-dev', phase: 'active' },
  { id: 'm-3', name: 'ghost-dev', phase: 'active' },   // ★ 只在 journal 里（重启后进程没了）
]

/**
 * ★★★ **判别性装置**（我第一版漏了它，是**变异测试**逼出来的）：
 * 一个成员**同时带 phase 与 status，且两者矛盾** —— `phase:'active'`（写入时快照）
 * 而 `status:'idle'`（进程内实况：回合之间）。**"僵尸活跃"就是这个形态**。
 *
 * 为什么非要有它：我第一版的装置**没有 `phase` 字段** ⇒
 * 我把规则改成"用 phase 判活跃"（错法）后，**断言仍然全绿** ⇒
 * **说明那套断言根本没在测这条不变量**。
 * 有了它，正确实现（认 status ⇒ 该不该红由 status 决定）与错法（认 phase ⇒ 全绿）**才会分叉**。
 */
const ZOMBIE = [
  { id: 'm-1', name: 'alive-dev', phase: 'active', status: 'running' },
  { id: 'm-4', name: 'zombie-dev', phase: 'active', status: 'idle' }, // ★ journal 说在岗、进程内 idle
]

// ═══ ① 核心不变量：journal.phase 判活跃 ⇒ **假绿**；agents.list 判 ⇒ 真红 ═══════
//
// ★★ 这一组是**判别性断言**：装置里 `zombie-dev` 的 `phase='active'` 与 `status='idle'` **矛盾**。
//    正确实现（认 status ⇒ `ok-idle`）与错法（认 phase ⇒ 当 `running`）**在 kind 上分叉**。
//    ⇒ 只有这一组能挡住"用 phase 冒充活跃"的变异（我第一版没有它，变异测试当场发现漏了）。
//
//    ⚠️ **判别点不是"谁红"**（两者都不该红 —— `idle` 是常态），而是 **kind 与判据来源**：
//      把 `phase` 当活跃来源，等于**换掉了"人在不在"的事实来源**（`R10` SOT）。
//        ⇒ 所以断言要钉的是**"这条判断的依据是 status"**，不是"它红不红"。
check('★★① 判别性：phase=active 与 status=idle 矛盾时，依据必须是 **status**（kind=ok-idle）', 'green', () => {
  const c = classifyTask({ id: 't', status: 'in_progress', ownerName: 'zombie-dev' }, (k) => ZOMBIE.find((m) => m.name === k))
  const ok = c.kind === 'ok-idle'   // ★ 错法（认 phase）会给 ok-running ⇒ 这里立刻分叉
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `kind=${c.kind}（错法会给 ok-running）` }
})

check('★★① 判别性：status 缺失 + phase=active ⇒ 落**未获取档**（不许被 phase 补成 running）', 'green', () => {
  const dev = [{ id: 'u-1', name: 'nohint-dev', phase: 'active' }]   // 只有 phase，没有 status
  const c = classifyTask({ id: 't', status: 'in_progress', ownerName: 'nohint-dev' }, (k) => dev.find((m) => m.name === k))
  // ★ 期望 `indeterminate`（未获取档）：**判不了**就该说判不了 —— 比"当它 unknown 然后绿"更准。
  //   错法（用 phase 补成 running）会给 `ok-running` ⇒ 这里立刻分叉。
  const ok = c.kind === 'indeterminate' && !c.orphan
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `kind=${c.kind}（错法会用 phase 补成 ok-running）` }
})

check('★★① 判别性（正对照）：真正 running 的那个 ⇒ `ok-running`', 'green', () => {
  const c = classifyTask({ id: 't', status: 'in_progress', ownerName: 'alive-dev' }, (k) => ZOMBIE.find((m) => m.name === k))
  const ok = c.kind === 'ok-running' && !c.orphan
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `kind=${c.kind}` }
})

check('★① 跨文件断言：phase=active 但不在 list ⇒ 报红', 'red', () => crossCheckLiveness(JOURNAL, LIVE))

check('★① 跨文件断言：phase=active 但进程内只是 idle ⇒ 报红（"在册但没在跑"也算分叉）', 'red', () =>
  crossCheckLiveness([{ id: 'm-4', name: 'zombie-dev', phase: 'active' }], ZOMBIE))

check('★① 跨文件断言：两侧一致 ⇒ 必须绿（正对照）', 'green', () =>
  crossCheckLiveness([{ id: 'm-1', name: 'alive-dev', phase: 'active' }], LIVE))

check('★① 跨文件断言：非 active 的 journal 行不算分叉（provisioning 本来就该不在进程里）', 'green', () =>
  crossCheckLiveness([{ id: 'm-9', name: 'provisioning-dev', phase: 'provisioning' }], LIVE))

// ═══ ② 三态（有/无/未获取）═══════════════════════════════════════════════
check('② 有孤儿（owner **不在名单** —— 唯一那类真孤儿）⇒ exit=1', 'red', () =>
  analyzeOrphans({ tasks: [{ id: 't1', status: 'in_progress', ownerName: 'ghost-dev' }], members: LIVE }))

check('② owner 活跃 ⇒ exit=0（不许误报）', 'green', () =>
  analyzeOrphans({ tasks: [{ id: 't1', status: 'in_progress', ownerName: 'alive-dev' }], members: LIVE }))

check('② owner `idle`（常态）⇒ exit=0（**不许假红**）', 'green', () =>
  analyzeOrphans({ tasks: [{ id: 't1', status: 'in_progress', ownerName: 'idle-dev' }], members: LIVE }))

check('② 无 in_progress ⇒ exit=0', 'green', () =>
  analyzeOrphans({ tasks: [{ id: 't1', status: 'completed', ownerName: 'ghost-dev' }], members: LIVE }))

check('③ 诚实条：缺 members ⇒ exit=2（不许静默 0）', 'unverified', () =>
  analyzeOrphans({ tasks: [{ id: 't1', status: 'in_progress', ownerName: 'alive-dev' }] }))

check('③ 诚实条：members 为空数组 ⇒ exit=2（读不到人 ≠ 没有人）', 'unverified', () =>
  analyzeOrphans({ tasks: [], members: [] }))

check('③ 诚实条：缺 tasks ⇒ exit=2', 'unverified', () => analyzeOrphans({ members: LIVE }))

// ═══ ③ 两种"孤儿"要分开（absent vs no-owner）══════════════════════════════
check('③b "不在名单"与"没有 owner"必须分成两种 kind', 'green', () => {
  const memberOf = (k) => LIVE.find((m) => m.name === k || m.id === k)
  const absent = classifyTask({ id: 'x', status: 'in_progress', ownerName: 'no-such-dev' }, memberOf)
  const noOwner = classifyTask({ id: 'y', status: 'in_progress' }, memberOf)
  const ok = absent.orphan && noOwner.orphan && absent.kind !== noOwner.kind
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `${absent.kind} / ${noOwner.kind}` }
})

// ═══ ③c ★★ **假红防线**：`idle` 是常态，**不许**报成孤儿 ═════════════════════════
//
// 【为什么单独立一组】我第一版把 `status !== 'running'` 的**一律**判孤儿 ⇒
//   `idle` 的 owner 被报成孤儿 = **假红**（叫一个活着的人"没人接"）。
//   COO 的真实误判现场就是这个形态：他用"`in_progress` × `list_agents`"巡出 3 个"孤儿"，
//   复核发现 `performance-measurer` **其实活着**（在单文件编辑报告、未落盘新文件）⇒ **一叫就回**。
//
//   底座依据（`dsh-agent-loop/lib/index.js:773-775` **逐字**）：
//   ```js
//   get status() { return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running" }
//   ```
//   ⇒ `status` **只有 `idle` / `running` 两个值**，且 **`idle` 是"回合之间"的常态**。
//   ⇒ 把 `idle` 当孤儿 = 把"没在跑"当成"人不在" ⇒ **"读不到 ≠ 没有"的假红版**。
const IDLE_DEVICE = [
  { id: 'i-1', name: 'idle-dev', status: 'idle' },
  { id: 'i-2', name: 'running-dev', status: 'running' },
  { id: 'i-3', name: 'nohint-dev' },   // status 缺失 ⇒ 不确定
]

check('★★③c `idle` 的 owner **不许**报孤儿（假红防线）', 'green', () =>
  analyzeOrphans({ tasks: [{ id: 't-idle', status: 'in_progress', ownerName: 'idle-dev' }], members: IDLE_DEVICE }))

check('★★③c `idle` 的 kind 必须是 `ok-idle`（不是孤儿）', 'green', () => {
  const c = classifyTask({ id: 't', status: 'in_progress', ownerName: 'idle-dev' }, (k) => IDLE_DEVICE.find((m) => m.name === k))
  const ok = !c.orphan && c.kind === 'ok-idle'
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `kind=${c.kind} orphan=${c.orphan}` }
})

check('★★③c `status` 缺失 ⇒ 落**未获取档**（不判孤儿，也不判在做）', 'green', () => {
  const c = classifyTask({ id: 't', status: 'in_progress', ownerName: 'nohint-dev' }, (k) => IDLE_DEVICE.find((m) => m.name === k))
  const ok = !c.orphan && c.kind === 'indeterminate'
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `kind=${c.kind} orphan=${c.orphan}` }
})

check('★★③c 混合装置：只有"真的不在名单"那个才红', 'red', () =>
  analyzeOrphans({
    tasks: [
      { id: 't-idle', status: 'in_progress', ownerName: 'idle-dev' },
      { id: 't-run', status: 'in_progress', ownerName: 'running-dev' },
      { id: 't-ghost', status: 'in_progress', ownerName: 'ghost-dev' },   // ★ 唯一真孤儿
    ],
    members: IDLE_DEVICE,
  }))

// ═══ ③d ★★ **第二诚实条**：`inactive` 不是观测值，是三档 + 证据 ═══════════════
//
// 【依据】底座 `dsh-experimental-agent-team/lib/index.js:454` **逐字**：
// ```js
// status: member.phase === "failed" ? "failed"
//       : member.phase === "provisioning" ? "provisioning"
//       : live?.status ?? "inactive"          // ← ★ 兜底**编造**
// ```
// ⇒ `inactive` 把三种情况压成一个词：① 真不在 ② 在但 idle ③ **在动，但我这个 scope 看不到**。
//   现场实证：`engineering-director` 被显示 `inactive`，而它的会话日志 mtime 连采三次**都在长**。
// ⇒ 判据：**`inactive` 不得作为任何一档的判据**；每档都要能回答"我用什么读数判的"。
const _NOW = Date.now()
const TIER_DEVICE = [
  { id: 't-run', name: 'running-dev', status: 'running', statusSource: 'live' },
  // ★ 显示 inactive，但有 scope 外证据（日志 1 分钟前在动）⇒ **可唤醒**，不是孤儿
  { id: 't-wake', name: 'writing-dev', status: 'inactive', statusSource: 'fallback', lastLogMtime: _NOW - 60_000 },
  // 显示 inactive，且**拿不到**任何 scope 外证据 ⇒ 未获取（**不许**判孤儿）
  { id: 't-unknown', name: 'nohint-dev', status: 'inactive', statusSource: 'fallback' },
]

check('★★③d `inactive` + 有 scope 外活动证据 ⇒ **可唤醒**，不许判孤儿', 'green', () => {
  const c = classifyTask(
    { id: 't', status: 'in_progress', ownerName: 'writing-dev' },
    (k) => TIER_DEVICE.find((m) => m.name === k),
    { now: _NOW, recentMs: 30 * 60 * 1000 },
  )
  const ok = !c.orphan && c.kind === 'ok-idle-wakeable'
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `kind=${c.kind} 证据=${c.evidence}` }
})

check('★★③d `inactive` + **拿不到**证据 ⇒ **未获取**（不许判孤儿）', 'unverified', () =>
  analyzeOrphans({
    tasks: [{ id: 't', status: 'in_progress', ownerName: 'nohint-dev' }],
    members: TIER_DEVICE,
    now: _NOW,
  }))

check('★★③d 未获取档**不参与红/绿**：只有"不在名单"的才算孤儿', 'green', () => {
  const r = analyzeOrphans({ tasks: [{ id: 't', status: 'in_progress', ownerName: 'nohint-dev' }], members: TIER_DEVICE, now: _NOW })
  // 期望：verdict=unverified（exit=2），**不是** orphans（exit=1）—— 不许把"判不了"当孤儿
  const ok = r.verdict === 'unverified' && r.exitCode === EXIT.unverified && r.orphans.length === 0
  return { verdict: ok ? 'ok' : 'red', exitCode: ok ? EXIT.ok : EXIT.red, why: `verdict=${r.verdict} exit=${r.exitCode} orphans=${r.orphans.length}` }
})

check('★★③d 混合装置：真孤儿（不在名单）红，可唤醒的不红', 'red', () => {
  const r = analyzeOrphans({
    tasks: [
      { id: 't-run', status: 'in_progress', ownerName: 'running-dev' },
      { id: 't-wake', status: 'in_progress', ownerName: 'writing-dev' },
      { id: 't-ghost', status: 'in_progress', ownerName: 'ghost-dev' },   // ★ 唯一真孤儿
    ],
    members: TIER_DEVICE,
    now: _NOW,
  })
  // 只应报 1 条（ghost）；writing-dev 不许出现在孤儿里
  if (r.orphans.length !== 1 || r.orphans[0].id !== 't-ghost') {
    return { verdict: 'red', exitCode: EXIT.red, why: `孤儿=${JSON.stringify(r.orphans.map((o) => o.id))}（应只有 t-ghost）` }
  }
  return { verdict: 'orphans', exitCode: EXIT.red, why: `孤儿=${r.orphans.map((o) => o.id).join(',')}（正确：只有不在名单的那个）` }
})

// ═══ ④ verify-route（402 链必须红）═══════════════════════════════════════
check('④ verify-route：402 链 ⇒ 报红', 'red', () => routeVerdict('deepseek-official'))
check('④ verify-route：可用链 ⇒ 绿', 'green', () => routeVerdict('superdeepseek'))
check('④ verify-route：未知链 ⇒ 未获取（不猜）', 'unverified', () => routeVerdict('some-other')) 
check('④ verify-route：空 provider ⇒ 未获取', 'unverified', () => routeVerdict(''))

// ── ★★ 变异测试：**证明这套断言真的会拦** ──────────────────────────────────
//
// 为什么要做：本项目反复栽在"**有机制的样子**当成机制"。
// 一套断言如果**永远不会红**（正则写错、装置没覆盖到），它比没有更坏（给虚假安全感）。
// ⇒ 所以这里**主动把规则改坏一次**，要求断言**当场变红**；不红就是本文件有缺陷。
//
// ## ★★★ 设计约束（我第一版违反了，被 CEO 判为**结构性缺陷** —— 这条比"加固"更根本）
// **不许"改产品文件来测判据"。**
// 我第一版的形态是：`writeFileSync(变异)` → 跑判据 → `writeFileSync(还原)`。
// 它的毛病**不是"可能被打断"那么轻**：
// ```
// · 每个变异都有一个**"产品文件处于坏状态"的窗口**（窗口 = 写入→还原的全部耗时）
// · ★ 更糟：脚本读的"原文"就是**盘上当前那份** ⇒
//   一旦某轮被打断留下变异体，**下一轮读到的"原文"已是变异体**
//   ⇒ 它会"忠实地"把变异体当原文、再把另一个变异叠上去 ⇒ **自锁**，越跑越坏
//   ⇒ 现场：CEO 看到 L199 好了、**L271 又出现**；再跑一次 M3 报"注入点找不到" —— **全是这一个病**
// ```
// ⇒ **正确设计（CEO 要求）**：**变异只发生在【临时副本】上，产品文件全程只读**。
//   做法：把 `orphans.js` 复制到 `mkdtempSync()` 出的临时目录 ⇒ 在**副本**上注入 ⇒
//        子进程用 **`TEAMKIT_ORPHANS_MODULE`** 环境变量指到副本 ⇒ 断言从副本 import。
//
// ★ **自证判据（写进输出，不靠我口头保证）**：
//   跑完变异测试 ⇒ **产品文件的 sha256 必须与跑前相同** ⇒ 不同就报红。
//   机械可核：`git diff --name-only -- plugin/` 跑前跑后必须相同。
//
// 变异点（四处，各对应一条不变量）：
//   M1 把"认 status"改成"认 phase"        ⇒ 必须被 ★★① 那组抓住
//   M2 把"members 为空 ⇒ 未获取"改成"绿"  ⇒ 必须被 ③ 诚实条抓住
//   M3 把 402 链的判定反转                ⇒ 必须被 ④ 抓住
//   M4 ★★ 把 `idle` 判成孤儿（**假红**）   ⇒ 必须被 ③c 抓住
function runMutationTest() {
  const srcPath = new URL('../lib/orphans.js', import.meta.url)
  const productPath = fileURLToPath(srcPath)
  // ★ 跑前取产品文件指纹 —— 跑完必须**一模一样**
  const beforeHash = createHash('sha256').update(readFileSync(productPath)).digest('hex')
  const src = readFileSync(productPath, 'utf8')

  const mutants = [
    {
      name: 'M1 认 phase 冒充活跃（"僵尸活跃"错法）',
      from: "  const st = m.status === undefined || m.status === null ? '' : String(m.status)",
      to: "  const st = m.phase === 'active' ? 'running' : (m.status === undefined || m.status === null ? '' : String(m.status))  // MUTANT",
      mustFail: '★★① 判别性：phase=active 与 status=idle 矛盾时',
    },
    {
      name: 'M2 members 为空时返回绿（假"没有孤儿"）',
      from: "  if (members.length === 0) {",
      to: "  if (false) {  // MUTANT",
      mustFail: '③ 诚实条：members 为空数组',
    },
    {
      name: 'M3 把 402 链当可用链',
      from: "  if (blocked.includes(p)) {",
      to: "  if (false) {  // MUTANT",
      mustFail: '④ verify-route：402 链',
    },
    {
      name: 'M4 把 idle 判成孤儿（**假红** —— COO 抓到的那个形态）',
      from: "  if (st === 'idle') {",
      to: "  if (false) {  // MUTANT",
      mustFail: '★★③c `idle` 的 owner 不许报孤儿',
    },
  ]

  // ★ 临时目录：**所有变异都写在这里**（产品文件永不被写）
  const tmpDir = mkdtempSync(join(tmpdir(), 'teamkit-mut-'))
  const results = []
  try {
    for (const mu of mutants) {
      // 每个变异用**独立副本**（互不污染；且都从**干净原文**复制）
      const copyName = 'orphans-' + createHash('sha1').update(mu.name).digest('hex').slice(0, 8) + '.mjs'
      const copyPath = join(tmpDir, copyName)
      if (!src.includes(mu.from)) {
        results.push({ name: mu.name, ok: false, why: `变异注入点找不到（源码变了？）：${mu.from.slice(0, 50)}` })
        continue
      }
      writeFileSync(copyPath, src.replace(mu.from, mu.to), 'utf8')
      let out = ''
      let code = 0
      try {
        // ★ 子进程用 `--module=<副本>` ⇒ 断言从**副本** import ⇒ **产品文件全程只读**
        out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--json', '--no-mutation', `--module=${copyPath}`], {
          encoding: 'utf8',
        })
        code = 0
      } catch (e) {
        out = String(e.stdout ?? '')
        code = e.status ?? 1
      }
      const caught = code !== 0 && /FAIL/.test(out)
      results.push({ name: mu.name, ok: caught, why: caught ? `断言当场报红（exit=${code}）` : `**没抓住**（exit=${code}）⇒ 这套断言有缺口` })
    }
  } finally {
    // 只删自己的临时目录（**产品文件从头到尾没被碰过**）
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  // ★★ **自证**：跑完产品文件必须一字未改（sha256 相同）
  const afterHash = createHash('sha256').update(readFileSync(productPath)).digest('hex')
  const productIntact = beforeHash === afterHash
  if (!productIntact) {
    // 这条**必须红** —— 它意味着"变异测试动了产品文件"，正是本条设计要根除的形态
    results.push({
      name: '★ 不变量：变异测试**不许改动产品文件**',
      ok: false,
      why: `**产品文件被改了！** 跑前 ${beforeHash.slice(0, 12)} ≠ 跑后 ${afterHash.slice(0, 12)}（> 本设计失效）`,
    })
  } else {
    results.push({
      name: '★ 不变量：变异测试**不改动产品文件**（sha256 前后相同）',
      ok: true,
      why: `product ${beforeHash.slice(0, 12)} 未变（变异只在临时副本上）`,
    })
  }
  return results
}
/**
 * ★★ **交叉一致性**（仓内专有；包内**跳过**，不是失败）。
 *
 * 【为什么要】`notes/coo/coo-liveness-divergence.mjs` 是 COO 的**独立第二实现**
 * （不同代码、同判据）。**两份独立实现给出同一答案** ⇒ 比"一份自证"强得多
 * （COO 原话：这叫"独立的第二条尺"）。
 *
 * 【我实测到的真实差异 —— 这是本用例存在的原因】
 * 我第一版**数 2、COO 数 1**：因为我把"在册但 `idle`"也算进了**主分叉指标**。
 * 两种都能自圆其说，但 COO 已公布 `22 vs 7 = 分叉 15` ⇒ **口径必须一致**，否则两个数没法比。
 * ⇒ 已改：主指标严格按"**`agents.list()` 里解析不出**"（COO 口径），
 *    "在册但非活跃"另放 `presentButIdle`（**信息不丢，但不污染主数字**）。
 * ⇒ 本用例把这条口径**钉住**（防下一个人改回去）。
 *
 * ⚠️ **`notes/` 不在 `package.json` 的 `files` 白名单里** ⇒ 开源用户机器上没这个文件
 *   ⇒ 找不到就报 **跳过（仓内专有）**，**不是 FAIL**（`repoOnly` 同族纪律）。
 */
async function runCrossConsistency() {
  let coo
  try {
    coo = await import(new URL('../../notes/coo/coo-liveness-divergence.mjs', import.meta.url).href)
  } catch {
    return { skipped: true, reason: 'notes/coo/coo-liveness-divergence.mjs 不在（包内布局）⇒ 跳过（仓内专有）' }
  }
  // 同一装置：journal 说 3 个 active；进程内只解析得出 2 个，其中一个在册但 idle
  const journalMembers = [
    { id: 'a', name: 'alive-1', phase: 'active' },
    { id: 'b', name: 'alive-2', phase: 'active' },
    { id: 'c', name: 'zombie', phase: 'active' },
  ]
  const liveMembers = [
    { id: 'a', name: 'alive-1', status: 'running' },
    { id: 'b', name: 'alive-2', status: 'idle' },
  ]
  const mine = crossCheckLiveness(journalMembers, liveMembers)
  const theirs = coo.computeDivergence({ journalMembers, liveIds: liveMembers.map((m) => m.id) })
  const sameCount = mine.diverged.length === theirs.divergentCount
  const sameNames = JSON.stringify(mine.diverged.map((d) => d.name)) === JSON.stringify(theirs.divergentNames)
  const sameVerdict = (mine.exitCode === EXIT.red) === (coo.verdictOf(theirs).code === 1)
  const ok = sameCount && sameNames && sameVerdict
  return {
    skipped: false,
    ok,
    why: `我的 diverged=${mine.diverged.length}${JSON.stringify(mine.diverged.map((d) => d.name))}`
      + ` vs COO divergentCount=${theirs.divergentCount}${JSON.stringify(theirs.divergentNames)}`
      + `；presentButIdle=${mine.presentButIdle.length}（**不计入主指标** —— 与 COO 口径一致）`,
  }
}

// ── ★ 报告前：`--demonstrate-red` 单独入口（CEO 要的第 ⑦ 条）──────────────────
//
// 【为什么要】"我知道判据会红"与"我见过它红"是两件事。
//   ⇒ 本入口**在临时副本上**注入一个已知错误，打印子进程的**红输出**，
//     证明"判据还灵"，且**不碰产品文件**（并自证 sha256 前后相同）。
if (process.argv.includes('--demonstrate-red')) {
  demonstrateRed()   // 内部 process.exit（0 = 红了且产品未变 / 1 = 没红或产品被改）
}

/**
 * ★★ **变异红输出现场演示**（CEO 要的第 ⑦ 条：`--demonstrate-red`）。
 *
 * 【为什么单列】"我知道判据会红"与"我见过它红"是两件事。
 *   本函数**在临时副本上**注入一个已知错误 ⇒ 子进程从副本 import ⇒ 打印它的**红输出**
 *   ⇒ 证明"判据还灵"，并且**自证产品文件 sha256 前后相同**。
 * @returns never（内部 process.exit）
 */
function demonstrateRed() {
  const productPath = fileURLToPath(new URL('../lib/orphans.js', import.meta.url))
  const before = createHash('sha256').update(readFileSync(productPath)).digest('hex')
  const src = readFileSync(productPath, 'utf8')
  const tmpDir = mkdtempSync(join(tmpdir(), 'teamkit-reddemo-'))
  const copyPath = join(tmpDir, 'orphans-demo.mjs')
  let out = ''
  let code = 0
  try {
    // 演示变异：把"空名单 ⇒ 未获取"改成"空名单 ⇒ 当没问题"（= 假的"没有孤儿"）
    writeFileSync(copyPath, src.replace('  if (members.length === 0) {', '  if (false) {  // DEMO-MUTANT'), 'utf8')
    try {
      out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--json', '--no-mutation', `--module=${copyPath}`], { encoding: 'utf8' })
      code = 0
    } catch (e) {
      out = String(e.stdout ?? '')
      code = e.status ?? 1
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const after = createHash('sha256').update(readFileSync(productPath)).digest('hex')
  const L = []
  L.push('★ 变异红输出演示（注入在**临时副本**上，产品文件只读）')
  L.push(`  子进程 exit = ${code}    （期望 ≠ 0 ⇒ 判据确实会红）`)
  L.push(`  产品文件 sha256 跑前 = ${before.slice(0, 16)}`)
  L.push(`  产品文件 sha256 跑后 = ${after.slice(0, 16)}   ${before === after ? '★ 未变（正确）' : '**被改了！**'}`)
  try {
    const j = JSON.parse(out)
    L.push(`  子进程判定 = ${j.verdict}`)
    for (const c of (j.cases ?? []).filter((x) => !x.ok)) L.push(`    XX ${c.name}`)
  } catch {
    L.push('  （子进程输出非 JSON —— 下面是它的原始输出前几行）')
    for (const l of out.split('\n').slice(0, 6)) L.push('    ' + l)
  }
  process.stdout.write(L.join('\n') + '\n')
  process.exit(code !== 0 && before === after ? 0 : 1)
}
const bad = cases.filter((c) => !c.ok)
// ★ 变异测试（默认跑；`--no-mutation` 时跳过 —— 那是子进程防递归用的）
//   ⚠️ `--module=<副本>` 时**也跳过**：那是"被演示/被测"的那一层，不该再递归跑变异。
const mutations = noMutation || !MODULE_IS_PRODUCT ? null : runMutationTest()
const mutBad = mutations === null ? [] : mutations.filter((m) => !m.ok)
const cross = noMutation || !MODULE_IS_PRODUCT ? null : await runCrossConsistency()
const crossBad = cross !== null && !cross.skipped && !cross.ok
const code = bad.length > 0 || mutBad.length > 0 || crossBad ? 1 : 0

if (asJson) {
  process.stdout.write(JSON.stringify({ verdict: code === 0 ? 'PASS' : 'FAIL', cases, mutations, cross, code }, null, 2) + '\n')
} else {
  process.stdout.write('孤儿巡检规则 · 能红断言（task-107 §五）\n')
  process.stdout.write('（① 活跃性只认 agents.list ② 三态不许混 ③ 两种孤儿要分开 ④ 402 链必须红）\n\n')
  for (const c of cases) {
    process.stdout.write(`  ${c.ok ? 'OK  ' : 'XX  '} ${c.name}\n`)
    process.stdout.write(`         期望=${c.expect} 实际=${c.got}${c.why ? '  ← ' + c.why : ''}\n`)
  }
  process.stdout.write(`\n判定：${code === 0 ? 'PASS' : 'FAIL'}（${cases.length - bad.length} 通过 / ${bad.length} 失败）\n`)
  if (bad.length > 0) process.stdout.write('  ⇒ 有用例没按预期红/绿 ⇒ **本规则自身有缺陷，必须修**（不是改断言的期望值）\n')
  if (mutations !== null) {
    process.stdout.write('\n★ 变异测试（把规则改坏 ⇒ 要求这套断言**当场报红**）：\n')
    for (const m of mutations) process.stdout.write(`  ${m.ok ? 'OK  ' : 'XX  '} ${m.name}\n         ${m.why}\n`)
    process.stdout.write(`  变异判定：${mutBad.length === 0 ? `PASS（${mutations.length} 处变异都被抓住 ⇒ 断言不是摆设）` : `FAIL（${mutBad.length} 处没抓住 ⇒ 断言有缺口）`}\n`)
  }
  if (cross !== null) {
    process.stdout.write('\n★ 交叉一致性（与 COO 的**独立第二实现**对同一装置取数）：\n')
    process.stdout.write(cross.skipped
      ? `  跳过：${cross.reason}\n`
      : `  ${cross.ok ? 'OK  ' : 'XX  '} ${cross.why}\n`)
  }
}
process.exit(code)
