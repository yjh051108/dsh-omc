/**
 * e2r.js —— OMC 论文 E²R 里**图上那两样**的落地（2026-09-14 / task-60）：
 *   · **分解边** `E_tree`（这个任务从哪个任务切出来）→ 视图字段 `parentTask`
 *   · **评审判决** `q_v ∈ {accept,reject}` 写回节点 → 视图字段 `reviewState` / `reviewNote`
 *
 * ## 先把「谁负责什么」钉死（这是"抄了形式"与"真落地"的分界）
 * | 能力 | 归属 | 证据 |
 * |---|---|---|
 * | 任务板本体（建/列/读/改/CAS/依赖门） | ❌ **底座** | `dsh-experimental-tool-agent-team/lib/index.js:361-500` |
 * | `accepted` 态 | ❌ 底座**没有**（`TeamTaskStatus` 只有 4 态） | `dsh-experimental-agent-team/lib/types/types.js` |
 * | 分解边 `parent` | ❌ 底座**没有**（`TeamTaskSnapshot` 8 字段无 parent） | `.../types/task-board.js:46-54` |
 * | 三个 schema 全 `.strict()` | ⇒ **写事件加字段会被拒** | `.../lib/types/invariant.js` |
 *
 * ⇒ 所以本文件**不改底座**，只在**派生视图**与**我们自己的台账**上做加法。
 *
 * ## 三条路，本文件都实现（各自独立开关）
 * **B（侧车台账，默认开）** `<stateDir>/e2r.jsonl`，append-only ⇒ 可回放 / 可审计 / **重启后重建**。
 * **C（description 摘要，默认开）** 把结构写进 `description` —— ⚠️ **关键洞察**：
 *   `description` 是底座 `TeamTaskView` 的 **declared property**（`.../tool-agent-team/lib/index.js:94-97`）
 *   ⇒ **它本来就出现在 `team_task_list` 里** ⇒ "板上看得见结构"**不需要碰任何 schema**（零风险）。
 * **A（包派生视图 + 放开工具出口 schema，默认关）** 见下节；**它是唯一"可能打断任务板"的形态**。
 *
 * ## ★★ 路径 A 的**完整真相**（Round 95 真宿主实测，逐层读数；`E2R-GAP.md` 原稿只到第一层）
 * 原稿说"包 `at.tasks.taskView` ⇒ 字段出现在 `listTasks` 视图里"。**这句对，但不完整**，
 * 差一层就是"整个任务板报错"。三层实测：
 *
 * **① 包装点必须精确到 own 属性，不是 prototype**
 * ```
 * board own property names             = journal,maxTasks,taskView   ← **实例自有属性**
 * board.taskView === proto.taskView    = true（值相同，但查找命中 own）
 * 包 proto.taskView → board.taskView===wrapped = **false**，hits = **0**（**静默无效**）
 * 包 OWN board.taskView → === wrapped = true，hits = **62**，字段出现
 * ```
 *
 * **② 只包视图 ⇒ **整个 team_task_list 报错**
 * ```
 * Error: tool "team_task_list" returned invalid output:
 *   "value.tasks[0].parentTask" is not a declared property (additionalProperties: false)
 * ```
 * 根因：`.../tool-agent-team/lib/index.js:80` 的 `TASK_VIEW_SCHEMA` 是 `additionalProperties:false`，
 * 而 `dsh-tools/lib/index.js:3417` 对**返回值**跑 `validateJsonSchemaValue`（拒绝点 `:466-467`）。
 * ⇒ **"派生视图不再过 `.strict()`"成立**（`:strict()` 只在**写事件**时跑），
 *    **但出口还过另一道：工具 output schema** —— 两道都要过。
 *
 * **③ 那道 output schema 可以放开，但要"**逐个 `ToolRuntime` 实例**"包 —— **不是原型**（R95b 实测）**
 * ```
 * tools.get('team_task_list')             -> undefined   ← ⚠️ 不带 scope 拿不到
 * tools.get('team_task_list', agent)      -> FOUND       ← scope 就是 **agent 本身**（不是 {agent}）
 * def: frozen=false output=false schema=false items=false props=false  ← **未冻结、可改**
 * 每个 agent 各一份独立定义（真宿主 11 个 agent ⇒ 11 份 distinct）
 * ```
 * ⚠️⚠️ **`view` 也是实例自有属性 —— 与 `taskView` 是同一个坑的第 2 次**：
 * ```
 * tools own property names  = …, view, …     ← `view` 是 **own**
 * own.view 形态              = "bound view" / `function () { [native code] }`（= `proto.view.bind(实例)`）
 * tools.view === proto.view  = **false**（own 遮蔽原型）
 * 包 proto.view 后：tools.view === wrapped = **false**、直呼 `tools.view/get/schemas` 命中 **0** 次
 * 真宿主 11 个 agent ⇒ **distinct ToolRuntime = 11**（**每个 agent 一个实例**）
 * 而 `ctx.get('tools')`（插件 apply 拿到的那个）**不在**那 11 个里（实测 `= false`）
 * ```
 * ⇒ **"单点包原型"这条路不存在**（我第一版就错在这儿）。正解 = **枚举所有实例、在实例上挂 own `view`**；
 *   卸的时候**按原描述符还原**（原本没有 own 就 `delete`）。
 * ⇒ **验证也必须用 agent 自己的那个实例** —— 我第一版用 `ctx.get('tools')` 验
 *   ⇒ **装对了也报 `schema-not-freed`** ⇒ "绝不半装"的守卫**误触** ⇒ **A 永远装不上**。
 *   ⚠️ **教训：守卫自己也要被测** —— 它既能挡住半装，也能挡住**正确**的装（后者更隐蔽）。
 *
 * ## ★ 失败不静默 · **绝不半装**（这是本文件最重要的一条纪律）
 * A 的致命形态是"字段挂上了、schema 没放开 ⇒ **任务板整个报错**"。
 * ⇒ 三道保险：
 *   1. **`apply()` 先探测**（own taskView 可包？枚举得到 `ToolRuntime` 吗？）；
 *   2. **验不过就整段回滚**（装完立刻**用 agent 自己的实例**取定义看三字段在不在；不在就**拆回去**）；
 *   3. **视图包装默认拒绝**：只有 `schemaFree === true` 时才往视图加字段
 *      ⇒ 万一运行期 schema 掉了（底座升级），**退化成"没有字段"而不是"工具报错"**。
 *
 * ## 脆弱性（诚实标注，必须原样进 README）
 * ① 依赖底座**内部属性名**（`TeamTaskBoard` 的 **own** `taskView`；`ToolRuntime` 的 **own** `view`）
 *    —— **两处都是私有 API，底座改形态即失效**；
 * ② 动的是**别人包里已注册的工具定义**（`output.schema`）—— **底座升级即可能碎**；
 *    ⚠️ **它真的很脆**：`lead` 只为验证"`additionalProperties` 该不该改"随手一碰，
 *       真机上 **10 处** `additionalProperties` 就被改成了 `true`（他复核读到 `restoredAp=[true]`，已还原）；
 * ③ 包装在**内存**里 ⇒ **重启即失效**（B 的台账是盘上事实，重启后结构自动重建；A 需重新 apply）；
 * ④ 只在**本插件 apply 的那个进程**里有效；
 * ⑤ ⚠️ **仍"未实测"的一格**：**新 spawn 的成员**是否有自己的 `ToolRuntime`
 *    （本机 `spawn_teammate` 只有 Lead 能调，我**没跑成**）⇒ 靠 `agent/created` 上的 `retry()`
 *    **重新枚举并补挂**；**结构性上应当覆盖**（新 agent 会出现在 `agents.list()` 里），但**未实测**。
 *
 * ## 机制 vs 协议（`H41` 口径：不许把"我们要求"说成"我们强制"）
 * · **真机制**：`blocked_by` 的就绪门（下游 `claim` 被宿主硬拒，`is not ready to claim`，R54 实测）；
 * · **协议**：`parentTask` / `reviewState` 本身 —— 底座**不认**它们，
 *   **没有任何底座代码会因为 `reviewState !== 'accept'` 而拒绝什么**；
 *   拦住"没评审就往下走"的**只有**你按 `teamkit-review` 把**评审建成任务 + 下游 `blocked_by` 它**。
 *   ⇒ 本文件提供的是**结构与判决的落点**（看得见、可审计），**不是强制点**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** 挂到任务视图上的三个字段名（**单一事实来源**：包装与断言都读它）。 */
export const E2R_FIELDS = ['parentTask', 'reviewState', 'reviewNote']

/** 评审判决的合法值（`none` = 尚未判决）。 */
export const REVIEW_STATES = ['none', 'accept', 'reject']

/**
 * 共用 `TASK_VIEW_SCHEMA` 的 4 个底座工具（`.../tool-agent-team/lib/index.js:361-520`）。
 * ⚠️ **4 个都要放开** —— 只放 `team_task_list` 而漏掉 `create`/`get`/`update`
 * ⇒ 后三个一调就报 `additionalProperties: false`。
 */
export const TASK_TOOL_NAMES = ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']

/** `description` 里的摘要标记（**幂等**的关键：同一标记只留一行）。 */
export const SUMMARY_MARK = '【E²R】'

/**
 * `description` 的长度上限（**底座的值**，不是我们编的）：
 * `.../types/task-board.js:50` `requiredText(request.description, 'description', 16_384)`。
 * 超了会被底座拒 ⇒ 摘要追加前先判，超了**明说没写进去**（不静默截断）。
 */
export const DESCRIPTION_MAX = 16_384

/** 台账路径：绝对路径原样用；否则相对 `<stateDir>`。 */
export function trackingPathFor(stateDir, cfg) {
  const f = cfg?.trackingFile || 'e2r.jsonl'
  return isAbsolute(f) ? f : join(stateDir, f)
}

/**
 * 读台账（append-only JSONL）⇒ `Map<rootId, Map<taskId, entry>>`（**按 Team root 分桶**）。
 *
 * ⚠️ **按 root 分桶的理由与 `release.js` 相同**：任务 id 是 **per-Team** 的（`task-1` 每个队都有），
 * 全局一份必然跨队外溢。
 */
export function readLedger(file, log = () => {}) {
  const entries = new Map()
  let lines = []
  if (existsSync(file)) {
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch (err) {
      log(`E2R-TRACKING-READ-FAIL file=${file} why=${err?.message ?? err}`)
      lines = []
    }
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      // ⚠️ **坏行不静默丢**：说清楚再跳过（缺一行 = 少一条结构）
      log(`E2R-TRACKING-BAD-LINE file=${file} excerpt=${line.slice(0, 80)}`)
      continue
    }
    const rootId = typeof rec?.root === 'string' && rec.root !== '' ? rec.root : '*'
    const taskId = rec?.taskId
    if (typeof taskId !== 'string' || taskId === '') continue
    let m = entries.get(rootId)
    if (m === undefined) {
      m = new Map()
      entries.set(rootId, m)
    }
    const cur = m.get(taskId) ?? { taskId }
    if (rec?.action === 'parent') {
      cur.parentTask = typeof rec.parentTask === 'string' ? rec.parentTask : undefined
    } else if (rec?.action === 'review') {
      cur.reviewState = REVIEW_STATES.includes(rec.reviewState) ? rec.reviewState : 'none'
      cur.reviewNote = typeof rec.reviewNote === 'string' ? rec.reviewNote : undefined
    } else if (rec?.action === 'clear') {
      delete cur.parentTask
      delete cur.reviewState
      delete cur.reviewNote
    } else {
      log(`E2R-TRACKING-UNKNOWN-ACTION action=${String(rec?.action)}（跳过）`)
      continue
    }
    cur.time = rec?.time
    m.set(taskId, cur)
  }
  // 清掉"什么都没记"的桶（读数干净）
  for (const [k, m] of [...entries.entries()]) {
    for (const [tid, e] of [...m.entries()]) {
      if (e.parentTask === undefined && e.reviewState === undefined) m.delete(tid)
    }
    if (m.size === 0) entries.delete(k)
  }
  return entries
}

/** 一行人能读的结构摘要（C 路的内容；也是 `team_structure` 的一行）。 */
export function summaryLine(entry) {
  const parts = [`parent: ${entry?.parentTask ?? '(未设)'}`, `review: ${entry?.reviewState ?? 'none'}`]
  if (typeof entry?.reviewNote === 'string' && entry.reviewNote !== '') parts.push(`note: ${entry.reviewNote}`)
  return `${SUMMARY_MARK} ${parts.join(' · ')}`
}

/**
 * 把结构摘要**幂等**地合并进 `description`。
 * 幂等 = 先删掉**所有**以标记开头的旧行，再追加一行 ⇒ 反复调用结果相同（不会越堆越长）。
 * @returns `{ text, changed, tooLong }`（`tooLong=true` 表示**底座的 16384 上限**会拒，调用方**别写**）
 */
export function mergeSummary(description, entry) {
  const body = String(description ?? '').replace(/\r\n/g, '\n')
  const keeps = body.split('\n').filter((l) => !l.trim().startsWith(SUMMARY_MARK))
  while (keeps.length > 0 && keeps[keeps.length - 1].trim() === '') keeps.pop()
  keeps.push(summaryLine(entry))
  const text = keeps.join('\n')
  return { text, changed: text !== body, tooLong: text.length > DESCRIPTION_MAX }
}

/**
 * 把 `TASK_VIEW` 形状的 schema 放开三个字段。
 * **只认"形状"**（`additionalProperties === false` + 有 `properties`）——
 * 底座若改了形状，这里**什么都不做**（返回 0），由调用方据此**拒绝装**。
 * ⚠️ **两种形状，且只改其中一层**：
 *   · `TASK_LIST`（`team_task_list` 的 output）：视图在 `properties.tasks.items`，
 *     而**根对象是列表信封**（`{tasks, nextCursor}`）⇒ **绝不能往根上加我们的字段**
 *     （那会把 `parentTask` 变成列表输出自己的顶层属性 —— 语义完全错）。
 *   · `TASK_VIEW`（`create`/`get`/`update` 的 output）：**它自己**就是视图。
 *   ⇒ 判据：**有 `properties.tasks.items` 就只改 items，否则才改自己**。
 * @returns 加进去的字段数
 */
export function freeViewSchema(schema) {
  if (!schema || typeof schema !== 'object') return 0
  // ★ **二选一，不是都改**（我第一版两个都 push ⇒ `team_task_list` 的**根**也被加了 3 个字段，
  //   自测 `E2R` 组当场抓到"加了 6 个"；根上加字段是**错的语义**：那是列表信封，不是视图）
  const t = schema.properties?.tasks?.items ? schema.properties.tasks.items : schema
  if (t.additionalProperties !== false || t.properties === undefined) return 0
  let n = 0
  for (const f of E2R_FIELDS) {
    if (t.properties[f] === undefined) {
      t.properties[f] = { type: 'string' }
      n += 1
    }
  }
  return n
}

/**
 * 建一个 **E²R 管理器**：台账（B）+ 摘要（C）+ 可选派生视图（A）。
 *
 * @param opts.agentTeams 宿主的 `ctx.agentTeams`（要 `tasks` 拿 own `taskView`）
 * @param opts.tools       宿主的 `ctx.tools`（A 要包 `view`）
 * @param opts.agents      宿主的 `ctx.agents`（A 的**验证**要用它取 scope）
 * @param opts.stateDir    状态根（台账落它下面）
 * @param opts.cfg         `paths.e2r`
 * @param opts.log
 */
export function makeE2rManager({ agentTeams, tools, agents, stateDir, cfg, log = () => {} }) {
  const file = trackingPathFor(stateDir, cfg)
  const entries = readLedger(file, log)
  /** 路径 A 的状态（**默认拒绝**：只有验过才 `schemaFree=true`）。 */
  let schemaFree = false
  let patch = { ok: false, why: 'not-attempted' }
  let undos = []
  let patchedDefs = 0
  /**
   * **已挂 own `view` 的 `ToolRuntime` → 它的还原函数**。
   * ⚠️ 用 `Map` 而不是数组：`agent/created` 会**多次**调用补挂 ⇒ 必须能**按实例去重**
   *   （同一个实例挂两次 = 层层嵌套，卸的时候只还原一层 ⇒ 残留）。
   */
  const runtimeUndos = new Map()
  /** 定义克隆缓存（同一份 def 只克隆一次；`WeakMap` ⇒ 不拖住对象）。 */
  const defCache = new WeakMap()

  // ── 台账写入（**先落盘、再改内存**：重启后重建永远有据可依）─────────────────
  const append = (rec) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, why: `${err?.message ?? err}` }
    }
  }

  const rootIdOf = (root) => {
    const id = root?.id ?? root?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  const bucket = (rootId) => {
    let m = entries.get(rootId)
    if (m === undefined) {
      m = new Map()
      entries.set(rootId, m)
    }
    return m
  }
  /** 取某任务的结构记录（拿不到 rootId ⇒ `undefined`，不猜）。 */
  const entryOf = (root, taskId) => {
    const rid = rootIdOf(root)
    if (rid === undefined) return undefined
    return entries.get(rid)?.get(taskId)
  }

  /** 所有记录了结构的任务（**按 Team 分组**）。 */
  const list = () =>
    [...entries.entries()]
      .map(([root, m]) => ({ root, tasks: [...m.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)) }))
      .filter((e) => e.tasks.length > 0)
      .sort((a, b) => a.root.localeCompare(b.root))

  const record = (rec) => {
    const w = append({ version: 1, time: new Date().toISOString(), ...rec })
    if (!w.ok) {
      return { ok: false, code: 3, why: `tracking-write-failed（${w.why}）—— 台账写不进去就不改内存（否则重启后对不上）` }
    }
    return { ok: true }
  }

  // ── 写动作 ────────────────────────────────────────────────────────────────
  /**
   * 设**分解边**：`taskId` 是从 `parentTask` 切出来的。
   * ⚠️ **语义诚实**：这是"结构记录"，**不是**底座 `blocked_by`（那是**依赖边** `E_dep`）。
   *   两者在 OMC 里是两样东西，**同一对节点上方向可能相反** ⇒ 技能里必须写明"近似，不是等价"。
   */
  function setParent({ root, taskId, parentTask, reason }) {
    if (typeof taskId !== 'string' || taskId === '') return { ok: false, code: 2, why: 'taskId-required' }
    if (typeof parentTask !== 'string' || parentTask === '') return { ok: false, code: 2, why: 'parentTask-required' }
    if (parentTask === taskId) return { ok: false, code: 2, why: 'self-parent（任务不能是自己切出来的）' }
    const rid = rootIdOf(root)
    if (rid === undefined) {
      return { ok: false, code: 2, why: 'root-required（必须能确定"这是哪个 Team"—— 不给就分不清同名任务属于谁）' }
    }
    const w = record({ action: 'parent', root: rid, taskId, parentTask, reason: typeof reason === 'string' ? reason : undefined })
    if (!w.ok) return w
    const b = bucket(rid)
    b.set(taskId, { ...(b.get(taskId) ?? { taskId }), taskId, parentTask, time: new Date().toISOString() })
    log(`E2R-PARENT-OK root=${rid} task=${taskId} parent=${parentTask}`)
    return { ok: true, code: 0 }
  }

  /** 写**评审判决**（`accept` / `reject` / `none`）。`note` 在 schema 层就是必填。 */
  function review({ root, taskId, reviewState, reviewNote }) {
    if (typeof taskId !== 'string' || taskId === '') return { ok: false, code: 2, why: 'taskId-required' }
    if (!REVIEW_STATES.includes(reviewState)) {
      return { ok: false, code: 2, why: `verdict-invalid（只收 ${REVIEW_STATES.join(' / ')}）` }
    }
    if (typeof reviewNote !== 'string' || reviewNote.trim() === '') {
      return { ok: false, code: 2, why: 'note-required（判决必须带理由 —— 与"说明是更新的一部分"同一条纪律）' }
    }
    const rid = rootIdOf(root)
    if (rid === undefined) return { ok: false, code: 2, why: 'root-required（必须能确定"这是哪个 Team"）' }
    const w = record({ action: 'review', root: rid, taskId, reviewState, reviewNote })
    if (!w.ok) return w
    const b = bucket(rid)
    b.set(taskId, { ...(b.get(taskId) ?? { taskId }), taskId, reviewState, reviewNote, time: new Date().toISOString() })
    log(`E2R-REVIEW-OK root=${rid} task=${taskId} verdict=${reviewState}`)
    return { ok: true, code: 0 }
  }

  /** "这个任务被批准了吗"（**只有 `accept` 算**；`completed` 不算 —— 这正是评审门那条）。 */
  const isAccepted = (root, taskId) => entryOf(root, taskId)?.reviewState === 'accept'

  /**
   * 清掉某任务的**全部结构**（分解边 + 判决）。
   *
   * ⚠️ **为什么必须有它**：`readLedger` 认得 `action:'clear'` —— 若没有**写得出来**的入口，
   * 那个分支就是**死代码**（声明了没人读 ⇒ 正是本仓 `H30`/R73 那条"制造假能力"的反面）。
   * ⇒ 台账是 append-only，**不删行**；"清空"也是**追加一条 `clear`**（历史仍可回放）。
   */
  function clear({ root, taskId, reason }) {
    if (typeof taskId !== 'string' || taskId === '') return { ok: false, code: 2, why: 'taskId-required' }
    const rid = rootIdOf(root)
    if (rid === undefined) return { ok: false, code: 2, why: 'root-required（必须能确定"这是哪个 Team"）' }
    const w = record({ action: 'clear', root: rid, taskId, reason: typeof reason === 'string' ? reason : undefined })
    if (!w.ok) return w
    const b = entries.get(rid)
    b?.delete(taskId)
    log(`E2R-CLEAR-OK root=${rid} task=${taskId}`)
    return { ok: true, code: 0 }
  }

  // ── 路径 A ────────────────────────────────────────────────────────────────
  /**
   * 收集**所有可达的 `ToolRuntime` 实例**（**这是 R95b 修的关键缺陷所在**）。
   *
   * ⚠️⚠️ **为什么必须逐个实例，而不能"单点包 `tools.view` 原型"**（我第一版就错在这儿）：
   * ```
   * tools own property names      = …, view, …        ← `view` 是**实例自有属性**
   * own.view 名字 / 形态           = "bound view" / `function () { [native code] }`（= `proto.view.bind(实例)`）
   * tools.view === proto.view     = **false**（自有属主遮蔽原型）
   * 包 proto.view 后：tools.view === wrapped = **false**、直呼 `tools.view/get/schemas` 命中 **0** 次
   * 真宿主 agent 数 11 ⇒ **distinct ToolRuntime = 11**（**每个 agent 一个实例**）
   * ```
   * ⇒ `prototype` 上包**永远不生效**（静默），和 `TeamTaskBoard.taskView` 是**同一个坑的第 2 次**。
   * ⇒ 正解：**枚举实例、在实例上挂 own `view`**；卸的时候**按原描述符还原**（原本没有 own 就 `delete`）。
   *
   * ⚠️ **仍然"未实测"的那一格**（诚实标注）：**新 spawn 的成员**会不会有自己的 ToolRuntime、
   *   从而**不在这张枚举里** —— 本机 `spawn_teammate` 只有 Lead 能调，我**没跑成**（见交付报告）。
   *   所以 `retry()` 挂在 `agent/created` 上：**新 agent 一出现就重新枚举并补挂**。
   */
  const collectRuntimes = () => {
    const set = new Set()
    if (tools) set.add(tools)
    for (const a of agentList()) {
      let t
      try {
        t = a?.ctx?.get?.('tools')
      } catch {
        continue
      }
      if (t) set.add(t)
    }
    return [...set].filter((rt) => rt && typeof rt.view === 'function')
  }

  /** 探测"能不能装"（**拿不到/形状不对 ⇒ 如实返回 why，不猜**）。 */
  function probe() {
    if (!agentTeams?.tasks) return { ok: false, why: 'no-agentTeams.tasks（拿不到任务板 ⇒ 底座可能变了）' }
    const board = agentTeams.tasks
    const own = Object.getOwnPropertyDescriptor(board, 'taskView')
    if (!own || typeof own.value !== 'function') {
      return { ok: false, why: 'no-own-taskView（`TeamTaskBoard` 实例上没有 own `taskView` ⇒ 底座可能变了）' }
    }
    if (own.writable === false || own.configurable === false) {
      return { ok: false, why: `taskView-not-writable（writable=${own.writable} configurable=${own.configurable}）` }
    }
    if (!tools) return { ok: false, why: 'no-tools（拿不到 tools service ⇒ 没法放开出口 schema）' }
    const rts = collectRuntimes()
    if (rts.length === 0) {
      return { ok: false, why: 'no-tool-runtime（枚举不到任何可利用的 `ToolRuntime` ⇒ 底座可能变了）' }
    }
    return { ok: true, board, own, rts }
  }

  /** 拿当前所有 agent（`agents.list()` 抛错 ⇒ 空数组，由 `verify` 判"验不了"）。 */
  const agentList = () => {
    try {
      const v = agents?.list?.()
      return Array.isArray(v) ? v : []
    } catch (err) {
      log(`E2R-AGENTS-LIST-FAIL why=${err?.message ?? err}`)
      return []
    }
  }

  /**
   * 验"schema 真的放开了吗"：**对每个 agent 用它自己的 `ToolRuntime`** 取 `team_task_list` 定义，
   * 看三字段在不在。
   *
   * ⚠️⚠️ **两个都必须做到**（R95b 抓到的两个真缺陷）：
   *   ① **必须用 agent 自己的那个实例**：`ctx.get('tools')`（插件 apply 拿到的那个）**不等于**
   *      agent 用的那个（实测"我拿到的 tools 在 agent 实例列表里吗 = **false**"）。
   *      我第一版用 `tools.get(...)` 验 ⇒ **装对了也报 `schema-not-freed`** ⇒ 守卫**误触**
   *      ⇒ **A 永远装不上**（比不加守卫更糟：看起来在工作，实际从不生效）。
   *   ② **必须"全部 agent 都验到"，不能"第一个成功就返回"** —— 因为 `schemaFree` 是**全局**开关：
   *      只要**有一个** agent 的 `ToolRuntime` 没被放开，视图就会给**它**加那三个字段
   *      ⇒ **它一调 `team_task_list` 就报 `additionalProperties: false`** ⇒ **整个工具对它报错**。
   *      ⇒ 这正是"绝不半装"要防的形态，所以这里的判据是 **∀（全部）**，不是 **∃（存在一个）**。
   *
   * **一个 agent 都没有 ⇒ `verified:false`**（这时**拒绝装** —— 绝不半装）。
   */
  function verify() {
    const list = agentList()
    if (list.length === 0) {
      return { verified: false, why: 'no-agent-to-verify（还没有任何 agent ⇒ **验不了**，不假装成功）', checked: 0 }
    }
    let sawDef = 0
    const unpatched = []
    for (const a of list) {
      let rt
      try {
        rt = a?.ctx?.get?.('tools')
      } catch {
        rt = undefined
      }
      // ⚠️ 拿不到该 agent 自己的 runtime ⇒ **算"没验到"**（不比"验过"宽松）
      if (!rt || typeof rt.get !== 'function') {
        unpatched.push(`${a.id}:(no-runtime)`)
        continue
      }
      let def
      try {
        def = rt.get('team_task_list', a)
      } catch (err) {
        unpatched.push(`${a.id}:(threw)` )
        continue
      }
      if (def?.name !== 'team_task_list') {
        unpatched.push(`${a.id}:(no-def)`)
        continue
      }
      sawDef += 1
      const items = def?.output?.schema?.properties?.tasks?.items
      if (!(items?.properties && E2R_FIELDS.every((f) => f in items.properties))) unpatched.push(a.id)
    }
    if (unpatched.length === 0 && sawDef > 0) {
      return { verified: true, why: 'ok', via: `${sawDef}/${list.length} 个 agent 全验到`, checked: sawDef }
    }
    return {
      verified: false,
      why:
        `schema-not-freed（${sawDef} 份定义取到，但 **${unpatched.length}/${list.length} 个 agent 没放开**：` +
        `${unpatched.slice(0, 3).join(', ')}${unpatched.length > 3 ? ' …' : ''}）` +
        ' ⇒ 若放行，那些 agent 一调 `team_task_list` 就会报 `additionalProperties: false`',
      checked: sawDef,
    }
  }

  /**
   * 把一个定义克隆一份、并**放开**它的 output schema（原始定义**一个字节都不动**）。
   * ⚠️ **必须 `structuredClone` 后再改 clone**：直接改真机的 `def.output.schema` 会**污染底座**
   *   （`lead` 2026-09-14 实测事故：他只为验证随手一碰，真机 **10 处** `additionalProperties` 变 `true`）。
   */
  const patchedDef = (def) => {
    if (defCache.has(def)) return defCache.get(def)
    let schema
    try {
      schema = structuredClone(def.output.schema)
    } catch (err) {
      log(`E2R-PATCH-CLONE-FAIL name=${def?.name} why=${err?.message ?? err}`)
      defCache.set(def, def)
      return def
    }
    const n = freeViewSchema(schema)
    const clone = { ...def, output: { ...def.output, schema } }
    defCache.set(def, clone)
    if (n > 0) {
      patchedDefs += 1
      log(`E2R-PATCH-SCHEMA name=${def.name} added=${n}`)
    }
    return clone
  }

  /** 造一个"会把 4 个工具的 output schema 放开"的 `view`（内层调用 `orig`）。 */
  const mkView = (orig) =>
    function view(scope) {
      const v = orig.call(this, scope)
      if (!v || !(v.visible instanceof Map)) return v
      const visible = new Map()
      for (const [name, def] of v.visible) {
        visible.set(name, TASK_TOOL_NAMES.includes(name) && def?.output?.schema ? patchedDef(def) : def)
      }
      return { ...v, visible }
    }

  /**
   * ★ **我们包装的标记**（挂在包装函数上）。
   *
   * ⚠️ **为什么仅靠 `runtimeUndos` 的 Map 不够**（R95b 实测的真缺陷）：
   *   `runtimeUndos` 按**实例身份**去重，而真宿主里 `agent.ctx.get('tools')` **每次返回一个新门面**
   *   （实测：`t1 === t2` = **false**、两次快照交集 **0/11**）⇒ **身份不可靠**。
   *   后果（实测）：`dispose()` 报 `ok:true`，但真机仍留着**一个**包装 ⇒ 定义字段数 **13**（应为 10）
   *   ⇒ **"报成功但有残留"** —— 正是本仓最忌的"静默失效"。
   * ⇒ 所以还原要**双轨**：① 按登记还原（精确、快）；② **兜底扫一遍所有可达实例**，
   *   凡是**带标记**的包装一律 `delete` 掉（回落干净原型）—— 标记不依赖身份，**跨门面也认得出**。
   */
  const WRAP_MARK = Symbol.for('dsh-teamkit:e2r-view-wrapper')

  /**
   * 枚举并**补挂**所有尚未包装的 `ToolRuntime`（**增量、幂等**）。
   *
   * ⚠️ **为什么必须是"增量函数"而不是 `apply()` 里的一段循环**（R95b 的第二个真缺陷）：
   *   新 spawn 的成员可能有**自己的** `ToolRuntime` ⇒ 它**不在** `apply()` 当时枚举到的那批里
   *   ⇒ 而 `schemaFree` 是**全局**开关 ⇒ 视图会给**它**也加那三个字段，
   *   但它那条链的 output schema **没放开** ⇒ **它一调 `team_task_list` 就报错**。
   *   ⇒ 所以 `agent/created` 上必须能**只补新的那几个**（而不是"已装过就整体跳过"）。
   *
   * @returns `{ patched, failed }`（本次新挂上的个数 / 失败的个数）
   */
  function patchNewRuntimes() {
    let patched = 0
    let failed = 0
    for (const rt of collectRuntimes()) {
      if (runtimeUndos.has(rt)) continue
      try {
        const ownDesc = Object.getOwnPropertyDescriptor(rt, 'view')
        const orig = typeof ownDesc?.value === 'function' ? ownDesc.value : rt.view
        if (typeof orig !== 'function') {
          failed += 1
          continue
        }
        const desc = ownDesc ?? { writable: true, configurable: true, enumerable: true }
        if (desc.writable === false || desc.configurable === false) {
          log('E2R-PATCH-RUNTIME-SKIP why=not-writable')
          failed += 1
          continue
        }
        Object.defineProperty(rt, 'view', { ...desc, value: mkView(orig) })
        // ★ **给包装打标记**（还原的兜底扫描靠它 —— 见 `WRAP_MARK` 的说明）
        Object.getOwnPropertyDescriptor(rt, 'view').value[WRAP_MARK] = true
        // ⚠️ **原本没有 own `view` 的实例**卸的时候要 `delete`，
        //   而不是"define 回 undefined"（那会留一个 own 属性把原型挡住）。
        runtimeUndos.set(rt, () => {
          if (ownDesc === undefined) delete rt.view
          else Object.defineProperty(rt, 'view', ownDesc)
        })
        patched += 1
      } catch (err) {
        failed += 1
        log(`E2R-PATCH-RUNTIME-FAIL why=${err?.message ?? err}`)
      }
    }
    return { patched, failed }
  }

  /**
   * 还原**全部**已挂的 `ToolRuntime`；哪个没还原**报出来**。
   * ★ **双轨**（见 `WRAP_MARK`）：① 按登记还原；② **兜底扫一遍**所有可达实例，
   *   把**带标记**的包装 `delete` 掉（身份不可靠时只有这条路兜得住）。
   */
  function restoreAllRuntimes() {
    const failed = []
    for (const [rt, fn] of runtimeUndos) {
      try {
        fn()
      } catch (err) {
        failed.push(`${err?.message ?? err}`)
      }
    }
    runtimeUndos.clear()
    // ② **兜底扫描**：`ctx.get('tools')` 每次可能给新门面 ⇒ 按身份登记会漏 ⇒ 按**标记**清。
    let swept = 0
    for (const rt of collectRuntimes()) {
      let own
      try {
        own = Object.getOwnPropertyDescriptor(rt, 'view')
      } catch {
        continue
      }
      if (own && typeof own.value === 'function' && own.value[WRAP_MARK] === true) {
        try {
          delete rt.view
          swept += 1
        } catch (err) {
          failed.push(`sweep:${err?.message ?? err}`)
        }
      }
    }
    if (swept > 0) log(`E2R-UNPATCH-SWEEP removed=${swept}（按标记兜底清掉 —— 身份登记漏掉的）`)
    if (failed.length > 0) throw new Error(`${failed.length} 处还原失败: ${failed.join(' | ')}`)
  }

  /**
   * **装**路径 A（**唯一入口**）。
   *
   * 顺序：探测 → 装 view → 逐个实例装 `tools.view` → **验** → 验不过就**整段回滚**。
   * ⇒ 四种失败都返回 `ok:false` + 具体 why：开关关 / 探测失败 / 定义失败 / **验不过（已回滚）**。
   */
  function apply() {
    if (patch.ok === true) return patch
    if (cfg?.schemaPatch !== true) {
      patch = { ok: false, why: 'schemaPatch-disabled（默认 **关**：它会动底座已注册的工具定义 —— 见文件头 §脆弱性）' }
      return patch
    }
    // 风险档总闸：`e2r.enabled` 必须显式打开
    if (cfg?.enabled !== true) {
      patch = { ok: false, why: 'e2r.enabled=false（风险档总闸关着；`schemaPatch` 是它的下级开关）' }
      log(`E2R-PATCH-SKIP ${patch.why}`)
      return patch
    }
    const p = probe()
    if (!p.ok) {
      patch = { ok: false, why: p.why }
      log(`E2R-PATCH-PROBE-FAIL why=${p.why}`)
      return patch
    }

    // ① 包 **own** taskView：**只在 `schemaFree` 时加字段**（默认拒绝 ⇒ 最坏退化成"没有字段"）
    const originalTaskView = p.own.value
    const wrappedTaskView = function taskView(root, state, task) {
      const v = originalTaskView.call(this, root, state, task)
      if (schemaFree !== true) return v
      const e = entryOf(root, task?.id)
      return {
        ...v,
        parentTask: e?.parentTask ?? '',
        reviewState: e?.reviewState ?? 'none',
        reviewNote: e?.reviewNote ?? '',
      }
    }
    const undoTaskView = () =>
      Object.defineProperty(p.board, 'taskView', {
        value: originalTaskView, writable: p.own.writable, configurable: p.own.configurable, enumerable: p.own.enumerable,
      })

    // ② **逐个 `ToolRuntime` 实例**包它的 own `view`（**NOT** 原型 —— 见 `collectRuntimes` 的说明）
    const r = patchNewRuntimes()
    log(`E2R-PATCH-RUNTIMES patched=${r.patched} failed=${r.failed} total=${runtimeUndos.size}`)

    const rollback = (why) => {
      const failed = []
      for (const [name, fn] of [['taskView', undoTaskView], ['tools.view', restoreAllRuntimes]]) {
        try {
          fn()
          log(`E2R-PATCH-ROLLBACK ${name} ok`)
        } catch (err) {
          failed.push(`${name}: ${err?.message ?? err}`)
        }
      }
      schemaFree = false
      patch = {
        ok: false,
        why:
          `${why} ⇒ **已整段回滚、未装**（绝不半装）` +
          (failed.length > 0 ? `；⚠️ 但回滚有失败项：${failed.join(' | ')}` : ''),
      }
      log(`E2R-PATCH-NOT-READY ${patch.why}`)
      return patch
    }

    try {
      Object.defineProperty(p.board, 'taskView', {
        value: wrappedTaskView, writable: p.own.writable, configurable: p.own.configurable, enumerable: p.own.enumerable,
      })
    } catch (err) {
      patch = { ok: false, why: `define-taskView-failed（${err?.message ?? err}）` }
      log(`E2R-PATCH-FAIL ${patch.why}`)
      return patch
    }
    if (runtimeUndos.size === 0) {
      return rollback('no-runtime-patched（一个 `ToolRuntime` 都没挂上 ⇒ 放开 schema 不可能生效）')
    }

    // ③ **验**：验不过 ⇒ 整段回滚（绝不半装）
    const vr = verify()
    if (!vr.verified) return rollback(`unverified（${vr.why}）`)

    schemaFree = true
    undos = [['taskView', undoTaskView], ['tools.view', restoreAllRuntimes]]
    patch = { ok: true, why: 'wrapped', via: vr.via, checked: vr.checked }
    log(`E2R-PATCH-OK via=${vr.via} checked=${vr.checked} defs=${patchedDefs} runtimes=${runtimeUndos.size}`)
    return patch
  }

  /**
   * 卸载：**两段 undo 都要跑**；哪一段没还原**报出来**（不静默）。
   * ★ **最后还要"回读核验"**（同 `release.js` 那条"报了 ok 就必须真能过滤掉"）：
   *   实测过"报 `ok:true` 但真机仍留一个包装"（字段数 10→13）⇒ 不核验就会把残留说成卸净。
   */
  function dispose() {
    const failed = []
    schemaFree = false
    for (const [name, fn] of undos) {
      try {
        fn()
        log(`E2R-UNPATCH-OK ${name}`)
      } catch (err) {
        failed.push(`${name}: ${err?.message ?? err}`)
      }
    }
    undos = []
    patch = { ok: false, why: 'disposed' }
    // ★ **回读核验**：3 轮取样，凡是还带标记的包装 / 还含三字段的定义，都算**没卸净**
    let residue = 0
    for (let round = 0; round < 3; round += 1) {
      for (const rt of collectRuntimes()) {
        let own
        try {
          own = Object.getOwnPropertyDescriptor(rt, 'view')
        } catch {
          continue
        }
        if (own && typeof own.value === 'function' && own.value[WRAP_MARK] === true) {
          residue += 1
          try {
            delete rt.view
          } catch {
            /* 清不掉也要计数 */
          }
        }
      }
    }
    if (residue > 0) {
      log(`E2R-UNPATCH-RESIDUE found=${residue} ⇒ 已尽力清掉；若仍有残留会体现在下面的核验里`)
    }
    const vr = verify()
    if (vr.verified) {
      // 三字段还在 ⇒ 卸不干净（**这是失败，不是成功**）
      failed.push(`postcheck：卸载后**三字段仍在**每个 agent 的定义里（${vr.checked} 份）⇒ 没卸净`)
    }
    if (failed.length > 0) log(`E2R-UNPATCH-INCOMPLETE ${failed.join(' | ')}`)
    return { ok: failed.length === 0, why: failed.join(' | ') }
  }

  return {
    file,
    entries,
    list,
    rootIdOf,
    entryOf,
    isAccepted,
    setParent,
    review,
    clear,
    /**
     * **结构视图**（**不依赖路径 A**）：台账 + 底座视图拼出来，供我们的 `team_structure` 工具用。
     * ⇒ 这是"成员要看结构就调我们的工具、底座一个字节不动"那条路的实体。
     */
    structureFor(root, boardViews) {
      const rid = rootIdOf(root)
      const m = rid === undefined ? undefined : entries.get(rid)
      return (Array.isArray(boardViews) ? boardViews : []).map((v) => {
        const e = m?.get(v.id)
        return {
          id: v.id,
          subject: v.subject,
          status: v.status,
          ownerName: v.ownerName,
          blockedBy: v.blockedBy,
          parentTask: e?.parentTask ?? '',
          reviewState: e?.reviewState ?? 'none',
          reviewNote: e?.reviewNote ?? '',
          // ★ **accepted 的定义**：`completed` **且** 判决是 `accept`
          accepted: v.status === 'completed' && e?.reviewState === 'accept',
        }
      })
    },
    summaryLine,
    mergeSummary,
    get schemaFree() {
      return schemaFree
    },
    get patch() {
      return patch
    },
    get patchedDefs() {
      return patchedDefs
    },
    apply,
    dispose,
    /**
     * 供 `agent/created` 调用：**给新出现的 `ToolRuntime` 补挂** own `view`。
     *
     * ⚠️⚠️ **不能写成"已装过就整体跳过"**（R95b 修的真缺陷）：
     *   新 spawn 的成员可能有**自己的** `ToolRuntime` ⇒ 而 `schemaFree` 是**全局**开关
     *   ⇒ 视图会给**它**也加那三个字段，但它那条链的 schema**没放开** ⇒ **它一调就报错**。
     *   ⇒ 所以这里**每次都真跑一遍增量补挂**（幂等：已在 `runtimeUndos` 里的实例跳过）。
     * @returns `{ ok, why, patched, verified }`
     */
    retry() {
      if (cfg?.schemaPatch !== true || cfg?.enabled !== true) {
        return { ok: false, why: 'schemaPatch/enabled 未开', patched: 0, verified: patch.ok === true }
      }
      // 首次装（`patch.ok` 还不是 true）⇒ 走完整 `apply()`（含探测与验证）
      if (patch.ok !== true) return apply()
      // 已装：只补**新**的实例，然后**再验一遍**（新 agent 那条链也要验到）
      const r = patchNewRuntimes()
      if (r.patched > 0) {
        log(`E2R-PATCH-RUNTIMES-INC patched=${r.patched} total=${runtimeUndos.size}`)
        const vr = verify()
        if (!vr.verified) {
          // ⚠️ 新实例验不过 ⇒ **必须让它退回"不加字段"**，否则就是"任务板报错"那个形态。
          schemaFree = false
          log(`E2R-PATCH-RETRY-UNVERIFIED ${vr.why} ⇒ schemaFree 已置 false（退化成"没有字段"，不是"工具报错"）`)
          return { ok: false, why: `retry-unverified（${vr.why}）⇒ **已把 schemaFree 置 false**，退化成"没有字段"`, patched: r.patched, verified: false }
        }
      }
      return { ok: true, why: r.patched > 0 ? `incremental(+${r.patched})` : 'no-new-runtime', patched: r.patched, verified: true }
    },
  }
}
