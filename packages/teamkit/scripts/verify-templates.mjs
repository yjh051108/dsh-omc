// verify-templates.mjs —— 【task-99 ② / 真装真跑】两个模板形态的端到端验证
//
// ⚠️ **全程沙盒**：`DSH_HOME` 指到临时目录；生成的预设落在临时目录。
//    **不碰** `$DSH_HOME/.agent-presets/`（真机用户预设）、**不碰**真机那 7 个别人的预设。
//
// 四步（每步独立给读数，失败就停在那一步，不"整体看起来通过"）：
//   ① 生成两个预设（lite / full）到沙盒
//   ② 沙盒里真 `install-teamkit.mjs` ⇒ 它们真落到 `<fakeHome>/.agent-presets/<name>/`
//   ③ 用**真 `discoverPresets()`** 读沙盒 ⇒ 两个都出现、`broken` 为空
//   ④ 用**真 `mountPreset()`** 在 scratch ctx 里挂一次 ⇒ 判据 = **零 import 失败**
//      （挂载收尾会因缺 host 服务而失败，那是**预期**；只要失败**不含** import 解析错误就算过。
//       这条路我在 task-55/59 验过，与 `probe-no-restart.mjs` 同口径。）
//
// 用法：node verify-templates.mjs
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const PLUGIN = join(REPO, 'plugin')
// ★ 脱敏后需要用 PLUGIN_DIR 兜底找依赖（与 PLUGIN 同义，保留两个名字以免改动面过大）
const PLUGIN_DIR = PLUGIN
const NODE = process.execPath

const rows = []
const say = (s) => { rows.push(s); console.log(s) }
const step = (n, ok, what, detail) => say(`  ${ok ? 'OK  ' : 'XX  '} [${n}] ${what}${detail ? '  — ' + detail : ''}`)

const sandbox = mkdtempSync(join(tmpdir(), 'teamkit-tpl-verify-'))
const fakeHome = join(sandbox, 'home')
mkdirSync(fakeHome, { recursive: true })
// ⚠️ **安装器读的是"包内"预设源**，不是仓内（我第一版搞错了，② 直接红）：
//   `install-teamkit.mjs:55` `pickSrc('presets','omc/agent.cordis.yml',[join(PKG,'presets'),join(PKG,'assets','presets')])`
//   ⇒ `PKG` = `plugin/` ⇒ 它读 `plugin/assets/presets/`（由 `sync-assets` 从仓内同步来）。
//   ⇒ 所以"生成 → 装"中间**必须有一道同步**（仓内 → 包内）。这就是 `R9` 的单一事实来源纪律。
//   本脚本用 sync-assets 同步（**它是幂等的仓→包镜像**），装完把生成物从**两处**都清掉。
const REPO_PRESETS = join(REPO, 'presets')
const PKG_PRESETS = join(PLUGIN, 'assets', 'presets')
const GEN_NAMES = ['verify-lite', 'verify-full']
/** 只删本脚本生成的目录（白名单 + 断言在预期的根下），仓内与包内都清。 */
const cleanupGenerated = () => {
  for (const root of [REPO_PRESETS, PKG_PRESETS]) {
    for (const n of GEN_NAMES) {
      const p = join(root, n)
      if (!p.startsWith(root)) continue  // 防呆
      rmSync(p, { recursive: true, force: true })
    }
  }
}
say('═══ 装置 ═══')
say(`  sandbox  = ${sandbox}`)
say(`  fakeHome = ${fakeHome}   ← DSH_HOME 指到这里，**绝不碰真机**`)
say(`  生成到   = ${REPO_PRESETS}（仓内）→ 同步到 ${PKG_PRESETS}（包内，安装器读这里）`)
say(`  装完清理 = 两处都删 ${GEN_NAMES.join('/')}`)
say('')

// ── ① 生成 ────────────────────────────────────────────────────────────────
say('═══ ① 生成两个预设（lite / full）═══')
for (const [name, tpl] of [['verify-lite', 'lite'], ['verify-full', 'full']]) {
  const r = execFileSync(NODE, [join(PLUGIN, 'scripts', 'preset-new.mjs'), name, '--template', tpl, '--out', REPO_PRESETS], { encoding: 'utf8' })
  const comp = join(REPO_PRESETS, name, 'agent.cordis.yml')
  const meta = join(REPO_PRESETS, name, 'preset.yml')
  step('①', existsSync(comp) && existsSync(meta), `${name}（模板 ${tpl}）生成`, `agent.cordis.yml=${existsSync(comp)} preset.yml=${existsSync(meta)}`)
}
say('')

// ── ①b 同步到包内（R9：仓内是源，包内是分发镜像）────────────────────────────
say('═══ ①b 把生成物与模板同步到包内 `plugin/assets/presets/`（安装器读这里）═══')
// ⚠️ **刻意不用整跑 `sync-assets.mjs`**：它是"仓 → 包"的**全量镜像**，
//   会把**别人的**在改资产（我实测到 `RULES.yml` 正被别的执行者改）一起推过去
//   ⇒ 那等于**替别人提交了半成品**。
//   ⇒ 本脚本只镜像**自己这两个目录**（`_templates/` 与两个 verify-*），blast radius 可控。
//   （`R9` 的全量同步仍由 `check-all.mjs` 那条 `sync-assets --check` 兜底，不在本脚本职责内。）
const copyTree = (src, dst) => {
  if (!existsSync(src)) return 0
  let n = 0
  if (statSync(src).isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src)) n += copyTree(join(src, e), join(dst, e))
  } else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); n++ }
  return n
}
let synced = 0
synced += copyTree(join(REPO_PRESETS, '_templates'), join(PKG_PRESETS, '_templates'))
for (const n of GEN_NAMES) synced += copyTree(join(REPO_PRESETS, n), join(PKG_PRESETS, n))
step('①b', existsSync(join(PKG_PRESETS, 'verify-lite', 'agent.cordis.yml')), '生成物与模板已镜像到包内（只镜像自己的，不碰别人的）', `复制 ${synced} 个文件`)
say('')
say('═══ ② 真跑 install-teamkit.mjs（DSH_HOME=fakeHome）═══')
try {
  execFileSync(NODE, [join(PLUGIN, 'tools', 'install-teamkit.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: fakeHome },
  })
} catch (err) {
  say(`  （安装器非零退出：${err?.status ?? '?'}）`)
}
const installed = join(fakeHome, '.agent-presets')
const dirs = existsSync(installed) ? readdirSync(installed).filter((d) => !d.startsWith('.')) : []
for (const name of ['omc', 'verify-lite', 'verify-full']) {
  step('②', dirs.includes(name), `${name} 落到 <fakeHome>/.agent-presets/`, dirs.includes(name) ? `有 .teamkit 标记=${existsSync(join(installed, name, '.teamkit'))}` : `实际装到的：${dirs.join(', ')}`)
}
// ★ 反面判据：`_templates` **不许**被当成预设装进去
step('②', !dirs.includes('_templates'), '`_templates` **没**被当成预设装走（`.tmpl` 后缀 + 非法 PRESET_ID 两层保护）', '')
say('')

// ── ③ 真 discovery ───────────────────────────────────────────────────────
say('═══ ③ 用**真 `discoverPresets()`** 读 fakeHome ═══')
// ⚠️ **2026-09-15 脱敏**：原来这两条是**硬编码的本机绝对路径**（含用户名）——
//   那既**泄露本机用户名**，又**在别人机器上一跑就崩**（路径不存在）。
//   ⇒ 改成**从环境推**：优先 `DSH_CHECKOUT` / `DSH_HOME`，再兜底从本脚本位置往上找。
const DSH_PKGS = (() => {
  const cands = []
  if (process.env.DSH_CHECKOUT) cands.push(process.env.DSH_CHECKOUT)
  if (process.env.DSH_HOME) cands.push(join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules'))
  if (process.env.APPDATA) cands.push(join(process.env.APPDATA, 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  cands.push(join(PLUGIN_DIR, '..', 'node_modules'), join(PLUGIN_DIR, 'node_modules'))
  for (const c of cands) {
    try {
      if (existsSync(join(c, '@deepseek-ai', 'dsh-agent-presets'))) return join(c, '@deepseek-ai')
    } catch { /* next */ }
  }
  return join(cands[cands.length - 1] ?? '.', '@deepseek-ai')
})()
const R = pathToFileURL(join(DSH_PKGS, '')).href
const disc = await import(R + 'dsh-agent-presets/lib/types/discovery.js')
// ⚠️ **harnessBase 不能省**：`discovery.js:158` 对 package 行会 `fileURLToPath(harnessBase)`
//   ⇒ 传 `undefined` 会 `ERR_INVALID_ARG_TYPE` 崩掉（我第一版就是）。真调用方（AgentPresets）
//   永远会给它（= 宿主组合的 baseUrl）⇒ 这里照真值给。
const HARNESS_BASE = process.env.DSH_HOME
  ? pathToFileURL(join(process.env.DSH_HOME, 'profiles', 'web') + sep).href
  : pathToFileURL(join(PLUGIN_DIR, '..') + sep).href
const found = await disc.discoverPresets([{ path: installed, trust: 'user' }], HARNESS_BASE)
const byId = new Map(found.map((p) => [p.id, p]))
for (const name of ['verify-lite', 'verify-full']) {
  const p = byId.get(name)
  step('③', p !== undefined && p.broken === undefined, `${name} 被发现且不 broken`, p === undefined ? '**没被发现**' : `broken=${p.broken ?? '(无)'}`)
}
say(`      发现的预设：${found.map((p) => p.id + (p.broken ? '(BROKEN)' : '')).join(', ')}`)
say('')

// ── ④ 真 mountPreset（判据：零 import 失败）───────────────────────────────
say('═══ ④ 用**真 `mountPreset()`** 挂一次（判据 = 零 import 失败）═══')
const { Context } = await import(R + 'cordis/lib/index.js')
const loaderMod = await import(R + 'cordis-plugin-loader/lib/index.js')
const { createScope } = await import(R + 'dsh-scope/lib/index.js')
const M = await import(R + 'dsh-agent-presets/lib/index.js')

for (const name of ['verify-lite', 'verify-full']) {
  const ctx = new Context()
  await ctx.plugin(loaderMod.default ?? loaderMod.Loader)
  // ⚠️ baseUrl **必须在装完 loader 之后**设（loader 构造会覆盖它）—— task-55 实测过
  ctx.baseUrl = HARNESS_BASE
  ctx.loader.builtins['group'] = loaderMod.EntryGroup ?? loaderMod.Group
  const sc = createScope(ctx, {})
  let err
  try {
    await M.mountPreset(sc.ctx, {
      id: name,
      path: join(installed, name, 'agent.cordis.yml'),
    })
  } catch (e) { err = String(e?.message ?? e) }

  const failLines = (err ?? '').split('\n').filter((l) => l.trim() !== '')
  const importFail = failLines.filter((l) => /cannot be resolved|Cannot find (package|module)|failed to import/i.test(l))
  const waiting = failLines.filter((l) => /waiting for/i.test(l))
  const leaked = failLines.filter((l) => /process-global/i.test(l))
  if (err === undefined) {
    step('④', true, `${name} 在 scratch ctx 里**整份挂上了**`, '（居然全挂上了）')
  } else {
    step('④', importFail.length === 0, `${name} 挂载：**零 import 失败**`, `import失败=${importFail.length} / waiting服务=${waiting.length} / 泄漏=${leaked.length}`)
    if (importFail.length > 0) for (const l of importFail.slice(0, 4)) say(`         ← ${l.trim().slice(0, 150)}`)
  }
}

// ── ⑤ 清场（**交付物里不许留我生成的预设**）────────────────────────────────
//   ⚠️ 顺序：**先判定，再清场**；清完复核"仓内 presets/ 只剩原有的"。
say('═══ ⑤ 清场（仓内 presets/ 不许留下验证用的生成物）═══')
cleanupGenerated()
const leftovers = GEN_NAMES.filter((n) => existsSync(join(REPO_PRESETS, n)))
step('⑤', leftovers.length === 0, '生成的验证预设已从仓内 presets/ 删除', leftovers.length ? `**还在：${leftovers.join(', ')}**` : '')
// ★ 顺带证明"别人的东西没动"：仓内 presets/ 应只剩 omc + _templates
const remain = readdirSync(REPO_PRESETS).filter((d) => !d.startsWith('.')).sort()
say(`      仓内 presets/ 现在：${remain.join(', ')}`)

say('')
say(`（沙盒保留供检查：${sandbox}）`)
say('')
const xx = rows.filter((l) => l.startsWith('  XX')).length
say(`═══ 小结：${xx === 0 ? '全部 OK' : xx + ' 项失败'} ═══`)
process.exit(xx === 0 ? 0 : 1)
