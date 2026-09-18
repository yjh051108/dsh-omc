/**
 * notify.js —— **上游更新通知**（上游≈前辈：上游一更新就告诉"持有覆盖"的那个成员）。
 *
 * 委托方原话（P-20）：「**上游类似于他的一个前辈**……只要上游更新了，马上给他一个通知，告诉他更新了，是否需要更新。」
 * 接着（P-22）又否掉了"删掉/保留"二选一：「**不是删掉或者保留，是可以 diff 去参考一下！**……」
 * ⇒ 通知必须带**四件**：① 人写的更新说明 ② 改后内容 ③ 可比的两侧路径（他自己跑 diff）
 *    ④ **≥4 项的动作菜单**（含"部分采纳"）。
 *
 * ── 三条硬约束（都是实测出来的，不是设计口味）────────────────────────────────
 *
 * 1. **只在上游 digest 真变时推**（成本命门）。
 *    `task-45` 实测：12 步 / 2 次上游改动 / **1 次注入**。上游没变的步**一条都不注入**。
 *    ⇒ 判据是 `sha1(文件内容) !== 上次的`，不是"每步都发一次"。
 *
 * 2. **限流必须配 pending 补推**，否则**永久丢通知**。
 *    `task-45` 实测缺陷：限流分支只 `return`，而 `lastDigest` 已前进 ⇒ 后续步全 `changed=false`
 *    ⇒ 那条更新**再也不会被判为"新"**（原文：`why=rate-limited` → 下一步 `why=no-change`）。
 *    `task-46` 实测修好：`RATE-LIMITED-QUEUED → PENDING-HOLD → PENDING-FLUSH → INJECT #3`。
 *    ⚠️ **实现要点（第一版写错过）**：pending 的判定**必须放在"没变更就早退"之前** ——
 *    放在后面就复现原缺陷（`UPSTREAM-CHANGELOG.md` §B.6）。
 *
 * 3. **只推给"持有该条 fork 覆盖"的成员**（受众收窄，`P-21` 的设计提议）。
 *    没改过该条的人 ⇒ 上游改了它**自动跟着变** ⇒ 通知对他**没有任何可执行动作**。
 *    `task-46` 实测：对照组 `up-changelog-keep` 变了 3 次，**3 次全 `SKIP-NOTIFY why=no-fork-override`**。
 *
 * ── 一条诚实标注 ────────────────────────────────────────────────────────────
 * 投递形态是**搭车（piggyback）**：在**该 agent 本来就要走的那一步**里往
 * `decision.messages` 追加一条 user message（与 `dsh-agent-instructions:1270-1288` 同形）。
 * 边际成本 = 一条消息的字节数（实测 669–2735 B），**不额外触发任何轮次**。
 * **代价**：**送达不保证** —— 一个做完活就 idle 的 agent **永远收不到**
 * （要保证送达得上"唤醒"形态，代价是一整步 ≈ 8.8 KB system prompt + 技能目录 + 139 工具表）。
 * 这条取舍写进 README 的"限制"节。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { forkRootFor } from './config.js'

/** 一条被跟踪的上游条目的当前状态（digest + 文本）。 */
function digestOf(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return '(absent)'
  }
}

/** 人写的更新说明：`<skill 目录>/CHANGELOG.md` 里 `## <digest8>` 那一条。
 * ⚠️ 落点纪律：**不能放技能根**（深度 1 的 `*.md` 会被当扁平技能，LANDMINES §18 实测）；
 * 深度 2 的 `<skill>/CHANGELOG.md` 安全（`UPSTREAM-CHANGELOG.md` §A.2 实测）。
 *
 * ★★★ **2026-09-14 / Round 82 修的集成缺陷** —— ① 在**真实生产路径上永远找不到**。
 *
 * 【缺陷现场】读取侧（本函数）与写入侧**读写的不是同一个文件、也不是同一种格式**：
 * ```
 * 读取（本函数）  ： <upstream.root>/<skill>/CHANGELOG.md   ← **per-skill**，`## <digest8>` 分节
 * 写入（promote-upstream.mjs）： <PKG>/CHANGELOG.md、<stateDir>/CHANGELOG.md ← **单一汇总**，
 *                              `## <日期> · <note>` + 一张 `| 技能 | sha |` 表
 * ```
 * ⇒ 实测（本机）：上游根里**一个 per-skill CHANGELOG 都没有** ⇒ `CHANGELOG-LOOKUP … found=false
 *   why=no-changelog-file` ⇒ **通知里的"① 这次主要改了什么、为什么"永远是空的**。
 * ⇒ 而 `UPSTREAM-CHANGELOG.md` §B.2 **验证过 ①"成立"** —— 但那次实验用的是
 *   `git log` 的 commit message 造的 per-skill 文件，**不是 promote 工具写的那个**。
 *   ⇒ **"机制被验证过" ≠ "生产路径接上了"**（这是本项目第 N 次同一格：R47/R71/R76/R79 同族）。
 *
 * 【修法】读取侧**加一条回退**：per-skill 找不到时，去**汇总 CHANGELOG**（`paths.changelogPath`）
 *   里按 **skill + 新 digest** 找那一条，取它的 `**说明**：` 行。
 *   ⚠️ 只在**读到文件且真匹配上**时才算 `found:true`；否则仍**如实报"没有说明"**（不假装有）。
 *
 * @param skillDir            per-skill 目录（原路径）
 * @param digest              本次新版本 digest
 * @param fallbackFiles      可选：汇总 CHANGELOG 候选路径（promote 工具写的那份）
 * @param skill              可选：技能名（汇总格式按 `| \`<skill>\` |` 定位）
 */
export function readChangelog(skillDir, digest, fallbackFiles = [], skill = '') {
  const file = join(skillDir, 'CHANGELOG.md')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // ① per-skill 不存在 ⇒ **先试汇总那份**（promote 工具写的）
    for (const fb of fallbackFiles) {
      if (typeof fb !== 'string' || fb === '') continue
      let agg
      try {
        agg = readFileSync(fb, 'utf8')
      } catch {
        continue
      }
      const hit = matchAggregateChangelog(agg, skill, digest)
      if (hit !== undefined) return { found: true, why: 'matched-aggregate-changelog', text: hit, file: fb }
    }
    return { found: false, why: 'no-changelog-file', text: '(本次更新没有说明：CHANGELOG.md 不存在)', file }
  }
  const short = String(digest).slice(0, 8)
  const sections = text.split(/^##\s+/m).slice(1)
  for (const section of sections) {
    const nl = section.indexOf('\n')
    const head = (nl < 0 ? section : section.slice(0, nl)).trim()
    if (head.startsWith(short)) return { found: true, why: 'matched-digest', text: section.trim(), file }
  }
  // ② per-skill 在但没这一条 ⇒ 也试汇总那份
  for (const fb of fallbackFiles) {
    if (typeof fb !== 'string' || fb === '') continue
    let agg
    try {
      agg = readFileSync(fb, 'utf8')
    } catch {
      continue
    }
    const hit = matchAggregateChangelog(agg, skill, digest)
    if (hit !== undefined) return { found: true, why: 'matched-aggregate-changelog', text: hit, file: fb }
  }
  return { found: false, why: 'no-entry-for-this-digest', text: `(本次更新没有说明：CHANGELOG.md 里没有 ${short} 这一条)`, file }
}

/**
 * 从**汇总 CHANGELOG** 里取"这一条"的说明。
 *
 * 汇总格式（`tools/promote-upstream.mjs` 写出来的，实测原文）：
 * ```
 * ## 2026-09-14 · <人写的 note>
 *
 * **说明**：<人写的 note>
 *
 * | 技能 | sha256（前 → 后） |
 * |---|---|
 * | `teamkit-org` | `5b899861877e9caf` → `7f67dda994a09160` |
 * ```
 * ⇒ 判据：**同一节里既有 `| \`<skill>\` |` 又有新 digest 的前 8 位** ⇒ 那一节的 `**说明**：` 就是它。
 * ⚠️ 匹配不上 ⇒ 返回 `undefined`（**不猜、不拿别的技能的说明**）。
 */
export function matchAggregateChangelog(agg, skill, digest) {
  if (typeof agg !== 'string' || skill === '') return undefined
  const short = String(digest).slice(0, 8)
  if (short === '' || short.startsWith('(')) return undefined
  const sections = agg.split(/^##\s+/m).slice(1)
  for (const section of sections) {
    // 这一节必须**提到这个技能**且**提到这个新 digest**
    if (!new RegExp('`' + skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`').test(section)) continue
    if (!section.includes(short)) continue
    const m = /\*\*说明\*\*[:：]\s*(.+)/.exec(section)
    if (m === null) continue
    return `${short}\n- ${m[1].trim()}`
  }
  return undefined
}

/** 快照上游某个 digest 的正文（幂等）。深度 3，实测不污染扫描。 */
export function snapshotUpstream(historyDir, skill, digest, text) {
  if (String(digest).startsWith('(')) return undefined
  const dir = join(historyDir, skill, String(digest).slice(0, 8))
  const file = join(dir, 'SKILL.md')
  if (existsSync(file)) return { file, existed: true }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, text, 'utf8')
  } catch (err) {
    return { file: undefined, existed: false, why: err?.code ?? err?.message }
  }
  return { file, existed: false }
}

/** 通知原文（**四件齐全 + 动作菜单 ≥4 项**，模板照 `UPSTREAM-CHANGELOG.md` §C 的可照抄版）。 */
export function noticeText({ skill, fromDigest, toDigest, newBody, changelog, forkFile, upstreamFile, oldSnapshot, maxBodyExcerpt }) {
  const excerpt = newBody.length > maxBodyExcerpt
    ? `${newBody.slice(0, maxBodyExcerpt)}\n…（正文共 ${newBody.length} 字，完整版见下面"上游新版"路径）`
    : newBody
  return [
    `【上游更新通知 · ${skill}】`,
    `你的**前辈**（上游）更新了技能 \`${skill}\`：${String(fromDigest).slice(0, 8)} → ${String(toDigest).slice(0, 8)}。`,
    '',
    '**① 这次主要改了什么、为什么**（上游更新说明原文）',
    '```',
    changelog.text,
    '```',
    '',
    '**② 改后正文（先看内容，不必现在就决定）**',
    '```',
    excerpt,
    '```',
    '',
    '**③ 可比的三侧（你自己跑 diff，不用问任何人）**',
    `- 你那一份：${forkFile}`,
    `- 上游新版：${upstreamFile}`,
    `- 上游旧版（快照）：${oldSnapshot ?? '(首次跟踪，没有旧版可比)'}`,
    '拿到两份正文后，用 `diff` 工具（`action: text`）自己比 —— 结论由你得出，不是我给你。',
    '',
    '**④ 你可以怎么用（不是二选一；下面每一条都独立可选）**',
    '- **部分采纳**：只把上游这次新增/改好的段落抄进你那一份，别的写法原样留着（推荐先做这个）。',
    '- **全盘跟随**：删掉你 fork 里那份同名条 —— 删掉后自动跟随上游最新版，你的本地改动随之消失。',
    '- **全盘保留**：什么都不做 —— 你的版本继续遮蔽上游，但你**不会**再自动收到这条之后的更新。',
    '- **反向上提**：若 diff 下来觉得你那份更好，把它写成提案给 Lead，由 Lead 决定要不要并进上游。',
    '- **只挂账**：先把说明与两条路径记下，等你手上有相关活时再回来处理。',
    '（以上任何选择都不需要别人批准。）',
  ].join('\n')
}

/** 构造一条可进 `decision.messages` 的 user message（**不 import 任何东西**，与 dsh-agent-instructions 同形）。 */
export function makeNotice(text, meta) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'teamkit-upstream-notify', ...meta },
  }
}

/**
 * 通知器：**每个目标成员一个实例**（因为它记的是"这个成员自己的 fork + 它自己的通知节流"）。
 *
 * 关键：`lastDigest` / `lastNotified` / `pending` / 节流时间是**per 成员**的
 * —— 不同成员的 fork 不同、收到通知的节奏也不同（P-21 的受众收窄）。
 */
export function makeNotifier({ paths, member, tracked, log = () => {} }) {
  const forkDir = forkRootFor(paths, member)
  const state = {
    lastDigest: new Map(),
    lastNotified: new Map(),
    lastNotifiedAt: 0,
    pending: [],
    steps: 0,
    injected: 0,
    // ★ 待投递队列（2026-09-14）：见 `sweep` 里写它的那段注释。
    //   语义：这些通知**已经进过某一步的上下文**，但调用方还要把它们**排进收件箱**，
    //   以保证"成员 idle 期间上游变了"这件事在它**下次开工第一步**就可见。
    deliveryQueue: [],
  }

  const forkHas = (skill) => existsSync(join(forkDir, skill, 'SKILL.md'))

  /** `tracked === 'auto'` ⇒ 只跟踪"这个成员在 fork 里真的改过"的条（零配置，且天然只推该推的）。 */
  function trackedSkills() {
    if (Array.isArray(tracked)) return tracked
    try {
      return readdirSync(forkDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .filter((e) => existsSync(join(forkDir, e.name, 'SKILL.md')))
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  function upstreamFileOf(skill) {
    // 上游可能有多个根；取**第一个真有的**（rank 400 的 user 根优先，与 config 的顺序一致）
    for (const root of [paths.upstream.root, ...(paths.upstream.extraRoots ?? [])]) {
      const f = join(root, skill, 'SKILL.md')
      if (existsSync(f)) return { root, file: f }
    }
    return { root: paths.upstream.root, file: join(paths.upstream.root, skill, 'SKILL.md') }
  }

  /** 基线：把当前上游版本快照进 history（这样"旧版"从此刻起就存在，能 diff）。 */
  function baseline() {
    for (const skill of trackedSkills()) {
      const { file } = upstreamFileOf(skill)
      const d = digestOf(file)
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        text = undefined
      }
      if (text !== undefined) {
        const snap = snapshotUpstream(paths.historyDir, skill, d, text)
        log(`BASELINE member=${member} skill=${skill} digest=${String(d).slice(0, 8)} snapshot=${snap?.file ?? '(none)'} fork=${forkHas(skill)}`)
      } else {
        log(`BASELINE member=${member} skill=${skill} digest=${d}（上游不存在，跳过）`)
      }
      state.lastDigest.set(skill, d)
      state.lastNotified.set(skill, d)
    }
  }

  /**
   * **本插件的核心一步**：在 `agent/pre-step` 里调用。
   * @param decision 上一步 waterfall 的结果（`{kind, messages}`）
   * @returns 修改后的 decision（或原样返回）
   *
   * ⚠️ 顺序**不可换**（照 task-46 §B.6 实测修好的那个顺序）：
   *   ① 先察觉变更 → ② **再补推 pending** → ③ 最后早退。
   * 把补推放到早退之后 = 复现 task-45 的"永久丢通知"缺陷。
   */
  function sweep(decision, signal) {
    state.steps += 1
    try {
      const skills = trackedSkills()
      const changed = []
      for (const skill of skills) {
        // ★★ **上游根本没有这条 ⇒ 不是"上游变了"**（2026-09-14 / Round 18 实测抓到的假通知）
        //
        // 【缺陷】`trackedSkills()`（`auto` 模式）= **fork 里有 SKILL.md 的条目**。
        //   而这里 digest 的是**上游**文件。成员**自己在 fork 里新建一条**（上游从来没有它）时：
        //     · `digestOf(不存在的文件)` → `'absent'`
        //     · `state.lastDigest.get(skill)` → `undefined`（首次见）
        //     ⇒ `'absent' !== undefined` ⇒ **误报 `UPSTREAM-CHANGED`**，并**真给成员发一条通知**。
        //   【实测现场】`coo` 在它 fork 里新建 `coo-probe`（72 B）后：
        //     ```
        //     UPSTREAM-CHANGED member=coo skill=coo-probe from=(none) to=(absent) snapshot=(none) fork=true
        //     CHANGELOG-LOOKUP … why=no-changelog-file
        //     INJECT member=coo #1 … skill=coo-probe bytes=1519      ← 一条**没有意义**的通知
        //     ```
        //   【为什么有危害】通知的语义是"**上游（前辈）更新了，你看看要不要跟**"。
        //     把"我自己新建的"当成"前辈更新了"，会**让成员去检查一个不存在的上游版本**，
        //     而且**每次开工都可能重复**（`lastDigest` 记的是 `'absent'`，一旦 fork 变动又不等）。
        //   【修法】**上游不存在 ⇒ 这条不参与"上游变更"检测**（fork-only 条目本来就与上游无关）。
        //     明确记一条 `SKIP-NOTIFY-UPSTREAM-ABSENT`（**不静默**），并**不写 `lastDigest`**
        //     （这样将来上游真出现了，它才会被当成"新出现"）。
        const { file } = upstreamFileOf(skill)
        if (!existsSync(file)) {
          log(`SKIP-NOTIFY-UPSTREAM-ABSENT member=${member} skill=${skill} why=这条只有 fork 里有（上游从来没有它）⇒ 不是"上游变了" fork=${forkHas(skill)}`)
          continue
        }
        const d = digestOf(file)
        const prev = state.lastDigest.get(skill)
        if (d !== prev) {
          let text
          try {
            text = readFileSync(file, 'utf8')
          } catch {
            text = undefined
          }
          const snap = text === undefined ? undefined : snapshotUpstream(paths.historyDir, skill, d, text)
          log(`UPSTREAM-CHANGED member=${member} skill=${skill} from=${String(prev ?? '(none)').slice(0, 8)} to=${String(d).slice(0, 8)} snapshot=${snap?.file ?? '(none)'} fork=${forkHas(skill)}`)
          changed.push({ skill, prev, d, text, snapshot: snap?.file })
          state.lastDigest.set(skill, d)
        }
      }

      // ── ② 补推 pending **必须在早退之前** ─────────────────────────────
      const now = Date.now()
      const windowOpen = now - state.lastNotifiedAt >= paths.notify.minIntervalMs
      const toSend = []
      if (state.pending.length > 0) {
        if (windowOpen) {
          toSend.push(...state.pending.splice(0))
          log(`PENDING-FLUSH member=${member} count=${toSend.length} step#${state.steps}`)
        } else {
          log(`PENDING-HOLD member=${member} pending=${state.pending.length} step#${state.steps} waitMs=${paths.notify.minIntervalMs - (now - state.lastNotifiedAt)}`)
        }
      }

      // ── ③ 早退（此时 pending 已经处理过）────────────────────────────
      if (changed.length === 0 && toSend.length === 0) return decision

      const needy = changed.filter((c) => forkHas(c.skill))
      for (const c of changed) {
        if (!forkHas(c.skill)) {
          // 没改过 ⇒ 自动跟随，无需动作 ⇒ **不该推**（P-21 受众收窄；task-46 实测对照组 3/3 全拦）
          log(`SKIP-NOTIFY member=${member} skill=${c.skill} why=no-fork-override`)
        }
      }

      if (!windowOpen) {
        for (const c of needy) {
          state.pending.push(c)
          log(`RATE-LIMITED-QUEUED member=${member} skill=${c.skill} digest=${String(c.d).slice(0, 8)} pending=${state.pending.length} step#${state.steps}`)
        }
        return decision
      }
      for (const c of needy) {
        if (state.lastNotified.get(c.skill) === c.d) {
          log(`SKIP-NOTIFY member=${member} skill=${c.skill} why=already-notified-same-digest`)
          continue
        }
        toSend.push(c)
      }
      if (toSend.length === 0) return decision

      const notices = []
      for (const c of toSend) {
        const { file } = upstreamFileOf(c.skill)
        // ★ **回退候选**（2026-09-14 / Round 82）：promote 工具写的**汇总** CHANGELOG。
        //   按"最可能被 promote 写到的"排序：`paths.changelogPath`（插件自己的口径）
        //   → `<upstream.root>/CHANGELOG.md`（有人可能把手写的放上游根）。
        //   ⚠️ 上游根下那份**深度 1 的 `*.md` 会被当扁平技能**（`LANDMINES §18`）——
        //     ⇒ **只读、不写**；它存在也只是候选（不存在就跳过，不报错）。
        const fallbackFiles = [paths.changelogPath, join(paths.upstream.root, 'CHANGELOG.md')].filter(
          (f, i, a) => typeof f === 'string' && f !== '' && a.indexOf(f) === i,
        )
        const changelog = readChangelog(join(paths.upstream.root, c.skill), c.d, fallbackFiles, c.skill)
        log(`CHANGELOG-LOOKUP member=${member} skill=${c.skill} digest=${String(c.d).slice(0, 8)} found=${changelog.found} why=${changelog.why} file=${changelog.file}`)
        const body = (() => {
          try {
            const t = c.text ?? readFileSync(file, 'utf8')
            const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(t)
            return m === null ? t : m[1]
          } catch {
            return ''
          }
        })()
        const text = noticeText({
          skill: c.skill,
          fromDigest: c.prev ?? '(none)',
          toDigest: c.d,
          newBody: body,
          changelog,
          forkFile: join(forkDir, c.skill, 'SKILL.md'),
          upstreamFile: file,
          oldSnapshot: c.snapshot,
          maxBodyExcerpt: paths.notify.maxBodyExcerpt,
        })
        const bytes = Buffer.byteLength(text, 'utf8')
        if (bytes > paths.notify.maxNoticeBytes) {
          // 超出上限**抛错是错的**（会把这一步否掉）；正确做法是**记下来并截到上限内**。
          // ⚠️ 与 `exp/changelog-probe` 的 `throw` 不同 —— 这里改成"截断 + 明说"，
          //    因为"该生效却没生效"必须留信号，而"整条不推"更糟。
          log(`NOTICE-TOO-LONG member=${member} skill=${c.skill} bytes=${bytes} limit=${paths.notify.maxNoticeBytes} ⇒ 截断`)
        }
        const finalText = bytes > paths.notify.maxNoticeBytes
          ? text.slice(0, paths.notify.maxNoticeBytes) + `\n…（通知超长已截断：原文 ${bytes} B，上限 ${paths.notify.maxNoticeBytes} B）`
          : text
        notices.push(makeNotice(finalText, {
          name: c.skill,
          fromDigest: c.prev ?? null,
          toDigest: c.d,
          changelogFound: changelog.found,
          bytes: Buffer.byteLength(finalText, 'utf8'),
        }))
        state.lastNotified.set(c.skill, c.d)
      }
      state.lastNotifiedAt = Date.now()
      state.injected += notices.length
      for (const n of notices) {
        log(`INJECT member=${member} #${state.injected} step#${state.steps} id=${n.id} skill=${n.source.name} bytes=${n.source.bytes} changelogFound=${n.source.changelogFound}`)
      }
      // ★ **把"本次决定要发、但只进了本步上下文"的通知也记进待投递队列**。
      //   为什么：`sweep` 的注入是**插进这一步的 messages**（本步能看到）；
      //   但**如果这一步之后成员就 idle 了**，那些通知就**只存在于这一步的上下文里**，
      //   而"上游又变了"这件事它下次开工才知道（正是 2026-09-14 实测的缺口）。
      //   ⇒ 调用方（`index.js`）可以把它们**再排队进收件箱**，确保"下次开工第一步就看见"。
      for (const n of notices) {
        state.deliveryQueue.push({ skill: n.source.name, digest: n.source.toDigest, text: n.text ?? '' })
      }
      signal?.throwIfAborted?.()
      return { ...decision, messages: [...(decision.messages ?? []), ...notices] }
    } catch (err) {
      // 通知层**永不否决这一步**（waterfall 里抛错会打断整个 step）
      log(`NOTIFY-ERROR member=${member} step#${state.steps} err=${err?.message}`)
      return decision
    }
  }

  return {
    state,
    baseline,
    sweep,
    /**
     * 取出并清空"待投递"队列（调用方把它排进该成员的收件箱）。
     * **取出即清空**：避免同一条通知被反复投递（幂等由调用方 + 清空共同保证）。
     */
    takeQueuedForDelivery() {
      const out = state.deliveryQueue.splice(0)
      return out
    },
    forkDir,
    /** 供 `--status` / selftest 断言的可观察读数。 */
    health: () => ({ member, steps: state.steps, injected: state.injected, pending: state.pending.length, tracked: trackedSkills().length }),
  }
}
