# 已实测读数（照抄原文，不是「应该能跑」）

## 1. DSH 原生 skills 发现（这套方案的落点证明）
```
$ node tools/install-teamkit.mjs
teamkit 安装
  源：…/teamkit
  落点：<用户目录>\.dsh\skills  以及  <用户目录>\.dsh\teamkit\talents
  完成：6 个 skill 目录 + 6 份 talents

# 装完后，在真会话里加载：
skill teamkit        → provider=filesystem  正文 1148 字符
skill teamkit-review → provider=filesystem  正文  735 字符
# 会话技能目录（系统注入的 available_skills）列出 teamkit 全家
```
**结论**：skills 是**按需加载、零 schema 成本、任何预设都吃得到**的包装形式 —— 这就是「通用增强」的落点。

## 2. <另一个项目> 侧的「建议编制」（gsd_team 现在就会打）
```
建议编制（可反驳）：
  层级：2 层 —— 两条以上的线各自有大块活 → 每条线一个主管
  门禁：strict —— 项目有 1 份契约（契约敏感）
  岗位：engineer(lead)@deps + engineer(lead)@engine-seam + engineer(lead)@entrypoint + engineer(lead)@global-instr + engineer(lead)@integration + chief(ceo) + reviewer(ic)
  招募：先翻 teamkit/talents（建议：engineer, chief, reviewer）；缺口就现写一份 Talent 并落盘
```
（源码见 `<交界目录>/team-bridge-org.md`。）

## 3. 回归读数（改动之后）
```
plugin/test/smoke.mjs               → PASS（35 通过 / 0 失败）
plugin/test/engine.test.mjs         → PASS（20 通过 / 0 失败）
plugin/test/workflow-bridge.test.mjs → PASS（33 通过 / 0 失败）
```

## 4. 事故三连（link: vs file:）—— 见 LANDMINES 第 1 条
```
① profile 依赖 link:<repo>/vendor/…   →  ERR_MODULE_NOT_FOUND: Cannot find package
                                        '@deepseek-ai/dsh-experimental-agent-team' imported from
                                        <另一个项目的仓>\vendor\dsh-experimental-tool-agent-team\lib\index.js
                                      → 每个会话 exit=1（会话日志里一条痕迹都没有）
② profile 依赖 file:/D:/… （绝对）     →  ENOENT: scandir '<profile>\<另一个项目的仓>\vendor\…'
③ 包放进 <profile>/<适配器修复目录>/ + 依赖 file:./<适配器修复目录>/…（相对）
                                      →  node_modules 里是**实体**；
                                         createRequire(它自己的位置).resolve(同族包) ✓
                                         e2e-brief 16/16、e2e-agents 9/9
```

## 5. 论文事实（引用时别写错）
- 标题：*From Skills to Talent: Organising Heterogeneous Agents as a Real-World Company*
- arXiv：**2604.22446**（作者含 Zhengxu Yu 等）
- 构件：Talents（可移植身份）/ Talent Market（按需招募）/ **E²R**（Explore-Execute-Review 树搜索）/ 组织接口
- 读数：PRDBench **84.67%**，比 SOTA **+15.48**；**摘要**声称 termination 与 deadlock-free
- **2026-09-12 对全文的校正（取证见 `notes/omc-paper.md`）**：
  - 正文**无编号定理**（Theorem/Proposition/Lemma/Proof 零命中）。「形式保证」的原材料只有 §2.2.3 一句（前提：执行器遵守超时契约）与 §2.2.4 七条不变量；deadlock 的落点是**死锁探测器判失败**，不是证明。
  - **无消融实验**（§5 自陈 "not yet quantitatively ablated"）；PRDBench 基线是**引用他人报告值**而非复跑；成本 **$345.59/50 题 ≈ $6.91/题**；**无 token 数与层深收益读数**。
  - 推论：`OPEN-QUESTIONS.md` 第 1 条「层级有没有收益」在论文里**没有答案**，本区的 tier=1 vs tier=2 A/B 是补空白，不是重复。
- 委托方提到的「派定律」：**摘要里没有同名定律**；对应的是上述形式保证（要追查正文引的定律，需下 PDF 再核）

## 6. 工具链修正（2026-09-12）——「读不到 ≠ 没装」
**症状**：`verify-handoff.mjs` 第 14 项报 `XX **没装**`，但同一路径用 `read` 工具读得出、本会话技能目录已列出 6 条 `teamkit*`。
**根因**：沙箱下 `pwsh` 读 `<用户目录>\.dsh` 被拒（`Test-Path`/`Get-Item` → `Access to the path … is denied`；`cmd.exe` 起不来 → `拒绝访问`）；
`existsSync` 于是返回 `false` → 被当成「没装」。**假阴性**。
**修法**：两个脚本的安装判定改成**三态**（已装 / 没装 / **未验证**）；读不到既不给 PASS、也不算 FAIL。

修后实测（node 用实体路径 `<portable node 目录>\node.exe`，v22.20.0）：
```
$ node tools/verify-handoff.mjs
  OK  …（13 项：文件齐 / 6 个 SKILL.md frontmatter 合法 / talents 6 份）
  ??  装没装 **未验证** —— 读不到 <用户目录>\.dsh\skills（EPERM）。这不是「没装」…
判定：UNVERIFIED（13 通过 / 0 失败 / 1 未验证）
exit=2

$ node tools/install-teamkit.mjs --check
  ??  teamkit（未验证：读不到落点 EPERM —— 这不是「没装」）
  ??  teamkit-a2a / teamkit-assemble / teamkit-escalate / teamkit-org / teamkit-review（同形）
  有 6 个**未验证**（读不到落点 <用户目录>\.dsh\skills …）
exit=0
```
**交叉证据（工具面，用来判「到底装没装」）**：
`read <用户目录>\.dsh\skills\teamkit\SKILL.md` 成功，正文与 `skills/teamkit/SKILL.md` **逐字一致**；`…\teamkit-review\SKILL.md` 同样成功。
外加本会话系统注入的 `available_skills` 列出全部 6 条 `teamkit*` → DSH 确实发现并加载了它们。
**诚实边界（未验证，别当已查）**：`$DSH_HOME/teamkit/talents/` 下那 6 份 talent 是否就位**未读**；`<用户目录>\.dsh` 其余内容未清点。

### 6.1 三态负向测试（用临时 fixture 把四种路径全走一遍，跑完即删）
fixture = `.tmp-selftest/skills/<6 个 skill>`（复制自 `skills/`），用 `DSH_HOME` 指过去造状态：

| 用例 | 造法 | 实测输出 | 退出码 |
|---|---|---|---|
| A 全齐 | `DSH_HOME=.tmp-selftest` | `OK 已装到 …\skills：teamkit …` / 判定 **PASS**（14 通过 / 0 失败 / 0 未验证）| **0** |
| A' `--check` | 同上 | 6 条 `OK （一致）` | 0 |
| B 真没装 | `DSH_HOME=.tmp-nonexistent` | `XX **没装全** —— 一个都没有` / 判定 **FAIL**（13/1/0）| **1** |
| B' `--check` | 同上 | 6 条 `-> （待装）` + `有 6 个没装`（**没有**误报"未验证"）| 0 |
| D 装一半 | 删掉 fixture 里 3 个 skill 目录 | `XX **没装全** —— 只有 teamkit teamkit-assemble teamkit-escalate` / **FAIL** | **1** |
| C 读不到 | `DSH_HOME=<用户目录>\.dsh`（沙箱拒读）| `?? 装没装 **未验证** —— 读不到 …（EPERM）` / 判定 **UNVERIFIED**（13/0/1）| **2** |

**结论**：三态互不吞并 —— 假阴性没了（C 不再报 FAIL），真失败也没被掩盖（B/D 仍 FAIL）。
**顺带踩到**：沙箱下 `& node x.mjs | Select-Object …` 直接起不来（`Program 'node.exe' failed to run: 拒绝访问`，命名管道限制）→ 原生程序别接 PowerShell 管道，已记进 `LANDMINES.md` §6。

## 7. 2026-09-12 · 对着原版取证 + 组织层落到「协议 + 可视化」

### 7.1 取证（论文 + 原版仓库）
- 论文 arXiv **2604.22446** HTML 全文（含附录 A–H）读完；原版仓库在本地 `<原版 OMC 目录>`
  （`origin = github.com/1mancompany/OneManCompany.git`，`HEAD = 1855764` = PR #429）。
  `github.com` 被本机 DNS 策略拒（解析到非公网 IP）→ **云端代码看不了，本地实体替代**。
- 另一份 OMC 全量副本 `<原版 OMC 检出目录>`：硬常量**逐字一致**
  （`MAX_REVIEW_ROUNDS=3` / `MAX_CHILDREN_PER_NODE=10` / `MAX_TREE_DEPTH=6` / `MAX_HOLD_SECONDS=1800`），仅行号差 7 行。
- 产出 5 份笔记（`notes/`）：`omc-paper.md` / `omc-engine.md` / `omc-talent-market.md` / `dsh-agent-teams-api.md` / `omc-to-dsh-internalization.md`。
- 三条校正已回写：`DESIGN-OMC.md`（来源段 + 映射表）、本文件 §5、`AGENTS.md` 硬规矩 1、`LANDMINES.md` §5。

### 7.2 组织层可视化（C 档）· `dsh-org-panel` 注入
```
$ dev_inject_plugin {"dir":"D:/dsh/03-dev-infra/dsh-org-panel"}
OK: @dsh-external/dsh-org-panel 已注入（junction=…\profiles\web\node_modules\@dsh-external\dsh-org-panel）
- host ✓   - client ✓ (lib/client.js)
```
端点实测（探针子代理在跑时）：
```
GET /@dsh-external/dsh-org-panel/api/state → HTTP 200
employees=51  working=4  teams=4  liveSessions=9  scannedRoots=4
teamNames=["omc-dsh(27)","<另一个项目>(12)","<另一个项目>(6)","omc-agent-teams(6)"]
```
探针结束后复读：`employees=52  teams=4  working=5  liveSessions=10`
→ **数据面随活子代理实时变化**（面板读的是 DSH 自己的 `ctx.subagents.listDescendants`，没有另造注册表）。
**未验证（不是红）**：面板自带判据 `tools/teams-gate.mjs --teams` 在本会话跑不了 —— 它要 mint 会话 cookie，
读 `~/.dsh/.credentials.yaml` 时 `EPERM`，退出码 1。

### 7.3 技能升级（A 档）
`skills/` 6 条 → **7 条**：
| 文件 | 动了什么 |
|---|---|
| `teamkit`（入口） | 重写：9 个原生工具的**硬边界**（只有 id/CAS/环检测是硬的）+ 五件事流程 + 导航表 |
| `teamkit-assemble` | **改成可执行判断表**：三道闸 → 切单元（四要素/粒度/判据不许为空）→ 选人 → 定层 → 铺板（`description` 骨架）→ 开人（**暗号法**验"真读到"）→ 三条验收 |
| `teamkit-org` | 补：**论文无定理**（只有 §2.2.3 一句带假设的有界终止 + §2.2.4 七不变量 + 死锁探测器判失败）、原版**硬数字表**、硬 vs 软（DSH 无钩子）、**原版自己的六个坑** |
| `teamkit-review` | 加**评审门**：`complete` ≠ 被批准、下游只认有判决记录的上游、**默认禁自审**、熔断表（3/3/2）|
| `teamkit-meeting` | **新增**：开会协议（议程→召集→收集→纪要四栏→行动项当场转任务）+ 防"互相确认"纪律 |
| `teamkit-a2a` / `teamkit-escalate` | 未改 |
读数：
```
$ node tools/install-teamkit.mjs   → 退出码 0（4 条待更新已更新，talents 6 份）
$ node tools/verify-handoff.mjs    → PASS（14 通过 / 0 失败 / 0 未验证）
  OK  skills：teamkit teamkit-a2a teamkit-assemble teamkit-escalate teamkit-meeting teamkit-org teamkit-review
  OK  全部 7 个 SKILL.md 合法
  OK  已装到 <用户目录>\.dsh\skills：teamkit … teamkit-review
```
**热发现实测**：`teamkit-meeting` 写进 `$DSH_HOME/skills` 之后，**本会话注入的技能目录当场多出这一条**（无需重启、无需换会话）；随后 4 条更新的 description 也同步刷新。

### 7.4 组织层文件本体（OMC 那一套的落地物）
之前只有 skill（讲方法），**没有 OMC 的组织层实体**。2026-09-12 补齐：

| 新文件 | 是什么 | 原版对应 |
|---|---|---|
| `TALENTS.yml` | **Market 手工版**：可 grep 的索引（role / skills / level / use_when）+「缺口现写并注册回来」的机制 | registry.json + MCP `search_candidates` |
| `talents/_SPEC.md` | **Talent 规范**：v1 字段表（含 `acceptance_style` / `onboarding` / `principles` / `personality_tags`），并**明写哪些原版字段 DSH 不承载**（`llm_model`/`api_provider`/`temperature`/`hosting`/`auth_method`——写了也不生效，别假装） | `profile.yaml` 18 字段 |
| `RULES.yml` | **治理**：must_report_up 四类 / never 清单 / 下游交接 / 成本阀 / 升级形状。注明原版 `permissions.yaml` 引擎**在生产路径上恒允许**（⚠️ **R89 更正**：原写"自己未接线"**不准** —— 引擎有 caller，**是喂进去的输入全空**；详见 `teamkit-org` 的"原版的缺口"），故这里是规则文本而非执行器 | `company_rules/permissions.yaml` + `company_culture.yaml` |
| `talents/principles/README.md` | **自演化位**：`principles/<name>.md` 首次复盘时创建，上岗材料必须带上 | 每人一份 `work_principles.md` |
| 6 份 `talents/*.md` 重写 | 按 `_SPEC.md` 对齐：加 `role` / `acceptance_style` / `onboarding` / `principles`，正文写"怎么算做完" | — |
| `tools/install-teamkit.mjs` | 组织层文件一并装到 `$DSH_HOME/teamkit/`（TALENTS.yml / RULES.yml / talents/ + principles/），`--uninstall` 一并清 | — |
| `tools/verify-handoff.mjs` | 自检加入 TALENTS.yml / RULES.yml / talents/_SPEC.md；`talents` 计数排除 `_` 前缀 | — |

读数：
```
$ node tools/install-teamkit.mjs
  OK  teamkit … teamkit-review（7 条全部一致）
  talents：6 份（含 principles/）
  组织层：TALENTS.yml RULES.yml
$ node tools/verify-handoff.mjs
  判定：PASS（17 通过 / 0 失败 / 0 未验证）
落点清点 <用户目录>\.dsh\teamkit\：
  RULES.yml  TALENTS.yml  talents\{_SPEC,chief,coo,engineer,research-lead,reviewer,writer}.md  talents\principles\README.md
```

**性质声明（别当保证读）**：`RULES.yml` 与 `teamkit-review` 的"评审门"都是**协议**，不是机制 ——
DSH 除 id/CAS/依赖环检测外**没有任何强制钩子**；原版的 `permissions.yaml` 引擎**在生产路径上恒允许**
（⚠️ **R89 更正**：原写"本身也未接线"**不准** —— 它有真实 caller（`acp/client.py:127` 的 `request_permission`），
**是喂进去的输入全空**：工具名取 `ToolCallUpdate.tool`，而该类型**没有 `tool` 字段** ⇒ 恒 `""`；
两个实参又都是 `{}` ⇒ 3 条规则全不命中 ⇒ `default: allow`。**真跑 Python 验过**）。
它们的效力只来自「落盘可审计 + 下一轮真的会去查」。

**未做**：`talents/principles/<name>.md` 目前**只有 README**（首次复盘时才创建，符合设计）；组织层的 A/B 读数未做。
