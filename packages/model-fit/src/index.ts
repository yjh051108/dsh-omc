/**
 * @dsh-external/dsh-model-fit — 模型适配层 v0.2
 *
 * 两个模块，都挂在 DeepSeek-V4.1-Flash 技术报告的实测结论上：
 *
 * M1 尺子闸（v0.1）
 *   检测「改了东西，尺子却不动」——不同输入读回同一结果，或同一输入反复读回同一结果。
 *   注入自带证据的事实陈述（证据=触发用的那几次入参/读回值）。
 *
 * M2 压缩锚点（v0.2）
 *   论文 §3.2.2：SWA 有界重放「重建出的状态是近似的…依赖缓存命中位置」；
 *   §2.3.2：CSA2 的稀疏检索按块级打分建候选池，没进池的信息后续层找不回来。
 *   而压缩事件自带 shadowedSeqs——精确告诉我们哪些事件刚被埋掉。
 *   据此把「刚被埋掉的开发者原话」重贴回近场（原话，不是我的复述）。
 *
 * 设计原则（为「不烦」服务）：
 *   1. 自带证据：每条干预写明凭什么，模型可据此判断对错
 *   2. 不命令：陈述事实 + 提议动作，不含祈使
 *   3. 有上限：每会话最多 maxPerSession 条，条间有冷却
 *   4. 会闭嘴：干预后若读数仍不动 → 记 ignored，连续 ignored 达阈 → 本会话静默
 *   5. 全程 try-catch 静默：闸故障绝不碰主路
 *
 * 落点：~/.dsh/model-fit/<sid>.jsonl（追加式台账，供事后判对错）
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from 'schemastery'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pickAnchors, countCandidates, worthAnchoring, residual, type HumanMsg } from './anchor-core.js'

export const name = '@dsh-external/dsh-model-fit'
export const inject = ['tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** M1：触发所需的最少连续相同读数次数 */
  minRepeat: z.number().default(3),
  /** M1：每会话最多注入几条 */
  maxPerSession: z.number().default(5),
  /** M1：两条干预之间的最小间隔（毫秒） */
  cooldownMs: z.number().default(120000),
  /** M1：判定期（工具调用数） */
  judgeWindow: z.number().default(20),
  /** M1：连续 ignored 达几次后本会话静默 */
  silenceAfterIgnored: z.number().default(2),
  /** M2：压缩后重贴开发者原话 */
  anchorAfterCompaction: z.boolean().default(true),
  /** M2：每次重贴最多几条 */
  anchorMax: z.number().default(3),
  /** M2：每条截断字符数 */
  anchorChars: z.number().default(110),
  /** M2：上下文骤降多少比例算一次压缩（事件缺失时的兜底） */
  compactionDropRatio: z.number().default(0.6),
  /** M2：太短的原话不当锚点（防空话/单词命令噪声——与闭环插件首轮 ≥12 字同口径） */
  anchorMinChars: z.number().default(12),
})

export interface FitConfig {
  enabled: boolean
  minRepeat: number
  maxPerSession: number
  cooldownMs: number
  judgeWindow: number
  silenceAfterIgnored: number
  anchorAfterCompaction: boolean
  anchorMax: number
  anchorChars: number
  compactionDropRatio: number
  anchorMinChars: number
}

// ── 工具分类 ────────────────────────────────────────────────────────────────
/** 读数类：其结果是「关于世界的证据」 */
const READING_TOOLS = new Set([
  'pwsh', 'read', 'grep', 'glob', 'job_output', 'read_image', 'web_fetch', 'web_search',
])
/** 变更类：动手改了东西 */
const WRITE_TOOLS = new Set(['edit', 'write'])
/** pwsh 里的变更特征（本机实测：坏尺子段 98 次文件手术就长这样） */
const PWSH_MUTATION = /Set-Content|Out-File|Add-Content|-replace|\.Replace\(|Remove-Item|New-Item|Copy-Item|Move-Item|>>|Set-ItemProperty/

function isWrite(tool: string, args: unknown): boolean {
  if (WRITE_TOOLS.has(tool)) return true
  if (tool !== 'pwsh') return false
  try {
    const a = args as Record<string, unknown> | undefined
    return PWSH_MUTATION.test(String(a?.['command'] ?? ''))
  } catch { return false }
}

interface CallRec {
  key: string
  tool: string
  argFp: string
  resFp: string
  brief: string
  excerpt: string
  at: number
}

interface Pending {
  at: number
  kind: string
  stuckFp: string
  checkAtCall: number
  verdict: 'adopted' | 'ignored' | null
}

interface AnchorJob {
  at: number
  shadowed: number
  preCtx: number
  msgs: HumanMsg[]
}

interface SessionState {
  recent: CallRec[]
  writes: number[]
  calls: number
  fired: number
  lastFireAt: number
  firedKeys: Set<string>
  ignoredStreak: number
  pending: Pending | null
  ledger: Array<Record<string, unknown>>
  // ── M2 状态 ──
  humans: HumanMsg[]
  restatedSeqs: Set<number>
  anchor: AnchorJob | null
  lastCtx: number
  compactions: number
  /** 是否已从 session.events 回填过历史真人原话（重启后 M2 不至于空手） */
  backfilled: boolean
}

const RING = 12
const ledgerDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'model-fit')

function sha(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

/** 从工具结果里抠出可比对的文本（形状未知，全部防御式） */
function textOf(result: unknown, depth = 0): string {
  if (result == null || depth > 4) return ''
  if (typeof result === 'string') return result
  if (typeof result !== 'object') return String(result)
  const r = result as Record<string, unknown>
  if (Array.isArray(r['content'])) {
    const parts = (r['content'] as unknown[]).map((c) => textOf(c, depth + 1)).filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  for (const k of ['content', 'value', 'text', 'output', 'result', 'data', 'message']) {
    const v = r[k]
    if (v === undefined) continue
    const t = textOf(v, depth + 1)
    if (t) return t
  }
  try { return JSON.stringify(result) } catch { return '' }
}

/** 从消息 content 里抠出纯文本 */
function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const c of content) {
    const o = c as { type?: string; text?: string } | undefined
    if (o && o.type === 'text' && typeof o.text === 'string') out += o.text
  }
  return out
}

function canonArgs(name: string, args: unknown): string {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args ?? {})
    return s.replace(/[0-9a-f]{16,}/gi, '<hex>').replace(/\d{10,}/g, '<num>')
  } catch { return name }
}

function briefArgs(name: string, args: unknown): string {
  try {
    const a = args as Record<string, unknown> | undefined
    const cmd = a?.['command'] ?? a?.['file_path'] ?? a?.['path'] ?? a?.['pattern'] ?? a?.['job_id']
    const s = typeof cmd === 'string' ? cmd : JSON.stringify(args ?? {})
    return s.replace(/\s+/g, ' ').slice(0, 120)
  } catch { return name }
}

function newState(): SessionState {
  return {
    recent: [], writes: [], calls: 0, fired: 0, lastFireAt: 0, firedKeys: new Set(),
    ignoredStreak: 0, pending: null, ledger: [],
    humans: [], restatedSeqs: new Set(), anchor: null, lastCtx: 0, compactions: 0, backfilled: false,
  }
}

/**
 * 从 session.events 回填历史真人原话。
 * 动机：session/event 钩子只看得见注册之后的事件——插件一重载，M2 就是空手，
 * 而「压缩后重贴开发者原话」恰恰依赖历史。宿主 session.events 是全量快照，一次扫描即可。
 */
function backfill(s: SessionState, session: any, persist?: (rec: Record<string, unknown>) => void): void {
  if (s.backfilled) return
  s.backfilled = true
  const diag: Record<string, unknown> = {
    rec: 'backfill', at: Date.now(),
    hasSession: !!session,
    keys: session ? Object.keys(session).slice(0, 20) : [],
  }
  // 三路尝试：events getter / log / snapshotEvents()
  let evs: unknown = undefined
  try { evs = session?.events; diag['eventsType'] = Array.isArray(evs) ? 'array' : typeof evs } catch (e) { diag['eventsErr'] = String(e) }
  if (!Array.isArray(evs)) {
    try { evs = (session as any)?.log; diag['logType'] = Array.isArray(evs) ? 'array' : typeof evs } catch (e) { diag['logErr'] = String(e) }
  }
  if (!Array.isArray(evs) && typeof (session as any)?.snapshotEvents === 'function') {
    try { evs = (session as any).snapshotEvents(); diag['snapType'] = Array.isArray(evs) ? 'array' : typeof evs } catch (e) { diag['snapErr'] = String(e) }
  }
  if (Array.isArray(evs)) {
    diag['n'] = evs.length
    const sample = evs.find((e: any) => e?.type === 'user/message')
    diag['sampleKeys'] = sample ? Object.keys(sample).slice(0, 12) : null
    diag['sampleSrc'] = sample ? JSON.stringify((sample as any)?.data?.source ?? null).slice(0, 120) : null
    for (const e of evs as any[]) {
      if (e?.type !== 'user/message') continue
      const src = e?.data?.source
      if (src?.kind !== 'user' || src?.plugin || e?.data?.goalId) continue
      const txt = plainText(e?.data?.content).trim()
      if (txt) s.humans.push({ seq: Number(e?.seq ?? -1), text: txt })
    }
    if (s.humans.length > 200) s.humans = s.humans.slice(-200)
  }
  diag['humans'] = s.humans.length
  // 诊断只在「一条原话都没捞到」时全量落盘——台账是拿来判对错的，不是拿来读诊断的
  if (persist) {
    try {
      persist(s.humans.length > 0
        ? { rec: 'backfill', at: Date.now(), humans: s.humans.length, events: diag['n'] ?? null }
        : diag)
    } catch { /* 静默 */ }
  }
}

export function apply(ctx: Context, config: FitConfig): void {
  const sessions = new Map<string, SessionState>()
  const persist = (sid: string, rec: Record<string, unknown>): void => {
    try {
      mkdirSync(ledgerDir(), { recursive: true })
      appendFileSync(join(ledgerDir(), `${sid}.jsonl`), JSON.stringify(rec) + '\n', 'utf8')
    } catch { /* 台账失败不碰主路 */ }
  }

  // ── 状态持久化：热重载是开发常态，不持久化就会丢预算/已贴标记/未结裁定 ──
  const stateFile = (sid: string): string => join(ledgerDir(), `${sid}.state.json`)
  const saveState = (sid: string, s: SessionState): void => {
    try {
      mkdirSync(ledgerDir(), { recursive: true })
      writeFileSync(stateFile(sid), JSON.stringify({
        v: 1, at: Date.now(),
        fired: s.fired, lastFireAt: s.lastFireAt, ignoredStreak: s.ignoredStreak,
        firedKeys: [...s.firedKeys], restatedSeqs: [...s.restatedSeqs],
        lastCtx: s.lastCtx, compactions: s.compactions,
        pending: s.pending ? { at: s.pending.at, kind: s.pending.kind, stuckFp: s.pending.stuckFp } : null,
      }), 'utf8')
    } catch { /* 静默 */ }
  }
  const hydrate = (sid: string, s: SessionState): void => {
    try {
      const f = stateFile(sid)
      if (!existsSync(f)) return
      const j = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
      s.fired = Number(j['fired'] ?? 0)
      s.lastFireAt = Number(j['lastFireAt'] ?? 0)
      s.ignoredStreak = Number(j['ignoredStreak'] ?? 0)
      s.firedKeys = new Set((j['firedKeys'] as string[]) ?? [])
      s.restatedSeqs = new Set(((j['restatedSeqs'] as number[]) ?? []).map(Number))
      s.lastCtx = Number(j['lastCtx'] ?? 0)
      s.compactions = Number(j['compactions'] ?? 0)
      // 未结干预：重载后读数组已丢，已无法裁定 → 如实记 unresolved，不冒充 adopted/ignored
      const p = j['pending'] as Record<string, unknown> | null
      if (p && p['at']) {
        persist(sid, { rec: 'verdict', at: Date.now(), fireAt: p['at'], verdict: 'unresolved', note: '重载丢失判定期' })
      }
    } catch { /* 静默 */ }
  }

  const st = (sid: string): SessionState => {
    let s = sessions.get(sid)
    if (!s) { s = newState(); hydrate(sid, s); sessions.set(sid, s) }
    return s
  }

  // ── ① 观测 A：读数指纹（M1）──────────────────────────────────────────────
  ctx.effect(() => (ctx.on as unknown as (ev: string, fn: (...a: any[]) => any) => () => void)('tools/result', (...args: any[]) => {
    try {
      if (!config.enabled) return
      const exec = args[0] as { name?: string; arguments?: unknown; agent?: { session?: { id?: string } } } | undefined
      const result = args[1]
      const tool = String(exec?.name ?? '')
      if (tool === 'fit_report') return
      const sid = exec?.agent?.session?.id
      if (!sid) return
      const s = st(sid)
      s.calls++
      if (isWrite(tool, exec?.arguments)) {
        s.writes.push(Date.now())
        if (s.writes.length > 60) s.writes.shift()
      }
      if (!READING_TOOLS.has(tool)) return

      const argCanon = canonArgs(tool, exec?.arguments)
      const txt = textOf(result)
      s.recent.push({
        key: `${tool}:${sha(argCanon)}`, tool, argFp: sha(argCanon),
        resFp: sha(txt.slice(0, 4000)), brief: briefArgs(tool, exec?.arguments),
        excerpt: txt.replace(/\s+/g, ' ').slice(0, 160), at: Date.now(),
      })
      if (s.recent.length > RING) s.recent.shift()

      // 判定期结算：读数一动立刻算「被采纳」；窗口到期仍不动才算 ignored
      const p = s.pending
      if (p && p.verdict === null) {
        const changed = s.recent.some((r) => r.at > p.at && r.resFp !== p.stuckFp)
        const expired = s.calls >= p.checkAtCall
        if (changed || expired) {
          p.verdict = changed ? 'adopted' : 'ignored'
          if (p.verdict === 'ignored') s.ignoredStreak++
          else s.ignoredStreak = 0
          const entry = s.ledger.find((e) => e['at'] === p.at)
          if (entry) { entry['verdict'] = p.verdict; entry['verdictCalls'] = s.calls }
          persist(sid, { rec: 'verdict', at: Date.now(), fireAt: p.at, verdict: p.verdict, ignoredStreak: s.ignoredStreak })
          saveState(sid, s)
        }
      }
    } catch { /* 静默 */ }
  }), '@dsh-external/dsh-model-fit: tools/result observer')

  // ── ① 观测 B：真人原话 + 压缩事件 + 上下文水位（M2）──────────────────────
  ctx.effect(() => (ctx.on as unknown as (ev: string, fn: (...a: any[]) => any) => () => void)('session/event', (session: any, event: any) => {
    try {
      if (!config.enabled) return
      const sid = session?.id
      if (!sid) return
      const s = st(sid)
      // 回填必须在这里也做：session/event 先于任何 pre-step 到达（重载后尤其如此），
      // 若压缩先到而池子是空的，M2 的锚点会被直接丢掉。backfill 内部幂等。
      backfill(s, session, (rec) => persist(sid, rec))
      const type = String(event?.type ?? '')

      if (type === 'user/message') {
        const src = event?.data?.source
        if (src?.kind === 'user' && !src?.plugin && !event?.data?.goalId) {
          const txt = plainText(event.data?.content).trim()
          if (txt) {
            s.humans.push({ seq: Number(event.seq ?? -1), text: txt })
            if (s.humans.length > 200) s.humans.shift()
          }
        }
        return
      }

      if (type === 'assistant/message') {
        const u = event?.data?.usage
        if (u) {
          const ctx = (u.inputTokens || 0) + (u.cacheReadTokens || 0)
          // 兜底：事件缺失时靠骤降识别压缩
          if (s.lastCtx > 0 && ctx > 0 && ctx < s.lastCtx * config.compactionDropRatio) {
            queueAnchor(s, sid, Math.max(0, s.lastCtx - ctx), s.lastCtx, null)
          }
          if (ctx > 0) { s.lastCtx = ctx; saveState(sid, s) }
        }
        return
      }

      if (type === 'compaction/summary') {
        const shadowed = Number(event?.data?.shadowedTokenCount ?? 0)
        const seqs = event?.data?.shadowedSeqs
        const preCtx = (event?.data?.usage?.inputTokens || 0) + (event?.data?.usage?.cacheReadTokens || 0)
        queueAnchor(s, sid, shadowed, preCtx || s.lastCtx, Array.isArray(seqs) ? seqs : null)
        return
      }
    } catch { /* 静默 */ }
  }), '@dsh-external/dsh-model-fit: session/event observer')

  /** 记一次压缩，备好将被埋掉的开发者原话 */
  function queueAnchor(s: SessionState, sid: string, shadowed: number, preCtx: number, seqs: number[] | null): void {
    if (!config.anchorAfterCompaction) return
    s.compactions++
    const pick = pickAnchors(s.humans, seqs, s.restatedSeqs, config.anchorMax, config.anchorMinChars)
    const shadowedSet = seqs && seqs.length ? new Set(seqs) : null
    const candidates = shadowedSet ? s.humans.filter((h) => shadowedSet.has(h.seq)).length : s.humans.length
    s.anchor = { at: Date.now(), shadowed, preCtx, msgs: pick }
    saveState(sid, s)
    persist(sid, {
      rec: 'compaction', at: Date.now(), sid,
      shadowed, preCtx, humansKnown: s.humans.length,
      candidates, picked: pick.length,
    })
  }

  // ── ② 决策 + 注入：agent/pre-step waterfall ──────────────────────────────
  ctx.effect(() => (ctx.on as unknown as (ev: string, fn: (...a: any[]) => any) => () => void)('agent/pre-step', async (payload: any, next: any) => {
    const decision = await next()
    try {
      if (!config.enabled) return decision
      const d = decision as { kind?: string; messages?: unknown[] } | undefined
      if (!d || d.kind === 'reject' || !Array.isArray(d.messages)) return decision
      const sid = (payload as any)?.agent?.session?.id
      if (!sid) return decision
      const s = st(sid)
      backfill(s, (payload as any)?.agent?.session, (rec) => persist(sid, rec))

      // ── M2：压缩后锚点重述（优先，且不受 M1 预算/静默影响）──
      if (s.anchor) {
        const job = s.anchor
        s.anchor = null
        for (const m of job.msgs) s.restatedSeqs.add(m.seq)
        if (job.msgs.length > 0) {
          const body = job.msgs
            .map((m) => '· ' + residual(m.text).slice(0, config.anchorChars))
            .join('\n')
          const text = job.shadowed > 0
            ? `📐 上下文刚压缩掉 ${Math.round(job.shadowed / 1000)}k（原 ${Math.round(job.preCtx / 1000)}k）。`
              + `论文 §3.2.2：重建的前缀状态是近似的、依赖缓存命中位置；§2.3.2：稀疏检索按块级打分建候选池，没进池的找不回来。`
              + `压缩前开发者原话重贴：\n${body}`
            : `📐 开发者原话重贴（手动触发）：\n${body}`
          s.ledger.push({ kind: 'compaction-anchor', at: job.at, sid, text, evidence: { shadowed: job.shadowed, preCtx: job.preCtx, msgs: job.msgs.length } })
          persist(sid, { rec: 'anchor-restate', at: job.at, sid, shadowed: job.shadowed, n: job.msgs.length })
          saveState(sid, s)
          return { ...d, messages: [...d.messages, createUserMessage({
            source: { kind: 'plugin', plugin: name },
            content: [{ type: 'text', text }],
          })] }
        }
      }

      // ── M1：尺子闸 ──
      if (s.fired >= config.maxPerSession) return decision
      if (s.ignoredStreak >= config.silenceAfterIgnored) return decision
      if (Date.now() - s.lastFireAt < config.cooldownMs) return decision
      const hit = detect(s, config)
      if (!hit || s.firedKeys.has(hit.key)) return decision

      s.fired++
      s.lastFireAt = Date.now()
      s.firedKeys.add(hit.key)
      s.pending = { at: s.lastFireAt, kind: hit.kind, stuckFp: hit.stuckFp, checkAtCall: s.calls + config.judgeWindow, verdict: null }
      const entry: Record<string, unknown> = {
        kind: hit.kind, at: s.lastFireAt, sid, key: hit.key, text: hit.text,
        evidence: hit.evidence, verdict: null, budget: `${s.fired}/${config.maxPerSession}`,
      }
      s.ledger.push(entry)
      persist(sid, { rec: 'intervene', ...entry })
      saveState(sid, s)
      return { ...d, messages: [...d.messages, createUserMessage({
        source: { kind: 'plugin', plugin: name },
        content: [{ type: 'text', text: hit.text }],
      })] }
    } catch { return decision }
  }), '@dsh-external/dsh-model-fit: agent/pre-step gate')

  // ── ③ 报告工具 ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fit_report',
    description: '查看模型适配层的台账：尺子闸干预与裁定、压缩锚点重述记录。',
    parameters: { sid: { type: 'string', description: '会话 id；缺省=本会话' } },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { sid?: string }, execCtx?: any) {
      const sid = args?.sid || execCtx?.agent?.session?.id || ''
      const live = sessions.get(sid)
      const byAt = new Map<number, Record<string, unknown>>()
      const events: Array<Record<string, unknown>> = []
      try {
        const f = join(ledgerDir(), `${sid}.jsonl`)
        if (existsSync(f)) {
          for (const line of readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue
            try {
              const r = JSON.parse(line) as Record<string, unknown>
              const isIntervene = r['rec'] === 'intervene' || (typeof r['kind'] === 'string' && r['kind'] !== 'verdict')
              const isVerdict = r['rec'] === 'verdict' || r['kind'] === 'verdict'
              if (isIntervene) byAt.set(Number(r['at']), r)
              if (isVerdict) { const m = byAt.get(Number(r['fireAt'])); if (m) m['verdict'] = r['verdict'] }
              if (r['rec'] === 'compaction' || r['rec'] === 'anchor-restate') events.push(r)
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
      if (live) for (const e of live.ledger) byAt.set(Number(e['at']), { ...(byAt.get(Number(e['at'])) ?? {}), ...e })
      const rows = [...byAt.values()].sort((a, b) => Number(a['at']) - Number(b['at']))
      const adopted = rows.filter((r) => r['verdict'] === 'adopted').length
      const ignored = rows.filter((r) => r['verdict'] === 'ignored').length
      const unresolved = rows.filter((r) => r['verdict'] === 'unresolved').length
      const budget = `M1 预算 ${live?.fired ?? rows.length}/${config.maxPerSession}`
        + ` · ignored 连击 ${live?.ignoredStreak ?? 0}/${config.silenceAfterIgnored}`
      const lines = [
        `模型适配层 · 台账（会话 ${sid}）`,
        `M1 干预 ${rows.length} 条（adopted ${adopted} · ignored ${ignored} · 未结 ${unresolved} · 待判 ${rows.length - adopted - ignored - unresolved}）· ${budget}`,
        `M2 压缩 ${live?.compactions ?? events.filter((e) => e['rec'] === 'compaction').length} 次 · 重贴 ${events.filter((e) => e['rec'] === 'anchor-restate').length} 次`
        + ` · 已知开发者原话 ${live?.humans.length ?? '?'} 条 · 当前上下文 ${Math.round((live?.lastCtx ?? 0) / 1000)}k`,
        '',
      ]
      for (const r of rows) {
        lines.push(`[${new Date(Number(r['at'])).toISOString().slice(11, 19)}] ${String(r['kind'])}  verdict=${String(r['verdict'] ?? '待判')}`)
        lines.push(`  证据: ${JSON.stringify(r['evidence'])}`)
      }
      for (const e of events.slice(-6)) {
        lines.push(`[${new Date(Number(e['at'])).toISOString().slice(11, 19)}] ${String(e['rec'])}  ${JSON.stringify({ shadowed: e['shadowed'], picked: e['picked'], n: e['n'], preCtx: e['preCtx'] })}`)
      }
      return lines.join('\n')
    },
  })), '@dsh-external/dsh-model-fit: fit_report tool')

  // ── ④ 手动锚定：感觉上下文漂移时，随时把开发者原话拉回近场 ──────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fit_anchor_now',
    description: '立即把最近的开发者原话重贴到近场（等效于刚发生过压缩）。感觉漂移或想确认当前约束时用。',
    parameters: { n: { type: 'number', description: '重贴几条（缺省取配置值）' } },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
    },
    async execute(args: { n?: number }, execCtx?: any) {
      const sid = execCtx?.agent?.session?.id
      const s = sid ? sessions.get(sid) : undefined
      if (!s) return '模型适配层：本会话尚未初始化（或已重载）。'
      if (s.humans.length === 0) return '模型适配层：还没收集到开发者原话。'
      const pool = s.humans.filter((h) => !s.restatedSeqs.has(h.seq) && worthAnchoring(h.text, config.anchorMinChars))
      if (pool.length === 0) {
        return `模型适配层：可重贴的原话已全部贴过（已知 ${s.humans.length} 条，已贴 ${s.restatedSeqs.size} 条）。`
      }
      const n = Math.max(1, Math.min(Math.trunc(Number(args?.n) || config.anchorMax), config.anchorMax))
      const pick = pool.slice(-n)
      s.anchor = { at: Date.now(), shadowed: 0, preCtx: s.lastCtx, msgs: pick }
      return `已排队重贴 ${pick.length} 条（下一次生成前注入）：\n`
        + pick.map((p) => '· ' + residual(p.text).slice(0, 90)).join('\n')
    },
  })), '@dsh-external/dsh-model-fit: fit_anchor_now tool')
}

/** M1 检测：返回命中信号或 null */
function detect(s: SessionState, config: FitConfig): { kind: string; key: string; text: string; evidence: Record<string, unknown>; stuckFp: string } | null {
  const r = s.recent
  if (r.length < config.minRepeat) return null
  const tail = r.slice(-config.minRepeat)
  if (new Set(tail.map((x) => x.resFp)).size !== 1) return null   // 结果必须完全一致
  const stuckFp = tail[0].resFp
  const argFps = new Set(tail.map((x) => x.argFp))
  const last = tail[tail.length - 1]

  // ★ 硬条件：这段读数之间必须真的动过手。
  //   否则只是「重复观测同一件事」——幂等验证、健康检查、轮询状态都长这样，报它就是烦。
  const writesBetween = s.writes.filter((t) => t > tail[0].at && t < last.at).length
  if (writesBetween === 0) return null

  const evidence = { n: tail.length, tool: last.tool, writesBetween, args: tail.map((x) => x.brief), excerpt: last.excerpt }

  if (argFps.size >= config.minRepeat) {
    return {
      kind: 'sensor-stuck', key: `stuck:${last.tool}:${stuckFp}`, stuckFp,
      text: `📏 疑似尺子卡住：期间动过 ${writesBetween} 次手，但最近 ${tail.length} 次读数结果完全相同、输入各不相同（工具 ${last.tool}）。`
        + `最近一次输入「${last.brief.slice(0, 60)}」，读回「${last.excerpt.slice(0, 60)}」。`
        + `要不要先喂一个已知一定会变的输入，确认这条读数通道还在反映实况。`,
      evidence,
    }
  }
  if (argFps.size === 1) {
    return {
      kind: 'sensor-loop', key: `loop:${last.tool}:${last.argFp}`, stuckFp,
      text: `📏 疑似原地打转：期间动过 ${writesBetween} 次手，${last.tool} 却用同一输入连读 ${tail.length} 次、结果一字不差（「${last.excerpt.slice(0, 60)}」）。`
        + `要不要换个输入，或确认这条读数通道是否还在反映实况。`,
      evidence,
    }
  }
  return null
}
