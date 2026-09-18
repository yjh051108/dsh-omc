#!/usr/bin/env node
/**
 * sync-assets.mjs —— 把**仓内资产**同步进插件包，并检查两边有没有漂移。
 *
 * ## 为什么必须有这个脚本（**2026-09-14 实测的分发缺口**）
 * 插件包 `package.json` 的 `files` 白名单只含 `lib/bin/scripts/patches/skills/…` ⇒
 * `npm pack` 出来的 **tgz 里没有**：预设（`omc` 的入口）、角色档（公司层的"人"）、
 * talents（岗位档案）、组织层（TALENTS.yml / RULES.yml）、以及**安装器本身**。
 * ⇒ **开源用户装上插件，拿不到"开公司"的任何资产** —— 违反北极星（越好装越好）。
 *
 * **实证**（`npm pack --dry-run`）：25 个文件里 **0 个** 是上面这些。
 *
 * ## 单一事实来源（两条都要守）
 *   **仓**（`<repo>/presets`、`<repo>/talents`、`<repo>/runs/005-role-skills/roles`、
 *        `<repo>/TALENTS.yml`、`<repo>/RULES.yml`、`<repo>/tools/install-teamkit.mjs`）
 *     ↓ 本脚本
 *   **插件包副本**（`plugin/assets/**`、`plugin/tools/install-teamkit.mjs`）
 * ⇒ **只许由本脚本生成，不许手改**；改了仓就重跑本脚本。
 *
 * ## 三条纪律（照 `sync-skills.mjs` 与 LANDMINES 的实测教训）
 *  1. **默认写、`--check` 只读**；`--help` 与 `--check` **绝不写盘**（LANDMINES §7）。
 *  2. **写出来必须无 BOM**（LANDMINES §19：BOM ⇒ 整条静默失效）——
 *     只走 `node:fs` 写字符串（Node 不写 BOM），**绝不调 `Set-Content -Encoding UTF8`**。
 *  3. **同名但内容不同 ⇒ 报告差异**（默认也覆盖，因为这里是"打包副本"，但会把 diff 数打出来）。
 *
 * 用法：
 *   node scripts/sync-assets.mjs            # 同步进 plugin/assets（打印每条动作）
 *   node scripts/sync-assets.mjs --check    # 只检查漂移（不写盘）；漂移 ⇒ 1，读不到源 ⇒ 2
 *   node scripts/sync-assets.mjs --help     # 本页（不写盘）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const REPO = resolve(PLUGIN_DIR, '..')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const check = has('--check')

if (has('--help') || has('-h')) {
  process.stdout.write(`sync-assets —— 把仓内资产同步进插件包（让 tgz 里真的带上它们）

  源 = <repo>/{presets,talents,runs/005-role-skills/roles,TALENTS.yml,RULES.yml,tools/install-teamkit.mjs}
  目标 = <plugin>/{assets/**,tools/install-teamkit.mjs}

  --check   只检查漂移（不写盘）；漂移 ⇒ 退出码 1，读不到源 ⇒ 退出码 2
  --help    本页（不写盘）
`)
  process.exit(0)
}

/** 递归列出目录下所有文件（相对路径，正斜杠）。`skip` = 要跳过的相对路径前缀。 */
function walk(dir, base = dir, skip = []) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    const rel = relative(base, p).replace(/\\/g, '/')
    // ⚠️ **排除开发物**（2026-09-14）：`raw/` 是"生成器 + 验证读数"，
    //   `_generate-agent-cordis.mjs` 里还写死了开发机路径（虽已加过期护栏）。
    //   **它们不该发给开源用户** —— 判据：用户拿到的是"能用的预设"，不是我们的开发现场。
    if (skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue
    if (e.isDirectory()) out.push(...walk(p, base, skip))
    else out.push(rel)
  }
  return out.sort()
}

/** 每一项：`{ name, src, dst, kind, skip? }`，kind = 'file' | 'dir' */
const ITEMS = [
  { name: 'presets', src: join(REPO, 'presets'), dst: join(PLUGIN_DIR, 'assets', 'presets'), kind: 'dir', skip: ['omc/raw'] },
  { name: 'talents', src: join(REPO, 'talents'), dst: join(PLUGIN_DIR, 'assets', 'talents'), kind: 'dir' },
  // ⚠️ **`roles` 要排除"没有同名 `.json` 角色档的目录"**（2026-09-14 / Round 26 修的 bug）。
  //   仓里有个 `runs/005-role-skills/roles/A/` —— 它是 **task-32 的探索证据**
  //   （`role-probe-a` 作用域探针；`COMPANY-LAYER.md §H` 记录过它被误删后逐字还原；
  //     `REPORT.md:43` 引用它），**没有 `A.json`** ⇒ 不是"人"。
  //   它此前被同步进包、又被安装器装到每个用户的 `$DSH_HOME/teamkit/roles/` ⇒
  //   用户会看到一个**没有岗位档案、却带一条技能的"幽灵角色"**。
  //   ⇒ 证据**留在仓里**（不删），只是**不进包、不分发**。见 `H7` 断言。
  { name: 'roles', src: join(REPO, 'runs', '005-role-skills', 'roles'), dst: join(PLUGIN_DIR, 'assets', 'roles'), kind: 'dir', skip: ['A'] },
  { name: 'TALENTS.yml', src: join(REPO, 'TALENTS.yml'), dst: join(PLUGIN_DIR, 'assets', 'org', 'TALENTS.yml'), kind: 'file' },
  { name: 'RULES.yml', src: join(REPO, 'RULES.yml'), dst: join(PLUGIN_DIR, 'assets', 'org', 'RULES.yml'), kind: 'file' },
  { name: 'install-teamkit.mjs', src: join(REPO, 'tools', 'install-teamkit.mjs'), dst: join(PLUGIN_DIR, 'tools', 'install-teamkit.mjs'), kind: 'file' },
]

let drifted = 0
let missingSrc = 0
let written = 0
const actions = []

for (const it of ITEMS) {
  if (!existsSync(it.src)) {
    missingSrc += 1
    actions.push(`  ??  ${it.name}：源不存在（${it.src}）—— 这一项**没同步**，不是"没有这项资产"`)
    continue
  }
  if (it.kind === 'file') {
    let same = false
    try { same = readFileSync(it.src, 'utf8') === readFileSync(it.dst, 'utf8') } catch { same = false }
    if (same) { actions.push(`  OK  ${it.name}（一致）`); continue }
    drifted += 1
    actions.push(`  ->  ${it.name}（待同步）`)
    if (!check) {
      mkdirSync(dirname(it.dst), { recursive: true })
      copyFileSync(it.src, it.dst)
      written += 1
    }
    continue
  }
  // dir
  const srcFiles = walk(it.src, it.src, it.skip ?? [])
  // ⚠️ **目标要扫全部文件（不套 skip）** —— 否则 `skip` 掉的那些（如 `raw/`）
  //    在目标里"看不见" ⇒ 判不出"多出来" ⇒ **永远清不掉**（我第一版就是这么写的，实测发现 raw 没被删）。
  let dstFiles = []
  try { dstFiles = walk(it.dst, it.dst, []) } catch { dstFiles = [] }
  const missing = srcFiles.filter((f) => !dstFiles.includes(f))
  const extra = dstFiles.filter((f) => !srcFiles.includes(f))
  const differ = srcFiles.filter((f) => {
    if (!dstFiles.includes(f)) return false
    try { return readFileSync(join(it.src, f), 'utf8') !== readFileSync(join(it.dst, f), 'utf8') } catch { return true }
  })
  if (missing.length === 0 && extra.length === 0 && differ.length === 0) {
    actions.push(`  OK  ${it.name}/（${srcFiles.length} 个文件，一致）`)
    continue
  }
  drifted += 1
  actions.push(`  ->  ${it.name}/（缺 ${missing.length} / 差 ${differ.length} / 多 ${extra.length}，源 ${srcFiles.length} 个）`)
  if (!check) {
    if (extra.length > 0) {
      // ⚠️ **只在打包副本里删"源没有的"**（副本必须与源一致；仓是权威）
      for (const f of extra) rmSync(join(it.dst, f), { force: true })
      // ⚠️ **删完文件还要清掉空目录** —— 我第一版只删文件 ⇒ `raw/` 变成**空目录仍留在包里**
      //    （实测：`--check` 报"多 5"、同步后 `raw/` 目录还在）。
      //    做法：自底向上，把"空目录"删掉（从最深的开始）。
      const dirs = extra
        .map((f) => dirname(join(it.dst, f)))
        .filter((d, i, a) => a.indexOf(d) === i)
        .sort((a, b) => b.length - a.length)
      for (const d of dirs) {
        let cur = d
        // 逐级向上，只要空就删（但不越过 `it.dst`）
        while (cur.length > it.dst.length && cur.startsWith(it.dst)) {
          try {
            if (readdirSync(cur).length === 0) { rmSync(cur, { recursive: true, force: true }); cur = dirname(cur) } else break
          } catch { break }
        }
      }
    }
    for (const f of srcFiles) {
      const d = join(it.dst, f)
      mkdirSync(dirname(d), { recursive: true })
      copyFileSync(join(it.src, f), d)
      written += 1
    }
  }
}

process.stdout.write('teamkit 资产同步 · ' + (check ? '只检查' : '同步') + '\n')
process.stdout.write('  源   ' + REPO + '\n')
process.stdout.write('  目标 ' + join(PLUGIN_DIR, 'assets') + '\n')
for (const a of actions) process.stdout.write(a + '\n')

if (check) {
  if (missingSrc > 0) {
    process.stdout.write('\n判读：**有源读不到**（退出码 2）—— 这不是"漂移"，要看清是哪一项。\n')
    process.exit(2)
  }
  if (drifted > 0) {
    process.stdout.write('\n判读：**有漂移**（退出码 1）—— 跑 `node scripts/sync-assets.mjs` 同步。\n')
    process.exit(1)
  }
  process.stdout.write('\n判读：一致（退出码 0）。\n')
  process.exit(0)
}
process.stdout.write('\n完成：写入 ' + written + ' 个文件。\n')
process.stdout.write('⚠️ 这只是"打包副本"；改了仓里的资产要重跑本脚本（或 npm run sync-assets）。\n')
