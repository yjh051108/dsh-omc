#!/usr/bin/env node
/**
 * sync-skills.mjs —— 把仓内 `skills/` **同步进插件包**，并检查两边有没有漂移。
 *
 * ## 为什么要有这个脚本（task-51 D 的"别两边各写一份"）
 * 插件要带上那 7 条方法 skill（判据见 README：带 = 装上就有方法可用），但**技能的维护入口
 * 只能有一个**。所以定死：
 *
 *   **单一事实来源 = 仓内 `../skills/`（相对本脚本 = `<repo>/skills`）；插件里的 `plugin/skills/`
 *   是它的「打包副本」，只许由本脚本生成，不许手改。**
 *
 * 这样：
 *  · 维护者在仓内改技能 → 跑 `npm run sync-skills` → 插件包跟着更新（不会漏）；
 *  · CI / 评审跑 `npm run sync-skills:check` → 两边**逐字节比对**，漂移就非零退出；
 *  · 开源用户拿到的是 tgz 里那份副本，**不需要仓**。
 *
 * ⚠️ 三条纪律（照 LANDMINES 的实测教训写进代码）：
 *  1. **默认 `--check` 之外才写**；`--help` 与 `--check` **绝不写盘**（LANDMINES §7：
 *     一个生成器脚本因为不看参数就 `rm -rf`，删了别人的历史读数）。
 *  2. **写出来的文件必须无 BOM**（LANDMINES §19：BOM ⇒ 整条技能静默失效）。
 *     本脚本只走 `node:fs` 写字符串（Node 不写 BOM），**绝不调 `Set-Content -Encoding UTF8`**。
 *  3. **同名但内容不同 ⇒ 报错而不是"静默覆盖"**；只有 `--force` 才覆盖。
 *
 * 用法：
 *   node scripts/sync-skills.mjs            # 同步（只补缺 + 更新有差异的，并打印每条的动作）
 *   node scripts/sync-skills.mjs --check    # 只检查（漂移 ⇒ 退出码 1；读不到 ⇒ 退出码 2）
 *   node scripts/sync-skills.mjs --force    # 覆盖目标里"多出来"的条目（默认不动它们）
 *   node scripts/sync-skills.mjs --help     # 本页（不写盘）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
// 单一事实来源：仓内 skills/（plugin/ 的上一级）
const SRC = resolve(PLUGIN_DIR, '..', 'skills')
const DST = join(PLUGIN_DIR, 'skills')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const check = has('--check')
const force = has('--force')

if (has('--help') || has('-h')) {
  process.stdout.write(`sync-skills —— 把 ${SRC} 同步进插件包 ${DST}
（**单一事实来源 = 仓内 skills/**；插件里那份是打包副本，别手改）

  --check   只检查漂移（不写盘）；漂移 ⇒ 退出码 1，读不到源 ⇒ 退出码 2
  --force   同时删除目标里"源没有"的条目（默认不动）
  --help    本页（不写盘）
`)
  process.exit(0)
}

process.stdout.write(`同步技能：\n  源   ${SRC}\n  目标 ${DST}\n`)

function listSkills(root) {
  const out = new Map()
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    return { error: err?.code ?? err?.message ?? String(err), out }
  }
  for (const e of dirents) {
    if (e.isDirectory() && !e.name.startsWith('.') && existsSync(join(root, e.name, 'SKILL.md'))) {
      out.set(e.name, join(root, e.name, 'SKILL.md'))
    }
  }
  return { error: null, out }
}

const src = listSkills(SRC)
if (src.error !== null) {
  // 读不到 ≠ 没有（LANDMINES §6）：`--check` 给退出码 2 = 未验证
  process.stdout.write(`  ??  读不到源目录（${src.error}）—— 这不是"没有技能"\n`)
  process.exit(check ? 2 : 1)
}
if (src.out.size === 0) {
  process.stdout.write('  XX  源目录里一条技能都没有 ⇒ 拒绝同步（否则会把插件包清空）\n')
  process.exit(1)
}

const dst = listSkills(DST)
const rows = []
let drift = 0
let wrote = 0

for (const [name, srcFile] of [...src.out.entries()].sort()) {
  const dstFile = join(DST, name, 'SKILL.md')
  const srcText = readFileSync(srcFile, 'utf8')
  if (srcText.charCodeAt(0) === 0xfeff) {
    rows.push(`  XX  ${name}  源文件带 BOM ⇒ 会被 DSH 静默丢弃（先修源，别同步）`)
    drift += 1
    continue
  }
  let action
  if (!existsSync(dstFile)) {
    action = 'add'
  } else {
    const dstText = readFileSync(dstFile, 'utf8')
    action = dstText === srcText ? 'same' : 'update'
  }
  if (action !== 'same') drift += 1
  if (!check && action !== 'same') {
    mkdirSync(dirname(dstFile), { recursive: true })
    writeFileSync(dstFile, srcText, 'utf8')            // Node 写 UTF-8 不加 BOM
    const back = readFileSync(dstFile, 'utf8')          // **写后回读**（LANDMINES §9 同族）
    if (back !== srcText) {
      rows.push(`  XX  ${name}  写后回读不一致`)
      process.exit(1)
    }
    wrote += 1
  }
  rows.push(`  ${action === 'same' ? 'OK ' : action === 'add' ? '-> ' : '~~ '} ${name.padEnd(20)} ${action}${Buffer.byteLength(srcText)}B`)
}

// 目标里"源没有"的条目：默认**不动**（可能是别人有意加的），但要说出来
const extras = [...dst.out.keys()].filter((n) => !src.out.has(n)).sort()
for (const name of extras) {
  if (force && !check) {
    rmSync(join(DST, name), { recursive: true, force: true })
    rows.push(`  --  ${name.padEnd(20)} removed(--force)`)
    drift += 1
  } else {
    rows.push(`  ??  ${name.padEnd(20)} 目标里有、源里没有（默认不动；--force 会删）`)
  }
}

process.stdout.write(rows.join('\n') + '\n')
process.stdout.write('')
if (check) {
  if (drift === 0) {
    process.stdout.write(`\n判定：PASS（${src.out.size} 条，两边一致）\n`)
    process.exit(0)
  }
  process.stdout.write(`\n判定：FAIL —— ${drift} 处漂移；跑 \`node scripts/sync-skills.mjs\`（并把结果一起提交）\n`)
  process.exit(1)
}
process.stdout.write(`\n完成：写入/更新 ${wrote} 条；源 ${src.out.size} 条、目标 ${dst.out.size} 条。\n`)
process.exit(0)
