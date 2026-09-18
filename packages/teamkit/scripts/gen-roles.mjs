/**
 * gen-roles.mjs —— 把 `talents/*.md` 的 frontmatter **确定性**地转成 `roles/*.json`。
 *
 * ## ⚠️ 权威源在哪（**别读反了**）
 * **权威源 = `talents/*.md`（人写的地方）**。`roles/*.json` 是**机器生成的读侧副本**。
 * ⇒ **不要手改 `roles/*.json`**：下一次跑本脚本会覆盖它（而且 `check-preset-overlap.mjs`
 *   的第 ③ 条判据会**判红**"有人反向编辑过"）。
 * ⇒ 要改角色 ⇒ **改 `talents/<name>.md`** ⇒ 重跑本脚本。
 *
 * ## 为什么要有生成器（而不是手抄 7 份）
 *  ① **单一事实来源**（`R10` SOT）：人写一份，机器读一份；手抄两遍必然漂移。
 *  ② **契约可机器校验**：字段表写成断言 —— 未知字段 / 禁字段 / 枚举越界 ⇒ **拒绝写盘**（退出码 1）。
 *  ③ **可重复**：改完 Talent 重跑一次即可。
 *
 * ## 本次搬迁（task-99）改了什么
 * 原位置 `runs/005-role-skills/exp/company-probe/tools/gen-roles.mjs` —— 在 `exp/**` 下，
 * 而 `AGENTS.md` 明说 `exp/**` 是"**不要再往里加东西**"的实验件区。
 * ⇒ 移进 `plugin/scripts/`（进包、进 `package.json` 的 `scripts`）。
 * **同时去掉写死的"往上 5 级"**：改成**显式可配 + 默认从脚本位置推**。
 *
 * ⚠️ **搬迁没改变权威源**：默认输出目录**仍是** `runs/005-role-skills/roles/`（仓内那一份），
 *    因为 `sync-assets.mjs` 就是从那里同步进包的（`sync-assets.mjs:82`）。
 *
 * ## 用法
 * ```
 * node plugin/scripts/gen-roles.mjs                 # 生成 + 校验（写仓内 roles/）
 * node plugin/scripts/gen-roles.mjs --check          # 只校验，不写盘（CI / 复核用）
 * node plugin/scripts/gen-roles.mjs --out <dir>      # 换输出目录（**做阳性对照用**）
 * node plugin/scripts/gen-roles.mjs --talents <dir>  # 换 Talent 源（**做阳性对照用**）
 * ```
 * 零依赖：只用 node 内置（与 `plugin/lib` 的口径一致）。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // plugin/scripts
const PLUGIN_DIR = resolve(HERE, '..')               // plugin/
/**
 * 仓根。
 * ⚠️ **不写死"往上几级"作业务前提**：这个值只作**默认**，且**必须过存在性检查**
 *    （下面 `assertRepoRoot`）。搬迁前它写死 `'../../../../..'`（5 级）——
 *    那是因为它在 `exp/company-probe/tools/` 下。**层级是位置的性质，不是事实**，
 *    所以这里既算出默认值、又**验它**，而不是假设它对。
 */
const REPO = resolve(PLUGIN_DIR, '..')

/**
 * 默认仓根的自证：`talents/` 与 `TALENTS.yml` 都在才算。
 * @returns {{ok: boolean, why: string}}
 */
export function assertRepoRoot(repo) {
  const missing = ['talents', 'TALENTS.yml'].filter((n) => !existsSync(join(repo, n)))
  if (missing.length > 0) {
    return {
      ok: false,
      why:
        `仓根判定失败（${repo}）缺：${missing.join(', ')}\n` +
        `   ★ **这是"仓内专有"的生成器** —— 它读仓根的 \`talents/*.md\`（权威源）并写到仓根 \`runs/…\`。\n` +
        `   ★ **开源用户不需要跑它**：预生成的 \`assets/roles/*.json\` **已随包发货**，"装"的时候用的就是那份。\n` +
        `   ⇒ 若你在"只有本包"的环境里想**重建**角色档 ⇒ 用显式路径：\n` +
        `        --talents <你的 talents 目录> --out <输出目录> [--talents-yml <TALENTS.yml>]`,
    }
  }
  return { ok: true, why: 'ok' }
}

/** 取 `--flag value`。 */
function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined
}

const TALENTS = argOf('--talents') !== undefined ? resolve(argOf('--talents')) : join(REPO, 'talents')
const OUT = argOf('--out') !== undefined ? resolve(argOf('--out')) : join(REPO, 'runs/005-role-skills/roles')
const TALENTS_YML = argOf('--talents-yml') !== undefined ? resolve(argOf('--talents-yml')) : join(REPO, 'TALENTS.yml')

/** `_SPEC.md` 的字段表（**逐字照抄**，不许自创）—— 见 `talents/_SPEC.md:9-24`。 */
const SPEC_FIELDS = {
  name: 'required',
  role: 'required',
  level: 'required',
  description: 'required',
  skills: 'required',
  tools: 'required',
  write_scope: 'required',
  gate_policy: 'required',
  acceptance_style: 'required',
  onboarding: 'required',
  // ★★ task-104（职责层）新增两字段 —— 委托方原话形式：「**ceo 该做什么，不该做什么**」。
  //   · `duties`     = 该做什么（正向）
  //   · `boundaries` = **不该做什么**（负向；委托方点名的那一问）
  //   两者**都必填**：只写"该做什么"等于漏掉委托方要的那半边。
  //   ★ 且**每条必须带理由指针**（`（依据：<文件> §<节>）`）⇒ 由 `check-all`/`selftest` 的 `H51` 验（防写成口号）。
  duties: 'required',
  boundaries: 'required',
  // ★★ **task-114（编制卡）新增** —— 委托方四问之一「**领导者该做什么**」的"关系"半边
  //   · `reports_to` = **直接上级的成员名**（与 `roles/<name>.json` 的 `name` 同域）
  //   ★ **`optional`（不是 required）** —— 理由：`chief` 上面没有人
  //     ⇒ 若设必填 ⇒ **必须给它一个假上级或空串** ⇒ **那是编数据**
  //     ⇒ 正解 = **可选字段 + 渲染时显式说"未声明"**（`task-114` 判据：「不许编一个」）
  //   ★ **"手下有谁"没有对应字段** —— 它是本字段的**反向索引**，运行时从全部角色档算出来
  //     ⇒ 依据 `R10`（同一事实只存一处）：两边都写 ⇒ 改一处忘另一处 ⇒ 必然不一致
  reports_to: 'optional',
  personality_tags: 'optional',
  principles: 'optional',
}

/** `_SPEC.md:24` 明写 **DSH 不承载**、写了就是骗人的声明 ⇒ 出现即失败。 */
const FORBIDDEN_FIELDS = ['hosting', 'llm_model', 'api_provider', 'temperature', 'auth_method']

/** `role` / `level` / `gate_policy` 的合法取值（照 `_SPEC.md:13-14,19`）。 */
const ENUM = {
  role: ['research', 'engineering', 'writing', 'review', 'coordination', 'execution', 'marketing'],
  level: ['lead', 'ic', 'coo', 'ceo'],
  gate_policy: ['review', 'strict'],
}

/** 极简 frontmatter 解析：只认 `key: value` 与 `key: [a, b, c]` 两种标量/内联数组。 */
export function parseFrontmatter(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (m === null) throw new Error(`${file}: 没有 frontmatter`)
  const meta = {}
  const body = m[2]
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    let value = kv[2].trim()
    // 内联数组 `[a, b, c]`
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    }
    meta[key] = value
  }
  return { meta, body }
}

/** TALENTS.yml 的 `use_when` / `added`（Market 字段，**不属 `_SPEC.md`** ⇒ 只进 INDEX）。 */
export function parseTalentsIndex(text) {
  const out = new Map()
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const nameM = /^\s{2}- name:\s*(.+)$/.exec(line)
    if (nameM !== null) {
      current = nameM[1].trim()
      out.set(current, {})
      continue
    }
    if (current === null) continue
    const kv = /^\s{4}([a-z_]+):\s*(.*)$/.exec(line)
    if (kv === null) continue
    let v = kv[2].trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    out.get(current)[kv[1]] = v
  }
  return out
}

/**
 * `acceptance_style` 的**可观察性**判据（`_SPEC.md:27` 硬规矩 1："写'高质量'等于没写"）。
 * 这是**启发式审计**，不是合同 —— 判错的边界在报告里逐条人工复看过。
 */
export function auditAcceptance(style) {
  const reasons = []
  const artifactWords = ['指针', '读数', '文件', '路径', '区间', '假设', '写明', '后面', '给全', '追到']
  const hitArtifact = artifactWords.filter((w) => style.includes(w))
  if (hitArtifact.length === 0) reasons.push('没有任何"落到产物上"的词（指针/读数/文件/路径/区间/写明…）')
  const vague = ['高质量', '做好了', '整体不错', '尽量', '认真']
  const hitVague = vague.filter((w) => style.includes(w))
  if (hitVague.length > 0) reasons.push(`含纯形容词：${hitVague.join('/')}`)
  return { observable: reasons.length === 0, reasons, artifactWords: hitArtifact, vagueWords: hitVague }
}

/**
 * 纯计算：由 talents 目录 + TALENTS.yml **算出**该写哪些文件（**不写盘**）。
 * ⇒ 拆出来是为了让"判据③ 重跑生成器比对"能**不落盘**地跑（`--check` 与校验器都用它）。
 * @returns {{ok, problems: string[], profiles: Array, index: object, audits: Array}}
 */
export function computeRoles({ talentsDir, talentsYmlPath }) {
  const problems = []
  if (!existsSync(talentsDir)) {
    return { ok: false, problems: [`talents 目录不存在：${talentsDir}`], profiles: [], index: null, audits: [] }
  }
  if (!existsSync(talentsYmlPath)) {
    return { ok: false, problems: [`TALENTS.yml 不存在：${talentsYmlPath}`], profiles: [], index: null, audits: [] }
  }
  const files = readdirSync(talentsDir).filter((f) => f.endsWith('.md') && f !== '_SPEC.md').sort()
  const talentsYml = parseTalentsIndex(readFileSync(talentsYmlPath, 'utf8'))
  const profiles = []
  const audits = []

  for (const file of files) {
    const abs = join(talentsDir, file)
    const text = readFileSync(abs, 'utf8')
    let meta
    let body
    try {
      ;({ meta, body } = parseFrontmatter(text, file))
    } catch (err) {
      problems.push(`PARSE ${err.message}`)
      continue
    }
    const stem = file.replace(/\.md$/, '')
    if (meta.name !== stem) problems.push(`NAME ${file}: name=${JSON.stringify(meta.name)} ≠ 文件名 ${stem}`)
    for (const key of Object.keys(meta)) {
      if (FORBIDDEN_FIELDS.includes(key)) {
        problems.push(`FORBIDDEN ${file}: 出现禁字段 "${key}"（_SPEC.md:24 DSH 不承载）`)
        continue
      }
      if (!Object.hasOwn(SPEC_FIELDS, key)) problems.push(`UNKNOWN ${file}: 字段 "${key}" 不在 _SPEC 里`)
    }
    for (const [key, kind] of Object.entries(SPEC_FIELDS)) {
      if (kind === 'required' && meta[key] === undefined) problems.push(`MISSING ${file}: 缺必填 "${key}"`)
    }
    for (const [key, allowed] of Object.entries(ENUM)) {
      if (meta[key] !== undefined && !allowed.includes(meta[key])) {
        problems.push(`ENUM ${file}: ${key}=${JSON.stringify(meta[key])} 不在 ${JSON.stringify(allowed)}`)
      }
    }
    for (const key of ['skills', 'tools', 'personality_tags']) {
      if (meta[key] !== undefined && !Array.isArray(meta[key])) problems.push(`TYPE ${file}: ${key} 应为数组`)
    }
    if (Array.isArray(meta.skills) && meta.skills.length === 0) problems.push(`EMPTY ${file}: skills 为空`)

    audits.push({ name: stem, style: String(meta.acceptance_style ?? ''), ...auditAcceptance(String(meta.acceptance_style ?? '')) })

    // 只输出 _SPEC 字段（顺序固定 ⇒ diff 稳定）
    const profile = {}
    for (const key of Object.keys(SPEC_FIELDS)) {
      if (meta[key] !== undefined) profile[key] = meta[key]
    }
    profiles.push({ file: `${stem}.json`, name: stem, profile, body: body.trim() })
  }

  const index = {
    schema: 'teamkit/roles@1',
    source: 'talents/_SPEC.md（字段契约）+ TALENTS.yml（Market 索引）',
    // ⚠️ **note 里不写生成器的路径**（task-99 实测教训）：
    //  脚本搬家时若把路径写进 note，**产物就会跟着变** ⇒ 判据③（"重跑生成器与已提交逐字节一致"）
    //  会**永远判红**（红的原因是我改了注释，不是数据漂移）⇒ 那条判据就废了。
    //  ⇒ note 只描述**规则**（谁是权威源、别手改），**路径不进产物**。
    note: '生成物 —— 权威源是 talents/*.md：改 Talent 再重跑生成器；**别手改本文件或 roles/*.json**。',
    roles: profiles
      .map((p) => {
        const t = talentsYml.get(p.name) ?? {}
        return {
          name: p.name,
          profile: p.file,
          role: p.profile.role,
          level: p.profile.level,
          skills: p.profile.skills,
          gate_policy: p.profile.gate_policy,
          ...(t.use_when === undefined ? {} : { use_when: t.use_when }),
          ...(t.added === undefined ? {} : { added: t.added }),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  }

  for (const name of talentsYml.keys()) {
    if (!profiles.some((p) => p.name === name)) problems.push(`INDEX-DRIFT TALENTS.yml 有 "${name}" 但 talents/ 没有对应文件`)
  }
  for (const p of profiles) {
    if (!talentsYml.has(p.name)) problems.push(`INDEX-DRIFT talents/${p.name}.md 存在但 TALENTS.yml 没登记`)
  }

  return { ok: problems.length === 0, problems, profiles, index, audits }
}

/**
 * 用法文本。
 * ⚠️ **`--help` 绝不写盘** —— 见下面 `main()` 的第一支。
 * 依据（`LANDMINES §7` 规矩 2）：**工具脚本必须提供 `--help`/`--dry-run`，且默认与 `--help` 绝不写盘**。
 * 现场：`docs-writer` 实测跑了一次 `gen-roles.mjs --help` ⇒ **重写了 8 个 json 的 mtime**
 * （内容幂等 ⇒ sha 未变，零损失）—— 但**"看一眼用法"不该动目标文件**。
 */
const USAGE = [
  '用法：node plugin/scripts/gen-roles.mjs [选项]',
  '',
  '把 talents/*.md 的 frontmatter 单向生成到 roles/*.json（权威源是 talents/）。',
  '',
  '选项：',
  '  --check              只校验，**不写盘**（CI / 复核用）',
  '  --dry-run            打印"会写哪些文件 / 内容是否有变化"，**不写盘**',
  '  --help, -h           打印本页，**不写盘**',
  '  --talents <dir>      换 Talent 源目录（默认 <仓根>/talents）',
  '  --out <dir>          换输出目录（默认 <仓根>/runs/005-role-skills/roles）',
  '  --talents-yml <file> 换 TALENTS.yml 路径',
  '',
  '退出码：0 成功 / 1 有契约违规 / 2 用法或环境问题（拿不到仓根等）',
  '',
  '⚠️ **不带 `--check` / `--dry-run` / `--help` 时会写盘**（这是它的本职）。',
  '   若只想看看会改成什么 ⇒ 用 `--dry-run`。',
].join('\n')

function main() {
  const argv = process.argv.slice(2)
  // ★★ **第一支：`--help` ⇒ 只打印，绝不写盘**
  //   ⚠️ 顺序很重要：必须在 `computeRoles` 与任何 `mkdirSync`/`writeFileSync` **之前**返回，
  //      否则"看一眼用法"就又把目标文件碰了（这正是本支要防的）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE + '\n')
    process.exit(0)
  }
  const checkOnly = argv.includes('--check')
  const dryRun = argv.includes('--dry-run')
  // 未知选项 ⇒ 报错 + 用法（**不静默忽略** —— 静默会把"打错字"变成"照常写盘"）
  const KNOWN = new Set(['--check', '--dry-run', '--talents', '--out', '--talents-yml'])
  const VALUE_FLAGS = new Set(['--talents', '--out', '--talents-yml'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    if (!KNOWN.has(a)) {
      process.stderr.write(`❌ 未知选项：${a}\n\n`)
      process.stdout.write(USAGE + '\n')
      process.exit(2)
    }
    if (VALUE_FLAGS.has(a)) i += 1 // 吃掉它的值
  }

  const repoCheck = assertRepoRoot(REPO)
  if (!repoCheck.ok && argOf('--talents') === undefined) {
    console.error(`❌ ${repoCheck.why}`)
    process.exit(2)
  }
  const r = computeRoles({ talentsDir: TALENTS, talentsYmlPath: TALENTS_YML })

  console.log(`# gen-roles: 扫到 ${r.profiles.length} 份 Talent`)
  for (const a of r.audits) {
    console.log(`  ${a.observable ? 'OK  ' : 'WEAK'} ${a.name.padEnd(14)} ${a.observable ? '' : `← ${a.reasons.join('; ')}`}`)
  }
  if (r.problems.length > 0) {
    console.error(`\n❌ ${r.problems.length} 处契约违规：`)
    for (const p of r.problems) console.error(`   - ${p}`)
  } else {
    console.log('\n✅ 契约校验全过（字段/枚举/必填/禁字段/与 TALENTS.yml 一致）')
  }

  // 算出"将写哪些文件、内容是否变化"——`--check` / `--dry-run` / 真写盘**共用**这一段。
  const pending = []
  for (const p of r.profiles) pending.push({ file: p.file, text: JSON.stringify(p.profile, null, 2) + '\n' })
  if (r.index !== null) pending.push({ file: 'INDEX.json', text: JSON.stringify(r.index, null, 2) + '\n' })
  const changed = []
  for (const f of pending) {
    let cur
    try { cur = readFileSync(join(OUT, f.file), 'utf8') } catch { cur = undefined }
    if (cur !== f.text) changed.push(f.file)
  }

  if (checkOnly) {
    console.log(`\n--check：未写盘（本应写 ${pending.length} 个文件到 ${OUT}；其中会变 ${changed.length} 个）`)
    process.exit(r.problems.length > 0 ? 1 : 0)
  }
  if (dryRun) {
    console.log(`\n--dry-run：**未写盘**。目标目录 ${OUT}`)
    console.log(`  会写 ${pending.length} 个文件；其中**内容会变**的 ${changed.length} 个：${changed.length ? changed.join(', ') : '(无 —— 生成幂等)'}`)
    process.exit(r.problems.length > 0 ? 1 : 0)
  }
  if (r.problems.length > 0) {
    console.error('\n有契约违规 ⇒ **拒绝写盘**（不让坏数据进 roles/）')
    process.exit(1)
  }

  mkdirSync(OUT, { recursive: true })
  let written = 0
  for (const f of pending) {
    if (!changed.includes(f.file)) continue   // ★ 内容没变 ⇒ **不碰 mtime**（幂等就真幂等）
    writeFileSync(join(OUT, f.file), f.text, 'utf8')
    written += 1
  }
  console.log(`\n✅ 写入 ${pending.length} 个角色档/索引中的 **${written} 个**（其余内容未变 ⇒ 不碰 mtime）→ ${OUT}`)
  console.log('   ⚠️ 权威源是 talents/*.md；别手改上面那些 json。')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
