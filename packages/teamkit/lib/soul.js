/**
 * soul.js —— **SOUL 注入**（2026-09-14 / Round 43 实现）。
 *
 * ## 这是什么（一句话）
 * 让成员的**自我迭代**（"我已经答应改什么"）在**下一步**就生效，而不是等下次装配。
 *
 * ## 为什么需要它（设计裁定的原文）
 * `runs/005-role-skills/DECISIONS.md` **P-08**：
 * > persona/preset 管**角色级身份**；**要自我迭代的 SOUL.md 走 `agent/pre-step` 注入 user message**
 * > （粒度=人头、不碰前缀、缓存安全与路由无关）。
 * 而 `PERF-LOOP.md:175` 把它记成 **"SOUL.md 注入插件不存在（伪码在 §4.3，未实现、未热卸实测）"**。
 *
 * ## 与 `principles`（已实现）的分工 —— **两者互补，不是重复**
 * | | `talents/principles/<name>.md`（已有） | `SOUL.md`（本文件） |
 * |---|---|---|
 * | 装在哪 | **系统提示词**（`systemPrompt.section`，装配期一次性） | **每步的 user message**（`agent/pre-step`） |
 * | 何时生效 | **下次装配**（本会话内改了不生效） | **下一步就生效** |
 * | 粒度 | 按**角色**（同岗位共享） | 按**人头**（"我自己答应改的"） |
 * | 适合 | 岗位的通用工作原则 | **被判决点名后**的具体承诺（"我下次不再 X"） |
 * ⇒ **裁定里要的正是"下一步生效"这一档** —— 因为绩效闭环（`PERF-LOOP.md` S2→S3）
 *   要求"**改了 → 下一轮用同一条读数复检**"；等下次装配就**跨不到下一轮**。
 *
 * ## 三条设计纪律
 * 1. **不改系统提示词**（那是 `in-history` 的代价区：改一次旧版本继续计费）⇒ 走 **user message**；
 * 2. **只在文件真变了才注入**（按 sha256 记在内存里）—— 否则每步都灌一遍，白烧 token 且稀释注意力；
 * 3. **注入失败绝不否决这一步**（与 notify 同一条纪律：waterfall 里抛错会打断整个 step）。
 *
 * ## 路径（**绝对，不给相对路径** —— Round 42 的教训）
 * `<DSH_HOME>/teamkit/soul/<name>.md`（装/写在真机落点；`ROLES_SOUL_DIR` 可覆盖）。
 * 为什么独立于 `talents/principles/`：那是**按角色**的（同岗位共享），
 * 这是**按人头**的（"这个人自己答应改什么"）—— 语义不同，**混在一起会让角色原则被人头噪音污染**。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认目录：`<stateDir>/soul/`（stateDir 由 config 解析，通常是 `$DSH_HOME/.teamkit`）。 */
export function soulFileFor(stateDir, member, cfg = {}) {
  const dir = typeof cfg.dir === 'string' && cfg.dir !== '' ? cfg.dir : join(stateDir, 'soul')
  return { dir, file: join(dir, `${member}.md`) }
}

/** 读一个人头的 SOUL（不存在 ⇒ `undefined`，**这不是错误**）。 */
export function readSoul(stateDir, member, cfg = {}) {
  const { dir, file } = soulFileFor(stateDir, member, cfg)
  if (!existsSync(file)) return { file, dir, text: undefined, sha: undefined }
  try {
    const text = readFileSync(file, 'utf8')
    const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
    return { file, dir, text, sha }
  } catch (err) {
    return { file, dir, text: undefined, sha: undefined, why: err?.message ?? String(err) }
  }
}

/** 把 SOUL 包成一条可注入的 user message（与 `notify.makeNotice` 同形）。 */
function makeSoulMessage(text, meta) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'teamkit-soul', ...meta },
  }
}

/**
 * ★★ **宿主侧读写 SOUL**（2026-09-14 / Round 48）。
 *
 * ## 为什么必须是"宿主侧"（真缺陷，实测）
 * 组织资产全在 `$DSH_HOME`（**agent 工作区之外**）：
 * ```
 *   SOUL / principles / roles / TALENTS.yml  ⇒  C:\Users\<你>\.dsh\...
 *   而 agent 的 cwd                          ⇒  D:\dsh\omc-agent-teams（它的项目）
 * ```
 * 实测（真 omc Lead 调 `write` 写自己的 SOUL）：
 * ```
 *   Error: [sandbox: file access denied under workspace-write mode]
 *          [sandbox: escalation available — retry … the approval prompt asks the user]
 * ```
 * ⇒ **成员的"自我迭代"在 `workspace-write` 沙箱下写不下去** ——
 *   `GROWTH.md` 那条"两轴成长"的**最后一米断了**（读得到内容，但写不回去）。
 *
 * ## 做法：与 `release_member` **同一形态** —— 工具在**宿主侧**执行
 * 宿主进程不受 agent 沙箱约束（实测 `fs.writeFileSync` 到 `$DSH_HOME` **成功**）
 * ⇒ 插件提供 `read_soul` / `write_soul`，由**宿主**代读代写。
 *
 * ## 三条纪律
 * 1. **只动 SOUL 那一个文件**（路径由 `soulFileFor` 算，**不接受任意路径** —— 这不是通用文件写工具）；
 * 2. **`append` 语义**：SOUL 是"一条条承诺"，**默认追加**（`mode:'append'`），
 *    整篇重写要显式 `mode:'replace'`（防手滑抹掉历史承诺）；
 * 3. **写完回读校验**（"写过了"≠"写进去了"，与 `promote` 同规矩）。
 */
export function readSoulForTool(stateDir, member, cfg = {}) {
  const r = readSoul(stateDir, member, cfg)
  return r
}

export function appendSoul(stateDir, member, text, cfg = {}) {
  const { file, dir } = soulFileFor(stateDir, member, cfg)
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, why: 'empty-text（SOUL 不写空内容）', file }
  try {
    mkdirSync(dir, { recursive: true })
    const existed = existsSync(file)
    // 追加时保证前面有换行（否则两行会粘在一起）
    const prefix = existed && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : ''
    appendFileSync(file, prefix + body.replace(/\s+$/, '') + '\n', 'utf8')
  } catch (err) {
    return { ok: false, why: `write-failed（${err?.message ?? err}）`, file }
  }
  // ★ **写完回读**（"写过了"≠"写进去了"）
  const back = readSoul(stateDir, member, cfg)
  if (back.text === undefined) return { ok: false, why: 'verify-failed（写完却读不回来）', file }
  return { ok: true, file, bytes: back.text.length, sha: back.sha }
}

export function replaceSoul(stateDir, member, text, cfg = {}) {
  const { file, dir } = soulFileFor(stateDir, member, cfg)
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, why: 'empty-text（SOUL 不写空内容）', file }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, body.replace(/\s+$/, '') + '\n', 'utf8')
  } catch (err) {
    return { ok: false, why: `write-failed（${err?.message ?? err}）`, file }
  }
  const back = readSoul(stateDir, member, cfg)
  if (back.text === undefined) return { ok: false, why: 'verify-failed（写完却读不回来）', file }
  return { ok: true, file, bytes: back.text.length, sha: back.sha }
}

/**
 * ★★ **SOUL 骨架模板**（task-101 / R120）—— **播种用**，**绝不编人格**。
 *
 * ## 为什么要有它（委托方当场问）
 * > 「其他东西全部都是由 skill、`SOUL.md`、`AGENT.md` 来沉淀的。……
 * >  你们现在团队内每个队员独立的、索引的 skill 以及 `SOUL.md`，这个功能做完没有？」
 * 现状：**读/注入做完了，播种没做**（本文件原先只有读/写，没有任何生成代码）。
 * ⇒ 本模板补的就是"**播种**"这一格：新成员一上岗，**先有一份骨架**，而不是"什么都没有"。
 *
 * ## 三条硬纪律（CEO 已裁；`soul.seed` 默认 `true` 的承重前提）
 * 1. **骨架 + 引导，绝不编"人格声明"**：
 *    · ❌ **空文件**（有形式无内容，比没有更糟）；
 *    · ❌ **系统编人格**（委托方口径：persona/preset 管**角色级身份**；
 *      **SOUL 是"我自己答应改什么"**）⇒ **替它表态 = 假**；
 *    · ✅ 只放**结构性内容** + **显式占位**（`未填`，`grep` 得到）+ 告诉它**绝对路径**该往哪写。
 * 2. ★ **不许出现第一人称承诺句**：模板里**没有任何**"我答应/我将/我不再"这类句子 ——
 *    那是**它自己**要写的，系统替它写就是伪造。
 *    （唯一那份真 SOUL `coo.md` 191B **逐字是它自己写的一句承诺** —— 那才是这份文件该长的样子。）
 * 3. **幂等 + 绝不覆盖**：`existsSync` 短路 ⇒ `seeded:false`（**已有成员的 sha 前后必须相等**）。
 *
 * ⚠️ **播种做的是"减少一个信号"，不是"新增一个机制"**：
 *   `readSoul` 读不到 ⇒ `{text: undefined}` 且**明说"这不是错误"**；注入器打 `SOUL-NONE member=…`
 *   ⇒ **"没有 SOUL"本来就可观测** ⇒ 风险小。
 */
export function soulSkeleton({ soulPath, member }) {
  const p = String(soulPath ?? '').replace(/\\/g, '/')
  return [
    '# SOUL —— 你自己答应自己改的事',
    '',
    '> **这份文件是空骨架 —— 内容「未填」。这不是错误，是"还没写"。**',
    '> 它不是别人给你的规矩，是**你自己**写的一条承诺：**以后不再做 X / 以后先做 Y**。',
    '',
    '## 它是什么（读一遍就够）',
    '- **谁写**：**你自己**。系统**不会**替你写内容 —— 替你表态就等于伪造你的承诺。',
    '- **和岗位原则的区别**：岗位原则走系统提示词（`$DSH_HOME/teamkit/talents/principles/`），',
    '  **按角色共享**、**下次装配**才生效；SOUL 是**个人**的、**改了下一次开工就带上**。',
    '- **什么时候写**：① 被评审**点名**某条缺陷之后；② 同一个坑踩了第二次。',
    '- **写在哪**（绝对路径，照抄即可）：',
    `  \`${p || '(路径未获取)'}\``,
    '',
    '## 承诺（待填）',
    '',
    '<!-- 未填：在下面写**你自己**的承诺，一条一行，越具体越好。 -->',
    '',
    '- ⬜ 未填',
    '',
    '## 怎么改（两条路，任选）',
    '- **工具**：调 `write_self {target:"soul", text:"…"}`（**宿主侧代写**，绕开 agent 沙箱；默认追加）；',
    '- **直接改**：用 `edit` 改上面那个绝对路径。',
    '',
    '> member = ' + String(member ?? '(未知)'),
    '',
  ].join('\n')
}

/**
 * ★★ **播种 SOUL 骨架**（task-101）—— **幂等、绝不覆盖、失败不静默**。
 *
 * @param stateDir 状态根（`<stateDir>/soul/<member>.md`）
 * @param member   成员名
 * @param opts.cfg    `paths.soul`（要 `dir`）
 * @param opts.enabled 是否启用（`false` ⇒ **不写**，返回 `seeded:false` + `why:'disabled'`）
 * @param opts.log
 * @returns
 *  · `{ ok:true, seeded:true, file, bytes, sha }`  —— 真的种下了
 *  · `{ ok:true, seeded:false, why:'exists', file, sha }` —— **已有内容，一个字节都没动**（幂等）
 *  · `{ ok:true, seeded:false, why:'disabled', file }`   —— 显式关闭（**调用方要把它说出来**）
 *  · `{ ok:false, why, file }`                     —— **写失败（失败不静默）**
 */
export function seedSoul(stateDir, member, { cfg = {}, enabled = true, log = () => {} } = {}) {
  const { file, dir } = soulFileFor(stateDir, member, cfg)
  // 逃生开关：**关掉就说出来**（同 `probeGate` 的形态：静默关闭 = 假机制）
  if (enabled !== true) {
    log(`SOUL-SEED-OFF member=${member} **未播种（显式关闭 soul.seed=false）** file=${file}`)
    return { ok: true, seeded: false, why: 'disabled', file }
  }
  // ★ 幂等：**已有内容 ⇒ 一个字节都不动**（返回它现有的 sha，供调用方做"前后相等"断言）
  const before = readSoul(stateDir, member, cfg)
  if (before.text !== undefined) {
    return { ok: true, seeded: false, why: 'exists', file, bytes: before.text.length, sha: before.sha }
  }
  const body = soulSkeleton({ soulPath: file, member })
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, body, 'utf8')
  } catch (err) {
    // ★ **失败不静默**（`soul.seed` 默认 true 的第三条承重前提）
    const why = `write-failed（${err?.message ?? err}）`
    log(`SOUL-SEED-FAIL member=${member} file=${file} why=${why} ⇒ **没播种**（不是"已播种"）`)
    return { ok: false, why, file }
  }
  // ★ **写完回读**（"写过了" ≠ "写进去了"，与 `appendSoul`/`replaceSoul` 同规矩）
  const back = readSoul(stateDir, member, cfg)
  if (back.text === undefined) {
    const why = 'verify-failed（写完却读不回来）'
    log(`SOUL-SEED-FAIL member=${member} file=${file} why=${why}`)
    return { ok: false, why, file }
  }
  log(`SOUL-SEEDED member=${member} file=${file} bytes=${back.text.length} sha=${back.sha}（骨架，内容「未填」）`)
  return { ok: true, seeded: true, file, bytes: back.text.length, sha: back.sha }
}

/**
 * 建一个 **SOUL 注入器**（**每人头一个实例**：它记的是"这个人上次看到的是哪一版"）。
 *
 * @param paths  解析后的配置（要用 `stateDir` / `paths.soul`）
 * @param member 人头名
 * @param log
 */
export function makeSoulInjector({ paths, member, log = () => {} }) {
  const cfg = paths?.soul ?? {}
  let lastSha = undefined // 内存：上次**注入过**的那一版
  let steps = 0
  let injected = 0

  /** 只读探测（不注入）：现在这一版是什么、要不要注入。 */
  const peek = () => {
    const r = readSoul(paths?.stateDir, member, cfg)
    if (r.text === undefined) return { ...r, shouldInject: false, why: 'no-soul-file' }
    if (r.sha === lastSha) return { ...r, shouldInject: false, why: 'unchanged' }
    return { ...r, shouldInject: true, why: lastSha === undefined ? 'first-read' : 'changed' }
  }

  /**
   * 在 `agent/pre-step` 里调用：**把 SOUL 插进这一步的 messages**。
   * ⚠️ **永不抛**（waterfall 抛错会打断整个 step）。
   */
  const sweep = (decision, signal) => {
    steps += 1
    try {
      if (cfg.enabled === false) return decision
      const p = peek()
      if (!p.shouldInject) {
        if (p.why === 'no-soul-file' && steps === 1) {
          // 只报一次（第一次没文件说明"这人不写 SOUL"，不必每步刷）
          log(`SOUL-NONE member=${member} tried=${p.file}`)
        }
        return decision
      }
      const body = String(p.text).trim()
      if (body === '') return decision
      const header =
        `**你的 SOUL（你上次答应自己改的事）** —— 来源 \`${p.file}\`\n` +
        '这是**你自己写的**，不是别人给的规矩；开工前读一眼，这轮就按它做。\n\n'
      const msg = makeSoulMessage(header + body, {
        member,
        file: p.file,
        sha: p.sha,
        why: p.why,
      })
      injected += 1
      log(`SOUL-INJECT member=${member} #${injected} step#${steps} sha=${p.sha} bytes=${body.length} why=${p.why}`)
      lastSha = p.sha
      signal?.throwIfAborted?.()
      return { ...decision, messages: [...(decision.messages ?? []), msg] }
    } catch (err) {
      // **永不否决这一步**
      log(`SOUL-ERROR member=${member} step#${steps} err=${err?.message ?? String(err)}`)
      return decision
    }
  }

  return {
    sweep,
    peek,
    get steps() {
      return steps
    },
    get injected() {
      return injected
    },
  }
}
