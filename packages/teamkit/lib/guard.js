/**
 * guard.js —— A 层（上游技能根）**误操作护栏**。
 *
 * ## 诚实口径（**必须原样搬进 README**，`DECISIONS.md` P-15/P-16 已定，禁止改成"写保护"）
 *
 * 它**不是权限机制、不是门禁、不拦得住有意为之的写**。实测三条：
 *  ① `ctx.tools.guard(fn)` 是 `write` / `edit` **两个工具名**上的判定点
 *     （`exp/authority-probe/lib/index.js:47` 的 `WRITE_TOOLS`）——
 *     其它写盘途径（`pwsh` 里 `Set-Content`、`node -e`、任何 shell）**根本不会走到它**；
 *  ② **`pwsh` 实测绕得过、零审计**（`LANDMINES.md` P-15 原文：*"禁止再把'写保护'说成'代码强制'"*）；
 *  ③ 委托方口径（P-16 原话）：**「他能不能改无所谓……他都不知道可以改，那他改啥呢？」**
 *     ⇒ 控制点在**认知**（他改的是哪一份），**不在文件系统**。
 *
 * 所以本模块**默认关闭**（`guard.enabled: false`）。要开的人得到的是一层
 * **"防手滑"**（模型本来要写上游、结果被提醒"那是公共契约"），**不是安全边界**。
 *
 * ## 唯一一处"代码强制"
 * `decide()` 是**纯函数**且被 `--selftest` 直接调用（不需要真 DSH / 真 teammate 就能断言）——
 * 这条是代码强制：`decide<T>({...})` 的六个分支都有 selftest 用例。
 *
 * ## 跨盘包含判定（踩过的坑，别改回去）
 * `path.relative(base, target)` 在**跨盘符**时返回**绝对路径**（不是 `..\…`）⇒
 * 只判 `!rel.startsWith('..')` 会**永远为真**。必须三条件同时成立：
 * `rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)`（`LANDMINES §10` 实测）。
 *
 * ## 逃生路（注入前就想好，照 `A-LAYER-AUTHORITY.md` §B4）
 *  · E1 插件源码在所有受保护根之外 ⇒ 永不被自己拒；
 *  · E2 `$DSH_TEAMKIT_DISABLE` 指向的文件存在 ⇒ 立即放行（逐次读盘，建文件即停药）；
 *  · E3 只可能拒绝受保护根**内**的 write/edit；其余路径一律 `undefined`（不干预）；
 *  · E4 卸载工具（`dev_uninject_plugin`）是宿主侧工具，不经本 guard。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { ENV } from './config.js'

/** 跨盘安全的包含判定（**三条件缺一不可**）。 */
export function under(base, target) {
  if (typeof base !== 'string' || base === '' || typeof target !== 'string') return false
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 纯函数策略判定：给定「谁 × 写哪 × 保护根 × 配置」，返回 reason 或 `undefined`（放行）。
 *
 * @param toolName 工具名（只有 `write` / `edit` 会被判定）
 * @param target 绝对路径（未解析的原始串由调用方 `resolve`）
 * @param identity `{ member, role, name }` —— **非本 Team 成员一律不接管**（不误伤别的项目）
 * @param protectedRoots `[{ id, base }]`
 * @param config `{ writers: [] }` —— 白名单成员名
 */
export function decide({ toolName, target, identity, protectedRoots, config = {} }) {
  if (toolName !== 'write' && toolName !== 'edit') return undefined
  if (typeof target !== 'string' || target === '') return undefined

  let hit
  for (const root of protectedRoots) {
    if (typeof root?.base !== 'string' || root.base === '') continue
    // 「根本身被写」也算命中（否则可以删/覆盖整个技能根目录描述文件）
    if (resolve(target) === resolve(root.base) || under(root.base, target)) {
      hit = root
      break
    }
  }
  if (hit === undefined) return undefined // ④ 受保护根之外：一律不拦

  // 不是本 Team 成员 ⇒ 不接管（正是"不误伤别的项目"那条）
  if (identity?.member !== true) return undefined
  if (identity.role === 'lead') return undefined // ① Lead 恒允许

  const writers = Array.isArray(config.writers) ? config.writers : []
  if (identity.name !== undefined && writers.includes(identity.name)) return undefined // ③ 白名单

  // ② 默认拒绝
  const who = `${identity.role ?? '?'}:${identity.name ?? '?'}`
  return [
    `上游技能根写保护（**误操作护栏，不是安全边界**）：${who} 未在 guard.writers 里授权写「${hit.id}」→ ${target}。`,
    `补救：把它加进配置 guard.writers，或设 $${ENV.disable} 指向的文件（建文件即停药）。`,
    '⚠️ 本护栏**只覆盖 write/edit 两个工具名**；用 shell 写盘（pwsh / Set-Content / node -e / 任何外部进程）' +
      '**不会经过它**，所以它拦的是"手滑"，不是"有心"。',
  ].join(' ')
}

/** 受保护根列表：上游根（含 extraRoots）+ 配置里额外的。**由 config 决定，不硬编码。** */
export function protectedRootsOf(paths) {
  const roots = [
    { id: 'upstream', base: paths.upstream.root },
    ...paths.upstream.extraRoots.map((base, i) => ({ id: `upstream-extra-${i + 1}`, base })),
    ...paths.guard.extraProtected.map((base, i) => ({ id: `guard-extra-${i + 1}`, base })),
  ]
  return roots.filter((r) => typeof r.base === 'string' && r.base !== '')
}

/** 药停文件是否在场（逐次读盘 ⇒ 建文件即生效，不需要重载插件）。 */
export function disabledNow(env = process.env) {
  const file = env[ENV.disable]
  if (typeof file !== 'string' || file === '') return false
  return existsSync(file)
}

/**
 * 注册 guard（**返回 disposer**；不在这里 `ctx.effect`，由 index.js 统一管生命周期）。
 * @returns `{ok, why, disposer}` —— 失败**不抛**（插件加载失败会连累整个 profile）
 */
export function registerGuard(ctx, { paths, log = () => {} }) {
  const roots = protectedRootsOf(paths)
  const stats = { evaluated: 0, allowed: 0, denied: 0, skippedOther: 0 }
  const guard = (exec) => {
    try {
      const toolName = exec?.name
      const raw = exec?.arguments !== null && typeof exec?.arguments === 'object' && 'file_path' in exec.arguments
        ? exec.arguments.file_path
        : undefined
      if (toolName !== 'write' && toolName !== 'edit') return undefined
      if (typeof raw !== 'string' || raw === '') return undefined
      const target = resolve(raw)

      // ① 先判"在不在受保护根内" —— 不在就**连日志都不写**（不给别的项目制造噪音）
      let hit
      for (const root of roots) {
        if (target === resolve(root.base) || under(root.base, target)) {
          hit = root
          break
        }
      }
      if (hit === undefined) return undefined

      stats.evaluated += 1
      if (disabledNow()) {
        stats.allowed += 1
        log(`GUARD-DISABLED tool=${toolName} target=${target}（药停文件在场）`)
        return undefined
      }

      // ② 身份：`exec.agent` → roster membership
      //    实测（authority-probe）：**global 层的 guard 回调里也能拿到 `exec.agent`**，
      //    所以只需注册一处就能按身份收窄，不必给每个 agent 单独注册。
      let identity = { member: false }
      try {
        const team = ctx.get('agentTeams')
        const m = typeof team?.tryMembership === 'function' ? team.tryMembership(exec?.agent) : undefined
        // ★★ **`role:'lead'` 的伪行不能当 Lead 信**（2026-09-14 / Round 80 修的真缺陷）。
        //
        // 【缺陷现场】底座 `types/roster.js` 有**两处**返回 `{role:'lead', name:'lead'}`：
        //   · `:81` —— **非 roster 的直接子 agent**（*"A direct child outside the durable
        //     roster is not a teammate"*）⇒ **伪行**
        //   · `:90` —— **真正的 Team root**
        //   两处的 `role` 与 `name` **完全一样** ⇒ 分不出来。
        //   ⇒ 而下面 `decide()` 的 **`:69` 写着 `if (identity.role === 'lead') return undefined`
        //     （"① Lead 恒允许"）** —— 于是**任何一个非 roster 的直接子 agent 都拿到"Lead 恒允许"**，
        //     **一次都没被 guard 拦过**。
        //   ⚠️ 这正是本 guard 最该防的那件事：它的存在意义是"**防止成员误写上游技能根**"，
        //     而伪行让它对一整类 agent **完全失效**（且**日志上看起来是"Lead 被放行"，完全合理**）。
        //
        // 【判据：怎么区分】伪行**必然带 parent**（底座 `:68-82` 那条分支的前提是
        //   `session.header.parentSession !== undefined`）；真 root 走 `:90`（`parentSession === undefined`）。
        //   ⇒ **有 parent ⇒ 不是 root ⇒ 不许享受"Lead 恒允许"**。
        const parentOf = exec?.agent?.session?.header?.parentSession
        if (m !== undefined) {
          if (m.role === 'lead' && parentOf !== undefined) {
            // 伪行：**降级成"非成员"**（⇒ 走 `:68` 的"不接管"分支，与"不是本 Team 成员"同待遇）
            //   ⚠️ 这里**不拒绝写入**，只是**不再给它 Lead 的豁免** —— guard 依然是"误操作护栏"口径。
            identity = { member: false, pseudoLead: true, name: m.name }
            log(`GUARD-PSEUDO-LEAD agent=${exec?.agent?.id ?? '?'} parent=${parentOf}（roster.js:81 的伪 lead 行 ⇒ 不适用"Lead 恒允许"）`)
          } else {
            identity = { member: true, role: m.role, name: m.name }
          }
        }
      } catch (err) {
        log(`GUARD-MEMBERSHIP-ERR err=${err?.message}`)
      }

      const reason = decide({
        toolName,
        target,
        identity,
        protectedRoots: roots,
        config: { writers: paths.guard.writers },
      })
      if (reason === undefined) {
        stats.allowed += 1
        log(`GUARD-ALLOW tool=${toolName} who=${identity.role ?? '-'}:${identity.name ?? '-'} target=${target} root=${hit.id}`)
      } else {
        stats.denied += 1
        log(`GUARD-DENY tool=${toolName} who=${identity.role ?? '-'}:${identity.name ?? '-'} target=${target} root=${hit.id}`)
      }
      return reason
    } catch (err) {
      // 出错**不拦**（fail-open）：宁可漏一次手滑，也不许把自己锁死在"什么都写不了"
      log(`GUARD-ERROR err=${err?.message}`)
      return undefined
    }
  }

  try {
    const disposer = ctx.tools.guard(guard)
    log(`GUARD-REGISTER-OK roots=[${roots.map((r) => `${r.id}=${r.base}`).join(' | ')}] writers=${JSON.stringify(paths.guard.writers)} disableFile=${process.env[ENV.disable] ?? '(unset)'}`)
    return { ok: true, why: 'ok', disposer, stats, roots }
  } catch (err) {
    log(`GUARD-REGISTER-FAIL err=${err?.message}`)
    return { ok: false, why: err?.message ?? String(err), stats, roots }
  }
}

/** 只读：把当前配置下的护栏覆盖面报出来（供 `--status`）。 */
export function describe(paths) {
  return {
    enabled: paths.guard.enabled,
    coverTools: ['write', 'edit'],
    bypassableBy: ['pwsh', 'node -e', '任何 shell 写盘', '任何外部进程'],
    roots: protectedRootsOf(paths).map((r) => r.id),
    writers: paths.guard.writers,
    disableFile: process.env[ENV.disable] ?? null,
    honesty: '误操作护栏，非安全边界（P-15/P-16）',
  }
}
