/**
 * dsh-teamkit —— DSH 插件入口（host 侧）。
 *
 * ## 它是什么（一句话）
 * 把 `runs/005-role-skills/exp/**` 里验证过的四件（**fork provider / 上游更新通知 /
 * 带强制说明的上游合并与回退 / A 层误操作护栏**）收敛成**一个可安装、可维护、可卸净**
 * 的插件，并带上那 7 条方法 skill。
 *
 * ## 为什么是**一个**包（task-51 A.1 的判据）
 * 四条判据，全部指向"一个包"：
 *  ① **它们共享同一套路径事实** —— 上游根 / fork 根 / history / CHANGELOG。拆成多包就必然
 *     要么复制这份配置（= 多事实来源，正是 B.1 要消灭的），要么再发明一个"配置包"（多一层）；
 *  ② **生命周期一致** —— 四件都在 `agent/created` / `agent/pre-step` 上挂钩，卸载要一起卸
 *     （"可卸净"是一条断言；多包卸一半就变成残留）；
 *  ③ **体积与依赖都是零** —— 本包**零运行时依赖、零裸 import**（运行时注入的插件目录没有
 *     node_modules，实测见 `UPSTREAM-NOTIFY.md` §A.1），拆包不省任何东西；
 *  ④ **开源用户的安装动作要少** —— 一条 `dsh plugin ... add` 比四条好（北极星：越好装越好）。
 * ⇒ **一个 bundle 包，内部四个模块**（lib/fork.js / lib/notify.js / lib/upstream.js / lib/guard.js）。
 *
 * ## "装上就有效果"（A.3 的硬要求）
 * 默认配置（全走 `lib/config.js` 的默认值）下，装上后**立刻**发生三件事，无需任何配置：
 *  ① `agent/created` 时给每个 roster teammate 建一份（空的）fork 目录并注册 provider
 *     ⇒ 它**看得见**"我自己有一份"，且空 fork = 纯 overlay 透传，**行为零变化**；
 *  ② `agent/pre-step` 时按 `sha1` 轮询上游（几十字节磁盘读，**零 token**），
 *     只在**真的变了**且**该成员持有覆盖**时推一条通知；
 *  ③ 自带 skills 装到上游根（`skills.enabled`，默认开）。
 * ⇒ 用户不需要先读文档就知道它活着：`teamkit status` 有数、日志有行、`teamkit selftest` 有判定。
 *
 * ## 生命周期（为什么这样挂）
 *  · `agent/created`：**唯一**能在"第一个提示词装配之前"注册 provider 的窗口
 *    （`dsh-agent-loop:890` 先 `assemble()`、`:894` 才发 `agent/pre-step`）。
 *    ⚠️ **同步 emit，抛错会否决 agent 发布**（`dsh-agent` runtime-types 原文
 *    *"Synchronous listener failure vetoes publication"*）⇒ 本文件里所有监听器**整体 try/catch**。
 *  · `agent/pre-step`：**waterfall + scope-filtered**（*"agent-scoped listeners receive only that agent"*，
 *    `dsh-agent\lib\types\runtime-types.d.ts:310`）⇒ **"装给谁就推给谁"是结构性给的**，
 *    不是我们判断出来的 —— 所以通知监听器**装在该 agent 自己的 ctx 上**。
 *  · `ctx.effect`：所有 disposer（provider / listener / guard）统一挂这里 ⇒ **卸载即净**。
 *
 * ## 三态诚实标注
 *  · `Config` 校验 / 路径解析 / guard 判定 / upstream 四件事的顺序 = **代码强制**（有 selftest 断言）；
 *  · fork overlay 语义（nearest wins、未改条自动跟随）= **代码强制 + 实测**（`TWO-CHANNEL-DELIVERY.md` §A.3）；
 *  · 通知的"只推该推的 / 只在不均变时推 / pending 补推" = **实测**（task-45/46）；
 *  · 通知的**送达** = **不保证**（搭车形态，形态 A；idle agent 永不收到，README 限制节写明）；
 *  · guard 是**误操作护栏**，不是安全边界（默认关）。
 */
import { dirname, join, resolve } from 'node:path'
// ⚠️ `node:fs` 只用到 `existsSync`（原则目录的候选列表）。
//   Round 16 加的"从已安装预设捞回配置"逻辑**已抽到 `config.js` 的
//   `recoverFromInstalledPreset`**（纯函数、可单测、只读）⇒ 这里不再直接读盘。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 导入语法：全部相对路径（**零裸 import** —— 运行时注入的插件目录没有 node_modules）
import { Config, detectLegacyForks, forkRootFor, pathsForAgent, recoverFromInstalledPreset, resolveAll } from './config.js'
import { makeLogger } from './log.js'
import { installSkill, scanRoot } from './skills.js'
import { installForkFor, memberNameOf, memberSelected } from './fork.js'
import { makeNotifier } from './notify.js'
import { makeSoulInjector, readSoul, seedSoul } from './soul.js'
import * as soulMod from './soul.js'
import * as selfWriteMod from './self-write.js'
import { registerGuard } from './guard.js'
import { makeReleaseManager } from './release.js'
import { registerReleaseTools } from './release-tools.js'
// ★ **E²R 结构与评审判决**（task-60）：分解边（`E_tree`）+ 评审判决（`q_v`）落到板上/台账里。
//   默认只开"零风险"那一档（台账 + description 摘要 + 三件工具）；
//   "包派生视图 + 放开出口 schema"那档（唯一可能打断任务板的形态）**默认关**。
import { makeE2rManager } from './e2r.js'
import { registerE2rTools } from './e2r-tools.js'
// ★★ **探针闸门**（task-92）：用底座自带的**文档化**口 `ctx.tools.guard()`，
//   在 `dev_stage_add` 被装之前校验 `R2`（往"会被持久化的共享对象"写字段且无回读 ⇒ 拒装）。
//   ⚠️ **生效范围 = 挂载本闸的那个 preset realm**（真读数：当前 = `omc` 那层；
//     **`standard` 的 agent 未被覆盖** —— 那是**已知缺口**，不是"全宿主都护住了"）。
//     ⚠️ 本段原先写「落 global 层 ⇒ 对全宿主生效」= **读码推断，已被真读数推翻**（留痕见 `probe-gate.js` 头）。
//   ⚠️ **liveness**：`guardReason` 在**每一次**允许的工具调用上都会被调（无论落哪层都在热路径）⇒ 实现里
//     **第一行 O(1) 短路 + fail-open + 不 await + 不读盘**（否则误杀 = 该链上停摆）。
import { registerProbeGate } from './probe-gate.js'
// 公司层（task-58 ④ / R24）：角色档 → 招募时按角色装"技能 provider + 人格段"。
// ⚠️ 段名**不能**用 `deployment:persona-prefix` —— 那是 `dsh-persona` 的段名
//    （`dsh-system-prompt:54` 的常量，`dsh-persona:37` 注册的），**每个预设都挂了 `persona` 行**
//    （`standard`/`omc` 都从 standard 抄的）⇒ 同层重名会抛 / 跨层会遮蔽整个预设 persona。
//    故用唯一名 `teamkit:role:<role>`。
import { installRoleFor, loadPrinciples, loadRoles, personaFor, roleFor } from './roles.js'
// ★★★ 保命网（2026-09-15 崩机事件）：只给本进程 stdout/stderr 装"仅管道断开"的 `'error'` 监听
import { installCrashGuard } from './crash-guard.js'

export const name = '@dsh-external/dsh-teamkit'
export const inject = ['skills', 'agents', 'tools']
export { Config }

const HERE = dirname(fileURLToPath(import.meta.url))
/** 本包目录（lib/ 的上一级）—— 用于定位自带 skills/。**不硬编码盘符。** */
export const PLUGIN_DIR = join(HERE, '..')

/**
 * 角色人格的**段名**（task-58 ④）—— 唯一名，**故意避开一切仓库段**。
 *
 * ⚠️ **不能用 `deployment:persona-prefix`**：那是 `dsh-system-prompt:54` 的常量，
 * 而 `dsh-persona` 那个 `- id: persona` 行注册的**正是它**（`dsh-persona:37`）。
 * `standard` / `omc` **每个预设都挂了 `persona` 行**（都从 `standard` 抄的）⇒ 在那个 agent 的
 * scope 里再注册同名：**同层重名会抛**（`dsh-system-prompt:240` 的 `sections.insert`），
 * **跨层则遮蔽整个预设 persona**（注释原文 *"A scoped section shadows a global section with the same name"*）。
 * **两种都坏** ⇒ 用 `teamkit:role:<role>`。
 */
const ROLE_SECTION_PREFIX = 'teamkit:role:'

/**
 * 角色人格段的 `order`。
 *
 * 我**实读**了 `dsh-system-prompt:10-40` 的 `SECTION_ORDERS` 全表：
 * ```
 * HARNESS_IDENTITY:-1000 | DEPLOYMENT_PERSONA_PREFIX:0 | PLAN_POLICY:500 | TEAM_POLICY:600
 * PTC_ONLY:800 | FILE_REFERENCE:900 | TOOL_BASH:1000 … TOOLS_SDK:5000 | STRUCTURED_OUTPUT:9900 | …
 * ```
 * ⇒ **`0` 与 `500` 之间是空的**，而角色人格是"**它是谁**"⇒ 应当**紧跟部署 persona（0）、
 * 在 plan/policy（500/600）之前**。**取 `100`。**
 * ⚠️ **不能照抄 900** —— 那是 `FILE_REFERENCE` 段位，会把人格夹进"文件引用/工具说明"之间。
 */
const ROLE_SECTION_ORDER = 100

/**
 * 读一个 agent 的**预设 id**（task-58：接管范围要按预设过滤）。
 *
 * 依据（`dsh-agent-presets\lib\index.js:1550-1552` 实读）：
 *   `composedPreset(agentCtx) { return standingMountFor(agentCtx)?.presetId }`
 *   `standingMountFor` → `scopeOf(agentCtx)` → `scopeParentOf` → `livePresetMounts()`
 * ⇒ 走的是**活的 scope 链**，**不是** `session.header.agentPreset` ——
 *   所以它对"header 还没写完的子 agent"**也答得出**。
 *
 * **绝不抛**：`agent/created` 是同步 emit，抛错会否决 agent 发布
 * （`dsh-agent\lib\types\runtime-types.d.ts:217`）⇒ 一切异常都收敛成 `undefined`。
 *
 * @returns {string|undefined} 预设 id；拿不到就是 `undefined`
 */
function agentPresetOf(ctx, agent) {
  try {
    const ap = ctx?.get?.('agentPresets')
    if (ap === undefined || typeof ap.composedPreset !== 'function') return undefined
    if (agent?.ctx === undefined) return undefined
    const v = ap.composedPreset(agent.ctx)
    return typeof v === 'string' && v !== '' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * 插件 apply。
 *
 * ⚠️ **本函数整体不能让异常逃出去**：配置文件坏、目录读不到、某个服务没就绪，
 * 都只应让**那一件事**不生效并留下信号，不该让插件加载失败（连累整个 profile）。
 *
 * @param ctx cordis 上下文
 * @param rawConfig 用户配置（profile patch / loader.create 传入；缺省 `{}`）
 * @param testOpts **仅供离线自测的接缝**（loader 只传两个参数 ⇒ 生产路径下恒为 undefined）。
 *   它让 `--selftest` 能在**沙盒 env/cwd** 下跑真 `apply()`，而不是让测试去改 `process.env`。
 */
export function apply(ctx, rawConfig = {}, testOpts = undefined) {
  // ── 0) 配置解析（**唯一事实来源**）─────────────────────────────────────
  let paths
  try {
    paths = resolveAll(rawConfig, {
      pluginDir: PLUGIN_DIR,
      ...(testOpts?.env === undefined ? {} : { env: testOpts.env }),
      ...(testOpts?.cwd === undefined ? {} : { cwd: testOpts.cwd }),
    })
  } catch (err) {
    process.stderr.write(`teamkit: CONFIG-RESOLVE-FAIL ${err?.message ?? String(err)}\n`)
    return { error: `CONFIG-RESOLVE-FAIL: ${err?.message ?? String(err)}`, paths: undefined }
  }

  // ★★ **把"从已安装预设捞回的 `upstream.root`"补回 paths**（2026-09-14 / Round 17）。
  //
  // 【为什么必须】**`upstream.root` 是写路径**（`promote` 合并 / 快照 / CHANGELOG / "上游变了"的判据），
  //   而**读路径**由预设里 `skill-filesystem` 的 `customSkillDirs` 决定。
  //   **两者不同指 ⇒ 上游链断开**（Round 5 实测过：成员 promote 上去后**自己和队友都看不到，且不报错**）。
  //   Round 16 我只捞了 `presetId` / `rolesDir` ⇒ 裸实例的 `upstream.root` 仍是默认 `$DSH_HOME/skills`，
  //   而 `omc` 的读路径是 `$DSH_HOME/teamkit/skills-upstream` ⇒ **读写不同指**（本轮实测的
  //   `APPLY {"upstreamRoot":"<用户目录>\\.dsh\\skills"}` 就是它）。
  //   ⚠️ **2026-09-15 脱敏**：原文逐字写了本机用户名 ⇒ 改成占位符（开源不可逆）。
  //
  // 【纪律】**只在用户没显式配 `upstream.root` 时**才用它 —— 显式配置永远优先（单一事实来源）。
  const recoveredCfg = recoverFromInstalledPreset(paths.dshHome, '@dsh-external/dsh-teamkit', process.env)
  const explicitUpstream = (() => {
    const a = rawConfig?.upstream?.root
    return typeof a === 'string' && a !== '' ? a : undefined
  })()
  if (explicitUpstream === undefined && recoveredCfg.upstreamRoot !== '') {
    paths = { ...paths, upstream: { ...paths.upstream, root: recoveredCfg.upstreamRoot } }
  }

  const log = makeLogger(paths.logFile, { prefix: 'teamkit' })
  log.info('APPLY', {
    pluginDir: PLUGIN_DIR,
    workspace: paths.workspace,
    dshHome: paths.dshHome,
    upstreamRoot: paths.upstream.root,
    forkRootTemplate: paths.forkRootTemplate,
    historyDir: paths.historyDir,
    changelog: paths.changelogPath,
    skills: paths.skills.enabled,
    fork: paths.fork.enabled,
    notify: paths.notify.enabled,
    guard: paths.guard.enabled,
  })

  const disposers = []
  /** 每个成员一个通知器（它自己的 fork + 它自己的节流/待推队列）。 */
  const notifiers = new Map()

  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ **保命网：给本进程的 stdout/stderr 装 `'error'` 监听**（2026-09-15 / 崩机事件）
  //
  // 【现场】`D:\dsh\desktop\web.log` 里 5 起 `write EOF` ⇒ `dsh exited code=1`：
  // ```
  //   Error: write EOF / at WriteWrap.onWriteComplete (node:internal/stream_base_commons:87:19)
  //   Emitted 'error' event on Socket instance at: …
  //   errno: -4095, code: 'EOF', syscall: 'write'
  // ```
  // 【根因链（CEO 逐行核，我独立复核）】
  // ```
  //  ① 桌面壳 `D:\dsh\desktop\main.js:169` 的 `spawn(DSH_NODE, [DSH_CLI, …])` **不给 `stdio`**
  //     ⇒ Node 默认 `'pipe'` ⇒ `child.stdout`/`child.stderr` 是 **net.Socket**
  //  ② ★★ 而**壳自己**在 `:17` 给**它自己**装了同款防护（注释逐字「防 EPIPE」）——
  //     ★ **它保护了自己，没保护 spawn 出去的 dsh 子进程**
  //  ③ ⇒ 管道被关后，**子进程**下一次 write 抛**未捕获 `'error'`** ⇒ **进程自杀 `code=1`**
  // ```
  // 【本网做什么】**范围最小**：只给 `stdout`/`stderr` 挂 `'error'`，且**只吞管道断开那一族**
  // ```
  //  · 只吞 `code === 'EOF' | 'EPIPE'`（或 `errno === -4095` 且栈含 Socket/WriteWrap）
  //  · ★★ **别的 error ⇒ 重新抛**（→ 未捕获 → 走 Node 默认行为 → 崩）⇒ **不掩盖任何别的错误**
  //  · ⛔ **不装 `process.on('uncaughtException')`** —— 那会吞掉**所有**异常（含我们自己的 bug）。
  //    （★ 我第一版写过它，**已按 CEO §④③ 的硬边界撤掉** —— 那条边界是对的。）
  //  · ★ **可卸净**：`dispose()` 移除监听 ⇒ `listenerCount('error')` 回到原值（`R22`）
  // ```
  // 【能红证据】`tools/crash-guard-test.mjs` ⇒ **PASS 12/12**（四条判据**双向**）：
  // ```
  //  ① 装网+管道断 ⇒ **不死** / 不装网 ⇒ **照旧崩**（`Emitted error event on Socket instance`）
  //  ② ★ 装网 + 普通 `TypeError` ⇒ **照旧崩**（**这条才是"没有掩盖错误"**）
  //  ③ 监听器计数：装前 **0** / 装后 **1** / 卸后 **0**
  //  ④ 非管道类 error（`EBADF`）⇒ **照旧抛**（不是"什么都吞"） · ⑤ 正常 `console.log` 照常出去
  // ```
  // 【为什么交给插件做】这是"**把桌面壳对它自己做过的事，应用到子进程侧**" ——
  //   而**我们不该去改壳**（`D:\dsh\desktop` 不是本仓）· 也**不该改 DSH 本体**（硬规矩 1）。
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ **配置变量名是 `paths`，不是 `cfg`**（2026-09-15 我第一版写错 ⇒ `ReferenceError: cfg is not defined`
  //   ⇒ ★ **`apply()` 直接抛错** ⇒ selftest 的 `G` 组连带 9 条假红（"apply() 抛错 ⇒ 连累整个 profile"））
  //   ⇒ 教训：**改装配点后必须立刻跑 `selftest`** —— 它当场抓住了（这正是那组断言存在的意义）。
  //
  // ★★ **CEO 判据②（2026-09-15）：装/不装都必须【留一条日志】** ——
  //   「否则"网生效没生效"只能靠读进程监听器 ⇒ 而那是'看不见的状态'」。
  //   ⇒ 所以三个分支**各有一条**（装成功 / 显式关掉 / 装配失败）⇒ `grep CRASH-GUARD teamkit.log` 恒有读数。
  if (paths.crashGuard.enabled === true) {
    try {
      // ★ 传 `uncaught: true` 显式化（原来靠默认值 —— 而"进程级兜底装没装"正是要报的那件事）
      const g = installCrashGuard({ log: (m) => log.info('CRASH-GUARD', m), uncaught: true })
      disposers.push(g.dispose)
      const s = g.stats()
      // ★★★ **两组数都要报**（`B79` · 2026-09-18）—— 原来只报 `s.before`（stdout/stderr）
      // ```
      // 【背景】09-17 23:03 起的那台宿主在 **09:51 崩过**（`write EOF`）· 崩的是
      //   `dsh-host-webserver` 的 **upgrade socket** ⇒ **不是 `process.stdout/stderr`**
      //   ⇒ ★ 而**那条网能兜住它的唯一位置就是【进程级】**（`uncaughtException`）
      // 【★ CEO 判据②的原文是】「**装/不装都必须留一条日志** ——
      //   否则"网生效没生效"只能靠读进程监听器 ⇒ 而那是'看不见的状态'」
      //   ⇒ ⚠️ **而原日志【只报了 stdout/stderr 那一半】** ⇒ **"进程级兜底装没装"依然不可见**
      //     ⇒ ★★ 即：**判据的意图是"让状态可见"，而那条日志没覆盖进程级那一半**
      // 【★ 为什么这一半最要紧】读日志的人要回答的问题是
      //   「**今天崩的那种（socket EOF），它够不够得到？**」
      //   ⇒ ★ 所以这里**不只报数字，还明说它够得到什么**（否则数字没有用）。
      // ```
      const uncaughtOn = s.afterUncaught > s.beforeUncaught
      log.info(
        'CRASH-GUARD-INSTALLED',
        `stdout/stderr 已装"仅管道断开(EOF/EPIPE)"保命网（可卸）` +
          ` · stdout/stderr 监听 ${JSON.stringify(s.before)} ⇒ ${JSON.stringify(s.after)}` +
          ` · ★ **进程级 uncaughtException 兜底** [${s.beforeUncaught}] ⇒ [${s.afterUncaught}]` +
          `（${uncaughtOn ? '**已装**' : '⚠️ **未装**'}）` +
          ` · ★ **本网够得到 \`process.stdout/stderr\`【以及进程级未捕获的管道错（EOF/EPIPE）】**` +
          ` ⇒ \`dsh-host-webserver\` 的 upgrade socket EOF **也兜得住**`,
      )
    } catch (err) {
      // ★ 装配失败**必须响**（否则用户以为装了）
      log.warn('CRASH-GUARD-INSTALL-FAIL', err?.message ?? String(err))
    }
  } else {
    // ★ 显式关掉也要留痕（`enabled: false`）—— 否则"没日志"分不清"关了"还是"没装上"
    log.info('CRASH-GUARD-SKIPPED', '已按配置关闭（crashGuard.enabled = false）')
  }
  /** 已装过 fork 的 agent id（**本实例内**不重复装）。 */
  const forkedAgents = new Set()
  /** 已挂过监听器的 agent id。 */
  const listeningAgents = new Set()
  /** ★ 已给**哪些 Lead** 挂过 SOUL 监听（Round 44：Lead 也有独立成长位）。 */
  const leadSoulAgents = new Set()

  // ── ★ 进程级 fork 登记（task-59 根因修复）────────────────────────────────
  //
  // 【为什么需要它】实测（`exp/instance-probe/probe-C-reload-order.mjs` + `probe-E-real-reload.mjs`）：
  //   重载插件时**多个实例会同时活着**（日志 `16:22:30`：三个实例在 28 ms 内先后 APPLY，
  //   而旧实例的 `PLUGIN-DISPOSE` 还没跑），而 `forkedAgents` 是**实例闭包里的 Set**
  //   ⇒ **新实例看不见旧实例装过什么** ⇒ 它扫 `apply-existing` 时给同一个 agent
  //   再注册同名 provider ⇒ `a skill provider named "teamkit-fork" is already registered in this scope`。
  //
  // 【为什么不是"把 disposer 挂到 agent.ctx"】实测（`probe-F-boundaries.mjs`）：那样**不解决问题** ——
  //   "同一 agent 被两次 apply"时 agent **还活着** ⇒ 实例#1 的 effect 还在 ⇒ provider 还在 ⇒ 照样撞名。
  //
  // 【为什么这个修法安全】实测（`probe-G-stale-disposer.mjs`）：
  //   ① 手动调 `registerProvider` 返回的 disposer **有效**（卸后同 scope 可再注册）；
  //   ② **陈旧 disposer 不会反杀新 provider** —— `undo()` 是**按注册身份**删，不是按名字删
  //      （故"先卸后装"后，旧实例收尾时再调一次旧 disposer 也伤不到新 provider）；
  //   ③ 旧 scope 已销毁后再调旧 disposer **不抛**（可安全忽略）。
  //
  // 【覆盖三类受管注册】`key` 是"同一个 agent scope 内会撞名的名字"：
  //   · `fork:<name>`    → `teamkit-fork`（`fork.js`）
  //   · `role:<name>`    → `teamkit-role-<role>`（`roles.js`）—— **同一形态，必须一起修**
  //   · `persona:<name>` → `teamkit:role:<role>`（`systemPrompt.section`）—— `dsh-system-prompt:188`
  //                        同层重名**会抛**（实测 `probe-N-persona-real.mjs`）
  //   ⚠️ **只修 fork 而不修后两者 = 改了一半**（Lead 反复强调的形态）：重挂时角色技能与人格段照样撞
  //      —— `probe-M-role-gap.mjs` 实测 `ROLE-SKIP ... teamkit-role-engineer is already registered`。
  //
  // 【登记里存什么】`agent.id -> Map<key, {disposer, gen, owner, member}>`。
  //   ⚠️ **不持有 agent 对象**：disposer 闭包只捕获路径字符串（`fork.js:156` / `roles.js:280`），
  //   不含 agent ⇒ 强引用**不会**拖住 agent。
  const REGISTRY_KEY = Symbol.for('dsh-teamkit:registry')
  /** 本实例的身份（用于"只清自己那份登记"）。 */
  const instanceId = Symbol('teamkit-instance')
  /**
   * **进程级**代次计数器（与登记同一个 Symbol 下）。
   * ⚠️ 不能是实例内的 `let forkGen = 0` —— 那样每个新实例都从 1 开始，
   *   日志里的 `gen` 会**永远重复**（实测：三次 apply 都报 `gen:1`），
   *   于是"这是第几代"这个最有用的诊断信息就废了。
   */
  const GEN_KEY = Symbol.for('dsh-teamkit:gen')
  /**
   * **进程级**：哪些实例是"**有配置的**"（用于让**裸实例让位**，见 `inScope`）。
   * 值 = `Map<instanceId, {at:number, presetId:string|undefined}>`。
   * 为什么必须是**进程级**：判定问的是"**进程里有没有别的有配置实例**"，
   * 那正是单实例闭包看不见的东西（与 fork 登记同一个理由）。
   */
  const CONFIGURED_KEY = Symbol.for('dsh-teamkit:configured-instances')
  /** 进程级登记：`agent.id -> Map<key, {disposer, gen, owner, member}>`（跨实例可见）。 */
  const registry = (() => {
    try {
      const cur = globalThis[REGISTRY_KEY]
      if (cur instanceof Map) return cur
      if (cur !== undefined) {
        log.warn('REGISTRY-TYPE-CONFLICT', { key: String(REGISTRY_KEY), got: typeof cur, action: 'replaced-with-Map' })
      }
      const fresh = new Map()
      globalThis[REGISTRY_KEY] = fresh
      return fresh
    } catch (err) {
      // 拿不到 `globalThis` 也不能让 apply 挂（退化成"只有实例内去重"的旧行为）
      log.warn('REGISTRY-UNAVAILABLE', { err: err?.message ?? String(err), fallback: '实例内 Set（= 旧行为，重挂仍可能撞名）' })
      return new Map()
    }
  })()

  /** 进程级递增代次（跨实例单调）—— 见上方 `GEN_KEY` 的说明。 */
  const nextGen = () => {
    try {
      globalThis[GEN_KEY] = (typeof globalThis[GEN_KEY] === 'number' ? globalThis[GEN_KEY] : 0) + 1
      return globalThis[GEN_KEY]
    } catch { return undefined }
  }
  /** 取某 agent 的登记子表（懒建）。 */
  const slotFor = (agentId) => {
    let slot = registry.get(agentId)
    if (slot === undefined) { slot = new Map(); registry.set(agentId, slot) }
    return slot
  }
  /**
   * **先卸后装**的公共入口：该 `agent+key` 已登记过就先卸掉旧的（可观察），并把它从登记里摘掉。
   * @returns `{preDisposed: string, prev: object|undefined}`
   */
  const preDispose = (agentId, key, ctxInfo) => {
    const prev = registry.get(agentId)?.get(key)
    if (prev === undefined) return { preDisposed: 'none（首次：登记里没有这条）', prev: undefined }
    let preDisposed = 'disposed'
    try {
      prev.disposer()
    } catch (err) {
      // 不是失败：disposer 可能已随旧 scope 销毁而失效（实测：旧 scope 销毁后再调**不抛**）
      preDisposed = `dispose-threw: ${err?.message ?? String(err)}`
      log.warn('PRE-DISPOSE-THREW', {
        key, ...ctxInfo,
        prevOwnerIsThisInstance: prev.owner === instanceId, prevGen: prev.gen,
        next: '仍然尝试重新注册（旧的那份可能已不在）',
      })
    }
    registry.get(agentId)?.delete(key)
    return { preDisposed, prev }
  }
  /** 登记一条受管注册（跨实例可见）。@returns 该条的代次 */
  const remember = (agentId, key, disposer, member) => {
    const gen = nextGen()
    slotFor(agentId).set(key, { disposer, gen, owner: instanceId, member })
    return gen
  }

  log.info('REGISTRY-READY', {
    key: String(REGISTRY_KEY),
    agentsTracked: registry.size,
    nextGen: (() => { try { return typeof globalThis[GEN_KEY] === 'number' ? globalThis[GEN_KEY] + 1 : 1 } catch { return 1 } })(),
    covers: ['fork:teamkit-fork', 'role:teamkit-role-<role>', 'persona:teamkit:role:<role>'],
    note: '跨实例可见；本次 apply 会把已存在的旧注册先卸后装',
  })

  // ── 接管范围：**只接管"与本次挂载同一预设"的 teammate**（task-58）────────────
  //
  // 【背景】委托方明令「**同时呢其他的 preset…不会受到影响。**」
  //   而修复前：`apply-existing` 兜底按 **roster 身份**选人、**不看预设**
  //   ⇒ 真宿主实测把 `standard` 预设的 3 个成员（plugin-smith / upstream-keeper /
  //     docs-writer）也装了 fork（Lead 的现场日志 `[15:44:07] FORK-REGISTER-OK (why="apply-existing…")`）。
  //
  // 【配置】优先用 `config.js` 解析出的 `paths.preset.id`（**单一事实来源**，task-51 B.1）；
  //   回落到 `rawConfig.preset?.id` / `rawConfig.presetId` —— 这样即使 `config.js` 尚未暴露该键
  //   （跨文件协调中），过滤**依然生效**，不会静默退回"全接管"那个 bug。
  //   ⚠️ **默认 `undefined`/`''` = 不过滤**（向后兼容旧行为）。
  /**
   * **从已安装的预设捞回本插件配置**（只读）。见 `config.js` 的 `recoverFromInstalledPreset` 长注释。
   * ⚠️ **必须在 `presetId` / `rolesDir` 之前求值**（它们要用这个结果）—— `const` 有 TDZ，
   *    放到下面会抛 `Cannot access before initialization`（我先写错过一次，靠 `node --check` 抓不出来）。
   * ⚠️ **`paths.upstream.root` 的补回在更上面**（`resolveAll` 之后立刻做）—— 因为 `pathsForAgent` /
   *    `SKILLS-SYNC` 等都要用它，那些东西在这里之前就已经被引用不到（`paths` 已被重新赋值）。
   */
  const recoveredFromPreset = recoveredCfg
  const presetId = (() => {
    const fromPaths = paths?.preset?.id
    if (typeof fromPaths === 'string' && fromPaths !== '') return fromPaths
    const raw = rawConfig?.preset?.id ?? rawConfig?.presetId
    if (typeof raw === 'string' && raw !== '') return raw
    // ★ **兜底：从已安装的预设捞回 `preset.id`**（Round 16）。
    //   捞不到 ⇒ `inScope` 走"裸实例"分支 ⇒ 要么全接管（污染别的预设）、要么让位（什么都不装），
    //   **两种都不对**。实现见 `config.js`（可单测的纯函数）。
    return recoveredFromPreset.presetId
  })()
  //
  // 【为什么 fail-closed】拿不到 `composedPreset` 证据时**跳过**，而不是照装：
  //   · fail-open（照装）⇒ 会越界接管别的预设 —— **正是本任务要修的 bug**；
  //   · fail-closed（跳过）⇒ 该成员**漏装** fork（日志 `SKIP-NO-PRESET-EVIDENCE`，可观测、可重试）。
  //   两害相权取"漏装"：漏装是少一个能力，越界是**破坏了别人的隔离承诺**。
  //
  // ★ **登记"本实例是不是有配置的"**（2026-09-14 / Round 16）：
  //   判据 = **该实例有没有来自预设的配置**（`preset.id` / `roles.dir` / 自定义 `upstream.root`）。
  //   为什么要登记：裸实例（热重载/注入挂在根上的那份，**读不到预设 config**）**不能接管** ——
  //   它给不出角色与正确的上游，接管只会"抢了活又干不了"（实测 `coo` 的 `ROLE-SKIP`）。
  //   而"要不要让位"问的是"**进程里有没有别的有配置实例**"⇒ 必须跨实例可见 ⇒ 进程级表。
  const isConfiguredInstance = (() => {
    if (presetId !== undefined) return true
    const rolesDirConfigured = typeof paths?.roles?.dir === 'string' && paths.roles.dir !== ''
    const upstreamCustomized = resolve(paths.upstream.root) !== resolve(join(paths.dshHome, 'skills'))
    return rolesDirConfigured || upstreamCustomized
  })()
  const configuredInstances = (() => {
    try {
      const cur = globalThis[CONFIGURED_KEY]
      if (cur instanceof Map) return cur
      const fresh = new Map()
      globalThis[CONFIGURED_KEY] = fresh
      return fresh
    } catch { return new Map() }
  })()
  const configuredOwned = isConfiguredInstance
  if (configuredOwned) configuredInstances.set(instanceId, { at: Date.now(), presetId: presetId ?? null })

  log.info('SCOPE-GATE', {
    presetId: presetId ?? '(未配置：不过滤，向后兼容)',
    how: 'agentPresets.composedPreset(agent.ctx)（走活 scope 链）',
    onMissing: 'skip（fail-closed：拿不到证据不接管别人）',
    configuredInstance: configuredOwned,
    configuredPeers: configuredInstances.size,
    recoveredPreset: recoveredCfg.presetFile ?? '(无：本机没装引用本包的预设)',
  })

  // ★★ **读写同指自查**（2026-09-14 / Round 17）—— 这是本项目**踩过两次**的同一类事故：
  //   写路径 = `paths.upstream.root`（`promote` / 快照 / CHANGELOG / "上游变了"的判据）；
  //   读路径 = 预设里 `skill-filesystem` 的 `customSkillDirs`（**由 DSH 决定，插件的 paths 里没有它**）。
  //   ⇒ **两者不同指 ⇒ 上游链静默断开**（Round 5 实测：成员 promote 上去后**谁都看不到，且不报错**）。
  //   ⇒ 这里**主动把两边都算出来比一遍**，不一致就 WARN（**失败不静默**）。
  //   ⚠️ 只在"从预设捞回了读路径"时才有得比；比不了就**明说比不了**（不写成"一致"）。
  {
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const readDirs = recoveredCfg.customSkillDirs ?? []
    const writeDir = paths.upstream.root
    if (readDirs.length === 0) {
      log.info('UPSTREAM-COPOINT-SKIP', {
        writeDir,
        why: '拿不到读路径（本机没装引用本包的预设 / 预设里没写 customSkillDirs）⇒ **这一项没验**，不是"已一致"',
      })
    } else {
      const mismatch = readDirs.filter((d) => norm(d) !== norm(writeDir))
      if (mismatch.length === 0) {
        log.info('UPSTREAM-COPOINT-OK', { dir: writeDir, checked: readDirs.length })
      } else {
        log.warn('UPSTREAM-COPOINT-MISMATCH', {
          writeDir,
          readDirs,
          mismatch,
          consequence: '读写不同指 ⇒ 成员 promote 上去之后**自己和队友都看不到**，且**不报错**（Round 5 实测过）',
          fix: '把预设里的 `upstream.root` 与 `skill-filesystem.customSkillDirs` 指到同一个目录',
        })
      }
    }
  }

  /**
   * 本 agent 是否落在接管范围内。
   *
   * ⚠️⚠️ **2026-09-14（Round 16）补了"裸实例让位"这一支** —— 实测抓到的真缺陷：
   *
   * 【缺陷】`presetId === undefined` 时原来**无条件全接管**（`no-preset-configured`）。
   *   而"**没有预设配置的实例**"是**真实存在**的：热重载/注入路径会把插件挂在**根**上，
   *   那个实例**读不到预设里的 `config`** ⇒ `presetId === undefined` ⇒ **它全接管**。
   *   【实测现场】热重载后让 `omc` 队招 `coo`：
   *     ```
   *     FORK-REGISTER-OK member=coo dir=…\forks\6ac4f43a\coo\skills   ← 裸实例接受了
   *     ROLE-SKIP        member=coo why=no-role（该成员名没有角色档）   ← 但它没有 roles.dir，给不出角色
   *     ROLES-LOADED     {"dir":"(未配置)","readable":false,"n":0}
   *     ```
   *   ⇒ **"接管了却服务不了"**：成员**拿到 fork、丢了角色**，且看不出是插件装错了实例。
   *
   * 【修法的难点】**不能简单地把"无配置"一律当成"不接管"** —— 那会**打掉"装上就有效果，零配置"**
   *   这个本插件的第一承诺（纯安装场景本来就没有 `roles.dir`、`upstream.root` 也是默认值）。
   *
   * 【所以判据是"进程里有没有别的**有配置**的实例"】（不是"我自己有没有配置"）：
   *   · 有配置的实例在场 ⇒ 裸实例**让位**（记 `skip-bare-instance`）—— 因为那个实例才是真正在服务的；
   *   · 没有 ⇒ 裸实例**照常接管**（零配置安装场景，行为与修复前一致）。
   *   这条判据用**进程级登记**（`globalThis[CONFIGURED_KEY]`，与 fork 登记同一个 `Symbol.for` 家族）
   *   —— 它能跨实例看见，正是"多实例并存"这个问题需要的视角。
   *
   * @returns {{take: boolean, why: string, got: string|undefined}}
   */
  const inScope = (agent) => {
    if (presetId === undefined) {
      // 裸实例：只有当**进程里还有"不是自己"的有配置实例**时才让位
      const peers = [...configuredInstances.keys()].filter((k) => k !== instanceId).length
      if (peers > 0) {
        return { take: false, why: `skip-bare-instance（进程里有 ${peers} 个有配置的实例在场 ⇒ 裸实例让位，避免"抢了活又干不了"）`, got: undefined }
      }
      return { take: true, why: 'no-preset-configured（零配置安装：全接管，向后兼容）', got: undefined }
    }
    const got = agentPresetOf(ctx, agent)
    if (got === undefined) return { take: false, why: 'skip-no-preset-evidence（composedPreset 拿不到）', got: undefined }
    if (got === presetId) return { take: true, why: 'in-scope', got }
    return { take: false, why: `skip-foreign-preset（got=${got}, want=${presetId}）`, got }
  }

  // ── 1) 自带 skills → 上游根（"装上就有效果"①）────────────────────────
  if (paths.skills.enabled) {
    try {
      const scan = scanRoot(paths.skills.sourceDir)
      if (!scan.readable) {
        log.warn('SKILLS-SOURCE-UNREADABLE', { dir: paths.skills.sourceDir, why: scan.why })
      } else if (!scan.existing) {
        log.warn('SKILLS-SOURCE-MISSING', { dir: paths.skills.sourceDir, note: '自带 skills 没找到 ⇒ 这一项不生效（不是"装好了"）' })
      } else {
        let installed = 0
        let skipped = 0
        let updated = 0
        const foreign = []
        for (const entry of scan.entries) {
          const r = installSkill(entry, paths.upstream.root, { overwrite: paths.skills.overwrite })
          if (r.action === 'installed' || r.action === 'overwritten') installed += 1
          else if (r.action === 'updated') {
            // ★ **我们装的旧版 ⇒ 已更新**（Round 47 修的真 bug：改了技能但用户读到旧版）
            updated += 1
            log.info('SKILL-UPDATED', { name: entry.name, why: r.why, dst: r.dst })
          } else if (r.action === 'skipped-exists' || r.action === 'skipped-foreign') {
            skipped += 1
            if (r.action === 'skipped-foreign') foreign.push(entry.name)
          } else if (r.action === 'failed') log.error('SKILLS-INSTALL-FAIL', { name: entry.name, why: r.why })
        }
        // ⚠️ **失败不静默**：源里被跳过的坏条目要显式报出来（用户否则以为它不在）
        for (const s of scan.skipped) log.warn('SKILLS-SOURCE-SKIPPED', { name: s.name, why: s.why })
        // ⚠️ **"跳过了不是我们装的那几条"也要说**（否则用户以为技能已更新、其实没有）
        if (foreign.length > 0) {
          log.warn('SKILLS-SKIPPED-FOREIGN', {
            names: foreign,
            why: '同名技能**不是本插件装的**（没有 `.teamkit` 标记）⇒ 按原语义**不覆盖**；要覆盖请设 `skills.overwrite=true`',
          })
        }
        log.info('SKILLS-SYNC', { source: paths.skills.sourceDir, dst: paths.upstream.root, found: scan.entries.length, installed, updated, skipped, bad: scan.skipped.length })
      }
    } catch (err) {
      log.error('SKILLS-SYNC-ERROR', err?.message ?? String(err))
    }
  }

  // ── 2) roster teammate 的 fork 与通知 ────────────────────────────────
  // 先**一次**加载角色档（**全局一份**，像 upstream 那样；不是每个 agent 重读）。
  // ⚠️ 配置来源：**优先 `paths.roles.dir`**（`config.js` 解析出的单一事实来源），
  //    回落 `rawConfig.roles?.dir`（跨文件协调期/降级时仍生效）。
  //    依赖状态：**已解除** —— `roles: { dir: 'str' }` 已注册进 `config.js` 的 `DEFAULTS` / `resolveAll` / `SHAPE`
  //    （Lead 2026-09-14 完成并自跑验过：缺省 `''`、配了即透传、类型错/未知子键都 REJECT）。
  //    未配置（`''`）⇒ 角色层**空**，此时 `ROLES-LOADED {n:0, skipped:1}` 明说"这一项没生效，不是装好了"。
  const rolesDir = (() => {
    const fromPaths = paths?.roles?.dir
    if (typeof fromPaths === 'string' && fromPaths !== '') return fromPaths
    const raw = rawConfig?.roles?.dir
    if (typeof raw === 'string' && raw !== '') return raw
    // ★ **兜底：从"已安装的预设"里把公司层配置捞回来**（2026-09-14 / Round 16）
    //   实测事故：热重载后重建的实例**读不到预设 config**，而**新建会话不会重新 apply 插件**
    //   ⇒ 裸实例仍接管成员，但 `roles.dir=''` ⇒ **成员"有 fork、没角色"**：
    //     `ROLE-SKIP {"why":"no-role（该成员名没有角色档）"}`（其实角色档在）。
    //   实现见 `config.js` 的 `recoverFromInstalledPreset`（纯函数、可单测、只读）。
    return recoveredFromPreset.rolesDir
  })()
  let loadedRoles = { roles: new Map(), skipped: [], dir: rolesDir, readable: false }
  // ★ **工作原则（自演化位）的惰性缓存**：按角色名缓存，避免每次 agent 装配都读盘。
  //   为什么按角色名而不是按 agent：**原则属于"岗位"**（`talents/principles/<role>.md` 与原版
  //   每人的 `work_principles.md` 对应）—— 同岗位的人共享同一份原则，改一次全体受益。
  //   ⚠️ 缓存只在**本实例**内有效（`apply` 一次建一个）⇒ 重挂后重新读盘 ⇒ 改了文件下次装配生效。
  const personaPrinciples = { cache: new Map(), dir: '', loaded: false }
  // ⚠️ **原则目录的约定**（读 `talents/principles/README.md` + `COMPANY-LAYER.md:259` 定的，不是猜）：
  //   原则文件是 **`talents/principles/<name>.md`**（对应原版每人的 `work_principles.md`）；
  //   角色档里的 `principles` 字段是**相对路径**（`principles/<name>.md`），目录由**这里**定。
  //
  // ⚠️ **不要用"往上的层数"硬推**（我第一版就是 `<rolesDir>/../../talents/principles`，
  //   实测推成了 `<repo>/runs/talents/principles` —— **少一层**，于是"7 份角色全部没写过原则"）。
  //   `rolesDir` 的形状取决于用户怎么配（`runs/005-role-skills/roles` / 别的深度），
  //   **层数不是不变量**。
  //   ⇒ 改用**候选列表 + "哪个真的存在"**（`LANDMINES §4`：候选列表，不要单一算法）：
  //     ① 显式配置（`paths.principles.dir` / `rawConfig.principles.dir`）—— 最优先；
  //     ② 从 `rolesDir` **逐级向上**找 `talents/principles`（命中即用）；
  //     ③ 从插件自己的**工作区**找 `<workspace>/talents/principles`（默认布局）；
  //   一个都没命中 ⇒ `''`，`personaFor` 会**明说"还没写"**（不是静默）。
  const principlesDirOf = (rolesDirRaw) => {
    const explicit = (() => {
      const a = paths?.principles?.dir
      if (typeof a === 'string' && a !== '') return a
      const b = rawConfig?.principles?.dir
      return typeof b === 'string' && b !== '' ? b : ''
    })()
    if (explicit !== '') return explicit
    const cands = []
    if (typeof rolesDirRaw === 'string' && rolesDirRaw !== '') {
      // 从 rolesDir 自身开始，向上最多 5 级找 `talents/principles`
      let cur = resolve(rolesDirRaw)
      for (let i = 0; i < 5; i += 1) {
        cands.push(join(cur, 'talents', 'principles'))
        const up = dirname(cur)
        if (up === cur) break
        cur = up
      }
    }
    if (typeof paths?.workspace === 'string' && paths.workspace !== '') {
      cands.push(join(paths.workspace, 'talents', 'principles'))
    }
    for (const c of cands) {
      if (existsSync(c)) return c     // **判据是"目录真的存在"**，不是"路径看着像"
    }
    log.warn('PRINCIPLES-DIR-NOT-FOUND', { tried: cands.slice(0, 6) })
    return ''
  }
  const principlesForRole = (role) => {
    if (role === undefined) return { text: undefined, file: undefined }
    if (!personaPrinciples.loaded) {
      personaPrinciples.loaded = true
      personaPrinciples.dir = principlesDirOf(rolesDir)
      log.info('PRINCIPLES-DIR', { dir: personaPrinciples.dir || '(未配置 roles.dir ⇒ 无原则目录)' })
    }
    // ★ **绝对路径必须给出去**（2026-09-14 事故）：只给相对路径 ⇒ teammate 会**猜**写入点，
    //   而猜错就是"写入点 ≠ 读取点" ⇒ 它写的新原则，下一个同岗位的人读不到（"组织会学习"静默断链）。
    const absFile = personaPrinciples.dir === '' || typeof role.principles !== 'string'
      ? undefined
      : join(personaPrinciples.dir, role.principles.split(/[\\/]/).pop())
    if (personaPrinciples.dir === '') return { text: undefined, file: absFile }
    if (personaPrinciples.cache.has(role.name)) return { text: personaPrinciples.cache.get(role.name), file: absFile }
    const got = loadPrinciples(personaPrinciples.dir, role.name)
    let value
    if (got === undefined) {
      value = undefined                     // 还没写过 —— 正常状态（`personaFor` 会明说）
    } else if (got.error !== undefined) {
      value = undefined
      log.warn('ROLE-PRINCIPLES-READ-FAIL', { role: role.name, why: got.error })   // 失败不静默
    } else {
      value = got.text
      log.info('ROLE-PRINCIPLES-LOADED', { role: role.name, file: got.file, bytes: got.text.length })
    }
    personaPrinciples.cache.set(role.name, value)
    return { text: value, file: absFile }
  }
  try {
    loadedRoles = loadRoles(rolesDir, (line) => log.warn('ROLE-SKIPPED', line))
    log.info('ROLES-LOADED', {
      dir: rolesDir || '(未配置)',
      readable: loadedRoles.readable,
      n: loadedRoles.roles.size,
      names: [...loadedRoles.roles.keys()].sort(),
      skipped: loadedRoles.skipped.length,
    })
  } catch (err) {
    // 失败不静默，也**绝不外抛**（apply 整体不能因一项坏掉而失败）
    log.error('ROLES-LOAD-FAIL', { dir: rolesDir, err: err?.message ?? String(err) })
  }

  /**
   * ★ **Lead 的 SOUL 通道**（2026-09-14 / Round 44）。
   *
   * ## 为什么单开一条
   * `memberNameOf()` 只认 `role==='teammate'` ⇒ **Lead 被 `handleAgent` 直接 return**，
   * 于是它**拿不到**下面三件：fork（技能工作副本）、岗位人格段（roles/<name>.json）、SOUL 注入。
   * **前两件不拿是对的**（判据）：
   *   · **fork** 是"技能工作副本"，而 `roles/` 里**没有 `lead` 角色档** ⇒ 它没有 role skills 可改；
   *   · **岗位人格段**来自角色档 ⇒ 同上（Lead 的"岗位"就是 `omc` 预设的 persona）。
   * **但 SOUL 必须给它**（判据 = 委托方的原话）：
   *   > 「**每人一套独立 skills、独立成长空间**」（`DECISIONS.md` 开篇引用）
   *   而 `GROWTH.md` 的成长两轴说的是"**让他意识到自己在这个位置上做得不够好，从而去改自己的
   *   skills / SOUL**"—— **Lead 也是个 AI，也在跑这家公司** ⇒ **它同样该有自我迭代位**。
   * ## 它拿到什么 / 不拿什么
   *   · ✅ **SOUL 注入**（`<stateDir>/soul/<lead 的名字>.md`，每步 user message）
   *   · ❌ fork（无角色技能）· ❌ 岗位人格段（无角色档）· ❌ 通知（通知是"上游给你的"，Lead 是上游的**写方**）
   * ## 名字怎么取
   *   ⚠️ **不能读 `session.header.name`** —— 真宿主实测（Round 44）：`header` 只有
   *   `{version,id,createdAt,cwd,isSeeded,agentPreset}`，**没有 `name`** ⇒ 第一版因此**永不触发**。
   *   ✅ **正解 = `tryMembership(agent)`**：对 Lead 它返回 `{role:'lead', name:'lead'}`
   *   （真宿主读数；而 `roster.memberName(agent)` 会**抛** `teammate name must be … not "lead"`）。
   *   ⇒ SOUL 文件 = `soul/lead.md`。
   */
  const handleLeadSoul = (agent, why) => {
    try {
      if (agent === undefined || typeof agent.id !== 'string') return
      // 只在"确实是 Lead"时走这条路（roster teammate 由 handleAgent 管）
      if (memberNameOf(agent) !== undefined) return
      // ★ **名字从 membership 取**（不是 session.header —— 那里没有 name）
      let name
      try {
        const team = agent?.ctx?.get?.('agentTeams')
        const m = typeof team?.tryMembership === 'function' ? team.tryMembership(agent) : undefined
        if (m?.role !== 'lead' || typeof m.name !== 'string' || m.name === '') return
        // ★★ **必须再判一次"这是真 root 还是伪行"**（2026-09-14 / Round 80 修的真缺陷）。
        //
        // 【缺陷现场】底座 `types/roster.js` 有**两处**返回 `{role:'lead', name:'lead'}`：
        //   · `:81` —— **非 roster 的直接子 agent**（*"A direct child outside the durable
        //     roster is not a teammate"*）⇒ **伪行**
        //   · `:90` —— **真正的 Team root**（Lead 自己）
        //   两处 **`role` 与 `name` 完全相同**（都是 `'lead'`）⇒ **只查 role/name 分不出来**。
        //   而本函数 629 行上方的注释**早就写着**"`tryMembership` 对非 roster 子 agent 会返回伪行
        //   `{role:'lead'}`（task-37 §8 实测）" —— **那条警告就贴在同一段代码里**，
        //   我却只在 `memberNameOf` 那处守了它，**没守住这里**。
        //   ⇒ 实测证据：日志里 `SOUL-INJECT member=lead #1 step#1` 在**同一毫秒内出现 8 次**
        //     （8 个不同 agent 实例全被当成 Lead）—— 每个都去读 `soul/lead.md` 并注入。
        //     后果：**把 Lead 的 SOUL 灌给不是 Lead 的 agent**（错误的人拿到别人的承诺），
        //     且每个都往自己 ctx 上盖一个 `teamkit:lead-soul:<agent.id>` 段。
        //
        // 【判据：怎么区分】伪行有个**真 root 没有**的特征 —— **它带 parent**：
        //   底座 `:68-82` 那条分支的前提是 `agent.session.header.parentSession !== undefined`；
        //   真 root 走 `:90`，即 `parentSession === undefined`（`:69` 的 `if` 不成立）。
        //   ⇒ 所以：**有 parent 的，一律不是 root**，不能拿它当 Lead。
        const parentOf = agent?.session?.header?.parentSession
        if (parentOf !== undefined) {
          log.info('SKIP-PSEUDO-LEAD', {
            agent: agent.id,
            parent: parentOf,
            why: 'tryMembership 返回的是"非 roster 直接子 agent"的伪 lead 行（底座 roster.js:81）⇒ 不是 root，不注入 Lead 的 SOUL',
          })
          return
        }
        name = m.name
      } catch {
        return
      }
      // ★ **预设闸门同样适用**（委托方明令：别的 preset 不受影响）
      const gate = inScope(agent)
      if (!gate.take) {
        log.info('SKIP-FOREIGN-PRESET', { member: name, agent: agent.id, why: `Lead SOUL：${why}` })
        return
      }
      const agentPaths = pathsForAgent(paths, agent)
      if (agentPaths.soul?.enabled === false) return
      const targetCtx = agent.ctx
      if (targetCtx === undefined || typeof targetCtx.on !== 'function') return
      if (leadSoulAgents.has(agent.id)) return
      leadSoulAgents.add(agent.id)
      const soulInjector = makeSoulInjector({ paths: agentPaths, member: name, log: (line) => log.info(line) })
      // ★★ **还要告诉 Lead"你的 SOUL 在哪"**（2026-09-14 / Round 45 收尾）。
      //
      // 【为什么单做这一步】Lead **没有角色档** ⇒ `personaFor` 那条链**从不经过它**
      //   ⇒ 我在 `personaFor` 里加的 SOUL 段**对 Lead 无效**。
      //   实测（新建 omc 会话，无历史）：问它"人格段里有没有 SOUL" ⇒ **`NO-SOUL-DOC`**。
      //   ⇒ 它拿得到 SOUL **文件内容**（pre-step 会注），却**不知道那个文件存在/写哪** ——
      //     于是"自我迭代"对它**不可写**（只能被动读一个自己从没写过的文件）。
      // 【做法】注册一个**系统提示词段**（与角色人格段同一机制 `sp.section`，但段名不同、只给 Lead）。
      //   ⚠️ **进提示词 = 一次装配一次**（不是每步）—— 这里只讲"它是什么、写哪、什么时候写"，
      //     属于**岗位契约**，不随迭代变化；而 SOUL 的**正文**仍走 pre-step（每步读、下一步生效）。
      try {
        const sp = agent.ctx?.get?.('systemPrompt')
        if (sp && typeof sp.section === 'function') {
          const soulPath = soulMod.soulFileFor(agentPaths.stateDir, name, agentPaths.soul).file.replace(/\\/g, '/')
          // ⚠️ **先卸后装**（2026-09-14 实测的第二个坑）：段名带 agent id 已保证"同 agent 不撞"，
          //   但**同进程里有多个插件实例**（真宿主实测 `APPLY-DONE` 70ms 内 17 次）⇒
          //   新实例重新注册时**旧实例那条还在 scope 里** ⇒ 仍报
          //   `prompt section "…" is already registered in this scope`。
          //   ⇒ 用与角色段同一个 `preDispose`（登记里有的先卸掉），并记下"是不是本实例的"。
          const secKey = `lead-soul-section`
          const pre = preDispose(agent.id, secKey, {})
          const offSec = sp.section({
            // ⚠️ **段名唯一到 agent**（第一版用固定名 ⇒ 第二个 Lead 就撞：
            //   `LEAD-SOUL-DOC-FAIL … "teamkit:lead-soul" is already registered in this scope`）。
            name: `teamkit:lead-soul:${agent.id}`,
            order: ROLE_SECTION_ORDER,
            text: () =>
              [
                '## 你的 SOUL（你自己答应自己改的事）',
                `**写在**：\`${soulPath}\``,
                '**是什么**：它不是别人给你的规矩，是**你自己**的一句承诺 —— "我下次不再 X / 我下次先 Y"。',
                '**什么时候写**：① 被评审**点名**某条缺陷之后；② 你自己发现同一个坑踩了第二次。',
                '**什么时候生效**：那个文件的内容会**在你每一步开工前**作为一条消息注入 ⇒ **改了下一步就生效**。',
                '**和岗位原则的区别**：岗位原则走系统提示词（**下次装配**才生效，且按岗位共享）；',
                'SOUL 是**你个人**的、**下一步就带上** —— 所以"改了要立刻生效"的东西写进 SOUL。',
                '**没写就什么也不会发生**（这是正常状态，不是错误）。',
              ].join('\n'),
          })
          if (typeof offSec === 'function') {
            disposers.push(offSec)
            // ★ **必须登记**，否则下一个实例的 `preDispose` **找不到它** ⇒ 照样撞名。
            //   （`preDispose` 只卸"登记里有的"；我第一版漏了 `remember` ⇒ 修了段名仍然 FAIL。）
            const genSec = remember(agent.id, secKey, offSec, name)
            log.info('LEAD-SOUL-DOC-OK', { agent: agent.id, name, soul: soulPath, gen: genSec, prevDisposed: pre.preDisposed })
          } else {
            log.warn('LEAD-SOUL-DOC-SKIP', { agent: agent.id, why: 'sp.section 没返回 disposer' })
          }
        } else {
          log.warn('LEAD-SOUL-DOC-SKIP', { agent: agent.id, why: 'no-systemPrompt.section（SOUL 仍会注入，只是不告诉它写哪）' })
        }
      } catch (err) {
        log.warn('LEAD-SOUL-DOC-FAIL', err?.message ?? String(err))
      }
      const off = targetCtx.on('agent/pre-step', async ({ signal }, next) => {
        let decision = await next().catch((err) => ({ kind: 'reject', messages: [], err }))
        decision = soulInjector.sweep(decision, signal)
        return decision
      })
      disposers.push(() => {
        try {
          off?.()
        } catch (err) {
          log.warn('LEAD-SOUL-LISTENER-OFF-FAIL', err?.message ?? String(err))
        }
      })
      log.info('LEAD-SOUL-ARMED', { agent: agent.id, name, soul: `${agentPaths.stateDir}/soul/${name}.md`, why })
    } catch (err) {
      log.warn('LEAD-SOUL-SETUP-FAIL', err?.message ?? String(err))
    }
  }

  const handleAgent = (agent, why) => {
    try {
      if (agent === undefined || typeof agent.id !== 'string') return
      const member = memberNameOf(agent)
      if (member === undefined) {
        // 不是 roster teammate（Lead / 普通 subagent / 别的项目会话）⇒ 不装 fork/角色/通知。
        // ⚠️ 必须显式拒绝：`tryMembership` 对非 roster 子 agent 会返回伪行 `{role:'lead'}`
        //    （task-37 §8 实测），若不判就会把 fork 装到无关的 agent 上（假阴性）
        // ★ **但 Lead 的 SOUL 走单独一条路**（见 `handleLeadSoul`）——
        //   委托方要求「每人一套独立成长空间」，**"每人"包括 Lead**。
        handleLeadSoul(agent, why)
        return
      }

      // ⚠️ **预设闸门（task-58）**：roster 身份**不等于**"属于我这次挂载的预设"。
      //    委托方明令「其它的 preset 不会受到影响」⇒ 只接管同预设的成员。
      //    不是"同一预设"就 **跳过并留日志**（**失败不静默**：否则用户看不出为什么没装）。
      const gate = inScope(agent)
      if (!gate.take) {
        log.info('SKIP-FOREIGN-PRESET', {
          member,
          agent: agent.id,
          why,
          reason: gate.why,
          got: gate.got ?? '(none)',
          want: presetId,
          // ★ **给一条"该怎么办"**（2026-09-14 加）。
          //   实测教训：`engineer` 报告"我改了 fork 却不生效"，查到最后发现
          //   **它所在的 Team 是 `standard` 预设，插件按设计就不接管它** —— 闸门在**正确工作**。
          //   但那条日志只说了 `got/want`，**没说"这是有意为之、以及想要它生效该怎么办"**
          //   ⇒ 读日志的人（含 AI）会把它当成"插件坏了"。
          //   真正的用法是：**要这套公司机制，就把预设选成 `omc`**（新建会话时选，或改 default）。
          hint: '这是**设计内的跳过**（不是故障）：本插件的实例挂在 `' + (presetId ?? '(未配置)') + '` 预设上，'
            + '只接管同预设的成员。要让这个成员也享受该机制：**用该预设新建一个会话**'
            + '（或在 `settings` 里把默认预设设成它），再在其中招人。',
        })
        return
      }

      // ⚠️ **单点补丁（task-57 收尾）**：fork 与通知**必须喂同一个 per-agent paths**。
      //   为什么是"单点"：`installForkFor` 的落点来自**它收到的 `paths`**（`fork.js` 的
      //   `const forkDir = forkRootFor(paths, member)`）⇒ `pathsForAgent` **是唯一开关**。
      //   为什么不能只改一处：`docs-writer` 实测过**半接线 = 活回归** ——
      //   若 fork 按 agent 分、而 notify 仍拿全局 `paths`，通知会去**全局目录**找覆盖 ⇒
      //   `tracked=0 / injected=0` ⇒ **通知静默全死且不报错**（比不接线更坏）。
      //   无 `agent.cwd` 时 `pathsForAgent` **逐字返回原 `paths`**（`config.js:334-340`）⇒ 向后兼容。
      const agentPaths = pathsForAgent(paths, agent)

      // ★ **存量 fork 迁移探测（2026-09-14 / Round 14）**
      //   fork 落点从 `<stateDir>/forks/<member>/skills` 改成 `<stateDir>/forks/<team>/<member>/skills`
      //   （修"两个 Team 同名成员撞一个目录"的真缺陷）⇒ **存量 fork 会留在旧路径**。
      //   若不提示，用户升级后看到的是"我改过的东西全没了"（新路径空 ⇒ 静默回到纯上游）。
      //   ⚠️ **只提示、不自动搬**：搬错方向（把 A 队成员的改动搬给 B 队）比不动更糟。
      //   ⚠️ 只报**真有 SKILL.md 条目**的（空目录不算，否则每次装配都刷屏）。
      try {
        const legacyStateDir = agentPaths.agentStateDir ?? agentPaths.stateDir
        const legacy = detectLegacyForks(legacyStateDir, [member])
        for (const hit of legacy) {
          const now = forkRootFor(agentPaths, member, { agent })
          // ⚠️⚠️ **必须判"新旧落点是不是同一个"**（2026-09-14 自检发现的假警报）：
          //   无 `cwd` 时 `pathsForAgent` **逐字返回原 paths**（向后兼容），
          //   而默认 `forkRootTemplate` 就是 `<stateDir>/forks/{member}/skills`
          //   ⇒ 那时 `now === legacy` ⇒ **会提示用户"把文件搬到它已经在的地方"**（无意义且误导）。
          //   ⇒ 只有**真的不同**才提示。
          if (now.replace(/\\/g, '/').toLowerCase() === hit.legacy.replace(/\\/g, '/').toLowerCase()) continue
          log.warn('FORK-LEGACY-PATH', {
            member,
            agent: agent.id,
            legacy: hit.legacy,
            now,
            action: '旧布局里这份 fork **有内容**。新版按 Team 分目录（修同名成员撞车）⇒ 它**不再被读取**。'
              + '要保留你的改动：把旧目录里的条目**手工**移到上面 `now` 那个目录（只搬你自己的那份）。',
          })
        }
      } catch (err) {
        log.warn('FORK-LEGACY-CHECK-FAIL', err?.message ?? String(err))
      }

      // ① fork provider —— **只在 agent/created**（第一个提示词装配之前）
      //
      // ★ task-59：这里从"实例内 Set 去重"改成**进程级登记 + 先卸后装**（三态日志见下）。
      //   旧的 `!forkedAgents.has(agent.id)` 只挡得住**同一个实例**内的重复；
      //   重载时新实例的 Set 是空的 ⇒ 撞名（现场读数 `FORK-REGISTER-FAIL`）。
      //   `forkedAgents` 保留：它仍是有用的**本实例**速查（避免每次扫全局 Map），但不是判据。
      if (agentPaths.fork.enabled && !forkedAgents.has(agent.id) && memberSelected(agentPaths.fork.members, member)) {
        forkedAgents.add(agent.id)
        const providerName = agentPaths.fork.providerName

        // ⓪ **先卸后装**：把**旧实例**（或本实例上一轮）留在同一个 scope 上的同名 provider 卸掉。
        //    ⚠️ 这一步是"能不能不再撞名"的胜负手，所以**必须留下可观察日志**（三种情形要能分开）：
        //       · 登记里没有 ⇒ 首次（下面 r.ok 走 `FORK-REGISTER-OK`）
        //       · 登记里有   ⇒ 卸旧装新（`FORK-REREGISTER-OK`）
        //       · 卸失败     ⇒ 记警告后**仍然尝试注册**（若还撞名才落到 SKIP；不许静默吞掉）
        const forkKey = `fork:${providerName}`
        const { preDisposed, prev } = preDispose(agent.id, forkKey, { member, agent: agent.id, provider: providerName })
        const reRegister = prev !== undefined

        // ⚠️ `installForkFor` 成功时会自己打一行 `FORK-REGISTER-OK`（`fork.js:157`）。
        //    重挂时那一行会与下面的 `FORK-REREGISTER-OK` **混在一起**，让"首次 vs 卸旧装新"
        //    又变得分不出来 ⇒ **只在重挂时过滤掉它的那一行**（其余行仍然照发：
        //    `FORK-MKDIR-FAIL` / `FORK-REGISTER-FAIL` 是失败信号，任何时候都要看得见）。
        const forward = (line) => {
          if (reRegister && String(line).startsWith('FORK-REGISTER-OK ')) return
          log.info(line)
        }
        const r = installForkFor(agent, {
          paths: agentPaths,
          name: providerName,
          rank: agentPaths.fork.rank,
          skillFileName: agentPaths.fork.skillFileName,
          createDirs: agentPaths.fork.createDirs,
        }, forward)

        if (r.ok) {
          disposers.push(r.disposer)
          // 登记**跨实例**（新实例下次能看到并卸掉它）；`gen` 由进程级计数器给
          const gen = remember(agent.id, forkKey, r.disposer, member)
          // ★ 三种情形**不打成同一行**（Lead 明确要求）：
          //    · `FORK-REGISTER-OK`     —— 首次（由 `fork.js` 发，未过滤）
          //    · `FORK-REREGISTER-OK`   —— 卸旧装新（本行；`fork.js` 那行已被过滤）
          //    · `FORK-SKIP` (WARN)     —— 真跳过（下面 else 分支）
          if (prev !== undefined) {
            log.info('FORK-REREGISTER-OK', {
              member, agent: agent.id, provider: providerName, gen, dir: r.dir,
              why: '登记里已有同名 provider ⇒ 先卸旧的再装新的（避免 already-registered 撞名）',
              prevWasThisInstance: prev.owner === instanceId,
              prevGen: prev.gen,
              preDispose: preDisposed,
            })
          }
        } else {
          // 真跳过：**这里必须能看出"跳过"而不是"装成功"**（三态日志的第三种）
          log.warn('FORK-SKIP', {
            member, agent: agent.id, provider: providerName,
            why: r.why, preDispose: preDisposed,
            note: prev === undefined ? '没有旧登记却仍失败 ⇒ 不是"重挂撞名"，要另查' : '卸了旧的仍撞名 ⇒ 同名 provider 不归本插件登记管辖',
          })
        }
      }

      // ★★ **①-b SOUL 骨架播种**（2026-09-14 / task-101；委托方当场问「每人独立的 SOUL 做完没有？」）
      //   【为什么在这个窗口】与 fork provider **同一窗口**（`agent/created`）——
      //     它是**唯一**能赶在"第一个提示词装配之前"动手的窗口；骨架要**第一步就带上**。
      //   【现状口径】**读/注入做完了，播种没做**（`soul.js` 原先没有任何生成代码）——
      //     本节补的就是那一格：新成员一上岗**先有一份骨架**，而不是"什么都没有"。
      //   【三条承重前提（`soul.seed` 默认 true 的前提）】
      //     ① **幂等**：已有 SOUL ⇒ `existsSync` 短路，**一个字节都不动**（sha 前后相等）；
      //     ② **骨架不含第一人称承诺句**（只有结构 + 显式「未填」占位）—— 替它表态 = 伪造；
      //     ③ **失败不静默**：写不进去 ⇒ 日志明说"**没播种**"（不许当成功）。
      //   ⚠️ **与 fork 独立**：fork 只是"注册了 provider"，**目录本身可能还没建**
      //     （真读数：第①②代 fork 根**是纯空壳**）⇒ 播种顺带**回读目录是否真存在**并如实记。
      try {
        const seed = seedSoul(agentPaths.stateDir, member, {
          cfg: agentPaths.soul ?? {},
          enabled: agentPaths.soul?.seed !== false,
          log: (line) => log.info(line),
        })
        // ⚠️ **目录是否真建出来**：fork 成功 ≠ 目录存在（`createDirs` 才建）。
        //   判据由 CEO 定：`<cwd>/.teamkit/forks/<team8>/{member}/skills` 必须为 True。
        //   ⇒ 这里**只读回读**，失败**如实报**（不静默、也不假装）。
        //   ⚠️⚠️ **不要引用 fork 那一支的 `r`** —— 它是 `if` 块内的 `const`，在此处**不在作用域**
        //     ⇒ `ReferenceError: r is not defined` ⇒ 被 catch 成 `SOUL-SEED-SETUP-FAIL`。
        //     （这正是 `H12` 家族的"作用域"坑；真机日志当场抓到，`node --check` 查不出。）
        //     改法：**只用 `forkRootFor(...)` 自己算**（与 fork 那一支同一公式 ⇒ 同一事实来源）。
        const forkDir = (() => { try { return forkRootFor(agentPaths, member, { agent }) } catch { return undefined } })()
        let forkDirExists = undefined
        if (typeof forkDir === 'string' && forkDir !== '') {
          try { forkDirExists = existsSync(forkDir) } catch { forkDirExists = undefined }
        }
        log.info('SOUL-SEED', {
          member, agent: agent.id,
          seeded: seed.seeded === true,
          why: seed.why ?? (seed.seeded ? 'created' : 'n/a'),
          file: seed.file,
          sha: seed.sha,
          forkDir: forkDir ?? '(未获取)',
          forkDirExists: forkDirExists ?? '(未获取)',
        })
        if (seed.ok !== true) {
          // 播种失败**已经由 seedSoul 打了 SOUL-SEED-FAIL**，这里再记一次"这项没生效"
          log.warn('SOUL-SEED-NOT-APPLIED', { member, why: seed.why })
        }
      } catch (err) {
        // **绝不外抛**（`agent/created` 是同步 emit，抛错会否决 agent 发布）
        log.warn('SOUL-SEED-SETUP-FAIL', err?.message ?? String(err))
      }

      // ② 通知监听器 + SOUL 注入 —— **装在该 agent 自己的 ctx 上** ⇒ scope-filtered 保证"装给谁就推给谁"
      //    ⚠️ 这里**不能 `return`**：`targetCtx` 缺失只该让这一项不生效，
      //       不该连带跳过 ③ 的公司层（第一版我写成 `return` ⇒ **静默吞掉角色装配**）。
      //    ⚠️ **SOUL 与通知共用同一个 `agent/pre-step`**，但**闸门独立**：
      //       通知受 `notify.enabled` 管；SOUL 受 `soul.enabled` 管（默认都开）。
      //       第一版我把 SOUL 塞在 `notify.enabled` 的 `if` 里 ⇒ **关掉通知会连带关掉 SOUL**（同 Round 34 的"闸门绑一起"）。
      if ((agentPaths.notify.enabled || agentPaths.soul?.enabled !== false) && !listeningAgents.has(agent.id)) {
        const targetCtx = agent.ctx
        if (targetCtx === undefined || typeof targetCtx.on !== 'function') {
          log.warn('PRE-STEP-SKIP', { member, agent: agent.id, why: 'no agent.ctx.on（通知与 SOUL 两项都不生效；其余项继续）' })
        } else {
          listeningAgents.add(agent.id)
          const soulInjector = makeSoulInjector({ paths: agentPaths, member, log: (line) => log.info(line) })
          const notifier = makeNotifier({
            paths: agentPaths,
            member,
            tracked: agentPaths.notify.tracked === 'auto' ? 'auto' : agentPaths.notify.tracked,
            log: (line) => log.info(line),
          })
          notifiers.set(member, notifier)
          notifier.baseline()
          const off = targetCtx.on('agent/pre-step', async ({ signal }, next) => {
            let decision = await next().catch((err) => ({ kind: 'reject', messages: [], err }))
            // ★ **SOUL 注入**（`DECISIONS.md` P-08 的裁定；2026-09-14 / Round 43 实现）。
            //   顺序：**先 SOUL、后 notifier** —— SOUL 是"你自己的承诺"，
            //   它该在"上游更新通知"之前进上下文（先看自己答应过什么，再看外面变了什么）。
            decision = soulInjector.sweep(decision, signal)
            const out = notifier.sweep(decision, signal)
            // ⚠️ **不要在这里"主动投递"** —— 我 2026-09-14 试过一版，**判断后回退了**：
            //   `subagents.queuePrompt(parent, childId, …)` 的前置是
            //   `activations.assertAdmitting(parent)` + `holdOwnership(parent, childId)`
            //   （`dsh-subagent/lib/types/continuation.js:239-240`）
            //   ⇒ 它要求调用者是**该 child 的直接父**且**持有它的所有权**。
            //   而这里是**某个成员自己的 `agent/pre-step`**（我们不是它的父）⇒ 投别的成员会被拒；
            //   投它自己又是**无意义**的（它正在跑，sweep 已经插进本步上下文了）。
            //   ⇒ **正确做法在别处**：上游一变更，由 **Lead 侧主动通知**（见 `tools/promote-upstream.mjs`
            //     的合并后步骤）—— 或者由成员**下次开工时**从 pre-step 拿到（现状，已可用）。
            //   记一条读数，方便以后确认"这条通道确实没被用上"，而不是静默。
            const queued = notifier.takeQueuedForDelivery()
            if (queued.length > 0) {
              log.info('NOTIFY-QUEUED-LOCAL', {
                member,
                count: queued.length,
                note: '已进本步上下文；若该成员随后 idle，通知不会主动送达（见 index.js 的说明）',
              })
            }
            return out
          })
          disposers.push(() => {
            try {
              off?.()
            } catch (err) {
              log.warn('NOTIFY-LISTENER-OFF-FAIL', err?.message ?? String(err))
            }
            const h = notifier.health()
            log.info('NOTIFY-LISTENER-OFF', `member=${member} ${JSON.stringify(h)}`)
          })
          log.info('NOTIFY-LISTENING', { member, agent: agent.id, why, tracked: paths.notify.tracked })
        }
      }
      // ③ **公司层：按角色档装"技能 provider + 人格段"**（task-58 ④ / R24）
      //    时机同 fork：在 `agent/created` 里，**赶在第一个提示词装配之前**
      //    （`dsh-agent-loop:890` 先 `assemble()`、`:894` 才发 `agent/pre-step`）。
      //
      //    ⚠️ **两条纪律**：
      //      · `installRoleFor` 内部注册失败**不抛**（同步 emit 抛错会否决 agent 发布）；
      //      · **人格段只在这里装一次** —— 绝不随后续步骤反复改：`systemPromptUpdate:'in-history'`
      //        意味着**每次改提示词，旧版本继续计费**（`SOUL-AND-CACHE.md`）。
      const role = roleFor(loadedRoles.roles, member)
      if (role === undefined) {
        // 不是错误：组织里没有这个成员名的角色档 = "通用工"，只拿 fork 不拿角色人格
        log.info('ROLE-SKIP', { member, agent: agent.id, why: 'no-role（该成员名没有角色档 —— 通用工）' })
      } else {
        // ⚠️ **provider 名的公式与 `roles.js:276` 逐字一致**（`${providerPrefix}${role.name}`，
        //    默认前缀 `teamkit-role-`）。这里必须"预知"这个名字才能**先卸后装** ——
        //    而 task-59 的写范围只许改本文件（不能去 `roles.js` 导出它）。
        //    ⇒ 若哪天 `roles.js` 改了前缀/公式，本处就会"卸了个不存在的名字" ⇒ 撞名复发。
        //      **不静默**：下面的 `REGISTRY-KEY-MISMATCH` 警告会显式点出这种漂移。
        const roleProviderName = `teamkit-role-${role.name}`
        const roleKey = `role:${roleProviderName}`
        const sectionName = `${ROLE_SECTION_PREFIX}${role.name}`
        const personaKey = `persona:${sectionName}`

        // ③-a 技能面：**先卸后装**（与 fork 同一纪律；不先卸就会 `already registered`）
        const rolePrev = preDispose(agent.id, roleKey, { member, agent: agent.id, provider: roleProviderName })
        const rr = installRoleFor(agent, role, { rolesDirBase: loadedRoles.dir })
        if (rr.ok) {
          const gen = remember(agent.id, roleKey, rr.disposer, member)
          if (rolePrev.prev === undefined) {
            log.info('ROLE-INSTALL-OK', { member, role: role.name, provider: rr.provider, dir: rr.dir, hasSkillsDir: rr.hasSkillsDir, gen })
          } else {
            // ★ 与 fork 同形的"三态"：卸旧装新**必须与首次分得开**
            log.info('ROLE-REREGISTER-OK', {
              member, role: role.name, provider: rr.provider, gen, dir: rr.dir,
              why: '登记里已有同名 role provider ⇒ 先卸旧的再装新的',
              prevWasThisInstance: rolePrev.prev.owner === instanceId, prevGen: rolePrev.prev.gen,
              preDispose: rolePrev.preDisposed,
            })
          }
        } else {
          log.warn('ROLE-SKIP', { member, agent: agent.id, role: role.name, why: rr.why, preDispose: rolePrev.preDisposed })
          // ★ 漂移检测：已卸过旧的却仍撞名 ⇒ provider 名公式与 roles.js 不一致（不静默）
          if (rolePrev.prev !== undefined && /already registered/.test(String(rr.why))) {
            log.warn('REGISTRY-KEY-MISMATCH', {
              member, role: role.name, assumedProvider: roleProviderName, why: rr.why,
              action: '请核 roles.js:276 的前缀/公式是否变了（本处按 `teamkit-role-<role>` 预卸）',
            })
          }
        }

        // ③-b 人格面：装在该 agent **自己的 ctx** 上（"装给谁就归谁"，同 fork 的纪律）
        //
        // ⚠️ task-59：`dsh-system-prompt:188` 的 `NamedEntries` 在**同层重名时会抛**
        //    （实测 `probe-N-persona-real.mjs`：`prompt section "teamkit:role:engineer" is already registered in this scope`）
        //    ⇒ 与 fork/role 同一个坑，**同样先卸后装**（否则重挂必抛 ⇒ `ROLE-PERSONA-FAIL`）。
        if (typeof rr.disposer === 'function') disposers.push(rr.disposer)
        const personaPrev = preDispose(agent.id, personaKey, { member, agent: agent.id, section: sectionName })
        try {
          const sp = agent.ctx?.get?.('systemPrompt')
          if (sp !== undefined && typeof sp.section === 'function') {
            const off = sp.section({
              name: sectionName,
              order: ROLE_SECTION_ORDER,
              // ★ **自演化位（OMC 的"组织会学习"那一格）**：
              //   `talents/principles/<role>.md` 对应物 —— 写了就**把正文注入上下文**（不是只给路径）；
              //   没写就由 `personaFor` **明说"目前还没写"**（不假装有、也不静默漏）；
              //   读出错 ⇒ 记 `ROLE-PRINCIPLES-READ-FAIL`（**失败不静默**）；
              //   ★ **并把该文件的绝对路径写进人格段**（`pf.file`）—— 让"该写哪"由系统给出，
              //     不靠 teammate 猜（猜错就是"写入点 ≠ 读取点"，本项目实测过那次断链）。
              text: (() => {
                const pf = principlesForRole(role)
                // ★ **SOUL 的绝对路径也要给**（Round 45）：人格段里必须写明"写哪"，
                //   否则成员**不知道那个文件存在** ⇒ 机制成了摆设（7 技能 + 7 角色档 SOUL 命中 0 处的实测缺口）。
                const soulPath = (() => {
                  try {
                    const { soulFileFor } = soulMod
                    return soulFileFor(agentPaths.stateDir, member, agentPaths.soul).file
                  } catch {
                    return undefined
                  }
                })()
                // ★ `peers` = **全部角色档**（`task-114`）——
                //   用于算"**我手下有谁**"这个**反向索引**（`R10`：不另设字段，运行时算）
                //   ⚠️ 传 `loadedRoles.roles`（那时已 load 完，`:603`）⇒ 渲染时能给出下级名单
                //   ⇒ 拿不到 ⇒ `personaFor` 会**明说「未获取」**（**不编**）
                return personaFor(role, pf.text, pf.file, soulPath, loadedRoles?.roles)
              })(),
            })
            if (typeof off === 'function') {
              disposers.push(off)
              const gen = remember(agent.id, personaKey, off, member)
              if (personaPrev.prev === undefined) {
                log.info('ROLE-PERSONA-OK', { member, role: role.name, section: sectionName, order: ROLE_SECTION_ORDER, gen })
              } else {
                log.info('ROLE-PERSONA-REREGISTER-OK', {
                  member, role: role.name, section: sectionName, order: ROLE_SECTION_ORDER, gen,
                  why: '同名段已登记 ⇒ 先卸旧的再装新的（dsh-system-prompt 同层重名会抛）',
                  prevWasThisInstance: personaPrev.prev.owner === instanceId, prevGen: personaPrev.prev.gen,
                  preDispose: personaPrev.preDisposed,
                })
              }
            }
          } else {
            log.warn('ROLE-PERSONA-SKIP', { member, role: role.name, why: 'no systemPrompt.section' })
          }
        } catch (err) {
          // 段重名会抛 ⇒ **这是要看见的失败**（不许静默）
          log.warn('ROLE-PERSONA-FAIL', { member, role: role.name, section: sectionName, err: err?.message ?? String(err), preDispose: personaPrev.preDisposed })
        }
      }

    } catch (err) {
      // **绝不外抛**：`agent/created` 是同步 emit，抛错会否决 agent 发布
      log.error('AGENT-HANDLE-ERROR', { why, agent: agent?.id, err: err?.message ?? String(err) })
    }
  }

  try {
    const off = ctx.on('agent/created', ({ agent }) => handleAgent(agent, 'created'))
    disposers.push(() => {
      try {
        off?.()
      } catch {
        /* ignore */
      }
    })
  } catch (err) {
    log.error('HOOK-AGENT-CREATED-FAIL', err?.message ?? String(err))
  }

  // 兜底：插件装上时**已经活着**的 agent（reload 场景）。
  // ⚠️ 此时装配已完成，**provider 装得上但赶不上第一次装配** —— 这条必须如实记：
  //    `agent/created` 才是唯一能"赶上第一个提示词"的窗口（task-37/44 实测）。
  //    这里只用**已有 roster 身份**的那批（通常是别的 Lead），并给 kind 打标。
  try {
    const live = ctx.get('agents')?.list?.() ?? []
    // ★ task-59 ④：**惰性修剪**进程级登记 —— 只留"此刻仍活着"的 agent id。
    //   为什么放这里：这是**每次 apply 都会走**的那条路径（与 `agent-presets` 的
    //   `pruneDisposedMounts` 同形 —— 读/挂载时顺手修剪，而不是靠一个专门的清理钩子）。
    //   ⚠️ 修剪掉的登记意味着"那个 agent 已经不在了" ⇒ 它的 provider 随它的 scope 消亡，
    //      登记留着只会无限增长（实测 `probe-F-boundaries.mjs`：`WeakRef` **不能**代替它 ——
    //      我们要的是"还能卸"（需要强引用），而 WeakRef 只管 GC，不提供主动卸的能力）。
    let pruned = 0
    try {
      const aliveIds = new Set(live.map((a) => a?.id).filter((x) => typeof x === 'string'))
      for (const id of [...registry.keys()]) {
        if (!aliveIds.has(id)) { registry.delete(id); pruned += 1 }
      }
    } catch (err) {
      log.warn('REGISTRY-PRUNE-FAIL', err?.message ?? String(err))
    }
    log.info('REGISTRY-PRUNED', {
      live: live.length, agentsTracked: registry.size, pruned,
      note: '登记只保留 agents.list() 里仍活着的 id（防无限增长）',
    })
    for (const a of live) handleAgent(a, 'apply-existing（⚠️ 已过装配窗口：只对后续步骤生效）')
  } catch (err) {
    log.warn('APPLY-LIVE-SCAN-FAIL', err?.message ?? String(err))
  }

  // ── 3) A 层误操作护栏（**默认关**）──────────────────────────────────
  if (paths.guard.enabled) {
    const g = registerGuard(ctx, { paths, log: (line) => log.info(line) })
    if (g.ok) disposers.push(g.disposer)
    else log.warn('GUARD-NOT-REGISTERED', g.why)
  } else {
    log.info('GUARD-OFF', '默认关闭：它只是"误操作护栏"，覆盖 write/edit 两个工具名，pwsh 绕得过（DECISIONS P-15/P-16）')
  }

  // ── 3.5) ★★ 探针闸门（`R2` 在线拦；task-92 / CEO 批方案②）──────────────────────
  //   【为什么要有它】`task-85` 的 `teamkit probe-check` 是**离线检**（有得检），
  //     而**两次事故的探针都走 `dev_stage_add` 的 inline execute、从不落盘** ⇒
  //     **没有机制强制作者先跑它** ⇒ **「能检」≠「会被检」**。
  //   【用哪个口】底座**自带且文档化**的 `ctx.tools.guard()`（`dsh-tools:2816-2821`），
  //     返回**字符串**即拒绝该次调用（`:3127-3139` 包成 `Error: <reason>`）——
  //     **不碰注入器的仓**（那是别人的辖区），**可卸净**（走 `ctx.effect` 的 disposer）。
  //   【承重约束 ①：**生效范围按挂载方式而定 —— 不是"全宿主"**】
  //     ⚠️ 本段原先写「落 global 层 ⇒ 对全宿主生效」= **读码推断，已被真读数推翻**。
  //     真宿主实测（真调 `tools.guardReason`）：`layers.global.guards` = **[]**；
  //       本闸实际落在 **`{"agentPreset":"omc"}`** 那层 ⇒ **`standard` 的 agent 未被覆盖**。
  //     ⇒ **已知缺口**：`standard` 成员的坏探针目前没人拦（**不许说成全宿主都有保护**）。
  //     ⬜ `closedloop-full` 为何被拦 / 注入形态是否落 global = **未获取 / 待验**（见 `probe-gate.js` 头）。
  //   【承重约束 ②：liveness】`guardReason` 在**每一次**被允许的工具调用上都会被调（无论落哪层）
  //     ⇒ guard 实现里**第一行 O(1) 短路 / 不 await / 不读盘 / 不抛 / fail-open**。
  {
    const pgCfg = paths.probeGate ?? {}
    try {
      const g = registerProbeGate(ctx, { enabled: pgCfg.enabled === true, log: (line) => log.info(line) })
      if (g.ok) {
        disposers.push(() => g.dispose())
      } else if (g.why !== 'disabled') {
        // ⚠️ **失败不静默**：`disabled` 那条已由 `registerProbeGate` 自己打"这道闸已关"，
        //   其余失败在这里明确说"**没装上**"（不是"已生效"）。
        log.warn('PROBE-GATE-NOT-ON', `${g.why} ⇒ **这道闸没生效**（不是"已保护"）`)
      }
    } catch (err) {
      // **绝不外抛**（apply 整体不能因一项坏掉而失败）
      log.warn('PROBE-GATE-SETUP-FAIL', err?.message ?? String(err))
    }
  }

  // ── 3.7) 成员释放（**委托方硬指令「必须可以删」**；2026-09-14 / Round 33–34）────────
  //   底座不给移除方法 ⇒ 我们**包一层 `TeamJournal.prototype.state`** 过滤已释放的人。
  //   承重链：`roster` 与 `journal` **同一实例** ⇒ roster 的资格检查也走被包那层
  //   （真宿主实测 `roster.journal === journal` = true）。
  //
  //   ★★ **两个闸门分开**（Round 34 自己修的设计缺陷）：
  //     · `memberRelease.enabled`      → **破坏性**动作（包装 + `release_member` / `unrelease_member`）
  //     · `memberRelease.readonlyTools`→ **只读**的 `list_zombies`
  //   为什么要分：我第一版把 `list_zombies` 也挂在 `enabled` 后面 ⇒
  //     **用户想先"看看有没有僵尸"就得先把破坏性能力打开** —— 那是把"看得见"和"能动手"绑在一起，
  //     与"先看得见、再决定动谁"的设计正好相反。
  //   ⚠️ **默认**：`enabled=false`（不动手）、`readonlyTools=true`（但**看得见**）。
  {
    const mrCfg = paths.memberRelease ?? {}
    const release = makeReleaseManager({
      agentTeams: ctx.get('agentTeams'),
      stateDir: paths.stateDir,
      cfg: mrCfg,
      log: (line) => log.info(line),
    })
    const wantDestructive = mrCfg.enabled === true
    const wantReadonly = mrCfg.readonlyTools !== false

    if (wantDestructive) {
      try {
        const w = release.apply()
        if (w.ok) {
          log.info(
            'RELEASE-READY',
            `tracking=${release.file} released=${release.released.size}` +
              (release.released.size > 0 ? ` names=${release.list().join(',')}` : ''),
          )
          // 暴露给同进程的调试面（**只读**用途：`list` / `isReleased`）
          try {
            ctx.set?.('teamkitRelease', release)
          } catch {
            /* 宿主可能没有 set；不影响主流程 */
          }
          disposers.push(() => release.dispose())
        } else {
          // ⚠️ **失败不静默**：说清楚为什么没装上（底座改名 / 不可写 / 拿不到 service）
          log.warn('RELEASE-NOT-READY', w.why)
        }
      } catch (err) {
        log.warn('RELEASE-SETUP-FAIL', err?.message ?? String(err))
      }
    } else {
      log.info('RELEASE-OFF', '破坏性动作默认关闭：要释放成员请设 memberRelease.enabled=true（`list_zombies` 只读、不受此闸门限制）')
    }

    // ★ **工具面**：`list_zombies` 只读，可单独开；两个写工具跟着 `enabled` 走。
    try {
      const tools = registerReleaseTools(ctx, {
        release,
        agentTeams: ctx.get('agentTeams'),
        agents: ctx.get('agents'),
        cfg: { enabled: wantDestructive, readonlyTools: wantReadonly },
        // ★ **"写我自己的那几份"**（Round 48–49）：宿主侧代写，绕开 agent 沙箱。
        //   白名单三选一（soul / principles / role-skill），路径**由插件算**，不接受调用方传路径。
        selfWriteDeps: {
          stateDir: paths.stateDir,
          // ⚠️ **必须用上面那个算好的 `rolesDir`，不是 `paths.roles.dir`**（2026-09-14 / Round 50 实测的 bug）：
          //   裸实例（热重载后重建 / 新建会话不重新 apply）里 `paths.roles.dir` **是空的** ——
          //   真正的值由 `recoveredFromPreset.rolesDir` 兜底捞回（见 L502 那个 IIFE）。
          //   我第一版传了 `paths.roles.dir` ⇒ `rolesDir=''` ⇒ `loadRoles('')` 读到 0 条
          //   ⇒ **coo 明明有角色档却报 `no-role`**（诊断日志 `SELF-WRITE-ROLE-MISS rolesDir= readable=false n=0`）。
          //   ⇒ 这是 R16 那个"兜底只在一条路上接了"的**同族**：算出了值，却在另一条路上用了原始的。
          teamkitDir: rolesDir !== '' ? join(rolesDir, '..') : '',
          rolesDir,
          soul: paths.soul,
          loadRoles,
          resolveSelfTarget: selfWriteMod.resolveSelfTarget,
          readSelf: selfWriteMod.readSelf,
          writeSelf: selfWriteMod.writeSelf,
        },
        log: (line) => log.info(line),
      })
      if (tools.names.length > 0) log.info('RELEASE-TOOLS-OK', `n=${tools.names.length} names=${tools.names.join(',')}`)
      for (const d of tools.disposers) disposers.push(d)
    } catch (err) {
      log.warn('RELEASE-TOOLS-SETUP-FAIL', err?.message ?? String(err))
    }
  }

  // ── 3.8) E²R：分解边 + 评审判决（task-60 / 2026-09-14）────────────────────
  //   【委托方的问题】「它一些公式，什么 r 方那个啥东西，这些东西你就是融合进来没有，
  //     还是说你只是抄了个形式？」⇒ 这一节就是"融合进来"的落点。
  //
  //   【底座缺什么（逐行核过）】`TeamTaskStatus` 只有 4 态（**无 `accepted`**）；
  //     `TeamTaskSnapshot` 8 字段（**无 `parent`**）；三个 schema 全 `.strict()` ⇒ **写事件加字段会被拒**。
  //   【我们怎么做（不改底座）】三条路，分两档开关：
  //     · **B 台账**：`<stateDir>/e2r.jsonl`（append-only、可回放、重启重建）；
  //     · **C 摘要**：写进任务 `description` —— ⚠️ **它是底座 `TeamTaskView` 的 declared property**
  //       ⇒ **本来就出现在 `team_task_list` 里** ⇒ 委托方要的"板上看得见结构"**零风险达成**；
  //     · **A 派生视图**（包 own `taskView` + 单点包 `tools.view` 放开出口 schema）：**默认关**。
  //   【为什么 A 默认关】它是**唯一"可能打断任务板"**的能力：漏放一个 agent scope 的出口 schema
  //     ⇒ 那个成员一调 `team_task_list` 就报 `additionalProperties: false`（Round 95 真宿主实测）。
  //     开了也**不保证装上**：`apply()` 先探测 → 装 → **立刻验** → **验不过整段回滚**（绝不半装）。
  {
    const e2rCfg = paths.e2r ?? {}
    let e2r
    try {
      e2r = makeE2rManager({
        agentTeams: ctx.get('agentTeams'),
        tools: ctx.get('tools'),
        agents: ctx.get('agents'),
        stateDir: paths.stateDir,
        cfg: e2rCfg,
        log: (line) => log.info(line),
      })
      log.info('E2R-READY', {
        tracking: e2r.file,
        teams: e2r.list().length,
        records: e2r.list().reduce((n, e) => n + e.tasks.length, 0),
        enabled: e2rCfg.enabled === true,
        structure: e2rCfg.structure !== false,
        schemaPatch: e2rCfg.schemaPatch === true,
      })
      // 暴露给同进程的调试面（**只读**用途：`list` / `entryOf` / `isAccepted`）
      try {
        ctx.set?.('teamkitE2r', e2r)
      } catch {
        /* 宿主可能没有 set；不影响主流程 */
      }
    } catch (err) {
      log.warn('E2R-SETUP-FAIL', err?.message ?? String(err))
      e2r = undefined
    }

    if (e2r) {
      // ── A 档：只有 `enabled` 与 `schemaPatch` **都** true 才尝试 ──────────────
      if (e2rCfg.enabled === true && e2rCfg.schemaPatch === true) {
        try {
          const p = e2r.apply()
          if (p.ok) {
            log.info('E2R-PATCH-READY', `via=${p.via} checked=${p.checked} defs=${e2r.patchedDefs} —— ` +
              '三个字段现在**出现在 team_task_list 里**（⚠️ 动的是底座已注册工具的 output schema：底座升级即可能碎）')
          } else {
            // ⚠️ **失败不静默**：说清楚为什么没装上（这是"未验证"，不是"装好了"）
            log.warn('E2R-PATCH-NOT-READY', p.why)
          }
        } catch (err) {
          log.warn('E2R-PATCH-SETUP-FAIL', err?.message ?? String(err))
        }
      } else {
        log.info('E2R-PATCH-OFF', `默认关（enabled=${e2rCfg.enabled === true} schemaPatch=${e2rCfg.schemaPatch === true}）：` +
          `它是**唯一可能打断任务板**的能力。**B 台账 + C description 摘要 + 三件工具照常生效**（板上同样看得见结构）。`)
      }

      // ── 工具面（**默认开**，零风险：不碰任何底座 schema）────────────────────
      try {
        const tools = registerE2rTools(ctx, {
          e2r,
          agentTeams: ctx.get('agentTeams'),
          agents: ctx.get('agents'),
          cfg: e2rCfg,
          // ★ **task-77：成员 → 角色档 `level` 的读口**（`member_levels` 工具要用）。
          //   ⚠️ **必须用上面那个三段兜底算好的 `rolesDir`**，不是 `paths.roles.dir` ——
          //   裸实例（热重载后重建）里 `paths.roles.dir` 是空的，真正的值由
          //   `recoveredFromPreset.rolesDir` 兜底捞回（与 `selfWriteDeps.rolesDir` 同一个坑，
          //   见 R50 那次 `no-role` 事故）。`loadRoles` / `roleFor` 直接复用 `roles.js`
          //   ⇒ **匹配规则与 `roles.js:176` 是同一份代码**（不重写第二套，避免"两份事实"）。
          rolesDeps: { rolesDir, loadRoles, roleFor },
          log: (line) => log.info(line),
        })
        if (tools.names.length > 0) log.info('E2R-TOOLS-OK', `n=${tools.names.length} names=${tools.names.join(',')}`)
        for (const d of tools.disposers) disposers.push(d)
      } catch (err) {
        log.warn('E2R-TOOLS-SETUP-FAIL', err?.message ?? String(err))
      }

      // ── 卸载：**两段 undo 都要跑**（只有 A 装过才有）────────────────────────
      disposers.push(() => {
        const r = e2r.dispose()
        if (!r.ok) log.warn('E2R-DISPOSE-INCOMPLETE', r.why)
      })

      // ── A 的**重试窗口**：`apply()` 时可能**还没有任何 agent 可验**（验不了 ⇒ 它按纪律拒绝装）──
      //   ⇒ 一旦有 agent 发布，就再试一次。**不改任何底座注册**：只是重跑我们自己的 `apply()`。
      //   ⚠️ 只在 A 档开着时才挂（默认关 ⇒ 这条 hook 都不出现）。
      if (e2rCfg.enabled === true && e2rCfg.schemaPatch === true) {
        try {
          const off = ctx.on('agent/created', () => {
            try {
              const r = e2r.retry()
              if (r.ok) log.info('E2R-PATCH-RETRY-OK', `via=${r.via} defs=${e2r.patchedDefs}`)
            } catch (err) {
              // **绝不外抛**：`agent/created` 是同步 emit，抛错会否决 agent 发布
              log.warn('E2R-PATCH-RETRY-FAIL', err?.message ?? String(err))
            }
          })
          disposers.push(() => {
            try {
              off?.()
            } catch {
              /* ignore */
            }
          })
        } catch (err) {
          log.warn('E2R-PATCH-RETRY-HOOK-FAIL', err?.message ?? String(err))
        }
      }
    }
  }

  // ── 4) 卸载：**可卸净**（一条断言，见 --selftest 的 D 组）───────────────
  ctx.effect(() => () => {
    let failed = 0
    let ran = 0
    // ⚠️ task-59 ③：`splice(0)` 会把数组**抽空** ⇒ 之后 `disposers.length` **恒为 0**。
    //    旧写法把这一项记成 `disposers`，于是日志永远显示 0 —— **正好会让人误读成
    //    "没有 disposer 要跑"**，是"失败不静默"的反面（Lead 已认这是日志 bug）。
    //    ⇒ 先数下**将要跑**的数量，再用 `ran` 记**实际跑过**的。
    const pending = disposers.splice(0)
    const declared = pending.length
    for (const d of pending) {
      ran += 1
      try {
        d()
      } catch (err) {
        failed += 1
        log.warn('DISPOSE-FAIL', err?.message ?? String(err))
      }
    }
    // 顺手清理**属于本实例**的登记（别人的登记不动，它们会在各自的 dispose 里清）。
    // ⚠️ 结构是 `agent.id -> Map<key, entry>`（task-59 覆盖 fork/role/persona 三类）⇒
    //    要**按 key 删**，删空了的 agent 槽位也要摘掉（否则留下空 Map，`size` 读数会虚高）。
    let cleared = 0
    for (const [id, slot] of [...registry.entries()]) {
      if (!(slot instanceof Map)) { registry.delete(id); cleared += 1; continue }
      for (const [k, rec] of [...slot.entries()]) {
        if (rec?.owner === instanceId) { slot.delete(k); cleared += 1 }
      }
      if (slot.size === 0) registry.delete(id)
    }
    // ★ **同时摘掉自己在"有配置实例"表里的登记**（Round 16）。
    //   不摘的后果：本实例已 dispose，但表里还留着 ⇒ 别的裸实例会**误判"有 peers 在场"**而不让位
    //   ⇒ **该接管的人不接管**（比"抢活"更隐蔽的故障）。与上面 registry 的清理同一个道理。
    let unregistered = 0
    try {
      if (configuredInstances.delete(instanceId)) unregistered = 1
    } catch { /* 忽略：清理失败不该影响 dispose */ }
    const h = log.health()
    log.info('PLUGIN-DISPOSE', {
      ...h,
      disposers: declared,
      disposersRan: ran,
      registryCleared: cleared,
      agentsRemaining: registry.size,
      disposeFailures: failed,
      forkedAgents: forkedAgents.size,
      notifiers: notifiers.size,
      configuredUnregistered: unregistered,
      configuredPeersLeft: configuredInstances.size,
      counters: log.counters.snapshot(),
    })
  })

  log.info('APPLY-DONE')
  return {
    /** 供外部（`--status` / 测试）读的句柄。 */
    paths,
    log,
    notifiers,
  }
}
