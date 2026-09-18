# 坑（先读这个；每条都是我踩过的）

## 1. 【最严重】往 live profile 里装包：link: 会把 DSH 弄挂
我用 `dsh plugin --profile <p> add link:<repo>/vendor/<pkg>` 装了一个修复版官方包。结果：
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-experimental-agent-team'
  imported from <另一个项目的仓>\vendor\dsh-experimental-tool-agent-team\lib\index.js
```
→ **每个会话 exit=1**（组合加载那一行就抛）。
**机制**：`link:` 在 pnpm 里是**符号链接**，而 Node 的 ESM 解析默认按**真实路径**走（preserveSymlinks=false）。
被链接的包物理上在仓库目录，它自己的 import 就从**仓库目录**往上找 —— 那里没有它的依赖。
**规矩**：一个会 import 同族包的包，必须**真的落在 profile 的 node_modules 里**。
可用形态（实测）：包放进 `<profile>/<适配器修复目录>/<pkg>/`，再用**相对** `file:` 声明。
**恢复手法**（当时没跑 pnpm）：删掉那条依赖 + 把另一 profile 里的官方实体副本拷回去。

## 2. pnpm 在本机（Windows + 空 PATH + homedir=<本机账户名>）的三个怪癖
- **绝对 file: 被当相对路径**：`file:/D:/…`、`file:D:\…`、`file:///D:/…` 三种都报 `ENOENT: scandir '<profile>\D:\…'`。只有**相对** file: 能用。
- **store 位置算错**：报 `ERR_PNPM_UNEXPECTED_STORE`，但它自己的报错里有正确路径 —— 解析 `linked from the store at X` 再重试一次（别硬编码）。
- **别跑 `pnpm install`**：它会试图 purge 整个 `node_modules`（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。要修就外科式改。

## 3. run_code 的进程生命周期（会让你以为测试挂了）
程序一结束，它拉起的 detached 子树**会被一起收走**：表现是套件跑到一半拿到 `3221225786`（= `0xC000013A`，被终止），日志里连判定行都没有。
**对策**：长套件要么在**同一个程序里轮询到结束**，要么拆小。别把「被收走」当成测试失败。

## 4. 本机环境事实（会让你算出错路径）
- `os.homedir()` 返回 **<本机账户名>**（真实家是 `<用户名>`）→ 任何按 homedir 找路径的逻辑都要**候选列表**，不要单一算法。
- `DSH_HOME` 要显式给（`<用户目录>\.dsh`）。
- `process.env.PATH` **可能空、也可能非空但没用** → 跑 npm/pnpm/git/node 要自己拼 PATH（node 目录 + npm 全局目录 + `C:\Program Files\Git\cmd` + `System32`）。
  **2026 实测**：PATH 非空（PowerShell 7 / CUDA / JDK / System32 / GitHub CLI 都在），**唯独没有 node** → `where node` 空、`Get-Command node` 空。
- **node 的实体在哪**（本机实测可用，别再猜）：
  - `<portable node 目录>\node.exe` ← **v22.20.0，实测能跑 `tools/*.mjs`**
  - 备选：`D:\app\Modex-MH-Agent\runtime\node\node.exe`、`D:\app\HBuilderX\plugins\node\node.exe`（版本可能偏旧）
  - 拼一发（powerShell）：`$env:PATH = "<portable node 目录>;$env:APPDATA\npm;C:\Program Files\Git\cmd;C:\WINDOWS\system32;$env:PATH"`
- `os.tmpdir()` 可能是**相对路径**（见过 `undefined\temp`）→ 临时目录要绝对化。

## 5. DSH skills 机制细节
- 扫描根（优先级从高到低）：`<项目>/.dsh/skills`（100）→ `<项目>/.agents/skills`（200）→ custom（300）→ `$DSH_HOME/skills`（400）→ `$AGENTS_HOME/skills`（500）→ bundled。
- 两种形态：**目录包** `<root>/<name>/SKILL.md`，或**扁平** `<root>/<name>.md`。
- frontmatter **必须有 name 和 description**（可选 whenToUse / invocation / metadata）；name 必须是合法 skill 名（kebab-case）。
- 正文**不进上下文**，由模型按需用 `skill` 工具加载 —— 这就是它比「加工具」省的地方。
- **不要**改 DSH 本体源码、不要加 profile 依赖。
  **但「插件（含运行时注入）」不是侵入**——那是 DSH 的开放扩展端口，可热卸可回滚（2026-09-12 委托方口径更正，原文把插件也误归为侵入，见 `AGENTS.md` 硬规矩 1）。
  优先级：skills（零 schema 成本、任何预设都吃得到）→ 插件（需要真强制、真工具面时才用）。

## 6. 沙箱会拒读 `<用户目录>` —— 检查脚本必须**三态**判定
本次（workspace-write）实测：`pwsh` **读不到** `<用户目录>\.dsh`
—— `Test-Path` / `Get-Item` 报 `Access to the path … is denied`，`cmd.exe` 连程序都起不来（`Program 'cmd.exe' failed to run: 拒绝访问`）。
**后果（真踩到）**：`existsSync(join(DSH_HOME,'skills'))` → `false`，于是 `verify-handoff.mjs` 报 `XX **没装**`。这是**假阴性**：
同一条路径用 `read` 工具读得出来，且本会话技能目录已列出 6 条 `teamkit*`（DSH 真的发现了）。
**规矩：读不到 ≠ 没装。** 判定必须三态，两个脚本已按此改：
| 状态 | 判据 | 输出 |
|---|---|---|
| 已装 | 读得到且齐 | `OK` |
| 没装 | 读得到但不齐 / `ENOENT` | `XX`（真失败）|
| **未验证** | `EACCES` / `EPERM` 等读不到 | `??`，**不给 PASS 也不算 FAIL**；`verify-handoff.mjs` 退出码 **2** |
**交叉验证的顺序**：工具面（`read`/`glob`）与 shell 面（`pwsh`）权限不同 —— 同一路径两边读数打架时，**先信工具面**，别急着下"没装/没有"的结论。

**同一条边界还会咬到管道**：把原生程序的 stdout 用 `|` 接进 PowerShell cmdlet（如 `& node x.mjs | Select-Object -Last 2`）会**整个起不来**：
`Program 'node.exe' failed to run: 拒绝访问`（沙箱不给命名管道）。
**对策**：直跑别接管道 —— `& node tools/x.mjs; echo "exit=$LASTEXITCODE"`；要截断就把输出重定向到文件再读。

## 7. 「看一眼用法」会删掉证据 —— 生成器脚本先看它会不会写
**2026-09-12 实测（一次真事故）**：评审员想查 `src/tools/refresh-selftest.mjs` 的用法，跑了 `node … --help`。
该脚本**不解析任何参数、无条件执行**（`refresh-selftest.mjs:20` 先 `rm -rf selftest-raw/` 再全量重生成），后果三连：
① 把别人（engineer）留下的**"修前红"历史快照删了**；② `SELFTEST.md` / `selftest-raw/**` 被换成新读数；
③ 事故期间它**撞上"代码正在被编辑"的半写窗口**，读到 `41 tests / 38 pass / 3 fail` —— **假红**。

**规矩（三条，都很便宜）**
1. **任何"生成 / 刷新 / 同步"类脚本，先 `read` 源码看它有没有无条件 `rm` / `write`，再决定跑不跑**；看不懂就别跑。
2. **工具脚本必须提供 `--help` 与 `--dry-run`，且默认与 `--help` 绝不写盘**；破坏性动作要在文件头显式写出来。
3. **只读角色（评审 / 审计）不得执行被审方仓库里的写脚本** —— 要复现就自己写探针、跑在 `os.tmpdir`
   （本项目的 reviewer 全程都是这么做的，只有那一次越界）。

**补救**：被删的原文若还能找回，**逐字另存**到只读方自己的目录，并当历史证据引用
（本例：`runs/001-money/reviews/regression-before-red.preserved.txt`）。

## 8. 交付物在动的时候，读数是会过期的
同一事故连着咬出第二口：`plan.md` 定稿于 17:59:31，而它引用的 `SELFTEST.md` 是 17:53:35 的（31/31）；
代码修复在 18:00–18:01 落地后变成 **46/46** → **"照做"文档拿被自己交付物取代的读数当验收证据**。
**规矩**：**任何引用了别人产物的文档，必须在被引用物定稿之后重基线**；
引用**不要写死编号**（"用例 31"会漂），改成按标题/路径引用。这条已落成 task-9 / task-11 的判据。

## 9. 机械校验最容易变成空壳：查「字段存在」≠ 查「值正确」
**2026-09-12 实测（Lead 自己犯的）**：reviewer 驳回 marketer 的 V4.0 后，我做了五条机器复核并报"全过"。
其中第 3 条是：`grep "合计"` 看到 `§5.2 合计 = 11.7–14.0` → **判过**。
reviewer 逐行相加：直播 7–8 + 长视频 2–3 + 专栏 0.5–1 + 动态 0.5–0.75 + 答疑台账 1.2–1.75 + 周复盘 0.5–0.75
= **11.7–15.25**，**上界超预算 14**；同一节里直播时数还有**三个不同的值**。
→ **我验的是"有没有写总和"，没验"总和等不等于逐行之和"。**

**规矩**：机械校验的判据要写成**关系式**，不是**存在性**：
- ❌「有没有写出合计」 → ✅「**合计 = 各行之和 ∧ 合计 ≤ 预算**」
- ❌「有没有引用来源」 → ✅「**引用的那页真有这个数字**」
- ❌「有没有改」 → ✅「**改后的值能由参数推出**」
这条与 §8 同族：**都是"形式对、内容错"**。存在性检查成本低、看着绿，但它不检验任何推导。
**凡是"算出来"的字段，必须能独立复算一次。**

## 10. per-agent 插件挂钩：三个实测坑 + 一条被我写错的机制（2026-09-12）
来源：`runs/005-role-skills/REPORT.md`（task-32 最小实验，跑完即卸）。**三条都是实测踩出来的，不是理论**。

1. **`agent.ctx.skills` 属性访问会被 cordis 的 inject 守卫拦掉**：`Error: cannot get property "skills" without inject`。
   **可用走法：`agent.ctx.get('skills')`。**（日志里的 `how=` 字段就是这条的证据。）
2. **`agent/created` 是同步钩子，监听器抛错会「否决 agent 发布」**（源码原文 *"Synchronous listener failure vetoes publication"*，
   `dsh-agent\lib\types\runtime-types.d.ts:217`，钩子签名 `:224-226`）。
   → 实验的第一版就在监听器里做了属性访问，**直接把 subagent 创建搞失败**（工具返回那句守卫错误）。
   **写在这个钩子里的代码必须防御式，且不能慢。**
3. **agent 身份必须按 name 读，不能按 id 猜**：实验第一版把 `63d3fcac…` 当成自己，实际那是 `research-lead`（自己是 `7f730a12…`）。
   **不纠正会拿到假阴性** —— 因为「**谁都看不到**」和「**隔离成立**」在读数上长得一模一样。
   > 这条是 §9 的同族：**否证性读数必须给出"阳性对照"**，否则你分不清"没命中"和"没生效"。

**同时纠正我写错的一条机制**：我在此前笔记与本项目 003 里写过「`send_message` 给 inactive 成员**必然冷恢复**」。
本轮实测：给 inactive 的 `writer` 发消息 → 返回 `status:"queued"`，**45 秒后 writer 仍 inactive、文件没生成**。
→ **冷恢复没有发生**（原因未获取）。**"会排队"是代码强制；"会冷恢复"不是每次都成立** —— 别把前者写成后者。

## 11. 【我（Lead）自己踩的】会话日志是**多帧 zstd** —— 单帧解压会造出"全是幻觉的零命中"（2026-09-12）
来源：复核 task-36 时自写 `runs/005-role-skills/raw/lead-verify/decode.mjs`。

1. **日志容器**：`~/.dsh/sessions/<编码cwd>/<session-id>/session.v3.jsonl.zstd`，**一次 append 一帧**（多帧）。
   `node:zlib` 的 `zstdDecompressSync` **只解第一帧** → 只拿到 1 行 `{"type":"session"}` header。
   本机实测：`4c95c722` 单帧解 → **1 行**；按帧魔数 `28 B5 2F FD` 切分逐帧解 → **FRAMES 10 / OK 10 / FAIL 0 / EVENTS 27**。
   > 直接后果：**用单帧解压去 grep 会话日志，会得到"零命中"**，而那个零命中**什么都不能证明**（engineer 报的 `in-history` 我一开始就是这么"没搜到"的）。
   > **规矩：先确认"帧数=N、失败=0"再取数；帧数对不上就别下结论。**
2. **字段路径**：`surfaceOp` 在**事件顶层**（`{"type":"system/message","seq":9,…,"surfaceOp":"append"}`），**不在** `intent` / `data` 里。
   我按 `e.intent?.surfaceOp ?? e.data?.surfaceOp` 取 → 全 `null` → **差点把工程师的实测读数判成编造**。
3. **"字节数不一样"先怀疑自己的量法**：`8797` 是 `message.content` 的**文本长度**；我量的是 `JSON.stringify(content)`（多 100 B 包装）→ 8897。
   两个数都不假，**量的不是同一样东西**。差异出现时，**默认先核自己的量法，而不是先判对方错**。
4. **`surfaceOp` 是可二值区分的**（`dsh-session\lib\index.js:277-279`）：`"append"` 是**字符串**，`replace` 是**三键对象** `{op,startSeq,endSeq}`。
   → 判断"走没走 in-history 分支"**不能只看 `append`**：`project()` 的 `head===undefined` 分支（`dsh-agent-loop\lib\index.js:269-272`）**也返回 append**。
   **必须找"head 已存在且文本已变、却仍记 append"的那一条**才是决定性读数（本机 = seq=22）。

> 一句话：**否证一个别人的读数之前，先证自己的取证链路是完整的**（否则 §9/§10.3 那类假阴性会换个壳再来一次）。全文读数见 `runs/005-role-skills/raw/lead-verify/LEAD-VERIFY.md`。

## 12. 【硬约束】**编制上限 8 人，名额不可回收、名字不可复用** —— 我为此白扔了 2 个名额（2026-09-12）
**踩法**：起探针 teammate 时**没先查上限**，起第 3 个才被拒：`Error: Team member limit 8 reached`。

**根因（逐行读过）**：
- `dsh-experimental-agent-team\lib\types\index.js:49` `DEFAULT_MAX_MEMBERS = 8`；`:81` schema `maxMembers`；`:98` `config.maxMembers ?? DEFAULT_MAX_MEMBERS`
- `\lib\types\roster.js:246-247` → `TEAM_MEMBER_LIMIT`
- `\lib\types\roster.js:243-244` → **重名直接抛 `TEAM_MEMBER_NAME_TAKEN`**（`was already used in this Team`）
- `\lib\types\roster.d.ts:39` 原话：**"maximum immutable roster entries per Team"**
- **上限按 teammate 计，lead 不占名额。**

**本部署的 8 是配置给的**（不是本体硬编码）：`profiles\web\node_modules\@deepseek-ai\dsh-experimental-agent-team-profile\cordis.patch.yml` 里
`- insert: - id: agent-team / config: { maxMembers: 8, … }`；而 `profiles\web\cordis.patch.yml`（**用户补丁层，在所有 bundle 层之后**）加
`- id: agent-team / config: { maxMembers: N }` 就能抬 —— **属配置，不属改本体**；代价 = **重载 profile / 重启 `dsh web`**。

**为什么这条比它看起来严重**：
- **直接否掉"OMC 式无限招人 / 辞退后重招"** —— OMC 的 `execute_fire` + 重招在这里**没有承载面**：名额 immutable、名字不可复用。"换人"这条路在 DSH Team 层**是断的**（这也反向印证了 005 那条结论：考核只能往"自我修正"走）。
- **探针很贵**：一个探针 = 一个**永久占用**的名额。**起 teammate 之前先看还剩几个名额，并想清楚它是不是必须是个 roster 成员**（能当 `subagent` 一次性子代理做的，就别起 teammate）。

## 13. 两条读数打架时：去取**系统当时实际发出去的原文**，别问当事人（2026-09-12）
**现场**：`tier-probe-target` 给了两条互相矛盾的收尾答案（先说 B 层遮蔽生效，后说没有）。
**我没有挑一条信**，而是解压它自己的会话日志，取每轮 `user/message` 里的 `<available_skills>` 原文：
`seq=13`（10 条，含 `tier-probe-b`）/`seq=36`（7 条，无）—— 插件日志 `PLUGIN-DISPOSE` 夹在两者之间（`12:04:55.793Z`）⇒ **两条都真**：前者是正读数，后者是**卸载即回卷**的读数（3.6 秒内、无需重启）。
**规矩**：
1. 当事人自述会**跨越状态变化点** —— 同一个 agent 在不同时刻说两句反话，可能两边都对。
2. 判据要用**系统注入的原文 + 时间戳**（会话日志里的 surface/reminder），**别用"你看到了什么"**。
3. 先找**状态变化的时间戳**（这里是 `PLUGIN-DISPOSE`），再判断每条读数落在变化点的哪一侧。

## 14. profile patch 的两条语义（**其中一条纠正了 `cordis.patch.yml` 自己的注释**）（2026-09-12）
来源：委托方要改 `maxMembers`，我不敢直接让他重启 —— 先去核"重启会不会起不来"。核完发现**两边都和我原先以为的不一样**。

### 14.1 「patch 指向不存在的 entry」是 **warn，不是致命** —— **文件里的注释是错的**
- 实读 `cordis-plugin-include@1.0.7\lib\index.js`：`:91-95` `const target = entryMap.get(id); if (!target) { warn("patch: entry %C not found", id); continue; }` —— **只告警并跳过**；insert 路同理（`:72-76`）。
- 而 `<用户目录>\.dsh\profiles\web\cordis.patch.yml` 开头写着：「新版 dsh（0.1.5-rc.1）把「patch 引用了不存在的 entry」从警告改成了**致命错误**：`patch: entry "X" not found` → profile 拒绝加载 → `dsh web` 起不来」，并据此在 2026-09-10 删掉了 20 条 `disabled: true` 条目。
- ⇒ **这条注释对当前安装的 1.0.7 不成立。** 真正致命的是**另一件事**：**重复 id** —— `cordis-plugin-loader\lib\index.js:91` `if (seen.has(id)) throw new TypeError("duplicate loader entry id: " + id)`。
- **后果**：注入器每次卸载插件都会往这个文件追加一条 `- id: <pkg> / disabled: true`，**这些悬空条目现在有 6 条**（5 个探针 + org-panel），**它们不会阻止 profile 加载**。
  但那条注释会让人以为"必须清掉才能起" ⇒ **诱导后人做一次不必要的危险编辑**。**已按实测把注释改正。**

### 14.2 **config 覆盖是按顶层键赋值，不是深合并** —— 写一个键会**换掉整个 config 对象**
- `cordis-plugin-include@1.0.7\lib\index.js:100-103`：`for (const [key, value] of Object.entries(overrides)) { if (key === "id") continue; target[key] = value; }`
  ⇒ 写 `- id: agent-team / config: {maxMembers: 100}`，**是把 bundle 那句 `config: {maxMembers: 8, maxTasks: 256, maxPendingMessagesPerMember: 64, maxMessageBytes: 65536, disposalTimeoutMs: 5000}` 整个替换掉**。
- **本例侥幸无害**：那四个值正好等于 schema 默认值（`dsh-experimental-agent-team\lib\types\index.js:50-53` 的 `DEFAULT_*`），回落不产生差异。
  **但换一个插件就会静默丢配置** —— 这是"查字段存在 ≠ 查值正确"（§9）的又一个同族。
- **规矩**：在 profile patch 里覆盖 `config` **必须把该 config 的键写全**，别只写你想改的那一个。已按此把 `agent-team` 的五个键写全。

### 14.3 重启前的最小检查清单（可机械跑）
1. **目标 entry 的 id 确实存在**（是某个 bundle patch `insert` 进来的，或已有条目）—— 不存在的只会 warn，**于是你的改动被静默忽略**（这才是真风险：**改了没生效，而你没发现**）。
2. **全文件 id 唯一**：取 `^\s*- id:` 后 `Sort-Object -Unique` 计数比对（重复 = 致命）。
3. 覆盖 `config` 时**键写全**（14.2）。
> 本机实测（2026-09-12）：`cordis.patch.yml` 共 **10 个 id，全部唯一** ⇒ **重启安全**。

## 15. 队友"失败且无收尾消息"时：**先去日志里找逐字错误码，别猜、别换人**（2026-09-12，我猜错三次）
**现场**：`send_message` 派活 → 收到 `accepted` → 队友 `failed before it finished`、**无收尾消息**。**连续四次**（engineer ×3、新招的 `upstream-keeper` ×1）。

**我猜错三次**：
1. "**宿主重启（22:28）打断了回合**" —— 时间线只是相关，**无证据**；
2. "**engineer 会话 5.55 MB 过重**" → **换人**招了新会话 ⇒ **新会话（46.6 KB，干净）照样失败** ⇒ 白换；
3. "**三次失败都是 503**" —— **错**。engineer 是 **402**，只有 `upstream-keeper` 是 503。**两条不同的链，两种不同的故障。**

**逐字读数（解压会话日志取 `turn/end` / `assistant/attempt` 的原始 JSON）**：
```
# engineer（路由 deepseek-official / deepseek-flash），turn 12/13/14 连续三次：
{"type":"turn/end","data":{"turn":14,"reason":{"kind":"error",
  "error":{"message":"Insufficient Balance","code":"QUOTA","status":402}}}}

# upstream-keeper（路由 superdeepseek / deepseek-v4.1-flash）：
{"type":"llm/retry","retry":5,"maxRetries":5,"failure":
  {"message":"503: {\"message\":\"system cpu overloaded (current: 98.3%, threshold: 90%)\",\"code\":\"system_cpu_overloaded\"}","code":"SERVER"}}
每次都是 inputTokens:0 / outputTokens:0  ⇒ 模型一个 token 都没产出
```

**规矩（可复用）**：
1. **队友失败先看它的会话日志**，且**必须看 `turn/end` 的 `reason.error` 原文**：
   解压 `~/.dsh/sessions/<编码cwd>/<id>/session.v3.jsonl.zstd`（**多帧 zstd**，见 §11），
   工具：`runs/005-role-skills/raw/lead-verify/decode.mjs`。
   > ⚠️ **2026-09-13 加固（我在这里第三次猜错）**：
   > **判失败原因只用 `decode.mjs <sess> errors`** —— 它一行一条给 `seq + message + code + status`。
   > **不许用 `seq <n>` 去"探索尾部"**：它只截断 `message.content`，**别的巨型字段（工具 schema）会把输出淹掉**，
   > 于是你会**读到中段却以为读到了尾部** ⇒ 下出自相矛盾的结论。
   > **拿不到尾部就先把工具修好，别凭中段下结论。**（新增 `tail N` 模式：尾部事件 + 递归截断。）
2. **两种故障处置完全不同**：
   - **`503 system_cpu_overloaded`（`code:"SERVER"`）** = 服务端过载 → **退避 500ms→10s、上限 5 次** ⇒ **窗口内重派没用，等**；
   - **`402 Insufficient Balance`（`code:"QUOTA"`）** = **额度/余额不足** ⇒ **等多久都不会好**，必须**换路由或充值**。
3. **`inputTokens:0` 是"根本没产出"的好判别信号**（正常回合不可能是 0）。
4. **服务端/额度故障不要换人、不要改任务设计** —— 那是把环境故障误判成 agent 问题（我换人那次就是白做）。

## 15.1 本部署**同时存在两条模型路由**，且**老成员固定绑在旧路由上**（2026-09-12 实测）
| 成员 | 路由（各自会话 `request/context` 原文） |
|---|---|
| **Lead** | `superdeepseek / deepseek-v4.1-flash` |
| **新招的 `upstream-keeper`** | `superdeepseek / deepseek-v4.1-flash` |
| **旧队友全体**（engineer / research-lead / reviewer / writer / marketer / 三个探针） | **`deepseek-official / deepseek-flash`** |
- 配置出处：`<用户目录>\.dsh\settings.yaml:3-6` 现为 `provider: superdeepseek`、`model: deepseek-v4.1-flash`；
  而**已存在的队友会话仍按它们创建时的路由跑**（`request/context` 是**每会话**记录的）。
- **后果（要紧）**：**同一个 Team 里，不同的成员可能跑在"额度/健康状态完全不同"的两条链上** ——
  **一个成员 402、另一个成员 503，看起来都是"失败"，根因却不同**。⇒ **派活前若怀疑是服务端问题，先看那个成员自己的路由与错误码。**

## 16. 重启会**清掉 Lead 侧的文件读取状态**（2026-09-12）
重启后第一次 `edit` 报 `cannot modify ...: file has not been read`，**但我在重启前明明读过那个文件**。
⇒ **这不是权限问题、不是版本冲突，是会话内的读取记账被重置了。** 处置：**重新 `read` 一次再改**，别当成 FS_STALE_VERSION 去 rebase。

## 17. 编制放开后**立刻验证"招得进"**，比看配置时间戳硬（2026-09-12）
判断 `maxMembers` 改动有没有生效，**别只看文件时间 vs 进程启动时间**（那是间接证据）——
**直接 `spawn_teammate` 一个**：重启前被拒（`TEAM_MEMBER_LIMIT 8`）、重启后成功 = **确证**。

## 18. 写了"未知事件类型"进会话日志 ⇒ **整份日志被拒**（2026-09-13，真事故）
**现场**：一个探针用**启发式**（"遍历 live agents，找谁的 Team state 有 members"）猜自己的 Team root，
**猜中了一个外来会话**（别的项目、cwd=`<另一支队的项目目录>`），并往**它的日志**里 append 了一条自定义事件
（`member-release/tombstone`，**没有 `ignorable: true`**）。

**为什么是硬伤**：`dsh-session-persistence\lib\index.js:184`
```js
if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
  throw unsupported(`session "…" contains event type "…" (seq …) unknown to this harness and not marked ignorable; refusing to interpret the log …`)
```
⇒ **整份日志被拒绝解释**（`SessionFormatUnsupportedError`），**没有忽略/修复开关**（三处 load 路径都校验：
`dsh-session-persistence-jsonl\lib\index.js:1816/2576/2679`）。

**两条可复用的救命知识**：
1. **修法（内存层，对"活会话"也安全）**：`KNOWN_SESSION_EVENT_TYPES`（`dsh-session\lib\index.js:79`）
   是 **`new Set([...])`、未冻结**，且**校验方 import 的是同一个实例** ⇒ **`.add('<type>')` 即可放行**：
   ```
   BEFORE  validate(未知类型) → THROW SessionFormatUnsupportedError
   ADDED   .add(type)  returned-same-set=true
   AFTER   → NO-THROW       CONTROL 好事件 → NO-THROW（证明校验器仍活）
   ```
   **不改文件、不碰活会话、不丢并发事件。** （宿主内存态，**重启后失效**。）
2. **永久修法是 `ignorable: true`**（这个 envelope 字段的**设计意图**就是"读方不认识时可安全跳过"，
   `session.append` 塞不进去 ⇒ 只能改已落盘那一帧）：**只 +9 字节、seq 连续、留痕不丢**。
   ⚠️ **别用"删帧"** —— 会留下 **seq 空洞**（`assertContiguous`，`dsh-session-persistence:229`
   要求 `seq === cursor + index`），现在能开但空洞永久留在日志里。

**根因与硬约束（比修法更重要）**：
- **任何写操作，目标必须由人或明确配置指定 —— 禁止启发式猜**；
- **对"不是本任务明确指定"的会话，一律只读**；
- **要写先只读验证 + 在副本上做**；
- **破坏性写入前必须先有可回退物**（本次**没有备份就开始写**，这是最该改的一点）。
> 反过来说，**这个探针的处置是对的**：发现后**停手 + 上报 + 先在副本验证修复方案**，没有继续扩大。
> 而且它把教训**写进了工具本身**（`plan.json` 的 note："rootAgentId 必须显式给定……缺失则拒绝运行"）——
> **把纪律做进工具，比写进报告可靠。**

## 19. **"声称已卸载" ≠ "真的卸载"** —— 必须查 registry（2026-09-13）
**现场**：事故方报"已卸载插件、已停手"，但我查 `dev_injected_list` / `dev_plugin_status`：
`dsh-member-release-probe` **仍是 `[active]`**，junction **仍在**（`Test-Path` = True）。
（它只往自己的日志写、无定时器，**没有实际危害**，但**与"已卸载"的说法不符**。）
**规矩**：**卸载后必须机械核对三处** ——
1. `dev_injected_list` 里**没有**它；
2. `Test-Path <profile>/node_modules/<包名>` = **False**；
3. `dev_plugin_status` 的 loader entries 里**没有**它。
> **"我卸载了"是一句话，"三处都是 False"才是证据。** 与 §9「字段存在 ≠ 值正确」同族。

## 18. **技能根下放 `CHANGELOG.md` 会变成一条技能**（2026-09-12，实测）
**现场**：想把"上游更新说明"放在技能目录旁边 → **它当场变成技能目录里的一条**（`available_skills` 里真出现了 `root-changelog-decoy`）。
**机制**：`dsh-skill-filesystem` 扫根目录时**按目录项发现技能**，**不会因为文件叫 `CHANGELOG.md` 就跳过**。
**规矩**：**任何非技能文件都不要放在技能扫描根下**（含 `README.md` / `CHANGELOG.md` / `.history/` 之类）——
要么放到**扫描面之外**（比如 `<projectRoot>/<某个不在 6 个根里的目录>/`），要么放进**每条技能自己的子目录**。
> 同族：`.history/<skill>/<digest>/SKILL.md` 放在**深度 3** 是安全的（实测 `(a)_HISTORY_LEAKED=false`）；**放深度 1 就会被当技能**。

## 19. **PowerShell `Set-Content -Encoding UTF8` 写 BOM ⇒ 整条技能静默失效**（2026-09-12，实测）
**现场**：用 `pwsh` 写 `SKILL.md`，首字节变成 `EF BB BF 2D`（BOM + `-`），
日志报 `WARN … missing YAML frontmatter`（`parseFrontmatter` 在 `dsh-skill-filesystem:772-775`）⇒ **frontmatter 解析失败 ⇒ 该技能静默无效**。
**规矩**：**改技能文件必须用无 BOM 的 UTF-8**。`pwsh 5.1` 的 `-Encoding UTF8` **默认带 BOM**；
用 `[System.IO.File]::WriteAllText($p,$s,(New-Object System.Text.UTF8Encoding $false))`，或用 DSH 自己的 `write` 工具（不写 BOM）。
> **为什么这条危险**：**不报错、不崩溃，只是那条技能"没了"** —— 又一个"字段存在 ≠ 值正确"（§9）同族。

## 20. **按步轮询会折叠突发提交**：一个步内连改多次 ⇒ 中间版本连说明一起被跳过（2026-09-12，实测）
**现场**：把 v3 / v4 在**同一个步间隔内**连着写，`UPSTREAM-CHANGED` 从 `c9388026` **直接跳到** `a3db8dda` ⇒ **v3（`019ae507`）既没通知、也没快照**。
**根因**：察觉机制是**按步轮询 sha1**（`task-45` 实测的钩子，见 `runs/005-role-skills/UPSTREAM-NOTIFY.md` §A），**粒度 = 一步**；一步内的多次写入**只留最后一次**。
**规矩**：**要"每次变更都有说明/都有快照"，快照或提交必须挂在"写"这个动作上，不能挂在"察觉"上。**
⇒ 这是**推荐真 git（commit 挂在写上）而不是只做快照轮询**的**实测理由**（不是口味问题）。

## 21. `ctx.get('agents').list()` 的条目**没有 `name` 字段** —— 按 name 装 fork 必须走 `agent/created`（2026-09-12，实测）
**现场**：想按 roster name 事后给 live agent 装 fork → 10 个 live agent 全打印 `(noname)` ⇒ 按 name 匹配直接 `TARGET-NOT-LIVE`、**三件套一个都没装**；改按 **agent id** 才装上。
**⇒ 精确化 task-37 的口径**：**「`name` 可用」限定在 `agent/created` 的载荷上**（那时 `tryMembership(agent).name` 有值）；
**"按 roster name 装 fork"必须走 `agent/created`**，**不能在 `agents.list()` 里事后匹配**。

## 22. `dev_uninject_plugin` 会**删掉同名的 profile 依赖 junction** —— 三处状态立刻不一致（2026-09-13，我踩了）
**现场**：我先把 `@dsh-external/dsh-teamkit` 装成 **profile 依赖**（`pnpm add link:…` ⇒ `package.json` 的 `dependencies` 有一条 + `node_modules` 下真 junction + lock 有记录）；
然后为了试用又 `dev_inject_plugin`，用完 `dev_uninject_plugin` 卸载 —— **卸载器把那个 junction 删了**，而：
- `package.json` 里**依赖声明还在**；
- `pnpm-lock.yaml` 里**条目还在**；
- `node_modules` 下**包没了**。
⇒ **三处不一致**。后果：**任何用 package 名引用它的东西（如 `omc` 预设那一行）都会解析不到** ⇒ 预设被判 **broken / 选择器里不可见**，**而且不报错，只让预设消失**。

**根因**：**注入器与 profile 依赖共用同一个 `node_modules/<pkg>` 路径**；卸载器按"它自己装的"来清，不看 `package.json` 是否声明。

**规矩**：
1. **同一个包不要同时用"profile 依赖"和"运行时注入"两种身份** —— 要用哪种就用哪种；
2. **卸载注入后必须核对三处**：`node_modules/<pkg>` 存在？`package.json` 里还在？lock 里还在？**不一致就用 `pnpm install` 收敛**（实测：它会把 junction 补回来，退出码 0）；
3. **判断依赖是否"真在位"，看 junction，不要看 `package.json`** —— 声明 ≠ 装上（§9 同族）。

## 23. 插件状态目录**跟 `process.cwd()`** ⇒ 多项目串台（2026-09-13，真宿主实测）
**现场**：`dsh web` 的 `process.cwd()` = `<DSH 工作根>`（**不是**任何项目的工作区）⇒ 插件把 `stateDir`/`logFile`/`forks`/`history`/`CHANGELOG` 全建在 **`<状态目录>`**。
而宿主里同时有 **`cwd=<另一支队的项目目录>`** 与 **`cwd=<本仓>`** 的 agent ⇒ **两个项目共用同一个状态目录**。
**依据**：`plugin/lib/config.js:122` `opts.cwd ?? process.cwd()`、`:130` `workspace = … ?? cwd`、`:137` `stateDir = … || join(workspace,'.teamkit')`。

**正解（已取到证据）**：宿主内 `ctx.get('agents').list()` —— **每个 agent 都带自己的 `session.header.cwd`**：
```json
[{"id":"session-487d27a4-…","cwd":"D:\\<另一个项目>"},
 {"id":"session-fa986645-…","cwd":"D:\\dsh\\omc-agent-teams"},
 {"id":"78bb5881-…","cwd":"D:\\dsh\\omc-agent-teams"}]
```
⇒ **定位语义应跟 `agent.session.header.cwd`**，不是 `process.cwd()`。
⚠️ **张力**：`apply()` 启动**只跑一次**，而 agent 的 cwd 各不相同 ⇒ 必须分清"**按 agent 分**"与"**全局一份**"（fork / 台账 按 agent；上游根 / CHANGELOG 全局）。

## 24. 预设**一旦会话跑过就锁死** —— `turnBoundary` 是判据（2026-09-13，真宿主实测）
`dsh-agent-presets\lib\index.js` 的 `swap()`：`boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null` ⇒ 抛 `agent-preset/locked`。
**真宿主四条原文**：
```
session-487d27 (<另一个项目>)  openTurnStartSeq=null  lastTurn=385   ← 锁
session-fa986645 (Lead)    openTurnStartSeq=5673  lastTurn=67    ← 锁（且正开着 turn）
78bb5881 (plugin-smith)    openTurnStartSeq=2233  lastTurn=3     ← 锁
f36ac9d9 (upstream-keeper) openTurnStartSeq=2129  lastTurn=6     ← 锁
```
⇒ **"换预设"只对"还没开始的会话"可行** ⇒ 要跑在某个预设下，**必须新开会话时选**（或找 `agent/created`/`session-start` 那个"装配前窗口"——`task-55` 在攻）。
⇒ 另：`agentPresets.defaultId = "standard"`；`roots` = shipped(`trust:system`) + user(`trust:user`)。
