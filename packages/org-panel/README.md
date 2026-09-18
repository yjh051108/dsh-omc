# @dsh-external/dsh-org-panel — 侧边栏「办公室」

DSH 右侧栏里的一个 tab，把**一个 Agent Team 当一家公司**画出来：
employee = **Agent Team 的 teammate**（不是所有子代理）；**一个会话一个公司**；
点得开板 / 规则 / 项目 / 会议室；开会时成员会**走到**会议室。

## ⚠️ 装之前先看：**本插件是 OMC 套件的一部分**

★ **不要单独装本包** —— 它是 **`dsh-omc` 套件**里的**一格**。
套件 = **本仓 2 个包**（`teamkit` 公司层 + `org-panel` 本包）+ **2 个依赖**
（运行时注入器 / 记忆层 —— **它们不在本仓**，从各自仓装）。
正确装法（**一条命令装齐**）：

```bash
git clone https://github.com/yjh051108/dsh-omc
cd dsh-omc
./install.sh          # Windows: .\install.ps1
#   可选：PROFILE=myco ./install.sh   ·   先干跑看要做什么：DRY_RUN=1 ./install.sh
```

> ⚠️ **旧的 `dsh-org-panel` 仓已归档**（2026-09-18 并入 `dsh-omc`）⇒ **别再指向它**
> —— 那里是**只读的旧版**（你照样能装上，但**拿到的是修前的代码，而且看不出区别**）。

### 若你只想单独装本包（**不推荐**，但可行）

```bash
# ① ★ 先建一个**完整 profile** —— `install.sh` 不管这一步，而缺了它面板会起不来
dsh --profile myco --from-default-profile web

# ② 再把面板装进去（★ 用你 clone 下来的 dsh-omc 里的子目录 —— 本包【不在 npm registry 上】）
dsh plugin --profile myco add "<你 clone 的 dsh-omc>/packages/org-panel"

# ③ 起它 —— 侧边栏会出现「办公室」
dsh --profile myco --port 3099 --no-open
```

> ★ **为什么单独装需要第 ① 步**：面板 `inject = ['webServer']`，而 `webServer` 由
> `@deepseek-ai/dsh-web-app` 提供 —— 裸 profile 里没有它，插件会一直 `pending`。
> **`install.sh` 装到默认 profile `web`（那里已经有 `dsh-web-app`）⇒ 它不需要你操心这一步**；
> 而你若是**自带一个别名的 profile** ⇒ 得自己先把它建完整。

> ★★ **装完（或在已开着的窗口里装上）要【刷新一次页面】** —— 本插件有 client 半，
> 它是在页面装载时注册 tab 的；**已经开着的页面看不到它**（`dsh` 会把它写进下次装载的 boot 清单）。
> ⇒ 刷新后：右侧栏的 **`+`** 里应出现「办公室」；**首次装载会自动打开一次**。
> ⚠️ **这一条是"装了没反应"的头号原因** —— 而刷新只需一秒，不必重启 `dsh`。

## 怎么确认它真的在工作（三步，30 秒）

```
① 打开右侧栏的「办公室」（在 `+` 里，或首装时它会自动打开一次）
② ★ **切到另一个会话**（点另一个 Lead / 另一家公司的会话）
③ ★★ **看面板是否【立刻】换成那家公司**（人数、公司名、板上内容都变）
   ⇒ ★ **不需要手动刷新面板** —— 这是本插件的行为约定
```

**这三步为什么会通过**：侧边栏的 tab 是**按会话**挂的（`scope: "session"`），
而宿主侧会把**当前会话 id** 通过 iframe 的 `src`（`?company=<sessionId>`）传进来 ⇒
会话一换 ⇒ iframe 换公司。**若第 ③ 步没变** ⇒ 请记下面板顶部的状态字与
浏览器控制台里 `window.__orgPanelClient.sessionId` 的值，开个 issue 贴上来。

**不加这一步会怎样**（这是最容易踩的坑）：

```
$ dsh plugin --profile myco add "https://github.com/yjh051108/dsh-org-panel"   # 装是装上了（★ 该仓已归档，见最前面）
$ dsh --profile myco
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
@dsh-external/dsh-org-panel: pending (waiting for service: webServer)
```

**这不是插件坏了**：面板 `inject = ['webServer']`（`lib/index.js:27`），
而 **`webServer` 由 `@deepseek-ai/dsh-web-app` 提供** —— 一个只有 `dsh-base` 的裸 profile
里没有它，插件就会一直 `pending`。用 `--from-default-profile web` 建的 profile
其 `bundles` 是 `@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app`，装了就能起。

> ⚠️ 别用 `dsh plugin add "@deepseek-ai/dsh-web-app"` 去补 —— 它的 rc 版依赖不在 npm registry 上
> （实测 `ERR_PNPM_FETCH_404 … dsh-client-ui-command`）。**走 `--from-default-profile`**。

## 装不上怎么办（两类死法，对号入座）

**先看你在哪一步失败** —— 两类都不需要读源码：

```
① 第②步 `dsh plugin add` 就失败
   · `404` / `Not found` / `ERR_PNPM_FETCH_404`
     ⇒ 你多半写成了裸包名（`@dsh-external/dsh-org-panel`）。
       ★ 本包【不在 npm registry 上】⇒ 必须写 **GitHub 地址**。
       ⚠️ **但正解是别单独装** —— 走 `dsh-omc` 的 `install.sh`（见本文最前面）；
          而要单独装 ⇒ 用 `dsh plugin --profile <p> add "<你 clone 的 dsh-omc>/packages/org-panel"`
          （★ **推荐本地目录形态**：旧仓 `dsh-org-panel` **已归档**，那里是只读旧版）
   · `'pnpm' is not recognized`
     ⇒ **缺 pnpm 前置**（`dsh plugin` 把它转发给 profile 目录下的 pnpm）。
       ⇒ 装 pnpm 并确保它在 `PATH` 上。

② 装上了，但 `dsh --profile <p>` 起不来
   · `plugin tree failed to load: dsh: 1 entry did not activate`
     `@dsh-external/dsh-org-panel: pending (waiting for service: webServer)`
     ⇒ **你的 profile 不完整**（缺 `@deepseek-ai/dsh-web-app`，它提供 `webServer`）。
       ⇒ 用 `dsh --profile <p> --from-default-profile web` 重建（见本文最前面）。
       ⇒ ⚠️ **这不是插件坏了** —— 面板 `inject = ['webServer']`，缺服务就一直是 `pending`。

③ 起来了，但侧边栏**没有「办公室」**
   · 先确认 client 半进没进 boot 清单：打开页面、搜 `@dsh-external/dsh-org-panel/client.js`
     ⇒ 在 ⇒ 侧边栏右侧的 **`+`** 里应能找到 tab（或首次装载会自动打开一次）。
     ⇒ 不在 ⇒ client 半没装载 ⇒ 回到 ② 检查 profile 的 `bundles` 有没有这一项。
```
> 这三条覆盖了我们实测到的**全部**失败形态。若你的症状不在其中 ⇒ 开个 issue 贴：
> `dsh --version` · `dsh plugin --profile <p> list` 的输出 · 起服务时的完整报错。

## 它是什么 / 不是什么

- **是**：DSH 原生数据的可视化。员工名单来自 **`ctx.agentTeams`** 的 roster
  （`listMembers(root)`，含 **inactive** 成员 —— 它们已不在 `agents` 注册表里，
  只有 roster 还记得），没有另造一套注册表。
- **不是**：不是把 OMC 搬进来。OMC 的后端（FastAPI + 190 个 REST 端点 + LangChain）一行都没跑；
  只**复用它的办公室渲染器**（`office.js` 等）—— 那才是"完整的像素和实时动画"所在。

## ★ 2026-09-14 口径更正（委托方逐条指出 → 已修）

| # | 委托方原话（问题） | 旧实现 | 现在 |
|---|---|---|---|
| ① | 「足足 43 个人……**只有 teamate 才是**」 | `subagents.listDescendants(rootId)` ⇒ **所有子代理都算员工**（实测 **47**） | **只认 `agentTeams` roster 的 teammate**（实测 **16**） |
| ② | 「**一个会话一个公司**，同一个项目开两个会话也各自独立」 | 只认一个 rootId ⇒ 多会话堆一幅图 | 按 **Team root 分组**；`/api/state?company=` / `?session=`；UI 有**公司切换器**（缺省跟随当前会话） |
| ③ | 「板 / rules / projects **都没法点开**」 | `office.js` 发了 `window.app.openXxx` 回调，**bridge 一个都没实现** | 桥接 `openWorkflowPanel` / `openProjectWall` / `openMeetingRoom` / `openMeetingMinutes` / `openEmployeeDetail`，并补 `/api/board` `/api/rules` `/api/projects` `/api/minutes` |
| ④ | 「员工会**走到**会议室……**你这里没有**」 | `meeting_rooms` 永远空数组，且**原版根本没有走路逻辑** | host 喂 `meeting_rooms`（由真实会议记录推导）；bridge **运行时包 `drawCharacter`** 做插值 + 借原版 walk 精灵行（row 4） |

### ① 人数：改前 / 改后
```
改前  employees = 47      （listDescendants 口径，把子代理也算成员工）
改后  employees = 16      （agentTeams roster 的 teammate 数）
```
`/api/debug` 会把**逐个活 agent 的团队身份**报出来（`membership.role`），
"为什么是 N 个人"因此可核，不是我说了算。

### ② 一个会话一个公司
```json
["<公司名 A> · fa9866", "<公司名 B> · 617bb9",
 "<公司名 B> · 635738", ..., "ptc"]        → 8 家
```
**注意 `617bb9` / `635738` 两条** —— 同一项目（`<公司名 B>`）的**两个会话**
就是**两家不同的公司**。同名靠 id 尾缀区分（`idTail()`）。
> ⚠️ 踩过：会话 id 形如 `session-<uuid>`，直接 `slice(0,6)` 会得到**一堆相同的 `sessio`**，
> 六个公司长得一模一样。所以先剥 `session-` 前缀再取尾。

### ④ 走动动画：为什么非写在 `bridge.js` 不可
**原版 `office.js`（与 OMC 上游仓库的 `frontend/office.js` **逐字节相同**，
sha256 `D3080A65…`）里**没有任何走路逻辑**** —— `_drawEntities()` 里参会者是被
`drawCharacter(pos.x, pos.y, emp)` **瞬间瞬移**到会议室的，没有插值，**上游也没有**（已核 OMC 全仓）。

⇒ 「走过去」只能由桥补，做法是**包一层 `drawCharacter`**：
原版给的两个入参**就是目的地**，在 `from → to` 之间按 `easeInOutQuad` 插值即得移动路径，
再借用原版**本来就有的** walk 精灵行（`office.js` 注释写明：*Row 4-5: walk*）。
**一行绘制逻辑都没重写，`office.js` 一个字节都没改。**

> 首次见到某员工时：入参是工位 ⇒ 直接坐好；入参是会议室 ⇒ **从工位走来**
> （否则刷新页面后参会者会"凭空出现在会议室里"，走动永远看不到 —— 这是第一版实测到的真缺陷）。

## 结构（三层，各自独立可测）

```
lib/index.js          host：前缀路由 /@dsh-external/dsh-org-panel/{api,office}
                      · /api/state        一个公司的 state（employees + office_layout + meeting_rooms）
                      · /api/state?wait=1 同一份，但等这一轮建完（判据用）
                      · /api/debug        逐个活 agent 的团队身份（核对人数用）
                      · /api/board        任务板（板）
                      · /api/rules        $DSH_HOME/teamkit/RULES.yml
                      · /api/projects     所有公司（会话）的任务汇总
                      · /api/minutes?room= 议程 + 纪要全文
lib/client.js         client：只在 sidebar.right.pane.tab 座位登记一个 iframe，不画任何东西
public/office/*       OMC 原版渲染器 + tilesets（5.35MB）+ bridge.js（桥：拉 state、接回调、走动插值）
tools/org-panel-check.mjs   机械判据：--state / --assets / --render / --panel / --no-restart
tools/verify-task61.mjs     task-61 验收读数器：A 人数 / B 切公司 / C 点开面 / D 走动 / E 零重启
tools/verify-layering.mjs   task-69 判据：分层（lead 前排 / teammate 办公区）+ 等级诚实（无档≠1、有档=真映射）+ 可见汇总
tools/verify-r106-quiet.mjs task-65 判据：休眠=静态低对比非红；真 failed 仍报警（像素级两帧 diff）
tools/verify-r107-no-flicker.mjs  task-84 判据：「读不到」不许显示成「0 人」（含反向对照：旧行为必须报红）
tools/verify-r101-r102.mjs  R101/R102 回归：会议室三态 + 休眠≠待命 + HUD 三档守恒
tools/probe-r101e-race.mjs  对照探针：证明 r101-r102 的 E 段"假红"是时序竞争（原文见 notes/r106-E-race-control.txt）
tools/verify-r104-companies.mjs  R104 判据：空公司不与真公司平铺
tools/verify-cache-slots.mjs     task-68 判据：分槽隔离（串公司专项）+ 归一化单测 + 每槽 SWR + 冷/稳态分开报
                                  + C1 机制单测（真·空公司 vs 读不到，含**反向对照**与**同源性自检**）
tools/probe-cold-window.mjs      task-68 冷启动窗口探针：照抄页面的真实键序列（首拍 s:<id> → 稳态 c:<id>）
tools/verify-task84-frames.mjs   task-84 判据：**画面级**「连续多帧不塌」（HUD/工位/角色墨 + 坍塌帧计数）
tools/verify-task102-lifecycle.mjs task-102 判据：不可见时**「工作」真停**（RAF=0/不发请求/animFrame 不动）
                                  + 恢复 + **反例对照**（只藏画面不停工作 ⇒ 必须报红）
tools/probe-t102-cpueffect.mjs   进程树 CPU 三段对照（可见/不可见/恢复各取中位）—— 回答「关了还烧不烧」
tools/probe-t102-realtoggle.mjs  真实触发路径（`#stage{display:none}`，不用测试钩子）⇒ 靠 not-intersecting 停
tools/probe-t102-cpu.mjs         宿主 + electron 全树 CPU 时间线（不知道开关时刻，只连续采样）
tools/probe-t102-baseline.mjs    「空闲基线」归属：host vs 其它 node 的**相关性**（排除了"别的 agent"）
tools/probe-t110-breakdown.mjs   task-110 分项：去重是否生效 + collectCompanies 占 buildState 多少 + 重建周期
tools/probe-t110-cwd.mjs         task-110 只读：cwd 免费路径 vs meta 路径（决定 listSessions 能否省）
tools/probe-t110-fielddiff.mjs   task-110 **字段级 diff**：顶层/summary/layout/employees[0]/meeting_rooms[0] 键集合
tools/probe-t110-valuerate.mjs   task-110 **逐字段有值率**（改前 vs 改后）⇒ 证「降成本没降功能」
tools/probe-t61-walk-evidence.mjs task-61 D 项**追加读数**：刷夹具 mtime（**只动时间戳**）⇒ booked=true
                                  ⇒ 走动正向读数 + **正文 sha 刷前=刷后**（没有换被测对象）
tools/probe-t115-realcollapse.mjs task-115 **真实收起机制**（移除 `[data-sidebar-right-open]`，
                                  **不是** `display:none` 近似）⇒ 命中 `not-intersecting` + RAF +0 + 还原自证
tools/verify-r111-throttle.mjs   R111 **可见时节流**：空闲 160fps→9.8fps（**跳帧但续链**）
                                  + 反向对照（关掉⇒回 160fps）+ **降帧≠降没了**（角色墨仍 65.9%）
tools/probe-r111-flake.mjs       诊断 + **反例自证**：判据"等空闲"等的是**会消失的状态**（不是等绿）
tools/measure-perf.mjs           卡顿归因的可复跑测量（**只测不改**；B1 快路 settled 是硬指标）
tools/teams-check.mjs            团队层机械判据（人读/诊断版）
tools/teams-gate.mjs             团队层的**落账闸**（与 teams-check 跑同一批判定；环的 dry-run 用得上）
tools/shot-office.mjs            截当前公司的办公室画面（人看的那个视图）落盘
tools/_probe-url.mjs             ⚠️ **临时诊断件**（哪个 URL 形状能让会话面挂载 ⇒ 办公室 tab 自动开）
                                  下划线前缀 = 非交付物；**别当判据用**
```

## 关键设计（都是踩出来的）

1. **端点永不阻塞**（快路**零 IO**）。`collectCompanies` 要读 `listSessions`（实测 ~1.3s），
   页面每 1.5s 拉一次 → 请求堆积。现在 `/api/state` 无 `wait` 时**只读缓存**；
   要新鲜完整的走 `?wait=1`（bridge 首拍与切公司时带）。
1b. ★ **缓存是「每键一槽」，miss 时供旧值（SWR）**（2026-09-14 / R109）：
   原来是**单一全局槽** ⇒ 键一被顶掉就 `return EMPTY_STATE`（`building:true/total:0`）
   ⇒ 页面把「读不到」画成「0 人」⇒ 委托方看到的**「公司一闪一闪」**。
   ⇒ 现在 `Map<key,slot>`，**每槽各自 SWR**；**只读本槽** ⇒ 结构上不可能串公司。
   ⚠️ **顺序不许反**：先分槽 → 再 SWR。反了会**串公司**（A 公司页面拿到 B 的员工列表）。
   ⚠️ 页面**首拍与稳态是两个键**（`?company=&session=X` vs `?company=<id>&session=X`），
      靠 **别名回填**（用 state 自己声明的 `company.id` 建 `c:<id>` 槽）接起来 —— 那正是冷启动那一闪。
   判据：`tools/verify-cache-slots.mjs`（分槽隔离/归一化单测/SWR）+ `tools/probe-cold-window.mjs`（冷窗口 A/B）。
1c. ★★ **别为「免费就有的东西」去付全量 IO**（2026-09-15 / task-110）：
   `buildState` 的 **~99%** 时间花在 `sessionMetaById()` 的 `sq.listSessions()`，
   而它**只为给公司取一个 `cwd`** —— 可 `cwdOf` 的第一项 **`agent.session.header.cwd` 是免费的**。
   实测 **`freeCwdHits=2 / metaCwdHits=0`** ⇒ 那条慢路径 **100% 白走**。
   ⇒ 改成**惰性回退**（只在免费路径为空时才付那次 `listSessions`）：
     `buildMs` **2502ms → 14–19ms**；host 可见段 CPU p50 **31–91% → 16–27%**。
   ⇒ ⚠️ **不要"直接删"**：删了就静默丢信息（公司名退化成 `Company N`）⇒ **保留回退**。
   ⇒ ⚠️ `cwdOf` 必须 **null-safe**（`meta` 现在可能是 `null`，否则把"省 99%"变成"崩"）。
   ⚠️ **频率与单次成本要分开报**：本次**只降了单次成本**，**TTL/轮询未动** ⇒
      **新鲜度最坏延迟仍 ≈3s**（**没有**用"提 TTL"换 CPU —— 那会让新数据晚 8s 才出现，用户能感知）。
   判据：`tools/probe-t110-{breakdown,cwd,fielddiff,valuerate}.mjs`；报告 `notes/perf/task110-report.md`。
2. **弹层接口要轮询等正文**。`/board` 实测 ~1.9s（62 个任务），
   判据脚本若固定等 1.2s 只会读到"读取中…"占位符 ⇒ **会误判成"点不开"**（实测踩过）。
3. **`meeting_rooms` 的占用判据 = 有议程、无纪要**。DSH 原生没有会议室；
   本仓 teamkit 的会议协议是**落盘**（`notes/meetings/<topic>-agenda.md` 开会、
   `-minutes.md` 收会）⇒ `booked` 于是有客观判据，不是编的。
   参会者 = **议程正文里点名出现过的本公司 roster 名字**。
4. **加载即预热**：面板打开时已有数据，看不到"空办公室"那几秒。
5. **部门牌子读 `zone.label_en`**（不是 `label`），且那个像素字体只吃 ASCII
   ⇒ 中文公司名退回 `C-<id尾>`。**别退回 `Company N`** —— 那个 N 是**枚举序号**，
   实测在中文名的牌子上显示成毫无意义的 `Company 7`。
6. **canvas_rows = 最后一个工位 + 会议室 + 6**：给部门牌子留位置，否则牌子被裁到画布外。
7. ★ **不可见时要停的是「工作」，不是「画面」**（2026-09-15 / R110，`bridge.js`）：
   `office.js:1329` 的 `loop(){ …; requestAnimationFrame(()=>this.loop()) }` 是**无条件常驻**的，
   而轮询也没有可见性判断 ⇒ 侧边栏收起后**照样烧**。
   ⇒ 在 `bridge.js` 里把 `R.loop` **包一层**（`office.js:1333` 写的是 `this.loop()` ⇒
     **实例属性解析**，所以**原版一行都不用改**）：不可见时**不再调度下一帧**；
     轮询也改成"不可见时**整拍跳过**"（不是"继续请求只是不画"）。
   ⚠️ ★ **只用 `visibilitychange` 是不够的**：侧边栏收起时 iframe 往往是 **`display:none`**，
     **`document.hidden` 不会变 true** ⇒ 必须再加 **`IntersectionObserver` + 零尺寸**两路兜底
     （实测真实路径靠 **`not-intersecting`** 发现，不是 `document.hidden`）。
   ⚠️ **复用渲染器，不许重建**：只暂停调度，`camera`/`animFrame`/状态全保留（实测恢复后 `animFrame` 续上）。
   判据：`tools/verify-task102-lifecycle.mjs`（**含反例对照**：只藏画面不停工作 ⇒ 必须报红）
        + `tools/probe-t102-realtoggle.mjs`（真实 `display:none` 路径）+ `tools/probe-t102-cpueffect.mjs`（进程树 CPU）。
8. ★★ **判据要自己保证前置，而不是"看看前置在不在"**（2026-09-15 / `R25` 强形态）：
   `verify-task61.mjs` 里两条 FAIL **都不是功能坏**，而是**判据自己让前置失效了**：
   ```
   · 时间前置：走动夹具一旦写下 ⇒ 45 分钟后必然被 host 判 stale（`MEETING_STALE_MS`）
     ⇒ 判据**跑前自己刷 mtime**（`fs.utimesSync`，**只动时间戳、正文 sha 必须不变**）
     ⚠️ 刷完**必须等过缓存 TTL（3000ms）** 再查 —— 否则 `?wait=1` 供的是刷新前的**缓存** ⇒ 假红
   · 空间前置：会议室点击坐标 `y=947` 落在 900 高的视口**外** ⇒ Playwright 点不到
     ⇒ 判据**自己把视口撑到够高** + `elementFromPoint` **先验命中**，再点
   ⚠️ 且**各判据自带自己的夹具**：两个判据曾对**同一个**夹具要求相反（走动要"新"、R101 要"旧"）
     ⇒ 一个刷新鲜就把另一个弄红（实测发生过）⇒ 现已拆成两份独立夹具
   ```
   证据：`notes/perf/t61-precondition-fixes.md` · `notes/perf/t61-walk-evidence.txt`
8b. ★★ **别把"最大的东西"当成"最贵的东西"—— 先盘账**（2026-09-15 / task-102 修 2 复核）：
   「打开面板卡一下」原猜是**贴图解码**，且报告里流传着「单张 2.42MB / 共 4.93MB 级」的说法。
   我盘了账（口径 = `public/office` 下图片**文件字节之和**，**不是**解码显存）：
   ```
   全部图片 **5.35 MB**（27 张）
     ├ 被引用·环境表 **0.37 MB**（4 张）
     ├ 角色表 char01–20 **2.12 MB**（20 张，`office-tileatlas.js:45-49` 动态拼路径）
     └ ★**未被任何代码引用 2.86 MB**（3 张）：Interiors_32x32 **2.42MB** · Room_Builder_32x32 392KB · generated_overview 63KB
   ```
   ★ **而 `office.js:78` 启动即 preload 的只有 `['gen','office','room_free']` = 0.37 MB**
     ⇒ 那个 2.42MB 的 `Interiors_32x32.png` **不在 preload 列表、也找不到任何代码引用**
   ⇒ ★★ **"按需解码"能省的是 0.37MB 这一档，不是 2.42MB / 5.35MB** ⇒ 收益据此下调。
   ⚠️ 核查方式（**这一步不能省**）：全仓**非图片**文件 grep 那三个文件名 ⇒ **无加载路径**（命中的都在笔记正文里）。
      还需排除"**按目录整体加载**"（否则 grep 会给**假阴性**）：实测 `public/`、`lib/` 下**有 2 处 `readdir`**
      （`lib/index.js:22` import / `:342 await readdir(dir)`）—— ★ 但它们读的是 **`notes/meetings/`（会议议程）**
      （`meetingRoots()` → 只认 `-agenda.md`）⇒ **与贴图无关** ⇒ 结论成立。
   🔴 ★★ **这一条我连栽两次，形状完全相同 —— 这是全条最该记住的地方**：
      ```
      第一次：**grep 输出被截断** ⇒ 我报"`readdir` **0 处**"（实际 2 处）⇒ 结论对，**证据是假的**
      第二次：我把"运行时不在 `topResources` 里"称为「**第一方铁证**」⇒
              而 `topResources` 是 `slice(0, **8**)`（生成行 `t103-browser-cost.mjs:100`），
              而 `resourceCount = **63**` ⇒ **只看 8/63 = 12.7%** ⇒ **"不在前 8" ≠ "没被请求"**
      ⇒ ★★ **两次都是"把截断后的视野当成全集"**
        ⇒ 而第二次我**自己还在文档里标了"不许越过"**（说明知道要防过头）
        ⇒ ★ **"我知道要小心" ≠ "我的定性强度的确没超读数"**（`R5`）
      ```
   ✅ **正确口径（经两次修正后的终版）**：
      · **可说**（★ **已证（单次）**）：「那张 2.42MB **不在那次 office 页加载里**」
        依据 = **算术反证**（若在，则解码总量下界 `1061370+2534713=3596083 B=3.43MB` **> 实测 2.76MB**，差 685.6KB）
        ⚠️ 前提已复核：① `:85` 的求和用**全集** `snap.resources`（`:100` 的 `slice(0,8)` 只在存 JSON 时截断）；
        ② `decodedBodySize` 对 PNG **= 文件字节**（**用已加载的 8/8 张对账，比值恒 1.000**）
      · **不可说**：✗「它**永远不会**被加载」（那次没加载 ≠ 其它交互路径不加载 ⇒ **仍【未获取】**）；
        ✗「可以删」（原版资产 ⇒ **不删不动**）。
        ⇒ ★ **两句范围不同不可合并**：①「**那一次**没加载」= 已证 · ②「**永不再加载**」= 未获取。
      · ⚠️ 我先前两次都错在同一处：**先报"0 处 readdir"（输出被截断）**、
        又报"**第一方铁证**"（列表被 `slice(0,8)`，只看 8/63）⇒ **都是"把截断后的视野当成全集"**。
        ⇒ ★ 由此得出一对自检问句：**「我看到的是它的全部吗？」** +
          **「若它不是全部，我还能用【总量/边界】做算术反证吗？」**
          （**这次正是"用总量绕过了截断"：列表不全，但总量是全的**）
   ⚠️ 两条不许越过：「**未被引用 ≠ 可以删**」（可能是上游对齐物；product-director 已裁**不删不动、留档**）；
      「**数字变小 ≠ 症状不存在**」⇒ "打开那一下卡"的归属**仍【未获取】**（用户真实点开关那一刻的 renderer 剖面从未拿到）。
   ⚠️ 另：报告里流传的 **2.76MB 是"解码量"**口径（已核到原始件 `raw/t103-browser-*.json` 的 `decodedMB` +
      生成行 `:85`/`:99` 的 `decodedBodySize` 求和），**5.35MB 是"磁盘字节"**口径 ⇒ **两个不同的量，引用必须带分母**。
   原文：`notes/perf/t102-tileset-budget.md`
9. ★★ **可见时空转也要治：节流，但必须"跳帧不跳链"**（2026-09-15 / R111，`bridge.js`）：
   ```
   实测：可见时 **160 fps** 常驻（后台 1fps）—— 这才是"面板开着就烧"的来源。
   R110 治的是"不可见不停"；这里是"可见时空转"。**两件事，别混。**
   160fps 里最贵的三处都在 `render()` 里（都是**每帧**做）：
     `office.js:1319` 扫描线 `for (sy…) fillRect` ≈350 次/帧 · `:1325` `_updateTooltip()` DOM 读写 · `:1324` minimap
   ⇒ **只要不渲染，就全省掉**。
   ```
   ```
   形态（★ 最容易做错的地方）：
     不可见        ⇒ 不调 origLoop、**不续链**（R110 现状，停死）
     可见 + 有活动 ⇒ 调 origLoop（原版全速）
     可见 + 全空闲 ⇒ **不调 origLoop**（不渲染、`animFrame` 不自增），
                    但 **自己 `requestAnimationFrame` 续链**
     ⇒ ⚠️ **少了"自己续链"那一步，RAF 链就断了 ⇒ 画面永久冻结**（比卡还糟）
   ```
   ```
   ★★ **"活动"的定义是"有变化"，不是"有心跳"**：
     轮询每 1.5s 都来，但**内容常常完全一样** ⇒ 那不值得全速重绘。
     ⇒ 第一版我把"每次 tick"当活动 ⇒ 宽限窗(2.5s) **永远不过期** ⇒ 节流从未生效
       （实测 164fps 纹丝不动，判据 A1/A2 报红）⇒ 改成**状态签名比对**
       （员工 id/status/is_listening + 公司 + 会议室占用 + HUD 三个数）。
   活动源：状态**变化** · 走动 · 相机未收敛 · 弹层打开 · **鼠标交互**（"用户在动它"= 最强信号）
   ⇒ 任一成立 ⇒ 全速（宽限 ≥2.5s）。空闲档 = 10fps。
   ```
   ```
   ⚠️ **一条用户看得见的代价**（已报 product-director 裁 A）：`office.js` 的**氛围动画全部按【帧数】**
     推进（`animFrame * k`，实测 **16 处 `animFrame`，`Date.now/performance.now` 命中 0**）
     ⇒ **降帧 ⇒ 氛围动画按同比例变慢**。裁 A = **接受**（"静止画面"的应有之义；且**不影响输入延迟**）。
   ```
   判据：`tools/verify-r111-throttle.mjs` ⇒ **EXIT=0（8/0/0）**
   ```
   A1 空闲 **9.8/秒**（不是 160）· A2 `skipped=776` ⇒ **跳帧但续链**（链没断）
   A3 ★**降帧≠降没了**：空闲档画面角色墨 **65.9%**、本帧仍画出 **23 个角色**
   B1 鼠标交互 ⇒ 立刻 **163.4/秒** · B2 走动（walkers=3）⇒ **154.3/秒**
   C1 ★反向对照：关掉节流 ⇒ **161.8/秒**（证明判据测得出差别）
   D1/D2 R110 回归：不可见仍停 + 恢复回来
   ```
   ⚠️ ★ **判据自己偶发假红过，而且我修了两次**（第二次是 product-director 抓到的）：
     · **v1 错法**：固定等 5s 就量 ⇒ 那 5s 里任何一次状态变化都污染 ⇒ 假红
     · **v2 错法（我第一版"修好"的）**：只在**计时【之前】**确认一次空闲
       ⇒ ⚠️ **漏洞：等到了【开始】，没盯住【过程】** ⇒ 窗口**中间**新来的活动照样污染
       （他实测 `activityNow=["grace"]`、`renders=137` ⇒ 我 v2 报的"3 次全绿"**不成立**）
     · **v3 正解**：**窗口【期间】逐拍采样**（每 300ms），`grace` **也算非空**；
       任一拍非空 ⇒ 该窗口**作废重试**（最多 5 轮）；全污染 ⇒ **UNV**（不做假绿）
       ⇒ 判据能自答："等到了什么才敢计时？" = **一个"从开始到结束逐拍都空"的窗口**
     · **决定性旁证**（判"节流没失效"的依据）：假红与正常次的**总 RAF 回调数几乎相同**
       （820 vs 827）⇒ 差别全在 `renders/skipped` 分配
     · **三条路径自证**（`R111_INJECT_ACTIVITY` 环境变量，默认关）：
       默认 3 连跑全绿 · `=1` ⇒ UNV · ★`=2`（窗口开始即污染）⇒ 日志 `污染 16/17 拍 ⇒ 丢弃` + UNV
       ⇒ 若没有 `=2`，**无法排除"修好只是把 FAIL 等没了"**
   ⚠️ 另：`obs.throttle().rendersPerSec` 是**累计平均**（非滑动窗口）⇒ 看趋势会单调下降，
      **那不是"节流慢慢生效"**；判据是 reset 后固定等 5s 再读，不受影响。
   证据：`notes/perf/task102-toggle-cpu.txt`（含改前/改后同口径对照）· `notes/perf/t115-realcollapse.md`
   → 完整报告：`notes/perf/t111-throttle.md`

## 怎么用

- 打开：右侧栏 tab 列表里的「办公室」，或从 + 号的引导页进。
- 排查：`node tools/verify-task61.mjs`（跑完落 `shots/`，退出码 0 全绿 / 1 有红 / 2 跑不了）。
  ✅ **现在 EXIT=0（fails=0）**：原先三条 ✗ 已全部消除 ——
  两条是**判据自身的前置问题**（时间：夹具过期 / 空间：点击坐标在视口外），
  一条是「宿主启动晚于改动」（**宿主重启过 ⇒ 该前置不成立**，本就不该算功能红）。
  ⇒ 详见 `notes/perf/t61-precondition-fixes.md`（含"我修走动时把 R101 弄红"的交叉污染记录）。
- 判据脚本（**各自的退出码就是判据**，0 全绿 / 1 有红 / 2 未验证）：
  `verify-layering.mjs` · `verify-r106-quiet.mjs` · `verify-r107-no-flicker.mjs` · `verify-r101-r102.mjs` · `verify-r104-companies.mjs` · `verify-cache-slots.mjs`
- 装载：`dev_inject_plugin {"dir": "D:/dsh/03-dev-infra/dsh-org-panel"}` —— host + client 一起生效，**不需要重启 dsh web**。
- 改代码后：`dev_reload_package {"packageName": "dsh-org-panel"}`。
- 卸载：`dev_uninject_plugin {"match": "dsh-org-panel"}`。

## 注意

- 本插件是**手写的 `lib/*.js`**，没有构建步骤（原先的 TS 脚手架已删——改 `src/` 不生效是个陷阱）。
  改 `lib/index.js` / `lib/client.js` 后 `dev_reload_package` 即可。
- **`office.js` 一个字节都没改**（sha256 与原版相同）——这是本仓的硬纪律，便于将来跟上游对齐。
  `office-tileatlas.js` 只改了**一处**（且是本次之前就有的）：默认 basePath 指向本插件前缀，
  免得和 DSH 自己的 `/assets/` 抢路由。其余 OMC 文件逐字未动。
- **判据夹具**（**两份，各有各的用途，不要互相借用**）：
  · `notes/meetings/walk-animation-agenda.md` —— 验「会议室 + 走动」的**假会议**。
    ⚠️ **必须新鲜**（host 的 `MEETING_STALE_MS = 45min` 会把过期的议程判成"已散会"）
    ⇒ `verify-task61.mjs` **跑前自己刷它的 mtime**（只动时间戳，正文不变）。
  · `notes/meetings/r101-abandoned-probe-agenda.md` —— 验 R101「没纪要的会议不该永久占用」的**假会议**。
    ⚠️ **必须过期** ⇒ `verify-r101-r102.mjs` **跑前自己把它置为 1 小时前**。
  ⇒ ★ **两份是必需的**：它们对 mtime 的要求**相反**（走动要新、R101 要旧）；
    曾经共用一份 ⇒ 一个刷新鲜就把另一个弄红（2026-09-15 实测发生）。删掉任一份，对应判据退化成 UNV。
- ✅ **`verify-task61.mjs` 的写死真值已修**（2026-09-15）：原来**两处各写死了一个固定人数**
  （人数判据一处、HUD 判据一处）⇒ **编制一变两处齐红**。现已删掉 ⇒ 改为**从 `/api/debug` 现算一次**
  放进 `EXPECTED`、HUD 那半读**同一个值**（`R10` 单一真值源），并补**集合级**断言（roster 全员必须在面板里）。
  ⇒ 实测 `true_teammates_from_debug = 22(roster) + 1(lead) = 23`、`23 == 23`。
  ⚠️ 口径：**不许写死任何数字** —— 写死任何一个具体值都会再假红。
  ⚠️ **注释里也不留具体数字**（留了会被下一个人 grep 到、又得核一遍"还算不算数"）。
- **分层视图的口径**（见 `notes/layering.md`）：`employees = lead(1) + roster(N)`；
  **lead 不在 roster 里**（实测 12/12 家 `roster 含 lead = False`）⇒ 两个数并列时**不是矛盾**。
  等级只能来自 `$DSH_HOME/teamkit/roles/INDEX.json`，**匹配不上必须是 `null`**（不许编 `1` = "Junior"）。
- OMC 源码在上游仓库（本地全量：前端 + 190 个端点的后端）。
