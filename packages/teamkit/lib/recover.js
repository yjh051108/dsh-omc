/**
 * recover.js —— **重启后的恢复能力**（只读；`task-106` B 段）。
 *
 * ## 为什么单独一个模块（两个理由）
 * 1. **单一事实来源**（`R10`）：`goals` 与 `board-replay` 共用同一套"怎么读板 / 怎么读会话事件"；
 * 2. ★ **避开同文件并发写**：`plugin/bin/teamkit.mjs` 当时正被 `plugin-smith` 写（`task-107`）
 *    ⇒ 逻辑放这里（**新文件，零冲突**），派发那几行**等它交活再补**。
 *
 * ## ⚠️★ **`orphans` 的规则**不在这里**（`R10`：只有一份实现）
 * ```
 * 盘上曾有【两份】orphans 实现（本文件第一版 + `orphans.js`）⇒ 被总工程师判为重复（`R10`）。
 * ⇒ 现定：**规则归 `lib/orphans.js`**（`plugin-smith` / `task-107`：`classifyTask` / `analyzeOrphans` /
 *   `crossCheckLiveness`）；**本文件只保留"service → 纯函数"的适配器**（`agents.list()` / `tryMembership`
 *   那一层），并**把分类工作委托给 `orphans.js`**。
 * ⇒ 一条链：`orphans.js`（规则，纯函数）→ `recover.js`（适配器 + goals + 板重放）
 * ⇒ **可机械核**：`grep -l "orphan-inactive" plugin/lib/*.js` 只应命中 `orphans.js`。
 * ```
 *
 * ## ★★ 另两件能力与各自**判据来源**（读源码 + 真宿主读数得来，不是猜）
 *
 * ### goal 重开（`goals`）—— **是设计，不是缺陷**（**只列，不自动 resume**）
 * ```
 * dsh-goal/lib/index.js:594-596
 *   ctx.on("agent/session-start", ({ agent }) => { this.setActivation(agent.session, "disarmed") })
 * ⇒ 每次会话启动（含**重启后拉起**）都**显式 disarm** —— 安全默认。
 *   `disarm()` 的文档原话："Remove process-local continuation authority"，
 *   注释：a later **human-authorized** `resume` records the new activation edge。
 * ⇒ **rearm 的唯一入口是 `goals.resume(agent, ref)`（`:686`）—— 那是「授权动作」**。
 *   ⇒ **自动 rearm = 替用户授权**（`R4` 同族）⇒ 本模块**只列 + 给一句"怎么 resume"**，**不代做**。
 * ```
 *
 * ### 板重放（`boardReplay`）—— 把一次性读数变成**可复跑判据**
 * ```
 * `journal` 是 event-sourced（`team/task` 事件按 `seq` 序折叠）⇒ **理论上能重放**。
 * 本仓真读数（Lead 会话）：`session.log` 30244 条事件、其中 `team/task` 356 条
 *   ⇒ 独立重放 ⇒ 总任务 107 / 非 deleted 98
 *   ⇒ 与**当前板**（`listTasks` 98 条）比对：差异 0、`status` 不一致 0
 * ```
 * ⚠️ **边界（`R5`：结论不许超出读数）**：**这只证明"日志 → 板"这条链成立**；
 *   **"重启后一定 100% 装回"仍未获取** —— 那还要经**投影缓存**（`session_projcache/<root>.json`），
 *   而"重启后真能装回"**只有真杀一次宿主才知道**（`R4`：那一步须先报 COO→CEO→用户）。
 */
import { analyzeOrphans } from './orphans.js'

/**
 * ★ **判据来源：活跃度**（**唯一权威 = 进程内运行时，不是 journal**）。
 *
 * @param agentTeams 宿主的 `agentTeams`
 * @param agents     宿主的 `agents`
 * @returns `{ ok:true, names:Set<string>, why }` 或 `{ ok:false, why }`
 *   ⚠️ **拿不到就 `ok:false`**（**不许退化成空集合** —— 那会让"孤儿"变成"全部"，或让"0 孤儿"变成假绿）
 */
export function liveMemberNames(agentTeams, agents) {
  // ★★ **先判"能不能拿到 agents 服务"** —— 我第一版漏了这一步：
  //   `agents === undefined` 时 `agents?.list?.()` 得到 `[]`（**空数组，不抛**）
  //   ⇒ 返回 `ok:true` + **空集合** ⇒ 下游 `findOrphans` 会把**每一条 in_progress 都判成孤儿**
  //   ⇒ **假绿的反面：假红**（同样是"用错来源"，与 `journal.phase` 那个"假 0"是一对）。
  //   ⇒ 判据：**拿不到服务 ⇒ `ok:false`**，让调用方**报未获取**，不许退化成空集合。
  if (agents === undefined || agents === null || typeof agents.list !== 'function') {
    return { ok: false, why: 'no-agents-service（拿不到 ctx.agents ⇒ **未获取**，不是"没有活人"）' }
  }
  let list
  try {
    list = agents.list() ?? []
  } catch (err) {
    return { ok: false, why: `agents.list-failed（${err?.message ?? err}）` }
  }
  if (!Array.isArray(list)) return { ok: false, why: `agents.list 返回的不是数组（${typeof list}）` }
  const names = new Set()
  for (const a of list) {
    if (a === undefined) continue
    let m
    try {
      m = agentTeams?.tryMembership?.(a)
    } catch {
      m = undefined
    }
    if (m?.name !== undefined && m.name !== '') names.add(m.name)
    // ⚠️ **不把"解析不出的 agent"当成成员**（那不是"活着"）
  }
  return { ok: true, names }
}

/**
 * ★ **孤儿任务**：`status==='in_progress'` 且 **owner 已不在进程内运行时**。
 *
 * ⚠️★ **本函数只做"适配 + 委托"，不自己实现分类规则**（`R10`：只有一份实现）：
 *   · **规则**在 `lib/orphans.js` 的 `analyzeOrphans`（`plugin-smith` / `task-107`）
 *     —— 它比我第一版更细（区分 `orphan-absent` / `orphan-inactive`，且对"空名单"报 `unverified`）；
 *   · **本函数**负责把 `liveNames`（来自 `liveMemberNames`）**适配成它要的 `members` 形状**。
 *
 * ⚠️ **`liveNames` 为空集合时不许当"没有孤儿"** —— 那会把每条 `in_progress` 判成孤儿（假红），
 *   或反过来被当成"没问题"。`analyzeOrphans` 对空 `members` 已正确报 `unverified`，
 *   本函数**原样透传它的 verdict**，不做自己的解释。
 *
 * @param tasks      板视图（`listTasks(root)` 的产物）
 * @param liveNames  `liveMemberNames(...)` 的 `names`（**Set<string>**）
 * @returns `{ orphans, scanned, verdict, why }` —— `verdict` 取自 `orphans.js`（`ok`/`orphans`/`unverified`）
 */
export function findOrphans(tasks, liveNames) {
  // 适配：`orphans.js` 要 `{id, name, status}` 的数组；我们只有名字集合
  //   ⇒ 给 `{name, status:'running'}`（**名字在集合里 = 进程内有它**，与 `ACTIVE_STATUSES` 一致）
  const members = liveNames instanceof Set ? [...liveNames].map((name) => ({ name, status: 'running' })) : []
  const r = analyzeOrphans({ tasks, members })
  return {
    orphans: Array.isArray(r.orphans) ? r.orphans : [],
    scanned: r.checked ?? 0,
    verdict: r.verdict,
    why: r.why,
  }
}

/**
 * ★★ **反例判据（值钱的对照）**：用 `journal.phase` 算孤儿 ⇒ **恒 0**。
 *
 * 这条不是"多余的实现"，是**把分叉做成机械判据**：
 * ```
 * 若两种来源给出**相同**结果 ⇒ 说明"僵尸活跃"这个现象不成立（那我们的判据②就白设计了）；
 * 若给出**不同**结果 ⇒ **分叉被实测**（正是 `task-106` 发现的机制）。
 * ```
 * ⚠️ `selftest` 用它当**反例断言**：`journal` 口径 **恒 0**，而 `agents.list()` 口径 **可能非 0**。
 *   ⚠️ **`journal` 口径那一半只用 4 行**（不是一份完整实现）——
 *     因为它的用途**只是"当反面对照"**（证明它是错的），**不是给人用的能力**；
 *     真正给人用的规则在 `orphans.js`（`classifyTask` / `crossCheckLiveness`）。
 *
 * @returns `{ byJournal, byRuntime, diverged }`
 */
export function compareOrphanSources(members, tasks, liveNames) {
  const ms = Array.isArray(members) ? members : []
  const byJournal = (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (t?.status !== 'in_progress') return false
    const m = ms.find((x) => x?.name === t.ownerName)
    return m === undefined || m.phase !== 'active'
  }).length
  const { orphans } = findOrphans(tasks, liveNames)
  const byRuntime = orphans.length
  return { byJournal, byRuntime, diverged: byJournal !== byRuntime }
}

/**
 * ★ **板重放**：从会话事件里独立重建任务板（`event-sourced` 折叠），供与当前板比对。
 *
 * 折叠规则（与底座 `applyProjectionEvent` 的语义一致）：**按 `seq` 序**，同 `id` **后写覆盖**。
 * ⚠️ 用 `revision` 兜底比较（同一 id 若事件乱序，取 revision 大的）—— **只影响"取哪一版"，不影响集合**。
 *
 * @param events `session.log`（全量事件数组）
 * @returns `{ total, alive, byId }`（`alive` = 非 `deleted`）
 */
export function replayBoard(events) {
  const evs = Array.isArray(events) ? events : []
  const taskEvs = evs.filter((e) => e?.type === 'team/task')
  const sorted = [...taskEvs].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
  const byId = new Map()
  for (const e of sorted) {
    const t = e?.data?.task
    if (t?.id === undefined) continue
    const prev = byId.get(t.id)
    if (prev === undefined || (t.revision ?? 0) >= (prev.revision ?? 0)) byId.set(t.id, t)
  }
  const all = [...byId.values()]
  return { total: all.length, alive: all.filter((t) => t.status !== 'deleted'), byId, taskEvents: taskEvs.length }
}

/**
 * ★ **板重放 vs 当前板**：逐条比对（`id` 集合 + `status`）。
 * @returns `{ ok, onlyLive, onlyReplay, statusMismatch, samples, replayTotal, replayAlive, liveTotal }`
 *   `ok === true` ⇒ **重放板 === 当前板**
 */
export function compareBoards(liveTasks, replay) {
  const live = Array.isArray(liveTasks) ? liveTasks : []
  const re = Array.isArray(replay?.alive) ? replay.alive : []
  const liveIds = new Set(live.map((t) => t.id))
  const reIds = new Set(re.map((t) => t.id))
  const onlyLive = [...liveIds].filter((x) => !reIds.has(x))
  const onlyReplay = [...reIds].filter((x) => !liveIds.has(x))
  const liveMap = new Map(live.map((t) => [t.id, t]))
  const samples = []
  let statusMismatch = 0
  for (const r of re) {
    const l = liveMap.get(r.id)
    if (l === undefined) continue
    if (l.status !== r.status) {
      statusMismatch += 1
      if (samples.length < 5) samples.push({ id: r.id, replay: r.status, live: l.status })
    }
  }
  return {
    ok: onlyLive.length === 0 && onlyReplay.length === 0 && statusMismatch === 0,
    onlyLive,
    onlyReplay,
    statusMismatch,
    samples,
    replayTotal: replay?.total ?? 0,
    replayAlive: re.length,
    liveTotal: live.length,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// S1 · **重新点名**（`task-106` S1；2026-09-14）
// ════════════════════════════════════════════════════════════════════════════
/**
 * ★★ **算出"该给谁发消息"的唤醒计划**（**纯函数：只出计划，永不发送**）。
 *
 * ## ★ 为什么"唤起"= **发消息**，不是 `spawnTeammate`（读源码得来，不是猜）
 * ```
 * ❌ `spawnTeammate` **不能**用来唤起：`roster.js:243` `TEAM_MEMBER_NAME_TAKEN`
 *    （**名字不可复用**）⇒ 想重招同名成员**直接抛错**；而且那是**新成员**、编制 +1、身份不同
 * ✅ **`agentTeams.sendMessage` 才是唤醒入口** —— 底座**已有**"冷启动失联成员"的能力：
 *      `dsh-experimental-agent-team/lib/index.js:1699-1701`
 *          ctx.on('agent/session-start', ({agent}) => this.scheduleRecovery(agent))
 *      `:1863-1871`  scheduleRecovery（queueMicrotask + 包异常，不炸）
 *      `:1873-1875`  recoverFor ⇒ roster.recoverFor + **mailbox.recoverFor**
 *      `types/mailbox.js:76-88`  recoverFor：把**未投递消息重投** ⇒
 *      `:925-933`  dispatchOnce：`target === undefined`（**该成员不在进程里**）⇒
 *                  `steerHostSubagentPrompt(...)` ⇒ `dsh-subagent:1870` **coldResume**
 *      `continuation.js:238-240`  deliverToChild **要求 `assertAdmitting(parent)` +
 *                  `holdOwnership(parent, childId)`** ⇒ **调用者必须是该 child 的直接父（= Lead）**
 * ⇒ **准确口径**：**"重启后不会自动复活全员；但如果那个成员有未投递消息，系统会把它冷启动起来"
 *    —— 缺的是【谁来产生那条消息】（"重新点名"这一步），不是底层能力。**
 * ```
 * ## ⛔★ 负边界（CEO 加的，必须守）
 * ```
 * · **唤起必须是 Lead 显式调用** —— **不许**有"`session-start` 自动复活全员"的路径（我们的代码里）。
 *   ⚠️ 底座自己在 `session-start` 会重投未投递消息（**那是它的既有语义，不是我们做的**）——
 *     交付文档里必须写清，免得后人读成"我们做了自动复活"。
 * · **唤醒 = 真实点火**（耗 token + 它可能开始改东西）⇒ 本函数**只出计划**；
 *   真正的发送由 CLI 的 `--wake --yes` 走（**默认 dry-run**）。
 * ```
 *
 * @param members   该 Team 的成员（`[{name, phase}]`，来自 **进程内**快照）
 * @param liveNames `liveMemberNames(...)` 的 `names`（Set）
 * @param opts.only 只唤醒这些人（白名单）；缺省 = 所有"失联"的人
 * @returns `{plan, skipped, why}` —— `plan` 里每人一条 `{name, reason, prompt}`
 */
export function planWake(members, liveNames, { only } = {}) {
  const ms = Array.isArray(members) ? members : []
  if (ms.length === 0) {
    // ★ R24：读不到成员 ≠ 没有人 ⇒ **未获取**，不许报"没人要唤醒"
    return { plan: [], skipped: [], why: 'unverified：成员名单为空（读不到人 ≠ 没有人）' }
  }
  if (!(liveNames instanceof Set)) {
    return { plan: [], skipped: [], why: 'unverified：拿不到进程内活跃名单（无法判断谁失联）' }
  }
  // ★★ `R24` fail-closed：**空的活跃名单 ⇒ 未获取**，**不是"全员都失联"**。
  //   【为什么空集合必然是"读失败"】**Lead 自己一定在 `agents.list()` 里**（它是当前进程的根）
  //     ⇒ `live` 为空**在真实宿主里不可能** ⇒ 它只可能来自"快照没抽到 / 服务读不到"
  //   ⚠️ 这是我第一版的**真 bug**：把空集合当成"没有活人" ⇒ **每个成员都被判失联**（**假红**）；
  //     与 `journal.phase` 的"假绿"是一对（**都是把"读不到"当成"读到了空的"**）。
  if (liveNames.size === 0) {
    return { plan: [], skipped: [], why: 'unverified：活跃名单为空（Lead 必在名单里 ⇒ 空集只可能是"没读到"）' }
  }
  const allow = only === undefined || only === null ? undefined : new Set(Array.isArray(only) ? only : [only])
  const plan = []
  const skipped = []
  for (const m of ms) {
    const name = String(m?.name ?? '')
    if (name === '' || name === 'lead') continue // Lead 自己不唤醒
    const live = liveNames.has(name)
    if (allow !== undefined && !allow.has(name)) {
      skipped.push({ name, why: '不在 --only 白名单里' })
      continue
    }
    if (live) {
      skipped.push({ name, why: '本来就活跃（在 agents.list 里）⇒ 不用唤' })
      continue
    }
    plan.push({
      name,
      reason: '失联：journal 里在编（phase 未变），但 agents.list() 里查不到 ⇒ 进程内已无它',
      // ★ 消息正文要**具体、可执行**，且**不假装它记得**（它可能已经忘了上一轮在做什么）：
      prompt:
        `【重新点名 · resume】你（${name}）在上一轮进程重启时掉线了，现在被 Lead 叫回来。` +
        `请先做两件事：① 用 team_task_list 查**你自己名下**的 in_progress 任务；` +
        `② 逐条回报"我做到哪了 / 下一步是什么"，**没有把握的写「未获取」，不要猜**。` +
        `（这条消息由 teamkit wake 发出：唤醒 = 真实点火，请按现有纪律工作。）`,
    })
  }
  return { plan, skipped, why: `扫了 ${ms.length} 个成员，需唤醒 ${plan.length} 个` }
}

/**
 * ★★ **把唤醒计划变成 `agentTeams.sendMessage` 的入参**（**纯函数，可单测**）。
 *
 * ## `request` 形状（**只读核过 `mailbox.js:97-133` 得来**，不是猜）
 * ```
 * `sendMessage(caller, request)` ⇒ `mailbox.send` ⇒ `sendAdmitted(caller, request)`
 * request 字段（逐条从源码读出）：
 *   · `target`  : string —— **成员名**（`resolveActiveMember(root, state, request.target)`；
 *                 `'lead'` 也可，`:20-21`）
 *   · `content` : array  —— **消息块数组**（`structuredClone(request.content)`；本项目惯例 `[{type:'text',text}]`）
 *   · `signal`  : **必需** —— `request.signal.throwIfAborted()`（`:99`/`:103`）；
 *                 `mailbox.send` 里 `AbortSignal.any([request.signal, lifecycle.signal])`（`:49`）
 * ⚠️ **前置（失败会抛，`R25`：前置不成立 ⇒ 报前置，不报 FAIL）**：
 *   · `resolveActiveMember` 要求该成员 **`phase === 'active'`**（`roster.js:23-25`）
 *     ⇒ **"僵尸活跃"（journal 说 active、进程里没有）恰好满足它** ⇒ 这才是能唤醒的原因
 *   · `pendingForTarget >= maxPendingMessagesPerMember` ⇒ `TEAM_MAILBOX_FULL`
 *   · `target === caller` ⇒ `TEAM_SELF_MESSAGE`；消息超 `maxMessageBytes` ⇒ `TEAM_MESSAGE_TOO_LARGE`
 * ```
 * @returns `[{target, content, prompt}]`（`prompt` 保留原文便于 dry-run 显示）
 */
export function makeWakeRequests(plan) {
  const rows = Array.isArray(plan) ? plan : []
  return rows.map((p) => ({
    target: String(p.name),
    content: [{ type: 'text', text: String(p.prompt ?? '') }],
    prompt: String(p.prompt ?? ''),
  }))
}

// ════════════════════════════════════════════════════════════════════════════
// S2 · **恢复包**（`task-106` S2）：一条命令给"现在该做什么"
// ════════════════════════════════════════════════════════════════════════════
/**
 * ★ **生成"恢复包"的行动清单**（纯函数：**只出清单，不执行任何动作**）。
 *
 * 依次覆盖三件事（与委托方原话一一对应）：
 * ```
 * ① **被中断的任务** → 孤儿清单（owner 不在了）⇒ "这条要**重新点名**"
 * ② **goal**         → `disarmed` 的 ⇒ **只给"人执行"的 resume 指令**（**不代做**：rearm = 授权动作）
 * ③ **失联成员**     → 唤醒计划 ⇒ "点哪一下"
 * ```
 * ## ⛔ 负边界
 * ```
 * · goal 侧 **绝不自动 resume** —— `disarm` 的设计意图就是"移除进程内续跑授权"，
 *   rearm 要**人授权**（`dsh-goal:615-627` 的文档原话 "human-authorized resume"）
 * · 本函数**无副作用**：不发送、不写盘、不调任何服务
 * ```
 * @param orphanReport `findOrphans(...)` 的返回
 * @param goalRows     `[{id, member, phase, activation, revision}]`
 * @param wakePlan     `planWake(...)` 的返回
 * @returns `{actions:[{kind, what, how}], summary}`
 */
export function buildResumePack(orphanReport, goalRows, wakePlan) {
  const orphans = Array.isArray(orphanReport?.orphans) ? orphanReport.orphans : []
  const goals = Array.isArray(goalRows) ? goalRows : []
  const wake = Array.isArray(wakePlan?.plan) ? wakePlan.plan : []
  const disarmed = goals.filter((g) => g?.activation === 'disarmed' && String(g?.phase ?? '') !== 'complete')
  const actions = []
  for (const o of orphans) {
    actions.push({
      kind: 'task-orphan',
      what: `孤儿任务 ${o.id}（owner=${o.owner ?? o.ownerName}）：板上写着有人在做，但那个人已不在`,
      how: `重新点名它 → \`teamkit wake --yes\`（若 owner 在 --only 名单里）；或由 Lead 另派 owner：\`team_task_create\` 前先 \`team_task_update\` 改人`,
    })
  }
  for (const g of disarmed) {
    actions.push({
      kind: 'goal-disarmed',
      what: `goal「${String(g.objective ?? g.id ?? '').slice(0, 40)}」在 ${g.id ?? '(未知会话)'} 上是 **disarmed**（会话启动时被安全关闭）`,
      // ★ CAS：ref 必须"先 get 再传"，**不许写死** revision（`dsh-goal:686-699`）
      how: `由**该会话的持有者**执行 resume（**人授权**）：先 \`get_goal\` 取当前 revision=${g.revision ?? '(未获取)'}，再 \`update_goal {action:'resume', goal_id, revision}\``,
    })
  }
  for (const w of wake) {
    actions.push({
      kind: 'member-lost',
      what: `成员 ${w.name} 失联（journal 在编、进程内没有）`,
      how: `\`teamkit wake --only ${w.name} --yes\`（**真实点火**，会耗 token）`,
    })
  }
  return {
    actions,
    summary: { orphans: orphans.length, disarmedGoals: disarmed.length, lostMembers: wake.length },
  }
}

