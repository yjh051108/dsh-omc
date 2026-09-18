/**
 * @dsh-external/dsh-org-panel — host half.
 *
 * 把 DSH 的「公司」翻译成 OMC office 渲染器认的状态对象，再用一个前缀路由喂给侧边栏的办公室页面。
 *
 * 设计约束（用户 2026-09-11 定向）：能抄就抄、能复用就复用、不准重启。
 *   · 渲染器 = OMC 原版 office.js / office-map.js / office-tileatlas.js（**逐字未改**）
 *   · 数据面 = DSH 原生 `ctx.agentTeams`（**员工 = Agent Team 的 teammate**）
 *   · 装载   = 运行时注入（host + client 同时生效），不需要重启 dsh web
 *
 * ★ 2026-09-14 口径更正（委托方逐条指出）：
 *   ① 旧实现用 `subagents.listDescendants(rootId)` 当员工名单 ⇒ **把所有子代理都算成公司的人**（实测 47 人）。
 *      公司的人只有 **Agent Team 的 teammate**（`agentTeams.listMembers(root)` 的 roster）。
 *   ② 旧实现把所有会话堆成一幅图。现在 **一个会话一个公司**（按 Team root 分组），
 *      `/api/state` 接受 `?session=` / `?company=`，UI 有公司切换器。
 *   ③④ 板 / rules / projects / 会议室 —— 渲染器本来就有回调，缺的是「桥没接」：
 *      host 侧补齐 `/api/board` `/api/rules` `/api/projects` `/api/minutes`，client 侧在 bridge.js 里接
 *      `window.app.openWorkflowPanel / openProjectWall / openMeetingRoom / openMeetingMinutes`，
 *      并喂 `meeting_rooms`（**由真实会议记录推导**，不是编的）。
 */
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize, sep, basename, isAbsolute } from 'node:path'

export const name = '@dsh-external/dsh-org-panel'
export const inject = ['webServer']

const BASE = '/@dsh-external/dsh-org-panel'
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = join(PANEL_DIR, 'public')

/** ⚠️ 不用 os.homedir()（某些环境下它会返回与真实用户无关的值）——先认环境变量。 */
const DSH_HOME = process.env.DSH_HOME || ''

/**
 * ★ **会议多久没动静就不再算"占用中"**（2026-09-14 / R101 修委托方亲眼看到的 bug）。
 *
 * ## 现象
 * 「那三个人一直在会议室里面都没出来」—— 参会者坐在会议室**永远不散**。
 *
 * ## 根因（一行）
 * 原来判"会议是否进行中"的唯一信号是 **有没有 `-minutes.md` 纪要文件**：
 * ```js
 * const booked = r.minutes === null     // ← 没纪要 = 永远进行中
 * ```
 * 而**没人写纪要是常态**：议题开了没空收尾、一次性测试会议、被别的事打断。
 * ⇒ 于是**只要议程文件在，那间会议室就一直"占用 1"、参会者一直站在里面**。
 *
 * ## 为什么不是"让人去补纪要"
 * 那等于说"忘记收尾 = 公司卡住"—— 现实里一定会发生，**面板不该因为它挂住**。
 * 会议**没被收尾**这件事本身应该能显示出来，但**不该表现为"人还坐在里面"**。
 *
 * ## 修法
 * 议程文件最后修改时间超过这个阈值、且**仍无纪要** ⇒ 判为**已散会（未收尾）**。
 * · 有纪要 ⇒ 以有纪要为准（`has_minutes: true`，语义不变）
 * · 无纪要但很旧 ⇒ `is_booked: false`，`description` 说明"未收尾"
 * · 无纪要且很新 ⇒ 仍算进行中（**正在开**）
 *
 * 45 分钟的依据：`teamkit-meeting` 的协议是"逐人召集 → 收发言 → 落盘纪要"，
 * 一轮正常会议在**十几分钟**内；45 分钟足够宽松到不会误散正在开的会，
 * 又足以让"忘了收尾"的在**一节课内**自己散场。**不是精确值**，是个可调的数。
 */
const MEETING_STALE_MS = 45 * 60 * 1000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}
const sendJson = (res, code, obj) => send(res, code, MIME['.json'], JSON.stringify(obj))

// ── DSH 服务取用（一律窄取 + try，缺服务不致命） ─────────────────────────────

function svc(ctx, key) {
  try { return ctx.get(key) ?? null } catch { return null }
}
const teamService = (ctx) => svc(ctx, 'agentTeams')
const liveAgents = (ctx) => {
  const a = svc(ctx, 'agents')
  try { return a && typeof a.list === 'function' ? a.list() : [] } catch { return [] }
}

/** 一个 agent 的团队身份；不是团队成员（普通子代理）→ null。 */
function membershipOf(ctx, agent) {
  const t = teamService(ctx)
  if (!t || typeof t.tryMembership !== 'function') return null
  try { return t.tryMembership(agent) ?? null } catch { return null }
}

/** roster（含 **inactive** 成员——它们已不在 agents 注册表里，只有 roster 还记得）。 */
function rosterOf(ctx, root) {
  const t = teamService(ctx)
  if (!t || typeof t.listMembers !== 'function') return { members: [], error: 'agentTeams 不可用' }
  try {
    const rows = t.listMembers(root)
    return { members: Array.isArray(rows) ? rows : [], error: '' }
  } catch (e) {
    return { members: [], error: e?.message ? String(e.message) : String(e) }
  }
}

function tasksOf(ctx, root) {
  const t = teamService(ctx)
  if (!t || typeof t.listTasks !== 'function') return { tasks: [], error: 'agentTeams 不可用' }
  try {
    const rows = t.listTasks(root)
    return { tasks: Array.isArray(rows) ? rows : [], error: '' }
  } catch (e) {
    return { tasks: [], error: e?.message ? String(e.message) : String(e) }
  }
}

// ── 会话元信息（cwd → 公司名） ───────────────────────────────────────────────

async function sessionMetaById(ctx) {
  const map = new Map()
  const sq = svc(ctx, 'sessionQuery')
  try {
    if (sq && typeof sq.listSessions === 'function') {
      for (const r of (await sq.listSessions()) || []) {
        const h = r?.header
        if (h && typeof h.id === 'string') map.set(h.id, { cwd: h.cwd || '', parent: h.parentSession || null, title: h.title || '' })
      }
    }
  } catch { /* 读不到就退化：公司名用 id 前 6 位 */ }
  return map
}

/**
 * ★ task-110：`meta` 现在可能是 **null**（惰性：要么没人需要回退，要么还没建）。
 * ⇒ 这里必须 null-safe，否则 `meta.get(...)` 会抛（那会把"省 99%"变成"崩"）。
 */
const cwdOf = (agent, meta) => agent?.session?.header?.cwd || (meta && typeof meta.get === 'function' ? meta.get(agent?.id)?.cwd : '') || ''

/**
 * 会话 id 的**可区分子串**：本部署里 id 形如 `session-<uuid>`
 * ⇒ 直接 slice(0,6) 会得到一堆相同的 `sessio`（实测踩过）。
 * 所以去掉 `session-`/`session_` 前缀后再取尾巴。
 */
function idTail(id) {
  const s = String(id || '').replace(/^session[-_]/, '')
  return (s.length >= 6 ? s.slice(0, 6) : s) || String(id || '').slice(0, 6)
}

function basenameOf(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

/** 像素牌子只吃 ASCII，中文工作区名退回 Company N。 */
function asciiSafe(name, fallback) {
  const t = String(name || '').trim()
  return t !== '' && !/[^\x20-\x7E]/.test(t) ? t.slice(0, 14) : fallback
}

// ── 公司 / 员工 ──────────────────────────────────────────────────────────────

const DESK_ROW0 = 4
const DESK_ROW_STEP = 3
const MAX_ROWS = 20
const ROOM_GY_GAP = 5
// ★ R108：管理层席位（对齐原版 `D:\app\omc\...\config.py:366-372`
//   `EXEC_ROW_GY=0 / EXEC_ROW_HEIGHT=2`）。lead 坐 gy=0，teammate 从 DESK_ROW0=4 起 ⇒ 两层分得开。
const EXEC_ROW_GY = 0
const EXEC_ROW_HEIGHT = 2
const EXEC_LEAD_COL = 4   // 让开 office.js:1154 硬编码画在 col 9 的 CEO

/**
 * 收集「公司」：每个 Agent Team 的 **root（lead 会话）** = 一家公司。
 * 同一项目开两个会话 ⇒ 两个不同的 root id ⇒ **两家公司**（名字相同就带 id 后缀区分）。
 */
async function collectCompanies(ctx) {
  // ★★ task-110：**惰性建 meta**（省掉 ~99% build 时间，**零信息损失**）。
  //
  // ## 病灶（分项读数，5 次真重建逐次量）
  // ```
  //   #  | buildMs | collect | ├ listSessions | ├ roots | └ rosters | meet+levels
  //   0  |    2502 |    2479 |       **2470** |       5 |         4 |          23
  //   1  |    2456 |    2450 |       **2441** |       6 |         3 |           6
  // ```
  // ⇒ `sessionMetaById()` 的 `sq.listSessions()` **占整个 build 的 ≈99%**（roster 只要 3–5ms）。
  //
  // ## 它为什么可以省
  // `cwdOf(agent, meta)` 有两条路，**第一条免费**（agent 自带头部信息）：
  // ```
  // cwdOf = agent?.session?.header?.cwd  ||  meta.get(agent?.id)?.cwd  ||  ''
  //         ^^^^^^^^^^^^^^^^^^^^^^^^ 免费        ^^^^^^^^^^^^^^^^^^^^ 需要 listSessions
  // ```
  // 而 `meta` **只被这一条路用到** ⇒ 只有某个 lead 的第一条路为空时，才真的需要它。
  //
  // ## 实测（5 次，`freeCwdHits`/`metaCwdHits`）
  // ```
  //   #  | listSessions | freeCwdHits | metaCwdHits
  //   0  |         2957 |           2 |           0
  //   1  |         2215 |           2 |           0      ... 5 次全同
  // ```
  // ⇒ **免费路径覆盖 100% 的 lead** ⇒ `listSessions()` 现在是**纯粹白花**。
  //
  // ## 为什么用"惰性回退"而不是"直接删"
  // 直接删 = 某天某 lead 头部 cwd 为空时会**静默丢信息**（公司名退化成 `Company N`）。
  // ⇒ 保留回退：**只有真的需要时才付那次 listSessions** ⇒ 省 99% 且**不丢信息**。
  //   ★ 可见差异（CEO 的反例判据）：若某 lead 头部 cwd 为空且 meta 也没有
  //     ⇒ 公司名变成 `Company N`、`isCurrent` 仍对，但**名字可见地变了** ⇒ 可观察。
  const tm0 = Date.now()
  let meta = null
  let metaMs = 0
  const roots = new Map()
  let freeCwdHits = 0
  let metaCwdHits = 0
  const needFallback = []
  for (const agent of liveAgents(ctx)) {
    const m = membershipOf(ctx, agent)
    if (!m || m.role !== 'lead') continue           // 普通子代理在这里被排除
    const own = agent?.session?.header?.cwd
    const ownOk = !!(own && String(own).trim() !== '')
    if (ownOk) freeCwdHits += 1
    else needFallback.push(agent)                   // ← 只有这些才需要 meta
    if (!roots.has(agent.id)) roots.set(agent.id, { id: agent.id, root: agent, cwd: ownOk ? String(own) : '' })
  }
  // ★ 只有**真的需要**时才付 `listSessions()` 的代价
  if (needFallback.length > 0) {
    const tf0 = Date.now()
    meta = await sessionMetaById(ctx)
    metaMs = Date.now() - tf0
    for (const agent of needFallback) {
      const fromMeta = meta.get(agent.id)?.cwd
      if (fromMeta) {
        metaCwdHits += 1
        const c = roots.get(agent.id)
        if (c) c.cwd = cwdOf(agent, meta)
      }
    }
  }
  const tm1 = Date.now()
  const tm2 = Date.now()
  // 同一 cwd 出现多次 ⇒ 名字加 id 后缀，保证**两个会话看起来就是两家公司**
  const cwdCount = new Map()
  for (const c of roots.values()) {
    const b = basenameOf(c.cwd) || ''
    if (b !== '') cwdCount.set(b, (cwdCount.get(b) || 0) + 1)
  }
  const list = []
  let n = 0
  for (const c of roots.values()) {
    n += 1
    const base = basenameOf(c.cwd)
    const dup = base !== '' && (cwdCount.get(base) || 0) > 1
    const label = base === '' ? `Company ${n}` : (dup ? `${base} · ${idTail(c.id)}` : base)
    // roster 里**只有** teammate 才是公司的人；lead 是 CEO（office.js 自己画 CEO）
    const { members, error } = rosterOf(ctx, c.root)
    const lead = members.find((m) => m.role === 'lead') || null
    const teammates = members.filter((m) => m.role === 'teammate' || (m.role === undefined && m.id !== c.id))
    list.push({
      id: c.id,
      root: c.root,
      cwd: c.cwd,
      name: label,
      // 像素牌子（`_drawDeptSign`）只吃 ASCII：中文公司名退回 `C-<id尾>`。
      // ⚠️ 不能退回 `Company N` —— 那个 N 是**枚举序号**，会在一块中文名的牌子上
      //    显示一个毫无意义的编号（实测截图上出现过 "Company 7"）。
      labelEn: asciiSafe(base, `C-${idTail(c.id)}`),
      lead,
      teammates,
      rosterError: error,
    })
  }
  list.sort((a, b) => b.teammates.length - a.teammates.length || a.name.localeCompare(b.name))
  const tm3 = Date.now()
  // 判据读它（**我们自己的派生字段**，不进底座）
  collectCompanies.lastPhase = {
    listSessions: metaMs,           // ★ 惰性：**只在需要回退时**才 > 0
    roots: tm2 - tm1, rosters: tm3 - tm2, total: tm3 - tm0,
    companyCount: list.length,
    // ★ 决定性读数：lead 的 cwd 是"免费路径"给的还是"listSessions 的 meta"给的
    freeCwdHits, metaCwdHits,
    metaBuilt: meta !== null,       // ★ 观察缝：0 = 免费路径够用，没白花 listSessions
  }
  return { companies: list, meta }
}

/** 由 `?session=` / `?company=` 解析出要画哪家公司。 */
function pickCompany(companies, wantCompany, wantSession) {
  if (companies.length === 0) return null
  if (wantCompany) {
    const hit = companies.find((c) => c.id === wantCompany)
    if (hit) return hit
  }
  if (wantSession) {
    const hit = companies.find((c) => c.id === wantSession)
    if (hit) return hit
    // 该会话是某个 teammate ⇒ 归它 lead 的那家公司
    for (const c of companies) {
      if (c.teammates.some((m) => m.id === wantSession)) return c
    }
  }
  return companies[0]
}

// ── 会议（**由真实会议记录推导，不编**） ────────────────────────────────────
//
// DSH 原生没有「会议室」。本仓 teamkit 的会议协议是**落盘**：
//   notes/meetings/<topic>-agenda.md   （议程 = 会开了）
//   notes/meetings/<topic>-minutes.md  （纪要 = 会开完了）
// ⇒ 「会议室被占用」的判据 = 存在 agenda、且**还没有** minutes。
// ⇒ 参会人 = 议程正文里**出现过的本公司 roster 名字**（真实点名，不是编的）。

function meetingRoots(company) {
  const roots = []
  if (company?.cwd && isAbsolute(company.cwd)) roots.push(join(company.cwd, 'notes', 'meetings'))
  if (DSH_HOME) roots.push(join(DSH_HOME, 'teamkit', 'meetings'))
  roots.push(join(PANEL_DIR, 'notes', 'meetings'))
  const seen = new Set()
  return roots.filter((r) => (seen.has(r) ? false : (seen.add(r), true)))
}

function firstHeading(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    if (/^#+\s*/.test(t)) return t.replace(/^#+\s*/, '').slice(0, 60)
    if (/^(问题|议题|主题|Topic|Question)[:：]/.test(t)) return t.split(/[:：]/).slice(1).join(':').trim().slice(0, 60)
  }
  return ''
}

async function readMeetings(company) {
  const records = []
  for (const dir of meetingRoots(company)) {
    let names
    try { names = await readdir(dir) } catch { continue }
    for (const fn of names) {
      if (!fn.endsWith('-agenda.md')) continue
      const slug = fn.slice(0, -'-agenda.md'.length)
      const agendaPath = join(dir, fn)
      let agenda = ''
      try { agenda = (await readFile(agendaPath, 'utf8')).slice(0, 20000) } catch { continue }
      const minutesPath = join(dir, `${slug}-minutes.md`)
      let minutes = null
      try { minutes = (await readFile(minutesPath, 'utf8')).slice(0, 40000) } catch { minutes = null }
      // ★ **R101 修：会议"结束"的信号不能只看有没有纪要** ——
      //   原来 `booked = (minutes === null)` ⇒ **只要没人写纪要，这个会议室就永远"占用中"**，
      //   参会的人**永远坐在里面出不来**（委托方 2026-09-14 亲眼看到："那三个人一直在会议室里面都没出来"）。
      //   而"没人写纪要"是**常态**：议题开了没空收尾、测试会议、被打断 —— 都不该让人卡在屋里。
      //   ⇒ 补一条**时间兜底**：议程文件最后修改时间超过 `MEETING_STALE_MS` 且**仍无纪要**
      //     ⇒ 判为**已散会（未收尾）**。纪要一旦写上，仍然以有纪要为准（`has_minutes`）。
      let agendaMtime = 0
      try { agendaMtime = (await stat(agendaPath)).mtimeMs } catch { agendaMtime = 0 }
      records.push({ slug, agendaPath, minutesPath, agenda, minutes, agendaMtime, fromCompanyDir: company?.cwd ? dir.startsWith(company.cwd) : false })
    }
  }
  return records
}

/** 会议 → office.js 的 `meeting_rooms[]`；participants 必须是**员工 id**（渲染器按 id 找位）。 */
async function meetingRoomsFor(company, employees) {
  const records = await readMeetings(company)
  const byName = new Map()
  for (const e of employees) { byName.set(e._memberName, e); byName.set(e.name, e); byName.set(e.id, e) }
  const rooms = []
  let i = 0
  for (const r of records) {
    const parts = []
    for (const [nm, emp] of byName) {
      if (!nm || !emp) continue
      if (nm.length < 3) continue
      // 只在**议程正文**里找点名（避免把 minutes 里的叙述也算成参会）
      if (r.agenda.includes(nm) && !parts.some((p) => p.id === emp.id)) parts.push(emp)
    }
    // 本公司 cwd 下的会议：即使一个名字都没匹配上，也归本公司
    if (parts.length === 0 && !r.fromCompanyDir) continue
    // ★ 三态，不是两态（R101）：
    //   · 有纪要            ⇒ 已结束（最权威）
    //   · 无纪要 + 议程很旧 ⇒ **已散会（未收尾）** ← 这就是原来缺的那一档
    //   · 无纪要 + 议程很新 ⇒ 进行中
    const stale = r.agendaMtime > 0 && Date.now() - r.agendaMtime > MEETING_STALE_MS
    const booked = r.minutes === null && !stale
    const abandoned = r.minutes === null && stale
    rooms.push({
      id: r.slug,
      name: r.slug.slice(0, 22),
      description: firstHeading(r.agenda) || (booked ? '会议进行中' : abandoned ? '未收尾（已散会）' : '会议已结束'),
      capacity: Math.max(3, parts.length),
      position: [1 + (i % 6) * 3, 0], // gy 由 layout 落位（见 buildState）
      is_booked: booked,
      abandoned,
      participants: parts.map((e) => e.id),
      agendaPath: r.agendaPath,
      minutesPath: r.minutes !== null ? r.minutesPath : null,
      has_minutes: r.minutes !== null,
    })
    i += 1
  }
  return rooms
}

// ── 布局（一个公司一张图） ──────────────────────────────────────────────────

/**
 * 底座成员状态 → 面板渲染状态。
 *
 * ★ **R102 修：`inactive` 不该伪装成"待命"（idle）**（2026-09-14）。
 *
 * ## 现象（委托方会一眼看出来的那种）
 * 17 个员工里 **16 个显示"待命"** —— 而事实是：**16 个 teammate 全是 `inactive`（休眠）**，
 * 只有 1 个在跑。修前那一行是：
 * ```js
 * return { status: 'idle', api: true, setup: false }   // idle / inactive   ← 两者被当成一样
 * ```
 * "待命"暗示**随时在岗**；而 `inactive` 是**会话已休眠、要唤醒才动**。
 * 本部署是**长期入驻制**（委托方原话：「我们公司是长期入驻制，所有人都是长期级的」）
 * ⇒ **休眠是常态、不是异常**，但**它必须看得出来**，否则用户会以为"人都待命着怎么没人干活"。
 *
 * ## 修法：用渲染器**已有**的徽章通道，不碰 office.js
 * `office.js:938` 认 `api_online === false` ⇒ 画「🔴 API offline」徽章 + tooltip。
 * ⇒ `inactive` 走这一档（`status` 仍是 `idle`，因为**位置/姿态没有变化**，
 *    但**徽章说明它现在不响应**）。语义上准确：它没在干活，也不占运行资源。
 *
 * ⚠️ **`failed` 与 `inactive` 都走 `api_online: false`** —— 徽章相同是**可接受的**：
 *    两者对用户的实际含义都是"现在使不上"；真正的区分在 `list_zombies`（那是排查工具）。
 */
function employeeStatus(m) {
  const s = String(m?.status ?? '').toLowerCase()
  if (s === 'running') return { status: 'working', api: true, setup: false }
  if (s === 'provisioning') return { status: 'idle', api: true, setup: true }
  if (s === 'failed') return { status: 'idle', api: false, setup: false }
  if (s === 'inactive') return { status: 'idle', api: false, setup: false }   // ★ 休眠 ≠ 待命
  return { status: 'idle', api: true, setup: false }   // 真 idle（活着且闲着）
}

/**
 * ★ R108（task-69）：**岗位等级 = 读侧派生**，绝不回流底座。
 *
 * ## 硬边界（CEO 批的跨辖区口径，`task-69 §1`）
 * 读 `agentTeams` 的一切一律**只读**：不包 `journal.state`、不包 `tasks[*]`、不加 own 键。
 * 本段加的字段**只落在我们自己的派生层**（`toEmployee` 的返回值 / `office_layout`）。
 *
 * ## 数据源
 * `$DSH_HOME/teamkit/roles/INDEX.json`（`schema: teamkit/roles@1`），7 个 role 各带 `level`，
 * 取值域 `{ceo, coo, lead, ic}`。匹配方式与 `plugin/lib/roles.js` 的 `roleFor` 一致：
 * **按 roster 成员的 `name` 精确匹配**。
 *
 * ## 为什么必须"匹配不上 ⇒ null"（不许填 1）
 * 改前 `toEmployee` 写死 `level: 1` ⇒ `office.js:1225 LEVEL_NAMES[1] = 'Junior'`
 * ⇒ **把"我不知道"显示成了一个具体职级**。本部署 22 人里只有 6 人有角色档，
 * 若一律填 1，就是**给 16 个人编了个"Junior"**。
 * ⇒ 匹配不上必须是 **`null`**（渲染面不画等级标签 = 如实"无信息"）。
 *
 * ⚠️ 已知副作用（不能改 `office.js`，如实记录）：hover tooltip 会显示 `Lv.null`
 * （`office.js:1231` `LEVEL_NAMES[emp.level] || 'Lv.' + emp.level`）。它只在悬停员工时出现，
 * 且**不影响"不画等级标签"**这条判据；已计入验收报告。
 */
const ROLES_CACHE_TTL_MS = 60000
let _rolesCache = { at: 0, map: null }

/** 读 `roles/INDEX.json` ⇒ `Map<roleName, levelName>`（`{}` 表示读不到，不是错误）。 */
async function loadRoleLevels() {
  if (_rolesCache.map && Date.now() - _rolesCache.at < ROLES_CACHE_TTL_MS) return _rolesCache.map
  const map = new Map()
  const candidates = []
  if (DSH_HOME) candidates.push(join(DSH_HOME, 'teamkit', 'roles', 'INDEX.json'))
  candidates.push(join(PANEL_DIR, 'roles', 'INDEX.json'))
  for (const p of candidates) {
    try {
      const j = JSON.parse(await readFile(p, 'utf8'))
      for (const r of (j.roles || [])) {
        if (r && typeof r.name === 'string' && r.level) map.set(r.name, String(r.level))
      }
      break
    } catch { /* 下一个候选 */ }
  }
  _rolesCache = { at: Date.now(), map }
  return map
}

/**
 * 角色档的 4 个 `level` 值 → 渲染器 5 级（product-director 裁定，照做）：
 * `ceo→5 / coo→4 / lead→3 / ic→2`；**匹配不上 ⇒ `null`（不设）**。
 * `ic` 标 Mid(2) 而非 Junior(1)：本部署没有"刚入职新人"这档，标 Junior 既不实也贬低。
 */
const LEVEL_TO_RENDER = { ceo: 5, coo: 4, lead: 3, ic: 2 }

/** 派生层：成员名 → 渲染器 level（`null` = 无角色档，如实）。 */
function levelFor(memberName, levels) {
  const key = String(memberName ?? '').trim()
  if (key === '' || !levels) return null
  const name = levels.get(key)
  if (!name || !(name in LEVEL_TO_RENDER)) return null
  return LEVEL_TO_RENDER[name]
}

/**
 * 布局按人数 + 会议室数算出来（不写死）。
 *
 * ★ R108（task-69）：**分成两层**（数据源都是底座原生的，零发明）：
 *   · **管理层** = 会话 root 的 **lead**（`collectCompanies` 的 `c.lead`，来自 roster 里 role='lead' 那条）
 *     ⇒ 坐 `EXEC_ROW_GY`（执行层，gy < `dept_start_row`）
 *   · **执行层** = **teammate** ⇒ 从 `dept_start_row = DESK_ROW0(4)` 起平铺（原样不变）
 * `memberCount` **只数 teammate**，lead 单独占一个执行层席位（由 `hasLead` 决定要不要留）。
 */
function layoutFor(company, memberCount, roomCount, hasLead) {
  let step = 3
  let inner = Math.max(1, Math.floor(17 / step))
  let rows = Math.max(1, Math.ceil(memberCount / inner))
  if (rows > 12) { step = 2; inner = Math.max(1, Math.floor(17 / step)); rows = Math.max(1, Math.ceil(memberCount / inner)) }
  rows = Math.min(rows, MAX_ROWS)

  const seats = []
  // ① 管理层：lead 一席（坐前排）。列让开 CEO 硬编码的 9–10 列（`office.js:1154` 画在 col 9）。
  if (hasLead) seats.push([EXEC_LEAD_COL, EXEC_ROW_GY])
  // ② 执行层：teammate 从 dept_start_row 起
  const perRow = Math.max(1, Math.floor((19 - 1) / step))
  for (let k = 0; k < memberCount; k += 1) {
    const row = Math.min(Math.floor(k / perRow), MAX_ROWS)
    const col = 1 + (k % perRow) * step
    seats.push([col, DESK_ROW0 + row * DESK_ROW_STEP])
  }
  const maxRow = memberCount > 0 ? Math.min(Math.floor((memberCount - 1) / perRow), MAX_ROWS) : 0
  const lastGy = DESK_ROW0 + maxRow * DESK_ROW_STEP
  const roomGy = roomCount > 0 ? lastGy + ROOM_GY_GAP : 0
  // 部门牌子画在 (dept_end_row + WALL_ROWS + 1.8) 行 ⇒ 会议室要让开它
  const canvasRows = (roomCount > 0 ? roomGy + 6 : lastGy + 6)

  return {
    seats,
    roomGy,
    office_layout: {
      canvas_rows: canvasRows,
      executive_row: EXEC_ROW_GY,
      exec_row_height: EXEC_ROW_HEIGHT,   // ★ 3 → 2（对齐原版 EXEC_ROW_HEIGHT=2）
      dept_start_row: DESK_ROW0,
      dept_end_row: lastGy,
      divider_cols: [],
      // ★ 第二个 zone = **可见汇总**（`office.js:547` 会为**每个** zone 画一块牌子）。
      //   start_col === end_col ⇒ `office-map.js:_buildFloors` 的内层 `col < end_col` 不执行
      //   ⇒ **不重绘任何地板**（零副作用），但牌子照画 ⇒ 借既有渲染能力做"可见"，不改渲染器。
      //   计数由 `buildState` 在 employees 建好后填（那时才知道有档/无档各几人）。
      zones: [{
        start_col: 1,
        end_col: 19,
        label: company ? company.name : '空',
        label_en: company ? company.labelEn : 'EMPTY',
        label_color: '#c9a86a',
      }, {
        start_col: 14,
        end_col: 14,
        label: '层级汇总（待填）',
        label_en: 'MGMT -  ROLE -  NONE -',
        label_color: '#8a7a62',
      }],
    },
  }
}

/** 把一条 roster 记录翻成 OMC 员工记录（字段名对齐 office.js 的读取面）。 */
function toEmployee(m, i, seat, levels) {
  const id = String(m?.id ?? `emp-${i}`)
  const rawName = String(m?.name ?? '').trim()
  const shown = (rawName !== '' ? rawName : id.slice(0, 8)).slice(0, 14)
  const st = employeeStatus(m)
  return {
    id,
    name: shown,
    nickname: shown,
    employee_number: id,
    role: m?.role === 'lead' ? 'CEO' : 'teammate',
    title: String(m?.description || (m?.role === 'lead' ? 'Team Lead' : 'teammate')).slice(0, 60),
    // ★ R108：**匹配不上 ⇒ null**（改前写死 `1` = 给 16 个没角色档的人编了个 "Junior"）。
    //   `null` 时 `office.js:~1200` 的 `data.level ? ... : ''` 分支 ⇒ **不画等级标签**（如实"无信息"）。
    level: levelFor(rawName, levels),
    _roleLevel: (levels && levels.get(rawName)) || null,   // 派生层留档：`ceo/coo/lead/ic` 原值，供判据核对
    status: st.status,
    is_listening: false,
    api_online: st.api,
    needs_setup: st.setup,
    guidance_notes: '',
    skills: [],
    performance_history: [],
    avatar_sprite: ((i % 20) + 1),
    desk_position: seat || [2, DESK_ROW0],
    remote: false,
    _memberName: rawName,
    _teamStatus: String(m?.status ?? ''),
    _provider: m?.provider ?? '',
    _context: m?.context ?? '',
    _model: m?.model ?? '',
    _diagnostics: Array.isArray(m?.diagnostics) ? m.diagnostics : [],
  }
}

const EMPTY_LAYOUT = layoutFor(null, 0, 0).office_layout

/**
 * 建一个公司的 state。
 * ★ 员工来源 = `agentTeams.listMembers(root)` 的 **teammate** 行 —— 不再用 `listDescendants`。
 */
async function buildState(ctx, wantCompany, wantSession) {
  const t0 = Date.now()
  const svcT = teamService(ctx)
  const source = (svcT && typeof svcT.tryMembership === 'function') ? 'agentTeams' : 'unavailable'
  // ★ task-110：**分项计时**（CEO 要求"先给分项读数，再决定改哪"）。
  //   用 `Date.now()` 打三段墙钟 —— 够回答"谁是大头"，且**零依赖**（不引 profiler）。
  //   ⚠️ 这是**墙钟分段**，不是 CPU/CPU-profiler 读数；`collectCompanies` 里绝大部分是
  //      await 服务（roster/listSessions），所以"墙钟占比"与"CPU 占比"方向一致但不等于。
  const _t0 = Date.now()
  const { companies } = await collectCompanies(ctx)
  const _t1 = Date.now()
  const company = pickCompany(companies, wantCompany, wantSession)

  const teammateRows = company ? company.teammates : []
  const levels = await loadRoleLevels()
  const hasLead = !!(company && company.lead)
  const meetings = company ? await meetingRoomsFor(company, teammateRows.map((m, i) => toEmployee(m, i, null, levels))) : []
  const _t2 = Date.now()
  const { office_layout, seats, roomGy } = layoutFor(company, teammateRows.length, meetings.length, hasLead)
  for (const r of meetings) r.position = [r.position[0], roomGy]

  // ★ R108：lead 占 `seats[0]`（管理层），teammate 从 `seats[1]` 起 —— **顺序必须与 layoutFor 一致**。
  const teammates = teammateRows.map((m, i) => toEmployee(m, i, seats[hasLead ? i + 1 : i], levels))
  // lead 也翻成一条 employee（管理层一员）：`role` 会成 'CEO'，`office.js` 对它走 CEO 分支 ⇒ 不画等级标签
  const leadEmp = hasLead ? [toEmployee(company.lead, -1, seats[0], levels)] : []
  const employees = leadEmp.concat(teammates)
  const inMeeting = new Set(meetings.filter((r) => r.is_booked).flatMap((r) => r.participants))
  for (const e of employees) if (inMeeting.has(e.id)) e.is_listening = true

  // ★ R108 派生层汇总（**只加在我们自己的对象上**，绝不回流底座）：
  //   有角色档 / 无角色档 各几人 ⇒ 填进第二个 zone 的牌子 ⇒「不画」也**看得见**。
  const rosterEmp = employees.filter((e) => e.role !== 'CEO')
  const withRole = rosterEmp.filter((e) => e.level !== null && e.level !== undefined).length
  const noRole = rosterEmp.length - withRole
  const mgmtCount = employees.length - rosterEmp.length
  const zones = (office_layout.zones || []).slice()
  if (zones[1]) {
    zones[1].label = `层级：管理层 ${mgmtCount} · 有角色档 ${withRole} · 无角色档 ${noRole}`
    zones[1].label_en = `MGMT ${mgmtCount}  ROLE ${withRole}  NONE ${noRole}`
  }
  office_layout.zones = zones
  const faceSummary = { mgmtCount, withRole, noRole, rosterTotal: rosterEmp.length }

  const working = employees.filter((e) => e.status === 'working').length
  const companyViews = companies.map((c) => ({
    id: c.id,
    name: c.name,
    cwd: c.cwd,
    teammates: c.teammates.length,
    working: c.teammates.filter((m) => String(m.status) === 'running').length,
    leadName: c.lead?.name ?? 'lead',
    rosterError: c.rosterError || '',
    isCurrent: company ? c.id === company.id : false,
  }))

  return {
    generatedAt: Date.now(),
    buildMs: Date.now() - t0,
    // ★ task-110 分项计时 —— **诊断字段**（product-director 裁 A：保留 + 显式标注）
    //   ⚠️ **它不是契约字段**：`bridge.js` / 前端**一律不读**它，删掉不影响任何功能。
    //   保留理由：分项读数（`listSessions ≈99%` 那一刀）就是靠它读出来的；
    //   删了它 ⇒ 下次要分项还得再改一次代码（成本 > 收益）。
    //   计时点：`_t0`=buildState 入口 · `_t1`=collectCompanies 返回后
    //           `_t2`=loadRoleLevels+meetingRoomsFor 之后 · `rest`=之后到 return
    //   ⚠️ 是**墙钟**分段，不是 CPU-profiler 读数。
    phaseMs: {
      collectCompanies: _t1 - _t0,
      meetingsAndLevels: _t2 - _t1,
      rest: Date.now() - _t2,
      // collectCompanies 内部的四项（见 `collectCompanies.lastPhase`；没跑到就是 null）
      collectDetail: collectCompanies.lastPhase || null,
    },
    building: false,
    source,
    company: company ? {
      id: company.id,
      name: company.name,
      cwd: company.cwd,
      teammateCount: teammateRows.length,
      lead: company.lead ? { id: company.lead.id, name: company.lead.name, status: company.lead.status, model: company.lead.model ?? '' } : null,
      isCurrent: true,
    } : null,
    companies: companyViews,
    employees,
    office_layout,
    meeting_rooms: meetings,
    tools: [],
    company_tokens: 0,
    version: '2.0.0',
    // ★ R108 派生汇总（判据读它核对"诚实 + 可见"两条；**不是底座字段**）
    levels: {
      face: faceSummary,
      distinctLevels: [...new Set(employees.map((e) => e.level))],
    },
    summary: {
      total: employees.length,
      working,
      idle: employees.length - working,
      teams: company ? 1 : 0,
      companies: companyViews.length,
      companyId: company ? company.id : '',
      companyName: company ? company.name : '',
      meetingRooms: meetings.length,
      bookedRooms: meetings.filter((r) => r.is_booked).length,
      inMeeting: inMeeting.size,
      teamNames: companyViews.map((c) => `${c.name}(${c.teammates})`),
      // 旧口径的旁证（面板不显示，只用于核对"改前 47 人"这件事）
      liveAgents: liveAgents(ctx).length,
    },
  }
}

// ── 缓存：/api/state 永不阻塞（页面 1.5s 拉一次） ────────────────────────────
const CACHE_TTL_MS = 3000
const EMPTY_STATE = {
  generatedAt: 0, buildMs: 0, building: true, source: 'pending',
  company: null, companies: [], employees: [],
  office_layout: EMPTY_LAYOUT, meeting_rooms: [], tools: [], company_tokens: 0, version: '2.0.0',
  summary: { total: 0, working: 0, idle: 0, teams: 0, companies: 0, companyId: '', companyName: '', meetingRooms: 0, bookedRooms: 0, inMeeting: 0, teamNames: [], liveAgents: 0 },
}
/**
 * ★★ R109（task-68 步骤 A）：缓存从**单一全局槽**改为 **Map<key, slot>** + **键归一化**。
 *
 * ## 病灶（A/B 实测，`tools/probe-cold-window.mjs`）
 * 改前 `cache` 只有一个槽：`cache.key` 一被别的键写掉，`stateFast` 就
 * `if (!sameKey) return EMPTY_STATE` ⇒ 返回 `building:true / total:0`
 * ⇒ 前端把「读不到」画成「0 人」⇒ 委托方看到的「公司一闪一闪」。
 * ```
 *                                    改前       改后
 * A 页面真实冷启动（首拍 s:<id> → 稳态 c:<id>）  3/3 pending   0/3 pending
 * B 键形态交替 20 拍                             20/20         0/20
 * ```
 * ⇒ 闪集中在**冷启动期的键 churn**，稳态本来就是 0（所以"稳态 0"不算证据）。
 *
 * ## 为什么必须先分槽、再 SWR（**顺序不许反** —— COO 裁定的决定性安全理由）
 * 若先做 SWR 再分槽，很容易实现成「`cache.state` 非空就返回它」
 * ⇒ **A 公司的请求会让 B 公司页面拿到 A 的员工列表 ⇒ 串公司**
 * ⇒ 比「一闪一闪」更坏的**错误数据**。分槽是 SWR 的安全前提：**SWR 只读本槽**，结构上不可能跨公司。
 */
const SLOT_MAX = 24          // 槽上限（防无界增长；超了按最旧淘汰）
const slots = new Map()      // key → { at, state, building }

/**
 * 键归一化：**同一公司不同 session ⇒ 同一键**；**不同公司 ⇒ 必须不同键**。
 *
 * ⚠️ 只做**零 IO 的字符串归一化**（快路的要害就是零 IO，不能为了认公司去读服务）。
 *   页面首拍 `?company=&session=X`（键 `s:X`）与稳态 `?company=<id>&session=X`（键 `c:<id>`）
 *   仍是两个键，靠 `startBuild` 里的**别名回填**接起来（那一步的信息取自 state 自己）。
 * ⚠️ **不许**把空 company 的情形并到 `c:` 前缀下 —— 那会把不同会话混进同一槽
 *   （session→company 的解析要 IO，纯函数做不到），**正是串公司的成因**。
 */
export function normalizeKey(company, session) {
  const c = String(company ?? '').trim()
  const s = String(session ?? '').trim()
  if (c !== '') return `c:${c}`
  if (s !== '') return `s:${s}`
  return 'auto'
}

/** 取（必要时建）一个槽；超上限时按 `at` 淘汰最旧的一个。 */
function slotOf(key) {
  let sl = slots.get(key)
  if (sl) return sl
  sl = { at: 0, state: null, building: null }
  slots.set(key, sl)
  if (slots.size > SLOT_MAX) {
    let oldestKey = null, oldestAt = Infinity
    for (const [k, v] of slots) {
      if (k === key) continue
      const at = v.at || 0
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    if (oldestKey !== null) slots.delete(oldestKey)
  }
  return sl
}

/** 只读观测（判据用）：当前槽的键与新鲜度，不含内容。 */
export function slotSnapshot() {
  const out = []
  for (const [k, v] of slots) out.push({ key: k, hasState: v.state !== null, building: v.building !== null, ageMs: v.at ? Date.now() - v.at : null })
  return out
}

function startBuild(ctx, key, company, session) {
  const sl = slotOf(key)
  if (sl.building !== null) return sl.building          // ★ 本槽去重（**别的槽完全不受影响**）
  sl.building = buildState(ctx, company, session)
    .then((s) => {
      sl.at = Date.now(); sl.state = s; sl.building = null
      // ★ **别名回填（零 IO，且不引入跨公司风险）** —— A 组 3/3 → 0/3 的关键。
      //   页面首拍 `?company=&session=<rootId>`（键 `s:<rootId>`），稳态 `?company=<rootId>`
      //   （键 `c:<rootId>`）⇒ 两个键；首拍建的那份稳态看不见 ⇒ 稳态头几拍又 pending。
      //   ⇒ 用**刚建出来的 state 自己声明的 `company.id`** 补一个 `c:<id>` 别名。
      //   ⚠️ **为什么安全**：别名键**取自 state 自身的 company.id**（不是从请求参数猜的）
      //      ⇒ 结构上不可能把 A 公司的数据挂到 B 公司的键上。
      //   ⚠️ 只在别名槽**空或更旧**时写入（不让慢 build 覆盖新数据）。
      const cid = s && s.company && s.company.id
      if (cid) {
        const alias = normalizeKey(cid, '')
        if (alias !== key) {
          const asl = slots.get(alias)
          if (!asl || asl.at === 0 || asl.at < sl.at) {
            slots.set(alias, { at: sl.at, state: s, building: null })
          }
        }
      }
      return s
    })
    .catch(() => { sl.building = null; return sl.state ?? EMPTY_STATE })
  return sl.building
}

/**
 * 快路：**零 IO** —— 这是要害。
 * `collectCompanies` 要读 `listSessions` + 每个 root 的 roster，实测 **~1.2s**；
 * 而 `/api/state` 被页面每 1.5s 拉一次 ⇒ 若在这里做 IO，请求会堆积、页面 fetch 永不 settle。
 * ⇒ 所以缓存键用**请求原样给的** `company|session` 串（不需要任何 IO 就能算出来），
 *   命中就直接给；没命中就踢一次后台重建 + 这一拍先给空（下一拍就有）。
 * ⇒ bridge 首拍与切公司时带 `?wait=1`（走慢路等建完），稳态轮询走快路。
 */
function cacheKey(company, session) {
  return normalizeKey(company, session)
}

/**
 * ★ **判据用的纯函数缝**（task-68 C1 机制级单测）：
 * 「给定一个槽 + 新鲜度 ⇒ 该返回什么」这一段**是纯逻辑**，抽出来就能**直接单测**，
 * 不必去碰 host 进程里的那个 Map（那也碰不到 —— 判据是另一个 node 进程）。
 *
 * ⚠️ `stateFast` **必须走这个函数**（否则单测测的是副本、与真实路径脱钩 —— 那才是假证据）。
 */
export function pickFastResponse(slot, fresh, company) {
  const sl = slot || { state: null }
  if (sl.state !== null && sl.state !== undefined) {
    return Object.assign({}, sl.state, { cached: !!fresh, stale: !fresh })
  }
  // 本槽**从未**有过值（真正的冷启动）⇒ 空态，**如实**表示"还不知道"。
  return Object.assign({}, EMPTY_STATE, { building: true, pendingCompany: company || '' })
}

function stateFast(ctx, key, company, session) {
  const sl = slotOf(key)
  const fresh = sl.state !== null && Date.now() - sl.at < CACHE_TTL_MS
  if (!fresh) startBuild(ctx, key, company, session)
  return pickFastResponse(sl, fresh, company)
}

async function stateFresh(ctx, key, company, session) {
  const sl = slotOf(key)
  if (sl.state !== null && Date.now() - sl.at < CACHE_TTL_MS) {
    return Object.assign({}, sl.state, { cached: true })
  }
  return await startBuild(ctx, key, company, session)
}

// ── 点开面（板 / rules / projects / 纪要） ──────────────────────────────────

function rulesCandidates(company) {
  const out = []
  if (DSH_HOME) out.push(join(DSH_HOME, 'teamkit', 'RULES.yml'))
  if (company?.cwd && isAbsolute(company.cwd)) out.push(join(company.cwd, 'RULES.yml'))
  out.push(join(PANEL_DIR, 'RULES.yml'))
  return out
}

async function readRules(company) {
  for (const p of rulesCandidates(company)) {
    try {
      const text = await readFile(p, 'utf8')
      return { path: p, exists: true, text: text.slice(0, 60000) }
    } catch { /* next */ }
  }
  return { path: '', exists: false, text: '', tried: rulesCandidates(company) }
}

function trimTask(t) {
  return {
    id: String(t?.id ?? ''),
    revision: t?.revision ?? 0,
    subject: String(t?.subject ?? ''),
    status: String(t?.status ?? ''),
    ownerName: t?.ownerName ?? '',
    ready: t?.ready === true,
    blockedBy: (t?.blockedBy ?? []).map(String),
    writeScopes: (t?.writeScopes ?? []).map(String),
    description: String(t?.description ?? '').slice(0, 1200),
  }
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

async function handleApi(ctx, req, res) {
  const raw = String(req.url ?? '')
  const [path, qs = ''] = raw.split('?')
  const q = new URLSearchParams(qs)
  const wantCompany = q.get('company') || ''
  const wantSession = q.get('session') || ''

  // ★ `/api/state` 先走**零 IO** 快路：缓存键只由请求参数算出，不碰任何服务。
  //   （子路由才需要 collectCompanies ⇒ 放在下面；否则每 1.5s 的轮询会被 ~1.2s 的
  //     listSessions 拖住，请求堆积、页面 fetch 永不 settle —— 实测踩过。）
  if (!path.endsWith('/debug') && !path.endsWith('/rules') && !path.endsWith('/board')
    && !path.endsWith('/projects') && !path.endsWith('/minutes')) {
    const key = cacheKey(wantCompany, wantSession)
    const state = q.get('wait') === '1'
      ? await stateFresh(ctx, key, wantCompany, wantSession)
      : stateFast(ctx, key, wantCompany, wantSession)
    sendJson(res, 200, state)
    return
  }

  const { companies, meta } = await collectCompanies(ctx)
  const company = pickCompany(companies, wantCompany, wantSession)

  if (path.endsWith('/debug')) {
    // 逐个活 agent 报它的团队身份 —— "为什么是 N 个人" 的可核证据
    const rows = liveAgents(ctx).map((a) => {
      const m = membershipOf(ctx, a)
      return {
        agentId: a.id,
        cwd: cwdOf(a, meta),
        parent: a?.session?.header?.parentSession ?? null,
        membership: m ? { role: m.role, name: m.name, rootId: m.root?.id ?? null } : null,
      }
    })
    const detail = companies.map((c) => ({
      companyId: c.id, name: c.name, cwd: c.cwd,
      rosterError: c.rosterError,
      roster: (c.teammates || []).map((m) => ({ id: m.id, name: m.name, role: m.role, status: m.status })),
      lead: c.lead ? { id: c.lead.id, name: c.lead.name, status: c.lead.status } : null,
    }))
    sendJson(res, 200, {
      source: teamService(ctx) ? 'agentTeams' : 'unavailable',
      liveAgents: rows.length,
      members: rows.filter((r) => r.membership !== null).length,
      notMembers: rows.filter((r) => r.membership === null).length,
      companies: companies.length,
      rows, detail,
    })
    return
  }

  if (path.endsWith('/rules')) {
    sendJson(res, 200, await readRules(company))
    return
  }

  if (path.endsWith('/board')) {
    if (!company) { sendJson(res, 200, { tasks: [], error: 'no company' }); return }
    const { tasks, error } = tasksOf(ctx, company.root)
    sendJson(res, 200, { company: { id: company.id, name: company.name }, tasks: tasks.map(trimTask), error })
    return
  }

  if (path.endsWith('/projects')) {
    const out = []
    for (const c of companies) {
      const { tasks, error } = tasksOf(ctx, c.root)
      out.push({
        id: c.id, name: c.name, cwd: c.cwd,
        teammates: c.teammates.length,
        tasks: tasks.length,
        completed: tasks.filter((t) => String(t?.status) === 'completed').length,
        inProgress: tasks.filter((t) => String(t?.status) === 'in_progress').length,
        tasksError: error,
        isCurrent: company ? c.id === company.id : false,
      })
    }
    sendJson(res, 200, { companies: out })
    return
  }

  if (path.endsWith('/minutes')) {
    const roomId = q.get('room') || ''
    if (!company) { sendJson(res, 404, { error: 'no company' }); return }
    const records = await readMeetings(company)
    const rec = records.find((r) => r.slug === roomId)
    if (!rec) { sendJson(res, 404, { error: 'meeting not found', roomId, tried: meetingRoots(company) }); return }
    sendJson(res, 200, {
      id: rec.slug,
      agendaPath: rec.agendaPath,
      minutesPath: rec.minutes !== null ? rec.minutesPath : null,
      hasMinutes: rec.minutes !== null,
      agenda: rec.agenda,
      minutes: rec.minutes,
    })
    return
  }

  // 兜底：未知子路由，给当前公司的快照（不阻塞）
  const key = cacheKey(wantCompany, wantSession)
  sendJson(res, 200, stateFast(ctx, key, wantCompany, wantSession))
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(String(req.url ?? '').split('?')[0].slice(`${BASE}/office`.length))
  if (rel === '' || rel === '/') rel = '/index.html'
  const rootAbs = normalize(join(PUBLIC_DIR, 'office'))
  const abs = normalize(join(rootAbs, rel))
  if (!abs.startsWith(rootAbs + sep)) {
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden')
    return
  }
  try {
    const info = await stat(abs)
    if (!info.isFile()) throw new Error('not a file')
    const ext = abs.slice(abs.lastIndexOf('.'))
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    })
    createReadStream(abs).pipe(res)
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', `not found: ${rel}`)
  }
}

export function apply(ctx) {
  // 装载即预热一次（默认公司），面板打开时就有数据。
  // ⚠️ 键必须走 `cacheKey`（= `normalizeKey`）—— 写死 `'|'` 会预热到一个**没人会用的槽**
  //    （归一化后空参的键是 `'auto'`）⇒ 预热白做，首拍照样 miss。
  setTimeout(() => { startBuild(ctx, cacheKey('', ''), '', '') }, 1200)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${BASE}/api`,
    handler: (req, res) => {
      handleApi(ctx, req, res).catch(() => send(res, 500, MIME['.json'], '{"error":"state failed"}'))
    },
  }), 'org-panel: state api')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${BASE}/office`,
    handler: (req, res) => {
      serveStatic(req, res).catch(() => send(res, 500, 'text/plain; charset=utf-8', 'io error'))
    },
  }), 'org-panel: office static')
}
