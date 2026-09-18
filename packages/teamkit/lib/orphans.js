/**
 * orphans.js —— **任务/目标巡检的规则本体**（task-107），零依赖、纯函数。
 *
 * 三条子命令共用本模块：`teamkit orphans` / `teamkit goals` / `teamkit board-replay`。
 *
 * ## ★★ 本文件最要紧的一段：**"活跃性"只能用进程内结论，不能用 journal 的 `phase`**
 *
 * 依据（COO 实测 + 我独立复核 + 底座源码）：
 * ```
 * journalTotal = 22
 *   判据 1 `journal.phase === 'active'`      ⇒ 22   ← ★ **假绿**（会得到"0 孤儿"）
 *   判据 2 能在 `agents.list()` 里解析出来    ⇒ 7
 *   分叉 = 15
 * ```
 * **机制**：`phase` 是**写入时的快照** —— 进程死了它**不会自己变**（"僵尸活跃"）。
 * 真活跃度只活在进程内。底座源码把这件事写得很直白
 * （`dsh-experimental-agent-team/lib/index.js:447-454`，`memberView.list()`）：
 * ```js
 * const live = this.ctx.agents.get(member.id);
 * status: member.phase === "failed" ? "failed"
 *       : member.phase === "provisioning" ? "provisioning"
 *       : live?.status ?? "inactive"          // ← phase==='active' 但进程里查不到 ⇒ 'inactive'
 * ```
 * ⇒ **`phase === 'active'` 与 `status === 'running'` 是两件事，会分叉。**
 * ⇒ 本模块只认 `status`。**别"优化"回 journal 口径** —— 那会得到"0 孤儿"的假绿。
 *   这条不变量有断言盯着：`plugin/scripts/check-orphans-rule.mjs`（含变异测试）。
 *
 * ## 三种"0"必须分开（诚实条）
 * ```
 * ① 真·无孤儿            ⇒ verdict 'ok'          ⇒ exit 0
 * ② 有孤儿               ⇒ verdict 'orphans'     ⇒ exit 1  ★ 这一档才是本命令存在的意义
 * ③ 读不到/读不全        ⇒ verdict 'unverified'  ⇒ exit 2  ← **不许静默当 ①**
 * ```
 * ③ 与 ① 的差别是"**没测**"与"**测了、没有**" —— 把前者画成后者就是**假事实**。
 */

/**
 * ★★ **`status` 的完整取值面**（依据：底座 `dsh-agent-loop/lib/index.js:773-775` **逐字**）：
 * ```js
 * get status() {
 *   return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
 * }
 * ```
 * ⇒ **只有两个值：`idle` / `running`**，而且 **`idle` 是"回合之间"的常态** ——
 *   进程活着、能唤醒（`whenIdle()` / `wake()` 都在同一段代码里），只是此刻没在跑一个 turn。
 *
 * ## ⚠️⚠️ 这一段是本命令**最容易被写错**的地方（我第一版就写错了，COO 从真实误判里抓出来）
 * 我第一版把 `ACTIVE_STATUSES = ['running','active']` 之外的**一律**判成孤儿
 * ⇒ **`idle` 的 owner 会被报成孤儿** = **假红**（叫一个活着的人"没人接"）。
 * 而 COO 的真实误判现场正是这个形态：他用"`in_progress` × `list_agents`"巡出 3 个"孤儿"，
 * 复核发现 `performance-measurer` **其实活着**（在单文件编辑报告、未落盘新文件）⇒ **一叫就回**。
 *
 * ⇒ 所以**不许把"拿不到/没在跑"当成"人不在"**（本项目一贯的"读不到 ≠ 没有"）。
 *   分类改成三态（见 `classifyTask` 的 `kind`）：
 * ```
 * ① present-running        ⇒ 在跑，正常
 * ② present-idle           ⇒ ★ **常态化**（回合之间 / 单文件编辑未落盘 / 维护态）⇒ **不是孤儿**
 * ③ orphan-absent          ⇒ **名单里根本没有这个人** ⇒ ★ **才是真孤儿**
 * ```
 * ⚠️ **`status` 缺失/未知**时**不判孤儿**，而是记 `present-unknown`（**不确定 ≠ 没有**）——
 *    这条同样是为了不产生假红。
 */

/** 三态退出码（与 `selftest` 同族）。 */
export const EXIT = { ok: 0, red: 1, unverified: 2 }

/**
 * 判一条任务是不是孤儿（**纯函数**）。
 *
 * ## ★★ 第二诚实条：`inactive` **不是观测值**，是底座**编造的兜底串**
 * 依据（`dsh-experimental-agent-team/lib/index.js:454` **逐字**）：
 * ```js
 * status: member.phase === "failed" ? "failed"
 *       : member.phase === "provisioning" ? "provisioning"
 *       : live?.status ?? "inactive"          // ← ★ `?? "inactive"` 是**兜底编造**
 * ```
 * ⇒ 它把**三种完全不同的情况**压成了同一个词：
 * ```
 * ① 真不在  ② 在但 idle  ③ **在动，但我这个 scope 看不到**
 * ```
 * **现场实证**：`engineering-director` 被 `list_agents` 显示 `inactive`，
 * 而连采它的会话日志 mtime `00:27:57 → 00:28:09 → 00:28:15`（**在长**）⇒ **它正在写，却显示 inactive**。
 *
 * ⇒ 所以：**`status === 'inactive'` 不得作为"孤儿"的判据**（那会给出**假红** —— 把在写的人报成没人接）。
 *   判定必须按**档位 + 证据**走，且**每档都要能回答"我用什么读数判的"**：
 *
 * | 档 | 判据（证据） | 结论 |
 * |---|---|---|
 * | `ok-running` | `statusSource==='live'` 且 `status==='running'` | 在做 |
 * | `ok-idle-wakeable` | **不依赖当前 scope 的证据**（会话日志 mtime 近期在动 / 近期回过消息） | 常态，**不是孤儿** |
 * | `orphan-absent` | owner **不在成员名单里**（且名单本身可信） | **真孤儿** |
 * | `orphan-no-owner` | `in_progress` 却没有 owner | **真孤儿** |
 * | `indeterminate` | `status==='inactive'` 或缺失，**且拿不到 scope 外的证据** | ★ **未获取**（**不许**落孤儿） |
 *
 * @param task `{id, status, ownerName|owner}`
 * @param memberOf `(nameOrId) => member | undefined`
 *   member 形如 `{name, id, status, statusSource?, phase?, lastLogMtime?, lastEchoAt?}`
 * @param opts `{recentMs}` —— "近期"的阈值（默认 30 分钟）。**可配**（不写死成结论）
 * @returns `{orphan, kind, why, ownerStatus, evidence}`
 */
export function classifyTask(task, memberOf, opts = {}) {
  const recentMs = typeof opts.recentMs === 'number' ? opts.recentMs : 30 * 60 * 1000
  const now = typeof opts.now === 'number' ? opts.now : Date.now()

  const status = String(task?.status ?? '')
  if (status !== 'in_progress') {
    return { orphan: false, kind: 'ok-not-in-progress', why: `status=${status}（只有 in_progress 才声称"有人在做"）`, ownerStatus: '-', evidence: '任务状态' }
  }
  const owner = task?.ownerName ?? task?.owner
  if (owner === undefined || owner === null || String(owner) === '') {
    return { orphan: true, kind: 'orphan-no-owner', why: 'in_progress 但没有 owner（没人认领却挂在板上）', ownerStatus: '(空)', evidence: '任务卡本身' }
  }
  const m = memberOf(String(owner))
  if (m === undefined) {
    // ★ 唯一一类"owner 真的不在"⇒ 真孤儿。⚠️ 但"名单本身可信"由 analyzeOrphans 保证（空名单 ⇒ unverified）。
    return { orphan: true, kind: 'orphan-absent', why: `owner "${owner}" 不在成员名单里`, ownerStatus: '(不在名单)', evidence: '成员名单（进程内）' }
  }

  const st = m.status === undefined || m.status === null ? '' : String(m.status)
  const source = String(m.statusSource ?? '(未标注)')

  // ① 明确"在做"：只有**真观测到 running** 才算（不看兜底串）
  if (st === 'running') {
    return { orphan: false, kind: 'ok-running', why: `owner ${owner} status=running（**观测值**，source=${source}）`, ownerStatus: st, evidence: 'liveStatus=running' }
  }

  // ② ★★ `idle` 是**真观测值**（来自 `live?.status`，`dsh-agent-loop:773-775`），**不是兜底串**
  //    ⇒ 它就是"回合之间"的常态、**可唤醒** ⇒ **不是孤儿、也不需要额外证据**。
  //    （★ 分界：只有 `inactive` 才是 `live === undefined` 时的**编造兜底** —— 见下面 ③。）
  if (st === 'idle') {
    return {
      orphan: false, kind: 'ok-idle', ownerStatus: st,
      why: `owner ${owner} status=idle（**观测值**，source=${source}）⇒ 回合之间的**常态**、可唤醒 ⇒ **不是孤儿**`,
      evidence: 'liveStatus=idle（观测值）',
    }
  }

  // ③ `inactive` / 缺失 ⇒ **不是观测** ⇒ 必须先找**不依赖当前 scope 的证据**。
  //    ⚠️ 这里是本函数最要紧的一步：**不许**直接落"孤儿"。
  const ev = []
  const logAge = typeof m.lastLogMtime === 'number' ? now - m.lastLogMtime : undefined
  const echoAge = typeof m.lastEchoAt === 'number' ? now - m.lastEchoAt : undefined
  if (logAge !== undefined) ev.push(`会话日志 mtime ${Math.round(logAge / 1000)}s 前`)
  if (echoAge !== undefined) ev.push(`最近回声 ${Math.round(echoAge / 1000)}s 前`)

  const fresh =
    (logAge !== undefined && logAge >= 0 && logAge <= recentMs) ||
    (echoAge !== undefined && echoAge >= 0 && echoAge <= recentMs)
  if (fresh) {
    return {
      orphan: false, kind: 'ok-idle-wakeable', ownerStatus: st === '' ? '(未获取)' : st,
      why: `owner ${owner} 的 liveStatus=${st === '' ? '(未获取)' : st}，但**有 scope 外的活动证据**（${ev.join('；')}）`
        + ` ⇒ **可唤醒** ⇒ **不是孤儿**`,
      evidence: ev.join('；'),
    }
  }

  // ③ 拿不到 scope 外的证据 ⇒ **未获取**（**不许**落孤儿 —— "读不到 ≠ 没有"）
  if (logAge === undefined && echoAge === undefined) {
    return {
      orphan: false, kind: 'indeterminate', ownerStatus: st === '' ? '(未获取)' : st,
      why: `owner ${owner} 的 liveStatus=${st === '' ? '(未获取)' : st}`
        + (st === 'inactive' ? '（★ **底座兜底值**，不是观测结果 —— `live?.status ?? "inactive"`）' : '')
        + '，且**拿不到 scope 外的证据**（快照没给 lastLogMtime/lastEchoAt）'
        + ` ⇒ **未获取**：不许判孤儿，也不许判"在做"`,
      evidence: '(未获取)',
    }
  }

  // ④ 有证据、但都过期 ⇒ 仍**不直接判孤儿**：COO 要求"叫不动"**必须先试一次**。
  return {
    orphan: false, kind: 'indeterminate', ownerStatus: st === '' ? '(未获取)' : st,
    why: `owner ${owner} 的 liveStatus=${st === '' ? '(未获取)' : st}，scope 外证据已过期（${ev.join('；')}）`
      + ' ⇒ 要判"叫不动"**必须先真发一条**（`orphan-inactive-confirmed` 需要那一步的读数）⇒ 本函数只到"未获取"',
    evidence: ev.join('；'),
  }
}

/**
 * 巡检一个**快照**（纯函数，不读盘）。
 *
 * @param snapshot `{tasks, members, at?, source?}`
 *   ⚠️ `members` **必须来自进程内**（`memberView.list()` / `list_agents`）。
 *      若只从日志重放出 `phase`，**不能**当 `members` 用 —— 那正是假绿。
 * @returns `{verdict, exitCode, orphans, checked, why}`
 */
export function analyzeOrphans(snapshot) {
  const tasks = snapshot?.tasks
  const members = snapshot?.members
  if (!Array.isArray(tasks) || !Array.isArray(members)) {
    const missing = []
    if (!Array.isArray(tasks)) missing.push('tasks')
    if (!Array.isArray(members)) missing.push('members')
    return {
      verdict: 'unverified', exitCode: EXIT.unverified, orphans: [], checked: 0,
      why: `未获取：快照缺 ${missing.join(' + ')}。缺成员列表就无法判断活跃性 —— **不许**把它当成"没有孤儿"`,
    }
  }
  if (members.length === 0) {
    // ⚠️ 空名单 = 未获取，**不是**"没有孤儿"（读不到人 ≠ 没有人）。
    return {
      verdict: 'unverified', exitCode: EXIT.unverified, orphans: [], checked: 0,
      why: '未获取：成员列表为空（读不到人 ≠ 没有人；空名单下任何 in_progress 都会被误判为孤儿）',
    }
  }
  const byName = new Map()
  const byId = new Map()
  for (const m of members) {
    if (m?.name !== undefined) byName.set(String(m.name), m)
    if (m?.id !== undefined) byId.set(String(m.id), m)
  }
  const memberOf = (k) => byName.get(k) ?? byId.get(k)

  const inProgress = tasks.filter((t) => String(t?.status) === 'in_progress')
  const orphans = []
  const indeterminate = []
  for (const t of inProgress) {
    const c = classifyTask(t, memberOf, {
      ...(snapshot?.recentMs === undefined ? {} : { recentMs: snapshot.recentMs }),
      ...(snapshot?.now === undefined ? {} : { now: snapshot.now }),
    })
    if (c.kind === 'indeterminate') {
      // ★ **不能判孤儿、也不能判"在做"** ⇒ 单列"未获取"档（**不参与红/绿判定**）。
      indeterminate.push({ id: String(t?.id ?? '(无 id)'), owner: String(t?.ownerName ?? t?.owner ?? '(空)'), why: c.why, evidence: c.evidence })
      continue
    }
    if (!c.orphan) continue
    const owner = t?.ownerName ?? t?.owner ?? '(空)'
    const m = memberOf(String(owner))
    orphans.push({
      id: String(t?.id ?? '(无 id)'),
      owner: String(owner),
      ownerStatus: c.ownerStatus,
      kind: c.kind,
      why: c.why,
      evidence: c.evidence,
      // 最后活跃时刻：快照里若有就给，**没有写 null**（由调用方渲染成"未获取"）——不许编。
      lastActiveAt: m?.lastActiveAt ?? null,
    })
  }
  if (orphans.length === 0 && indeterminate.length === 0) {
    return { verdict: 'ok', exitCode: EXIT.ok, orphans: [], indeterminate: [], checked: inProgress.length, why: `${inProgress.length} 条 in_progress，owner 全部可判且活跃` }
  }
  if (orphans.length === 0) {
    // ⚠️ 有"判不了"的 ⇒ **不是 ok**。但也**不是红**（不许把"未获取"当孤儿 —— 那是假红）。
    //    ⇒ 落 `unverified`（exit=2）：**"没测出来"与"测了没有"必须分开**。
    return {
      verdict: 'unverified', exitCode: EXIT.unverified, orphans: [], indeterminate, checked: inProgress.length,
      why: `${inProgress.length} 条 in_progress 里有 ${indeterminate.length} 条**判不了**`
        + '（拿不到 scope 外的证据 ⇒ 既不判孤儿也不判在做）⇒ 未获取',
    }
  }
  return {
    verdict: 'orphans', exitCode: EXIT.red, orphans, indeterminate, checked: inProgress.length,
    why: `${inProgress.length} 条 in_progress 里有 ${orphans.length} 条孤儿（owner 不在名单 / 没 owner）`
      + (indeterminate.length > 0 ? `；另有 ${indeterminate.length} 条判不了（未获取）` : ''),
  }
}

// ── §四 验证岗可用链 ────────────────────────────────────────────────────────

/**
 * 路由可用性（纯函数）。
 *
 * ⚠️ **不写死**：本部署已知 `superdeepseek` 可用、`deepseek-official` 是 402（等不好）
 * （运营事实 P-26/P-27）。但开源用户的路由不是这两条 ⇒ 两个名单都**可覆盖**（`--usable` / `--blocked`）。
 * @returns `{verdict:'usable'|'blocked'|'unknown', exitCode, why}`
 */
export function routeVerdict(provider, { usable = ['superdeepseek'], blocked = ['deepseek-official'] } = {}) {
  if (provider === undefined || provider === null || String(provider) === '') {
    return { verdict: 'unknown', exitCode: EXIT.unverified, why: '未获取：拿不到该成员的路由（provider 为空）' }
  }
  const p = String(provider)
  if (blocked.includes(p)) {
    return {
      verdict: 'blocked', exitCode: EXIT.red,
      why: `provider=${p} 在**已知坏链**名单里（402，等不好）⇒ 派它去验证 = **叫一个不会答的人答题**`,
    }
  }
  if (usable.includes(p)) return { verdict: 'usable', exitCode: EXIT.ok, why: `provider=${p} 在可用链名单里` }
  return { verdict: 'unknown', exitCode: EXIT.unverified, why: `未获取：provider=${p} 既不在可用名单也不在坏链名单（不猜）` }
}

// ── §三 跨文件夹具：**用 journal/看板字段判断"某人现在活着"必须同时核 agents.list()** ──

/**
 * ★★ 跨文件断言（CEO 亲自要求，归本任务）。
 *
 * 【它挡的是什么】"**拿一个会过期的字段当现状**" —— CEO 自述这几轮多次拿板当事实做决定。
 * 【判据】任一处用 `journal` 的 `phase` 判断"某人现在活着/在做" ⇒ 必须同时核 `agents.list()`。
 *
 * ## ⚠️ 定义必须与 `notes/coo/coo-liveness-divergence.mjs` **对齐**（实测发现两份会差）
 * COO 的 `computeDivergence()` 把"分叉"定义为**在 `agents.list()` 里解析不出**（**按 id 存在性**）。
 * 我第一版多加了"且 `status` 非活跃"这一条 ⇒ **同一装置下我数 2、它数 1**
 * （它不把 `idle` 的那个算进主指标）。两种都能自圆其说，但**数字必须可比**
 * （COO 已公布 `22 vs 7 = 分叉 15`，口径不能悄悄不同）。
 * ⇒ 现在：**主指标 `diverged` 严格按"存在性"**（与 COO 一致），
 *    把"在册但非活跃"另放 `presentButIdle`（**信息不丢，但不污染主数字**）。
 *    交叉一致性有断言：`plugin/scripts/check-orphans-rule.mjs` 的同装置对照用例。
 *
 * ⚠️ **不写死分叉数**（COO 明确提醒）：判据是"**分叉必须为空**"，不是"分叉等于某个数"。
 *
 * @param journalMembers `[{id, name, phase}]` —— 来自 journal 的**快照**
 * @param liveMembers `[{id, name, status}]` —— 来自**进程内** `agents.list()`
 * @returns `{verdict, exitCode, diverged, presentButIdle, checked, why}`
 */
export function crossCheckLiveness(journalMembers, liveMembers) {
  if (!Array.isArray(journalMembers) || !Array.isArray(liveMembers)) {
    return {
      verdict: 'unverified', exitCode: EXIT.unverified, diverged: [], checked: 0,
      why: '未获取：拿不到 journal 成员或进程内成员名单之一 ⇒ 无法做跨文件核对',
    }
  }
  const liveById = new Map()
  const liveByName = new Map()
  for (const m of liveMembers) {
    if (m?.id !== undefined) liveById.set(String(m.id), m)
    if (m?.name !== undefined) liveByName.set(String(m.name), m)
  }
  const diverged = []
  const presentButIdle = []
  for (const jm of journalMembers) {
    // 只看"journal 声称它在岗"的那些 —— 其余（provisioning/failed）本来就该不在进程里。
    if (String(jm?.phase) !== 'active') continue
    const byId = liveById.get(String(jm.id))
    // ★ **主判据 = COO 的定义**：`agents.list()` 里**解析不出**（按 id）
    if (byId === undefined) {
      diverged.push({
        id: String(jm?.id ?? '(无 id)'),
        name: String(jm?.name ?? '(无名)'),
        journalPhase: 'active',
        liveStatus: '(不在进程内)',
      })
      continue
    }
    // 在册但**没在跑一个 turn**（`status !== 'running'`）：**不算主分叉**（与 COO 口径一致），
    // 单独记 —— 它不该被当成"在做"，但也**不是"人不见了"**（`idle` 是常态，见文件头）。
    // ⚠️ 这里**不判孤儿**（那是 `classifyTask` 的事，且它现在把 idle 判成"常态"）。
    if (String(byId.status ?? '') !== 'running') {
      presentButIdle.push({
        id: String(jm?.id ?? '(无 id)'),
        name: String(jm?.name ?? '(无名)'),
        journalPhase: 'active',
        liveStatus: String(byId.status),
      })
    }
  }
  const checkedActives = journalMembers.filter((m) => String(m?.phase) === 'active').length
  if (diverged.length === 0 && presentButIdle.length === 0) {
    return {
      verdict: 'ok', exitCode: EXIT.ok, diverged: [], presentButIdle: [], checked: checkedActives,
      why: `journal 声称在岗的成员都在进程内且活跃（核了 ${checkedActives} 条）`,
    }
  }
  if (diverged.length === 0) {
    // 没有"解析不出"的，但有"在册却不活跃"的 ⇒ 主指标 0（与 COO 一致），但仍**不是**"一致"。
    return {
      verdict: 'red', exitCode: EXIT.red, diverged: [], presentButIdle, checked: checkedActives,
      why: `主分叉 0（与 COO 口径一致），但有 ${presentButIdle.length} 个"journal 说 active、进程内非活跃" ⇒ 拿 phase 当现状同样会误判`,
    }
  }
  return {
    verdict: 'red', exitCode: EXIT.red, diverged, presentButIdle, checked: checkedActives,
    why: `${diverged.length} 个成员 **journal.phase='active' 但进程里解析不出** ⇒ 拿 phase 当现状会误判（"僵尸活跃"）`
      + (presentButIdle.length > 0 ? `；另有 ${presentButIdle.length} 个"在册但不活跃"` : ''),
  }
}
