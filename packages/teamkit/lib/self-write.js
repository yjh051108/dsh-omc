/**
 * self-write.js —— **宿主侧代写"我自己的"那些文件**（2026-09-14 / Round 49）。
 *
 * ## 为什么必须有它（真缺陷，连撞两轮）
 * 组织资产**全部装在 `$DSH_HOME`** ⇒ 它们在 **agent 的工作区之外**；
 * 而 agent 跑在 `workspace-write` 沙箱里 ⇒ **它写不了自己那几份**。实测（真 `omc` Lead）：
 * ```
 *   write $DSH_HOME/.teamkit/soul/lead.md          → [sandbox: file access denied under workspace-write mode]
 *   write $DSH_HOME/teamkit/talents/principles/…   → 同上
 * ```
 * ⇒ **"自我迭代"与"组织会学习"这两格，读得到、写不回去。**
 *   R48 我只修了 SOUL 一处；R49 实测**原则文件同样被拒** ⇒ 这一轮**做成一个通用的**，
 *   免得下一轮再发现第三处（这正是"逐处打补丁"的病根）。
 *
 * ## 它是什么 / 不是什么（**这是关键的安全边界**）
 * ✅ 它是**"写我自己的那几份"**：目标只能从**白名单枚举**里选，路径由**插件算**，
 *    **绝不接受调用方传路径**。
 * ❌ 它**不是**通用文件写工具 —— 那等于给 agent 一个绕过沙箱的后门。
 *
 * ## 白名单（只有这三类；加新的要在这里写明理由）
 * | `target` | 落到哪 | 谁该写 |
 * |---|---|---|
 * | `soul` | `<stateDir>/soul/<你的名字>.md` | 本人（"我答应自己改什么"） |
 * | `principles` | `<teamkit>/talents/principles/<角色名>.md` | 本人（"这类活怎么干"，按角色共享） |
 * | `role-skill` | `<teamkit>/roles/<角色名>/skills/<技能名>/SKILL.md` | 本人（"我这条技能要改"） |
 *
 * ⚠️ **`role-skill` 需要额外的 `skill` 参数**，且**只允许写进"你自己角色目录下"**；
 *    不许跳出（`under()` 判据，跨盘安全）。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'

/** 白名单：**只有这三个**。加新的必须在这里写理由。 */
export const TARGETS = ['soul', 'principles', 'role-skill']

/** 相对 base 是否在内部（跨盘安全；与 `skills.js:under` 同规矩）。 */
function under(base, target) {
  const rel = relative(base, target)
  if (rel === '') return false
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

function sha16(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 算目标文件的**绝对路径**（全部由插件算，**不接受调用方传路径**）。
 *
 * @param opts.stateDir     `paths.stateDir`（SOUL 落点）
 * @param opts.teamkitDir   `<DSH_HOME>/teamkit`（talents/ 与 roles/ 的父目录）
 * @param opts.member       调用者的名字（`tryMembership(agent).name`）
 * @param opts.role         调用者的**角色名**（从角色档来；`role-skill` 必需）
 * @param opts.target       `'soul' | 'principles' | 'role-skill'`
 * @param opts.skill        `role-skill` 的技能名（**必须已在角色目录下存在**，不许新建任意名）
 * @returns `{ ok, file }` 或 `{ ok:false, why }`
 */
export function resolveSelfTarget({ stateDir, teamkitDir, member, role, target, skill, soulCfg = {} }) {
  if (!TARGETS.includes(target)) return { ok: false, why: `unknown-target（只允许 ${TARGETS.join(' / ')}）` }
  if (typeof member !== 'string' || member === '') return { ok: false, why: 'no-member（认不出你是谁）' }
  if (target === 'soul') {
    const dir = typeof soulCfg.dir === 'string' && soulCfg.dir !== '' ? soulCfg.dir : join(stateDir, 'soul')
    return { ok: true, file: join(dir, `${member}.md`), base: dir }
  }
  // 下面两个都需要角色名（**按角色共享**，不是按人头）
  if (typeof role !== 'string' || role === '') {
    return { ok: false, why: `no-role（\`${target}\` 按**角色**落点，但你这次没有角色档 ⇒ 不猜）` }
  }
  if (typeof teamkitDir !== 'string' || teamkitDir === '') return { ok: false, why: 'no-teamkitDir（配置里没有组织层根）' }
  if (target === 'principles') {
    const dir = join(teamkitDir, 'talents', 'principles')
    return { ok: true, file: join(dir, `${role}.md`), base: dir }
  }
  // role-skill：**必须**给出 skill 名，且**只允许写进自己角色目录里已存在的那条**
  if (typeof skill !== 'string' || skill === '') return { ok: false, why: 'no-skill（写角色技能必须给 `skill` 名）' }
  const roleDir = join(teamkitDir, 'roles', role, 'skills')
  const file = join(roleDir, skill, 'SKILL.md')
  if (!under(roleDir, file)) return { ok: false, why: 'escapes-role-dir（技能名不能跳出你自己的角色目录）' }
  return { ok: true, file, base: roleDir }
}

/** 读（不存在 ⇒ `text: undefined`，**正常状态**，不是错误）。 */
export function readSelf(file) {
  if (!existsSync(file)) return { file, text: undefined }
  try {
    const text = readFileSync(file, 'utf8')
    return { file, text, sha: sha16(text), bytes: text.length }
  } catch (err) {
    return { file, text: undefined, why: err?.message ?? String(err) }
  }
}

/**
 * 写（`append` 默认 / `replace` 显式）+ **回读校验**。
 * ⚠️ **宿主侧执行** ⇒ 不受 agent 沙箱约束（这正是它存在的理由）。
 */
export function writeSelf(file, text, { mode = 'append' } = {}) {
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, why: 'empty-text（不写空内容）', file }
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (mode === 'replace') {
      writeFileSync(file, body.replace(/\s+$/, '') + '\n', 'utf8')
    } else {
      const existed = existsSync(file)
      const prefix = existed && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : ''
      appendFileSync(file, prefix + body.replace(/\s+$/, '') + '\n', 'utf8')
    }
  } catch (err) {
    return { ok: false, why: `write-failed（${err?.message ?? err}）`, file }
  }
  // ★ **写完回读**（"写过了" ≠ "写进去了"）
  const back = readSelf(file)
  if (back.text === undefined) return { ok: false, why: 'verify-failed（写完却读不回来）', file }
  return { ok: true, file, bytes: back.bytes, sha: back.sha }
}

export { under }
