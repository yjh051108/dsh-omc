/**
 * release-tools.js —— 把**成员释放**暴露成**可调用的工具**（2026-09-14 / Round 34）。
 *
 * ## 为什么单独一份
 * `lib/release.js` 是**机制**（包 `journal.state` + 台账）；但**能调用它的人**才是交付。
 * Round 33 只做了机制 ⇒ 宿主日志里只有 `RELEASE-OFF`，**没人能调**。
 * 本文件把 `list_zombies` / `release_member` / `unrelease_member` 注册成真工具。
 *
 * ## 三条与别的工具不同的设计
 * 1. **默认不注册**（`memberRelease.enabled=false` 时一个工具都不出现）——
 *    破坏性能力**不该出现在不了解它的会话里**（减少误用面）；
 * 2. **`release_member` 强制 `reason`**（schema 里 `required: true`）——
 *    把"说明是硬门"从**代码判断**再提前到**schema 层**（模型连调用都构造不出来）；
 * 3. **`list_zombies` 只读**，先"看得见"再"决定释放谁"（零风险，可单独先开）。
 *
 * ⚠️ **谁能调**：工具注册在**插件 apply 的那个 ctx** 上 ⇒ 同进程内**所有 agent scope 都看得见**
 * （除非别处 `tools.restrict` 掉）。释放是**团队级**动作，所以这是有意为之；
 * 但**它不是"仅 Lead 可调"** —— 底座没有"工具级角色门"，这一点**必须如实写进 README**。
 *
 * ## ★★ **绝不用裸导入**（2026-09-14 / Round 40 修的一处自造回归）
 * 本文件曾经写着 `import { defineTool } from '@deepseek-ai/dsh-tools'` ——
 * **那是整个插件里唯一的裸依赖**（其余全是 `node:` 内置 + 相对导入）。
 * 为什么它有毒（与 `LANDMINES §1` 的事故同一个机理）：
 *   · `link:`/junction 装法下，Node 按**真实路径**解析 ⇒ 裸导入会去**插件目录往上**找；
 *   · 本机上它**恰好能找到**（全局 npm 路径在祖先链上）⇒ 所以"没炸"；
 *   · **但换一台机器 / 换一种装法就找不到** ⇒ 而那正是 LANDMINES §1 里
 *     `ERR_MODULE_NOT_FOUND … imported from <vendor 路径>` 的形态。
 * ⇒ **判据：插件的 `lib/**.js` 里只允许 `node:` 内置与相对导入**（`H12` 组盯着）。
 * ⇒ 替代做法：**手写 definition**（`parameters` 直接给 JSON Schema）——
 *   我实测过 `tools.register(手写 definition)` **成功**，不需要 `defineTool`。
 */
import { existsSync } from 'node:fs'

/**
 * ★ **把 `defineTool` 的简写参数表转成 JSON Schema**（本地实现，**不裸导入**）。
 *
 * 为什么自己写：`defineTool` 在 `@deepseek-ai/dsh-tools` 里，而**裸导入会破坏"从任意路径可加载"**
 * （见文件头那段）。它的转换规则很简单（我照 `dsh-tools` 的
 * `parameterSchemaSpecToJsonSchema` 的语义实现，只覆盖我们这 4 个字段的用法）：
 *   `{ name: { type, description, required? } }` ⇒
 *   `{ type:'object', additionalProperties:false, properties:{…}, required:[…] }`
 *
 * ⚠️ **只支持我们实际用到的**（`type` / `description` / `required` / `items`）；
 *    需要更复杂的东西时**先补转换器**，别默默退化成"schema 少了一个约束"。
 */
function paramsToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, v] of Object.entries(spec ?? {})) {
    const p = { type: v.type ?? 'string' }
    if (v.description !== undefined) p.description = v.description
    if (v.items !== undefined) p.items = v.items
    if (v.additionalProperties !== undefined) p.additionalProperties = v.additionalProperties
    properties[key] = p
    if (v.required === true) required.push(key)
  }
  const out = { type: 'object', additionalProperties: false, properties }
  if (required.length > 0) out.required = required
  return out
}

/** 文本结果（工具输出统一形态）。 */
const textOut = (schemaProps = {}) => ({
  schema: { type: 'object', additionalProperties: true, properties: schemaProps },
  render: (args, value) => {
    const lines = []
    if (Array.isArray(value?.lines)) lines.push(...value.lines)
    else if (typeof value?.text === 'string') lines.push(value.text)
    else lines.push(JSON.stringify(value, null, 2))
    return [{ type: 'text', text: lines.join('\n') + '\n' }]
  },
})

/**
 * ★ **把"调用方 agent"映射成它所属 Team 的 root**（2026-09-14 / Round 36）。
 *
 * 为什么要这一步：`release` 的过滤必须**以 Team 为界**（同名成员在别的 Team 里不该受影响）。
 *   `exec.agent` 是**调用方**（可能是 Lead，也可能是某个成员）。
 *   `journal.state(x)` 只认**确切的 Team Lead** ⇒ 要把调用方解析成那个 Lead。
 *
 * **候选列表**（LANDMINES §4：别用单一算法），全部失败 ⇒ 返回 `undefined`（让 `release` 拒绝）：
 *   ① 调用方自己就是 Lead（`state(agent)` 不抛且 members 里有它自己）⇒ 用它；
 *   ② `roster.membership(agent)` / `tryMembership` 能给出所属 root ⇒ 用之；
 *   ③ `agents.list()` 里找 `name==='lead'` 的（同 Team 只有一个 Lead）⇒ 用能读通的那个。
 *
 * ⚠️ **宁可返回 undefined 也不猜**：猜错 = 释放到**别人的 Team** 里（比"没释放"糟得多）。
 */
export function resolveTeamRoot(caller, { agentTeams, agents, log = () => {}, allowEmptyTeam = false } = {}) {
  if (!caller) return undefined
  const journal = agentTeams?.journal
  if (!journal) return undefined
  /**
   * ★ **确定性 root 判据**（R96 / task-63 修）—— 分**两段**，这是本函数的**核心设计**：
   *
   * **第一段：身份**（怎么知道"这个 agent 是某个 Team 的 Lead"）
   *   ① `journal.state(a)` **读得通**（不抛）—— 只排除"投影没注册"；
   *   ② 底座自己认它是 lead（`tryMembership(a).role === 'lead'`）；
   *   ③ **没有 parent**（`parentSession === undefined`）—— R80 教训：底座对"非 roster 的直接子 agent"
   *      也返回伪 `{role:'lead',name:'lead'}`，**只能靠有没有 parent 区分** ⇒ **有 parent 的不是 root**。
   *   ⚠️ 光"读得通"是**不够**的（`lead` 实测已证）：真 teammate 的 `state()` **也不抛** ⇒
   *     "不抛即可"会把**队友**当成自己的 root ⇒ **必须加上 ②③**。
   *
   * **第二段：团规模闸门**（`allowEmptyTeam`，**默认 `false`**）
   *   `false`（默认）⇒ **保留旧语义**：`members.length > 0` 才算（**破坏性工具用这条**）；
   *   `true`          ⇒ **空公司也认**（**读型工具用这条**）。
   *   ⚠️ **为什么默认保持严格**（`lead` 的裁决 + 我认同，理由落盘）：
   *     · `release_member` 是**破坏性**工具：空公司里**本来没有成员可释放** ⇒ **放宽的实用收益 ≈ 0**；
   *       而放宽的代价是"在一个还没有成员的 Team 上写了释放台账"——
   *       那条记录**会在该名字将来真的加入时立刻生效**（把新成员**直接隐身**）⇒ **延迟生效的脚枪**。
   *     · `team_structure` 等**读型**工具：放宽后只是"读到一个空列表"，**不会改任何东西** ⇒ **零风险**。
   *   ⇒ **读 / 写风险不对称** ⇒ **判据分开**，由调用方**显式**声明要用哪一档（不隐式放宽）。
   */
  const readState = (a, { allowEmptyTeam }) => {
    if (a === undefined) return undefined
    let st
    try {
      st = journal.state(a)
    } catch {
      return undefined // 读不通 ⇒ 不是 Team 会话 / 投影没注册
    }
    if (!Array.isArray(st?.members)) return undefined
    // ② 底座自己认不认它是 lead
    let m
    try {
      m = agentTeams?.roster?.tryMembership?.(a) ?? agentTeams?.tryMembership?.(a)
    } catch {
      m = undefined
    }
    if (m?.role !== 'lead') return undefined
    // ③ ★ 有 parent 的不是 root（R80：伪 lead 行）—— 这条挡住"把队友当 Team"
    if (a?.session?.header?.parentSession !== undefined) return undefined
    // 第二段：团规模闸门（默认严；读型可显式放宽）
    if (allowEmptyTeam !== true && st.members.length === 0) return undefined
    return st
  }
  /** 这个 agent 是不是 root（`readState` 的布尔版，语义同一个）。 */
  const isRoot = (a, opts) => readState(a, opts) !== undefined
  const defaultOpts = { allowEmptyTeam: allowEmptyTeam === true }
  // ① 调用方自己能不能当 root
  if (isRoot(caller, defaultOpts)) return caller
  // ② 用 membership 找它所属的 root
  try {
    const m = agentTeams?.roster?.membership?.(caller) ?? agentTeams?.roster?.tryMembership?.(caller)
    const r = m?.root ?? m?.lead ?? m?.team?.root
    if (r !== undefined && isRoot(r, defaultOpts)) return r
  } catch {
    /* 继续 */
  }
  // ③ 从所有 agent 里找 Lead，用**能读通**的那个（且成员里含调用方名，作为消歧依据）
  const name = caller?.name ?? caller?.session?.header?.name
  let list = []
  try {
    list = agents?.list?.() ?? []
  } catch {
    list = []
  }
  const leads = list.filter((a) => (a?.session?.header?.name ?? a?.name) === 'lead')
  for (const lead of leads) {
    const st = readState(lead, defaultOpts)
    if (st === undefined) continue
    // 判据：调用方（或其名字）在这份名单里 ⇒ 是同一个 Team
    if (name === 'lead' || st.members.some((m) => m?.name === name || m?.id === caller?.id)) return lead
  }
  // 只有一个 Lead 读得通时，用它（**并说明这是兜底**）
  const readable = leads.filter((a) => isRoot(a, defaultOpts))
  if (readable.length === 1) {
    log('RELEASE-ROOT-FALLBACK 只有一个可读 Lead ⇒ 用它当 root')
    return readable[0]
  }
  log(`RELEASE-ROOT-UNRESOLVED caller=${name ?? '(无名)'} readableLeads=${readable.length}`)
  return undefined
}

/**
 * 注册三个工具。**只在 `memberRelease.enabled === true` 时调用。**
 *
 * @param ctx  宿主插件 ctx（要有 `tools`）
 * @param opts.release   `makeReleaseManager(...)` 的返回值
 * @param opts.agentTeams 宿主的 `agentTeams`（`list_zombies` 要用）
 * @param opts.cfg       `paths.memberRelease`
 * @param opts.log
 * @returns `{ disposers, names }`（**可卸净**：每个工具一个 disposer）
 */
export function registerReleaseTools(ctx, { release, agentTeams, agents, cfg, selfWriteDeps, log = () => {} }) {
  const disposers = []
  const names = []
  // ★ **两个闸门**：只读的 `list_zombies` 与破坏性的两个写工具**分开**。
  //   为什么分：把"看得见"和"能动手"绑在一起 ⇒ 用户**想看有没有僵尸**就得先开破坏性能力
  //   ⇒ 与"先看得见、再决定动谁"的设计正好相反（我 Round 34 第一版就这么错了）。
  const destructive = cfg?.enabled === true
  const readonly = cfg?.readonlyTools !== false

  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    log('RELEASE-TOOLS-SKIP ctx.tools.register 不可用（宿主变了？）')
    return { disposers, names }
  }

  const reg = (definition) => {
    try {
      // ★ **不裸导入 `defineTool`**：自己把 `parameters` 转成 JSON Schema 再注册
      //   （实测 `tools.register(手写 definition)` 成功 ⇒ 不需要那个包）。
      const full = { ...definition, parameters: paramsToJsonSchema(definition.parameters) }
      const d = ctx.tools.register(full)
      disposers.push(d)
      names.push(definition.name)
      log(`RELEASE-TOOL-OK name=${definition.name}`)
    } catch (err) {
      // **失败不静默**：说清楚是哪个工具没装上、为什么
      log(`RELEASE-TOOL-FAIL name=${definition.name} why=${err?.message ?? err}`)
    }
  }

  // ── ① list_zombies（**只读**；`readonlyTools!==false` 就注册）──────────────
  if (readonly) {
    reg({
    name: 'list_zombies',
    description:
      '列出 Team 里"看得见、用不了、还占名额"的成员（只读，不改任何东西）：' +
      'phase=failed 的、以及长期没有活动的。' +
      '用它先看清"该释放谁"，再决定要不要调 release_member。',
    parameters: {
      staleAfterMinutes: {
        type: 'number',
        description: `多久没活动算"闲置"（默认 ${cfg?.staleAfterMinutes ?? 30}）。`,
      },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    async execute(args) {
      const stale = Number.isFinite(args?.staleAfterMinutes) ? args.staleAfterMinutes : cfg?.staleAfterMinutes
      const lines = []
      const { listZombies, readTeamMembers } = await import('./release.js')
      // **成员怎么拿**：`journal.state(root)` 要**确切的 Team Lead**；而 `ctx.get('agents')` 能列出
      // 所有 agent ⇒ **从中找 `name==='lead'` 的那个当 root**（真宿主里这条路走通，见 Round 34）。
      const found = readTeamMembers(agentTeams, { agents })
      if (!found.ok) {
        lines.push(`**未获取**：拿不到 Team 名单 —— ${found.why}`)
        lines.push('（这是诚实边界，不是"没有僵尸"。请在 Lead 会话里调，或先确认 agentTeams service 可用。）')
        return { lines }
      }
      const r = listZombies(agentTeams, { members: found.members, staleAfterMinutes: stale })
      if (r.zombies.length === 0) {
        lines.push(`没有发现僵尸成员（扫了 ${r.scanned} 个：${found.members.map((m) => m?.name).join(', ')}）。`)
      } else {
        lines.push(`发现 ${r.zombies.length} 个占名额但用不了的成员：`)
        for (const z of r.zombies) lines.push(`- ${z.name}（${z.id}）phase=${z.phase} —— ${z.why}`)
        lines.push('')
        lines.push('要释放：`release_member { name, reason }`（**必须写理由**）。')
        lines.push('⚠️ 释放后**名字不可复用** ⇒ 再招人要换新名。')
      }
      if (r.note) lines.push(`（注：${r.note}）`)
      return { lines }
    },
  })
  }  // ← 收 `if (readonly) {` 块（漏了这个 ⇒ `Unexpected end of input`；自测 `--check` 当场抓到）

  // ── ② release_member（**破坏性**；`reason` 在 schema 层就是 required）──────
  if (destructive) reg({
    name: 'release_member',
    description:
      '释放一个成员：名单不再列出它、**名额真的释放**、发给它会找不到。' +
      '⚠️ 这是破坏性动作，且**日志里抹不掉**（event-sourced）。**必须写 reason**。' +
      '⚠️ 释放后**名字不可复用**，再招人要用新名字。',
    parameters: {
      name: { type: 'string', required: true, description: '要释放的成员名（`list_agents` 里的 name）。' },
      reason: {
        type: 'string',
        required: true,
        description: '为什么释放它（**必填**：这是给对方也是给未来的你留的记录）。',
      },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    // ★★ **必须拿到"调用方是谁"**（`exec.agent`）—— 2026-09-14 / Round 36 修的真外溢 bug：
    //   第一版按**全局名字**过滤 ⇒ 实测 A 队（standard）与 B 队（omc）**都有 `engineer`**，
    //   释放一个会**连带**把另一个也拿掉（违反"其它 preset 不受影响"）。
    //   ⇒ 现在要求"能确定是哪个 Team"，否则**拒绝**（`code=2`，失败不静默）。
    async execute(args, exec) {
      const caller = exec?.agent
      const root = resolveTeamRoot(caller, { agentTeams, agents, log })
      const label = root ? `${root.name ?? root.session?.header?.name ?? root.id}` : '(未获取)'
      const r = release.release(args?.name, args?.reason, root)
      const lines = []
      if (r.ok) {
        lines.push(
          r.already
            ? `${args.name} 在 Team「${label}」里之前就已经释放过了（幂等，无需重复）。`
            : `已在 Team「${label}」里释放 ${args.name}。`,
        )
        lines.push('判据：`list_agents` 里不再出现它；名额已释放（可以招新人）。')
        lines.push('⚠️ 名字不可复用 —— 再招人要换新名。')
        lines.push('⚠️ **只影响这一个 Team**（同名成员在别的 Team 里不受影响）。')
      } else {
        lines.push(`释放失败（code=${r.code}）：${r.why}`)
      }
      return { lines, code: r.code ?? 1 }
    },
  })
  // ── ③ unrelease_member（**误操作回退**，幂等；破坏性一档）─────────────────
  if (destructive) reg({
    name: 'unrelease_member',
    description: '撤销一次释放（误操作回退）：把人放回名单。只影响调用方所在的 Team。幂等。',
    parameters: {
      name: { type: 'string', required: true, description: '要放回的成员名。' },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    async execute(args, exec) {
      const root = resolveTeamRoot(exec?.agent, { agentTeams, agents, log })
      const r = release.unrelease(args?.name, root)
      const lines = []
      if (r.ok) {
        lines.push(
          r.already
            ? `${args.name} 本来就不在已释放名单里（幂等）。`
            : `已把 ${args.name} 放回名单。`,
        )
      } else {
        lines.push(`撤销失败（code=${r.code}）：${r.why}`)
      }
      return { lines, code: r.code ?? 1 }
    },
  })

  // ── ④⑤ **"写我自己的那几份"**（**宿主侧代写** —— 2026-09-14 / Round 48–49 修的真缺陷）──
  // 【缺陷】组织资产全在 `$DSH_HOME`（**agent 工作区之外**），真 member 调 `write`：
  //   `Error: [sandbox: file access denied under workspace-write mode]`
  //   R48 只修了 SOUL ⇒ **R49 实测"原则文件"同样被拒** ⇒ 本轮**做成一个通用的**。
  // 【做法】工具体在**宿主侧**跑（不受 agent 沙箱约束）；目标**只能从白名单枚举选**，
  //   路径**由插件算**，**绝不接受调用方传路径**（这不是绕过沙箱的通用后门）。
  // ⚠️ **闸门独立**（`if (selfWriteDeps)`）—— 与 `memberRelease` 无关。
  const myIdentity = (exec) => {
    const a = exec?.agent
    if (!a) return undefined
    try {
      const team = a?.ctx?.get?.('agentTeams')
      const m = typeof team?.tryMembership === 'function' ? team.tryMembership(a) : undefined
      if (typeof m?.name !== 'string' || m.name === '') return undefined
      // ★★★ **拒绝底座的"伪 lead 行"**（2026-09-14 / Round 81 修的真缺陷 —— 这是**第三处**）。
      //
      // 【缺陷现场】底座 `types/roster.js` 有**两处**返回 `{role:'lead', name:'lead'}`：
      //   · `:81` —— **非 roster 的直接子 agent**（*"A direct child outside the durable
      //     roster is not a teammate"*）⇒ **伪行**
      //   · `:90` —— **真正的 Team root**
      //   两者 `role`/`name` **完全相同** ⇒ 只查它们分不出来。
      //
      //   ⇒ **本处的后果比前两处更重**：`resolveSelfTarget` 用 `member` 拼落点 ——
      //     `write_self {target:'soul'}` 会落到 **`soul/${member}.md`**，
      //     而伪行的 `name` 恒为字面量 **`'lead'`** ⇒
      //     **任何一个"非 roster 的直接子 agent"都能写/覆盖 `soul/lead.md`（真 Lead 自己的那份）**。
      //     实测（本机）：`resolveSelfTarget({member:'lead', target:'soul'})`
      //     ⇒ `<用户目录>\.dsh\.teamkit\soul\lead.md` = **与真 Lead 落点完全相同**。
      //     ⚠️ **2026-09-15 脱敏**：原文逐字写了本机用户名 ⇒ 改成占位符。
      //     ⇒ 这不只是"看到别人的东西"，而是**能覆盖 Lead 的自我承诺**（而 SOUL 每步注入进 Lead 的上下文）。
      //
      // 【判据：怎么区分】伪行**必然带 parent**（底座 `:68-82` 那条分支的前提是
      //   `session.header.parentSession !== undefined`）；真 root 走 `:90`（`parentSession === undefined`）。
      //   ⇒ **有 parent ⇒ 不是 root ⇒ 不认这个身份**（返回 undefined ⇒ 工具报"认不出你是谁"，不猜）。
      const parentOf = a?.session?.header?.parentSession
      if (m.role === 'lead' && parentOf !== undefined) {
        log(`SELF-WRITE-PSEUDO-LEAD agent=${a.id} parent=${parentOf}（roster.js:81 的伪 lead 行 ⇒ 不认作身份，否则会写到 soul/lead.md）`)
        return undefined
      }
      // 角色名：从角色档里按 member 名查（与 `handleAgent` 同一判据）
      let role
      try {
        const roles = selfWriteDeps?.loadRoles?.(selfWriteDeps.rolesDir)
        role = roles?.roles instanceof Map ? roles.roles.get(m.name)?.name : undefined
        // ⚠️ **失败要留痕**（我第一版这里静默 ⇒ coo 明明有角色档却报 no-role，查了半天）：
        //   把"查表用了哪个键 / 表里有没有 / 表读到几条"打出来。
        if (role === undefined) {
          log(
            `SELF-WRITE-ROLE-MISS member=${m.name} rolesDir=${selfWriteDeps?.rolesDir ?? '(空)'} ` +
              `readable=${roles?.readable} n=${roles?.roles instanceof Map ? roles.roles.size : 'n/a'} ` +
              `keys=${roles?.roles instanceof Map ? [...roles.roles.keys()].join(',') : 'n/a'}`,
          )
        }
      } catch (err) {
        log(`SELF-WRITE-ROLE-ERR member=${m.name} why=${err?.message ?? err}`)
        role = undefined
      }
      // ⚠️ **去掉死字段 `isLead`**（2026-09-14 / Round 81）：
      //   它原来写的是 `isLead: m.role === 'lead'` —— **全插件无人读它**
      //   （`grep isLead` 只命中这一处声明），且它**天然会被伪 lead 行骗到**。
      //   ⇒ 死字段 + 会被骗 = **最坏组合**：看起来"有身份判断"，实际**没有任何人用它**，
      //     而将来谁要用它，**第一眼就会掉进伪行的坑**（R73 的 H30 同族：声明了没人读；
      //     这次更进一步 —— 它不只是没用，**还立了一个错的判据在那儿等着被用**）。
      return { name: m.name, role: role ?? undefined }
    } catch (err) {
      log(`SELF-WRITE-IDENTITY-ERR why=${err?.message ?? err}`)
      return undefined
    }
  }
  if (selfWriteDeps) {
    reg({
      name: 'read_self',
      description:
        '读**你自己**的落盘文件（它们在 `$DSH_HOME`，**在工作区之外** ⇒ `read` 会被沙箱拒；这个工具在宿主侧代读）。' +
        '`target` 三选一：`soul`（我答应自己改什么）· `principles`（这类活怎么干，按角色共享）· `role-skill`（要带 `skill` 名）。',
      parameters: {
        target: { type: 'string', required: true, description: '`soul` / `principles` / `role-skill`' },
        skill: { type: 'string', description: '只有 `role-skill` 需要：技能目录名' },
      },
      output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
      async execute(args, exec) {
        const me = myIdentity(exec)
        if (me === undefined) return { lines: ['**未获取**：认不出调用者是谁（拿不到 membership.name）'], code: 1 }
        const t = selfWriteDeps.resolveSelfTarget({
          stateDir: selfWriteDeps.stateDir,
          teamkitDir: selfWriteDeps.teamkitDir,
          member: me.name,
          role: me.role,
          target: args?.target,
          skill: args?.skill,
          soulCfg: selfWriteDeps.soul,
        })
        if (!t.ok) return { lines: [`取不到落点：${t.why}`], code: 1 }
        const r = selfWriteDeps.readSelf(t.file)
        const p = String(t.file).replace(/\\/g, '/')
        if (r.text === undefined) return { lines: [`\`${args?.target}\` 目前**还没写**：\`${p}\``, '（这是正常状态。要写就用 `write_self`。）'] }
        return { lines: [`\`${args?.target}\`（\`${p}\`，sha=${r.sha}，${r.bytes} B）：`, '', r.text.trimEnd()] }
      },
    })
    reg({
      name: 'write_self',
      description:
        '把内容写进**你自己**的落盘文件（它们在 `$DSH_HOME`，**在工作区之外** ⇒ `write` 会被沙箱拒；这个工具在宿主侧代写）。' +
        '`target` 三选一：`soul` · `principles` · `role-skill`（要带 `skill` 名）。' +
        '默认**追加**；整篇重写要显式 `mode:"replace"`。写完**回读校验**。',
      parameters: {
        target: { type: 'string', required: true, description: '`soul` / `principles` / `role-skill`' },
        text: { type: 'string', required: true, description: '写什么（一条一句最好，带动作）' },
        skill: { type: 'string', description: '只有 `role-skill` 需要：技能目录名' },
        mode: { type: 'string', description: '`append`（默认）或 `replace`' },
        reason: { type: 'string', description: '为什么现在写（被判决点名？同一个坑第二次？）' },
      },
      output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
      async execute(args, exec) {
        const me = myIdentity(exec)
        if (me === undefined) return { lines: ['**未获取**：认不出调用者是谁（拿不到 membership.name）'], code: 1 }
        const t = selfWriteDeps.resolveSelfTarget({
          stateDir: selfWriteDeps.stateDir,
          teamkitDir: selfWriteDeps.teamkitDir,
          member: me.name,
          role: me.role,
          target: args?.target,
          skill: args?.skill,
          soulCfg: selfWriteDeps.soul,
        })
        if (!t.ok) return { lines: [`没写：${t.why}`], code: 1 }
        const mode = args?.mode === 'replace' ? 'replace' : 'append'
        const r = selfWriteDeps.writeSelf(t.file, args?.text, { mode })
        if (!r.ok) return { lines: [`没写成：${r.why}`], code: 1 }
        const lines = [
          `已${mode === 'replace' ? '重写' : '追加'} \`${args?.target}\`：\`${String(r.file).replace(/\\/g, '/')}\`（现 ${r.bytes} B，sha=${r.sha}）`,
        ]
        if (args?.target === 'soul') lines.push('**下一步开工时它就会出现在你的上下文里**（`agent/pre-step` 注入，按 sha 去重）。')
        if (args?.target === 'principles') lines.push('**按角色共享** ⇒ 同岗位的人**下次装配**就会带上（走系统提示词）。')
        if (args?.target === 'role-skill') lines.push('**磁盘技能根** ⇒ 走 watcher，**当场生效**。')
        return { lines }
      },
    })
  }

  return { disposers, names }
}
