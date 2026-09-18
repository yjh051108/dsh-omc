/**
 * probe-gate.js —— **在线拦**：把 `R2` 探针纪律挂到宿主的工具调用管线里（2026-09-14 / task-92）。
 *
 * ## 它解决什么（`task-85` 的遗留，CEO 点名）
 * `task-85` 交付了 `checkProbeSource` + `teamkit probe-check` ⇒ 那是**离线检**（**有得检**）。
 * 但 **两次事故的探针都走 `dev_stage_add` 的 inline execute、从不落盘** ⇒
 * **没有任何机制强制探针作者先跑 `probe-check`** ⇒ **「能检」≠「会被检」**。
 * ⇒ 本模块用**底座自带的文档化扩展口**把闸门接到**必经之路**上。
 *
 * ## 底座扩展口（读源码得来，非 hack）
 * ```js
 * // dsh-tools/lib/index.js:2816-2821
 * guard(guard) { return this.layers.effect(this.ctx, layer => layer.guards.append(guard), …) }
 * // :2823-2831  guardReason(exec)：**先 global 层，再 scope 链**
 * // :3127-3139  返回**字符串** ⇒ 包成 `Error: <reason>` 回模型 ⇒ **真拒绝该次调用**
 * ```
 *
 * ## ⚠️⚠️ 生效范围：**不是 global 层 —— 按挂载方式而定**（**真读数推翻了我先前的推断**）
 *
 * ★ **留痕（原推断 vs 真读数，两边都留着 —— 不许只留后者）**：
 * ```
 * ❌ 原推断（读源码得出，total工程师写的，**曾被 CEO 采纳**）：
 *    dsh-scope/lib/index.js:189-203  effect(ctx,…)：scopeOf(ctx) === undefined ⇒ layer = this.global
 *    而插件 apply 拿到的 ctx「就是宿主 ctx」（PLUGIN-SCOPE.md：`ctx.get('scope')` = undefined）
 *    ⇒ **推断**我们的 guard 在 global 层 ⇒ 对全宿主生效。
 *
 * ✅ 真宿主只读探针（2026-09-14，在活宿主里**真调**，非读码）：
 *    tools.layers.global.guards = **[]（空）**                      ⇒ **本闸不在 global 层**
 *    tools.layers.scoped 里持有本闸的那一层，key = **{"agentPreset":"omc"}**
 *    逐个 agent 真调 `tools.guardReason({name:'dev_stage_add', agent, arguments:{execute:<违规源码>}})`：
 *      session-449fe43b (closedloop-full, root)  ⇒ denied = **true**（被拦）
 *      session-fa986645 (standard, root)         ⇒ denied = **false**（**没被拦**）
 *      00bad638-7cf0    (standard, child)        ⇒ denied = **false**
 *      02b63878-b80a    (standard, child)        ⇒ denied = **false**
 *    ⇒ **实测：`standard` 的 agent 都没被覆盖。**
 * ```
 * ⇒ **准确说法**：本闸挂在**挂载它的那个 preset realm 的 scope** 上（当前 = `{"agentPreset":"omc"}`）；
 *   **`standard` 预设的 agent 不在它的 scope 链上 ⇒ 不被拦**。
 * ⇒ ⚠️ **开源前的已知缺口**：**「`standard` 成员的坏探针目前没人拦」**（这是缺口的准确形状）。
 *   **不许说成「全宿主都有保护」**（那是假的 —— 而假信息比漏写更糟）。
 * ⇒ ⬜ **仍未获取**：那次采样里 `closedloop-full` 的 root 为什么被拦（**有读数但解释不了，不编**）。
 * ⇒ **待验推论（未验，别当结论）**：`dev_inject_plugin` **宿主注入** ⇒ ctx 无 scope ⇒ **可能**落 global；
 *   经预设**挂载** ⇒ 带 preset scope ⇒ 只覆盖该 realm。
 *   **判据**：两种装载方式各跑一次 `guardReason` 对照。
 *   （这也解释了两份文档为何互相矛盾：`PLUGIN-SCOPE.md` 测的是**注入**形态，本次测的是**预设挂载**形态。）
 *
 * ## ★ 硬约束（`engineering-director` 核出，必须守）
 * ### ① **liveness：这是每一次工具调用都会进的函数**
 * `guardReason` 在**每一次"被允许的工具调用"**上都会被调（`:2824` 先查 global，再走 `chainLayers(exec.agent)`）
 * ⇒ **落在哪个层都在热路径上** ⇒ 该 scope 链上**每个 agent 的每一次工具调用都会进我们的 guard**
 * （而**不管它落在哪一层**）。⇒ 因此实现上**必须**：
 *   1. **第一行就判 `exec?.name !== 'dev_stage_add'` ⇒ 立刻 `return undefined`**（O(1)、无副作用、不读盘）；
 *   2. **整体 `try/catch` ⇒ 出错一律放行（fail-open）** —— 护栏故障**绝不许**挡住正常工作；
 *   3. **任何路径上都不 `await`**（guard 是**同步**接口）、**不读盘**、**不抛**。
 *
 * ## ⚠️ 覆盖范围（**诚实边界，不许升格**）
 * ```
 * ✅ 覆盖：**挂载本闸的那个 preset realm**（当前 = `omc`）里的 `dev_stage_add` 调用
 * ⚠️ **不覆盖 `standard` 等其它预设**（真读数：那 3 个 agent `denied=false`）
 *         ⇒ **开源前的已知缺口**（`standard` 成员的坏探针目前没人拦）
 * ❌ 不覆盖：`pwsh` / `node -e` 内联脚本改共享对象（**看不到**）
 *         · guard 注册**之前**已 staged 的工具（**没检过**）
 *         · 别的注入路径 / 别的插件
 * ⇒ 准确说法：**「把两次事故走的那条路拦住了」**，**不是**「R2 机械化了」，
 *   也**不是**「全宿主都有保护」。
 * ```
 */
import { checkProbeSource } from './probe-source.js'

/** 我们要拦的目标工具名（**单一事实来源**：判据与文档都读它）。 */
export const GATED_TOOL = 'dev_stage_add'

/**
 * 造**拒绝理由**（自带修法 —— 这是"默认 true 不误杀"的前提之一）。
 * ⚠️ 必须是**纯字符串拼接**（不读盘、不抛）。
 */
export function denialReason(violations) {
  const first = Array.isArray(violations) && violations.length > 0 ? violations[0] : undefined
  const where = first === undefined ? '' : `（首处在第 ${first.line} 行，形态 \`${first.kind}\`）`
  return (
    `【R2 探针纪律】这支 execute 往"会被持久化的共享对象"写字段/改原型，且**作用域内无回读校验** ⇒ **拒装**。${where}` +
    '\n修法二选一：① 只读验证走**副本**（clone 再改）或**旁路观测**（读回原值比较）；' +
    '② 若确需包装 ⇒ **同一次调用内还原 + 回读校验"已还原"**（`=== 原值` 那种**代码**，' +
    '**只写注释说"我会还原"不算证据**）。' +
    '\n（判据 `RULES.yml R2`；离线自查：`teamkit probe-check <file>` 或 `--stdin`。）'
  )
}

/**
 * 造那个 guard 函数（**纯函数、可直接单测**，不必有真宿主）。
 *
 * @param opts.enabled 是否启用（`false` ⇒ 返回 `undefined`，**一个 guard 都不注册**）
 * @param opts.log     日志（只用于**注册/卸载**，**不在 guard 内调用** —— guard 里不许有副作用）
 * @returns guard 函数，或 `undefined`（未启用）
 */
export function makeProbeGateGuard({ enabled = true } = {}) {
  if (enabled !== true) return undefined
  return function probeGateGuard(exec) {
    // ★★ **约束②-1：第一行就是 O(1) 短路** —— 非目标工具立刻放行，不做任何其它事。
    //   （这条是 liveness：宿主里**每一次**工具调用都进这里。）
    if (exec?.name !== GATED_TOOL) return undefined
    try {
      const src = exec?.arguments?.execute
      // 不是字符串（比如别的地方改了 schema）⇒ 不归我们管 ⇒ 放行
      if (typeof src !== 'string') return undefined
      const r = checkProbeSource(src)
      if (r.ok === true) return undefined // 合规 ⇒ 放行
      return denialReason(r.violations)
    } catch {
      // ★★ **约束②-2：fail-open** —— 护栏**自己出错绝不许挡住正常工作**。
      //   ⚠️ 这里**连日志都不打**：guard 在每次调用时都会跑，写日志=副作用+可能成为新的故障面。
      return undefined
    }
  }
}

/**
 * 把闸门注册到宿主的 `tools` 上（**可卸净**）。
 *
 * @param ctx  宿主插件 ctx（要有 `tools.guard`）
 * @param opts.enabled 是否启用
 * @param opts.log
 * @returns `{ ok, why?, dispose? }`
 */
export function registerProbeGate(ctx, { enabled = true, log = () => {} } = {}) {
  if (enabled !== true) {
    // ★ 逃生开关：**关掉要在日志里显式说明**（"这道闸已关"）—— 不许静默。
    log(
      'PROBE-GATE-OFF **这道闸已关**（`probeGate.enabled=false`）：' +
        '`dev_stage_add` **不再**校验 `R2` ⇒ 违规探针**可以装进去**。这是显式选择，不是故障。',
    )
    return { ok: false, why: 'disabled' }
  }
  const tools = ctx?.tools
  if (tools === undefined || typeof tools.guard !== 'function') {
    // **失败不静默**
    log('PROBE-GATE-NOT-REGISTERED `ctx.tools.guard` 不可用 ⇒ **这道闸没装上**（底座变了吗？）—— 不是"已生效"')
    return { ok: false, why: 'no-tools.guard' }
  }
  const guard = makeProbeGateGuard({ enabled: true })
  if (guard === undefined) return { ok: false, why: 'guard-not-built' }
  let dispose
  try {
    dispose = tools.guard(guard)
  } catch (err) {
    log(`PROBE-GATE-REGISTER-FAIL why=${err?.message ?? err}`)
    return { ok: false, why: `register-failed（${err?.message ?? err}）` }
  }
  if (typeof dispose !== 'function') {
    log('PROBE-GATE-NO-DISPOSER `tools.guard` 没返回 disposer ⇒ **无法保证卸净**（底座变了吗？）')
    return { ok: false, why: 'no-disposer' }
  }
  log(
    `PROBE-GATE-ON 已装上：拦 \`${GATED_TOOL}\` 的 R2 违规（返回字符串即拒绝）。` +
      '⚠️ **生效范围 = 挂载本闸的那个 preset realm**（真读数：`standard` 的 agent **未被覆盖** ——' +
      '**这是已知缺口**，见本文件头与 `RULES.yml R8`）。**不许理解成"全宿主都有保护"。**',
  )
  return {
    ok: true,
    dispose: () => {
      try {
        dispose()
      } catch (err) {
        log(`PROBE-GATE-DISPOSE-FAIL why=${err?.message ?? err}`)
      }
    },
  }
}
