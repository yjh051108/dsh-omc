/**
 * preset-new.mjs —— `teamkit preset-new <name> [--template <t>] [--role <r>]` 的**实现体**。
 *
 * ## 为什么内核在 `lib/`、而这里只是一层薄壳
 * `lib/preset-gen.js` 是**纯函数**（不读盘除模板、不写盘）⇒ 单测可以在临时目录里跑、不碰真机；
 * 本文件只做三件"有副作用"的事：**解析参数 → 落盘 → 自证**。
 *
 * ## 与 `bin/teamkit.mjs` 的关系（task-99 分两批交付）
 * · **第 1 批（本次）**：本文件**可独立跑**（`node plugin/scripts/preset-new.mjs <name> ...`）
 *   ⇒ 不依赖 `bin/teamkit.mjs`，因此**不与别人抢那个共享文件**。
 * · **第 2 批**：`bin/teamkit.mjs` 里加 `case 'preset-new'`（3~5 行）转发到这里。
 *
 * ## 落点（**关键：默认只写仓内，绝不碰真机**）
 * · 默认 `--out <仓内 presets/>` ⇒ 生成物进**本仓**，随 `sync-assets` 进包、随安装器分发；
 * · `--out` 可指到别处（**测试就该指到临时目录**）。
 * · ⚠️ **本工具不主动写 `$DSH_HOME/.agent-presets/`** —— 那是"装到用户真机"，
 *   归 `install-teamkit.mjs` 管（它有不覆盖 + `.teamkit` 标记的纪律）。**本工具不抢那条路。**
 *
 * ## 三态口径
 * · 名字合法性 / 不覆盖 / 模板存在性 = **代码强制**（内核 `plan()` 里，`--out` 之前就拒）；
 * · "生成的预设真能挂" = **实测**（另见 `check-preset-overlap.mjs` 与报告里的 `mountPreset` 读数）。
 *
 * 零依赖：只用 node 内置。
 */
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DEFAULT_TEMPLATE, DEFAULT_PERSONA, listTemplates, plan } from '../lib/preset-gen.js'

const HERE = dirname(fileURLToPath(import.meta.url))   // plugin/scripts
const PLUGIN_DIR = resolve(HERE, '..')                 // plugin/
const REPO = resolve(PLUGIN_DIR, '..')                 // 仓根（**开发布局**）

/**
 * 模板目录：**优先包内** `plugin/assets/presets/_templates`，回落仓内 `presets/_templates`。
 *
 * ⚠️ 为什么要"包内优先"（task-99 实测发现的**开源用户会踩的坑**）：
 *   · 开发仓里模板在 `<仓根>/presets/_templates`；
 *   · 但用户是 `npm i` 装出来的包 ⇒ **仓根不存在**（`REPO` 会算成 `node_modules/@dsh-external`）
 *     ⇒ 只认仓内路径 ⇒ **用户机器上找不到模板**。
 *   · 包内那份由 `sync-assets.mjs` 从仓内同步来（`presets/` → `assets/presets/`）⇒ 就该用它。
 *   三态：两个都在时**用包内**（它是分发形态）；都没有 ⇒ 报错并**列出找过的路径**（不静默）。
 */
function resolveTemplatesDir() {
  const candidates = [
    join(PLUGIN_DIR, 'assets', 'presets', '_templates'), // 包内（分发形态）
    join(REPO, 'presets', '_templates'),                 // 仓内（开发形态）
  ]
  for (const p of candidates) if (existsSync(p)) return { dir: p, candidates }
  return { dir: candidates[0], candidates }
}

/**
 * 默认输出目录 —— **DSH 真正读用户预设的那个根**。
 *
 * ⚠️ **我第一版写的是 `<仓根>/presets`，那是个错误设计**（实测发现的）：
 *   · 开发仓里它是对的（生成物进仓、随 `sync-assets` 进包）；
 *   · **但开源用户是 `npm i` 装出来的** ⇒ `<包>/..` = `node_modules/@dsh-external`
 *     ⇒ 生成物会落到 `node_modules/@dsh-external/presets/` —— **一个没人读的垃圾位置**。
 *   · DSH 读用户预设的地方是 `$DSH_HOME/.agent-presets/`（`discovery.js:48` `USER_PRESET_DIR`）。
 * ⇒ 改成本地用户预设根；**仓内开发**要生成进仓时显式给 `--out <仓根>/presets`（报告与
 *   `verify-templates.mjs` 都这么做）。
 *
 * 依赖：`$DSH_HOME`（缺省 `~/.dsh`）。**不含 workspace**（`resolveAll` 同口径）。
 */
function defaultOutDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}
const TEMPLATES = resolveTemplatesDir()
const TEMPLATES_DIR = TEMPLATES.dir

/** 取 `--flag value` 的值。 */
function argOf(flag, argv = process.argv) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
}

/** 会**吃掉**下一个 token 的旗标（其它旗标都是布尔/无值）。 */
const VALUE_FLAGS = new Set(['--template', '--out', '--role', '--persona', '--description', '--order'])

/**
 * 解析参数（**纯函数**，便于单测）。
 *
 * ⚠️⚠️ **本函数第一版有真 bug，是我自己的 CLI 冒烟测试抓到的**（不是想出来的）：
 *   我原来写 `argv.slice(2).filter(a => !a.startsWith('--'))` 然后取第一个当名字 ——
 *   但**经 `teamkit preset-new <name>` 调用时**，`process.argv` 是
 *   `[node, teamkit.mjs, 'preset-new', '<name>', …]` ⇒ **`'preset-new'` 这个子命令名
 *   会被当成预设名** ⇒ 实际生成出名叫 `preset-new` 的预设，而命令**看起来成功了**（exit=0）。
 *   ⇒ 这正是本项目最反复的坑：**"看起来成功"与"真的对了"是两件事**。
 *   修法（两条一起）：
 *     ① **显式跳过子命令 token**（`argv[2] === 'preset-new'` 时跳过）；
 *     ② 按 `VALUE_FLAGS` **真正吃掉旗标的值** —— 否则 `--template lite` 里的 `lite`
 *        会漏进位置参数、被误当成名字（同一个 bug 的第二个入口）。
 *
 * @returns {{ok, why?, name?, template?, out?, presetId?, persona?, description?, order?}}
 */
export function parseArgs(argv) {
  const positional = []
  const flags = {}
  let i = 2
  // ① 跳过子命令 token（只有"经 bin 转发"时才有；直接跑本脚本时没有）
  if (argv[i] === 'preset-new') i += 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) { flags[a.slice(0, eq)] = a.slice(eq + 1); continue }   // `--template=lite` 形态也支持
      if (VALUE_FLAGS.has(a)) { flags[a] = argv[i + 1]; i += 1; continue } // ② 吃掉它的值
      flags[a] = true
      continue
    }
    positional.push(a)
  }
  const name = positional[0]
  if (name === undefined) {
    return { ok: false, why: '缺预设名。用法：preset-new <name> [--template <t>] [--out <dir>] [--role <r>] [--persona <text>] [--description <text>] [--order <n>]' }
  }
  if (positional.length > 1) {
    return { ok: false, why: `多余的参数：${positional.slice(1).join(', ')}（本命令只接受一个预设名）` }
  }
  const orderRaw = flags['--order']
  let order
  if (orderRaw !== undefined) {
    order = Number(orderRaw)
    if (!Number.isFinite(order)) return { ok: false, why: `--order 必须是数字（收到 ${JSON.stringify(orderRaw)}）` }
  }
  return {
    ok: true,
    name,
    template: flags['--template'] ?? DEFAULT_TEMPLATE,
    out: flags['--out'] ?? defaultOutDir(),
    ...(flags['--role'] === undefined ? {} : { role: flags['--role'] }),
    ...(flags['--persona'] === undefined ? {} : { persona: flags['--persona'] }),
    ...(flags['--description'] === undefined ? {} : { description: flags['--description'] }),
    ...(order === undefined ? {} : { order }),
  }
}

/**
 * 真实执行：落盘两个文件 + **回读自证**。
 * ⚠️ **回读是纪律，不是可选项**：写完不读回，就等于"我以为写进去了"
 *    （本项目 `promote-upstream.mjs` 立过这条规矩：写完 CHANGELOG 要回读确认）。
 * @param opts 解析后的参数 + `templatesDir` / `promptTemplateFn`（后者留给调用的命令面加"预设闸门"行）
 * @returns {{ok, code, why, files?, wrote?}}
 */
export function runPresetNew(opts) {
  const templatesDir = opts.templatesDir ?? TEMPLATES_DIR
  // ① **先决策**（拒绝都在这里发生；`plan` 纯函数，不产生任何写入）
  const decided = plan({
    targetDir: opts.out,
    templatesDir,
    name: opts.name,
    template: opts.template,
    ...(opts.presetId === undefined ? {} : { presetId: opts.presetId }),
    ...(opts.persona === undefined ? {} : { persona: opts.persona }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    ...(opts.order === undefined ? {} : { order: opts.order }),
  })
  if (!decided.ok) return { ok: false, code: 2, why: decided.why }

  // ② 落盘
  const wrote = []
  try {
    mkdirSync(join(opts.out, opts.name), { recursive: true })
    for (const f of decided.files) {
      writeFileSync(f.path, f.text, 'utf8')
      wrote.push(f.path)
    }
  } catch (err) {
    // 写一半失败 ⇒ 尽力清掉半成品（不留"看起来生成了、其实是半个"的目录）
    for (const p of wrote) { try { rmSync(p, { force: true }) } catch { /* ignore */ } }
    try { rmSync(join(opts.out, opts.name), { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, code: 1, why: `写盘失败：${err?.message ?? String(err)}（已清理半成品）` }
  }

  // ③ **回读自证**：每个文件必须读得回来，且与将要写的字节**完全一致**。
  for (const f of decided.files) {
    if (!existsSync(f.path)) return { ok: false, code: 1, why: `回读失败：${f.path} 不存在` }
    let back
    try { back = readFileSync(f.path, 'utf8') } catch (err) { return { ok: false, code: 1, why: `回读失败：${f.path}（${err?.message ?? String(err)}）` } }
    if (back !== f.text) return { ok: false, code: 1, why: `回读不一致：${f.path}（写进去的与读回来的不同）` }
  }
  // ④ **自证：没有任何生成器占位符残留**（内核已查，这里再查一遍落盘后的实际字节）
  for (const f of decided.files) {
    const back = readFileSync(f.path, 'utf8')
    const left = [...new Set([...back.matchAll(/\{\{@[a-zA-Z][a-zA-Z0-9]*\}\}/g)].map((m) => m[0]))]
    if (left.length > 0) return { ok: false, code: 1, why: `生成的 ${f.path} 里残留占位符：${left.join(', ')}` }
  }
  return { ok: true, code: 0, why: 'ok', files: decided.files.map((f) => f.path), wrote, template: decided.template }
}

/**
 * CLI 入口（被 `bin/teamkit.mjs` 转发或直接跑都走这里）。
 *
 * ## `--role` 的语义（**与判据 ④"预设里不许内联岗位数据"不冲突的形态**）
 * `--role <r>` **只写进 `preset.yml` 的显示元数据**（`description` 里带一句"面向 <r>"），
 * **绝不写进 composition 的任何 config** —— 因为预设只做**装配**，岗位数据的事实来源是
 * `talents/*.md` → `roles/*.json`（见 `check-preset-overlap.mjs` 第 ④ 条）。
 * ⚠️ 若哪天要"按岗位生成人格"，那是**另一个功能**，得先解决"人格算不算岗位数据"这个判定
 *    —— 本轮**不做**（不发明）。这里只把它当**标签**用，并如实标注。
 */
export function main(argv = process.argv) {
  const args = parseArgs(argv)
  if (!args.ok) {
    process.stderr.write(`❌ ${args.why}\n`)
    return 2
  }
  const avail = listTemplates(TEMPLATES_DIR)
  const opts = {
    name: args.name,
    template: args.template,
    out: resolve(args.out),
    templatesDir: TEMPLATES_DIR,
  }
  if (args.persona !== undefined) opts.persona = args.persona
  if (args.order !== undefined) opts.order = args.order
  // `--role` ⇒ 只影响显示元数据（见上面注释）
  const descParts = []
  if (args.role !== undefined) descParts.push(`面向 ${args.role}`)
  if (args.description !== undefined) descParts.push(args.description)
  if (descParts.length > 0) opts.description = descParts.join('；')

  const res = runPresetNew(opts)
  if (!res.ok) {
    process.stderr.write(`❌ preset-new 拒绝：${res.why}\n`)
    if (!avail.ok) process.stderr.write(`   （模板目录也读不到：${avail.why}）\n`)
    else process.stderr.write(`   可用模板：${avail.templates.join(', ')}\n`)
    return res.code
  }
  process.stdout.write(`✅ 生成预设 \`${args.name}\`（模板 ${res.template}）\n`)
  for (const f of res.files) process.stdout.write(`   ${f}\n`)
  if (args.role !== undefined) {
    process.stdout.write(`   （--role ${args.role} 只记进 preset.yml 的显示元数据；**不内联岗位数据**）\n`)
  }
  process.stdout.write('\n⚠️ 这是**生成物**：手改之后再跑一次 preset-new 会把它覆盖回模板的样子。\n')
  process.stdout.write('   要改形态 ⇒ 改 `presets/_templates/<模板>/agent.cordis.yml.tmpl`。\n')
  process.stdout.write('   下一步（可选）：node plugin/tools/install-teamkit.mjs   # 装到 $DSH_HOME/.agent-presets/\n')
  return 0
}

// 直接跑才执行（被 import 时只导出函数，便于单测）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}

// 保持导出面显式（`DEFAULT_PERSONA` 让测试能钉"生成了什么人格"）
export { DEFAULT_PERSONA, TEMPLATES_DIR }
