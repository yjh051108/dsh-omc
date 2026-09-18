/**
 * roles.js —— **公司层**：把 Talent 角色档变成"招募时按角色装配"的那一段。
 *
 * ## 为什么需要它（目标原话）
 * 「**尝试将它开发到完全体，真正意义上的 DSH 内的 OMC，能够组建成一人公司的团队**」
 *
 * 插件原先只有**基础设施层**（fork / 通知 / 上游合并 / guard）——
 * 它让"每个成员有一份可改的工作副本"，但**没有"这个人是谁、认什么判据、该拿什么工具"**。
 * 本模块补的正是这一层：**`spawn_teammate({name})` → 按 name 查角色档 → 装该角色的技能 provider**。
 *
 * ## 数据来源与"单一事实来源"
 * 角色档由 `runs/005-role-skills/roles/*.json` 提供（`task-56` 用生成器从 `talents/*.md` 产），
 * 字段契约见 `talents/_SPEC.md`。**本模块只读、不改、不复制**：
 * 路径由配置项 `roles.dir` 给（默认 `<workspace>/runs/005-role-skills/roles`），
 * 找不到就是**没有角色档**（`unknown`），**不猜、不静默造假档**。
 *
 * ## 三条诚实口径（照 `_SPEC.md` 的硬规矩）
 *  ① **`acceptance_style` 必须可观察** —— 它进的是 persona，属 **L1（提示词层，非强制）**；
 *  ② **不许绑后端**：`_SPEC.md:24` 明写 `hosting`/`llm_model`/`api_provider`/`temperature`
 *     **DSH 不承载，写了就是骗人的声明** ⇒ 本模块**拒绝**含这些字段的角色档（见 `FORBIDDEN_FIELDS`），
 *     并把拒绝**报出来**（不静默降级）；
 *  ③ **`write_scope` / `gate_policy` 是 advisory** —— 本模块只把它们的**文本**放进人格，
 *     **不假装能拦写**（真拦要 `guard`，而 guard 已如实标为"误操作护栏，pwsh 绕得过"）。
 *
 * ## 与 `fork` 的分工（**别混**）
 *  · `roles.js` 管 **"这个人是谁"**（身份：技能包 + 人格 + 判据）；
 *  · `fork.js` 管 **"他自己那一份在哪"**（overlay 工作副本）。
 * 两者都在 `agent/created` 装，但**互不依赖**：角色档缺失时 fork 照装（fork 只认 roster name）。
 *
 * ## 生命周期
 * 只导出**纯函数 + 一个 provider 工厂**；装配动作由 `index.js` 在 `agent/created` 里做
 * （那里是**唯一**能赶在第一个提示词前的窗口，`dsh-agent-loop:890` 实测）。
 * 本模块**不自己挂钩子**，因此卸载时无残留可清。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** `_SPEC.md:24` 明写 DSH 不承载的字段 —— 出现即**拒绝**（照抄进来就是骗人）。 */
export const FORBIDDEN_FIELDS = ['hosting', 'llm_model', 'api_provider', 'temperature', 'auth_method']

/** `_SPEC.md:14` 的 level 取值。 */
export const LEVELS = ['lead', 'ic', 'coo', 'ceo']

/**
 * `_SPEC.md:13` 的 **role 取值**（**封闭枚举**）。
 * ⚠️ **2026-09-14 / Round 71 补的**：`_SPEC.md` 早就把它写成了 `research / engineering / writing /
 * review / coordination / execution`（**六个、封闭**），而 `validateRole` **只校验了 `level`、漏了它** ⇒
 * **`role: 'wizard'` 会被放行**（负对照实测：`ok=true`）。同类漏的还有 `gate_policy`。
 * ⇒ 这正是本项目反复出现的那一格：**"字段在 spec 里是枚举" ≠ "校验器真的当枚举管"**
 *   （同族：`LANDMINES §9` 字段存在 ≠ 值正确 / R19 `tools` 字段零效果）。
 *
 * ⚠️⚠️ **补上枚举时立刻抓到一个真不一致**（同轮）：
 *   真实的 7 份角色档里 **`marketer` 用的是 `role: 'marketing'`**（`TALENTS.yml` / `talents/marketer.md` 也是），
 *   而 `_SPEC.md` 当时的枚举里**没有 `marketing`、却有一个没人用的 `execution`**。
 *   ⇒ **枚举写错的是 `_SPEC.md`，不是数据**（7 份档 + Market 索引三方一致用 `marketing`）。
 *   ⇒ 处置：**把 `marketing` 加进枚举**（并保留 `execution` 作为未使用但合法的值），
 *     **同时修 `_SPEC.md`** —— **不是把校验放宽**（放宽会让 `wizard` 那种真错也漏过去）。
 *   ⇒ 教训：**补枚举会立刻把"数据 vs spec 谁对"这个一直没人问的问题翻出来**；
 *     而**判据是"哪边多、哪边是实际在用的"**，不是"谁是文件"。
 */
export const ROLES = ['research', 'engineering', 'writing', 'review', 'coordination', 'marketing', 'execution']

/** `_SPEC.md:19` 的 **gate_policy 取值**（**封闭枚举**：`review` 默认 / `strict`）。 */
export const GATE_POLICIES = ['review', 'strict']

/** 角色档里**必须**有、且必须非空的字段（`_SPEC.md:11-22` 的必填集）。 */
const REQUIRED_FIELDS = ['name', 'role', 'level', 'description', 'skills', 'tools', 'write_scope', 'gate_policy', 'acceptance_style', 'onboarding']

/**
 * 校验一份角色档。**返回 `{ok, role?, why?}`，永不抛**（`agent/created` 是同步 emit，
 * 抛错会否决 agent 发布 —— 本插件全局纪律）。
 * @param raw 已 `JSON.parse` 的对象
 * @param where 出错时回报的来源（文件名），便于"失败不静默"
 */
export function validateRole(raw, where = '(unknown)') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, why: `${where}: 不是对象` }
  }
  const bad = FORBIDDEN_FIELDS.filter((f) => Object.hasOwn(raw, f))
  if (bad.length > 0) {
    // 这是**设计错误**不是笔误：DSH 的 spawn_teammate 没有这些参数，写进来只会骗人
    return { ok: false, why: `${where}: 出现禁字段 ${bad.join(', ')}（_SPEC.md:24：DSH 不承载，写了就是骗人的声明）` }
  }
  const missing = REQUIRED_FIELDS.filter((f) => raw[f] === undefined || raw[f] === null || raw[f] === '')
  if (missing.length > 0) return { ok: false, why: `${where}: 缺必填字段 ${missing.join(', ')}` }
  // ★★ **`name` 必须是 lower-kebab-case**（2026-09-14 / Round 72 收紧）。
  // 【缺陷现场】原判据是 `[A-Za-z0-9_-]+` —— 它**放过大写、下划线、连续短横、首尾短横**，
  //   而 `_SPEC.md:12` 明写 **"唯一 id，**kebab-case**，必须等于文件名"**。
  //   负对照实测：`name:'Engineer_1'` ⇒ **放行**（而那**根本不能当 DSH 成员名**）。
  // 【为什么必须真管】底座原话：`teammate name must be **lower-kebab-case**, at most 64 characters, and not "lead"`
  //   ⇒ 放行非法名 ⇒ **招人的时候才炸**，而不是读档的时候（错得更晚、更难定位）。
  //   ⚠️ 同时**保留一条**：`[A-Za-z0-9_-]+` 的**旧理由**（"能被目录白名单化"）已经被 kebab 覆盖，
  //     但**额外禁止** `lead`（底座明确拒绝它当 teammate 名）与超长（>64）。
  if (typeof raw.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.name)) {
    return { ok: false, why: `${where}: name=${JSON.stringify(raw.name)} 必须是 **lower-kebab-case**（_SPEC.md:12；底座原话 "must be lower-kebab-case"）` }
  }
  if (raw.name === 'lead') {
    return { ok: false, why: `${where}: name 不能是 "lead"（底座拒写：teammate name must be … and not "lead"）` }
  }
  if (raw.name.length > 64) {
    return { ok: false, why: `${where}: name 超过 64 字符（底座原话 "at most 64 characters"）` }
  }
  if (!LEVELS.includes(raw.level)) return { ok: false, why: `${where}: level=${raw.level} 不在 ${LEVELS.join('/')}` }
  // ★ **两个封闭枚举也管起来**（2026-09-14 / Round 71）——
  //   原先只校验 `level`，而 `_SPEC.md` 同样把 `role`（六个）与 `gate_policy`（两个）写成了**封闭取值**。
  //   负对照实测：`role:'wizard'` / `gate_policy:'maybe'` 当时**都被放行**。
  if (!ROLES.includes(raw.role)) return { ok: false, why: `${where}: role=${raw.role} 不在 ${ROLES.join('/')}（_SPEC.md:13 是封闭枚举）` }
  if (!GATE_POLICIES.includes(raw.gate_policy)) {
    return { ok: false, why: `${where}: gate_policy=${raw.gate_policy} 不在 ${GATE_POLICIES.join('/')}（_SPEC.md:19；默认 review）` }
  }
  if (!Array.isArray(raw.skills) || !Array.isArray(raw.tools)) return { ok: false, why: `${where}: skills/tools 必须是数组` }
  return { ok: true, role: raw }
}

/**
 * 读一个角色档目录，返回 `{roles: Map<name, role>, skipped: [{file, why}], dir, readable}`。
 * **跳过坏档但不静默**：坏档进 `skipped`，由调用方打日志（"失败不静默"纪律）。
 */
export function loadRoles(dir, log = () => {}) {
  const out = { roles: new Map(), skipped: [], dir, readable: false }
  if (typeof dir !== 'string' || dir === '') {
    out.skipped.push({ file: '(dir)', why: 'roles.dir 未配置或为空' })
    return out
  }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    out.skipped.push({ file: dir, why: `读不到目录（${err?.code ?? err?.message}）⇒ 本项不生效，不是"装好了"` })
    return out
  }
  out.readable = true
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    if (e.name === 'INDEX.json') continue
    const file = join(dir, e.name)
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      out.skipped.push({ file, why: `JSON 解析失败：${err?.message}` })
      continue
    }
    const v = validateRole(raw, e.name)
    if (!v.ok) {
      out.skipped.push({ file, why: v.why })
      continue
    }
    // ★★ **`name` 必须等于文件名**（`_SPEC.md:12` 明写；2026-09-14 / Round 72 补）。
    // 【缺陷现场】这条规定写在那里很久，而**代码从来没查过** ⇒ 负对照：`x.json` 里的 `name:'y'` 被放行。
    // 【为什么要管】`name → 角色档` 是**按名字查的**（`roleFor(roles, member)` 用 `roles.get(name)`），
    //   而**技能目录/provider 也按 name 生成**（`installRoleFor`）⇒ 名字与文件名不一致时：
    //   ① `TALENTS.yml` 里按 name 过滤会找不到；
    //   ② 排查时"文件叫 x、里面写 y"**极易误导**（本项目 R42 那条"写入点 ≠ 读取点"的同族）。
    //   ⇒ 判据：**逐档查**（不是抽查），不一致就 **skip 并说明**（失败不静默）。
    const base = e.name.replace(/\.json$/i, '')
    if (v.role.name !== base) {
      out.skipped.push({
        file,
        why: `name(${JSON.stringify(v.role.name)}) 必须等于文件名(${JSON.stringify(base)}) —— _SPEC.md:12；` +
          '不查的话 TALENTS.yml 按 name 过滤会找不到它（"文件叫 x、里面写 y"）',
      })
      continue
    }
    if (out.roles.has(v.role.name)) {
      out.skipped.push({ file, why: `角色名重复（已存在 ${v.role.name}）` })
      continue
    }
    out.roles.set(v.role.name, v.role)
  }
  for (const s of out.skipped) log(`ROLE-SKIPPED ${s.file} :: ${s.why}`)
  return out
}

/** 查一个成员名对应的角色档。**找不到返回 undefined**（不猜、不造默认档）。 */
export function roleFor(roles, member) {
  if (typeof member !== 'string') return undefined
  return roles.get(member)
}

/**
 * 把角色档渲染成**人格段**（进 `systemPrompt.section` 的那段文本）。
 *
 * 只放**身份与判据**，不放路径、不放工具清单（工具靠 `tools` 面，路径靠 fork 通知）。
 * `write_scope` / `gate_policy` **作为"你这是 advisory"的文本写进去** —— 不假装强制。
 *
 * @param role 角色档
 * @param principles **已加载的工作原则正文**（`loadPrinciples()` 的产物；`undefined` = 还没写过）
 *   —— 这是 OMC「**组织会学习**」那一格（原版每人的 `work_principles.md`）：
 *   **写了就进上下文；没写就明说没写**（不许假装有、也不许静默漏掉）。
 * @param principlesFile **该原则文件的绝对路径**（可选）。
 *   ⚠️ **为什么必须给**（2026-09-14 实测的事故）：只给相对路径 `principles/engineer.md` 时，
 *   teammate **不知道绝对位置** ⇒ 它按角色档里的相对路径**猜**成了仓内那份，
 *   而预设的 `principles.dir` 指向 **`$DSH_HOME/teamkit/talents/principles`**
 *   ⇒ **写入点 ≠ 读取点** ⇒ **它写的新原则，下一个同岗位的人读不到**（"组织会学习"静默断链）。
 *   ⇒ 把绝对路径写进人格段，"该写哪"由系统给出，**不靠猜**。
 */
export function personaFor(role, principles = undefined, principlesFile = undefined, soulFile = undefined, peers = undefined) {
  const lines = [
    `## 你的岗位：${role.name}（${role.role} / ${role.level}）`,
    role.description,
    '',
    `**你认的完成判据**：${role.acceptance_style}`,
    `**你的工作范围（advisory）**：${role.write_scope}`,
    `**评审门**：${role.gate_policy}`,
  ]
  // ★★ **把岗位的工具面写进人格段**（2026-09-14 / Round 19）。
  //
  // 【缺口】角色档里有 `tools` 字段（`reviewer: read,grep,pwsh` / `engineer: read,write,edit,pwsh,grep`…），
  //   `validateRole` 只检查"它是数组"（`roles.js:68`）——**之后从没被任何代码用过**：
  //   既没进人格段、也没进工具面 ⇒ **那是一条"零效果的声明"**，
  //   而读它的人（模型 / 维护者）**会以为它是约束**（`LANDMINES §9`：字段存在 ≠ 值正确）。
  //
  // 【为什么不做成"硬性工具门"】实测过（本轮）：
  //   `ctx.tools.restrict({allow,deny})` **管不到** `read`/`write`/`pwsh`/`send_message` 这些
  //   **DSH 内置工具** —— 它们不在 `ctx.tools` 的 `knownNames`/`restrictableNames` 里
  //   （实测：该 scope 下 107 个名字，**一个内置工具都没有**；它们是别的包 `ctx.tools.register` 进
  //   预设各自的层、由 agent 装配时挂上的）。
  //   ⇒ 唯一的"拦"法是 `ctx.tools.guard`（按名字在 `tools/pre-execute` 上拒绝），
  //     但那是**拒绝调用**、不是**看不见工具**，而且委托方 P-15/P-16 已明确：
  //     **控制面在认知，不在文件系统**（"他都不知道可以改，那他改啥呢？"）。
  //
  // 【所以这里做什么】**诚实地把它变成"认知"**：写进人格段，并**明说它是工作约定、不是强制**。
  //   这样：① 模型知道自己的岗位该用哪些工具（少乱用）；② **不假装**它是门禁（符合"只报实测"）。
  if (Array.isArray(role.tools) && role.tools.length > 0) {
    lines.push(
      `**你这个岗位的常用工具**：${role.tools.join(' / ')}`,
      '（**工作约定**：按岗位来用工具，别去动不属于你这岗位的那套；本条与上面的 `write_scope` 一样是 advisory。）',
    )
  }
  if (Array.isArray(role.personality_tags) && role.personality_tags.length > 0) {
    lines.push(`**工作风格**：${role.personality_tags.join(' / ')}`)
  }
  // ── ★★ **职责与边界**（2026-09-15 / task-104 第 2 阶段）─────────────────────────────
  //
  // 【委托方原话（本任务的唯一由来）】
  //   「这个公司的 **ceo 该做什么，不该做什么**，领导者该做什么，不该做什么啊……
  //     你要在**插件里面一开始初始化的时候**，大家都意识到这一点……
  //     我**开了一个新公司（另外一摊），现在又出现这样的问题了**，我**不想重复说**。」
  //
  // 【缺口（`task-104` 设计文档 §1.2 实测）】角色档 12 个字段**全是正向** ——
  //   有"做什么"（description/acceptance_style/write_scope），**没有一栏说"不该做什么"**。
  //   ★ 而**最该硬的那条约束（CEO 不动手）过去是靠 `tools` 里没有 `write` 隐含表达的**，
  //     偏偏`tools` 这一段（上面 :228）**自陈是 advisory（工作约定，不是门禁）**
  //     ⇒ **最该硬的约束用了最软的表达**。这两行就是把那条约束**明写出来**。
  //
  // 【为什么放人格段】① 通道已在（`personaFor()` 已在注岗位段）⇒ **零新机制**（`R13`）；
  //   ② 它进的是**装配期的系统提示词** ⇒ 成员**第一条提示词里就有**
  //     ⇒ 这正是委托方要的"**一开始初始化的时候大家都意识到**"。
  //
  // 【诚实口径（与 `tools` 那段一致）】它**也是 advisory**：写在这里是**认知**，不是门禁。
  //   委托方 P-15/P-16 已定：**控制面在认知，不在文件系统**。**不假装它是强制。**
  if (Array.isArray(role.duties) && role.duties.length > 0) {
    lines.push('**你该做什么（职责）**：')
    for (const d of role.duties) lines.push(`- ${d}`)
  }
  if (Array.isArray(role.boundaries) && role.boundaries.length > 0) {
    lines.push('', '**你不该做什么（边界；与上一条同等重要）**：')
    for (const b of role.boundaries) lines.push(`- ${b}`)
    // ★ 明写"这是边界"这件事本身 —— 否则模型容易把它读成"建议"（本项目的固定失败模式）
    lines.push('（这些边界是**这个岗位的定义的一部分**，不是可选建议。写这类约束仍然走认知层：本条与 `write_scope`/`tools` 一样是 **advisory**，但它**不是"看情况"** —— 要越界就先说清理由并上报。）')
  }
  // ★★ **编制（"我向谁报 / 我手下有谁"）** —— `task-114`
  // ```
  // 【委托方四问之一】「**领导者该做什么、不该做什么**」——
  //   ★ **"管谁"就是"领导者该做什么"的一半** ⇒ 只写 `duties`（内容）答不全。
  // 【数据源】`role.reports_to`（**单值**，与 `roles/<name>.json` 的 `name` 同域）
  //   ⇒ ★ **"手下有谁"【不另设字段】**：它是 `reports_to` 的**反向索引**，
  //     由调用方把**全部角色**传进来算（`peers` 参数）—— 依据 `R10`（同一事实只存一处）。
  //     ⚠️ 两边都写 ⇒ 改一处忘另一处 ⇒ 必然不一致（本项目反复栽过）。
  // 【"不许编"】★ `reports_to` 未声明 ⇒ **明写「未声明」**，**不留空、不猜一个上级**
  //   （`chief` 就是这样：它上面没有人 ⇒ 字段可选正是为了这个）。
  // 【为什么放人格段】与 `duties` 同通道（`R13`：零新机制）⇒ 装配期系统提示词 ⇒ 第一条提示词里就有。
  // ```
  {
    const up = typeof role.reports_to === 'string' && role.reports_to.trim() !== '' ? role.reports_to.trim() : null
    // 反向索引：谁报给我（**需要调用方提供全部角色**；没提供 ⇒ 明说"未获取"，不编）
    let reports = null
    if (peers !== undefined && peers !== null) {
      const all = peers instanceof Map ? [...peers.values()] : Array.isArray(peers) ? peers : [...(peers.roles?.values?.() ?? [])]
      reports = all
        .filter((r) => r !== undefined && r !== null && r.name !== role.name && typeof r.reports_to === 'string' && r.reports_to.trim() === role.name)
        .map((r) => r.name)
        .sort()
    }
    lines.push('', '**你的编制（关系；与职责同等重要）**：')
    lines.push(up === null ? `- 直接上级：**未声明**（这一档就是"未声明"——不编一个上级给你）` : `- 直接上级：\`${up}\``)
    if (reports === null) {
      lines.push('- 你手下有：**未获取**（本次渲染没拿到花名册 ⇒ 不编）')
    } else {
      lines.push(reports.length === 0 ? '- 你手下有：（没有直属下级）' : `- 你手下有：${reports.map((n) => `\`${n}\``).join(' · ')}`)
    }
    lines.push('（编制决定"**谁该向谁回报、谁的结论由谁复核**"；越级不是禁止，但要说清为什么。依据：`ORG.md §2` 编制图）')
  }
  if (typeof role.principles === 'string' && role.principles !== '') {
    // 有绝对路径就显示绝对路径（**唯一权威**）；否则退回相对路径 + 注明"这是相对仓根的写法"
    const where = typeof principlesFile === 'string' && principlesFile !== ''
      ? `\`${principlesFile.replace(/\\/g, '/')}\``
      : `\`${role.principles}\``
    if (principles !== undefined) {
      // ★ **自演化位命中**：把你上次复盘沉淀下来的原则**真注入上下文**（不是只给个路径）
      lines.push(
        '',
        `**你在本项目里学到的工作原则**（来自 ${where}）：`,
        principles,
        '',
        `> 要**追加**新原则就写进**这个文件**：${where}（只追加，不要重写已有内容）。`,
      )
    } else {
      // 还没写过 —— **明说"没有"**，并给出该写什么（照 `talents/principles/README.md` 的约定）
      lines.push(
        '',
        `**你的工作原则**：${where} **目前还没写**（首次复盘时创建）。`,
        '写它时只写**增量的工作原则**（"这类活在这个项目里要怎么做"），不写流水账；',
        '并且要能指到**成长两轴之一**：① 垂直深度（在自己的领域做到最棒）② 交接质量（谁接/接什么/什么时候算接住）。',
        '**没写进文件的复盘等于没复盘。**',
      )
    }
  }
  // ★★ **SOUL 的落点与时机**（2026-09-14 / Round 45）。
  //
  // 【缺口】Round 43–44 把 SOUL 注入做成了**真机制**（`agent/pre-step` ⇒ 每步 user message），
  //   但**没有任何地方告诉成员"SOUL 是什么、写哪、什么时候写"** ——
  //   实测：7 条技能 + 7 份角色档里 `SOUL` 命中 **0 处**。
  //   ⇒ 机制在，**可它在现实中不可达**（没人会去写一个自己不知道存在的文件）。
  //
  // 【为什么与上面的 `principles` 分开说】两者**不是一回事**（我 Round 43 判过一次，这里再对读者讲清）：
  //   · `principles`：**按角色**，写"这类活怎么干"；走**系统提示词**，**下次装配**才生效；
  //   · `SOUL`：**按人头**，写"**我自己答应改什么**"；走**每步 user message**，**下一步就生效**。
  //   ⇒ 被判决点名之后要写的是 **SOUL**（因为"下一轮复检"必须**下一步就带上**）。
  //
  // @param soulFile **SOUL 文件的绝对路径**（可选；调用方给得出就给）
  if (typeof soulFile === 'string' && soulFile !== '') {
    const where = `\`${soulFile.replace(/\\/g, '/')}\``
    lines.push(
      '',
      `**你的 SOUL**：${where}`,
      '它是**你自己的**（不是岗位规范）：写「**我答应自己改什么**」——一句话一条，带"下次怎么做"的动作。',
      '**什么时候写**：被评审**点名**某条缺陷之后、或你自己发现同一个坑踩了第二次之后。',
      '**它和我上面那条"工作原则"不一样**：原则是**这个岗位**怎么干活（走提示词、**下次装配**才生效）；',
      'SOUL 是**我个人**的承诺，**每步开工前都会读一遍** ⇒ **改了下一步就生效**（所以"下一轮复检"要指望它）。',
      '**没写就什么也不会发生**（这是正常状态，不是错误）。',
    )
  }
  return lines.join('\n')
}

/**
 * 读一个角色的**工作原则**（自演化位）。`talents/principles/<name>.md` 的对应物。
 *
 * 三态（**不许把"读不到"与"没写过"混为一谈**）：
 *  · 文件存在 ⇒ 返回它的正文（去掉首尾空白）；**空文件**按"没写过"处理（避免注入空白段）；
 *  · 文件不存在 ⇒ 返回 `undefined`（= 还没写过，**这是正常状态**，不是错误）；
 *  · 读出错（权限/IO）⇒ 返回 `{ error }`，由调用方**报出来**（不静默）。
 *
 * @param dir 原则目录（`<roles.dir>/../principles` 或显式给）
 * @param roleName 角色名（与 `talents/<name>.md` 同名）
 * @returns `{ text }` | `undefined` | `{ error }`
 */
export function loadPrinciples(dir, roleName) {
  if (typeof dir !== 'string' || dir === '' || typeof roleName !== 'string' || roleName === '') return undefined
  const file = join(dir, `${roleName}.md`)
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (text === '') return undefined
    return { text, file }
  } catch (err) {
    return { error: `读不到 ${file}（${err?.code ?? err?.message}）—— 这一项没生效，不是"没有原则"` }
  }
}

/**
 * 从一个角色档推导它的原则文件路径。
 *
 * ⚠️ **约定来自 `talents/principles/README.md` + `COMPANY-LAYER.md:259`**（不是猜）：
 * 原则文件是 **`talents/principles/<name>.md`**；角色档里的 `principles` 字段是**相对路径**
 * （形如 `principles/engineer.md`）⇒ **只有文件名那一段有用**，目录由**调用方**按约定给。
 *
 * @param principlesDir **原则目录**（`<repo>/talents/principles`）；`index.js` 有候选列表来定它
 * @param role 角色档
 * @returns `{ file, dir }`；`role.principles` 缺失或 `principlesDir` 为空 ⇒ `undefined`（**不猜**）
 */
export function principlesPathFor(principlesDir, role) {
  const rel = role?.principles
  if (typeof rel !== 'string' || rel === '') return undefined
  if (typeof principlesDir !== 'string' || principlesDir === '') return undefined
  // 相对路径里**只取文件名**：`principles/engineer.md` → `engineer.md`
  // （角色档里的 `principles/` 前缀是"它相对仓根"的写法，目录由 `principlesDir` 决定）
  const name = rel.split(/[\\/]/).pop()
  if (typeof name !== 'string' || name === '') return undefined
  return { file: join(principlesDir, name), dir: principlesDir }
}

/**
 * 造一个**只带本角色技能**的 skill provider。
 *
 * ⚠️ 与 `makeForkProvider` 同构（`{name, list()}`），但语义不同：
 *  · fork provider 读的是**该成员的工作副本**（会变，成员自己改）；
 *  · 本 provider 读的是**角色技能目录**（随角色档走，同角色的人看到同一份）。
 * 两者都注册进同一个 agent 的 scope ⇒ **同名条按 rank 决出胜者**（nearest wins）。
 *
 * @param opts.name         provider 名（如 `teamkit-role-engineer`）
 * @param opts.dir          角色技能目录（`<角色>/skills/`）；不存在 = 空 catalog（**合法**）
 * @param opts.rank         scope 内排序（默认 240 —— 比 fork 的 250 略低，即"成员自己的改动优先"）
 * @param opts.skillFileName 条目主文件名（默认 `SKILL.md`）
 */
export function makeRoleSkillProvider({ name, dir, rank = 240, skillFileName = 'SKILL.md' }) {
  // 复用 fork.js 的解析？不 —— 那会让 roles.js 依赖 fork.js 的内部。
  // 这里只做最小实现：目录里的每个子目录 + `skillFileName` 当作一条技能。
  const readEntry = (dirName) => {
    const file = join(dir, dirName, skillFileName)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
    // 极简 frontmatter 解析：只取 name / description（与 skills.js 的 parseSkill 同口径的最小面）
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    if (m === null) return undefined
    const meta = {}
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
    const skillName = meta.name ?? dirName
    if (typeof skillName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(skillName)) return undefined
    return { name: skillName, description: meta.description ?? '(no description)', body: m[2], file }
  }

  return {
    name,
    rank,
    async list() {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return [] // 没有角色技能目录 = 合法的空（角色档可以只带人格）
      }
      const out = []
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        const got = readEntry(e.name)
        if (got === undefined) continue
        // ⚠️ **这四个字段是 `dsh-skill` 的硬要求**（`lib/index.js:452-464` `validateCandidate`）：
        //    `invocation`（经 `validateInvocation` 查两个布尔）/ `source` / `rank` /
        //    `provider`（**必须 === 注册名**，不等就抛）。
        //    **我第一版漏了它们** —— `registerProvider` 会成功，但 `skills.list()` 在校验时**直接抛**
        //    （调用点 `:360` 在 `provider.list()` 的 try/catch 之外）⇒ **失败很响，但不是静默**。
        //    现场读数（`upstream-keeper` 报、我自跑复现）：
        //      `TypeError: skill provider "teamkit-role-engineer" returned skill "…" with a non-string source`
        //    形状照 `fork.js:78-88`（同族 provider，已验证过）。
        out.push({
          name: got.name,
          description: got.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'role',
          provider: name,
          rank,
          locator: got.file,
          path: got.file,
        })
      }
      return out
    },
    /**
     * 读一条角色的正文。**`dsh-skill:256` 会调它**（`skill` 工具按需加载时）——
     * 没有它，加载正文会拿到 `undefined`。形状照 `fork.js:92-104`。
     */
    async get(candidate) {
      const file = typeof candidate?.locator === 'string' ? candidate.locator : candidate?.path
      if (typeof file !== 'string') return undefined
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
      if (m === null) return undefined
      const meta = {}
      for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
        if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
      }
      return {
        name: candidate.name,
        description: meta.description ?? candidate.description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'role',
        provider: name,
        content: m[2],
        locator: file,
        path: file,
      }
    },
  }
}

/**
 * 给**一个** agent 装该角色的技能 provider。
 *
 * ⚠️ 与 `installForkFor` 同样的纪律：**失败不抛**（`agent/created` 是同步 emit），
 * 且**失败要留痕**（返回 `{ok:false, why}` 由调用方 log）。
 *
 * @param agent 该 agent（要能拿到 `agent.ctx.get('skills')`）
 * @param role  已校验的角色档
 * @param opts  `{ rolesDirBase, providerPrefix, rank, log }`
 */
export function installRoleFor(agent, role, opts = {}) {
  if (role === undefined) return { ok: false, why: 'no-role（这个成员名没有角色档 —— 不是错误，是"通用工"）' }
  let svc
  try {
    // ⚠️ `agent.ctx.skills` 属性访问会被 cordis 的 inject 守卫拦掉（task-32 实测）⇒ 必须 `get`
    svc = agent?.ctx?.get?.('skills')
  } catch (err) {
    return { ok: false, why: `ctx.get(skills) 抛错：${err?.message}` }
  }
  if (svc === undefined || typeof svc.registerProvider !== 'function') {
    return { ok: false, why: 'no registerProvider（skills 服务未就绪）' }
  }

  const providerName = `${opts.providerPrefix ?? 'teamkit-role-'}${role.name}`
  const roleSkillsDir = opts.roleSkillsDir ?? join(opts.rolesDirBase ?? '.', role.name, 'skills')
  const installed = []
  try {
    const disposer = svc.registerProvider(() => makeRoleSkillProvider({
      name: providerName,
      dir: roleSkillsDir,
      rank: opts.rank ?? 240,
    }))
    installed.push(providerName)
    return { ok: true, why: 'ok', provider: providerName, dir: roleSkillsDir, hasSkillsDir: existsSync(roleSkillsDir), disposer }
  } catch (err) {
    // 重名 provider（同一 scope 注册两次）会抛 —— **这是要看见的失败**，不许静默
    return { ok: false, why: `registerProvider 抛错：${err?.message}` }
  }
}
