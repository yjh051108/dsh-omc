/**
 * build — 共生体构建：src/*.js 复制到 lib/（纯 ESM 零编译，closedloop 同模式——
 * 绕开 DSH_CHECKOUT 探测坑：Git Bash $HOME 可能解析到旧 profile（本机账户名的家目录），
 * AGENTS.md 血泪坑 #1 的构建面变体）。
 * 用法：node scripts/build.mjs
 */
import { cpSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

let count = 0
for (const f of readdirSync(srcDir)) {
  const p = join(srcDir, f)
  if (statSync(p).isFile() && /\.(js|mjs)$/.test(f)) { cpSync(p, join(libDir, f)); count++ }
}
if (!existsSync(join(libDir, 'index.js'))) { console.error('BUILD FAIL: lib/index.js 缺失'); process.exit(1) }
console.log(`BUILD OK: ${count} files → lib/`)
