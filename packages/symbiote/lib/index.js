/**
 * @dsh-external/dsh-symbiote — 共生体：学习环的独立观测器官（纯 ESM，closedloop 同构建模式）。
 * 只读 closedloop 盘档（graded-state/），真算 C（信誉）/V 读数覆盖，出蒸馏草稿。
 * 纪律：①零触碰 closedloop 仓；②只写 distill-drafts/ 草稿，正式入图走 engram 确认制
 * （R15 生产者不自评的共生体版：观测者不代写记忆）；③schema 精简（进 prefill 按字符计费）。
 */
import { join, dirname } from 'node:path'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { draftNodeFor } from './draft.js'

/* v0.5.5 接线：链/章状态——spawn 独立 stamper 进程 check（外部验证者不共码；缺席/红/灰诚实降级） */
function stampCheck(fullSid) {
  try {
    const stamper = process.env.DSH_STAMPER_JS || 'D:/dsh/03-dev-infra/dsh-stamper/stamper.mjs'
    if (!existsSync(stamper)) return 'absent'
    const out = execFileSync(process.execPath, [stamper, 'check', fullSid, '--home', dirname(GS())], { timeout: 8000, encoding: 'utf8' })
    return (String(out).trim().split(/\s+/)[0] || '?').toLowerCase()
  } catch (e) {
    const so = String(e?.stdout || '').trim()
    if (/^RED/i.test(so)) return 'red:' + so.slice(3, 50)
    return 'gray'
  }
}

export const name = 'dsh-symbiote'
export const inject = ['tools']
export const Config = z.object({})

const GS = () => join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'graded-state')
const SEV_W = { catastrophic: 4, major: 2, minor: 1 }

/* R20（v1.5）：命中率用 Wilson 下界——小样本天然压制，closed=2 全中不再是 C=90 */
function wilson(k, n) {
  if (!n) return 0
  const p = k / n, z = 1.96, z2 = z * z
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n)
}

function loadJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/* 真 A + 唯一 C 真相：只读 import closedloop 的 stateFace 与 rank-organ.computeC，
   对每份真盘档算实际帧字节 + 信誉。**去重**：C 公式单一同源（rank-organ），symbiote 不再自带一份
   （此前两份漂移：cover 定义不同——正是 E2E 抓的"两侧各解"病灶，按 D25 教训消除）。import 失败降级账本代理。 */
let clModule = null
async function closedloopFace() {
  if (clModule === null) {
    try {
      const dir = process.env.SYMBIOTE_CLOSEDLOOP_DIR || 'D:/dsh/dsh-closedloop-mode/lib'
      const pt = await import(new URL('file:///' + dir + '/propose-text.js').href)
      const oe = await import(new URL('file:///' + dir + '/optimal-engine.js').href)
      const ms = await import(new URL('file:///' + dir + '/mode-state.js').href)
      const ro = await import(new URL('file:///' + dir + '/rank-organ.js').href)
      clModule = { face: (sid) => { const s = ms.loadState(sid); if (!s) return null; return pt.stateFace(s, oe.stackTop(oe.loadStack(sid))) }, computeC: ro.computeC }
    } catch { clModule = false }
  }
  return clModule || null
}

async function scanLedgers() {
  const dir = GS()
  const cl = await closedloopFace()
  const rows = []
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.closedloop.json')) } catch { return rows }
  for (const f of files) {
    const s = loadJson(join(dir, f))
    if (!s || !Array.isArray(s.closed) || s.closed.length === 0) continue
    const m = f.match(/session-([0-9a-f]{8})/) || f.match(/^([0-9a-f]{8})/)
    const sid = m ? m[1] : f.slice(0, 8)
    const stack = loadJson(join(dir, f.replace('.closedloop.json', '.optimal.json')))
    const closed = s.closed.length
    let C
    if (cl && cl.computeC) { C = cl.computeC(s, stack).C } // 唯一真相：rank-organ
    else { const rb = (stack && Array.isArray(stack.rolledBack)) ? stack.rolledBack : []; C = Math.round(100 * 0.7 * wilson(closed, closed + rb.length)) } // 降级：仅命中项，标注
    let kb = 0
    try { kb = readFileSync(join(dir, f), 'utf8').length / 1024 } catch {}
    const rbN = (stack && Array.isArray(stack.rolledBack)) ? stack.rolledBack.length : 0
    rows.push({ sid, fullSid: f.replace('.closedloop.json', ''), stage: s.stage || '-', closed, rollbacks: rbN, hit: +(closed / Math.max(1, closed + rbN)).toFixed(2), C, ledgerKB: +kb.toFixed(1), vReadings: s.closed.filter((c) => typeof c.v === 'number').length, terminal: !!s.terminalReport, stamp: stampCheck(f.replace('.closedloop.json', '')) })
  }
  rows.sort((a, b) => b.closed - a.closed)
  return rows
}

async function reportText(rows) {
  if (rows.length === 0) return '共生体：graded-state 无带闭合步的账本（闭环未跑或 DSH_HOME 未设）。'
  const top = rows.slice(0, 5)
  const avgC = Math.round(top.reduce((a, r) => a + r.C, 0) / top.length)
  const vTot = rows.reduce((a, r) => a + r.vReadings, 0)
  const cTot = rows.reduce((a, r) => a + r.closed, 0)
  const face = await closedloopFace()
  const lines = []
  let faceSum = 0, faceN = 0
  for (const r of rows.slice(0, 12)) {
    let fa = ''
    if (face) {
      const fb = await Promise.resolve(face.face(r.fullSid)).catch(() => null)
      if (fb != null) { const n = Buffer.byteLength(String(fb), 'utf8'); faceSum += n; faceN++; fa = ` 帧${n}B` }
    }
    lines.push(`${r.sid} ${r.stage} 闭${r.closed} 炉${r.rollbacks} hit=${r.hit} C=${r.C} 账本${r.ledgerKB}KB V读数${r.vReadings}${fa}${r.terminal ? ' [已归零→可蒸馏]' : ''} 章=${r.stamp}`)
  }
  const aLine = faceN ? `｜真A：stateFace 均值 ${Math.round(faceSum / faceN)}B/帧（预算 1333B，${Math.round(faceSum / faceN / 13.33)}%）` : '｜真A：stateFace 模块不可达，降级账本代理'
  // 导演宏观页（用户指令：只看现状/趋势/待拍板——三行大白话，细节在下面账）
  const macro = macroPage()
  return [macro, `共生体扫描：${rows.length} 份账本｜头部5会话均值 C=${avgC}｜V读数覆盖 ${vTot}/${cTot}（覆盖低=measure 断言未普及，PLANT 在案）${aLine}`, ...lines].join('\n')
}

/** 三行宏观：定价进度 / 影子-现 口径分歧 / 近7天回炉势（涨跌给方向不吓人）。 */
function macroPage() {
  const L = ['【导演面板】']
  try {
    const p = JSON.parse(readFileSync(join(GS(), 'pricing.json'), 'utf8'))
    const rec = p.gates && p.gates.records || 0
    // ETA：按历史 pairs 的时间戳算出单节奏；样本 <5 或节奏 <0.5 单/天=不算数（诚实位，宁缺毋滥）
    let eta = ''
    try {
      const pts = (p.pairs || []).map((x) => x.at).filter(Boolean).concat(p.cutoverLog || [])
      const hist = (p.history || []).map((h) => h.at).filter(Boolean)
      const stamps = hist.length > pts.length ? hist : pts
      if (stamps.length >= 5) {
        const span = (stamps[stamps.length - 1] - stamps[0]) / 864e5
        if (span < 1) eta = '｜跨度<1天=爆发节奏，ETA 不算数' // 半天十单≠每天十单——爆发日禁止外推（数指真测防的是我自己）
        else {
          const rate = stamps.length / Math.max(span, 0.01)
          if (rate >= 0.5) {
            const left = Math.max(0, 300 - rec)
            eta = `｜按节奏 ${rate.toFixed(1)} 单/天约 ${Math.ceil(left / rate)} 天达线`
          } else eta = '｜节奏样本太稀，ETA 不算数'
        }
      } else eta = '｜节奏样本<5，ETA 不算数'
    } catch { /* 无 at 字段的旧记录=不给假预估 */ }
    const lr = p.lastRecal
    L.push(`定价：影子期 ${rec}/300 单${p.real ? '（已切实价）' : ''}，到点自动切换无需你管${eta}${lr ? `｜再校准：${lr.healthy ? '健康' : '报病(simSick，切换锁死)'} @${new Date(lr.at).toISOString().slice(5, 16).replace('T', ' ')}` : '｜再校准：未跑'}`)
    // r30 分层进度（水管已接：pairs 带 band 戳起）——dev 带（3-5 步及以上）满 30 即分层自切
    try {
      const ps = p.pairs || []
      const toyN = ps.filter((x) => x.band === '1-2').length
      const devN = ps.filter((x) => x.band && x.band !== '1-2' && x.band !== 'na').length
      L.push(`分层进度：toy带 ${toyN}/300 · dev带 ${devN}/30（dev 满 30 即各层自切实价；r30 前老记录无 band 戳不计——数据形状修正日=2026-09-05）`)
    } catch { /* 分层行读失败=少一行不装 */ }
    if (p.real && p.cutoverAt && Date.now() - p.cutoverAt < 7 * 864e5) {
      const pr40 = (p.pairs || []).slice(-40).filter((x) => x.shadowC != null)
      const hh = pr40.length >= 20 ? spearman(pr40.map((x) => x.shadowC), pr40.map((x) => x.trueQ)) : null
      L.push(`切换体检：第 ${Math.floor((Date.now() - p.cutoverAt) / 864e5) + 1}/7 天，两尺一致度=${hh == null ? '样本攒中' : hh}（<0.5 自动回影子，无需你管）`)
    }
    if (p.demotions) L.push(`历史回影子 ${p.demotions} 次（最近：${String((p.demotionLog || []).slice(-1)[0]?.note || '?')}）——双向门都在工作`)
    const pr = (p.pairs || []).slice(-40)
    if (pr.length >= 30) {
      const sp2 = spearman(pr.map((x) => x.shadowC ?? 0), pr.map((x) => x.trueQ ?? 0))
      L.push(`两把尺子一致度=${sp2}（>0.7 影子可信；<0.3 有尺在骗另一把，值得看一眼）`)
    } else L.push(`两把尺子对照：样本 ${pr.length}/30 不足，只攒不评（n<30 的秩相关是噪声，报警=制造焦虑）`)
    // 拍板队列行：唯一需要用户出现的环节集中报数（草稿不过夜地等，但催活不越权）
    try {
      const dd = join(GS(), 'distill-drafts')
      const files = existsSync(dd) ? readdirSync(dd).filter((x) => x.endsWith('.json') && !x.startsWith('triage-log')) : []
      if (files.length) {
        let oldest = Infinity
        for (const f of files) { try { oldest = Math.min(oldest, JSON.parse(readFileSync(join(dd, f), 'utf8')).at || oldest) } catch { /* 坏文件跳过计数 */ } }
        const ageD = oldest === Infinity ? null : Math.floor((Date.now() - oldest) / 864e5)
        L.push(`拍板队列：蒸馏草稿 ${files.length} 份待确认${ageD != null ? `（最久 ${ageD} 天）` : ''}——你一句话我可批量誊净，不催不动`)
      }
    } catch { /* 队列读失败=这行不显示，不装 */ }
  } catch { L.push('定价：账本未开笔（records=0，正常冷启动）') }
  try {
    const now = Date.now(), wk = now - 7 * 864e5
    let a = 0, b = 0, ra = 0, rb2 = 0
    for (const f of readdirSync(GS()).filter((x) => x.endsWith('.closedloop.json'))) {
      let s; try { s = JSON.parse(readFileSync(join(GS(), f), 'utf8')) } catch { continue }
      for (const c of s.closed || []) { if (!c.at) continue; if (c.at > wk) a++; else b++ }
      let st; try { st = JSON.parse(readFileSync(join(GS(), f.replace('.closedloop.json', '.optimal.json')), 'utf8')) } catch { continue }
      for (const x of st.rolledBack || []) { if (!x.at) continue; if (/process-death|外部|external|用户|E2E|虚报|验闸|复测|活卡/i.test(String(x.reason || ''))) continue; if (x.at > wk) ra++; else rb2++ }
    }
    const rateWk = a + ra ? ra / (a + ra) : null, rateOld = b + rb2 ? rb2 / (b + rb2) : null
    L.push(rateWk == null || rateOld == null ? '回炉势：样本不足' : `近7天回炉率 ${(rateWk * 100).toFixed(0)}% vs 此前 ${(rateOld * 100).toFixed(0)}%（${rateWk <= rateOld ? '↓在变稳' : '↑在变糙——若连续两周升，值得查'}）`)
  } catch { L.push('回炉势：读盘失败（不装数）') }
  // tok 批算腿（backfill-tok.mjs，stale>24h 后台 detached 补跑，不卡面板）：res 第四腿的离线数据源
  try {
    const tf = join(GS(), '..', 'tok-report.json')
    const tpath = existsSync('D:/dsh/harness-master-design/tok-report.json') ? 'D:/dsh/harness-master-design/tok-report.json' : tf
    if (existsSync(tpath)) {
      const r = JSON.parse(readFileSync(tpath, 'utf8'))
      const ageH = Math.round((Date.now() - r.at) / 36e5)
      const withTok = (r.rows || []).filter((x) => x.newTok != null)
      const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null
      if (ageH > 24) { try { spawn(process.execPath, ['D:/dsh/harness-master-design/backfill-tok.mjs'], { detached: true, stdio: 'ignore' }).unref() } catch { /* detached 补跑失败=下次再说 */ } }
      // 周兜底（目标④"每 10 单或每周"的后半）：再校准报告 >7 天即补跑
      try { const rf = 'D:/dsh/harness-master-design/recalibration-report.json'; if (existsSync(rf)) { const rr = JSON.parse(readFileSync(rf, 'utf8')); if (Date.now() - rr.at > 7 * 864e5) { spawn(process.execPath, ['D:/dsh/harness-master-design/recalibrate.mjs'], { detached: true, stdio: 'ignore' }).unref(); } } } catch { /* 无报告=没兜底需求 */ }
      L.push(withTok.length ? `tok 腿：新料中位 ${med(withTok.map((x) => x.newTok))}tok/票｜覆盖 ${withTok.length}/${(r.rows || []).length}（批算 ${ageH}h 前${ageH > 24 ? '，补跑中' : ''}）` : 'tok 腿：批算账本在但无覆盖会话（session 日志缺失）')
    } else L.push('tok 腿：批算未跑过（backfill-tok.mjs 首跑后显示）')
  } catch { L.push('tok 腿：读报失败（不装数）') }
  // r43 介入率活仪表（总目标函数首次有活读数）：source.kind==='user' 严口径，goal/plugin 自动流全不计
  try {
    const ivPath = 'D:/dsh/harness-master-design/intervene-report.json'
    if (existsSync(ivPath)) {
      const iv = JSON.parse(readFileSync(ivPath, 'utf8'))
      const ivAge = Math.floor((Date.now() - iv.at) / 36e5)
      L.push(`介入率：24h 活窗 ${iv.rate24h ?? '样本不足'} 人/闭合（真人${iv.humans24h}÷闭合${iv.closed24h}，同窗修正 r46；全史背景 ${iv.overallRate}｜基线 1.76；报龄 ${ivAge}h${ivAge > 48 ? '——补跑 measure-intervene' : ''}）`)
      // v0.8.27 在岗介入率（分子只数落在未闭合步窗口内的真人帧——旧口径把设计讨论也算了，实测高估约 3 倍）
      if (iv.onDutyRate24h != null) L.push(`在岗介入率：24h ${iv.onDutyRate24h} 人/闭合（在岗帧${iv.onDutyHumans24h}÷闭合${iv.closed24h}；全史 ${iv.onDutyOverallRate}）——新口径，与旧口径基线 1.76 不可比`)
    } else L.push('介入率：未跑（measure-intervene.mjs 首跑后显示）')
  } catch { L.push('介入率：读报失败（不装数）') }
  // 图谱 ⏳ 待确认队列直读（用户唯一人工环节集中报数；status='pending' 硬语义，无 status 字段=store 直入不算——r5 status 误判案底沿用）
  try {
    const cands = [join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'engram-relay', 'engrams.jsonl'), join(GS(), '..', 'engram-relay', 'engrams.jsonl')].filter((p) => existsSync(p))
    let pend = 0, oldest = Infinity, pendTitles = ''
    const tl = []
    for (const line of cands.length ? readFileSync(cands[0], 'utf8').split('\n') : []) {
      if (!line.trim()) continue
      try { const n = JSON.parse(line); if (n && n.status === 'pending') { pend++; if (n.createdAt) oldest = Math.min(oldest, n.createdAt); if (n.title) tl.push(String(n.title).slice(0, 12)) } } catch { /* 坏行跳 */ }
    }
    pendTitles = tl.length ? tl.slice(0, 5).join('、') + (tl.length > 5 ? `…共${tl.length}` : '') : ''
    if (cands.length) L.push(`图谱 ⏳ 待确认 ${pend} 节点${pend && oldest < Infinity ? `（最久 ${Math.floor((Date.now() - oldest) / 864e5)} 天）` : ''}——engram_confirm 各点一遍或让我代列清单${pendTitles ? '：' + pendTitles : ''}`)
    else L.push('图谱队列：relay 存储不可达（不装数）')
  } catch { L.push('图谱队列：读失败（不装数）') }
  // 机检全家总账行：读 family-report（>24h detached 自刷），红单直报缺项——九把尺一眼全貌
  try {
    const ff = 'D:/dsh/harness-master-design/family-report.json'
    if (existsSync(ff)) {
      const fr = JSON.parse(readFileSync(ff, 'utf8'))
      const ageH = Math.round((Date.now() - fr.at) / 36e5)
      const reds = Object.entries(fr.out || {}).filter(([, v]) => v !== 'ok').map(([k]) => k.replace('check-', ''))
      if (ageH > 24) { try { spawn(process.execPath, ['D:/dsh/harness-master-design/check-family.mjs'], { detached: true, stdio: 'ignore' }).unref() } catch { /* 下次 */ } }
      L.push(`机检全家：${fr.ok}/${fr.total} 绿（${ageH}h 前）${reds.length ? ' 红单：' + reds.join(',') + (ageH > 24 ? '（补跑中）' : '') : ' ｜一键 node check-family 全查'}`)
    } else L.push('机检全家：未跑过（node check-family.mjs 首刷后显示）')
  } catch { L.push('机检全家：读报失败（不装数）') }
  return L.join('\n')
}
function spearman(a, b) {
  const rank = (x) => { const idx = x.map((v, j) => [v, j]).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); idx.forEach((p, k) => r[p[1]] = k + 1); return r }
  const ra = rank(a), rb = rank(b), n = a.length, m = (n + 1) / 2
  let num = 0, d1 = 0, d2 = 0
  for (let j = 0; j < n; j++) { num += (ra[j] - m) * (rb[j] - m); d1 += (ra[j] - m) ** 2; d2 += (rb[j] - m) ** 2 }
  return d1 && d2 ? +(num / Math.sqrt(d1 * d2)).toFixed(2) : 0
}

function makeDraft(sid) {
  const dir = GS()
  let f
  try { f = readdirSync(dir).find((x) => x.endsWith('.closedloop.json') && (x.includes('session-' + sid) || x.startsWith(sid))) } catch {}
  if (!f) return { ok: false, error: `无 sid=${sid} 的 closedloop 账本` }
  const cl = loadJson(join(dir, f)) || {}
  const stack = loadJson(join(dir, f.replace('.closedloop.json', '.optimal.json')))
  const closed = cl.closed || []
  const rb = (stack && Array.isArray(stack.rolledBack)) ? stack.rolledBack : []
  const vCurve = closed.filter((c) => typeof c.v === 'number').map((c) => c.v)
  // 节点构造已抽到 src/draft.js（纯逻辑、零依赖）——回归测试 import 的就是它，
  // 不重写一份逻辑去测（[[出货代码才可测]]）。契约常量与降级规则都在那边。
  const node = draftNodeFor(cl, stack, f, sid)
  const draft = {
    at: Date.now(),
    sid,
    evidence: { closed: closed.length, rollbacks: rb.length, vCurve, groups: (cl.groups || []).map((g) => g.title), terminal: !!cl.terminalReport, ledger: 'graded-state/' + f },
    node,
    status: 'pending-confirm：草稿需模型/人经 engram_store 正式入图——共生体只写草稿不自写（观测者不代写记忆）',
  }
  const outDir = join(dir, 'distill-drafts')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${sid}-${Date.now()}.json`)
  writeFileSync(out, JSON.stringify(draft, null, 1))
  return { ok: true, out, nodeTitle: draft.node.title, nodeSummary: draft.node.summary }
}

const OUT = { schema: { type: 'object', additionalProperties: false, required: ['ok', 'text'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: String(v?.text || '') }] }

export function apply(ctx, _config) {
  const defs = [
    {
      name: 'symbiote_report',
      description: '共生体扫描闭环盘档：每会话真算 C（信誉）/闭合/回炉/V 读数覆盖——学习环的只读观测面',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      output: OUT,
      async execute() { return { ok: true, text: await reportText(await scanLedgers()) } },
    },
    {
      name: 'symbiote_distill',
      description: '对指定会话账本出蒸馏草稿（证据链+engram 节点草案，落 distill-drafts/ 待确认）',
      parameters: { type: 'object', additionalProperties: false, required: ['sid'], properties: { sid: { type: 'string', description: '会话 id 前缀（如 b74630b0）' } } },
      output: OUT,
      async execute(args) {
        const r = makeDraft(String(args?.sid || '').trim())
        return { ok: !!r.ok, text: r.ok ? `蒸馏草稿落盘：${r.out}\n节点草案：${r.nodeTitle}｜${r.nodeSummary}` : `失败：${r.error}` }
      },
    },
  ]
  for (const def of defs) {
    ctx.effect(() => ctx.tools.register(def), `symbiote: ${def.name}`)
  }
}
