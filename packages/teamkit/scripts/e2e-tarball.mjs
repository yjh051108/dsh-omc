#!/usr/bin/env node
/**
 * e2e-tarball.mjs —— **真 tgz 端到端**：打包 → npm install → 跑安装器 → 核对落点。
 *
 * ## 为什么必须有这一层（**2026-09-14 的教训**）
 * 我此前测过"仓内布局沙盒装"与"包内布局沙盒装"，**都绿**。
 * 但**从没测过"真 tgz → `npm install` → 跑安装器"** —— 而**只有这条链暴露了两个真 bug**：
 *   ① `cpSync` 缺 `recursive` ⇒ 预设里的子目录（`raw/`）让**安装器直接崩**，
 *      且是**半装状态**（skills/talents/roles 装了、上游根没装）；
 *   ② `pickSrc` 的候选用"目录存在"判，而**包根本身永远存在** ⇒ 组织层**静默没装**（`orgFiles = []`）。
 * ⇒ **"沙盒源 = 仓内" 与 "包内副本" 是两条不同的路**，**必须真的走一遍 tgz**。
 *
 * ## 它做什么（全在临时目录，不碰真 DSH_HOME）
 *   1. `npm pack`（在插件目录）
 *   2. 在临时目录 `npm install <tgz>`（模拟开源用户）
 *   3. `DSH_HOME=<临时>` 跑**装出来的包**里的 `tools/install-teamkit.mjs`
 *   4. 核对 **6 个落点**是否齐、且**文件数 > 0**
 *   5. 核对装出来的**预设是可移植的**（无写死开发机路径；`!!js` 表达式数 ≥ 4）
 *
 * 用法：
 *   node scripts/e2e-tarball.mjs             # 跑（PASS ⇒ 退出码 0）
 *   node scripts/e2e-tarball.mjs --keep      # 保留临时目录供检查
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const keep = process.argv.includes('--keep')
// npm 在 Windows 上要 `.cmd`，且 `execFileSync` **不能直接 exec 一个 `.cmd`**（EINVAL）
// ⇒ Windows 上走 `shell: true`（把命令交给 cmd.exe）。这是"真环境才暴露"的一条（实测踩到）。
//
// ★★ **2026-09-15 修正：npm 要与 `node` 同源**（COO 实测 + 我复核）
// ```
// 现场：本机 `node` 是 **portable 布局**（`…\node-portable\node-v22.20.0-win-x64\node.exe`），
//   而 `npm.cmd` **就在同目录**（实测：`npm` 2073B / `npm.cmd` 538B / `npm.ps1`）
//   但**两者都不在 PATH** ⇒ 只找 PATH 会**长期假 UNVERIFIED**（而这是"开源就绪"的核心判据）。
// ⇒ 优先用 `process.execPath` 旁边的那个；找不到再回落 PATH。
// ```
const npmBeside = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
const npmCmd = existsSync(npmBeside) ? npmBeside : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32', ...opts })

const rows = []
const check = (ok, msg, readout = '') => { rows.push({ ok, msg, readout }); if (!ok) process.exitCode = 1 }

const base = join(tmpdir(), `teamkit-e2e-${Date.now()}`)
try {
  mkdirSync(base, { recursive: true })
  // ── 1. 打包 ─────────────────────────────────────────────────────────────
  const packOut = run(npmCmd, ['pack', '--pack-destination', base], { cwd: PLUGIN_DIR })
  const tgz = join(base, (packOut.trim().split(/\r?\n/).pop() ?? '').trim())
  check(existsSync(tgz), '`npm pack` 产出了 tgz', tgz.replace(base, '<tmp>'))
  // ── 2. 装（模拟开源用户）────────────────────────────────────────────────
  const consumer = join(base, 'consumer')
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'c', private: true }), 'utf8')
  run(npmCmd, ['install', tgz, '--ignore-scripts'], { cwd: consumer })
  const pkgDir = join(consumer, 'node_modules', '@dsh-external', 'dsh-teamkit')
  check(existsSync(pkgDir), '`npm install <tgz>` 装出了包', pkgDir.replace(base, '<tmp>'))
  // ── 3. 从**装出来的包**跑安装器 ──────────────────────────────────────────
  const fakeHome = join(base, 'fake-home')
  const installer = join(pkgDir, 'tools', 'install-teamkit.mjs')
  check(existsSync(installer), '包里有安装器（tools/install-teamkit.mjs）')
  let instOut = ''
  try {
    instOut = run(process.execPath, [installer], { env: { ...process.env, DSH_HOME: fakeHome } })
    check(true, '安装器**跑完不崩**（exit=0）')
  } catch (err) {
    check(false, '安装器**跑完不崩**（exit=0）', `exit=${err.status ?? '?'} ${String(err.stderr ?? err.message).slice(0, 160)}`)
  }
  // ── 4. 六个落点齐 + 非空 ────────────────────────────────────────────────
  const want = [
    // ★★★ **2026-09-19 改**（`B178` · 委托方亲手报的"skill 散到别的预设"）
    // ```
    // 【原来这条是】`['方法技能', join(fakeHome, 'skills'), 7]` —— 断言装到**公共技能根** ❌
    // 【为什么改】公共根被 DSH 本体的默认根清单扫到（`dsh-skill-filesystem/lib/index.js:171-172`，
    //   `includeDefaultRoots` 默认 `true`）⇒ **任何预设都读得到**
    //   ⇒ 别的预设的 agent 读了"组队/招人"那 7 条 ⇒ **有"开子代理的冲动"**（委托方原话）
    // 【新判据】**公共技能根那一条【删掉】**（**它原来恰好在断言"泄漏发生了"** ❌）·
    //   改为**只断言专属落点**，并在下面加一条**反向断言**（公共根里不许有 `teamkit*`）✅
    // ```
    ['上游根（技能的【唯一】落点）', join(fakeHome, 'teamkit', 'skills-upstream'), 7],
    ['talents', join(fakeHome, 'teamkit', 'talents'), 7],
    ['原则（自演化位）', join(fakeHome, 'teamkit', 'talents', 'principles'), 2],
    ['角色档', join(fakeHome, 'teamkit', 'roles'), 8],
    ['预设 omc', join(fakeHome, '.agent-presets', 'omc'), 3],
  ]
  for (const [name, p, min] of want) {
    let n = 0
    try { n = readdirSync(p).length } catch { n = 0 }
    check(n >= min, `${name} 落到 ${p.includes('fake-home') ? '<fake-home>/' + p.split('fake-home')[1].replace(/\\/g, '/') : p}（≥${min} 项）`, `n=${n}`)
  }
  // ★★★ **反向断言：公共技能根里【不许】有那 7 条**（`B178` 的核心 —— **"隔离"的判据**）
  // ```
  // ⚠️ **不是"公共根为空"**（用户自己的 skill 可能在那儿）—— 而是 **"我们的那 7 条不许在那儿"**
  //   ⇒ 这就是**用户会看到的那个症状**（别的预设下也有 teamkit）的机械形态 ✅
  // ```
  {
    const pub = join(fakeHome, 'skills')
    let leaked = []
    try {
      leaked = readdirSync(pub).filter((d) => d === 'teamkit' || d.startsWith('teamkit-'))
    } catch {
      leaked = [] // 目录不存在 ⇒ 没泄漏 ✅
    }
    check(
      leaked.length === 0,
      '★ **公共技能根里没有 teamkit\\*（隔离成立）**',
      `★ 泄漏了 ${leaked.length} 条：${leaked.join(' ')} ⇒ **别的预设会读到它们**（B178）`,
    )
  }
  // 组织层（此前静默没装的那一项）
  for (const f of ['TALENTS.yml', 'RULES.yml']) {
    check(existsSync(join(fakeHome, 'teamkit', f)), `组织层 ${f} 装上了`, existsSync(join(fakeHome, 'teamkit', f)) ? 'ok' : '缺')
  }
  // ── 4b. ★★★ **公司建造指南**：四道门全过（2026-09-15 / `task-117`）────────────
  // 【为什么单独一条】`assets/org/COMPANY-GUIDE.md` 是**从零建公司**的入口 ——
  //   ★ 而它**极易"写对了却送不到"**，且**四道门各自会静默失败**：
  //   ```
  //   ① `files` 白名单 —— "放同目录" **不会**自动带上（CEO 最小实测：`files:['README.md']` +
  //      同目录 `COMPANY-GUIDE.md` ⇒ **不进 tgz**，且**不报错、不警告**）
  //   ② `sync-assets` 会**删多余**（`sync-assets.mjs:133` `rmSync(extra)`）——
  //      若 `assets/org/` 被当 `dir` 管 ⇒ 指南在下次同步时**被静默删掉**
  //   ③ `npm pack` 出来之后，**装**这一步还要点名它 ——
  //      原 `ORG_SRC = ['TALENTS.yml','RULES.yml']` **写死两项** ⇒ **新增文件装不到用户机器**
  //      （我实测：探针放 `assets/org/` ⇒ 隔离装完 `<fakeHome>/teamkit/` 里**没有它**）
  //   ④ 装了还要**在真机找得到**（落点）
  //   ⇒ ★ 所以本组**四条一起判**，且**每条都能红**（见 `e2e-guide-mutation.mjs`）。
  // ```
  const GUIDE = 'COMPANY-GUIDE.md'
  const GUIDE_IN_PKG = join(pkgDir, 'assets', 'org', GUIDE)
  const GUIDE_IN_HOME = join(fakeHome, 'teamkit', GUIDE)
  // ① 进得了包（白名单 + 真 pack 后的包内容 —— 不是"看白名单应该会带"）
  check(existsSync(GUIDE_IN_PKG), `① 公司建造指南**进得了 tgz**（\`assets/org/${GUIDE}\`）`, existsSync(GUIDE_IN_PKG) ? 'ok' : '**缺** ⇒ 检查 package.json 的 files 是否含 assets')
  // ② 装得到真机（`ORG_SRC` 要扫目录，不能写死名单）
  check(existsSync(GUIDE_IN_HOME), `② 指南**装到了 \`$DSH_HOME/teamkit/\`**（装机落点）`, existsSync(GUIDE_IN_HOME) ? 'ok' : '**缺** ⇒ `ORG_SRC` 可能又写死了文件名')
  // ③ sha 与包内一致（防"装了个旧的/截断的"）
  {
    const a = existsSync(GUIDE_IN_PKG) ? createHash('sha256').update(readFileSync(GUIDE_IN_PKG)).digest('hex').slice(0, 16) : '(包内缺)'
    const b = existsSync(GUIDE_IN_HOME) ? createHash('sha256').update(readFileSync(GUIDE_IN_HOME)).digest('hex').slice(0, 16) : '(落点缺)'
    check(a !== '(包内缺)' && a === b, '③ 落点的教程 **sha 与包内一致**（没收错/没截断）', `包内=${a} 落点=${b}`)
  }
  // ④ 非空且有实质内容（防"占位空文件"混过前三门）
  {
    const n = existsSync(GUIDE_IN_HOME) ? readFileSync(GUIDE_IN_HOME, 'utf8').length : 0
    check(n > 2000, `④ 指南**非空且有实质内容**（>2000 字符）`, `${n} 字符`)
  }
  // ⑤ ★★ **`--check` 也必须核它**（2026-09-15 修的第二个真缺口）
  // ```
  // 【现场】原 `--check` **只在输出里列了组织层的文件名**，**从不比对内容** ⇒
  //   我篡改落点的 `COMPANY-GUIDE.md` ⇒ `--check` **仍然 exit=0** ⇒
  //   ★ **"列了名字" ≠ "核了内容"**（`R5` 家族：看着像核过了）。
  //   ⚠️ 而 `--check` 的定位就是「**不安装也能发现问题**」⇒ 漏核组织层 = 它的一半职责失效。
  // 【本条判据】篡改落点 ⇒ `--check` **必须退出码 1**（不是 0）
  //   ⇒ ★ 且**必须指名那个文件**（否则用户不知道哪份不一致）
  // ```
  if (existsSync(GUIDE_IN_HOME)) {
    const orig = readFileSync(GUIDE_IN_HOME, 'utf8')
    try {
      writeFileSync(GUIDE_IN_HOME, '# 故意篡改（e2e 检查 --check 能不能发现）\n', 'utf8')
      let out5 = ''
      let code5 = 0
      try {
        out5 = run(process.execPath, [installer, '--check'], { env: { ...process.env, DSH_HOME: fakeHome } })
        code5 = 0
      } catch (e) {
        out5 = String(e.stdout ?? '') + String(e.stderr ?? '')
        code5 = e.status ?? -1
      }
      check(code5 !== 0, '⑤ 篡改落点后 `--check` **不再报 0**（它真的核内容）', `exit=${code5}`)
      check(new RegExp(GUIDE).test(out5), '⑤ `--check` **指名了**哪份不一致', new RegExp(GUIDE).test(out5) ? 'ok' : '没指名')
    } finally {
      writeFileSync(GUIDE_IN_HOME, orig, 'utf8') // ★ 还原（后续断言仍要用它的正确内容）
    }
  }
  // ── 5. 装出来的预设是**可移植**的 ───────────────────────────────────────
  const preset = join(fakeHome, '.agent-presets', 'omc', 'agent.cordis.yml')
  const src = existsSync(preset) ? readFileSync(preset, 'utf8') : ''
  const hard = (src.match(/^\s*[a-z]+:\s*'[A-Za-z]:\//gm) ?? []).length
  // ⚠️ 正则要容忍 `!!js` 后面的 `(`：实际写法是 `!!js (process.env.DSH_HOME …) + '…'`。
  //    我第一版写 `!!js\s+process\.env` ⇒ **匹配 0**，误报成"预设不可移植"（实测踩到）。
  const jsExpr = (src.match(/!!js\s*\(?\s*process\.env/g) ?? []).length
  check(hard === 0, '装出来的预设里**没有写死的盘符路径**', `命中 ${hard}`)
  check(jsExpr >= 4, '装出来的预设用 `!!js` 表达式读 `$DSH_HOME`（≥4 处）', `命中 ${jsExpr}`)
  // 组织层不该是空的（那正是 bug ② 的形态）
  const orgLine = (instOut.split(/\r?\n/).find((l) => l.includes('组织层：')) ?? '').trim()
  check(/TALENTS\.yml/.test(orgLine) && /RULES\.yml/.test(orgLine), '安装器自报"组织层：TALENTS.yml RULES.yml"', orgLine || '(没这行)')

  // ── 6. ★★ **装出来的资产"能用"吗**（2026-09-14 / Round 38）────────────────────
  // 【缺口】上面 4 节全是 **count 文件**（`readdirSync(p).length`）——
  //   那只能证明"文件到了"，**证明不了"它能用"**。
  //   真实失效形态（本项目 Round 9 实测过）：`provider 注册成功、`list()` 返回空` ⇒
  //   **"招了人，但他没有自己的技能"** —— 那时文件数照样是 7/8/2，**断言全绿**。
  // 【判据】用**真代码路径**（不是数文件）验证装出来的资产：
  //   ① **角色档能被真 `loadRoles` 读出来**（`n=7` 且每条都有 `skills` 字段）；
  //   ② **角色技能真的落进包**（每个角色的 `skills/` 下至少 1 个 `SKILL.md`）——
  //      这是"有身份没技能"那条的直接判据；
  //   ③ **原则目录能被真 `loadPrinciples` 读出来**（`engineer` 那份非空）。
  {
    const { loadRoles, loadPrinciples } = await import(pathToFileURL(join(pkgDir, 'lib', 'roles.js')).href)
    const rolesDir = join(fakeHome, 'teamkit', 'roles')
    // ⚠️ `loadRoles` 返回 **`{roles: Map, skipped, dir, readable}`**，不是数组 ——
    //    我第一版按数组写 ⇒ `list.filter is not a function`（当场崩，好在 e2e 直接抛出来）。
    let res = null
    let roleErr = null
    try {
      res = loadRoles(rolesDir)
    } catch (err) {
      roleErr = String(err?.message ?? err)
    }
    const rmap = res?.roles instanceof Map ? res.roles : new Map()
    const list = [...rmap.values()]
    check(
      roleErr === null && res?.readable === true && list.length >= 7,
      '★★ 装出来的角色档**能被真 `loadRoles` 读出来**（不是"数够 8 个文件"就算）',
      roleErr ? `抛错: ${roleErr.slice(0, 80)}` : `n=${list.length} skipped=${res?.skipped?.length ?? '?'}`,
    )
    // 跳过数为 0（有 skipped 就说明"文件在、但读不了"）
    check(
      (res?.skipped?.length ?? 1) === 0,
      '★ `loadRoles` **一条都没跳过**（skipped=0 ⇒ 没有"文件在但读不了"的）',
      `skipped=${JSON.stringify((res?.skipped ?? []).slice(0, 3))}`,
    )
    // 每个角色都要有 skills 字段（"有身份没技能"的直接判据）
    const noSkillField = list.filter((r) => !Array.isArray(r?.skills)).map((r) => r?.name ?? '?')
    check(noSkillField.length === 0, '★ 每个读到的角色档都带 `skills` 字段（不是"空身份"）', noSkillField.length ? `缺: ${noSkillField.join(',')}` : `n=${list.length}`)
    // ★★★ **职责层（`duties`/`boundaries`）真的走到用户那一步了吗**（2026-09-15 / CEO 抓的"第二段洞"）
    // ```
    // 【为什么补这条】CEO 实测：真机 roles 有 duties、`H53` 四条绿、`personaFor()` 读 ——
    //   而 **`e2e-tarball` 里提及 `duties`/`boundaries`/`personaFor` = **0 处**
    //   ⇒ ★ **"交付形态的端到端"没有验职责** —— 而**它才是开源用户实际走的那条路**。
    //   ⇒ 与上轮那个洞**同一形状**：**"仓内对"与"用户拿到"之间有一段路**，
    //     上轮断在"装 → 真机读取"，这段断在"**打包 → 端到端验证**"。
    // 【判据】**能力（3 条，都能红）**：
    //   ① 每个角色档都带**非空** `duties` 与 `boundaries`（**逐个查**，不查总数 —— 见上面那条的教训）
    //   ② 每条都带**理由指针**（`依据：`）⇒ "不是口号"（`H53` 同口径）
    //   ③ ★ **`personaFor()` 拼出的文本里真出现职责与边界**（这才是"成员看得到"）
    // ```
    const noDuties = list.filter((r) => !Array.isArray(r?.duties) || r.duties.length === 0).map((r) => r?.name ?? '?')
    const noBounds = list.filter((r) => !Array.isArray(r?.boundaries) || r.boundaries.length === 0).map((r) => r?.name ?? '?')
    check(
      noDuties.length === 0 && noBounds.length === 0,
      '★★★ **装出来的每份角色档都有非空 `duties` + `boundaries`**（职责层真的进了 tgz）',
      noDuties.length || noBounds.length ? `缺 duties: ${noDuties.join(',')} | 缺 boundaries: ${noBounds.join(',')}` : `${list.length} 份齐全`,
    )
    let noPointer = []
    for (const r of list) {
      for (const s of [...(r?.duties ?? []), ...(r?.boundaries ?? [])]) {
        if (!String(s).includes('依据：')) noPointer.push(`${r?.name}: ${String(s).slice(0, 24)}`)
      }
    }
    check(
      noPointer.length === 0,
      '★★ 每条 `duties`/`boundaries` 都带**理由指针**（`依据：`）⇒ 不是口号',
      noPointer.length ? `缺指针 ${noPointer.length} 条：${noPointer.slice(0, 2).join(' | ')}` : '全部带指针',
    )
    // ★ ③ `personaFor()` 真拼出来 —— "成员第一条提示词里看得到"才叫到了终点
    let pfErr = null
    let pfText = ''
    try {
      const { personaFor } = await import(pathToFileURL(join(pkgDir, 'lib', 'roles.js')).href)
      const chief = rmap.get('chief')
      if (chief === undefined) throw new Error('loadRoles 里没有 chief')
      pfText = personaFor(chief)
    } catch (err) {
      pfErr = String(err?.message ?? err)
    }
    const chiefRole = rmap.get('chief')
    const pfHasDuty = pfErr === null && chiefRole !== undefined && pfText.includes(String(chiefRole.duties[0]).slice(0, 16))
    const pfHasBound = pfErr === null && chiefRole !== undefined && pfText.includes(String(chiefRole.boundaries[0]).slice(0, 16))
    check(
      pfErr === null && pfHasDuty && pfHasBound,
      '★★★ **`personaFor()` 拼出的文本里真出现职责与边界**（成员开箱就看得到，不是"字段存在"）',
      pfErr !== null ? `抛错: ${pfErr.slice(0, 80)}` : `duties=${pfHasDuty} boundaries=${pfHasBound} len=${pfText.length}`,
    )
    // ★★★ **编制（`reports_to`）也要走到终点**（`task-114`；与职责**同一形状**）
    // ```
    // 【判据 · 两毛，都在**装出来的 tgz**上验（开源用户实际走的那条路）】
    //   ① 装出来的角色档里**至少一份带 `reports_to`**（数据进了包）
    //   ② `personaFor(coo)` 文本里**出现「直接上级」+ 上级名**（渲染到了终点）
    //   ★（③"chief 明写未声明"那条由 `selftest` 的 `H53` 与 `verify-clean-install-e2e` 覆盖 —— 不重复造）
    // ```
    const withReports = list.filter((r) => typeof r?.reports_to === 'string' && r.reports_to !== '')
    check(withReports.length > 0, '★★★ **装出来的角色档里有 `reports_to`**（编制卡真的进了 tgz）', `${withReports.length} 份带编制`)
    let pbErr = null
    let cooText = ''
    try {
      const { personaFor } = await import(pathToFileURL(join(pkgDir, 'lib', 'roles.js')).href)
      const coo = rmap.get('coo')
      if (coo === undefined) throw new Error('loadRoles 里没有 coo')
      cooText = personaFor(coo, undefined, undefined, undefined, rmap)
    } catch (err) {
      pbErr = String(err?.message ?? err)
    }
    const cooRole = rmap.get('coo')
    const hasUpLine = pbErr === null && /直接上级/.test(cooText)
    const hasUpName = pbErr === null && cooRole !== undefined && typeof cooRole.reports_to === 'string' && cooText.includes(cooRole.reports_to)
    check(
      pbErr === null && hasUpLine && hasUpName,
      '★★★ **`personaFor(coo)` 里出现"直接上级"与上级名**（"我向谁报"到了终点，不是只在档案里）',
      pbErr !== null ? `抛错: ${pbErr.slice(0, 80)}` : `行=${hasUpLine} 名=${hasUpName}（${cooRole?.reports_to ?? '?'}）`,
    )
    // 角色技能**真落进落点**（目录里有 SKILL.md，不是空目录）
    // ⚠️ **判据不能是"总数 ≥7"** —— 我第一版就是这么写的，**变异测试当场没判死**：
    //    只删掉 `engineer` 的技能目录，其余 8 个还在 ⇒ 总数仍 ≥7 ⇒ **照样绿**。
    //    ⇒ 正确判据：**每一个角色都至少有一条技能**（逐个查，不是查总数）。
    let roleSkillFiles = 0
    const roleDirs = []
    const rolesWithoutSkills = []
    try {
      for (const e of readdirSync(rolesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        roleDirs.push(e.name)
        const sk = join(rolesDir, e.name, 'skills')
        let n = 0
        if (existsSync(sk)) {
          for (const s of readdirSync(sk)) {
            if (existsSync(join(sk, s, 'SKILL.md'))) {
              n += 1
              roleSkillFiles += 1
            }
          }
        }
        if (n === 0) rolesWithoutSkills.push(e.name)
      }
    } catch {
      /* 下面按空判 */
    }
    check(
      roleSkillFiles > 0 && rolesWithoutSkills.length === 0,
      `★ **每个角色的技能都真有 ` + '`SKILL.md`' + `**（${roleSkillFiles} 条 / ${roleDirs.length} 个角色，无一为空）`,
      `roleSkillFiles=${roleSkillFiles} 空技能的=${rolesWithoutSkills.join(',') || '(无)'}`,
    )
    // ★★ **角色数也要对**（2026-09-14 / Round 38 变异测试抓出来的松断言）：
    //   上面那条只查"存在的目录都不为空" —— **整个角色目录被删掉时它会照样绿**
    //   （实测：删掉 `engineer/skills` ⇒ 变成"6 个角色、无一为空" ⇒ **PASS**）。
    //   ⇒ 再加一条：**角色数必须与仓内角色档数一致**（缺一个就是分发漏了人）。
    const expectRoleIds = (() => {
      try {
        return readdirSync(join(pkgDir, 'assets', 'roles')).filter((f) => f.endsWith('.json') && f !== 'INDEX.json').length
      } catch {
        return -1
      }
    })()
    check(
      expectRoleIds > 0 && roleDirs.length === expectRoleIds,
      `★ **每个角色档都配了技能目录**（${roleDirs.length}/${expectRoleIds}）—— 缺一个就是"分了人但没给技能"`,
      `roleDirs=${roleDirs.length} 角色档=${expectRoleIds}`,
    )
    // 原则（自演化位）能被真代码读到
    let principles = null
    try {
      principles = loadPrinciples(join(fakeHome, 'teamkit', 'talents', 'principles'), 'engineer')
    } catch {
      principles = null
    }
    const ptxt = typeof principles === 'string' ? principles : (principles?.text ?? '')
    check(
      typeof ptxt === 'string' && ptxt.length > 0,
      '★ 装出来的 `talents/principles/engineer.md` **能被真 `loadPrinciples` 读出来**',
      `bytes=${ptxt.length}`,
    )
  }

  // ── 报告 ───────────────────────────────────────────────────────────────
  process.stdout.write('teamkit 真 tgz 端到端\n')
  for (const r of rows) process.stdout.write(`  ${r.ok ? 'OK  ' : 'XX  '}${r.msg}${r.readout ? '  — ' + r.readout : ''}\n`)
  const fail = rows.filter((r) => !r.ok).length
  process.stdout.write(`\n判定：${fail === 0 ? 'PASS' : 'FAIL'}（${rows.length - fail} 通过 / ${fail} 失败）\n`)
} finally {
  if (!keep) rmSync(base, { recursive: true, force: true })
  else process.stdout.write(`\n临时目录保留：${base}\n`)
}
