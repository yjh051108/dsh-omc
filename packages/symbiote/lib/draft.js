/**
 * draft — 共生体蒸馏草稿的**纯逻辑**（零依赖、零 IO、零时钟）。
 *
 * 抽出来的理由（照 [[出货代码才可测]] 的教训）：回归测试必须能 import **出货代码本身**；
 * 而 index.js 依赖 schemastery / child_process，插件目录没有 node_modules，
 * 独立 node 进程 import 不了 —— 所以纯逻辑必须与宿主接线分层，否则只能靠"重写一份逻辑去测"（等于没测）。
 *
 * 案底（2026-09-11 图谱实测）：旧标题 `单${sid.slice(0,8)}蒸馏：${lastTitle}` 有 30+ 字，
 * 被 engram store 的 `_t.slice(0, 12)` 砍成 `单xxxxxxxx蒸馏：`——图谱里真躺着
 * [[单e3a53c3f蒸馏：]] / [[单b74630b0蒸馏：]] 两个空壳。本模块用契约常量把这件事锁死。
 */

/** engram store 对标题的硬契约：`_t.slice(0, 12)`（超一个字符就被砍） */
export const TITLE_MAX = 12
/** engram 摘要契约：不看正文就能判断相关性 */
export const SUMMARY_MAX = 30

const cut = (x, n) => { const v = String(x || ''); return v.length > n ? v.slice(0, n) + '…' : v }

/**
 * 由已加载的 closedloop 账本 + 栈 + 文件名，构造要誊写入图的节点草案。纯函数。
 * @param cl  closedloop 账本对象（{cost, closed, groups, terminalReport}）
 * @param stack optimal 栈对象（{rolledBack}）
 * @param ledgerFile graded-state 下的账本文件名（进证据链）
 * @param sid 会话 id（仅用于兜底，不进标题——标题里放会话 id 对未来无意义）
 */
export function draftNodeFor(cl, stack, ledgerFile, sid) {
  const closed = (cl && cl.closed) || []
  // ★ v0.5.1：归因史只取**本单**回炉——栈上 rolledBack 跨单累积（closed 每单重置、栈不清），
  //   直接取会把上一单的错写进这一单的记忆（张冠李戴比没记更坏）。taskAt 由环的 cost_set 落盘。
  const _allRb = (stack && Array.isArray(stack.rolledBack)) ? stack.rolledBack : []
  const rb = (cl && cl.taskAt) ? _allRb.filter((r) => Number(r && r.at) >= Number(cl.taskAt)) : _allRb
  const vCurve = closed.filter((c) => typeof c.v === 'number').map((c) => c.v)

  // 标题：取任务 purpose 首句；cut(x, TITLE_MAX-1) 保证「有省略号时恰 TITLE_MAX、无省略号时 ≤TITLE_MAX-1」，
  // 两种情形都整条活过 store 的 slice 契约。
  const purpose = (cl && cl.cost && cl.cost.purpose) || ''
  const titleSrc = String(purpose || (closed.length ? closed[closed.length - 1].title : '')).split(/[，。；,;]/)[0]
  const title = cut(titleSrc || '单蒸馏', TITLE_MAX - 1)

  // 摘要：**先缩短组名，再考虑丢组名**——组名才是「不看正文就能判断相关性」的那一半。
  // 案底①（硬截）：30 字硬截时组名把指标全挤掉。
  // 案底②（v0.5.x 实跑抓到）：组名一长（12+19=32 字），"整名 or 只指标"的梯子会直接跳到只留指标，
  //   退回老丑相 `闭合2·回炉1`——所以梯子里必须夹"缩短版组名"这一档。
  const gsAll = closed.map((c) => String((c && c.title) || '').trim()).filter(Boolean)
  const gnames = gsAll.slice(0, 3).join('、')
  const gshort = gsAll.slice(0, 3).map((g) => (g.length > 5 ? g.slice(0, 5) + '…' : g)).join('、')
  const gfirst = gsAll[0] ? (gsAll[0].length > 8 ? gsAll[0].slice(0, 8) + '…' : gsAll[0]) : ''
  const mFull = vCurve.length
    ? `闭合${closed.length}·回炉${rb.length}·V${vCurve[0]}→${vCurve[vCurve.length - 1]}`
    : `闭合${closed.length}·回炉${rb.length}`
  const mShort = `闭合${closed.length}·回炉${rb.length}`
  const summary = [
    gnames && `${gnames}｜${mFull}`,
    gnames && `${gnames}｜${mShort}`,
    gshort && `${gshort}｜${mShort}`,
    gfirst && `${gfirst}｜${mShort}`,
    gfirst,
    mShort,
  ].find((x) => x && x.length <= SUMMARY_MAX) || mShort

  const content = '归因史：' + (rb.slice(0, 5).map((r) => String(r.reason || '').slice(0, 40)).join(' / ') || '无')
    + `；证据链：graded-state/${ledgerFile}`

  return { layer: 'project', kind: 'event', title, summary, content }
}
