/**
 * fork.js —— **fork provider**：把"某个成员自己那一份技能工作副本"注册进**它自己的 scope**。
 *
 * 模型（委托方 P-17 定的，不是我们的发明）：**上游 = 前辈 / fork = 它自己的工作副本 / PR = 沉淀通道**。
 *  · 上游 = 6 个公共磁盘根（`dsh-skill-filesystem:150-188`），只有 Lead / PR 合并能改；
 *  · fork = **只存差异**（改过/新增的条）。**没改的条根本不在 fork 层里** ⇒ 由上游层提供 ⇒
 *    **上游一更新，它就自动跟着变，零同步动作**（`TWO-CHANNEL-DELIVERY.md` §A.3 实测胜负手）；
 *  · 合并语义 = **nearest layer wins outright**，rank 只在同层内比
 *    （`dsh-skill:109-115` 文档 + `:298-311 collectFresh` 逐层 `merged.set`）。
 *
 * ⚠️ **一条必须写死的设计纪律**（P-18）：**fork 绝不能"复制全量上游"**。
 * 一旦复制，未改的条就变成 fork 层的静态副本，**上游再改它就不跟了** —— A-3 立刻失效。
 * 所以本文件的 `list()` **只读 fork 目录**，绝不去"把上游合并进来"。
 *
 * 时机：**唯一有效窗口是 `agent/created`**（第一个提示词装配之前；
 * `dsh-agent-loop:890` 先 `assemble()`、`:894` 才发 `agent/pre-step`）—— 见 index.js。
 *
 * ⚠️ 两个实测坑（写在代码里，不写在文档里）：
 *  ① `agent/created` 是**同步 emit**，监听器抛错会**否决 agent 发布**
 *     （`dsh-agent\lib\types\runtime-types.d.ts` "Synchronous listener failure vetoes publication"）
 *     ⇒ 本模块的入口一律 try/catch，**任何情况下不向外抛**。
 *  ② **身份必须读 `tryMembership(agent).name`，且只在 `role==='teammate'` 时信**
 *     —— 对**不在 roster 里**的子 agent，`tryMembership` 会返回伪行 `{role:'lead',name:'lead'}`
 *     （`dsh-experimental-agent-team/lib/index.js:411-417`，实测于 task-37 §8）。
 *     不纠正就会把 persona/provider 装到**无关的 subagent** 上（`LANDMINES §10.3` 的假阴性同族）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { forkRootFor } from './config.js'
import { installSkill, isSkillName, parseSkill } from './skills.js'

/**
 * 造一个 fork provider（**每次调用都重新现扫 fork 目录** —— 不缓存，
 * 与 `dsh-skill-filesystem:93-108` 的"每次读都现扫磁盘"同形；
 * 这样成员用任何工具改自己的 fork 都当场生效）。
 *
 * `list()` 返回的形状必须过 `dsh-skill:451-464 validateCandidate` 的校验：
 * `name` 必须匹配 kebab-case、`rank` 必须是有限数、`provider` 必须**等于注册时的 name**、
 * `source` 必须是字符串、`invocation` 必须两个布尔都给。
 */
export function makeForkProvider({ name, forkDir, rank, skillFileName = 'SKILL.md' }) {
  const readEntry = (dirName) => {
    const file = join(forkDir, dirName, skillFileName)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseSkill(text)
    if (!parsed.hasFrontmatter) return undefined
    const skillName = parsed.meta.name ?? dirName
    if (!isSkillName(skillName)) return undefined
    return {
      name: skillName,
      description: parsed.meta.description ?? '(no description)',
      ...(parsed.meta.whenToUse === undefined ? {} : { whenToUse: parsed.meta.whenToUse }),
      body: parsed.body,
      file,
    }
  }

  return {
    name,
    async list() {
      const out = []
      let entries
      try {
        entries = readdirSync(forkDir, { withFileTypes: true })
      } catch {
        // fork 目录不存在 = 该成员没改过任何东西 = **合法的空 fork**（overlay 全靠上游）
        return out
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        const got = readEntry(e.name)
        if (got === undefined) continue
        out.push({
          name: got.name,
          description: got.description,
          ...(got.whenToUse === undefined ? {} : { whenToUse: got.whenToUse }),
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'fork',
          provider: name,
          rank,
          locator: got.file,
          path: got.file,
        })
      }
      return out
    },
    async get(candidate) {
      const file = typeof candidate?.locator === 'string' ? candidate.locator : candidate?.path
      if (typeof file !== 'string') return undefined
      const text = readFileSync(file, 'utf8')
      const parsed = parseSkill(text)
      return {
        name: candidate.name,
        description: parsed.meta.description ?? candidate.description,
        ...(parsed.meta.whenToUse === undefined ? {} : { whenToUse: parsed.meta.whenToUse }),
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'fork',
        provider: name,
        content: parsed.body,
        path: file,
        // 不给 resourceBase ⇒ DSH 打印 "managed by provider"（`dsh-skill:71-81`）。
        // 给 `{kind:'directory'}` 会**把 fork 目录的绝对路径交给模型** ——
        // 那正好是 P-16 想避免的"把可改对象暴露给它的认知"；而这里我们**要**它知道
        // 自己那份在哪（通知里给路径）。两处口径分开：通知给路径（有明确目的），
        // 技能加载输出不给（省 token，且不给无关的绝对路径）。
      }
    },
  }
}

/**
 * 装 fork 到**一个** agent 自己的 scope。
 * @returns `{ok, why, disposer, added}` —— 失败**不抛**（`agent/created` 的同步语义要求）。
 */
export function installForkFor(agent, { paths, name, rank, skillFileName, createDirs }, log = () => {}) {
  const member = memberNameOf(agent)
  if (member === undefined) return { ok: false, why: 'not-a-roster-teammate（身份不明确，不装）' }
  // ✅ **task-57 的"按 agent 定落点"已经接线完成**（2026-09-14 更正本段注释）。
  //
  // 【原注释说的是什么】它原来写着「这里**本应**改成按 agent 的 `session.header.cwd` 定 fork 落点…
  //   因为 `index.js` 当前由 task-58 占用，**本轮不改** ⇒ 现状 = "串台仍未修"」。
  //
  // 【为什么这段注释现在是错的】接线**不是改这一行**，而是**由调用方喂 per-agent 的 `paths`**：
  //   · `index.js` 用 `pathsForAgent(paths, agent)` 算出 `agentPaths`，**同时**喂给
  //     `installForkFor({paths: agentPaths, …})`（`index.js:683`）**与** `makeNotifier({paths: agentPaths, …})`（`:727`）
  //     ⇒ 两处**同源**，正是原注释里说的"必须同批落地"。
  //   · 所以本函数**只认它收到的 `paths`**（`forkRootFor(paths, member)`）—— 这是**对的**：
  //     落点由**调用方**用哪个 `paths` 决定，单点开关在 `pathsForAgent`。
  //   · 真宿主读数：`FORK-REGISTER-OK … dir=D:\dsh\omc-agent-teams\.teamkit\forks\6ac4f43a\coo\skills`
  //     —— 含 **team 层**（Round 14 加的），**证明**落点是按 agent（含其 Team）算出来的，不是全局一份。
  //   · 另：`notify.js` 的 `tracked` 读数在真宿主里已能非零（Round 18 起有 `UPSTREAM-CHANGED` / `INJECT`）。
  // ⇒ 结论：**这里不需要改动**；原注释是"计划态"残留，已被后续轮次实现并验证。
  const forkDir = forkRootFor(paths, member)
  if (createDirs) {
    try {
      mkdirSync(forkDir, { recursive: true })
    } catch (err) {
      log(`FORK-MKDIR-FAIL member=${member} dir=${forkDir} err=${err?.code ?? err?.message}`)
      return { ok: false, why: `mkdir 失败：${err?.code ?? err?.message}` }
    }
  }
  let svc
  try {
    // ⚠️ `agent.ctx.skills` 属性访问会被 cordis 的 inject 守卫拦掉
    // （`cannot get property "skills" without inject`，task-32 实测）
    svc = agent?.ctx?.get?.('skills')
  } catch (err) {
    return { ok: false, why: `ctx.get(skills) 抛错：${err?.message}` }
  }
  if (svc === undefined || typeof svc.registerProvider !== 'function') {
    return { ok: false, why: 'no registerProvider（skills 服务未就绪）' }
  }
  try {
    const disposer = svc.registerProvider(() => makeForkProvider({ name, forkDir, rank, skillFileName }))
    log(`FORK-REGISTER-OK member=${member} agent=${agent?.id} provider=${name} dir=${forkDir}`)
    return { ok: true, why: 'ok', disposer, dir: forkDir, member }
  } catch (err) {
    // 重名 provider（同一 scope 注册两次）会抛 —— 这是**要看见的失败**，不许静默
    log(`FORK-REGISTER-FAIL member=${member} agent=${agent?.id} err=${err?.message}`)
    return { ok: false, why: `registerProvider 抛错：${err?.message}` }
  }
}

/**
 * 读一个 agent 的 roster 成员名。**只在 `role === 'teammate'` 时返回名字。**
 * @returns 名字或 `undefined`
 */
export function memberNameOf(agent) {
  try {
    const team = agent?.ctx?.get?.('agentTeams')
    if (team === undefined || typeof team?.tryMembership !== 'function') return undefined
    const m = team.tryMembership(agent)
    if (m === undefined || m.role !== 'teammate') return undefined
    return typeof m.name === 'string' ? m.name : undefined
  } catch {
    return undefined
  }
}

/** 成员是否在 `fork.members` 名单里（`'*'` = 全部 teammate）。 */
export function memberSelected(members, name) {
  if (!Array.isArray(members) || members.length === 0) return false
  if (members.includes('*')) return true
  return members.includes(name)
}

/**
 * 把一条上游技能**带进** fork 目录（"我要改它"的起点）。
 * 为什么需要它：fork 只存差异 ⇒ 新成员要改某条时，得先把上游那版拿过来当起点。
 * `teamkit fork-init <member> <skill>` 用它。
 *
 * ⚠️ **task-57 裁定（Lead）：本函数保持"全局落点"，但必须留可见信号。**
 * 理由：这是**离线 CLI 路径**（`fork-init`），**没有 agent** ⇒ 拿不到 `session.header.cwd`，
 * 没法按项目分。而 `forkRootForAgent` 在无 cwd 时的行为是**静默回落全局** ——
 * 在这里"静默"是**危险的**：用户会以为"给某个项目的成员播了种"，其实播到了**全局** fork 根。
 * ⇒ 本函数**不猜**、也不静默：无 cwd 上下文时**显式打一行** `FORK-SEED-GLOBAL`。
 * ⇒ 也**不改落点**（要保持现状，用调用方传进来的 `paths` 的全局 fork 根）。
 *
 * ⚠️ **为什么不能在这里按 agent 分**：`installForkFor` 拿到的是**活 agent 对象**（有 session.header）；
 * `seedFork` 拿到的只有**字符串 member 名**。要按项目播，只能由**调用方**给上下文
 * （例如给 CLI 加 `--cwd`）—— 那是**新功能**，不在本任务范围（`STATE-LOCATION.md` §6 已列为待裁定）。
 *
 * @returns `{ok, why, file}`
 */
export function seedFork(paths, member, skillName, log = () => {}) {
  const forkDir = forkRootFor(paths, member)
  // **可见信号（判据 4）**：本路径没有 agent/cwd 上下文 ⇒ 明说"这次播种用的是全局 paths"。
  // 这条**不是**调试噪音：它是"离线路径只作用于全局"的唯一运行时证据（`--help`/README 里也写了）。
  log(`FORK-SEED-GLOBAL member=${member} dir=${forkDir}（离线路径没有 agent ⇒ 播种作用于**全局** fork 根，不按项目分；要按项目分见 STATE-LOCATION.md §6）`)
  const src = join(paths.upstream.root, skillName, 'SKILL.md')
  if (!existsSync(src)) return { ok: false, why: `上游没有这条：${src}` }
  const dst = join(forkDir, skillName, 'SKILL.md')
  mkdirSync(join(forkDir, skillName), { recursive: true })
  const r = installSkill({ name: skillName, file: src }, forkDir, { overwrite: true })
  log(`FORK-SEED member=${member} skill=${skillName} action=${r.action} file=${dst}`)
  return { ok: r.action !== 'failed', why: r.why ?? r.action, file: dst }
}
