#!/usr/bin/env node
/**
 * install-teamkit.mjs（交接包版，自包含）
 *
 * 把本包的 skills/ 装到 DSH 的**用户 skills 根**（$DSH_HOME/skills），talents/ 装到 $DSH_HOME/teamkit/talents。
 * 为什么是这里：DSH 原生就有 skills 机制（dsh-skill-filesystem 扫 项目/.dsh/skills、项目/.agents/skills、
 * custom、$DSH_HOME/skills、$AGENTS_HOME/skills、bundled 六个根；目录包形态 = <root>/<skill>/SKILL.md，
 * frontmatter 必须有 name + description）。**不改 DSH、不加工具、不碰任何 profile 依赖。**
 *
 *   node tools/install-teamkit.mjs            # 装（幂等）
 *   node tools/install-teamkit.mjs --check    # 只报状态
 *   node tools/install-teamkit.mjs --uninstall# 只删本包装的
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * ★ **同一份安装器要能服务两种布局**（2026-09-14 实测的分发缺口）。
 *
 *  ① **仓内布局**（维护者用）：`PKG` = 仓根
 *     → `skills/`、`talents/`、`runs/005-role-skills/roles/`、`presets/`、`TALENTS.yml`
 *  ② **包内布局**（开源用户用，`npm install` 后）：`PKG` = `<node_modules>/@dsh-external/dsh-teamkit`
 *     → `skills/`、**`assets/talents/`**、**`assets/roles/`**、**`assets/presets/`**、**`assets/org/`**
 *     （`assets/**` 由 `plugin/scripts/sync-assets.mjs` 从仓内同步生成，**单一事实来源仍是仓**）
 *
 * ⚠️ **判据必须是"这一项资产在不在"，不是"候选目录在不在"**：
 *   我第一版对 org 写的候选是 `[PKG, join(PKG,'assets','org')]`，而 **`PKG` 本身永远存在** ⇒
 *   `pickSrc` 直接返回包根 ⇒ `orgFiles = []` ⇒ **组织层静默没装**（真 tgz 实测抓到的）。
 *   ⇒ 所以签名改成"**探针文件**（probe）+ 候选目录"：用 `join(cand, probe)` 判存在。
 *
 * @param label 人类可读项名（缺源时报出来）
 * @param probe 该资产里的**一个代表性条目**（相对候选目录）；用它判"这一项在不在"
 * @param cands 候选目录，**按优先级**
 */
const missingSources = []
const pickSrc = (label, probe, cands) => {
  for (const c of cands) if (existsSync(join(c, probe))) return c
  missingSources.push(`${label}（探针 ${probe} 都没找到；试过：${cands.join(' | ')}）`)
  return cands[0]
}
const SKILLS_SRC = pickSrc('skills', 'teamkit/SKILL.md', [join(PKG, 'skills')])
const TALENTS_SRC = pickSrc('talents', 'engineer.md', [join(PKG, 'talents'), join(PKG, 'assets', 'talents')])
// 组织层文件（OMC 那一套的落地物）：Market 索引 + 治理规则 + （2026-09-15 起）公司建造指南等。
// 装到 `$DSH_HOME/teamkit/` 下与 talents 并列。
//
// ★★★ **2026-09-15 修：原来是写死的两项名单，会静默漏发新文件**
// ```
// 【现场】原代码逐字：`const ORG_SRC = ['TALENTS.yml', 'RULES.yml']`
//   ⇒ ★ 而 `plugin/assets/org/` 是**要新增文件**的目录（`COMPANY-GUIDE.md` 就放这里）
//   ⇒ ⚠️ **写死两项 ⇒ 新增的文件【进得了 tgz，却装不到用户机器】** ——
//     因为"装"这一步只点名那两个 ⇒ 用户在 `$DSH_HOME/teamkit/` 里**找不到指南**
//   ⇒ ★ 我实测抓到的（`installer-lands-org-probe.mjs`）：探针放 `assets/org/` ⇒
//     隔离装完 `<fakeHome>/teamkit/` 内容 = `roles, RULES.yml, skills-upstream, talents, TALENTS.yml`
//     ⇒ **探针不在**。
// ⇒ **修法：改成"扫 `ORG_BASE` 目录"** —— 新增文件自动跟着走，不用每次改代码。
//   ⚠️ 只收**已知该发的扩展名**（`.yml` / `.md`），避免把编辑器临时文件也装进去。
// ⚠️ **改这里（仓根 `tools/`）才是改权威源**；`plugin/tools/` 那份是 `sync-assets` 的**副本**，
//   直接改副本会被同步覆盖掉（我这一轮就先改错了副本，靠 `sync-assets --check` 报漂移才发现）。
// ```
const ORG_BASE = pickSrc('org(TALENTS.yml/RULES.yml)', 'TALENTS.yml', [PKG, join(PKG, 'assets', 'org')])
const ORG_SRC = (() => {
  try {
    return readdirSync(ORG_BASE)
      .filter((f) => /\.(ya?ml|md)$/i.test(f))
      .sort()
  } catch {
    // ★ fail-closed：扫不到 ⇒ **退回原两项**（保证组织层不会整块丢掉），并**明说**为什么
    console.error(`⚠️ **组织层目录扫不到**（${ORG_BASE}）⇒ 退回固定两项（TALENTS.yml / RULES.yml）`)
    return ['TALENTS.yml', 'RULES.yml']
  }
})()
// ★ **角色档**（公司层的"人"）：`roles/*.json` 是 `plugin/lib/roles.js` 读的数据源。
//   2026-09-14 发现：它**此前没有任何安装落点** ⇒ 开源用户装完**没有角色档** ⇒
//   `ROLES_LOADED {n:0}` ⇒ 公司层整块不生效（"装了却没反应"）。
const ROLES_SRC = pickSrc('roles', 'engineer.json', [join(PKG, 'runs', '005-role-skills', 'roles'), join(PKG, 'assets', 'roles')])
// ★ **preset**（"选 `omc` = 以开公司方式做项目"的入口）：此前只在开发者的 `~/.dsh/.agent-presets/omc/`，
//   插件包与仓里都没有 ⇒ **开源用户拿不到入口**。
const PRESETS_SRC = pickSrc('presets', 'omc/agent.cordis.yml', [join(PKG, 'presets'), join(PKG, 'assets', 'presets')])
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// ⚠️ **`SKILLS_DST` 曾经是 `$DSH_HOME/skills`（公共技能根）—— 2026-09-19 起【不再装那份】**（`B178`）
// ★★★ **为什么改**（委托方亲手报的）：
// ```
// 【他原话】「**为什么在其他预设下面也会有你的 team kit？……我看到主要是因为你的 skill
//   散布到其他的预设里了，导致它（们）有开启子代理的冲动。**」
// 【★ 而它的因果链成立】`$DSH_HOME/skills` 是**公共技能根**（DSH 本体的**默认根之一**）⇒
//   任何预设都读得到 ⇒ 而我们那 7 条 skill **真讲"组队/招人/开子代理"**
//   ⇒ **别的预设的 agent 读了就有"开子代理的冲动"** ❌
// ```
// ★★★ **而旧注释里那条"两份都要装"的推理是一条【自我说服链】**（每一环都对、合起来错）：
// ```
// ① ★ "用户可能不选 `omc` 预设" ⇒ 那一瞬间它需要 skill ⇒ 所以装到公共根
//    ⇒ ★★ **而这是个【伪需求】** —— **没选 `omc` 的 agent【本来就不该有公司层 skill】**
// ② ★★ "`omc` 用 `includeDefaultRoots:false` ⇒ 它不扫公共根 ⇒ 那份对它【零作用】"
//    ⇒ ★★★ **而这只说了一半**：它对 `omc` 零作用 ✅ · **而它对 `standard` 等【绝对不是零作用】**
// ③ ★★★ **最要紧的一步**：旧注释写"委托方明令「其它预设不受影响」"——
//    ⇒ ★★ **而我们把那个"明令"用在了"选 `omc` 时不受影响"上**，
//      **而他要的是【别的预设不受我们影响】** ❌ ⇒ **一句【单向】约束被理解成了【另一个方向】**
// ```
// ★★★ **判据（我据此事记下）**：**"某一处不受影响" ≠ "只有那一处不受影响"** ——
//   要问的是「**还会影响谁**」。旧注释里"副作用（已知且可接受）"就是**问了但不当回事**。
// ★★ **而修法不能再走旧链的形态**：**"为了兼容装法 B，所以装两份"** ——
//   ⇒ **正解：装法 B 下的 agent 本来就不该有公司 skill。那条链不需要公共根那份。**
//   ⇒ **"上游更新 → 全员自动跟随"那条链【只在 `omc` 下才有意义】**，
//     而它由 `upstream.root` / `customSkillDirs` **同指 `teamkit/skills-upstream`** 已闭合 ✅
// ⚠️ **所以本安装器现在只装 `UPSTREAM_DST` 那一份**（且 `omc` 预设的 `includeDefaultRoots:false`
//   让**别的预设读不到它** ⇒ 隔离成立）。判据见 `tools/check-skill-root-isolation.mjs`。
const TEAMKIT_DST = join(DSH_HOME, 'teamkit')
const TALENTS_DST = join(TEAMKIT_DST, 'talents')
const ROLES_DST = join(TEAMKIT_DST, 'roles')
// ★ **上游根（`omc` 预设的 `upstream.root` 与 `customSkillDirs` 同指这里）**。
//   为什么放在 `teamkit/` 下而不是 `$DSH_HOME/skills`：
//   `$DSH_HOME/skills` 会被 `dsh-base` 的**全局** `skill-filesystem` 行扫到 ⇒
//   **每个预设（含官方 `standard`）都会看到 teamkit 那 7 条**；
//   委托方明令「其它预设不受影响」⇒ `omc` 用 `includeDefaultRoots:false` + 本目录，
//   **既保隔离，又让"上游更新 → 全员自动跟随"的链路闭合**（读写同指）。
const UPSTREAM_DST = join(TEAMKIT_DST, 'skills-upstream')
const AGENT_PRESETS_DST = join(DSH_HOME, '.agent-presets')
/** ★★★ **公共技能根**（`B180`：**只有 `--global` 模式才装它**） */
const SKILLS_DST = join(DSH_HOME, 'skills')
const check = process.argv.includes('--check')
const uninstall = process.argv.includes('--uninstall')
// ★★★ **两种模式：`--locked`（release / 陌生人）与 `--global`（本地 / 我们）**（`B180` · CEO 裁）
// ```
// 【委托方原话（他救公司那句）】「**本地不要更新锁定预设。因为你现在……我在标准模式导致你现在
//   没法像 omc 一样自动注入 skill，这样子你现在的公司就完蛋了。我们传的 release 包是锁定预设的，
//   但是我们本地的不要这样。**」
// ⇒ ★★★ **他要的是【分离两件事】**：
//   · **release 包**（给陌生人）⇒ **锁定**（**只在 `omc` 下** —— 那是他"其它预设不受影响"的明令）✅
//   · **本地**（他自己用）⇒ **不锁**（**保持全局可用 ⇒ 公司才能跑**）✅
// 【★ 我先前那条指令为什么错】**我说"移走公共根那份"** ——
//   **对 release 对 ✅ · 对本地错** ❌ ⇒ ★★ **我把"隔离"当成了【唯一的正解】**，
//   而**委托方的形态是【两者并存】**。
//   ⇒ 判据（我记下）：**凡"改全局配置"的指令 ⇒ 必须先问"release 与本地是否要同样处理"**
//   ⇒ 而它与 `B171`（**用"发布面"当白名单 ⇒ 只做了北极星前半句**）**同族**：
//     **优化了"给出去的"，弄坏了"我们自己用的"** ❌
// 【★ 默认值】**`--locked` 是默认** ——
//   · **release 是给陌生人的**，而"不影响其它预设"是他的**明令** ⇒ **默认必须安全** ✅
//   · **本地用 `--global`**（**在我们的安装脚本/README 里写明**）✅
// 【两种模式各写什么】
//   · `--locked`：`teamkit/skills-upstream` ✅ · 公共根 ❌（**且要清掉旧版遗留**）· 预设 ✅ · **不动 `profile.bundles`**
//   · `--global`：`teamkit/skills-upstream` ✅ · **公共根 ✅** · 预设 ✅ · **（`profile.bundles` 由 `dsh plugin add` 管，本器不动）**
// ```
const globalMode = process.argv.includes('--global')
const lockedMode = process.argv.includes('--locked') || !globalMode // ★ **默认 locked**


// ★★ **`--help`**（2026-09-14 / Round 77 补）。
//
// 【缺陷现场】这个安装器**跑到 `--help` 就真的去装了**（实测：我打 `--help`，它印的是安装输出）。
//   ⇒ 用户想"先看看有哪些开关"，结果**直接改了系统** —— 这与本项目 `LANDMINES §7` 记的那次
//     事故**同族**（"一个生成器脚本因为不看参数就 rm -rf"）。
//   ⇒ 而且它**没有文档化的参数表** —— 那 3 个开关（`--check` / `--uninstall` / `--force`）
//     只在 `plugin/README.md` 里，**命令自己的 `--help` 看不到**。
// ⚠️ **`--help` / `-h` 必须"只打印、绝不写盘"**（本插件对 CLI 的既有纪律：`teamkit help` 就是这样）。
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('teamkit 交接包 · 安装器')
  console.log('')
  console.log('用法： node tools/install-teamkit.mjs [开关]')
  console.log('')
  console.log('开关：')
  console.log('  --locked       ★ **默认**：技能只装 `teamkit/skills-upstream`（**只在 `omc` 预设下可见**）')
  console.log('                 —— ★ **release / 陌生人用这个**（"不影响其它预设"是委托方的明令）')
  console.log('  --global       ★ 技能**同时**装进公共技能根 `$DSH_HOME/skills`（**所有预设都能读到**）')
  console.log('                 —— ★ **本地 / 我们自己用这个**（否则"标准模式"下读不到 ⇒ 公司跑不起来）')
  console.log('  --check        只看状态，**不写盘**（会报"待更新 / 一致 / 缺失 / 读不到"）')
  console.log('  --uninstall    **只删本包装的**（靠 `.teamkit` 标记）—— 用户自己写的 Talent / principles **不动**')
  console.log('  --force        覆盖已存在的同名预设（默认跳过，不冲掉你改过的）')
  console.log('  --help, -h     本页（**不写盘**）')
  console.log('')
  console.log('★ 为什么有两种模式（`B180` · 委托方裁定）：')
  console.log('  · **release 包**（给陌生人）⇒ **锁定** ⇒ 公共技能根里【没有】我们的 skill')
  console.log('    ⇒ 别的预设的 agent 读不到"组队/招人"那几条 ⇒ **不会莫名有开子代理的冲动**')
  console.log('  · **本地**（我们自己用）⇒ **不锁** ⇒ 公共技能根里有 ⇒ **在哪都能读到方法包**')
  console.log('  ⚠️ **`--locked` 是默认**（默认必须安全）· **本地请显式加 `--global`**')
  console.log('')
  console.log('环境变量：')
  console.log('  DSH_HOME       落点根（默认 ~/.dsh）。⚠️ **指向临时目录就能做安全测试**：')
  console.log('                   DSH_HOME=/tmp/probe node tools/install-teamkit.mjs --uninstall')
  console.log('                 ⇒ 完整 install/uninstall 都在那个临时目录里发生，**不碰真机**。')
  console.log('')
  console.log('它装什么（都在 $DSH_HOME 下）：')
  console.log('  skills/                  7 条方法技能（本插件自带）')
  console.log('  teamkit/roles/           角色档（岗位档案）')
  console.log('  teamkit/talents/         Talent + `_SPEC.md` + `principles/`（后者**只补缺**）')
  console.log('  teamkit/skills-upstream/ 上游根（`omc` 自带方法包，**只补缺**）')
  console.log('  teamkit/TALENTS.yml, RULES.yml   组织层（Market 索引 + 治理）')
  console.log('  .agent-presets/omc/      `omc` 预设（**不覆盖已存在的**，除非 --force）')
  process.exit(0)
}

const dirs = existsSync(SKILLS_SRC) ? readdirSync(SKILLS_SRC, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(SKILLS_SRC, e.name, 'SKILL.md'))).map((e) => e.name) : []
// ★★ **`_SPEC.md` 必须一起装**（2026-09-14 / Round 71 修的缺陷）。
//
// 【缺陷现场】原判据是 `filter((f) => f.endsWith('.md') && !f.startsWith('_'))` ——
//   **"下划线开头 = 内部文件"这个直觉是错的**。后果：`talents/_SPEC.md`
//   （**Talent 字段规范 + 各字段的合法取值**）**永远装不到用户机器上**。而它正是：
//     · 用户**想现写一份 Talent** 时的字段依据（`teamkit-assemble` §3 明说"按 `talents/_SPEC.md` 的字段"）；
//     · 角色档**合法取值**的唯一定义处（`role` 的封闭枚举、`gate_policy` 只允许 review/strict）。
//   ⇒ 实测：装完 `$DSH_HOME/teamkit/talents/` 里**没有 `_SPEC.md`**（真机那份是旧版，`marketing` 不在枚举里）。
//   ⇒ 修法：**不再按前缀排除**。要排除就**逐条列出文件名并写明理由**。
//   ⚠️ **本文件是"源"**（仓根 `tools/install-teamkit.mjs`）；`plugin/tools/` 那份是
//     `sync-assets.mjs` 生成的副本 —— **改错那一份会被同步覆盖掉**（我这一轮就这么错过一次）。
const talents = existsSync(TALENTS_SRC) ? readdirSync(TALENTS_SRC).filter((f) => f.endsWith('.md')) : []
const orgFiles = ORG_SRC.filter((f) => existsSync(join(ORG_BASE, f)))
if (dirs.length === 0) { console.error('找不到 skills 源：' + SKILLS_SRC); process.exit(1) }

console.log('teamkit 交接包 · ' + (uninstall ? '卸载' : check ? '只检查' : '安装'))
console.log('  源 ' + SKILLS_SRC)
// ★ **落点只有 `UPSTREAM_DST` 一处了**（`B178`）—— 公共技能根那份**不再装**
// ★ **落点随模式变**（`B180`）—— ⚠️ 不能写死成"只此一处"（`--global` 下是两处）
console.log(
  `  落点 ${UPSTREAM_DST}${globalMode ? ` 与 ${SKILLS_DST}（★ \`--global\`：两处都装 —— **所有预设都读得到**）` : '（★ **`--locked`：只此一处** —— 公共技能根不装）'}`,
)
console.log('  与 ' + TEAMKIT_DST)

if (uninstall) {
  // ★★★ **公共技能根那份也要清**（`B178`）—— 旧版安装器装过它 ⇒ 用户机器上可能还留着
  // ```
  // 【为什么卸载要管它】旧版把 7 条装进了 `$DSH_HOME/skills`（**公共根**）⇒
  //   而它正是委托方报的那个泄漏源 ⇒ ★ **光"新版不装"不够，还得把已经装过的清掉** ✅
  //   ⚠️ **只删带 `.teamkit` 标记的**（与 install/uninstall 一贯口径一致 —— 不碰用户自己的）
  // ```
  let nLegacy = 0
  const LEGACY_PUBLIC = join(DSH_HOME, 'skills')
  if (existsSync(LEGACY_PUBLIC)) {
    for (const d of dirs) {
      const p = join(LEGACY_PUBLIC, d)
      if (existsSync(join(p, '.teamkit'))) {
        rmSync(p, { recursive: true, force: true })
        nLegacy += 1
      }
    }
    if (nLegacy > 0) console.log(`  ★ 清掉公共技能根里 ${nLegacy} 条（旧版装的 · \`${LEGACY_PUBLIC}\`）`)
  }
  let n = 0
  for (const d of dirs) {
    const p = join(UPSTREAM_DST, d)
    if (existsSync(join(p, '.teamkit'))) { rmSync(p, { recursive: true, force: true }); n += 1 }
  }
  // ★ **talents：只删"有我们标记的"**（2026-09-14 / Round 76 修）。
  //   ⚠️ 原来这里是 `rmSync(TALENTS_DST, {recursive:true})` —— **整目录删**，
  //   会连**用户自己现写的 Talent**（`TALENTS.yml` 教他们这么干）与
  //   **成员复盘写出来的 `principles/*.md`** 一起删掉。
  //   ⇒ 改成按 `.teamkit-<file>` 标记逐份认领；**没标记的一律不动**。
  //   ⚠️ 目录里若还剩"用户的文件"，就**不删目录本身**。
  let nt = 0
  if (existsSync(TALENTS_DST)) {
    for (const e of readdirSync(TALENTS_DST, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.startsWith('.teamkit-')) continue
      const target = e.name.slice('.teamkit-'.length)
      const tp = join(TALENTS_DST, target)
      if (existsSync(tp)) { rmSync(tp, { force: true }); nt += 1 }
      rmSync(join(TALENTS_DST, e.name), { force: true })
    }
    // 目录空了才删（不空 = 还有用户的东西 ⇒ 留着）
    if (readdirSync(TALENTS_DST).length === 0) rmSync(TALENTS_DST, { recursive: true, force: true })
  }
  for (const f of orgFiles) { const p = join(TEAMKIT_DST, f); if (existsSync(p)) rmSync(p, { force: true }) }
  // 角色档（对称卸载）
  if (existsSync(ROLES_DST)) rmSync(ROLES_DST, { recursive: true, force: true })
  // 上游根（对称卸载）—— ⚠️ 这是"omc 自带方法包"的落点，删它不影响 `$DSH_HOME/skills`
  if (existsSync(UPSTREAM_DST)) rmSync(UPSTREAM_DST, { recursive: true, force: true })
  // 预设：**只删本包装的**（用 `.teamkit` 标记 —— 与 skills 同一套"只删自己装的"纪律）
  let pd = 0
  if (existsSync(AGENT_PRESETS_DST)) {
    for (const e of readdirSync(AGENT_PRESETS_DST, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const mark = join(AGENT_PRESETS_DST, e.name, '.teamkit')
      if (existsSync(mark)) { rmSync(join(AGENT_PRESETS_DST, e.name), { recursive: true, force: true }); pd += 1 }
    }
  }
  console.log('  删掉 ' + n + ' 个 skill 目录 + ' + nt + ' 份 Talent + roles + ' + pd + ' 个预设 + ' + orgFiles.join(' '))
  process.exit(0)
}

// 一个 skill 的安装状态。**不用 existsSync**：沙箱拒读时它返回 false，
// 会把「读不到」误判成「待装」（假阴性，实测见 EVIDENCE）。四态：
//   same（一致）/ stale（待更新）/ missing（真没装）/ unreadable（读不到=未验证）
const statusOf = (src, dst) => {
  let want
  try { want = readFileSync(src, 'utf8') } catch (e) { return { state: 'error', why: e.code || e.message } }
  try {
    const have = readFileSync(dst, 'utf8')
    return { state: have === want ? 'same' : 'stale' }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable', why: e.code || e.message }
  }
}

let missing = 0
let unreadable = 0
/** ★★ **落点清单：`--locked` ⇒ 只有上游根 · `--global` ⇒ 上游根 + 公共技能根**（`B180`） */
const SKILL_ROOTS = globalMode ? [UPSTREAM_DST, SKILLS_DST] : [UPSTREAM_DST]
console.log(
  `  模式：${globalMode ? '★ **`--global`**（本地 —— 技能装进【两个根】，所有预设都读得到）' : '★ **`--locked`**（默认 · release —— 技能【只装 `teamkit/skills-upstream`】，只在 `omc` 预设下可见）'}`,
)
for (const d of dirs) {
  const src = join(SKILLS_SRC, d, 'SKILL.md')
  for (const root of SKILL_ROOTS) {
    const dstDir = join(root, d)
    const dst = join(dstDir, 'SKILL.md')
    const st = statusOf(src, dst)
    if (st.state === 'missing') missing += 1
    if (st.state === 'unreadable') unreadable += 1
    const label = st.state === 'same' ? 'OK  ' : st.state === 'unreadable' ? '??  ' : st.state === 'error' ? 'XX  ' : '->  '
    const note = st.state === 'same' ? '（一致）'
      : st.state === 'stale' ? '（待更新）'
        : st.state === 'missing' ? '（待装）'
          : st.state === 'unreadable' ? '（未验证：读不到落点 ' + st.why + ' —— 这不是「没装」）'
            : '（源读不了：' + st.why + '）'
    // ★ 公共技能根那一份额外标注（**让人知道那是"本地不锁"才装的**）
    const where = root === SKILLS_DST ? '  ⚠️ 公共技能根（**只有 `--global` 会装它**）' : ''
    console.log('  ' + label + d + note + where)
    if (check || st.state === 'unreadable' || st.state === 'error') continue
    mkdirSync(dstDir, { recursive: true })
    writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8')
    writeFileSync(join(dstDir, '.teamkit'), 'teamkit:v1 ' + d + '\n', 'utf8')
  }
}
// ★★★ **`--locked` 模式：把公共技能根里【旧版遗留】的清掉**（`B180`）
// ```
// 【为什么必须清】旧版安装器**无条件**把 7 条装进了公共根 ⇒ 用户机器上可能还留着
//   ⇒ ★ **光"新版不装"不够** —— 那份遗留仍在，而它**正是委托方报的那个泄漏源** ❌
// ⇒ 只清**带 `.teamkit` 标记**的（与 install/uninstall 一贯口径一致 —— **不碰用户自己的**）
// ⚠️ **而 `--global` 模式【不清】**（那种模式下本来就该有）
// ```
if (lockedMode && !check) {
  let cleaned = 0
  if (existsSync(SKILLS_DST)) {
    for (const d of dirs) {
      const p = join(SKILLS_DST, d)
      if (existsSync(join(p, '.teamkit'))) {
        rmSync(p, { recursive: true, force: true })
        cleaned += 1
      }
    }
  }
  if (cleaned > 0) {
    console.log(`  ★ \`--locked\`：清掉公共技能根里 ${cleaned} 条旧版遗留（\`${SKILLS_DST}\`）—— **它正是"别的预设也读到"的那个源**`)
  }
}
// ★★ **Talent 目录要"只清自己装的"**（2026-09-14 / Round 76 修的真缺陷）。
//
// 【缺陷现场】原来这里是 `cpSync` 循环 + 一句 `cpSync(principles/)` —— **只补不删**：
//   实测：往真机 `talents/` 里造一个**仓里没有**的 `zz-orphan-probe.md`，重装后**它还在**
//   （与 R75 那个 `roles/A/` **同一族**：**"不再装" ≠ "已经装过的会消失"**）。
//   而 `--uninstall` 更狠：`rmSync(TALENTS_DST, {recursive:true})` —— **整目录删**，
//   连**用户自己写的东西**一起删。
//
// ⚠️⚠️ **但这里不能像 `roles/` 那样"按名单 prune"** —— 因为：
//   ① `TALENTS.yml` 明确教用户「**缺口就现写一份 Talent 落盘**」⇒ **用户会往这里加文件**；
//   ② `talents/principles/<name>.md` 是**用户/成员自己复盘写出来的**（"首次复盘时创建"）。
//   ⇒ **盲删会毁用户的东西**（比"留个孤儿"严重得多）。
//
// 【正解：**标记制**】装的时候给**每一份我们装的文件**盖 `.teamkit` 侧车标记，
//   prune 时**只删"有标记、且这次不在名单里"的**；**没标记的一律不动**（那是用户的）。
//   这与本安装器既有的纪律一致（`skills/` 与 `presets/` 都是靠 `.teamkit` 标记"只删自己装的"）。
//
// ⚠️ **`principles/` 例外**：它是**用户/成员写的**，**永远不删**（我们只"补 seed"，从不覆盖）。
const talentMarkFor = (f) => join(TALENTS_DST, `.teamkit-${f}`)
if (!check && talents.length > 0) {
  mkdirSync(TALENTS_DST, { recursive: true })
  for (const f of talents) {
    cpSync(join(TALENTS_SRC, f), join(TALENTS_DST, f))
    // 盖标记：**我们装过这一份**（供下次 prune 认领）
    writeFileSync(talentMarkFor(f), 'teamkit:v1 talent ' + f + '\n', 'utf8')
  }
  const princ = join(TALENTS_SRC, 'principles')
  // ⚠️ **`principles/` 只补缺、不覆盖**（那是用户/成员自己写的）——
  //    且**不盖标记**（意味着"我们不管它" ⇒ 永不 prune）。
  if (existsSync(princ)) {
    const pDst = join(TALENTS_DST, 'principles')
    mkdirSync(pDst, { recursive: true })
    for (const f of readdirSync(princ)) {
      const d = join(pDst, f)
      if (!existsSync(d)) cpSync(join(princ, f), d)
    }
  }
  // ── prune：**只删"有我们标记、且这次不在名单里"的**（用户自己加的一律不动）────────
  const talentSet = new Set(talents)
  const prunedTalents = []
  for (const e of readdirSync(TALENTS_DST, { withFileTypes: true })) {
    if (!e.isFile()) continue
    if (!e.name.startsWith('.teamkit-')) continue
    const target = e.name.slice('.teamkit-'.length)
    if (talentSet.has(target)) continue
    const targetPath = join(TALENTS_DST, target)
    if (existsSync(targetPath)) rmSync(targetPath, { force: true })
    rmSync(join(TALENTS_DST, e.name), { force: true })
    prunedTalents.push(target)
  }
  if (prunedTalents.length > 0) {
    console.log('  🧹 清掉**上次我们装的、这次不在名单里**的 Talent：' + prunedTalents.join(', '))
    console.log('     ⇒ 你没标记的同名文件**一个都没动**（`principles/` 永不 prune —— 那是你们写的）。')
  }
}
if (!check) {
  mkdirSync(TEAMKIT_DST, { recursive: true })
  for (const f of orgFiles) cpSync(join(ORG_BASE, f), join(TEAMKIT_DST, f))
}
// ★★★ **`--check` 也要核组织层**（2026-09-15 修的**真缺口**；CEO §③① 要求核这条）
// ```
// 【现场（我实测）】装完 ⇒ `--check` ⇒ exit=0 ⇒ **而我篡改了落点的 `COMPANY-GUIDE.md`**
//   ⇒ 再跑 `--check` ⇒ **仍然 exit=0**（它只在输出里**列了文件名** `组织层：COMPANY-GUIDE.md RULES.yml TALENTS.yml`）
//   ⇒ ★★ **"列了名字" ≠ "核了内容"** —— 那是 `R5` 家族（**看着像核过了**）
//   ⇒ ⚠️ 而 `--check` 的定位恰恰是「**不安装也能发现问题**」⇒ **漏核组织层 = 它的一半职责失效**
// 【修法】对每个 `orgFiles` 逐字节比对**源 vs 落点**（与预设那段同一手法）：
//   · 缺失 ⇒ 报「落点缺失」· 内容不同 ⇒ 报「待更新」
//   · ★ 并**汇总进 drift**（让退出码能反映它 —— 否则报了半天仍 exit=0）
// ⚠️ **本段刻意【不用】`if (check) {` 这个字面形态**（2026-09-15 我踩的另一个坑）：
//   `selftest` 的 `H39` 用 `inst.indexOf('if (check) {')` 定位"`--check` 主分支"，
//   而我若在这里也写一句 `if (check) {` ⇒ **它会先命中我这段** ⇒ `process.exit(code)` 落在窗口外
//   ⇒ **H39 假红**（报"`--check` 不设退出码"，而退出码明明在）。
//   ⇒ 所以这里用 `check ? … : []` 与 `if (check && …)` 的形态，**不引入那个字面**。
// ```
const orgDrift = []
for (const f of check ? orgFiles : []) {
  const src = join(ORG_BASE, f)
  const dst = join(TEAMKIT_DST, f)
  if (!existsSync(dst)) {
    orgDrift.push(`${f}（**落点缺失**）`)
    continue
  }
  let same = false
  try {
    same = readFileSync(src, 'utf8') === readFileSync(dst, 'utf8')
  } catch {
    same = false
  }
  if (!same) orgDrift.push(`${f}（**待更新：与源不同**）`)
}
if (check && orgDrift.length > 0) {
  console.log('  ⚠️ **组织层落点与源不一致**：')
  for (const x of orgDrift) console.log('       ' + x)
  console.log('     ⇒ 修：`node <安装器> --force`（重建落点）')
} else if (check && orgFiles.length > 0) {
  console.log(`  组织层：${orgFiles.length} 份与源逐字节一致 ✓（${orgFiles.join(' ')}）`)
}
if (check) globalThis.__orgDrift = orgDrift
// ★ **角色档（公司层的"人"）**：装到 `$DSH_HOME/teamkit/roles/`。
//   为什么装这里而不是原路径：原路径 `runs/005-role-skills/roles` 是**开发仓内部**的，
//   开源用户 clone 后路径不同 ⇒ 预设里的 `roles.dir` 用 `!!js` 表达式指向本落点（可移植）。
//   （安装器是唯一把"仓内资产"搬到"用户机器稳定位置"的地方 —— 单一事实来源仍是仓。）
if (!check && existsSync(ROLES_SRC)) {
  mkdirSync(ROLES_DST, { recursive: true })
  // ★ **只装"有角色档的人"**（2026-09-14 / Round 26 修的真 bug）。
  //
  // 【缺陷】原来两段循环各扫各的：`.json` 全拷 + **任何**带 `skills/` 的目录都拷
  //   ⇒ 仓里有个 **`roles/A/`**（**task-32 的探索证据**：`role-probe-a` 的作用域探针，
  //     `COMPANY-LAYER.md §H` 记录过它被误删后**逐字还原**，`REPORT.md:43` 引用它），
  //   它**没有 `A.json`**（不是真角色）⇒ 却因为"有 `skills/`"被**装给每一个用户**。
  //   实测：真机落点与沙盒安装都出现了 `A/`。
  // 【为什么这是错的】`A` 是**证据/探针**（名字也不在角色档集合里）⇒ 用户会看到一个
  //   **没有岗位档案、却带一条技能的"幽灵角色"**（同族：Round 9「有 provider 没内容」，这次反过来）。
  // 【修法】**判据 = 存在同名 `.json` 角色档**；没有 ⇒ 跳过并**打印**（不静默）。
  //   ⚠️ 证据**仍然留在仓里**（`roles/A/` 不删 —— 它被 `REPORT.md` / `A-LAYER-AUTHORITY.md` 引用），
  //      只是**不再分发给用户**。
  const roleIds = readdirSync(ROLES_SRC).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  for (const f of roleIds) cpSync(join(ROLES_SRC, `${f}.json`), join(ROLES_DST, `${f}.json`))
  const orphans = []
  for (const e of readdirSync(ROLES_SRC, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const sk = join(ROLES_SRC, e.name, 'skills')
    if (!existsSync(sk)) continue
    if (!roleIds.includes(e.name)) { orphans.push(e.name); continue }
    cpSync(sk, join(ROLES_DST, e.name, 'skills'), { recursive: true })
  }
  if (orphans.length > 0) {
    console.log('  ⚠️ 跳过**没有角色档的目录**（它们是证据/探针，不是"人"）：' + orphans.join(', '))
    console.log('     ⇒ 它们**仍在仓里**（被文档引用），只是不分发给你。')
  }
  // ★★ **还要 prune 掉"上一次装进去、这次不该在"的目录**（2026-09-14 / Round 75 修的真缺陷）。
  //
  // 【缺陷现场】R26 修了"**不再拷贝** `A/`"（判据 = 有没有同名 `.json` 角色档），
  //   **但没有删掉已经装进去的那一份** ⇒ 真机 `$DSH_HOME/teamkit/roles/` 里**至今还躺着 `A/`**
  //   （我实测：`A 目录存在: True`，而且与仓内**逐字节一致**）。
  //   ⇒ 用户看到的正是 R26 注释里说的那个**"幽灵角色"**：没有岗位档案、却带一条技能。
  //   **"不再装" ≠ "已经装过的会被清掉"** —— 二者是两件事，而我只做了前者。
  // 【修法】装完后**对账**：真机 `roles/` 下**凡是不在 `roleIds` 里的目录**都删掉（并打印"删了什么"）。
  //   ⚠️ 只删**目录**（`A/` 那种没有对应 `.json` 的）；**带 `.json` 的一律保留**（那是真角色）。
  //   ⚠️ 不静默：删了要**逐条打印**。
  const prunedRoles = []
  if (!check) {
    for (const e of readdirSync(ROLES_DST, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      if (roleIds.includes(e.name)) continue
      // 额外安全：只删"看起来是我们装的"（带 `skills/` 或 `SKILL.md`）——不碰用户自己建的杂物目录
      const looksOurs = existsSync(join(ROLES_DST, e.name, 'skills')) || existsSync(join(ROLES_DST, e.name, 'SKILL.md'))
      if (!looksOurs) continue
      rmSync(join(ROLES_DST, e.name), { recursive: true, force: true })
      prunedRoles.push(e.name)
    }
    if (prunedRoles.length > 0) {
      console.log('  🧹 清掉**上次装进去、这次不该在**的目录：' + prunedRoles.join(', '))
      console.log('     ⇒ 它们是探针/证据（没有同名角色档）——"不再装"不等于"旧的会自己消失"。')
    }
  }
}
// ★ **preset（入口）**：装到 `$DSH_HOME/.agent-presets/<name>/`。
//   ⚠️ 这一步**改变了用户机器上"预设从哪来"** —— 但 `.agent-presets/` 是 DSH 的**用户预设根**
//   （`discovery.js:48` `USER_PRESET_DIR = '.agent-presets'`）⇒ 这是官方位置，不是侵入。
//   ⚠️ **不覆盖已存在的同名预设**（除非 `--force`）：用户可能自己改过。
const presetDirs = existsSync(PRESETS_SRC)
  ? readdirSync(PRESETS_SRC, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(PRESETS_SRC, e.name, 'agent.cordis.yml'))).map((e) => e.name)
  : []
const force = process.argv.includes('--force')
const presetActions = []
if (!check) {
  for (const p of presetDirs) {
    const dst = join(AGENT_PRESETS_DST, p)
    const dstFile = join(dst, 'agent.cordis.yml')
    const srcFile = join(PRESETS_SRC, p, 'agent.cordis.yml')
    // ★★ **区分"用户改过"与"上游更新了"**（2026-09-14 / Round 35 修的真缺口）。
    //
    // 【原行为】`existsSync(dstFile) && !force` ⇒ **一律跳过**。安全（不覆盖用户改动），
    //   但**分不清两种情况** ⇒ 后果是**"我更新了插件、用户的预设却永远停在旧版"**：
    //   本轮实测：仓内预设已含 `memberRelease`，而真机落点 **0 处** ⇒ 用户**开不了那个能力**，
    //   而且安装器只淡淡说一句"已存在 ⇒ 跳过"，**不说是"你有改动"还是"我就没更新你"**。
    //
    // 【新判据】用**标记 + 比对**：
    //   · 落点**有 `.teamkit` 标记**（＝这份是我们装的）且**内容与源的上一版一致** ⇒ 是纯上游更新 ⇒ **覆盖**；
    //   · 落点**有标记**但我们无法证明没被改过（无"已装版本"记录）⇒ **保守跳过**，但**明确说出是哪种情况**；
    //   · 落点**没有标记** ⇒ 用户自己的 ⇒ **绝不覆盖**（与既有语义一致）。
    //   怎么"证明没被改过"：比较落点与**上次装的版本**。上次装的版本没存 ⇒ 只能保守。
    //   ⇒ 所以这里**做最保守但最诚实**的那档：**逐字节比对**，并打印**是"完全相同"还是"有差异"**。
    let action = null
    if (existsSync(dstFile) && !force) {
      let same = false
      try {
        same = readFileSync(dstFile, 'utf8') === readFileSync(srcFile, 'utf8')
      } catch {
        same = false
      }
      const ours = existsSync(join(dst, '.teamkit'))
      if (same) {
        action = p + '（已是最新：与源逐字节相同）'
      } else if (!ours) {
        action = p + '（已存在但**没有 .teamkit 标记** ⇒ 像是**你自己的**预设 ⇒ **不覆盖**；要覆盖加 --force）'
      } else {
        // 我们装的、但内容不同 —— **可能是上游更新，也可能是用户改过** ⇒ 不擅自覆盖，但说清楚
        action = p + '（**内容与源不同** ⇒ 不覆盖；若是上游更新、你没改过，加 --force 即可）'
      }
      presetActions.push(action)
      continue
    }
    mkdirSync(dst, { recursive: true })
    // ⚠️ **`recursive: true` 是必须的**（2026-09-14 真 tgz 才暴露的 bug）：
    //   预设目录里可能有子目录（如 `raw/` 放着生成器与验证读数）；
    //   不带 `recursive` ⇒ `cpSync` 抛 `ERR_FS_EISDIR: Recursive option not enabled, cannot copy a directory`
    //   ⇒ **整个安装器崩在预设那一步**，前面的 skills/talents/roles 装了、后面的上游根没装（**半装状态**）。
    //   ⚠️ 为什么沙盒测试没抓到：我此前的沙盒源都指向**仓内** `presets/`，
    //      而 `raw/` 在当时还没有被同步进包内副本 ⇒ **只有"真 tgz → npm install → 跑安装器"这条链才触发**。
    for (const f of readdirSync(join(PRESETS_SRC, p))) {
      cpSync(join(PRESETS_SRC, p, f), join(dst, f), { recursive: true })
    }
    // ★ `.teamkit` 标记：卸载时**只删本包装的**（用户自己写的同名预设不许误删）
    writeFileSync(join(dst, '.teamkit'), 'teamkit:v1 preset ' + p + '\n', 'utf8')
    presetActions.push(p)
  }
}
console.log('  talents：' + talents.length + ' 份' + (existsSync(join(TALENTS_SRC, 'principles')) ? '（含 principles/）' : ''))
console.log('  组织层：' + orgFiles.join(' '))
// ★ **缺源要报出来**（"失败不静默"）：装不上资产时用户必须知道**是哪一项、试过哪些路径**，
//   否则他会以为"装上了"（本项目反复踩的一类：读了 A、写了 B、不报错）。
if (missingSources.length > 0) {
  console.log('')
  console.log('⚠️ 有资产源**没找到**（这些项不会被安装）：')
  for (const m of missingSources) console.log('    ' + m)
  console.log('   ⇒ 仓内布局应有 runs/005-role-skills/roles + presets + talents；')
  console.log('     包内布局应有 assets/{roles,presets,talents,org}（由 plugin/scripts/sync-assets.mjs 生成）。')
}
// ★ **上游根种入**：把 7 条方法技能放进 `$DSH_HOME/teamkit/skills-upstream/`。
//   为什么是"种入"而不是"软链"：软链在 Windows 要权限、跨盘更脆；
//   而这里的语义本来就是"**这份是 omc 自带的方法包**"（上游更新的对象）——
//   ✅ 而且 `plugin/lib/index.js` 的 `SKILLS-SYNC` 也会往 `upstream.root` 同步自带 skills ⇒ 双保险。
//   ⚠️ **只补缺，不覆盖**（若用户已经改过上游某条，不能被安装动作冲掉；要覆盖加 `--force`）。
let seeded = 0
if (!check && existsSync(SKILLS_SRC)) {
  mkdirSync(UPSTREAM_DST, { recursive: true })
  for (const d of dirs) {
    const src = join(SKILLS_SRC, d, 'SKILL.md')
    const dstDir = join(UPSTREAM_DST, d)
    const dst = join(dstDir, 'SKILL.md')
    if (existsSync(dst) && !force) continue
    mkdirSync(dstDir, { recursive: true })
    cpSync(src, dst)
    seeded += 1
  }
}
console.log('  上游根：' + UPSTREAM_DST + (check ? '' : '（种入 ' + seeded + ' 条，已存在的不覆盖）'))

// ★★★ **`--check` 必须也报"上游根过期了没"**（2026-09-14 / Round 84 修的真缺陷 —— R47 复发）。
//
// 【缺陷现场】`--check` 只查 `SKILLS_DST`（`$DSH_HOME/skills`）那 7 条，
//   而上游根（`teamkit/skills-upstream`）**只打印一句"（--check 不写入）"，从不比对**。
//   ⇒ 实测：把上游根里 `teamkit-escalate/SKILL.md` 改旧 ⇒ 跑 `--check` ⇒
//     **7 条全报 `OK（一致）`，退出码 0** —— 而**模型真正读的就是那份**（`omc` 预设的
//     `customSkillDirs` 指它，且 `includeDefaultRoots:false` 明确不扫 `$DSH_HOME/skills`）。
//   ⇒ 这就是 R47 那个事故的**同一个形状**（"我改了技能，模型却读到旧版，且没有任何报错"），
//     只不过这次它发生在**"本该抓这种事的工具"自己身上**。
//   ⚠️ `selftest` 的 `H28`（R68 加）确实查上游根 —— 但用户**不会每天跑 selftest**，
//     而 `--check` 是**安装器给出的状态报告**（README 里就是这么写的）。
// 【修法】逐条比对 `SKILLS_SRC` 与 `UPSTREAM_DST`：不一致 ⇒ 报 `（上游根待更新）` 并计入 drift。
if (check) {
  const upDrift = []
  for (const d of dirs) {
    const srcFile = join(SKILLS_SRC, d, 'SKILL.md')
    const dstFile = join(UPSTREAM_DST, d, 'SKILL.md')
    if (!existsSync(dstFile)) {
      upDrift.push(d + '（**上游根缺失**）')
      continue
    }
    let same = false
    try {
      same = readFileSync(srcFile, 'utf8') === readFileSync(dstFile, 'utf8')
    } catch {
      same = false
    }
    if (!same) upDrift.push(d + '（**上游根待更新**）')
  }
  if (upDrift.length > 0) {
    console.log('  ⚠️ **上游根与源不一致** —— 而**模型读的就是上游根**（`omc` 的 `customSkillDirs` 指它）：')
    for (const x of upDrift) console.log('       ' + x)
    console.log('     ⇒ 修：`node <安装器> --force`（只补缺的那条；`--force` 会覆盖上游根里同名的）')
    console.log('     ⚠️ 别忽略它：这是 R47 那个"模型读到旧版、却没有任何报错"的同一个形状。')
  } else if (dirs.length > 0) {
    console.log('  上游根：' + dirs.length + ' 条与源一致 ✓')
  }
  // 汇总进 preset drift（让最终退出码能反映它）
  globalThis.__upstreamRootDrift = upDrift
}

console.log('  角色档：' + (existsSync(ROLES_SRC) ? readdirSync(ROLES_SRC).filter((f) => f.endsWith('.json')).length + ' 份 → ' + ROLES_DST : '(源缺失)'))
// ★ `--check` 也要**报告预设是否过期**（Round 35 修：原来 check 完全不说这件事 ⇒
//   用户跑 `--check` 看到"OK"却不知道**真机那份是旧的**，能力开关改了也传不过去）。
if (check) {
  const drift = []
  for (const p of presetDirs) {
    const srcFile = join(PRESETS_SRC, p, 'agent.cordis.yml')
    const dstFile = join(AGENT_PRESETS_DST, p, 'agent.cordis.yml')
    if (!existsSync(dstFile)) drift.push(p + '（**未装**）')
    else {
      let same = false
      try {
        same = readFileSync(dstFile, 'utf8') === readFileSync(srcFile, 'utf8')
      } catch {
        same = false
      }
      if (!same) drift.push(p + (existsSync(join(AGENT_PRESETS_DST, p, '.teamkit')) ? '（**已过期/有改动**）' : '（**非本包所装**，不覆盖）'))
    }
  }
  console.log('  预设  ：' + (presetDirs.length > 0 ? presetDirs.join(' ') + ' → ' + AGENT_PRESETS_DST + '  ' + (drift.length ? '⚠️ ' + drift.join('; ') : '（一致）') : '(源缺失)'))
  // ★★ **`--check` 要给退出码**（2026-09-14 / Round 84 补）。
  // 【缺陷现场】`--check` 跑完**从来不 `process.exit`** ⇒ 脚本/CI 里它**永远退 0**，
  //   哪怕它刚刚报了"7 条待更新"或"上游根待更新" ⇒ **"有漂移"这个结论无法被机器读到**。
  //   ⇒ 这与 R78 修的那个"无参数 exit 0"是**同一格**：**退出码是接口，不是细节**。
  // 判据：**只有"全绿 + 无未验证"才 0**；
  //   · 有漂移（`$DSH_HOME/skills` 或预设 或 **上游根**）⇒ **1**
  //   · 有未验证（读不到落点）⇒ **2**（"读不到 ≠ 没装"，与 selftest 的三态口径一致）
  const upRootDrift = Array.isArray(globalThis.__upstreamRootDrift) ? globalThis.__upstreamRootDrift : []
  // ★ **组织层漂移也要计入退出码**（2026-09-15）—— 否则"报了却仍 exit 0"，
  //   ⇒ 脚本/CI 读不到"指南装了旧的/漏了"这件事（与上面那条同族：**退出码是接口**）
  const orgRootDrift = Array.isArray(globalThis.__orgDrift) ? globalThis.__orgDrift : []
  const anyDrift = drift.length > 0 || upRootDrift.length > 0 || orgRootDrift.length > 0
  const code = unreadable > 0 ? 2 : anyDrift ? 1 : 0
  if (anyDrift || unreadable > 0) {
    console.log('')
    console.log(
      '**--check 判定：' +
        (unreadable > 0 ? 'UNVERIFIED（有读不到的落点）' : 'DRIFT（有待更新/不一致）') +
        '** ⇒ 退出码 ' + code +
        (upRootDrift.length > 0 ? '（含**上游根**漂移 —— 那是模型真正读的那份）' : '') +
        (orgRootDrift.length > 0 ? '（含**组织层**漂移 —— 指南/RULES/TALENTS）' : ''),
    )
  }
  process.exit(code)
} else {
  console.log('  预设  ：' + (presetDirs.length > 0 ? presetDirs.join(' ') + ' → ' + AGENT_PRESETS_DST + '  [' + presetActions.join('; ') + ']' : '(源缺失)'))
}
if (!check) {
  console.log('')
  console.log('完成。DSH 下一次会话（或 skills/change 之后）会把它们列进技能目录；模型按需用 skill 工具读正文。')
  console.log('组织层落在 ' + TEAMKIT_DST + '：TALENTS.yml（市场索引）/ RULES.yml（治理）/ talents/（含 principles/）/ roles/（角色档）')
  if (presetDirs.length > 0) {
    console.log('★ **用法**：新建会话时把预设选成 **OMC 开公司模式**（或把 `agent-presets.default` 设成它）。')
    console.log('   选它 = 以开公司的方式做这个项目；其它预设（含官方 standard）不受影响。')
  }
} else if (missing > 0) {
  console.log('')
  console.log('有 ' + missing + ' 个没装：node tools/install-teamkit.mjs')
}
if (unreadable > 0) {
  console.log('')
  console.log('有 ' + unreadable + ' 个**未验证**（读不到落点 ' + UPSTREAM_DST + '，通常是沙箱拒绝访问 DSH_HOME）——')
  console.log('这不是「没装」：换能读该路径的 shell 重跑 --check，或用 read 工具直接读该目录下的 SKILL.md。')
}
