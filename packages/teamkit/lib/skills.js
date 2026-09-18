/**
 * skills.js —— 技能条的**读写原语**（frontmatter 解析 / 目录发现 / 安装）。
 *
 * 为什么独立成件：这个插件里"读一条 SKILL.md 的 name/description/正文"这件事
 * 在**四个**实验件里各写了一遍（`exp/a-channel-probe/lib/index.js:52-64`、
 * `exp/notify-probe/lib/index.js:58-70`、`exp/changelog-probe/lib/index.js:86-98`、
 * `exp/hire-probe/lib/index.js:64-76`，正则是同一行）—— 这正是 task-51 B.1
 * 说的"多处各写一遍"，收敛到这一处。
 *
 * 三条硬纪律（都有实测来源，写进代码而不是写进注释）：
 *  ① **写 SKILL.md 必须无 BOM**：PS 5.1 的 `Set-Content -Encoding UTF8` 带 BOM ⇒
 *     frontmatter 解析失败 ⇒ **整条技能静默消失**（`LANDMINES §19`）。本模块只走
 *     `node:fs` 写字符串（Node 不写 BOM），并在安装后**回读校验首字节**。
 *  ② **frontmatter 第一行必须严格等于 `---`**（`dsh-skill-filesystem:772-775`），
 *     否则同样静默失效 —— 所以解析器要把"没有 frontmatter"如实报出来，不许假装成功。
 *  ③ **技能名必须 kebab-case**（`dsh-skill:17` `^[a-z0-9]+(?:-[a-z0-9]+)*$`），
 *     且**目录名不必等于 frontmatter 的 name**（本机实测：`skills/teamkit-org` 里
 *     `name: teamkit-org` 恰好相同，但 `verify-handoff.mjs:34` 把"必须等于"当判据；
 *     `dsh-skill-filesystem` 自己只信 frontmatter 的 name）⇒ 本模块**以 frontmatter 为准**，
 *     并把"目录名 ≠ name"作为一个**可报的 WARN**。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 合法技能名（与 `dsh-skill:17` 同一正则）。 */
export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name)
}

/**
 * 极简 frontmatter 解析。
 * **只认标量键**（`name` / `description` / `whenToUse` / `invocation` 之类的简单值）；
 * 不引入 yaml 依赖（注入目录没有 node_modules，见模块头）。
 * @returns `{ hasFrontmatter, meta, body, why }` —— `why` 说明为什么没有 frontmatter（诚实，不静默）
 */
export function parseSkill(text) {
  const raw = String(text ?? '')
  // ①②：BOM 会让首行不等于 `---` ⇒ 显式识别并报出来（这一点比"静默当没有 frontmatter"有用得多）
  const hasBom = raw.charCodeAt(0) === 0xfeff
  const stripped = hasBom ? raw.slice(1) : raw
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(stripped)
  if (m === null) {
    return {
      hasFrontmatter: false,
      hasBom,
      meta: {},
      body: stripped,
      why: hasBom ? 'BOM-OR-MISSING-FRONTMATTER' : 'missing-frontmatter',
    }
  }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv !== null) meta[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
  }
  // 诚实标注：本解析器**会剥掉 BOM**（比 DSH 宽松 —— `parseFrontmatter` 要求首行严格等于 `---`，
  // 所以 DSH 那边整条技能会**静默消失**）。`hasBom` 就是给调用方去 warn 的信号：
  // **能不能解析**与**该不该报警**是两件事，这里都如实给出来。
  return { hasFrontmatter: true, hasBom, meta, body: m[2], why: 'ok' }
}

/** 一条技能条目的发现结果。 */
function candidateFrom(dir, entryName, { root, flat }) {
  const file = flat ? join(root, entryName) : join(root, entryName, 'SKILL.md')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, file, why: `${err?.code ?? err?.message}` }
  }
  const parsed = parseSkill(text)
  if (!parsed.hasFrontmatter) return { ok: false, file, why: `frontmatter:${parsed.why}` }
  // ⚠️ **BOM 必须在这里就拦下**：DSH 的 `parseFrontmatter` 要求首行严格等于 `---`，
  // 带 BOM 时首行是 `\uFEFF---` ⇒ 该技能**整条静默消失**（只留一行 warn，LANDMINES §19）。
  // 我们自己的解析器会剥 BOM（更宽松），但**不许**把"我们能读"当成"DSH 能读" ⇒ 按 skip 报出来。
  if (parsed.hasBom) return { ok: false, file, why: 'BOM（DSH 会静默丢弃这条：首行不等于 ---）—— 用无 BOM UTF-8 重写' }
  const name = parsed.meta.name ?? entryName.replace(/\.md$/, '')
  if (!isSkillName(name)) return { ok: false, file, why: `invalid-skill-name:${name}` }
  return {
    ok: true,
    name,
    description: parsed.meta.description ?? '(no description)',
    whenToUse: parsed.meta.whenToUse,
    dirName: flat ? entryName.replace(/\.md$/, '') : entryName,
    dir: flat ? root : join(root, entryName),
    file,
    body: parsed.body,
    meta: parsed.meta,
    warnings: !flat && entryName !== name ? [`目录名 ${entryName} ≠ frontmatter name ${name}（DSH 以 frontmatter 为准）`] : [],
  }
}

/**
 * 扫一个技能根，返回**三态**结果（合法的条目 / 被跳过的条 + 原因 / 根本身读不到的判据）。
 *
 * 为什么返回 `skipped`：`dsh-skill-filesystem` 遇到坏条目**只 warn 然后跳过** ⇒ 用户的
 * 技能"静默消失"（`LANDMINES §19` 的实况）。我们把每一条 skip 的原因**带回给调用方**，
 * 让 `--selftest` / `--status` 能把它们打出来 —— 这就是"失败不静默"的落点。
 */
export function scanRoot(root, opts = {}) {
  const out = { root, entries: [], skipped: [], readable: true, why: null }
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    const code = err?.code ?? ''
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      out.readable = true
      out.existing = false
      return out
    }
    // **读不到 ≠ 没有**（`LANDMINES §6`）：EACCES/EPERM 归 unreadable
    out.readable = false
    out.why = code || err?.message || String(err)
    return out
  }
  out.existing = true

  for (const e of dirents) {
    // ① 目录包形态 `<root>/<name>/SKILL.md`
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue // 隐藏目录（.history / .git）永不是技能
      const cand = candidateFrom(root, e.name, { root, flat: false })
      if (cand.ok) out.entries.push(cand)
      else if (!existsSync(join(root, e.name, 'SKILL.md'))) {
        // 目录里没有 SKILL.md —— 只有在**它看起来像技能目录**时才记 skip（避免噪音：
        // 技能根下常驻 assets/ 之类的子目录）
        if (!opts.quiet) out.skipped.push({ name: e.name, file: cand.file, why: 'no-SKILL.md' })
      } else {
        out.skipped.push({ name: e.name, file: cand.file, why: cand.why })
      }
      continue
    }
    // ② 扁平形态 `<root>/<name>.md`
    if (e.isFile() && e.name.endsWith('.md')) {
      const cand = candidateFrom(root, e.name, { root, flat: true })
      if (cand.ok) out.entries.push(cand)
      else out.skipped.push({ name: e.name, file: cand.file, why: cand.why })
    }
  }
  out.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/** 扫多个根，后面的根**不覆盖**前面的同名条目（先到先得；调用方自己按语义排序）。 */
export function scanRoots(roots, opts = {}) {
  const seen = new Map()
  const all = []
  for (const root of roots) {
    const r = scanRoot(root, opts)
    all.push(r)
    for (const e of r.entries) if (!seen.has(e.name)) seen.set(e.name, { ...e, root })
  }
  return { roots: all, byName: seen, entries: [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }
}

/**
 * 无 BOM 写入（**并回读断言**）。
 * @returns `{ok, why, bytes}` —— 失败时 why 可执行。
 */
export function writeSkillFile(file, text) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    // Node 的 writeFileSync 写 UTF-8 不加 BOM（这正是我们要的；PS 5.1 的 Set-Content 会加）
    writeFileSync(file, text, 'utf8')
  } catch (err) {
    return { ok: false, why: `写入失败：${err?.code ?? err?.message}` }
  }
  let back
  try {
    back = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, why: `回读失败：${err?.code ?? err?.message}` }
  }
  if (back !== text) return { ok: false, why: `回读不一致（写入 ${Buffer.byteLength(text)} B，回读 ${Buffer.byteLength(back)} B）` }
  if (back.charCodeAt(0) === 0xfeff) return { ok: false, why: '写出的文件带 BOM ⇒ 该技能会被 DSH 静默丢弃（LANDMINES §19）' }
  return { ok: true, why: 'ok', bytes: Buffer.byteLength(text, 'utf8') }
}

/** 把一个技能目录（<name>/SKILL.md）复制到目标技能根下。 */
export function installSkill(entry, dstRoot, { overwrite = false } = {}) {
  const dstDir = join(dstRoot, entry.name)
  const dst = join(dstDir, 'SKILL.md')
  const existedBefore = existsSync(dst)
  if (existedBefore && !overwrite) {
    const want = readFileSync(entry.file, 'utf8')
    const cur = readFileSync(dst, 'utf8')
    if (cur === want) return { name: entry.name, action: 'same', dst }
    // ★★ **"我们装的、内容却旧了" ⇒ 更新它**（2026-09-14 / Round 47 实测的真 bug）。
    //
    // 【缺陷现场】我把技能从 39 行改到 80 行（加了"撤人怎么撤"整节），`sync-skills` 同步了仓内与包内，
    //   **但上游根那份仍是 39 行** —— 因为默认 `skills.overwrite=false` 时**这里直接 `skipped-exists`**。
    //   真宿主实测（新 omc 会话**自己发现的**）：
    //   > `skill` 工具加载到的是**上游根那份**（39 行）……**里面根本没有"撤人怎么撤"这一节**
    //   ⇒ **模型读到的是旧版，而我没被告知** —— 我前几轮"把知识写进技能"的努力**全部没到用户手上**。
    //
    // 【原意图（要保住）】`overwrite:false` 是为了**别冲掉用户自己改过的技能** —— 那是对的。
    // 【修法（两者都要）】判据加一维：**这份是不是我们装的**（`.teamkit` 标记）+
    //   **用户改过没有**（与我们上次装的内容比对）：
    //     · 我们装的 + 内容 = 我们的旧版 ⇒ **是我们自己的更新** ⇒ **覆盖**（用户没损失）；
    //     · 我们装的 + 内容 ≠ 任何我们的版本 ⇒ 用户改过 ⇒ **不覆盖**，**并明确报 `skipped-user-edited`**；
    //     · 没有 `.teamkit` 标记 ⇒ 不是我们装的 ⇒ **不覆盖**（维持原语义）。
    //   ⚠️ "用户改过没有"**只能近似判**（我们没存"上次装的版本"）⇒ 本实现用**启发式**：
    //     有标记 ⇒ 认为是我们装的；内容不同 ⇒ 覆盖（因为**它带了我们的标记，说明不是用户手写的**）。
    //     若用户**在我们的文件上改过**，会被覆盖 —— 这是**取舍**，已写进 README 让用户知道（可关 `skills.overwrite`）。
    const ours = existsSync(join(dstDir, '.teamkit'))
    if (!ours) {
      // ⚠️ **没有标记 ≠ 一定是用户的**（2026-09-14 实测）：
      //   本机上**上游根那 7 条全都没有 `.teamkit` 标记** —— 因为它们是**早期版本（还没有标记逻辑时）**
      //   由本插件播种的。若一律当"外来"⇒ **我们自己的旧版永远不会更新**（正是本轮那个 bug）。
      //   ⇒ 再加一维**内容判据**：这份内容**看起来是不是我们的技能**（带 `name: teamkit*` 的 frontmatter）。
      //     是 ⇒ 当作"我们装的旧版"⇒ 更新；不是 ⇒ 真外来 ⇒ 不覆盖。
      const looksOurs = /^---[\s\S]{0,400}?\nname:\s*teamkit[a-z-]*\s*$/m.test(cur)
      if (!looksOurs) {
        // 真外来（= 用户自己的同名技能）⇒ 保持原语义：绝不覆盖
        return { name: entry.name, action: 'skipped-foreign', dst }
      }
      // 是我们早期播种的 ⇒ 补标记 + 更新（并说清为什么）
      const r1 = writeSkillFile(dst, want)
      if (!r1.ok) return { name: entry.name, action: 'failed', dst, why: r1.why }
      writeFileSync(join(dstDir, '.teamkit'), `teamkit:v1 ${entry.name}\n`, 'utf8')
      return { name: entry.name, action: 'updated', dst, bytes: r1.bytes, why: 'ours-unmarked-but-stale（早期播种、无标记 ⇒ 补标记并更新）' }
    }
    // 是我们装的、但内容旧了 ⇒ 覆盖（这是**我们自己的版本更新**，不是用户改动）
    const r0 = writeSkillFile(dst, want)
    if (!r0.ok) return { name: entry.name, action: 'failed', dst, why: r0.why }
    writeFileSync(join(dstDir, '.teamkit'), `teamkit:v1 ${entry.name}\n`, 'utf8')
    return { name: entry.name, action: 'updated', dst, bytes: r0.bytes, why: 'ours-but-stale（我们装的旧版 ⇒ 更新）' }
  }
  const r = writeSkillFile(dst, readFileSync(entry.file, 'utf8'))
  if (!r.ok) return { name: entry.name, action: 'failed', dst, why: r.why }
  // 标记位：卸载只删本插件装的（照 `install-teamkit.mjs:44` 的 `.teamkit` 标记）
  writeFileSync(join(dstDir, '.teamkit'), `teamkit:v1 ${entry.name}\n`, 'utf8')
  return { name: entry.name, action: existedBefore ? 'overwritten' : 'installed', dst, bytes: r.bytes }
}

/** 判据：`under(base, target)`（跨盘安全，三条件缺一不可 —— `LANDMINES §10` 的实测坑）。 */
export function under(base, target, path) {
  if (typeof base !== 'string' || base === '' || typeof target !== 'string') return false
  const rel = path.relative(base, target)
  // 跨盘时 path.relative 返回**绝对路径**，只判 `!rel.startsWith('..')` 会永远为真
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
