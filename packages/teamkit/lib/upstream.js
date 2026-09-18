/**
 * upstream.js —— **上游更新的唯一入口**（把 `tools/promote-upstream.mjs` 从"仓内工具"
 * 收进插件：`promote` / `rollback` / `list`）。
 *
 * 为什么收进插件（task-51 D 的判据回答在 README；这里是实现理由）：
 *  `promote-upstream.mjs` 现在写死了 `PKG = tools/..`、`SKILLS_SRC=<仓>/skills`、
 *  `UPSTREAM=$DSH_HOME/skills`、`HISTORY=<仓>/.upstream-history`、`CHANGELOG=<仓>/CHANGELOG.md`
 *  —— **四个路径全写死**（`tools/promote-upstream.mjs:34-39`）。开源用户 clone 下来
 *  这四个位置全不对。收进插件后它们全部来自 `lib/config.js` 的 `resolveAll()`。
 *
 * 四件事**顺序不可换**（照 P-32 已认可并沙盒实测过的形态）：
 *   ① 快照旧版 → ② 合并 → ③ 记 CHANGELOG → ④ 复核（回读校验）
 *
 * **硬门**：没有 `--note` ⇒ 返回 `code: 2`，**什么都不写**。
 * 为什么把"说明"做成硬门而不是靠自觉：委托方要「每次 push 都发个主要做了什么」，
 * 而写手是模型 —— **最不可靠的恰好就是仪式**（`promote-upstream.mjs:5-11` 原文）。
 * 而且**说明挂在"写"这个动作上**，因此不受"按步轮询会折叠突发提交"那个已实测缺陷影响
 * （`LANDMINES §20`：一个步内连改多次，中间版本连说明一起丢）。
 *
 * ⚠️ 三态：「说明是硬门」= **代码强制**（本文件 `if note 为空 → return code 2`，且
 * 调用方在写盘前先看 code）；「按 note 自动生成可读说明」= 只是文本模板，不是机制。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { scanRoot } from './skills.js'
import { expectContains } from './log.js'

export const EXIT = {
  OK: 0,
  FAIL: 1,
  /** **缺说明**（照 `promote-upstream.mjs:102` 的约定，退出码 2 = 合并不了）。 */
  NO_NOTE: 2,
  /** 写进去了但**回读校验失败**（照 `promote-upstream.mjs:152` 的约定 3）。 */
  WRITE_UNVERIFIED: 3,
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/**
 * `stateOf` —— 一条技能在「仓内源 ↔ 上游」两侧的状态。
 *
 * ⚠️ **源 = `upstream.sources`（仓内源），不是 `skills.sourceDir`**。
 * 这两个是不同的东西，第一版我混用了，后果是**静默的错落点**：
 *   · `skills.sourceDir` = **插件自带**的 skills（默认 `<插件包>/skills`）——
 *     用途是"装上就把方法技能同步到上游根"，它是**包的一部分**；
 *   · `upstream.sources`  = **用户仓内**的技能源（默认 `<workspace>/skills`）——
 *     用途是"把仓里的改动合并进上游"，它是**用户的**。
 * 混用的实况（我在 C2 组里抓到）：`teamkit promote --all` 报 `entries=7`（把插件自带的
 * 7 条合了上去），而用户想合的那条**一条也没动**，且**不退错**。
 * ⇒ 这正是 task-51 B.1"单一事实来源"要防的那类错：**两个都叫"源"，但它们是两件事。**
 *   一个动作改多条源时必须**明确说的是哪一个**（这里多个源时取**先命中**的那个，与
 *   `scanRoots` 的先到先得一致）。
 */
function sourceOf(paths) {
  return paths.upstream.sources[0] ?? paths.skills.sourceDir
}

function stateOf(paths, name) {
  // 上游侧固定；源侧在多个 source 之间取先命中的
  const dst = join(paths.upstream.root, name, 'SKILL.md')
  const have = existsSync(dst) ? readFileSync(dst, 'utf8') : undefined
  let src
  let want
  for (const root of paths.upstream.sources) {
    const cand = join(root, name, 'SKILL.md')
    if (existsSync(cand)) {
      src = cand
      want = readFileSync(cand, 'utf8')
      break
    }
  }
  if (src === undefined) src = join(sourceOf(paths), name, 'SKILL.md')
  return { name, src, dst, want, have, same: want !== undefined && have !== undefined && want === have, upstreamMissing: have === undefined, sourceMissing: want === undefined }
}

/** 源里有哪些技能（**跨全部 `upstream.sources`**，按 frontmatter 的 name；先到先得）。 */
export function sourceSkills(paths) {
  // 逐个源扫，先到先得（与 stateOf 的取值一致）
  const entries = []
  const skipped = []
  const seen = new Set()
  const roots = []
  for (const root of paths.upstream.sources) {
    const scan = scanRoot(root)
    roots.push(scan)
    for (const e of scan.entries) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      entries.push({ ...e, root })
    }
    for (const s of scan.skipped) skipped.push(s)
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { entries, skipped, roots, sourceDir: sourceOf(paths) }
}

/**
 * `list`：待合并清单。
 * @returns `{code, lines, rows}`（**不写盘**）
 */
export function list(paths, log = () => {}) {
  const scan = sourceSkills(paths)
  const lines = [
    '上游更新 · 待合并清单',
    `  源   ${paths.upstream.sources.join('  |  ')}`,
    `  上游 ${paths.upstream.root}`,
  ]
  if (paths.upstream.sources.length === 1) {
    lines[1] = `  源   ${paths.upstream.sources[0]}`
  }
  if (scan.skipped.length > 0) {
    // "失败不静默"：源里被跳过的条要看得见（否则用户以为它不在，其实是坏的）
    for (const s of scan.skipped) log(`SOURCE-SKIPPED name=${s.name} why=${s.why}`)
  }
  const rows = []
  let pending = 0
  for (const entry of scan.entries) {
    const st = stateOf(paths, entry.name)
    const tag = st.sourceMissing ? 'SRC?' : st.upstreamMissing ? 'NEW ' : st.same ? 'OK  ' : '->  '
    if (!st.same) pending += 1
    rows.push({ name: entry.name, tag, same: st.same, upstreamMissing: st.upstreamMissing })
    lines.push(`  ${tag}${entry.name}` + (st.same ? '（一致）' : st.upstreamMissing ? '（上游没有）' : '（待更新）'))
  }
  for (const s of scan.skipped) rows.push({ name: s.name, tag: 'BAD ', same: false, skippedWhy: s.why })
  lines.push(pending === 0 ? '\n  无需合并。' : `\n  ${pending} 条待合并：加 --note "说明" 后合并。`)
  return { code: EXIT.OK, lines, rows, pending, scan }
}

/**
 * `promote`：快照 → 合并 → 记账 → 复核。**`note` 为空直接返回 EXIT.NO_NOTE，一行都不写。**
 * @param opts.note 更新说明（**硬门**）
 * @param opts.skill 只合并这一条（与 `all` 互斥）
 * @param opts.all 合并所有与源不一致的
 * @param opts.dryRun 只报不写（**零写盘**）
 */
export function promote(paths, opts = {}, log = () => {}) {
  const note = typeof opts.note === 'string' ? opts.note.trim() : ''
  if (note === '') {
    log('NO-NOTE 缺少 --note "这次主要改了什么、为什么" ⇒ 不允许更新上游')
    return {
      code: EXIT.NO_NOTE,
      lines: [
        '✗ 缺少 --note "这次主要改了什么、为什么"。',
        '  这是**硬要求**：委托方要"每次 push 都要发个主要做了什么"。',
        '  **没有说明 = 不允许更新上游**（不是"忘了也能推"）。',
      ],
      rows: [],
    }
  }

  const scan = sourceSkills(paths)
  // ① 指名了一条：先确认它在源里**且 frontmatter 合法**（否则静默空转 = "失败不静默"的反例）
  if (opts.skill) {
    const hit = scan.entries.find((e) => e.name === opts.skill)
    if (hit === undefined) {
      const bad = scan.skipped.find((s) => s.name === opts.skill)
      const why = bad
        ? `源里的 "${opts.skill}" **存在但读不出来**：${bad.why}（修好它，或用 --list 看 BAD 行）`
        : `源里没有技能 "${opts.skill}"（源目录：${scan.sourceDir}）`
      log(`SKILL-NOT-FOUND name=${opts.skill} why=${bad ? bad.why : 'absent'}`)
      return { code: EXIT.FAIL, lines: [`✗ ${why}`], rows: [] }
    }
  }

  const names = opts.skill ? [opts.skill] : opts.all ? scan.entries.map((e) => e.name).filter((n) => !stateOf(paths, n).same) : []
  if (names.length === 0) {
    const why = opts.all
      ? '没有待合并的条目（源与上游已一致）⇒ 无事可做'
      : '没指定要合并什么：用 --skill <名字> 或 --all（或先 --list 看清单）'
    log(`NOTHING-TO-DO ${why}`)
    // ⚠️ 退出码 2（= "合并不了"）而不是 0：**"什么都没做"不该看起来像"做成了"**。
    return { code: EXIT.NO_NOTE, lines: [`✗ ${why}`], rows: [] }
  }

  const stamp = new Date().toISOString()
  const rows = []
  const lines = []
  for (const name of names) {
    const st = stateOf(paths, name)
    if (st.want === undefined) {
      rows.push({ name, action: 'skipped-source-missing' })
      lines.push(`跳过 ${name}：源不存在`)
      continue
    }
    const before = st.have === undefined ? '(上游没有)' : sha256(st.have).slice(0, 16)
    const after = sha256(st.want).slice(0, 16)

    // ① 快照旧版（**在合并之前** —— 这样成员之后能拿旧版跟新版 diff）
    if (!opts.dryRun && st.have !== undefined) {
      const snapDir = join(paths.historyDir, name, sha256(st.have).slice(0, 8))
      mkdirSync(snapDir, { recursive: true })
      cpSync(st.dst, join(snapDir, 'SKILL.md'), { force: true })
    }
    // ② 合并
    if (!opts.dryRun) {
      mkdirSync(dirname(st.dst), { recursive: true })
      writeFileSync(st.dst, st.want, 'utf8')
      // 写完立刻回读（"写过了"≠"写进去了"）
      const back = readFileSync(st.dst, 'utf8')
      if (back !== st.want) {
        log(`MERGE-VERIFY-FAIL name=${name} file=${st.dst}`)
        return { code: EXIT.WRITE_UNVERIFIED, lines: [`✗ 合并后回读校验失败：${st.dst}`], rows }
      }
    }
    rows.push({ name, before, after, action: opts.dryRun ? 'dry-run' : 'merged', dst: st.dst })
    lines.push(`${opts.dryRun ? '[dry-run] ' : ''}${name}  ${before} → ${after}`)
  }

  if (!opts.dryRun) {
    // ③ 记账（说明写在"写"这个动作上，不靠事后察觉）
    const body = rows.filter((r) => r.action === 'merged' || r.action === 'dry-run')
      .map((r) => `| \`${r.name}\` | \`${r.before}\` → \`${r.after}\` |`).join('\n')
    const entry = `\n## ${stamp.slice(0, 10)} · ${note}\n\n` +
      `**说明**：${note}\n\n` +
      `| 技能 | sha256（前 → 后） |\n|---|---|\n${body}\n\n` +
      `**回退**：\`teamkit rollback ${rows.find((r) => r.action === 'merged')?.name ?? '<skill>'}\`（取最近一次快照）\n` +
      `**快照位置**：\`${paths.historyDir}/<skill>/<sha8>/SKILL.md\`\n` +
      `**动作**：\`teamkit promote\`（本插件；说明是硬门）\n`
    // ⚠️ **必须先建父目录**：`changelogPath` 默认在 `<stateDir>/CHANGELOG.md` 下，而 stateDir
    //    在**第一次** promote 之前并不存在 ⇒ 不建就 `ENOENT`（这是**在沙盒跑真 CLI 时抓到的**，
    //    `tools/promote-upstream.mjs:39` 之所以没这个问题，是因为它的 CHANGELOG 落在**仓根**
    //    `<PKG>/CHANGELOG.md`，而仓根必然存在 —— 收进插件后默认落点变了，坑就露出来了）。
    try {
      mkdirSync(dirname(paths.changelogPath), { recursive: true })
    } catch (err) {
      log(`CHANGELOG-MKDIR-FAIL file=${paths.changelogPath} err=${err?.code ?? err?.message}`)
      return { code: EXIT.FAIL, lines: [`✗ 无法创建 CHANGELOG 的父目录：${dirname(paths.changelogPath)}（${err?.code ?? err?.message}）`], rows }
    }
    if (!existsSync(paths.changelogPath)) {
      writeFileSync(paths.changelogPath, '# CHANGELOG —— 上游（技能）更新说明\n', 'utf8')
    }
    const prev = readFileSync(paths.changelogPath, 'utf8')
    const ANCHOR = '\n---\n\n## 待办'
    const next = prev.includes(ANCHOR) ? prev.replace(ANCHOR, entry + ANCHOR) : prev + entry
    writeFileSync(paths.changelogPath, next, 'utf8')

    // ④ 复核：**回读确认说明真的落盘**（缺了就 exit 3，绝不假装成功）
    const verified = expectContains(paths.changelogPath, note)
    if (!verified.ok) {
      log(`CHANGELOG-VERIFY-FAIL file=${paths.changelogPath} why=${verified.why}`)
      return { code: EXIT.WRITE_UNVERIFIED, lines: [`✗ 致命：说明没写进 CHANGELOG —— ${verified.why}`], rows }
    }
    log(`PROMOTE-OK entries=${rows.filter((r) => r.action === 'merged').length} changelog=${paths.changelogPath} sha=${sha256(note).slice(0, 8)}`)
    lines.push(`\n已追加 CHANGELOG 条目（写入校验通过）· 快照在 ${paths.historyDir}`)
  } else {
    log(`PROMOTE-DRY-RUN entries=${rows.length}`)
  }

  return { code: EXIT.OK, lines, rows }
}

/**
 * `rollback`：回到该技能**最近一次**快照。
 * ⚠️ 与 `promote-upstream.mjs:81-95` 一致：它取的是"最近一次 promote 之前的那一版"，
 * 因此连续 promote 两次只能退一步 —— 这是**已知限制**，README 的"限制"节要写。
 */
export function rollback(paths, skill, log = () => {}) {
  if (typeof skill !== 'string' || skill === '') {
    return { code: EXIT.FAIL, lines: ['✗ 用法：teamkit rollback <skill>'] }
  }
  const dir = join(paths.historyDir, skill)
  if (!existsSync(dir)) return { code: EXIT.FAIL, lines: [`没有快照：${dir}（这个技能还没被 promote 过）`] }
  const snaps = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'SKILL.md'))).sort()
  if (snaps.length === 0) return { code: EXIT.FAIL, lines: [`快照为空：${dir}`] }
  const latest = snaps[snaps.length - 1]
  const to = join(paths.upstream.root, skill, 'SKILL.md')
  const before = existsSync(to) ? sha256(readFileSync(to, 'utf8')).slice(0, 16) : '(无)'
  try {
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(join(dir, latest, 'SKILL.md'), 'utf8'), 'utf8')
  } catch (err) {
    return { code: EXIT.FAIL, lines: [`✗ 回退写入失败：${err?.code ?? err?.message}`] }
  }
  const after = sha256(readFileSync(to, 'utf8')).slice(0, 16)
  log(`ROLLBACK skill=${skill} snapshot=${latest} ${before} -> ${after}`)
  return { code: EXIT.OK, lines: [`回退 ${skill}：取快照 ${latest}`, `  ${before} → ${after}`] }
}
