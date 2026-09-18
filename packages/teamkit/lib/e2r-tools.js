/**
 * e2r-tools.js —— 把 **E²R 的结构与判决**暴露成**三件可调用的工具**（2026-09-14 / task-60）。
 *
 * ## 为什么单独一份（与 `release-tools.js` 同样的分工）
 * `lib/e2r.js` 是**机制**（台账 + 摘要 + 可选派生视图）；但**能调用它的人**才是交付。
 * 没有这一份，"结构落盘了"就等于"没人能设、没人能读"。
 *
 * ## 三件工具（**默认开**，零风险：一个字节都不碰底座 schema）
 * | 工具 | 干什么 | 风险 |
 * |---|---|---|
 * | `set_task_structure` | 设**分解边**（`parentTask`）+ 把摘要写进 `description` | 零：只用底座的 `edit` action |
 * | `review_task`         | 写**评审判决**（`accept`/`reject`/`none`）+ 理由 | 零：同上 |
 * | `team_structure`      | **读**结构视图（含 `accepted`）—— **我们的**，不动底座 | 零：只读 |
 *
 * ⚠️ **`review_task` 不是强制点**（`H41` 口径，**不许说成机制**）：
 *   底座**不认** `reviewState`。写了 `accept` 只是**落了一条判决**；
 *   真拦住"没评审就往下走"的，是**评审任务 + 下游 `blocked_by`**（那条 `claim` 被宿主硬拒）。
 *   本工具做的是**把判决落到盘上、并且让它出现在板上**，**不是**"拒绝谁继续"。
 *
 * ## 与 `release-tools.js` 共用两条纪律
 * 1. **绝不用裸导入**（`lib/**.js` 只允许 `node:` 内置与相对导入；`H12` 盯着）——
 *    所以 `parameters` 是**手写 JSON Schema**，不 `import { defineTool }`；
 * 2. **失败不静默**：拿不到 Team / 拿不到任务板 / 写盘失败 ⇒ **明说 why**，绝不假装成功。
 *
 * ## ★ 两个"必须先做到"的前置（都能如实报"未获取"）
 * · **要能确定调用方属于哪个 Team**：复用 `release-tools.js` 的 `resolveTeamRoot`
 *   （候选列表：调用方自己 / membership / 找 Lead；**全都失败就返回 undefined，不猜**）；
 * · **要能读到底座的任务**：`agentTeams.listTasks(caller)` —— 拿不到就报"未获取"。
 */
import { resolveTeamRoot } from './release-tools.js'

/** 文本结果（工具输出统一形态；与 `release-tools.js` 的 `textOut` 同构）。 */
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
 * ★ **把 `defineTool` 的简写参数表转成 JSON Schema**（本地实现，**不裸导入**）。
 * 与 `release-tools.js` 里那份**同一套语义**（那边也解释了为什么不能 import `defineTool`）。
 */
function paramsToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, v] of Object.entries(spec ?? {})) {
    const p = { type: v.type ?? 'string' }
    if (v.description !== undefined) p.description = v.description
    if (v.items !== undefined) p.items = v.items
    if (v.enum !== undefined) p.enum = v.enum
    if (v.additionalProperties !== undefined) p.additionalProperties = v.additionalProperties
    properties[key] = p
    if (v.required === true) required.push(key)
  }
  const out = { type: 'object', additionalProperties: false, properties }
  if (required.length > 0) out.required = required
  return out
}

/**
 * 拿**调用方所在 Team 的任务视图**（元数据来源）。
 *
 * ★★ **R96 / task-63：这里必须传 `allowEmptyTeam: true`** ——
 *   本文件的三件工具**全是读型**（`team_structure` 只读；`set_task_structure` / `review_task`
 *   只写**我们自己的台账 + 底座的 `edit`**，**不碰别人的 Team**）⇒ **空公司放宽是零风险的**。
 *   ⚠️ 而 `release_member`（**破坏性**）**不传**这个开关 ⇒ 它保持严格（`members>0`）——
 *   **读 / 写风险不对称**，判据就该分开（详见 `release-tools.js` 的 `allowEmptyTeam` 说明）。
 *   ⇒ 不这样做的话：**新开一个 omc 会话（必然还没招人）第一件事就报 "root-unresolved"**
 *     —— 而"开公司的第一步"恰好发生在公司为空的时候。
 * @returns `{ ok:true, root, views }` 或 `{ ok:false, why }`
 */
function readBoard(agentTeams, agents, caller, log) {
  const root = resolveTeamRoot(caller, { agentTeams, agents, log, allowEmptyTeam: true })
  if (root === undefined) {
    return {
      ok: false,
      why: 'root-unresolved（认不出调用方属于哪个 Team —— 不猜：猜错会写到**别人的**任务板上）',
    }
  }
  let views
  try {
    views = agentTeams?.listTasks?.(caller)
  } catch (err) {
    return { ok: false, why: `listTasks-failed（${err?.message ?? err}）` }
  }
  if (!Array.isArray(views)) return { ok: false, why: `listTasks 返回的不是数组（${typeof views}）` }
  return { ok: true, root, views }
}

/**
 * ★★ **成员 → 角色档 `level` 的可读口**（2026-09-14 / task-77）。
 *
 * ## 为什么要有它（委托方当场问的「为什么我没有在图像里面看到分层？」）
 * `LAYERING-SOURCE.md §2` 把断链点钉成三格：
 * ```
 * level 存在于  →  ① 插件磁盘（$DSH_HOME/teamkit/roles/*.json）
 * level 进入了  →  ② 模型上下文（roles.js:200 的人格段标题）
 * level 缺一个  →  ③ ★ **对外的可读口**：把「成员名」与「它的 level」对上，给消费者读
 * ```
 * 本函数 + `member_levels` 工具就是**第 ③ 格**。
 *
 * ## ★★ 硬判据（`task-77` 最看重的一条）：**"我不知道"不许显示成"Junior"**
 * ```
 * · 匹配不上（该成员名没有角色档）⇒ `exists:false` + **`level: undefined`**
 *   ⇒ **绝不默认成 `1`/`'ic'`**。真读数：本 Team 21 人里**只有 5 人**有角色档（覆盖率 23.8%）
 *      （`product-director` 实测、`engineering-director` 复核接受，`LAYERING-SOURCE.md §1-A′`）。
 * · 读不到 `$DSH_HOME/teamkit/roles`（开源用户没装）⇒ **整口报"未获取"**（`readable:false` + why），
 *   **不崩、不兜底成 `1`**。
 * ```
 * ⚠️ 本项目最忌讳的是"把不知道说成知道"：面板现状 `dsh-org-panel/lib/index.js:422` 写死 `level: 1`
 *   ⇒ 20 个 employee 全是 Junior —— 那**正是**委托方说"没看到分层"的直接来源。
 *
 * ## 匹配规则：**与 `roles.js:176 roleFor` 逐字一致**
 * ```js
 * export function roleFor(roles, member) { if (typeof member !== 'string') return undefined; return roles.get(member) }
 * ```
 * ⇒ 本函数**直接复用 `loadRoles` + `roleFor`**（不自己重写一套匹配），
 *   避免出现"两份事实"（`LAYERING-SOURCE.md §4` 把"按名字猜"列为被否写法）。
 *
 * @param rolesDir 角色档目录（`$DSH_HOME/teamkit/roles`）
 * @param memberNames 成员名列表（来自 roster，**不含 lead** —— lead 不在 roster 里）
 * @returns `{ ok:true, readable:true, dir, rows, stats }`
 *          或 `{ ok:false, readable:false, dir, why }`（**读不到目录 ⇒ 未获取，不是"全都无档"**）
 */
export function describeMemberLevels(rolesDir, memberNames, { loadRoles, roleFor } = {}) {
  const names = Array.isArray(memberNames) ? memberNames.filter((n) => typeof n === 'string' && n !== '') : []
  // ⚠️ **读不到目录 ⇒ 整口"未获取"**（不能报成"这些人都没有角色档" —— 那是把"我没读到"说成"事实是没有"）
  const loaded = loadRoles(rolesDir)
  if (!loaded?.readable) {
    return {
      ok: false,
      readable: false,
      dir: rolesDir ?? '',
      why:
        `拿不到角色档目录 \`${rolesDir ?? '(未配置)'}\` ⇒ **未获取**` +
        `（不是"这些成员都没有角色档"。原因：${loaded?.skipped?.[0]?.why ?? '未知'}）`,
      rows: [],
      stats: { total: names.length, withRole: 0, coverage: 0 },
    }
  }
  const rows = names.map((name) => {
    const role = roleFor(loaded.roles, name) // ★ 与 roles.js:176 同一套匹配
    if (role === undefined) {
      // ★★ **无角色档 ⇒ 如实表达"通用工"，`level` 留空**（绝不填 1）
      return { name, exists: false, level: undefined, role: undefined }
    }
    return { name, exists: true, level: role.level, role: role.role }
  })
  const withRole = rows.filter((r) => r.exists).length
  return {
    ok: true,
    readable: true,
    dir: rolesDir ?? '',
    rows,
    stats: {
      total: rows.length,
      withRole,
      coverage: rows.length === 0 ? 0 : withRole / rows.length,
      // 供消费者一眼看出"这口读的是哪份档"（**可审计**）
      rolesLoaded: loaded.roles.size,
    },
  }
}

/**
 * 注册三件工具。**默认开**（`e2r.structure !== false`）—— 它们零风险。
 *
 * @param ctx  宿主插件 ctx（要有 `tools`）
 * @param opts.e2r        `makeE2rManager(...)` 的返回值
 * @param opts.agentTeams 宿主的 `agentTeams`
 * @param opts.agents     宿主的 `agents`
 * @param opts.cfg         `paths.e2r`
 * @param opts.log
 * @param opts.rolesDeps   `{ rolesDir, loadRoles, roleFor }` —— task-77 的 level 读口要用
 * @returns `{ disposers, names }`（**可卸净**：每个工具一个 disposer）
 */
export function registerE2rTools(ctx, { e2r, agentTeams, agents, cfg, log = () => {}, rolesDeps } = {}) {
  const disposers = []
  const names = []
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    log('E2R-TOOLS-SKIP ctx.tools.register 不可用（宿主变了？）')
    return { disposers, names }
  }
  if (cfg?.structure === false) {
    log('E2R-TOOLS-OFF e2r.structure=false ⇒ 三件工具都不注册')
    return { disposers, names }
  }

  const reg = (definition) => {
    try {
      const full = { ...definition, parameters: paramsToJsonSchema(definition.parameters) }
      const d = ctx.tools.register(full)
      disposers.push(d)
      names.push(definition.name)
      log(`E2R-TOOL-OK name=${definition.name}`)
    } catch (err) {
      // **失败不静默**：说清楚是哪个工具没装上、为什么
      log(`E2R-TOOL-FAIL name=${definition.name} why=${err?.message ?? err}`)
    }
  }

  // ── ① set_task_structure（设分解边 + 摘要进 description）──────────────────
  reg({
    name: 'set_task_structure',
    description:
      '设一个任务的**分解边**：它是从哪个任务切出来的（OMC 论文的 `E_tree`）。' +
      '同时把结构摘要写进任务 `description`（**底座会把它显示在 team_task_list 里** ⇒ 板上看得见，不需要改底座）。' +
      '⚠️ **这不是底座的 `blocked_by`**（那是**依赖边** `E_dep`，管"先做谁"）；' +
      '这里是**结构边**，管"由谁组成"。两者方向可能相反，**别混用**。' +
      '⚠️ 它**不是强制点**：设了就只是"有记录"，不会拒绝任何操作。',
    parameters: {
      task_id: { type: 'string', required: true, description: '要设结构的任务 id（如 `task-42`）。' },
      parent_task: {
        type: 'string',
        description:
          '它是从哪个任务切出来的（如 `task-40`）。**只能是同一个 Team 里的任务 id**。' +
          '**传空字符串 = 清掉这条分解边**（误设时用；台账仍可回放，不删历史）。',
      },
      reason: { type: 'string', description: '为什么这样切（可选，但建议写：这是给未来的人看的）。' },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    async execute(args, exec) {
      const caller = exec?.agent
      const lines = []
      const b = readBoard(agentTeams, agents, caller, log)
      if (!b.ok) return { lines: [`**未获取**：${b.why}`], code: 1 }
      // 任务必须真存在（在**当前 Team 的**视图里找）
      const target = b.views.find((v) => v.id === args?.task_id)
      if (target === undefined) {
        return {
          lines: [`没设：当前 Team 里没有任务 \`${args?.task_id}\`（有 ${b.views.length} 个：${b.views.map((v) => v.id).join(', ')}）`],
          code: 1,
        }
      }
      // ★ **空 `parent_task` = 清掉这条分解边**（误设的回退路径；否则只能设不能撤）
      const want = typeof args?.parent_task === 'string' ? args.parent_task.trim() : ''
      if (want === '') {
        const c = e2r.clear({ root: b.root, taskId: args.task_id, reason: args?.reason })
        if (!c.ok) return { lines: [`没清成（code=${c.code}）：${c.why}`], code: c.code ?? 1 }
        lines.push(`已清掉 \`${args.task_id}\` 的结构记录（分解边 + 判决）。`)
        lines.push('台账是 append-only：**没有删行**，追加了一条 `clear` ⇒ 历史仍可回放。')
        return { lines }
      }
      const parent = b.views.find((v) => v.id === want)
      if (parent === undefined) {
        return {
          lines: [`没设：当前 Team 里没有父任务 \`${want}\`（有 ${b.views.length} 个：${b.views.map((v) => v.id).join(', ')}）`],
          code: 1,
        }
      }
      const r = e2r.setParent({ root: b.root, taskId: args.task_id, parentTask: args.parent_task, reason: args?.reason })
      if (!r.ok) return { lines: [`没设成（code=${r.code}）：${r.why}`], code: r.code ?? 1 }
      lines.push(`已设分解边：\`${args.task_id}\` ← \`${args.parent_task}\`（台账 \`${e2r.file}\`）。`)
      // ★ C 路：把摘要也写进 description（**用底座自己的 edit action**，不碰 schema）
      const { text, changed, tooLong } = e2r.mergeSummary(target.description, e2r.entryOf(b.root, args.task_id))
      if (tooLong) {
        lines.push(`⚠️ 摘要**没有写进 description**：合并后会超底座的 ${16_384} 字符上限（现 ${text.length}）—— 台账已记，板上看不到这一行。`)
      } else if (!changed) {
        lines.push('（description 里的摘要本来就是这个内容，未改动。）')
      } else {
        const ur = await updateTaskDescription(agentTeams, caller, args.task_id, target.revision, text)
        if (ur.ok) lines.push('已把摘要写进 `description` ⇒ **底座的 `team_task_list` 里就能看到这一行**。')
        else lines.push(`⚠️ 台账已记，但摘要**没写进 description**：${ur.why}`)
      }
      lines.push('⚠️ **不是强制点**：这只是"有记录"。要**真拦**"没评审就往下走"，请把评审建成任务并让下游 `blocked_by` 它（见 `teamkit-review`）。')
      return { lines }
    },
  })

  // ── ② review_task（写评审判决）────────────────────────────────────────────
  reg({
    name: 'review_task',
    description:
      '给一个已完成的任务写**评审判决**（OMC 论文的 `q_v ∈ {accept,reject}`）：`accept` / `reject` / `none`（撤销）。' +
      '判决与理由落在**台账**（`<stateDir>/e2r.jsonl`）与任务 `description` 摘要里 ⇒ 板上看得见。' +
      '⚠️ **这不是底座的 `completed` 态**：底座只有 4 态、**没有 `accepted`**。' +
      '⚠️ **它不是强制点**：写了 `reject` 也**不会**阻止谁继续（没有任何底座代码看这个字段）。' +
      '要真拦，请把评审建成任务、让下游 `blocked_by` 它 —— 那条 `claim` 会被宿主硬拒。',
    parameters: {
      task_id: { type: 'string', required: true, description: '被判决的任务 id。' },
      verdict: {
        type: 'string',
        required: true,
        enum: ['accept', 'reject', 'none'],
        description: '`accept` 接受 / `reject` 驳回 / `none` 撤销判决。',
      },
      note: {
        type: 'string',
        required: true,
        description: '判决理由（**必填**）。接受 = 证据指针；驳回 = 差在哪 + 一个可执行的下一步。',
      },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    async execute(args, exec) {
      const caller = exec?.agent
      const lines = []
      const b = readBoard(agentTeams, agents, caller, log)
      if (!b.ok) return { lines: [`**未获取**：${b.why}`], code: 1 }
      const target = b.views.find((v) => v.id === args?.task_id)
      if (target === undefined) {
        return { lines: [`没写：当前 Team 里没有任务 \`${args?.task_id}\`（有：${b.views.map((v) => v.id).join(', ')}）`], code: 1 }
      }
      const r = e2r.review({ root: b.root, taskId: args.task_id, reviewState: args?.verdict, reviewNote: args?.note })
      if (!r.ok) return { lines: [`没写成（code=${r.code}）：${r.why}`], code: r.code ?? 1 }
      lines.push(`已记判决：\`${args.task_id}\` = **${args.verdict}**（理由已落台账 \`${e2r.file}\`）。`)
      const { text, changed, tooLong } = e2r.mergeSummary(target.description, e2r.entryOf(b.root, args.task_id))
      if (tooLong) {
        lines.push('⚠️ 摘要没写进 description（超底座上限）—— 台账已记，板上看不到这一行。')
      } else if (changed) {
        const ur = await updateTaskDescription(agentTeams, caller, args.task_id, target.revision, text)
        if (ur.ok) lines.push('已把判决摘要写进 `description` ⇒ 底座的 `team_task_list` 里看得到。')
        else lines.push(`⚠️ 台账已记，但摘要没写进 description：${ur.why}`)
      }
      if (target.status !== 'completed') {
        lines.push(`⚠️ 注意：这个任务现在还是 \`${target.status}\`，**不是** \`completed\` —— 判决通常给已完成的任务。`)
      }
      lines.push('⚠️ **不是强制点**（没有任何底座代码看 `reviewState`）。要真拦：评审建成任务 + 下游 `blocked_by` 它。')
      return { lines }
    },
  })

  // ── ③ team_structure（**读**结构视图；我们自己的，底板不动）───────────────
  reg({
    name: 'team_structure',
    description:
      '读当前 Team 的任务**结构视图**：每个任务带 `parentTask`（分解边）/ `reviewState`（判决）/ `accepted`（= `completed` **且**判决 `accept`）。' +
      '这是**我们插件自己的**读口（台账 + 底座的只读视图拼出来）—— 用它看结构**不需要**动底座的 `team_task_list`。' +
      '⚠️ 没有记录的任务显示 `parentTask:""`、`reviewState:"none"`（= 还没设，不是出错）。',
    parameters: {
      only_accepted: { type: 'boolean', description: '`true` = 只列"被接受"的（`completed` 且判决 accept）。' },
      only_pending_review: {
        type: 'boolean',
        description: '`true` = 只列"已完成但**还没**判决"的（这就是评审门要盯的那一格）。',
      },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    async execute(args, exec) {
      const caller = exec?.agent
      const lines = []
      const b = readBoard(agentTeams, agents, caller, log)
      if (!b.ok) return { lines: [`**未获取**：${b.why}`], code: 1 }
      let rows = e2r.structureFor(b.root, b.views)
      if (args?.only_accepted === true) rows = rows.filter((r) => r.accepted === true)
      if (args?.only_pending_review === true) rows = rows.filter((r) => r.status === 'completed' && r.reviewState !== 'accept')
      if (rows.length === 0) {
        lines.push(`没有符合条件的任务（共 ${b.views.length} 个任务）。`)
        if (args?.only_pending_review === true) lines.push('⇒ **没有"完成了但没判决"的任务**（这是好消息）。')
        return { lines }
      }
      const accepted = rows.filter((r) => r.accepted).length
      lines.push(`结构视图（${rows.length} 个任务；其中 **accepted** = ${accepted} 个）：`)
      for (const r of rows) {
        const par = r.parentTask === '' ? '' : ` ← parent ${r.parentTask}`
        const rv = r.reviewState === 'none' ? 'review none' : `review **${r.reviewState}**`
        lines.push(`- \`${r.id}\` [${r.status}] ${rv}${par} — ${r.subject}`)
      }
      lines.push('')
      lines.push('判据：`accepted` = `status==="completed"` **且** `reviewState==="accept"` —— **`completed` 本身不算被批准**。')
      lines.push('⚠️ 这只是**结构**。要**强制**评审门：把评审建成任务 + 让下游 `blocked_by` 它（`claim` 会被宿主硬拒）。')
      return { lines }
    },
  })

  // ── ④ member_levels（**只读**：成员 → 角色档 level 的可读口；task-77）────────
  //   ★ 形态选择理由（task-77 要求"形态由你定，但要给理由"）：
  //     ① **不落盘 JSON**：落盘会**多一份事实来源**，磁盘与角色档漂移时**没有任何信号**
  //        （本项目反复防的"两份事实"；`LAYERING-SOURCE.md §4` 把"发明数据源"列为被否写法）；
  //     ② **做成独立只读工具**（而不是塞进 `team_structure`）：两者**关注点不同** ——
  //        `team_structure` 是"任务的树与判决"，本口是"人 → 职级"；
  //        且**消费者不同**：面板/别的插件要的是**一份能整体读的名单**，
  //        塞进任务视图反而要它从任务里反推人（`team_structure` 只列**有 owner 的任务**，
  //        ⇒ **没领活的人根本不在里面**，覆盖率会假性偏低）。
  //     ③ **直接读角色档**（每次调用重读）⇒ 角色档一改，下一次调用就是新的（**无缓存漂移**）；
  //        代价是每次一次 `readdirSync`（几个文件，可忽略）。
  reg({
    name: 'member_levels',
    description:
      '读**成员 → 角色档职级**（`level`）的映射（**只读**，不改任何东西）。' +
      '用途：面板/别的消费者要画"分层"时，来这里取**有出处**的职级，' +
      '而不是**猜**（按名字猜 `*director*` = 高管）或**写死**（`level: 1`）。' +
      '⚠️ **匹配不上（该成员名没有角色档）⇒ 如实返回 `exists:false`，`level` 为空** —— ' +
      '**绝不默认成 1/Junior**（把"我不知道"显示成"Junior"是本项目最忌讳那类谎）。' +
      '⚠️ **读不到角色档目录 ⇒ 整口返回「未获取」**（不是"这些人都没有角色档"）。',
    parameters: {
      members: {
        type: 'array',
        items: { type: 'string' },
        description:
          '要查的成员名列表。**不传 ⇒ 自动取本 Team roster 的全部成员**（不含 lead —— lead 不在 roster 里）。',
      },
    },
    output: textOut({ lines: { type: 'array', items: { type: 'string' } } }),
    async execute(args, exec) {
      const caller = exec?.agent
      const lines = []
      const deps = rolesDeps
      if (!deps || typeof deps.loadRoles !== 'function' || typeof deps.roleFor !== 'function') {
        return { lines: ['**未获取**：插件没把角色档依赖接进来（`rolesDeps` 缺失）—— 这是装配问题，不是"没有角色档"'], code: 1 }
      }
      // 成员名单：显式给就用手给的；否则从**调用方所在 Team 的 roster** 取
      let names = Array.isArray(args?.members) ? args.members.filter((n) => typeof n === 'string' && n !== '') : []
      let via = '参数 members'
      if (names.length === 0) {
        const b = readBoard(agentTeams, agents, caller, log)
        if (!b.ok) {
          // ⚠️ **拿不到 roster ⇒ 未获取**（不猜、不返回空名单冒充"查完了"）
          return { lines: [`**未获取**：${b.why}`, '（可改用 `members: ["engineer", …]` 显式点名。）'], code: 1 }
        }
        let roster = []
        try {
          roster = agentTeams?.listMembers?.(caller) ?? []
        } catch (err) {
          return { lines: [`**未获取**：listMembers 抛错（${err?.message ?? err}）`], code: 1 }
        }
        names = (Array.isArray(roster) ? roster : [])
          .filter((m) => m?.role !== 'lead') // ★ lead 不是 roster 成员（实测 20/20 都是 teammate）
          .map((m) => m?.name)
          .filter((n) => typeof n === 'string' && n !== '')
        via = '本 Team roster'
      }
      const r = describeMemberLevels(deps.rolesDir, names, deps)
      if (!r.ok) return { lines: [`**未获取**：${r.why}`], code: 1 }
      lines.push(`职级读口（来源 \`${r.dir}\`，已载入 ${r.stats.rolesLoaded} 份角色档；成员来自：${via}）：`)
      for (const row of r.rows) {
        lines.push(
          row.exists
            ? `- \`${row.name}\` → **${row.level}**（role: ${row.role}）`
            : `- \`${row.name}\` → **无角色档（通用工）** —— \`exists:false\`、\`level\` 为空`,
        )
      }
      lines.push('')
      lines.push(
        `覆盖率：**${r.stats.withRole}/${r.stats.total}**（${(r.stats.coverage * 100).toFixed(1)}%）` +
          ' —— 其余的人**真的没有角色档**，不是"还没查"。',
      )
      lines.push('⚠️ **`exists:false` 必须被如实显示为"通用工"**；显示成 `level:1`/`Junior` 就是把"不知道"说成"知道"。')
      return { lines }
    },
  })

  return { disposers, names }
}

/**
 * 用**底座自己的 `edit` action** 改 `description`（**不碰任何 schema**）。
 *
 * ⚠️ 为什么不用 `set_dependencies` 那类：`edit` 是底座**已有**的 action，
 *   而且 `TeamTaskBoard.update` 的 `edit` 分支会经 `requiredText(..., 16_384)` 校验
 *   （`.../types/task-board.js:128-141`）⇒ 超长会被**底座**拒 —— 我们不猜上限。
 *
 * ⚠️ **需要 `revision`**（CAS）：调用方给的是**它刚读到的** revision。
 *   若期间有别人改过，宿主会抛 `stale team task … revision` ⇒ 这条**如实报出来**（不重试、不掩盖）。
 */
export async function updateTaskDescription(agentTeams, caller, taskId, revision, text) {
  try {
    const r = await agentTeams.updateTask(caller, {
      taskId,
      expectedRevision: revision,
      action: 'edit',
      description: text,
    })
    return { ok: true, view: r }
  } catch (err) {
    return { ok: false, why: `${err?.message ?? err}` }
  }
}
