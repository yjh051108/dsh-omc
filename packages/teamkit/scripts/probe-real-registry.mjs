#!/usr/bin/env node
/**
 * probe-real-registry.mjs —— **用真的 `dsh-skill` 注册表**跑一遍 overlay 语义，
 * 而不是自造一个合并器（`--selftest` 的 D 组是自造的，这条是它的**升级读数**）。
 *
 * ## 为什么值得单独一个探针
 * `--selftest` D 组模拟的是 `dsh-skill:298-311 collectFresh`，**模拟就可能模拟错**。
 * 这个探针**在独立进程里** `import()` 真包、`new Context()`、`new SkillRegistry(ctx)`，
 * 注册两个 provider（一个冒充 filesystem 上游、一个是我们自己的 fork provider），
 * 然后调**真的** `list()` / `get()` 看谁赢、以及"上游改了、fork 没改的条跟不跟"。
 *
 * ## 边界（很重要，写死在代码里）
 *  · **完全独立进程**：不连不碰正在跑的 `dsh web`，不注入、不改 profile、不动 `$DSH_HOME`；
 *  · **只读**：唯一写入是它自己的临时沙盒（`os.tmpdir()`），跑完删；
 *  · **找不到包就报 UNVERIFIED**，**不猜、不模拟**（"读不到 ≠ 不成立"，LANDMINES §6）；
 *  · 退出码：**0 = 真读数拿到了且语义成立 / 1 = 拿到了但语义不成立 / 2 = 拿不到（未验证）**。
 *
 * ## 怎么找包
 * `$DSH_PACKAGES` 显式给 → 否则按候选列表探测（照 LANDMINES §4：**候选列表，不要单一算法**）：
 *  1. `<dsh 安装>/node_modules`（npm 全局装的布局）
 *  2. `$DSH_CHECKOUT/node_modules`
 *  3. 常见 checkout 路径
 * 判据是**目录里真有 `dsh-skill/lib/index.js`**，不是"路径看着像"。
 *
 * 用法：
 *   node scripts/probe-real-registry.mjs            # 跑
 *   node scripts/probe-real-registry.mjs --help     # 本页（不写盘）
 *   node scripts/probe-real-registry.mjs --json     # 机器可读
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')

const argv = process.argv.slice(2)
const val = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const OUT = val('--out')
if (argv.includes('--help') || argv.includes('-h')) {
  // ⚠️ 注意：帮助文本里**不要出现反引号**（它会在模板字符串里提前闭合 —— 我第一版就栽在这，
  //    报的是 `SyntaxError: missing ) after argument list`，看起来像别处的括号问题）。
  const lines = [
    'probe-real-registry —— 用真的 dsh-skill 注册表验证 fork overlay 语义（独立进程，只读）',
    '',
    '  $DSH_PACKAGES=<含 @deepseek-ai/* 的 node_modules 目录>   显式指定',
    '  --json          机器可读输出（stdout）',
    '  --out <file>    把 JSON 结果写进文件（给父进程读 —— 避免用管道捕获子进程输出：',
    '                  沙箱下 child_process 的 piped stdio 会 EPERM，LANDMINES §6）',
    '  --keep          保留临时沙盒',
    '',
    '退出码：0=实测成立 / 1=实测不成立 / 2=拿不到读数（未验证）',
    '',
  ]
  process.stdout.write(lines.join('\n'))
  process.exit(0)
}

/** 候选列表探测（**不要单一算法** —— LANDMINES §4 的 homedir 教训）。 */
function findPackages() {
  const tried = []
  const cands = []
  if (process.env.DSH_PACKAGES) cands.push(process.env.DSH_PACKAGES)
  if (process.env.DSH_CHECKOUT) cands.push(join(process.env.DSH_CHECKOUT, 'node_modules'))
  const npmRoot = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : undefined
  if (npmRoot) {
    cands.push(join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    cands.push(join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  // ⚠️ **2026-09-15 脱敏**：原来这里**硬编码了两条本机绝对路径**（含用户名）——
  //   而那既**泄露本机用户名**，又**在别的机器上永远命中不了**（等于死代码）。
  //   ⇒ 改成**从环境推**（`APPDATA` / `DSH_HOME`），**任何机器都对**，且不含任何用户名。
  if (process.env.DSH_HOME) {
    cands.push(join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai'))
  }
  if (process.env.APPDATA) {
    cands.push(join(process.env.APPDATA, 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  // ★ 兜底：从**本脚本自身位置**往上找（仓内/包内两种布局都对）
  cands.push(join(PLUGIN_DIR, '..', 'node_modules', '@deepseek-ai'))
  cands.push(join(PLUGIN_DIR, 'node_modules', '@deepseek-ai'))
  for (const c of cands) {
    if (c === undefined || c === '') continue
    const base = resolve(c)
    tried.push(base)
    // 两种布局：base 自己就是 @deepseek-ai/ 的父，或 base 就是 @deepseek-ai/
    for (const dir of [base, join(base, '@deepseek-ai')]) {
      if (existsSync(join(dir, 'dsh-skill', 'lib', 'index.js')) || existsSync(join(dir, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js'))) {
        const normalized = existsSync(join(dir, 'dsh-skill', 'lib', 'index.js')) ? dir : join(dir, '@deepseek-ai')
        return { dir: normalized, tried }
      }
    }
  }
  return { dir: null, tried }
}

const found = findPackages()
if (found.dir === null) {
  process.stdout.write('判定：UNVERIFIED —— **找不到真的 dsh 包**（读不到 ≠ 不成立）\n')
  process.stdout.write('  试过的路径：\n' + found.tried.map((t) => `    ${t}`).join('\n') + '\n')
  process.stdout.write('  要拿到读数：设 $DSH_PACKAGES 指向含 @deepseek-ai/dsh-skill 的那个 node_modules。\n')
  process.exit(2)
}

const url = (rel) => pathToFileURL(join(found.dir, rel)).href

// ── 加载真包 ─────────────────────────────────────────────────────────────
let cordis
let dshSkill
try {
  cordis = await import(url('cordis/lib/index.js'))
  dshSkill = await import(url('dsh-skill/lib/index.js'))
} catch (err) {
  process.stdout.write(`判定：UNVERIFIED —— 找到了包目录但 **import 失败**：${err?.message}\n`)
  process.stdout.write(`  目录 ${found.dir}\n`)
  process.exit(2)
}

const results = []
const ok = (msg, readout) => {
  results.push({ state: 'PASS', msg, readout })
  process.stdout.write(`  OK  ${msg}${readout ? `  — ${readout}` : ''}\n`)
}
const bad = (msg, readout) => {
  results.push({ state: 'FAIL', msg, readout })
  process.stdout.write(`  XX  ${msg}${readout ? `  — ${readout}` : ''}\n`)
}
const unv = (msg, readout) => {
  results.push({ state: 'UNVERIFIED', msg, readout })
  process.stdout.write(`  ??  ${msg}${readout ? `  — ${readout}` : ''}\n`)
}

process.stdout.write(`真包目录 ${found.dir}\n`)
process.stdout.write(`dsh-skill 导出的名字：${Object.keys(dshSkill).join(', ')}\n\n`)

// ── 搭沙盒 ───────────────────────────────────────────────────────────────
const base = join(tmpdir(), `teamkit-real-probe-${Date.now()}`)
const upstreamDir = join(base, 'upstream-skills')
const forkDir = join(base, 'fork-skills')
mkdirSync(upstreamDir, { recursive: true })
mkdirSync(forkDir, { recursive: true })
const writeSkill = (dir, name, body) => {
  mkdirSync(join(dir, name), { recursive: true })
  // ⚠️ 无 BOM（LANDMINES §19）
  writeFileSync(join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: probe ${name}\n---\n\n${body}\n`, 'utf8')
}
writeSkill(upstreamDir, 'probe-keep', 'UP-KEEP-v1')
writeSkill(upstreamDir, 'probe-overridden', 'UP-OVERRIDDEN-v1')
writeSkill(forkDir, 'probe-overridden', 'FORK-OVERRIDDEN-v1')   // ← fork 只存差异

const providerOf = (dir, { name, source, rank }) => ({
  name,
  async list() {
    const { readdirSync } = await import('node:fs')
    const out = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const file = join(dir, e.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
      const desc = m === null ? '(none)' : (/^description:\s*(.*)$/m.exec(m[1]) ?? [, '(none)'])[1]
      out.push({
        name: e.name,
        description: desc,
        invocation: { modelInvocable: true, userInvocable: true },
        source,
        provider: name,
        rank,
        locator: file,
        path: file,
      })
    }
    return out
  },
  async get(candidate) {
    const text = readFileSync(candidate.locator, 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source,
      provider: name,
      content: m === null ? text : m[2],
      path: candidate.locator,
    }
  },
})

// ── 造真 registry ────────────────────────────────────────────────────────
let registry
try {
  const ctx = new cordis.Context()
  const Ctor = dshSkill.SkillRegistry
  registry = new Ctor(ctx, {})
  ok('`new cordis.Context()` + `new SkillRegistry(ctx)` 成功', `class=${Ctor.name}`)
} catch (err) {
  unv('无法在进程外构造真 `SkillRegistry`（可能需要完整宿主注入）', err?.message)
  rmSync(base, { recursive: true, force: true })
  process.stdout.write('\n判定：UNVERIFIED —— 真 registry 构造不起来（**不是"语义不成立"**）\n')
  process.exit(2)
}

// 注册上游（先）与 fork（后）—— **两个都注册在同一个 ctx 上**，
// 但 fork 用的是 `agent.ctx`（agent scope）；这里是简化：用 global 层验证 **rank 与同名覆盖**，
// 以及 `collectFresh` 的逐层合并。scope 链那一层的真读数在 --selftest G 组（假 ctx）+ 本探针的
// "provider 级"读数互补 —— 见输出末尾的边界说明。
const { makeForkProvider } = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'fork.js')).href)

const upProv = providerOf(upstreamDir, { name: 'probe-fs', source: 'user-dsh', rank: 400 })
const forkProv = makeForkProvider({ name: 'teamkit-fork', forkDir, rank: 250, skillFileName: 'SKILL.md' })

let disposers = []
try {
  disposers.push(registry.registerProvider(() => upProv))
  disposers.push(registry.registerProvider(() => forkProv))
  ok('两个 provider 都注册进真 registry（上游 rank 400 / fork rank 250）')
} catch (err) {
  bad('registerProvider 抛错', err?.message)
  rmSync(base, { recursive: true, force: true })
  process.stdout.write('\n判定：FAIL\n')
  process.exit(1)
}

// `list()` / `get()` 的 scope 参数：不传 scope = 只读 global 层
const list = await registry.list({})
const names = list.map((s) => s.name).sort()
const gotKeep = await registry.get('probe-keep', {})
const gotOver = await registry.get('probe-overridden', {})

ok('真 `registry.list()` 可用', `返回 ${list.length} 条：${names.join(', ')}`)
if (gotKeep !== undefined) ok('真 `registry.get()` 可用', `probe-keep 正文 = ${String(gotKeep.content).trim()}`)
else unv('`registry.get()` 返回 undefined（该条没被解析出来）')

// ★ 判据 1：fork 里有的条 ⇒ fork 版本赢（**在同一个 layer 内比 rank**：fork rank 250 < 上游 400）
const overWon = gotOver !== undefined && String(gotOver.content).includes('FORK-OVERRIDDEN-v1')
if (overWon) ok('★ fork 覆盖有效：同名条取到的是 **fork 的正文**（rank 250 赢过 400）',
  `provider=${gotOver.provider} rank=${gotOver.rank} body=${String(gotOver.content).trim()}`)
else bad('fork 覆盖无效 —— 同名条没有取到 fork 的正文',
  `provider=${gotOver?.provider} body=${String(gotOver?.content ?? '').trim()}`)

// ★ 判据 2：fork 里**没有**的条 ⇒ 仍由上游提供（overlay 的"只存差异"）
const keepFromUpstream = gotKeep !== undefined && gotKeep.provider === 'probe-fs'
if (keepFromUpstream) ok('★ fork 里没有的条**仍来自上游**（overlay：fork 只存差异）',
  `provider=${gotKeep.provider} body=${String(gotKeep.content).trim()}`)
else bad('fork 里没有的条没有落到上游 provider', `provider=${gotKeep?.provider}`)

// ★ 判据 3（胜负手）：改上游 ⇒ **fork 里没改的条跟着变**；fork 改过的条不变
writeSkill(upstreamDir, 'probe-keep', 'UP-KEEP-v2')
writeSkill(upstreamDir, 'probe-overridden', 'UP-OVERRIDDEN-v2')
// provider 每次 list/get 都现扫盘（我们的实现就是这样；真文件系统 provider 也如此）⇒ 无需失效通知
const gotKeep2 = await registry.get('probe-keep', {})
const gotOver2 = await registry.get('probe-overridden', {})
const keepFollowed = gotKeep2 !== undefined && String(gotKeep2.content).includes('UP-KEEP-v2')
const overHeld = gotOver2 !== undefined && String(gotOver2.content).includes('FORK-OVERRIDDEN-v1')
if (keepFollowed) ok('★★ 【胜负手】上游改了 ⇒ **fork 里没改的条跟着变**（真 registry 读数，不是模拟）',
  `probe-keep = ${String(gotKeep2.content).trim()}`)
else bad('★★ 胜负手不成立：上游改了但 fork 里没改的条没跟着变',
  `probe-keep = ${String(gotKeep2?.content ?? '').trim()}`)
if (overHeld) ok('★ 上游改了 ⇒ fork 里**改过的**条不受影响（fork 的独立性）',
  `probe-overridden = ${String(gotOver2.content).trim()}`)
else bad('fork 的覆盖被上游冲掉了', `probe-overridden = ${String(gotOver2?.content ?? '').trim()}`)

// 清场
for (const d of disposers) {
  try {
    d()
  } catch {
    /* ignore */
  }
}
disposers = []
try {
  rmSync(base, { recursive: true, force: true })
} catch {
  /* ignore */
}

const fails = results.filter((r) => r.state === 'FAIL').length
const unvs = results.filter((r) => r.state === 'UNVERIFIED').length
const verdict = fails > 0 ? 'FAIL' : unvs > 0 ? 'UNVERIFIED' : 'PASS'
process.stdout.write(`\n判定：${verdict}（${results.filter((r) => r.state === 'PASS').length} 通过 / ${fails} 失败 / ${unvs} 未验证）\n`)
process.stdout.write('\n**本探针的边界（诚实标注）**\n')
process.stdout.write('  · 真包、真 `SkillRegistry`、真 `list()/get()` —— 这三样是**真读数**；\n')
process.stdout.write('  · 但两个 provider 都注册在 **global 层**（同一个 scope）⇒ 这里验的是\n')
process.stdout.write('    "同名覆盖 + rank" 与 "provider 现扫磁盘 ⇒ 无需失效通知"；\n')
process.stdout.write('  · **agent-scope 的就近覆盖（nearest layer wins outright）** 这一层需要真 agent scope，\n')
process.stdout.write('    本探针不构造它（`dsh-scope` 的 scope 链要宿主注入）⇒ 那半条仍是\n')
process.stdout.write('    `--selftest` G 组的假 ctx 读数 + task-44 的既有实测，**不是本探针的读数**。\n')
if (argv.includes('--json') || OUT !== undefined) {
  const json = JSON.stringify({ verdict, packagesDir: found.dir, results }, null, 2) + '\n'
  if (OUT !== undefined) writeFileSync(OUT, json, 'utf8')
  else process.stdout.write(json)
}
process.exit(fails > 0 ? 1 : unvs > 0 ? 2 : 0)
