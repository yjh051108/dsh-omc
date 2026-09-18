/**
 * check-preset-overlap.mjs —— **"三件套不许重叠"的四条机械判据**（task-99 ②）。
 *
 * ## 四条判据（总工程师给，CEO 批）
 * ```
 * ① roles/*.json 每个字段能在 talents/*.md 的 frontmatter **逐字找到**
 * ② roles/*.json **不许有** talents 里没有的新字段
 * ③ **生成关系单向**：talents →（生成器）→ roles；**反向编辑禁止**
 * ④ 预设里**不许内联岗位数据**（预设只做装配）
 * ```
 * ①+② 合起来 = **字段集合相等 + 每个值逐字相等**（"同一份事实的四个副本"必须真一致）。
 *
 * ## 这一条为什么值得存在（判据来自实测）
 * 实测（总工程师，我独立复核成立）：7 个角色 × 12 字段 **全部逐字段一致**
 * ⇒ 它们**不是三套东西，是同一份事实的多个副本** ⇒ 副本之间只要有人手改一处就会漂，
 *   而且**漂了不会有任何信号**（没有断言盯着）。
 * ⇒ 本文件就是那个信号。**它必须能红** —— 见 §阳性对照。
 *
 * ## 为什么"能红"要单独证明
 * "有判据"与"判据真的会红"是两件事（本项目反复栽在把"有机制的样子"当成机制）。
 * ⇒ 用法里带 `--self-test`：**自己造一个假违规**（json 多一个字段 / 少一个字段 / 值不等），
 *   跑同一套逻辑，**要求它报红**。红了才算这条判据活着。
 *
 * ## 用法
 * ```
 * node plugin/scripts/check-preset-overlap.mjs              # 四态判定（人类可读）
 * node plugin/scripts/check-preset-overlap.mjs --json        # 机器可读
 * node plugin/scripts/check-preset-overlap.mjs --self-test   # ★ 阳性对照：证明判据能红
 * ```
 * 退出码：`0` 全过 / `1` 有 FAIL / `2` 无 FAIL 但有 UNVERIFIED（与 `teamkit selftest` 同口径）。
 *
 * 零依赖：只用 node 内置。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { computeRoles, parseFrontmatter } from './gen-roles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const REPO = resolve(PLUGIN_DIR, '..')

const ROLES_DIR = join(REPO, 'runs', '005-role-skills', 'roles')
const TALENTS_DIR = join(REPO, 'talents')
const TALENTS_YML = join(REPO, 'TALENTS.yml')
const PRESETS_DIR = join(REPO, 'presets')

/** 一行判定结果。三态：PASS / FAIL / UNVERIFIED（**不许把"没测"写成 PASS**）。 */
const rows = []
const add = (state, rule, what, detail) => rows.push({ state, rule, what, detail })

/**
 * 判据 ①②：roles/*.json 与 talents/*.md 的 frontmatter —— **集合相等 + 值逐字相等**。
 * @returns {{ok: boolean, problems: string[], pairs: number}}
 */
export function checkFieldsConsistent(rolesDir, talentsDir) {
  const problems = []
  if (!existsSync(rolesDir)) return { ok: false, problems: [`roles 目录不存在：${rolesDir}`], pairs: 0 }
  if (!existsSync(talentsDir)) return { ok: false, problems: [`talents 目录不存在：${talentsDir}`], pairs: 0 }
  const names = readdirSync(rolesDir).filter((f) => f.endsWith('.json') && f !== 'INDEX.json').map((f) => f.replace(/\.json$/, '')).sort()
  let pairs = 0
  for (const name of names) {
    const jPath = join(rolesDir, `${name}.json`)
    const mPath = join(talentsDir, `${name}.md`)
    if (!existsSync(mPath)) { problems.push(`② roles/${name}.json 有，但 talents/${name}.md 不存在（岗位档案是源，缺了就是单向断链）`); continue }
    let j
    let fm
    try { j = JSON.parse(readFileSync(jPath, 'utf8')) } catch (err) { problems.push(`② roles/${name}.json 不是合法 JSON：${err?.message ?? String(err)}`); continue }
    try { ({ meta: fm } = parseFrontmatter(readFileSync(mPath, 'utf8'), `${name}.md`)) } catch (err) { problems.push(`② talents/${name}.md 解析失败：${err?.message ?? String(err)}`); continue }

    const jk = Object.keys(j)
    const fk = Object.keys(fm)
    // ② json 里**多出** frontmatter 没有的字段
    for (const k of jk) {
      if (!fk.includes(k)) problems.push(`② roles/${name}.json 有 talents 里没有的字段 "${k}"（json 不许自创字段）`)
    }
    // ① frontmatter 有、json 缺的字段（逐字找到 ⇒ 双向都要查）
    for (const k of fk) {
      if (!jk.includes(k)) problems.push(`① talents/${name}.md 的字段 "${k}" 在 roles/${name}.json 里找不到`)
    }
    // 值逐字相等
    for (const k of jk) {
      if (!fk.includes(k)) continue
      pairs += 1
      const a = JSON.stringify(j[k])
      const b = JSON.stringify(fm[k])
      if (a !== b) problems.push(`① roles/${name}.json 的 "${k}" 与 talents 不等：json=${a} md=${b}`)
    }
  }
  return { ok: problems.length === 0, problems, pairs, names }
}

/**
 * 判据 ③：**生成关系单向** —— 重跑生成器（**不落盘**）与已提交的 roles/ 逐字节比对。
 * 不一致 ⇒ **有人手改过 roles/*.json**（反向编辑）⇒ 红。
 */
export function checkSingleDirection(rolesDir, talentsDir, talentsYmlPath) {
  const problems = []
  const r = computeRoles({ talentsDir, talentsYmlPath })
  if (!r.ok) {
    // ⚠️ 生成器自己报违约 ⇒ 这是 **UNVERIFIED 的正当理由**（不是"PASS"）：
    //    这种情况下"能不能生成"都没定，谈"单向"没意义。
    return { ok: false, unverified: true, problems: r.problems }
  }
  if (!existsSync(rolesDir)) return { ok: false, problems: [`roles 目录不存在：${rolesDir}`] }
  // 生成器算出来的每份 profile + INDEX.json 必须与盘上逐字节一致
  for (const p of r.profiles) {
    const onDisk = join(rolesDir, p.file)
    if (!existsSync(onDisk)) { problems.push(`③ ${p.file} 在 roles/ 里不存在（生成器会产出它）`); continue }
    const want = JSON.stringify(p.profile, null, 2) + '\n'
    const got = readFileSync(onDisk, 'utf8')
    if (want !== got) problems.push(`③ roles/${p.file} 与"从 talents 重新生成"的结果**不一致** ⇒ 有人手改过它（反向编辑禁止；改 talents/*.md 再重跑生成器）`)
  }
  const idx = join(rolesDir, 'INDEX.json')
  if (existsSync(idx) && r.index !== null) {
    const want = JSON.stringify(r.index, null, 2) + '\n'
    if (readFileSync(idx, 'utf8') !== want) problems.push('③ roles/INDEX.json 与重新生成的结果不一致 ⇒ 有人手改过（反向编辑禁止）')
  } else if (!existsSync(idx)) {
    problems.push('③ roles/INDEX.json 不存在（生成器会产出它）')
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 判据 ④：**预设里不许内联岗位数据**（预设只做装配）。
 *
 * 机械判据（两个面，任一命中即红）：
 *  · **面 A**：composition 里出现 `talents/` 的**岗位字段名**作为 YAML 键
 *    （`write_scope` / `gate_policy` / `acceptance_style` / `onboarding` / `personality_tags`）
 *    —— 这些字段只该活在 `talents/*.md` 与 `roles/*.json` 里，预设**读目录**而不是**抄内容**；
 *  · **面 B**：composition 里出现**岗位名 + 岗位描述**这种"内联一份岗位档"的形态
 *    （判据：`description:` 的值等于某个 talent 的 description 原文）。
 *
 * ⚠️ **刻意不查"文件里出现岗位名"** —— 预设**可以**提到岗位名（注释里解释语义、
 *    或将来做"按岗位装配"的配置都可能出现），查它会**假红**。假红会让人把判据关掉，
 *    那比没有判据更坏。⇒ 只查"**字段名当键**"与"**描述原文被抄进来**"这两个硬信号。
 */
export function checkNoInlineRoleData(presetsDir, rolesDir) {
  const problems = []
  if (!existsSync(presetsDir)) return { ok: false, unverified: true, problems: [`presets 目录不存在：${presetsDir}`] }
  // 收集 talents 的字段名与 description 原文（作为"被抄进来的指纹"）
  const FIELD_KEYS = ['write_scope', 'gate_policy', 'acceptance_style', 'onboarding', 'personality_tags']
  const descriptions = []
  if (existsSync(rolesDir)) {
    for (const f of readdirSync(rolesDir).filter((x) => x.endsWith('.json') && x !== 'INDEX.json')) {
      try {
        const j = JSON.parse(readFileSync(join(rolesDir, f), 'utf8'))
        if (typeof j.description === 'string' && j.description.length > 8) descriptions.push({ name: f.replace(/\.json$/, ''), text: j.description })
      } catch { /* 前面判据会报 */ }
    }
  }
  // 扫每个预设（含 _templates）的 composition
  const targets = []
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (e.name === 'agent.cordis.yml' || e.name === 'agent.cordis.yml.tmpl') targets.push(p)
    }
  }
  walk(presetsDir, 0)
  for (const file of targets) {
    const text = readFileSync(file, 'utf8')
    const rel = file.replace(REPO + '\\', '').replace(REPO + '/', '').replace(/\\/g, '/')
    // 面 A：岗位字段名作为 YAML 键（`  key:` 或 `- key:`），且**不在注释行里**
    for (const key of FIELD_KEYS) {
      const re = new RegExp(`^[^#\\n]*\\b${key}\\s*:`, 'm')
      if (re.test(text)) problems.push(`④ ${rel} 里出现岗位字段 "${key}:" 当键 ⇒ 预设不许内联岗位数据（只做装配：读 roles.dir）`)
    }
    // 面 B：某个 talent 的 description 原文被抄进预设
    for (const d of descriptions) {
      if (text.includes(d.text)) problems.push(`④ ${rel} 里抄进了 talents/${d.name}.md 的 description 原文 ⇒ 预设不许内联岗位数据`)
    }
  }
  return { ok: problems.length === 0, problems, scanned: targets.length }
}

// ── 阳性对照：**证明判据能红**（不是"我说它能红"）────────────────────────────
/**
 * 自测：在**真实临时目录**里造 4 种**已知违规**，要求对应判据**报红**。
 *
 * ⚠️ 为什么必须做这个（而不是"读代码觉得它会红"）：
 *   本项目反复栽在"把'有机制的样子'当成机制"（`H41`/`R13` 同族）。
 *   判据**没被证明能红** ⇒ 它可能永远绿（比如正则写错了、路径拼错了、字段名敲错了），
 *   而**永远绿的判据比没有判据更坏**（它给人虚假的安全感）。
 * ⇒ 这里**先自证**：造违规 ⇒ 必须红；不红就是**本判据自身有缺陷**，自测失败。
 *
 * @returns {{ok: boolean, cases: Array<{name, expect, got, verdict, ok, why?}>}}
 */
export function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'teamkit-overlap-selftest-'))
  const cases = []
  const T = join(base, 'talents')
  const R = join(base, 'roles')
  const P = join(base, 'presets')
  mkdirSync(T, { recursive: true }); mkdirSync(R, { recursive: true }); mkdirSync(join(P, 'probe'), { recursive: true })

  // 一个**完整合法**的 Talent（12 个 _SPEC 字段全给）—— 必须让生成器**跑通**，
  // 否则判据③永远是"生成器自己报违约"的 UNVERIFIED ⇒ 阳性对照会**假红**（我第一版就栽在这）。
  const TALENT_MD = [
    '---',
    'name: a',
    'role: engineering',
    'level: ic',
    'description: 测试用角色档（含"读数"以便通过可观察性审计）',
    'skills: [实现]',
    'tools: [read, write]',
    'write_scope: src/**',
    'gate_policy: review',
    'acceptance_style: 改完贴**原始读数**',
    'onboarding: 先读任务卡',
    'personality_tags: [实测]',
    'principles: principles/a.md',
    '---',
    '正文',
    '',
  ].join('\n')
  writeFileSync(join(T, 'a.md'), TALENT_MD, 'utf8')
  writeFileSync(join(T, 'TALENTS.yml'), 'talents:\n  - name: a\n    use_when: 测试\n', 'utf8')

  // ★ **基准由生成器自己产出**（而不是我手写一份"我以为对"的）⇒ 基准必然与生成器一致 ⇒ 判据③必定绿。
  //   这样后面"手改 ⇒ 红"的红，**只可能**是手改造成的。
  const genBase = computeRoles({ talentsDir: T, talentsYmlPath: join(T, 'TALENTS.yml') })
  const goodJson = genBase.profiles.find((p) => p.name === 'a')?.profile
  if (goodJson === undefined || !genBase.ok) {
    return { ok: false, cases: [{ name: '基准构造', expect: 'n/a', got: 'failed', verdict: 'FAIL', ok: false, why: `生成器拒绝了这个 fixture：${(genBase.problems ?? []).slice(0, 2).join(' | ')}` }] }
  }
  writeFileSync(join(R, 'a.json'), JSON.stringify(goodJson, null, 2) + '\n', 'utf8')
  if (genBase.index !== null) writeFileSync(join(R, 'INDEX.json'), JSON.stringify(genBase.index, null, 2) + '\n', 'utf8')
  writeFileSync(join(P, 'probe', 'agent.cordis.yml'), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n", 'utf8')

  const runCase = (name, expect, fn) => {
    let problems = null
    try { problems = fn() } catch (err) { problems = [`threw: ${err?.message ?? String(err)}`] }
    const red = Array.isArray(problems) && problems.length > 0
    const ok = expect === 'red' ? red : !red
    cases.push({ name, expect, got: red ? 'red' : 'green', verdict: ok ? 'PASS' : 'FAIL', ok, why: red ? problems[0] : '' })
  }

  // ① 基准必须先绿（否则"红"可能是别的原因造成的假红 ⇒ 阳性对照无效）
  runCase('基准（一致的 talents/roles）', 'green', () => checkFieldsConsistent(R, T).problems)
  // ② json 多出一个字段 ⇒ 判据②必须红
  runCase('roles 多一个字段 foo', 'red', () => {
    const j = { ...goodJson, foo: 'x' }
    writeFileSync(join(R, 'a.json'), JSON.stringify(j, null, 2) + '\n', 'utf8')
    const p = checkFieldsConsistent(R, T).problems
    writeFileSync(join(R, 'a.json'), JSON.stringify(goodJson, null, 2) + '\n', 'utf8') // 还原
    return p
  })
  // ③ 同一个字段值不同 ⇒ 判据①必须红
  runCase('roles 的 gate_policy 与 talents 不等', 'red', () => {
    const j = { ...goodJson, gate_policy: 'strict' }
    writeFileSync(join(R, 'a.json'), JSON.stringify(j, null, 2) + '\n', 'utf8')
    const p = checkFieldsConsistent(R, T).problems
    writeFileSync(join(R, 'a.json'), JSON.stringify(goodJson, null, 2) + '\n', 'utf8')
    return p
  })
  // ④ 预设里内联岗位字段 ⇒ 判据④必须红
  runCase('预设里写 write_scope: src/**', 'red', () => {
    const f = join(P, 'probe', 'agent.cordis.yml')
    const before = readFileSync(f, 'utf8')
    writeFileSync(f, before + '  config:\n    write_scope: src/**\n', 'utf8')
    const p = checkNoInlineRoleData(P, R).problems
    writeFileSync(f, before, 'utf8')
    return p
  })
  // ⑤ 预设抄进岗位描述原文 ⇒ 判据④必须红
  runCase('预设抄进角色 description 原文', 'red', () => {
    const desc = '实现者：按判据把代码写出来并自测，如实报读数。'
    writeFileSync(join(R, 'a.json'), JSON.stringify({ ...goodJson, description: desc }, null, 2) + '\n', 'utf8')
    const f = join(P, 'probe', 'agent.cordis.yml')
    const before = readFileSync(f, 'utf8')
    writeFileSync(f, before + `# ${desc}\n`, 'utf8')
    const p = checkNoInlineRoleData(P, R).problems
    writeFileSync(f, before, 'utf8')
    writeFileSync(join(R, 'a.json'), JSON.stringify(goodJson, null, 2) + '\n', 'utf8')
    return p
  })
  // ⑥ 反向编辑（手改 roles 与生成器结果不一致）⇒ 判据③必须红
  //    ⚠️ 基准由生成器自产（上面）⇒ 基准必须先绿，否则"红"的原因不明。
  runCase('基准③（未手改 ⇒ 必须绿）', 'green', () => checkSingleDirection(R, T, join(T, 'TALENTS.yml')).problems)
  runCase('roles 被手改（与重生成不一致）', 'red', () => {
    const b = checkSingleDirection(R, T, join(T, 'TALENTS.yml')).problems
    if (b.length > 0) return [`基准本来就不绿 ⇒ 本用例无法判定（先修基准）：${b[0]}`]
    const f = join(R, 'a.json')
    const orig = readFileSync(f, 'utf8')
    writeFileSync(f, JSON.stringify({ ...goodJson, level: 'ceo' }, null, 2) + '\n', 'utf8')
    const p = checkSingleDirection(R, T, join(T, 'TALENTS.yml')).problems
    writeFileSync(f, orig, 'utf8')   // 还原
    return p
  })

  rmSync(base, { recursive: true, force: true })
  const bad = cases.filter((c) => !c.ok)
  return { ok: bad.length === 0, cases }
}

function main() {
  const asJson = process.argv.includes('--json')
  const selfTestMode = process.argv.includes('--self-test')

  // ★ `--self-test`：**先自证判据能红**（造违规 ⇒ 必须红），再跑真实判定。
  //   顺序很重要：判据本身没被证明能红时，后面的"PASS"没有意义。
  if (selfTestMode) {
    const st = selfTest()
    if (asJson) {
      process.stdout.write(JSON.stringify({ selfTest: st }, null, 2) + '\n')
    } else {
      process.stdout.write('阳性对照（造已知违规 ⇒ 要求判据报红）\n\n')
      for (const c of st.cases) {
        process.stdout.write(`  ${c.ok ? 'OK  ' : 'XX  '} ${c.name}\n`)
        process.stdout.write(`         期望=${c.expect} 实际=${c.got}${c.why ? '  ← ' + c.why.slice(0, 110) : ''}\n`)
      }
      process.stdout.write(`\n阳性对照判定：${st.ok ? 'PASS（判据确实能红）' : 'FAIL（判据没能按预期红 ⇒ 它自身有缺陷）'}\n`)
    }
    process.exit(st.ok ? 0 : 1)
  }

  // ① ②
  const c12 = checkFieldsConsistent(ROLES_DIR, TALENTS_DIR)
  if (c12.ok) add('PASS', '①②', `roles/*.json 与 talents/*.md 的 frontmatter 逐字一致（${c12.pairs} 个字段对）`, `${c12.names?.length ?? 0} 个角色`)
  else for (const p of c12.problems) add('FAIL', '①②', p, '')

  // ③
  const c3 = checkSingleDirection(ROLES_DIR, TALENTS_DIR, TALENTS_YML)
  if (c3.ok) add('PASS', '③', '生成关系单向：roles/ 与"重跑生成器"的结果逐字节一致（没人反向编辑）', '')
  else if (c3.unverified) add('UNVERIFIED', '③', `生成器自身报违约 ⇒ 谈"单向"没意义：${c3.problems.slice(0, 3).join(' | ')}`, '')
  else for (const p of c3.problems) add('FAIL', '③', p, '')

  // ④
  const c4 = checkNoInlineRoleData(PRESETS_DIR, ROLES_DIR)
  if (c4.ok) add('PASS', '④', `预设里没有内联岗位数据（扫了 ${c4.scanned} 个 composition）`, '')
  else if (c4.unverified) add('UNVERIFIED', '④', c4.problems.join(' | '), '')
  else for (const p of c4.problems) add('FAIL', '④', p, '')

  const fails = rows.filter((r) => r.state === 'FAIL').length
  const unver = rows.filter((r) => r.state === 'UNVERIFIED').length
  const code = fails > 0 ? 1 : unver > 0 ? 2 : 0

  if (asJson) {
    process.stdout.write(JSON.stringify({ verdict: fails > 0 ? 'FAIL' : unver > 0 ? 'UNVERIFIED' : 'PASS', rows, code }, null, 2) + '\n')
  } else {
    process.stdout.write('三件套不许重叠 · 四条机械判据\n')
    process.stdout.write('（① roles↔talents 逐字一致 ② json 不许自创字段 ③ 单向生成 ④ 预设不内联岗位数据）\n\n')
    for (const r of rows) {
      const mark = r.state === 'PASS' ? 'OK  ' : r.state === 'FAIL' ? 'XX  ' : '??  '
      process.stdout.write(`  ${mark} [${r.rule}] ${r.what}\n`)
      if (r.detail !== '') process.stdout.write(`         ${r.detail}\n`)
    }
    const pass = rows.filter((r) => r.state === 'PASS').length
    process.stdout.write(`\n判定：${fails > 0 ? 'FAIL' : unver > 0 ? 'UNVERIFIED' : 'PASS'}（${pass} 通过 / ${fails} 失败 / ${unver} 未验证）\n`)
  }
  process.exit(code)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
