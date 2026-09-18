/**
 * config.js —— **本插件唯一的路径事实来源**（task-51 B.1）。
 *
 * ⚠️ **task-57 修正（2026-09-13，真宿主实测暴露的缺陷）**：状态落点**不能跟 `process.cwd()`**。
 * 真 `dsh web` 的 `cwd = D:\dsh` ⇒ 旧默认把 `stateDir`/`logFile`/`forks`/`history`/`CHANGELOG`
 * **全建在 `D:\dsh\.teamkit`** ⇒ **两个不同项目的 agent 共用同一个状态目录**（串台）。
 *   ⚠️ **2026-09-15 脱敏**：原文逐字写了**另一个项目**的名字 ⇒ 改成通用描述
 *     （★ 技术要点不受影响：**"两个项目的 agent 串台"这个事实**才是证据）。
 * 正解：**agent 自己的 `session.header.cwd`**（`dsh-session\lib\types\types.d.ts:68-69`
 * `readonly cwd?: string;` —— *"Absolute working directory the session was created in"*；
 * Lead 在真宿主读到 4 个 agent 的该值**各不相同且都有值**）。
 *
 * ⇒ **两层落点语义（本文件的核心区分）**：
 * | 类别 | 项 | 归属判据 |
 * |---|---|---|
 * | **全局一份** | `stateDir` / `historyDir` / `changelogPath` / `logFile` | **属于"上游"这个全局对象**，不属于任何成员 |
 * | **按 agent 分** | **fork 目录**（`forkRootTemplate` 经 `forkRootForAgent` 实例化） | **属于那个成员自己的工作副本** |
 *
 * "全局一份"的**依据**（回源码核过，不是口味）：
 *  ① `upstream.js:189-194` 快照的是 `st.dst` = **上游根**的文件 ⇒ **history 属于上游**；
 *  ② `upstream.js:214` CHANGELOG 条目 = **上游** before→after 的 sha256 ⇒ 是"上游更新史"；
 *  ③ `notify.js:217` 通知里的"旧版快照"读的也是**上游**文件，且 `:74` 有 `existsSync` 幂等短路
 *     ⇒ 同一份上游版本被 N 个成员快照到**同一个**目录反而更省（按 agent 分会重复 N 份）。
 * ⚠️ 一条限定：**"全局"的边界应跟着 `upstream.root` 走** —— 默认 `upstream.root = $DSH_HOME/skills`
 *    （不含 workspace）⇒ 默认确实是全局；用户若把 `upstream.root` 覆盖到**项目内**路径，
 *    history 也应跟着那个项目走才自洽。本轮**按默认（全局）实现**，限定写进 `STATE-LOCATION.md`。
 *
 * ✅ **【2026-09-14 更正】上面这段"尚未接线"已经过期 —— 接线早就完成了。**
 *   原文写的是「`fork.js:123` / `notify.js:136` 仍是两参调用 ⇒ fork 落点仍跟 `paths.workspace`…
 *   **在接线完成前，不许声称"串台已修好"**」。
 *   **接线做法后来定成了另一种（更稳的）形态** —— **不改那两个两参调用，而是让调用方喂 per-agent 的 `paths`**：
 *     · `index.js` 用 `pathsForAgent(paths, agent)` 算 `agentPaths`，**同一份**喂给
 *       `installForkFor({paths: agentPaths})`（`:683`）**与** `makeNotifier({paths: agentPaths})`（`:727`）；
 *     · `forkRootFor(paths, member)` **保持两参**是对的 —— 落点由**调用方给哪个 `paths`** 决定
 *       （**单点开关 = `pathsForAgent`**，比在三处各传 `{agent}` 更不容易漏）。
 *   ⇒ **真宿主读数证明它成立**：`FORK-REGISTER-OK … dir=D:\…\.teamkit\forks\<team>\<member>\skills`
 *     —— 含 **team 层**（`forkRootTemplateFor` 里 `teamSlugOf(agent)` 算的），
 *     ⇒ **落点是按 agent 算的，不是全局一份**；串台已修。
 *   ⚠️ 结论保留一句：**"不许声称串台已修好"的前提是"没接线"**；现在**有真宿主读数**，所以可以声称。
 *
 * 为什么单独一个文件、且零 import：
 *  ① 收敛：实验件里"上游目录 / fork 目录 / CHANGELOG 位置 / 通知参数"各写一遍、
 *     还写死 `D:/dsh/omc-agent-teams/...`（`exp/a-channel-probe/lib/index.js:24-27`、
 *     `exp/notify-probe/lib/index.js:28-33`、`exp/changelog-probe/lib/index.js:26-33`、
 *     `exp/authority-probe/lib/index.js:31-45`）。这里**只写一次**，其余模块全部 import 它。
 *  ② 零依赖：运行时注入的插件目录**没有 node_modules**（实测于 `UPSTREAM-NOTIFY.md` §A.1
 *     的"chokidar 那条路不能复用"），所以本包**不 import 任何裸模块**（连 `schemastery` 也不）。
 *     代价是要自己实现 `~standard` 形状的配置校验 —— 见下方 `Config`。
 *
 * 三态标注：本文件的"默认值"是**设计**（本机未逐个用真 DSH 跑过每一个分支）；
 * 「默认值从 env / cwd / DSH_HOME 推导、不含盘符」这条是**代码强制**（`resolveAll()` 里
 * `isAbsolute` 判定 + `env`/`cwd` 取值的写法本身），且 `--selftest` 会在**临时 DSH_HOME** 下
 * 断言"所有解析出的路径都在临时根之下"。
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
// ⚠️ `detectLegacyForks`（Round 14 加的迁移探测）需要读盘才能"看旧布局里有没有内容"。
//   本文件**原本零 fs 依赖**（纯路径解析）—— 引入它是**有意取舍**：
//   探测必须"看目录里真有没有东西"，否则会把"空目录"也报成"有待迁移的 fork"（假警报）。
//   用 `node:fs` 的**同步**接口，且全部包在 try/catch 里（探测失败**绝不影响主流程**）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'

/**
 * 环境变量名（全部可覆盖；列在这里是为了单点可查）。
 *
 * ⚠️ **不是每个都"本插件自己在读"** —— 2026-09-14 / Round 73 补的说明
 *   （原先只写"单点可查"，读的人**会以为六个都被用了**）：
 * | 键 | 谁在读 | 说明 |
 * |---|---|---|
 * | `home` | **本插件** | `paths.dshHome` 的**权威来源**（`os.homedir()` 在**本机给的是一个非真实家目录的账户名**，不能用） |
 * | `workspace` / `state` / `log` | **本插件** | 各自覆盖 `workspace` / `stateDir` / `logFile` |
 * | `disable` | **本插件** | 药停开关（`$DSH_TEAMKIT_DISABLE` ⇒ 插件整体不接管） |
 * | `agentsHome` | ❌ **没人读（本插件不读）** | ⚠️ **它是 DSH 原生**的技能根（rank **500**，`dsh-skill-filesystem` 自己扫 `$DSH_AGENTS_HOME/skills`）⇒ **本插件不需要算它**。留在这里只是**记录"生态里有这个变量"**；`resolveAll()` 的返回值里**没有** `agentsHome` 字段（别去找）。 |
 *
 * ⇒ **判据**：`grep` 一个变量名时，**"出现在 ENV 表里" ≠ "被用了"**。
 *   要确认"谁在读"，得看**调用点**（`process.env[ENV.x]`），不是看这张表。
 */
export const ENV = {
  home: 'DSH_HOME',
  agentsHome: 'DSH_AGENTS_HOME',
  workspace: 'DSH_TEAMKIT_WORKSPACE',
  state: 'DSH_TEAMKIT_STATE',
  log: 'DSH_TEAMKIT_LOG',
  disable: 'DSH_TEAMKIT_DISABLE',
}

/**
 * 默认值表 —— **每一项都要给"为什么是这个默认值"**（task-51 A.3 要求）。
 *
 * | 键 | 默认 | 为什么默认是这个 |
 * |---|---|---|
 * | `workspace` | `$DSH_TEAMKIT_WORKSPACE` → `process.cwd()` | cwd 是"用户在哪想用这套"的唯一无盘符信号；不猜仓名 |
 * | `dshHome` | `$DSH_HOME` → `~/.dsh` | DSH 自己的口径；`os.homedir()` 在本机是错的（LANDMINES §4 实测：它返回一个**非真实家的账户名**），故 env 优先 |
 * | `stateDir` | `<dshHome>/.teamkit` | ⚠️ **task-57 改**：**全局一份**的状态根。旧默认 `<workspace>/.teamkit` 在真宿主里等于 `process.cwd()` ⇒ 多项目串台（实测）。`.teamkit` 不在 6 个技能扫描根里（`dsh-skill-filesystem:150-188`）。**若 `$DSH_HOME` 也没给**，它会落到 `~/.dsh` —— 本机 `homedir()` 会算错（LANDMINES §4），这是**已知限制**，与 `upstream.root` 同源 |
 * | `agent.stateTemplate` | `{cwd}/.teamkit` | ⚠️ **task-57 新增**：**按 agent 分**的状态根模板。`{cwd}` = 该 agent 的 `session.header.cwd` ⇒ 每个项目、每个成员各有自己的 fork 落点。**这是修串台的正解** |
 * | `fork.perAgent` | `true` | ⚠️ **task-57 新增**：fork 落点是否按 `agent.cwd` 分。`false` = 退回旧的"跟 workspace"行为（逃生开关） |
 * | `forkRootTemplate` | `<stateDir>/forks/{member}/skills` | **全局兜底**（无 cwd 时用）。fork 只存差异；放 stateDir 下 ⇒ 永不被当上游技能 |
 * | `historyDir` | `<stateDir>/history` | **全局一份**：快照的是**上游**版本（`upstream.js:189-194` 拷的是 `st.dst` = 上游根文件）⇒ 属于上游、不属于任何成员。深度 3 已实测不污染扫描（UPSTREAM-CHANGELOG §A.2） |
 * | `changelogPath` | `<stateDir>/CHANGELOG.md` | **全局一份**：记的是**上游更新史**（`upstream.js:214` = 上游 before→after）。**不能放技能根**（实测会变成一条技能，LANDMINES §18） |
 * | `logFile` | `<stateDir>/teamkit.log` | **全局一份**：宿主级事件（APPLY / DISPOSE）只有一份；跟 cwd 走会在换项目时把日志分叉成互不相见的几份 |
 * | `upstream.root` | `$DSH_HOME/skills` | `dsh-skill-filesystem` 的 user 根（rank 400），update 的默认落点 |
 * | `upstream.sources` | `[<workspace>/skills]` | "仓内源" = 合并的来源；open-source 用户把它指向自己的技能仓 |
 * | `upstream.extraRoots` | `[<workspace>/.agents/skills, <workspace>/.dsh/skills]` | 另两个项目级上游根（rank 200/100），供**通知**监视 |
 * | `skills.enabled` | `true` | "装上就有效果"：把插件自带的 skills 装到上游根 |
 * | `fork.enabled` | `true` + `members:['*']` | 装上即给每个 roster teammate 备好一份空 fork（空 = 纯 overlay 透传，零行为变化但可见/可用） |
 * | `notify.enabled` | `true` | 上游更新通知（只对**持有覆盖**的成员推，零配置可用） |
 * | `guard.enabled` | `false` | **诚实口径**：它只是"误操作护栏"，只覆盖 `write`/`edit` 两个工具名，`pwsh` 绕得过（DECISIONS P-15/P-16）⇒ **默认关**，要真门禁的人自己开 |
 * | `e2r.enabled` | `false` | ⚠️ **task-60**：路径 A（放开工具出口 schema）是**唯一"可能打断任务板"**的能力 —— 漏放一个 scope ⇒ 那个成员一调 `team_task_list` 就报 `additionalProperties:false`（Round 95 实测）。**默认关** |
 * | `e2r.structure` | `true` | **零风险**：台账 + `description` 摘要 + 三件工具。只写我们自己的文件、只用底座**已有的** `edit` action ⇒ **装上就有效果** |
 * | `e2r.schemaPatch` | `false` | 路径 A 的**下级开关**（`enabled` 与它**都 true** 才动）。放开 4 个 team task 工具的 output schema；装完**立刻验**、验不过**整段回滚** |
 * | `e2r.trackingFile` | `e2r.jsonl` | 侧车台账（append-only；包装在内存 ⇒ 重启即失效 ⇒ 靠它重建结构）。**按 Team root 分桶** |
 */
export const DEFAULTS = {
  workspace: '',
  dshHome: '',
  stateDir: '',
  forkRootTemplate: '',
  historyDir: '',
  changelogPath: '',
  logFile: '',
  agent: {
    // ⚠️ task-57：`{cwd}` = agent.session.header.cwd。**不要**写成绝对路径 —— 它按 agent 实例化。
    stateTemplate: '{cwd}/.teamkit',
  },
  // ⚠️ task-58：`''` = **不过滤**（向后兼容；未配置时完全不影响行为）。
  preset: {
    id: '',
  },
  // ⚠️ 公司层（task-56/task-60）：角色档目录。`''` = 未配置 ⇒ 角色层**不生效**
  //    （`index.js` 会打 `ROLE-SKIPPED` 说明"这一项没生效，不是装好了"）。
  //    默认**不猜**任何绝对路径 —— 路径形状由用户/预设给（照"零硬编码"那条北极星）。
  roles: {
    dir: '',
  },
  upstream: {
    root: '',
    sources: [],
    extraRoots: [],
  },
  skills: {
    enabled: true,
    sourceDir: '',
    // 装到上游根时是否覆盖已存在的同名条（默认 false = 只补缺，不覆盖用户已有的东西）
    overwrite: false,
  },
  // 自演化位（工作原则，`talents/principles/<name>.md`）的目录。`''` = 没配 ⇒
  // `index.js` 用**候选列表**去找（从 roles.dir 逐级向上 / workspace 下），
  // 一个都没命中 ⇒ `PRINCIPLES-DIR-NOT-FOUND` 警告 + 人格段明说"还没写"（不静默）。
  principles: {
    dir: '',
  },
  fork: {
    enabled: true,
    members: ['*'],
    providerName: 'teamkit-fork',
    rank: 250,
    createDirs: true,
    // ⚠️ task-57：fork 落点是否按 agent 的 session.header.cwd 分（false = 退回旧的全局行为）
    perAgent: true,
    // fork 覆盖的条从哪读（相对 forkRoot 的 SKILL.md）
    skillFileName: 'SKILL.md',
  },
  notify: {
    enabled: true,
    minIntervalMs: 60_000,
    maxNoticeBytes: 4000,
    maxBodyExcerpt: 900,
    // 'auto' = 只跟踪"成员在 fork 里真的改过"的那些条（零配置、且只推该推的）
    tracked: 'auto',
  },
  guard: {
    enabled: false,
    writers: [],
    // 除上游根之外，额外受保护的目录（默认空）
    extraProtected: [],
  },
  // ★ **SOUL 注入**（2026-09-14 / Round 43 实现；裁定见 `DECISIONS.md` **P-08**）。
  //   一句话：让成员的**自我迭代**（"我已经答应改什么"）在**下一步**就生效，而不是等下次装配。
  //   为什么不能只靠 `principles`（已实现）：那走**系统提示词**（装配期一次性）⇒
  //     **本会话内改了不生效**；而绩效闭环（`PERF-LOOP.md` S2→S3）要求"改了 → **下一轮**复检"。
  //   ⇒ 走 `agent/pre-step` 注入 **user message**（粒度=人头、不碰提示词前缀、缓存安全）。
  soul: {
    // 默认**开**（零配置就有效果）；但没有 SOUL 文件时**什么也不做、不报错**。
    enabled: true,
    // 目录：空 ⇒ `<stateDir>/soul/`（通常 `$DSH_HOME/.teamkit/soul/<name>.md`）。
    dir: '',
    // ★★ **播种骨架**（2026-09-14 / task-101；委托方当场问「每人独立的 SOUL 做完没有？」）。
    //   现状是「**读/注入做完了，播种没做**」⇒ 本键补的就是那格：新成员一上岗**先有一份骨架**。
    //   **默认 `true`** 的三条承重前提（缺一就不该 true）：
    //     ① **幂等**：`existsSync` 短路 ⇒ 已有 SOUL 的成员 **sha 前后必须相等**（绝不覆盖）；
    //     ② **骨架不含第一人称承诺句**（那才是"替它表态"）—— 只有结构性内容 + 显式「未填」占位；
    //     ③ **失败不静默**：写不进去 ⇒ 日志明说"**没播种**"，不许当成功。
    //   ⚠️ **逃生开关**：设 `false` ⇒ 日志显式打「**未播种（显式关闭）**」（同 `probeGate` 的形态）。
    seed: true,
  },
  // ★ **成员释放**（委托方硬指令：「必须可以删」；2026-09-14 / Round 33 实现）。
  //   底座真相（`DECISIONS.md` P-34）：roster **没有移除方法**、journal **没有移除事件**
  //   ⇒ 我们**不改底座**，而是**包一层 `TeamJournal.prototype.state`**：
  //   让它返回的 `members` **过滤掉"已释放"的 id**。
  //   **为什么这能真释放名额（不是只改视图）**：`roster` 与 `journal` 是**同一个实例**
  //   （`this.roster = new TeamRoster(ctx, this.journal, …)`，
  //    `dsh-experimental-agent-team/lib/types/index.js:107`）⇒ roster 的资格检查也走被包的那层。
  //   实测（Round 33，真宿主）：`roster.journal === journal` = **true**；
  //   `TeamJournal.prototype.state` **writable+configurable** ⇒ 可安全包装与还原。
  memberRelease: {
    // ★★ **默认开**（2026-09-14 / 委托方定向：「**能够撤人的功能，要默认打开**」）。
    //   ⚠️ 这是**破坏性**动作（把人从名单里拿掉）—— 之所以仍默认开，是因为：
    //     · 底座**没有移除成员的方法**（roster 9 个公开方法里没有 remove/delete/fire）
    //       ⇒ **撤人是我们唯一的救济手段**，"招错人"否则=永久少一个名额；
    //     · 它**有三道闸**：`requireReason: true`（必须写理由）/ `unrelease_member` 可撤销 / 台账落盘。
    //   ⇒ 委托方取舍：**"我必须可以删"** 比"默认关着更安全"**更值钱**。
    enabled: true,
    // ★ **只读的 `list_zombies` 单独一档**（Round 34 修的设计缺陷）：
    //   我第一版把它挂在 `enabled` 后面 ⇒ 用户"想看一眼有没有僵尸"就得先开破坏性能力
    //   ⇒ 与"先看得见、再决定动谁"正好相反。**默认开**（它只读、零风险）。
    readonlyTools: true,
    // 侧车台账（**盘上事实**）：`journal.state` 的包装在**内存**里 ⇒ 重启即失效
    // ⇒ 靠这份台账在启动时重建"谁被释放过"。相对 `<stateDir>`。
    trackingFile: 'member-release.jsonl',
    // 强制写理由（对齐"说明是更新的一部分"这一硬门）
    requireReason: true,
    // 巡检里"长期 inactive"的阈值（只用于 `list_zombies` 的只读提示）
    staleAfterMinutes: 30,
  },
  // ★★★ **保命网**（2026-09-15 崩机事件；`plugin/lib/crash-guard.js`）。
  //   【为什么默认开】它是**唯一"装了就不会因管道断开而自杀"**的能力，
  //     而"管道断开 ⇒ 未捕获 `'error'` ⇒ 进程自杀"是**已证事实**（对照实验：**pipe 崩、TTY 不崩**）。
  //   【边界】只给 `process.stdout` / `process.stderr` 装 `'error'`，**只吞 `EOF`/`EPIPE`**；
  //     ★ **别的 error 一律重新抛**；⛔ **不装 `process.on('uncaughtException')`**。
  //   ⚠️ **它改了宿主进程的监听器** ⇒ 所以**必须进配置表**（`H25` 盯着；`DECISIONS P-34` 那条精神：
  //     **一个默认开、会改宿主进程状态的能力，用户有权知道并关掉**）。
  //   ⚠️ **诚实口径**：它**未必对症**现场的崩溃（我没能复现出 `EOF / -4095` 的签名）——
  //     它治的是**已证的那一类**（管道断开），**留着代价为零**。
  crashGuard: {
    enabled: true,
  },
  // ★ **E²R 结构与评审判决**（2026-09-14 / task-60；对应 OMC 论文的 `E_tree` 与 `q_v`）。
  //   底座**没有**这两样（`TeamTaskStatus` 只有 4 态、无 `accepted`；`TeamTaskSnapshot` 8 字段、无 parent），
  //   而三个 schema 全 `.strict()` ⇒ **写事件加字段会被拒**。
  //   ⇒ 我们**不改底座**，只做加法：台账（盘上事实）+ description 摘要 + **可选**的派生视图。
  e2r: {
    // ★★ **默认 false** —— 它是本插件里**唯一"可能打断任务板"**的能力。
    //   为什么（`lead` 2026-09-14 裁决 + 我 Round 95 实测）：`schemaPatch` 要动**底座已注册工具的
    //   output.schema**；而每个 agent 各有一份独立定义 ⇒ 一旦漏放某个 scope，
    //   那个成员一调 `team_task_list` 就报 `additionalProperties: false`（**整个任务板工具报错**）。
    //   ⇒ "用得越多越坏"的形态，**不适合默认开**。
    //   ⚠️ 注意：**B（台账）与 C（description 摘要）与 `structure` 工具不受它管**，
    //     那三样**默认就开**（零风险）—— 见下面 `structure`。
    enabled: false,
    // ★ **默认 true**：台账 + description 摘要 + 三件工具（`set_task_structure` / `review_task`
    //   / `team_structure`）。**零风险**：只写我们自己的文件、只用底座**已有的** `edit` action，
    //   **一个字节都不碰底座 schema**。委托方要的"板上看得见结构"靠它就能达成
    //   （`description` 是底座 `TeamTaskView` 的 **declared property**，本来就在 `team_task_list` 里）。
    structure: true,
    // ★ **默认 false**：路径 A（包**own** `taskView` + 单点包 `tools.view` 放开出口 schema）。
    //   开了也**不保证装上** —— `apply()` 会**先探测、装完立刻验、验不过整段回滚**
    //   （见 `e2r.js` 头部 §绝不半装）。**它是 `enabled` 的下级开关：两个都 true 才动。**
    schemaPatch: false,
    // 侧车台账（**盘上事实**：包装在内存里 ⇒ 重启即失效 ⇒ 靠这份台账重建"结构"）。相对 `<stateDir>`。
    // append-only JSONL，**按 Team root 分桶**（任务 id 是 per-Team 的，全局一份会跨队外溢）。
    trackingFile: 'e2r.jsonl',
  },
  // ★★ **探针闸门（R2 在线拦）** —— 2026-09-14 / task-92（CEO 批方案②）。
  //   一句话：**装 `dev_stage_add` 之前必过闸**，违规（往"会被持久化的共享对象"写字段/改原型且无回读校验）⇒ **拒装**。
  //   承重口：底座自带、**文档化**的 `ctx.tools.guard()`（`dsh-tools/lib/index.js:2816-2821`），
  //   返回**字符串**即拒绝该次调用（`:3127-3139` 包成 `Error: <reason>`）。
  probeGate: {
    // ★★ **默认 `true`** —— 委托方两条口径的交点：
    //   · 「**装上不生效 = 假机制**」⇒ 默认必须开；
    //   · 「**谨慎 ≠ 停摆**」⇒ 开的前提是**不误杀正常开发**（见下"四个前置条件"）。
    //   四个前置条件（缺一不可，`selftest` 的 `H48` 组逐条断言）：
    //     ① 只对 `dev_stage_add` 生效 ⇒ 对任何其它工具**零影响**；
    //     ② **不许抛异常**；③ 拒绝理由**自带修法**；④ **有逃生开关**（就是本键）。
    //
    // ⚠️⚠️ **生效范围按挂载方式而定 —— 不是"全宿主"**（**真读数推翻了我先前的读码推断**）。
    //   **留痕**：本段原先写「它落 global 层 ⇒ 对全宿主所有 agent 生效」—— **那是推断，已被推翻**。
    //   **真宿主实测**（`engineering-director` 在活宿主里真调 `tools.guardReason`，非读码）：
    //     `tools.layers.global.guards` = **[]（空）**；本闸实际落在 **`{"agentPreset":"omc"}`** 那层；
    //     逐 agent 结果：`closedloop-full` root **被拦** / `standard` 的 root 与两个 child **都没被拦**。
    //   ⇒ **准确说法**：本闸只覆盖**挂载它的那个 preset realm**（当前 `omc`）。
    //   ⚠️ **已知缺口（开源前要写出来）**：**`standard` 成员的坏探针目前没人拦**。
    //   ⬜ `closedloop-full` 为何被拦 = **未获取**（有读数但解释不了，不编）。
    //   ⬜ **待验**：`dev_inject_plugin` 注入形态可能落 global ⇒ **两种装载方式各真调一次对照**。
    // ⚠️ **liveness**：`guardReason` 在**每一次**被允许的工具调用上都会被调（不管落哪层 ⇒ 都在热路径）
    //   ⇒ guard 里**第一行 O(1) 短路、不 await、不读盘、不抛、fail-open**（否则误杀 = 该链上停摆）。
    enabled: true,
  },
}

/** 把 `~`、`${ENV}`、相对路径解析成绝对路径。**不含任何盘符假设。** */
export function expand(input, { workspace, env }) {
  if (typeof input !== 'string' || input === '') return input
  let out = input
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(1))
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const key = a ?? b
    const v = env[key]
    return v === undefined ? m : v
  })
  // ⚠️ **两条都要走 `resolve`**：环境变量插值常常带 `/`（如 `${DSH_HOME}/sub`），
  // 而 Windows 上 `C:\a/b` 与 `C:\a\b` **字符串不相等** ⇒ 只判 `isAbsolute` 就返回，
  // 会让"同一个路径"在不同的比较里变成两个值（自测 A 组抓到的：`${DSH_HOME}/sub` ≠ `join(home,'sub')`）。
  return isAbsolute(out) ? resolve(out) : resolve(workspace, out)
}

/**
 * 解析最终配置（**纯函数**：输入 raw config + 环境，输出冻结的绝对路径表）。
 * @param raw 用户配置（profile patch / loader.create 传入；缺省 = `{}`）
 * @param opts.workspace 覆盖 workspace（测试用）
 * @param opts.env 环境（测试用）
 * @param opts.cwd 默认 workspace 的来源
 * @param opts.pluginDir 本包目录（用于定位自带 skills）
 */
export function resolveAll(raw = {}, opts = {}) {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const pluginDir = opts.pluginDir

  const workspace = resolve(
    opts.workspaceRaw ??
      raw.workspace ??
      opts.workspace ??
      env[ENV.workspace] ??
      cwd,
  )
  const dshHome = resolve(
    raw.dshHome ?? env[ENV.home] ?? join(homedir(), '.dsh'),
  )
  const ctx = { workspace, env }

  // ⚠️ task-57：`stateDir` 是**全局一份**的状态根（history / CHANGELOG / log 都在它下面）。
  // 旧默认 `<workspace>/.teamkit` 在真宿主里 = `process.cwd()` ⇒ **多项目串台**（实测缺陷）。
  // 新默认 `<dshHome>/.teamkit`：与 `upstream.root`（`$DSH_HOME/skills`）**同源** ⇒
  // "全局的东西都跟着 DSH_HOME 走，按成员的东西跟着 agent.cwd 走"这条分界才自洽。
  const stateDir = expand(raw.stateDir || env[ENV.state] || join(dshHome, '.teamkit'), ctx)
  const agentStateTemplate = raw.agent?.stateTemplate || DEFAULTS.agent.stateTemplate
  const expanded = {
    workspace,
    dshHome,
    stateDir,
    agent: {
      stateTemplate: agentStateTemplate,
    },
    // ⚠️ task-58：必须**暴露给调用方**（只在 SHAPE 里注册 = 只校验、不可达 ⇒ 设计无效）。
    // `''` = 不过滤。调用方按 `paths.preset.id` 判断"我这次挂载属于哪个预设"。
    preset: {
      id: raw.preset?.id ?? DEFAULTS.preset.id,
    },
    // ⚠️ 公司层：角色档目录。同样**必须暴露**（`index.js` 优先读 `paths.roles.dir`）。
    // `''` = 未配置 ⇒ 角色层不生效（`ROLE-SKIPPED` 会说明，不静默）。
    roles: {
      dir: raw.roles?.dir ?? DEFAULTS.roles.dir,
    },
    forkRootTemplate: expand(raw.forkRootTemplate || join(stateDir, 'forks', '{member}', 'skills'), ctx),
    historyDir: expand(raw.historyDir || join(stateDir, 'history'), ctx),
    changelogPath: expand(raw.changelogPath || join(stateDir, 'CHANGELOG.md'), ctx),
    logFile: expand(raw.logFile || env[ENV.log] || join(stateDir, 'teamkit.log'), ctx),

    upstream: {
      root: expand(raw.upstream?.root || join(dshHome, 'skills'), ctx),
      sources: (raw.upstream?.sources?.length ? raw.upstream.sources : [join(workspace, 'skills')])
        .map((p) => expand(p, ctx)),
      extraRoots: (raw.upstream?.extraRoots ?? [
        join(workspace, '.agents', 'skills'),
        join(workspace, '.dsh', 'skills'),
      ]).map((p) => expand(p, ctx)),
    },

    skills: {
      enabled: raw.skills?.enabled ?? DEFAULTS.skills.enabled,
      sourceDir: expand(raw.skills?.sourceDir || (pluginDir ? join(pluginDir, 'skills') : join(workspace, 'skills')), ctx),
      overwrite: raw.skills?.overwrite ?? DEFAULTS.skills.overwrite,
    },
    // 自演化位目录。**必须暴露**（`index.js` 优先读 `paths.principles.dir` —— 显式配置比候选推导稳）。
    principles: {
      dir: expand(raw.principles?.dir ?? DEFAULTS.principles.dir, ctx),
    },

    fork: {
      enabled: raw.fork?.enabled ?? DEFAULTS.fork.enabled,
      members: raw.fork?.members?.length ? raw.fork.members : DEFAULTS.fork.members,
      providerName: raw.fork?.providerName || DEFAULTS.fork.providerName,
      rank: raw.fork?.rank ?? DEFAULTS.fork.rank,
      createDirs: raw.fork?.createDirs ?? DEFAULTS.fork.createDirs,
      perAgent: raw.fork?.perAgent ?? DEFAULTS.fork.perAgent,
      skillFileName: raw.fork?.skillFileName || DEFAULTS.fork.skillFileName,
    },

    notify: {
      enabled: raw.notify?.enabled ?? DEFAULTS.notify.enabled,
      minIntervalMs: raw.notify?.minIntervalMs ?? DEFAULTS.notify.minIntervalMs,
      maxNoticeBytes: raw.notify?.maxNoticeBytes ?? DEFAULTS.notify.maxNoticeBytes,
      maxBodyExcerpt: raw.notify?.maxBodyExcerpt ?? DEFAULTS.notify.maxBodyExcerpt,
      tracked: raw.notify?.tracked?.length ? raw.notify.tracked : DEFAULTS.notify.tracked,
    },

    guard: {
      enabled: raw.guard?.enabled ?? DEFAULTS.guard.enabled,
      writers: raw.guard?.writers ?? DEFAULTS.guard.writers,
      extraProtected: (raw.guard?.extraProtected ?? DEFAULTS.guard.extraProtected).map((p) => expand(p, ctx)),
    },

    soul: {
      enabled: raw.soul?.enabled ?? DEFAULTS.soul.enabled,
      dir: raw.soul?.dir ? expand(raw.soul.dir, ctx) : DEFAULTS.soul.dir,
      // ★ 播种（task-101）：**必须暴露给调用方**（只注册进 SHAPE = 只校验、不可达 ⇒ 设计无效）。
      seed: raw.soul?.seed ?? DEFAULTS.soul.seed,
    },

    memberRelease: {
      enabled: raw.memberRelease?.enabled ?? DEFAULTS.memberRelease.enabled,
      trackingFile: raw.memberRelease?.trackingFile || DEFAULTS.memberRelease.trackingFile,
      requireReason: raw.memberRelease?.requireReason ?? DEFAULTS.memberRelease.requireReason,
      readonlyTools: raw.memberRelease?.readonlyTools ?? DEFAULTS.memberRelease.readonlyTools,
      staleAfterMinutes: raw.memberRelease?.staleAfterMinutes ?? DEFAULTS.memberRelease.staleAfterMinutes,
    },

    // ★★ **保命网**（2026-09-15）：**必须在这里显式暴露** ——
    //   我第一版只在 `index.js` 里写 `paths.crashGuard?.enabled !== false` ⇒
    //   `paths.crashGuard` 恒 `undefined` ⇒ **靠"undefined !== false"碰巧为真** ⇒
    //   ★ **那不是设计，是语言特性**（且它不在配置表里 ⇒ 用户不知道有这个开关）。
    crashGuard: {
      enabled: raw.crashGuard?.enabled ?? DEFAULTS.crashGuard.enabled,
    },

    // ★ E²R（task-60）：结构与评审判决。**三个字段都要暴露**给调用方
    //   （只注册进 SHAPE = 只校验、不可达 ⇒ 设计无效，与 `preset.id` 那条同一个坑）。
    e2r: {
      enabled: raw.e2r?.enabled ?? DEFAULTS.e2r.enabled,
      structure: raw.e2r?.structure ?? DEFAULTS.e2r.structure,
      schemaPatch: raw.e2r?.schemaPatch ?? DEFAULTS.e2r.schemaPatch,
      trackingFile: raw.e2r?.trackingFile || DEFAULTS.e2r.trackingFile,
    },

    // ★ **探针闸门**（task-92）：`enabled` 必须**暴露给调用方**（只注册进 SHAPE = 只校验、不可达 ⇒ 设计无效）。
    probeGate: {
      enabled: raw.probeGate?.enabled ?? DEFAULTS.probeGate.enabled,
    },
  }
  // `forkRootTemplate` 是模板：只有 `{member}` 之外的部分才是目录
  expanded.forkRootTemplate = expanded.forkRootTemplate.replace(/\{member\}/g, '{member}')
  return expanded
}

/**
 * ★ **从"已安装的预设"里捞回本插件的配置**（2026-09-14 / Round 16）。
 *
 * ## 为什么需要（实测事故）
 * `dev_reload_package` 热重载重建的实例**读不到预设里的 `config`**，而**新建会话不会重新 apply 插件**
 * ⇒ 剩下的实例是**裸实例**：`preset.id` / `roles.dir` 全是空 ⇒ 它**仍接管成员，却给不出角色**：
 * ```
 * FORK-REGISTER-OK member=coo dir=…\forks\6ac4f43a\coo\skills
 * ROLE-SKIP        member=coo why=no-role（该成员名没有角色档）   ← 其实角色档在（729B）
 * ```
 * ## 做法
 * 扫 `$DSH_HOME/.agent-presets/*`，找**引用本包**（`agent.cordis.yml` 里含 `pkgName`）的那个预设，
 * 从它里面读：
 *   · `preset:\n  id: <x>`  ⇒ `presetId`
 *   · `roles:\n  dir: !!js <expr>` ⇒ 求值得到 `rolesDir`
 * `!!js` 用**与 DSH 同一套语义**求值（`cordis-plugin-loader:289`
 * `new Function("ctx","expr","with(ctx){return eval(expr)}")`）。
 *
 * ## 纪律
 * · **只读**（绝不写用户预设）；
 * · **不写死预设名**（找"引用本包"的那个）⇒ 与"随包分发哪个预设"解耦；
 * · **读不到就返回空**（`{presetId:undefined, rolesDir:''}`）——**不猜、不假装有**；
 * · 全程 try/catch（`agent/created` 是同步 emit，抛错会否决 agent 发布）。
 *
 * @param dshHome `$DSH_HOME`
 * @param pkgName 本包名（用来判"这个预设引用了我们"）
 * @param env 环境变量表（`!!js` 求值用）
 */
export function recoverFromInstalledPreset(dshHome, pkgName, env = process.env) {
  const empty = { presetId: undefined, rolesDir: '', upstreamRoot: '', customSkillDirs: [], presetFile: undefined }
  try {
    if (typeof dshHome !== 'string' || dshHome === '') return empty
    const root = join(dshHome, '.agent-presets')
    if (!existsSync(root)) return empty
    let dirs = []
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return empty
    }
    // `!!js` 求值器（与 DSH loader 同一套语义：`cordis-plugin-loader:289`）
    const evalJs = (expr) => {
      try {
        // eslint-disable-next-line no-new-func
        const f = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
        const v = f({ process: { env } }, expr)
        return typeof v === 'string' && v !== '' ? v : undefined
      } catch {
        return undefined
      }
    }
    for (const name of dirs.sort()) {
      const file = join(root, name, 'agent.cordis.yml')
      if (!existsSync(file)) continue
      let raw = ''
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (typeof pkgName === 'string' && pkgName !== '' && !raw.includes(pkgName)) continue
      const mId = /preset:\s*\n\s*id:\s*([^\s#]+)/.exec(raw)
      const presetId = mId ? mId[1].replace(/^['"]|['"]$/g, '') : name
      const rolesDir = (() => {
        const m = /roles:\s*\n\s*dir:\s*!!js\s+([^\n]+)/.exec(raw)
        return m ? (evalJs(m[1].trim()) ?? '') : ''
      })()
      // ★★ **`upstream.root` 也必须捞**（2026-09-14 / Round 17 —— 我 Round 16 漏了它）。
      //   为什么关键：`upstream.root` 是**写路径**（`promote` 合并 / 快照 / CHANGELOG / "上游变了"的判据），
      //   而**读路径**由预设里 `skill-filesystem` 的 `customSkillDirs` 决定。
      //   **两者不同指 ⇒ 上游链断开**（本项目 Round 5 实测过：成员 promote 上去后自己和队友都看不到，
      //   **且不报错**）。Round 16 我只捞了 `presetId`/`rolesDir` ⇒ 裸实例的 `upstream.root`
      //   仍是默认 `$DSH_HOME/skills`，而 omc 的读路径是 `$DSH_HOME/teamkit/skills-upstream`
      //   ⇒ **又是读写不同指**（本轮实测的 `APPLY {upstreamRoot:"…\\.dsh\\skills"}` 就是它）。
      const mUp = /upstream:\s*\n\s*root:\s*!!js\s+([^\n]+)/.exec(raw)
      const upstreamRoot = mUp ? (evalJs(mUp[1].trim()) ?? '') : ''
      // 顺带把读路径也捞出来（用于**自查"读写是否同指"**，不参与写）
      //
      // ⚠️ 解析要**只吃列表项**：我第一版用 `customSkillDirs:\s*\n((?:\s*#[^\n]*\n|\s*-\s*[^\n]+\n)+)`
      //   会把**下一个顶层键**（`- id: tool-skill`）也当成列表项吃进来（实测：
      //   `customSkillDirs=["…skills-upstream","id: tool-skill"]`）。
      //   ⇒ 改成**逐行扫，遇到"不像列表项/不是缩进注释"的行就停**，并且**只收"像路径"的值**
      //     （含 `/` 或 `\` 或以 `~`/`!!js` 开头）—— 顶层 `- id:` 只有名字，没有分隔符，天然被排除。
      const customSkillDirs = []
      const lines = raw.split('\n')
      let inCustom = false
      for (const line of lines) {
        if (/^\s*customSkillDirs:\s*$/.test(line)) { inCustom = true; continue }
        if (!inCustom) continue
        if (/^\s*#/.test(line)) continue                       // 块内注释
        if (/^\s*-\s+/.test(line)) {
          const v = line.replace(/^\s*-\s+/, '').trim()
          if (v.startsWith('!!js ')) {
            const got = evalJs(v.slice(5).trim())
            // ⚠️ 只收"像路径"的求值结果（`!!js` 也可能是别的表达式）
            if (got !== undefined && /[\\/]/.test(got)) customSkillDirs.push(got)
          } else {
            const lit = v.replace(/^['"]|['"]$/g, '')
            if (/[\\/~]/.test(lit)) customSkillDirs.push(lit)
          }
          continue
        }
        if (line.trim() === '') continue                       // 空行容忍
        break                                                   // 其它顶层键 ⇒ 列表结束
      }
      return {
        presetId: presetId === '' ? undefined : presetId,
        rolesDir,
        upstreamRoot,
        customSkillDirs,
        presetFile: file,
      }
    }
    return empty
  } catch {
    return empty
  }
}

/** 把 `{member}` 模板实例化。成员名做**白名单化**，避免路径穿越。 */
export function forkRootFor(paths, member, opts = {}) {
  // 只留 `[A-Za-z0-9_-]`（点也去掉 —— 这样 `..` / `.` 这两种"目录自指"名字不可能出现，
  // 路径穿越从字符集上就不可能，而不是靠"后面再检查一下"）。
  const safe = String(member).replace(/[^A-Za-z0-9_-]/g, '_') || '_'
  const template = forkRootTemplateFor(paths, opts)
  return template.replace(/\{member\}/g, safe)
}

// ── task-57：**按 agent 分**的落点（修"多项目串台"的正解）────────────────────
// 为什么必须有这一段：`apply()` 在宿主启动时**只跑一次**，那一刻**算不出用户的项目是哪个**
// （真 `dsh web` 的 `process.cwd() = D:\dsh`，而成员各自的 cwd 各不相同）。
// 而每个 agent 都带自己的 `session.header.cwd` ⇒ **按 agent 派生的部分要留到 `agent/created`**。
// 设计纪律：**全局一份的留在 `apply()` 时定；按 agent 分的在 `agent/created` 时定**。

/**
 * 读一个 agent 的会话 cwd。**防御式：任何异常都返回 `undefined`，绝不外抛**
 * （`agent/created` 是同步 emit，抛错会否决 agent 发布 —— `dsh-agent` runtime-types 原文）。
 * @returns 绝对路径字符串，或 `undefined`（拿不到）
 */
export function agentCwdOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * 某 agent 的**状态根**（按 agent 分）。`{cwd}` 由 `agent.session.header.cwd` 填。
 *
 * 三态（**这是"缺失时有没有兜底"的判据**）：
 *  · 有 cwd            ⇒ `<cwd>/.teamkit`（**按项目分开**）
 *  · cwd 为空/缺失      ⇒ **兜底到全局 `paths.stateDir`**（= `<dshHome>/.teamkit`）
 *  · `fork.perAgent=false` ⇒ 强制全局（用户显式关掉分项目）
 *
 * ⚠️ **兜底是"设计"、不是"实测"**：本函数在无 cwd 时返回全局 stateDir **而不是抛错**，
 * 代价是**缺失会被静默吸收**（旧行为）。⇒ 调用方应当把 `agentCwdOf(agent) === undefined`
 * 作为**可观察信号**记进日志（否则"该分而没分"看不见 —— LANDMINES §9 的同族）。
 */
export function stateDirForAgent(paths, agent) {
  if (paths?.fork?.perAgent === false) return paths.stateDir
  const cwd = agentCwdOf(agent)
  if (cwd === undefined) return paths.stateDir
  const tpl = paths?.agent?.stateTemplate ?? DEFAULTS.agent.stateTemplate
  // `{cwd}` 是**绝对路径**替换；其余部分走和别的键一样的展开规则（`~` / `${ENV}` / 相对）
  const expanded = expand(tpl.replace(/\{cwd\}/g, resolve(cwd)), { workspace: paths.workspace, env: process.env })
  return expanded
}

/**
 * 该 agent 的 fork 根模板（`{member}` 槽位未填）。
 * 拿不到 cwd ⇒ 退回**全局** `paths.forkRootTemplate`（旧行为，向后兼容）。
 *
 * ⚠️⚠️ **2026-09-14（Round 14）：这里多了一层 `{team}` —— 修一个实测的真缺陷。**
 *
 * 【缺陷】原来的落点是 `<stateDir>/forks/{member}/skills`，**只按成员名**。
 *   而 DSH 的成员名是 **per-Team** 的（`roster` 属于 Team root = Lead 会话），**不是全局唯一**。
 *   ⇒ 同一个工作区里**两个 Team 各有一个 `engineer`** 时，两者**撞同一个 fork 目录**：
 *     · 后写的那个覆盖先写的 ⇒ **A 队成员改了 fork，B 队成员"跟着变"**（互相污染）；
 *     · 而 `memberNameOf()` 只信 `tryMembership` ⇒ 插件把 provider 装给**它认的那个** engineer，
 *       另一个 Team 的 engineer **看不到自己刚写的 fork**（读了不生效）。
 *   【实测】`engineer`（我队，`agentPreset=standard`，agent `7f730a12`）写了自己的 fork，
 *     而 provider 被装在 `da5e63cc`（另一个 Team，`agentPreset=omc`）身上 ⇒ 它调 `skill` 拿到的
 *     仍是上游版（`Base directory` 指 `$DSH_HOME/skills/...`），**自己写的 fork 完全不生效**。
 *
 * 【修法】**在路径里加一层 Team 判别**（`{team}`）：
 *   `<stateDir>/forks/<team>/<member>/skills`。
 *   `{team}` 取该 agent 的 **Team root**（`session.header.parentSession` = 它所属 Team 的 Lead 会话 id），
 *   取前 8 位做 slug。**拿不到 ⇒ `'default'`**（单 Team 场景行为稳定，且不会路径穿越）。
 *
 * 【为什么把 `{team}` 在**这里**烘焙掉，而不是让 `forkRootFor` 再收一个参数】
 *   `fork.js` / `notify.js` 里是**两参**调用 `forkRootFor(paths, member)`
 *   （`fork.js:135`/`:208`、`notify.js:136`）。若把 `{team}` 留到那两处填，
 *   就要**同时**改三处、并保证它们拿到**同一个** agent —— 那正是 `LANDMINES` 记过的"半接线"陷阱
 *   （只改 fork、没改 notify ⇒ `tracked=0`、通知静默全死）。
 *   ⇒ 在这个**唯一**派生 per-agent paths 的函数里烘焙掉，三处调用**天然一致**。
 */
export function forkRootTemplateFor(paths, opts = {}) {
  const agent = opts.agent
  if (agent === undefined || paths?.fork?.perAgent === false) return paths.forkRootTemplate
  const cwd = agentCwdOf(agent)
  if (cwd === undefined) return paths.forkRootTemplate
  const stateDir = stateDirForAgent(paths, agent)
  return join(stateDir, 'forks', teamSlugOf(agent), '{member}', 'skills')
}

/**
 * 该 agent 所属 **Team 的判别 slug**（用于把 fork 目录按 Team 分开）。
 *
 * 依据：Team 的 root 是**Lead 会话**，而成员的 `session.header.parentSession` 就指向它
 * （实测：`engineer`(7f730a12) → `parentSession=session-fa986645…`；
 *  另一个 Team 的 `engineer`(da5e63cc) → `parentSession=session-1cdd6ee8…`）。
 *
 * ⚠️ **拿不到就返回 `'default'`**（不是抛错）：
 * `agent/created` 是**同步 emit**，抛错会否决 agent 发布。拿不到只是"这一层分不开"，
 * 单 Team 场景下与旧行为等价 ⇒ **降级安全**。
 * 返回的字符集与成员名同样白名单化（防路径穿越）。
 */
export function teamSlugOf(agent) {
  try {
    const raw = agent?.session?.header?.parentSession ?? agent?.session?.header?.teamRoot
    if (typeof raw !== 'string' || raw === '') return 'default'
    // `session-1cdd6ee8-dae1-…` → `1cdd6ee8`（够区分，且短、好读）
    const compact = raw.replace(/^session-/, '').split('-')[0]
    const safe = compact.replace(/[^A-Za-z0-9_-]/g, '')
    return safe === '' ? 'default' : safe
  } catch {
    return 'default'
  }
}

/**
 * 一个 agent 的 fork 落点（**含 Team 层**）。给需要"先知道目录再读"的调用方用
 * （如迁移检查 / 诊断打印）。`forkRootFor` 仍是唯一实例化入口。
 */
export function forkRootForAgentV2(paths, agent, member) {
  return forkRootFor(paths, member, { agent })
}

/**
 * **迁移探测**：旧布局（`<stateDir>/forks/<member>/skills`，无 Team 层）里**有内容**时，
 * 返回那些成员名 —— 调用方据此**提示用户迁移**（不自动搬：搬错方向比不动更糟）。
 *
 * 为什么需要它：本次改动**改变了 fork 的落点**。存量用户升级后，
 * 他们的 fork（成员自己改过的技能）**还躺在旧路径** ⇒ 若不提示，就会表现成"我的改动突然全没了"
 * （而新路径是空的 ⇒ 静默回到纯上游）。
 *
 * ⚠️ **`stateDir` 必须显式传**：本项目的 fork 在**按 agent 分的** stateDir 下
 * （`<cwd>/.teamkit`，见 `stateDirForAgent`），**不是**全局 `paths.stateDir`。
 * 我第一版用 `paths.stateDir`（全局）⇒ 实测**探不到**本项目那份存量 fork（假阴性）。
 *
 * @param stateDir 要探测的**状态根**（应传 `stateDirForAgent(paths, agent)`）
 * @param members 成员名列表
 * @returns `[{member, legacy}]`（只含"旧目录里真有 SKILL.md 条目"的）
 */
export function detectLegacyForks(stateDir, members) {
  const out = []
  try {
    if (typeof stateDir !== 'string' || stateDir === '') return out
    for (const m of (Array.isArray(members) ? members : [])) {
      const safe = String(m).replace(/[^A-Za-z0-9_-]/g, '_') || '_'
      const legacy = join(stateDir, 'forks', safe, 'skills')
      if (!existsSync(legacy)) continue
      let hasContent = false
      try {
        hasContent = readdirSync(legacy, { withFileTypes: true })
          .some((e) => e.isDirectory() && existsSync(join(legacy, e.name, 'SKILL.md')))
      } catch {
        hasContent = false
      }
      if (hasContent) out.push({ member: String(m), legacy })
    }
  } catch {
    /* 探测失败不影响主流程 */
  }
  return out
}

/**
 * 按 agent 实例化 fork 落点。**`{cwd}`/`{member}` 都填好**，返回绝对路径。
 * 这是 `fork.js` / `notify.js` 该用的那个 —— 现有两参 `forkRootFor` 保持向后兼容。
 */
export function forkRootForAgent(paths, agent, member) {
  return forkRootFor(paths, member, { agent })
}

/**
 * 按 agent 派生**整套**路径表（fork 相关的部分按 agent 分；上游/全局部分继承）。
 * 给 `installForkFor` / `makeNotifier` 用：它们只需要 `paths` + 该 agent 的 cwd。
 * @returns 新的 paths（浅拷贝 + 覆盖 fork 相关字段）；**无 cwd 时逐字返回原 `paths`**
 */
export function pathsForAgent(paths, agent) {
  const cwd = agentCwdOf(agent)
  if (cwd === undefined || paths?.fork?.perAgent === false) return paths
  const stateDir = stateDirForAgent(paths, agent)
  return {
    ...paths,
    agentCwd: resolve(cwd),
    agentStateDir: stateDir,
    forkRootTemplate: forkRootTemplateFor(paths, { agent }),
  }
}

// ── 配置校验：手写 `~standard` 形状，零依赖 ────────────────────────────────
// cordis 的 `resolveConfig`（`cordis\lib\index.js:955-963`）只做三件事：
//   `Config["~standard"].validate(config)` → 有 `then` 就报"不支持异步" → 有 `issues` 就抛
//   → 否则用 `result.value`。所以**不必依赖 schemastery**，给一个同形状对象即可。
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * schema 表：`键 → 期望类型码`。写成表而不是一串 if：**校验规则与配置表一一对应**，改配置时改一处。
 * 类型码（全是字符串 —— 这样"嵌套对象"与"数值下界"不会互相混淆，
 * ⚠️ 第一版我用 `{num: min}` 当对象写，结果被当成"嵌套对象" ⇒ 合法的 `minIntervalMs: 0` 被判非法；自测 A 组抓到的）：
 *   `'str'` / `'bool'` / `'str[]'` / `'auto|str[]'` / `'num>=<下界>'` / 嵌套对象 = 子表
 */
const SHAPE = {
  workspace: 'str',
  dshHome: 'str',
  stateDir: 'str',
  forkRootTemplate: 'str',
  historyDir: 'str',
  changelogPath: 'str',
  logFile: 'str',
  agent: { stateTemplate: 'str' },
  // ⚠️ task-58（`upstream-keeper`）用的键：**「我这次挂载属于哪个预设」**。
  // 语义：`preset.id` 未配置 ⇒ **不过滤**（向后兼容）；配了 ⇒ 只接管
  // `composedPreset(agent.ctx) === preset.id` 的成员。
  // **可缺省**：`check()` 对 `undefined` 直接 `continue` ⇒ 不写就完全不影响现有行为。
  // 必须在这里注册 —— 否则顶层未知键检查会把它判成"打错了"（task-57 那个严格性修复的直接后果）。
  preset: { id: 'str' },
  // 公司层：角色档目录（task-56 的 `roles/*.json`）。**可缺省** —— 不写就不生效（不是错）。
  roles: { dir: 'str' },
  upstream: { root: 'str', sources: 'str[]', extraRoots: 'str[]' },
  skills: { enabled: 'bool', overwrite: 'bool', sourceDir: 'str' },
  // 自演化位目录（`talents/principles`）。**可缺省** —— 不写就用候选列表推；写了就最优先。
  principles: { dir: 'str' },
  fork: { enabled: 'bool', createDirs: 'bool', perAgent: 'bool', members: 'str[]', rank: 'num>=0', providerName: 'str', skillFileName: 'str' },
  notify: { enabled: 'bool', minIntervalMs: 'num>=0', maxNoticeBytes: 'num>=64', maxBodyExcerpt: 'num>=0', tracked: 'auto|str[]' },
  guard: { enabled: 'bool', writers: 'str[]', extraProtected: 'str[]' },
  soul: { enabled: 'bool', dir: 'str', seed: 'bool' },
  memberRelease: { enabled: 'bool', readonlyTools: 'bool', trackingFile: 'str', requireReason: 'bool', staleAfterMinutes: 'num>=0' },
  // ⚠️ **E²R（task-60）**：三个键**都要在 SHAPE 里注册** —— 否则顶层未知键检查会把它们判成"打错了"
  //   （`{ e2r: { enabled: true } }` 会被静默接受 ⇒ 用户以为改了、其实没生效，那正是 B.4 要防的）。
  e2r: { enabled: 'bool', structure: 'bool', schemaPatch: 'bool', trackingFile: 'str' },
  // ⚠️ **探针闸门**（task-92）：`enabled` 要在 SHAPE 里注册 —— 否则顶层未知键检查会把 `probeGate` 判成"打错了"。
  probeGate: { enabled: 'bool' },
}

function check(raw, issues, shape = SHAPE, path = '') {
  const at = (k) => (path ? `${path}.${k}` : k)
  for (const [k, spec] of Object.entries(shape)) {
    const v = raw?.[k]
    if (v === undefined) continue
    const p = [at(k)]
    if (typeof spec === 'object') {
      if (!isPlain(v)) issues.push({ message: '必须是对象', path: p })
      else check(v, issues, spec, at(k))
      continue
    }
    if (spec.startsWith('num>=')) {
      const min = Number(spec.slice(5))
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
        issues.push({ message: `必须是 >= ${min} 的数字`, path: p })
      }
      continue
    }
    switch (spec) {
      case 'str':
        if (typeof v !== 'string') issues.push({ message: '必须是字符串', path: p })
        break
      case 'bool':
        if (typeof v !== 'boolean') issues.push({ message: '必须是布尔值', path: p })
        break
      case 'str[]':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          issues.push({ message: '必须是字符串数组', path: p })
        }
        break
      case 'auto|str[]':
        if (v !== 'auto' && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
          issues.push({ message: "必须是 'auto' 或字符串数组", path: p })
        }
        break
      default:
        issues.push({ message: `内部错误：未知的类型码 ${JSON.stringify(spec)}（这是插件自己的 bug，不是你的配置错）`, path: p })
    }
  }
  // 未识别的键 = 打错了。**必须报**（"失败不静默"：不认识的键会静默无效，
  // 用户会以为改了配置却什么也没发生 —— 那正是 task-51 B.4 要防的）。
  // ⚠️ **task-57 修正**：旧实现只查顶层（`if (path === '')`），而它的注释说"嵌套表的未知键由各自的
  //    SHAPE 管" —— **那句话是错的**：嵌套 SHAPE 当时也只遍历自己认识的键，**同样不查未知键**。
  //    实况（本任务探针 E 组抓到）：`{ agent: { stateTemplat: 'x' } }`（少一个 e）**被静默接受** ⇒
  //    用户以为改了 `stateTemplate`，其实一个字都没生效。⇒ 改成**每一层都查**。
  for (const k of Object.keys(raw ?? {})) {
    if (!Object.hasOwn(shape, k)) {
      issues.push({ message: '未知的配置键（打错了？本插件不认识的键会静默无效，所以这里报错）', path: [at(k)] })
    }
  }
}

/** 标准 schema 包装：与 cordis `resolveConfig` 兼容的最小形状。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-teamkit',
    /** @returns `{ value }` 或 `{ issues }`（严格同步，与 cordis 一致）。 */
    validate(input) {
      if (input !== undefined && !isPlain(input)) {
        return { issues: [{ message: '配置必须是对象', path: [] }] }
      }
      const raw = input ?? {}
      const issues = []
      check(raw, issues)
      if (issues.length > 0) return { issues }
      return { value: raw }
    },
  },
}
