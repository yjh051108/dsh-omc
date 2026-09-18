#!/usr/bin/env node
/**
 * teamkit —— 插件的**离线**命令行（不需要启动 DSH、不碰真上游、不碰 profile）。
 *
 * 子命令：
 *   teamkit selftest [--json]        三态自测（PASS / FAIL / UNVERIFIED），默认在临时目录里跑
 *   teamkit status                   把"当前配置会落到哪些路径 + 各件开没开"打出来（只读）
 *   teamkit list                     上游待合并清单（只读）
 *   teamkit promote --skill X --note "说明" | --all --note "说明" [--dry-run]
 *   teamkit rollback <skill>         回退到最近一次快照
 *   teamkit fork-init <member> <skill>   把上游某条带进该成员的 fork（"我要改它"的起点）
 *   teamkit doctor                   环境体检（node 版本 / 路径可写性 / 依赖 / 残留）
 *
 * 三条设计约束（都是"越好装越好 / 越好维护越好"的直接落地）：
 *  ① **默认与 `--help` 绝不写盘**（`LANDMINES §7` 的实况：一个生成器脚本因为不看参数就 `rm -rf`，
 *     把别人的历史读数删了）。本文件只在 `promote` / `rollback` / `fork-init` 里写，
 *     且 `promote` 没有 `--note` 时**连一行都不写**。
 *  ② **`--selftest` 默认沙盒化**：`DSH_HOME` 与 workspace 都指向 `os.tmpdir()` 下的临时目录，
 *     真上游/真 profile 全程不碰；跑完默认清场（`--keep` 可留）。
 *  ③ **退出码三态**（照 `tools/verify-handoff.mjs:62-65"` 的约定）：
 *     0 = 全 PASS / 1 = 有 FAIL / 2 = 有 UNVERIFIED（读不到 ≠ 通过，也不算失败）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, basename, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'
// ⚠️ 静态 import（`cliOverrides` 是同步函数，不能在里面 await）。
//   用**同一个** `recoverFromInstalledPreset`（`lib/config.js`）—— 与 `tools/promote-upstream.mjs`
//   共用一份实现，避免"同样一件事、两个工具给两个答案"（Round 21 实测的缺口）。
import { recoverFromInstalledPreset } from '../lib/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
/** 本包名 —— 用来在 `$DSH_HOME/.agent-presets/*` 里找"**引用本包**的那个预设"（不写死预设名）。 */
const PKG_NAME = '@dsh-external/dsh-teamkit'

const argv = process.argv.slice(2)
// ⚠️⚠️ **不要用 `?? 'help'` 兜底**（2026-09-14 / Round 78 修的真缺陷）。
//
// 【缺陷现场】这里原来是 `argv[0] ?? 'help'` —— 于是**无参数时 `cmd` 变成了 `'help'`**，
//   让下面那个 **`case undefined:`（我特意为"没给子命令"写的分支）永远进不去**。
//   实测：我加了 `case undefined:` + `process.exit(1)`，**无参数仍然 exit 0** ——
//   查了三遍才发现**它根本没走到那个 case**（`cmd` 早就被兜底成 `'help'` 了）。
//
// 【为什么这不是小事】无参数**不是"请求帮助"**：脚本/CI 里
//   `teamkit` 什么都不干却返回 0 ⇒ **看起来成功了**（同族：R69"判据恒红"、R73"声明了没人读"：
//   **表面上像在工作，实际没有任何信息**）。
//   对照 `git` / `npm`：无参数 ⇒ 打印用法 + **退出码 1**。
//
// ⇒ 现在：`cmd` **原样保留 `undefined`**，由派发 switch 的 `case undefined:` 明确处理
//   （打印用法到 stderr + exit 1）；**显式 `help` / `--help` / `-h` 仍 exit 0**。
const cmd = argv[0]
const has = (f) => argv.includes(f)
const val = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

// ── 三态记账（本文件唯一的判定出口）────────────────────────────────────────
const report = { pass: 0, fail: 0, unverified: 0, skipped: 0, rows: [] }

// ══════════════════════════════════════════════════════════════════════════════
// ★★★ **处境：我在"仓内"还是"包内"**（2026-09-15 / CEO 批；`task-113` 开源前置）
//
// 【为什么】`selftest` 里有 **33 条断言**读的是**仓根文件**
//   （`tools/check-all.mjs` · `presets/omc/…` · `tools/install-teamkit.mjs` · `TALENTS.yml` …）
//   ⇒ ★ **在"只有 `plugin/`"的处境下它们必然失败** —— 而那**不是缺陷，是处境不同**。
//   ⇒ ⚠️ **开源用户第一屏跑 `selftest` 会看到 33 条红** ⇒ 他会以为"这包坏了"。
// 【与既有语义一致】`tools/check-all.mjs` 早有 **`repoOnly: true`**（逐字：
//   「**`repoOnly: true`** 的这几条**不在发布包里**…**按"在仓内跑"与"在包里跑"两种处境分别给判据**」）
//   ⇒ ★ **本条就是把这个语义搬进 `selftest`**（`R10`：**不造第二套**）。
// 【为什么是"逐条"而不是"按组"】★ **实测（`repoOnly-group-measure.mjs`）**：
//   · 裸目录下**整组可跳**的组 **12 个**（C3/H5/H18/H29/H31/H33/H39/H40/H41/H42/H50/H52）
//   · ★★ 但有 **6 个混合组**（裸目录下**既有通过又有失败**）：
//     `E2R`（**35 通过** / 3 失败）· `R`（**21 通过** / 2 失败）· `H32`(1/4) · `H6`(1/2) · `H7`(1/1) · `H10`(3/2)
//     ⇒ ★ **按组跳会【静默吞掉 `E2R` 那 35 条真正通过的】** ⇒ **必须逐条标**。
// 【为什么用"文案"当键、不用行号】行号会漂；**文案是运行时的稳定标识**；
//   且**一处数据表 = 逐条标记**（否则要在 33 个调用点各写一遍）。
// 【★ fail-closed（CEO 判据⑤）】★ **判不出版处 ⇒ 按"仓内"处理（【不跳过】）** ——
//   「**不许跳过**」是保守侧：宁可多报红，也不许把"没验"混进"全绿"。
// ══════════════════════════════════════════════════════════════════════════════
const LAYOUT = (() => {
  try {
    // 锚点：`tools/check-all.mjs` 只存在于**仓根**（不在包里）
    if (existsSync(join(PLUGIN_DIR, '..', 'tools', 'check-all.mjs'))) return 'repo'
    // 反向锚：包内必有 `package.json` 且**没有**仓根那些目录
    if (existsSync(join(PLUGIN_DIR, 'package.json')) && !existsSync(join(PLUGIN_DIR, '..', 'runs'))) return 'package'
    return 'repo' // ★ 判不出 ⇒ **保守按仓内**（不跳过）
  } catch {
    return 'repo' // ★ 连探都探不了 ⇒ 保守按仓内
  }
})()

/** 读**仓根**文件、因而在包内布局下必然不成立的断言（**逐条**，键 = 失败时打印的那句文案） */
const REPO_ONLY_ASSERTIONS = new Set([
  '两套实现写出的东西不一样 ⇒ 用哪个工具结果不同（"同一件事两条实现会漂"）', // [C3]
  '两边的"说明是硬门"判据不一致 ⇒ 脚本按退出码判断时会得到不同结论', // [C3]
  '只报"已存在 ⇒ 跳过" ⇒ 用户分不清"我有改动"与"上游没更新我"（Round 35 实测的缺口）', // [R]
  '`--check` 说 OK 而真机是旧的 ⇒ 用户没有"不安装也能发现问题"的手段', // [R]
  '本判据要读它；读不到不假装', // [H18]
  '它在**仓根** `tools/` 下（不在包里）', // [H29]
  '首行写着 "The `standard` agent preset" ⇒ 维护者以为看错文件；且**头注释是"这文件是什么"的唯一说明**', // [H31]
  '不写派生关系 ⇒ 读者无法核对"只加了 teamkit 一行"这条承诺（委托方口径"其它 preset 不受影响"就没法验）', // [H31]
  '"不再装" ≠ "旧的会自己消失" ⇒ 老用户机器上会**永远留着**已经不该分发的目录（R26 修了一半；R75 补另一半）', // [H32]
  '静默删 ⇒ 用户不知道自己的目录被动过（本插件全局纪律：失败/动作都不静默）', // [H32]
  '按名单盲删 ⇒ **会删掉用户自己现写的 Talent**（`TALENTS.yml` 明说"缺口就现写一份落盘"）；不 prune ⇒ 又留孤儿（`roles/A/` 同族）⇒ **只有标记制两头都对**', // [H32]
  '覆盖 principles ⇒ 抹掉成员的自我迭代记录（本插件的 SOUL/原则自演化就靠它）', // [H32]
  '`--help` 却真去装 ⇒ 用户"只想看看开关"就改了系统（`LANDMINES §7` 同族：脚本不看参数就动手）', // [H33]
  '开关只在 README 里 ⇒ 命令自己是"黑盒"；而 `$DSH_HOME` 定向是**唯一安全的破坏性测试姿势**（R76 的事故就因为没有它）', // [H33]
  '不查 ⇒ 上游根旧了也报"7 条全 OK"、退出码 0 ⇒ **R47 那个"模型读旧版却无报错"复发在状态报告里**', // [H39]
  '跑完不 exit ⇒ 脚本/CI 里**永远退 0**，哪怕刚报了"7 条待更新"（R78"无参数 exit 0"同族：退出码是接口）', // [H39]
  '**两种装法各读一个根**：预设装法读 `skills-upstream`；bundle 装法读 `$DSH_HOME/skills`（也是全局扫的那个）⇒ 缺一份就有一种装法读不到', // [H40]
  '不写明 ⇒ 下一个人会当"重复劳动"删掉其中一份 ⇒ **删掉就是 R47 复发**（模型读不到技能、且无报错）', // [H40]
  '空头承诺（"我们不"其实没人拦）⇒ 成员以为有硬门、写空判据时想"反正它会拦我"（R86 实测抓到一处）', // [H41]
  '留着一个**错的**反转断言 ⇒ 别人（或下一轮的我）会照它做决定；真相是"引擎真、有 caller，**但喂进去的输入全空**" ⇒ 生产路径**恒允许**', // [H42]
  '只纠正那一条 ⇒ 下次遇到"有引擎有测试有 caller"的假机制，**还会被骗**（方法比结论耐用）', // [H42]
  '**C2 的真实事故**：P0 报告 A1–A5 **5/5 都是"加约束"**，减负 **0 条** —— 复盘只加负担、从不减', // [H50]
  '**比"号存不存在"**抓不到它（三次撞号里号都已存在）⇒ **必须比内容指纹**；撞号的代价 = **用 A 的纪律去记 B 的违规**', // [H52]
  '能力做了但技能里没有 ⇒ 成员与 Lead 都读不到它 ⇒ 等于没做（`H16` 已抓过三次）', // [E2R]
  '把"有个字段"说成"会拦住你" ⇒ 正是 `H41` 抓的那种空头承诺', // [E2R]
  '`blocked_by`(E_dep) 与 `parentTask`(E_tree) 是两样东西，同一对节点上方向可能相反', // [E2R]
  '真事故换来的规则被静默改掉 ⇒ 下一个照做的人会重犯同一个错', // [H5]
  '新成员按 SOP 读却读不到"正解在哪" ⇒ 会以为正解还不存在（只判"全文含"是不够的）', // [H6]
  'SOP 引用了不存在的入口 ⇒ 新成员照着跑会直接失败', // [H6]
  '把证据删了 ⇒ `REPORT.md:43` / `A-LAYER-AUTHORITY.md` 的引用变成死链（同族：删之前先 grep 引用）', // [H7]
  '自测永远报 6 条 UNVERIFIED 而没人能分清"真没验"与"验了没记"', // [H10]
  '没有口径 ⇒ 读者还是分不清状态', // [H10]
])

const OK = (group, msg, readout) => {
  report.pass += 1
  report.rows.push({ group, state: 'PASS', msg, readout })
  process.stdout.write(`  OK  [${group}] ${msg}${readout === undefined ? '' : `  — ${readout}`}\n`)
}
const BAD = (group, msg, readout) => {
  // ★★ 包内布局 ⇒ 逐条标过的仓内专有断言**报 SKIP**（不是 FAIL）—— 见上面 `LAYOUT` 那段注释
  if (LAYOUT === 'package' && REPO_ONLY_ASSERTIONS.has(msg)) {
    report.skipped += 1
    report.rows.push({ group, state: 'SKIP', msg, readout })
    process.stdout.write(`  --  [${group}] ${msg}  — **SKIP：仓内专有（包内布局）**\n`)
    return
  }
  report.fail += 1
  report.rows.push({ group, state: 'FAIL', msg, readout })
  process.stdout.write(`  XX  [${group}] ${msg}${readout === undefined ? '' : `  — ${readout}`}\n`)
}
/** **读不到 ≠ 不成立**（`LANDMINES §6`）：既不给 PASS 也不算 FAIL。 */
const UNV = (group, msg, readout) => {
  report.unverified += 1
  report.rows.push({ group, state: 'UNVERIFIED', msg, readout })
  process.stdout.write(`  ??  [${group}] ${msg}${readout === undefined ? '' : `  — ${readout}`}\n`)
}
const CHECK = (group, cond, good, bad, readout) => (cond ? OK(group, good, readout) : BAD(group, bad, readout))

const section = (title) => process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}\n`)

/**
 * `teamkit version` —— 报版本（**只读 `package.json`、不写盘**；2026-09-14 / Round 78 补）。
 *
 * 【为什么必须有】北极星是"**越方便开源后其他用户安装越好**"，而"报 bug 时能说清装的哪一版"
 *   是**最基本的一格**。它原来不被支持（`--version` ⇒ `未知子命令`），
 *   而 `package.json` 里明明有 `version`。
 * ⚠️ 额外报 **node 版本**与**运行形态**（仓内 / 包内）—— 排查时这两个最常被问到。
 */
function versionCmd() {
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  } catch {
    /* 读不到就报不出名字/版本，但不该崩 */
  }
  // ⚠️ **用 `/` 判断，不引 `path.sep`** —— 我第一版写了 `sep`（**没导入**）⇒ `version` 直接
  //    `ReferenceError: sep is not defined`（**语法检查查不出来，只有真跑才炸**）。
  //    ⇒ 教训：**新加的 CLI 子命令，加完必须真跑一次**（`node --check` 只查语法，查不到未定义引用）。
  const norm = PLUGIN_DIR.replace(/\\/g, '/')
  const where = norm.includes('/node_modules/') ? '包内（npm install 后）' : '仓内（开发布局）'
  process.stdout.write(`${pkg.name ?? '(未知包名)'} ${pkg.version ?? '(无 version 字段)'}\n`)
  process.stdout.write(`  node           ${process.versions.node}\n`)
  process.stdout.write(`  运行形态       ${where}\n`)
  process.stdout.write(`  插件目录       ${PLUGIN_DIR}\n`)
}

function help() {
  process.stdout.write(`teamkit —— Agent Teams 组织层插件（上游 / fork / PR 三件套）

用法：
  teamkit selftest [--json] [--keep]   三态自测（在临时目录里跑，不碰真上游）
  teamkit status                       当前配置解析结果 + 各件开关（只读）
  teamkit list   [--source <dir>]      上游待合并清单（只读）
  teamkit promote (--skill X | --all) --note "说明" [--source <dir>] [--upstream <dir>] [--dry-run]
  teamkit rollback <skill>
  teamkit fork-init <member> <skill>
      ⚠️ **只作用于全局 fork 根**（离线路径没有 agent ⇒ 拿不到 session.header.cwd，
      无法按项目分）。运行时它会打一行 FORK-SEED-GLOBAL 明说这件事。
      要按项目分见 runs/005-role-skills/STATE-LOCATION.md §6。
  teamkit doctor
  teamkit init                         ★ **初始化一家公司**：装齐该装的 + **逐条报"还差什么、为什么"**
                                      （⚠️ 它**装不齐** —— 我们这家公司是多个包，只有本包开源了）
  teamkit help | --help | -h           本页（**不写盘**）
  teamkit version | --version | -v     报版本（读 package.json，**不写盘**）—— 报 bug 时带上它

★ **重启后的续接（委托方「重启之后接不上」/「把 goal 重新打开」那两条的交付物）**：
  teamkit resume  --snapshot <file.json>   ★ **列出**孤儿任务 / 失联成员 / 被 disarm 的 goal（**只列，不发送**）
      ⚠️ **快照怎么来**：'members'/'live' 必须来自**进程内 list_agents** ——
        ★ **不要用 journal 的 phase 去推断**（那会出**假绿**：看着"有人在做"，其实会话早没了）
  teamkit wake    --snapshot <file.json>   **真的重新点名**（给失联成员发消息）—— 默认 **dry-run**，--yes 才真发
  teamkit goals   [--snapshot <file.json>]  **goal 的落盘状态**（含被 disarm 的）—— 对应「把 goal 重新打开」
  teamkit orphans --snapshot <file.json>   孤儿任务巡检：in_progress 但 owner 不活跃/不在名单 ⇒ **exit=1（红）**
  teamkit board-replay --snapshot <file>   任务板重放（event-sourced journal ⇒ 核对重放后与当前是否一致）
  teamkit verify-route <member> --provider <p>   **核这个成员所在的模型链能不能用**（坏链上 ⇒ 红）
  teamkit probe-check <file> | --stdin      探针源码静态检查（"写共享对象且无回读" ⇒ 判红）
  teamkit preset-new <name>                 生成一份 agent preset（形态见 preset-gen）
  ⇒ ★ 这些**离线**（拿不到宿主进程内状态）⇒ 所以要你给 --snapshot；
    快照的产生方式见 README §命令（以及 runs/005-role-skills/RESUME-USER-VIEW.md）。

⚠️ **CLI 是离线跑的**（没有 profile ⇒ 配置只能来自 env/参数），所以有这三个显式覆盖：
  --source <dir>    **仓内源**（默认 <workspace>/skills）—— 就是你要合并进上游的那份技能仓
  --upstream <dir>  上游技能根（默认 $DSH_HOME/skills）
  --state <dir>     状态目录（默认 **$DSH_HOME/.teamkit**，含 forks/ 快照/ 日志/ CHANGELOG）
  ⚠️ task-57 起，--state 的默认值**不再跟 process.cwd()**（旧默认 <workspace>/.teamkit 在真宿主里
     等于宿主 cwd ⇒ 多项目串台）。**各成员的 fork** 落点由该 agent 的 cwd 决定（<其 cwd>/.teamkit）。
  不给 --source 时它会对你配置里的源干活 —— **不会**去动插件自带的 skills/。

配置来源（**唯一事实来源** = lib/config.js）：
  $DSH_TEAMKIT_WORKSPACE  工作区（默认 process.cwd()）
  $DSH_HOME               DSH 家目录（默认 ~/.dsh）
  $DSH_TEAMKIT_STATE      状态目录（默认 **$DSH_HOME/.teamkit**）
  $DSH_TEAMKIT_DISABLE    药停文件路径（存在即放行 guard）
  其余（含每项默认值与理由）见 README 的配置表。
`)
}

// ── 统一的沙盒装置 ────────────────────────────────────────────────────────
function sandbox({ keep = false } = {}) {
  const base = join(tmpdir(), `teamkit-selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const home = join(base, 'dshhome')
  const ws = join(base, 'ws')
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const env = { ...process.env, DSH_HOME: home, DSH_TEAMKIT_WORKSPACE: ws }
  delete env.DSH_TEAMKIT_STATE
  delete env.DSH_TEAMKIT_DISABLE
  return { base, home, ws, env, cleanup: () => (keep ? undefined : rmSync(base, { recursive: true, force: true })) }
}

function writeSkill(dir, name, { body = 'BODY', frontmatter = true, bom = false } = {}) {
  mkdirSync(dir, { recursive: true })
  const text = frontmatter
    ? `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n${body}\n`
    : `${body}\n`
  writeFileSync(join(dir, 'SKILL.md'), (bom ? '\uFEFF' : '') + text, 'utf8')
  return join(dir, 'SKILL.md')
}

/**
 * 各测试组**互相隔离**的配置解析：每组一个自己的 workspace + DSH_HOME 子目录。
 * ⚠️ 必须**先剥掉** `$DSH_TEAMKIT_WORKSPACE`（否则各组会解析到同一个 workspace/上游根，
 * 互相污染 —— 第一版就踩了：D 组和 E 组共享了 `<dshhome>/skills`，因为 env 里的
 * workspace 变量把 `cwd` 覆盖掉了）。这条保留作注：**配置优先级本身就该有测试**。
 */
function groupEnv(sb, group) {
  const env = { ...sb.env }
  delete env.DSH_TEAMKIT_WORKSPACE
  const ws = join(sb.base, `ws-${group}`)
  const home = join(sb.base, `home-${group}`)
  mkdirSync(ws, { recursive: true })
  mkdirSync(home, { recursive: true })
  env.DSH_HOME = home
  return { env, cwd: ws }
}

function groupPaths(cfg, sb, group, raw = {}) {
  const { env, cwd } = groupEnv(sb, group)
  return cfg.resolveAll(raw, { pluginDir: PLUGIN_DIR, env, cwd })
}

/**
 * 造一个**最小 ctx** 给真 `SkillRegistry` 用（`G2` 与 `G3` 共用 —— 单一事实来源）。
 *
 * 两处坑（都是实测踩出来的，别省）：
 *  ① `Service` 构造会调 `ctx.reflect.provide(name, self, check)`（`cordis:1781`）⇒ 必须给 `reflect.provide`；
 *  ② `ScopedLayers.effect` 传的是**生成器函数**（`dsh-scope:192` `ctx.effect(function* () { … })`）：
 *     先 `yield*` 跑完同步体（**注册就发生在这一步**），再 `yield` 出的才是 disposer。
 *     **把生成器当普通函数调 ⇒ 注册从未发生 ⇒ `list()` 返回 0 ⇒ 假阴性**（`plugin-smith` 实测量过）。
 * @param logs 可选数组；`logger.warn` 的输出会推进去（供断言"注册表有没有报错"）
 */
function mkMinimalRegistryCtx(logs = []) {
  const ctx = {
    logger: {
      warn: (m) => logs.push(String(m)),
      info: () => {},
      debug: () => {},
      error: (m) => logs.push('ERR ' + m),
    },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      try {
        if (fn !== null && typeof fn === 'function' && fn.constructor?.name === 'GeneratorFunction') {
          const it = fn()
          let step = it.next()
          const ds = []
          while (step.done !== true) {
            if (typeof step.value === 'function') ds.push(step.value)
            step = it.next()
          }
          return () => { for (const d of ds) { try { d() } catch { /* ignore */ } } }
        }
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      } catch {
        return () => {}
      }
    },
    reflect: { provide: () => () => {}, store: {} },
  }
  ctx.root = ctx
  return ctx
}

/**
 * 定位**真 `@deepseek-ai/dsh-skill`** 所在目录（`G2` 与 `G3` 共用 —— 单一事实来源）。
 *
 * 用**候选列表**而不是单一算法（`LANDMINES §4`）：先 `$DSH_PACKAGES`，再常见 npm/pnpm 位置；
 * **判据是"目录里真有 `dsh-skill/lib/index.js`"**，不是"路径看着像"。
 * @returns 归一化后的包根（可直接 `join(root, 'dsh-skill', 'lib', 'index.js')`），或 `undefined`
 */
function findRealPackagesRoot() {
  const cands = []
  if (process.env.DSH_PACKAGES) cands.push(process.env.DSH_PACKAGES)
  cands.push(
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai'),
    join(process.env.LOCALAPPDATA ?? '', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai'),
  )
  for (const c of cands) {
    if (c === '' || !existsSync(c)) continue
    if (existsSync(join(c, 'dsh-skill', 'lib', 'index.js'))) return c
    const sub = join(c, '@deepseek-ai')
    if (existsSync(join(sub, 'dsh-skill', 'lib', 'index.js'))) return sub
  }
  return undefined
}

// ── R2 探针纪律的**机械校验**（H46；2026-09-14 / task-85；**task-92 移入 lib/**）─────
// ★★ **判据本体已移到 `plugin/lib/probe-source.js`**（**单一事实来源**）——
//   因为判据现在有**两个消费者**，且**必须同一份代码**（否则“离线检”与“在线拦”变成两套判据）：
//     ① 离线检：`teamkit probe-check`（本文件）；② 在线拦：`lib/probe-gate.js` 的 `tools.guard`。
//   ⚠️ **不能把判据留在 bin/ 里再让 lib 来 import 本文件** —— 本文件底部就是 CLI 入口 `switch (cmd)`，
//     **import 它会重跑整个 CLI**（我在 task-85 就踩过一次同款：`await import(自己)`）。
//   ⚠️⚠️ **必须 `import` + `export` 两条都写**：只写 `export {…} from ‘…’` **不把名字带进本文件作用域**
//     ⇒ `probeCheckCmd` 里引用它 ⇒ `ReferenceError: checkProbeSource is not defined`。
//     （这条是**“加完必须真跑一次”**抓到的：`node --check` 只查语法，查不出未定义引用。）
export { checkProbeSource } from '../lib/probe-source.js'
import { checkProbeSource } from '../lib/probe-source.js'

// ── selftest ──────────────────────────────────────────────────────────────
async function selftest() {
  const sb = sandbox({ keep: has('--keep') })
  process.stdout.write(`teamkit 自测 · 插件 ${PLUGIN_DIR}\n`)
  process.stdout.write(`  沙盒 ${sb.base}${has('--keep') ? '（--keep：跑完保留）' : '（跑完清场）'}\n`)

  // 动态 import（这样 CLI 的 help/doctor 不需要加载任何 lib）
  const cfg = await import('../lib/config.js')
  const skills = await import('../lib/skills.js')
  const upstream = await import('../lib/upstream.js')
  const fork = await import('../lib/fork.js')
  const notify = await import('../lib/notify.js')
  const guard = await import('../lib/guard.js')
  const entry = await import('../lib/index.js')
const roles = await import('../lib/roles.js')

  // ═══ A · 配置与路径（零硬编码）════════════════════════════════════════
  section('A · 配置与路径（零硬编码）')
  const paths = cfg.resolveAll({}, { pluginDir: PLUGIN_DIR, env: sb.env, cwd: sb.ws })
  OK('A', 'resolveAll(空配置) 成功', `workspace=${paths.workspace}`)

  // 沙盒内的路径 = 全部**配置派生**的路径（不含 skills.sourceDir —— 它默认指向本包自己的
  // skills/，那是包内资源、本来就该在包旁边，不是"硬编码用户的盘符"）
  const sandboxPaths = [
    paths.workspace, paths.dshHome, paths.stateDir, paths.forkRootTemplate, paths.historyDir,
    paths.changelogPath, paths.logFile, paths.upstream.root,
    ...paths.upstream.sources, ...paths.upstream.extraRoots,
  ]
  const outside = sandboxPaths.filter((p) => !resolve(p).startsWith(resolve(sb.base)))
  CHECK('A', outside.length === 0, '所有**配置派生**的路径都落在临时沙盒之内（默认值不含用户的盘符/仓路径）',
    '有路径越出了沙盒 ⇒ 说明存在硬编码', `${sandboxPaths.length - outside.length}/${sandboxPaths.length} 在沙盒内`)

  // 更硬的一条：**代码里不许出现盘符字面量**（这才是"零硬编码"的直接判据）
  // 只查**代码**，注释里出现 `D:/dsh/...` 是允许的（本包的注释大量引用实测现场路径，
  // 那是证据不是配置）—— 所以先剥注释再查。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const libFiles = ['index.js', 'config.js', 'skills.js', 'fork.js', 'notify.js', 'upstream.js', 'guard.js', 'log.js']
  const hardLiterals = []
  for (const f of libFiles) {
    const code = stripComments(readFileSync(join(PLUGIN_DIR, 'lib', f), 'utf8'))
    for (const m of code.matchAll(/['"`][^'"`\n]*[A-Za-z]:[\\/][^'"`\n]*['"`]/g)) {
      hardLiterals.push(`${f}: ${m[0]}`)
    }
    if (/omc-agent-teams/.test(code)) hardLiterals.push(`${f}: 代码里含 'omc-agent-teams'`)
  }
  CHECK('A', hardLiterals.length === 0,
    '`lib/**` 的**代码里**没有盘符字面量、也没有本仓名字面量（注释里的引用不算 —— 那是证据）',
    '代码里存在硬编码路径 ⇒ 开源用户装到别的盘就废', hardLiterals.join(' | ') || '0 处')

  const rootTemplateHasSlot = paths.forkRootTemplate.includes('{member}')
  CHECK('A', rootTemplateHasSlot, 'forkRootTemplate 里保留 `{member}` 槽位', '模板里没有 {member}，多成员会互相踩')

  const forkDirA = cfg.forkRootFor(paths, 'writer')
  const forkDirUnsafe = cfg.forkRootFor(paths, '../../evil')
  CHECK('A', forkDirA.includes('writer') && !forkDirUnsafe.includes('..'),
    'forkRootFor 会白名单化成员名（`../../evil` 不会被拼进路径）', '成员名没做白名单 ⇒ 路径穿越',
    `'../../evil' → ${relative(sb.base, forkDirUnsafe)}`)

  // ── A2 · ★ **两个 Team 的同名成员必须分到不同 fork 目录**（2026-09-14 的真缺陷）─────
  // 【缺陷】落点原为 `<stateDir>/forks/{member}/skills` —— **只按成员名**，
  //   而 DSH 的成员名是 **per-Team** 的（roster 属于 Team root = Lead 会话），**不是全局唯一**。
  //   ⇒ 同一工作区里两个 Team 各有一个 `engineer` 时**撞同一个目录**：
  //     一方写的 fork**另一方看得见**（互相污染），而且插件会把 provider 装给**它认的那个** agent，
  //     另一个 Team 的成员**自己写的 fork 对自己不生效**（实测：`skill` 拿到的仍是上游版）。
  // 【判据】两个 agent，`member` 同名、`parentSession` 不同 ⇒ **fork 落点必须不同**；
  //   且**都没 parentSession** 时也要给个稳定值（不能是空路径 / 不能抛）。
  {
    const mkAgent = (id, parent) => ({
      id,
      session: { header: { cwd: sb.ws, parentSession: parent, agentPreset: 'x' } },
    })
    const a1 = mkAgent('agent-aaa', 'session-fa986645-a03f-4ab1-9c56-991b0de4d0c9')
    const a2 = mkAgent('agent-bbb', 'session-1cdd6ee8-dae1-4642-bda1-b588f1a3e30e')
    const p1 = cfg.pathsForAgent(paths, a1)
    const p2 = cfg.pathsForAgent(paths, a2)
    const f1 = cfg.forkRootFor(p1, 'engineer', { agent: a1 })
    const f2 = cfg.forkRootFor(p2, 'engineer', { agent: a2 })
    CHECK('A2', f1 !== f2,
      '★ **两个 Team 的同名成员分到不同 fork 目录**（fork 路径含 Team 判别层）',
      '两个 Team 的同名成员撞同一 fork 目录 ⇒ 互相污染、且"自己写的 fork 对自己不生效"（实测缺陷）',
      `A=${relative(sb.base, f1)}  B=${relative(sb.base, f2)}`)
    const slugs = [cfg.teamSlugOf(a1), cfg.teamSlugOf(a2)]
    CHECK('A2', slugs[0] !== slugs[1] && slugs.every((s) => /^[A-Za-z0-9_-]+$/.test(s)),
      '`teamSlugOf` 给出**可区分且字符集安全**的 Team slug（白名单化，防穿越）',
      'slug 相同或含非法字符 ⇒ 仍然撞 / 有路径穿越风险', slugs.join(' vs '))
    CHECK('A2', cfg.teamSlugOf(undefined) === 'default' && cfg.teamSlugOf({ session: { header: {} } }) === 'default',
      '**拿不到 Team 身份 ⇒ 退回 `default`**（不是抛错：`agent/created` 是同步 emit，抛错会否决 agent 发布）',
      '拿不到身份时抛错或给出空串', `undefined→${cfg.teamSlugOf(undefined)}`)
    const unsafeTeam = cfg.teamSlugOf({ session: { header: { parentSession: 'session-../../evil/x' } } })
    CHECK('A2', !unsafeTeam.includes('/') && !unsafeTeam.includes('..'),
      '`teamSlugOf` 对恶意 `parentSession` 也白名单化（`../..` 进不去）',
      'Team slug 可被穿越', unsafeTeam)
  }

  const expanded = cfg.expand('~/sub', { workspace: sb.ws, env: { HOME: '/home/x' } })
  const expandedRel = cfg.expand('rel/sub', { workspace: sb.ws, env: {} })
  const expandedEnv = cfg.expand('${DSH_HOME}/sub', { workspace: sb.ws, env: { DSH_HOME: sb.home } })
  CHECK('A', expandedRel === join(sb.ws, 'rel', 'sub') && expandedEnv === join(sb.home, 'sub'),
    '相对路径按 workspace 解析、`${ENV}` 按环境展开', '路径展开规则不对',
    `rel → ${relative(sb.ws, expandedRel)} ; \${DSH_HOME} → ${relative(sb.home, expandedEnv)}`)

  const vGood = cfg.Config['~standard'].validate({ notify: { minIntervalMs: 0 } })
  const vBadType = cfg.Config['~standard'].validate({ notify: { minIntervalMs: 'soon' } })
  const vUnknown = cfg.Config['~standard'].validate({ notifyy: {} })
  const vBadTop = cfg.Config['~standard'].validate([])
  CHECK('A', vGood.value !== undefined && vGood.issues === undefined,
    'Config.validate 接受合法配置', '合法配置被判非法')
  CHECK('A', vBadType.issues?.length > 0, 'Config.validate 会拒绝**类型错**的键（`minIntervalMs: "soon"`）',
    '类型错被放过 ⇒ 装上去静默不生效')
  CHECK('A', vUnknown.issues?.length > 0 && /未知的配置键/.test(vUnknown.issues[0].message),
    'Config.validate 会拒绝**打错的键名**（`notifyy`）—— "失败不静默"',
    '打错的键被放过 ⇒ 用户以为配置生效了，其实没有（正是 B.4 要防的）')
  CHECK('A', vBadTop.issues?.length > 0, 'Config.validate 会拒绝非对象配置', '非对象配置被放过')

  // ── A3 · **从已安装的预设捞回配置**（2026-09-14 / Round 16 的真缺陷）──────────
  // 【缺陷】`dev_reload_package` 热重载重建的实例**读不到预设里的 `config`**，
  //   而**新建会话不会重新 apply 插件** ⇒ 剩下的是**裸实例**：`roles.dir=''`
  //   ⇒ 它**仍接管成员，却给不出角色**（实测 `coo` 报 `ROLE-SKIP {why:"no-role"}`，而角色档明明在）。
  // 【修法】从"已安装的预设"里把 `preset.id` / `roles.dir` **捞回来**（只读、不猜、读不到就空）。
  // 【本组判据】① 在**有该预设**的机器上能捞到；② **负例必须返回空**（不猜、不 pretend）；
  //   ③ 求值 `!!js` 用的语义与 DSH 一致（`process.env` 可用）。
  {
    const fakeHome = join(sb.base, 'home-a3')
    const presetDir = join(fakeHome, '.agent-presets', 'probe-preset')
    mkdirSync(presetDir, { recursive: true })
    const pkg = '@dsh-external/dsh-teamkit'
    writeFileSync(join(presetDir, 'agent.cordis.yml'), [
      '# 人造预设（自测用）',
      '- id: dsh-teamkit',
      `  name: '${pkg}'`,
      '  config:',
      '    preset:',
      '      id: probe-preset',
      '    roles:',
      "      dir: !!js (process.env.DSH_HOME || '/fallback') + '/teamkit/roles'",
      '    upstream:',
      "      root: !!js (process.env.DSH_HOME || '/fallback') + '/teamkit/skills-upstream'",
      '',
      '- id: skill-filesystem',
      '  name: dummy',
      '  config:',
      '    includeDefaultRoots: false',
      '    customSkillDirs:',
      "      - !!js (process.env.DSH_HOME || '/fallback') + '/teamkit/skills-upstream'",
      '',
      '- id: tool-skill',
      '  name: dummy2',
      '',
    ].join('\n'), 'utf8')
    const rec = cfg.recoverFromInstalledPreset(fakeHome, pkg, { DSH_HOME: 'X:/h' })
    CHECK('A3', rec.presetId === 'probe-preset',
      '★ 能从已安装预设里捞回 `preset.id`（热重载后 config 丢失的兜底）',
      '捞不回来 ⇒ 裸实例要么越界接管、要么什么都不装（两种都不对）',
      `presetId=${rec.presetId}`)
    CHECK('A3', String(rec.rolesDir).replace(/\\/g, '/') === 'X:/h/teamkit/roles',
      '★ 能求值 `roles.dir` 的 `!!js` 表达式（与 DSH 同一套 `with(ctx){eval(expr)}` 语义）',
      '`!!js` 求值不对 ⇒ 公司层读不到角色档', `rolesDir=${rec.rolesDir}`)
    // ★ **`upstream.root` 也要捞**（Round 17 补 —— Round 16 漏了它，导致读写不同指、上游链静默断）
    CHECK('A3', String(rec.upstreamRoot).replace(/\\/g, '/') === 'X:/h/teamkit/skills-upstream',
      '★ 能捞回 `upstream.root`（**写路径**）—— 漏了它 ⇒ 读写不同指 ⇒ 上游链静默断（Round 5 事故的形态）',
      '没捞 upstream.root ⇒ 裸实例会往默认 `$DSH_HOME/skills` 合并，而 omc 成员根本不读那里',
      `upstreamRoot=${rec.upstreamRoot}`)
    // ★ **读路径也要捞，且要能自查"读写同指"**（并且**不许把下一个顶层键吃进来**）
    CHECK('A3', Array.isArray(rec.customSkillDirs) && rec.customSkillDirs.length === 1
      && String(rec.customSkillDirs[0]).replace(/\\/g, '/') === 'X:/h/teamkit/skills-upstream',
      '★ 能捞出读路径 `customSkillDirs`（**只收列表项**，不吃下一个顶层键 `- id: tool-skill`）',
      '把顶层键当成目录 ⇒ "读写同指"自检会误报；漏掉读路径 ⇒ 比不了',
      JSON.stringify(rec.customSkillDirs))
    {
      const norm2 = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const copoint = rec.customSkillDirs.length > 0 && rec.customSkillDirs.every((d) => norm2(d) === norm2(rec.upstreamRoot))
      CHECK('A3', copoint, '★ 捞回的读路径与写路径**同指**（本项目踩过两次的"上游链静默断"就以这条为判据）',
        '读写不同指 ⇒ promote 上去谁都看不到且不报错', `read=${rec.customSkillDirs[0]} write=${rec.upstreamRoot}`)
    }
    // 负例：**不许猜**
    const rMiss = cfg.recoverFromInstalledPreset(join(sb.base, 'nope-home'), pkg, {})
    CHECK('A3', rMiss.presetId === undefined && rMiss.rolesDir === '' && rMiss.upstreamRoot === '',
      '**没有该预设的机器** ⇒ 返回空（不猜、不假装 —— 零配置安装场景靠这条保持原行为）',
      '读不到却造了一个值 ⇒ 会去读不该读的目录', JSON.stringify(rMiss))
    const rOther = cfg.recoverFromInstalledPreset(fakeHome, '@someone/else', {})
    CHECK('A3', rOther.presetId === undefined,
      '**预设不引用本包** ⇒ 不认领（按包名判，不写死预设名）',
      '认领了别人的预设 ⇒ 越界', JSON.stringify(rOther))
    const rEmpty = cfg.recoverFromInstalledPreset('', pkg, {})
    CHECK('A3', rEmpty.presetId === undefined && rEmpty.rolesDir === '',
      '空 `dshHome` ⇒ 返回空（不抛）', '空入参抛错', JSON.stringify(rEmpty))
  }

  // ═══ B · 技能条读写原语 ══════════════════════════════════════════════
  section('B · 技能条读写原语（含两个静默失效坑）')
  const srcRoot = join(sb.ws, 'src-skills')
  writeSkill(join(srcRoot, 'alpha'), 'alpha')
  writeSkill(join(srcRoot, 'beta'), 'beta', { body: 'BETA-BODY' })
  mkdirSync(join(srcRoot, 'not-a-skill'), { recursive: true })          // 目录但没有 SKILL.md
  writeFileSync(join(srcRoot, 'flat.md'), '---\nname: flat\ndescription: flat skill\n---\n\nFLAT\n', 'utf8')
  writeSkill(join(srcRoot, 'bom-bad'), 'bom-bad', { bom: true })        // ← LANDMINES §19：BOM ⇒ 静默失效
  writeSkill(join(srcRoot, 'no-fm'), 'no-fm', { frontmatter: false })   // ← 没有 frontmatter

  const parsedValid = skills.parseSkill('---\nname: x\ndescription: y\n---\n\nbody\n')
  const parsedBom = skills.parseSkill('\uFEFF---\nname: x\ndescription: y\n---\n\nbody\n')
  CHECK('B', parsedValid.hasFrontmatter && parsedValid.hasBom === false && parsedValid.body.includes('body'),
    'parseSkill 认合法 frontmatter', 'parseSkill 解析失败')
  // ⚠️ 口径（第一版这里写错过）：我们自己的解析器**会剥 BOM**（比 DSH 宽松），
  //    但 DSH 的 `parseFrontmatter` 要求首行**严格等于** `---` ⇒ 带 BOM 的条**整条静默消失**。
  //    所以判据不是"我们能不能解析"，而是 **`hasBom` 必须被标出来**、且 **`scanRoot` 必须把它归为 skip**。
  CHECK('B', parsedBom.hasBom === true,
    '**BOM 被显式标出来**（`hasBom:true`）—— 这是让调用方能 warn/拒绝的信号',
    'BOM 没有被标出 ⇒ 那个静默坑会被漏掉',
    `why=${parsedBom.why} hasFrontmatter=${parsedBom.hasFrontmatter}`)

  const bomDir = join(sb.base, 'bom-probe')
  writeSkill(join(bomDir, 'bom-skill'), 'bom-skill', { bom: true })
  const bomScan = skills.scanRoot(bomDir)
  CHECK('B', bomScan.entries.length === 0 && bomScan.skipped.some((s) => s.why.includes('BOM')),
    '**带 BOM 的条被 `scanRoot` 归为 skip 并给出原因**（照 DSH 的真实行为：它会被静默丢弃）',
    '带 BOM 的条被当成合法技能 ⇒ 我们会把它同步/装上去，而 DSH 根本看不见它',
    `entries=${bomScan.entries.length} skipped=${JSON.stringify(bomScan.skipped.map((s) => s.why))}`)

  const scan = skills.scanRoot(srcRoot)
  const names = scan.entries.map((e) => e.name).sort()
  CHECK('B', JSON.stringify(names) === JSON.stringify(['alpha', 'beta', 'flat']),
    'scanRoot 发现目录包 + 扁平包、跳过隐藏与非技能目录', 'scanRoot 的发现结果不对', `发现 ${names.join(',')}`)
  const skippedNames = scan.skipped.map((s) => s.name).sort()
  CHECK('B', skippedNames.includes('bom-bad') && skippedNames.includes('no-fm'),
    '跳过项**带原因返回**（bom-bad / no-fm）—— 这就是"失败不静默"的落点',
    '坏条目被静默吞掉 ⇒ 用户以为技能不在，其实是坏的', `skipped=${skippedNames.join(',')}`)

  const unreadable = skills.scanRoot(join(sb.base, 'does-not-exist'))
  CHECK('B', unreadable.readable === true && unreadable.existing === false,
    '不存在的根判为 `existing:false`（而不是"读不到"）', '不存在的根被误判成不可读')

  const w = skills.writeSkillFile(join(sb.base, 'wtest', 'SKILL.md'), '---\nname: w\n---\n\nx\n')
  const firstByte = readFileSync(join(sb.base, 'wtest', 'SKILL.md'))[0]
  CHECK('B', w.ok && firstByte === 0x2d,
    'writeSkillFile 写出的文件**首字节是 `-`（无 BOM）**并回读一致', '写出的文件带 BOM 或回读不一致',
    `首字节 0x${firstByte.toString(16)}，${w.bytes} B`)

  // ── B2 · ★★ **"我们装的技能旧了"必须被更新**（2026-09-14 / Round 47 实测的真 bug）──
  // 【缺陷现场】我把 `teamkit-escalate` 从 39 行改到 80 行，`sync-skills` 同步了仓内与包内，
  //   **但上游根那份仍是 39 行** —— 因为 `skills.overwrite:false` 时 `installSkill` 直接 `skipped-exists`。
  //   **真宿主里是新会话自己发现的**：
  //   > `skill` 工具加载到的是**上游根那份**（39 行）……**里面根本没有"撤人怎么撤"这一节**
  //   ⇒ **我前几轮"把知识写进技能"的努力，全部没到用户手上**（而没有任何报错）。
  // 【判据】三种落点各判一次（用真 `installSkill`）：
  //   ① 我们装的（有 `.teamkit`）+ 内容旧 ⇒ **`updated`**；
  //   ② 早期播种（**无标记**但 frontmatter 是 `teamkit*`）⇒ **`updated`**（否则永远更新不了）；
  //   ③ 真外来（无标记、内容不是我们的）⇒ **`skipped-foreign`**，绝不覆盖用户的东西。
  {
    const dstRoot = join(sb.base, 'b2dst')
    // ⚠️ **落点必须真在 `dstRoot` 下** —— 我第一版把预置写到了 `sb.base/b2/<name>`，
    //    而 `installSkill` 看的是 `dstRoot/<name>` ⇒ **每次都当"首次安装"**（`action=installed`，三断言全红）。
    //    **是断言装置写错了，不是代码错**（自测当场抓到）。
    const D = (name, body, marker) => {
      const dir = join(dstRoot, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
      if (marker) writeFileSync(join(dir, '.teamkit'), `teamkit:v1 ${name}\n`, 'utf8')
      return { name, file: join(dir, 'SKILL.md'), dir }
    }
    const SRC = (name, body) => {
      const dir = join(sb.base, 'b2src', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
      return { name, file: join(dir, 'SKILL.md') }
    }
    const OLD = '---\nname: teamkit-alpha\ndescription: old\n---\n\nOLD\n'
    const NEW = '---\nname: teamkit-alpha\ndescription: new\n---\n\nNEW\n'
    // ① 有标记 + 旧内容
    D('teamkit-alpha', OLD, true)
    const r1 = skills.installSkill(SRC('teamkit-alpha', NEW), dstRoot)
    CHECK('B2', r1.action === 'updated' && readFileSync(join(dstRoot, 'teamkit-alpha', 'SKILL.md'), 'utf8').includes('NEW'),
      '★★ **我们装的技能旧了 ⇒ 自动更新**（`action:"updated"`）—— 不再是静默 `skipped-exists`',
      '静默跳过 ⇒ **改了技能但用户永远读旧版，且没有任何报错**（真宿主实测：新会话读到的仍是 39 行旧版）',
      `action=${r1.action} why=${r1.why ?? '-'}`)
    // ② 早期播种：无标记，但 frontmatter 是 teamkit*
    D('teamkit-beta', OLD, false)
    const r2 = skills.installSkill(SRC('teamkit-beta', NEW), dstRoot)
    CHECK('B2', r2.action === 'updated' && existsSync(join(dstRoot, 'teamkit-beta', '.teamkit')),
      '★★ **早期播种（无 `.teamkit` 标记）也能被更新**（按 frontmatter 判定"这是我们自己的"，并补上标记）',
      '只认标记 ⇒ 早期装的那批**永远更新不了**（本机上游根 7 条全无标记，正是这个形态）',
      `action=${r2.action}`)
    // ③ 真外来：无标记 + 内容不是我们的
    D('my-own-skill', '---\nname: my-own-skill\ndescription: 用户自己的\n---\n\nMINE\n', false)
    const r3 = skills.installSkill(SRC('my-own-skill', NEW), dstRoot)
    CHECK('B2', r3.action === 'skipped-foreign' && readFileSync(join(dstRoot, 'my-own-skill', 'SKILL.md'), 'utf8').includes('MINE'),
      '★ **用户自己的同名技能，绝不覆盖**（`action:"skipped-foreign"`）——`overwrite:false` 的原意保住了',
      '误覆盖用户自己的技能 ⇒ 直接毁用户的东西（原设计就是为了防这个）',
      `action=${r3.action}`)
  }

  const underCross = (() => {
    // 跨盘安全判定：三条件缺一不可（LANDMINES §10 的实测坑）—— 这里用真 path 判 D: → E:
    const cross = relative('D:\\a', 'E:\\b')
    return { cross, isAbs: /^[A-Za-z]:|^\//.test(cross) }
  })()
  CHECK('B', underCross.isAbs,
    '`path.relative` 在**跨盘**时返回绝对路径（这正是"只判 `!startsWith(\'..\')`"会永远为真的根因）',
    '本机没复现跨盘行为（换平台会不同）', `relative(D:\\a, E:\\b) = ${JSON.stringify(underCross.cross)}`)

  // ═══ C · 上游：promote / rollback 全链路（硬门 + 写后回读）════════════
  section('C · 上游合并（说明是硬门 / 快照 / 回退 / 写后回读）')
  // ⚠️ 两个都得改道：
  //  · `skills.sourceDir` 的默认值是**本包自己的 skills/**（那是"装上就把自带方法技能同步到上游根"），
  //    不改道就会**往插件包里写测试数据** —— H 组的"单一事实来源"断言抓到过 `plugin/skills/demo` 真出现过；
  //  · `upstream.sources` 的默认值是 `<workspace>/skills`（**仓内源**，promote 的源）—— 它在沙盒里本来就对，
  //    但这里显式写出来，以免 `groupPaths` 的 workspace 推导一改就悄悄指错地方。
  const cpaths = groupPaths(cfg, sb, 'c', {
    skills: { sourceDir: join(sb.base, 'ws-c', 'bundled-skills') },
    upstream: { sources: [join(sb.base, 'ws-c', 'skills')] },
  })
  // 源：仓内源（= cpaths.upstream.sources[0]）
  const csrc = cpaths.upstream.sources[0]
  writeSkill(join(csrc, 'demo'), 'demo', { body: 'V2\n' })
  // 上游：先造"旧版"
  writeSkill(join(cpaths.upstream.root, 'demo'), 'demo', { body: 'V1\n' })

  const noNote = upstream.promote(cpaths, { all: true }, () => {})
  const wroteNothing = !existsSync(cpaths.changelogPath)
  CHECK('C', noNote.code === upstream.EXIT.NO_NOTE,
    '**没有 --note ⇒ 拒绝合并**（EXIT_NO_NOTE=2）', '缺说明还能合并 ⇒ 硬门失效', `code=${noNote.code}`)
  CHECK('C', wroteNothing, '被硬门拒绝时**一行都没写**（CHANGELOG 不存在）', '被拒绝却写了盘')
  const upTextAfterRefuse = readFileSync(join(cpaths.upstream.root, 'demo', 'SKILL.md'), 'utf8')
  CHECK('C', upTextAfterRefuse.includes('V1'), '被硬门拒绝时**上游没被改**（仍是 V1）', '被拒绝却改了上游')

  const dry = upstream.promote(cpaths, { all: true, note: 'dry-run 说明', dryRun: true }, () => {})
  const dryNoWrite = !existsSync(cpaths.changelogPath) && !existsSync(cpaths.historyDir)
  CHECK('C', dry.code === upstream.EXIT.OK && dryNoWrite,
    '--dry-run **零写盘**（无 CHANGELOG、无快照）', '--dry-run 写了盘', `code=${dry.code}`)

  const real = upstream.promote(cpaths, { all: true, note: '把 demo 从 V1 提到 V2' }, () => {})
  const upAfter = readFileSync(join(cpaths.upstream.root, 'demo', 'SKILL.md'), 'utf8')
  const chlog = existsSync(cpaths.changelogPath) ? readFileSync(cpaths.changelogPath, 'utf8') : ''
  CHECK('C', real.code === upstream.EXIT.OK, '带说明可合并', '带说明仍失败', `code=${real.code}`)
  CHECK('C', upAfter.includes('V2'), '合并后上游内容 = 源内容', '合并没生效')
  CHECK('C', chlog.includes('把 demo 从 V1 提到 V2'),
    'CHANGELOG 里**回读得到**刚写的说明（`promote-upstream.mjs:150` 的规矩）', '说明没落盘（= 工具白做）')

  const snapDirs = (() => {
    try {
      return readdirSafe(join(cpaths.historyDir, 'demo'))
    } catch {
      return []
    }
  })()
  const snapText = snapDirs.length > 0 ? readFileSync(join(cpaths.historyDir, 'demo', snapDirs[0], 'SKILL.md'), 'utf8') : ''
  CHECK('C', snapDirs.length === 1 && snapText.includes('V1'),
    '快照存的是**合并前的旧版**（V1）—— 成员之后能拿它跟新版 diff', '快照不是旧版 / 没生成快照',
    `snapshots=${snapDirs.join(',')}`)

  const rb = upstream.rollback(cpaths, 'demo', () => {})
  const upRolled = readFileSync(join(cpaths.upstream.root, 'demo', 'SKILL.md'), 'utf8')
  CHECK('C', rb.code === upstream.EXIT.OK && upRolled.includes('V1'),
    'rollback 回退到最近一次快照（V2 → V1）', 'rollback 没回退成功')

  const missingSkill = upstream.promote(cpaths, { skill: 'does-not-exist', note: 'x' }, () => {})
  CHECK('C', missingSkill.code !== upstream.EXIT.OK,
    '`--skill 不存在的名字` 会**报错**而不是静默成功', '不存在的技能被判成功 ⇒ 静默空转')

  // ── C3 · ★ **两个 promote 实现必须一致**（2026-09-14 / Round 22）─────────────────
  // 【背景】本仓**有两套**"合并上游"的实现：
  //   · A = `plugin/lib/upstream.js`（`teamkit promote` 用它）
  //   · B = `tools/promote-upstream.mjs`（AGENTS.md 里写的"上游更新的唯一入口"，独立脚本）
  //   两条路径都在写同一棵上游树。**上轮（Round 21）我只对齐了 `list` 的"显示"**，
  //   本轮把**真行为**也拉齐比一遍 —— 否则**它们迟早会给相反的结果，而且没人发现**
  //   （同族：Round 21「同一件事两条实现会漂」）。
  // 【判据】同一场景下：① 写入的上游内容**逐字节相同**；② **退出码语义一致**
  //   （无 `--note` 必须非 0；成功必须 0）。
  {
    const a3 = join(sb.base, 'c3-a')      // 给 A 用
    const b3 = join(sb.base, 'c3-b')      // 给 B 用
    for (const d of [a3, b3]) {
      mkdirSync(join(d, 'src', 'demo'), { recursive: true })
      mkdirSync(join(d, 'up'), { recursive: true })
      mkdirSync(join(d, 'home'), { recursive: true })
      writeFileSync(join(d, 'src', 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: 一致性对比\nd3\n---\nV1\n', 'utf8')
    }
    // A：库函数（已在 C 组建立的 `cpaths` 之外，另起一套干净沙盒）
    const apaths = groupPaths(cfg, sb, 'c3', {
      skills: { sourceDir: join(a3, 'src') },
      upstream: { root: join(a3, 'up'), sources: [join(a3, 'src')] },
      stateDir: join(a3, 'home', '.teamkit'),
    })
    const ra = upstream.promote(apaths, { all: true, note: '一致性：A' }, () => {})
    const wa = readFileSync(join(a3, 'up', 'demo', 'SKILL.md'), 'utf8')
    // B：真脚本（子进程）
    const runnerB = ['--input-type=module', '-e', 'process.exit(0)']
    void runnerB
    const rb = spawnSync(process.execPath, [
      join(PLUGIN_DIR, '..', 'tools', 'promote-upstream.mjs'),
      '--all', '--source', join(b3, 'src'), '--upstream', join(b3, 'up'),
      '--history', join(b3, 'home', 'hist'), '--changelog', join(b3, 'home', 'CHANGELOG.md'),
      '--note', '一致性：B',
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: join(b3, 'home') } })
    const wb = existsSync(join(b3, 'up', 'demo', 'SKILL.md'))
      ? readFileSync(join(b3, 'up', 'demo', 'SKILL.md'), 'utf8')
      : ''
    CHECK('C3', wa === wb && wa !== '',
      '★ **A（`lib/upstream.js`）与 B（`tools/promote-upstream.mjs`）写出的上游内容逐字节相同**',
      '两套实现写出的东西不一样 ⇒ 用哪个工具结果不同（"同一件事两条实现会漂"）',
      `A=${wa.length}B B=${wb.length}B same=${wa === wb}`)
    // ② 退出码语义一致：无 --note 必须都非 0
    const rcNoNoteA = upstream.promote(apaths, { all: true }, () => {}).code
    const rcNoNoteB = spawnSync(process.execPath, [
      join(PLUGIN_DIR, '..', 'tools', 'promote-upstream.mjs'),
      '--all', '--source', join(b3, 'src'), '--upstream', join(b3, 'up'),
      '--history', join(b3, 'home', 'hist'), '--changelog', join(b3, 'home', 'CHANGELOG.md'),
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: join(b3, 'home') } }).status
    CHECK('C3', rcNoNoteA !== 0 && rcNoNoteB !== 0 && rb.status === 0,
      '★ **退出码语义一致**：无 `--note` 两边都拒（非 0）；有 `--note` 两边都 0',
      '两边的"说明是硬门"判据不一致 ⇒ 脚本按退出码判断时会得到不同结论',
      `A(no-note)=${rcNoNoteA} B(no-note)=${rcNoNoteB} B(ok)=${rb.status}`)
  }

  // ═══ C2 · 真 CLI 端到端（子进程跑 `bin/teamkit.mjs`，不是直接拍函数）══════
  // 为什么单独一组：库函数级读数（C 组）**过不了"回执字节怎么渲染、退出码对不对、
  // `--help` 会不会写盘"** 这类事。我在沙盒里跑真 CLI 时抓到过一个只有这条链才会暴露的
  // 真 bug：`promote` 第一次运行时 CHANGELOG 的**父目录还不存在** ⇒ `ENOENT`
  // （库函数级的 C 组没覆盖到，因为它在调用前先建了别的目录）。⇒ 这一组保留。
  section('C2 · 真 CLI 端到端（子进程；含"父目录不存在"这个只在这条链上才露的坑）')
  const cliWs = join(sb.base, 'ws-c2')
  const cliHome = join(sb.base, 'home-c2')
  mkdirSync(cliWs, { recursive: true })
  mkdirSync(cliHome, { recursive: true })
  const cliEnv = { ...process.env, DSH_HOME: cliHome, DSH_TEAMKIT_WORKSPACE: cliWs }
  delete cliEnv.DSH_TEAMKIT_STATE
  /**
   * 跑真 CLI。**输出走文件、不走管道**：沙箱下 `child_process` 的 piped stdio 会 EPERM
   * （LANDMINES §6 的实测边界）。
   *
   * ⚠️ 实现上用**一个很小的中间脚本** `_cli-run.mjs` 去起真 CLI 并把 stdio 指到文件 ——
   * 不用 `node -e`（第一版那样写，`process.argv.slice(2)` 的偏移随 `--` 而定，
   * 我实测拿到的是 `node:internal/modules/cjs/loader` 的错，说明参数根本没传到 CLI）。
   * 中间脚本落盘在沙盒里，随沙盒一起删。
   */
  const runner = join(sb.base, '_cli-run.mjs')
  writeFileSync(runner, [
    "import { spawnSync } from 'node:child_process'",
    "import { openSync } from 'node:fs'",
    'const [cli, outFile, errFile, ...args] = process.argv.slice(2)',
    "const r = spawnSync(process.execPath, [cli, ...args], { stdio: ['ignore', openSync(outFile, 'w'), openSync(errFile, 'w')] })",
    'process.exit(r.status === null ? 1 : r.status)',
    '',
  ].join('\n'), 'utf8')

  const runCli = (args) => {
    const tag = Math.random().toString(36).slice(2, 8)
    const outFile = join(sb.base, `cli-out-${tag}.txt`)
    const errFile = join(sb.base, `cli-err-${tag}.txt`)
    const r = spawnSync(process.execPath, [runner, join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), outFile, errFile, ...args], {
      stdio: 'ignore',
      env: cliEnv,
      timeout: 60_000,
    })
    if (r.error !== undefined) return { code: -1, out: '', err: `spawn 失败：${r.error.code ?? r.error.message}` }
    const read = (f) => {
      try {
        return readFileSync(f, 'utf8')
      } catch {
        return ''
      }
    }
    return { code: r.status ?? -1, out: read(outFile), err: read(errFile) }
  }
  // ⚠️ **`SRC` 必须与"默认源"不同名**（2026-09-14 实测的教训）：
  //   默认源 = `<cliWs>/skills`；若 `SRC` 也取 `join(cliWs,'skills')`，那么
  //   **"`--source` 生效"与"`--source` 被忽略"两种情形下，`list` 打印的"源"那一行一模一样**
  //   ⇒ 下面那条回归断言**永远绿**（我自己变异验证时发现了：把修复回退掉它照样绿）。
  //   ⇒ 用 `<cliWs>/member-repo/skills`：**名字与默认源不同**，才能区分两种情形。
  const SRC = join(cliWs, 'member-repo', 'skills')
  const cliSrc = join(SRC, 'cli-demo')
  writeSkill(cliSrc, 'cli-demo', { body: 'V1' })

  const h = runCli(['help'])
  CHECK('C2', h.code === 0 || h.out.includes('用法'), '`teamkit help` 正常（且**不写盘**——见下面的残留断言）',
    'help 异常', `exit=${h.code}`)

  // ⚠️ 必须显式给 `--source`：CLI 是**离线**跑的（没有 profile ⇒ 配置只能来自 env/参数），
  //    不给就会对着**插件自带的 skills/** 干活（我第一版就是这么错的：`PROMOTE-OK entries=7`
  //    把插件自带那 7 条合了上去，而测试想合的 `cli-demo` 一条没动，**且不退错**）。
  //    ⇒ 这正是一个"静默错落点"，所以 `--source/--upstream/--state` 是 CLI 的必需件，不是附加项。
  //    （`SRC` 已在上面定义 —— 且**故意与默认源不同名**，理由见那里的注释。）
  const l = runCli(['list', '--source', SRC])
  CHECK('C2', l.code === 0 && l.out.includes('cli-demo'),
    '`teamkit list --source <仓内源>` 报出待合并的 `cli-demo`（真 CLI，非库调用）', 'list 没报出条目', `exit=${l.code}`)

  // ── C2-b · ★ **CLI 的上游要与 `promote-upstream.mjs` 同源**（2026-09-14 / Round 21 的缺口）──
  // 【缺口】同一件事、两个工具给两个答案：
  //   · `tools/promote-upstream.mjs` 自 Round 17 起**自动对齐**到"已安装预设的上游"；
  //   · `plugin/bin/teamkit.mjs` 的 `list` / `promote` **仍用离线默认 `$DSH_HOME/skills`**
  //     ⇒ 用户看 `teamkit list` 以为在跟 `$DSH_HOME/skills` 打交道，而 `omc` 成员根本不读那里。
  // 【修法】`cliOverrides()` 复用**同一个** `recoverFromInstalledPreset`（`lib/config.js`）。
  // 【本组判据】① **沙盒里没有预设 ⇒ 不许自动改**（否则会把测试装置带偏、也说明它没按证据走）；
  //             ② 显式 `--upstream` 优先（不许被自动覆盖）。
  {
    // ① 沙盒 `DSH_HOME` 下**没有** `.agent-presets` ⇒ 不该出现"自动对齐"那行
    const l2 = runCli(['list', '--source', SRC, '--upstream', join(sb.base, 'up-a')])
    CHECK('C2', !/自动对齐/.test(l2.out + l2.err),
      '★ 沙盒里没有"引用本包的预设" ⇒ **不自动对齐**（按证据走，不许无凭据地改目标）',
      '没有预设却报"已自动对齐" ⇒ 说明它没按证据走', `out含自动对齐=${/自动对齐/.test(l2.out + l2.err)}`)
    // ② 显式 --upstream 优先：显示的就是它给的那个
    // ⚠️ **必须匹配"上游 <路径>"那一行** —— 我第一版用 `includes('上游')` 抓到了**表头**
    //    `上游更新 · 待合并清单`（它先出现）⇒ 断言假红。**是我断言写松了，不是代码错**（自测自己抓到的）。
    const upB = join(sb.base, 'up-b')
    const l3 = runCli(['list', '--source', SRC, '--upstream', upB])
    const upLine = (l3.out.split('\n').find((x) => /^\s*上游\s+\S/.test(x)) ?? '').trim()
    CHECK('C2', upLine.includes('up-b'),
      '★ 显式 `--upstream` **优先**（不被"自动对齐"覆盖）',
      '自动对齐把用户显式给的目标改掉了 ⇒ 那比报错更糟', upLine || '(没有上游路径行)')
  }
  // ★ 新增（2026-09-14 的真 bug 回归）：**`list` 必须真把 `--source` 显示出来**。
  //   修前：`cliOverrides()` 只写了 `raw.skills.sourceDir`，而 `list()`/`sourceSkills()` 读的是
  //   **`paths.upstream.sources`** ⇒ 用户传 `--source` 被**静默忽略**、清单仍显示 `<workspace>/skills`。
  //   上面那条断言**查不出来**（它只看条目名，而默认源的条目名恰好也在）—— **所以必须查"源"那一行**。
  const lSrcLine = (l.out.split('\n').find((ln) => ln.includes('源')) ?? '').trim()
  CHECK('C2', lSrcLine.includes(SRC) || lSrcLine.includes(SRC.replace(/\\/g, '/')),
    '★ `list` 的“**源**”那一行**就是** `--source` 给的那个目录（不是默认的 `<workspace>/skills`）',
    '`--source` 被静默忽略 ⇒ 用户看错待合并清单、`promote` 也会去扫错目录',
    `源行: ${lSrcLine}`)

  const p0 = runCli(['promote', '--all', '--source', SRC])
  CHECK('C2', p0.code === 2, '`teamkit promote --all`（无 --note）⇒ **退出码 2**', '缺说明没被拒绝', `exit=${p0.code}`)

  const p1 = runCli(['promote', '--all', '--source', SRC, '--note', 'CLI 端到端：把 cli-demo V1 推到上游'])
  const upFile = join(cliHome, 'skills', 'cli-demo', 'SKILL.md')
  CHECK('C2', p1.code === 0, '`teamkit promote --all --source … --note "…"` 成功（**这条跑通了"父目录不存在"那个坑**）',
    'promote 失败 —— 看 stderr 是不是 ENOENT（父目录未建）', `exit=${p1.code} ${p1.err.split('\n')[0] ?? ''}`)
  CHECK('C2', existsSync(upFile) && readFileSync(upFile, 'utf8').includes('V1'),
    'promote 后**指定源那条**真写进了上游（内容 = 源）—— 而不是把插件自带的 7 条合上去',
    '上游文件没写出来 / 写错了对象', relative(cliHome, upFile))
  // ⚠️ task-57：落点从 `<workspace>/.teamkit` 改成 `<dshHome>/.teamkit`（`config.js` 的 stateDir
  // 默认值改了）⇒ 这条断言的**意图不变**（"首次 promote 会自己建 CHANGELOG 的父目录"，
  // 真 CLI 抓到的坑），但**路径要跟着新语义走**：CLI 的 DSH_HOME 是 `cliHome`（`:335-338`）。
  // 证据：修前日志 `PROMOTE-OK … changelog=…\home-c2\.teamkit\CHANGELOG.md`（功能是好的，只是断言路径过期）。
  CHECK('C2', existsSync(join(cliHome, '.teamkit', 'CHANGELOG.md')),
    '**首次 promote 会自己建 CHANGELOG 的父目录**（真 CLI 抓到的坑）', 'CHANGELOG 没落盘')

  // rollback 需要**至少两次** promote（第一次上游还不存在 ⇒ 没有"旧版"可快照）。
  // ⚠️ 这个细节我第一版写错过：CLI 组直接 rollback 拿到 exit=1，我差点当成 bug；
  //    核完是**行为正确**——"没有旧版可退"就该失败（而不是假装退成功了）。
  //    这里两条都断言：**首次 rollback 必须失败并说明原因**，**第二次之后 rollback 必须成功**。
  const noSnap = runCli(['rollback', 'cli-demo', '--source', SRC])
  CHECK('C2', noSnap.code === 1 && /没有快照/.test(noSnap.out + noSnap.err),
    '**首次 promote 后 rollback 会如实报"没有快照"**（没有旧版可退 ⇒ 不许假装成功）',
    '没有旧版却报成功 ⇒ 静默假成功', `exit=${noSnap.code}`)

  // 第二次 promote：改了源内容 ⇒ 上游侧被覆盖 ⇒ 这时才有"旧版"进快照
  // ⚠️ **必须写进 `SRC`**（= `cliSrc` 的根），不是 `<cliWs>/skills` ——
  //    `SRC` 改成 `member-repo/skills` 之后，写旧位置等于"源没变"⇒ 无需合并 ⇒ 第二次 promote 失败。
  writeSkill(cliSrc, 'cli-demo', { body: 'V2' })
  const p2 = runCli(['promote', '--all', '--source', SRC, '--note', 'CLI 端到端第 2 次：V1 → V2'])
  CHECK('C2', p2.code === 0, '第二次 promote 成功（此时上游已有旧版 ⇒ 会写快照）', '第二次 promote 失败', `exit=${p2.code}`)
  const rb1 = runCli(['rollback', 'cli-demo', '--source', SRC])
  const upAfterRb = existsSync(upFile) ? readFileSync(upFile, 'utf8') : ''
  CHECK('C2', rb1.code === 0 && upAfterRb.includes('V1'),
    '`teamkit rollback <skill>` 把上游退回**上一版**（V2 → V1，取最近一次快照）',
    'rollback 没退回去', `exit=${rb1.code} 内容=${upAfterRb.trim()}`)

  // ★ 这一条是本组的**核心价值**：CLI 不带 --source 时必须"对着仓内源指错"这件事**能被发现**
  //   （不许静默地去合插件自带的 7 条）
  const noSrc = runCli(['promote', '--all', '--note', '不该动任何东西'])
  const wrongTarget = existsSync(join(cliHome, 'skills', 'teamkit'))
  CHECK('C2', !wrongTarget,
    'CLI **不带 `--source` 时只会动它自己认可的默认源**（仓内源），不会去合**插件自带的 skills/**'
    + '—— 这条就是那个"静默错落点"的回归断言',
    '不带 --source 时把插件自带的 skills 合进了上游 ⇒ 用户会被静默地动错对象',
    `上游根里出现 teamkit/ ? ${wrongTarget}（exit=${noSrc.code}）`)

  // `--help` 绝不写盘（LANDMINES §7 的实况：一个生成器脚本因为不看参数就 rm -rf）
  const beforeHelp = existsSync(join(cliWs, '.teamkit'))
  const hw = runCli(['--help'])
  CHECK('C2', hw.code === 0 && beforeHelp === existsSync(join(cliWs, '.teamkit')),
    '`teamkit --help` **不写盘**（LANDMINES §7 的纪律：默认与 --help 绝不写）',
    '--help 写了盘', `exit=${hw.code}`)

  const stt = runCli(['status'])
  CHECK('C2', stt.code === 0 && stt.out.includes('guard') && stt.out.includes('非安全边界'),
    '`teamkit status` 把 guard 的诚实口径原样打出来（不美化）', 'status 输出缺诚实口径', `exit=${stt.code}`)

  const dc = runCli(['doctor'])
  CHECK('C2', dc.code === 0 && dc.out.includes('node'), '`teamkit doctor` 可用', 'doctor 失败', `exit=${dc.code}`)


  section('D · fork overlay（只存差异 / 上游更新自动流入）')
  // ⚠️ 同样把 sourceDir 改道（它会往上游根写 skills —— 不许写进插件包自己的 skills/）
  const dpaths = groupPaths(cfg, sb, 'd', { skills: { sourceDir: join(sb.base, 'ws-d', 'src-skills') } })
  const member = 'demo-member'
  const forkDir = cfg.forkRootFor(dpaths, member)
  mkdirSync(forkDir, { recursive: true })
  // 上游两条：`overridden`（fork 会覆盖它）/ `keep`（fork 不碰它）
  writeSkill(join(dpaths.upstream.root, 'overridden'), 'overridden', { body: 'UP-OVERRIDDEN-v1\n' })
  writeSkill(join(dpaths.upstream.root, 'keep'), 'keep', { body: 'UP-KEEP-v1\n' })
  // fork 里**只**放一条（= "只存差异"）
  writeSkill(join(forkDir, 'overridden'), 'overridden', { body: 'FORK-OVERRIDDEN-v1\n' })

  const provider = fork.makeForkProvider({ name: 'teamkit-fork', forkDir, rank: dpaths.fork.rank })
  const forkList = await provider.list()
  CHECK('D', forkList.length === 1 && forkList[0].name === 'overridden',
    'fork provider 的 list() **只报 fork 目录里的条**（不复制上游）', 'fork 复制了上游 ⇒ A-3 自动跟随会被毁',
    `fork 里 ${forkList.length} 条`)
  const cand = forkList[0]
  const shapeOk = typeof cand.name === 'string' && typeof cand.rank === 'number' && cand.provider === 'teamkit-fork'
    && cand.invocation?.modelInvocable === true && typeof cand.source === 'string' && typeof cand.locator === 'string'
  CHECK('D', shapeOk, 'fork 条目的形状满足 `dsh-skill:451-464 validateCandidate` 的六项要求',
    '形状不合规 ⇒ 真 DSH 会抛错并跳过整条 provider', JSON.stringify({ rank: cand.rank, provider: cand.provider, source: cand.source }))
  const got = await provider.get(cand)
  CHECK('D', got.name === cand.name && got.content.includes('FORK-OVERRIDDEN-v1'),
    'get() 返回 fork 自己的正文（且**不带 `resourceBase`** ⇒ 不把 fork 绝对路径递给模型）',
    'get() 正文不对或给了 resourceBase', `content ${got.content.length} 字，resourceBase=${got.resourceBase === undefined ? 'absent' : 'present'}`)

  // 模拟 dsh-skill 的合并语义（`collectFresh:298-311`：global → … → nearest，逐层 merged.set 覆盖）
  const fsProvider = {
    name: 'filesystem',
    async list() {
      return skills.scanRoot(dpaths.upstream.root).entries.map((e) => ({
        name: e.name, description: e.description, source: 'user-dsh', provider: 'filesystem', rank: 400,
        locator: e.file, path: e.file,
      }))
    },
    async get(c) {
      const text = readFileSync(c.locator, 'utf8')
      return { name: c.name, description: c.description, provider: 'filesystem', source: 'user-dsh', content: skills.parseSkill(text).body, path: c.locator }
    },
  }
  const merge = async () => {
    const merged = new Map()
    for (const layer of [fsProvider, provider]) {           // 上游层 → fork 层（越近越后写 ⇒ 覆盖）
      for (const e of await layer.list()) merged.set(e.name, { ...e, layer: layer.name })
    }
    return merged
  }
  const m1 = await merge()
  CHECK('D', m1.get('overridden')?.layer === 'teamkit-fork' && m1.get('keep')?.layer === 'filesystem',
    'overlay 语义：**同名条 fork 胜**、**fork 里没有的条仍来自上游**（A-1/A-2）',
    'overlay 语义不成立', `overridden→${m1.get('overridden')?.layer} / keep→${m1.get('keep')?.layer}`)

  // ★ 胜负手：改上游，fork 里没改的那条要跟着变；fork 改过的那条不变
  writeSkill(join(dpaths.upstream.root, 'keep'), 'keep', { body: 'UP-KEEP-v2\n' })
  writeSkill(join(dpaths.upstream.root, 'overridden'), 'overridden', { body: 'UP-OVERRIDDEN-v2\n' })
  const m2 = await merge()
  const keepGot = await fsProvider.get(m2.get('keep'))
  const overGot = await provider.get(m2.get('overridden'))
  CHECK('D', keepGot.content.includes('UP-KEEP-v2'),
    '★ **上游改了 ⇒ fork 里没改的条跟着变**（overlay 的承重假设 A-3）',
    'A-3 不成立 ⇒ 整套 fork/PR 就只是比喻', `keep = ${keepGot.content.trim()}`)
  CHECK('D', overGot.content.includes('FORK-OVERRIDDEN-v1'),
    '★ **上游改了 ⇒ fork 里改过的条不受影响**（fork 的独立性）',
    'fork 的覆盖被上游冲掉了', `overridden = ${overGot.content.trim()}`)

  // ═══ D2 · **真包**读数（升级 D 组：不用自造合并器，直接驱动真 `SkillRegistry`）═══
  section('D2 · 真 `dsh-skill` 注册表读数（独立子进程；拿不到就算 UNVERIFIED）')
  const probeOut = join(sb.base, 'real-registry.json')
  const probeRes = (() => {
    // ⚠️ 用 `--out <file>` 取结果，**不用管道捕获 stdout**：沙箱下 `child_process` 的
    //    piped stdio 会 EPERM（LANDMINES §6 的实测边界）。stdio 也显式 'ignore'。
    try {
      const r = spawnSync(process.execPath, [join(PLUGIN_DIR, 'scripts', 'probe-real-registry.mjs'), '--out', probeOut], {
        stdio: 'ignore',
        env: { ...process.env, ...sb.env },
        timeout: 60_000,
      })
      if (r.error !== undefined) return { state: 'unverified', why: `spawn 失败：${r.error.code ?? r.error.message}` }
      if (!existsSync(probeOut)) return { state: 'unverified', why: `子进程退出码 ${r.status}，但没有写结果文件（大概是找不到真包）` }
      const j = JSON.parse(readFileSync(probeOut, 'utf8'))
      return { state: 'ok', json: j }
    } catch (err) {
      return { state: 'unverified', why: err?.code === 'EPERM' ? 'EPERM（沙箱不给管道）' : (err?.message ?? String(err)) }
    }
  })()

  if (probeRes.state === 'unverified') {
    UNV('D2', '**真 `dsh-skill` 注册表**读数未获取（自造合并器那条已在上面的 D 组通过）',
      `${probeRes.why} ⇒ 要拿到读数：设 $DSH_PACKAGES 指向含 @deepseek-ai/dsh-skill 的 node_modules，或跑 \`node scripts/probe-real-registry.mjs\``)
  } else {
    const j = probeRes.json
    OK('D2', `真包读到读数（${j.packagesDir}）`, `子进程判定 ${j.verdict}`)
    for (const row of j.results) {
      if (row.state === 'PASS') OK('D2', row.msg, row.readout)
      else if (row.state === 'FAIL') BAD('D2', row.msg, row.readout)
      else UNV('D2', row.msg, row.readout)
    }
  }

  // ═══ E · 通知（只在不均变时推 / 只推该推的 / pending 补推）═════════════
  section('E · 上游更新通知（四件齐全 + 限流补推）')
  const epaths = groupPaths(cfg, sb, 'e', { skills: { sourceDir: join(sb.base, 'ws-e', 'src-skills') } })
  const eMember = 'notify-member'
  const eForkDir = cfg.forkRootFor(epaths, eMember)
  mkdirSync(eForkDir, { recursive: true })
  writeSkill(join(epaths.upstream.root, 'tracked'), 'tracked', { body: 'UP-v1\n' })
  writeSkill(join(epaths.upstream.root, 'untouched'), 'untouched', { body: 'UP-v1\n' })
  writeSkill(join(eForkDir, 'tracked'), 'tracked', { body: 'FORK-v1\n' })     // ← 持有覆盖 ⇒ 该推

  const notifier = notify.makeNotifier({ paths: epaths, member: eMember, tracked: 'auto', log: () => {} })
  notifier.baseline()
  const d0 = { kind: 'ok', messages: [] }
  const s1 = notifier.sweep(d0)
  CHECK('E', s1.messages.length === 0 && notifier.health().injected === 0,
    '**上游没变 ⇒ 一条都不注入**（成本命门）', '没变也注入 ⇒ 每步烧钱',
    `steps=${notifier.health().steps} injected=${notifier.health().injected}`)

  // ── E2 · ★ **fork-only 条目不许被当成"上游变了"**（2026-09-14 / Round 18 实测抓到的假通知）──
  // 【缺陷】`tracked` 在 `auto` 模式 = **fork 里有 SKILL.md 的条目**，而 `sweep` digest 的是**上游**文件。
  //   成员**自己在 fork 里新建一条**（上游从来没有它）时：`digestOf(不存在)='absent'`、
  //   `lastDigest.get()=undefined` ⇒ `'absent' !== undefined` ⇒ **误报 `UPSTREAM-CHANGED` 并真发通知**。
  //   【实测现场】`coo` 新建 `coo-probe`（72 B）后：
  //     `UPSTREAM-CHANGED member=coo skill=coo-probe from=(none) to=(absent) snapshot=(none) fork=true`
  //     `INJECT member=coo #1 … skill=coo-probe bytes=1519`
  //   【危害】通知语义是"**前辈更新了，你看要不要跟**" ⇒ 把它套到"我自己新建的"上，
  //     会**让成员去检查一个不存在的上游版本**。
  // 【判据】fork 里新增一条、**上游没有** ⇒ sweep **不得**注入任何通知。
  {
    const e2paths = groupPaths(cfg, sb, 'e2', { skills: { sourceDir: join(sb.base, 'ws-e2', 'src-skills') } })
    const e2Member = 'forkonly-member'
    const e2Fork = cfg.forkRootFor(e2paths, e2Member)
    mkdirSync(e2Fork, { recursive: true })
    // 上游 **没有** `my-new-skill`；fork 里**有**
    writeSkill(join(e2Fork, 'my-new-skill'), 'my-new-skill', { body: 'MINE-V1\n' })
    const n2 = notify.makeNotifier({ paths: e2paths, member: e2Member, tracked: 'auto', log: () => {} })
    n2.baseline()
    const s3 = n2.sweep({ kind: 'ok', messages: [] })
    CHECK('E2', s3.messages.length === 0 && n2.health().injected === 0,
      '★ **fork 里新建、上游没有的条目 ⇒ 不推通知**（"我自己新建的"不是"前辈更新了"）',
      '误把 fork-only 当成上游变更 ⇒ 给成员发无意义通知，并让它去找一个不存在的上游版本',
      `injected=${n2.health().injected}`)
    // ★★ **关键**：`baseline()` 会把"上游不存在"也记进 `lastDigest`（`'absent'`）
    //   ⇒ 上面那条**在 baseline 之后**永远看不出差异，**所以它并不能单独证明我的修复**（我第一版就没测住）。
    //   真正暴露缺陷的路径是：**成员在运行中途往 fork 里加一条** —— 那时 `baseline()` 已经跑过，
    //   新条目的 `lastDigest.get()` 是 `undefined`（**从未登记**），而 `digestOf(上游不存在)='absent'`
    //   ⇒ `'absent' !== undefined` ⇒ **误报**。这条才是判据。
    //   （现场就是这样：`coo` 是先有了 fork 目录、baseline 跑过，之后才新建 `coo-probe`。）
    writeSkill(join(e2Fork, 'added-mid-run'), 'added-mid-run', { body: 'MID-V1\n' })
    const s5 = n2.sweep({ kind: 'ok', messages: [] })
    CHECK('E2', s5.messages.length === 0 && n2.health().injected === 0,
      '★ **运行中途往 fork 加一条（上游从来没有它）⇒ 也不推通知**（这才是真缺陷路径：新条目不在 baseline 里）',
      '`lastDigest` 里没有它 + 上游不存在 ⇒ 误报 "absent ≠ undefined" ⇒ 发假通知（实测 coo 就是这样被误报的）',
      `injected=${n2.health().injected}`)
    // 反向：上游**真有**这条且变了 ⇒ 该推（别把上面那条修成"永不推"）
    writeSkill(join(e2paths.upstream.root, 'my-new-skill'), 'my-new-skill', { body: 'UP-LATER\n' })
    const s4 = n2.sweep({ kind: 'ok', messages: [] })
    CHECK('E2', s4.messages.length === 1,
      '★ 但**上游后来真有这条**（且与已知不同）⇒ 照常推（修完不是"永不推"）',
      '修过头 ⇒ 上游真的新增了同名条也不通知', `injected=${n2.health().injected}`)
  }

  // 改上游（**只改有覆盖的那条**），并按**新 digest** 写一条人写的更新说明
  // （落点深度 2 = `<skill>/CHANGELOG.md`，实测不污染扫描；放技能根会变成一条技能，LANDMARKS §18）
  writeSkill(join(epaths.upstream.root, 'tracked'), 'tracked', { body: 'UP-v2\n' })
  const newDigest = (await import('node:crypto')).createHash('sha1')
    .update(readFileSync(join(epaths.upstream.root, 'tracked', 'SKILL.md'))).digest('hex').slice(0, 8)
  writeFileSync(join(epaths.upstream.root, 'tracked', 'CHANGELOG.md'),
    `# CHANGELOG\n\n## ${newDigest}\n- **改了什么**：正文标记 v1 → v2\n- **为什么**：自测要验"说明能进通知"\n`, 'utf8')

  const s2 = notifier.sweep(d0)
  CHECK('E', s2.messages.length === 1 && notifier.health().injected === 1,
    '上游变了 ⇒ 注入 1 条（搭车形态：只多一条 message，不触发额外轮次）', '变了却没注入',
    `injected=${notifier.health().injected}`)
  const notice = s2.messages[0]?.content?.[0]?.text ?? ''
  const fourSections = ['① 这次主要改了什么', '② 改后正文', '③ 可比的三侧', '④ 你可以怎么用'].every((k) => notice.includes(k))
  // 只数 **④ 节**里的菜单项（否则 CHANGELOG 正文里的 `- **…**` 会被误计 —— 第一版就是这样虚高的）
  const menuBlock = notice.split('④ 你可以怎么用')[1] ?? ''
  const actionCount = (menuBlock.match(/^- \*\*/gm) ?? []).length
  CHECK('E', fourSections, '通知含**四节**（说明 / 改后内容 / 可比两侧 / 动作菜单）', '通知缺节', `chars=${notice.length}`)
  CHECK('E', notice.includes('部分采纳') && actionCount >= 4,
    '**动作菜单 ≥4 项且含"部分采纳"**（P-22 否掉的正是"删掉/保留"二选一）',
    '动作集退化成二选一', `菜单 ${actionCount} 项`)
  CHECK('E', notice.includes('改了什么') && notice.includes('正文标记 v1 → v2'),
    '**人写的更新说明进了通知**（按 digest8 从 `<skill>/CHANGELOG.md` 取到）',
    '说明没进通知 ⇒ 复现 P-22 否掉的"只有 digest、没有说明"',
    `changelogFound=true / 说明正文在通知里`)
  CHECK('E', notice.includes('diff') && notice.includes('结论由你得出'),
    '通知给的是**路径 + 让他自己 diff**，不把结论喂给他', '通知里直接把结论喂了')
  CHECK('E', notice.includes(newDigest), '通知带新 digest（可追溯）', '通知没带 digest')

  // 诚实的另一半：**没有说明时不许假装有**（task-46 §B.2 的两次实测读数）
  //   ⇒ 用第二条技能制造"上游变了但 CHANGELOG 里没有这一版"
  writeSkill(join(eForkDir, 'nodesc'), 'nodesc', { body: 'FORK-nodesc\n' })
  writeSkill(join(epaths.upstream.root, 'nodesc'), 'nodesc', { body: 'UP-nodesc-v1\n' })
  const n3 = notify.makeNotifier({ paths: epaths, member: eMember, tracked: 'auto', log: () => {} })
  n3.baseline()
  writeSkill(join(epaths.upstream.root, 'nodesc'), 'nodesc', { body: 'UP-nodesc-v2\n' })
  const s2b = n3.sweep(d0)
  const nodescNotice = s2b.messages.map((m) => m.content[0].text).find((t) => t.includes('nodesc')) ?? ''
  CHECK('E', nodescNotice.includes('本次更新没有说明'),
    '**没有说明时明说"本次没有说明"**（不假装有、也不静默省略）',
    '缺说明时静默了 ⇒ 读者会以为改动很小（task-46 §B.2 的诚实口径）',
    nodescNotice.includes('本次更新没有说明') ? '已明说' : '(没找到该条通知)')

  // 只改**没有覆盖**的那条 ⇒ 不该推（P-21 受众收窄）
  writeSkill(join(epaths.upstream.root, 'untouched'), 'untouched', { body: 'UP-v2\n' })
  const before = notifier.health().injected
  const s3 = notifier.sweep(d0)
  CHECK('E', notifier.health().injected === before && s3.messages.length === 0,
    '`untouched` 变了但**该成员没有覆盖它 ⇒ 不推**（没改过的人自动跟随，通知对他没有可执行动作）',
    '推了不该推的 ⇒ 通知量爆炸', `injected 仍为 ${notifier.health().injected}`)

  // ★ 限流 → pending → 补推（task-45 的永久丢失缺陷，这里断言修好）
  //     用一个**新的成员**（新的 fork 目录）来跑，避免与上面那次注入的 `lastNotified` 搅在一起
  const nMember = 'notify-limited-member'
  const nForkDir = cfg.forkRootFor(epaths, nMember)
  mkdirSync(nForkDir, { recursive: true })
  writeSkill(join(nForkDir, 'tracked'), 'tracked', { body: 'FORK-v1\n' })
  const n2 = notify.makeNotifier({ paths: epaths, member: nMember, tracked: 'auto', log: () => {} })
  n2.baseline()
  writeSkill(join(epaths.upstream.root, 'tracked'), 'tracked', { body: 'UP-v3\n' })
  const lim1 = n2.sweep(d0)                                // 第一次：窗口外（lastNotifiedAt=0）⇒ 直接推
  writeSkill(join(epaths.upstream.root, 'tracked'), 'tracked', { body: 'UP-v4\n' })
  const lim2 = n2.sweep(d0)                                // 第二次：窗口内 ⇒ 入 pending
  const h2 = n2.health()
  CHECK('E', lim1.messages.length === 1 && lim2.messages.length === 0 && h2.pending === 1,
    '限流窗口内的更新**入 pending 队列**（而不是丢掉）', '限流把通知吃掉了',
    `r1=${lim1.messages.length} r2=${lim2.messages.length} pending=${h2.pending}`)
  // 把窗口打开（模拟时间流逝）后**必须补推** —— 关键：补推要发生在"没变更就早退"之前
  const originalNow = Date.now
  Date.now = () => originalNow() + 120_000
  const lim3 = n2.sweep(d0)
  Date.now = originalNow
  CHECK('E', lim3.messages.length === 1 && lim3.messages[0].content[0].text.includes('UP-v4'),
    '★ 窗口过后**补推成功**（`PENDING-FLUSH → INJECT`）—— task-45 的"永久丢通知"已修好',
    'pending 永远不被消费 ⇒ 复现 task-45 缺陷',
    `补推 ${lim3.messages.length} 条，pending 剩 ${n2.health().pending}`)

  // ═══ F · 护栏（**误操作护栏**，纯函数判定 + 跨盘包含）═════════════════
  section('F · A 层误操作护栏（纯函数判定，默认关）')
  const protectedRoots = [{ id: 'upstream', base: join(sb.base, 'up-root') }]
  const target = join(sb.base, 'up-root', 'x', 'SKILL.md')
  const outsidePath = join(sb.base, 'elsewhere', 'y.txt')
  const cases = [
    ['非 write/edit 工具', guard.decide({ toolName: 'read', target, identity: { member: true, role: 'teammate', name: 'w' }, protectedRoots }), undefined],
    ['受保护根之外', guard.decide({ toolName: 'write', target: outsidePath, identity: { member: true, role: 'teammate', name: 'w' }, protectedRoots }), undefined],
    ['非本 Team 成员', guard.decide({ toolName: 'write', target, identity: { member: false }, protectedRoots }), undefined],
    ['Lead 恒允许', guard.decide({ toolName: 'write', target, identity: { member: true, role: 'lead', name: 'lead' }, protectedRoots }), undefined],
    ['白名单成员允许', guard.decide({ toolName: 'write', target, identity: { member: true, role: 'teammate', name: 'w' }, protectedRoots, config: { writers: ['w'] } }), undefined],
  ]
  let casesOk = 0
  for (const [label, gotReason, want] of cases) {
    if (gotReason === want) casesOk += 1
    else BAD('F', `放宽分支错了：${label}`, `期望 ${want}，得到 ${gotReason}`)
  }
  OK('F', `五个"放行"分支全部正确（非写工具 / 根外 / 非成员 / Lead / 白名单）`, `${casesOk}/${cases.length}`)
  const denied = guard.decide({ toolName: 'write', target, identity: { member: true, role: 'teammate', name: 'w' }, protectedRoots })
  CHECK('F', typeof denied === 'string' && denied.includes('误操作护栏'),
    '**拒绝分支**给出 reason，且文案里明说"误操作护栏，不是安全边界"',
    '拒绝分支没给 reason / 口径写成"写保护"', String(denied).slice(0, 60) + '…')
  CHECK('F', denied.includes('pwsh') && denied.includes('shell'),
    '拒绝文案**自带绕过说明**（覆盖 write/edit 两个工具名，shell 绕得过）—— P-15 的诚实口径',
    '文案没写绕过面 ⇒ 会被人当安全边界用')

  const winUnder = (() => {
    // 真 path 上的跨盘读数（本机是 Windows ⇒ 这条是真读数，不是模拟）
    const cross = relative('D:\\a', 'E:\\b')
    const insideRel = relative('D:\\a', 'D:\\a\\b')
    const self = relative('D:\\a', 'D:\\a')
    return { cross, crossIsAbs: /^[A-Za-z]:/.test(cross), insideRel, self }
  })()
  const guardUnderCross = guard.under('D:\\a', 'E:\\b') === false
  const guardUnderInside = guard.under('D:\\a', 'D:\\a\\b') === true
  const guardUnderSelf = guard.under('D:\\a', 'D:\\a') === false
  CHECK('F', guardUnderCross && guardUnderInside && guardUnderSelf,
    '`under()` 跨盘安全：跨盘=false / 真子路径=true / 自己=false（LANDMINES §10 的坑）',
    '跨盘包含判定不对 ⇒ 会把工作区路径全判成受保护',
    `relative(D:\\a,E:\\b)='${winUnder.cross}'（是绝对路径:${winUnder.crossIsAbs}）`)

  // 药停文件（逃生路 E2）
  const disableFile = join(sb.base, 'DISABLE')
  const envBackup = process.env.DSH_TEAMKIT_DISABLE
  process.env.DSH_TEAMKIT_DISABLE = disableFile
  const offBefore = guard.disabledNow()
  writeFileSync(disableFile, '', 'utf8')
  const offAfter = guard.disabledNow()
  if (envBackup === undefined) delete process.env.DSH_TEAMKIT_DISABLE
  else process.env.DSH_TEAMKIT_DISABLE = envBackup
  CHECK('F', offBefore === false && offAfter === true,
    '药停文件（`$DSH_TEAMKIT_DISABLE`）建文件即生效 ⇒ 逃生路可用', '药停路不生效 ⇒ 可能把自己锁死')

  const gdesc = guard.describe({ ...paths, guard: { ...paths.guard, enabled: true } })
  CHECK('F', gdesc.honesty.includes('非安全边界') && gdesc.bypassableBy.includes('pwsh'),
    '`guard.describe()` 的返回里带诚实口径 + 绕过面（供 `--status` 原样打印，不许被美化）',
    'status 会误导用户', `honesty=${gdesc.honesty} / bypassableBy=${gdesc.bypassableBy.length} 项`)

  // ═══ G · 插件入口 apply/dispose（假 ctx，不需要真 DSH）════════════════
  section('G · 插件入口 apply / dispose（假 ctx）')
  const gws = join(sb.base, 'ws-g')
  const genv = { ...sb.env }
  delete genv.DSH_TEAMKIT_WORKSPACE
  const gpaths = cfg.resolveAll({}, { pluginDir: PLUGIN_DIR, env: genv, cwd: gws })
  const hooks = []
  const providers = []
  const guards = []
  let disposed = 0
  const fakeAgentCtx = {
    on: (ev, fn) => {
      const rec = { ev, fn }
      hooks.push(rec)
      return () => { rec.off = true }
    },
    get: (name) => {
      if (name === 'skills') return { registerProvider: (create) => { providers.push(create); return () => { providers.pop() } } }
      if (name === 'agentTeams') return { tryMembership: () => ({ role: 'teammate', name: 'fake-member' }) }
      return undefined
    },
  }
  const fakeAgent = { id: 'fake-agent-1', ctx: fakeAgentCtx }
  const rootCtx = {
    on: (ev, fn) => {
      hooks.push({ ev, fn, root: true })
      return () => {}
    },
    get: (name) => {
      if (name === 'agents') return { list: () => [] }
      if (name === 'skills') return { registerProvider: () => () => {} }
      if (name === 'agentTeams') return { tryMembership: () => undefined }
      if (name === 'tools') return { guard: (fn) => { guards.push(fn); return () => { guards.pop() } } }
      return undefined
    },
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') rootCtx._disposers.push(d)
      return () => {}
    },
    _disposers: [],
  }
  // 自带 skills：临时造一个源目录（**不依赖仓内 skills/ 是否存在**，但若存在则用它做真读数）
  const gsrcRoot = join(gws, 'src-skills')
  writeSkill(join(gsrcRoot, 'teamkit-demo'), 'teamkit-demo')
  const handle = (() => {
    try {
      return entry.apply(rootCtx, { workspace: gws, skills: { sourceDir: gsrcRoot } }, { env: genv, cwd: gws })
    } catch (err) {
      BAD('G', 'apply() 抛错 ⇒ 会连累整个 profile 加载', err?.stack?.split('\n')[0])
      return undefined
    }
  })()
  CHECK('G', handle !== undefined, '`apply()` 在假 ctx 上**不抛**并返回句柄', 'apply() 抛错')
  const installedToUpstream = existsSync(join(gpaths.upstream.root, 'teamkit-demo', 'SKILL.md'))
  CHECK('G', installedToUpstream, 'apply() 把自带 skills 装到**配置里的上游根**（默认效果①）', '自带 skills 没装上')
  const createdHook = hooks.find((h) => h.ev === 'agent/created')
  CHECK('G', createdHook !== undefined, '在 `agent/created` 上挂了钩子（唯一能赶上第一个提示词的窗口）', '没挂 agent/created')

  // 走一遍 create：fork provider + 通知监听器都要装上
  const errorsBefore = report.fail
  try {
    createdHook.fn({ agent: fakeAgent })
  } catch (err) {
    BAD('G', 'agent/created 监听器抛错 ⇒ 按 DSH 语义会**否决 agent 发布**（实证：必须整体 try/catch）', err?.message)
  }
  const forkDirThis = cfg.forkRootFor(gpaths, 'fake-member')
  CHECK('G', report.fail === errorsBefore, '`agent/created` 监听器**不向外抛**（同步 emit，抛错会否决 agent 发布）', '监听器抛出了')
  CHECK('G', providers.length === 1 && existsSync(forkDirThis),
    '`agent/created` 时给该成员注册了 fork provider 并建了 fork 目录（默认效果②）', 'fork 没装上',
    `providers=${providers.length} dir=${relative(sb.base, forkDirThis)}`)
  const preStepHook = hooks.find((h) => h.ev === 'agent/pre-step')
  CHECK('G', preStepHook !== undefined, '在该 agent 自己的 ctx 上挂了 `agent/pre-step`（scope-filtered ⇒ 装给谁就推给谁）', '没挂 pre-step')

  // dispose：所有 disposer 都要跑掉（"可卸净"）
  for (const d of rootCtx._disposers) {
    try {
      d()
      disposed += 1
    } catch (err) {
      BAD('G', 'dispose 抛错', err?.message)
    }
  }
  CHECK('G', disposed >= 1, '卸载时 `ctx.effect` 的 disposer 全部执行（可卸净的第 1 半）', 'dispose 没跑', `执行了 ${disposed} 个`)
  CHECK('G', providers.length === 0,
    '卸载后 fork provider 的 disposer 被清空（可卸净的第 2 半）', 'provider 卸载后仍在', `providers=${providers.length}`)

  // G-附加：零裸 import（开源用户装上去不会因为缺依赖而 exit=1）
  const badImports = []
  for (const f of ['index.js', 'config.js', 'skills.js', 'fork.js', 'notify.js', 'upstream.js', 'guard.js', 'log.js']) {
    const text = readFileSync(join(PLUGIN_DIR, 'lib', f), 'utf8')
    const re = /(?:from|import)\s+['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(text)) !== null) {
      const spec = m[1]
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
      badImports.push(`${f}: ${spec}`)
    }
  }
  CHECK('G', badImports.length === 0,
    'lib/** 里**零裸 import**（运行时注入的插件目录没有 node_modules ⇒ 裸 import 会让每个会话 exit=1）',
    '存在裸 import', badImports.join(' | ') || '全部是 node: 或相对路径')

  // ═══ G2 · 公司层 roles.js（角色档 → 招募时装技能 provider + 人格）══════════
  // 这一组回答的目标问题：「**能够组建成一人公司的团队**」缺的那一层。
  // 判据来自 `talents/_SPEC.md`：禁字段必须**拒绝**（不是忽略）、缺档必须**报出来**（不是静默）、
  // 空角色技能目录是**合法空**（不是失败）。
  section('G2 · 公司层：角色档（Talent）→ 招募装配')
  const rolesDir = join(sb.base, 'ws-g2-roles')
  mkdirSync(rolesDir, { recursive: true })

  // ⓪ ★★ **两个封闭枚举真的被当枚举管**（2026-09-14 / Round 71）────────────────────
  // 【缺陷现场】`_SPEC.md` 把 `role`（六个封闭值）与 `gate_policy`（`review`/`strict`）都写成了**封闭取值**，
  //   而 `validateRole` **只校验了 `level`、漏了这两个** ⇒ 负对照实测：
  //     `role:'wizard'` ⇒ `ok=true`（放行！）
  //     `gate_policy:'maybe'` ⇒ `ok=true`
  //   ⇒ 这正是本项目反复出现的那一格：**"spec 里写了枚举" ≠ "校验器真的当枚举管"**
  //     （同族：`LANDMINES §9` 字段存在 ≠ 值正确 / R19 `tools` 字段零效果 / R55 "写了 ≠ 用户读得到"）。
  // 【补枚举时当场又抓到一件】7 份真角色档里 `marketer` 用的是 `role:'marketing'`，
  //   而 `_SPEC.md` 枚举里**没有 `marketing`、却有个没人用的 `execution`**
  //   ⇒ **枚举写错的是 spec**（7 份档 + Market 索引三方一致用 `marketing`）
  //   ⇒ 处置：**把 `marketing` 加进枚举并修 `_SPEC.md`** —— **不是放宽校验**
  //     （放宽会让 `wizard` 那种真错也漏过去）。
  {
    const base = {
      name: 'g2-enum-probe', role: 'engineering', level: 'ic', description: 'd',
      skills: ['a'], tools: ['read'], write_scope: 'w', gate_policy: 'review',
      acceptance_style: 's', onboarding: 'o',
    }
    const bad1 = roles.validateRole({ ...base, role: 'wizard' })
    CHECK('G2', bad1.ok === false && /不在/.test(String(bad1.why)),
      '★★ **非法 `role` 被拒**（`wizard` ⇒ `ok:false`）—— `_SPEC.md:13` 是**封闭枚举**',
      '不校验 ⇒ 任何 role 字符串都放行 ⇒ 角色档"看起来合规"但语义是垃圾（R71 负对照实测放行过）',
      `ok=${bad1.ok} why=${String(bad1.why).slice(0, 60)}`)
    const bad2 = roles.validateRole({ ...base, gate_policy: 'maybe' })
    CHECK('G2', bad2.ok === false && /不在/.test(String(bad2.why)),
      '★★ **非法 `gate_policy` 被拒**（`maybe` ⇒ `ok:false`）—— 只允许 `review` / `strict`',
      '不校验 ⇒ 写 `gate_policy:"maybe"` 也当合规；而它决定"这道门严不严"（`_SPEC.md:19`）',
      `ok=${bad2.ok} why=${String(bad2.why).slice(0, 60)}`)
    // 正对照：**真实在用的**那些取值都要放行（尤其 `marketing` —— 它是那次不一致的那一个）
    const okVals = ['research', 'engineering', 'writing', 'review', 'coordination', 'marketing', 'execution']
    const rejected = okVals.filter((r) => roles.validateRole({ ...base, role: r }).ok !== true)
    CHECK('G2', rejected.length === 0,
      '★ 且**枚举里那七个 `role` 取值全部放行**（含真在用的 `marketing`）',
      '枚举与真实数据不一致 ⇒ 真角色档会被误拒（R71 补枚举时当场抓到 `marketing` 这处不一致）',
      rejected.length === 0 ? `${okVals.length} 个取值全放行 ✓` : `**误拒：${rejected.join(', ')}**`)
    // ★★ **`name` 必须是 lower-kebab-case**（2026-09-14 / Round 72 收紧）──────────────
    // 【缺陷现场】原判据 `[A-Za-z0-9_-]+` **放过大写/下划线/连续短横**，而 `_SPEC.md:12` 明写 "**kebab-case**"；
    //   底座原话：*"teammate name must be **lower-kebab-case**, at most 64 characters, and not \"lead\""*。
    //   ⇒ 负对照实测：`Engineer_1` / `a_b` / `lead` / 65 字符 **四条全被放行** ⇒
    //     **招人的时候才炸**（比读档时炸更晚、更难定位）。
    {
      const badNames = ['Engineer_1', 'a_b', 'lead', 'a'.repeat(65), '-eng', 'eng-', 'en--g', '']
      const leaked = badNames.filter((n) => roles.validateRole({ ...base, name: n }).ok === true)
      CHECK('G2', leaked.length === 0,
        '★★ **非法成员名被拒**（大写 / 下划线 / `lead` / >64 / 首尾短横 / 连续短横 / 空）',
        '不校验 ⇒ **招人时才炸**（底座要 lower-kebab-case，且明确拒绝 `lead`）—— 错得更晚更难定位',
        leaked.length === 0 ? `${badNames.length} 种非法名全部拒绝 ✓` : `**放行：${JSON.stringify(leaked)}**`)
      const goodNames = ['eng-lead-1', 'a', 'a1-b2-c3']
      const wrong = goodNames.filter((n) => roles.validateRole({ ...base, name: n }).ok !== true)
      CHECK('G2', wrong.length === 0,
        '★ 且**合法 kebab 名全部放行**',
        '收紧过头 ⇒ 真角色档被误拒（R71 `marketing` 那种"枚举/规则比数据更严"的反向坑）',
        wrong.length === 0 ? `${goodNames.length} 个合法名全放行 ✓` : `**误拒：${wrong.join(', ')}**`)
    }
    // ★★ **`name` 必须等于文件名**（`_SPEC.md:12`；2026-09-14 / Round 72 补）──────────
    // 【缺陷现场】这条规定写在 spec 里很久，而 `loadRoles` **从来没查过** ⇒
    //   负对照：`x.json` 里写 `name:'y'` ⇒ **被放行**（`name → 角色档` 是按名字查的，两边不一致就找不到）。
    {
      const probeDir = join(sb.base, 'ws-g2-namefile')
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(
        join(probeDir, 'actual-name.json'),
        JSON.stringify({ ...base, name: 'different-name' }, null, 2),
        'utf8',
      )
      const loadedNF = roles.loadRoles(probeDir, () => {})
      const skipped = loadedNF.skipped.find((s) => /必须等于文件名/.test(String(s.why)))
      CHECK('G2', loadedNF.roles.size === 0 && skipped !== undefined,
        '★★ **`name` 与文件名不一致 ⇒ 被拒且说明原因**（`_SPEC.md:12`）',
        '不查 ⇒ `TALENTS.yml` 按 name 过滤找不到它 + 排查时"文件叫 x、里面写 y"极易误导（R42 同族）',
        skipped === undefined ? '**没查出来（放行了）**' : '已拒 ✓')
    }
  }

  // ① 一份**合规**角色档
  const goodRole = {
    name: 'g2-engineer', role: 'engineering', level: 'ic', description: '实现者：按判据写出来并自测。',
    skills: ['实现'], tools: ['read', 'write'], write_scope: 'src/**', gate_policy: 'review',
    acceptance_style: '跑一遍能跑的那部分，把原始读数贴出来', onboarding: '先读任务卡',
  }
  writeFileSync(join(rolesDir, 'g2-engineer.json'), JSON.stringify(goodRole, null, 2), 'utf8')
  const loaded1 = roles.loadRoles(rolesDir, () => {})
  CHECK('G2', loaded1.readable === true && loaded1.roles.size === 1 && loaded1.skipped.length === 0,
    '读得到角色档目录、7 类字段全的档**通过校验**', '合规档被拒了 ⇒ 角色层不可用',
    `readable=${loaded1.readable} roles=${loaded1.roles.size} skipped=${loaded1.skipped.length}`)

  // ② **禁字段必须拒绝**（`_SPEC.md:24`：DSH 不承载 model/provider/temperature，写进来就是骗人的声明）
  writeFileSync(join(rolesDir, 'g2-forbidden.json'),
    JSON.stringify({ ...goodRole, name: 'g2-forbidden', llm_model: 'x', temperature: 0.7 }), 'utf8')
  const loaded2 = roles.loadRoles(rolesDir, () => {})
  const forb = loaded2.skipped.find((s) => s.file.endsWith('g2-forbidden.json'))
  CHECK('G2', forb !== undefined && /禁字段/.test(forb.why) && loaded2.roles.has('g2-forbidden') === false,
    '**含禁字段的角色档被拒绝**（且未进 roles）—— `_SPEC.md:24` 的"别绑后端"是硬门不是建议',
    '禁字段被放进了角色层 ⇒ 用户会以为模型/温度真的生效', forb?.why ?? '(没被拒)')

  // ③ **缺字段必须报出来**，不静默
  writeFileSync(join(rolesDir, 'g2-missing.json'), JSON.stringify({ name: 'g2-missing', level: 'ic' }), 'utf8')
  const loaded3 = roles.loadRoles(rolesDir, () => {})
  const miss = loaded3.skipped.find((s) => s.file.endsWith('g2-missing.json'))
  CHECK('G2', miss !== undefined && /缺必填字段/.test(miss.why),
    '缺必填字段的档**被拒且给原因**（不静默跳过 —— LANDMINES §9 同族）', '坏档被静默忽略', miss?.why ?? '(没被拒)')

  // ④ **读不到目录 ≠ 空成功**（三态：unreadable 必须能被区分）
  const loadedMissing = roles.loadRoles(join(sb.base, 'nope-does-not-exist'), () => {})
  CHECK('G2', loadedMissing.readable === false && loadedMissing.skipped.length > 0,
    '角色档目录**读不到时 readable=false**（不是"零角色 = 成功"）—— 与 verify-handoff 的三态同规矩',
    '读不到被判成"没有角色" ⇒ 静默不生效', `readable=${loadedMissing.readable}`)

  // ⑤ `installRoleFor`：注册 provider；且**失败不许外抛**（`agent/created` 是同步 emit）
  const g2registered = []
  const g2agent = {
    id: 'g2-agent',
    ctx: {
      get: (n) => (n === 'skills'
        ? { registerProvider: (create) => { g2registered.push(create()); return () => { g2registered.pop() } } }
        : (n === 'agentTeams' ? { tryMembership: () => ({ role: 'teammate', name: 'g2-engineer' }) } : undefined)),
    },
  }
  const inst = roles.installRoleFor(g2agent, roles.roleFor(loaded1.roles, 'g2-engineer'), { rolesDirBase: rolesDir })
  CHECK('G2', inst.ok === true && g2registered.length === 1 && g2registered[0].name === 'teamkit-role-g2-engineer',
    '`installRoleFor` 给该 agent 注册了**以角色命名的 skill provider**（招募即装身份）',
    '角色身份没装上', JSON.stringify({ ok: inst.ok, provider: inst.provider, why: inst.why }))

  // ⑥ 空角色技能目录 = **合法空**（不是失败）
  const g2list = await g2registered[0].list()
  CHECK('G2', Array.isArray(g2list) && g2list.length === 0,
    '角色**没有技能文件**时 catalog 是空数组 —— 合法（角色档可以只带人格），不是错误',
    '空目录被当失败', `list().length=${g2list.length}`)

  // ⑦c ★★ 真 `SkillRegistry` 契约（**这条才是有鉴别力的那条**）
  //   为什么必须加：G2 原先只断言"`registerProvider` 成功 / 失败不外抛"——
  //   而**`registerProvider` 成功不代表条目可用**。Lead 第一版 `roles.js` 的 `list()` 只返回
  //   `{name,description,body,file}`，`registerProvider` 照样成功，但**注册表在校验时会抛**
  //   （`dsh-skill:452-464 validateCandidate` 要求 `invocation/source/rank/provider`，
  //    且 `provider` 必须 === 注册名；调用点 `:360` 在 `provider.list()` 的 try/catch 之外）。
  //   ⇒ **现场读数（`upstream-keeper` 报、Lead 自跑复现）**：
  //     `TypeError: skill provider "teamkit-role-engineer" returned skill "…" with a non-string source`
  //   这条断言把"注册成功"升级为"**条目真的过注册表校验**"——用**真** `SkillRegistry`，不用模拟。
  const g2RoleSkills = join(rolesDir, 'g2-engineer', 'skills')
  mkdirSync(join(g2RoleSkills, 'g2-role-demo'), { recursive: true })
  writeFileSync(
    join(g2RoleSkills, 'g2-role-demo', 'SKILL.md'),
    '---\nname: g2-role-demo\ndescription: G2 角色技能契约断言用条目\n---\n\n正文\n',
    'utf8',
  )
  let g2regOk = false
  let g2regDetail = '(未跑)'
  let g2regUnverified = false
  try {
    // 真包定位：照 `scripts/probe-real-registry.mjs:67-84` 的**候选列表**逻辑（LANDMINES §4：不要单一算法）。
    // 找不到 ⇒ **UNVERIFIED**（不是 FAIL）—— 与 D2 组同一套三态纪律。
    const pkgRoot = findRealPackagesRoot()
    if (pkgRoot === undefined) {
      g2regUnverified = true
      g2regDetail = '找不到真 @deepseek-ai/dsh-skill ⇒ 本条判 UNVERIFIED（给 $DSH_PACKAGES 可拿到读数）'
    } else {
      const { SkillRegistry } = await import(pathToFileURL(join(pkgRoot, 'dsh-skill', 'lib', 'index.js')).href)
      // 最小 ctx：`Service` 构造要 `ctx.reflect.provide`；`ScopedLayers.effect` 传的是**生成器函数**
      const regLogs = []
      const rctx = mkMinimalRegistryCtx(regLogs)
      const reg = new SkillRegistry(rctx, {})
      reg.registerProvider(() => roles.makeRoleSkillProvider({ name: 'teamkit-role-g2', dir: g2RoleSkills, rank: 240 }))
      const listed = await reg.list()
      const arr = Array.isArray(listed) ? listed : (listed?.skills ?? [])
      g2regOk = arr.length >= 1 && arr.some((c) => (c.name ?? c) === 'g2-role-demo')
      g2regDetail = `pkg=${pkgRoot.includes('node_modules') ? '…/node_modules' : pkgRoot} n=${arr.length} warn=${regLogs.length ? regLogs.join('|').slice(0, 70) : '(无)'}`
    }
  } catch (err) {
    g2regOk = false
    g2regDetail = `${err?.name ?? ''}: ${String(err?.message).slice(0, 110)}`
  }
  if (g2regUnverified) {
    UNV('G2', '★ 角色技能条目过 `SkillRegistry.validateCandidate`（**缺真包，未获取**）', g2regDetail)
  } else {
    CHECK('G2', g2regOk,
      '★ 角色技能条目**真的过得了真 `SkillRegistry` 的 `validateCandidate`**（`invocation`/`source`/`rank`/`provider` 四件齐、provider===注册名）',
      '注册成功但条目过不了校验 ⇒ `skills.list()` 会在真宿主里抛错（Lead 第一版就是这样）', g2regDetail)
  }

  // ⑦ 人格段必须把 `acceptance_style` 带进去，且**不许冒充强制**
  const persona = roles.personaFor(goodRole)
  CHECK('G2', persona.includes(goodRole.acceptance_style) && persona.includes('advisory') && !/强制|enforced/i.test(persona),
    '人格段带**完成判据**且把 `write_scope` 如实标成 **advisory**（不假装能拦写）',
    '人格段丢了判据 / 或把 advisory 吹成强制', `persona ${persona.length} 字`)

  // ⑦-c ★ **岗位的工具面必须进人格段**（2026-09-14 / Round 19 补的缺口）
  // 【缺口】角色档的 `tools` 字段此前**只被检查"是数组"**（`roles.js:68`），之后**没人用**
  //   ⇒ 那是一条"零效果的声明"，而读者会以为它是约束（`LANDMINES §9`）。
  // 【为什么不做成硬门】实测：`ctx.tools.restrict()` **管不到** `read`/`write`/`pwsh` 这些
  //   **DSH 内置工具** —— 它们不在该 scope 的 `knownNames`/`restrictableNames` 里
  //   （实测：107 个名字里**一个内置工具都没有**；它们是别的包 `ctx.tools.register` 进预设各自的层）。
  //   唯一能拦的是 `tools.guard`（按名字拒绝调用），而委托方 P-15/P-16 已定：
  //   **控制面在认知，不在文件系统**。
  // ⇒ 判据 = "**写进认知，且如实标成 advisory**"，不是"真拦得住"。
  {
    const roleWithTools = { ...goodRole, tools: ['read', 'grep'] }
    const pT = roles.personaFor(roleWithTools)
    CHECK('G2', pT.includes('常用工具') && pT.includes('read') && pT.includes('grep'),
      '★ 岗位的 `tools` **进了人格段**（此前该字段零效果；现在写进认知）',
      '`tools` 字段仍无人使用 ⇒ 角色档里的工具声明是"零效果声明"，读者会误以为是约束',
      pT.split('\n').find((l) => l.includes('常用工具')) ?? '(没有这行)')
    CHECK('G2', pT.includes('advisory') && !/强制|enforced/i.test(pT),
      '★ 且**如实标成 advisory**（不假装"DSH 会拦你调别的工具"）',
      '把工具面吹成门禁 ⇒ 复现"只报实测"纪律的反面', 'advisory 标记在')
    const pNoTools = roles.personaFor({ ...goodRole, tools: [] })
    CHECK('G2', !pNoTools.includes('常用工具'),
      '角色档**没写 tools** ⇒ 人格段不塞空行', '空 tools 也塞了一行')
  }
  // ⑦b 缺档 = "通用工"，不是错误
  const noRole = roles.installRoleFor(g2agent, undefined, { rolesDirBase: rolesDir })
  CHECK('G2', noRole.ok === false && /no-role/.test(noRole.why),
    '成员名**没有角色档**时明确报 `no-role`（= 通用工，不是错误）', '没角色档时行为不明', noRole.why)

  // ⑧ `skills` 服务缺失 / `ctx.get` 抛错（cordis inject 守卫）⇒ 必须**被捕获**，不外抛
  let g2threw = false
  try {
    const r1 = roles.installRoleFor({ id: 'x', ctx: { get: () => undefined } }, goodRole, {})
    const r2 = roles.installRoleFor({ id: 'y', ctx: { get: () => { throw new Error('cannot get property "skills" without inject') } } }, goodRole, {})
    if (r1.ok !== false || r2.ok !== false) g2threw = true
  } catch {
    g2threw = true
  }
  CHECK('G2', g2threw === false,
    '`skills` 服务缺失 / `ctx.get` 抛错时**返回 ok:false 而不外抛**（同步 emit 抛错会否决 agent 发布）',
    '装配失败时抛出去了 ⇒ 会让 agent 发布被否决')

  // ⑨ 角色档**不含**模型/供应商字段（本仓真档案的回归断言）
  const realRolesDir = join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles')
  const realLoaded = roles.loadRoles(realRolesDir, () => {})
  const realForbidden = realLoaded.skipped.filter((s) => /禁字段/.test(s.why))
  CHECK('G2', realForbidden.length === 0,
    `本仓**真角色档**（${realLoaded.roles.size} 份）里零禁字段（回归断言：防止有人把 llm_model 加回去）`,
    '真角色档里出现禁字段', realLoaded.roles.size === 0 ? `(读不到 ${realRolesDir} —— 这条就只是 UNVERIFIED 级信息)` : `checked ${realLoaded.roles.size}`)

  // ═══ G3 · 上游链闭合（2026-09-14 的真事故回归）════════════════════════════
  // **背景（为什么要这条断言）**：Lead 给 `omc` 预设做技能隔离时，把"读路径"
  // （`skill-filesystem` 的 `customSkillDirs`）改到 `plugin/skills`，**但没改"写路径"**
  // （插件的 `upstream.root` 仍是 `$DSH_HOME/skills`）⇒ **上游链静默断开**：
  //   成员 `promote` 到上游后，自己和队友都**看不到** ⇒
  //   **"上游更新 → 全员自动跟随"（overlay 语义，OMC 的核心机制）失效，且不报错**。
  // 现场判决读数（Lead 跑的）：往 `upstream.root` 放一条只在上游的技能 ⇒
  //   "上游目录里有它: true / 读路径里有它: **false**"。
  // ⇒ 这条断言把"读写必须同指"变成机械判据，**防止再改一半**。
  section('G3 · 上游链闭合（读写同指 + overlay 自动跟随）')
  {
    // 用**沙盒**的 paths（不碰真盘）：upstream.root 与"读路径"由同一个 cfg 解析
    const g3base = join(sb.base, 'ws-g3')
    mkdirSync(g3base, { recursive: true })
    const g3up = join(g3base, 'upstream')
    const g3paths = cfg.resolveAll(
      { upstream: { root: g3up }, skills: { sourceDir: join(sb.base, 'ws-g3', 'none') } },
      { pluginDir: PLUGIN_DIR, env: { ...sb.env }, cwd: g3base },
    )
    // ① 配置层：解析出来的 upstream.root 必须**就是**传入那个（可配 ⇒ 能被预设指到读路径）
    CHECK('G3', resolve(g3paths.upstream.root) === resolve(g3up),
      '`upstream.root` **可配置**（预设能把它指到与 `customSkillDirs` 同一个目录）—— 这是"读写同指"的前提',
      'upstream.root 不跟随配置 ⇒ 预设无法让读写同指 ⇒ 上游链必断',
      `resolved=${relative(sb.base, g3paths.upstream.root)}`)

    // ② 行为层：往 upstream.root 放一条，**用真 SkillRegistry + 真 fork provider** 看成员能否看到
    //    （fork 为空 = 成员没改过 ⇒ 该条必须来自上游 ⇒ 这就是 overlay 自动跟随）
    const g3Name = 'g3-upstream-only'
    writeSkill(join(g3paths.upstream.root, g3Name), g3Name, { body: 'UP-v1\n' })
    const g3forkDir = join(sb.base, 'ws-g3', 'forks', 'g3-member', 'skills')
    mkdirSync(g3forkDir, { recursive: true })   // **空** fork
    let g3seen = false
    let g3detail = '(未跑)'
    const g3pkg = findRealPackagesRoot()
    if (g3pkg === undefined) {
      g3detail = '找不到真 @deepseek-ai/dsh-skill ⇒ 本条判 UNVERIFIED（给 $DSH_PACKAGES 可拿到读数）'
    } else try {
      const { SkillRegistry } = await import(pathToFileURL(join(g3pkg, 'dsh-skill', 'lib', 'index.js')).href)
      const reg = new SkillRegistry(mkMinimalRegistryCtx(), {})
      reg.registerProvider(() => ({
        name: 'g3-upstream-sim',
        rank: 400,
        async list() {
          const t = readFileSync(join(g3paths.upstream.root, g3Name, 'SKILL.md'), 'utf8')
          const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)
          return [{
            name: g3Name,
            description: (/description:\s*(.+)/.exec(m?.[1] ?? '')?.[1] ?? 'upstream').trim(),
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'user-dsh',
            provider: 'g3-upstream-sim',
            rank: 400,
            locator: join(g3paths.upstream.root, g3Name, 'SKILL.md'),
          }]
        },
        async get(c) { return { name: c.name, description: c.description, content: readFileSync(c.locator, 'utf8'), invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'g3-upstream-sim' } },
      }))
      reg.registerProvider(() => fork.makeForkProvider({ name: 'teamkit-fork', forkDir: g3forkDir, rank: 250 }))
      const listed = await reg.list()
      const arr = Array.isArray(listed) ? listed : (listed?.skills ?? [])
      const hit = arr.find((x) => (x.name ?? x) === g3Name)
      g3seen = hit !== undefined && hit.provider === 'g3-upstream-sim'
      g3detail = hit ? `provider=${hit.provider} source=${hit.source}` : `catalog n=${arr.length} 里没有它`
    } catch (err) {
      g3detail = `${err?.name ?? ''}: ${String(err?.message).slice(0, 100)}`
    }
    CHECK('G3', g3seen,
      '★★ **overlay 自动跟随**：上游加一条、成员 fork 为空 ⇒ 它**看得到**（且来源标注为上游 provider，不是 fork）',
      '上游加了成员看不到 ⇒ 上游链断（Lead 那次真事故的形态）', g3detail)
  }

  // ═══ G4 · 自演化位（工作原则）══════════════════════════════════════════════
  // **背景**：OMC 最值钱的一格是「组织会学习」—— 原版每人的 `work_principles.md`：
  //   教练一次 → 永久写盘 → **此后每次任务注入上下文**。
  //   本仓的对应物是 `talents/principles/<role>.md`（`talents/principles/README.md` 有约定）。
  // **修前的缺陷**：`roles.js` 只把**路径**写进人格文本，**从不读那个文件** ⇒
  //   **"写了原则"和"没写"在模型看来一样**（都只是看到一行路径）⇒ 那一格是**断的**。
  // ⇒ 这一组把三态变成机械判据：**写了就注入正文 / 没写就明说 / 读错要报**。
  section('G4 · 自演化位：工作原则（写了就注入，没写就明说）')
  {
    const g4base = join(sb.base, 'ws-g4')
    const g4princ = join(g4base, 'principles')
    mkdirSync(g4princ, { recursive: true })
    const g4role = {
      name: 'g4-engineer', role: 'engineering', level: 'ic', description: '实现者',
      acceptance_style: '贴原始读数', write_scope: 'src/**', gate_policy: 'review',
      principles: 'principles/g4-engineer.md',
    }
    // ① **没写过** ⇒ 明说"还没写"，并给出成长两轴（照 README 的约定，不是空话）
    const p0 = roles.personaFor(g4role, undefined)
    CHECK('G4', p0.includes('目前还没写') && p0.includes('垂直深度') && p0.includes('交接质量'),
      '**没写过原则**时：人格段**明说"目前还没写"**，并给出**成长两轴**（垂直深度 / 交接质量）—— 不假装有、也不静默漏',
      '没写却不说 ⇒ 模型不知道这格是空的；或说了但没给"该写什么"',
      `persona ${p0.length} 字`)

    // ② **写了** ⇒ 正文**真注入**（不是只给路径）
    const g4text = '- 这类活先跑最小复现再动手\n- 交接时给可复现命令\n'
    writeFileSync(join(g4princ, 'g4-engineer.md'), g4text, 'utf8')
    const got = roles.loadPrinciples(g4princ, 'g4-engineer')
    const p1 = roles.personaFor(g4role, got?.text)
    CHECK('G4', got?.text !== undefined && p1.includes('先跑最小复现再动手') && !p1.includes('目前还没写'),
      '★ **写过原则**时：正文**真进了人格段**（`loadPrinciples` 读盘 → `personaFor` 注入），且不再说"还没写"',
      '只给了路径、没注入正文 ⇒ "组织会学习"这一格是断的（Lead 修前就是这样）',
      `loaded ${got?.text?.length ?? 0} 字；注入=${p1.includes('先跑最小复现再动手')}`)

    // ③ **空文件** ⇒ 按"没写过"处理（不注入空白段）
    writeFileSync(join(g4princ, 'g4-empty.md'), '   \n\n', 'utf8')
    CHECK('G4', roles.loadPrinciples(g4princ, 'g4-empty') === undefined,
      '**空文件**按"没写过"处理（不往提示词里塞空白段）', '空文件被当成"有原则" ⇒ 注入一段空白')

    // ④ **不存在** ⇒ `undefined`（正常状态，不是错误）
    CHECK('G4', roles.loadPrinciples(g4princ, 'g4-nobody') === undefined,
      '**文件不存在** ⇒ `undefined`（= 还没写过，**正常状态**，不是错误）', '不存在被当成错误')

    // ⑤ 路径推导：`role.principles`（相对路径）→ 绝对路径（**约定**：目录由调用方给，只取文件名）
    //    约定依据：`talents/principles/README.md` + `COMPANY-LAYER.md:259` ⇒ 原则在 `talents/principles/<name>.md`
    const pp = roles.principlesPathFor(g4princ, g4role)
    CHECK('G4', pp !== undefined && String(pp.file) === join(g4princ, 'g4-engineer.md'),
      '`principlesPathFor` 把 `role.principles`（相对路径）推成**该原则目录下的文件**（只取文件名那一段）',
      '推不出路径 ⇒ 原则永远读不到；或把角色档里的 `principles/` 前缀当成了目录',
      `file=${relative(sb.base, String(pp?.file))}`)
    CHECK('G4', roles.principlesPathFor(g4princ, { name: 'x' }) === undefined,
      '角色档**没有 `principles` 字段** ⇒ 返回 `undefined`（**不猜**一个默认路径出来）',
      '没声明却造了路径 ⇒ 会去读一个不该读的文件')
    CHECK('G4', roles.principlesPathFor('', g4role) === undefined,
      '**没给原则目录** ⇒ 返回 `undefined`（**不猜**目录 —— 目录约定由 `index.js` 的候选列表定）',
      '目录为空却拼出路径 ⇒ 会去读仓根/盘根下的怪路径')

    // ⑥ 坏目录 **不抛**（`agent/created` 是同步 emit，抛错会否决 agent 发布）
    let g4threw = false
    try { roles.loadPrinciples(join(g4base, 'nope-does-not-exist'), 'x') } catch { g4threw = true }
    CHECK('G4', g4threw === false, '原则目录读不到时**不抛**（同 `installRoleFor` 的纪律）', '读盘错误抛出去了')

    // ⑥ ★ **绝对路径必须进人格段**（2026-09-14 事故回归：写入点 ≠ 读取点）
    //   事故现场：persona 只给相对路径 `principles/engineer.md` ⇒ teammate **猜**写入点，
    //   猜成了**仓内那份**，而预设的 `principles.dir` 指向 `$DSH_HOME/teamkit/talents/principles`
    //   ⇒ **它写的新原则，下一个同岗位的人读不到** ⇒「组织会学习」静默断链。
    //   判据：给了 `principlesFile` 时，人格段里必须出现**那个绝对路径**。
    const absF = join(g4princ, 'g4-engineer.md')
    const p2 = roles.personaFor(g4role, got?.text, absF)
    const absShown = p2.includes(absF.replace(/\\/g, '/'))
    CHECK('G4', absShown,
      '★ 人格段里给出原则文件的**绝对路径**（"该写哪"由系统给出，**不靠 teammate 猜**）',
      '只给相对路径 ⇒ teammate 会猜错写入点 ⇒ 写进去的原则下一个同岗位的人读不到（本项目实测过）',
      absShown ? '绝对路径在 persona 里' : `persona 里没有 ${absF}`)
    CHECK('G4', p2.includes('只追加'),
      '★ 并明确要求"**只追加**，不要重写已有内容"（自演化位的写纪律）',
      '没写"只追加" ⇒ teammate 可能重写整个文件、冲掉前辈沉淀的原则',
      p2.includes('只追加') ? '已写明' : '(没有这句)')
  }

  // ═══ G5 · 角色技能面（"招了人，他有自己的技能吗"）══════════════════════════
  // **背景**：`installRoleFor` 给每个 agent 注册 `teamkit-role-<role>` provider ——
  //   但**注册成功 ≠ 有内容**。本仓的 `roles/<name>/skills/` 曾长期**全是空目录** ⇒
  //   招来的人"有自己的技能 provider，却一条技能都没有"（与 `validateCandidate` 那次同族：
  //   结构对了、内容是空的）。2026-09-14 为 7 个角色各写了真技能（共 9 条）。
  // ⇒ 这一组把"角色技能面非空、且**按角色各给各的**"变成机械判据。
  section('G5 · 角色技能面（每条角色档都带自己的技能，且互不串）')
  {
    const realRolesDir2 = join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles')
    const rl = roles.loadRoles(realRolesDir2, () => {})
    const g5pkg = findRealPackagesRoot()
    if (rl.roles.size === 0) {
      UNV('G5', '角色技能面读数未获取（读不到本仓 roles/）', `tried ${realRolesDir2}`)
    } else {
      // ① 每个角色档都有 skills 目录、且至少 1 条技能（**不是空目录**）
      const empty = []
      let totalSkills = 0
      for (const [name] of rl.roles) {
        const dir = join(realRolesDir2, name, 'skills')
        const list = await roles.makeRoleSkillProvider({ name: 'x', dir }).list()
        totalSkills += list.length
        if (list.length === 0) empty.push(name)
      }
      CHECK('G5', empty.length === 0,
        `**每个角色档都带自己的技能**（${rl.roles.size} 个角色共 ${totalSkills} 条）—— 不是"有 provider 没内容"`,
        '有角色是空技能目录 ⇒ 招来的人"有身份没技能"（本仓曾长期如此）', `空角色: ${empty.join(',') || '(无)'}`)

      // ② 走**真 `SkillRegistry`**：注册两个角色，看 catalog 是否**按角色分开**
      if (g5pkg === undefined) {
        UNV('G5', '★ 角色技能过真注册表（缺真包，未获取）', '给 $DSH_PACKAGES 可拿到读数')
      } else {
        let got = null
        let why = ''
        try {
          const { SkillRegistry } = await import(pathToFileURL(join(g5pkg, 'dsh-skill', 'lib', 'index.js')).href)
          const reg = new SkillRegistry(mkMinimalRegistryCtx(), {})
          for (const name of ['engineer', 'reviewer']) {
            if (!rl.roles.has(name)) continue
            const dir = join(realRolesDir2, name, 'skills')
            reg.registerProvider(() => roles.makeRoleSkillProvider({ name: 'teamkit-role-' + name, dir, rank: 240 }))
          }
          const listed = await reg.list()
          const arr = Array.isArray(listed) ? listed : (listed?.skills ?? [])
          const eng = arr.filter((c) => c.provider === 'teamkit-role-engineer').map((c) => c.name)
          const rev = arr.filter((c) => c.provider === 'teamkit-role-reviewer').map((c) => c.name)
          got = { n: arr.length, eng, rev }
          why = `n=${arr.length} engineer=${eng.join(',')} reviewer=${rev.join(',')}`
        } catch (err) { why = `${err?.name ?? ''}: ${String(err?.message).slice(0, 100)}` }
        const okBoth = got !== null && got.eng.length > 0 && got.rev.length > 0
          && got.eng.every((n2) => !got.rev.includes(n2))
        CHECK('G5', okBoth,
          '★ 经**真 `SkillRegistry`**：engineer 与 reviewer 各自拿到**自己的**技能（互不串）',
          '注册表里读不到 / 两个角色的技能混在一起', why)
      }
    }
  }

  // ═══ R · 成员释放（**委托方硬指令「必须可以删」**；2026-09-14 / Round 33）══════
  // 【底座真相】roster 无移除方法 / journal 无移除事件 ⇒ 我们**包一层 `TeamJournal.prototype.state`**。
  // 【本组验什么】用的是**一个真形状的假 journal**（原型方法、writable+configurable），
  //   验**我们这一层**的四件事；**真宿主**的接线另有读数（见台账 Round 33）。
  //   ⚠️ **不测"底座能不能被改"**（那不该被改）—— 只测**我们的包装是不是真的过滤、且能还原**。
  section('R · 成员释放（包 journal.state 过滤已释放者；含还原与台账）')
  {
    const R = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'release.js')).href)
    // 造一个**真形状**的假 journal：`state(root)` 在**原型**上、返回 `{members:[…]}`
    const mkFake = () => {
      class FakeJournal {
        constructor(members) {
          this._members = members
        }
        state() {
          return { members: this._members, tasks: [], messages: [] }
        }
      }
      const j = new FakeJournal([
        { id: 'a1', name: 'alice', phase: 'active' },
        { id: 'b2', name: 'bob', phase: 'active' },
      ])
      return { journal: j, proto: FakeJournal.prototype }
    }
    // ① 包装后：被释放者从 `state().members` 里消失，**且不动底座那份 state**（浅拷贝）
    {
      const { journal, proto } = mkFake()
      // ⚠️ **必须先抓住"原方法"**：包装之后 `proto.state` 就是包装版了 ——
      //    我第一版直接 `proto.state.call(...)` 去验"原方法没被污染"，**结果测的是包装版**（假红）。
      const originalState = proto.state
      const rawBefore = originalState.call(journal)
      const before = rawBefore.members.length
      const w = R.wrapJournalState({ journal }, { released: new Set(['bob']), log: () => {} })
      const after = journal.state().members
      const rawAfter = originalState.call(journal)
      CHECK('R', w.ok && after.length === before - 1 && after.every((m) => m.name !== 'bob'),
        '★ 包 `journal.state` 后，**被释放者不再出现在名单里**',
        '过滤没生效 ⇒ "释放"只是台账上的字，名单仍列着它',
        `ok=${w.ok} before=${before} after=${after.length} names=${after.map((m) => m.name).join(',')}`)
      // ⚠️ 判据必须是**"底座的数据源没被改"**，不是"state 对象是同一个"——
      //    `state()` 本来就**每次新建对象**（真底座也是投影出来的）⇒ 比对象身份会**假红**
      //    （我第一版就这么错了，自测当场抓到）。
      const src = journal._members
      CHECK('R', rawAfter.members.length === before && src.length === before && src.some((m) => m.name === 'bob'),
        '★ 过滤**不动底座的数据源**：原方法读到的仍是全部人，`_members` 里 bob 还在（返回浅拷贝）',
        '直接改底座数据 ⇒ 污染别的消费者（二次伤害）',
        `原方法=${rawAfter.members.length} 人 / 数据源=${src.length} 人 / 含 bob=${src.some((m) => m.name === 'bob')}`)
      // ② 还原：还原后名单恢复（**卸载即净**）
      w.restore()
      const restored = journal.state().members.length
      CHECK('R', restored === before,
        '★ **还原后名单恢复**（`restore()` 真把原型方法放回去）',
        '还原不干净 ⇒ 插件卸载后宿主仍被过滤（"卸了还有残留"）',
        `restore 后 ${restored} 人`)
    }
    // ③ 台账：release/unrelease 落盘 + 重放（**重启后重建**的依据）
    {
      const dir = join(sb.base, 'r-track')
      mkdirSync(dir, { recursive: true })
      const { journal } = mkFake()
      const m = R.makeReleaseManager({
        agentTeams: { journal },
        stateDir: dir,
        cfg: { trackingFile: 'member-release.jsonl', requireReason: true },
        log: () => {},
      })
      m.apply()
      // ⚠️ **`release` 现在要求 root**（Round 36 修外溢 bug 后的新契约）⇒ 传假的 root 对象
      const rootA = { id: 'root-A', session: { header: { name: 'lead' } } }
      const okRel = m.release('bob', '长期 inactive，且 phase=failed', rootA)
      const afterRel = journal.state(rootA).members.map((x) => x.name)
      // **重放**：拿同一份台账建第二个管理器（= 模拟"重启后重建"）
      const m2 = R.makeReleaseManager({
        agentTeams: { journal },
        stateDir: dir,
        cfg: { trackingFile: 'member-release.jsonl', requireReason: true },
        log: () => {},
      })
      m2.apply()
      const afterReplay = journal.state(rootA).members.map((x) => x.name)
      CHECK('R', okRel.ok && !afterRel.includes('bob') && !afterReplay.includes('bob'),
        '★ **台账 → 重启后重建**：同一份台账新建管理器，过滤照样成立（盘上事实，不是内存依赖）',
        '只靠内存 ⇒ 重启即失效（那是"看起来能删、重启又回来"）',
        `release.ok=${okRel.ok} afterRel=${afterRel.join(',')} afterReplay=${afterReplay.join(',')}`)
      // ④ **说明是硬门**：没 reason 就拒绝（对齐 promote 的退出码 2 口径）
      const noReason = m.release('alice', '', rootA)
      CHECK('R', noReason.ok === false && noReason.code === 2,
        '★ **没写理由就拒绝释放**（`code=2`，与 `promote` 的"说明是硬门"同口径）',
        '破坏性动作不写理由 ⇒ 三个月后没人知道为什么少了个人',
        `ok=${noReason.ok} code=${noReason.code} why=${noReason.why}`)
      // ④-b ★ **拿不到 root 也拒绝**（不猜）—— 这是 Round 36 外溢 bug 的正面防线
      const noRoot = m.release('alice', '试试', undefined)
      CHECK('R', noRoot.ok === false && noRoot.code === 2 && /root-required/.test(String(noRoot.why)),
        '★ **给不出"这是哪个 Team"就拒绝释放**（`root-required`，不猜、不写全局桶）',
        '拿不到 root 还照释放 ⇒ 会按名字误伤**别的 Team 的同名成员**（Round 36 实测的真 bug）',
        `ok=${noRoot.ok} code=${noRoot.code}`)
      // ⑤ 撤销：`unrelease` 幂等且名单回来
      const un = m.unrelease('bob', rootA)
      const back = m.isReleased('bob', rootA)
      CHECK('R', un.ok && back === false && m.unrelease('bob', rootA).already === true,
        '★ **`unrelease` 能把人放回来，且重复调用幂等**（误操作可回退）',
        '只能放不能撤 ⇒ 误点一次就永久损失一个名额',
        `un.ok=${un.ok} isReleased=${back} 二次 already=${m.unrelease('bob', rootA).already}`)
    }
    // ③-b ★★ **跨 Team 隔离**（2026-09-14 / Round 36 实测的真外溢）
    //   背景：真宿主里 `standard` 队与 `omc` 队**都有 `engineer`**。
    //   第一版按**全局名字**过滤 ⇒ 释放 A 队的 engineer，**B 队的也一起消失**
    //   （实测 `aLost=[engineer] bLost=[engineer] LEAKED=true`）⇒ 违反"其它 preset 不受影响"。
    {
      const dir = join(sb.base, 'r-iso')
      mkdirSync(dir, { recursive: true })
      const mkTeamJournal = (names) => {
        class FakeJournal {
          constructor(ns) {
            this._members = ns.map((n, i) => ({ id: `${n}-${i}`, name: n, phase: 'active' }))
          }
          state() {
            return { members: this._members }
          }
        }
        return new FakeJournal(names)
      }
      const journal = mkTeamJournal(['engineer', 'alice', 'bob'])
      const rootA = { id: 'team-A' }
      const rootB = { id: 'team-B' }
      // ⚠️ 同一个 journal 实例服务两个 root（真底座就是这样的：按 root 选投影）
      const m = R.makeReleaseManager({
        agentTeams: { journal },
        stateDir: dir,
        cfg: { trackingFile: 'iso.jsonl', requireReason: true },
        log: () => {},
      })
      m.apply()
      const rel = m.release('engineer', '只在 A 队释放', rootA)
      // 判据：**A 队的 state 少人，B 队的 state 一人不少**
      const aNames = journal.state(rootA).members.map((x) => x.name)
      const bNames = journal.state(rootB).members.map((x) => x.name)
      CHECK('R', rel.ok && !aNames.includes('engineer') && bNames.includes('engineer'),
        '★★ **跨 Team 隔离**：释放 A 队的 `engineer` ⇒ **B 队的同名成员不受影响**',
        '按全局名字过滤 ⇒ 释放一个 Team 会误伤另一个 Team 的同名成员（违反"其它 preset 不受影响"）',
        `A=${aNames.join(',')} B=${bNames.join(',')}`)
      // 判据：`list()` 按 Team 分组，不糊成一条扁平表
      const listed = m.list()
      CHECK('R', Array.isArray(listed) && listed.length === 1 && listed[0].root === 'team-A' && listed[0].names.includes('engineer'),
        '★ **`list()` 按 Team 分组**（`[{root, names}]`）—— 不糊成一条扁平姓名表',
        '扁平表 ⇒ 看不出"这个名字是在哪个 Team 里被释放的"（跨 Team 重名时无法区分）',
        JSON.stringify(listed))
    }
    // ③-c ★★ **多实例共存**（2026-09-14 / Round 36 修的**第二个**真 bug）
    //   真宿主实测：`APPLY-DONE` **70ms 内出现 5 次** ⇒ 同一进程里有**多个插件实例**。
    //   原写法"只包一次" ⇒ 第二个实例拿到 `already-wrapped`、**复用了第一个实例的闭包**
    //   ⇒ **第二个实例的 `released` 根本没被读**：
    //     `m2.release('carol')` **返回 ok:true/code:0（声称成功）**，而名单里 carol **还在**
    //     ⇒ **报成功但什么也没发生**（"失败不静默"要防的最坏形态）。
    //   修法：原型上挂**登记簿**（`Set<桶集合>`），包装读**并集**，每个实例各放一份、各摘一份。
    {
      const dir = join(sb.base, 'r-multi')
      mkdirSync(dir, { recursive: true })
      class FakeJournal2 {
        constructor(ns) {
          this._members = ns.map((n, i) => ({ id: `${n}-${i}`, name: n, phase: 'active' }))
        }
        state() {
          return { members: this._members }
        }
      }
      const journal = new FakeJournal2(['alice', 'bob', 'carol'])
      const at = { journal }
      const root = { id: 'team-M' }
      const cfgM = { requireReason: true }
      const m1 = R.makeReleaseManager({ agentTeams: at, stateDir: dir, cfg: { ...cfgM, trackingFile: 'mi1.jsonl' }, log: () => {} })
      const w1 = m1.apply()
      const m2 = R.makeReleaseManager({ agentTeams: at, stateDir: dir, cfg: { ...cfgM, trackingFile: 'mi2.jsonl' }, log: () => {} })
      const w2 = m2.apply()
      CHECK('R', w1.ok && w2.ok && w2.why === 'joined-existing',
        '★ **第二个实例"加入"已有包装的登记簿**（不是拿到一个架空的 `already-wrapped`）',
        '第二实例复用了第一实例的闭包 ⇒ **它的释放永远不会生效**，却会报成功',
        `w1=${w1.why ?? 'ok'} w2=${w2.why ?? 'ok'}`)
      // 判据：**只用第二个实例**释放，必须真生效
      const r2 = m2.release('carol', '只用第二个实例释放', root)
      const namesAfter = journal.state(root).members.map((x) => x.name)
      CHECK('R', r2.ok && !namesAfter.includes('carol'),
        '★★ **只用第二个实例释放，真能过滤掉**（多实例登记簿生效，不是"报成功没动作"）',
        '第二个实例报成功但名单不变 ⇒ 用户以为删了，其实没删（最坏的静默失效）',
        `ok=${r2.ok} names=${namesAfter.join(',')}`)
      // 判据：摘掉一个实例 ⇒ 另一个的过滤**仍在**（不能"一个人走就把整层拆了"）
      m1.dispose()
      const afterOne = journal.state(root).members.map((x) => x.name)
      CHECK('R', !afterOne.includes('carol'),
        '★ **退出一个实例后，另一个实例的释放仍然生效**（不"一个人走就拆层"）',
        '第一个 dispose 就还原原型 ⇒ 还在用的实例**悄悄失效**（同族：半接线）',
        `names=${afterOne.join(',')}`)
      // 判据：全部退出 ⇒ 干净还原
      m2.dispose()
      const afterAll = journal.state(root).members.map((x) => x.name)
      CHECK('R', afterAll.length === 3,
        '★ **全部实例退出 ⇒ 原型方法干净还原**（名单回到 3 人）',
        '最后一个走的人不还原 ⇒ 插件卸了宿主还被过滤（"卸了还有残留"）',
        `names=${afterAll.join(',')}`)
    }
    // ⑥ 拿不到可包的方法时**不许静默**：要给出 why
    {
      const w = R.wrapJournalState({ journal: {} }, { released: new Set(['x']), log: () => {} })
      CHECK('R', w.ok === false && typeof w.why === 'string' && w.why !== '',
        '★ 拿不到可包的 `state` ⇒ **返回 `ok:false` + `why`**（失败不静默）',
        '静默失败 ⇒ 你以为释放了，其实什么也没发生',
        `ok=${w.ok} why=${w.why}`)
    }
    // ⑦ ★ **文档不许再说"这能力还没进插件"**（Round 32 刚把它标成"待实现"，
    //    Round 33 实现了 ⇒ 旧话立刻变成"已有之物被写成不存在"，同族 Round 25/31）。
    {
      const docsToCheck = [
        ['plugin/README.md', join(PLUGIN_DIR, 'README.md')],
        ['AGENTS.md', join(PLUGIN_DIR, '..', 'AGENTS.md')],
      ]
      const stale = []
      for (const [label, p] of docsToCheck) {
        let t = ''
        try { t = readFileSync(p, 'utf8') } catch { continue }
        if (/尚未进插件本体|还没进插件本体|release` 实现 = \*\*0 处\*\*/.test(t)) stale.push(label)
      }
      CHECK('R', stale.length === 0,
        '★ **文档不再说"成员释放还没进插件"**（Round 33 已实现；旧话属"已有之物被写成不存在"）',
        '文档说没实现 ⇒ 读者（与下一个 AI）会去重做一遍已完成的活',
        stale.length === 0 ? '0 处' : `仍写着: ${stale.join(' / ')}`)
    }
    // ⑧ ★ **能力必须是"可调用的"**（Round 34：只做机制、没人能调 = 没交付）
    {
      const src = (() => { try { return readFileSync(join(PLUGIN_DIR, 'lib', 'release-tools.js'), 'utf8') } catch { return '' } })()
      const want = ['list_zombies', 'release_member', 'unrelease_member']
      const miss = want.filter((n) => !src.includes(`name: '${n}'`))
      CHECK('R', src !== '' && miss.length === 0,
        '★ **三个工具都定义了**（`list_zombies` 只读 / `release_member` / `unrelease_member`）',
        '只有机制没有工具 ⇒ 用户根本调不到"释放"（Round 33 的死角）',
        miss.length === 0 ? `${want.length} 个齐` : `缺: ${miss.join(', ')}`)
      // `reason` 必须在 **schema 层** required（比运行时判断更早挡住）
      const reasonRequired = /reason:\s*\{[^}]*required:\s*true/s.test(src)
      CHECK('R', reasonRequired,
        '★ **`release_member` 的 `reason` 在 schema 层就是 `required: true`**（模型连调用都构造不出来）',
        '只在运行时判断 ⇒ 模型会先构造出调用再被拒（多一跳）；schema 层挡住更早更硬',
        reasonRequired ? 'schema 层 required ✓' : '未在 schema 层标 required')
      // **两个闸门分开**（Round 34 自己修的设计缺陷）：
      // `list_zombies` 只读 ⇒ `readonlyTools!==false` 就注册；两个写工具跟着 `enabled`。
      const roGate = /if \(readonly\)\s*(?:reg\()?/.test(src) && /readonlyTools\s*!==\s*false/.test(src)
      const destGate = /if \(destructive\)\s*reg\(/.test(src) && /cfg\?\.enabled === true/.test(src)
      CHECK('R', roGate && destGate,
        '★ **两个闸门分开**：只读的 `list_zombies` 默认就注册；破坏性两个工具要 `enabled=true`',
        '把"看得见"和"能动手"绑一起 ⇒ 用户想看有没有僵尸就得先开破坏性能力（与设计相反）',
        `readonly 闸门=${roGate} destructive 闸门=${destGate}`)
    }
    // ⑫ ★ **安装器要能区分"用户改过"与"上游更新了"**（2026-09-14 / Round 35 修的真缺口）
    //   原行为：`existsSync(dstFile) && !force` ⇒ **一律跳过**，只淡淡一句"已存在"。
    //   后果（本轮实测）：仓内预设已含 `memberRelease`，真机落点 **0 处** ⇒ 用户**永远开不了**那个能力，
    //   且安装器**不区分**是"你有改动"还是"我就没更新你"。
    {
      const inst = (() => { try { return readFileSync(join(PLUGIN_DIR, '..', 'tools', 'install-teamkit.mjs'), 'utf8') } catch { return '' } })()
      // ★★ **安装器不许用"下划线开头"当排除通则**（2026-09-14 / Round 71 修的真缺陷）————
      // 【缺陷现场】原判据 `!f.startsWith('_')` ⇒ **`talents/_SPEC.md` 永远装不到用户机器上**。
      //   而它是：用户想现写 Talent 时的字段依据 / 角色档**合法取值**的唯一定义处 /
      //   我这一轮刚改的 `role` 枚举 —— **改了也送不出去**（实测：真机那份是旧版）。
      // ⇒ 判据：安装器源码里**不许**再出现 `startsWith('_')` 这种**按前缀排除**的写法。
      //   要排除就**逐条列出文件名并写明理由**（"下划线开头 = 内部文件"这个直觉是错的：
      //   `_SPEC.md` 是**交付物的一部分**）。
      // ⚠️ **必须先剥注释** —— 我第一版直接扫全文 ⇒ **自己更正注释里引述的那句**把断言永远弄红了
      //    （与 `H14`/`H18` 同款："引述反面写法"被当成"真在用"）。
      // ⚠️⚠️ **第二版仍然红**：我按 `'\n'` 切行，而本仓文件是 **CRLF** ⇒ 切不干净、行首残留 `\r`
      //    ⇒ `trim()` 之前判断 `startsWith('//')` 失败。⇒ **按行处理含 Windows 文件时，先归一化换行**。
      const instCode = inst
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      const badPrefixFilter = /\.startsWith\('_'\)/.test(instCode)
      CHECK('R', !badPrefixFilter,
        '★★ **安装器不用"下划线开头"当排除通则**（`talents/_SPEC.md` 必须装给用户）',
        '用前缀排除 ⇒ `_SPEC.md`（Talent 字段规范 + 合法取值定义）**永远送不到用户机器**（R71 实测）',
        badPrefixFilter ? '**仍有 `startsWith(\'_\')`**' : '没有按前缀排除 ✓')
      // 判据：三种情况各有自己的措辞（说明它真的在区分，而不是一句"已存在"打天下）
      const marks = ['已是最新', '没有 .teamkit 标记', '内容与源不同']
      const missI = marks.filter((m) => !inst.includes(m))
      CHECK('R', inst !== '' && missI.length === 0,
        '★ **安装器区分三种预设状态**（已是最新 / 不是本包装的 / 内容与源不同）—— 不是一句"已存在"',
        '只报"已存在 ⇒ 跳过" ⇒ 用户分不清"我有改动"与"上游没更新我"（Round 35 实测的缺口）',
        missI.length === 0 ? '3 种齐' : `缺: ${missI.join(' / ')}`)
      // `--check` 也要报过期（只读就能发现问题）
      const checkReportsDrift = /if \(check\)[\s\S]{0,600}已过期\/有改动/.test(inst)
      CHECK('R', checkReportsDrift,
        '★ **`--check` 会报"预设已过期/有改动"**（只读一条命令就能发现问题）',
        '`--check` 说 OK 而真机是旧的 ⇒ 用户没有"不安装也能发现问题"的手段',
        checkReportsDrift ? 'check 会报漂移 ✓' : 'check 不报漂移')
    }
    // ⑭ ★★ **端到端不许只"数文件"**（2026-09-14 / Round 38 修的核心缺口）
    //   原 e2e 全是 `readdirSync(p).length >= N` ⇒ **只证明"文件到了"，证明不了"能用"**。
    //   本项目 Round 9 实测过的形态：`provider 注册成功、`list()` 返回空`
    //   ⇒ **"招了人，但他没有自己的技能"** —— 那时**文件数照样对，断言全绿**。
    //   ⇒ 现在 e2e 加了**功能断言**（真 `loadRoles` / 真 `loadPrinciples` / 每个角色都有技能）。
    {
      const e2e = (() => { try { return readFileSync(join(PLUGIN_DIR, 'scripts', 'e2e-tarball.mjs'), 'utf8') } catch { return '' } })()
      const functional = ['loadRoles', 'loadPrinciples', '每个角色档都配了技能目录']
      const missF = functional.filter((m) => !e2e.includes(m))
      CHECK('R', e2e !== '' && missF.length === 0,
        '★★ **真 tgz 端到端里有"功能断言"**（真 `loadRoles` / 真 `loadPrinciples` / 角色配齐技能）',
        '只数文件 ⇒ "文件到了但用不了"照样全绿（Round 9 的"有身份没技能"就是这种）',
        missF.length === 0 ? '3 项齐' : `缺: ${missF.join(' / ')}`)
      // 判据里必须有"逐角色"检查（不是"总数 ≥N"—— 那个我变异过，**删一个角色也不红**）
      const perRole = /rolesWithoutSkills/.test(e2e) && /roleDirs\.length === expectRoleIds/.test(e2e)
      CHECK('R', perRole,
        '★ 功能断言是**逐角色**的（不是"总数 ≥N" —— 删掉一个角色的技能，总数仍够 ⇒ 假绿）',
        '"总数 ≥N" 的判据在"少一个角色"时**不会变红**（我变异测试实测过）',
        perRole ? '逐角色 + 角色数配对 ✓' : '缺逐角色/配对数判据')
    }
  }

  // ── H12 · ★★ **插件的 `lib/**` 里不许有裸导入**（2026-09-14 / Round 40 修的自造回归）──
  // 【缺陷】Round 34 我在 `lib/release-tools.js` 里写了
  //   `import { defineTool } from '@deepseek-ai/dsh-tools'` ——
  //   **那是整个插件里唯一的裸依赖**（此前全是 `node:` 内置 + 相对导入）。
  // 【为什么有毒】与 `LANDMINES §1` 的事故**同一机理**：
  //   `link:`/junction 装法下 Node 按**真实路径**解析 ⇒ 裸导入会去**插件目录往上**找。
  //   本机**恰好能找到**（全局 npm 在祖先链上）⇒ 所以"没炸"；**换机器/换装法就 `ERR_MODULE_NOT_FOUND`**
  //   —— 正是本项目最严重那次事故的形态（`imported from <vendor 路径>`）。
  // 【判据】`plugin/{lib}/**\/*.js` 的 import 只允许 **`node:` 内置**与**相对路径**（`./` `../`）。
  //   ⚠️ 只查 `lib/`（那是**会被宿主 import 的**代码）；`bin/`/`scripts/`/`tools/` 是**离线 CLI**，
  //      它们可以在别处跑，风险不同（但也不该有裸依赖 —— 一并查，**只报不判**留给下面那条）。
  {
    const dirs = ['lib', 'bin', 'scripts', 'tools']
    const offenders = []
    for (const d of dirs) {
      let files = []
      try {
        files = readdirSync(join(PLUGIN_DIR, d), { withFileTypes: true })
          .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs')))
          .map((e) => e.name)
      } catch {
        files = []
      }
      for (const f of files) {
        let t = ''
        try {
          t = readFileSync(join(PLUGIN_DIR, d, f), 'utf8')
        } catch {
          continue
        }
        // ⚠️ **必须先剥掉注释**：我第一版直接扫全文 ⇒ **把注释里的示例也算成裸导入**（假红）——
        //    本轮我自己那两段"说明为什么不许裸导入"的注释里**原样引用了那句 import**。
        //    ⚠️ 而且**光剥 `//` 不够**：那段说明在 `/** … */` **块注释**里（第二版仍假红）。
        //    ⇒ 先剥**块注释**，再剥**行注释**。
        const code = t
          .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
          .split('\n')
          .map((l) => {
            const i = l.indexOf('//')
            return i >= 0 ? l.slice(0, i) : l
          })
          .join('\n')
        // 抓 `import … from '<spec>'` 与 `await import('<spec>')` 的 specifier
        for (const m of code.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'\s*\)/g)) {
          const spec = m[1] ?? m[2]
          if (spec === undefined) continue
          if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('file:')) continue
          offenders.push(`${d}/${f} → ${spec}`)
        }
      }
    }
    CHECK('H12', offenders.length === 0,
      '★★ **插件代码里没有"裸导入"**（只有 `node:` 内置 + 相对路径）⇒ 从**任意路径**都能加载',
      '裸导入 + `link:` 装法 ⇒ 按真实路径找不到那个包 ⇒ `ERR_MODULE_NOT_FOUND`（LANDMINES §1 的最严重事故形态）',
      offenders.length === 0 ? '0 个裸导入' : offenders.slice(0, 4).join(' / '))
  }

  // ── H13 · ★ **"模型能调的工具"必须在用户手册里有"怎么用"**（2026-09-14 / Round 41）──
  // 【缺陷】Round 33–37 把 `list_zombies` / `release_member` / `unrelease_member` 做成了真工具，
  //   但 `plugin/README.md` 里**这三个工具名一次都没出现**（只在"限制"节里提了一句 `memberRelease` 配置）。
  //   ⇒ 用户读手册**只会看到 CLI 命令**，**根本不知道运行时还有这几个工具** ——
  //   同族 Round 25（SOP 过期）/ 31（计划态注释）：**东西做出来了，但没人知道它在**。
  // 【判据】README 里**必须**出现这三个工具名，且**必须有一节讲它们**（不是"藏在限制里"）。
  //   ⚠️ 只查"名字在不在 + 有没有那一节"，**不查措辞**（那是人审的事）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    // ★ **别硬编码三个名字**（2026-09-14 / Round 66）：
    //   原判据写死 `['list_zombies','release_member','unrelease_member']` ⇒
    //   R48/49 加的 `read_self` / `write_self` **做出来了但表里没有**，而这条断言**照样绿**。
    //   ⇒ 改成**从实现里抓**（`release-tools.js` 的 `name: '<x>'`），**有几个抓几个**（R64 的教训：
    //     "文档 ↔ 实现"的对照，判据要从**实现侧**取，不能从文档侧列一份固定的）。
    let rt = ''
    try { rt = readFileSync(join(PLUGIN_DIR, 'lib', 'release-tools.js'), 'utf8') } catch { rt = '' }
    // ⚠️ **必须先剥注释**（2026-09-14 / Round 81 又栽一次 —— 这是第 6 次）：
    //   `release-tools.js` 的注释里有 `{role:'lead', name:'lead'}`（我在讲伪 lead 行），
    //   而正则 `name:\s*'([a-z_]+)'` 的 `\s*` **允许零个空格** ⇒ **把 `name:'lead'` 当成一个工具名** ⇒
    //   判据说"缺: lead"（**一个根本不存在的工具**）。同族：H14/H18/R71/R73/H32 **全是"引述被当真"**。
    //   ⇒ 固定动作：**扫源码的判据，第一件事就是剥注释 + 归一化换行。**
    const rtCode = rt
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    const mustTools = [...new Set([...rtCode.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]))]
    const missT = mustTools.filter((t) => !rd.includes(t))
    CHECK('H13', mustTools.length >= 3 && missT.length === 0,
      `★ **用户手册里列了模型能调的每个工具**（从实现里抓，共 ${mustTools.length} 个）`,
      '工具做了但手册不提 ⇒ 用户只知道 CLI，**不知道运行时有哪些能力**（"东西在，没人知道"）；' +
        '⚠️ 写死名单会让新加的工具**静默漏掉**（`read_self`/`write_self` 就这么漏了一轮）',
      mustTools.length === 0 ? '**没抓到最后实现里的工具名**（格式变了？）' : missT.length === 0 ? `${mustTools.length} 个工具名齐：${mustTools.join(', ')}` : `缺: ${missT.join(', ')}`)
    // 必须有**专门一节**（判据：出现 `## 运行时的工具` 这个标题），而不是散落在别的节里
    const hasSection = /^#{2,3}\s*运行时的工具/m.test(rd)
    CHECK('H13', hasSection,
      '★ 手册里有**"运行时的工具"专节**（不是把工具名散落在限制/命令节里）',
      '没有专节 ⇒ 读者按目录跳转时**找不到"我能调什么"**',
      hasSection ? '有专节 ✓' : '没有"运行时的工具"节')
    // ★★ **"装上就有效果"必须把"岗位人格段"算进去**（2026-09-14 / Round 41 发现的第二处遗漏）
    //   本节原来列了 3 件（技能 / fork / 通知），**漏了第 4 件：每个成员拿到自己的岗位人格段**
    //   —— 那恰恰是"公司层"最核心的那一件（有岗位、有验收口径、有自演化位）。
    //   真宿主有 `ROLE-PERSONA-OK` 为证。**做成的东西必须在本节露面**（同 H13 的立意）。
    const listsPersona = /装完\*\*立刻\*\*发生五件事/.test(rd) && /岗位人格段/.test(rd) && /SOUL/.test(rd)
    CHECK('H13', listsPersona,
      '★ "装上就有效果"里**列了第 4 件（岗位人格段）与第 5 件（SOUL 注入）**',
      '漏掉任一件 ⇒ 用户以为"装完只是多了技能"，**不知道成员会变成有岗位、且能自我迭代的人**',
      listsPersona ? '五件事齐 ✓' : '仍缺岗位人格段或 SOUL')
  }

  // ── H14 · ★ **技能里给"装出来的资产"必须用绝对路径**（2026-09-14 / Round 42）──────
  // 【缺陷】`teamkit-assemble` §3 原来写的是：
  //     「打开 `$DSH_HOME/teamkit/TALENTS.yml` … → 读 `talents/<file>`」
  //   —— **同一句里，一个是绝对路径、一个是相对路径** ⇒ 模型得**自己拼** `talents/`，
  //   而 `talents/` 在**真机落点** `$DSH_HOME/teamkit/talents/`，**不在当前项目里**。
  //   项目里**恰好也有一份同名的**（开发仓）⇒ 它会读到**开发仓那份**，
  //   在用户机器上**读不到**（Round 23 实测过同族事故：拼错的那份"不会被读"）。
  // 【判据】技能里凡是指**装出来的资产**（`talents/` / `roles/` / `TALENTS.yml` / `RULES.yml`），
  //   出现时**必须带 `<DSH_HOME>`（或 `$DSH_HOME`）前缀**，不许是光秃秃的相对路径。
  //   ⚠️ **例外**：讲**原版 OMC 字段名**（`work_principles.md` / `profile.yaml`）或**举例说明**的地方不算。
  {
    const offenders = []
    let skillDirs = []
    try {
      skillDirs = readdirSync(join(PLUGIN_DIR, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      skillDirs = []
    }
    // 只抓"裸引用的装出来的资产"：`talents/` / `roles/` 出现在反引号里、且**前面不是** `$DSH_HOME/` 或 `/`
    const barePat = /`(talents\/|roles\/)/g
    for (const d of skillDirs) {
      let t = ''
      try {
        t = readFileSync(join(PLUGIN_DIR, 'skills', d, 'SKILL.md'), 'utf8')
      } catch {
        continue
      }
      // ⚠️ **`teamkit-a2a` 整份豁免**：它的那一节**就是**在教"不要自己拼路径"，
      //    里面**必须**保留裸相对路径当**反面示例**（「Lead 按仓内相对路径拼出 …」）。
      //    ⇒ 与其逐行猜"这行是不是示例"（我试过，判据不稳），不如**整份豁免 + 在注释里写明理由**。
      //    ⚠️ 豁免不是"放过"：那一节的存在**正是在实施本判据要教的事**。
      if (d === 'teamkit-a2a') continue
      for (const line of t.split('\n')) {
        // 跳过"讲原版字段/举例"的行（含 OMC 原版字样或 `work_principles`）
        if (/原版|work_principles|profile\.yaml/.test(line)) continue
        for (const m of line.matchAll(barePat)) {
          const idx = m.index ?? 0
          const before = line.slice(Math.max(0, idx - 30), idx)
          if (/\$DSH_HOME\/teamkit\/$/.test(before) || /<DSH>\//.test(before)) continue
          offenders.push(`${d}: ${line.trim().slice(0, 70)}`)
        }
      }
    }
    CHECK('H14', offenders.length === 0,
      '★ **技能里指"装出来的资产"用了绝对路径**（`$DSH_HOME/teamkit/…`），不是光秃秃的 `talents/`',
      '相对路径 ⇒ 模型自己拼 ⇒ 在项目里**恰好有同名的一份**时读到错的、在用户机器上读不到',
      offenders.length === 0 ? '0 处裸相对路径' : offenders.slice(0, 3).join(' || '))
  }

  // ── H15 · ★ **"做得不够好时怎么纠正"必须在技能里有落点**（2026-09-14 / Round 46）──
  // 【缺口】`PERF-LOOP.md` §9 标题就是「**今天就能做的一步**」，写清了 S0→S3 四步；
  //   但实测：**7 条技能里"绩效 / 复检 / S0 / 纠错强度"命中 = 0 处**（`PERF-LOOP` 只在
  //   `plugin/lib/*.js` 的**注释**里被提到 4 次）。
  //   ⇒ **闭环设计得再细，没人读得到也等于没有**（同族 Round 41/45："东西在，没人知道"）。
  //   而这一环是**委托方明确要的**：「考核是为了**让他意识到自己做得不够好**，去改 skills / SOUL」。
  // 【判据】`teamkit-escalate`（"什么时候换人"那一节的自然归属）里**必须有这四步**：
  //   `S0 预登记` / `S1 送达` / `S2 修订` / `S3 复检` 四个词都在，且**提到"闭环合上"的判据**。
  {
    let esc = ''
    try { esc = readFileSync(join(PLUGIN_DIR, 'skills', 'teamkit-escalate', 'SKILL.md'), 'utf8') } catch { esc = '' }
    const steps = ['S0 预登记', 'S1 送达', 'S2 修订', 'S3 复检']
    const missS = steps.filter((s) => !esc.includes(s))
    CHECK('H15', esc !== '' && missS.length === 0,
      '★★ **"做得不够好时先纠正、别急换人"的四步在技能里**（S0 预登记 / S1 送达 / S2 修订 / S3 复检）',
      '只有 `runs/**` 里那份设计、技能里没有 ⇒ **成员与 Lead 都读不到**这个闭环（Round 41/45 同族）',
      missS.length === 0 ? '4 步齐' : `缺: ${missS.join(', ')}`)
    // 且要**说清闭环判据**（不是只列四个词）
    const statesClosure = /闭环合上.*S1.*S2.*S3/.test(esc)
    CHECK('H15', statesClosure,
      '★ 且**写明闭环判据**（`闭环合上 = S1 ∧ S2 ∧ S3 全绿`，缺一进递进）',
      '只列步骤不说判据 ⇒ 读者无法判断"这次到底合上没有"',
      statesClosure ? '有闭环判据 ✓' : '没写闭环判据')
    // 委托方口径必须带上（"不是淘汰/排队"）——否则读者会把它当绩效淘汰
    const hasStance = /不是淘汰|不是.*排队|纠错强度/.test(esc)
    CHECK('H15', hasStance,
      '★ 且带上**委托方口径**（考核不是淘汰/排队；递进 = 纠错强度，不是等级）',
      '不带口径 ⇒ 读者把它当"绩效淘汰"，与"让他去改自己的 skills / SOUL"的用意相反',
      hasStance ? '口径在 ✓' : '缺口径')
  }

  // ── H17 · ★★ **用户手册必须给"上手路径"**（2026-09-14 / Round 55）────────────
  // 【缺陷现场】我让一个 agent 只读 README **前 60 行**（模拟"新用户决定要不要用"），它答：
  //   > 「**README 没给「开一家一人公司」的上手路径**……我卡在「东西都装好了，然后呢」」
  //   > 「前 60 行里**连「装插件本体」本身的命令都没有** —— `## 装` 小节第一条就是
  //   >   「**0. 装完还要装资产**」，**默认我已经装过了**」
  //   ⇒ 实测确认：`### 0. 装完还要装资产` 在 `### 1. 装进 profile` **之前** ——
  //     **让用户先"配置"再"安装"**，顺序是反的。（已改成 ①②③④⑤⑥。）
  // 【为什么这是北极星级问题】委托方定的北极星是"**越方便开源后其他用户安装越好**" ——
  //   而"装完不知道该干啥"正是**最伤开源体验**的一格：功能全在，用户用不起来。
  // 【判据】README 里必须有一个**上手小节**，且它必须出现在**第一章附近**（不能藏在末尾），
  //   且它要给出**四样**：装插件命令 / 装资产命令 / 选哪个预设 / **验收信号**。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    const m = /^##\s*(?:30\s*秒上手|快速上手|上手)/m.exec(rd)
    const atLine = m === null ? -1 : rd.slice(0, m.index).split('\n').length
    CHECK('H17', m !== null && atLine > 0 && atLine <= 80,
      '★★ **README 有"上手"小节，且在前 80 行内**（新用户第一屏就能看到）',
      '没有/太靠后 ⇒ 用户"装完不知道干啥"（实测：只读前 60 行的 agent 答"我卡在东西装好了然后呢"）',
      m === null ? '**没有上手小节**' : `在第 ${atLine} 行`)
    if (m !== null) {
      const nextH2 = rd.indexOf('\n## ', m.index + 4)
      const seg = rd.slice(m.index, nextH2 === -1 ? undefined : nextH2)
      const want = [
        ['装插件命令', /dsh plugin .*add/],
        ['装资产命令', /install-teamkit\.mjs/],
        ['选哪个预设', /omc/],
        ['验收信号', /ROLES-LOADED|ROLE-PERSONA-OK|FORK-REGISTER-OK|selftest/],
      ]
      const missing = want.filter(([, re]) => !re.test(seg)).map(([n]) => n)
      CHECK('H17', missing.length === 0,
        '★ 上手小节里有**四样**：装插件命令 / 装资产命令 / 选哪个预设 / **验收信号**',
        '缺任一样 ⇒ 用户走不到"跑起来"（尤其**验收信号**：没有它用户不知道装对了没）',
        missing.length === 0 ? '4 样齐' : `缺: ${missing.join(', ')}`)
    }
    // 顺序判据：**"先装插件本体"必须排在"装资产"之前**（第一版是反的）
    const iPlugin = rd.search(/^###\s*①[^\n]*装插件本体/m)
    const iAssets = rd.search(/^###\s*②[^\n]*装资产/m)
    CHECK('H17', iPlugin !== -1 && iAssets !== -1 && iPlugin < iAssets,
      '★★ **"①先装插件本体"排在"②装资产"之前**（顺序不能反 —— 第一版是反的）',
      '反着写 ⇒ 用户被要求"先配置再安装"，**第一步就卡住**（实测：agent 指出"默认我已经装过了"）',
      `①插件@${iPlugin} ②资产@${iAssets}`)
    // ★ **第①步的命令必须是"真能跑通的形态"**（2026-09-14 / Round 56 实测）
    //   我在一个**一次性 profile** 里真跑了 `dsh plugin --profile probe56 add …`：
    //     · `file:./plugin`  ⇒ `ENOENT: scandir '…\profiles\probe56\D:\dsh\omc…'`
    //       （`dsh plugin` 转发给**该 profile 目录下的 pnpm**，相对路径按 profile 目录解析）
    //     · `"D:\path\to\plugin"`（**绝对路径、不带 file:**）⇒ **exit=0**，真装进 dependencies + bundles
    //   ⇒ 判据：README 里**不许**再把 `file:./` 当推荐写法；且必须提醒 `pnpm` 要在 PATH 上。
    const hasBadForm = /dsh plugin[^\n]*add\s+file:\.\//.test(rd)
    const mentionsPnpm = /pnpm.*(PATH|不是|recognized)/.test(rd)
    CHECK('H17', !hasBadForm,
      '★★ **安装命令不用 `file:./plugin`**（实测会 ENOENT；要用**绝对路径**）',
      '相对路径被 pnpm 按 **profile 目录**解析 ⇒ 报 `ENOENT: scandir …\\profiles\\<p>\\D:\\…`（我亲测）',
      hasBadForm ? '**仍在推荐 `file:./…`**' : '没有坏写法 ✓')
    CHECK('H17', mentionsPnpm,
      '★ 且提醒了 **`pnpm` 必须在 PATH 上**（`dsh plugin` 是转发给 pnpm 的）',
      '不提醒 ⇒ 用户看到 `\'pnpm\' is not recognized`，**看不出是缺前置**，容易误判成"包坏了"',
      mentionsPnpm ? '有提醒 ✓' : '没提 pnpm 前置')
  }

  // ── H18 · ★★ **"不能做"的记录要带出处与时间，且不许留过期口径**（Round 57）───────
  // 【缺陷现场】`AGENTS.md` 硬规矩 1 原文写「改 DSH 本体源码 / **动任何 profile 依赖**」——
  //   而委托方早已明确「**包装成 profile 依赖…我已经给你完全权限了**」。
  //   我**引述了那个过期的"不能做"**，白挂了一条 `❌ 仍未验（约束所致）` 挂了很多轮
  //   （`dsh plugin --profile add` 端到端）—— 直到 Round 56 真去跑，才发现**约束早就不在了**。
  // 【同类第二处】`AGENTS.md` 硬规矩 2 原文推荐 `dsh plugin add file:<相对路径>` ——
  //   Round 56 实测那条**必失败**（ENOENT，pnpm 按 profile 目录解析）。
  // ⇒ 规则：**一句话里说"不能/禁止/要做 X"时，必须能指出"谁说的、什么时候"**；
  //   并且**过期口径要就地改掉**，不能只在别处写个"更正"（读者可能只看到错的那句）。
  {
    let ag = ''
    try { ag = readFileSync(join(PLUGIN_DIR, '..', 'AGENTS.md'), 'utf8') } catch { ag = '' }
    if (ag === '') {
      CHECK('H18', null, 'AGENTS.md 读不到 ⇒ 未验证', '本判据要读它；读不到不假装')
    } else {
      // ① 过期的"禁止动 profile 依赖"不许作为**活跃口径**存在（允许出现在"更正"引述里）
      const liveBadRule = /侵入的定义是「改 DSH 本体源码 \/ 动任何 profile 依赖」/.test(ag)
      CHECK('H18', !liveBadRule,
        '★★ **AGENTS 硬规矩 1 不再把"动任何 profile 依赖"列为禁止**（委托方已解除）',
        '留着 ⇒ 后人（包括我）会**继续引述一个已过期的约束**，白挂"未验"（Round 56 实测过）',
        liveBadRule ? '**仍有那句活跃口径**' : '已更正 ✓')
      // ② 也不许再推荐必失败的 `file:<相对路径>` 写法
      //    ⚠️ **但它出现在"更正引述"里是必须的**（「本条原文写的是『…』」—— 不引就没法说明改了什么）。
      //    判据：**引述行**含"原文写的是/原来/曾经/更正" ⇒ 放行；**命令示例行** ⇒ 抓。
      //    （这是我第一次把 H18 写成纯关键词匹配时**自己制造的假红** —— 与 H14 那次同族。）
      const badLines = ag
        .split('\n')
        .filter((l) => /dsh plugin add file:<相对路径>/.test(l))
        .filter((l) => !/原文写的是|原来|曾经|更正|已改正|是错的/.test(l))
      CHECK('H18', badLines.length === 0,
        '★★ **AGENTS 硬规矩 2 不再推荐 `add file:<相对路径>`**（实测必失败：ENOENT）',
        '推荐必失败写法 ⇒ 用户第一步就挂，且错误信息（scandir …\\profiles\\x\\D:\\…）**看不出根因**',
        badLines.length === 0 ? '已改成绝对路径 ✓' : `${badLines.length} 行仍在推荐：${badLines[0].trim().slice(0, 60)}`)
      // ③ "不能做"必须带时间锚（判据：文档里关键更正都带日期）
      const hasDateAnchor = /2026-09-1[0-9]/.test(ag)
      CHECK('H18', hasDateAnchor,
        '★ AGENTS.md 里的口径更正**带时间锚**（`2026-09-…`）⇒ 可判断新旧',
        '不带时间 ⇒ 读者无法判断"这条是新的还是旧的"（本次两个坑都源于此）',
        hasDateAnchor ? '有时间锚 ✓' : '没有时间锚')
    }
  }

  // ── H19 · ★★ **文档里的"数字断言"必须与实测一致**（2026-09-14 / Round 58）────────
  // 【缺陷现场】这轮做"文档断言 vs 实测"对账，抓到：
  //   `plugin/README.md:486` 与 `AGENTS.md:128` 都写着「`R` 组 **7 条**」——
  //   而**实测 `R` 组已经是 22 条**（我每轮都在往里加断言，**文档没跟着走**）。
  //   ⇒ 这正是 `AGENTS.md` 自己立的规矩「**自己跑，别抄数**」（"断言数每轮都在加"）**被我自己违反**。
  // 【判据】文档里**不许**出现"某组 N 条"这种**会漂移的硬编码计数**；
  //   要引用组时**只给组名 + 让它自己跑**。允许例外：**明确标着"当时"的历史读数**。
  {
    const docs = [
      { file: join(PLUGIN_DIR, 'README.md'), name: 'plugin/README.md' },
      { file: join(PLUGIN_DIR, '..', 'AGENTS.md'), name: 'AGENTS.md' },
    ]
    const offenders = []
    for (const d of docs) {
      let t = ''
      try {
        t = readFileSync(d.file, 'utf8')
      } catch {
        continue
      }
      t.split('\n').forEach((line, i) => {
        // 抓"组名 + N 条"（如 `R` 组 7 条 / S 组 22 条）
        if (!/组\s*\d+\s*条/.test(line)) return
        // 例外：明确是"当时/历史"的读数
        if (/当时|历史上|Round \d+ 时|已过时/.test(line)) return
        offenders.push(`${d.name}:${i + 1}`)
      })
    }
    CHECK('H19', offenders.length === 0,
      '★★ **文档里没有"会漂移的组计数"**（如「`R` 组 7 条」）—— 引用组时只给组名，数让它自己跑',
      '硬编码组计数 ⇒ 我每加一条断言它就错一次（实测：文档说 7 条、实际 22 条）；这也违反 AGENTS 自己立的"**自己跑，别抄数**"',
      offenders.length === 0 ? '0 处漂移计数' : `${offenders.length} 处：${offenders.slice(0, 3).join(', ')}`)
  }

  // ── H20 · ★★ **开源发布的元数据要齐**（2026-09-14 / Round 59）──────────────
  // 【为什么算硬判据】北极星是「**越方便开源后其他用户安装越好**」——
  //   装的第一步不是跑命令，而是**用户能不能看懂"这是什么、谁的、能不能用"**。
  //   `npm pack` 验证过：62→63 个文件、零夹带；但元数据当时缺 **LICENSE 正文**
  //   （`license: "BSD-3-Clause"` 声明了却**没有 LICENSE 文件**）与 `keywords`。
  // ⇒ 判据：**声明了 license ⇒ 必须有 LICENSE 正文**（否则是"声明式许可"，法律上站不住）；
  //   `keywords` 非空（发现性）；`repository|homepage|bugs` 若缺，**必须有显式理由字段**（不许沉默）。
  {
    let pkg = null
    try {
      pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    } catch {
      pkg = null
    }
    if (pkg === null) {
      CHECK('H20', false, 'package.json 读不了或不是合法 JSON', '发布元数据都在这份文件里')
    } else {
      const hasLicenseFile = existsSync(join(PLUGIN_DIR, 'LICENSE')) || existsSync(join(PLUGIN_DIR, 'LICENSE.md'))
      const declaredLicense = typeof pkg.license === 'string' && pkg.license !== ''
      CHECK('H20', !declaredLicense || hasLicenseFile,
        '★★ **声明了 `license` ⇒ 就有 LICENSE 正文**（`BSD-3-Clause` + `LICENSE` 文件）',
        '只声明不附正文 ⇒ **法律上站不住**（用户拿到包却看不到授权条款），且 npm 生态默认要带',
        declaredLicense ? `license=${pkg.license} 正文=${hasLicenseFile}` : '没声明 license')
      const kw = Array.isArray(pkg.keywords) ? pkg.keywords : []
      CHECK('H20', kw.length >= 5,
        '★ `keywords` 非空（≥5，便于被发现）',
        '没有 keywords ⇒ npm/搜索引擎里搜不到这个包（开源"被发现"的第一步）',
        `${kw.length} 条：${kw.slice(0, 4).join(', ')}${kw.length > 4 ? '…' : ''}`)
      // repository/homepage/bugs：**可以缺，但不许沉默**（要有显式理由字段）
      const missingRepo = pkg.repository == null && pkg.homepage == null && pkg.bugs == null
      const hasReason = typeof pkg['//repository'] === 'string' && pkg['//repository'].length > 10
      CHECK('H20', !missingRepo || hasReason,
        '★ 缺 `repository`/`homepage`/`bugs` 时**必须写明理由**（本仓无 git remote ⇒ 不编 URL）',
        '沉默地缺 ⇒ 后人以为"忘了填"；写了理由 ⇒ 知道是**有意的**、发布时要补',
        missingRepo ? (hasReason ? '有理由字段 ✓' : '**缺且无理由**') : '有 repository 类字段')
    }
  }

  // ── H21 · ★★ **`doctor` 要查"会挡住用户第一步的外部前置"**（2026-09-14 / Round 60）──
  // 【为什么】我自己**连撞两次**，两次的报错都**看不出是缺前置**：
  //   · R56：`dsh plugin --profile <p> add` ⇒ `'pnpm' is not recognized`（它其实转发给 pnpm）
  //   · R59：`e2e-tarball` ⇒ `'npm.cmd' is not recognized`（我漏了 npm 那个目录）
  //   两次我第一反应都是"这个包/脚本坏了"，**而不是"我环境缺前置"**。
  // ⇒ `doctor` 的定位正是「**只看能不能跑起来**」，而"缺前置"就是最典型的跑不起来。**它必须报这个。**
  // 【判据】doctor 的**源码**里必须真的探测 `pnpm` 与 `npm`（而不是只在文档里提一句）。
  //   ⚠️ 用**源码级**判据（本组在沙盒里跑，不能真去 spawn 外部命令 —— 会拖慢且污染）。
  {
    let src = ''
    try { src = readFileSync(join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), 'utf8') } catch { src = '' }
    // ★ **三条都要探**（`dsh` 是 R61 补的第一条：不装它，README 第①步根本无从谈起）
    const probesDsh = /name:\s*'dsh'/.test(src)
    const probesPnpm = /name:\s*'pnpm'/.test(src) && /whichOnPath\('pnpm'\)|whichOnPath\(tool\.name\)/.test(src)
    const probesNpm = /name:\s*'npm'/.test(src)
    CHECK('H21', probesDsh && probesPnpm && probesNpm,
      '★★ **`doctor` 探测 `dsh` / `pnpm` / `npm` 三条外部前置**（缺了就报，并给替代路径）',
      '不探测 ⇒ 用户第一步失败时**只看到 `\'xx\' is not recognized`**，会误判成"包坏了"（我本人撞过 pnpm 与 npm）',
      `dsh=${probesDsh} pnpm=${probesPnpm} npm=${probesNpm}`)
    // 且**缺前置时要给"不看它也能用"的替代**（否则只是报警不给路）
    // ⚠️ **判据必须限定在 `doctor()` 函数体内** —— 我第一版扫**全文**，
    //    于是 `install-teamkit.mjs` 在**别处**（R 组）出现过就让它恒绿 ⇒ **变异没判死**（当场抓到）。
    //    ⇒ 教训：**"扫源码"的判据一定要限定作用域**，否则任何别处出现过的词都会让它变成橡皮图章。
    const doctorBody = (() => {
      const i = src.indexOf('async function doctor()')
      if (i === -1) return ''
      // ⚠️ **`indexOf(x, from)` 只保证"从 from 开始找"，不会跳过 from 之前的结果** ——
      //    我第一版这么写，结果截到的是**文件开头到 doctor 之前**那 57 KB（`// ── 派发` 之前
      //    第一个 `// ──` 出现在 L46），于是 `doctorBody` 里含**整个 selftest** ⇒ 判据恒绿。
      //    ⇒ 正解：用**行级**定位（先切行，再按行号取区间）。
      const lines = src.split('\n')
      const start = lines.findIndex((l) => l.startsWith('async function doctor()'))
      if (start === -1) return ''
      let end = start + 1
      for (let k = start + 1; k < lines.length; k++) {
        if (/^(\/\/ ──|async function |function )/.test(lines[k])) {
          end = k
          break
        }
      }
      return lines.slice(start, end).join('\n')
    })()
    const givesFallback = /纯 node，不需要 npm/.test(doctorBody) && /install-teamkit\.mjs/.test(doctorBody)
    CHECK('H21', givesFallback,
      '★ 且**缺前置时给了替代路径**（纯 node 的安装器），不是只报警',
      '只报警不给路 ⇒ 用户卡在原地；给路 ⇒ 他能先跑起来',
      `${givesFallback ? '有替代路径 ✓' : 'doctor 里没有替代路径'}（doctorBody ${doctorBody.length} 字符）`)
  }

  // ── H22 · ★★ **文档里的路径必须"在用户会站的那个目录里成立"**（2026-09-14 / Round 62）──
  // 【缺陷现场】README 第②步写的是 `node node_modules/@dsh-external/dsh-teamkit/tools/install-teamkit.mjs`。
  //   **我从一个空项目目录照抄这行 ⇒ `Cannot find module`** ——
  //   因为它是**相对路径**，而 `node_modules` 只在**包被装到的那个目录**（profile 目录）里存在。
  //   ⇒ 缺的不是路径本身，是**"你要先 cd 到哪"那句话**。
  //   ⇒ 同类：`npx teamkit-install`（README 也写了）**现在必 404**（本包还没发布到 npm）。
  // 【判据】文档里出现 `node node_modules/...` 这种**相对 node_modules 路径**时，
  //   **同一节里必须有 `cd ` 或"绝对路径"的说明**（否则用户会在错的目录里跑）。
  //   并且**不许把 `npx <本包未发布的 bin>` 当作可选路径**（要么标注"发布后"）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    // ① 相对 node_modules 路径必须配 `cd`
    // ⚠️ **我第一版扫的是全文** ⇒ 第②步加的 `cd` 把**第⑥步也"顺带救"了** ⇒ 恒绿（本轮当场抓到）。
    //   ⇒ 正解：**每一处** `node node_modules/...` 的**周边 ±N 行**里都要有 `cd`/绝对路径的说明。
    const relNmLines = []
    rd.split('\n').forEach((line, i) => {
      if (/node node_modules\/@dsh-external\/dsh-teamkit/.test(line)) relNmLines.push(i)
    })
    const unContextualized = relNmLines.filter((i) => {
      const ctx = rd.split('\n').slice(Math.max(0, i - 8), i + 4).join('\n')
      return !/cd\s+["'`%]|cd ~\/\.dsh|cd "%USERPROFILE%|\$DSH_HOME|绝对路径|先 cd/.test(ctx)
    })
    CHECK('H22', unContextualized.length === 0,
      '★★ **每一处 `node node_modules/...` 的相对路径，附近都要有"先 cd"或"绝对路径"的说明**',
      '只在一处说明 ⇒ 别处的相对路径仍会让用户在自己目录里跑 ⇒ `Cannot find module`（Round 62/64 各抓到一处）',
      relNmLines.length === 0 ? '没有相对路径' : `${relNmLines.length} 处，其中 ${unContextualized.length} 处没说明`)
    const hasCd = /cd\s+["'`%]|cd ~\/\.dsh|cd "%USERPROFILE%/.test(rd)
    // ② `npx teamkit-install` 必须标"发布后"（本包未发布 ⇒ 现在 404）
    const usesNpx = /npx teamkit-install/.test(rd)
    if (usesNpx) {
      const marked = /npx teamkit-install[\s\S]{0,400}?(发布后|尚未发布|404)/.test(rd) || /(尚未发布|404)[\s\S]{0,400}?npx teamkit-install/.test(rd)
      CHECK('H22', marked,
        '★ 提到 `npx teamkit-install` 时**必须标注"本包尚未发布到 npm"**',
        '不标注 ⇒ 用户照抄 ⇒ **404**（Round 62 实测：`npm error code E404 … teamkit-install`）',
        marked ? '已标注 ✓' : '**没标注"未发布"**')
    } else {
      CHECK('H22', true, '文档里没有 `npx teamkit-install`（那更干净）', undefined, '不用 npx ✓')
    }
  }

  // ── H23 · ★★ **README 第⑤步的"验收信号"必须有一条不问日志的查法**（Round 63）──────
  // 【缺口】README 第⑤步给的四条验收信号**全是日志字样**（`ROLES-LOADED` / `ROLE-PERSONA-OK` /
  //   `FORK-REGISTER-OK` / SOUL）⇒ **用户得自己去 grep 日志**，而"日志在哪"他未必知道。
  //   `status` 当时只报**配置路径**（"会落到哪"），**不报"实际发生过没有"**。
  // ⇒ 判据：`status` 必须**现数**这四条信号的**出现次数**（而不是只让人去翻日志），
  //   且**日志读不到时报"未验证"**（不说成"没发生"）。
  {
    let src = ''
    try { src = readFileSync(join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), 'utf8') } catch { src = '' }
    // 限定在 status() 函数体内（R60 的教训：扫全文会被别处出现骗过）
    const statusBody = (() => {
      const lines = src.split('\n')
      const start = lines.findIndex((l) => l.startsWith('async function status()'))
      if (start === -1) return ''
      let end = start + 1
      for (let k = start + 1; k < lines.length; k++) {
        if (/^(\/\/ ──|async function |function )/.test(lines[k])) {
          end = k
          break
        }
      }
      return lines.slice(start, end).join('\n')
    })()
    // ⚠️ **必须先剥注释再判** —— 我第一版直接用 `statusBody`（含注释），
    //   而 `status()` 里那段**说明性注释**正好列举了这三个信号名
    //   ⇒ **把真代码删掉、注释还在 ⇒ 判据恒绿**（变异当场抓到）。
    //   ⇒ 这与 `H11`（扫到旧注释）/`H12`（扫到块注释）是**同一个坑**：**"扫源码"式判据必须剥注释**。
    const stripComments = (t) =>
      t
        .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
        .split('\n')
        .filter((l) => !l.trim().startsWith('//')) // 行注释
        .join('\n')
    const statusCode = stripComments(statusBody)
    // ⚠️ **只查"名字出现过"是不够的** —— `sig: 'ROLES-LOADED'` 这个**标签**本身就含名字，
    //   所以把 `count(/…/g)` 换成 `n: 0` 它**照样绿**（我又一次变异没判死，当场抓到）。
    //   ⇒ 判据要查**"真的在计数"**：每个信号都要有 `count(/<信号>/g)` 这种**调用**。
    const countsSigs = ['ROLES-LOADED', 'ROLE-PERSONA-OK', 'FORK-REGISTER-OK'].every((s) =>
      new RegExp(`count\\(/${s}/g\\)`).test(statusCode),
    )
    CHECK('H23', countsSigs,
      '★★ **`status` 真的在"现数"这三条信号**（有 `count(/信号/g)` 调用，不是只有名字标签）',
      '只让人翻日志 ⇒ 用户不知道日志在哪；**只在标签里出现名字 ⇒ 数字可能恒为 0（假绿）**',
      countsSigs ? '三条都有 count() 调用 ✓' : 'status() 代码里没有真正的计数调用')
    // ★ **"装上就有效果"那五件事，每件都要有入口**（Round 64 补第 3 件：上游变更通知）
    //   README 逐条列了五件事；`status` 只数了**四件** ⇒ 通知那件**没有入口**（用户只能去 grep）。
    //   ⇒ 判据：五件事对应的信号，**每一类都要有 `count(...)` 调用**。
    const fiveThings = [
      ['技能装到上游根', /count\(\/SKILLS-SYNC\/g\)/],
      ['fork 工作副本', /count\(\/FORK-REGISTER-OK\/g\)/],
      ['上游变更通知', /count\(\/NOTIFY-LISTENING\/g\)/],
      ['岗位人格段', /count\(\/ROLE-PERSONA-OK\/g\)/],
      ['SOUL 注入', /count\(\/SOUL-INJECT\/g\)/],
    ]
    const missingEntry = fiveThings.filter(([, re]) => !re.test(statusCode)).map(([n]) => n)
    CHECK('H23', missingEntry.length === 0,
      '★★ **README「装上就有效果」那五件事，每件都有 `status` 入口**（不必去 grep 日志）',
      '漏一件 ⇒ 用户以为它没工作（或根本不知道它该工作）；**通知那件我漏了一整轮**（Round 64 才补）',
      missingEntry.length === 0 ? '五件都有 count() 入口 ✓' : `缺入口：${missingEntry.join('、')}`)
    // 且：日志读不到 ⇒ 必须报"未验证"（而不是静默/说成"没发生"）
    const honorsUnreadable = /未验证/.test(statusCode) && /logText === null/.test(statusCode)
    CHECK('H23', honorsUnreadable,
      '★ 且**日志读不到时报"未验证"**（读不到 ≠ 没发生）',
      '读不到就说"没发生" ⇒ 假红：用户以为公司层没装，其实只是沙箱拒读（LANDMINES §6 同族）',
      honorsUnreadable ? '有未验证分支 ✓' : '日志读不到时没有区分')
  }

  // ── H24 · ★★ **README §命令表里的每条命令都必须真的存在**（2026-09-14 / Round 65）──
  // 【本轮怎么发现的】我照 README §命令 逐条真跑（`selftest/status/list/promote/rollback/fork-init/doctor/help`），
  //   八条**行为全对**（`help` 真不写盘；`rollback` 无快照真 exit=1；`fork-init` 干净状态下真 exit=0）——
  //   **但没有任何断言盯着这张表** ⇒ 哪天改了子命令名/删了一个，README 会**继续骗人**。
  //   （本项目已多次吃到"文档承诺 vs 实现"的亏：R47 技能没更新 / R62 路径说错 / R64 五件事漏入口。）
  // 【判据】README §命令表里 `teamkit <子命令>` 的**每一个**，都必须在 `bin/teamkit.mjs` 的**派发 switch**
  //   里有对应的 `case`。**逐条查**，不许"找到一个就算"（R64 的教训：扫全文会被别处骗过）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    let src = ''
    try { src = readFileSync(join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), 'utf8') } catch { src = '' }
    // 抽出 §命令 那节（从 `## 命令` 到下一个 `## `）
    const sec = (() => {
      const i = rd.indexOf('\n## 命令')
      if (i === -1) return ''
      const j = rd.indexOf('\n## ', i + 4)
      return j === -1 ? rd.slice(i) : rd.slice(i, j)
    })()
    const documented = [...new Set([...sec.matchAll(/^teamkit\s+([a-z][a-z-]*)/gm)].map((m) => m[1]))]
    // 派发 switch 里的 case 名（限定在 `switch (cmd)` **之后到文件尾** ——
    //   ⚠️ 我第一版只取 1500 字符 ⇒ **没抽到那条 switch**（它在文件很靠后的位置）⇒ 假红。
    //   这是"窗口写小"类的错，与 R60 的 `indexOf` 越界同族：**截取范围本身要按事实定，不能拍**。）
    const sw = (() => {
      const i = src.indexOf('switch (cmd)')
      return i === -1 ? '' : src.slice(i)
    })()
    const implemented = new Set([...sw.matchAll(/case '([a-z][a-z-]*)'/g)].map((m) => m[1]))
    const undoc = documented.filter((c) => !implemented.has(c))
    CHECK('H24', documented.length >= 5 && undoc.length === 0,
      '★★ **README §命令表里的每条命令，在 `bin/teamkit.mjs` 的派发里都有对应 `case`**',
      '文档写了实现没有 ⇒ 用户照着敲**直接报 unknown command**（本项目已多次吃到"文档承诺 vs 实现"的亏）',
      documented.length === 0
        ? '**没抽到命令**（§命令 的格式变了？—— 那本身也是缺陷）'
        : `${documented.length} 条：${documented.join(', ')}${undoc.length > 0 ? `  ⇒ **缺实现：${undoc.join(', ')}**` : ' ⇒ 全部有实现 ✓'}`)
  }

  // ── H25 · ★★ **schema 里可配的每个顶层键，都要在 README §配置表里有行**（Round 66）──
  // 【本轮怎么发现的】把 `config.js` 的 `DEFAULTS` 顶层键与 README §配置表**对照**，抓到：
  //   `roles` 与 `principles` —— **两个都是 `SHAPE` 里被校验的顶级可配键**，
  //   而 §配置表**一行都没有**（只在正文里顺带提了一句 `roles.dir`）。
  //   ⇒ 它们是**公司层的两个关键目录**（角色档 / 自演化位）—— 恰恰是 R42 那条教训
  //     「**凡是"读资产"的指令，判据必须是"它在用户机器上的绝对路径"**」里最容易配错的东西。
  // 【判据】`DEFAULTS` 的**每个顶层键**，都要能在 README §配置表的第一列找到（`| \`<key>...\``）。
  //   逐键查（不许"找到一个就算" —— R64 的教训）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    let cfg = ''
    try { cfg = readFileSync(join(PLUGIN_DIR, 'lib', 'config.js'), 'utf8') } catch { cfg = '' }
    const defaultsBlock = (() => {
      const m = /export const DEFAULTS = \{([\s\S]*?)\n\}/.exec(cfg)
      return m === null ? '' : m[1]
    })()
    const topKeys = [...defaultsBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm)].map((m) => m[1])
    // 配置表第一列的键（形如 `| \`fork.enabled\` |`）；取点号前的顶层名
    const docTop = new Set(
      [...rd.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9.]*)`/gm)].map((m) => m[1].split('.')[0]),
    )
    const missing = topKeys.filter((k) => !docTop.has(k))
    CHECK('H25', topKeys.length >= 8 && missing.length === 0,
      '★★ **`config.js` 里可配的每个顶层键，README §配置表都有行**（用户才知道能配、默认是什么）',
      '实现了可配却不在表里 ⇒ 用户**不知道能配**；而 `roles.dir`/`principles.dir` 正是最容易配错的两个（R42 同族）',
      topKeys.length === 0
        ? '**没抽到 DEFAULTS 顶层键**（格式变了？）'
        : `${topKeys.length} 个顶层键${missing.length > 0 ? ` ⇒ **缺行：${missing.join(', ')}**` : ' ⇒ 全部有行 ✓'}`)
  }

  // ── H26 · ★★ **README §目录结构 的树，要跟得上实际文件**（2026-09-14 / Round 67）────
  // 【本轮怎么发现的】把 §目录结构 的树与实际目录对照，抓到它**漏了 6 个 `lib/`、2 个 `scripts/`、
  //   整个 `tools/` 与 `assets/`** —— 因为**每加一个模块都没回头更新它**：
  //   `roles.js` / `release.js` / `release-tools.js` / `soul.js` / `self-write.js`（R33–R49 加的）全不在。
  //   而 §目录结构 是**新读者（尤其想贡献的人）理解"东西在哪"的第一张图**。
  // 【判据】`lib/` 与 `scripts/` 里的**每个文件**都必须在那棵树里出现（**逐文件查**）。
  //   ⚠️ 只查这两个目录：`bin/` 只有一个入口、`assets/` 是生成的、`skills/` 是同步副本 ——
  //     那些列在树里但不必逐文件（`assets/` 的检查由 `H4` 那组管同步漂移）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    const tree = (() => {
      const i = rd.indexOf('## 目录结构')
      if (i === -1) return ''
      const j = rd.indexOf('## 许可', i)
      return j === -1 ? rd.slice(i) : rd.slice(i, j)
    })()
    const missing = []
    for (const dir of ['lib', 'scripts']) {
      let files = []
      try {
        files = readdirSync(join(PLUGIN_DIR, dir)).filter((f) => !f.startsWith('.'))
      } catch {
        files = []
      }
      for (const f of files) if (!tree.includes(f)) missing.push(`${dir}/${f}`)
    }
    CHECK('H26', tree !== '' && missing.length === 0,
      '★★ **README §目录结构 跟得上实际文件**（`lib/` 与 `scripts/` 逐文件查）',
      '树落后 ⇒ 新读者（尤其想贡献的人）**看不到一半的模块**；每加一个模块都会让它更假（实测漏了 6 个）',
      tree === '' ? '**没找到 §目录结构**（标题变了？）' : missing.length === 0 ? 'lib/ + scripts/ 全部在树里 ✓' : `**树里缺：${missing.join(', ')}**`)
  }

  // ── H27 · ★★ **§限制 必须覆盖"装完才会发现"的那几条**（2026-09-14 / Round 67）──────
  // 【本轮怎么发现的】§限制 当时有 6 条，都是真的；但**缺了两条我实测过、且属于"装了才发现"的**：
  //   · **沙箱**：组织资产在 `$DSH_HOME`（工作区外）⇒ 成员用内置 `write` **会被拒**
  //     （`[sandbox: file access denied under workspace-write mode]`）——**这正是 `read_self`/`write_self` 存在的理由**；
  //   · **`fork-init` 只作用全局 fork 根**（离线路径拿不到 agent cwd）—— 播种可能"对不上"它实际读的目录。
  //   两条都只在**§命令/§运行时工具**里顺带提过，**没进"开源必读"那张表**。
  // 【判据】这两条"硬限制"必须在 §限制 节里出现（**逐条查**）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    const lim = (() => {
      const i = rd.indexOf('\n## 限制')
      if (i === -1) return ''
      const j = rd.indexOf('\n## ', i + 4)
      return j === -1 ? rd.slice(i) : rd.slice(i, j)
    })()
    const must = [
      ['沙箱拒写 $DSH_HOME', /sandbox|沙箱/],
      ['fork-init 只作用全局', /fork-init/],
    ]
    const missingLim = must.filter(([, re]) => !re.test(lim)).map(([n]) => n)
    CHECK('H27', lim !== '' && missingLim.length === 0,
      '★★ **§限制 覆盖了"装了才发现"的两条硬限制**（沙箱拒写 / `fork-init` 只作用全局）',
      '只写在别的节里 ⇒ 用户按"开源必读"那张表读完，**仍会踩到**（这正是那些限制该在这里的理由）',
      lim === '' ? '**没找到 §限制**（标题变了？）' : missingLim.length === 0 ? '两条都在 §限制 里 ✓' : `**§限制 缺：${missingLim.join('、')}**`)
  }

  // ── H29 · ★★ **每个校验器都要被"总入口"接上**（2026-09-14 / Round 70）────────────
  // 【本轮怎么发现的】数了一下我每轮收尾手跑的命令：**6~7 条**
  //   （`selftest` / `e2e-tarball` / `sync-*2` / `check-c3-closure` / `check-perf-cycle` / `verify-handoff`）——
  //   **而它们被谁调用过？一个都没有**（`package.json` 里没有聚合入口，也没有脚本引用它们）。
  //   ⇒ **全靠我记得跑**；**漏跑一条不会有任何信号** —— 与 R69（判据恒红没人看）、
  //     R47（技能没更新没人报）**同一族**：**做出来了，但没有任何机械动作去用它。**
  // 【本轮修法】新增**总入口** `tools/check-all.mjs`（一条命令跑全部，给**一个总退出码**）。
  // 【判据】仓里**每个** `check-*.mjs` 都必须在总入口的 `SUITES` 清单里出现（**逐文件查**）。
  {
    let allSrc = ''
    try { allSrc = readFileSync(join(PLUGIN_DIR, '..', 'tools', 'check-all.mjs'), 'utf8') } catch { allSrc = '' }
    if (allSrc === '') {
      CHECK('H29', null, '总入口 `tools/check-all.mjs` 读不到 ⇒ 未验证', '它在**仓根** `tools/` 下（不在包里）')
    } else {
      const checkerDirs = [join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'tools'), join(PLUGIN_DIR, '..', 'tools')]
      // ══════════════════════════════════════════════════════════════════════════
      // ★★★ **2026-09-18 扩：从"名字出现在总入口里" ⇒ "真有一个调用者文件引用它"**
      // ```
      // 【为什么扩（CEO 抓到 `check-remote-blob` 没接上）】
      //   原实现：`const wired = allSrc`（把 `check-all.mjs` 全文当一个字符串）
      //     ⇒ 判据是 `allSrc.includes(f)` ⇒ ★★ **只要那个文件名【在注释里出现过】就算"接上了"**
      //   ⇒ ⚠️ 而那是**白名单形状的洞**：只要在 `check-all.mjs` 里写一句注释提到某个脚本名
      //     ⇒ **`H29` 当场变绿，而那个脚本仍然没人跑**。
      // 【修法（两条一起）】
      //   ① **总入口**（`check-all.mjs` 的 `SUITES`）⇒ 仍算"已接上"（它**真的会跑**）
      //   ② ★ 否则 ⇒ **必须有一个【别的文件】真的把它当脚本调用**
      //      （在该文件里找 `xxx.mjs` 引用，**排除自引用**）
      //      ⇒ 找不到 ⇒ **照样报红**（**不是白名单：调用关系必须能被验证**）
      // ```
      const repoRoot = join(PLUGIN_DIR, '..')
      /** ★ 找"哪些【别的】 .mjs 引用了 `name`"（排除它自己 ⇒ 自引用不算调用者） */
      const callersOf = (name) => {
        const found = []
        const scan = (dir) => {
          let es = []
          try {
            es = readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of es) {
            if (e.name === 'node_modules' || e.name === '.git') continue
            const p = join(dir, e.name)
            if (e.isDirectory()) scan(p)
            else if (e.name.endsWith('.mjs') && e.name !== name) {
              try {
                if (readFileSync(p, 'utf8').includes(name)) found.push(relative(repoRoot, p).split('\\').join('/'))
              } catch { /* skip */ }
            }
          }
        }
        scan(join(repoRoot, 'tools'))
        scan(join(repoRoot, 'plugin', 'tools'))
        scan(join(repoRoot, 'plugin', 'scripts'))
        return found
      }
      const unwired = []
      const viaCaller = []
      for (const d of checkerDirs) {
        let files = []
        try {
          // ★★ **2026-09-15 扩范围（CEO 实读本行抓到的洞）**：原来只有 `/^check-.*\.mjs$/`
          // ```
          // 现场：我新写了 `tools/verify-shipped-roles.mjs`（**用户视角的发货态校验**）——
          //   ★ **它不匹配 `check-*`** ⇒ **本断言扫不到它** ⇒ 它**没接进 `check-all`**
          //     ⇒ 而 **`H29` 照旧报 `OK … 全部已接上总入口 ✓`** —— ★ **绿着，但那个脚本没人跑**
          //   ⇒ ★★ **这正是 `H29` 自己警告的那个洞，换了个入口**：
          //      "做出来了，但没有任何机械动作去用它" —— **这次是"闸门自己的扫描范围"有洞**。
          //      ⚠️ **闸门的洞，人是看不见的**（因为 `H29` 报绿）。
          //   ⚠️ 佐证"靠人记"的老路回来了：`verify-handoff.mjs` 是**手工**接进 `check-all` 的。
          // ⇒ 判据扩到 **`check-*.mjs` + `verify-*.mjs`**（两类都是"机械校验器"）。
          //   能红的判据：**造一个未接总入口的 `verify-*.mjs` ⇒ 本断言必须报红**（见注释末）。
          // ```
          files = readdirSync(d).filter((f) => /^(check|verify)-.*\.mjs$/.test(f))
        } catch {
          files = []
        }
        for (const f of files) {
          if (allSrc.includes(f)) continue // ① 总入口真会跑它
          // ② ★ 否则：必须有【别的文件】真调用它（**排除自引用** —— 否则"自己提到自己"就算数）
          const cs = callersOf(f)
          if (cs.length > 0) viaCaller.push(`${f}←${cs[0]}`)
          else unwired.push(f)
        }
      }
      CHECK('H29', unwired.length === 0,
        '★★ **仓里每个 `check-*.mjs` / `verify-*.mjs` 都被"总入口"【或某个调用者】接上了**',
        '没接上 ⇒ **漏跑不会有任何信号**（与 R47/R69 同族："做出来了，但没有机械动作去用它"）' +
          '；★ **不是白名单**：在 `check-all.mjs` 里用注释提到名字**不算** —— 必须有【别的文件】真引用它',
        unwired.length === 0
          ? `全部已接上 ✓${viaCaller.length > 0 ? `（${viaCaller.length} 个由别的脚本调用：${viaCaller.slice(0, 3).join(' · ')}）` : ''}`
          : `**没接上：${unwired.join(', ')}**`)
    }
  }

  // ── H30 · ★★ **`ENV` 表里"声明了但没人读"的变量必须显式标注**（Round 73）────────
  // 【本轮怎么发现的】我逐个真试 `ENV` 表里那 6 个变量 —— `DSH_AGENTS_HOME` **怎么设都没反应**。
  //   去查调用点 ⇒ **`ENV.agentsHome` 在整包里只出现 1 次**（就是它自己那行声明）：
  //   ```js
  //   agentsHome: 'DSH_AGENTS_HOME',   // ← 全包唯一出现处；没人 process.env[ENV.agentsHome]
  //   ```
  //   ⇒ 我**第一次读那张表时也以为六个都在用**（"列在这里是为了单点可查"这句话**鼓励了这个误读**）。
  //   ⚠️ **它本身不是 bug**（`DSH_AGENTS_HOME` 是 **DSH 原生**的技能根 rank 500，本插件不需要算它）——
  //     但**"声明了却不标明没人用"会制造假能力**（同族：R19 `tools` 字段零效果 / R71 枚举没管）。
  // 【判据】`ENV` 表里**每个**变量，要么在代码里**真有调用点**（`ENV.<k>` 出现在声明之外），
  //   要么**在它那一行的注释/文档里显式说"没人读"** —— **不许两者都没有**。
  {
    let cfg = ''
    try { cfg = readFileSync(join(PLUGIN_DIR, 'lib', 'config.js'), 'utf8') } catch { cfg = '' }
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    const envBlock = (() => {
      const m = /export const ENV = \{([\s\S]*?)\n\}/.exec(cfg)
      return m === null ? '' : m[1]
    })()
    const envKeys = [...envBlock.matchAll(/^\s{2}([a-zA-Z]+):\s*'([A-Z_]+)'/gm)].map((m) => ({ key: m[1], name: m[2] }))
    const unread = []
    for (const { key, name } of envKeys) {
      // 调用点：**除了"声明那一行"以外**还出现过 `ENV.<key>`
      // ⚠️ **必须把"声明行"排除掉**（我第一版没排 ⇒ `agentsHome` 明明没人读却数出 2 次 ⇒ 判据恒绿，
      //   直到变异测试打歪才暴露）。判据：**逐行看**，跳过 `ENV = {` 到 `}` 之间的那些行。
      const declStart = cfg.indexOf('export const ENV = {')
      const declEnd = cfg.indexOf('\n}', declStart)
      const declaredKeys = new Set(
        [...cfg.slice(declStart, declEnd).matchAll(/^\s{2}[a-zA-Z]+:\s*'[A-Z_]+'/gm)].length > 0
          ? envKeys.map((k) => k.key)
          : [],
      )
      const countIn = (text) => {
        // ⚠️⚠️ **必须先剥注释** —— 我这一版又栽在这里：**H30 自己的注释里引述了 `ENV.agentsHome`**
        //   （"它在整包里只出现 1 次（就是它自己那行声明）"）⇒ 计数器把那句注释**当成调用点** ⇒ 判据恒绿。
        //   ⇒ 这是 **H14 / H18 / R71 的第 4 次同款**：**"扫源码"式判据必须剥注释**（且要**归一化 CRLF**）。
        const stripped = text
          .replace(/\r\n/g, '\n')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
          .join('\n')
        let n = 0
        for (const line of stripped.split('\n')) {
          // 跳过 ENV 表内部的行（声明本身不算"被读"）
          if (/^\s{2}[a-zA-Z]+:\s*'[A-Z_]+',?\s*$/.test(line)) continue
          n += [...line.matchAll(new RegExp(`ENV\\.${key}\\b`, 'g'))].length
        }
        return n
      }
      let realUses = countIn(cfg)
      for (const d of ['lib', 'bin', 'scripts', 'tools']) {
        try {
          for (const f of readdirSync(join(PLUGIN_DIR, d))) {
            if (!/\.(m?js)$/.test(f)) continue
            realUses += countIn(readFileSync(join(PLUGIN_DIR, d, f), 'utf8'))
          }
        } catch {
          /* 目录不在就算了 */
        }
      }
      if (realUses > 0) continue
      // 没人读 ⇒ 必须"说清楚"（config 的注释里 或 README 的表里 提到"不读/没人读"）
      const explained = new RegExp(`${name}[^\\n]{0,80}(不读|没人读|不由本插件|本插件不读)`).test(cfg + '\n' + rd)
      if (!explained) unread.push(`${key}(${name})`)
    }
    CHECK('H30', envKeys.length >= 4 && unread.length === 0,
      '★★ **`ENV` 表里"声明了但没人读"的变量都被显式标注**（不许制造假能力）',
      '声明了没人读、又不说明 ⇒ 读表的人**以为它在生效**（我这次就以为六个都在用；同族 R19/R71）',
      envKeys.length === 0
        ? '**没抽到 ENV 表**（格式变了？）'
        : unread.length === 0
          ? `${envKeys.length} 个变量：有调用的有调用、没人读的已标注 ✓`
          : `**未标注又没人读：${unread.join(', ')}**`)
  }

  // ── H31 · ★★ **`omc` 预设的首行必须自称 `omc`**（2026-09-14 / Round 74）──────────
  // 【缺陷现场】`presets/omc/agent.cordis.yml` 是**从官方 `standard` 派生**的（照抄基线再插一条
  //   `@dsh-external/dsh-teamkit`）—— 而它的**首行原来是 `standard` 原文**：
  //   > `# The \`standard\` agent preset: the full coding agent, mounted once per process.`
  //   ⇒ **维护者打开 `omc` 会以为看错了文件**；而这段头注释**恰恰是"这个文件是什么"的唯一说明**。
  //   ⚠️ 更要紧的是它**掩盖了派生关系**（读者不知道"其余每个字节与 standard 一致"这条承诺）。
  // 【判据】该文件**首行**必须提到 `omc`（自称），且**必须显式提到它是从 `standard` 派生的**
  //   （派生关系是"其它预设不受影响"那条承诺的依据 —— 不写，读者无法核对）。
  {
    const f = join(PLUGIN_DIR, '..', 'presets', 'omc', 'agent.cordis.yml')
    let t = ''
    try { t = readFileSync(f, 'utf8') } catch { t = '' }
    const firstLine = t.split('\n')[0] ?? ''
    CHECK('H31', /`omc`/.test(firstLine),
      '★★ **`omc` 预设的首行自称 `omc`**（不是 `standard` 原文）',
      '首行写着 "The `standard` agent preset" ⇒ 维护者以为看错文件；且**头注释是"这文件是什么"的唯一说明**',
      t === '' ? '**文件读不到**' : `首行：${firstLine.slice(0, 78)}`)
    // 派生关系必须写明（它是"其它预设不受影响"的依据）
    const head = t.slice(0, t.indexOf('- id:')).slice(0, 3000)
    const saysDerived = /从.*`standard`.*派生|派生|derived/i.test(head)
    CHECK('H31', saysDerived,
      '★ 且**头注释写明"它从 `standard` 派生"**（"其余字节一致、别的预设不受影响"的依据）',
      '不写派生关系 ⇒ 读者无法核对"只加了 teamkit 一行"这条承诺（委托方口径"其它 preset 不受影响"就没法验）',
      saysDerived ? '写明了 ✓' : '**没写派生关系**')
  }

  // ── H32 · ★★ **安装器必须"prune 掉上次装进去、这次不该在"的角色目录**（Round 75）──
  // 【缺陷现场】R26 修了"**不再拷贝** `roles/A/`"（判据 = 有没有同名 `.json` 角色档），
  //   **但没删掉已经装进去的那一份** ⇒ 真机 `$DSH_HOME/teamkit/roles/` 里**至今还躺着 `A/`**
  //   （我实测 `A 目录存在: True`，且与仓内逐字节一致）
  //   ⇒ 用户看到的正是 R26 注释里说的那个**"幽灵角色"**（没岗位档案、却带一条技能）。
  //   ⚠️ **"不再装" ≠ "已经装过的会自己消失"** —— 二者是两件事，而我只做了前者。
  // 【判据】安装器源码里必须有 **prune 逻辑**（装完后对账真机目录、删掉不在 roleIds 里的）。
  //   仅查"有没有那条循环"（源码级，不跑真装 —— 那会动真机）。
  {
    const inst = (() => { try { return readFileSync(join(PLUGIN_DIR, '..', 'tools', 'install-teamkit.mjs'), 'utf8') } catch { return '' } })()
    const hasPrune = /prunedRoles/.test(inst) && /readdirSync\(ROLES_DST/.test(inst)
    CHECK('H32', hasPrune,
      '★★ **安装器会 prune 掉"上次装进去、这次不该在"的角色目录**（`A/` 那种幽灵）',
      '"不再装" ≠ "旧的会自己消失" ⇒ 老用户机器上会**永远留着**已经不该分发的目录（R26 修了一半；R75 补另一半）',
      hasPrune ? '有 prune 逻辑 ✓' : '**没有 prune**（只做了"不再拷贝"）')
    // 且**不许静默**（删了要打印）
    const saysPruned = /清掉\*\*上次装进去/.test(inst)
    CHECK('H32', saysPruned,
      '★ 且**删了要打印**（不静默）',
      '静默删 ⇒ 用户不知道自己的目录被动过（本插件全局纪律：失败/动作都不静默）',
      saysPruned ? '有打印 ✓' : '**删了不打印**')
    // ★★ **`talents/` 要按"标记制"prune，且不许碰用户写的东西**（2026-09-14 / Round 76）──
    // 【缺陷现场】`talents/` 原来**只补不删**（与 R75 那个 `roles/A/` 同族）：
    //   我往真机造一个仓里没有的 `zz-orphan.md` ⇒ 重装后**它还在**。
    //   更糟的是 `--uninstall` 那段是 `rmSync(TALENTS_DST,{recursive:true})` —— **整目录删**，
    //   会连**用户自己现写的 Talent**（`TALENTS.yml` 教他们这么干）与**成员复盘写的 `principles/`** 一起删。
    // 【为什么不照抄 `roles/` 的按名单 prune】那会**盲删用户的东西** ——
    //   `roles/` 是"岗位档案"（只能我们装），而 **`talents/` 用户会往里加**（索引里明说"缺口就现写一份落盘"）。
    // ⇒ 正解 = **标记制**：装时盖 `.teamkit-<完整文件名>`，prune 只认**有标记且不在名单**的；
    //   **`principles/` 永不 prune**（那是用户/成员写的）。
    // 【判据】源码里必须有：① `talentMarkFor`（标记制）；② 标记用**完整文件名**；
    //   ③ `--uninstall` 里 `talents` 是**逐份认领**（不是整目录 rmSync）。
    {
      const usesMarker = /talentMarkFor/.test(inst) && /\.teamkit-\$\{f\}/.test(inst)
      CHECK('H32', usesMarker,
        '★★ **`talents/` 用"标记制"prune**（`.teamkit-<完整文件名>`），不是按名单盲删',
        '按名单盲删 ⇒ **会删掉用户自己现写的 Talent**（`TALENTS.yml` 明说"缺口就现写一份落盘"）；' +
          '不 prune ⇒ 又留孤儿（`roles/A/` 同族）⇒ **只有标记制两头都对**',
        usesMarker ? '标记制 ✓' : '**没有标记制**')
      // `--uninstall` 不许**无条件**整目录 rmSync talents
      // ⚠️ **两处必须排除**（我第一版都撞了，与 R73/R71 同款）：
      //   ① **注释里引述的旧写法**（我自己在注释里写了 `rmSync(TALENTS_DST,{recursive:true})` 作对照）
      //      ⇒ **必须先剥注释**；
      //   ② **"空了才删目录"是合法的**（`if (readdirSync(TALENTS_DST).length === 0) rmSync(...)`）——
      //      那正是"保护用户文件"的实现 ⇒ **只抓"无条件删"**（该行不含 `length === 0` / `readdirSync` 条件）。
      const uninstCode = inst
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      const uninstallsWholeTalents = uninstCode
        .split('\n')
        .some((l) => /rmSync\(TALENTS_DST,\s*\{\s*recursive:\s*true/.test(l) && !/length === 0/.test(l))
      CHECK('H32', !uninstallsWholeTalents,
        '★★ **`--uninstall` 不**无条件**整目录删 `talents/`**（那会删掉用户写的 Talent 与 `principles/`）',
        '无条件整目录删 ⇒ **卸载一次 = 用户的 Talent 与成员写的原则全没**（比"留孤儿"严重得多）',
        uninstallsWholeTalents ? '**仍有无条件整目录删**' : '逐份认领（只在空了才删目录）✓')
      // `principles/` 必须"只补缺不覆盖"
      const protectsPrinciples = /只补缺、不覆盖/.test(inst) && /principles/.test(inst)
      CHECK('H32', protectsPrinciples,
        '★ 且 **`principles/` 只补缺、不覆盖**（那是用户/成员复盘写出来的）',
        '覆盖 principles ⇒ 抹掉成员的自我迭代记录（本插件的 SOUL/原则自演化就靠它）',
        protectsPrinciples ? '只补缺 ✓' : '**会覆盖 principles**')
    }
  }

  // ── H33 · ★★ **安装器的 `--help` 必须"只打印、不写盘"**（2026-09-14 / Round 77）──
  // 【缺陷现场】这个安装器**跑到 `--help` 就真的去装了**（实测：我打 `--help`，它印的是安装输出）
  //   ⇒ 用户想"先看看有哪些开关"，**结果直接改了系统** ——
  //   与 `LANDMINES §7` 记的那次事故**同族**（"一个生成器脚本因为不看参数就 `rm -rf`"）。
  //   而且它**没有参数表**：3 个开关只在 README 里，**命令自己的 `--help` 看不到**。
  // 【判据】源码里必须有 `--help` 分支，且它**在一切写盘动作之前就 `process.exit(0)`**。
  //   ⚠️ 用**源码级 + 位置**判据（不真跑 —— 那会动盘；虽然可以用 `DSH_HOME` 定向，但源码判据更稳）。
  {
    const inst = (() => { try { return readFileSync(join(PLUGIN_DIR, '..', 'tools', 'install-teamkit.mjs'), 'utf8') } catch { return '' } })()
    const helpIdx = inst.indexOf("process.argv.includes('--help')")
    // 第一个"写盘动作"出现的位置（mkdirSync / cpSync / rmSync / writeFileSync）
    const firstWrite = (() => {
      const cands = ['mkdirSync(', 'cpSync(', 'rmSync(', 'writeFileSync(']
        .map((k) => inst.indexOf(k))
        .filter((i) => i > 0)
      return cands.length === 0 ? -1 : Math.min(...cands)
    })()
    CHECK('H33', helpIdx > 0 && (firstWrite < 0 || helpIdx < firstWrite),
      '★★ **安装器的 `--help` 在"任何写盘动作之前"就 return**（只打印、不写盘）',
      '`--help` 却真去装 ⇒ 用户"只想看看开关"就改了系统（`LANDMINES §7` 同族：脚本不看参数就动手）',
      helpIdx < 0 ? '**没有 --help 分支**' : helpIdx < firstWrite ? '在首次写盘之前 ✓' : `**--help 在写盘之后**（help@${helpIdx} write@${firstWrite}）`)
    // 且它要把 3 个开关与 $DSH_HOME 的安全测试法**印出来**（否则等于没有文档）
    const documents = ['--check', '--uninstall', '--force', 'DSH_HOME'].every((k) => inst.includes(k))
    CHECK('H33', documents,
      '★ 且**参数表与 `$DSH_HOME` 安全测试法都印在 `--help` 里**',
      '开关只在 README 里 ⇒ 命令自己是"黑盒"；而 `$DSH_HOME` 定向是**唯一安全的破坏性测试姿势**（R76 的事故就因为没有它）',
      documents ? '4 项都在 ✓' : '**参数/环境变量没印全**')
  }

  // ── H34 · ★★ **CLI 的退出码必须"说真话"**（2026-09-14 / Round 78）─────────────
  // 【本轮抓到两个】都在 `bin/teamkit.mjs`：
  //   ① **`--version` 不被支持** ⇒ 落进 `default` 报"未知子命令"
  //      ⇒ **开源用户报 bug 时说不出自己装的是哪一版**（北极星"越好装越好"的直接缺口）；
  //   ② **无参数 ⇒ `exit 0`**，而**根因在 `const cmd = argv[0] ?? 'help'`** ——
  //      那个 `?? 'help'` 兜底让 `case undefined:` **永远进不去**（我加了那个 case 也没用，查了三遍）。
  //      ⇒ 无参数**不是"请求帮助"**：脚本/CI 里它**什么都不干却返回 0**（看起来成功了）。
  //      对照 `git`/`npm`：无参数 ⇒ 用法 + **退出码 1**。
  // 【判据】源码里必须：① 有 `--version` 的 case；② **`cmd` 不加 `?? 'help'` 兜底**
  //   （否则"没给子命令"无法与"显式 help"区分）；③ `case undefined:` 要 `process.exit(1)`。
  {
    let src = ''
    try { src = readFileSync(join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), 'utf8') } catch { src = '' }
    // ★★ **改成真的跑一次 `--version`**（2026-09-14 / Round 78 当场改进）。
    // 【为什么不用源码正则】我第一版写的是 `/case '--version':/.test(src)` ——
    //   **而那个正则字面量本身就在 `src` 里**（这条判据写在同一个文件里！）
    //   ⇒ 变异测试把两处 `case '--version':` 都改掉后，**判据仍然绿**（正则去匹配被改过的自己，
    //     而"被改过的自己"里正好也有改后的字串）—— **自指陷阱**。
    //   ⇒ **能跑就真跑**：`spawnSync` 自己、跑 `--version`、判 **exit 0 且输出里有版本号**。
    //     这是**行为判据**，不受"源码里怎么写/我引述了它"影响（本项目的既有偏向：能测行为就别测文本）。
    const vr = spawnSync(process.execPath, [join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), '--version'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    })
    const vOut = String(vr.stdout ?? '')
    const pkgVer = (() => {
      try {
        return JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version ?? ''
      } catch {
        return ''
      }
    })()
    const versionWorks = vr.status === 0 && pkgVer !== '' && vOut.includes(pkgVer)
    CHECK('H34', versionWorks,
      '★★ **跑 `--version` 真的报出版本号**（exit 0 且输出含 `package.json` 的 version）—— 开源用户报 bug 时能说清装的哪一版',
      '不支持/报错 ⇒ `--version` 被当成"未知子命令"；而 `package.json` 里明明有 `version`（北极星：装完能自查）',
      versionWorks ? `exit=0 且含 ${pkgVer} ✓` : `exit=${vr.status} 输出=${JSON.stringify(vOut.slice(0, 60))} pkgVer=${JSON.stringify(pkgVer)}`)
    // ② `?? 'help'` 兜底必须不存在
    // ⚠️ **必须先剥注释** —— 我又栽了第 5 次：**我自己的更正注释里引述了 `?? 'help'`**
    //   （"根因在 `const cmd = argv[0] ?? 'help'`"）⇒ 断言恒红。
    //   （前四次：`H14`/`H18`/R71/R73。⇒ 剥注释已是**肌肉记忆级**的必做动作。）
    const srcCode = src
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    const hasHelpFallback = /argv\[0\]\s*\?\?\s*'help'/.test(srcCode)
    CHECK('H34', !hasHelpFallback,
      '★★ **`cmd` 不加 `?? \'help\'` 兜底**（否则"没给子命令"永远走不到 `case undefined:`）',
      '兜底成 help ⇒ **无参数 ≡ 显式 help** ⇒ 加了 `case undefined:` 也**进不去**（R78 实测：查三遍才发现）',
      hasHelpFallback ? '**仍有 `?? \'help\'` 兜底**' : '无兜底 ✓')
    // ③ 无参数必须 exit 1
    const undefIdx = src.indexOf('case undefined:')
    const undefExit = undefIdx > 0 && /process\.exit\(1\)/.test(src.slice(undefIdx, undefIdx + 400))
    CHECK('H34', undefExit,
      '★ 且 **`case undefined:` 明确 `process.exit(1)`**（无参数不是成功）',
      '无参数 exit 0 ⇒ 脚本/CI 里"什么都没干"**看起来成功了**（同族：R69 判据恒红 / R73 声明了没人读）',
      undefExit ? 'exit(1) ✓' : '**无参数没有 exit(1)**')
  }

  // ── H35 · ★★ **README 里引用的"底座文件:行号"，那个文件必须真在那儿**（Round 79）──
  // 【本轮怎么发现的】README「限制」节有 8 处 `roster.js:243` 这类引用 —— 我逐条去核：
  //   **行号本身是对的**，但 **7 处漏了 `types/` 前缀** ⇒
  //   读者去 `lib/roster.js` grep **找不到文件**（真实路径是 `lib/types/roster.js`）。
  //   另有 **1 处引用指错了文件**：写 `invariant.js:353` 说"名字复用被它拒"，
  //   而那儿是 `session/event` 的**总钩子**（`invariant.js:349-356`），**不专门管名字唯一性**；
  //   真正抛 `TEAM_MEMBER_NAME_TAKEN` 的是 **`types/roster.js:244`**。
  // 【判据】README 里每个 `xxx.js:NN` / `xxx.d.ts:NN` 式引用，**不查行号**（那会随上游变），
  //   只查**那个文件在底座里真实存在**（在 `dsh-experimental-agent-team/lib` 下递归找，允许 `types/` 前缀）。
  //   ⚠️ **不存在的文件 = 读者永远找不到** ⇒ 那是"引用已烂"，必须有信号（R58 数字漂移的同族）。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    // 底座 lib 根：从运行者的 profile 里找（本插件的 peerDep）
    const agentTeamLib = (() => {
      const home = process.env.DSH_HOME ?? ''
      if (home === '') return ''
      const cand = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-experimental-agent-team', 'lib')
      return existsSync(cand) ? cand : ''
    })()
    if (agentTeamLib === '') {
      CHECK('H35', null, 'README 的底座引用可核（`dsh-experimental-agent-team/lib`）',
        '**未验证**：这跑拿不到 `$DSH_HOME/profiles/web/...` ⇒ 不猜、不假装', '拿不到底座 lib 目录')
    } else {
      // 抽出所有 `xxx.js:NN` / `xxx.d.ts:NN` 引用。
      // ⚠️ **正则要允许 `/`**（我第一版写成 `[a-zA-Z0-9_.-]+` ⇒ **含 `types/` 的引用全被漏掉**，
      //   只抽到 4 条裸引用 —— 而**裸引用恰恰是要抓的那一类**！⇒ 变异测试因此没判死，
      //   我顺着查才发现"抽得太少"。**判据本身的范围要够宽**（R24 同族：范围写窄 = 漏检）。
      // ⚠️ 另：**`（判据：…）` 里引述的旧写法**（`roster.js:243`）也会被抽到 ——
      //   **那是"引述"，不是"在用"** ⇒ 这里**只取文件名做存在性检查**，
      //   而 `roster.js` 与 `types/roster.js` 指同一个文件 ⇒ **引述不会造成假红**（也不必剥注释）。
      const refs = [...new Set([...rd.matchAll(/`((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:js|ts)):\d+/g)].map((m) => m[1]))]
      // 本插件自己的 lib（`upstream.js` 那种）不算底座引用
      const mine = new Set(
        (() => {
          try {
            return readdirSync(join(PLUGIN_DIR, 'lib')).filter((f) => /\.(js|ts)$/.test(f))
          } catch {
            return []
          }
        })(),
      )
      const notFound = []
      for (const r of refs) {
        // ⚠️ 引用可能带路径（`types/roster.js`）也可能不带（`roster.js`）⇒ **一律按 basename 比**
        //   （这也让"注释里引述的旧写法"不会造成假红 —— 它们指向同一个文件）。
        const base = r.split('/').pop()
        if (mine.has(base)) continue
        // 递归找同名文件（允许在 types/ 下）
        let hit = false
        const walk = (d, depth) => {
          if (hit || depth > 3) return
          let es = []
          try {
            es = readdirSync(d, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of es) {
            if (hit) return
            if (e.isDirectory()) walk(join(d, e.name), depth + 1)
            else if (e.name === base) hit = true
          }
        }
        walk(agentTeamLib, 0)
        if (!hit) notFound.push(r)
      }
      CHECK('H35', refs.length > 0 && notFound.length === 0,
        '★★ **README 引用的每个底座文件都真实存在**（行号不查——那会随上游变；**文件必须能找到**）',
        '文件不存在 ⇒ 读者**按图索骥找不到**（R79 实测：7 处漏 `types/` 前缀）；同族 R58 数字漂移',
        refs.length === 0 ? '**没抽到底座引用**（格式变了？）' : notFound.length === 0 ? `${refs.length} 处引用全部能找到文件 ✓` : `**找不到：${notFound.join(', ')}**`)
    }
  }

  // ── H36 · ★★★ **`tryMembership` 的"伪 lead 行"不许被当成真 Lead**（Round 80）──────
  // 【本轮抓到的真缺陷 —— 两处，其中一处在 guard 里，等于**护栏失效**】
  // 底座 `types/roster.js` 有**两处**返回 `{role:'lead', name:'lead'}`：
  //   · `:81` —— **非 roster 的直接子 agent**（*"A direct child outside the durable roster is
  //     not a teammate"*）⇒ **伪行**
  //   · `:90` —— **真正的 Team root**
  //   两处的 `role`/`name` **完全相同** ⇒ **只查 role/name 分不出来**。
  // ⇒ 后果 ①（`index.js` 的 `handleLeadSoul`）：日志实测 `SOUL-INJECT member=lead #1 step#1`
  //     在**同一毫秒出现 8 次** ⇒ **把 Lead 的 SOUL 灌给 8 个不是 Lead 的 agent**；
  //   后果 ②（`guard.js` 的 `decide()`）：`if (identity.role === 'lead') return undefined`
  //     ⇒ **伪行让 guard 对一整类 agent "恒允许"**（而 guard 的全部意义就是防误写上游技能根）。
  //   ⚠️ 讽刺的是：**`fork.js:22-23` 的注释早就写着这件事**（"对不在 roster 里的子 agent，
  //     `tryMembership` 会返回伪行 `{role:'lead',name:'lead'}`"）—— **警告在仓库里，别处没守。**
  // 【判据】**凡"信 `tryMembership` 的 `lead`"的地方，必须同时判"它有没有 parent"**
  //   （底座那条伪行分支的前提是 `session.header.parentSession !== undefined`；
  //    真 root 走 `:90`，`parentSession === undefined`）。
  //   ⇒ 逐处查**调用点**（不是查名字）：`handleLeadSoul` 与 `guard` 两处都要有 parent 判据。
  {
    let idx = ''
    try { idx = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8') } catch { idx = '' }
    let gd = ''
    try { gd = readFileSync(join(PLUGIN_DIR, 'lib', 'guard.js'), 'utf8') } catch { gd = '' }
    const strip = (t) =>
      t
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
    const idxCode = strip(idx)
    const gdCode = strip(gd)
    // ① handleLeadSoul：接受 `role === 'lead'` 的同时，必须判 parentSession
    const leadBlock = (() => {
      const i = idxCode.indexOf('const handleLeadSoul')
      return i === -1 ? '' : idxCode.slice(i, i + 2600)
    })()
    const guardsPseudoLead = /parentSession/.test(leadBlock) && /SKIP-PSEUDO-LEAD/.test(leadBlock)
    CHECK('H36', guardsPseudoLead,
      '★★★ **`handleLeadSoul` 拒绝"伪 lead 行"**（有 parent ⇒ 不是 root ⇒ 不注入 Lead 的 SOUL）',
      '不判 ⇒ 实测**同一毫秒 8 次** `SOUL-INJECT member=lead` ⇒ **把 Lead 的 SOUL 灌给不相干的 agent**',
      guardsPseudoLead ? '有 parentSession 判据 + 留痕 ✓' : '**没判伪行**（照信 role==="lead"）')
    // ② guard：`role === 'lead'` 的豁免前，必须判 parent
    const guardBlock = (() => {
      const i = gdCode.indexOf('let identity = { member: false }')
      return i === -1 ? '' : gdCode.slice(i, i + 2600)
    })()
    const guardRejectsPseudo = /GUARD-PSEUDO-LEAD/.test(guardBlock) && /parentSession/.test(guardBlock)
    CHECK('H36', guardRejectsPseudo,
      '★★★ **`guard` 不把伪 lead 行当 Lead 豁免**（否则护栏对一整类 agent **恒允许**）',
      '`identity.role === \'lead\'` ⇒ `return undefined`（恒允许）⇒ **伪行 = 护栏失效**，且日志上看着像"Lead 被放行"',
      guardRejectsPseudo ? '有伪行判据 + 留痕 ✓' : '**伪行会拿到 Lead 豁免**')
    // ③ `release-tools.js` 的 `myIdentity`（**第三处**，2026-09-14 / Round 81 补）——————
    // 【为什么它最重】`resolveSelfTarget` 用 `member` 拼落点 ⇒
    //   伪行的 `name` 恒为字面量 `'lead'` ⇒ **`write_self {target:'soul'}` 会写到 `soul/lead.md`**，
    //   也就是 **真 Lead 自己那份**（而 SOUL 每步注入进 Lead 的上下文）。
    //   实测（本机）：`resolveSelfTarget({member:'lead',target:'soul'})` ⇒
    //   `<用户目录>\.dsh\.teamkit\soul\lead.md` —— **与真 Lead 落点逐字相同**。
    //   ⚠️ **2026-09-15 脱敏**：原文逐字写了本机用户名 ⇒ 开源前改成占位符
    //     （`R35`：公开不可逆 —— 那串字**已经在公网历史里了**，此处只是不再新增）。
    let rtl = ''
    try { rtl = readFileSync(join(PLUGIN_DIR, 'lib', 'release-tools.js'), 'utf8') } catch { rtl = '' }
    const rtlCode = rtl
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    const identBlock = (() => {
      const i = rtlCode.indexOf('const myIdentity = ')
      return i === -1 ? '' : rtlCode.slice(i, i + 2600)
    })()
    const identRejectsPseudo = /SELF-WRITE-PSEUDO-LEAD/.test(identBlock) && /parentSession/.test(identBlock)
    CHECK('H36', identRejectsPseudo,
      '★★★ **`myIdentity` 拒绝伪 lead 行**（否则非 roster 子 agent 能**覆盖真 Lead 的 `soul/lead.md`**）',
      '伪行 name 恒为 `\'lead\'` ⇒ `resolveSelfTarget` 拼出 `soul/lead.md` = **真 Lead 那份** ⇒ 可覆盖 Lead 的自我承诺',
      identRejectsPseudo ? '有伪行判据 + 留痕 ✓' : '**伪行会写到 soul/lead.md**')
    // ④ **不许再有"死判据 `isLead`"**（它天然会被伪行骗到，且全仓无人读）
    const hasDeadIsLead = /isLead:\s*m\.role/.test(rtlCode)
    CHECK('H36', !hasDeadIsLead,
      '★ 且**没有"死判据 `isLead`"**（声明了没人读，却立了个会被伪行骗的判断在那儿等人用）',
      '死字段 + 会被骗 = 最坏组合：看着"有身份判断"，实际没人用；**将来谁用第一眼就掉坑**（R73 的 H30 同族）',
      hasDeadIsLead ? '**仍有 `isLead: m.role`**' : '已移除 ✓')
  }

  // ── H37 · ★★★ **"读了 A、写了 B"的集成缺口**（2026-09-14 / Round 82）──────────────
  // 【本轮抓到的真缺陷 —— 委托方点名要的那件事，在生产路径上**从来没生效过**】
  //   委托方口径（`DECISIONS.md` P-22）："**不是删掉或者保留，是可以 diff 去参考一下！**"
  //   ⇒ 通知必须带四件：① 人写的更新说明 ② 改后内容 ③ 可比的两侧路径 …
  //   而 **① 的读取侧与写入侧读写的不是同一个文件、也不是同一种格式**：
  // ```
  //   读（plugin/lib/notify.js 的 readChangelog）：<upstream.root>/<skill>/CHANGELOG.md
  //                                                —— **per-skill**，按 `## <digest8>` 分节
  //   写（tools/promote-upstream.mjs）：            <PKG>/CHANGELOG.md
  //                                                —— **单一汇总**，`## <日期> · <note>` + `| 技能 | sha |` 表
  // ```
  //   实测（本机）：上游根里**一个 per-skill CHANGELOG 都没有** ⇒
  //   `CHANGELOG-LOOKUP … found=false why=no-changelog-file` ⇒ **"①"永远是空的**。
  //   ⚠️ 而 `UPSTREAM-CHANGELOG.md` §B.2 **验证过 ①"成立"** ——
  //     但那次实验用的是 **`git log` 的 commit message** 造的 per-skill 文件，
  //     **不是 promote 工具写的那个** ⇒ **"机制被验证过" ≠ "生产路径接上了"**。
  // 【判据】`readChangelog` 必须**能读汇总格式**（有 `matchAggregateChangelog` 且调用点传了回退路径）。
  //   行为判据优先：**真跑一次** `readChangelog`（喂一份汇总 CHANGELOG + 一个不在 per-skill 里的技能）
  //   ⇒ 应 `found:true why=matched-aggregate-changelog`。
  {
    let nf = ''
    try { nf = readFileSync(join(PLUGIN_DIR, 'lib', 'notify.js'), 'utf8') } catch { nf = '' }
    const hasMatcher = /export function matchAggregateChangelog/.test(nf)
    CHECK('H37', hasMatcher,
      '★★★ **`readChangelog` 能读"汇总格式"的 CHANGELOG**（promote 工具写的就是那种）',
      '只认 per-skill ⇒ **promote 写的说明永远读不到** ⇒ 通知里的"① 人写的更新说明"**恒为空**（R82 实测）',
      hasMatcher ? '有 matchAggregateChangelog ✓' : '**没有汇总格式的读取路径**')
    // 行为判据：真跑（用一份最小汇总样本，不碰真盘）
    let behavior = 'n/a'
    try {
      const agg =
        '## 2026-09-14 · 测试说明\n\n**说明**：把 X 改成 Y，因为 Z。\n\n| 技能 | sha256（前 → 后） |\n|---|---|\n| `probe-skill` | `aaaa1111aaaa1111` → `bbbb2222bbbb2222` |\n'
      const mod = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'notify.js')).href)
      const hit = mod.matchAggregateChangelog(agg, 'probe-skill', 'bbbb2222bbbb2222')
      const miss = mod.matchAggregateChangelog(agg, 'other-skill', 'bbbb2222bbbb2222')
      const wrongDigest = mod.matchAggregateChangelog(agg, 'probe-skill', 'ffff9999ffff9999')
      behavior = `命中=${JSON.stringify(hit)} 别技能=${JSON.stringify(miss)} 错digest=${JSON.stringify(wrongDigest)}`
      CHECK('H37', typeof hit === 'string' && hit.includes('把 X 改成 Y') && miss === undefined && wrongDigest === undefined,
        '★★ **且它"只认真匹配"**（技能名或 digest 对不上 ⇒ `undefined`，**不拿别人的说明**）',
        '匹配太松 ⇒ 会把**别的技能**的说明贴给这条 ⇒ 通知里出现**张冠李戴的"人写的说明"**（比空着更坏）',
        behavior)
    } catch (err) {
      CHECK('H37', null, '汇总 CHANGELOG 匹配（行为判据）', `**未验证**：${err?.message ?? err}`, behavior)
    }
  }

  // ── H38 · ★★★ **三个 `write_self` 落点，读写两侧必须逐字一致**（2026-09-14 / Round 83）──
  // 【为什么单列】R82 抓到的那个真缺陷（"读了 A、写了 B"）让我把**所有"读一个路径、写另一个路径"
  //   的链路**都并排列了一遍。三条 `write_self` 落点里，**每一对都可能悄悄错开**：
  // ```
  //   soul       : 写 self-write.js  <stateDir>/soul/<member>.md
  //                读 soul.js        <stateDir>/soul/<member>.md          ✅ 同公式
  //   principles : 写 self-write.js  <teamkitDir>/talents/principles/<role>.md
  //                读 index.js 注入   <principles.dir>（预设配到同一个地方）  ✅ 实测一致
  //   role-skill : 写 self-write.js  <teamkitDir>/roles/<role>/skills/<skill>/SKILL.md
  //                读 installRoleFor  <loadedRoles.dir>/<role>/skills      ✅ 写点落在读点目录里
  // ```
  // 【判据】**行为判据**（不是读代码）：用真角色档目录跑一次 `loadRoles`，
  //   再对每个 target 算 `resolveSelfTarget` 的落点，**断言它落在读侧目录里**。
  //   ⚠️ 拿不到真角色档目录（没装）⇒ **报未验证**，不猜。
  {
    const rolesRoot = (() => {
      const home = process.env.DSH_HOME ?? ''
      if (home === '') return ''
      const cand = join(home, 'teamkit', 'roles')
      return existsSync(cand) ? cand : ''
    })()
    if (rolesRoot === '') {
      CHECK('H38', null, '`write_self` 三个落点与读侧一致',
        '**未验证**：这跑拿不到 `$DSH_HOME/teamkit/roles`（没装过组织层）⇒ 不猜', '拿不到 roles 根')
    } else {
      let rolesMod = null
      let swMod = null
      try {
        rolesMod = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'roles.js')).href)
        swMod = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'self-write.js')).href)
      } catch (err) {
        CHECK('H38', null, '`write_self` 三个落点与读侧一致', `**未验证**：import 失败 ${err?.message ?? err}`, '')
      }
      if (rolesMod !== null && swMod !== null) {
        const loaded = rolesMod.loadRoles(rolesRoot, () => {})
        const roleNames = [...loaded.roles.keys()]
        const teamkitDir = join(rolesRoot, '..')
        const stateDir = join(teamkitDir, '..', '.teamkit')
        const bad = []
        // ① soul：写点必须 = soul.js 的公式
        try {
          const want = rolesMod ? join(stateDir, 'soul', 'probe.md') : ''
          const got = swMod.resolveSelfTarget({ stateDir, teamkitDir, member: 'probe', target: 'soul' }).file
          if (String(got) !== String(want)) bad.push(`soul: 写=${got} 读=${want}`)
        } catch (err) {
          bad.push(`soul: 抛错 ${err?.message ?? err}`)
        }
        // ② principles + ③ role-skill：对**每个真角色**算一遍
        for (const rn of roleNames) {
          const p = swMod.resolveSelfTarget({ stateDir, teamkitDir, member: rn, role: rn, target: 'principles' })
          const wantP = join(teamkitDir, 'talents', 'principles', `${rn}.md`)
          if (p.ok === true && String(p.file) !== String(wantP)) bad.push(`principles(${rn}): 写=${p.file} 读=${wantP}`)
          // role-skill：写点必须落在 installRoleFor 的读目录里
          const skDir = join(rolesRoot, rn, 'skills')
          if (!existsSync(skDir)) continue
          const first = readdirSync(skDir)[0]
          if (first === undefined) continue
          const t = swMod.resolveSelfTarget({ stateDir, teamkitDir, member: rn, role: rn, target: 'role-skill', skill: first })
          if (t.ok === true && !String(t.file).startsWith(skDir)) bad.push(`role-skill(${rn}): 写=${t.file} 不在读目录 ${skDir}`)
        }
        CHECK('H38', roleNames.length > 0 && bad.length === 0,
          '★★★ **`write_self` 的三个落点都落在"读侧真读的地方"**（soul / principles / role-skill）',
          '读写错开 ⇒ **写下去了但没人读到**（R82 那个"读了 A、写了 B"的同族；成员会以为"我改了但没生效"）',
          roleNames.length === 0
            ? '**读不到任何角色档**（装了吗？）'
            : bad.length === 0
              ? `${roleNames.length} 个角色 × 三个落点，读写两侧全部一致 ✓`
              : `**不一致：${bad.slice(0, 3).join(' | ')}**`)
      }
    }
  }

  // ── H39 · ★★★ **安装器的 `--check` 必须查"模型真正读的那个上游根"**（Round 84）──────
  // 【本轮抓到的真缺陷 —— R47 复发，而且复发在"本该抓它的工具"里】
  //   `--check` 只比对 `$DSH_HOME/skills` 那 7 条，而上游根（`teamkit/skills-upstream`）
  //   **只打印一句"（--check 不写入）"，从不比对**。
  //   ⇒ 实测：把上游根里 `teamkit-escalate/SKILL.md` 改旧 ⇒ `--check` **7 条全报 `OK（一致）`、
  //     退出码 0** —— 而**模型读的就是那份**（`omc` 的 `customSkillDirs` 指它，
  //     且 `includeDefaultRoots:false` 明确不扫 `$DSH_HOME/skills`）。
  //   ⇒ 即 R47 的同一形状（"改了技能，模型读旧版，无任何报错"），**发生在状态报告里**。
  // 【判据】① `--check` 的源码里必须有"上游根逐条比对"（`upDrift`）；
  //   ② **必须 `process.exit`** —— 它原先跑完从不 exit ⇒ **脚本/CI 里永远退 0**
  //      （与 R78 修的"无参数 exit 0"同族：**退出码是接口**）。
  {
    let inst = ''
    try { inst = readFileSync(join(PLUGIN_DIR, '..', 'tools', 'install-teamkit.mjs'), 'utf8') } catch { inst = '' }
    const hasUpDrift = /upDrift/.test(inst) && /上游根待更新/.test(inst)
    CHECK('H39', hasUpDrift,
      '★★★ **安装器 `--check` 会逐条比对"上游根"**（那才是 `omc` 成员读的那份）',
      '不查 ⇒ 上游根旧了也报"7 条全 OK"、退出码 0 ⇒ **R47 那个"模型读旧版却无报错"复发在状态报告里**',
      hasUpDrift ? '有上游根比对 ✓' : '**不查上游根**')
    // ② `--check` 必须给退出码（不许跑完就结束）
    // ⚠️ **窗口不能写死**（2026-09-15 我踩的假红）：
    //   原实现从 `if (check) {` 起截 **6000 字符**，而我在 `--check` 分支里加了一段"组织层漂移比对"
    //   ⇒ `process.exit(code)` 被推到**距离 11618** ⇒ **超出窗口** ⇒ 断言报"`--check` 不设退出码"
    //   ⇒ ★★ **而退出码明明在**（就在那里）—— **这是我的窗口太小，不是产品坏了**。
    //   ⇒ 修法：**窗口按"代码块"取，不按字符数猜** —— 从 `if (check) {` 起做**大括号配平**，取到块尾。
    //     （同族教训：`H29` 的扫描范围、e2e 的分母 —— **范围写死了，就会漏**）
    const checkBlock = (() => {
      const i = inst.indexOf('if (check) {')
      if (i === -1) return ''
      let depth = 0
      for (let k = i; k < inst.length; k += 1) {
        const ch = inst[k]
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) return inst.slice(i, k + 1)
        }
      }
      return inst.slice(i, i + 40000) // 配平失败 ⇒ 退一个**足够大**的窗口（总比 6000 大）
    })()
    const hasExit = /process\.exit\(code\)/.test(checkBlock)
    CHECK('H39', hasExit,
      '★★★ 且 **`--check` 会 `process.exit`**（有漂移 ⇒ 1 / 有未验证 ⇒ 2 / 全绿 ⇒ 0）',
      '跑完不 exit ⇒ 脚本/CI 里**永远退 0**，哪怕刚报了"7 条待更新"（R78"无参数 exit 0"同族：退出码是接口）',
      hasExit ? '有 process.exit(code) ✓' : '**--check 不设退出码**')
  }

  // ── H40 · ★★★ **两种模式（`--locked` / `--global`）都要在**（`B180` · 2026-09-19 重写）──────
  // 【本断言的前身（Round 85）】它当时要求"**安装器两处都写**"（公共根 + 上游根）
  //   ⇒ ★★ **而那条设计【被委托方否掉了】**（他原话）：
  //     「**本地不要更新锁定预设。……我在标准模式导致你现在没法像 omc 一样自动注入 skill，
  //      这样子你现在的公司就完蛋了。我们传的 release 包是锁定预设的，但是我们本地的不要这样。**」
  //   ⇒ ★★★ **即：要【分离两件事】** ——
  //     · **release / 陌生人** ⇒ **`--locked`**（只装上游根 ⇒ **别的预设读不到**）
  //     · **本地 / 我们** ⇒ **`--global`**（公共根也装 ⇒ **公司才跑得起来**）
  // 【★ 而旧断言的危险】它要求"两处都写" ⇒ **它会把正确的 `--locked` 判成坏** ❌
  //   ⇒ ★★ **所以本条改成：两种模式【都存在且各自可预测】**（**而不是"强制同时装两处"**）
  // ```
  // 【判据（三条，都是结构级的）】
  //   ① 安装器里有 `--global` 与 `--locked` 两个开关（**且 `--locked` 是默认**）
  //   ② **落点清单随模式变**：`--global` ⇒ 两个根 · `--locked` ⇒ 只有上游根
  //   ③ **`--locked` 要清掉公共根里旧版遗留**（**否则泄漏源还在**）
  // ⚠️ **为什么用结构断言而不用"跑一遍看结果"**：`selftest` 是**离线自证**，
  //   而"跑安装器"会**写 `$DSH_HOME`**（那是真机状态）⇒ 只能静态检查源码结构
  //   ⇒ 而**动态那半**由 `plugin/scripts/e2e-tarball.mjs` 在**沙箱**里做（它断言公共根里没有 `teamkit*`）
  // ```
  {
    let inst = ''
    try { inst = readFileSync(join(PLUGIN_DIR, '..', 'tools', 'install-teamkit.mjs'), 'utf8') } catch { inst = '' }
    const hasBothFlags = /process\.argv\.includes\('--global'\)/.test(inst) && /process\.argv\.includes\('--locked'\)/.test(inst)
    // ★ **默认必须是 locked**（`--locked` 或 `!globalMode`）
    const lockedByDefault = /process\.argv\.includes\('--locked'\)\s*\|\|\s*!globalMode/.test(inst)
    // ★ **落点随模式变**（`SKILL_ROOTS` 那一行）
    const modeDependentRoots = /const SKILL_ROOTS = globalMode \? \[UPSTREAM_DST, SKILLS_DST\] : \[UPSTREAM_DST\]/.test(inst)
    // ★ **locked 模式要清公共根遗留**
    const cleansLegacy = /if \(lockedMode && !check\)/.test(inst)
    CHECK('H40', hasBothFlags && lockedByDefault,
      '★★★ **安装器有 `--locked`（默认）与 `--global` 两种模式**',
      '缺 ⇒ **只有一种行为** ⇒ 而委托方要的是"**release 锁 / 本地不锁**"两件事（`B180`）⇒ 混在一起必然弄坏一边',
      hasBothFlags && lockedByDefault ? '两模式齐 · locked 是默认 ✓' : `hasBothFlags=${hasBothFlags} lockedByDefault=${lockedByDefault}`)
    CHECK('H40', modeDependentRoots,
      '★★ **技能落点随模式变**（`--global` 两个根 · `--locked` 只有上游根）',
      '落点写死 ⇒ **两模式形同虚设** ⇒ 而 `--locked` 的意义正是"**别的预设读不到**"',
      modeDependentRoots ? '随模式变 ✓' : '**落点没随模式变**')
    CHECK('H40', cleansLegacy,
      '★★ **`--locked` 会清掉公共技能根里旧版遗留**（光"不装"不够 —— 遗留仍在就是泄漏源）',
      '不清 ⇒ 旧版装过的那 7 条**还在公共根** ⇒ **别的预设照样读到** ⇒ 委托方报的症状不消失',
      cleansLegacy ? '会清 ✓' : '**没清遗留**')
  }

  // ── H41 · ★★★ **技能里不许把"协议"说成"机制"**（2026-09-14 / Round 86）────────────
  // 【本轮抓到的真缺陷 —— 一个**空头承诺**】
  //   `skills/teamkit-assemble/SKILL.md:31` 原文：
  //   > 判据为空 = 无法评审。**原版 OMC 允许空判据（代码只查字段在不在），我们不。**
  //   ⇒ 「**我们不**」读起来是"**我们拦住了**"。实测：
  // ```
  //   · 底座 `team_task_create` 的参数 schema **只有 `subject` / `description` / `blockedBy` / `writeScopes`**
  //     ⇒ **根本没有 `acceptance_criteria` 这个字段**（所以也不可能拒）
  //   · 本插件代码里 **一行都没查过它**（`grep acceptance_criteria plugin/**` = **0 命中**）
  // ```
  //   ⇒ **"我们不"是假的** —— 真相是"**跟原版一样，靠你自己守**"。
  //   ⚠️ 危害：成员**读技能时以为有硬门** ⇒ 写空判据时会想"反正它会拦我"（它不会）
  //     ⇒ 这正是 **`LANDMINES` 那种"把提议说成强制"**的同族，只是这次发生在**技能正文里**。
  // 【判据】技能里出现「**会报错 / 会被拒 / 直接报错 / 硬拒**」这类**机制性措辞**时，
  //   必须能指向**一条真实存在的强制点**。写死的白名单（已逐条人工核实过）：
  // ```
  //   真的：`team_task_create` 检依赖环后报错（底座 assertTaskGraph，R80 核过源码）
  //         `claim` 被就绪门硬拒（`team task "…" is not ready to claim`，R54 真机实测）
  //         `delete` 有下游时被拒（`still blocks "task-4"`，R80 核过源码）
  //   假的（本轮修）：判据为空 —— 已改成"我们也不拦（靠你自己守）"
  // ```
  //   ⚠️ 判据**不查语义**（那是人审的事），只查**"这句机制措辞旁边有没有给出来源/依据"**。
  {
    const files = (() => {
      try {
        return readdirSync(join(PLUGIN_DIR, '..', 'skills'), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(PLUGIN_DIR, '..', 'skills', e.name, 'SKILL.md'))
          .filter((f) => existsSync(f))
      } catch {
        return []
      }
    })()
    // 允许的"真机制"依据（人工核实过）。
    // ⚠️ **必须收紧到"同一行或紧邻下一行"**：我第一版用 ±3 行窗口 ⇒
    //   **变异没判死**（新加的那句"会被拒"从**邻近的"实测"二字**拿到了豁免）。
    //   ⇒ 教训与 R79/R85 同族：**判据的"范围"要么够宽（不漏）、要么够窄（不误放）——
    //     而"宽窗"在这里等于'几乎任何断言都能蹭到附近的依据'。**
    //   ⇒ 改成：**同一行**，或**紧邻的下一行**（"这句话的依据写在它下面一行"是常见写法）。
    const ALLOWED = [
      /is not ready to claim/, // 就绪门：claim 硬拒（R54 真机实测）
      /still blocks/, // delete 有下游被拒（R80 核过源码）
      /assertTaskGraph|检环|检测到直接报错/, // 依赖环（R80 核过源码）
      /实测|真机|源码|（见 `[a-z-]+`|:[\d-]{1,10}\b/, // 给出了来源指针
    ]
    const bare = []
    for (const f of files) {
      let t = ''
      try {
        t = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const lines = t.replace(/\r\n/g, '\n').split('\n')
      lines.forEach((l, i) => {
        // 只看"断言式机制措辞"（不是标题、不是代码块里的工具名）
        if (!/会报错|会被拒|直接报错|硬拒|真机制/.test(l)) return
        if (/^#{1,4}\s/.test(l.trim())) return
        // ⚠️ **排除"引述/指示"形态**：本判据**自己的指示语**也会命中
        //   （我在技能里写了"**判据**：凡是真会拒的，都写成「`<工具>` 会直接报错」"）
        //   ⇒ 那是**在引用这个措辞**，不是**在断言某个机制**。
        //   判据：该行含「」或 `**判据**` 或 `**不许**` ⇒ 视为**元语句**，跳过。
        if (/「|」|\*\*判据\*\*|\*\*不许\*\*/.test(l)) return
        // ⚠️ **同一行**，或**紧邻下一行**（"依据写在下一行"是常见写法）
        const ctx = l + '\n' + (lines[i + 1] ?? '')
        if (!ALLOWED.some((re) => re.test(ctx))) bare.push(`${f.split(/[\\/]/).slice(-2)[0]}:${i + 1}`)
      })
    }
    CHECK('H41', files.length > 0 && bare.length === 0,
      '★★★ **技能里"会报错/会被拒/真机制"这类断言，都给出了依据**（不许把协议说成机制）',
      '空头承诺（"我们不"其实没人拦）⇒ 成员以为有硬门、写空判据时想"反正它会拦我"（R86 实测抓到一处）',
      files.length === 0
        ? '**读不到 skills/**（布局变了？）'
        : bare.length === 0
          ? `${files.length} 条技能的机制性断言都有依据 ✓`
          : `**无依据：${bare.slice(0, 4).join(', ')}**`)
  }

  // ── H42 · ★★★ **"有机制的样子、没有机制的效果"—— 规则要核"输入真被传了吗"** ──────
  // 【本轮怎么发现的】核 `RULES.yml` 的每一句断言的依据时，去读了**原版 OMC**（`D:\app\omc`）：
  //   我们原先写的是「原版那个引擎**未接线**（ACP 分支**无 caller**）」。
  //   逐行核对后 —— **前半句是错的，真相更精确也更有教益**：
  // ```
  //   · 引擎**完整实现**（`acp/permission.py` 的 `PolicyEngine`），**且有 7 个单元测试**
  //   · **确实有 caller**（`acp/client.py` 的 `request_permission`，ACP 协议回调，真实路径）
  //   · **但**它在 `:144` 调成 `engine.decide(tool=tool_name, args={}, context={})` —— **两个实参都是空字典**
  //   · 而三条规则**全都依赖那两个字典里的键**：
  //       `target_exists` / `owner_is_self`（没人传）· `tool:"external_api"`（tool 是实际工具名）
  //       · `cost_usd`（不存在 ⇒ 取 0.0 ⇒ `0 > 10` 假）
  //     ⇒ **一条都不命中** ⇒ 落到 `default: allow` ⇒ **恒允许**
  // ```
  //   ⇒ **"引擎是真的、测试是真的、调用也是真的 —— 但经生产路径它恒允许"**。
  //     **给"规则有没有被强制"的判据，不能看"有没有引擎/测试/调用"，要看"那条规则依赖的输入
  //       在生产路径上真的被传了吗"**（核**实参**，不核**存在**）。
  //   ⚠️ 这与 R86 修的"技能里 '我们不' 是空头承诺"**是同一个形状** ⇒ 所以专门立一条判据。
  // 【判据】`RULES.yml` 里**不许再出现**"未接线 / 无 caller"这类**未逐行核过的反转断言**；
  //   且**必须写明"怎么判一条规则真被强制"**（核实参）—— 否则下一个人会重犯同一个错。
  {
    let rules = ''
    try { rules = readFileSync(join(PLUGIN_DIR, '..', 'RULES.yml'), 'utf8') } catch { rules = '' }
    // ① 不许再写"未接线 / 无 caller"（那是错的）
    // ⚠️ **必须排除"引述式更正"** —— 我在同一文件里写了「本条**原先写的是**「…**无 caller**…」」，
    //   那是**在纠正它**，不是**在断言它**。⇒ 剥掉"引述段"（「」内、以及 `原先是` / `更正` 前后）。
    //   （这是本判据第 N 次撞"引述被当真" —— R71/R73/H32/H13/H36 同族；
    //     这次的解法比"剥注释"更细：**要按语义排除"我引用了它"**。）
    const stripped = rules
      .replace(/\r\n/g, '\n')
      .replace(/「[^」]*」/g, '「引用」') // 去掉中文引号内内容（引述）
      .replace(/`[^`]*`/g, '`code`') // 去掉反引号内内容（引用代码/词）
    const wrongClaim = /未接线|无 caller/i.test(stripped)
    // ⚠️ **扩到"全仓的活文档"**（2026-09-14 / Round 89）：R87 我只扫了 `RULES.yml` ——
    //   而**同一个错断言在别的文件里还有 4 份活的**（`skills/teamkit`、`skills/teamkit-org`、`EVIDENCE.md` …）
    //   ⇒ **这正是 R84 那条教训的复发**（"修一个缺陷时，要把它在**所有相关入口**里都补上"）：
    //     我 R87 修了 `RULES.yml`，**没扫其它文件** ⇒ 同一个错话在别处又活了。
    //   ⇒ 判据扩成：所有"活文档"（仓根 `*.md`/`*.yml` + `skills/**`）都不许留这个错断言。
    //     ⚠️ 排除 `runs/`（历史台账，**本就该保留旧结论**）、`notes/`（研究记录）、备份目录。
    const liveDocs = []
    try {
      for (const f of readdirSync(join(PLUGIN_DIR, '..'))) {
        if (/\.(md|yml)$/.test(f)) liveDocs.push(join(PLUGIN_DIR, '..', f))
      }
      for (const e of readdirSync(join(PLUGIN_DIR, '..', 'skills'), { withFileTypes: true })) {
        if (e.isDirectory()) liveDocs.push(join(PLUGIN_DIR, '..', 'skills', e.name, 'SKILL.md'))
      }
    } catch {
      /* 目录不在就算了 */
    }
    let wrongDoc = ''
    for (const f of liveDocs) {
      if (!existsSync(f)) continue
      let t = ''
      try {
        t = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const s = t.replace(/\r\n/g, '\n').replace(/「[^」]*」/g, '「引用」').replace(/`[^`]*`/g, '`code`')
      for (const l of s.split('\n')) {
        if (!/未接线|无 caller/i.test(l)) continue
        // ⚠️ **两个假阳性必须排除**（2026-09-14 / Round 89 当场撞上）：
        //   ① **剥掉反引号后**，"`permissions.yaml` 规则引擎" 变成了 "`code` 规则引擎" ⇒
        //      主题判据 `/permissions\.yaml/` **失配**（所以这里**改用"规则引擎/权限引擎/ACP"等词**）；
        //   ② **我这轮的更正句**（`原写"未接线（3 条里 2 条…）"`）**本身就在引述旧话** ——
        //      它没有用「」，所以躲过了引号剥离 ⇒ 含「更正/原写/原先/R8x」的行 = **留痕，跳过**。
        if (/更正|原写|原先|R8\d|核不出来/.test(l)) continue
        if (!/规则引擎|权限引擎|ACP 分支|permissions/i.test(l)) continue
        wrongDoc = f.split(/[\\/]/).slice(-1)[0]
        break
      }
      if (wrongDoc !== '') break
    }
    CHECK('H42', rules !== '' && !wrongClaim && wrongDoc === '',
      '★★★ **"原版 permissions 引擎未接线/无 caller"这句错断言，在所有活文档里都不留**（不只 `RULES.yml`）',
      '留着一个**错的**反转断言 ⇒ 别人（或下一轮的我）会照它做决定；真相是"引擎真、有 caller，**但喂进去的输入全空**" ⇒ 生产路径**恒允许**',
      rules === ''
        ? '**读不到 RULES.yml**'
        : wrongClaim
          ? '**RULES.yml 里仍写着"未接线/无 caller"**'
          : wrongDoc !== ''
            ? `**还在别处活着：${wrongDoc}**（R87 只修一处 ⇒ R84"修全所有入口"的教训复发）`
            : `已修全（扫了 ${liveDocs.length} 个活文档）✓`)
    // ② 必须写明"怎么判"（核实参）—— 这是可迁移的方法，不只是纠一个错
    const teachesHow = /实参/.test(rules) && /(没有机制的效果|恒允许|橡皮图章)/.test(rules)
    CHECK('H42', teachesHow,
      '★★ 且**写明了"怎么判一条规则真被强制"**（核 `decide(...)` 的**实参**，不是它的**存在**）',
      '只纠正那一条 ⇒ 下次遇到"有引擎有测试有 caller"的假机制，**还会被骗**（方法比结论耐用）',
      teachesHow ? '写明了方法 ✓' : '**只纠了事实、没给方法**')
  }

  // ── H43 · ★★★ **不许写"核不出来"的数**（2026-09-14 / Round 88）────────────────────
  // 【本轮抓到的真缺陷 —— 一个"听起来很具体"的**假数字**】
  //   `TALENTS.yml` / `skills/teamkit-org` / `skills/teamkit-assemble` 都写着
  //   「原版 `execute_hire()` **23 步**纯代码」—— 去核：
  // ```
  //   · 原版全仓（`D:\app\omc`，含 docs/notes/源码）grep「23 步 / 23.step / twenty-three」⇒ **0 命中**
  //     ⇒ **原版从没这么说过**（那个数**是我自己编的**）
  //   · 引用指针指向 `onboarding.py:867-1122`（`execute_hire` 全体），而那段里
  //     **各种数法都不是 23**：步骤注释 **22** 条 / 函数调用 **18** 行 / 赋值 **30** 处 / `if` **25** 处
  // ```
  //   ⇒ 危害：它**扩散到了 5 个文件**（含 `notes/` 的研究记录），而且**读起来最像"有依据"**
  //     （有数字 + 有 `file:line`）—— **假数字 + 真指针 = 最像证据的假证据**。
  // 【判据】`TALENTS.yml` 与 `skills/**` 里，**不许出现"指到某个 `file:line` 的同时给一个可数的数"**
  //   （形如「N 步 / N 条 / N 处 / N 个」紧邻一个 `xxx.py:NNN`）——
  //   **除非同一行/下一行说明了它怎么数出来的**（本轮修法就是给出"注释 22/调用 18/赋值 30/if 25"）。
  //   ⚠️ **不追溯历史**（`notes/` 与备份里的更正记录会**引述**旧数字，那是留痕，不算违规）——
  //     所以本判据只看**"更正"标记之外**的那些行。
  {
    const targets = [
      join(PLUGIN_DIR, '..', 'TALENTS.yml'),
      join(PLUGIN_DIR, '..', 'RULES.yml'),
    ]
    try {
      for (const e of readdirSync(join(PLUGIN_DIR, '..', 'skills'), { withFileTypes: true })) {
        if (e.isDirectory()) targets.push(join(PLUGIN_DIR, '..', 'skills', e.name, 'SKILL.md'))
      }
    } catch {
      /* 没有 skills 就算了 */
    }
    const suspicious = []
    for (const f of targets) {
      if (!existsSync(f)) continue
      let t = ''
      try {
        t = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const lines = t.replace(/\r\n/g, '\n').split('\n')
      lines.forEach((l, i) => {
        // 形如：一个可数的数（N 步/条/处/个/行）+ 邻近一个 `xxx:NNN` 引用
        if (!/\d+\s*(步|条|处|个|行)/.test(l)) return
        if (!/[a-zA-Z0-9_./-]+\.(?:py|js|ts|md|yml):\d+/.test(l)) return
        // 排除"更正/原先写的是"这类引述留痕
        if (/更正|原先写的是|R88|已更正|核不出来/.test(l)) return
        // ⚠️ **"说明来源"必须是"关于这个数怎么来的"**（2026-09-14 / Round 90 当场撞的假阳性）：
        //   我写的「…行号在 `:351-354` —— 恰好**差 7 行**（`EVIDENCE.md:106` 的说法成立）」被判可疑 ——
        //   而那句**恰恰是在解释这个数从哪来的**（两副本对账）。
        //   ⇒ 判据加宽：**本行或上一行**出现「复核对账/逐条复核/逐字一致/差 N 行/两副本」等
        //     **"这是核对出来的"** 的措辞 ⇒ 视为**已说明来源**。
        const ctx = (lines[i - 1] ?? '') + '\n' + l
        if (/复核|对账|逐字一致|差 \d+ 行|两副本|两份副本|实测|真读|真跑|逐条/.test(ctx)) return
        suspicious.push(`${f.split(/[\\/]/).slice(-2)[0]}:${i + 1}`)
      })
    }
    CHECK('H43', suspicious.length === 0,
      '★★★ **"可数的数"与"`file:line` 指针"同现时，必须说明怎么数出来的**（否则别写数）',
      '假数字 + 真指针 = **最像证据的假证据**（R88 实测："23 步"原版全仓 0 命中，扩散到 5 个文件）',
      suspicious.length === 0 ? '没有"未说明来源的数 + 指针"同现 ✓' : `**可疑：${suspicious.slice(0, 4).join(', ')}**`)
  }

  // ── H44 · ★★★ **引用的出处里必须真有那个数**（2026-09-14 / Round 91）─────────────
  // 【本轮抓到的两个"指错文件"】都发生在**"硬数字"表**上：
  //   ① `teamkit-org §2`：「单节点执行超时 3600s ← `vessel.py`」——
  //      而 `vessel.py` 里**没有** 3600；真出处是 `acp/backends/script_backend.py:26`
  //      与 `agents/tree_tools.py:234`（R90 已修）
  //   ② `DESIGN-OMC.md`：「空转重试 2 ← 照抄 `config.py:358-361` 与 `vessel_config.py`」——
  //      而这两处**都没有**那个 2；真出处是 `core/vessel.py:175` `MAX_STALL_RETRIES`（本轮修）
  //   ⚠️ **还差一点就抄错一个同值不同义的**：`vessel_config.py:65` 的 `max_subtask_depth = 2`
  //     —— 同为 **2**，但它是**子任务嵌套深度**、**不是"空转次数"**。
  //     ⇒ **同值不同义** + **指错文件** = 数字对、名字对、出处错 —— **最难发现的一类**。
  // 【判据】**行为判据**：对一组 (常量名 → 期望值) 的白名单，
  //   若原版仓在（`D:\app\omc`）⇒ 逐条断言"该常量在原版里被定义成那个值"；
  //   **拿不到原版仓 ⇒ 报未验证**（不猜）。
  //   ⚠️ 刻意**不查"引用写没写对文件名"**（那要么漏、要么因同义不可判）——
  //     查的是**更强的东西：那个数在原版里真的存在吗、值对不对**。
  {
    const ORIG = 'D:/app/omc/src/onemancompany'
    const originals = existsSync(ORIG) ? ORIG : ''
    if (originals === '') {
      CHECK('H44', null, '硬数字与原版源码一致（常量名 → 值）',
        '**未验证**：这台机器上没有原版仓 `D:/app/omc` ⇒ 不猜、不假装', '原版仓不在')
    } else {
      // 白名单：常量名 → 期望值（本轮 + R90 逐条读源码得来）
      const WANT = [
        ['MAX_REVIEW_ROUNDS', '3'],
        ['MAX_CHILDREN_PER_NODE', '10'],
        ['MAX_TREE_DEPTH', '6'],
        ['MAX_HOLD_SECONDS', '1800'],
        ['MAX_STALL_RETRIES', '2'],
        ['max_retries: int', '3'],
        // ⚠️ `retry_delays` 在原版是 `field(default_factory=lambda: [5, 15, 30])` ——
        //   值**不在 `=` 后面直接给**，所以"`=` 后取首值"的通用判据抓不到它。
        //   ⇒ 单独用一条**更宽松**的判据：该行整体要包含 `[5, 15, 30]`。
      ]
      const wrong = []
      const seen = []
      for (const [name, want] of WANT) {
        // 在原版里递归找这个常量的定义
        let found = false
        const walk = (d, depth) => {
          if (found || depth > 4) return
          let es = []
          try {
            es = readdirSync(d, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of es) {
            if (found) return
            const p = join(d, e.name)
            if (e.isDirectory()) walk(p, depth + 1)
            else if (/\.py$/.test(e.name)) {
              let t = ''
              try {
                t = readFileSync(p, 'utf8')
              } catch {
                continue
              }
              // ⚠️⚠️ **原版仓的文件是 CRLF** ⇒ 必须 `split(/\r?\n/)`。
              //   我第一版用 `split('\n')` ⇒ 每行尾部残留 `\r` ⇒ **JS 的 `$` 不匹配 `\r` 之前的空位**
              //   （`$` 只认字符串末尾或末尾 `\n` 之前）⇒ `/=\s*(.+)$/` 对**每一行都返回 null**
              //   ⇒ H44 **全部报"对不上"**（假红）。⇒ **这是我第 2 次栽在同一个 CRLF 坑上**（R73 那次是切行）。
              for (const line of t.replace(/\r\n/g, '\n').split('\n')) {
                // ⚠️ **别把正则塞进模板字面量** —— 我第一版把 `new RegExp(` 整个嵌进多行模板，
                //   反斜杠被 JS 先转义一次 ⇒ 正则变废。⇒ **先算好 `esc`，再 `new RegExp`**。
                const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                const re = new RegExp('^\\s*' + esc + '\\s*(?::[^=]+)?=\\s*(.+)$')
                const m = re.exec(line)
                if (m === null) continue
                seen.push(`${name}=${m[1].trim().split('#')[0].trim()}`)
                if (m[1].trim().split('#')[0].trim().startsWith(want)) found = true
                break
              }
            }
          }
        }
        walk(originals, 0)
        if (!found) wrong.push(`${name}（期望 ${want}）`)
      }
      // 单独查 `RETRY_DELAYS = [5, 15, 30]`（`vessel.py:81`）—— 它是**模块级常量**，不是 dataclass 字段
      {
        let ok = false
        const walk2 = (d, depth) => {
          if (ok || depth > 4) return
          let es = []
          try {
            es = readdirSync(d, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of es) {
            if (ok) return
            const p = join(d, e.name)
            if (e.isDirectory()) walk2(p, depth + 1)
            else if (/\.py$/.test(e.name)) {
              let t = ''
              try {
                t = readFileSync(p, 'utf8')
              } catch {
                continue
              }
              if (/^\s*RETRY_DELAYS\s*=\s*\[\s*5\s*,\s*15\s*,\s*30\s*\]/m.test(t.replace(/\r\n/g, '\n'))) ok = true
              // dataclass 形态：`retry_delays: list[int] = field(default_factory=lambda: [5, 15, 30])`
              if (/retry_delays[^\n]*\[5,\s*15,\s*30\]/.test(t.replace(/\r\n/g, '\n'))) ok = true
            }
          }
        }
        walk2(originals, 0)
        if (!ok) wrong.push('RETRY_DELAYS/retry_delays（期望 [5, 15, 30]）')
      }
      CHECK('H44', wrong.length === 0,
        '★★★ **我们抄的每个"硬数字"，在原版源码里都真的存在、且值对**（常量名 → 值）',
        '指错文件 / 抄错值 ⇒ 读者按图索骥会**找到一段无关代码**（R90/R91 各抓到一次）；' +
          '⚠️ 最险的是**同值不同义**（`max_subtask_depth=2` 是深度、不是"空转次数"）',
        wrong.length === 0 ? `${WANT.length} 个常量全部对上（实际读到：${seen.slice(0, 3).join(' / ')} …）` : `**对不上：${wrong.join(', ')}**`)
    }
  }

  // ── H45 · ★★★ **一行里列了多个数，就要给多个出处**（2026-09-14 / Round 92）──────
  // 【为什么要立】R90 与 R91 **各抓到一次同一族的错**：
  // ```
  //   R90｜teamkit-org §2：「单节点执行超时 3600s ← `vessel.py`」
  //        ⇒ vessel.py 里**没有** 3600；真出处 script_backend.py:26 / tree_tools.py:234
  //   R91｜DESIGN-OMC.md：「原版的硬数字（照抄 `config.py:358-361` 与 `vessel_config.py`）…
  //        空转重试 **2**」 ⇒ 那个 2 **不在这两处**；真出处 `core/vessel.py:175`
  // ```
  //   ⇒ 两处的形状完全一样：**一个单元格/一行里列了 N 个数，却只给一个出处**
  //     ⇒ **那个出处一旦不覆盖全部，剩下的数就成了"看起来有依据的无依据数字"**。
  //   R91 的元教训里我写了"已可以考虑做成判据" —— **这就是它**。
  // 【判据】活文档里，**同一行**若出现 **≥2 个"加粗的数字"**（`**10**` / `**1800s**` 之类）
  //   **且**只给了 **1 个** `file:line` 指针 ⇒ 报可疑（要求"逐数给出处"或"那个出处覆盖全部"）。
  //   ⚠️ 允许的写法：`A **10** / B **6** ← \`x.py:1-9\`；C **3** ← \`y.py:2\``
  //     —— 即**指针数 ≥ 数字数**，或每个数后面都紧跟自己的指针（本判据按"指针数 ≥ 数字数"判）。
  {
    const liveDocs = []
    try {
      for (const f of readdirSync(join(PLUGIN_DIR, '..'))) {
        if (/\.(md|yml)$/.test(f)) liveDocs.push(join(PLUGIN_DIR, '..', f))
      }
      for (const e of readdirSync(join(PLUGIN_DIR, '..', 'skills'), { withFileTypes: true })) {
        if (e.isDirectory()) liveDocs.push(join(PLUGIN_DIR, '..', 'skills', e.name, 'SKILL.md'))
      }
    } catch {
      /* 目录不在就算了 */
    }
    const flagged = []
    for (const f of liveDocs) {
      if (!existsSync(f)) continue
      let t = ''
      try {
        t = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      t
        .replace(/\r\n/g, '\n')
        .split('\n')
        .forEach((l, i) => {
          // ⚠️ **别把"加粗数字"写得太窄**（R79 的教训：判据抽得太少 = 静默漏检）：
          //   第一版我用 `\*\*\d+(?:\.\d+)?s?\*\*` ⇒ **只认 `**10**` 这种纯数字加粗**，
          //   而 `**≤ 3**` / `**10 个**` / `**1800s**` 里的短描述形式**全被漏掉**。
          //   ⇒ 改成 **"加粗段内含数字，且段内不超过 12 字符"**（短 = 是个数/阈值，不是整句） ——
          //     这样既能抓到 `**10**`/`**≤ 3**`/`**1800s**`/`**10 个**`，
          //     又不会把 `**（重名检查 …）**` 这种整句当数字。
          // ⚠️⚠️ **"加粗数字"的判据试了三版才稳**（每版都被自己的读数打回）：
          //   ① `\*\*\d+(?:\.\d+)?s?\*\*`（纯数字）⇒ 太窄：漏掉 `**≤ 3**` / `**10 个**` 这类真实写法
          //   ② `\*\*[^*\n]{0,12}\d[^*\n]{0,12}\*\*`（短加粗段内含数字）⇒ 太宽：
          //      把 **`**R91 更正出处**`**（含数字的**词**）也算成一个"数" ⇒ 它多算了 1 个 ⇒ **假红**
          //   ③ ⇒ **正解：加粗段去掉标记后，必须以"数字结尾"或"数字+单位/量词结尾"**
          //      （`10` / `1800s` / `≤ 3` / `10 个` 都成立；`R91 更正出处` 不成立）
          const nums = (l.match(/\*\*[^*\n]{0,12}\d+(?:\.\d+)?\s*(?:s|个|条|处|行|次|轮|人|天|小时|秒)?\*\*/g) ?? []).length
          if (nums < 2) return
          // ⚠️ **只数"源码类"指针**（判据的主题是"归属覆盖"）。
          //   三次试出来的边界（都被自己的假阳/假阴打过）：
          //     ① 放宽成"任何 `file:line`" ⇒ 把「时间戳 …`LEAD-VERIFY.md:288`…」这种**日志引用**也报（假阳）
          //     ② 收紧成"必须含 `core/`/`agents/`/`acp/` 前缀" ⇒ **R91 的真实历史形态写的是
          //        `` `config.py:358-361` ``（**裸文件名、没有目录前缀**）⇒ **判不死**（假阴，当场发现）
          //     ③ ⇒ **正解：认 `.py`/`.js`/`.ts` 后缀 + `:行号`，允许路径可选**。
          const ptrs = (l.match(/`[^`]*\.(?:py|js|ts):[\d,\-]+`/g) ?? []).length
          if (ptrs === 0) return
          // ⚠️ 排除"更正留痕"行（它们**就是在解释**当初指错的事，引述旧写法是正常的）
          if (/更正|原先写的是|R9\d/.test(l)) return
          if (ptrs < nums) flagged.push(`${f.split(/[\\/]/).slice(-1)[0]}:${i + 1}（${nums} 数 / ${ptrs} 指针）`)
        })
    }
    CHECK('H45', flagged.length === 0,
      '★★★ **一行里列了多个"硬数字"，就要有同样多的 `file:line` 指针**（一个出处未必覆盖全部）',
      'R90/R91 **各抓到一次**：表格把 N 个数打包给一个出处，而其中某个**不在那儿** ⇒ 那个数成了"看起来有依据的无依据数字"',
      flagged.length === 0 ? `活文档里没有"多数 + 少指针"的行 ✓` : `**可疑：${flagged.slice(0, 5).join(', ')}**`)
  }

  // ── H46 · ★★★ **探针"写共享对象却无回读校验"⇒ 判红**（2026-09-14 / task-85；`RULES.yml` R2）──
  // 【为什么立它】**P0 事故**（2026-09-14）：一支探针包了 `at.journal.state` 并往 task 上注入
  //   `e2rProbe:'INST-WRAP'` ⇒ 那个对象**被底座经 `team/task` 持久化** ⇒ `.strict()` 拒
  //   ⇒ `state.failure` 置位且**永不自愈** ⇒ **全公司读不到板**（`INCIDENT-P0-BOARD-CORRUPTION.md`）。
  // 【判据】`RULES.yml R2`：「探针源码里出现『对入参对象赋值 / 改原型』却**无回读校验** ⇒ 判红，**没有例外**」。
  //   ⚠️ **只写注释说"会还原"不算**（`H41` 家族：**文案不是机制**）—— 判据**先剥注释**，
  //     所以"我会还原"那句注释**不产生豁免**。
  // 【★ 扫描范围（我定的，给理由）】
  //   · **扫 `runs/005-role-skills/exp/**`（81 个历史探针件）但只当"当前违规"判红**，
  //     而把**事故已记录在案的那支**放进 `KNOWN` 白名单并**写明事故编号** ⇒
  //     **历史留痕有交代、当前违规必红** —— 避免 `H29` 那种"恒红没人看"。
  //   · ⚠️ **真正危险的那支 `dev_stage_add` inline 探针从不落盘** ⇒ 文件扫描**结构性抓不到**。
  //     ⇒ 所以 `H46` **还断言那个可复用校验函数存在且可用**（`teamkit probe-check`），
  //       让 **inline 探针也有得检** —— 否则这条断言只防"落盘的"，防不住**真出过事的那一类**。
  {
    // ① 校验函数**自证**（变异测试：红/绿两条都要过 —— 判据自己要先会跑）
    //    ⚠️ 这是**本断言的核心**：光有规则不算，**要贴"真报红了"的输出**。
    const RED_SAMPLE = `
      // 探针：包 journal.state 注入字段（事故的形态）
      async function probe(args, ctx) {
        const at = ctx.get('agentTeams')
        const orig = at.journal.state
        at.journal.state = function (r) {
          const s = orig.call(this, r)
          return { ...s, tasks: s.tasks.map(t => ({ ...t, e2rProbe: 'INST-WRAP' })) }
        }
        return 'done' // 我会还原的（注释不算证据）
      }
    `
    const GREEN_SAMPLE = `
      async function probe(args, ctx) {
        const at = ctx.get('agentTeams')
        const orig = at.journal.state
        at.journal.state = function (r) { return orig.call(this, r) }
        // ★ 回读校验：改完读回来比对（这是**代码**，不是注释）
        const restored = at.journal.state === orig
        at.journal.state = orig
        const readback = at.journal.state === orig
        return { restored, readback }
      }
    `
    const redR = checkProbeSource(RED_SAMPLE)
    const greenR = checkProbeSource(GREEN_SAMPLE)
    CHECK('H46', redR.ok === false && redR.violations.length > 0,
      '★★★ **变异测试①：「写共享对象且无回读」的假探针 ⇒ 判红**',
      '断言自己不会跑 ⇒ 判据形同虚设（本项目固定陷阱："判据自己不会跑"）',
      `ok=${redR.ok} violations=${redR.violations.length} kind=${redR.violations.map((v) => v.kind).join(',')}`)
    CHECK('H46', greenR.ok === true,
      '★★★ **变异测试②：「写了但带回读校验」⇒ 判绿**（否则就是"一律判红"的恒红判据）',
      '只会判红 ⇒ 与 `H29` 同族：没人看的判据 = 没有判据',
      `ok=${greenR.ok} why=${String(greenR.why).slice(0, 50)}`)
    // ② **"只写注释声称会还原"必须判红**（`H41` 家族：文案不是机制）——
    //    这是本判据最容易做成"纸老虎"的一格，单独立一条。
    const COMMENT_ONLY = `
      async function probe(args, ctx) {
        const at = ctx.get('agentTeams')
        // 注意：我下面会还原（只写注释，没有任何回读代码）
        at.journal.state = function (r) { return r }
        return 'ok'
      }
    `
    const cR = checkProbeSource(COMMENT_ONLY)
    CHECK('H46', cR.ok === false,
      '★★★ **只写注释说"会还原"⇒ 仍判红**（文案不是机制 —— `H41` 家族）',
      '注释能被当成豁免 ⇒ 探针作者只要写一句"我会还原"就能绕过这条纪律',
      `ok=${cR.ok} violations=${cR.violations.length}`)

    // ③ 真语料扫描：**当前违规必须为 0**（历史留痕按 `KNOWN` 交代，不是沉默）
    const expRoot = join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'exp')
    const KNOWN = {
      // 事故已记录在案的那支（**历史留痕，有交代**）⇒ 不重复判红；但**必须指到事故编号**
      'member-release/lib/index.js':
        'R20 时期的 journal.state 包装探针；**事故编号 `INCIDENT-P0-BOARD-CORRUPTION.md`**；' +
        '它**有**回读（`restored=${journal.state === origState}`）⇒ 现在也应判绿',
    }
    const mjs = []
    {
      // ★★ **2026-09-15 修正：备份/镜像件不进"当前违规"口径**（`R24` 家族：判据取错范围 ⇒ 假红）
      // ```
      // 现场：`docs-writer` 做 `task-104` 时，按"改前逐字节备份"的纪律把文件拷到
      //   `exp/duty-probe/backup-pre-stage1/`（**那是备份，不是探针**）——
      //   其中 `teamkit.mjs` 是**旧版本的生产文件** ⇒ 它含 `at.journal.state = function (r) {`
      //   （**生产文件里本来就有这个形态**，`H46` 的 `RED_SAMPLE` 也引用了它）
      //   ⇒ **`H46` 把它当"当前违规"判红** ⇒ **假红**（不是执行者违规，是我的范围取错）。
      // ```
      // ★★★ **但"按目录名排除"会开一个洞（CEO 指出，我采纳）**：
      // ```
      // 若只看名字（`backup-*`）⇒ **真违规只要放进一个叫 backup- 的目录就能藏** ⇒
      //   那是"给违规发了一张免检票"，正是 `R14` 要防的"判据通胀"。
      // ⇒ 正确判据 = **按内容身份**：
      //     · 该文件**与某个【产品文件】逐字节相同** ⇒ 它是**复制品**（备份/镜像）⇒ 跳过
      //     · 否则 ⇒ **照扫照判**（**哪怕它在 `backup-*/` 里**）
      // ⇒ 这样：**备份被豁免（因为它就是那份产品文件的副本）**，
      //   而**"违规藏在备份目录里"仍然会被抓到**（它与产品文件不同）。
      // ```
      // 能红的判据（写进注释，供后人验）：**造一个"在 `backup-*/` 里、内容是【伪造的】违规探针"**
      //   ⇒ **必须仍被判红**（因为它与任何产品文件都不逐字节相同）。
      const PRODUCT_DIRS = ['lib', 'bin', 'scripts', 'tools'].map((d) => join(PLUGIN_DIR, d))
      // 用**已 import 的** `node:crypto`（**不新增顶层 import** —— 避免动到别处的契约）
      const { createHash } = await import('node:crypto')
      const sha = (f) => {
        try { return createHash('sha256').update(readFileSync(f)).digest('hex') } catch { return undefined }
      }
      // ① 产品文件的哈希集（"什么算复制品"的基准）
      const productHashes = new Set()
      const collect = (d) => {
        let es = []
        try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of es) {
          const f = join(d, e.name)
          if (e.isDirectory()) collect(f)
          else if (/\.(mjs|js)$/.test(e.name)) {
            const h = sha(f)
            if (h !== undefined) productHashes.add(h)
          }
        }
      }
      for (const d of PRODUCT_DIRS) collect(d)
      // ② 遍历语料，**跳过"与产品文件逐字节相同"的复制品**（备份/镜像）
      //    ⚠️ **不按目录名排除** —— 那会让"真违规藏在 backup-*/ 里"免检（CEO 指出）
      const walk = (d, depth) => {
        if (depth > 6) return
        let es = []
        try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of es) {
          const f = join(d, e.name)
          if (e.isDirectory()) { walk(f, depth + 1); continue }
          if (!/\.(mjs|js)$/.test(e.name)) continue
          const h = sha(f)
          if (h !== undefined && productHashes.has(h)) continue // ★ 复制品 ⇒ 不是"当前违规语料"
          mjs.push(f)
        }
      }
      walk(expRoot, 0)
    }
    const corpusViolations = []
    for (const f of mjs) {
      let t = ''
      try { t = readFileSync(f, 'utf8') } catch { continue }
      const r = checkProbeSource(t)
      if (r.ok) continue
      const rel = f.replace(/\\/g, '/').split('/exp/')[1] ?? f
      if (KNOWN[rel] !== undefined) continue // 历史留痕：有交代
      corpusViolations.push(`${rel}:${r.violations[0].line}(${r.violations[0].kind})`)
    }
    CHECK('H46', corpusViolations.length === 0,
      '★★★ **`exp/**` 语料里没有"当前违规"**（历史留痕按 `KNOWN` 逐条交代，不用沉默代表豁免）',
      '一律判红 ⇒ `H29` 那种"恒红没人看"；一律放过 ⇒ 断言没有用',
      `扫了 ${mjs.length} 个探针件；当前违规 ${corpusViolations.length}` +
        (corpusViolations.length > 0 ? ` ⇒ **${corpusViolations.slice(0, 4).join(', ')}**` : ' ✓'))

    // ④ ★ **inline 探针那一支**：文件扫描抓不到 ⇒ **断言"有可复用的检查口"存在**
    //    （`dev_stage_add` 的 execute 从不落盘 ⇒ 没有这个口，本断言就只防落盘件，防不住真出事的形态）
    const selfSrc = (() => { try { return readFileSync(fileURLToPath(import.meta.url), 'utf8') } catch { return '' } })()
    // ⚠️⚠️ **判据要查"判据本体在哪导出"**，不是"在 `bin/teamkit.mjs` 里导出"。
    //   2026-09-14 / task-92：我把 `checkProbeSource` **移到 `lib/probe-source.js`**（两个消费者要同一份代码），
    //   `bin/` 只 `re-export` ⇒ 原来那条"扫自身找 `export function checkProbeSource`"**当场红**。
    //   ⇒ 这是**移动代码时的连带项**：断言必须跟着"事实来源"走，否则它会**惩罚正确的重构**。
    const libSrc = (() => { try { return readFileSync(join(PLUGIN_DIR, 'lib', 'probe-source.js'), 'utf8') } catch { return '' } })()
    const hasExport = /export function checkProbeSource\s*\(/.test(libSrc)
    // ⚠️⚠️ **不能直接 `/case 'probe-check'/` 扫全文** —— 那会**命中本行自己**
    //   （本断言的字面量里就写着这个串）⇒ **恒真 ⇒ 空断言**。我第一版正是如此，靠"逐行核一遍"抓到。
    //   判据改成：**必须在 `switch (cmd)` 之后的派发区里**找到它（排除本断言所在的 H 组）。
    const dispatchAt = selfSrc.indexOf('switch (cmd)')
    const afterDispatch = dispatchAt === -1 ? '' : selfSrc.slice(dispatchAt)
    const hasSubcmd = /case 'probe-check':/.test(afterDispatch)
    // ★ 还要断言 **CLI 真的把名字带进作用域**（`export {…} from` 不导入 ⇒ `ReferenceError`）：
    //   我 task-92 就踩过 —— `node --check` 查语法查不出未定义引用，**只有真跑**才现形。
    const importsLocally = /import \{ checkProbeSource \} from '\.\.\/lib\/probe-source\.js'/.test(selfSrc)
    CHECK('H46', hasExport && hasSubcmd && importsLocally,
      '★★★ **inline 探针有得检**：`checkProbeSource` 在 `lib/probe-source.js` 导出 **且** 派发区有 `probe-check`' +
        ' **且** CLI 真把它 `import` 进作用域',
      '只扫落盘文件 ⇒ **结构性防不住真出事的那一类**；而"导出但没 import" ⇒ `ReferenceError`（`node --check` 查不出）',
      `lib 导出=${hasExport} 派发区=${hasSubcmd} CLI 已 import=${importsLocally}`)
  }

  // ── H47 · ★★★ **"释放 owner" 会不会造出下游死锁**（2026-09-14 / `RULES.yml` R6）──
  // 【现场】`task-69` 被 release（owner 空、status=pending），而 `task-68 blocked_by=[task-69]`
  //   ⇒ **下游永久不 ready**，且**板上没有任何信号**（看起来只是"有个 pending 任务"）。
  //   根因：owner 把"更新描述 + 释放 owner"当成了"交付"。
  // 【判据】纯函数 `releaseWouldDeadlock(tasks, taskId)`：
  //   · 该任务 `status !== 'completed'` **且** 有**未完成**任务 `blockedBy` 指向它 ⇒ **会死锁**（true）
  //   · 该任务已完成 / 没有下游 / 下游都已完成 ⇒ 安全（false）
  //   · **拿不到 tasks**（null / 非数组）⇒ 返回 `undefined`（**未获取**，不是"安全"）
  //     —— 这条防的是"读不到 ⇒ 当成没问题"（本项目反复栽的那一类）。
  // 【本项目老坑】不用"注释里写着会检查"当证据：**必须真跑**四条输入（变异测试在下面）。
  {
    const releaseWouldDeadlock = (tasks, taskId) => {
      if (!Array.isArray(tasks)) return undefined
      const self = tasks.find((t) => t?.id === taskId)
      if (self === undefined) return undefined
      if (self.status === 'completed') return false
      return tasks.some(
        (t) => t?.id !== taskId && t?.status !== 'completed' && Array.isArray(t?.blockedBy) && t.blockedBy.includes(taskId),
      )
    }
    const T = (id, status, blockedBy = []) => ({ id, status, blockedBy })
    // ① 真死锁形态（现场复刻）：pending 的 task-69 被 task-68 依赖
    const c1 = releaseWouldDeadlock([T('task-69', 'pending'), T('task-68', 'pending', ['task-69'])], 'task-69')
    // ② 安全：下游已完成
    const c2 = releaseWouldDeadlock([T('task-69', 'pending'), T('task-68', 'completed', ['task-69'])], 'task-69')
    // ③ 安全：任务自己已完成
    const c3 = releaseWouldDeadlock([T('task-69', 'completed'), T('task-68', 'pending', ['task-69'])], 'task-69')
    // ④ 未获取：读不到 tasks
    const c4 = releaseWouldDeadlock(null, 'task-69')
    CHECK('H47', c1 === true,
      '★★★ **"释放 pending 任务且下游未完成" ⇒ 判会死锁**（`R6` 的现场复刻）',
      '不拦 ⇒ 下游**永久不 ready**，且板上没有信号（`task-69`/`task-68` 的现场）',
      `case①=${c1}（应为 true）`)
    CHECK('H47', c2 === false && c3 === false,
      '★★ **两条安全态不误报**：下游已完成 / 任务自己已完成 ⇒ 放行',
      '一律判死锁 ⇒ 变成"永远不让人 release"的恒红判据（`H29` 同族）',
      `case②=${c2} case③=${c3}（都应为 false）`)
    CHECK('H47', c4 === undefined,
      '★★ **读不到 tasks ⇒ 返回"未获取"**（不是"安全"）',
      '把"读不到"当"没问题" ⇒ 正是 `R3`/`H42` 那一族（我没看到 ≠ 不存在）',
      `case④=${String(c4)}（应为 undefined）`)
  }

  // ── H48 · ★★★ **探针闸门（`R2` 在线拦）七条判据**（2026-09-14 / task-92）──────────
  // 【为什么单列一组】它在 `guardReason` 里，而那是**每一次工具调用**都要过的路径
  //   （`:3127`；先查 global 层再走 `chainLayers(exec.agent)` —— **落在哪层都在这条热路径上**）
  //   ⇒ **误杀/变慢 = 该 scope 链上停摆** ⇒ 判据必须比"功能对不对"更严：**零影响 / fail-open / 不 await / 性能**。
  // 【七条】①普通工具原样放行 ②违规拒 ③合规放行 ④**故意抛错仍放行**（fail-open）
  //   ⑤**性能无可测差异** ⑥不 await / 不读盘 / 不抛（逐条） ⑦**注册路径成立**
  //   ⚠️ ⑦ 的**原措辞**是"**全局生效**有证据" —— **已更正**：真读数显示本闸落在
  //     `{"agentPreset":"omc"}` 层，**`standard` 的 agent 未被覆盖**（见 `probe-gate.js` 头部留痕）。
  //     本组**不谎称全局**；"只护 omc"是**已知缺口**（`RULES.yml R8`）。
  section('H48 · 探针闸门（R2 在线拦：tools.guard；默认开）')
  {
    const PG = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'probe-gate.js')).href)

    // ①-④ 纯函数级：直接驱动 guard（不需要真宿主）
    const g = PG.makeProbeGateGuard({ enabled: true })
    CHECK('H48', typeof g === 'function',
      '★★ **`makeProbeGateGuard({enabled:true})` 返回一个函数**',
      '拿不到 guard ⇒ 这道闸装不上（后面六条都无从谈起）',
      `typeof=${typeof g}`)

    // ① **普通工具 ⇒ 原样放行**（liveness 的第一格：非目标工具必须 O(1) 短路）
    const passNormal = g({ name: 'read', arguments: { file_path: '/x' } }) === undefined &&
      g({ name: 'pwsh', arguments: { command: 'ls' } }) === undefined &&
      g({ name: 'team_task_list', arguments: {} }) === undefined
    CHECK('H48', passNormal,
      '★★★ **① 普通工具（read/pwsh/team_task_list）一律原样放行**（返回 `undefined`）',
      '误杀普通工具 ⇒ **该 scope 链上每一次工具调用都失败**（它在 `guardReason` 热路径上，落哪层都一样）',
      `read/pwsh/team_task_list 都放行=${passNormal}`)

    // ② **违规 ⇒ 拒**（把事故形态喂进去）
    const RED = `async function p(a, ctx){const at=ctx.get('agentTeams');const orig=at.journal.state;at.journal.state=function(r){const s=orig.call(this,r);return {...s,tasks:s.tasks.map(t=>({...t,e2rProbe:'X'}))}};return 1}`
    const red = g({ name: 'dev_stage_add', arguments: { name: 'x', description: 'd', execute: RED } })
    CHECK('H48', typeof red === 'string' && /R2/.test(red) && /修法/.test(red),
      '★★★ **② 违规探针 ⇒ 拒**，且拒绝理由里**含 `R2` 与修法**',
      '拒了但不说怎么改 ⇒ 作者只能瞎试（而且这条必须"自带修法"才配默认开）',
      `返回=${typeof red} 含R2=${/R2/.test(String(red))} 含修法=${/修法/.test(String(red))}`)

    // ③ **合规 ⇒ 放行**
    const GREEN = `async function p(a, ctx){const at=ctx.get('agentTeams');const orig=at.journal.state;at.journal.state=function(r){return orig.call(this,r)};const readback=at.journal.state===orig;at.journal.state=orig;return readback}`
    const green = g({ name: 'dev_stage_add', arguments: { name: 'y', description: 'd', execute: GREEN } })
    CHECK('H48', green === undefined,
      '★★★ **③ 合规探针（带回读）⇒ 放行**（不许"一律拒绝"⇒ 那会废掉整个注入器）',
      '一律拒 ⇒ 与"拒绝一切 pwsh"同族错误：**把工具废掉当成了安全**',
      `返回=${String(green)}`)

    // ④ **fail-open 变异：故意让 guard 内部抛错 ⇒ 仍必须放行**
    //   做法：喂一个让判据内部炸的输入（`execute` 是个"会抛的 getter"）
    {
      const boom = { name: 'dev_stage_add', arguments: {} }
      Object.defineProperty(boom.arguments, 'execute', { get() { throw new Error('boom（模拟 guard 内部故障）') } })
      let threw = false
      let r
      try { r = g(boom) } catch { threw = true }
      CHECK('H48', threw === false && r === undefined,
        '★★★ **④ fail-open 变异：guard 内部抛错 ⇒ 该次调用仍被放行**（不抛、返回 `undefined`）',
        '护栏故障挡住正常工作 ⇒ **比没有护栏更糟**（它会把全公司停摆，而原因还藏在护栏里）',
        `抛了吗=${threw} 返回=${String(r)}`)
    }

    // ⑥ **不 await / 不读盘 / 不抛**（逐条）—— 用**源码静态核**（纯函数无 fs 依赖）
    {
      const gateSrc = (() => { try { return readFileSync(join(PLUGIN_DIR, 'lib', 'probe-gate.js'), 'utf8') } catch { return '' } })()
      const guardBody = gateSrc.slice(gateSrc.indexOf('return function probeGateGuard'), gateSrc.indexOf('catch {'))
      const noAwait = !/\bawait\b/.test(guardBody)
      const noFs = !/(readFileSync|existsSync|readdirSync|writeFileSync|appendFileSync)/.test(guardBody)
      const noThrow = !/\bthrow\b/.test(guardBody)
      CHECK('H48', noAwait && noFs && noThrow,
        '★★★ **⑥ guard 体内：不 `await` / 不读盘 / 不 `throw`**（逐条静态核）',
        'guard 是**同步**接口，且每次调用都跑 ⇒ await/读盘会把"每次调用"变成"每次 IO"（见⑤性能）',
        `noAwait=${noAwait} noFs=${noFs} noThrow=${noThrow}`)

      // ★ ⑤ **性能**：同一个 guard 在"非目标工具"上的耗时 —— 与"什么都不做"对比
      //   ⚠️ **判据**：p50 差异**不显著**（这里用"不超 1 个数量级"这种**保守**阈值 + 打印实测值；
      //     不写"很快"这种没有读数的话）。拿不到就报未获取。
      const N = 20000
      const baseline = () => { let s = 0; for (let i = 0; i < N; i += 1) s += i & 1; return s }
      const withGuard = () => { let s = 0; for (let i = 0; i < N; i += 1) { if (g({ name: 'read', arguments: {} }) !== undefined) s += 1; s += i & 1 } return s }
      const timeIt = (fn, runs = 7) => {
        const xs = []
        for (let i = 0; i < runs; i += 1) { const t0 = performance.now(); fn(); xs.push(performance.now() - t0) }
        xs.sort((a, b) => a - b)
        return xs[Math.floor(xs.length / 2)]
      }
      timeIt(baseline, 3); timeIt(withGuard, 3) // 预热
      const p50Base = timeIt(baseline)
      const p50Guard = timeIt(withGuard)
      const perCallNs = ((p50Guard - p50Base) / N) * 1e6
      CHECK('H48', Number.isFinite(perCallNs) && perCallNs < 1000,
        '★★★ **⑤ 性能：非目标工具上一次 guard 调用的**单次开销 < 1µs**（p50，逐次实测）',
        '每次调用都跑 ⇒ 若每次几十 µs，**该链上**工具调用整体变慢（CEO 有 `/api/state` 32.5–50% pending 的现场背景）',
        `p50 基线=${p50Base.toFixed(2)}ms / 带 guard=${p50Guard.toFixed(2)}ms ⇒ **单次 ≈ ${perCallNs.toFixed(1)}ns**（N=${N}）`)
    }

    // ⑦ **注册路径成立**（**不是**"证明全局生效" —— 那条已被真读数推翻，见 `probe-gate.js` 头）
    //   ⚠️ 这里**不假装能在 selftest 里观察真宿主**（那要真 agent）——
    //   判据只是「**注册路径确实调了 `ctx.tools.guard` 并拿到 disposer**」。
    //   ⚠️ **"生效范围"这一格 selftest 测不到** ⇒ 只能靠**真宿主探针**（已做过：本闸落 `omc` 层，
    //     `standard` 未覆盖）。**别把这条 ⑦ 读成"全局已证"。**
    {
      const calls = []
      const fakeCtx = {
        tools: {
          guard(fn) { calls.push({ hasFn: typeof fn === 'function' }); return () => {} },
        },
      }
      const r = PG.registerProbeGate(fakeCtx, { enabled: true, log: () => {} })
      CHECK('H48', r.ok === true && calls.length === 1 && typeof r.dispose === 'function',
        '★★ **⑦ 注册路径成立**（`ctx.tools.guard(fn)` 被真调一次，且拿到 `dispose`）',
        '拿不到 disposer ⇒ **卸不净**（它在热路径上，卸不净比装不上更糟）',
        `ok=${r.ok} guard 调用=${calls.length} 有 dispose=${typeof r.dispose === 'function'}`)
      // 逃生开关：关掉 ⇒ **不注册**（返回 disabled，且由调用方打"这道闸已关"）
      const off = PG.registerProbeGate(fakeCtx, { enabled: false, log: () => {} })
      CHECK('H48', off.ok === false && off.why === 'disabled' && calls.length === 1,
        '★★ **逃生开关：`enabled=false` ⇒ 一个 guard 都不注册**（`why=disabled`）',
        '关不掉 ⇒ 用户遇到误杀时**无路可走**（默认 true 的前提就是"必须能关"）',
        `ok=${off.ok} why=${off.why} guard 调用仍为=${calls.length}`)
      // 底座没有 guard ⇒ **失败不静默**（返回具体 why，不冒充"已生效"）
      const noApi = PG.registerProbeGate({ tools: {} }, { enabled: true, log: () => {} })
      CHECK('H48', noApi.ok === false && String(noApi.why).includes('tools.guard'),
        '★★ **底座没有 `tools.guard` ⇒ 报具体 why**（不冒充"已生效"）',
        '静默失败 ⇒ 用户以为被保护了，实际没有（`H41` 家族）',
        `ok=${noApi.ok} why=${noApi.why}`)
    }
  }

  // ── H49 · ★★★ **README 里写的"默认 X"必须与 `config.js` 的 `DEFAULTS` 一致**（2026-09-14 / task-98）──
  // 【为什么单列】CEO 现场抓到一条**给开源用户的假信息**：
  //   `plugin/README.md` 的**限制/配置表**写着「`memberRelease.enabled` 默认**关**」，
  //   而 `plugin/lib/config.js` 的真默认值是 **`true`**（委托方定向"撤人必须默认打开"）。
  //   ⇒ **漏写是缺信息；写错是给假信息** —— 而它在**专门给开源用户看的**那一节 ⇒ 直击北极星。
  // 【判据】凡是能从 `DEFAULTS` 直接读出的布尔/数字默认值，README 里那行**必须**与它一致。
  //   ⚠️ **只查"我们能机械对账的"那几个键**（`enabled` 类）—— 不追求覆盖全部配置项
  //     （那会变成脆的文本解析器；**宁可少而准**）。加一个键就加一行白名单。
  //   ⚠️ **红线检查**：README 同一行里若同时出现「默认**关**」与真值 `true`（或反之）⇒ **判红**。
  {
    let rd = ''
    try { rd = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rd = '' }
    const cfg = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'config.js')).href)
    // `DEFAULTS` 未必导出 ⇒ 用 `resolveAll` 的产物对账（它一定会把默认值解析出来）
    let resolved = undefined
    try { resolved = cfg.resolveAll({}, { dshHome: join(tmpdir(), 'teamkit-h49'), cwd: join(tmpdir(), 'teamkit-h49') }) } catch { resolved = undefined }
    // 判据表：README 里的**配置键** → 从 resolved 取真值的路径
    const PAIRS = [
      { key: 'memberRelease.enabled', path: ['memberRelease', 'enabled'] },
      { key: 'probeGate.enabled', path: ['probeGate', 'enabled'] },
      { key: 'guard.enabled', path: ['guard', 'enabled'] },
      { key: 'e2r.enabled', path: ['e2r', 'enabled'] },
      { key: 'e2r.structure', path: ['e2r', 'structure'] },
      { key: 'e2r.schemaPatch', path: ['e2r', 'schemaPatch'] },
    ]
    const pick = (o, p) => p.reduce((a, k) => (a === undefined ? undefined : a[k]), o)
    const bad = []
    const checked = []
    for (const { key, path } of PAIRS) {
      const truth = pick(resolved, path)
      if (typeof truth !== 'boolean') continue // 取不到真值 ⇒ 不判（不许编）
      // 找 README 里含该键名的那一行
      const line = rd.split('\n').find((l) => l.includes('`' + key + '`'))
      if (line === undefined) continue
      // 该行声明的默认值：**粗体**里的 true/false，或"默认开/默认关"字样
      const saysTrue = /(\*\*`?true`?\*\*)|默认\s*开|\*\*默认\*\*开/.test(line)
      const saysFalse = /(\*\*`?false`?\*\*)|默认\s*关|\*\*默认\*\*关/.test(line)
      const declared = saysTrue === saysFalse ? undefined : saysTrue
      if (declared === undefined) continue // 该行没明确表态 ⇒ 不判（避免假红）
      checked.push(key)
      if (declared !== truth) bad.push(`${key}: README 说「${declared ? '开' : '关'}」/ 真值「${truth ? '开' : '关'}」`)
    }
    CHECK('H49', bad.length === 0,
      '★★★ **README 里"默认 X"与 `config.js` 真值一致**（只对账能机械读出的那几个 `enabled` 类键）',
      '漏写是缺信息，**写错是给假信息** —— 而它在**专门给开源用户看的**那一节（直击北极星）',
      bad.length === 0
        ? `对账 ${checked.length} 个键全部一致 ✓（${checked.join(', ')}）`
        : `**不一致**：${bad.join(' | ')}`)

    // ── ② ★ **"我们已有但 README 没写"的存在性**（CEO 追加，`task-98` 同批）──────
    // 【为什么要有它】我们有**真读数**却不在 README 里写 = **把诚实留给自己、把坑留给用户**。
    //   现场：`A2A-BOUNDARY.md` 有 7 条真调（含"向下扩编被硬拦"），而 README **只顺带提了一句 A2A**。
    //   对用户的后果：他会以为"manager 能扩编"，撞到 `TEAM_LEAD_REQUIRED` 后以为是 bug。
    // 【判据】**存在性**（grep 得到关键词即可）—— ⚠️ 只断言"有这一节"，**不判内容对错**
    //   （内容对错要靠人核；把"内容质量"做成机械判据 = 判据通胀）。
    //   ⇒ 加一个能力就加一行；**这一行本身就是"README 必须覆盖它"的承诺**。
    {
      const MUST_APPEAR = [
        { kw: 'A2A', why: 'README 必须写 A2A 的真实边界（我们有 A2A-BOUNDARY.md 的 7 条真读数）' },
        { kw: 'only the Team Lead can create teammates', why: '向下扩编被硬拦的**原始报错**要写出来（用户会撞到）' },
      ]
      const missing = MUST_APPEAR.filter((m) => !rd.includes(m.kw))
      CHECK('H49', missing.length === 0,
        '★★ **"我们已有真读数"的能力/边界，README 里必须有落点**（存在性，不判内容）',
        '有读数不写 = **把坑留给用户**；而"用户撞到才发现在"正是北极星最恨的形态',
        missing.length === 0
          ? `${MUST_APPEAR.length} 条都写了 ✓`
          : `**缺**：${missing.map((m) => m.kw).join(' | ')}（${missing.map((m) => m.why).join('；')}）`)
    }

    // ── ③ ★ **限制节的每条，要么有依据、要么标「未获取」**（CEO 追加）──────────
    // 【判据】在 `## 限制` 到下一个 `## ` 之间，每个 `### N.` 小节**必须**出现可核证据之一：
    //   ① 一个 `文件:行号` 引用  ② 一个 `status:"…"` / `Error: …` 原始返回片段
    //   ③ 显式写「未获取」/「未验证」
    //   ⇒ **没有证据也没标未获取 ⇒ 那条限制是"空口"**（`H41` 家族：文案不是机制）
    //   ⚠️ 只对小节标题向后到下一个标题之间取段落；**找不到小节结构 ⇒ 不判**（避免假红）。
    {
      const i = rd.indexOf('## 限制')
      const j = i === -1 ? -1 : rd.indexOf('\n## ', i + 1)
      const section = i === -1 ? '' : j === -1 ? rd.slice(i) : rd.slice(i, j)
      const noEvidence = []
      if (section !== '') {
        // 拆 `### N.` 小节
        const parts = section.split(/\n### /).slice(1)
        for (const p of parts) {
          const title = p.split('\n')[0].trim().slice(0, 40)
          const body = p
          const hasFileLine = /[\w./-]+:\d+(-\d+)?/.test(body) // `roster.d.ts:14` 这类
          const hasRaw = /(status:"|Error:|TEAM_[A-Z_]+|"code":)/.test(body)
          const hasUnknown = /未获取|未验证|未实测/.test(body)
          if (!hasFileLine && !hasRaw && !hasUnknown) noEvidence.push(title)
        }
      }
      CHECK('H49', noEvidence.length === 0,
        '★★ **限制节每条：要么有依据（`文件:行号` / 原始返回），要么显式标「未获取」**',
        '空口限制 = **文案不是机制**（`H41`）：读者无法复核，也就无法判断该不该信',
        section === ''
          ? '没找到 `## 限制` 节（标题变了？）'
          : noEvidence.length === 0
            ? `限制节共 ${(section.match(/\n### /g) ?? []).length} 条，全部有依据或标了未获取 ✓`
            : `**无依据**：${noEvidence.join(' | ')}`)
    }
  }

  // ── H50 · ★★ **复盘必须有「减少人工动作」那一栏**（2026-09-14 / `AI-COMPANY-FORM.md` C2）──
  // 【它拦的真实事故（**已实测，就发生在今天**）】
  //   扫两份 `runs/005-role-skills/INCIDENT-*.md`：grep「减少人工|减负|删掉.*规矩|机器替|省一步」⇒ **0 处**；
  //   逐条归类 P0 报告的 A1–A5：**5/5 全是"加约束 / 加文档 / 一次性动作"**。
  //   ⇒ 一条纪律**在它诞生的那个复盘里就没被遵守** ⇒ **不是"还没生效"，是"从来没生效"**。
  // 【判据（**只做存在性那半** —— 总工程师判：语义那半不可机械，见 `C2-JUDGMENT.md`）】
  //   每份 `INCIDENT-*.md` 必须：
  //     ① 有一节标题含「减少人工动作」（或同义）
  //     ② **非空**
  //     ③ 内含**依据指针**（`文件:行号` / 原始返回 / 显式「未获取」/「本轮无」）
  // 【为什么不判语义】"那条动作**真的**减负"要理解上下文 —— 关键词表一句话就能骗过
  //   ⇒ 硬做 = **判据通胀**（COO 警告过：都在填、没人看、最后全假）。
  // 【防坑（两条，必须留在注释里，防下一个人"加强"它）】
  //   ① **允许如实写「本轮无」** ⇒ 否则会逼人**编一个假减负**（比"没有"更坏）
  //   ② **不许做成数量指标**（"减负 ≥ 1 条"）= 指标式合规（`H43`/`H44` 同族）
  {
    const dir = join(PLUGIN_DIR, '..', 'runs', '005-role-skills')
    let reports = []
    try {
      reports = readdirSync(dir).filter((f) => /^INCIDENT-.*\.md$/.test(f))
    } catch {
      reports = []
    }
    const bad = []
    for (const f of reports) {
      let text = ''
      try {
        text = readFileSync(join(dir, f), 'utf8')
      } catch {
        bad.push(`${f}: 读不到`)
        continue
      }
      const m = text.match(/\n#{2,4}\s*[^\n]*减少人工动作[^\n]*\n([\s\S]*?)(?=\n#{2,4}\s|$)/)
      if (m === null) {
        bad.push(`${f}: **缺「减少人工动作」一节**`)
        continue
      }
      const body = m[1].trim()
      if (body.length === 0) {
        bad.push(`${f}: 那一节**是空的**`)
        continue
      }
      const hasPointer = /[\w./-]+:\d+|ERROR|Error:|status:"|未获取|本轮无|不适用/.test(body)
      if (!hasPointer) bad.push(`${f}: 那一节**没有依据指针**（要「文件:行号」/ 原始返回 / 「未获取」/「本轮无」）`)
    }
    CHECK('H50', reports.length > 0 && bad.length === 0,
      `★★ **每份事故复盘都有「减少人工动作」一栏**（非空 + 带依据指针；共 ${reports.length} 份）`,
      '**C2 的真实事故**：P0 报告 A1–A5 **5/5 都是"加约束"**，减负 **0 条** —— 复盘只加负担、从不减',
      reports.length === 0
        ? '**没扫到任何 `INCIDENT-*.md`**（目录变了？）'
        : bad.length === 0
          ? `${reports.length} 份都有该栏且带指针 ✓`
          : `**不合规**：${bad.join(' | ')}`)
  }

  // ── H51 · ★★★ **关键 JS 文件必须能被 parse**（2026-09-14 / 同一坑已出现两次）──
  // 【它拦的真实事故 ×2】
  //   · `docs-writer`（`task-57` 改 `--help`）：把 Markdown 反引号嵌进模板字符串 ⇒ **整个 CLI 语法崩**
  //   · 总工程师（本文件 `H50` 那段）：**同一个坑** ⇒ `SyntaxError: missing ) after argument list`
  //     ⇒ **整个 CLI 跑不起来**（`status` exit=1）
  // ⇒ ⚠️ **它比"某条断言失败"严重**：自测工具本身挂了 ⇒ **没人知道自己坏了**。
  // 【判据】**不写正则猜**（那要半个 JS parser，必然误报）——
  //   用 **`node --check`**：**Node 自己就是最权威的 parser**（`R13`：先找既有信号/既有机制）。
  // 【★ 诚实边界（**不许升格**）】
  //   ⚠️ **它查不了"自己"**：`teamkit.mjs` 若语法崩，`selftest` **根本起不来** ⇒ 本断言跑不到。
  //   ⇒ 所以它覆盖的是 **`plugin/lib/**` / `scripts/**` / `tools/**` 等"被别人 import 的件"**，
  //     对那些件它**确实能拦**（一崩就报红）。
  //   ⚠️ **要覆盖"自测入口本身" ⇒ 得在 `selftest` 之外跑**：
  //      `runs/005-role-skills/exp/board-diag/syntax-check.mjs`（独立脚本，**它先于 selftest 崩就发现**）
  //      + `syntax-check-mutation.mjs`（**变异测试**：已证"重现那个坑 ⇒ exit=1 且指名文件"）。
  //   ⇒ **不许**把本条说成"自测入口也被保护了"。
  {
    const GEN_DIRS = ['lib', 'scripts', 'tools'].map((d) => join(PLUGIN_DIR, d))
    const SELF = fileURLToPath(import.meta.url)
    const collect = (dir, out = []) => {
      let es = []
      try {
        es = readdirSync(dir)
      } catch {
        return out
      }
      for (const e of es) {
        if (e.startsWith('.') || e === 'node_modules') continue
        const p = join(dir, e)
        let st
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (st.isDirectory()) collect(p, out)
        else if (/\.m?js$/.test(e) && p !== SELF) out.push(p)
      }
      return out
    }
    const targets = GEN_DIRS.flatMap((d) => collect(d))
    const broken = []
    for (const t of targets) {
      const r = spawnSync(process.execPath, ['--check', t], { encoding: 'utf8' })
      if (r.status !== 0) {
        const first = String(r.stderr ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')[0]
        broken.push(`${relative(PLUGIN_DIR, t)}: ${first ?? 'parse 失败'}`)
      }
    }
    CHECK('H51', targets.length > 0 && broken.length === 0,
      `★★★ **关键 JS 件必须能被 parse**（\`node --check\`；共查 ${targets.length} 个：\`lib\`/\`scripts\`/\`tools\`）`,
      '语法崩 = **整个 CLI / 模块失效**（比"某条断言失败"严重：**自测挂了就没人知道自己坏了**）',
      targets.length === 0
        ? '**没扫到任何目标文件**（目录变了？）'
        : broken.length === 0
          ? `${targets.length} 个全部可 parse ✓（⚠️ 本条查不了 teamkit.mjs 自身 —— 见注释）`
          : `**不能 parse**：${broken.join(' | ')}`)
  }

  // ── B · ★★★ **重启后的恢复能力**（`task-106` B 段；2026-09-14）──────────────────
  // 【委托方原话】「重启之后就没法续接上之前的任务了……包括要把 goal 重新打开」
  // 【本组验的三件事 + **一条反例断言**】
  //   ① **活跃度来源必须是 `agents.list()`**（进程内运行时）—— **不是 `journal.phase`**
  //   ② **孤儿任务**能被机械列出（规则在 `lib/orphans.js`，`recover.js` **只做适配 + 委托**，`R10` 一份实现）
  //   ③ **板重放**（event-sourced 折叠）与当前板一致
  //   ④ ★ **反例断言**：**用 `journal.phase` 算 ⇒ 比运行时口径少**（把"两来源分叉"做成判据）
  //      —— 这条是本组最值钱的：它证明**用错来源会得到"假绿"**
  //      （真读数：判据1 journal ⇒ **0**；判据2 agents.list ⇒ **10**）
  section('B · 重启后恢复（孤儿 / 板重放 / 活跃度来源）')
  {
    const RC = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'recover.js')).href)

    // ④ ★★ **反例断言（先做，它是本组的灵魂）**：journal 口径**看不见**"僵尸活跃"
    {
      const members = [
        { name: 'alive-a', phase: 'active' },   // 运行时也在
        { name: 'ghost-b', phase: 'active' },   // ★ **journal 说 active，运行时已不在**（僵尸活跃）
      ]
      const tasks = [
        { id: 't1', status: 'in_progress', ownerName: 'alive-a' },
        { id: 't2', status: 'in_progress', ownerName: 'ghost-b' },
      ]
      const live = new Set(['alive-a'])
      const c = RC.compareOrphanSources(members, tasks, live)
      CHECK('B', c.byJournal === 0 && c.byRuntime === 1 && c.diverged === true,
        '★★★★ **反例断言：`journal.phase` 口径看不见"僵尸活跃"**（journal=0 而运行时=1）——**两来源分叉被实测**',
        '用错来源 ⇒ 命令报 **"0 孤儿"的假绿**（本项目最忌讳的"看起来成立 vs 真的成立"）',
        `journal 口径=${c.byJournal}（应 0） 运行时口径=${c.byRuntime}（应 1） 分叉=${c.diverged}`)
    }

    // ② 孤儿：**规则归 `orphans.js`**（`recover.js` 只适配 + 委托 ⇒ `R10` 一份实现）
    {
      const tasks = [
        { id: 't1', status: 'in_progress', ownerName: 'alive-a' },
        { id: 't2', status: 'in_progress', ownerName: 'ghost-b' },
        { id: 't3', status: 'in_progress' },                       // **没有 owner**
        { id: 't4', status: 'completed', ownerName: 'ghost-b' },   // 非 in_progress ⇒ **不算**
      ]
      const r = RC.findOrphans(tasks, new Set(['alive-a']))
      const ids = r.orphans.map((o) => o.id)
      CHECK('B', r.scanned === 3 && ids.length === 2 && ids.includes('t2') && ids.includes('t3') && !ids.includes('t4'),
        '★★ **孤儿 = in_progress 且 owner 不在运行时**（无 owner 也算；`completed` 不算）—— 规则取自 `orphans.js`',
        '把 completed 也算孤儿 ⇒ 恒红没人看；漏掉"无 owner" ⇒ 那种任务同样没人接',
        `scanned=${r.scanned} verdict=${r.verdict} 孤儿=${ids.join(',') || '(无)'}`)
      // ★ **空名单 ≠ 没有孤儿**（读不到人 ≠ 没有人）—— 这条防的是"假绿"那一半
      const empty = RC.findOrphans(tasks, new Set())
      CHECK('B', empty.verdict === 'unverified' && empty.orphans.length === 0,
        '★★ **空成员名单 ⇒ `unverified`（未获取）**，**不是"没有孤儿"**',
        '空名单当"没问题" ⇒ 正是 `R3` 那一族（我没看到 ≠ 不存在）',
        `verdict=${empty.verdict}（应 unverified）`)
    }

    // ① 活跃度来源：**拿不到 agents ⇒ `ok:false`（fail-closed）**
    //    ⚠️ 这是我第一版的真 bug：`agents?.list?.()` 在 `agents===undefined` 时得到 **空数组不抛**
    //      ⇒ 返回 `ok:true` + 空集合 ⇒ 下游会把**每一条 in_progress 都判成孤儿**（**假红**）
    {
      const a1 = RC.liveMemberNames({}, undefined)
      const a2 = RC.liveMemberNames({}, { list() { throw new Error('boom') } })
      const a3 = RC.liveMemberNames({ tryMembership: (x) => ({ name: x.n }) }, { list: () => [{ n: 'x' }, { n: 'y' }] })
      CHECK('B', a1.ok === false && a2.ok === false && a3.ok === true && a3.names.has('x') && a3.names.has('y'),
        '★★ **活跃度来源 fail-closed**：拿不到 `agents` 服务 ⇒ `ok:false`（**不许退化成空集合**）',
        '退化成空集合 ⇒ **每条 in_progress 都被判孤儿**（与 `journal.phase` 的"假 0"是一对：**假红 vs 假绿**）',
        `undefined⇒ok=${a1.ok} 抛错⇒ok=${a2.ok} 正常⇒ok=${a3.ok} names=${[...(a3.names ?? [])].join(',')}`)
    }

    // ③ 板重放：event-sourced 折叠（后写覆盖）+ 与当前板比对
    {
      const events = [
        { type: 'team/task', seq: 1, data: { task: { id: 't1', revision: 1, status: 'pending' } } },
        { type: 'team/task', seq: 2, data: { task: { id: 't1', revision: 2, status: 'completed' } } },
        { type: 'team/task', seq: 3, data: { task: { id: 't9', revision: 1, status: 'deleted' } } },
        { type: 'team/member', seq: 4, data: { member: { id: 'm1' } } },  // 非 task 事件 ⇒ **忽略**
      ]
      const rp = RC.replayBoard(events)
      CHECK('B', rp.total === 2 && rp.alive.length === 1 && rp.taskEvents === 3,
        '★★ **板重放：按 `seq` 折叠、同 id 后写覆盖、`deleted` 不计入 alive、非 task 事件忽略**',
        '折叠错 ⇒ 重放出的板与真板不一致，**而这个判据正是用来验"能不能恢复"的**',
        `total=${rp.total}(应2) alive=${rp.alive.length}(应1) taskEvents=${rp.taskEvents}(应3)`)
      const same = RC.compareBoards([{ id: 't1', status: 'completed' }], rp)
      CHECK('B', same.ok === true,
        '★ **重放板 === 当前板 ⇒ `ok:true`**（这是"能不能恢复"的机械判据）',
        '不一致却报 ok ⇒ 恢复能力是假的',
        `ok=${same.ok} 只在活板=${same.onlyLive.length} 只在重放=${same.onlyReplay.length} status 不一致=${same.statusMismatch}`)
      // 反例：故意让两块不一致 ⇒ 必须 `ok:false` 并**逐条列出差异**
      const diff = RC.compareBoards([{ id: 't1', status: 'pending' }], rp)
      CHECK('B', diff.ok === false && diff.statusMismatch === 1 && diff.samples.length === 1,
        '★★ **反例：板不一致 ⇒ `ok:false` 且逐条列差异**（不是"看起来恢复了"）',
        '只返回 true/false 不给差异 ⇒ 排障时还得人肉比对（`R14`：人肉 = 备忘，不是机制）',
        `ok=${diff.ok} mismatch=${diff.statusMismatch} 样本=${JSON.stringify(diff.samples)}`)
    }

    // ⑤ ★★ **`goals` / `board-replay` 两条命令必须能真跑**（`R21`：能 parse ≠ 能跑）
    //   ⚠️ 本组前四条验的是**纯函数**；这一条验的是"**CLI 真调得起来、退出码对**"
    //     —— `case` 写错 / 函数名打错 ⇒ **纯函数全绿也照样挂**（本项目栽过：`node --check` 只查语法）。
    {
      const snapDir = join(sb.base, 'b-cmd')
      mkdirSync(snapDir, { recursive: true })
      const okSnap = join(snapDir, 'ok.json')
      writeFileSync(okSnap, JSON.stringify({
        tasks: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'in_progress' }],
        events: [
          { type: 'team/task', seq: 1, data: { task: { id: 't1', revision: 1, status: 'pending' } } },
          { type: 'team/task', seq: 2, data: { task: { id: 't1', revision: 2, status: 'completed' } } },
          { type: 'team/task', seq: 3, data: { task: { id: 't2', revision: 1, status: 'in_progress' } } },
        ],
      }), 'utf8')
      const noEvSnap = join(snapDir, 'noev.json')
      writeFileSync(noEvSnap, JSON.stringify({ tasks: [], events: [{ type: 'team/member', seq: 1, data: {} }] }), 'utf8')
      const goalsSnap = join(snapDir, 'goals.json')
      writeFileSync(goalsSnap, JSON.stringify({ sessions: [{ id: 's1', member: 'lead', phase: 'active', activation: 'disarmed', revision: 4 }] }), 'utf8')
      const emptyGoals = join(snapDir, 'goals-empty.json')
      writeFileSync(emptyGoals, JSON.stringify({ sessions: [] }), 'utf8')

      const runCli = (args) => {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' })
        return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
      }
      const brOk = runCli(['board-replay', '--snapshot', okSnap])
      CHECK('B', brOk.code === 0 && brOk.out.includes('重放 === 当前板'),
        '★★ **`board-replay` 真跑：一致 ⇒ exit 0**（`R21`：能 parse ≠ 能跑）',
        '`case` / 函数名写错 ⇒ **纯函数断言全绿也照样挂**（`node --check` 只查语法）',
        `exit=${brOk.code}（应 0）`)
      const brNo = runCli(['board-replay', '--snapshot', noEvSnap])
      CHECK('B', brNo.code === 2 && /未获取/.test(brNo.err),
        '★★★ **`board-replay` 无 task 事件 ⇒ exit 2 + 明写「未获取」**（`R24` fail-closed）',
        '"读不到"被当成"读到空的" ⇒ **两块都空 ⇒ 判 ok** ⇒ 正是假绿',
        `exit=${brNo.code}（应 2）stderr 含未获取=${/未获取/.test(brNo.err)}`)
      const gOk = runCli(['goals', '--snapshot', goalsSnap])
      CHECK('B', gOk.code === 1 && gOk.out.includes('resume') && !/goals\.resume\(/.test(gOk.out.replace(/调|或让/g, '')),
        '★★ **`goals` 真跑：有 disarmed ⇒ exit 1**，且输出里**给的是"人执行"的办法**（不代做）',
        '自动 rearm ⇒ **替用户授权**（`R4` 同族）；不给办法 ⇒ 用户只知道红、不知道怎么开',
        `exit=${gOk.code}（应 1）含 resume 字样=${gOk.out.includes('resume')}`)
      const gEmpty = runCli(['goals', '--snapshot', emptyGoals])
      CHECK('B', gEmpty.code === 2 && /未获取/.test(gEmpty.err),
        '★★★ **`goals` 空名单 ⇒ exit 2 + 「未获取」**（`R24`：读不到 ≠ 没有）',
        '空名单报"全部正常" ⇒ 假绿（与 `journal.phase` 同族）',
        `exit=${gEmpty.code}（应 2）stderr 含未获取=${/未获取/.test(gEmpty.err)}`)
    }

    // ⑥ ★★ **S1/S2（`wake` / `resume`）**：纯函数计划 + dry-run 不发 + fail-closed（`task-106` S1+S2）
    //   ⛔ 本组**必须能红**的那条：**dry-run 时一个字节都不许发**（唤醒 = 真实点火）
    {
      const members = [
        { name: 'lead', phase: 'active' },     // Lead 自己**从不**唤醒
        { name: 'alive-a', phase: 'active' },  // 进程内也在 ⇒ **不唤**
        { name: 'ghost-b', phase: 'active' },  // ★ 僵尸活跃 ⇒ **要唤**
      ]
      const live = new Set(['lead', 'alive-a'])
      const plan = RC.planWake(members, live)
      const names = plan.plan.map((p) => p.name)
      CHECK('B', names.length === 1 && names[0] === 'ghost-b',
        '★★ **`planWake`：只唤醒"失联"的成员**（Lead 自己不算、进程内在的不算）',
        '把 Lead/活跃成员也算进去 ⇒ 给活人发"你掉线了"⇒ 噪音 + 浪费 token',
        `计划=${names.join(',') || '(无)'} 跳过=${plan.skipped.length}`)

      const reqs = RC.makeWakeRequests(plan.plan)
      CHECK('B', reqs.length === 1 && reqs[0].target === 'ghost-b' &&
        Array.isArray(reqs[0].content) && reqs[0].content[0]?.type === 'text',
        '★★ **`makeWakeRequests` 产出底座 `sendMessage` 认的形状**（`target` + `content:[{type:\'text\'}]`）',
        '形状不对 ⇒ 真发送时被底座拒（`resolveActiveMember` / `structuredClone`）',
        `target=${reqs[0]?.target} blocks=${reqs[0]?.content?.length}`)

      // ★★ **dry-run 不发**（可红的负边界）：走真 CLI，确认 `wake` 不带 `--yes` 时 exit=1 且**没发**
      const snapDir2 = join(sb.base, 'b-wake')
      mkdirSync(snapDir2, { recursive: true })
      const wSnap = join(snapDir2, 'w.json')
      writeFileSync(wSnap, JSON.stringify({ members, live: [...live] }), 'utf8')
      const wDry = runCli(['wake', '--snapshot', wSnap])
      CHECK('B', wDry.code === 1 && /DRY-RUN/.test(wDry.out) && /一条都没发/.test(wDry.out),
        '★★★★ **`wake` 默认 DRY-RUN：不发送 + 明写"上面一条都没发"**（唤醒 = 真实点火）',
        'dry-run 也真发 ⇒ **静默点火**（耗 token、成员可能开始改东西）—— 与"自动复活全员"同族',
        `exit=${wDry.code}（应 1）含 DRY-RUN=${/DRY-RUN/.test(wDry.out)}`)

      // ★★ **`--yes` 不许假装发了**（CLI 进程里没有 `agentTeams` 服务 ⇒ fail-closed 报未获取）
      const wYes = runCli(['wake', '--snapshot', wSnap, '--yes'])
      CHECK('B', wYes.code === 2 && /未获取/.test(wYes.err) && /一条都没发/.test(wYes.err),
        '★★★★ **`wake --yes` 在 CLI 进程里 ⇒ exit 2 + 明写"一条都没发"**（没有 `agentTeams` 服务）',
        '假装发了 ⇒ 用户以为成员被唤醒（实际没有）⇒ **比不唤醒更糟**（`R24`/`H41` 家族）',
        `exit=${wYes.code}（应 2）stderr 含未获取=${/未获取/.test(wYes.err)}`)

      // ★★ **空活跃名单 ⇒ 未获取**（我自己抓到的第二个"假红"bug）
      //   `liveNames.size === 0` ⇒ 若当成"没有活人" ⇒ **每个成员都被判失联** ⇒ 全体误唤醒
      const emptyLive = RC.planWake(members, new Set())
      CHECK('B', String(emptyLive.why).startsWith('unverified'),
        '★★★ **空活跃名单 ⇒ `unverified`**（Lead 必在名单里 ⇒ 空集只可能是"没读到"）',
        '把空集当"没有活人" ⇒ **每个成员都被判失联** ⇒ **假红**（与 `journal.phase` 的"假绿"成对）',
        `why=${String(emptyLive.why).slice(0, 30)}`)

      // ★★ **S2`resume` 真跑：三条动作都出、且明写"没有执行任何一条"**
      const rSnap = join(snapDir2, 'r.json')
      writeFileSync(rSnap, JSON.stringify({
        tasks: [{ id: 't-o', status: 'in_progress', ownerName: 'ghost-b' }],
        members,
        live: [...live],
        goals: [{ id: 's1', member: 'lead', phase: 'active', activation: 'disarmed', revision: 4, objective: 'X' }],
      }), 'utf8')
      const rOut = runCli(['resume', '--snapshot', rSnap])
      CHECK('B', rOut.code === 1 && /task-orphan/.test(rOut.out) && /goal-disarmed/.test(rOut.out) &&
        /member-lost/.test(rOut.out) && /没有执行任何一条/.test(rOut.out),
        '★★ **`resume` 真跑：孤儿 + disarmed goal + 失联成员三类都列，且明写"没有执行任何一条"**',
        '只列不标注"没执行" ⇒ 用户以为系统已经替他恢复了；漏掉 goal ⇒ 委托方那句"goal 重新打开"没落实',
        `exit=${rOut.code}（应 1）三类齐=${/task-orphan/.test(rOut.out) && /goal-disarmed/.test(rOut.out) && /member-lost/.test(rOut.out)}`)

      // ★★ **goal 侧不许自动 resume**：`resume` 的输出里**只能给"人执行"的办法**
      const goalLine = String(rOut.out).split('\n').find((l) => l.includes('goal-disarmed')) ?? ''
      const goalHow = String(rOut.out).split('\n').find((l) => l.includes('人授权')) ?? ''
      CHECK('B', /人授权|由\*\*该会话的持有者\*\*/.test(goalHow) && !/已 resume|已重新打开|arms? it/i.test(rOut.out),
        '★★ **`resume` 对 goal 只给"人执行"的指令**，**没有**任何自动 rearm（`R4`：不替用户授权）',
        '自动 rearm ⇒ 替用户做授权决定（`disarm` 的设计意图就是"移除进程内续跑授权"）',
        `给出的是人工指令=${/人授权/.test(goalHow)}`)
    }
  }

  // ── H52 · ★★★ **纪律编号撞号检测**（2026-09-14 / `R26` 的机械判据）──
  // 【它拦的真实事故（同一天三次，都是 CEO）】
  //   · 给 `R22` ⇒ 与已占【R22 派活负边界】冲突
  //   · 改成 `R24` ⇒ **又与已占【R24 fail-closed】冲突**（第一条的教训**当场复发**）
  //   · 说 `task-109` ⇒ 实际是 `task-110`（`task-109` 已被占）
  // 【★ 关键设计（COO 裁决，我采纳）：**比【内容指纹】，不是比"号存不存在"**】
  //   ```
  //   ❌ 候选 B（"引用一个号 ⇒ 必须解析到存在的实体；解析不到 ⇒ 红"）**不成立**：
  //      三次撞号里，号**当时都已存在**（引用是**能解析的**！）
  //      ⇒ 失败形态是 **collision（撞号）**，不是 **dangling（悬空）**
  //      ⇒ **B 一条都抓不到。**
  //   ✅ 真能拦的判据：**同一编号 + 两处【不同内容】⇒ 红**
  //   ```
  // 【诚实边界（COO 提，我保留）】**它拦不住"在散文里预分配"**（三次都是**在信里**给的号）
  //   ⇒ 那部分**仍只能是备忘**；机制**只拦"写盘后的后果"**。**两条并行，不是二选一。**
  {
    let txt = ''
    try { txt = readFileSync(join(PLUGIN_DIR, '..', 'RULES.yml'), 'utf8') } catch { txt = '' }
    // 定义行：`# ★… 【R<n>】 …`（**标题行**，不含正文引用）
    //
    // ★★ **2026-09-15 修正：正则必须带 `★` 前缀**（`R24` 家族：判据取错范围 ⇒ 假红）
    // ```
    // 现场：我落 `R32` 时，在**正文里引用了** `【R32】` 三次（"我落盘了（`R32`）"、"搜「【R32】」0 命中"…）
    //   而原正则 `^#\s.*?【R(\d+)】` **把引用也当定义行** ⇒ 同一个号出现 3 次且内容不同
    //   ⇒ ★ **H52 报"撞号 R32"** —— **那是假红**（它其实是**一条定义 + 两条引用**）
    // ⇒ 判据收紧：**真定义行的形态是 `# ★★★ 【R<n>】…`**（全 33 条实测都带 `★`）
    //   ⇒ 用 `^#\s*★+ ?【R(\d+)】` ⇒ **引用行（不含 ★）不再进"定义行"集合**。
    // ⚠️ **这是收紧范围，不是放宽判据**：真撞号（两条 `★` 定义行同号）**照样红**。
    // 能红的判据：**造两条 `# ★★★ 【R99】** 不同内容 ⇒ 必须仍报撞号**（见 `exp/board-diag/h52-mutation.mjs`）。
    // ```
    const defs = [...txt.matchAll(/^#\s*★+\s*【R(\d+)】(.*)$/gm)].map((m) => ({ n: m[1], title: m[2].trim() }))
    const byNum = new Map()
    for (const d of defs) {
      if (!byNum.has(d.n)) byNum.set(d.n, [])
      byNum.get(d.n).push(d.title)
    }
    const collide = []
    for (const [n, titles] of byNum) {
      // 同一编号出现多次 ⇒ 比内容指纹；**标题相同 = 无害重复**（不误报）
      const uniq = [...new Set(titles)]
      if (uniq.length > 1) collide.push(`R${n}: ${uniq.map((t) => t.slice(0, 28)).join('  vs  ')}`)
    }
    CHECK('H52', txt !== '' && defs.length > 0 && collide.length === 0,
      `★★★ **纪律编号不许撞号**（同一 \`R<n>\` 两处**不同内容** ⇒ 红；共扫 ${defs.length} 条定义行）`,
      '**比"号存不存在"**抓不到它（三次撞号里号都已存在）⇒ **必须比内容指纹**；' +
        '撞号的代价 = **用 A 的纪律去记 B 的违规**',
      txt === ''
        ? '**读不到 `RULES.yml`**（路径变了？）'
        : defs.length === 0
          ? '**没扫到任何定义行**（行格式变了？）'
          : collide.length === 0
            ? `${byNum.size} 个编号全部唯一或同内容 ✓（定义行 ${defs.length}）`
            : `**撞号**：${collide.join(' | ')}`)
  }

  // ── H16 · ★★ **"对外能力"必须在技能里有落点**（2026-09-14 / Round 47）────────────
  // 【为什么把它做成通用判据】同类缺口**已经出现三次**（41 工具没进手册 / 45 SOUL 没人知道
  //   / 46 绩效闭环没进技能）⇒ 靠"我下次记得写"是不行的，**必须有个地方每次替我数**。
  // 【判据】给出**能力清单**（= 插件真的往外提供的东西），每条都必须能在**技能**里找到；
  //   不在技能里的，要**显式列进 `expects` 的白名单并写明"为什么它不在技能里"**——
  //   这样"漏了"与"有意不在"就被分开了（不许用沉默代表"有意"）。
  //
  // ⚠️ 维护纪律：**加一个对外能力 ⇒ 要么写进技能，要么在下面 `deliberate` 里写一句理由**。
  {
    // 能力 → 它"该出现在哪个技能里"的判据关键词
    const capabilities = [
      { cap: '成员释放（撤人）', must: ['release_member', 'list_zombies'], where: 'teamkit-escalate' },
      { cap: '自我迭代（读自己那几份）', must: ['read_self'], where: '技能里要说"怎么读回自己的 SOUL/原则"' },
      { cap: '自我迭代（写自己那几份）', must: ['write_self'], where: '技能里要说"怎么把自己答应的事写下去"' },
      { cap: 'SOUL 概念', must: ['SOUL'], where: '任意技能（现由 teamkit-a2a/escalate 覆盖）' },
      { cap: '考核闭环', must: ['S0 预登记'], where: 'teamkit-escalate' },
      { cap: '上游/fork', must: ['fork'], where: 'teamkit-org' },
      { cap: '评审门', must: ['blocked_by'], where: 'teamkit-review' },
      { cap: '评审任务就绪门', must: ['就绪门', 'blocked_by'], where: 'teamkit-review' },
      // ★ E²R（task-60）：把分解边与评审判决落到板上 —— 三件工具都得在技能里能找到
      { cap: '分解边（E_tree → parentTask）', must: ['set_task_structure'], where: 'teamkit-review' },
      { cap: '评审判决写回（q_v）', must: ['review_task'], where: 'teamkit-review' },
      { cap: '结构视图（含 accepted）', must: ['team_structure', 'accepted'], where: 'teamkit-review' },
      { cap: 'A2A 消息契约', must: ['send_message'], where: 'teamkit-a2a' },
    ]
    // **有意不进技能**的（各给一句理由）—— 用"沉默"代表"有意"是不允许的
    const deliberate = {
      promote: 'CLI 命令（Lead 在终端敲）⇒ 归 `plugin/README.md` 的「命令」节，不是模型读的技能',
      'fork-init': 'CLI 命令（离线跑，无 agent）⇒ 同上，归 README 命令节；它只作用于全局 fork 根，模型在会话里不用它',
      'teamkit selftest': 'CLI 命令（离线三态自测）⇒ 归 README；它是**维护者**跑的健康判据，不是成员干活的方法',
      'teamkit doctor': 'CLI 命令（环境体检）⇒ 同上，归 README；面向**装机的人**，不是干活的模型',
    }
    let skillsBlob = ''
    try {
      for (const d of readdirSync(join(PLUGIN_DIR, 'skills'), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        try {
          skillsBlob += readFileSync(join(PLUGIN_DIR, 'skills', d.name, 'SKILL.md'), 'utf8') + '\n'
        } catch {
          /* 跳过读不到的 */
        }
      }
    } catch {
      skillsBlob = ''
    }
    const missingCap = capabilities.filter((c) => !c.must.some((m) => skillsBlob.includes(m))).map((c) => c.cap)
    CHECK('H16', skillsBlob !== '' && missingCap.length === 0,
      '★★ **每个"对外能力"都能在技能里找到**（' + capabilities.length + ' 条清单逐条查）',
      '能力做了但技能里没有 ⇒ **成员与 Lead 都读不到它** ⇒ 等于没做（同类已出现 3 次：41/45/46）',
      missingCap.length === 0 ? `${capabilities.length} 条都有落点` : `缺落点: ${missingCap.join(', ')}`)
    // 反面：`deliberate` 里**不许**出现"其实该在技能里"的（= 白名单要有理由，且理由非空）
    const badDeliberate = Object.entries(deliberate).filter(([, why]) => typeof why !== 'string' || why.trim().length < 10)
    CHECK('H16', badDeliberate.length === 0,
      '★ **"有意不进技能"的每一项都写了理由**（不许用沉默代表"有意"）',
      '白名单不带理由 ⇒ 下次有人分不清"这是有意的"与"这是漏的"',
      badDeliberate.length === 0 ? `${Object.keys(deliberate).length} 项都有理由` : `缺理由: ${badDeliberate.map(([k]) => k).join(', ')}`)
  }

  // ── S · **SOUL 注入**（`DECISIONS.md` P-08 的裁定；2026-09-14 / Round 43 实现）────────
  // 【缺口】`PERF-LOOP.md:175` 原文记着「**SOUL.md 注入插件不存在**（伪码在 §4.3，未实现）」。
  //   而 P-08 裁定：「**要自我迭代的 SOUL.md 走 `agent/pre-step` 注入 user message**」。
  // 【为什么不能只靠 `principles`】那走**系统提示词**（装配期一次性）⇒ 本会话内改了不生效；
  //   绩效闭环要求"改了 → **下一轮**用同一条读数复检"。
  // 【判据】用**真模块 + 真文件**验证四件事（不是读源码字符串）：
  //   ① 无文件 ⇒ **不注入**（`shouldInject:false`，且不抛）；
  //   ② 有文件 ⇒ 首步注入，且**内容进了 messages**；
  //   ③ **没改就不再注入**（sha 未变 ⇒ 第二步不注入）—— 否则每步灌一遍白烧 token；
  //   ④ **改了 ⇒ 下一步就注入**（这正是"下一步生效"那条裁定的实测）。
  // ── S2 · ★★ **SOUL 骨架播种**（task-101；委托方当场问「每人独立的 SOUL 做完没有？」）──────
  // 【现状口径】**读/注入做完了，播种没做**（`soul.js` 原先零生成代码）⇒ 本组验的就是补上的那一格。
  // 【三组正反判据（CEO/总监定的）】
  //   正例：新成员 ⇒ 有骨架（`seeded:true` + 文件真在）
  //   反例①：生成物与骨架模板**逐字一致**（`=== soulSkeleton(...)`）⇒ 证明**没编话**
  //   反例②：**必须显示「未填」** 且 **第一人称承诺句 = 0 行**（替它表态 = 伪造）
  //   反例③：**已有 SOUL 不许被覆盖** ⇒ seed 前后 **sha 相等**（幂等）
  //   另加两条：**逃生开关**（`enabled:false` ⇒ 不建文件）与 **失败不静默**（写不进去 ⇒ `ok:false` + 日志）
  // ⚠️ 全部在**临时目录**跑（`R12`：不许在真机 `$DSH_HOME` 做试验）。
  section('S2 · SOUL 骨架播种（幂等 / 不编人格 / 失败不静默）')
  {
    const S2 = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'soul.js')).href)
    const root = join(sb.base, 'soul-seed')
    mkdirSync(root, { recursive: true })

    // 正例：新成员 ⇒ 播种
    const logs = []
    const r1 = S2.seedSoul(root, 'newbie', { cfg: {}, enabled: true, log: (l) => logs.push(l) })
    CHECK('S2', r1.ok === true && r1.seeded === true && existsSync(r1.file),
      '★ **正例：新成员 ⇒ 骨架被种下**（`seeded:true` + 文件真存在）',
      '播种报成功但文件不在 ⇒ "有形式无内容"（比没有更糟）',
      `ok=${r1.ok} seeded=${r1.seeded} bytes=${r1.bytes} sha=${r1.sha}`)

    // 反例①：与模板**逐字一致**（证明没编话）
    const onDisk = (() => { try { return readFileSync(r1.file, 'utf8') } catch { return '' } })()
    const tpl = S2.soulSkeleton({ soulPath: r1.file, member: 'newbie' })
    CHECK('S2', onDisk !== '' && onDisk === tpl,
      '★★ **反例①：落盘内容与骨架模板逐字一致**（⇒ **系统没有编任何话**）',
      '落盘内容 ≠ 模板 ⇒ 有人（或系统）往里塞了内容 ⇒ 那就是**替成员表态**',
      `逐字一致=${onDisk === tpl} 落盘=${onDisk.length}B 模板=${tpl.length}B`)

    // 反例②：必须显示「未填」且**零第一人称承诺句**
    const firstPerson = onDisk.split('\n').filter((l) => /我答应|我将|我不再|我下次|我会|我要/.test(l))
    CHECK('S2', onDisk.includes('未填') && firstPerson.length === 0,
      '★★ **反例②：含「未填」占位，且第一人称承诺句 = 0 行**（SOUL 的内容要**它自己**写）',
      '系统写第一人称承诺 ⇒ **伪造成员的承诺**（委托方口径：persona 管角色身份，SOUL 是"我自己答应什么"）',
      `含未填=${onDisk.includes('未填')} 第一人称行数=${firstPerson.length}`)

    // 反例③：幂等 —— 已有 SOUL **绝不被覆盖**
    const before = (() => { try { return readFileSync(r1.file, 'utf8') } catch { return '' } })()
    const r2 = S2.seedSoul(root, 'newbie', { cfg: {}, enabled: true, log: () => {} })
    const after = (() => { try { return readFileSync(r1.file, 'utf8') } catch { return '' } })()
    CHECK('S2', r2.seeded === false && r2.why === 'exists' && before === after,
      '★★ **反例③：第二次播种 = 幂等**（`seeded:false` / `why:exists`，**内容逐字未变**）',
      '不幂等 ⇒ **每次装配都覆盖** ⇒ 成员自己写的承诺被系统抹掉（最坏的那类数据丢失）',
      `seeded=${r2.seeded} why=${r2.why} 内容未变=${before === after}`)

    // 反例③-b：**有真实内容的成员**（模拟真机那份 coo.md）⇒ 一个字节都不动
    const cooFile = join(root, 'soul', 'coo.md')
    mkdirSync(join(cooFile, '..'), { recursive: true })
    writeFileSync(cooFile, '- 这是它自己写的承诺\n', 'utf8')
    const cooBefore = readFileSync(cooFile, 'utf8')
    const r3 = S2.seedSoul(root, 'coo', { cfg: {}, enabled: true, log: () => {} })
    CHECK('S2', r3.seeded === false && readFileSync(cooFile, 'utf8') === cooBefore,
      '★★ **反例③-b：有内容的成员绝不被覆盖**（内容逐字未变 = 真机那份 `coo.md` 的安全保证）',
      '覆盖已有 SOUL ⇒ 抹掉成员自己写的承诺（真机唯一存量就是这种）',
      `seeded=${r3.seeded} why=${r3.why} 内容未变=${readFileSync(cooFile, 'utf8') === cooBefore}`)

    // 逃生开关：关掉 ⇒ **不建文件**，且日志**显式说"未播种"**
    const offLogs = []
    const r4 = S2.seedSoul(root, 'switchoff', { cfg: {}, enabled: false, log: (l) => offLogs.push(l) })
    CHECK('S2', r4.seeded === false && r4.why === 'disabled' && !existsSync(join(root, 'soul', 'switchoff.md')) &&
      offLogs.some((l) => /未播种/.test(String(l))),
      '★ **逃生开关：`soul.seed=false` ⇒ 不建文件**，且日志**显式打「未播种」**（静默关闭 = 假机制）',
      '关掉了却不说 ⇒ 用户以为种了、其实没有',
      `seeded=${r4.seeded} why=${r4.why} 文件没建=${!existsSync(join(root, 'soul', 'switchoff.md'))}`)

    // 失败不静默：把一个**文件**当目录用 ⇒ mkdir 必失败
    const notDir = join(sb.base, 'soul-seed-notdir')
    writeFileSync(notDir, 'x', 'utf8')
    const failLogs = []
    const r5 = S2.seedSoul(notDir, 'x', { cfg: { dir: join(notDir, 'sub') }, enabled: true, log: (l) => failLogs.push(l) })
    CHECK('S2', r5.ok === false && typeof r5.why === 'string' && r5.why !== '' && failLogs.some((l) => /SOUL-SEED-FAIL/.test(String(l))),
      '★★ **失败不静默：写不进去 ⇒ `ok:false` + 具体 why + 日志 `SOUL-SEED-FAIL`**',
      '静默失败 ⇒ 用户以为种了（`soul.seed` 默认 true 的第三条承重前提）',
      `ok=${r5.ok} why=${String(r5.why).slice(0, 40)} 有 FAIL 日志=${failLogs.some((l) => /SOUL-SEED-FAIL/.test(String(l)))}`)
  }

  section('S · SOUL 注入（`agent/pre-step` ⇒ user message；下一步生效）')
  {
    const S = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'soul.js')).href)
    const dir = join(sb.base, 'soul-test')
    mkdirSync(dir, { recursive: true })
    const paths = { stateDir: dir, soul: { enabled: true, dir: '' } }
    const member = 'soul-demo'

    // ① 没文件 ⇒ 不注入、不抛
    {
      const inj = S.makeSoulInjector({ paths, member, log: () => {} })
      const out = inj.sweep({ kind: 'continue', messages: [] })
      CHECK('S', Array.isArray(out?.messages) && out.messages.length === 0,
        '① **没有 SOUL 文件时什么都不做**（不注入、不抛错）',
        '没文件就报错/注入空消息 ⇒ 每个成员的每一步都被污染',
        `messages=${out?.messages?.length}`)
    }
    // ② 有文件 ⇒ 首步注入（内容真进了 messages）
    {
      const { file } = S.soulFileFor(dir, member)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '- P-1 交付前先自查判据\n- P-2 不许把"没验证"说成"应该没问题"\n', 'utf8')
      const inj = S.makeSoulInjector({ paths, member, log: () => {} })
      const out = inj.sweep({ kind: 'continue', messages: [] })
      const txt = JSON.stringify(out?.messages ?? [])
      CHECK('S', (out?.messages?.length ?? 0) === 1 && txt.includes('P-1 交付前先自查判据'),
        '② **有 SOUL 文件 ⇒ 首步注入**，且**内容真进了 messages**',
        '注入了但不带内容 ⇒ 成员看不到自己答应过什么',
        `messages=${out?.messages?.length} 含内容=${txt.includes('P-1')}`)
      // ③ 没改 ⇒ 第二步**不再注入**（sha 未变）
      const out2 = inj.sweep({ kind: 'continue', messages: [] })
      CHECK('S', (out2?.messages?.length ?? 0) === 0 && inj.injected === 1,
        '③ **文件没改 ⇒ 不重复注入**（按 sha 记内存，避免每步白灌）',
        '每步都灌一遍 ⇒ 白烧 token 且稀释注意力（"噪声淹没信号"）',
        `第二步 messages=${out2?.messages?.length} 累计注入=${inj.injected}`)
      // ④ 改了 ⇒ **下一步就注入**（这就是"下一步生效"的实测）
      writeFileSync(file, '- P-1 交付前先自查判据\n- **P-3（新）：被判决点名的缺陷，下一轮必须给出可复现的复检读数**\n', 'utf8')
      const out3 = inj.sweep({ kind: 'continue', messages: [] })
      const txt3 = JSON.stringify(out3?.messages ?? [])
      CHECK('S', (out3?.messages?.length ?? 0) === 1 && txt3.includes('P-3'),
        '④ ★★ **改了 SOUL ⇒ 下一步就注入**（"下一步生效"这条裁定的实测，不是设计上成立）',
        '改了不生效 ⇒ 绩效闭环（改了→下一轮复检）**跨不到下一轮**（`principles` 那条走装配期，够不着）',
        `第三步 messages=${out3?.messages?.length} 含 P-3=${txt3.includes('P-3')} 累计=${inj.injected}`)
    }
    // ⑤ 闸门独立：`soul.enabled:false` ⇒ 不注入（但**不该影响通知**——那由 notify 自己管）
    {
      const inj = S.makeSoulInjector({ paths: { ...paths, soul: { enabled: false, dir: '' } }, member, log: () => {} })
      const out = inj.sweep({ kind: 'continue', messages: [] })
      CHECK('S', (out?.messages?.length ?? 0) === 0,
        '⑤ `soul.enabled:false` ⇒ **不注入**（闸门独立于 `notify.enabled`）',
        '两个闸门绑一起 ⇒ 关通知会连带关 SOUL（同 Round 34 的"闸门绑一起"缺陷）',
        `messages=${out?.messages?.length}`)
    }
    // ⑥ ★★ **Lead 也有独立成长位**（2026-09-14 / Round 44）────────────────────────
    // 【缺口】`memberNameOf()` 只认 `role==='teammate'` ⇒ **Lead 被 `handleAgent` 直接 return**，
    //   于是它拿不到 fork / 岗位人格段 / SOUL 三件。**前两件不拿是对的**（没有 `lead` 角色档），
    //   但 **SOUL 必须给它** —— 委托方原话「**每人一套独立 skills、独立成长空间**」，
    //   而 `GROWTH.md` 说的是"让他意识到自己做得不够好，**从而去改自己的 skills / SOUL**"，
    //   **Lead 也是个 AI，也在跑这家公司**。
    // 【判据】源码里必须有**单独的 Lead SOUL 通道**，且**名字不能从 `session.header` 取**
    //   （真宿主实测：`header` 只有 `{version,id,createdAt,cwd,isSeeded,agentPreset}`，**没有 `name`**
    //    ⇒ 我第一版因此**永不触发**；正解是 `tryMembership(agent).name`）。
    {
      let src = ''
      try { src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8') } catch { src = '' }
      // ⚠️ **判据必须查"定义"，不是"字符串出现过"** —— 我第一版只查 `handleLeadSoul` 出现在源码里，
      //    于是**把函数定义改名（摘掉实现）它照样绿**（变异测试当场抓到的"断言太松"）。
      //    ⇒ 逐条查：**函数定义** + **被调用** + **装好时打的日志**。
      const defines = /const handleLeadSoul\s*=\s*\(/.test(src)
      const calls = /^\s*handleLeadSoul\(agent, why\)/m.test(src)
      const logs = /LEAD-SOUL-ARMED/.test(src)
      const hasLeadChannel = defines && calls && logs
      CHECK('S', hasLeadChannel,
        '⑥ ★★ **Lead 有单独的 SOUL 通道**（**定义 + 调用 + 装好的日志**三处都在）',
        'Lead 被 `memberNameOf` 排除 ⇒ 它没有独立成长位（违反委托方"**每人**一套独立成长空间"）',
        `定义=${defines} 调用=${calls} 日志=${logs}`)
      // 名字**必须**从 membership 取（不是 header）—— 这是我实测踩过的坑
      const usesMembership = /tryMembership\(agent\)[\s\S]{0,200}?role !== 'lead'/.test(src)
      const readsHeaderName = /session\?\.\s*header\?\.\s*name/.test(src)
      CHECK('S', usesMembership && !readsHeaderName,
        '⑥-b ★ Lead 的**名字从 `tryMembership` 取**（`session.header.name` 真宿主里**不存在**）',
        '读 `header.name` ⇒ 恒 undefined ⇒ Lead SOUL **永不触发**（我第一版就这么错的）',
        `membership=${usesMembership} 读header=${readsHeaderName}`)
    }
    // ⑦ ★★ **人格段必须告诉成员"SOUL 写哪、什么时候写"**（2026-09-14 / Round 45）
    //    【缺口】Round 43–44 把 SOUL 做成真机制，但**7 条技能 + 7 份角色档里 `SOUL` 命中 0 处** ⇒
    //    **机制在，可它在现实中不可达**（没人会去写一个自己不知道存在的文件）。
    //    【判据】用**真函数**（不是读源码字符串）：`personaFor(role, …, soulPath)` 的输出里
    //      **必须含那个绝对路径**、且**说清与 `principles` 的区别**（一个走提示词、一个每步生效）。
    {
      const R = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'roles.js')).href)
      const role = {
        name: 'soul-demo', role: 'engineering', level: 'ic', description: 'x',
        acceptance_style: 'y', write_scope: 'z', gate_policy: 'review', tools: ['read'],
      }
      const soulPath = 'C:/Users/demo/.dsh/.teamkit/soul/soul-demo.md'
      const p = R.personaFor(role, undefined, 'C:/Users/demo/.dsh/teamkit/talents/principles/soul-demo.md', soulPath)
      CHECK('S', p.includes(soulPath),
        '⑦ ★★ **人格段里写了 SOUL 的绝对路径**（成员才知道该往哪写）',
        '不写路径 ⇒ 成员不知道那个文件存在 ⇒ 机制成摆设（7 技能 + 7 角色档 SOUL 命中 0 处的实测缺口）',
        p.includes(soulPath) ? '含绝对路径 ✓' : '人格段里没有 SOUL 路径')
      const explainsDiff = /每步开工前都会读一遍|下一步就生效/.test(p) && /下次装配/.test(p)
      CHECK('S', explainsDiff,
        '⑦-b ★ 且**说清 SOUL 与 `principles` 的区别**（一个"下次装配"、一个"下一步生效"）',
        '不说区别 ⇒ 成员会把两件事混为一谈，**被判决点名后不知道该写哪个**',
        explainsDiff ? '含区别说明 ✓' : '未说清区别')
      // 不给 soulFile 时**不该塞空段**（向后兼容：老调用方不传第 4 参）
      const p2 = R.personaFor(role, undefined, 'C:/x/principles/soul-demo.md')
      CHECK('S', !/你的 SOUL/.test(p2),
        '⑦-c 不传 `soulFile` ⇒ **人格段里不出现 SOUL 段**（向后兼容，不塞空话）',
        '不传也塞一段 ⇒ 老调用方的输出被悄悄改变（无谓的提示词膨胀）',
        /你的 SOUL/.test(p2) ? '仍出现 SOUL 段' : '没传就不塞 ✓')
    }
    // ⑧ ★★ **Lead 也要知道"SOUL 写哪"**（2026-09-14 / Round 45 收尾；**实测两次才成**）
    //    【缺口】Lead **没有角色档** ⇒ `personaFor` 那条链**从不经过它**
    //      ⇒ 我在 `personaFor` 里加的 SOUL 段**对 Lead 无效**。实测（新建 omc 会话、无历史）：
    //      问它"人格段里有没有 SOUL" ⇒ **`NO-SOUL-DOC`**（它拿得到 SOUL **内容**，却**不知道文件在哪**）。
    //    【修法】`handleLeadSoul` 里**额外注册一个系统提示词段**（只给 Lead），段名唯一到 agent。
    //    【判据】源码里必须有那条 `sp.section` 且段名**带 agent.id**（固定名会撞 —— 我真撞过两个坑）：
    //      ① 固定名 `teamkit:lead-soul` ⇒ 第二个 Lead 就 `already registered`；
    //      ② 段名带 id 后**仍撞** ⇒ **跨实例**（多实例共存）⇒ 必须配 `preDispose` + `remember`。
    {
      let src = ''
      try { src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8') } catch { src = '' }
      const hasSection = /teamkit:lead-soul:\$\{agent\.id\}/.test(src)
      const hasPre = /const pre = preDispose\(agent\.id, secKey/.test(src)
      const hasRemember = /remember\(agent\.id, secKey, offSec/.test(src)
      CHECK('S', hasSection && hasPre && hasRemember,
        '⑧ ★★ **Lead 也有"SOUL 写哪"的提示词段**（段名带 agent.id + `preDispose` + `remember`）',
        '缺任一项 ⇒ 第二个 Lead / 第二个实例就撞名 ⇒ **只有第一个 Lead 知道写哪**（实测踩过两次）',
        `段名带id=${hasSection} preDispose=${hasPre} remember=${hasRemember}`)
    }
    // ⑨ ★★ **SOUL 必须能被"写"下去**（2026-09-14 / Round 48 修的**真缺陷**）────────────
    //    【缺陷现场】组织资产全在 `$DSH_HOME`（**agent 工作区之外**）；真 omc Lead 调 `write` 写自己的 SOUL：
    //      `Error: [sandbox: file access denied under workspace-write mode]`
    //      `[sandbox: escalation available — retry … the approval prompt asks the user]`
    //    ⇒ **读得到内容（插件注入），但写不回去** ⇒ `GROWTH.md` 那条"两轴成长"的**最后一米断了**。
    //    【修法】像 `release_member` 那样给**宿主侧工具**（工具体在宿主进程跑，不受 agent 沙箱约束）：
    //      `read_soul` / `write_soul`。**独立闸门**（不受 `memberRelease.enabled` 影响）。
    //    【判据】用**真模块 + 真文件**验证：`appendSoul` 能写进去、**回读能读回来**、`replace` 能整篇换掉。
    {
      const S2 = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'soul.js')).href)
      const sdir = join(sb.base, 'soul-write-test')
      const paths2 = { stateDir: sdir, soul: { enabled: true, dir: '' } }
      const who = 'write-demo'
      // ① 追加：写进去 + 回读得到 + 文件真存在
      const a1 = S2.appendSoul(sdir, who, '- 第一条：下次先确认落点')
      const back1 = S2.readSoul(sdir, who)
      CHECK('S', a1.ok && back1.text !== undefined && back1.text.includes('第一条'),
        '⑨ ★★ **`appendSoul` 真能把 SOUL 写进去**（宿主侧代写 ⇒ 绕开 agent 沙箱），且**回读得到**',
        '写不进 ⇒ 成员的自我迭代**只读不写**（真缺陷：write 被沙箱拒）',
        `ok=${a1.ok} bytes=${a1.bytes ?? '-'} 回读=${back1.text !== undefined}`)
      // ② 再追加 ⇒ 两条都在（不覆盖第一条）
      const a2 = S2.appendSoul(sdir, who, '- 第二条：报读数再下结论')
      const back2 = S2.readSoul(sdir, who)
      CHECK('S', a2.ok && back2.text.includes('第一条') && back2.text.includes('第二条'),
        '⑨-b 追加是**追加**（第一条还在）—— 不是覆盖',
        '追加变覆盖 ⇒ 会手滑抹掉历史承诺',
        `两条都在=${back2.text.includes('第一条') && back2.text.includes('第二条')}`)
      // ③ 空内容拒绝（不许写空）
      const a3 = S2.appendSoul(sdir, who, '   ')
      CHECK('S', a3.ok === false && /empty-text/.test(String(a3.why)),
        '⑨-c **空内容被拒**（`empty-text`）—— 不许往 SOUL 里写空白',
        '写空 ⇒ 文件存在但没内容，读的人以为"写过"',
        `ok=${a3.ok} why=${a3.why}`)
      // ④ replace 整篇换掉
      const a4 = S2.replaceSoul(sdir, who, '- 只剩这一条')
      const back4 = S2.readSoul(sdir, who)
      CHECK('S', a4.ok && !back4.text.includes('第一条') && back4.text.includes('只剩这一条'),
        '⑨-d `replaceSoul` **整篇重写**（显式才生效，默认是追加）',
        '默认就重写 ⇒ 危险；默认追加 + 显式 replace 才是对的默认值',
        `ok=${a4.ok} 含旧=${back4.text.includes('第一条')}`)
    }
    // ⑨-e 工具注册面：两个 self 工具在源码里（且**不在** `destructive` 闸门里）
    {
      let rt = ''
      try { rt = readFileSync(join(PLUGIN_DIR, 'lib', 'release-tools.js'), 'utf8') } catch { rt = '' }
      // ⚠️ R49 把 `read_soul`/`write_soul` **推广成** `read_self`/`write_self`（白名单三选一：
      //    soul / principles / role-skill）—— 因为"原则文件"同样被沙箱拒（同族，实测）。
      //    ⇒ 这条断言**当场红了一次**，正是它该做的（改名/摘功能会被它抓住）。
      const hasRead = /name: 'read_self'/.test(rt)
      const hasWrite = /name: 'write_self'/.test(rt)
      // 判据：`if (selfWriteDeps)` 是**独立**闸门（不与 `if (destructive)` 同块）
      const gatedIndependently = /if \(selfWriteDeps\) \{/.test(rt)
      CHECK('S', hasRead && hasWrite && gatedIndependently,
        '⑨-e **`read_self` / `write_self` 在源码里，且闸门独立**（不受 `memberRelease.enabled` 影响）',
        '挂在破坏性闸门里 ⇒ 用户不开释放就**写不了自己的东西**（同 Round 34 的"闸门绑一起"）',
        `read=${hasRead} write=${hasWrite} 独立闸门=${gatedIndependently}`)
    }
    // ⑩ ★★ **"写我自己那几份"必须是白名单，不许变成沙箱后门**（2026-09-14 / Round 49–50）
    //    【为什么单列】R48 修了 SOUL，R49 实测**原则文件同样被沙箱拒** ⇒ 推广成 `read_self`/`write_self`
    //    带 `target` 三选一。**推广的代价是"它看起来像一个通用写工具"** ⇒
    //    必须**机械地**确认三件事，否则它就是个后门：
    //      ① 路径**由插件算**（`resolveSelfTarget`），**不接受调用方传路径**；
    //      ② 只允许**白名单三个** target（第四个直接拒）；
    //      ③ `role-skill` **不许跳出**你自己的角色目录（`under()` 判据）。
    {
      const SW = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'self-write.js')).href)
      const tk = join(sb.base, 'teamkit-demo')
      const base = { stateDir: join(sb.base, 'sw-state'), teamkitDir: tk, member: 'alice', role: 'engineer' }
      // ① 白名单：非白名单 target 一律拒
      const bad = SW.resolveSelfTarget({ ...base, target: 'evil', skill: 'x' })
      CHECK('S', bad.ok === false && /unknown-target/.test(String(bad.why)),
        '⑩ ★★ **非白名单 `target` 直接拒**（`unknown-target`）—— 不许拿它当通用写工具',
        '不白名单 ⇒ 它就是一个**绕过 agent 沙箱的任意写后门**（安全边界塌了）',
        `ok=${bad.ok} why=${bad.why}`)
      // ② 三个白名单各自算对路径
      const rSoul = SW.resolveSelfTarget({ ...base, target: 'soul' })
      const rPrin = SW.resolveSelfTarget({ ...base, target: 'principles' })
      const rSkill = SW.resolveSelfTarget({ ...base, target: 'role-skill', skill: 'role-engineer-first-read' })
      CHECK('S', rSoul.ok && rPrin.ok && rSkill.ok &&
        String(rSoul.file).includes('soul') && String(rSoul.file).includes('alice') &&
        String(rPrin.file).includes(join('talents', 'principles')) && String(rPrin.file).includes('engineer') &&
        String(rSkill.file).includes(join('roles', 'engineer', 'skills')),
        '⑩-b **三个白名单各自算对路径**（soul 按人头；principles/role-skill 按角色）',
        '路径算错 ⇒ 写进别人的文件里（比"写不了"更糟）',
        `soul=${rSoul.ok} principles=${rPrin.ok} role-skill=${rSkill.ok}`)
      // ③ `role-skill` 不许跳出角色目录（用 `..` 试）
      const esc = SW.resolveSelfTarget({ ...base, target: 'role-skill', skill: '../../../../evil' })
      CHECK('S', esc.ok === false && /escapes-role-dir/.test(String(esc.why)),
        '⑩-c ★★ **`role-skill` 不许用 `..` 跳出角色目录**（`escapes-role-dir`）',
        '能跳出 ⇒ 可以写到 `$DSH_HOME` 里任何地方（白名单名存实亡）',
        `ok=${esc.ok} why=${esc.why}`)
      // ④ 没有角色名时 **拒绝**（principles/role-skill 按角色落点 ⇒ 不猜）
      const noRole = SW.resolveSelfTarget({ ...base, role: undefined, target: 'principles' })
      CHECK('S', noRole.ok === false && /no-role/.test(String(noRole.why)),
        '⑩-d 没有角色名 ⇒ `principles`/`role-skill` **拒绝**（`no-role`，不猜落点）',
        '猜角色 ⇒ 写到别的角色那份里；"宁可写不了也别写错"',
        `ok=${noRole.ok} why=${noRole.why}`)
      // ⑤ 真写：writeSelf 落盘 + 回读（用白名单里算出来的那个路径）
      const wr = SW.writeSelf(rSoul.file, '- 第十条：先算路径再写')
      const rd = SW.readSelf(rSoul.file)
      CHECK('S', wr.ok && rd.text !== undefined && rd.text.includes('第十条'),
        '⑩-e **白名单路径上真能写进去**（宿主侧 ⇒ 绕开沙箱）+ 回读得到',
        '写不进 ⇒ 推广了个寂寞（与 R48 修之前一样）',
        `ok=${wr.ok} bytes=${wr.bytes ?? '-'}`)
    }
    // ⑪ ★★ **`selfWriteDeps.rolesDir` 必须用"兜底算好的那个"**（2026-09-14 / Round 50 实测的 bug）──
    //    【缺陷现场】`rolesDir` 在 L502 由**三段兜底**算出（`paths.roles.dir` → `rawConfig` →
    //      `recoveredFromPreset`），**但 `selfWriteDeps` 里我传的是 `paths.roles.dir`（原始值）**。
    //      裸实例（热重载重建 / 新建会话不重新 apply）里它是**空** ⇒ `loadRoles('')` 读到 0 条
    //      ⇒ **`coo` 明明有角色档却报 `no-role`**。诊断日志：
    //        `SELF-WRITE-ROLE-MISS member=coo rolesDir= readable=false n=0`
    //    ⇒ 这是 R16「兜底只在一条路上接了」的**同族**：**算出了值，却在另一条路上用了原始的。**
    //    【判据】`selfWriteDeps` 里**不许**出现 `rolesDir: paths.roles.dir`（要引那个变量）。
    {
      let src = ''
      try { src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8') } catch { src = '' }
      const usesRaw = /rolesDir:\s*paths\.roles\.dir/.test(src)
      const usesVar = /teamkitDir:\s*rolesDir\s*!==\s*''/.test(src) && /^\s*rolesDir,$/m.test(src)
      CHECK('S', !usesRaw && usesVar,
        '⑪ ★★ **`selfWriteDeps.rolesDir` 用的是"三段兜底算好的那个变量"**，不是 `paths.roles.dir`',
        '用原始值 ⇒ 裸实例里为空 ⇒ **有角色档的成员被当成"没角色"**（`no-role`，实测踩到）',
        `用了原始paths=${usesRaw} 用了变量=${usesVar}`)
    }
  }

  // ═══ E2R · 分解边 + 评审判决（task-60 / 2026-09-14）════════════════════════
  // 【委托方的问题】「它一些公式，什么 r 方那个啥东西，这些东西你就是融合进来没有，
  //   还是说你只是抄了个形式？」⇒ 本组验的就是"融合进来"的那部分**真的成立**。
  //
  // 【本组验什么】用**真模块**（不是读源码字符串）：
  //   ① 台账落盘 + **重放**（重启后重建）；
  //   ② `accept` 的判据 = `completed` **且**判决 accept（**`completed` 不算被批准**）；
  //   ③ `description` 摘要是**幂等**的（反复调用不越堆越长）+ 有底座上限守卫；
  //   ④ **跨 Team 隔离**（任务 id 是 per-Team 的：`task-1` 每个队都有）；
  //   ⑤ 路径 A 默认**关**（`schemaPatch` 不 true 就不装）+ 探测/验证失败**给 why**；
  //   ⑥ ★★ **`freeViewSchema` 只在"形状对"时才动手**（`additionalProperties:false`）
  //      —— 形状变了就**一个字段都不加**（这是"绝不半装"的第一道）；
  //   ⑦ 三件工具都定义了 + `note` 在 schema 层 required。
  //   ⚠️ **不测"真底座能不能被包"** —— 那是**真宿主**的事（`dev_stage_*` 读数在台账里），
  //      沙盒里没有真 TeamTaskBoard ⇒ 只能测"我们这一层的形状判断与纪律"。
  section('E2R · 分解边 + 评审判决（台账 / 摘要 / 判决 / 不半装）')
  {
    const E = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'e2r.js')).href)

    // ① 台账：落盘 + **重放**（重启后重建的依据）
    {
      const dir = join(sb.base, 'e2r-track')
      mkdirSync(dir, { recursive: true })
      const cfgE = { trackingFile: 'e2r.jsonl' }
      const m = E.makeE2rManager({ stateDir: dir, cfg: cfgE, log: () => {} })
      const rootA = { id: 'team-A' }
      const p1 = m.setParent({ root: rootA, taskId: 'task-2', parentTask: 'task-1', reason: '从 task-1 切出来' })
      const r1 = m.review({ root: rootA, taskId: 'task-2', reviewState: 'accept', reviewNote: '复现通过' })
      // **重放**：同一份台账新建管理器（= 模拟"重启后重建"）
      const m2 = E.makeE2rManager({ stateDir: dir, cfg: cfgE, log: () => {} })
      const e = m2.entryOf({ id: 'team-A' }, 'task-2')
      CHECK('E2R', p1.ok && r1.ok && e?.parentTask === 'task-1' && e?.reviewState === 'accept' && e?.reviewNote === '复现通过',
        '★ **台账 → 重启后重建**：同一份台账新建管理器，结构照样读得出（盘上事实，不是内存依赖）',
        '只靠内存 ⇒ 重启即失效（那是"看似记了、重启就没了"）',
        `parent.ok=${p1.ok} review.ok=${r1.ok} 重放后 parent=${e?.parentTask} verdict=${e?.reviewState}`)
      // ② `accept` 的判据：**completed 且 accept**（`completed` 本身不算）
      const accYes = m2.isAccepted({ id: 'team-A' }, 'task-2')
      const accNo = m2.isAccepted({ id: 'team-A' }, 'task-9')
      CHECK('E2R', accYes === true && accNo === false,
        '★ **`accepted` 的判据 = 有 `accept` 判决**（没有判决的任务一律不算被批准）',
        '把"有记录"当成"被批准" ⇒ 就是委托方问的"只抄了形式"',
        `有判决=${accYes} 无记录=${accNo}`)
      // ③ 摘要**幂等**：反复合并不越堆越长
      const base = '这是任务的说明。'
      const s1 = E.mergeSummary(base, { parentTask: 'task-1', reviewState: 'accept', reviewNote: 'x' })
      const s2 = E.mergeSummary(s1.text, { parentTask: 'task-1', reviewState: 'accept', reviewNote: 'x' })
      const s3 = E.mergeSummary(s1.text, { parentTask: 'task-1', reviewState: 'reject', reviewNote: 'y' })
      const markCount = (s2.text.match(/【E²R】/g) ?? []).length
      CHECK('E2R', s1.text === s2.text && markCount === 1 && s3.text !== s1.text,
        '★ **摘要合并是幂等的**（同一状态反复合并不越堆越长；判决变了则更新那一行）',
        '不幂等 ⇒ 每次判决都往 description 里追加一行 ⇒ 描述被撑爆、最后被底座的 16384 上限拒',
        `两次相同=${s1.text === s2.text} 标记数=${markCount} 判决变则更新=${s3.text !== s1.text}`)
      // ③-b **超长守卫**：会超底座上限时**明说 tooLong**（不静默截断）
      const huge = E.mergeSummary('x'.repeat(16_383), { parentTask: 'a', reviewState: 'accept' })
      CHECK('E2R', huge.tooLong === true,
        '★ 合并后会超**底座的 16384 上限** ⇒ 返回 `tooLong:true`（调用方据此**不写**，明说"板上看不到这行"）',
        '静默截断 ⇒ 用户以为板上记了、其实底座会拒或内容被砍',
        `tooLong=${huge.tooLong} len=${huge.text.length}`)
    }

    // ④ **跨 Team 隔离**：同一个任务 id 在两个 Team 里各记各的（不外溢）
    {
      const dir = join(sb.base, 'e2r-iso')
      mkdirSync(dir, { recursive: true })
      const m = E.makeE2rManager({ stateDir: dir, cfg: { trackingFile: 'iso.jsonl' }, log: () => {} })
      m.review({ root: { id: 'team-X' }, taskId: 'task-1', reviewState: 'accept', reviewNote: 'X 队接受' })
      const xv = m.entryOf({ id: 'team-X' }, 'task-1')?.reviewState
      const yv = m.entryOf({ id: 'team-Y' }, 'task-1')
      CHECK('E2R', xv === 'accept' && yv === undefined,
        '★★ **跨 Team 隔离**：`task-1` 在 X 队的判决**不会**出现在 Y 队（任务 id 是 per-Team 的）',
        '按 taskId 全局存 ⇒ 一个 Team 的判决串到另一个 Team（与 `release` 那个外溢 bug 同族）',
        `X=${xv} Y=${yv === undefined ? '(无)' : JSON.stringify(yv)}`)
      // 拿不到 root ⇒ **拒绝**（不猜，不写全局桶）
      const noRoot = m.review({ root: { session: {} }, taskId: 'task-3', reviewState: 'accept', reviewNote: 'n' })
      CHECK('E2R', noRoot.ok === false && noRoot.code === 2 && /root-required/.test(String(noRoot.why)),
        '★ **给不出"这是哪个 Team"就拒绝**（`root-required`，不猜、不写全局桶）',
        '拿不到 root 还照写 ⇒ 会写到别的 Team 的任务上',
        `ok=${noRoot.ok} code=${noRoot.code}`)
      // 理由必填（与"说明是更新的一部分"同一条纪律）
      const noNote = m.review({ root: { id: 'team-X' }, taskId: 'task-1', reviewState: 'accept', reviewNote: '   ' })
      CHECK('E2R', noNote.ok === false && noNote.code === 2 && /note-required/.test(String(noNote.why)),
        '★ **判决必须带理由**（空理由 ⇒ `code=2` 拒绝）',
        '没理由的判决 ⇒ 三个月后没人知道当初为什么放行',
        `ok=${noNote.ok} code=${noNote.code}`)
      // 自环拒绝
      const self = m.setParent({ root: { id: 'team-X' }, taskId: 'task-1', parentTask: 'task-1' })
      CHECK('E2R', self.ok === false && /self-parent/.test(String(self.why)),
        '★ **任务不能是自己切出来的**（自环拒绝）',
        '允许自环 ⇒ 结构视图里出现自己当自己父节点的环',
        self.why)
      // ★ `clear`：清空也是**追加一条 `clear`**（台账 append-only，历史仍可回放）
      //   ⚠️ 这条同时挡住一类缺陷：`readLedger` 认 `action:'clear'` ——
      //      若没有**写得出来**的入口，那个分支就是**死代码**（"声明了没人读"，`H30` 同族）。
      const mClear = m.review({ root: { id: 'team-X' }, taskId: 'task-9', reviewState: 'reject', reviewNote: '先给个判决' })
      const cleared = m.clear({ root: { id: 'team-X' }, taskId: 'task-9', reason: '误判，撤销' })
      const gone = m.entryOf({ id: 'team-X' }, 'task-9')
      // **重放**：`clear` 之后重建管理器 ⇒ 该任务**不再有**结构（历史靠台账行，不靠内存）
      const mClear2 = E.makeE2rManager({ stateDir: dir, cfg: { trackingFile: 'iso.jsonl' }, log: () => {} })
      const goneAfterReplay = mClear2.entryOf({ id: 'team-X' }, 'task-9')
      CHECK('E2R', mClear.ok && cleared.ok && gone === undefined && goneAfterReplay === undefined,
        '★ **`clear` 能清掉结构，且重放后仍然清着**（"清空"也是追加一条记录，不删台账行）',
        '只能设不能清 ⇒ 误判的判决永久留在板上；而"删台账行"又会让历史不可回放',
        `判决ok=${mClear.ok} clear.ok=${cleared.ok} 清后=${gone === undefined} 重放后=${goneAfterReplay === undefined}`)
    }

    // ⑤ 路径 A：**默认关**（不装，且给出 why）；开关开了但底座不对 ⇒ 也给 why（不静默、不半装）
    {
      const dir = join(sb.base, 'e2r-patch')
      mkdirSync(dir, { recursive: true })
      // 默认配置：`enabled=false` / `schemaPatch=false` ⇒ **不装**
      const m = E.makeE2rManager({ stateDir: dir, cfg: {}, log: () => {} })
      const p = m.apply()
      CHECK('E2R', p.ok === false && typeof p.why === 'string' && p.why !== '' && m.schemaFree === false,
        '★ **路径 A 默认不装**（`schemaPatch` 未显式开 ⇒ 返回 why、`schemaFree=false`）',
        '默认就动底座已注册工具的 schema ⇒ 漏一个 agent scope 就打断整个任务板（Round 95 真宿主实测）',
        `ok=${p.ok} schemaFree=${m.schemaFree} why=${String(p.why).slice(0, 60)}`)
      // 两个开关都开，但**拿不到 agentTeams.tasks** ⇒ 探测失败 ⇒ **不装**（且 why 指到具体缺失）
      const m2 = E.makeE2rManager({
        stateDir: dir,
        cfg: { enabled: true, schemaPatch: true },
        agentTeams: {},
        tools: {},
        agents: {},
        log: () => {},
      })
      const p2 = m2.apply()
      CHECK('E2R', p2.ok === false && /no-agentTeams\.tasks/.test(String(p2.why)) && m2.schemaFree === false,
        '★★ **开关开了也要先探测**：拿不到 `agentTeams.tasks` ⇒ **拒绝装** + why 指到具体缺失（绝不半装）',
        '半装（字段挂了、schema 没放开）⇒ **整个 `team_task_list` 报错**，比不装糟得多',
        `ok=${p2.ok} why=${String(p2.why).slice(0, 70)}`)
      // ⚠️ **假 double 必须还原真形状**（R95b 教训）：真宿主里
      //   ① `ctx.get('tools')` / `agent.ctx.get('tools')` **每次返回一个实例**，且**每个 agent 一个**；
      //   ② 实例上有 **own** `view`（形态 = `proto.view.bind(实例)`，即 `name === 'bound view'`）——
      //      包 **prototype 是静默无效的**。
      //   ⇒ 若 double 只给"原型上的 view"，就**测不出**这个真缺陷（我第一版就是这么漏的）。
      const mkFakeTools = () => {
        const LIST_SCHEMA = () => ({
          type: 'object',
          additionalProperties: false,
          properties: {
            tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } } },
            nextCursor: { type: 'integer' },
          },
        })
        class FakeRuntime {
          constructor() {
            this.def = { name: 'team_task_list', output: { schema: LIST_SCHEMA(), render: () => [] } }
            // ★ **own bound `view`**（真形状：`proto.view.bind(this)`）
            const self = this
            const bound = Object.getPrototypeOf(this).view.bind(this)
            Object.defineProperty(this, 'view', { value: bound, writable: true, configurable: true, enumerable: true })
            void self
          }
          view() {
            return { visible: new Map([['team_task_list', this.def]]), knownNames: new Set(['team_task_list']), restrictableNames: new Set() }
          }
          get(name) {
            return this.view().visible.get(name)
          }
        }
        return new FakeRuntime()
      }
      /** 造一个**真形状**的假 agent：它有自己的 `ctx.get('tools')`。
       * ⚠️ 这里**按 agent 缓存同一实例**（真宿主的 `ctx.get('tools')` 每次可能返回**新** facade ——
       *   那条另见交付报告里的"身份不稳定"实测；本组测的是**我们的逻辑**，故用稳定身份）。 */
      const mkFakeAgent = (id) => {
        const rt = mkFakeTools()
        return { id, ctx: { get: (k) => (k === 'tools' ? rt : undefined) } }
      }
      const m3 = E.makeE2rManager({
        stateDir: dir,
        cfg: { enabled: true, schemaPatch: true },
        // 形状对的假 board（own `taskView`）
        agentTeams: { tasks: Object.defineProperty({}, 'taskView', { value: function taskView() { return {} }, writable: true, configurable: true, enumerable: false }) },
        tools: mkFakeTools(),
        agents: { list: () => [] }, // ★ **空**：没有任何 agent 可验
        log: () => {},
      })
      const p3 = m3.apply()
      CHECK('E2R', p3.ok === false && /no-agent-to-verify|unverified/.test(String(p3.why)) && m3.schemaFree === false,
        '★★ **没有 agent 可验 ⇒ 拒绝装**（验不了就不装 —— "读不到 ≠ 通过"）',
        '验不了还装 ⇒ 装没装上没人知道；万一没放开，用户遇到的是"任务板报错"',
        `ok=${p3.ok} why=${String(p3.why).slice(0, 80)}`)
      // ★★ **正例：有 agent 可验 + schema 真放开 ⇒ 装成**（证明 A 不是"永远拒绝"）
      const fakeAgents = [mkFakeAgent('agent-1'), mkFakeAgent('agent-2')]
      const m4 = E.makeE2rManager({
        stateDir: dir,
        cfg: { enabled: true, schemaPatch: true },
        agentTeams: {
          tasks: Object.defineProperty(
            {
              _views: [],
              list() {
                return this._views
              },
            },
            'taskView',
            { value: function taskView(root, state, task) { return { id: task.id, subject: task.subject, status: task.status } }, writable: true, configurable: true, enumerable: false },
          ),
        },
        tools: mkFakeTools(),
        agents: { list: () => fakeAgents },
        log: () => {},
      })
      const p4 = m4.apply()
      CHECK('E2R', p4.ok === true && m4.schemaFree === true,
        '★★ **正例：有 agent 可验 + schema 真放开 ⇒ A 装成**（`ok:true` / `schemaFree:true`）',
        '只会拒绝不会装 ⇒ 那这条能力等于不存在（与"永远报未验证"同族）',
        `ok=${p4.ok} schemaFree=${m4.schemaFree} defs=${m4.patchedDefs} via=${p4.via}`)
      // ★★ **"所有 agent"都要放开 —— 全部验到才算过**（R95b 修的真缺陷）
      //   判据：m4 装完后，**每个** fake agent 用它自己的 runtime 取定义，三字段都得在
      const perAgent = fakeAgents.map((a) => {
        const d = a.ctx.get('tools').get('team_task_list', a)
        const it = d?.output?.schema?.properties?.tasks?.items
        return it ? ['parentTask', 'reviewState', 'reviewNote'].every((f) => f in it.properties) : false
      })
      CHECK('E2R', perAgent.length === 2 && perAgent.every(Boolean),
        '★★ **每个 agent 各自那条链都放开了**（`verify()` 的判据是 **∀ 全部**，不是 ∃ 一个）',
        '只要有一个 agent 没放开 ⇒ 视图会给它加字段而它的 schema 不收 ⇒ **它一调 `team_task_list` 就报错**',
        `逐 agent = ${perAgent.map((b) => (b ? 'OK' : '未放开')).join(' / ')}`)
      // ★★ **一个 agent 没放开 ⇒ 必须拒绝装**（这条挡住"多数成功就放行"的错误判据）
      {
        // 造 3 个 agent，其中一个的 runtime 拒绝被包装（`view` 不可写 ⇒ patchNewRuntimes 跳过它）
        const bad = mkFakeAgent('agent-bad')
        const badRt = bad.ctx.get('tools')
        Object.defineProperty(badRt, 'view', { value: badRt.view, writable: false, configurable: false })
        const mixed = [mkFakeAgent('agent-ok'), bad]
        const m5 = E.makeE2rManager({
          stateDir: dir,
          cfg: { enabled: true, schemaPatch: true },
          agentTeams: (() => {
            const b = { list: () => [] }
            Object.defineProperty(b, 'taskView', { value: function taskView() { return {} }, writable: true, configurable: true, enumerable: false })
            return { tasks: b }
          })(),
          tools: mkFakeTools(),
          agents: { list: () => mixed },
          log: () => {},
        })
        const p5 = m5.apply()
        CHECK('E2R', p5.ok === false && m5.schemaFree === false,
          '★★ **只要有一个 agent 的链没放开 ⇒ 拒绝装**（"多数成功"不算成功）',
          '按"有一个成功就放行"判 ⇒ 剩下的 agent 一调 `team_task_list` 就报 `additionalProperties: false`',
          `ok=${p5.ok} schemaFree=${m5.schemaFree} why=${String(p5.why).slice(0, 60)}`)
      }
      // 卸载：**两段 undo 都跑**，且 `schemaFree` 回到 false
      const d4 = m4.dispose()
      CHECK('E2R', d4.ok === true && m4.schemaFree === false,
        '★★ **卸载：两段 undo 都跑且都成功**（`ok:true`；`schemaFree` 回到 false）',
        '只还原一段 ⇒ 留下"字段还在但 schema 已还原"的半装态（**那正是整个任务板报错的形态**）',
        `ok=${d4.ok} why=${d4.why || '(无)'} schemaFree=${m4.schemaFree}`)
      // ★★ **卸载后必须"回读核验"**（R95b 实测：`dispose()` 报 `ok:true`，真机却仍留一个包装 ⇒
      //    定义字段数 10→**13**）⇒ 判据是"定义真的回到干净"，不是"undo 没抛错"。
      const afterDispose = fakeAgents.map((a) => {
        const rt = a.ctx.get('tools')
        const d = rt.get('team_task_list', a)
        return Object.keys(d?.output?.schema?.properties?.tasks?.items?.properties ?? {}).length
      })
      CHECK('E2R', afterDispose.every((n) => n === 1),
        '★★ **卸载后回读核验：定义回到"只有 id"的原始形状**（字段数 = 1，不是 4）',
        '不核验 ⇒ "报 ok:true 但真机仍有残留"（我实测过一次：`dispose()` ok 而字段数 10→13）',
        `逐 agent 字段数 = ${afterDispose.join(',')}`)
    }

    // ⑤-b ★★ **空公司（members=0）也必须能用**（R96 / task-63 —— `lead` 用真 omc 会话抓到的真缺陷）
    // 【缺陷】`release-tools.js` 的 `readsOk` 原本要求 **`members.length > 0`**
    //   ⇒ **刚建、还没招人的 Team 一律读不通** ⇒ 新开一个 omc 会话调 `team_structure` 报
    //     `root-unresolved` ⇒ **"开公司的第一步"恰好发生在公司为空的时候**。
    // 【根因】`journal.state(root)` 是**按该 agent 自己 session 取的投影**
    //   （`projection.js:254` `init: header => emptyTeamState(header.id)`）⇒ 它**对任何 agent 都不抛**
    //   ⇒ `members>0` **从来就不是身份判据**，只是"看着像个 Team"的近似。
    // 【修法】身份 = `tryMembership.role==='lead'` **且** `parentSession===undefined`（R80 伪 lead 行教训）；
    //   **团规模单列一个闸门** `allowEmptyTeam`：读型 `true` / 写型默认 `false`（**风险不对称**）。
    {
      const R = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'release-tools.js')).href)
      /** 造一个**空公司**的假 Team：一个真 root（无 parent）+ 一个真 teammate（有 parent）。 */
      const mkEmptyTeam = () => {
        const mkAgent = (id, parentSession) => ({
          id,
          session: { header: { id, ...(parentSession === undefined ? {} : { parentSession }) } },
        })
        const lead = mkAgent('lead-empty')
        const mate = mkAgent('mate-1', 'lead-empty')
        const st = { id: 'lead-empty', members: [] } // ★ **members = 0**（空公司）
        const journal = { state: () => st }
        const roster = {
          tryMembership: (a) => (a.id === 'lead-empty'
            ? { root: lead, id: 'x', role: 'lead', name: 'lead' }
            : { root: lead, id: 'x', role: 'teammate', name: 'mate-1' }),
        }
        return { agentTeams: { journal, roster }, lead, mate }
      }
      // ① 读型（`allowEmptyTeam: true`）⇒ **空公司里认得出 root**
      {
        const { agentTeams, lead } = mkEmptyTeam()
        const got = R.resolveTeamRoot(lead, { agentTeams, agents: { list: () => [lead] }, allowEmptyTeam: true })
        CHECK('E2R', got === lead,
          '★★ **空公司（members=0）里，读型也能认出自己的 root**（task-63 修的真缺陷）',
          '`members>0` 当 root 判据 ⇒ **新开一个 omc 会话第一件事就报 "root-unresolved"**（公司初始化时必然为空）',
          `resolveTeamRoot(allowEmptyTeam:true) = ${got === lead ? '认出 root ✓' : String(got)}`)
      }
      // ② 写型（默认严）⇒ **空公司里仍拒绝**（破坏性工具保持原语义）
      {
        const { agentTeams, lead } = mkEmptyTeam()
        const got = R.resolveTeamRoot(lead, { agentTeams, agents: { list: () => [lead] } })
        CHECK('E2R', got === undefined,
          '★★ **空公司里，写型（默认）仍拒绝**（破坏性工具不放宽 —— 读/写风险不对称）',
          '放宽破坏性工具 ⇒ 在**还没有成员的 Team** 上写了释放台账，那条记录会**在该名字将来加入时立刻生效**（延迟生效的脚枪）',
          `resolveTeamRoot(默认) = ${got === undefined ? 'undefined ✓（保持严格）' : '认出了（不该）'}`)
      }
      // ③ ★★ **真 teammate 永远不能被认成"自己当 root"**（R80 伪 lead 行）
      {
        const { agentTeams, lead, mate } = mkEmptyTeam()
        const got = R.resolveTeamRoot(mate, { agentTeams, agents: { list: () => [lead, mate] }, allowEmptyTeam: true })
        CHECK('E2R', got !== mate && got === lead,
          '★★ **真 teammate 解析成它的 Lead，而不是它自己**（哪怕开了 `allowEmptyTeam`）',
          '把队友当成 root ⇒ **动到别人的 Team**（R80 那条"`tryMembership` 对非 roster 子 agent 返回伪 lead 行"的同一个坑）',
          `teammate → ${got === mate ? '**它自己（严重）**' : (got === lead ? '它的 Lead ✓' : String(got))}`)
      }
      // ④ ★★ **判断靠的是"身份"，不是"不抛"**（`lead` 实测：真 teammate 的 state() 也不抛）
      {
        // 造一个"state() 不抛、但 role 不是 lead"的 agent ⇒ **绝不能被当 root**
        const lead = { id: 'L', session: { header: { id: 'L' } } }
        const impostor = { id: 'I', session: { header: { id: 'I' } } } // 无 parent，但 membership=teammate
        const journal = { state: () => ({ id: 'I', members: [] }) }
        const roster = { tryMembership: () => ({ root: lead, id: 'x', role: 'teammate', name: 'imp' }) }
        const got = R.resolveTeamRoot(impostor, { agentTeams: { journal, roster }, agents: { list: () => [impostor] }, allowEmptyTeam: true })
        CHECK('E2R', got === undefined,
          '★★ **"`state()` 不抛"不足以为证**（role≠lead 的一律不认，哪怕它没 parent、哪怕读了不抛）',
          '`lead` 已实测：真 teammate 的 `state()` **也不抛** ⇒ 只按"不抛"判 ⇒ **把队友当 root**',
          `role=teammate 且无 parent ⇒ ${got === undefined ? 'undefined ✓' : '认出了（不该）'}`)
      }
      // ⑤ **假对象（乱 id）仍然拒绝**（`lead` 实测：null/{}/假 id 都会抛）
      {
        const journal = { state: () => { throw new Error('projection is not registered') } }
        const roster = { tryMembership: () => ({ role: 'lead', name: 'lead' }) }
        const got = R.resolveTeamRoot({ id: 'bogus' }, { agentTeams: { journal, roster }, agents: { list: () => [] }, allowEmptyTeam: true })
        CHECK('E2R', got === undefined,
          '★ **`state()` 读不通（投影没注册）⇒ 仍拒绝**（"不猜"纪律不变）',
          '读不通还认 ⇒ 会把随便什么 agent 当成 Team root',
          `读不通 ⇒ ${got === undefined ? 'undefined ✓' : '认出了（不该）'}`)
      }
    }

    // ⑤-c ★★ **成员 → 角色档 `level` 读口（task-77）**：**"我不知道"不许显示成"Junior"**
    //   【委托方当场问的】「为什么我没有在图像里面看到分层？」⇒ `LAYERING-SOURCE.md §2` 定成
    //     "level 在磁盘、进了模型上下文，**缺一个对外可读口**把自己跟成员名对上"。
    //   【本组验的**核心是 honesty 那一格**】：匹配不上 ⇒ `exists:false` + **`level` 为空**，
    //     **绝不默认成 1/'ic'**；读不到目录 ⇒ **整口"未获取"**（不是"这些人都没有角色档"）。
    {
      const T = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'e2r-tools.js')).href)
      const ROLES = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'roles.js')).href)
      const deps = { loadRoles: ROLES.loadRoles, roleFor: ROLES.roleFor }
      // ⚠️ **仓内角色档的真实落点**（我第一版写成 `<repo>/roles` ⇒ **不存在** ⇒ 4 条断言当场红）。
      //   实际落点是 `runs/005-role-skills/roles`（`roles.js` 头注释写的那个「数据来源」；
      //   打包副本在 `plugin/assets/roles`）。⇒ **路径要用候选列表 + "哪个真的存在"**（`LANDMINES §4`），
      //   不是猜一个。这里优先用**源**（runs/…），它不存在时退到**包内副本**（assets/roles）。
      const realDir = [
        join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles'),
        join(PLUGIN_DIR, 'assets', 'roles'),
      ].find((d) => existsSync(join(d, 'engineer.json')))

      // ① 有档成员 ⇒ level 正确
      {
        const r = T.describeMemberLevels(realDir, ['engineer'], deps)
        const row = r.rows?.[0]
        CHECK('E2R', r.ok === true && row?.exists === true && row?.level === 'ic' && row?.role === 'engineering',
          '★ **有角色档的成员 ⇒ `level` 正确**（`engineer` → `ic`，与 `roles.js:42` 的取值域一致）',
          '有档却报不出来 ⇒ 读口没接通（那面板就只能继续写死）',
          `ok=${r.ok} engineer → exists=${row?.exists} level=${row?.level} role=${row?.role}`)
      }
      // ② ★★ **反例断言（本任务最看重）**：无档成员 ⇒ **"无角色档"，不是 1**
      {
        const r = T.describeMemberLevels(realDir, ['panel-smith', 'e2r-landing', 'engineering-director'], deps)
        const rows = r.rows ?? []
        const allNoRole = rows.length === 3 && rows.every((x) => x.exists === false)
        // ★ 判据：**`level` 必须是 `undefined`**（不是 1、不是 'ic'、不是任何默认值）
        const noLevelAtAll = rows.every((x) => x.level === undefined)
        CHECK('E2R', r.ok === true && allNoRole && noLevelAtAll,
          '★★ **反例断言：无角色档的成员 ⇒ `exists:false` 且 `level` 为空**（**不是 1 / 不是 "Junior"**）',
          '把"我不知道"显示成"Junior"是本项目最忌讳那类谎（面板写死 `level:1` 正是委托方说"没看到分层"的来源）',
          `panel-smith/e2r-landing/engineering-director → exists=${rows.map((x) => x.exists).join(',')} level=${JSON.stringify(rows.map((x) => x.level))}`)
        // 覆盖率也要如实（本 Team 实测只有 5/21 有档 ⇒ 读口必须能表达"低覆盖"而不是"人人有级"）
        CHECK('E2R', r.stats.withRole === 0 && r.stats.total === 3,
          '★ **覆盖率如实**：这 3 个都无档 ⇒ `withRole:0`（不虚报）',
          '虚报覆盖率 ⇒ 消费者以为"人人有职级"，实际上 76% 的人没有',
          `withRole=${r.stats.withRole}/${r.stats.total} coverage=${(r.stats.coverage * 100).toFixed(0)}%`)
      }
      // ③ ★★ **目录不存在 ⇒ 三态里的"未获取"**（不崩、不是 1、也不是"全都无档"）
      {
        const r = T.describeMemberLevels(join(sb.base, 'no-such-roles-dir'), ['engineer'], deps)
        CHECK('E2R', r.ok === false && r.readable === false && /未获取/.test(String(r.why)) && r.rows.length === 0,
          '★★ **角色档目录不存在 ⇒ 整口返回「未获取」**（**不崩、不兜底成 1、也不报成"全都无档"**）',
          '把"我没读到目录"说成"这些人都没有角色档" ⇒ 开源用户（没装 roles）会看到一份假名单',
          `ok=${r.ok} readable=${r.readable} rows=${r.rows.length} why=${String(r.why).slice(0, 60)}`)
      }
      // ④ **空成员列表**：如实给 0/0（不是崩、也不是假覆盖率）
      {
        const r = T.describeMemberLevels(realDir, [], deps)
        CHECK('E2R', r.ok === true && r.stats.total === 0 && r.stats.coverage === 0,
          '★ **空名单 ⇒ `0/0` 且 coverage 为 0**（不除零、不崩）',
          '除零 → NaN/Infinity ⇒ 消费者算比例时静默出错',
          `total=${r.stats.total} coverage=${r.stats.coverage}`)
      }
      // ⑤ **匹配规则必须与 `roles.js:176 roleFor` 是同一套**（不许自己重写第二套）
      {
        const src = (() => { try { return readFileSync(join(PLUGIN_DIR, 'lib', 'e2r-tools.js'), 'utf8') } catch { return '' } })()
        // 判据：本模块**调用 `roleFor`**（而不是自己 `roles.get(...)` 造第二套匹配）
        const usesRoleFor = /roleFor\(loaded\.roles,\s*name\)/.test(src)
        const ownMatch = /roles\.get\(name\)/.test(src)
        CHECK('E2R', usesRoleFor && !ownMatch,
          '★★ **匹配规则走 `roles.js` 的 `roleFor`**（同一份代码），**没有重写第二套 `roles.get`**',
          '自己重写匹配 ⇒ 出现"两份事实"：角色档改规则后读口不跟（`LAYERING-SOURCE.md §4` 把"按名字猜"列为被否写法）',
          `用 roleFor=${usesRoleFor} 自造匹配=${ownMatch}`)
      }
      // ⑥ **真仓角色档读数**（不是假数据 —— 证明这口在真目录上真能读）
      {
        const r = T.describeMemberLevels(realDir, ['chief', 'coo', 'engineer', 'marketer', 'research-lead', 'reviewer', 'writer', 'nobody-xyz'], deps)
        const got = Object.fromEntries((r.rows ?? []).map((x) => [x.name, x.exists ? x.level : '(无档)']))
        CHECK('E2R', r.ok === true && got.chief === 'ceo' && got.coo === 'coo' && got.engineer === 'ic' &&
          got['research-lead'] === 'lead' && got['nobody-xyz'] === '(无档)',
          '★ **真角色档目录上的读数**（7 份全读对；瞎编的名字如实无档）',
          '读口在真数据上错 ⇒ 面板接上也画错',
          `chief=${got.chief} coo=${got.coo} engineer=${got.engineer} research-lead=${got['research-lead']} nobody-xyz=${got['nobody-xyz']}`)
      }
    }

    // ⑥ `freeViewSchema`：**只认形状**（`additionalProperties:false`）—— 形状变了就不动
    {
      const okSchema = {
        type: 'object',
        additionalProperties: false,
        properties: { tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } } } },
      }
      const n1 = E.freeViewSchema(okSchema)
      const items1 = okSchema.properties.tasks.items
      const listOk = n1 === 3 && items1.properties.parentTask?.type === 'string' && items1.additionalProperties === false
      CHECK('E2R', listOk,
        '★ **`TASK_LIST` 形状**：给 `properties.tasks.items` 加三字段，且**保留** `additionalProperties:false`',
        '把 `additionalProperties` 改成 true ⇒ 等于把底座的出口契约悄悄放宽（不只是加我们三个）',
        `加了 ${n1} 个；items.keys=${Object.keys(items1.properties).join(',')}`)
      // `TASK_VIEW` 形状（create/get/update 的 output 就是它本身）
      const viewSchema = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } }
      const n2 = E.freeViewSchema(viewSchema)
      CHECK('E2R', n2 === 3 && viewSchema.properties.reviewState?.type === 'string',
        '★ **`TASK_VIEW` 形状**（`create`/`get`/`update` 的 output 就是它）也加三字段 —— **4 个工具都要覆盖**',
        '只放 `team_task_list` 而漏掉另三个 ⇒ 那三个一调就报 `additionalProperties: false`',
        `加了 ${n2} 个`)
      // 形状不对（没有 additionalProperties:false）⇒ **一个都不加**
      const wrong = { type: 'object', properties: { id: { type: 'string' } } }
      const n3 = E.freeViewSchema(wrong)
      CHECK('E2R', n3 === 0 && wrong.properties.parentTask === undefined,
        '★★ **形状不对就一个字段都不加**（没有 `additionalProperties:false` ⇒ 底座可能已变）',
        '对着未知形状硬加 ⇒ 可能把底座的契约改坏（这就是"半装"的前一步）',
        `加了 ${n3} 个`)
    }

    // ⑦ **能力必须是"可调用的"**（同 R 组第 ⑧ 条的纪律：只做机制、没人能调 = 没交付）
    {
      const src = (() => { try { return readFileSync(join(PLUGIN_DIR, 'lib', 'e2r-tools.js'), 'utf8') } catch { return '' } })()
      const want = ['set_task_structure', 'review_task', 'team_structure']
      const miss = want.filter((n) => !src.includes(`name: '${n}'`))
      CHECK('E2R', src !== '' && miss.length === 0,
        '★ **三件工具都定义了**（`set_task_structure` / `review_task` / `team_structure`）',
        '只有机制没有工具 ⇒ 用户根本调不到"设结构 / 写判决"（R 组当年踩过的同一个死角）',
        miss.length === 0 ? `${want.length} 个齐` : `缺: ${miss.join(', ')}`)
      const noteRequired = /note:\s*\{[^}]*required:\s*true/s.test(src)
      CHECK('E2R', noteRequired,
        '★ **`review_task` 的 `note` 在 schema 层就是 `required: true`**（模型连调用都构造不出来）',
        '只在运行时判断 ⇒ 模型先构造出调用再被拒（多一跳）；schema 层挡住更早',
        noteRequired ? 'schema 层 required ✓' : '未在 schema 层标 required')
      // ⚠️ **`enum` 要真进 schema**（我第一版 `paramsToJsonSchema` 漏了 `enum` 转发，
      //    它会**静默退化**成"字符串数组约束没了" —— 与 `release-tools.js` 那条同族）
      const enumForwarded = /if \(v\.enum !== undefined\) p\.enum = v\.enum/.test(src)
      CHECK('E2R', enumForwarded,
        '★ **`paramsToJsonSchema` 要转发 `enum`**（否则 `verdict` 的取值约束**静默消失**）',
        '转换器支持的字段比调用方用的少 ⇒ 少了一个约束而**没人知道**（子集退化）',
        enumForwarded ? 'enum 已转发 ✓' : '**未转发 enum**')
    }

    // ⑧ ★ **技能里真的写了这三件事**（`H16` 的"对外能力要有落点"，这里对本能力再自证一次）
    {
      const sk = (() => {
        try { return readFileSync(join(PLUGIN_DIR, '..', 'skills', 'teamkit-review', 'SKILL.md'), 'utf8') } catch { return '' }
      })()
      const want = ['review_task', 'set_task_structure', 'team_structure', 'accepted']
      const miss = want.filter((w) => !sk.includes(w))
      CHECK('E2R', sk !== '' && miss.length === 0,
        '★ **三件工具与 `accepted` 都写进了 `teamkit-review`**（成员读得到才叫交付）',
        '能力做了但技能里没有 ⇒ 成员与 Lead 都读不到它 ⇒ 等于没做（`H16` 已抓过三次）',
        miss.length === 0 ? `${want.length} 项都在` : `缺: ${miss.join(', ')}`)
      // ★★ **机制 vs 协议必须分开写**（`H41` 口径：不许把"我们要求"说成"我们强制"）
      const hasProtocolNote = /协议/.test(sk) && /不是强制点|不强制|真机制/.test(sk)
      CHECK('E2R', hasProtocolNote,
        '★★ **技能里明说了"哪部分是机制、哪部分是协议"**（`reviewState` **不是强制点**）',
        '把"有个字段"说成"会拦住你" ⇒ 正是 `H41` 抓的那种空头承诺',
        hasProtocolNote ? '有机制/协议对照 ✓' : '**没写机制 vs 协议**')
      // **分解边 ≠ 依赖边**必须说清（别把近似说成等价）
      const hasApprox = /近似/.test(sk)
      CHECK('E2R', hasApprox,
        '★ **说清"我们用依赖边近似表达分解关系"**（不许把近似说成等价）',
        '`blocked_by`(E_dep) 与 `parentTask`(E_tree) 是两样东西，同一对节点上方向可能相反',
        hasApprox ? '有"近似"标注 ✓' : '**没标近似**')
    }
  }

  // ═══ H · 结构（可安装性 / 可维护性的机械判据）═════════════════════════
  section('H · 包结构与可安装性')
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  CHECK('H', pkg.dsh?.bundle?.patch === './cordis.patch.yml',
    '`dsh.bundle.patch` 指向 cordis.patch.yml（生态惯例；`dsh plugin` 靠它认这是 bundle）',
    'package.json 里没有 dsh.bundle.patch ⇒ `dsh plugin add` 只会当普通依赖装',
    JSON.stringify(pkg.dsh ?? null))
  CHECK('H', existsSync(join(PLUGIN_DIR, 'cordis.patch.yml')),
    'cordis.patch.yml 存在且被 files 白名单收录', 'patch 文件缺失或不在 files 里',
    `files=${JSON.stringify(pkg.files ?? [])}`)
  const peerVersions = Object.values(pkg.peerDependencies ?? {})
  CHECK('H', peerVersions.length > 0 && peerVersions.every((v) => typeof v === 'string' && !/^\d+\.\d+\.\d+$/.test(v)),
    'peerDependencies **只声明范围、不硬编码版本**（照生态模式，如 `>=0.0.1-rc <2`）',
    'peerDependencies 里写死了版本', JSON.stringify(pkg.peerDependencies ?? {}))
  const hasDeps = Object.keys(pkg.dependencies ?? {}).length === 0
  CHECK('H', hasDeps, '**零 runtime 依赖**（`dependencies` 为空）⇒ 装它不会拖任何东西',
    '引入了 runtime 依赖 ⇒ 安装会变重，且注入目录里解析不到', `dependencies=${JSON.stringify(pkg.dependencies ?? {})}`)
  const filesWhitelisted = Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('bin')
    && pkg.files.includes('cordis.patch.yml')
  CHECK('H', filesWhitelisted, '`files` 白名单包含 lib / bin / cordis.patch.yml', 'files 白名单不完整')

  // ── H53 · ★★★ **职责字段存在但没人读 ⇒ 判红**（2026-09-14 / task-104 第 1 阶段）──────
  //
  // 【为什么要有它】`task-104` 分两阶段：第 1 阶段只加**数据**（`duties`/`boundaries` 进角色档），
  //   第 2 阶段才改 `roles.js` 的 `personaFor()` 让它们**进成员上下文**。
  //   ⇒ ⚠️ **两阶段之间会有一个危险窗口**：角色档里**字段全在**，而**成员第一条提示词里一个字都看不到**
  //     ⇒ 若没有这条断言，**板上会显示"职责层已实现"** —— 而那正是本项目反复栽的
  //       「**有机制的样子、没有机制的效果**」（`H42` 同族 / `LANDMINES §9` 字段存在≠值正确）。
  //   ⇒ ★ **这条断言的设计目标就是"在第 1 阶段结束时【红】"** ——
  //     它把"半成品"变成**可见的红**，而不是让它冒充完成。
  //     **第 2 阶段（`personaFor()` 注两行）落地后，它会自动转绿**（无需改本断言）。
  //
  // 【三态】`R24`：角色档读不到 ⇒ **未获取**（不判红也不判绿）
  {
    const rolesDirAbs = join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles')
    let roleFiles = null
    let why = null
    try {
      roleFiles = readdirSync(rolesDirAbs).filter((f) => f.endsWith('.json') && f !== 'INDEX.json')
    } catch (err) {
      why = err?.code ?? err?.message ?? String(err)
    }
    if (roleFiles === null) {
      UNV('H53', '职责字段的**消费者**检查', `读不到角色档目录 ${rolesDirAbs}（${why}）⇒ 未获取`)
    } else {
      // ① 数据侧：8 份档案是否都有两字段，且每条带理由指针
      const withFields = []
      const missing = []
      const noPointer = []
      for (const f of roleFiles) {
        let j = null
        try { j = JSON.parse(readFileSync(join(rolesDirAbs, f), 'utf8')) } catch { continue }
        const d = Array.isArray(j.duties) ? j.duties : []
        const b = Array.isArray(j.boundaries) ? j.boundaries : []
        if (d.length > 0 && b.length > 0) withFields.push(f)
        else missing.push(f)
        for (const s of [...d, ...b]) if (!String(s).includes('依据：')) noPointer.push(`${f}: ${String(s).slice(0, 40)}`)
      }
      CHECK('H53', missing.length === 0,
        `**每份角色档都有 duties + boundaries**（${withFields.length}/${roleFiles.length} 份）`,
        `缺字段的档案 ⇒ 委托方那一问（"不该做什么"）没有落点：${missing.join(' | ')}`,
        missing.length === 0 ? `${roleFiles.length} 份齐全` : missing.join(','))
      CHECK('H53', noPointer.length === 0,
        '**每条 duties/boundaries 都带理由指针**（`依据：…`）⇒ **不是口号**',
        '有职责条目**没带理由指针** ⇒ 无法证伪、拦不住任何人（= 口号）：' + noPointer.slice(0, 3).join(' | '),
        noPointer.length === 0 ? '全部带指针' : `${noPointer.length} 条缺指针`)

      // ② ★ 消费者侧：`personaFor()` 到底有没有读它们 —— **这一条就是"字段存在但没人读"的判据**
      let rolesJs = ''
      try { rolesJs = readFileSync(join(PLUGIN_DIR, 'lib', 'roles.js'), 'utf8') } catch { rolesJs = '' }
      const consumerReads = /\brole\.duties\b/.test(rolesJs) || /\brole\.boundaries\b/.test(rolesJs)
      CHECK('H53', consumerReads,
        '**职责字段有消费者**（`roles.js` 的 `personaFor()` 读了 `role.duties` / `role.boundaries`）⇒ 成员第一条提示词里看得到',
        '**角色档里已写入 `duties`/`boundaries`，而 `roles.js` 一个都没读** ⇒ ' +
          '「**字段存在但没人读**」= 有机制的样子、没有机制的效果。' +
          '（★ **若你正在做 task-104 第 1 阶段，这条红是【预期的】**：第 2 阶段改 `personaFor()` 后自动转绿）',
        consumerReads ? 'roles.js 已消费' : '★ **预期红（task-104 第 1 阶段）**：roles.js 尚未消费')

      // ②bis ★★ **编制字段（`reports_to`）也要有消费者**（`task-114`；CEO 提醒 1：**同一形状会再犯**）
      // ```
      // 【为什么扩这一条】`task-104` 那个洞的形态 = **"字段写进档案了，但没人读"**（`H53` 抓过）。
      //   ★ CEO 明确指出：`reports_to` **是同一个形状的下一例** ⇒
      //     **不扩 ⇒ 下一个人会再犯一次**（"修一处、不加机制、下次又来"——本项目反复栽的形态）。
      // 【判据】与 `duties` 同口径：`roles.js` 里必须**真读** `role.reports_to`
      //   ⚠️ 而且要**真拼进 persona 文本**（这一步由下面 ②ter 验 —— 光"读了"不算，得"看得见"）
      // ```
      const reportsConsumer = /\brole\.reports_to\b/.test(rolesJs)
      CHECK('H53', reportsConsumer,
        '**编制字段有消费者**（`roles.js` 的 `personaFor()` 读了 `role.reports_to`）⇒ 成员提示词里看得到"我向谁报"',
        '★ **角色档里有 `reports_to`，而 `roles.js` 没读** ⇒ ' +
          '与 `task-104` 的洞**同一形状**（"字段存在但没人读"）⇒ 下一个人会再犯',
        reportsConsumer ? 'roles.js 已消费 reports_to' : '★ **编制字段没人读**')

      // ②ter ★★★ **编制必须【真拼进 persona 文本】**（CEO 提醒 1+2：光"读了"不够，要"看得见"）
      // ```
      // 【判据 · 两条，正反都要】
      //   ① `personaFor(coo)` 的文本里**出现其上级名**（`coo` 的上级是 `chief`）
      //   ② ★ `personaFor(chief)` 的文本里**明写"未声明"**（`chief` 上面没有人）
      //      ⇒ ★ **"没有上级"与"没声明上级"是两件事** —— 后者必须**可见**，不是那一行静默消失
      // 【为什么用真 `loadRoles`+`personaFor`】只读源码判"有没有读"会假绿（本项目栽过）；
      //   这里**真跑**函数、**看拼出的文本**。
      // ```
      {
        let pErr = null
        let cooText = ''
        let chiefText = ''
        try {
          const rolesMod = await import(new URL('file:///' + join(PLUGIN_DIR, 'lib', 'roles.js').replace(/\\/g, '/')).href)
          const loaded = rolesMod.loadRoles(join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles'))
          const coo = loaded.roles.get('coo')
          const chief = loaded.roles.get('chief')
          if (coo === undefined || chief === undefined) throw new Error('roles 里缺 coo 或 chief')
          cooText = rolesMod.personaFor(coo, undefined, undefined, undefined, loaded.roles)
          chiefText = rolesMod.personaFor(chief, undefined, undefined, undefined, loaded.roles)
        } catch (err) {
          pErr = String(err?.message ?? err)
        }
        const up = typeof cooText === 'string' && cooText.includes('chief')
        CHECK('H53', pErr === null && up,
          '★★ **`personaFor(coo)` 的文本里出现其上级**（"我向谁报"真的进了提示词，不是只在档案里）',
          pErr !== null ? `跑不起来：${pErr.slice(0, 100)}` : '编制段没进 persona 文本 ⇒ 成员看不到 ⇒ 等于没有',
          pErr !== null ? `抛错: ${pErr.slice(0, 80)}` : `含 chief=${up}`)
        const undeclared = typeof chiefText === 'string' && /未声明/.test(chiefText)
        CHECK('H53', pErr === null && undeclared,
          '★★ **`personaFor(chief)` 里明写「未声明」**（"没有上级"要**看得见**，不是那行静默消失）',
          pErr !== null ? `跑不起来：${pErr.slice(0, 100)}` : 'chief 的编制行被静默跳过 ⇒ 读者分不清"没上级"与"没声明"',
          pErr !== null ? `抛错: ${pErr.slice(0, 80)}` : `含"未声明"=${undeclared}`)
      }

    // ③ ★★★ **发货态**：用户机器上跑的那份（`$DSH_HOME/teamkit/roles`）有没有字段（2026-09-15 / CEO 抓的洞）
    // ```
    // 【为什么补这一条】**CEO 实测抓到**：仓内 8 份全有 `duties`、`H53` 绿、`personaFor()` 也读了 ——
    //   而**真机目录 `$DSH_HOME/teamkit/roles` 是两天前的旧版**（`duties=0`、**无 `director.json`**）
    //   ⇒ ★ **`H53` 绿 ≠ 用户拿到职责** —— 它读的是**仓内源码路径**（`runs/005-role-skills/roles`），
    //     而**成员实际读的是安装器落的那份**。
    //   ⇒ ★ 这是"**读数的范围 ≠ 结论的范围**"（今晚那一族最贵的一次）。
    // ```
    // 【三态（`R24`）】：
    //   · `DSH_HOME` 没设 或 真机目录不存在（没装 / CI）⇒ **`UNV`（未获取）**，**不判红**
    //   · 存在 ⇒ 逐份核 `duties`/`boundaries` 条数 **与仓内源一致** + **`director.json` 在**
    //   ★ **不硬编码真机路径**（`R12`）：走 `DSH_HOME` 环境变量，取不到 ⇒ 未获取。
    {
      const dshHome = process.env.DSH_HOME ?? ''
      const shipped = dshHome === '' ? '' : join(dshHome, 'teamkit', 'roles')
      if (shipped === '' || !existsSync(shipped)) {
        UNV('H53', '**发货态**（真机 `$DSH_HOME/teamkit/roles`）也有职责字段',
          shipped === ''
            ? '`DSH_HOME` 未设置 ⇒ **未获取**（不判红：CI / 干净环境正常如此）'
            : `真机角色档目录不存在（${shipped}）⇒ **未获取**（还没装 ⇒ 不是"装了却不对"）`)
      } else {
        const srcDir = join(PLUGIN_DIR, 'assets', 'roles')
        const bad = []
        let checked = 0
        const srcJson = (() => {
          try { return readdirSync(srcDir).filter((f) => f.endsWith('.json') && f !== 'INDEX.json') } catch { return [] }
        })()
        for (const f of srcJson) {
          const sp = join(shipped, f)
          if (!existsSync(sp)) { bad.push(`${f}: 发货目录里没有`); continue }
          let sj = null
          let tj = null
          try { sj = JSON.parse(readFileSync(join(srcDir, f), 'utf8')) } catch { continue }
          try { tj = JSON.parse(readFileSync(sp, 'utf8')) } catch { bad.push(`${f}: 读不了/不是 JSON`); continue }
          const sd = Array.isArray(sj.duties) ? sj.duties.length : 0
          const sb = Array.isArray(sj.boundaries) ? sj.boundaries.length : 0
          const td = Array.isArray(tj.duties) ? tj.duties.length : 0
          const tb = Array.isArray(tj.boundaries) ? tj.boundaries.length : 0
          checked += 1
          if (td === 0 || tb === 0) bad.push(`${f}: 发货态 duties=${td} boundaries=${tb}（**旧版**）`)
          else if (td !== sd || tb !== sb) bad.push(`${f}: 发货态(${td}/${tb}) ≠ 源(${sd}/${sb})`)
        }
        if (existsSync(join(srcDir, 'director.json')) && !existsSync(join(shipped, 'director.json'))) {
          bad.push('`director.json`：**源里有、发货态没有**（新增档没发出去）')
        }
        CHECK('H53', bad.length === 0,
          `**发货态**（真机 \`$DSH_HOME/teamkit/roles\`）与源一致：核对 ${checked} 份，每份都有两字段 + \`director.json\` 在`,
          '★ **仓内齐了但用户机器上没有** ⇒ "装好了却没职责"（本断言前两条只验仓内 ⇒ **这就是那个洞**）：' + bad.slice(0, 3).join(' | '),
          bad.length === 0 ? `${checked} 份与源一致` : bad.slice(0, 3).join(' ; '))
      }
    }
  }

  // ── H54 · ★★ **"只读意图"的旗标必须真只读**（2026-09-15 / CEO 要求"别只修，要让它有断言"）──
  // 【为什么要有它】`docs-writer` 实测：`node plugin/scripts/gen-roles.mjs --help`
  //   ⇒ **重写了 8 个 `roles/*.json` 的 mtime**（内容幂等 ⇒ sha 不变，所以**一直没被发现**）。
  //   ⇒ `plugin-smith` 已修（`main()` 第一支：`--help`/`--dry-run` 都不写盘）。
  //   ★ 但 CEO 的要求是：**"别只修，要让它有断言"** ——
  //     否则**下一个人会再引入**（本项目反复栽：修好一处、没有机制、下次又犯）。
  // 【判据】**真跑** `--help` 与 `--dry-run` ⇒ 8 个角色档的 **mtime 与 sha256 都必须不变**。
  //   ⚠️ 用 **mtime**（不只是 sha）—— 因为那个 bug 的形态正是"**内容不变但文件被重写**"。
  //   ⚠️ 本断言**只读**（跑子进程 + 比对），**不改任何产品文件**（`R38`：要证明"会红"也不许改产品文件）。
  // 【三态】`R24`：跑不起来（脚本不存在/超时）⇒ **未验证**（不判红、也不判绿）。
  {
    const gen = join(PLUGIN_DIR, 'scripts', 'gen-roles.mjs')
    const rolesSrc = join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles')
    // ⚠️ `createHash` / `execFileSync` **不在本文件顶层 import 里** ⇒ 按本文件的既有写法**局部导入**
    //   （`:3829` 就是这么写的：`const { createHash } = await import('node:crypto')`）
    const { createHash } = await import('node:crypto')
    const { execFileSync } = await import('node:child_process')
    if (!existsSync(gen)) {
      UNV('H54', '`gen-roles.mjs` 的"只读旗标真只读"', '脚本不存在 ⇒ 未获取')
    } else {
      const snap = () => {
        const out = new Map()
        try {
          for (const f of readdirSync(rolesSrc)) {
            if (!f.endsWith('.json')) continue
            const p = join(rolesSrc, f)
            const st = statSync(p)
            out.set(f, { mtime: st.mtimeMs, sha: createHash('sha256').update(readFileSync(p)).digest('hex') })
          }
        } catch { /* 目录读不到 ⇒ 空表 ⇒ 下面会判未获取 */ }
        return out
      }
      const runGen = (flag) => {
        try {
          execFileSync(process.execPath, [gen, flag], { cwd: PLUGIN_DIR, encoding: 'utf8', windowsHide: true, timeout: 120000 })
          return true
        } catch {
          return false
        }
      }
      const before = snap()
      if (before.size === 0) {
        UNV('H54', '`gen-roles.mjs` 的"只读旗标真只读"', `读不到角色档目录 ${rolesSrc} ⇒ 未获取`)
      } else {
        const okHelp = runGen('--help')
        const afterHelp = snap()
        const okDry = runGen('--dry-run')
        const afterDry = snap()
        const changed = []
        for (const flag of [['--help', afterHelp], ['--dry-run', afterDry]]) {
          const [name, after] = flag
          for (const [f, b] of before) {
            const a = after.get(f)
            if (a === undefined) { changed.push(`${name}: ${f} 消失了`); continue }
            if (a.sha !== b.sha) changed.push(`${name}: ${f} **内容变了**`)
            else if (a.mtime !== b.mtime) changed.push(`${name}: ${f} **被重写（mtime 变了）**`)
          }
        }
        const executable = okHelp && okDry
        CHECK('H54', executable && changed.length === 0,
          '★★ **"只读意图"的旗标真只读**：`gen-roles --help` / `--dry-run` 跑完 ⇒ 8 份角色档 **mtime 与 sha 都不变**',
          '★ "只读旗标会写盘"= 用户以为只是看看，实际改了文件（`LANDMINES §7`）；' +
            (executable ? '' : '（子进程跑不起来 ⇒ 判据不成立）') +
            (changed.length > 0 ? `实测变化：${changed.slice(0, 3).join(' | ')}` : ''),
          executable
            ? (changed.length === 0 ? `${before.size} 份日志档 mtime/sha 全程不变 ✓` : changed.slice(0, 3).join(' ; '))
            : 'gen-roles 跑不起来')
      }
    }
  }

  // ── H55 · ★★★ **每个 `case` 都必须在 `--help` 里列出来**（2026-09-15 / CEO 抓到的洞）──────
  // 【为什么要有它】CEO 实测：`--help` 只列 9 个命令，而源码里 `orphans` / `resume` / `wake` / `verify-route`
  //   **四个 case 一个都没列** —— 而 **`resume` 正是委托方那句**
  //   「**重启之后就没法续接上之前的任务了**」的**交付物**。
  //   ⇒ ★★ **能力有、发现不了** ⇒ 用户敲 `--help` 会**以为没做**。
  // 【这一族的第五个现场】（CEO 归纳）：
  //   `H29`（**范围**漏类）· 夹具 45min（**时间**）· 视口 vs 坐标（**空间**）· 归因层级（进程 vs 页面）
  //   · ★ **`--help` 漏命令（入口的可发现性）** ⇒ 与 `R39`（判据必须够得到自己的前置）同族。
  // 【判据】**扫 `case '…'` ⇒ 逐个核对在 `--help` 文本里出现**
  //   ⚠️ **必须剥注释** —— `:7200` 那行注释里也写着 `case 'orphans'` 字样
  //     ⇒ ★ 那是"**引用 ≠ 本体**"（`H29` 修过的同一形态），不剥会把注释当成"已列出"⇒ **假绿**
  {
    let src = ''
    try { src = readFileSync(join(PLUGIN_DIR, 'bin', 'teamkit.mjs'), 'utf8') } catch { src = '' }
    if (src === '') {
      UNV('H55', '每个 `case` 都在 `--help` 里列出', '读不到 teamkit.mjs ⇒ 未获取')
    } else {
      // 与 `:311` / `:2503` 同形态的剥注释（**这份是自包含的**，避免跨作用域依赖）
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      const code = strip(src)
      const allCases = [...new Set([...code.matchAll(/case '([a-z][a-z0-9-]*)':/g)].map((m) => m[1]))].sort()
      // `--help` 文本：**同一份已剥注释的源码**里，从 `function help()` 到它的收尾
      const helpBody = (() => {
        const i = code.indexOf('function help()')
        if (i === -1) return ''
        return code.slice(i, i + 6000) // help 页足够长的窗口
      })()
      const missing = allCases.filter((c) => !new RegExp(`teamkit ${c}\\b`).test(helpBody))
      CHECK('H55', missing.length === 0,
        `★★ **每个命令都在 \`--help\` 里列出来了**（扫到 ${allCases.length} 个 \`case\`，逐个核对）`,
        '★ **能力有、发现不了** ⇒ 用户敲 `--help` 会以为没做（`resume` 正是委托方"重启后接不上"的交付物）：' +
          `没列出：${missing.join(' / ')}`,
        missing.length === 0 ? `${allCases.length} 个命令全部可见 ✓` : `**漏列 ${missing.length} 个：${missing.join(' / ')}**`)

      // ★★ **反向判据**（CEO §④③ 要求）：`--help` 里出现的命令 ⇒ **必须真有那个 `case`**
      // ```
      // 【为什么要反向】只有正向（"每个 case 都列出了"）⇒ 无法防"**写了一个不存在的命令**"：
      //   用户照着敲 ⇒ `teamkit <那个命令>` ⇒ 落到未知子命令分支 ⇒ **他以为文档骗人**
      //   ⇒ 而正向判据**照样绿**（因为"help 里的命令"不在 `allCases` 里，不在比对范围内）。
      // 【实测这条判据有真现场吗】有：本项目早先出现过"文档写了实现没有"
      //   （`H25` 的注释逐字："文档写了实现没有 ⇒ 用户照着敲直接报 unknown command"）。
      // ⚠️ **剥注释**已在上面的 `code` 里做过 ⇒ 此处用同一份 `helpBody`。
      // ⚠️ **别名不算**（`help`/`version` 是 `case` 本身）· **参数行不以 `teamkit xx` 开头的不算**
      //   ⇒ 只取形如 `teamkit <name>` 的行首命令名。
      // ```
      const helpCmds = [...new Set([...helpBody.matchAll(/^\s*teamkit ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]))].sort()
      const phantom = helpCmds.filter((c) => !allCases.includes(c))
      CHECK('H55', phantom.length === 0,
        `★★ **反向**：\`--help\` 里写出的 ${helpCmds.length} 个命令，**每个都真有对应 \`case\`**（防"写了不存在的命令"）`,
        '★ **文档写了实现没有** ⇒ 用户照着敲会报 `unknown command`（`H25` 记过同一形态）' +
          `不存在的命令：${phantom.join(' / ')}`,
        phantom.length === 0 ? `${helpCmds.length} 个命令全部存在 ✓` : `**${phantom.length} 个命令不存在：${phantom.join(' / ')}**`)
    }
  }
}

  // ── H4 · **资产真的进包**（2026-09-14 实测的分发缺口）──────────────────────
  // 背景：`files` 只含 `lib/bin/scripts/patches/skills/…` ⇒ `npm pack` 出的 tgz 里
  // **没有** 预设（`omc` 的入口）、角色档（公司层的"人"）、talents、组织层、**以及安装器本身**
  // ⇒ **开源用户装上插件，拿不到"开公司"的任何资产**（实证：25 个文件里 0 个是这些）。
  // ⇒ 这一组把"资产进得了包"变成机械判据（**不跑 npm，只看白名单 + 包内副本是否齐**）。
  {
    const need = ['assets', 'tools']
    const wlOk = need.every((k) => Array.isArray(pkg.files) && pkg.files.includes(k))
    CHECK('H4', wlOk,
      '`files` 白名单包含 `assets` 与 `tools`（否则 tgz 里没有预设/角色档/组织层/安装器）',
      '资产不进包 ⇒ 用户装了插件却拿不到任何"开公司"的东西', `files=${JSON.stringify(pkg.files ?? [])}`)
    // 包内副本必须齐（由 `scripts/sync-assets.mjs` 从仓内同步）
    const assetsNeed = [
      ['预设入口', join(PLUGIN_DIR, 'assets', 'presets', 'omc', 'agent.cordis.yml')],
      ['角色档', join(PLUGIN_DIR, 'assets', 'roles', 'engineer.json')],
      ['角色技能', join(PLUGIN_DIR, 'assets', 'roles', 'engineer', 'skills')],
      ['talents', join(PLUGIN_DIR, 'assets', 'talents', 'engineer.md')],
      ['原则（自演化位）', join(PLUGIN_DIR, 'assets', 'talents', 'principles', 'README.md')],
      ['组织层', join(PLUGIN_DIR, 'assets', 'org', 'TALENTS.yml')],
      ['安装器', join(PLUGIN_DIR, 'tools', 'install-teamkit.mjs')],
    ]
    const missingA = assetsNeed.filter(([, p]) => !existsSync(p)).map(([n]) => n)
    CHECK('H4', missingA.length === 0,
      '包内资产**齐**（预设入口 / 角色档 / 角色技能 / talents / 原则 / 组织层 / 安装器）',
      '包内缺资产 ⇒ tgz 里也缺 ⇒ 用户装不上；补法：`node scripts/sync-assets.mjs`',
      missingA.length === 0 ? `${assetsNeed.length} 项齐` : `缺: ${missingA.join(',')}`)
    // 角色技能**非空**（"有 provider 没内容"那一类，G5 已治仓内；这里治包内副本）
    // ⚠️ **判据是"有 SKILL.md 文件"，不是"目录存在"** ——
    //    我第一版判 `readdirSync(...).length > 0`（子目录数），变异测试发现：
    //    **把技能子目录移走后断言仍绿**（目录还在、只是空了）⇒ 判据不够严。
    const roleSkillsCount = (() => {
      try {
        const d = join(PLUGIN_DIR, 'assets', 'roles', 'engineer', 'skills')
        let n = 0
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(d, e.name, 'SKILL.md'))) n += 1
        }
        return n
      } catch { return 0 }
    })()
    CHECK('H4', roleSkillsCount > 0,
      `包内**角色技能真的有 SKILL.md**（engineer 有 ${roleSkillsCount} 条）—— 不是"空的 skills 目录"`,
      '包内角色技能目录里没有 SKILL.md ⇒ 用户拿到的是"有身份没技能"（判"目录存在"是不够的）')
  }

  // ── H5 · ★ **"实测换来的规则"不许被静默改掉**（2026-09-14 / Round 24）────────────
  // 【为什么要有这条】本项目的 skill 里有几条是**真事故换来的**，改一个字就等于把教训抹掉：
  //   · `teamkit-a2a` 的「**派活时绝对不要自己拼路径**」—— 来自 Round 23 的真事故：
  //     Lead 在派活指令里写了**仓内相对路径**，成员照做 ⇒ **内容对、位置错、下一个同岗位的人读不到**。
  //   · `teamkit-review` 的「**手动巡检表**」—— 来自 Round 20：原文承诺的"巡检告警"**根本不存在**。
  //   ⇒ 这几条如果被哪次重写弄丢，**不会有任何红**（skill 正文没有断言盯着）。
  // 【判据】源（仓根 `skills/`）与**包内副本**（`plugin/skills/`）都含有这些关键句；
  //   **并且两边逐字节一致**（单一事实来源，由 `sync-skills` 保证）。
  {
    const KEY_RULES = [
      { file: join(PLUGIN_DIR, '..', 'skills', 'teamkit-a2a', 'SKILL.md'), must: ['绝对不要自己拼路径', '位置错的东西比没写更糟'] },
      { file: join(PLUGIN_DIR, '..', 'skills', 'teamkit-review', 'SKILL.md'), must: ['手动巡检表', '别把"有巡检告警"当成已经有了'] },
    ]
    for (const { file, must } of KEY_RULES) {
      const name = file.split(/[\\/]/).slice(-2)[0]
      let txt = ''
      try { txt = readFileSync(file, 'utf8') } catch { txt = '' }
      const missing = must.filter((m) => !txt.includes(m))
      CHECK('H5', txt !== '' && missing.length === 0,
        `★ **\`${name}\` 里"实测换来的规则"还在**（${must.length} 条关键句一条不缺）`,
        '真事故换来的规则被静默改掉 ⇒ 下一个照做的人会重犯同一个错',
        missing.length === 0 ? `${must.length} 条齐` : `缺: ${missing.join(' / ')}`)
    }
  }

  // ── H6 · ★ **团队 SOP 的"交付形态声明"不许过期**（2026-09-14 / Round 25）─────────
  // 【为什么】`AGENTS.md` 是**每个新成员读的第一份文件**（本仓的团队 SOP）。
  //   本轮实测它当时写着三条**与事实相反**的话：
  //     「`exp/**` 下那些**都是实验件、别人装不了、路径还写死 `D:/dsh/omc-agent-teams/...`**」
  //   而实测：插件已收敛（`plugin/`）、能装（真 tgz 端到端 15/0）、**零硬编码路径（0 处）**。
  //   ⇒ **新成员照那份 SOP 读，会以为"正解还不存在"**（同族 Round 20 那条"指向不存在之物的承诺"，
  //     方向相反 —— 这次是"**已有之物被写成不存在**"）。
  // 【判据】① SOP 的"先读顺序"里**必须**出现交付物本体（`plugin/README.md`）；
  //   ② SOP 里**不许**再出现那两条已被实测推翻的声明；③ SOP 引用的命令入口**真的存在**。
  //   ⚠️ 只查"会不会误导人"的关键句，**不查全文**（否则每句话都要维护，反而没人敢改）。
  {
    const sop = join(PLUGIN_DIR, '..', 'AGENTS.md')
    let txt = ''
    try { txt = readFileSync(sop, 'utf8') } catch { txt = '' }
    // ⚠️ **必须判"它在先读顺序那一段里"**，不能只判"全文含这个字符串" ——
    //    我第一版只查 `includes('plugin/README.md')`，而它在文档**别处**也出现过 ⇒
    //    **把先读顺序里那条换掉，断言照样绿**（变异测试发现的）。
    const readOrder = (() => {
      const m = /##\s*先读顺序[\s\S]*?(?=\n##\s)/.exec(txt)
      return m ? m[0] : ''
    })()
    CHECK('H6', readOrder !== '' && readOrder.includes('plugin/README.md'),
      '★ **团队 SOP（`AGENTS.md`）的"先读顺序"那一段里有交付物本体**（`plugin/README.md`）',
      '新成员按 SOP 读却读不到"正解在哪" ⇒ 会以为正解还不存在（只判"全文含"是不够的）',
      readOrder === '' ? '(找不到"先读顺序"那一段)' : `该段含 plugin/README.md=${readOrder.includes('plugin/README.md')}`)
    const stale = ['别人装不了', '路径还写死 `D:/dsh/omc-agent-teams']
    const staleHit = stale.filter((s) => txt.includes(s))
    CHECK('H6', staleHit.length === 0,
      '★ SOP 里**没有**已被实测推翻的声明（"别人装不了" / "路径写死"）',
      'SOP 说"装不了"而实测能装 ⇒ 读者会放弃已有的正解（"已有之物被写成不存在"）',
      staleHit.length === 0 ? '0 处' : `命中: ${staleHit.join(' / ')}`)
    const cmds = ['plugin/bin/teamkit.mjs', 'plugin/scripts/e2e-tarball.mjs',
      'plugin/tools/install-teamkit.mjs', 'tools/promote-upstream.mjs']
    const missing2 = cmds.filter((c) => !txt.includes(c))
    CHECK('H6', missing2.length === 0,
      '★ SOP 里写的命令入口**真的在**（不留死命令）',
      'SOP 引用了不存在的入口 ⇒ 新成员照着跑会直接失败',
      missing2.length === 0 ? `${cmds.length} 个入口齐` : `缺: ${missing2.join(' / ')}`)
  }

  // ── H7 · ★ **"证据/探针"不许被分发成"人"**（2026-09-14 / Round 26 修的真 bug）──
  // 【缺陷】仓里 `runs/005-role-skills/roles/A/` 是 **task-32 的探索证据**
  //   （`role-probe-a` 作用域探针；`COMPANY-LAYER.md §H` 记过它被误删后逐字还原；`REPORT.md:43` 引用），
  //   它**没有 `A.json`**（不是"人"）—— 但它此前**被同步进包、又被安装器装给每个用户**
  //   ⇒ 用户拿到一个**没有岗位档案、却带一条技能的"幽灵角色"**。
  // 【判据】① **包内副本**里，每个 `assets/roles/<x>/` 都必须有同名 `<x>.json`；
  //        ② 仓里那份证据 `A/` **仍然存在**（不许"修 bug 时把证据删了" —— 它被文档引用）。
  {
    const assetsRoles = join(PLUGIN_DIR, 'assets', 'roles')
    let ghosts = []
    try {
      for (const e of readdirSync(assetsRoles, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        if (!existsSync(join(assetsRoles, `${e.name}.json`))) ghosts.push(e.name)
      }
    } catch { ghosts = ['(读不到 assets/roles)'] }
    CHECK('H7', ghosts.length === 0,
      '★ **包内没有"幽灵角色"**（每个 `assets/roles/<x>/` 都有同名 `<x>.json` 岗位档案）',
      '没有角色档却带技能的目录会被装给用户 ⇒ 一个"看得见、没岗位、删不掉"的幽灵',
      ghosts.length === 0 ? '0 个幽灵' : `幽灵: ${ghosts.join(', ')}`)
    CHECK('H7', existsSync(join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'roles', 'A', 'skills', 'role-probe-a', 'SKILL.md')),
      '★ **证据仍在仓里**（`roles/A/…/role-probe-a/SKILL.md`）—— 修分发时不删证据',
      '把证据删了 ⇒ `REPORT.md:43` / `A-LAYER-AUTHORITY.md` 的引用变成死链（同族：删之前先 grep 引用）')
  }

  // ── H8 · ★ **面向用户的文档不许写死"会漂的数字"**（2026-09-14 / Round 27）──────────
  // 【缺陷】`plugin/README.md`（**用户装完唯一会读的那份**）原来写着：
  //     「当前读数：判定：UNVERIFIED（**90 通过** / 0 失败 / 6 未验证）」
  //   而**同一天实测已是 153 通过** —— 断言数每轮都在加，**写死的数字必然过期**。
  //   危害：用户跑出 153 会以为"是不是我装坏了"；或反过来，看到 90 以为一切正常。
  // 【修法】README 里改成**"自己跑一下"** + **判据是退出码/三态，不是数字**。
  // 【本组判据】`plugin/README.md` 里**不许出现**"`<数字>` 通过"这种会漂的写法
  //   （历史台账 `runs/**` 里可以有 —— **那些是某轮的历史读数，本来就该保持原样**）。
  //   ⚠️ 只查**面向用户的那份**（`plugin/README.md`），不查台账。
  {
    const readme = join(PLUGIN_DIR, 'README.md')
    let rm = ''
    try { rm = readFileSync(readme, 'utf8') } catch { rm = '' }
    // ⚠️ **只查"当读数报出来的"那种写法**（整行就是「… N 通过 …」的断言），
    //    不查"解释里引用历史数字"（我这次更正时就引用了「原来写着 90 / 现在 153」——
    //    那是**说明这段历史**，不是**当读数报**）。我第一版扫全文 ⇒ **假红**（自测抓到的）。
    const drift = rm.split('\n')
      .filter((l) => /^\s*>?\s*判定：/.test(l) || /^\s*\|?\s*\d+\s*通过\s*\/\s*\d+\s*失败\s*\|?\s*$/.test(l))
      .filter((l) => /\d+\s*通过/.test(l))
      .map((l) => l.trim().slice(0, 60))
    CHECK('H8', rm !== '' && drift.length === 0,
      '★ **用户文档（`plugin/README.md`）里没有"当读数报出来的"通过数**（那种数字必然随每轮漂）',
      '写死数字 ⇒ 用户跑出别的数会以为装坏了（或以为一切正常）；判据应是**退出码 + 三态**',
      drift.length === 0 ? '0 处' : `命中: ${drift.join(' / ')}`)
    CHECK('H8', rm.includes('selftest') && /退出码|三态/.test(rm),
      '★ 且它给出了**不会漂的判据**（跑 `selftest` + 解释退出码/三态）',
      '只有数字、没有判据 ⇒ 读者无从判断"我自己这次算不算正常"')
  }

  // ── H9 · ★ **"其它 preset 不受影响"必须能机械验**（2026-09-14 / Round 28）──────────
  // 交付方最原始那句要求：「**我用这个 present 代表了这个项目…其它的 present 不会受到影响。**」
  //   我之前只在**组件层**验过（闸门 / `SKIP-FOREIGN-PRESET` / 角色装配只装同预设），
  //   这轮补了**装配结果**的读数（新建 `omc` 会话 ⇒ 它的 `system/message` 含公司口径；
  //   我自己的 `standard` 会话 ⇒ 系统提示词里一个字都没有）。
  // 【本组判据】把"隔离"钉成**不依赖宿主**的机械判据：
  //   ① **本包分发的 `omc` 预设**里**必须有**公司口径（`You run as a company` 等）——
  //      否则用户选了 `omc` 也拿不到"开公司"的框架；
  //   ② **shipped 的 `standard`**（官方那份）里**不许有**这些字符串 ——
  //      否则"其它预设不受影响"从源头上就不成立。
  //   ⚠️ ②要能"读不到就 UNVERIFIED"（shipped 预设的位置随安装方式变，**不许猜**）。
  {
    const omcPreset = join(PLUGIN_DIR, 'assets', 'presets', 'omc', 'agent.cordis.yml')
    let omcTxt = ''
    try { omcTxt = readFileSync(omcPreset, 'utf8') } catch { omcTxt = '' }
    const MARKS = ['You run as a company', 'upstream is your senior']
    const missA = MARKS.filter((m) => !omcTxt.includes(m))
    CHECK('H9', omcTxt !== '' && missA.length === 0,
      '★ **本包的 `omc` 预设带公司口径**（"You run as a company" / "upstream is your senior"）',
      '选了 omc 却拿不到"开公司"的框架 ⇒ 交付方最原始那句要求没落地',
      missA.length === 0 ? '2 条口径齐' : `缺: ${missA.join(' / ')}`)
    const shippedStd = (() => {
      const cands = [
        process.env.DSH_BUNDLED_PRESET_DIR ? join(process.env.DSH_BUNDLED_PRESET_DIR, 'standard', 'agent.cordis.yml') : undefined,
        join(PLUGIN_DIR, '..', '..', '..', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
      ].filter(Boolean)
      for (const c of cands) if (existsSync(c)) return c
      return undefined
    })()
    if (shippedStd === undefined) {
      UNV('H9', '★ shipped `standard` 里没有公司口径（**拿不到官方预设文件 ⇒ 未验证**）',
        '要拿到读数：设 `DSH_BUNDLED_PRESET_DIR` 指向 `@deepseek-ai/dsh-agent-presets/presets`')
    } else {
      let stdTxt = ''
      try { stdTxt = readFileSync(shippedStd, 'utf8') } catch { stdTxt = '' }
      const leak = MARKS.filter((m) => stdTxt.includes(m))
      CHECK('H9', stdTxt !== '' && leak.length === 0,
        '★ **shipped `standard` 里没有公司口径** ⇒ 「其它 preset 不受影响」在源头上成立',
        '官方 standard 里混进了公司口径 ⇒ 没选 omc 的用户也会被影响（违反交付方明令）',
        leak.length === 0 ? '0 处泄漏' : `泄漏: ${leak.join(' / ')}`)
    }
  }

  // ── H10 · ★ **"未验证"必须有一份可审计的状态台账**（2026-09-14 / Round 29）──────────
  // 【缺口】`selftest` 永远报 6 条 UNVERIFIED（**故意** —— 沙盒里测不了）。
  //   但那 6 条**后来有一半我用真宿主补验过了**，而**自测看不出来、台账里也散在各轮**
  //   ⇒ **读者分不清"真没验"与"验了但没记"**。
  // 【本组判据】① `runs/005-role-skills/UNVERIFIED-LEDGER.md` **存在**；
  //   ② 它有**三列口径**（是什么 / 有没有真读数 / 读数在哪）—— 用关键词代替列名检查；
  //   ③ **用户手册（`plugin/README.md`）指向它**（否则用户永远看不到）。
  //   ⚠️ 只查"这份台账还在不在、用户能不能找到"，**不查内容对不对**（那是人审的事）。
  {
    const ledger = join(PLUGIN_DIR, '..', 'runs', '005-role-skills', 'UNVERIFIED-LEDGER.md')
    let lg = ''
    try { lg = readFileSync(ledger, 'utf8') } catch { lg = '' }
    CHECK('H10', lg !== '',
      '★ **"未验证"有一条可审计的状态台账**（`runs/005-role-skills/UNVERIFIED-LEDGER.md`）',
      '自测永远报 6 条 UNVERIFIED 而没人能分清"真没验"与"验了没记"')
    const need = ['已补验', '仍未验', '读数在哪']
    const missL = need.filter((m) => !lg.includes(m))
    CHECK('H10', lg !== '' && missL.length === 0,
      '★ 台账给出**三列口径**（`已补验` / `仍未验` / `读数在哪`）—— 可据以逐条审计',
      '没有口径 ⇒ 读者还是分不清状态', missL.length === 0 ? '3 列齐' : `缺: ${missL.join(' / ')}`)
    let rm10 = ''
    try { rm10 = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8') } catch { rm10 = '' }
    CHECK('H10', rm10.includes('UNVERIFIED-LEDGER.md'),
      '★ **用户手册指向那份台账**（否则用户看不到"那几条到底什么状态"）',
      'README 只说"有未验证"、不指路 ⇒ 用户无从判断自己该不该担心')
    // ⚠️ **只有台账**（单一事实来源）：README 里**不许**再抄一份"已补验 N 条"的计数 ——
    //    我 Round 29 抄了「3 条已补验」，Round 30 台账变成 4 条 ⇒ **README 当场过期**（自测抓到的）。
    //    与 Round 27 的"通过数"同族：**会漂的数字不许出现在用户手册里**。
    const dupCount = [...rm10.matchAll(/\d+\s*条(?:已[^，。\n]{0,8})?补验/g)].map((m) => m[0])
    CHECK('H10', dupCount.length === 0,
      '★ 用户手册里**不抄**"已补验 N 条"这类计数（会随每轮漂；以台账为单一事实来源）',
      '手册抄了一份会漂的计数 ⇒ 台账更新后手册立刻过期（Round 27 的"写死通过数"同族）',
      dupCount.length === 0 ? '0 处' : `命中: ${dupCount.join(' / ')}`)
    // ★ **同一判据也要罩住 `AGENTS.md`**（它是"先读顺序"里第 2 号文件，同样是面向读者的手册）。
    //   Round 32 实测：它写着「当前 **148 通过**」而真值是 **162** —— 与 README 那次同族。
    let ag = ''
    try { ag = readFileSync(join(PLUGIN_DIR, '..', 'AGENTS.md'), 'utf8') } catch { ag = '' }
    const agCount = [...ag.matchAll(/(?:当前|实测)\s*\*{0,2}\d+\s*通过/g)].map((m) => m[0])
    CHECK('H10', ag === '' || agCount.length === 0,
      '★ **`AGENTS.md` 里也不写死"当前 N 通过"**（会随每轮漂）',
      'SOP 里写死通过数 ⇒ 下一轮就过期（Round 27/32 同族）',
      agCount.length === 0 ? '0 处' : `命中: ${agCount.join(' / ')}`)
  }

  // ── H11 · ★ **shipped 代码里不许留"计划态"注释**（2026-09-14 / Round 31）────────────
  // 【缺陷】`plugin/lib/fork.js` 与 `plugin/lib/config.js` 里各有一段**计划态注释**：
  //     「**本轮只改了本文件**…接缝已建、**但尚未接线**」
  //     「接线 = 那两处改成 `forkRootFor(paths, member, { agent })`」
  //     「**在接线完成前，不许声称"串台已修好"**」
  //   而**接线早已完成**（做法变了：由调用方喂 per-agent `paths`，`index.js:683`/`:727` 同源）
  //   ⇒ 这两段注释**读起来像"现在还没修"**，会误导维护者（同族：Round 25 的 SOP 过期）。
  // 【判据】shipped 代码（`lib/**` + `bin/**`）里**不许**出现"计划态"措辞：
  //   `本应改成` / `尚未接线` / `接缝已建、但尚未接线` / `等 task-N 让出`。
  //   ⚠️ **只查"别处的计划"**，不查"我这里的 TODO"（后者可以存在，只要**当场可判**）。
  //     本组扫的是**被点名文件 + 未完成时态**的组合 —— 那正是会过期的那一类。
  {
    const planWords = ['本应改成', '尚未接线', '接缝已建、但尚未接线', '等 task-']
    const hits = []
    for (const dir of ['lib', 'bin']) {
      let files = []
      try { files = readdirSync(join(PLUGIN_DIR, dir), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) } catch { files = [] }
      for (const f of files) {
        // ⚠️ **跳过本文件**（`bin/teamkit.mjs`）—— 它必须**写出这些词**才能检测它们（自指，必然命中）。
        if (f === 'teamkit.mjs') continue
        let t = ''
        try { t = readFileSync(join(PLUGIN_DIR, dir, f), 'utf8') } catch { continue }
        // ⚠️ **"更正段"里的引用不算**：本轮我把旧注释**原样引用**在"更正说明"里
        //    （「原文写的是…尚未接线…」）—— 那是**说明历史**，不是**声称现状**。
        //    判据：**含「更正」的那一段**不算。做法：把含"更正"的行与它后面 20 行一起剔掉再查。
        //    （第一版没剔 ⇒ **假红**，自测当场抓到的。）
        const lines = t.split('\n')
        const keep = []
        let skip = 0
        for (const ln of lines) {
          if (/【\d{4}-\d{2}-\d{2} 更正】|更正本段注释|下面是当时的/.test(ln)) skip = 22
          if (skip > 0) { skip -= 1; continue }
          keep.push(ln)
        }
        const t2 = keep.join('\n')
        for (const w of planWords) if (t2.includes(w)) hits.push(`${dir}/${f} 含「${w}」`)
      }
    }
    CHECK('H11', hits.length === 0,
      '★ **shipped 代码里没有"计划态"注释**（"本应/尚未接线/等 task-N 让出"）',
      '代码里留着"还没接线"的旧注释 ⇒ 维护者会以为缺陷还在（Round 25 的 SOP 过期同族）',
      hits.length === 0 ? '0 处' : hits.slice(0, 3).join(' / '))
  }

  // ── H3 · 本包的 bundle patch **不许**改别的插件的 config（隐藏耦合）──
  // 为什么要有这条：任务 §C 的缓解 1 说"bundle patch 可以带更宽松的 maxMembers"。
  // 我**没有**把它做成默认，而是给了一份**可选**片段（`patches/lenient-max-members.yml`），
  // 理由：那是**改别的插件**（`agent-team`）的 config，而 patch 的覆盖语义是
  // **按顶层键赋值、不是深合并**（LANDMINES §14.2）⇒ 一旦 `agent-team` 的 schema 变了，
  // 我们那份 patch 会**静默地把它的整个 config 换掉**。而且"名额给多少"是**用户的成本决策**。
  // ⇒ 这条断言把"我们没偷偷改别人"变成一个**机械判据**。
  const ownPatch = readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8')
  const ownPatchCode = ownPatch.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  const touchesOthers = /^\s*- id:\s*(?!dsh-teamkit)\S/m.test(ownPatchCode)
    || /agent-team/.test(ownPatchCode)
  CHECK('H3', !touchesOthers,
    '本包自带的 `cordis.patch.yml` **只插入自己那一行**，不改任何别的插件的 config（无隐藏耦合）',
    '自带的 patch 动了别的插件 ⇒ 会把别人的 config 整个换掉（LANDMINES §14.2）',
    `patch 里的非注释行数=${ownPatchCode.split('\n').filter((l) => l.trim() !== '').length}`)
  const optPatch = join(PLUGIN_DIR, 'patches', 'lenient-max-members.yml')
  const optExists = existsSync(optPatch)
  const optIsNotWired = optExists && !new RegExp(basename(optPatch).replace(/\./g, '\\.')).test(ownPatch)
  CHECK('H3', optIsNotWired,
    '可选的 `patches/lenient-max-members.yml` **存在但没被自动挂上**（用户要自己粘）',
    '可选补丁被自动挂上了 ⇒ 我们就替用户做了成本决策',
    optExists ? '存在且未被 cordis.patch.yml 引用' : '（文件不存在）')

  // ── 单一事实来源：包内 skills/ 必须与仓内 skills/ 逐字节一致（"别两边各写一份"）──
  const repoSkills = resolve(PLUGIN_DIR, '..', 'skills')
  if (!existsSync(repoSkills)) {
    // 用户从 tgz 装的场景：**没有仓内 skills/** —— 这不是失败（包内那份就是唯一一份）
    OK('H', '`同步源（仓内 skills/）不在场 ⇒ 包内 skills/ 是唯一一份（tgz 安装场景，正常）`',
      `包内 ${readdirSync(join(PLUGIN_DIR, 'skills')).filter((d) => !d.startsWith('.')).length} 条`)
  } else {
    const a = readdirSync(repoSkills).filter((d) => !d.startsWith('.') && existsSync(join(repoSkills, d, 'SKILL.md'))).sort()
    const b = existsSync(join(PLUGIN_DIR, 'skills'))
      ? readdirSync(join(PLUGIN_DIR, 'skills')).filter((d) => !d.startsWith('.') && existsSync(join(PLUGIN_DIR, 'skills', d, 'SKILL.md'))).sort()
      : []
    const drift = []
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`条目不同：仓=[${a.join(',')}] 包=[${b.join(',')}]`)
    for (const n of a) {
      if (!b.includes(n)) continue
      const ta = readFileSync(join(repoSkills, n, 'SKILL.md'), 'utf8')
      const tb = readFileSync(join(PLUGIN_DIR, 'skills', n, 'SKILL.md'), 'utf8')
      if (ta !== tb) drift.push(`${n} 内容不一致`)
    }
    CHECK('H', drift.length === 0,
      `**单一事实来源**：包内 skills/ 与仓内 skills/ 逐字节一致（${a.length} 条）—— 跑 \`npm run sync-skills\` 修`,
      '两边漂移了 ⇒ 维护者改了仓内那份、忘了同步进包（"别两边各写一份"的反例）', drift.join(' | ') || '0 处漂移')

    // ── H28 · ★★ **"上游根那份"与"仓内那份"也要一致**（2026-09-14 / Round 68）────────
    // 【为什么单列】`H` 组盯的是**仓 ↔ 包**；但**模型真正读到的是"上游根"那份**
    //   （`dsh-skill-filesystem` 扫的 `$DSH_HOME/teamkit/skills-upstream`）。
    //   R47 那次事故正是这一环：我把技能从 39 行改到 80 行、**仓与包都同步了**，
    //   而上游根那份**仍是 39 行** ⇒ **模型读到旧版，且没有任何报错**。
    //   ⇒ "三份副本"（仓 / 包 / 上游根）里，**前两个有断言、第三个没有** —— 这就是缺口。
    // ⚠️ **沙盒里的自测不能读真 `DSH_HOME`**（`selftest` 默认把 `DSH_HOME` 指向 tmp）⇒
    //   这里用**运行者的真实 `DSH_HOME`**（`process.env.DSH_HOME` 若被临时改过，就明说"未验证"，不猜）。
    {
      const realHome = process.env.DSH_HOME ?? ''
      const upstreamRoot = realHome === '' ? '' : join(realHome, 'teamkit', 'skills-upstream')
      if (upstreamRoot === '' || !existsSync(upstreamRoot)) {
        CHECK('H28', null,
          '上游根与仓内一致',
          '**未验证**：这一跑没拿到真实 `DSH_HOME` 或上游根还不存在（安装器没跑过）—— 不猜、不假装',
          upstreamRoot === '' ? '`$DSH_HOME` 为空' : `上游根不存在：${upstreamRoot}`)
      } else {
        const stale = []
        for (const n of a) {
          const up = join(upstreamRoot, n, 'SKILL.md')
          if (!existsSync(up)) {
            stale.push(`${n}（上游根没有）`)
            continue
          }
          if (readFileSync(join(repoSkills, n, 'SKILL.md'), 'utf8') !== readFileSync(up, 'utf8')) stale.push(`${n} 内容旧了`)
        }
        CHECK('H28', stale.length === 0,
          '★★ **"模型真正读到的那份"（上游根）与仓内逐字节一致**',
          '不同步 ⇒ **模型读旧版而没有任何报错**（R47 实测：我改了技能，模型仍读到 39 行的旧版）',
          stale.length === 0 ? `${a.length} 条一致 ✓` : stale.join(' | '))
      }
    }

    // H2 · `sync-skills.mjs --check` 自己的三态（源读不到 ⇒ 2，不是 1；漂移 ⇒ 1）
    //   ⚠️ 在**临时副本**里跑，绝不碰真包（否则会把漂移写进交付物）
    const tmpPlugin = join(sb.base, 'syncprobe', 'plugin')
    mkdirSync(join(tmpPlugin, 'scripts'), { recursive: true })
    mkdirSync(join(tmpPlugin, 'skills'), { recursive: true })
    writeFileSync(join(tmpPlugin, 'package.json'), '{"name":"syncprobe"}\n', 'utf8')
    // 直接读源脚本文本再写一份（避免复制时被别的规则影响）
    writeFileSync(join(tmpPlugin, 'scripts', 'sync-skills.mjs'),
      readFileSync(join(PLUGIN_DIR, 'scripts', 'sync-skills.mjs'), 'utf8'), 'utf8')
    const sync = (cwdPlugin) => {
      const r = spawnSync(process.execPath, [join(cwdPlugin, 'scripts', 'sync-skills.mjs'), '--check'], {
        stdio: 'ignore', timeout: 30_000,
      })
      return r.status ?? -1
    }
    // (a) 源目录不存在（临时副本的 `../skills` 没建）⇒ 必须是 2 = "未验证/读不到"，不是 1
    const a2 = sync(tmpPlugin)
    CHECK('H2', a2 === 2,
      '`sync-skills.mjs --check` 在**源读不到**时给**退出码 2**（读不到 ≠ 没有 —— 与 selftest 同一套三态）',
      '源读不到被当成"漂移/失败"（退出码 1）⇒ 假阴性', `退出码 ${a2}（期望 2）`)
    // (b) 源存在且与目标一致 ⇒ 0
    writeSkill(join(tmpPlugin, '..', 'skills', 'sync-probe'), 'sync-probe')
    writeSkill(join(tmpPlugin, 'skills', 'sync-probe'), 'sync-probe')
    CHECK('H2', sync(tmpPlugin) === 0,
      '`sync-skills.mjs --check` 两边一致时给**退出码 0（PASS）**', '一致却报失败')
    // (c) 目标漂移 ⇒ 1
    writeSkill(join(tmpPlugin, 'skills', 'sync-probe'), 'sync-probe', { body: 'DRIFTED' })
    CHECK('H2', sync(tmpPlugin) === 1,
      '`sync-skills.mjs --check` 检出漂移时给**退出码 1（FAIL）**', '漂移没被检出 ⇒ 同步脚本是个空壳')
  }

  // ═══ I · UNVERIFIED：没有真 DSH 就测不了的（**不许写成 PASS**）══════════
  section('I · 未验证（没有真 DSH / 真 teammate 就测不了 —— 不许当 PASS）')
  UNV('I', '**agent-scope 的就近覆盖**（*nearest layer wins outright*）—— D2 组用的是真 '
    + '`SkillRegistry`，但两个 provider 都注册在 **global 层**（构造真 agent scope 要宿主注入）'
    + '⇒ "同名覆盖 + rank" 那条是真读数，"跨 scope 链"那半条仍是假 ctx 读数 + task-44 的既有实测',
    '要补的测法：`dev_inject_plugin` 后在一个真 teammate 上看 catalog 里同名的 provider')
  UNV('I', '`agent/created` 的**真**时机（本组用假 ctx 直接调钩子；'
    + '「赶得上第一个提示词」的判据来自 task-37/44 的实测，不是本轮复现）',
    '要补的测法：真 spawn 一个 teammate，读它第一条 request 的 catalog')
  UNV('I', '通知的**送达**（搭车形态：做完活就 idle 的 agent 永远收不到）',
    '要补的测法：给一个会 idle 的 agent 装上，改上游后等它下一步')
  UNV('I', '`dsh plugin --profile <p> add <本地路径>` 的**端到端**（本轮**没有真跑**那条命令 —— '
    + '它要写 profile 依赖，任务明令禁止；本机 `pnpm` 在 `<npm 全局目录>`）',
    '要补的测法：用户机器上照 README 的安装命令跑一次')
  UNV('I', 'guard 在真 DSH 里对 `pwsh` 等旁路的**实测绕过**（本组只断言了"文案写了绕过面" + 纯函数判定；'
    + '「pwsh 绕得过、零审计」是 P-15 的既有实测，本轮未复现）', '不阻塞：默认关')
  UNV('I', '插件在**真 `dsh web` 宿主**里被 loader 加载（本组用假 ctx 调 `apply()`；'
    + '`Config["~standard"]` 与真 `cordis.resolveConfig` 的对接是**代码强制**—— '
    + '`cordis\\lib\\index.js:955-963` 只做 validate/issues/value 三件事 —— 但没有端到端跑过）',
    '要补的测法：`dev_inject_plugin` 真注入一次，读日志')

  // ── 清场与判定 ────────────────────────────────────────────────────────
  const shasBefore = readFileSync(join(cpaths.upstream.root, 'demo', 'SKILL.md'), 'utf8')
  sb.cleanup()
  const cleaned = !existsSync(sb.base)
  if (has('--keep')) OK('Z', '沙盒保留（--keep）', sb.base)
  else CHECK('Z', cleaned, '跑完**清场干净**（临时沙盒已删）', '临时沙盒残留', `残留=${sb.base}`)
  // 真上游/真 profile 未碰：断言本进程 env 里没有把 DSH_HOME 改到真家目录过
  CHECK('Z', process.env.DSH_HOME !== join(sb.home),
    '进程级 `DSH_HOME` **没有被本进程改写**（沙盒只通过传参生效，真环境不受影响）',
    '本进程改了 DSH_HOME ⇒ 可能污染后续动作', `process.env.DSH_HOME=${process.env.DSH_HOME ?? '(unset)'}`)

  const verdict = report.fail > 0 ? 'FAIL' : report.unverified > 0 ? 'UNVERIFIED' : 'PASS'
  process.stdout.write('\n' + '='.repeat(70) + '\n')
  process.stdout.write(`判定：${verdict}（${report.pass} 通过 / ${report.fail} 失败 / ${report.unverified} 未验证）\n`)
  // ★★★ **SKIP 必须可见**（CEO 判据③：**不许静默跳过** —— 否则"没验"会混进"全绿"）
  if (report.skipped > 0) {
    process.stdout.write(
      `  · ★ **${report.skipped} 条仓内专有断言 ⇒ SKIP（包内布局）** —— ` +
        `它们读的是**仓根文件**（\`tools/check-all.mjs\` / \`presets/omc/…\` / \`TALENTS.yml\` 等），` +
        `在"只有本包"的处境下**必然不成立**，**不是失败**（与 \`check-all\` 的 \`repoOnly: true\` 同义）。\n`,
    )
    process.stdout.write(`     ⚠️ **它们的原文仍在**（上面逐条标了 \`-- [组]\`）⇒ **没有消失，只是不适用**。\n`)
  }
  process.stdout.write(`  · 处境：**${LAYOUT === 'package' ? '包内（只有 plugin/）' : '仓内（含仓根）'}**\n`)
  process.stdout.write(`  · FAIL 的含义：本插件自己的逻辑错了（可修）\n`)
  process.stdout.write(`  · UNVERIFIED 的含义：**没测过就不算过**，也不是失败（多是"缺真 DSH 现场"）\n`)
  if (has('--json')) {
    process.stdout.write(JSON.stringify({ verdict, ...report }, null, 2) + '\n')
  }
  process.exit(report.fail > 0 ? 1 : report.unverified > 0 ? 2 : 0)
}

function readdirSafe(dir) {
  return readdirSync(dir)
}

// ── status ────────────────────────────────────────────────────────────────
async function status() {
  const cfg = await import('../lib/config.js')
  const guard = await import('../lib/guard.js')
  const paths = cfg.resolveAll(cliOverrides(), { pluginDir: PLUGIN_DIR })
  process.stdout.write('teamkit · 当前配置解析结果（只读；不启动 DSH）\n')
  const rows = [
    ['workspace', paths.workspace],
    ['dshHome', paths.dshHome],
    ['stateDir', paths.stateDir],
    ['上游根 upstream.root', paths.upstream.root],
    ['上游额外根 extraRoots', paths.upstream.extraRoots.join(', ') || '(无)'],
    ['仓内源 upstream.sources', paths.upstream.sources.join(', ')],
    ['fork 根模板', paths.forkRootTemplate],
    ['历史快照 historyDir', paths.historyDir],
    ['CHANGELOG', paths.changelogPath],
    ['日志 logFile', paths.logFile],
    ['自带 skills 源', paths.skills.sourceDir],
  ]
  for (const [k, v] of rows) process.stdout.write(`  ${k.padEnd(26)} ${v}\n`)

  // ★★ **预设对照（2026-09-14 补的真缺口）**
  //
  // 【缺口】上面的每一行都是**默认值**（离线 CLI 不认预设）。
  //   而 `omc` 预设会把 `upstream.root` / `roles.dir` / `principles.dir` / `customSkillDirs`
  //   全部**覆盖**成 `$DSH_HOME/teamkit/...`。
  //   ⇒ 用户看 `status` 以为"上游是 `$DSH_HOME/skills`"，**而 `omc` 的成员根本不读那里**
  //     ⇒ `promote` 合到那里**不报错、也没效果**（正是我们要消灭的"静默"）。
  // 【这里做什么】若本机装了 `omc` 预设，就把预设里那几个 `!!js` 表达式的**真值**算出来并**并排显示**，
  //   不一致就显式标出来。**不猜**：表达式用与 DSH 同一套语义求值
  //   （`cordis-plugin-loader:289` `new Function("ctx","expr","with(ctx){return eval(expr)}")`）。
  const presetFile = join(paths.dshHome, '.agent-presets', 'omc', 'agent.cordis.yml')
  if (existsSync(presetFile)) {
    let raw = ''
    try { raw = readFileSync(presetFile, 'utf8') } catch { raw = '' }
    const evalJs = (expr) => {
      try {
        // eslint-disable-next-line no-new-func
        const f = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
        return String(f({ process }, expr))
      } catch (err) { return `(求值失败：${err?.message ?? err})` }
    }
    const pick = (key) => {
      // 抓 `key:` 后面第一个 `!!js <expr>`（到行尾）
      const re = new RegExp(`^\\s*${key}:\\s*!!js\\s+(.+)$`, 'm')
      const m = re.exec(raw)
      return m ? evalJs(m[1].trim()) : undefined
    }
    const presetUpstream = (() => {
      const m = /upstream:[\s\S]{0,300}?!!js\s+([^\n]+)/.exec(raw)
      return m ? evalJs(m[1].trim()) : undefined
    })()
    const presetRoles = (() => {
      const m = /roles:\s*\n\s*dir:\s*!!js\s+([^\n]+)/.exec(raw)
      return m ? evalJs(m[1].trim()) : undefined
    })()
    const presetCustom = (() => {
      const m = /customSkillDirs:\s*\n(?:\s*#[^\n]*\n)*\s*-\s*!!js\s+([^\n]+)/.exec(raw)
      return m ? evalJs(m[1].trim()) : undefined
    })()
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const disp = (p) => (p === undefined ? '(预设里没有这一项)' : String(p).replace(/\//g, '\\'))
    process.stdout.write('\n★ 本机 `omc` 预设的**真值**（上面那些默认值在 omc 下**被它覆盖**）\n')
    process.stdout.write(`  预设文件                 ${presetFile}\n`)
    // ⚠️ **只在"上面真的有一行可比"时才做对比** —— 我第一版把 `roles.dir` / `customSkillDirs`
    //    也拿去和 `undefined` 比 ⇒ 恒报"与上面不同"（**假警报**；自跑时发现）。
    //    ⇒ 现在：`upstream.root` 与上面那行比（那才是会"看错树"的那一项）；
    //       其余三项**只显示真值**，不硬编一个对比对象。
    const cmpAgainst = (label, presetVal, resolvedVal) => {
      if (presetVal === undefined) { process.stdout.write(`  ${label.padEnd(24)} ${disp(presetVal)}\n`); return }
      const same = resolvedVal !== undefined && norm(presetVal) === norm(resolvedVal)
      process.stdout.write(`  ${label.padEnd(24)} ${disp(presetVal)}${resolvedVal === undefined ? '' : same ? '  (与上面一致)' : '  ← ⚠️ **与上面不同**'}\n`)
    }
    cmpAgainst('预设 upstream.root', presetUpstream, paths.upstream.root)
    // 这两项上面**没有**对应行 ⇒ 只显示真值（不假装对比）
    if (presetRoles !== undefined) process.stdout.write(`  ${'预设 roles.dir'.padEnd(24)} ${disp(presetRoles)}  (角色档目录)\n`)
    if (presetCustom !== undefined) process.stdout.write(`  ${'预设 customSkillDirs[0]'.padEnd(24)} ${disp(presetCustom)}  (读路径)\n`)
    const mismatch = presetUpstream !== undefined && norm(presetUpstream) !== norm(paths.upstream.root)
    const customMismatch = presetUpstream !== undefined && presetCustom !== undefined
      && norm(presetUpstream) !== norm(presetCustom)
    if (customMismatch) {
      process.stdout.write('\n  ⚠️⚠️ **预设里 `upstream.root` 与 `customSkillDirs` 不一致** ⇒\n')
      process.stdout.write('      **读写不同指 ⇒ "上游更新 → 全员自动跟随"会静默失效**（本项目实测过一次）。\n')
    }
    if (mismatch) {
      process.stdout.write('\n  ⚠️ **离线 CLI 的默认上游 ≠ omc 实际用的上游** ⇒\n')
      process.stdout.write('     `teamkit promote` / `promote-upstream.mjs` **不带参数时会写到上面那个默认值**，\n')
      process.stdout.write('     而 omc 的成员**不读那里** ⇒ **合并会"报成功但没人看到"**。\n')
      process.stdout.write('     正确用法：`--upstream ' + presetUpstream + '`\n')
      process.stdout.write('               `--source <agent.cwd>/.teamkit/forks/<member>/skills`\n')
    } else if (presetUpstream !== undefined) {
      process.stdout.write('\n  OK：预设上游与离线默认一致（这一项没有"看错树"的风险）。\n')
    }
  } else {
    process.stdout.write('\n（本机没有 `omc` 预设 ⇒ 上面这些就是真值；装了预设后这里会并排显示预设真值）\n')
  }

  process.stdout.write('\n开关（默认值见 lib/config.js 的 DEFAULTS，每项都有"为什么是这个默认值"）\n')
  process.stdout.write(`  skills.enabled   ${paths.skills.enabled}  (overwrite=${paths.skills.overwrite})\n`)
  process.stdout.write(`  fork.enabled     ${paths.fork.enabled}  (members=${JSON.stringify(paths.fork.members)}, provider=${paths.fork.providerName}, rank=${paths.fork.rank})\n`)
  process.stdout.write(`  notify.enabled   ${paths.notify.enabled}  (minIntervalMs=${paths.notify.minIntervalMs}, tracked=${JSON.stringify(paths.notify.tracked)})\n`)
  process.stdout.write(`  guard.enabled    ${paths.guard.enabled}  ← 默认关：它是**误操作护栏**，不是安全边界\n`)
  process.stdout.write('\nguard 覆盖面（诚实口径，原样打印）\n')
  const d = guard.describe({ ...paths, guard: { ...paths.guard, enabled: true } })
  process.stdout.write(`  覆盖工具   ${d.coverTools.join(', ')}\n`)
  process.stdout.write(`  绕得过     ${d.bypassableBy.join(', ')}\n`)
  process.stdout.write(`  受保护根   ${d.roots.join(', ') || '(无)'}\n`)
  process.stdout.write(`  白名单     ${JSON.stringify(d.writers)}\n`)
  process.stdout.write(`  药停文件   ${d.disableFile ?? '(未设置 $DSH_TEAMKIT_DISABLE)'}\n`)
  process.stdout.write(`  性质       ${d.honesty}\n`)
  process.stdout.write('\n各路径当前状态（三态：OK / -- 不存在 / ?? 读不到）\n')
  for (const [k, p] of [['上游根', paths.upstream.root], ['仓内源', paths.upstream.sources[0]], ['状态目录', paths.stateDir], ['历史快照', paths.historyDir]]) {
    let mark
    try {
      statSync(p)
      mark = 'OK'
    } catch (err) {
      mark = err?.code === 'ENOENT' ? '--' : `?? ${err?.code ?? err?.message}`
    }
    process.stdout.write(`  ${mark.padEnd(4)} ${k.padEnd(10)} ${p}\n`)
  }
  process.stdout.write('\n提示：`?? ` = **读不到 ≠ 不存在**（沙箱可能拒读 DSH_HOME，LANDMINES §6）。\n')

  // ── ★★ **"公司层到底活着没有"**（2026-09-14 / Round 63）────────────────────────
  // 【缺口】README 第⑤步给用户的验收信号全是**日志里的字样**（`ROLES-LOADED` / `ROLE-PERSONA-OK` /
  //   `FORK-REGISTER-OK`）⇒ **用户必须自己去 grep 日志**，而"日志在哪"他未必知道。
  //   `status` 当时只报**配置路径**（"会落到哪"），**不报"实际发生过没有"**。
  // 【做法】`status` 顺手读 `paths.logFile`，把 README 第⑤步那四条的**真实出现情况**数出来。
  //   ⚠️ **不假装**：日志读不到/不存在 ⇒ 明确报"未验证"，不说"没发生"（两者不同）。
  process.stdout.write('\n公司层（= README「装上就有效果」那五件事；从日志里现数）\n')
  const logPath = paths.logFile
  let logText = null
  try {
    logText = readFileSync(logPath, 'utf8')
  } catch {
    logText = null
  }
  if (logText === null) {
    process.stdout.write(`  ?? 日志读不到或不存在：${logPath}\n     ⇒ **未验证**（读不到 ≠ 没发生）；它会在插件第一次跑起来时创建。\n`)
  } else {
    const count = (re) => (logText.match(re) ?? []).length
    const lastOf = (re) => {
      const m = logText.match(re)
      return m === null ? undefined : m
    }
    const rows = [
      // ★ **「装上就有效果」第 1 件：技能装到上游根**（2026-09-14 / Round 64 补）
      //   `SKILLS-SYNC` 是"把插件自带的 7 条方法技能播到上游根"那一步的证据。
      {
        name: '技能装到上游根',
        sig: 'SKILLS-SYNC',
        n: count(/SKILLS-SYNC/g),
        hint: '插件自带的方法技能被同步到上游根（成员据此才有方法可用）',
      },
      {
        name: '公司层角色档',
        sig: 'ROLES-LOADED',
        n: count(/ROLES-LOADED/g),
        hint: '角色档被读进来（`n=7` = 七份都在）',
      },
      {
        name: '岗位人格段',
        sig: 'ROLE-PERSONA-OK',
        n: count(/ROLE-PERSONA-OK/g),
        hint: '成员被装上了岗位人格段（有岗位、有原则位）',
      },
      {
        name: '技能工作副本',
        sig: 'FORK-REGISTER-OK',
        n: count(/FORK-REGISTER-OK/g),
        hint: '成员拿到了自己的 fork（它想怎么改就怎么改）',
      },
      {
        name: 'SOUL 注入',
        sig: 'SOUL-INJECT',
        n: count(/SOUL-INJECT/g),
        hint: '成员自己的 SOUL 被注进上下文（下一步生效）',
      },
      // ★ **「装上就有效果」第 3 件：上游变更通知**（2026-09-14 / Round 64 补）
      //   【缺口】README 说五件事，而 `status` 当时只数了其中四件 —— **第 3 件（通知）没有入口**。
      //   用户要么去 grep 日志，要么以为它没工作。
      //   ⚠️ 通知的信号比别处多几种状态，**只报"推了几条"会漏掉"为什么没推"** ⇒ 一并列出：
      //     · `NOTIFY-LISTENING` —— 监听器装上了（**这一条才代表"通知在工作"**）
      //     · `UPSTREAM-CHANGED` —— 真检测到上游变了
      //     · `INJECT` —— 真推了一条通知（进成员本步上下文）
      //     · `SKIP-NOTIFY-UPSTREAM-ABSENT` —— 有意跳过（那个技能上游根本没有 ⇒ 不是"漏了"）
      {
        name: '上游变更通知（装监听器）',
        sig: 'NOTIFY-LISTENING',
        n: count(/NOTIFY-LISTENING/g),
        hint: '通知监听器装上了（没有它，后面的"检测到变"与"推送"都不会发生）',
      },
      {
        name: '上游变更通知（真推送）',
        sig: 'INJECT',
        n: count(/\bINJECT member=/g),
        hint: '真推了通知给成员（进本步上下文）；为 0 = 上游还没变过，**不代表没工作**',
      },
    ]
    for (const r of rows) {
      process.stdout.write(`  ${r.n > 0 ? 'OK ' : '-- '} ${r.sig.padEnd(18)} ${String(r.n).padStart(4)} 次  ${r.hint}\n`)
    }
    const anyOk = rows.some((r) => r.n > 0)
    if (!anyOk) {
      process.stdout.write(
        '  ⇒ **一条都没出现**。这不一定是错——可能只是**还没起过 `omc` 会话**。\n' +
          '     要让它出现：按 README 第③步新建一个 **omc** 会话（招人/派活），然后回来看这里。\n' +
          '     ⚠️ 若你已经起了 `omc` 会话却一条都没有 ⇒ 那不是"没跑"，是**没装上**：跑安装器（README 第②步）。\n',
      )
    } else {
      const names = (() => {
        const m = [...logText.matchAll(/FORK-REGISTER-OK member=(\S+)/g)].map((x) => x[1])
        return [...new Set(m)]
      })()
      if (names.length > 0) process.stdout.write(`  （拿到过 fork 的成员名：${names.join(', ')}）\n`)
    }
    // SOUL 落点也顺手报一下（README 第⑤步第 4 条提到它）
    const soulDir = join(paths.stateDir, 'soul')
    const soulFiles = (() => {
      try {
        return readdirSync(soulDir).filter((f) => f.endsWith('.md'))
      } catch {
        return null
      }
    })()
    process.stdout.write(
      `  ${soulFiles === null ? '-- ' : soulFiles.length > 0 ? 'OK ' : '-- '} SOUL 落点          ${soulDir}` +
        `${soulFiles === null ? '（目录还不存在 —— 没人写过 SOUL，这是正常状态）' : `（${soulFiles.join(', ') || '还没有人写过'}）`}\n`,
    )
  }

  // ── ★★ **「我此刻被接管了吗」（task-100 / R119）**──────────────────────────────
  // 【委托方当场问】「现在你能不能选择已有的预设来选择不同的已有的预设，这个机制做好没有？」
  // 【判定（总工程师判、CEO 批）】**「只接管 `omc`」这个边界：机制对，缺的是「让用户知道」**
  //   ⇒ 这是**体验缺口，不是机制缺陷**。**本段只补可见性，不改机制**：
  //     绝不把 guard 改成 global —— 那会让 guardReason 在**每一次**工具调用上都被调，
  //     有 liveness 风险（`task-92` 已裁）。
  //
  // 【为什么只能从日志判】`status` 是**离线 CLI**：没有 profile、没有 loader、**没有活 agent**
  //   ⇒ 它**无法**自己算 composedPreset(agent.ctx)。唯一能拿到的事实是**宿主真跑过什么** ——
  //   而 `SCOPE-GATE`（闸门自己报 presetId）与 `SKIP-FOREIGN-PRESET`（跳过了谁、为什么）
  //   就是那两个事实的**原始行**（`lib/index.js:385` / `:785`）。
  //
  // ⚠️ **三态必须分清（R5：指不到原始行就不许编状态）**：
  //   ✅ 生效中  = 有 SCOPE-GATE 且 presetId 是具体预设名（如 omc）
  //   ⛔ 未生效  = 有 SKIP-FOREIGN-PRESET（**原因与 hint 照抄日志原文**）
  //   ⬜ 未获取  = **日志读不到 / 日志里没有 SCOPE-GATE 行** ⇒ 报「未获取」，**不是**「没生效」
  // ⚠️ presetId 是「(未配置：不过滤，向后兼容)」时要**单独说清**：那是「不过滤」语义，**≠ 生效中**。
  process.stdout.write('\n接管状态（= 本插件的实例接管了哪些 agent；从日志里现读，不猜）\n')
  {
    const gateLines = logText === null ? [] : [...logText.matchAll(/^.*\bSCOPE-GATE\b.*$/gm)].map((m) => m[0])
    const skipLines = logText === null ? [] : [...logText.matchAll(/^.*\bSKIP-FOREIGN-PRESET\b.*$/gm)].map((m) => m[0])
    // 从一行日志里取「时间戳 + 原文（截断）」作为**可复核的出处**
    const citeOf = (line) => {
      const ts = /^\[([^\]]+)\]/.exec(line)?.[1] ?? '(无时间戳)'
      return { ts, text: line.length > 200 ? `${line.slice(0, 200)}…` : line }
    }
    // 从 JSON 尾巴里取一个字符串字段（不整体 parse —— 行里有中文与表达式，尽量稳）
    const fieldOf = (line, key) => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(line)
      return m === null ? undefined : m[1].replace(/\\\\/g, '\\')
    }
    const citeBlock = (c) => {
      process.stdout.write(`     出处：${logPath}\n`)
      process.stdout.write(`           时间戳 ${c.ts}\n`)
      process.stdout.write(`           原文   ${c.text}\n`)
    }

    if (gateLines.length > 0) {
      // ✅ 生效中 —— 取**最后一条**（最新状态；日志是 append-only）
      const last = gateLines[gateLines.length - 1]
      const presetId = fieldOf(last, 'presetId')
      const isUnfiltered = presetId === undefined || presetId.includes('未配置')
      if (isUnfiltered) {
        // ⚠️「不过滤」≠「生效中」：必须说出来，别让人误读
        process.stdout.write('  ⬜ **未获取**（闸门跑过，但没给出具体预设 ⇒ 本实例是「不过滤」语义）\n')
        process.stdout.write(`     presetId = ${presetId ?? '(该行没有这个字段)'}（「不过滤」≠「接管了 omc」）\n`)
      } else {
        process.stdout.write(`  ✅ **生效中**（SCOPE-GATE presetId=${presetId}）\n`)
        process.stdout.write('     含义：本实例挂在该预设上，**只接管同预设的 agent**\n')
      }
      process.stdout.write(`     计数：SCOPE-GATE 共 ${gateLines.length} 行（最近一条如下）\n`)
      citeBlock(citeOf(last))
      if (skipLines.length > 0) {
        process.stdout.write(`     （同时有 ${skipLines.length} 行 SKIP-FOREIGN-PRESET —— 其它预设的 agent 被**有意**跳过，见下一节）\n`)
      }
    } else if (skipLines.length > 0) {
      // ⛔ 未生效 —— 原因与 hint **照抄日志原文**（用户最需要那句「设计内跳过，不是故障」）
      const last = skipLines[skipLines.length - 1]
      const got = fieldOf(last, 'got')
      const want = fieldOf(last, 'want')
      const reason = fieldOf(last, 'reason')
      const hint = fieldOf(last, 'hint')
      process.stdout.write('  ⛔ **未生效**（本机日志里**只有跳过、没有闸门**）\n')
      process.stdout.write(`     原因：${reason ?? '(该行没有 reason 字段)'}\n`)
      if (got !== undefined || want !== undefined) {
        process.stdout.write(`     实况：got=${got ?? '?'}  want=${want ?? '?'} ⇒ 本实例挂在 ${want ?? '?'}，跳过了 ${got ?? '?'}\n`)
      }
      if (hint !== undefined) process.stdout.write(`     怎么办：${hint}\n`)
      process.stdout.write(`     计数：SKIP-FOREIGN-PRESET 共 ${skipLines.length} 行（最近一条如下）\n`)
      citeBlock(citeOf(last))
    } else {
      // ⬜ 未获取 —— **不许编一个状态**
      process.stdout.write(`  ⬜ **未获取**（${logText === null ? '日志读不到' : '日志里没有 SCOPE-GATE 行'}）\n`)
      process.stdout.write(`     出处：${logPath}\n`)
      process.stdout.write('     ⇒ **读不到 ≠ 没生效**：宿主还没在 omc 预设下跑过、或日志换过地方。\n')
      process.stdout.write('       要看真状态：用 omc 新建一个会话，再看这里（或 grep 日志里的 SCOPE-GATE）。\n')
    }
  }
}

/**
 * CLI 侧的配置覆盖：`--source <dir>` / `--upstream <dir>` / `--state <dir>`。
 *
 * ## 为什么必须有 `--source`（不是"顺手加的"）
 * 插件运行时，`upstream.sources` 来自 profile patch 里的 config。
 * 但 **CLI 是离线跑的**：没有 profile、没有 loader，配置只能来自 env。
 * 若不给这个口子，`teamkit promote` 就会永远对着**插件自带的 `skills/`**（它的默认值）
 * —— 开源用户想推自己仓库里的技能就**没有路**。
 * 更糟的是：**它不会报错**，只会把插件自带那 7 条合上去（我写 C2 组时实测到：
 * `PROMOTE-OK entries=7`，而测试想合的 `cli-demo` 一条也没动）⇒ 一个**静默的错落点**。
 * ⇒ 这一条本身就是 task-51 B.1（单一事实来源）在 CLI 面上的必需件。
 */
function cliOverrides() {
  const raw = {}
  const src = val('--source')
  const up = val('--upstream')
  const state = val('--state')
  if (src !== undefined) {
    // ⚠️ **`--source` 必须同时写两处**（2026-09-14 实测的真 bug）：
    //   · `skills.sourceDir` = **插件自带 skills 的源**（"装上就有效果"那一项：装到 `upstream.root`）；
    //   · `upstream.sources` = **待合并的"仓内源"**（`upstream.list` 显示的那行、`sourceSkills()` 真扫的那个）
    //     —— 依据 `plugin/lib/upstream.js:sourceSkills` 读的是 `paths.upstream.sources`，
    //     而 `list()` 打印的也是 `paths.upstream.sources`。
    //   **只写 `skills.sourceDir` 的后果（修前实测）**：用户传 `--source <我的技能仓>` 被**静默忽略**，
    //   `list` 仍显示 `<workspace>/skills`、`promote` 仍去扫默认路径 ⇒ 正是"失败不静默"要防的形态。
    //   ⇒ 两处一起写：语义一致，且**不改变**"自带 skills 同步"那一项的既有行为。
    raw.skills = { sourceDir: src }
    raw.upstream = { sources: [src] }
  }
  if (up !== undefined) raw.upstream = { ...(raw.upstream ?? {}), root: up }
  if (state !== undefined) raw.stateDir = state
  // ★★ **默认自动对齐到"已安装预设"的上游**（2026-09-14 / Round 21）。
  //
  // 【为什么要】离线 CLI 的默认上游是 `$DSH_HOME/skills`，而 **`omc` 预设的上游是
  //   `$DSH_HOME/teamkit/skills-upstream`**（预设的 `upstream.root` 与 `customSkillDirs` 同指它）。
  //   ⇒ 用户跑 `teamkit list` / `teamkit promote`（不带 `--upstream`）会**对着一个 `omc` 根本不读的目录**，
  //     **不报错、也没效果** —— 正是"失败不静默"要防的那一类。
  //   【实测的不一致（本轮的缺口）】同样一件事，两个工具给两个答案：
  //     · `tools/promote-upstream.mjs` ⇒ Round 17 起**自动对齐**（会打印"已自动对齐…"）
  //     · `teamkit list` / `teamkit promote`（本文件）⇒ **仍显示 `$DSH_HOME/skills`**
  //   ⇒ 复用**同一个** `recoverFromInstalledPreset`（`lib/config.js`，单一事实来源），
  //     让两个工具给出**同一个答案**。
  //   ⚠️ **显式 `--upstream` 永远优先**（上面那行已经写了，这里只在"没给"时补）。
  //   ⚠️ **必须说出来**：静默换目标目录比报错更糟（用户会以为写到了他指定的地方）。
  if (up === undefined) {
    try {
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
      const rec = recoverFromInstalledPreset(dshHome, PKG_NAME, process.env)
      if (typeof rec.upstreamRoot === 'string' && rec.upstreamRoot !== '') {
        const cur = raw.upstream?.root
        const differs = typeof cur !== 'string' || cur === ''
        // 只有在"用户也没通过 raw.upstream.root 给过"时才补；原来 raw.upstream 只有 sources 的情况也要补
        if (differs) {
          raw.upstream = { ...(raw.upstream ?? {}), root: rec.upstreamRoot }
          process.stderr.write(
            'ℹ️ 已自动对齐到预设的上游：' + rec.upstreamRoot + '\n' +
              '   （你没给 --upstream，而离线默认值几乎总是错的；要改写别处请显式给 --upstream <dir>）\n',
          )
        }
      }
    } catch {
      /* 对齐失败不影响主流程（退回旧默认） */
    }
  }
  return raw
}

// ── list / promote / rollback / fork-init ────────────────────────────────
async function withUpstream(fn) {
  const cfg = await import('../lib/config.js')
  const upstream = await import('../lib/upstream.js')
  const paths = cfg.resolveAll(cliOverrides(), { pluginDir: PLUGIN_DIR })
  const log = (line) => process.stderr.write(`  [log] ${line}\n`)
  const code = fn({ paths, upstream, log })
  process.exit(code ?? 0)
}

async function promoteCmd() {
  await withUpstream(({ paths, upstream, log }) => {
    const note = val('--note')
    const dryRun = has('--dry-run')
    const r = upstream.promote(paths, { all: has('--all'), skill: val('--skill'), note, dryRun }, log)
    process.stdout.write(r.lines.join('\n') + '\n')
    // 只在**真成功**时才打复核清单（失败/拒绝时打一遍"待合并清单"会让人以为它做了什么）
    if (!dryRun && r.code === 0) {
      const listRes = upstream.list(paths, log)
      process.stdout.write('\n复核（合并后清单）\n' + listRes.lines.join('\n') + '\n')
    }
    return r.code
  })
}

async function rollbackCmd() {
  await withUpstream(({ paths, upstream, log }) => {
    // `--source` 对 rollback 无意义（它只读快照 + 写上游），但**不改道 `--state` 会读错快照** ⇒
    // 给用户一致的覆盖面（`cliOverrides` 已经处理 --state/--upstream）
    const r = upstream.rollback(paths, argv[1], log)
    process.stdout.write(r.lines.join('\n') + '\n')
    return r.code
  })
}

async function listCmd() {
  await withUpstream(({ paths, upstream, log }) => {
    const r = upstream.list(paths, log)
    process.stdout.write(r.lines.join('\n') + '\n')
    return r.code
  })
}

async function forkInitCmd() {
  const cfg = await import('../lib/config.js')
  const fork = await import('../lib/fork.js')
  const paths = cfg.resolveAll(cliOverrides(), { pluginDir: PLUGIN_DIR })
  const member = argv[1]
  const skill = argv[2]
  if (!member || !skill) {
    process.stderr.write('用法：teamkit fork-init <member> <skill>\n')
    process.stderr.write('  ⚠️ 本命令**只作用于全局 fork 根**（离线路径没有 agent，无法按项目分）。\n')
    process.exit(1)
  }
  const r = fork.seedFork(paths, member, skill, (line) => process.stderr.write(`  [log] ${line}\n`))
  process.stdout.write(r.ok ? `已把上游 \`${skill}\` 带进 ${member} 的 fork：${r.file}\n` : `失败：${r.why}\n`)
  process.exit(r.ok ? 0 : 1)
}

// ── orphans / verify-route（task-107：把"孤儿任务巡检"做成机制）────────────────
/**
 * ★★ **`teamkit orphans`** —— 列"`in_progress` 且 owner 不活跃"的任务。
 *
 * ## 为什么这是**机制**而不是备忘（CEO 原话）
 * > 「请把 `teamkit orphans` 做成【**能红的东西**】……否则永远只是"COO 记得去看"」
 * ⇒ 三态退出码里 **`1`（有孤儿）才是本命令存在的意义**。
 *
 * ## ★★ 判据的承重处：活跃性只能来自**进程内**，不能用 journal 的 `phase`
 * （COO 实测：journal 22/22 `active` ⇒ 用它算出"0 孤儿"= **假绿**；真活跃只有 7）
 * 机制与源码依据写在 `lib/orphans.js` 头部。
 *
 * ## 数据从哪来（**本 CLI 是离线进程 ⇒ 必须从外部喂**）
 * `--snapshot <file>`：一个 JSON，形如
 * ```json
 * { "tasks": [{ "id": "task-1", "status": "in_progress", "ownerName": "engineer" }],
 *   "members": [{ "name": "engineer", "id": "abc", "status": "running" }] }
 * ```
 * ⚠️ `members` **必须来自宿主进程内**（`list_agents` / `memberView.list()`），
 *   **不是** journal 重放出来的 `phase`。喂错了就是假绿。
 *
 * ## 三态（与 `selftest` 同族）
 * `0` 无孤儿 ／ `1` **有孤儿（红）** ／ `2` **未获取**（快照缺失/读不全 ⇒ **不许静默 0**）
 */
async function orphansCmd() {
  const orphans = await import('../lib/orphans.js')
  const snapPath = val('--snapshot')
  if (snapPath === undefined) {
    process.stderr.write('用法：teamkit orphans --snapshot <file.json>\n')
    process.stderr.write('  ⚠️ 快照里的 `members` **必须来自宿主进程内**（list_agents），\n')
    process.stderr.write('     不是 journal 重放出来的 phase —— 用 phase 会算出"0 孤儿"的**假绿**。\n')
    process.stderr.write('  快照格式：{"tasks":[{id,status,ownerName}],"members":[{name,id,status}]}\n')
    process.exit(orphans.EXIT.unverified)
  }
  let snap
  try {
    snap = JSON.parse(readFileSync(snapPath, 'utf8'))
  } catch (err) {
    // ★ 诚实条：读不到快照 ⇒ exit=2，**不是** 0
    process.stderr.write(`未获取：快照读不到/解析失败（${snapPath}）—— ${err?.message ?? String(err)}\n`)
    process.stderr.write('  ⇒ **不许**把它当成"没有孤儿"（读不到 ≠ 没有）。\n')
    process.exit(orphans.EXIT.unverified)
  }
  const r = orphans.analyzeOrphans(snap)
  process.stdout.write('teamkit orphans · 孤儿任务巡检\n')
  process.stdout.write(`  判定：${r.verdict === 'ok' ? 'OK（无孤儿）' : r.verdict === 'orphans' ? '**红：有孤儿**' : '未获取'}\n`)
  process.stdout.write(`  ${r.why}\n`)
  if (r.orphans.length > 0) {
    process.stdout.write('\n  task id           owner               owner 状态        最后活跃\n')
    for (const o of r.orphans) {
      const last = o.lastActiveAt === null ? '(未获取)' : new Date(o.lastActiveAt).toISOString().slice(11, 16)
      process.stdout.write(`  ${o.id.padEnd(17)} ${o.owner.padEnd(19)} ${o.ownerStatus.padEnd(17)} ${last}\n`)
      process.stdout.write(`      └ ${o.kind}：${o.why}\n`)
    }
    process.stdout.write('\n  ⇒ 板上写着"有人在做"，但 owner 已经不活跃/不在名单 ⇒ **没人会去接**。\n')
  }
  process.exit(r.exitCode)
}

/**
 * ★ **`teamkit verify-route <member>`** —— 派验证岗**之前**先核"它在不在可用链上"。
 *
 * 依据（COO 实测的真实陷阱）：`reviewer` 的持有者路由 = `deepseek-official/deepseek-flash`
 * = **402 Insufficient Balance 那条链** ⇒ **叫它去验证 = 叫一个不会答的人答题 = 假机制**。
 *
 * ⚠️ **可用/坏链名单不写死**：本部署的运营事实是 `superdeepseek` 可用、`deepseek-official` 是 402，
 * 但开源用户的路由不是这两条 ⇒ `--usable` / `--blocked` **可覆盖**。
 * 三态：`0` 可用 ／ `1` **在坏链上（红）** ／ `2` 未知（不猜）。
 */
async function verifyRouteCmd() {
  const orphans = await import('../lib/orphans.js')
  const member = argv[1]
  if (member === undefined) {
    process.stderr.write('用法：teamkit verify-route <member> --provider <p> [--usable a,b] [--blocked c,d]\n')
    process.stderr.write('  或：teamkit verify-route <member> --route-map <file.json>\n')
    process.exit(orphans.EXIT.unverified)
  }
  const list = (v) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter((s) => s !== ''))
  let provider = val('--provider')
  if (provider === undefined) {
    // 从路由表取（`{"<member>": {"provider": "...", "model": "..."}}`）—— 复用 COO 那张对照表
    const mapPath = val('--route-map')
    if (mapPath !== undefined) {
      try {
        const map = JSON.parse(readFileSync(mapPath, 'utf8'))
        provider = map?.[member]?.provider
      } catch (err) {
        process.stderr.write(`未获取：路由表读不到（${mapPath}）—— ${err?.message ?? String(err)}\n`)
        process.exit(orphans.EXIT.unverified)
      }
    }
  }
  const usable = list(val('--usable')) ?? ['superdeepseek']
  const blocked = list(val('--blocked')) ?? ['deepseek-official']
  const r = orphans.routeVerdict(provider, { usable, blocked })
  process.stdout.write(`teamkit verify-route · ${member}\n`)
  process.stdout.write(`  provider : ${provider ?? '(未获取)'}\n`)
  process.stdout.write(`  可用名单 : ${usable.join(', ')}\n`)
  process.stdout.write(`  坏链名单 : ${blocked.join(', ')}\n`)
  process.stdout.write(`  判定     : ${r.verdict === 'usable' ? '可用' : r.verdict === 'blocked' ? '**红：在坏链上**' : '未获取'}\n`)
  process.stdout.write(`  ${r.why}\n`)
  process.exit(r.exitCode)
}

// ── probe-check（`R2` 探针纪律的**可复用检查口**；task-85）────────────────────
/**
 * ★★ **`teamkit probe-check`** —— 把 `R2` 从"文本纪律"变成**可执行的一步**。
 *
 * ## 为什么必须有这个子命令（不是"顺手加个 CLI"）
 * `dev_stage_add` 的探针是 **inline execute（从不落盘）** ⇒ **`selftest` 的文件扫描结构性抓不到它**。
 * 而**真出事的正是那一类**。⇒ 探针作者在**写 inline 探针之前**，要能把 snippet 喂进来先检一遍：
 * ```
 * teamkit probe-check ./exp/foo.mjs          # 落盘探针
 * teamkit probe-check --stdin < snippet.js   # ★ inline 探针（真出事的那种）
 * ```
 * ⚠️ **退出码**：`0` 合规 / `1` 违规（**这样它能进 `check-all.mjs` 或任何 CI**）。
 */
async function probeCheckCmd() {
  // ⚠️ **绝不能 `import(import.meta.url)`** —— 那会**重新执行整个 CLI 入口**
  //   （本文件底部就是 `switch (cmd)`）⇒ 递归跑一遍。`checkProbeSource` **就在本文件里**，
  //   直接调用即可（我第一版写成动态 import ⇒ 这是个真 bug，靠"加完必须真跑一次"抓到）。
  let source = ''
  let label = ''
  if (has('--stdin')) {
    label = '(stdin)'
    source = readFileSync(0, 'utf8') // 0 = stdin
  } else {
    const file = argv[1]
    if (file === undefined) {
      process.stderr.write('用法：teamkit probe-check <file> | teamkit probe-check --stdin < snippet.js\n')
      process.exit(2)
    }
    label = file
    try {
      source = readFileSync(file, 'utf8')
    } catch (err) {
      process.stderr.write(`读不到 ${file}：${err?.message ?? err}\n`)
      process.exit(2)
    }
  }
  const r = checkProbeSource(source)
  process.stdout.write(`probe-check · ${label}\n`)
  process.stdout.write(`  ${r.ok ? 'OK ' : 'XX '} ${r.why}\n`)
  for (const v of r.violations) {
    process.stdout.write(`      L${v.line} [${v.kind}] ${v.text}\n`)
  }
  process.stdout.write(`  （注：${r.note}）\n`)
  if (!r.ok) process.stdout.write('  ⇒ **违反 `RULES.yml R2`**：请改为"走副本"或"包装后**回读校验已还原**"。\n')
  process.exit(r.ok ? 0 : 1)
}

/**
 * ★ **`teamkit board-replay --snapshot <file.json>`** —— 板重放判据（`task-106` B 段①）。
 *
 * 【它回答什么】「**重启后任务板还在不在**」—— 把"我以为 event-sourced 能重放"变成**可复跑判据**。
 *   做法：拿**会话事件**独立折叠出板，与**当前板**逐条比对（id 集合 + status）。
 *
 * 【快照格式】
 * ```
 * {"tasks":[{id,status}],            ← 当前板（`team_tak_list` 的产物）
 *  "events":[{type:'team/task',seq,data:{task:{...}}}]}   ← 会话事件（`session.log` 里 type==='team/task' 的那些）
 * ```
 *
 * ⚠️ **为什么走快照而不是自己读会话日志**（重要）：
 *   会话日志是 **zstd 压缩容器**，本项目有实测教训 —— **单帧解压会造出"零命中"的假事实**（`LANDMINES` §11–§13）
 *   ⇒ 本命令**不碰宿主私有格式**（硬规矩 0 的敏感区）、**不自己解压**，
 *     由调用方把事件**以纯 JSON 喂进来**（与 `orphans --snapshot` 同一约定）。
 *
 * 【三态·退出码】`0` 重放 === 当前板 ／ `1` **有差异（逐条列出）** ／ `2` **未获取**（读不到 / 没有 task 事件）
 * ⚠️★ `R24`：**"读不到" ≠ "读到了空"** —— `taskEvents === 0` 时**报未获取**，**不许**因为
 *   "两块都空"就判 `ok`（那正是"假绿"）。空板与"快照抽错了"在这里**不可区分** ⇒ **fail-closed**。
 */
async function boardReplayCmd() {
  const rec = await import('../lib/recover.js')
  const EXIT = { ok: 0, red: 1, unverified: 2 }
  const snapPath = val('--snapshot')
  if (snapPath === undefined) {
    process.stderr.write('用法：teamkit board-replay --snapshot <file.json>\n')
    process.stderr.write('  快照格式：{"tasks":[{id,status}],"events":[{type:"team/task",seq,data:{task}}]}\n')
    process.stderr.write('  ⚠️ events 取自会话日志里 type==="team/task" 的那些（**本命令不自己解压会话日志**：\n')
    process.stderr.write('     zstd 容器单帧解压会造出"零命中"的假事实 —— 见 LANDMINES §11–§13）。\n')
    process.exit(EXIT.unverified)
  }
  let snap
  try {
    snap = JSON.parse(readFileSync(snapPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`未获取：快照读不到/解析失败（${snapPath}）—— ${err?.message ?? String(err)}\n`)
    process.stderr.write('  ⇒ **不许**当成"板一致"（读不到 ≠ 读到了空）。\n')
    process.exit(EXIT.unverified)
  }
  const tasks = snap?.tasks
  const events = snap?.events
  if (!Array.isArray(tasks) || !Array.isArray(events)) {
    const missing = []
    if (!Array.isArray(tasks)) missing.push('tasks')
    if (!Array.isArray(events)) missing.push('events')
    process.stderr.write(`未获取：快照缺 ${missing.join(' + ')} ⇒ 无法重放/比对。\n`)
    process.exit(EXIT.unverified)
  }
  const rp = rec.replayBoard(events)
  // ★ R24 fail-closed：一条 task 事件都没读到 ⇒ **未获取**（不许因为"两块都空"就判 ok）
  if (rp.taskEvents === 0) {
    process.stderr.write(
      `未获取：快照里 **没有** \`team/task\` 事件（收到 ${events.length} 条事件，task 事件 0 条）。\n` +
        '  ⇒ 无法证明"板能重放" —— **读不到 ≠ 读到了空**（快照抽取口径对吗？`session.log` 里 type 是 `team/task`）。\n',
    )
    process.exit(EXIT.unverified)
  }
  const cmp = rec.compareBoards(tasks, rp)
  process.stdout.write('teamkit board-replay · 板重放比对\n')
  process.stdout.write(`  事件 ${events.length} 条（其中 \`team/task\` ${rp.taskEvents} 条）\n`)
  process.stdout.write(`  重放：总任务 ${rp.total} / 非 deleted ${cmp.replayAlive}  ／  当前板 ${cmp.liveTotal}\n`)
  process.stdout.write(`  判定：${cmp.ok ? 'OK（重放 === 当前板）' : '**红：有差异**'}\n`)
  if (!cmp.ok) {
    process.stdout.write(`  只在当前板（重放里没有）= ${cmp.onlyLive.length}${cmp.onlyLive.length ? '：' + cmp.onlyLive.slice(0, 10).join(', ') : ''}\n`)
    process.stdout.write(`  只在重放里（当前板没有）= ${cmp.onlyReplay.length}${cmp.onlyReplay.length ? '：' + cmp.onlyReplay.slice(0, 10).join(', ') : ''}\n`)
    process.stdout.write(`  status 不一致 = ${cmp.statusMismatch}\n`)
    for (const s of cmp.samples) process.stdout.write(`      ${s.id}：重放=${s.replay} 当前=${s.live}\n`)
    process.stdout.write('\n  ⇒ ⚠️ 差异**逐条列在上面**（不是"看起来恢复了"）—— 先查"快照是不是在不同时刻取的"。\n')
  } else {
    process.stdout.write('  ⇒ 日志 → 板这条链**成立**。\n')
    process.stdout.write('  ⚠️ 边界：这只证"重放能重建板"，**不等于"重启后一定 100% 装回"**（那要真杀一次宿主，R4）。\n')
  }
  process.exit(cmp.ok ? EXIT.ok : EXIT.red)
}

/**
 * ★ **`teamkit goals --snapshot <file.json>`** —— **列出需要人 resume 的 goal**（`task-106` B 段③）。
 *
 * 【它回答什么】委托方原话：「**包括要把 goal 重新打开**，对吧？goal。」
 *   现状（真读数 + 源码）：**重启后 goal 会变 `disarmed`** —— 这是**设计**，不是缺陷：
 *   ```
 *   dsh-goal/lib/index.js:594-596  ctx.on('agent/session-start', …) ⇒ setActivation(session, 'disarmed')
 *   disarm() 文档原话：Remove process-local continuation authority…
 *     注释：a later **human-authorized** `resume` records the new activation edge
 *   ⇒ rearm 的唯一入口 = `goals.resume(agent, ref)`（:686）—— **那是「授权动作」**
 *   ```
 *   ⇒ ★ **本命令只列，不自动 resume** —— **自动 rearm = 替用户授权**（`R4` 同族：不替用户做授权决定）。
 *
 * 【快照格式】`{"sessions":[{id, member, phase, activation, revision}]}`（调用方从 `goals.get(agent)` 取）
 *
 * 【三态】`0` 没有需要处理的 ／ `1` **有 disarmed 的 active goal（需要人 resume）** ／ `2` 未获取
 * ⚠️★ `R24` fail-closed：`sessions` 为空数组 ⇒ **未获取**（读不到 ≠ 没有）；**不许**报"全部正常"。
 */
async function goalsCmd() {
  const EXIT = { ok: 0, red: 1, unverified: 2 }
  const snapPath = val('--snapshot')
  if (snapPath === undefined) {
    process.stderr.write('用法：teamkit goals --snapshot <file.json>\n')
    process.stderr.write('  快照格式：{"sessions":[{id,member,phase,activation,revision}]}\n')
    process.stderr.write('  ⚠️ 本命令**只列不自动 resume** —— resume 是「人授权」动作（R4 同族）。\n')
    process.exit(EXIT.unverified)
  }
  let snap
  try {
    snap = JSON.parse(readFileSync(snapPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`未获取：快照读不到/解析失败（${snapPath}）—— ${err?.message ?? String(err)}\n`)
    process.exit(EXIT.unverified)
  }
  const sessions = snap?.sessions
  if (!Array.isArray(sessions) || sessions.length === 0) {
    process.stderr.write(
      '未获取：快照里没有 `sessions`（或为空）⇒ 无法判断有没有 goal 需要 resume。\n' +
        '  ⇒ **读不到 ≠ 没有**：空名单下报"全部正常"就是假绿（见 RULES.yml R24）。\n',
    )
    process.exit(EXIT.unverified)
  }
  // 需要人 resume 的：`phase` 还没结束 **且** `activation === 'disarmed'`
  const need = sessions.filter(
    (s) => s?.activation === 'disarmed' && String(s?.phase ?? '') !== 'complete',
  )
  const armed = sessions.filter((s) => s?.activation === 'armed')
  process.stdout.write('teamkit goals · 需要 resume 的 goal\n')
  process.stdout.write(`  共 ${sessions.length} 个会话有 goal：armed ${armed.length} / disarmed ${need.length}\n`)
  if (need.length === 0) {
    process.stdout.write('  判定：OK（没有"未结束但已 disarmed"的 goal）\n')
    process.exit(EXIT.ok)
  }
  process.stdout.write('  判定：**有 goal 需要人 resume**\n\n')
  process.stdout.write('  session           member               phase     activation   revision\n')
  for (const s of need) {
    process.stdout.write(
      `  ${String(s.id ?? '(无)').slice(0, 16).padEnd(17)} ${String(s.member ?? '(非成员)').padEnd(20)} ` +
        `${String(s.phase ?? '(未知)').padEnd(9)} ${String(s.activation).padEnd(12)} ${s.revision ?? '(未获取)'}\n`,
    )
  }
  process.stdout.write('\n  ⇒ 为什么会这样（**是设计，不是 bug**）：会话每次启动都会 `disarm`\n')
  process.stdout.write('     （`dsh-goal/lib/index.js:594-596` 的 `agent/session-start`）⇒ **重启后不会自动续跑**。\n')
  process.stdout.write('  ⇒ 怎么开（**由人执行**，本命令不代做）：让该会话的持有者调 `goals.resume`，\n')
  process.stdout.write('     或让模型调 goal 工具的 `resume` action（那会记录一条"人授权"的 activation 边）。\n')
  process.exit(EXIT.red)
}

/**
 * ★ **`teamkit resume --snapshot <file.json>`**（`task-106` S2）—— 一条命令给"现在该做什么"。
 *
 * 【它回答什么】委托方原话：「重启之后就没法续接上之前的任务了……包括要把 goal 重新打开」。
 *   本命令把三件事**合成一份清单**（每条形如 `what` + `how`）：
 *   ```
 *   ① 孤儿任务（owner 不在了）   ⇒ "重新点名"
 *   ② goal `disarmed`            ⇒ **只给"人执行"的 resume 指令**（**不代做**）
 *   ③ 失联成员                   ⇒ `teamkit wake …`
 *   ```
 * 【快照格式】
 * ```
 * {"tasks":[{id,status,ownerName}],           ← 当前板（`team_task_list`）
 *  "members":[{name,phase}],                  ← **进程内**成员快照（`list_agents`；**不是 journal 重放**）
 *  "live":["alive-a", …],                     ← 进程内活跃名单（`list_agents` 里能解析出 membership 的名字）
 *  "goals":[{id,member,phase,activation,revision}]}
 * ```
 * 【三态】`0` 无需动作 ／ `1` **有动作要做** ／ `2` **未获取**（快照缺项 / 读不到）
 * ⚠️★ `R24` fail-closed：`members` 或 `live` 缺失/为空 ⇒ **未获取**（读不到 ≠ 没有）。
 * ⛔★ **负边界**：本命令**只出清单**，**不发送任何消息、不 resume 任何 goal** ——
 *   `goal` 的 rearm 是**授权动作**（`dsh-goal` 的 `disarm` 设计意图就是"移除进程内续跑授权"），
 *   **自动 rearm = 替用户授权**（`R4` 同族）⇒ 一律**由人执行**。
 */
async function resumeCmd() {
  const rec = await import('../lib/recover.js')
  const EXIT = { ok: 0, red: 1, unverified: 2 }
  const snapPath = val('--snapshot')
  if (snapPath === undefined) {
    process.stderr.write('用法：teamkit resume --snapshot <file.json>\n')
    process.stderr.write('  快照格式：{"tasks":[…],"members":[…],"live":[…],"goals":[…]}\n')
    process.stderr.write('  ⚠️ `members`/`live` 必须来自**进程内**（list_agents）—— 用 journal 的 phase 会出假绿。\n')
    process.stderr.write('  ⛔ 本命令**只出清单**：不发送、不 resume（goal 的 rearm 是「人授权」动作）。\n')
    process.exit(EXIT.unverified)
  }
  let snap
  try {
    snap = JSON.parse(readFileSync(snapPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`未获取：快照读不到/解析失败（${snapPath}）—— ${err?.message ?? String(err)}\n`)
    process.exit(EXIT.unverified)
  }
  if (!Array.isArray(snap?.members) || !Array.isArray(snap?.live)) {
    process.stderr.write('未获取：快照缺 `members` / `live`（或不是数组）⇒ 无法判断谁失联。\n')
    process.stderr.write('  ⇒ **读不到 ≠ 没有**：缺名单时报"一切正常"就是假绿（RULES.yml R24）。\n')
    process.exit(EXIT.unverified)
  }
  const liveNames = new Set(snap.live.map((n) => String(n)))
  const orphanReport = rec.findOrphans(snap.tasks, liveNames)
  const wakePlan = rec.planWake(snap.members, liveNames)
  const pack = rec.buildResumePack(orphanReport, snap.goals, wakePlan)
  process.stdout.write('teamkit resume · 恢复包（重启后该做什么）\n')
  process.stdout.write(`  孤儿任务 ${pack.summary.orphans} ／ disarmed goal ${pack.summary.disarmedGoals} ／ 失联成员 ${pack.summary.lostMembers}\n`)
  if (wakePlan.why !== undefined && String(wakePlan.why).startsWith('unverified')) {
    process.stdout.write(`  ⚠️ ${wakePlan.why}\n`)
  }
  if (pack.actions.length === 0) {
    process.stdout.write('  判定：OK（没有需要动作的项）\n')
    process.exit(EXIT.ok)
  }
  process.stdout.write('\n  #  类型           是什么 / 怎么做\n')
  let i = 0
  for (const a of pack.actions) {
    i += 1
    process.stdout.write(`  ${i}. [${a.kind}] ${a.what}\n`)
    process.stdout.write(`     ⇒ ${a.how}\n`)
  }
  process.stdout.write('\n  ⛔ 本命令**没有执行任何一条** —— 上面全是"点哪一下"（goal 的 resume 必须由人执行）。\n')
  process.exit(EXIT.red)
}

/**
 * ★★ **`teamkit wake`**（`task-106` S1）—— **重新点名**：把失联成员叫回来。
 *
 * ## ⛔★ 五条硬约束（每一条都有对应断言）
 * ```
 * ① **默认 dry-run**：不给 `--yes` ⇒ **只打印计划，一个字节都不发**（"唤醒 = 真实点火"）
 * ② **必须 Lead 显式调用** —— `sendMessage` 底层要求 caller 是**该 child 的直接父**
 *    （`continuation.js:238-240`），所以**天然 Lead-only**；本命令另加一条前置检查并明写
 * ③ **不许有任何"自动复活全员"的路径** —— 底座自己在 `session-start` 会重投未投递消息
 *    （`index.js:1699-1701`，**那是它的既有语义**）；**我们的代码只在此命令被执行时动作**
 * ④ **前置不成立 ⇒ 报"前置不成立"，不报 FAIL**（`R25`）
 * ⑤ **失败不静默**：逐条报每个人 `accepted` / `queued` / 失败原因
 * ```
 * ## 调用形态（`task-106` 期间**只做 dry-run**）
 * ```
 * teamkit wake --snapshot <file.json>              # **dry-run**：打印"即将给谁发什么"
 * teamkit wake --snapshot <file.json> --only <名>  # 只处理一个人
 * ```
 * ⚠️ **真正发送需要活的宿主 ctx**（`agentTeams.sendMessage`），而 `teamkit` 是**独立 CLI 进程**
 *   ⇒ **本命令在 CLI 侧只做 dry-run**；真发送由**插件工具**（宿主内）或 Lead 的 `send_message` 完成。
 *   ⇒ 本命令**不假装能发**：给 `--yes` 时**明说"CLI 进程内没有 agentTeams 服务 ⇒ 未获取"**（fail-closed）。
 */
async function wakeCmd() {
  const rec = await import('../lib/recover.js')
  const EXIT = { ok: 0, red: 1, unverified: 2 }
  const snapPath = val('--snapshot')
  const only = val('--only')
  const yes = has('--yes')
  if (snapPath === undefined) {
    process.stderr.write('用法：teamkit wake --snapshot <file.json> [--only <成员名>] [--yes]\n')
    process.stderr.write('  ⚠️ **默认 dry-run**（只打印计划）；`--yes` 才真发（**Lead-only**）。\n')
    process.stderr.write('  ⚠️ 唤醒 = **给失联成员发一条消息**（底座已有通道 ⇒ 冷启动它），**不是 spawn 新成员**。\n')
    process.exit(EXIT.unverified)
  }
  let snap
  try {
    snap = JSON.parse(readFileSync(snapPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`未获取：快照读不到/解析失败（${snapPath}）—— ${err?.message ?? String(err)}\n`)
    process.exit(EXIT.unverified)
  }
  if (!Array.isArray(snap?.members) || !Array.isArray(snap?.live)) {
    process.stderr.write('未获取：快照缺 `members` / `live` ⇒ 无法算出该唤醒谁（读不到 ≠ 没有人，R24）。\n')
    process.exit(EXIT.unverified)
  }
  const liveNames = new Set(snap.live.map((n) => String(n)))
  const plan = rec.planWake(snap.members, liveNames, only === undefined ? {} : { only: [only] })
  process.stdout.write('teamkit wake · 重新点名\n')
  if (String(plan.why).startsWith('unverified')) {
    process.stderr.write(`未获取：${plan.why}\n`)
    process.exit(EXIT.unverified)
  }
  process.stdout.write(`  ${plan.why}\n`)
  if (plan.plan.length === 0) {
    process.stdout.write('  判定：OK（没有失联成员需要唤醒）\n')
    process.exit(EXIT.ok)
  }
  const reqs = rec.makeWakeRequests(plan.plan)
  process.stdout.write('\n  即将给以下成员发消息：\n')
  for (const r of reqs) {
    process.stdout.write(`    · ${r.target}\n`)
    process.stdout.write(`      ${r.prompt.slice(0, 90)}…\n`)
  }
  if (!yes) {
    process.stdout.write('\n  【DRY-RUN】**上面一条都没发** —— 加 `--yes` 才会真发。\n')
    process.stdout.write('  ⚠️ 唤醒 = 真实点火（耗 token + 它可能开始改东西）⇒ 与 `goals` 的"只列不代做"同一形态。\n')
    process.exit(EXIT.red)
  }
  // ★ 真发送需要**活的宿主 ctx**（`agentTeams.sendMessage`）；`teamkit` 是独立 CLI 进程 ⇒ **没有它**
  //   ⇒ **不许在这里假装发了**（fail-closed，`R24`）。真发送走插件工具 / Lead 的 `send_message`。
  process.stderr.write(
    '未获取：`--yes` 需要**活的宿主 ctx**（`agentTeams.sendMessage`），而 `teamkit` 是**独立 CLI 进程**\n' +
      '  ⇒ 本进程里**没有**该服务 ⇒ **一条都没发**（**不许**把它当成"已唤醒"）。\n' +
      '  ⇒ 真发送请：① 在 **Lead 会话**里由 Lead 用 `send_message`；或 ② 走插件内工具（宿主 ctx）。\n',
  )
  process.exit(EXIT.unverified)
}

// ── doctor ───────────────────────────────────────────────────────────────
async function doctor() {
  const cfg = await import('../lib/config.js')
  const paths = cfg.resolveAll({}, { pluginDir: PLUGIN_DIR })
  process.stdout.write('teamkit · 环境体检\n')
  const major = Number(process.versions.node.split('.')[0])
  process.stdout.write(`  ${major >= 20 ? 'OK ' : 'XX '} node ${process.versions.node}（要求 >= 20，本包只用 node: 内置模块）\n`)
  const missing = ['lib/index.js', 'lib/config.js', 'lib/skills.js', 'lib/fork.js', 'lib/notify.js', 'lib/upstream.js', 'lib/guard.js', 'lib/log.js', 'bin/teamkit.mjs', 'cordis.patch.yml', 'package.json']
    .filter((f) => !existsSync(join(PLUGIN_DIR, f)))
  process.stdout.write(`  ${missing.length === 0 ? 'OK ' : 'XX '} 包内文件齐（缺：${missing.join(', ') || '无'}）\n`)
  // 可写性
  const probe = join(paths.stateDir, '.write-probe')
  let writable = 'OK '
  try {
    mkdirSync(paths.stateDir, { recursive: true })
    writeFileSync(probe, 'x', 'utf8')
    rmSync(probe, { force: true })
  } catch (err) {
    writable = err?.code === 'EACCES' || err?.code === 'EPERM' ? `?? (${err.code}：读不到 ⇒ 未验证)` : `XX (${err.code ?? err.message})`
  }
  process.stdout.write(`  ${writable} 状态目录可写：${paths.stateDir}\n`)
  const upExists = existsSync(paths.upstream.root)
  process.stdout.write(`  ${upExists ? 'OK ' : '-- '} 上游根${upExists ? '存在' : '**不存在**'}：${paths.upstream.root}` +
    `${upExists ? '' : '（promote 会创建它；若你其实想写项目内的 .agents/skills，请改 upstream.root）'}\n`)
  const vendored = (() => {
    const p = join(PLUGIN_DIR, 'skills')
    try {
      return readdirSync(p).filter((d) => !d.startsWith('.')).length
    } catch {
      return null
    }
  })()
  process.stdout.write(`  ${vendored !== null && vendored > 0 ? 'OK ' : '?? '} 包内自带 skills：${vendored === null ? '读不到/不存在（skills.enabled 会静默不生效 ⇒ 见 --selftest B 组）' : `${vendored} 条`}\n`)
  // ── ★ **两条"会挡住用户第一步"的外部前置**（2026-09-14 / Round 60）──────────────
  // 【为什么要查】（我自己连撞两次，两次的报错都**看不出是缺前置**）：
  //   · **`pnpm`** —— README 第①步 `dsh plugin --profile <p> add` 是**转发给 pnpm** 的；
  //     不在 PATH 时报 `'pnpm' is not recognized as an internal or external command`
  //     ⇒ 用户会以为"这个包坏了"（Round 56 实测）。
  //   · **`npm`** —— 安装器 / `e2e-tarball` / `npm pack` 都要它；不在 PATH 时报
  //     `'npm.cmd' is not recognized` ⇒ 同上（Round 59 实测，就发生在我自己身上）。
  // ⇒ doctor 的定位是"**只看能不能跑起来**"，而"缺前置"正是**最典型的跑不起来**。
  //   ⚠️ 用 `spawnSync` + `shell` 探测**而不是** `which`（Windows 上 `where`/`which` 行为不一）。
  const whichOnPath = (name) => {
    try {
      const r = spawnSync(name, ['--version'], { encoding: 'utf8', shell: true, timeout: 20000, windowsHide: true })
      if (r.error) return { ok: false, why: r.error.code ?? r.error.message }
      if (r.status !== 0) return { ok: false, why: `exit=${r.status}` }
      const v = String(r.stdout ?? '').trim().split('\n')[0].slice(0, 24)
      return { ok: true, version: v }
    } catch (err) {
      return { ok: false, why: err?.code ?? err?.message ?? String(err) }
    }
  }
  for (const tool of [
    // ★ **`dsh` 放第一条**（2026-09-14 / Round 61）——
    //   它是 README 第①步 `dsh plugin --profile web add …` 的**第一个**前置：
    //   **没有 `dsh` 这条命令，后面几步都无从谈起**。
    //   本机实测：`dsh.cmd` **装在** `AppData\Roaming\npm\` 里，但**默认 PATH 上没有它**
    //   ⇒ `dsh --version` 报 `'dsh' 不是内部或外部命令`。
    //   ⚠️ 这个坑我自己也踩过：Round 56 我要跑 `dsh plugin add` 时，**先得去翻它的真实路径**
    //     （`…/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`）——**说明 doctor 该提前告诉我**。
    { name: 'dsh', why: 'README 第①步 `dsh plugin --profile <p> add` 用的就是它（没它，后面几步都无从谈起）' },
    { name: 'pnpm', why: 'README 第①步 `dsh plugin add` 靠它（`dsh plugin` 是转发给 pnpm 的）' },
    { name: 'npm', why: '安装器 / `npm pack` / `e2e-tarball` 靠它' },
  ]) {
    const r = whichOnPath(tool.name)
    process.stdout.write(`  ${r.ok ? 'OK ' : '-- '} ${tool.name} ${r.ok ? r.version : '**不在 PATH 上**'}（${tool.why}）\n`)
    if (!r.ok) {
      // 每条缺前置都给**可照做的下一步**（否则用户只被告诉"你缺东西"，仍卡着）
      if (tool.name === 'dsh') {
        process.stdout.write(
          '      ⇒ `dsh` 由全局包提供。查它装在哪 + 把那个目录加进 PATH：\n' +
            '        · `npm root -g`（或在 npm 前缀目录下看 `dsh.cmd` / `dsh`）\n' +
            '        · 那个目录就是 `dsh` 所在，把它加进 PATH 后重开终端。\n' +
            '        · 不想加 PATH 也能跑：`node <npm-root>/@deepseek-ai/dsh/lib/bin.js plugin --profile <p> add <绝对路径>`。\n',
        )
      } else {
        process.stdout.write(
          '      ⇒ 它不在也能用 `node tools/install-teamkit.mjs`（纯 node，不需要 npm）；\n' +
            '        但 `dsh plugin add` 与 `npm pack` 会失败，且那个报错（\'xx is not recognized\'）**看不出是缺前置**。\n',
        )
      }
    }
  }
  // ── 顺带：**这两条路径是"用户会问"的**，直接报出来（README 承诺"重启后仍在"）────────
  // ⚠️ **不要在外层模板串里嵌反引号**（`omc`）—— ESM 解析会当场炸（本项目踩过多次，这次又踩）。
  const presetRoot = paths.dshHome + '/.agent-presets'
  const omcInstalled = existsSync(join(presetRoot, 'omc'))
  process.stdout.write('  -- 预设根（omc 该装在这）：' + presetRoot + '\n')
  process.stdout.write(`  ${omcInstalled ? 'OK ' : '-- '} omc 预设${omcInstalled ? '已装' : '**没装**（跑安装器即可）'}\n`)
  process.stdout.write('\n结论：doctor 只看"能不能跑起来"；逻辑正确性用 `teamkit selftest`（三态判定）。\n')
}

/**
 * ★★★ `teamkit init` —— **初始化一家公司**（2026-09-15 / 委托方训话的落地）
 *
 * ## 委托方原话（这一条就是为它写的）
 * ```
 * 「不是我们现在用的什么，你开源什么呀，为什么这些东西不开源出来？
 *   你创建了这么久的这个公司，你们公司有什么可以拿来？**就是给别人初始化用的**，
 *   你难道不开源玩吗？那别人用的体验跟我们的不一样，难道不是你的失职吗？」
 * ```
 * ## 它做什么
 * ```
 * 把"从零到和我们一样一家公司"需要的**这几步**串成**一条命令**（丙方案）：
 *   ① 核本包资产齐不齐（预设 / 角色档 / 技能 / 组织层）
 *   ② 跑安装器（`tools/install-teamkit.mjs`）⇒ 装到 `$DSH_HOME`
 *   ③ ★★ **逐条报"还有什么没装、为什么"** —— 拿不到的**必须显式报未获取**
 * ```
 * ## ★★ 判据（CEO §④ 写死；本命令逐条实现）
 * ```
 * ① **一条命令** `node plugin/bin/teamkit.mjs init` ⇒ 尽量装齐
 * ② ★★ **对"拿不到的"必须明确报「未获取 + 为什么」**（`R24`）——
 *    ⛔ **不许静默跳过**（那会让陌生人以为"装完了"）
 * ③ ★ **幂等**：重复跑 ⇒ 不重复装、不报错
 * ④ ★ **失败不静默**：每一步给「装了 / 已存在 / 未获取+原因」三态
 * ⑤ ★★ 写进 `plugin/README.md` 的「初始化一家公司」一节
 * ```
 * ## ⚠️ **它现在装不齐**（诚实口径）
 * ```
 * 「我们这家公司」= 多个包，而**只有 `dsh-teamkit` 开源了** ⇒
 *   ★ 所以本命令的**真正价值是把缺口显式化**（输出里点名"哪些未开源"）——
 *     而不是假装装完了。
 * ```
 */
async function initCmd() {
  const cfg = await import('../lib/config.js')
  const paths = cfg.resolveAll({}, { pluginDir: PLUGIN_DIR })
  process.stdout.write('teamkit init · **初始化一家公司**\n')
  process.stdout.write('  目标：把"从零到和我们一样一家公司"需要的步骤串成一条命令。\n')
  process.stdout.write('  ⚠️ 它会**尽量装齐**，并**逐条报"还差什么、为什么"**（不许静默跳过）。\n\n')

  // ── ① 本包资产齐不齐（装之前先自证"我有东西可装"）───────────────────────
  const assets = [
    ['预设 omc', join(PLUGIN_DIR, 'assets', 'presets', 'omc', 'agent.cordis.yml')],
    ['组织层 RULES.yml', join(PLUGIN_DIR, 'assets', 'org', 'RULES.yml')],
    ['组织层 TALENTS.yml', join(PLUGIN_DIR, 'assets', 'org', 'TALENTS.yml')],
    ['公司建造指南', join(PLUGIN_DIR, 'assets', 'org', 'COMPANY-GUIDE.md')],
    ['技能上游（7 条）', join(PLUGIN_DIR, 'skills')],
    ['角色档', join(PLUGIN_DIR, 'assets', 'roles')],
  ]
  process.stdout.write('【第 1 步】核本包资产：\n')
  let lacking = 0
  for (const [name, p] of assets) {
    const ok = existsSync(p)
    if (!ok) lacking += 1
    process.stdout.write(`  ${ok ? 'OK ' : 'XX '} ${name}\n`)
  }
  if (lacking > 0) {
    process.stdout.write(`\n⛔ **本包自身缺 ${lacking} 项资产** ⇒ 停在这里（先修包，别往下装）\n`)
    process.exit(1)
  }

  // ── ② 跑安装器（装到 $DSH_HOME）─────────────────────────────────────────
  process.stdout.write('\n【第 2 步】装到本机（`$DSH_HOME`）：\n')
  const installer = join(PLUGIN_DIR, 'tools', 'install-teamkit.mjs')
  if (!existsSync(installer)) {
    process.stdout.write('  XX **安装器不在包里**（tools/install-teamkit.mjs）⇒ 未获取\n')
    process.exit(1)
  }
  const r = spawnSync(process.execPath, [installer], { encoding: 'utf8', windowsHide: true, timeout: 300000 })
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  for (const line of out.trim().split('\n').slice(-14)) process.stdout.write(`      ${line}\n`)
  if (r.status !== 0) {
    process.stdout.write(`  XX **安装器退出码 ${r.status}** ⇒ 失败不静默（上面是它的原始输出）\n`)
    process.exit(1)
  }
  process.stdout.write('  OK 安装器跑完（exit=0）\n')

  // ── ③ ★★ 逐条报"公司还差什么"（**本命令的核心价值**）────────────────────
  // ```
  // 这一节是**委托方那句"给别人初始化用的"的直接落地**：
  //   ★ **陌生人拿不到的东西，必须在这里被点名** —— 否则他会以为"装完了、就这些"。
  // ```
  // ★★★ **2026-09-15 修（CEO 抓到的真缺陷）：原来这张表是【源码里写死的】**
  // ```
  // 现场：我第一版把 14 个包的可用性**硬编码**在源码里 ⇒
  //   ★ 而**第二天就有两条漂了**：面板**已开源**（我却写"未开源"）、
  //     `super-injector` 的版本号也会变 ⇒ **陌生人跑 `init` 会被误导**。
  // ⇒ ★★ 这正是委托方骂的那件事的同形：**"信息是实时的吗"** ——
  //   写死的世界状态 = **"看起来对" ≠ "现在还对"**。
  // ⇒ **修法（本段）**：**能取就取实时**（未认证 GitHub API）⇒ 有/没有 · 版本多少；
  //   **取不到 ⇒ 标「未获取」**（`R24`），**不许猜**。
  //   ⚠️ 实时查询**依赖网络**；`hosts` 会把 `api.github.com` 指到 127.0.0.1 ⇒
  //     这里**用 `dns.resolve4` 拿真 IP 再直连**（走 c-ares ⇒ 不读 hosts；与 `check-preset-autoload` 同一手法）。
  //   ⚠️ **超时要短**（每个 ≤6s）—— `init` 是给人跑的，不能卡住。
  // ```
  process.stdout.write('\n【第 3 步】公司还差什么（**逐条：拿得到 / 拿不到 + 为什么**）：\n')
  process.stdout.write('  ⚠️ 以下可用性**实时查询**（未认证 GitHub API）—— 取不到的会标「未获取」，不猜。\n')

  /** 拿 api.github.com 的真 IP（`dns.resolve4` 走 c-ares ⇒ **不读 hosts**） */
  const apiIp = async () => {
    try {
      const dns = await import('node:dns/promises')
      const ips = await dns.resolve4('api.github.com')
      return ips[0] ?? null
    } catch {
      return null
    }
  }

  /** ★★★ **认证 token（优先用）** —— 2026-09-18 / CEO §③【1】
   * ```
   * 【为什么需要】未认证 GitHub API **只有 60 次/小时** ⇒ 而 `init` 一次要问 N 个仓
   *   ⇒ ★ 实测：未认证配额被烧光后，**每个仓都返回 403 rate-limit**
   *     ⇒ 而旧代码把它当"不存在" ⇒ **用户看到"这包没有"，而它明明在**（今晚第 6 例）
   * 【★ 为什么不用 `gh api`】它走 `hosts`（`github.com` → 127.0.0.1）⇒ **要转发器**
   *   ⇒ ⚠️ **而 `init` 是给用户跑的命令 ⇒ 不该要求它先起转发器**
   * ⇒ **正解：拿 token 直接加在 `curl` 的 `Authorization` 头上**（`--resolve` 直连那条路保留）
   * 【token 从哪来（按可靠性排序）】① 环境变量 ② `gh auth token`（本机装了 gh 就有）
   *   ⇒ **都拿不到 ⇒ 未认证**（并**明说"可能被限流"** —— 不猜）
   * ⚠️ **token 绝不打印/落盘**（只用于这一个请求头）。
   * ```
   */
  const ghToken = (() => {
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const v = process.env[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    try {
      const gh = [
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'GitHub CLI', 'gh.exe'),
      ].find((p) => { try { return statSync(p).isFile() } catch { return false } })
      if (gh === undefined) return null
      const r = spawnSync(gh, ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
      const t = String(r.stdout ?? '').trim()
      return /^[A-Za-z0-9_]{20,}$/.test(t) ? t : null
    } catch {
      return null
    }
  })()

  /** 查一个公开仓：返回 {exists, fullName, files, hasPatch} 或 null（未获取） */
  const probeRepo = async (slug, ip) => {
    if (ip === null) return null
    const authArgs = ghToken === null ? [] : ['-H', `Authorization: Bearer ${ghToken}`]
    const r = spawnSync(
      'curl',
      ['-s', '--max-time', '6', '--resolve', `api.github.com:443:${ip}`, ...authArgs,
       `https://api.github.com/repos/${slug}`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    )
    const body = String(r.stdout ?? '')
    if (body.trim() === '') return null
    try {
      const j = JSON.parse(body)
      if (j.full_name === undefined) {
        // ★★★ **区分「真的不存在(404)」与「限流/被拦(403/429)」**（2026-09-18 · 实测抓到的误报）
        // ```
        // 【现场】未认证 API **配额只有 60/小时** ⇒ 用完就每个仓库都返回
        //   `{"message":"API rate limit exceeded for …"}`
        //   ⇒ ★★ 而旧代码把它当成 `exists: false` ⇒ `init` 对用户说
        //     「**未获取** —— **该地址不存在**」 ⇒ **那是假的**（仓明明在）
        // 【★ 它错在哪一步】`j.full_name === undefined` 有**很多种原因**
        //   （404 真不存在 / 403 限流 / 401 / 网络异常…）⇒ 而旧代码**只用一个状态表达所有**
        //   ⇒ ★ 与 `R24` 同族：**"我读不到" ≠ "它不存在"**
        // 【修法】**看 `message` 判因**：含 `rate limit` ⇒ 记「限流」；含 `Not Found` ⇒ 才是"不存在"
        //   ⇒ 其余的 ⇒ 一律**未获取**（不猜）。
        // ⚠️ **顺带**：`init` 每跑一次就要问 N 个仓 ⇒ **更容易撞配额**
        //   ⇒ 所以**这条误报在真实使用中很常见**（用户第一次跑就可能是这样）。
        // ```
        const msg = String(j.message ?? '未知')
        if (/rate limit/i.test(msg)) {
          return { exists: false, why: `**GitHub API 限流**（未认证只有 60 次/小时）⇒ **不是"仓不存在"**`, rateLimited: true }
        }
        if (/Not Found|404/i.test(msg)) return { exists: false, why: '**该地址确实不存在**（404）' }
        return null // ★ **其他原因（401/403/网络…）⇒ 未获取，不猜**
      }
      // 顺带取 tree（判"关键文件在不在"，如 `cordis.patch.yml`）—— ★ **同样带认证**（省配额）
      const rt = spawnSync(
        'curl',
        ['-s', '--max-time', '6', '--resolve', `api.github.com:443:${ip}`, ...authArgs,
         `https://api.github.com/repos/${slug}/git/trees/${j.default_branch}?recursive=1`],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      )
      let paths = []
      try {
        paths = (JSON.parse(String(rt.stdout ?? '')).tree ?? []).map((e) => e.path)
      } catch { /* tree 取不到不算失败 */ }
      return { exists: true, fullName: j.full_name, visibility: j.visibility, paths }
    } catch {
      return null
    }
  }

  const ip = await apiIp()
  // ★ 每条：`slug` 为 null 表示"我们知道它没公开仓"（那是**事实**，不是猜）；否则实时查
  const company = [
    { name: '@dsh-external/dsh-teamkit', role: '公司层（角色档 / 技能 / 组织层 / 指南）', slug: 'yjh051108/dsh-teamkit', bundled: true },
    { name: '@dsh-external/dsh-org-panel', role: '★ 侧边栏"办公室"（**看得到公司**）', slug: 'yjh051108/dsh-org-panel', need: 'cordis.patch.yml' },
    { name: '@dsh-external/dsh-super-injector', role: '运行时注入（把本地包挂进 loader）', slug: 'yjh051108/dsh-super-injector' },
    { name: '@dsh-external/dsh-engram-relay', role: '记忆图谱（engram）', slug: 'yjh051108/dsh-engram-relay' },
    // ★ 2026-09-18：这三个**已建公开仓**（我逐仓核过 `gh api repos/…` ⇒ **200**）⇒ slug 填上
    //   ⇒ ⚠️ 而 `dsh-agent-browser` **保持 `null`** —— 实测 **404（确实还没有）**，
    //     ★ **不许为了"看起来全绿"而编一个 slug**（那会造出"指向不存在的来源"，即 `B37` 那族）
    { name: '@dsh-external/dsh-tool-output-guard', role: '工具输出护栏', slug: 'yjh051108/dsh-tool-output-guard' },
    { name: '@dsh-external/dsh-agent-browser', role: '侧边栏浏览器面板', slug: null },
    { name: '@dsh-external/dsh-issue-watch', role: 'issue 监视', slug: 'yjh051108/dsh-issue-watch' },
    { name: '@dsh-external/dsh-model-fit', role: '模型适配', slug: 'yjh051108/dsh-model-fit' },
    // ★ 2026-09-18 **第二批**（`coo` 报的第⑤步 · 我逐仓核过 `gh api repos/…` ⇒ **200**）
    //   ⚠️ **name/role 我照 `package.json` 核过**（**不凭转述** —— 那两包的 name 与描述逐字对上了）
    //   ⇒ ★ 不加这两行 = **"仓建好了、公开了，而 `init` 里用户看不到"**（第一批刚修过的那个坑）
    { name: '@dsh-external/dsh-symbiote', role: '共生体：只读观测闭环盘档（真 C 信誉 / 注意力税 / 蒸馏草稿）', slug: 'yjh051108/dsh-symbiote' },
    { name: '@dsh-external/dsh-web-tools', role: '浏览器工具（web_status / web_shot / web_dom）', slug: 'yjh051108/dsh-web-tools' },
    { name: '@deepseek-ai/dsh-tool-diff', role: '工具：diff（**别人开源**）', slug: 'omdsh-dev/dsh-tool-diff' },
    { name: '@deepseek-ai/dsh-tool-json', role: '工具：json（**别人开源**）', slug: 'omdsh-dev/dsh-tool-json' },
    { name: '@deepseek-ai/dsh-tool-markdown', role: '工具：markdown（**别人开源**）', slug: 'omdsh-dev/dsh-tool-markdown' },
    { name: '@deepseek-ai/dsh-tool-time', role: '工具：time（**别人开源**）', slug: 'omdsh-dev/dsh-tool-time' },
  ]
  let missing = 0
  let unverified = 0
  for (const c of company) {
    let mark = '-- '
    let how = ''
    if (c.bundled === true) {
      mark = 'OK '
      how = '已装（本包）'
    } else if (c.slug === null) {
      // ★ **事实**：我们这台机器上它没有公开仓（已实测）—— 但那是"我查到的事实"，不是"永久真理"
      mark = '-- '
      missing += 1
      how = '**未获取** —— `init` 查到的公开仓列表里没有它（若你知道它另有地址，请报 issue）'
    } else {
      const got = await probeRepo(c.slug, ip)
      if (got === null) {
        mark = '?? '
        unverified += 1
        how = `**未获取** —— GitHub API 取不到（无网/被拦）⇒ **不猜**（手动查 https://github.com/${c.slug}）`
      } else if (got.rateLimited === true) {
        // ★★★ **限流 ≠ 不存在**（2026-09-18 / CEO §③【2】）
        // ```
        // 【现场】旧输出逐字：`**未获取** —— 该地址不存在（API rate limit exceeded …）`
        //   ⇒ ★★ **两个矛盾的说法同时出现，而用户先读到"该地址不存在"** ⇒ 他会以为这包没有。
        // 【修法】限流单独一档 ⇒ `??`（未获取）+ **明说"是限流不是不存在"** + 可操作的话。
        // ```
        mark = '?? '
        unverified += 1
        how = `${got.why}\n        ⇒ ★ **不是"它没有"**（我这次没读到而已）· 重试，或配 \`GH_TOKEN\` 后更准`
      } else if (!got.exists) {
        mark = '-- '
        missing += 1
        how = `**未获取** —— ${got.why}`
      } else {
        mark = 'OK '
        let note = `**public**：https://github.com/${got.fullName}`
        if (c.need !== undefined) {
          const has = got.paths.includes(c.need)
          if (!has) {
            // ★ 从"可拿"降级为"可拿但还差一步" —— **这才是实时的真相**
            note += ` · ⚠️ **但还缺 \`${c.need}\`** ⇒ 现在装了**激活不了**（等它补上）`
            mark = '?? '
            unverified += 1
          }
        }
        note += `\n        ⇒ 装法：\`dsh plugin --profile <p> add "https://github.com/${got.fullName}"\``
        how = note
      }
    }
    process.stdout.write(`  ${mark} ${c.name}\n        ${c.role}\n        ⇒ ${how}\n`)
  }

  // ── ④ 落点体检（装了之后能不能用）──────────────────────────────────────
  process.stdout.write('\n【第 4 步】落点体检：\n')
  const checks = [
    ['角色档', join(paths.dshHome, 'teamkit', 'roles')],
    ['技能上游', join(paths.dshHome, 'teamkit', 'skills-upstream')],
    ['talents', join(paths.dshHome, 'teamkit', 'talents')],
    ['组织层 RULES.yml', join(paths.dshHome, 'teamkit', 'RULES.yml')],
    ['公司建造指南', join(paths.dshHome, 'teamkit', 'COMPANY-GUIDE.md')],
    ['预设 omc', join(paths.dshHome, '.agent-presets', 'omc')],
  ]
  for (const [name, p] of checks) {
    const ok = existsSync(p)
    process.stdout.write(`  ${ok ? 'OK ' : 'XX '} ${name}：${p}\n`)
  }

  // ── ⑤ 结论（**三态，不粉饰**）──────────────────────────────────────────
  // ★ 措辞也**不再写死世界状态**（2026-09-15 / CEO 抓到"面板已开源而我写未开源"）——
  //   现在按**实时读数**分类：`missing`（查了，确实没有）/ `unverified`（取不到，不猜）
  process.stdout.write('\n' + '='.repeat(64) + '\n')
  if (missing === 0 && unverified === 0) {
    process.stdout.write('判定：**PASS（公司层齐了）** —— 新建会话、预设选 `omc` 即可。\n')
  } else {
    const parts = []
    if (missing > 0) parts.push(`${missing} 个包在公开仓里**查不到**`)
    if (unverified > 0) parts.push(`${unverified} 个**未能取到**（无网/被拦 ⇒ 不猜）`)
    process.stdout.write(`判定：**部分完成 —— 装上了「公司层」；公司其余部分：${parts.join(' · ')}**\n`)
    process.stdout.write(
      '  ★ **公司层你现在已经有了**（角色档 / 技能 / 组织层 / 建造指南 + 预设 `omc`）\n' +
        '    ⇒ 新建会话选 `omc` 就能开公司。\n' +
        '  ★ 上面那些标 `-- / ??` 的，是**「看得到公司」那类外挂**（侧边栏面板 / 浏览器 / 护栏…）\n' +
        '    ⇒ 本条**已实时查过 GitHub**：能拿到就给了装法；拿不到/取不到的**都点名了**，没藏。\n' +
        '  ★ 完整清点依据：`plugin/assets/org/COMPANY-GUIDE.md` 与仓库根的 `COMPANY-INIT-INVENTORY.md`。\n',
    )
    process.exitCode = 2 // ★ 未获取 ≠ 失败（与 selftest 的三态口径一致）
  }
  process.stdout.write('  幂等：本命令可重复跑（安装器本身幂等）。\n')
  process.stdout.write('  ⚠️ 本节的可用性**每次运行都重新查**（不写死在源码里）—— 所以它不会过期。\n')
}

// ── 派发 ─────────────────────────────────────────────────────────────────
switch (cmd) {
  case 'selftest':
    await selftest()
    break
  case 'status':
    await status()
    break
  case 'list':
    await listCmd()
    break
  case 'promote':
    await promoteCmd()
    break
  case 'rollback':
    await rollbackCmd()
    break
  case 'fork-init':
    await forkInitCmd()
    break
  case 'doctor':
    await doctor()
    break
  // ★★★ `init`（2026-09-15 / 委托方训话的落地）：**初始化一家公司** ——
  //   把"从零到和我们一样一家公司"串成**一条命令**，并**逐条报"还差什么、为什么"**。
  //   ⚠️ 它**装不齐**（我们这家公司是多个包，只有本包开源了）⇒
  //     ★ **它的核心价值是"把缺口显式化"**，而不是假装装完了（`R24`：报"无"要附范围）。
  case 'init':
    await initCmd()
    break
  // ★★ `orphans` / `verify-route`（task-107）：把"孤儿任务巡检"从备忘做成机制。
  //   `orphans` 的 **exit=1 才是它存在的意义**（有孤儿 ⇒ 红）；`2` = 未获取（**不许静默 0**）。
  //   ⚠️ 本段**不要在模板字符串里写反引号**（那会让整个 CLI 语法崩，本项目已 3 次）。
  case 'orphans':
    await orphansCmd()
    break
  case 'verify-route':
    await verifyRouteCmd()
    break
  // ★★ `goals` / `board-replay`（task-106 B 段 · **区域所有权：本两行归 `e2r-landing`**）——
  //   与 `orphans` / `verify-route`（`task-107`，归 `plugin-smith`）**同在 `switch` 里但各写各的区域**。
  //   · `board-replay` ⇒ 把"板能不能重放恢复"从一次性读数做成**可复跑判据**（`lib/recover.js`）
  //   · `goals`        ⇒ **只列**"需要人 resume 的 goal"（`disarmed` 是设计；**自动 rearm = 替用户授权**，不做）
  //   ⚠️ 两条都走 **`--snapshot <file.json>`**（**不自己解压会话日志**：zstd 单帧解压会造"零命中"假事实）。
  //   ⚠️ 本段**不要在模板字符串里写反引号**（那会让整个 CLI 语法崩，本项目已 3 次）。
  case 'board-replay':
    await boardReplayCmd()
    break
  case 'goals':
    await goalsCmd()
    break
  // ★★ `resume` / `wake`（task-106 **S1+S2** · **区域所有权：本两行归 `e2r-landing`**）——
  //   · `resume` ⇒ 一条命令给"重启后该做什么"（孤儿 + disarmed goal + 失联成员 ⇒ 逐条给"点哪一下"）
  //   · `wake`   ⇒ **重新点名**（把失联成员叫回来）——**默认 dry-run**，且**只列不代发**
  //   ⛔ **负边界**：`wake` **不许**做"自动复活全员"；唤醒必须是 **Lead 显式调用**（见函数头 §①②③）。
  //   ⛔ **不碰** `case 'orphans'` / `case 'verify-route'` / `case 'preset-new'`（那些归 `plugin-smith`）。
  case 'resume':
    await resumeCmd()
    break
  case 'wake':
    await wakeCmd()
    break
  // ★★ **`preset-new`**（task-99）：把"手抄预设"变成"一次命令生成"。
  //   【为什么在这里只是**薄壳**】权威实现是 `scripts/preset-new.mjs`（内核
  //   `lib/preset-gen.js` 是纯函数）。那两处已有各自的读者（`verify-templates.mjs`
  //   与 `check-preset-overlap.mjs` 都直接 import 它们）⇒ **不在本文件重写一套**，
  //   否则就成了第二个事实来源（`R10`）。
  //   【转发方式】`await import` 它的 `main()`，并**把本进程的 argv 原样传进去**
  //   （它自己解析 `--template/--out/--role/...`）；退出码**由它返回**，这里照搬。
  //   ⚠️ 本段**不要在模板字符串里写反引号** —— 那会让整个 CLI 语法崩（本项目已 3 次）。
  case 'preset-new': {
    // 动态 import：这样 `teamkit help` / `doctor` 不必加载生成器
    const mod = await import('../scripts/preset-new.mjs')
    // ⚠️ 本派发里**没有**一个 `code` 变量（各 case 自己 `process.exit`）⇒ 这里也照做，
    //   不引入新约定（否则"看起来设置了退出码、其实没生效"正是本项目反复栽的形态）。
    process.exit(mod.main(process.argv))
    break
  }
  // ★ `probe-check`（task-85）：`R2` 探针纪律的**可复用检查口**。
  //   ⚠️ **`--stdin` 那一支是重点** —— `dev_stage_add` 的 inline 探针从不落盘，
  //   只有这个口能检它（而**真出事的正是那一类**）。
  case 'probe-check':
    await probeCheckCmd()
    break
  // ★★ **`--version` / `-v`**（2026-09-14 / Round 78 补）。
  // 【缺口】它原来**不被支持** —— 落进 `default` 报 `未知子命令：--version`。
  //   ⇒ **开源用户报 bug 时说不出自己装的是哪一版**（而 `package.json` 里明明有 `version`）。
  //   这是北极星"越方便开源后其他用户安装越好"的直接一格：**装完能自查版本**。
  //   ⚠️ **只读 package.json、不写盘**，且**必须 exit 0**（它是成功的信息查询）。
  case 'version':
  case '--version':
  case '-v':
    versionCmd()
    break
  case 'help':
  case '--help':
  case '-h':
    help()
    break
  // ⚠️ **无参数 ≠ help**（2026-09-14 / Round 78 修）。
  // 【缺陷】原来 `case undefined:` 跟 `help` **共用一支**、**exit 0** ⇒
  //   脚本无法区分"我请求了帮助"与"我啥也没请求、它啥也没干"。
  //   对照：`git` / `npm` 无参数 ⇒ **打印用法 + 退出码 1**。
  // ⇒ 现在：**打印用法到 stderr + exit 1**（明确"你没给子命令"），而**显式 help 仍 exit 0**。
  case undefined:
    process.stderr.write('没有给子命令（也不是"你输了 help"）—— 下面是用法：\n\n')
    help()
    process.exit(1)
  default:
    process.stderr.write(`未知子命令：${cmd}\n\n`)
    help()
    process.exit(1)
}
