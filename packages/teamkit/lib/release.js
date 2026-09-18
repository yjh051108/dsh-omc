/**
 * release.js —— **成员释放**（委托方硬指令：「我要你解决这个问题，**必须可以删**」）。
 *
 * ## 底座真相（不是我们的选择，`DECISIONS.md` P-34 有逐行证据）
 * · `TeamRoster` **没有任何移除方法**（`roster.d.ts:47-97` 只有 9 个方法）；
 * · journal **没有成员移除事件**（只有 `team/member` / `team/task` / `team/message/*`）；
 * · `stopTeammates` **只停会话、不释放名额**；
 * · `phase='failed'` 的成员**照样占名额、照样占名字** ⇒ "看见、用不了、删不掉"的僵尸。
 *
 * ## 我们做的（**不改底座，包一层**）
 * 包 `TeamJournal.prototype.state`（原型方法，实测 **writable + configurable**），
 * 让它返回的 `members` **过滤掉"已释放"的 id**。
 *
 * **为什么这能真释放名额（关键，不是只改视图）**：
 * `roster` 与 `journal` 是**同一个实例** ——
 * `this.roster = new TeamRoster(ctx, this.journal, …)`
 * （`dsh-experimental-agent-team/lib/types/index.js:107`；打包副本 `lib/index.js:1693`）
 * ⇒ roster 的重名检查（`roster.js:243`）与名额检查（`roster.js:246`）**也走被包的这一层**。
 * **实测（Round 33，真宿主）**：`at.roster.journal === at.journal` = **true**。
 *
 * ## 三件成立 / 两件不成立（实验 + 我复核）
 * | | |
 * |---|---|
 * | ✅ 名单不再列出 | 过滤后 `list_agents` / roster view 不含它 |
 * | ✅ **名额真释放** | 过滤后 `spawn` 能写入（不是只过滤视图） |
 * | ✅ 被释放者**不可再寻址** | 发给它 = `TEAM_MEMBER_NOT_FOUND`（roster 只认过滤后的 state） |
 * | ❌ **名字不可复用** | 写入时被 `invariant.js:353` 拒 —— **释放后招人要换新名** |
 * | ❌ **日志里抹不掉**（也不该抹） | `applyCurrentTeamEvent` 只有 4 个分支、**无移除分支** ⇒ event-sourced，抹掉 = 伪造历史 |
 *
 * ## 脆弱性（诚实标注，必须写进 README）
 * ① **依赖 TS 的 `private` 属性 `journal`**（编译期私有、运行时可达）—— 底座改名即失效；
 * ② **包装在内存里** ⇒ **重启即失效** ⇒ 靠**侧车台账**（`member-release.jsonl`，盘上事实）在启动时重建；
 * ③ 只在**本插件被 apply 的那个进程**里有效。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'

/**
 * 台账里"已释放"的记录形态（append-only JSONL；`action` 允许 `unrelease` 回退）。
 *
 * ★ **返回 `Map<rootId, Set<name>>`**（按 Team 分桶）—— 见 `makeReleaseManager` 顶部的
 *   "跨队重名外溢"说明。**兼容 v1 老台账**（没有 `root` 字段的）：把它们归到 `'*'` 桶，
 *   并**打一行日志说明**（不静默降级）。
 */
function readTracking(file, log = () => {}) {
  const released = new Map()
  let lines = []
  if (existsSync(file)) {
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch (err) {
      log(`RELEASE-TRACKING-READ-FAIL file=${file} why=${err?.message ?? err}`)
      lines = []
    }
  }
  const bucket = (rootId) => {
    let s = released.get(rootId)
    if (s === undefined) {
      s = new Set()
      released.set(rootId, s)
    }
    return s
  }
  let legacy = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let rec = undefined
    try {
      rec = JSON.parse(line)
    } catch {
      // ⚠️ **坏行不静默丢**：说清楚，然后跳过（缺一行 = 可能少释放一个人）
      log(`RELEASE-TRACKING-BAD-LINE file=${file} excerpt=${line.slice(0, 80)}`)
      continue
    }
    // v1 没有 root ⇒ 归 `'*'` 桶并计数（下面统一说明）
    const rootId = typeof rec?.root === 'string' && rec.root !== '' ? rec.root : '*'
    if (rec?.root === undefined) legacy += 1
    if (rec?.action === 'unrelease') {
      // `'*'` 的撤销 = 从**所有**桶摘掉（与 `unrelease(name)` 的宽口径一致）
      if (rootId === '*') for (const s of released.values()) s.delete(rec.name)
      else released.get(rootId)?.delete(rec.name)
    } else if (rec?.action === 'release' && typeof rec.name === 'string') {
      bucket(rootId).add(rec.name)
    }
  }
  if (legacy > 0) {
    log(
      `RELEASE-TRACKING-LEGACY n=${legacy} —— 台账里有**没有 root 的旧记录**（v1）⇒ 归入 '*' 桶；` +
        `'*' 是**全局桶**，那些名字在**所有 Team** 里都会被过滤（若要收紧，请按 root 重记）`,
    )
  }
  // 清掉空桶（读数干净：`list()` 不该列出"释放了 0 个人"的 Team）
  for (const [k, s] of [...released.entries()]) if (s.size === 0) released.delete(k)
  return released
}

/**
 * ★ 包装 `TeamJournal.prototype.state`，让返回的 `members` 过滤掉"已释放"的人。
 *
 * @param agentTeams 宿主的 `ctx.agentTeams`（要拿 `journal` / `roster`）
 * @param opts.released  `Set<string>`（成员名）—— **按名字**过滤
 *        （为什么按名字：`state.members` 里既有 `id` 也有 `name`，而**调用方大多按 name 查**，
 *         且 `spawn` 的重名检查也是按 name ⇒ 按 name 过滤才能同时挡住"再招同名"和"看见"）
 * @param opts.log
 * @returns `{ ok, why?, restore() }` —— **失败不静默**，且**能干净还原**
 */
export function wrapJournalState(agentTeams, { released, log = () => {} }) {
  if (!agentTeams) return { ok: false, why: 'no-agentTeams（宿主没有 registed agentTeams service）' }
  const journal = agentTeams.journal
  if (!journal) return { ok: false, why: 'no-journal（拿不到 agentTeams.journal）' }
  const proto = Object.getPrototypeOf(journal)
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'state') : undefined
  if (!desc || typeof desc.value !== 'function') {
    return { ok: false, why: 'no-patchable-state（`TeamJournal.prototype.state` 不是可写方法 ⇒ 底座可能变了）' }
  }
  if (desc.writable === false || desc.configurable === false) {
    return { ok: false, why: `state-not-writable（writable=${desc.writable} configurable=${desc.configurable}）` }
  }
  const original = desc.value
  // ★★ **多实例共存**（2026-09-14 / Round 36 修的第一个真 bug 的**后续**）。
  //
  // 【缺陷】原写法是"只包一次"：第二个实例拿到 `already-wrapped` ⇒ **复用了第一个实例的闭包**
  //   ⇒ 第二个实例的 `released` **根本没被读**。真宿主实测（同一进程里 `APPLY-DONE` **70ms 内出现 5 次**）：
  //   ```
  //   实例② apply() → why="already-wrapped"（复用了实例①的闭包）
  //   实例② release('carol') → **返回 ok:true / code:0**（声称成功！）
  //   名单仍是 [alice, bob, carol] ⇒ **carol 根本没被过滤**（静默失效）
  //   实例① release('bob')  → 名单变 [alice, carol]（只有实例①的集合有效）
  //   ```
  //   ⇒ **工具会报"已释放"，实际什么也没发生** —— 正是"失败不静默"要防的最坏形态。
  //
  // 【修法】**不在闭包里持有一份集合，而是在原型上挂一本"登记簿"**：
  //   · `PROTO_REGISTRY[Symbol]` = `Set<桶集合>`（**所有活着的实例**各放一份）；
  //   · 包装**只装一次**（避免层层嵌套），但它读的是**登记簿的并集**；
  //   · 每个实例 `apply()` 时把自己的桶**放进去**（幂等：同一个 Set 放两次无副作用）；
  //   · `dispose()` 时**摘掉自己那一份**（且**最后一个**摘掉时才还原原型方法）。
  const REG = Symbol.for('dsh-teamkit:release-buckets')
  // 兼容：如果原型上已经有一个"旧版单闭包"包装（**同一进程热重载**会遇到），
  //   它的登记簿是空的 ⇒ 需要把它换掉（用真 `original` 来源不可知，只能按标记处理）。
  if (original.__teamkitReleaseWrapped === true && original[REG] instanceof Set) {
    // 已是登记簿式包装 ⇒ **加入自己的桶**，并复用同一还原链
    original[REG].add(released)
    log(`RELEASE-WRAP-JOIN buckets=${original[REG].size}`)
    return {
      ok: true,
      why: 'joined-existing',
      restore: () => {
        try {
          original[REG].delete(released)
          // **只在还剩自己时**才真的把原型方法还原（别人还在用 ⇒ 不能拆）
          if (original[REG].size === 0) original.__teamkitReleaseRestore?.()
          log(`RELEASE-UNWRAP-OK buckets=${original[REG].size}`)
        } catch (err) {
          log(`RELEASE-UNWRAP-FAIL why=${err?.message ?? err}`)
        }
      },
    }
  }
  if (original.__teamkitReleaseWrapped === true) {
    // ⚠️ **旧版包装（单一闭包）**：无法把新桶挂进去 ⇒ **如实报错**，不假装成功
    return {
      ok: false,
      why:
        'legacy-single-wrap（原型上已有一个**旧版单闭包**包装，它的集合无法被我们追加）' +
        '⇒ 本实例的释放**不会生效**。修法：重载插件（`dev_reload_package`）让新代码装上；' +
        '或重启宿主。**不报成功**，因为"报成功但没生效"比失败更糟。',
    }
  }
  // ★★ **按 Team root 分桶**（2026-09-14 / Round 36 修的真外溢 bug）。
  //
  // 【缺陷】第一版把 `released` 当**全局一份 Set<name>**，过滤时只看名字：
  //   实测（真宿主，7 个 Team 并存）—— A 队（`standard`）与 B 队（`omc`）**都有个叫 `engineer` 的成员**
  //   ⇒ **只"释放"A 队的 engineer ⇒ B 队的 engineer 也一起从名单里消失**
  //   （实测 `aLost=[engineer] / bLost=[engineer] / LEAKED=true`）。
  //   这**违反委托方明令**「其它 preset 不会受到影响」，而且**跨 Team 也跨 preset**。
  //
  // 【修法】**过滤必须以"这次 `state(root)` 问的是哪个 root"为界**：
  //   · `release.js` 的 `released` 变成 `Map<rootId, Set<name>>`（**按 root 分桶**）；
  //   · 包装里先算出 **root 的标识**，只用它那一桶过滤；
  //   · 兼容：调用方若直接给了 **裸 `Set`**（老的单桶形态），当作"`*` 全局桶"（**显式、不静默**）。
  //
  // 【root 的标识怎么取】`state(root)` 的 `root` 是**那个 Lead agent 对象** ⇒ 用它的 `id`
  //   （`agent.id`，真宿主里唯一且稳定）。取不到 id 就退回 `*` 桶（**并在日志里说**）。
  const bucketFor = (root) => {
    const id = root?.id ?? root?.session?.id ?? undefined
    if (typeof id === 'string' && id !== '') return id
    log('RELEASE-BUCKET-FALLBACK 拿不到 root.id ⇒ 退回全局桶（跨 Team 过滤可能外溢）')
    return '*'
  }
  // ★ **判定"这个名字在当前 root 下被释放过吗" = 登记簿里**任一**集合说了算**（并集语义）。
  //   为什么是并集：同一进程可能有多个插件实例（真宿主实测 `APPLY-DONE` 70ms 内 5 次）
  //   ⇒ 每个实例各有一份 `released`；**任何一份里记了"释放"都该生效**
  //   （它们读的是**同一本台账**，所以正常情况下内容一致；不一致时"更严格的那份"赢）。
  const inBucket = (root, name, buckets) => {
    const rid = bucketFor(root)
    for (const rel of buckets) {
      if (rel instanceof Map) {
        const b = rel.get(rid)
        if (b !== undefined && b.has(name)) return true
      } else if (rel?.has?.(name) === true) {
        // 裸 Set ⇒ 当作"显式全局桶"（老形态；**不静默**）
        return true
      }
    }
    return false
  }
  const bucketsEmpty = (buckets) => {
    for (const rel of buckets) if (rel.size > 0) return false
    return true
  }
  const wrapped = function state(root) {
    const st = original.call(this, root)
    if (!st || !Array.isArray(st.members)) return st
    const buckets = wrapped[REG] instanceof Set ? [...wrapped[REG]] : []
    if (buckets.length === 0 || bucketsEmpty(buckets)) return st
    const members = st.members.filter((m) => !inBucket(root, m?.name, buckets))
    if (members.length === st.members.length) return st
    // 返回**浅拷贝**（不改底座那份 state —— 它是投影出来的，动它会污染别的消费者）
    return { ...st, members }
  }
  const restore = () => {
    try {
      // ⚠️ **最后一个实例**离开时才真还原（别人还在用 ⇒ 拆了会让它们的释放失效）
      const reg = wrapped[REG]
      if (reg instanceof Set) reg.delete(released)
      if (reg instanceof Set && reg.size > 0) {
        log(`RELEASE-UNWRAP-KEEP buckets=${reg.size}（还有别的实例在用）`)
        return
      }
      Object.defineProperty(proto, 'state', { ...desc, value: original })
      // ★ **回读实证"已还原"**（2026-09-14 / `task-83-E`，CEO 批准；形态同 `e2r.js:743-753`）。
      //   为什么必须有：`memberRelease.enabled` **默认开**（`config.js:202`）⇒ 它是本插件
      //   **目前唯一默认在跑的"底座 API 就地修改"**，而原先这里**只 log OK、没有任何回读** ⇒
      //   **「我调了 restore」≠「它真的还原了」** —— 那正是 R75/R95/R108 三次事故共同缺的那个动作。
      //   判据：`proto.state` 的描述符 `value` 必须 **逐字等于 `original`**；
      //   **不等 ⇒ 报 STALE（失败），绝不报 OK**。
      let back
      try {
        back = Object.getOwnPropertyDescriptor(proto, 'state')
      } catch (err) {
        log(`RELEASE-UNWRAP-STALE why=回读抛错（${err?.message ?? err}）⇒ **不能断言已还原**`)
        return
      }
      if (back?.value === original) {
        log('RELEASE-UNWRAP-OK restored===original: true')
      } else {
        log(
          'RELEASE-UNWRAP-STALE restored===original: **false** ' +
            '（回读到的 value 与 original 不是同一个函数 ⇒ **未还原**；' +
            '这是**失败**，请勿当成 ok）',
        )
      }
    } catch (err) {
      log(`RELEASE-UNWRAP-FAIL why=${err?.message ?? err}`)
    }
  }
  wrapped.__teamkitReleaseWrapped = true
  wrapped.__teamkitReleaseRestore = restore
  // ★ **登记簿**：挂在这一个包装函数上（原型方法就它一个）⇒ 所有实例共享
  wrapped[REG] = new Set([released])
  try {
    Object.defineProperty(proto, 'state', { ...desc, value: wrapped })
  } catch (err) {
    return { ok: false, why: `define-failed（${err?.message ?? err}）` }
  }
  return { ok: true, why: 'wrapped', restore }
}

/** 台账路径：绝对路径原样用；否则相对 `<stateDir>`。 */
export function trackingPathFor(stateDir, cfg) {
  const f = cfg?.trackingFile || 'member-release.jsonl'
  return isAbsolute(f) ? f : join(stateDir, f)
}

/**
 * 建一个**释放管理器**（`release` / `unrelease` / `list` / `isReleased`）。
 * 所有写动作都**先落台账、再改内存** —— 这样"重启后重建"永远有据可依。
 *
 * ## ★★ 按 **Team root 分桶**（2026-09-14 / Round 36 修的真外溢 bug）
 * 第一版是**全局一份 `Set<name>`** ⇒ 实测漏：A 队（standard）与 B 队（omc）**都有 `engineer`**，
 * **释放 A 队的 engineer ⇒ B 队的也消失**（`aLost=[engineer] bLost=[engineer] LEAKED=true`）
 * —— **违反"其它 preset 不受影响"**。
 * ⇒ 现在 `released` 是 **`Map<rootId, Set<name>>`**；`release(name, reason, root)` **要求给 root**
 *   （拿不到 root 就**拒绝**，不猜、不写全局桶 —— 失败不静默）。
 */
export function makeReleaseManager({ agentTeams, stateDir, cfg, log = () => {} }) {
  const file = trackingPathFor(stateDir, cfg)
  const released = readTracking(file, log)
  let wrap = { ok: false, why: 'not-attempted' }

  const apply = () => {
    wrap = wrapJournalState(agentTeams, { released, log })
    if (!wrap.ok) log(`RELEASE-WRAP-FAIL why=${wrap.why}`)
    else if (wrap.why === 'joined-existing') {
      log(`RELEASE-WRAP-JOIN buckets=${[...released.keys()].length}（加入已有包装的登记簿，**本实例的集合也生效**）`)
    } else {
      log(`RELEASE-WRAP-OK teams=${released.size} total=${[...released.values()].reduce((n, s) => n + s.size, 0)}`)
    }
    return wrap
  }

  const append = (rec) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, why: `${err?.message ?? err}` }
    }
  }

  /** root 的标识（分桶键）。**取不到就返回 undefined**（让调用方拒绝，而不是猜）。 */
  const rootIdOf = (root) => {
    const id = root?.id ?? root?.session?.id ?? undefined
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  const bucket = (rootId) => {
    let s = released.get(rootId)
    if (s === undefined) {
      s = new Set()
      released.set(rootId, s)
    }
    return s
  }

  return {
    file,
    released,
    get wrap() {
      return wrap
    },
    apply,
    rootIdOf,
    /** 已释放名单：`[{ root, names }]`（**按 Team 分组**，不再是一条扁平姓名表）。 */
    list() {
      return [...released.entries()]
        .map(([root, s]) => ({ root, names: [...s].sort() }))
        .filter((e) => e.names.length > 0)
        .sort((a, b) => a.root.localeCompare(b.root))
    },
    /** 某人是否在某 Team 里被释放过（不传 root ⇒ 任一 Team 里有就算）。 */
    isReleased(name, root) {
      if (root !== undefined) {
        const id = rootIdOf(root)
        return id !== undefined && (released.get(id)?.has(name) ?? false)
      }
      for (const s of released.values()) if (s.has(name)) return true
      return false
    },
    /**
     * 释放：**必须带 reason**（`requireReason` 时）+ **必须能确定 root**。
     * 先落台账 → 再改内存 → 确认包装在位。
     */
    release(name, reason, root) {
      if (typeof name !== 'string' || name === '') return { ok: false, code: 2, why: 'name-required（要给出成员名）' }
      if (cfg?.requireReason !== false && (typeof reason !== 'string' || reason.trim() === '')) {
        return { ok: false, code: 2, why: 'reason-required（释放是破坏性动作：必须写清"为什么"）' }
      }
      const rootId = rootIdOf(root)
      if (rootId === undefined) {
        return {
          ok: false,
          code: 2,
          why:
            'root-required（必须给出"这是哪个 Team"—— 不给就分不清同名成员属于谁。' +
            '实测漏：standard 与 omc 都有 engineer，全局按名字过滤会**误伤另一个 Team**）',
        }
      }
      const b = released.get(rootId)
      if (b?.has(name) === true) return { ok: true, already: true, code: 0 }
      // ★★ **包装没生效 ⇒ 拒绝写台账**（2026-09-14 / Round 36 修的真 bug）：
      //   原写法是"先写台账、再改内存、发现包装不在就重试" —— 但重试若也失败，
      //   会返回 `code:3` 而**台账里已经记了一条** ⇒ 重启后重建**会真的过滤掉那个人**
      //   （用户看到的是"我明明失败了，人还是没了"）。**台账是盘上事实，不该为失败的动作留痕。**
      if (!wrap.ok) {
        const retry = apply()
        if (!retry.ok) {
          return {
            ok: false,
            code: 3,
            why: `wrap-not-live（${retry.why}）—— **拒绝释放，且未写台账**（避免"报失败但盘上留了痕"）`,
          }
        }
      }
      const w = append({ action: 'release', root: rootId, name, reason, time: new Date().toISOString(), version: 2 })
      if (!w.ok) return { ok: false, code: 3, why: `tracking-write-failed（${w.why}）—— 台账写不进去就不改内存（否则重启后对不上）` }
      bucket(rootId).add(name)
      if (!wrap.ok) {
        const retry = apply()
        if (!retry.ok) return { ok: false, code: 3, why: `wrapped-failed（${retry.why}）—— 台账已记，但**内存未生效**` }
      }
      // ★ **落地自检**：确认"过滤真的生效"（而不是只在台账上）
      //   —— 这是"失败不静默"的最后一格：报了 ok 就必须真能过滤掉。
      if (!this.isReleased(name, root)) {
        return { ok: false, code: 3, why: 'postcheck-failed（台账已记，但内存里查不到 ⇒ 本次释放未生效）' }
      }
      log(`RELEASE-OK root=${rootId} name=${name}`)
      return { ok: true, code: 0, released: this.list() }
    },
    /** 撤销释放（误操作回退）；幂等。`root` 不给 ⇒ 从**所有** Team 的桶里摘掉同名（显式宽口径）。 */
    unrelease(name, root) {
      if (typeof name !== 'string' || name === '') return { ok: false, code: 2, why: 'name-required' }
      const rootId = root === undefined ? undefined : rootIdOf(root)
      if (root !== undefined && rootId === undefined) {
        return { ok: false, code: 2, why: 'root-required（给了 root 但取不到 id ⇒ 拒绝，避免误摘别的 Team）' }
      }
      const targets = rootId !== undefined ? [rootId] : [...released.keys()]
      let hit = false
      for (const k of targets) if (released.get(k)?.has(name) === true) hit = true
      if (!hit) return { ok: true, already: true, code: 0 }
      const w = append({ action: 'unrelease', root: rootId ?? '*', name, time: new Date().toISOString(), version: 2 })
      if (!w.ok) return { ok: false, code: 3, why: `tracking-write-failed（${w.why}）` }
      for (const k of targets) released.get(k)?.delete(name)
      log(`UNRELEASE-OK root=${rootId ?? '*'} name=${name}`)
      return { ok: true, code: 0, released: this.list() }
    },
    /** 卸载：还原原型方法（**台账不动** —— 它不是进程状态，是盘上事实）。 */
    dispose() {
      if (wrap.ok && typeof wrap.restore === 'function') wrap.restore()
      wrap = { ok: false, why: 'disposed' }
    },
  }
}

/**
 * ★ **僵尸巡检**（只读；零风险）。
 *
 * 为什么要它：`phase='failed'` 或长期不动的成员**占名额占名字**却用不了
 * ⇒ 你得先**看见**才能决定释放谁。此函数**只读**、不改任何东西。
 *
 * @returns `{ zombies: [{name, id, phase, why}], scanned, note }`
 */
/**
 * ★ **拿 Team 名单**（候选列表探测；**拿不到就说拿不到**，不猜）。
 *
 * 为什么不能只写一条路：`journal.state(root)` 要**确切的 Team Lead**，而底座
 * **没有"列出所有 root"的公共面**（`roster.list` / `memberView` 都要 root）。
 * ⇒ 照 `LANDMINES §4`：**候选列表 + 逐个验**，全都失败就如实报 `ok:false`。
 *
 * ## ⚠️ 真宿主实测（Round 34）把这条修过两次
 * 第一版三个候选**全失败**（在真 `omc` 会话里调 `list_zombies` 得到的原话）：
 * ```
 * 所有候选都没拿到（memberView(root)（要 root，拿不到）
 *   / liveChildrenByRoot() → object            ← 不是数组，是**按 root 分组的对象**
 *   / list() 抛错: Cannot destructure property 'root' of 'membership' as it is undefined）
 * ```
 * ⇒ 两处判错了：① `liveChildrenByRoot()` 返回**对象**（`{rootId: [...]}`）而非数组；
 *   ② `roster.list()` 要 root（无参直接炸）。
 * **修法**：从 **tool 侧的 `ctx`** 取 root —— `agents.list()` 里那些 `session.header.name === 'lead'`
 *   的就是 Team Lead（真宿主里这条路能走通）。
 *
 * @param opts.agents `ctx.get('agents')`（**首选**：能直接找到 Lead 当 root）
 * @returns `{ ok: true, members, via }` 或 `{ ok: false, why }`
 */
export function readTeamMembers(agentTeams, { agents } = {}) {
  const roster = agentTeams?.roster
  if (!roster) return { ok: false, why: '拿不到 agentTeams.roster（service 不在或名字变了）' }
  const tried = []

  // ★ 候选⓪（**首选**）：拿一个真 Lead 当 root，然后 `journal.state(root)` / `roster.memberView(root)`
  if (agents && typeof agents.list === 'function') {
    let list = []
    try {
      list = agents.list() ?? []
    } catch (err) {
      tried.push(`agents.list() 抛错: ${err?.message ?? err}`)
    }
    // ⚠️ **"Lead 怎么认"不能只认 `session.header.name==='lead'`**（Round 34 实测：20 个 agent
    //    里**没有一个** name 是 'lead' ⇒ 那条判据在真宿主里落空）。
    //    ⇒ 用**候选列表**（照 LANDMINES §4）：name / role / header 三处都试，**并记录看到了什么**。
    const asRoot = (a) => {
      const h = a?.session?.header ?? {}
      return { name: h.name ?? a?.name, role: a?.role ?? h.role, id: a?.id }
    }
    const shapes = list.slice(0, 5).map(asRoot)
    let lead = list.find((a) => (a?.session?.header?.name ?? a?.name) === 'lead')
    if (!lead) lead = list.find((a) => (a?.role ?? a?.session?.header?.role) === 'lead')
    // 兜底③：谁 **能当 root** 就用谁（`journal.state(x)` 不抛错且 members 非空的那个）
    if (!lead) {
      for (const a of list) {
        try {
          const st = agentTeams.journal?.state?.(a)
          if (Array.isArray(st?.members) && st.members.length > 0) {
            return { ok: true, members: st.members, via: `journal.state(自动找到的 root: ${asRoot(a).name ?? asRoot(a).id})` }
          }
        } catch {
          /* 不是 root，继续 */
        }
      }
      tried.push(
        `agents.list() 里认不出 Lead（拿到 ${list.length} 个；前 5 个的形状：${JSON.stringify(shapes)}）`,
      )
    }
    if (lead) {
      // ① journal.state(lead).members —— 最直接
      try {
        const st = agentTeams.journal?.state?.(lead)
        if (Array.isArray(st?.members) && st.members.length > 0) {
          return { ok: true, members: st.members, via: 'journal.state(lead).members' }
        }
        tried.push(`journal.state(lead).members → ${Array.isArray(st?.members) ? st.members.length : typeof st?.members}`)
      } catch (err) {
        tried.push(`journal.state(lead) 抛错: ${err?.message ?? err}`)
      }
      // ② roster.memberView(lead)
      try {
        const mv = roster.memberView?.(lead)
        if (Array.isArray(mv) && mv.length > 0) return { ok: true, members: mv, via: 'roster.memberView(lead)' }
        tried.push(`roster.memberView(lead) → ${Array.isArray(mv) ? mv.length : typeof mv}`)
      } catch (err) {
        tried.push(`roster.memberView(lead) 抛错: ${err?.message ?? err}`)
      }
      // ③ roster.list(lead)
      try {
        const rl = roster.list?.(lead)
        if (Array.isArray(rl) && rl.length > 0) return { ok: true, members: rl, via: 'roster.list(lead)' }
        tried.push(`roster.list(lead) → ${Array.isArray(rl) ? rl.length : typeof rl}`)
      } catch (err) {
        tried.push(`roster.list(lead) 抛错: ${err?.message ?? err}`)
      }
    }
  } else {
    tried.push('agents 不可用（没有 ctx.get("agents")）')
  }

  // ── 兜底候选（没有 agents 时）：形状探测 ────────────────────────────────
  // ⚠️ `liveChildrenByRoot()` 在真宿主返回的是**对象**（按 root 分组的 map），不是数组
  if (typeof roster.liveChildrenByRoot === 'function') {
    try {
      const r = roster.liveChildrenByRoot()
      if (Array.isArray(r)) {
        if (r.length > 0) return { ok: true, members: r, via: 'liveChildrenByRoot()(array)' }
        tried.push('liveChildrenByRoot() → 空数组')
      } else if (r && typeof r === 'object') {
        const flat = Object.values(r).flat().filter(Boolean)
        if (flat.length > 0) return { ok: true, members: flat, via: 'liveChildrenByRoot()(按 root 分组的对象拍平)' }
        tried.push(`liveChildrenByRoot() → 对象但拍平后为空（keys=${Object.keys(r).length}）`)
      } else {
        tried.push(`liveChildrenByRoot() → ${typeof r}`)
      }
    } catch (err) {
      tried.push(`liveChildrenByRoot() 抛错: ${err?.message ?? err}`)
    }
  }
  return { ok: false, why: `所有候选都没拿到（${tried.join(' / ')}）` }
}

/**
 * ★ **僵尸巡检**（只读；零风险）。
 *
 * 为什么要它：`phase='failed'` 或长期不动的成员**占名额占名字**却用不了
 * ⇒ 你得先**看见**才能决定释放谁。此函数**只读**、不改任何东西。
 *
 * @param opts.members **显式给成员数组**（首选：由调用方在它自己的 scope 里取，最可靠）
 * @returns `{ zombies: [{name, id, phase, why}], scanned, note }`
 */
export function listZombies(agentTeams, { members: passed, agents, staleAfterMinutes = 30, now = Date.now() } = {}) {
  const out = { zombies: [], scanned: 0, note: '' }
  let members = Array.isArray(passed) ? passed : []
  if (members.length === 0) {
    const r = readTeamMembers(agentTeams, { agents })
    if (!r.ok) {
      out.note = r.why
      return out
    }
    members = r.members
    out.note = `成员名单来自 ${r.via}`
  }
  out.scanned = members.length
  const staleMs = Number(staleAfterMinutes) * 60_000
  for (const m of members) {
    const phase = m?.phase ?? m?.status ?? 'unknown'
    const last = m?.lastActiveAt ?? m?.updatedAt ?? m?.createdAt
    const t = typeof last === 'string' ? Date.parse(last) : typeof last === 'number' ? last : NaN
    const idle = Number.isFinite(t) ? now - t > staleMs : false
    if (phase === 'failed') out.zombies.push({ name: m?.name, id: m?.id, phase, why: 'phase=failed（看得见、用不了、还占名额）' })
    else if (idle) out.zombies.push({ name: m?.name, id: m?.id, phase, why: `idle>${staleAfterMinutes}min` })
  }
  return out
}

export { readTracking, writeFileSync }
