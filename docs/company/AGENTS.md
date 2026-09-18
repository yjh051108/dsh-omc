# AGENTS.md — omc-agent-teams（独立工作区）

**一句话**：这里做的是「Agent Teams 的**组织层**」—— Talents（人）→ Tier（层）→ Board（板）→ Review（评审），把 OMC（OneManCompany，arXiv 2604.22446）内化到 DSH。不分领域：研究、写作、开发、审计同用。

## 边界（很重要）
- **<另一个项目> 的 DSH 内化不在这里** —— 那在 `<另一个项目的仓>`，由另一个项目负责。
- 本区只在**交界处**调用它：要上岗材料用 `gsd_brief`；要 `gate: strict` 用 `gsd_workflow {name:'verify'}`。见 `<交界目录>/NOTES.md`。
- 本区的产物只放本区（Markdown / JSON 落盘），别写回 `<另一个项目>`。

## 先读顺序（省时间）
1. **`plugin/README.md`** —— **交付物本体**（`@dsh-external/dsh-teamkit`）：怎么装、装什么、有哪些限制。
   ⚠️ **它是先读的第一份** —— 前面几份是"过程与裁决"，**这一份是"东西在哪、怎么用"**。
2. `LANDMINES.md` —— 我踩过的坑（含一次把 DSH 会话全挂的事故）
3. `DESIGN-OMC.md` —— 设计立场（编制三档、E²R、gate 旋钮、A2A、终止与无死锁）
4. `runs/005-role-skills/DECISIONS.md` —— 委托方逐条裁定（P-01…P-38+，**改设计前先查这里**）
5. `HANDOFF.md` / `PLAN.md` / `OPEN-QUESTIONS.md` —— 早期的范围与清点（**只在"资产清点"上仍准**；
   ⚠️ **验收判据不作数**，见下文）

## 命令（**先跑自测**）
```bash
# ⓪ ★ **一条命令跑完全部校验器**（2026-09-14 / Round 70 新增）—— **改动后第一件事**
node tools/check-all.mjs
#   跑 7 个：selftest · e2e-tarball · sync-skills --check · sync-assets --check ·
#            check-c3-closure · check-perf-cycle · verify-handoff
#   退出码：0 全 PASS / 1 有 FAIL（**必须修**）/ 2 无 FAIL 但有 UNVERIFIED（**能接受，但要知道**）
#   ⚠️ **为什么要有它**：这 7 条以前**一个都没被谁调用过** ⇒ 全靠"我记得跑"，
#      而**漏跑一条不会有任何信号**（判据 `H29` 现在盯着这件事）。

# ① 健康判据（三态：PASS / FAIL / UNVERIFIED）
node plugin/bin/teamkit.mjs selftest

# ② 交付形态的端到端（npm pack → npm install → 跑安装器 → 核对落点 **+ 功能断言**）
node plugin/scripts/e2e-tarball.mjs

# ③ 装（用户侧；仓内与包内两种布局都支持）
node plugin/tools/install-teamkit.mjs            # 装；--check 只看；--uninstall 只删本包装的

# ④ 上游合并（说明是硬门；没 --note ⇒ 退出码 2）
node tools/promote-upstream.mjs --list
node tools/promote-upstream.mjs --all --note "改了什么、为什么"
node tools/promote-upstream.mjs --rollback <skill>

# ⑤ 改动"源"之后必须同步进包（否则 tgz 里是旧副本）
node plugin/scripts/sync-skills.mjs && node plugin/scripts/sync-assets.mjs
```
> ⚠️ **单一事实来源**：技能改 `skills/`（仓根）；资产改 `talents/` / `roles/` / `presets/` / `TALENTS.yml` /
> `RULES.yml` / `tools/install-teamkit.mjs` —— **改完必须跑 ⑤ 同步**（我踩过：改了 `plugin/skills/` 的副本，
> `sync-skills` 按设计把它覆盖回去了，我的编辑当场消失）。
> **`promote-upstream.mjs` 是上游更新的唯一入口**（委托方 2026-09-13 认可此形态）。
> **没有 `--note` ⇒ 退出码 2，合并不了** —— 把「每次 push 都要发个主要做了什么」从口号变成门禁。
> 它四件事：**①快照旧版（供成员自己 diff）→ ②合并 → ③记 `CHANGELOG.md` → ④复核**；
> **说明挂在"写"这个动作上**，因此不受"按步轮询会折叠突发提交"那个缺陷影响。详见 `runs/005-role-skills/DECISIONS.md` P-32。

> **`$DSH_HOME/skills` 是「技能上游」的一个磁盘根，不是每个成员的私有目录。**
> 它属于**所有**同 cwd / 同 preset 的 agent 共同读取的那一层（下文 §本区现状 第 2 条）。
> 每个成员**自己那一份**是 overlay 在它之上的 **fork**；写这里 = 改公共契约，影响全员。

## 硬规矩

0. ★★★ **DSH 运行时是底线 —— 绝对不能碰。**（2026-09-14 委托方定向）
   原话：「**DSH 的运行时被打断，或者说什么无法冲洗的问题，这个是底线，这个是绝对不能触碰的。**
   要**绝对保证没有问题的情况下**再碰敏感的地方……**绝对不能让 DSH 爆掉**。」
   **它排在所有规矩之前 —— 因为它一旦破了，后面所有规矩都无从谈起。**

   **敏感区（改坏了会让 DSH 打不开 / 会话读不出来 / 全员失效）**：
   ```
   宿主进程本身（重启/杀/端口） · 会话日志 session.v3.jsonl.zstd ·
   投影缓存 session_projcache/** · DSH 本体源码 · profile 与预设注册 ·
   **底座 API 的就地修改**（journal.state() 返回值 / tasks[*] / 原型包装）· 已装载插件的 fiber ·
   `$DSH_HOME/settings.yaml` + credentials（坏了起不来）· SOUL/fork 注入通道（坏了全员带错人格）
   ```
   **两条硬判据**：
   ```
   ① 「"我觉得安全" 不是证据，"回读证明它没变" 才是。」
   ② 要碰 ⇒ **先绕开**；绕不开 ⇒ **交给它的责任人**；**永不在它上面试验**。
   ```
   ⚠️ **写宿主私有格式（会话日志 / 投影缓存）直接禁 —— 不立级数**：
   两种填充方案（0x00 补零 / zstd skippable frame）**宿主都拒** ⇒ **没有可证安全的做法**，
   立级数只会给它一个"合规的外壳"。（COO 判定，CEO 采纳）

   ⚠️ **这条纪律文本已经失败过两次**（`ORG.md §1.2` 写了"CEO 不再动手"，然后我犯了两次）——
   ⇒ 所以**它必须变成机器能拦的东西**（`RULES.yml` + guard 扩面 + 断言），**不是又一句好听话**。

   ⚠️ **谨慎 ≠ 停摆**（委托方明确）：**不要因为谨慎就把任务停住上报** ——
   正确形态是**换一条不会碰到它的路**，而不是"停下来等批准"。

   ### ★ 「换路」判据（2026-09-14 高管会 · 总工程师提出，**可机械执行**）
   ```
   1. 把目标从**动作**改写成**要读到的结论**（"修板" → "确认板能不能读"）
   2. 列出为达成它**必须产生的全部写入**：文件路径 / 内存对象 / 进程动作 —— 一个不许漏
   3. 逐个对照上面的敏感区清单：**全不在 ⇒ 是换路**（动手）；
      **只要有一个在 ⇒ 不是换路**（改设计 / 交责任人）
   4. **说不清"有没有写入" ⇒ 记「未获取」，不许默认它安全**（"我觉得安全"不是证据）
   5. **判据要贴出来**：写入清单 + 逐项对照结果
   ```
   ⇒ **一句话**：**换路的判据不是"我换了做法"，是"写入清单为空、或全在清单之外"。**

   **正反例（都用真实事故）**：
   ```
   ❌ 不是换路：目标写成"修板" ⇒ 写入含 session.v3.jsonl.zstd ⇒ **在清单里** ⇒ 应改设计
   ✅ 是换路：目标写成"确认板能不能读" ⇒ 写入 = **0（纯只读）**
   ```

   ### ★★ 三层防线（**按"真能拦"排序，不是并列**）
   ```
   第 1 道 · **换路**        —— 不碰它。唯一不需要任何机制就成立的防线
   第 2 道 · **回读验证**    —— "证明它没变"（正例：e2r.js:743-753 三轮取样查残留）
   第 3 道 · 断言 + guard    —— **只拦落盘的东西**；对"当场写进宿主内存"**无效**
   ```
   ⚠️ **不许把第 3 道说成"底线守住了"** —— 那是本项目最反复的错
   （把"有机制的样子"当成机制）。两次事故**都有"当场写内存"的成分**：
   `dev_stage_add` 的 inline 探针**从不落盘** ⇒ guard 与断言**都扫不到**。

   ### ⚠️ 系统条件（`task-86` 要写进复盘 —— **两次事故的共同根因**）
   > **我们从来没有要求"动手前列出写入清单"。**
   > CEO 当时的目标是**动作**（"把板修好"），**连"我要写哪些东西"都没列**
   > ⇒ 按换路判据，**那根本不是换路**，该改设计或交责任人。

1. **侵入的定义是「改 DSH 本体源码」—— 这一样禁止。**
   **插件（含运行时注入）不算侵入**：那是使用 DSH 的**开放扩展端口**，可热卸、可回滚、不碰本体。
   优先级：skills（零 schema 成本、任何预设都吃得到）→ 插件（要真强制、真工具面时才用）。
   > 2026-09-12 委托方口径更正：原文写的是「skills 是唯一非侵入钩子」，把插件也误归为侵入 —— 已按本条改正。
   > **★ 2026-09-14 口径更正（Round 57）**：本条**原文写的是**「改 DSH 本体源码 / **动任何 profile 依赖**」。
   >   **后半句已被委托方解除**：原话「**包装成 profile 依赖，你不用找我要授权，我已经给你完全权限了**」
   >   ⇒ **可以动 profile 依赖**（装插件、写 profile patch 都算）。**唯一仍然禁止的是改 DSH 本体源码。**
   >   ⚠️ **我为此白挂了一条"❌ 仍未验（约束所致）"挂了很多轮**（`dsh plugin add` 端到端）——
   >   因为它**引述了一个已经过期的约束**，而没去核"谁说的、什么时候、还算不算"。
   >   ⇒ **教训**：**"不能做"的记录必须带出处与时间**；每次读到它，**先核对它是否仍然成立**。
   >   ⇒ 该约束解除后 Round 56 已补验：`dsh plugin --profile <p> add "<绝对路径>"` **exit=0**（见 `README.md` 的两个前置坑）。
2. **往 live profile 里装用 `link:`/junction 要极其小心 —— 真正的判据是「这个包裸导入别的包吗」。**
   `link:` 是符号链接，Node 按**真实路径**解析 ⇒ **包自己的裸导入**（`import … from 'some-pkg'`）
   会去**包目录往上**找 ⇒ 找不到就 **每个会话 exit=1**（`LANDMINES` 第 1 条那次事故的原文）。
   **★ 2026-09-14 更正（Round 40 实测）**：危险的是「**裸导入 + link 装法**」这个**组合**，不是 link 本身。
   实测：`createRequire` 从**真路径**解析 `@deepseek-ai/dsh-tools` **成功**（全局 npm 在祖先链上），
   而解析 `@deepseek-ai/dsh-experimental-agent-team`（**只在 profile 里**）**失败** —— 后者正是当年挂掉的那个。
   ⇒ **两条一起守**：① 优先用 `dsh plugin add <绝对路径>`（真落到 profile `node_modules`）；
     ⚠️ **★ 2026-09-14 口径更正（Round 56 实测）**：本条**原文写的是**「优先用 `dsh plugin add file:<相对路径>`」——
     **那是错的**。实测：`dsh plugin --profile probe56 add "file:D:/…/plugin"` ⇒
     `ENOENT: scandir '…\profiles\probe56\<DSH 工作根>\omc…'` + `pnpm failed exit=-4058`。
     **根因**：`dsh plugin` 把参数**转发给该 profile 目录下的 pnpm**，pnpm 按 **profile 目录**解析相对路径。
     **正解 = 绝对路径、不带 `file:`** ⇒ `exit=0`，真写进 `dependencies` + `bundles`。
     另：**`pnpm` 必须在 PATH 上**，否则只报 `'pnpm' is not recognized`（看不出是缺前置）。
     ② **`plugin/lib/**` 里只允许 `node:` 内置与相对导入** —— 这条有断言盯着（`selftest` 的 `H12` 组）。
   本部署现状：profile 里是 junction，**且插件零裸导入** ⇒ 能用（**那个"零裸导入"是承重条件，别拆**）。
3. **默认 gate: review**（模型评审当门禁）；strict 只在对外交付 / 契约敏感 / 不可逆时点火。
4. **只报实测读数。** 拿不到读数就写「未验证」，不要写成「应该没问题」。
5. **结论落盘。** 会话会丢，盘上不会。

## 本区现状
- `skills/` **7 个方法 skill**（`teamkit` 入口 + assemble / org / review / meeting / escalate / a2a）：**已在真会话里被 DSH 发现并加载过**；2026-09-12 从"讲名词"改成**可执行判断表**（读数见 `EVIDENCE.md` §7.3）。
- **组织层文件**（OMC 那一套的落地物）：`TALENTS.yml`（Market 索引）/ `RULES.yml`（治理）/ `talents/_SPEC.md`（Talent 规范）+ 6 份 Talent + `talents/principles/`（自演化位）/ `ROSTER.yml`（本次编制）。装到 `$DSH_HOME/teamkit/`，读数见 `EVIDENCE.md` §7.4。
- **组织层的可视化**在 `<工作区>\dsh-org-panel`（复用 OMC 原版像素渲染器，数据源是 DSH 的 `ctx.subagents.listDescendants`）。装载：`dev_inject_plugin {"dir":"D:/dsh/03-dev-infra/dsh-org-panel"}`。
- `<交界目录>/` 是与 <另一个项目> 适配器的交界说明与可搬代码。
- `notes/` 是 2026-09-12 对着**原版**（论文 + `<原版 OMC 目录>`）做的取证与内化对齐稿 —— 读它比读本文件的概括准。
- **未做**：组织层的 A/B 读数；**`RULES.yml` 仍是协议不是机制**（治理规则没有强制点）。
  ⚠️ **但"评审门"已经不是纯协议了**（2026-09-14 实测更正）：**把"评审"建成一个任务、让下游任务
  `blocked_by` 它**，下游去 `claim` 会被宿主**硬拒**（`team task "task-N" is not ready to claim`）
  ⇒ 这是**真机制**；`teamkit-review` 里有可照做的步骤与**手动巡检表**（因为**没有**自动巡检）。
- **⚠️ 交付形态已定（委托方 2026-09-13 北极星）**：「**我们做的是插件** —— 一定要**越方便开源后其他用户安装越好**，一定是**越好维护越好**。」
  **✅ 已收敛完成**（2026-09-14）：`plugin/` = `@dsh-external/dsh-teamkit`。实测读数：
  · **零硬编码路径**（`plugin/{lib,bin,tools,scripts}` 里非注释的 `D:/dsh/omc-agent-teams` 命中 = **0 处**）；
  · **真 tgz 端到端 PASS**（`node plugin/scripts/e2e-tarball.mjs` ⇒ `npm pack → npm install → 跑安装器 → 核对落点`
    **+ 功能断言**：装出来的角色档能被真 `loadRoles` 读出、每个角色都有技能、原则能被真 `loadPrinciples` 读出。
    **自己跑，别抄数**；判据同样是**退出码**：`0` 全过 / `1` 有失败）；
  · **一条能照抄跑通的安装路**：`node plugin/tools/install-teamkit.mjs`（**同时支持"仓内"与"包内"两种布局**）；
  · **可卸净**（安装器 `--uninstall` 只删带 `.teamkit` 标记的）；
  · **失败不静默**（缺源 / 漂移 / 回读失败都有显式日志与`EXIT` 码）；
  · **离线自测**：`node plugin/bin/teamkit.mjs selftest` ⇒ `PASS/FAIL/UNVERIFIED` 三态（**自己跑，别抄数** ——
    断言数每轮都在加；判据是**退出码**：`0` 全过 / `2` 有未验证 / `1` 有失败）。
  ⇒ **`runs/005-role-skills/exp/**` 下那些仍是实验件**（**不要**再往那边加东西）；**正解在 `plugin/`**。
  维护口径与同步命令见 `plugin/README.md`；设计与裁决见 `runs/005-role-skills/DECISIONS.md` P-33。
- **⚠️ 开源必读的限制（`DECISIONS.md` P-34 有逐行证据）：成员「只增不删」**
  roster **没有任何移除方法**（`roster.d.ts:47-97` 只有 9 个方法）；journal **没有成员移除事件**（只有 `team/member`/`team/task`/`team/message/*`）；`stopTeammates` **只停会话、不释放名额**（`roster.js:218-219`）。
  ⚠️ **更狠的一层**：**`phase='failed'` 的成员照样占名额、照样占名字，还会在 `list_agents` 里显示成一个 `failed` 成员**（重名检查 `roster.js:243` **无 phase 过滤**；名额按 `state.members.length` 算 `:246`；`memberView` 遍历全部 `:115`），
  但 **它发消息找不到**（`resolveActiveMember` 只认 `active`，`:22-25`）、**连 Team 身份都没了**（`tryMembership` 只认 `active`/`provisioning`，`:73-75`）⇒ **一个"看得见、用不了、删不掉"的僵尸**。
  ⇒ **"招错一个人" = 永久少一个名额。** 唯一"重开一局"的办法是**新开一个 Lead 会话**（配额随 root 走，`journal.js:20-21`），代价是旧 Team 的任务/消息看不到。
  **这三行必须原样进插件 README 的"限制"节** —— 开源用户最恨"装了才发现"。
  ✅ **【2026-09-14 Lead 复核更正】"删不掉"这半条**已经有插件层解法**（委托方硬指令「必须可以删」）**：
     · **能"释放名额"**：在我们的 fiber 里**包一层 `ctx.agentTeams.journal.state`**，过滤掉"已释放"的 id。
       承重链（我独立复核过）：`this.roster = new TeamRoster(ctx, this.journal, …)`
       （`dsh-experimental-agent-team/lib/types/index.js:107`；打包副本 `lib/index.js:1693`）
       ⇒ **roster 的资格检查与被包的 journal 是同一实例** ⇒ **名额真释放**，不是只改视图。
       成立的三件：**名单不再列出 / 名额真释放（过滤后 spawn 能写入）/ 不可再寻址**。
     · **不能"抹掉"（也不该做）**：`applyCurrentTeamEvent` 只有 4 个分支、**无移除分支**
       （`types/projection.js:175-233`，`members.push` 在 `:198`）⇒ 日志是 event-sourced，
       **抹掉 = 伪造历史**；**名字可复用**同样不成立（`invariant.js:353` 拒写）。
     · ✅ **【2026-09-14 / Round 33 已实现】该能力现已进插件本体**：`plugin/lib/release.js`
       （`wrapJournalState` / `makeReleaseManager`），在 `index.js` 的 `memberRelease.enabled=true` 时装配。
       **真宿主读数**（包装真 `TeamJournal.prototype.state`，过滤一个真实成员）：
       ```
       加工前: [judge-paper, judge-model]   2 人
       包装后: [judge-model]                1 人   ← 被释放者真从 Team 状态消失
       membership(被释放者) → "is not a member of an active Agent Team"  ← 不可再寻址
       还原后: 2 人回来了                        ← 卸载即净
       ```
       **离线自测**的 **`R` 组**覆盖该能力的**每一条**（**自己跑，别抄数** —— 条数每轮都在加）：
       过滤生效 / 不动底座数据源 / 还原干净 / 台账重放 / 无理由拒绝 / unrelease 幂等 / 失败给 why
       / **跨 Team 隔离** / 多实例登记簿 / 原型方法干净还原。
       ⚠️ **默认关**（`memberRelease.enabled=false`）：这是破坏性动作，不该"装上就生效"。
     细节与原始读数：`runs/005-role-skills/MEMBER-RELEASE.md`。
- **不接受 HANDOFF/PLAN 的验收判据作为本项目目标** —— 2026-09-12 委托方明确：目标是「把 OMC 那一套装到本地 agent team 上」，不是跑演示任务。那两份文档只在"范围与资产清点"上仍可参考。
- **四条硬事实（2026-09-12 实测，改设计形状，别再用想象覆盖）**：
  1. **编制上限已放开到 100（重启后实测招得进）；「名额」在插件层可释放（见上节更正），但「名字不可复用」不变。**
     - 上限**不是**本体硬编码：`DEFAULT_MAX_MEMBERS = 8`（`dsh-experimental-agent-team\lib\types\index.js:49`）只是默认值，本部署已在 profile 用户补丁层覆盖成 `maxMembers: 100`；
     - **重启后实测**：`spawn_teammate {name:"upstream-keeper"}` **成功**（member id `f36ac9d9-…`，第 9 个 teammate）⇒ **配置真的生效了**（读数见 `DECISIONS.md` P-25）；
     - **口径定死：名额不是约束，预算是约束**；取舍由 Lead 按预算做（委托方裁定，`DECISIONS.md` P-13.1）；
     - ⚠️ **"名字不可复用"那半条仍在**（`roster.js:243-247` `TEAM_MEMBER_NAME_TAKEN`、`roster.js:246-247` `TEAM_MEMBER_LIMIT`；`roster.d.ts:39` 原话 *"maximum **immutable** roster entries per Team"*）⇒ **"辞退重招"可以做到"释放名额"，但"复用同一个名字"仍断着**。
       ✅ **【2026-09-14 更正】** 本行原写「**不可回收** / 不可复用」—— **"不可回收"已不成立**：
       插件层包 `journal.state` 就能**真释放名额**（承重链与读数见上节"Lead 复核更正"）。
       ⇒ **抬上限让"招得起"；包 `journal.state` 让"辞得掉"；但"名字复用"仍做不到**（`invariant.js:353` 拒写）。
     - 另：名额是 **per Team root（= per Lead 会话）**，不是 per machine（`reviews/005-verdict.md` §1 的 scope 修正）。详见 `runs/005-role-skills/TWO-TIER.md` §7。
  2. **技能是「上游 + fork」两层（旧称 A 层 / B 层），两层都是"活的"，且是 overlay 关系**：
     - **上游**（旧称 **A 层**）= preset 那个 `skill-filesystem` 扫的 **6 个公共磁盘根**（`.dsh/skills` 100 / `.agents/skills` 200 / custom 300 / `$DSH_HOME/skills` 400 / `$DSH_AGENTS_HOME/skills` 500 / bundled 600）——**不是 per-preset 私有目录**；只有 Lead / PR 合并能改；
     - **fork**（旧称 **B 层**）= 插件在 `agent/created` 注册进**该 agent 自己 scope** 的 provider，**只存差异**（改过/新增的条）；它**想怎么改就怎么改**，只影响自己；
     - **overlay 语义（实测胜负手）**：同名条 fork 胜（*nearest layer wins outright*，rank 只在同层内比）；**fork 里没改的条自动来自上游** ⇒ **上游一更新，所有 fork 自动跟着变，零同步动作**。
     - **硬纪律：fork 绝不能"复制全量上游"** —— 一旦复制，未改的条变成静态副本，自动跟随立刻失效。
     - **PR**（旧称"沉淀通道"）= fork 里"觉得对大家也有用"的改动，**成员提、Lead 合**；合并后各 fork 自动拿到。**PR 不是晋升**（本区没有"晋升"这一说，见 `DESIGN-OMC.md` §2 与 `runs/005-role-skills/GROWTH.md`）。
     - 注入与卸载**当场生效**（fork 卸载后 3.6 秒回卷）。详见 `runs/005-role-skills/TWO-CHANNEL-DELIVERY.md`、`TWO-TIER.md` §1–§5、`DECISIONS.md` P-17/P-18。
  3. **【运营事实】本部署有两条模型路由，老成员全在"余额不足"的那条上。**
     - 可用：`superdeepseek / deepseek-v4.1-flash`（**新活只派这条**；新招的成员继承 Lead 当前路由）；
     - 不可用：`deepseek-official / deepseek-flash` —— `402 Insufficient Balance`（`code:"QUOTA"`），**额度问题，等多久都不会好**；
     - **绑定不可改**：`research-lead` / `engineer` / `reviewer` / `writer` / `marketer` / 三个探针**全在 402 那条上**，且**名字不可复用**（名额可在插件层释放，见上节更正）⇒ **不能用"重建同名队友"来换链**，只能**用新名字招新成员**（已有先例：`upstream-keeper` / `gate-reviewer` / `docs-writer`）。详见 `DECISIONS.md` P-26/P-27、`LANDMINES.md` §15/§15.1。
  4. **改 system prompt 不必"炸前缀"**：DeepSeek 官方默认条目声明了 `systemPromptUpdate:'in-history'` ⇒ 续序列时提示词**追加在缓存历史之后**；代价是**旧版本继续计费**。因此**要自我迭代的 `SOUL.md` 走 `agent/pre-step` 注 message**，不进 persona。详见 `SOUL-AND-CACHE.md` + `raw/lead-verify/LEAD-VERIFY.md`。
- **Lead 复核纪律**：队友的报告只是**线索**。本轮我亲自复核过：`in-history` 的三条代码链 + 本机日志、招募通道最后一格（真 teammate 双向）、**guard 的原始日志**（诚实口径：它只是**误操作护栏**，覆盖 `write`/`edit` 两个工具名；`pwsh` 绕得过、实测零审计 —— **禁止再把"写保护"说成"代码强制"**，见 `LANDMINES.md`、`DECISIONS.md` P-15/P-16）、编制上限的抛错与源码。**日志是压缩容器（多帧 zstd），单帧解压会造出"零命中"的假事实** —— 见 `LANDMINES.md` §11–§13。
