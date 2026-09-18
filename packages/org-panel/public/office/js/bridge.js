/**
 * bridge.js — 把 DSH 的 state 喂给 OMC 原版 officeRenderer，并补上原版**没实现**的那半。
 *
 * 分工（刻意的不对称）：
 *   · `office.js` = OMC 原版渲染器，**逐字未改**（便于将来跟上游对齐）。
 *   · 本文件 = 「桥」。原版把该发的事件都发了（`window.app?.openXxx` 回调 + `state.meeting_rooms`），
 *     但**没人接**。所以这里做四件事：
 *       ① 拉 `/api/state`（**一个会话一个公司**：`?company=` 选公司）→ `updateState`
 *       ② 实现 `window.app.*` 回调（板 / 规则 / 项目 / 会议室 / 纪要 / 员工）
 *       ③ 喂 `state.meeting_rooms` 的**渲染层**：会议室到了、成员就"走"过去
 *       ④ 公司切换器 + 观测面 `window.__orgPanel`
 *
 * ⚠️ 为什么走路动画写在这里而不是 office.js：
 *   原版（OMC 上游仓库的 `frontend/office.js`，与本仓那份 **0 行差异**）
 *   **根本没有走路逻辑** —— `_drawEntities()` 里参会者是**瞬间出现在会议室**的
 *   （`inMeeting[emp.id] → drawCharacter(pos.x, pos.y, emp)`，无插值）。
 *   所以"走过去"只能由桥补：**包一层 `drawCharacter`**，在**同样两个入参**之间做插值，
 *   并借用原版**本来就有的** walk 精灵行（row 4）+ 相机/地图，一行绘制逻辑都不重写。
 */
(function () {
  var BASE = '/@dsh-external/dsh-org-panel/api'
  var INTERVAL = 1500
  var WALK_MS = 2400        // 走到会议室要多久（够长，肉眼+screenshot 都看得见）
  var WALK_FRAME_MS = 140   // walk 精灵换帧间隔

  // ── R106：休眠 = **常态**，报警 = **故障** —— 两者必须分开 ──────────────────
  //
  // ## 缺陷（委托方当场指出：「人物上面会亮，这个红色的小叉叉在那闪」）
  // `office.js:938-947` 那个分支是**故障报警通道**：
  //     else if (data.api_online === false) {
  //       const alpha = 0.5 + Math.sin(this.animFrame * 0.1) * 0.4   ← 这就是"闪"
  //       ...画红色 ✗...
  // 它当初是给"API 真的挂了"用的。R102 为了"让休眠看得出来"，
  // 把 `inactive`（**本部署的常态** —— 长期入驻制）也映射进 `api_online:false`
  // ⇒ **常态被接到了报警通道上** ⇒ 16 个工位全在闪。这是**改错了**，不是原版的锅。
  //
  // ## 这次的分法（把常态与警报彻底分开）
  //   · **休眠**（底层 `inactive`）⇒ 走**本文件的安静标记**：静态、低对比、冷灰、**0 动画**
  //   · **真故障**（底层 `failed`）⇒ 仍走 `office.js:938` 的红色闪烁报警（**原样保留**）
  // 判据读的是**底层状态** `_teamStatus`（`lib/index.js` 从 roster 原样带过来），
  // 不再借用那个被混用的 `api_online` 字段 —— 一个字段不担两个语义。
  //
  // ## 为什么不改 office.js
  // `bridge.js:122` 已经包了 `R.drawCharacter`（走路动画）。**原版照画 → 我们再叠标记**
  // ⇒ office.js 一行都不用改（它仍与上游 0 行差异）。
  var QUIET = {
    status: 'inactive',        // 只有这个**底层**状态算"休眠"
    color: '#5a6072',          // 冷灰（**非红**）：低对比，与地板同色系
    alpha: 0.42,               // 不透明度：低于报警的**最低**档（0.5）—— "低对比"是可测的
    x: 23, y: -10, w: 8, h: 8, // 相对角色像素原点 (px, py) 的锚点
  }
  function hexFrac(hex) {
    var h = String(hex).replace('#', '')
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
  }
  QUIET.frac = hexFrac(QUIET.color)   // 判据用它核对"实际画出来的像素确实是这个色"
  var ALARM = {                       // office.js:938-947 的报警框（**只读参照**，用于判据对照）
    x: 22, y: -10, w: 10, h: 8,
    alphaMin: 0.5, alphaMax: 0.9,     // 0.5 ± 0.4 ⇒ 会闪
  }

  // ── 可观测面：判据脚本读它，避免"没报错"与"没跑"分不清 ──
  var obs = {
    ticks: 0, ok: 0, lastHttp: 0, lastError: '',
    lastTotal: -1, companyId: '', companyName: '',
    companies: 0, rooms: 0, booked: 0, walkers: 0,
    lastWalkAt: 0, callbacks: [], modal: '', currentSession: '',
    parentSession: '', failReason: '',
  }
  window.__orgPanel = obs

  var state = null
  var chosenCompany = ''      // 用户手动选的公司；空 = 跟随当前会话
  var resolvedCompany = ''    // 本次实际请求的公司

  function setHud(id, text) {
    var el = document.getElementById(id)
    if (el) el.textContent = String(text)
  }
  function showError(msg) {
    var errBox = document.getElementById('err')
    if (errBox) { errBox.style.display = 'block'; errBox.textContent = msg }
    setHud('h-err', String(msg).split('\n')[0])
  }
  function clearError() {
    var errBox = document.getElementById('err')
    if (errBox) errBox.style.display = 'none'
    setHud('h-err', '')
  }

  if (!window.officeRenderer) {
    showError('officeRenderer 未初始化：office.js 没加载成功')
    return
  }
  var R = window.officeRenderer
  var TILE_PX = (typeof TILE === 'number') ? TILE : 32   // office.js 顶层 `const TILE = TILE_SIZE`（全局词法域，跨脚本可见）

  // ── ① 当前会话 id（决定"缺省跟随哪个公司"） ────────────────────────────────

  // ── ① 当前会话 id（决定"缺省跟随哪个公司"） ────────────────────────────────
  // 右侧栏 tab 的 body **拿不到 sessionId**（slots 只给 tabId/signal/actions）。
  // 但 iframe 与宿主**同源**，所以读 `window.parent.location.search`（DSH 的会话入口是
  // `/?session=<id>`，判据脚本 `org-panel-check.mjs` 就是这么进的）。逐级回退，全拿不到就走"公司列表第一个"。
  function readCurrentSession() {
    var m1 = function (href, key) {
      try {
        var m = String(href || '').match(new RegExp('[?&]' + key + '=([^&#]+)'))
        return m ? decodeURIComponent(m[1]) : ''
      } catch (e) { return '' }
    }
    // ★★ B163（2026-09-18）：**`?company=<sessionId>` 优先** ——
    //   这是 `client.js`（宿主侧）能拿到的【唯一可靠】通道：它把**当前会话 id** 放进 iframe 的 src。
    //   ⚠️ 为什么不用 `?session=`：**DSH 是 SPA，切会话时宿主 URL 不带 `?session=`**
    //     （实测：URL 恒为 `/`，`?session=` 被丢弃）⇒ 那个四级回退**全部落空** ⇒ 退到"列表第一个"。
    //   而 client.js 从 `ctx.sidebarRight.binding` 能拿到**真实 sessionId** ⇒ 经 src 传进来。
    var ownCompany = m1(window.location.search, 'company')
    if (ownCompany) return ownCompany
    var from = function (href) { return m1(href, 'session') }
    var own = from(window.location.search)
    if (own) return own
    try {
      var p = window.parent
      if (p && p !== window && p.location) {
        var got = from(p.location.search)
        if (got) return got
      }
    } catch (e) { obs.failReason += 'parent:' + (e && e.message) + ';' }
    // 宿主可能把手选会话存在本地存储里
    try {
      var keys = ['dsh.session', 'dsh:session', 'dsh.sessionId', 'dsh:lastSession', 'lastSession']
      for (var i = 0; i < keys.length; i++) {
        var v = window.localStorage.getItem(keys[i])
        if (v && /^[0-9a-fA-F-]{8,}$/.test(v)) return v
      }
      for (var j = 0; j < window.localStorage.length; j++) {
        var k = window.localStorage.key(j)
        if (!k || !/session/i.test(k)) continue
        var val = window.localStorage.getItem(k)
        if (val && /^[0-9a-fA-F-]{8,}$/.test(val)) return val
      }
    } catch (e) { obs.failReason += 'ls:' + (e && e.message) + ';' }
    return ''
  }

  // ── ② 走路动画：包 drawCharacter（原版入参即"目的地"，插值即成移动） ────────
  var walks = {}   // empId → {cur:[x,y], from:[x,y], to:[x,y], destKey, t0, dir}
  var origDrawCharacter = R.drawCharacter.bind(R)
  var origGetCharFrame = R._getCharFrame.bind(R)

  // ── ②b R106：把"休眠（常态）"与"故障（报警）"在**渲染缝上**彻底分开 ────────
  //
  // 判据读**底层状态** `_teamStatus`（`lib/index.js:434` 从 roster 原样带下来），
  // 不再借用那个被混用的 `api_online` —— 一个字段不担两个语义。
  var lastDraw = {}          // empId → {x, y, mode}：**本帧实际画它时用的入参**（判据据此算区域，不靠推断）
  // 逐帧计数：`live` 在渲染中累加，`committed` 在**帧末**原子提交
  // ⇒ 判据读到的永远是"某一个**画完整**的帧"，不会读到画了一半的中间态。
  var live = { quiet: 0, pass: 0 }
  var committed = { quiet: 0, pass: 0, frame: -1 }

  function isDormant(data) {
    return !!data && String(data._teamStatus || '').toLowerCase() === QUIET.status
  }

  // 帧末提交：包一层 render()，保证 `obs.quietThisFrame()` 读到的是**画完整**的一帧。
  var origRender = R.render.bind(R)
  R.render = function () {
    live.quiet = 0; live.pass = 0
    try {
      return origRender()
    } finally {
      committed.quiet = live.quiet
      committed.pass = live.pass
      committed.frame = R.animFrame
    }
  }
  function noteDraw(data, x, y, mode) {
    if (!data || !data.id) return
    var ld = lastDraw[data.id]
    if (!ld) ld = lastDraw[data.id] = { x: 0, y: 0, mode: '' }
    ld.x = x; ld.y = y; ld.mode = mode
    if (mode === 'quiet') live.quiet += 1
    else live.pass += 1
  }

  /** 安静的休眠标记：**静态**（无 animFrame）、**低对比**（alpha 0.42）、**冷灰非红**。 */
  function drawQuietBadge(x, y) {
    var ctx = R.ctx
    var px = x * TILE_PX
    var py = y * TILE_PX - TILE_PX      // 与 office.js:827 同构
    ctx.globalAlpha = QUIET.alpha
    ctx.fillStyle = QUIET.color
    ctx.fillRect(px + QUIET.x, py + QUIET.y, QUIET.w, QUIET.h)
    ctx.globalAlpha = 1
  }

  // 判据专用开关：为 true 时不画安静标记（用于取"底图"，从而把**徽章的贡献**从**背景的动**里分离出来）。
  // ⚠️ 只由 `obs.debugSample()` 在同一次调用内 set/restore；平时恒为 false。
  var suppressQuiet = false

  /**
   * 画一个角色：**休眠者 → 安静标记；其余原样交回原版**。
   *
   * ★ 关键一步：原版照画，但**先把它看到的"报警信号"摘掉** ——
   *   · `office.js:938` 见 `api_online===false` ⇒ 画那个**闪烁的红色 ✗**（`Math.sin(animFrame*0.1)`）
   *   · `office.js:913` 见 `status==='idle'`     ⇒ 画**会飘的 z**（也是 `Math.sin`）
   *   ⇒ 给原版一份**只用于这一次绘制**的替身：
   *       `api_online: true`   ⇒ 不画红色报警
   *       `status: 'inactive'` ⇒ 不画 z（office.js 只认 `'working'` / `'idle'` 两档）
   * ⚠️ **不改原对象**：替身活不过这一次调用 ⇒ `state` / tooltip / 点击判定读到的仍是**真值**。
   */
  function paintChar(x, y, data, isCEO) {
    var mode = isDormant(data) ? 'quiet' : 'pass'
    noteDraw(data, x, y, mode)
    if (mode === 'pass') return origDrawCharacter(x, y, data, isCEO)
    var safe = {
      id: data.id, name: data.name, nickname: data.nickname, role: data.role,
      avatar_sprite: data.avatar_sprite, desk_position: data.desk_position,
      level: data.level, skills: data.skills,
      status: QUIET.status, api_online: true, needs_setup: false, is_listening: false,
    }
    if (data.__walkBase !== undefined) safe.__walkBase = data.__walkBase
    var out = origDrawCharacter(x, y, safe, isCEO)
    if (!suppressQuiet) drawQuietBadge(x, y)
    return out
  }

  // ── 观测面：判据脚本读它（不新增全局大对象；挂进已有的 `__orgPanel`） ──
  obs.quietColor = QUIET.color
  obs.quietAlpha = QUIET.alpha
  obs.quietBox = { x: QUIET.x, y: QUIET.y, w: QUIET.w, h: QUIET.h }
  obs.alarmBox = { x: ALARM.x, y: ALARM.y, w: ALARM.w, h: ALARM.h, alphaMin: ALARM.alphaMin, alphaMax: ALARM.alphaMax }
  obs.quietThisFrame = function () { return { quiet: committed.quiet, pass: committed.pass, frame: committed.frame } }
  obs.dormantIds = function () {
    var out = []
    for (var k in lastDraw) if (lastDraw[k].mode === 'quiet') out.push(k)
    return out
  }
  /** 判据用：某个员工**这一帧实际被画在**哪里。返回设备像素矩形（含 dpr 与相机变换）。
   *  `dx/dy/w/h` 是相对角色像素原点 (px, py) 的**世界像素**偏移 —— 与 drawCharacter 内部同一坐标系。 */
  function regionOf(empId, dx, dy, w, h) {
    var ld = lastDraw[empId]
    if (!ld) return null
    var cam = R.camera, z = cam.zoom, dpr = R.dpr || 1
    var px = ld.x * TILE_PX, py = ld.y * TILE_PX - TILE_PX
    // 复刻 office.js render() 的变换链：setTransform(dpr,…) → scale(zoom) → translate(-round(cam.x), -round(cam.y))
    // ⇒ 设备像素 = dpr * zoom * (world - round(cam))
    var cx = Math.round(cam.x), cy = Math.round(cam.y)
    return {
      x: Math.round(dpr * z * (px + dx - cx)),
      y: Math.round(dpr * z * (py + dy - cy)),
      w: Math.max(1, Math.round(dpr * z * w)),
      h: Math.max(1, Math.round(dpr * z * h)),
      mode: ld.mode, tile: [ld.x, ld.y],
    }
  }
  obs.region = regionOf
  obs.badgeRect = function (empId, which) {
    var b = which === 'alarm' ? ALARM : QUIET
    return regionOf(empId, b.x, b.y, b.w, b.h)
  }
  obs.viewScale = function () { return { zoom: R.camera.zoom, dpr: R.dpr || 1, camX: R.camera.x, camY: R.camera.y } }
  obs.canvasSize = function () { return { w: R.canvas.width, h: R.canvas.height } }
  obs.animFrame = function () { return R.animFrame }
  obs.modeOf = function (empId) { return lastDraw[empId] ? lastDraw[empId].mode : null }

  /**
   * 判据专用：把相机**钉在目标位**（消除 lerp 亚像素漂移），返回可用于还原的快照。
   * 为什么需要：连拍两帧时相机会继续 lerp ⇒ 徽章区域读出 Δ=1~4 的差，
   * **那是相机在动，不是徽章在闪**。钉住之后才谈得上"像素完全相同"。
   * ⚠️ 还原用 `obs.unpinCamera(save)`，判据脚本放在 `finally` 里（改真机对象必须能回滚）。
   */
  obs.pinCamera = function () {
    var cam = R.camera
    var save = { x: cam.x, y: cam.y, zoom: cam.zoom, tx: cam._tx, ty: cam._ty, tz: cam._tz }
    cam.x = cam._tx; cam.y = cam._ty; cam.zoom = cam._tz
    return save
  }
  obs.unpinCamera = function (save) {
    if (!save) return
    var cam = R.camera
    cam.x = save.x; cam.y = save.y; cam.zoom = save.zoom
    cam._tx = save.tx; cam._ty = save.ty; cam._tz = save.tz
  }

  // 判据用**统一探针框**：同时罩住"安静标记"(23,-10,8,8) 与"原版报警"(22,-10,10,8)
  // ⇒ 三个构建量的是**同一块像素**，可以直接比（否则各量各的框，比较无意义）。
  var PROBE = { x: 20, y: -12, w: 14, h: 12 }
  obs.probeBox = { x: PROBE.x, y: PROBE.y, w: PROBE.w, h: PROBE.h }

  /**
   * 判据专用：**同步**、**可归因**地量"这个标记到底会不会随帧变"。
   *
   * ## 为什么不能直接连拍两帧（实测教训）
   * 直接隔 600ms 采两次，徽章区域会读出 **Δ=1~4** 的差 —— 但那是
   * **相机 lerp 的亚像素漂移** + **相机跳位后的头几次渲染不稳定**（图集/尺寸一次性建立），
   * **不是徽章在闪**。拿它当证据会得出错误结论。
   *
   * ## 做法：把变量逐个钉死，再比
   *   ① 相机定格到目标（消除 lerp 漂移）
   *   ② **暖机若干次渲染**（越过"头几次不稳定"窗口；实测第 3 次之后完全稳定）
   *   ③ 同一个 animFrame 渲染两次 ⇒ **渲染确定性**（期望 0 变化）
   *   ④ 两个不同 animFrame、标记**开** ⇒ 该区域总变化  ← **判据看这条**
   *   ⑤ 两个不同 animFrame、标记**关**（`suppressQuiet`）⇒ **纯背景**变化（归因对照）
   *   ⑥ 同一 animFrame、标记 开 vs 关 ⇒ 标记的**净贡献**（用来反解 alpha）
   * ⇒ ④ === 0 ⇒ 该区域**与帧无关** ⇒ 标记是**静态的**（这就是"不闪"的可测定义）。
   *
   * 全程**同步**（JS 单线程，rAF 插不进来），改过的真机对象在 `finally` **原样还原**，
   * **在同一次调用内完成**。
   */
  obs.debugSample = function (ids, box) {
    var B = box || PROBE
    var cam = R.camera
    var save = { x: cam.x, y: cam.y, zoom: cam.zoom, tx: cam._tx, ty: cam._ty, tz: cam._tz, af: R.animFrame }
    var cv = R.canvas, g = R.ctx
    function grab(r) {
      if (!r) return null
      var x = Math.max(0, Math.min(cv.width - 1, Math.round(r.x)))
      var y = Math.max(0, Math.min(cv.height - 1, Math.round(r.y)))
      var w = Math.max(1, Math.min(cv.width - x, Math.round(r.w)))
      var h = Math.max(1, Math.min(cv.height - y, Math.round(r.h)))
      var d = g.getImageData(x, y, w, h).data
      var a = []
      for (var i = 0; i < d.length; i += 4) a.push([d[i], d[i + 1], d[i + 2]])
      return { x: x, y: y, w: w, h: h, pixels: a }
    }
    var out = { box: { x: B.x, y: B.y, w: B.w, h: B.h }, warmup: 0, settled: false, items: {} }
    try {
      cam.x = cam._tx; cam.y = cam._ty; cam.zoom = cam._tz      // ① 定格
      // ② **暖机到"换帧不变"为止**（最多 20 轮）。
      //    为什么不能"固定渲染几次就完事"（实测踩过）：相机跳位后的头几次渲染**还没稳定**
      //    ⇒ 第一个被测的员工会读出 Δ=1~5 的**假"闪"**（实测 d1 有 225 像素、d2/d3 却是 0，
      //      差别只在于 d1 是暖机后**第一个**被量的）。所以暖机判据**必须就是我们要证的那件事**。
      //    ⚠️ 若 20 轮都稳定不下来 ⇒ `settled=false` ⇒ 判据**如实报红**（真闪就会这样，绝不掩盖）。
      var r0 = regionOf(ids[0], B.x, B.y, B.w, B.h)
      for (var wm = 0; wm < 20 && !out.settled; wm += 1) {
        out.warmup = wm + 1
        R.animFrame = 5000; suppressQuiet = false; origRender()
        var w1 = r0 ? grab(r0) : null
        R.animFrame = 5400; suppressQuiet = false; origRender()
        var w2 = r0 ? grab(r0) : null
        if (w1 && w2 && dstat(w1.pixels, w2.pixels).changed === 0) out.settled = true
      }
      for (var k = 0; k < ids.length; k += 1) {
        var id = ids[k]
        var rect = regionOf(id, B.x, B.y, B.w, B.h)
        var rec = { mode: lastDraw[id] ? lastDraw[id].mode : null, rect: rect }
        if (!rect) { out.items[id] = rec; continue }
        // ③ 同帧两次（标记开）
        R.animFrame = 5000; suppressQuiet = false; origRender()
        var a1 = grab(rect)
        R.animFrame = 5000; suppressQuiet = false; origRender()
        var a2 = grab(rect)
        // ④ 异帧（标记开）—— **判据看这条**
        R.animFrame = 5400; suppressQuiet = false; origRender()
        var b1 = grab(rect)
        // 再验一次（防"恰好一次相同"）
        R.animFrame = 6200; suppressQuiet = false; origRender()
        var b2 = grab(rect)
        // ⑤ 异帧（标记关）⇒ 纯背景（归因对照）
        R.animFrame = 5000; suppressQuiet = true; origRender()
        var c1 = grab(rect)
        R.animFrame = 5400; suppressQuiet = true; origRender()
        var c2 = grab(rect)
        // ⑥ 同帧 开 vs 关 ⇒ 标记净贡献
        R.animFrame = 5000; suppressQuiet = true; origRender()
        var c3 = grab(rect)
        // ⑦ **回环复核**：再回到 af=5000 渲染一次 ⇒ 与 a1 比。
        //    相等 ⇒ 5400 那次是真的"帧相关"；不等 ⇒ 是**暖机漂移**（渲染还没稳定），A1 不能照字面下结论。
        R.animFrame = 5000; suppressQuiet = false; origRender()
        var a1b = grab(rect)
        rec.sameFrame = dstat(a1.pixels, a2.pixels)          // 期望 0
        rec.loopBackSameFrame = dstat(a1.pixels, a1b.pixels) // 期望 0（回环）
        rec.diffFrameOn = dstat(a1.pixels, b1.pixels)        // ★ 期望 0 = 静态
        rec.diffFrameOn2 = dstat(a1.pixels, b2.pixels)       // ★ 期望 0 = 静态
        rec.diffFrameBg = dstat(c1.pixels, c2.pixels)        // 背景自身（归因）
        rec.netContribution = dstat(a1.pixels, c3.pixels)    // 标记画了什么
        rec.pixelsOn = a1.pixels                             // 完整像素（判据算红度/对比要看全，不能只看头几个）
        rec.pixelsBg = c3.pixels
        rec.lastDrawNow = lastDraw[id] ? [lastDraw[id].x, lastDraw[id].y] : null
        out.items[id] = rec
      }
    } finally {
      suppressQuiet = false
      R.animFrame = save.af
      cam.x = save.x; cam.y = save.y; cam.zoom = save.zoom
      cam._tx = save.tx; cam._ty = save.ty; cam._tz = save.tz
      origRender()
    }
    return out
  }
  function dstat(a, b) {
    var n = Math.min(a.length, b.length), same = 0, ch = 0, max = 0
    var first = []
    for (var i = 0; i < n; i += 1) {
      var d = Math.max(Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]), Math.abs(a[i][2] - b[i][2]))
      if (d === 0) same += 1
      else { ch += 1; if (first.length < 6) first.push({ i: i, a: a[i], b: b[i], d: d }) }
      if (d > max) max = d
    }
    return { total: n, same: same, changed: ch, max: max, first: first }
  }

  /** 员工用的精灵表 key（与原版 `_getCharFrame` 同构）。 */
  function sheetOf(data) {
    var n = data.avatar_sprite || ((R._hashStr(data.id || 'default') % 20) + 1)
    return 'char' + String(n).padStart(2, '0')
  }

  /** 工位在画布坐标里的位置（= 原版画"在岗"时的入参：desk_position + 1 列 / WALL_ROWS 行）。 */
  function homeOf(data) {
    var dp = data && data.desk_position
    if (!dp || dp.length !== 2) return null
    return [dp[0] + 1, dp[1] + WALL_ROWS]
  }
  // 原版 walk 行 = row 4；方向栏位与原版一致（右 0-5 / 上 6-11 / 左 12-17 / 下 18-23）
  R._getCharFrame = function (data) {
    if (data && data.__walkBase !== undefined) {
      var f = Math.floor(Date.now() / WALK_FRAME_MS) % 6
      return { sheet: sheetOf(data), row: 4, col: data.__walkBase + f, w: 1, h: 2 }
    }
    return origGetCharFrame(data)
  }
  R.drawCharacter = function (gx, gy, data, isCEO) {
    if (isCEO || !data || !data.id) return origDrawCharacter(gx, gy, data, isCEO)
    var key = gx + ',' + gy
    var now = Date.now()
    var w = walks[data.id]
    if (!w) {
      // ★ 首次见到这个员工：入参 = 它**现在该在的地方**。
      //   · 若那是工位 ⇒ 直接坐好（不用动）。
      //   · 若那是会议室 ⇒ **从工位走过来** —— 否则刷新页面后参会者会"凭空出现在会议室里"，
      //     走动动画永远看不到（这是第一版实测到的真缺陷）。
      var home = homeOf(data)
      var start = home && home.join(',') !== key ? home : [gx, gy]
      w = walks[data.id] = {
        cur: [start[0], start[1]], from: [start[0], start[1]], to: [gx, gy],
        destKey: key, t0: start.join(',') === key ? 0 : now, dir: 18,
      }
      if (w.t0) obs.lastWalkAt = now
    } else if (w.destKey !== key) {
      // 目的地变了（去开会 / 回工位）⇒ 从"当前画到的位置"开始走到新目的地
      w.from = [w.cur[0], w.cur[1]]
      w.to = [gx, gy]
      w.destKey = key
      w.t0 = now
      obs.lastWalkAt = now
    }
    if (w.destKey !== key || w.t0 === 0) return paintChar(gx, gy, data, isCEO)
    var same = w.to[0] === w.from[0] && w.to[1] === w.from[1]
    var p = same ? 1 : Math.min(1, (now - w.t0) / WALK_MS)
    var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2   // easeInOutQuad
    var x = w.from[0] + (w.to[0] - w.from[0]) * e
    var y = w.from[1] + (w.to[1] - w.from[1]) * e
    w.cur = [x, y]
    if (p < 1) {
      var dx = w.to[0] - w.from[0], dy = w.to[1] - w.from[1]
      w.dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 12) : (dy >= 0 ? 18 : 6)
      data.__walkBase = w.dir
      try { return paintChar(x, y, data, isCEO) } finally { delete data.__walkBase }
    }
    return paintChar(gx, gy, data, isCEO)
  }
  function countWalkers() {
    var n = 0, now = Date.now()
    for (var k in walks) {
      var w = walks[k]
      if (w.t0 && now - w.t0 < WALK_MS) n += 1
    }
    return n
  }
  /**
   * 走动**直接读数**（不是"调度过就算"）：返回每个走动中的员工的
   * 起点 / 终点 / **当前插值位置**。判据脚本采样两次，位置若在变 = 真的在走。
   */
  obs.walkSnapshot = function () {
    var out = [], now = Date.now()
    for (var k in walks) {
      var w = walks[k]
      if (!w.t0 || now - w.t0 >= WALK_MS) continue
      out.push({
        id: k, from: [Math.round(w.from[0] * 100) / 100, w.from[1]],
        to: [w.to[0], w.to[1]],
        pos: [Math.round(w.cur[0] * 100) / 100, Math.round(w.cur[1] * 100) / 100],
        progress: Math.round(((now - w.t0) / WALK_MS) * 100) / 100,
      })
    }
    return out
  }
  obs.atHome = function () {
    var out = []
    for (var k in walks) {
      var w = walks[k]
      if (w.destKey === w.from[0] + ',' + w.from[1]) out.push(k)
    }
    return out
  }

  // ── ③ 弹层（板 / 规则 / 项目 / 会议室 / 纪要 / 员工） ──────────────────────
  var modal = document.getElementById('modal')
  var mBody = document.getElementById('m-body')
  var mTabs = document.getElementById('m-tabs')
  var mTag = document.getElementById('m-tag')
  var mTitle = document.getElementById('m-title')
  var modalTabs = []
  var modalAt = 0

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function closeModal() {
    obs.modal = ''
    if (modal) modal.classList.remove('open')
  }
  function renderTabs() {
    if (!mTabs) return
    mTabs.innerHTML = ''
    if (modalTabs.length < 2) return
    modalTabs.forEach(function (t, i) {
      var b = document.createElement('div')
      b.className = 'tab' + (i === modalTabs.active ? ' on' : '')
      b.textContent = t.label
      b.onclick = function () { modalTabs.active = i; renderTabs(); t.render() }
      mTabs.appendChild(b)
    })
  }
  function openModal(tag, title, tabs) {
    obs.modal = tag
    modalAt = Date.now()
    if (mTag) mTag.textContent = tag
    if (mTitle) mTitle.textContent = title || ''
    modalTabs = tabs || []
    modalTabs.active = 0
    renderTabs()
    if (modalTabs.length > 0) modalTabs[0].render()
    if (modal) modal.classList.add('open')
  }
  function body(html) { if (mBody) mBody.innerHTML = html }

  var q = function (extra) {
    // ★★ B163：**company 的取值优先级**（这是"切会话时面板跟着切"的落点）：
    //   ① 用户手选的公司（`chosenCompany`，非空时优先 —— 尊重手动选择）
    //   ② ★ **当前会话**（`obs.currentSession`）—— 修前这里只用 `resolvedCompany`，
    //      而 `resolvedCompany` 要等**首拍回来**（`:1123` 由 `st.company.id` 赋）才有值
    //      ⇒ 首拍必然打 `?company=`（空）⇒ 后端退回"列表第一个"⇒ **面板停在上一个公司**。
    //   ⚠️ 为什么用 `?company=` 传会话：后端**慢路**里 `pickCompany(companies, wantCompany, wantSession)`
    //      能按 session 解析（`lib/index.js:300-306`），而**快路**不 collectCompanies ⇒ `?session=` 拿不到。
    var comp = chosenCompany || resolvedCompany || obs.currentSession || ''
    var s = '?company=' + encodeURIComponent(comp)
    if (chosenCompany === '' && obs.currentSession) s += '&session=' + encodeURIComponent(obs.currentSession)
    return s + (extra || '')
  }
  function getJson(path, extra) {
    return fetch(BASE + path + q(extra), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  // 板 = 团队任务板（对应原版公告板的 openWorkflowPanel 回调）
  function renderBoard() {
    body('<div>读取任务板…</div>')
    getJson('/board').then(function (d) {
      var rows = d.tasks || []
      if (rows.length === 0) {
        body('<div>本公司暂无任务。</div>' + (d.error ? '<div class="path">err: ' + esc(d.error) + '</div>' : ''))
        return
      }
      var h = '<table><tr><th>#</th><th>状态</th><th>主题</th><th>负责人</th><th>就绪</th></tr>'
      rows.forEach(function (t) {
        h += '<tr><td>' + esc(t.id) + '</td><td class="st-' + esc(t.status) + '">' + esc(t.status) + '</td>'
        h += '<td>' + esc(t.subject) + '</td><td>' + esc(t.ownerName || '—') + '</td>'
        h += '<td>' + (t.ready ? '✓' : '✗') + '</td></tr>'
      })
      h += '</table>'
      body(h)
    }).catch(function (e) { body('<div>任务板读取失败：' + esc(e.message) + '</div>') })
  }
  // 规则 = $DSH_HOME/teamkit/RULES.yml
  function renderRules() {
    body('<div>读取 RULES.yml…</div>')
    getJson('/rules').then(function (d) {
      if (!d.exists) {
        body('<div>未找到 RULES.yml。</div><div class="path">试过：' + esc((d.tried || []).join('  |  ')) + '</div>')
        return
      }
      body('<div class="path">' + esc(d.path) + '</div><pre style="white-space:pre-wrap;margin:6px 0 0">' + esc(d.text) + '</pre>')
    }).catch(function (e) { body('<div>RULES.yml 读取失败：' + esc(e.message) + '</div>') })
  }
  // 项目 = 各公司（会话）的任务汇总
  function renderProjects() {
    body('<div>读取项目…</div>')
    getJson('/projects').then(function (d) {
      var rows = d.companies || []
      var h = '<table><tr><th>公司（会话）</th><th>员工</th><th>任务</th><th>完成</th><th>进行中</th><th>cwd</th></tr>'
      rows.forEach(function (c) {
        h += '<tr><td>' + esc(c.name) + (c.isCurrent ? ' ◀' : '') + '</td><td>' + esc(c.teammates) + '</td>'
        h += '<td>' + esc(c.tasks) + '</td><td>' + esc(c.completed) + '</td><td>' + esc(c.inProgress) + '</td>'
        h += '<td class="path">' + esc(c.cwd) + '</td></tr>'
      })
      h += '</table>'
      body(h)
    }).catch(function (e) { body('<div>项目读取失败：' + esc(e.message) + '</div>') })
  }
  // 会议室 / 纪要
  function renderRoom(room, wantMinutes) {
    body('<div>读取会议记录…</div>')
    getJson('/minutes', '&room=' + encodeURIComponent(room.id)).then(function (d) {
      var h = '<div><b>' + esc(room.name) + '</b> · ' + (d.hasMinutes ? '已结束（有纪要）' : '进行中（无纪要）') + '</div>'
      h += '<div class="path">议程：' + esc(d.agendaPath) + '</div>'
      h += '<div class="path">纪要：' + esc(d.minutesPath || '（还没有）') + '</div>'
      h += '<div style="margin-top:6px"><b>议程</b></div><pre style="white-space:pre-wrap">' + esc(d.agenda) + '</pre>'
      if (d.minutes) h += '<div style="margin-top:6px"><b>纪要</b></div><pre style="white-space:pre-wrap">' + esc(d.minutes) + '</pre>'
      body(h)
    }).catch(function (e) { body('<div>会议记录读取失败：' + esc(e.message) + '</div>') })
  }
  function renderEmployee(emp) {
    var h = '<div><b>' + esc(emp.name) + '</b> · ' + esc(emp.title || emp.role) + '</div>'
    h += '<table><tr><th>字段</th><th>值</th></tr>'
    ;[['id', emp.id], ['status', emp._teamStatus || emp.status], ['provider', emp._provider],
      ['context', emp._context], ['model', emp._model], ['role', emp.role]].forEach(function (p) {
      h += '<tr><td>' + esc(p[0]) + '</td><td>' + esc(p[1] || '—') + '</td></tr>'
    })
    h += '</table>'
    if ((emp._diagnostics || []).length) {
      h += '<div style="margin-top:6px"><b>diagnostics</b></div><pre style="white-space:pre-wrap">' + esc(emp._diagnostics.join('\n')) + '</pre>'
    }
    body(h)
  }

  // ★ 原版 office.js 会发这些回调；**以前一个都没实现** ⇒ 点不开。
  window.app = window.app || {}
  var CB = {
    openWorkflowPanel: function () {
      openModal('板', '任务板（板 / board）', [
        { label: '任务板', render: renderBoard },
        { label: 'RULES.yml', render: renderRules },
      ])
    },
    openProjectWall: function () {
      openModal('项目', '项目（所有公司 / 会话）', [
        { label: '项目', render: renderProjects },
        { label: '任务板', render: renderBoard },
      ])
    },
    openMeetingRoom: function (room) {
      openModal('会议室', '会议室：' + (room && room.name ? room.name : ''), [
        { label: '会议记录', render: function () { renderRoom(room) } },
      ])
    },
    openMeetingMinutes: function (room) {
      openModal('纪要', '会议纪要：' + (room && room.name ? room.name : ''), [
        { label: '会议记录', render: function () { renderRoom(room, true) } },
      ])
    },
    openEmployeeDetail: function (emp) {
      openModal('员工', '员工：' + (emp && emp.name ? emp.name : ''), [
        { label: '详情', render: function () { renderEmployee(emp || {}) } },
      ])
    },
    openToolDetail: function (id) { openModal('工具', '工具：' + id, [{ label: '详情', render: function () { body('<div>无工具数据。</div>') } }]) },
  }
  Object.keys(CB).forEach(function (k) { window.app[k] = CB[k] })
  obs.callbacks = Object.keys(CB)

  var closeBtn = document.getElementById('m-x')
  if (closeBtn) closeBtn.onclick = closeModal
  if (modal) modal.onclick = function (e) { if (e.target === modal) closeModal() }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal() })
  // HUD 三个按钮 —— 走**同一条** modal 通路（与画布点击一致）
  var bind = function (id, fn) { var el = document.getElementById(id); if (el) el.onclick = fn }
  bind('b-board', CB.openWorkflowPanel)
  bind('b-rules', function () { openModal('规则', 'RULES.yml（治理规则）', [{ label: 'RULES.yml', render: renderRules }]) })
  bind('b-projects', CB.openProjectWall)
  // 画布上"板 / projects"两块牌子的坐标由 office.js 自己算；这里不再重复实现。

// ── R110（task-102）：**不可见 ⇒ 停"工作"（不是停"画面"）** ─────────────────
//
// ## 委托方现象（逐字）
// 「在我**开关这个侧边栏**的时候，我电脑就是会**卡一下**，然后我的**鼠标变慢了**，
//   再**慢慢慢慢**恢复到正常的**跟手**的状态」
//
// ## 实测（CEO 独立采样，我已复核同向）
// ```
// electron renderer（侧边栏所在进程）10 次 2s 采样：均值 **79.7% 单核**（>40% 占 9/10，<5% 占 0/10）
//   ⇒ **持续**满载（不是偶发尖峰）⇒ 系统级输入延迟 = "鼠标变慢"的直接来源
// gpu-process：4s 增量 **0.00s** ⇒ ★ **排除 GPU**（我原以为是大贴图压 GPU —— 被读数否掉）
// ```
// ## 机制（两件事，别混为一谈）
// ```
// · **一直在烧** ← `office.js:1329` `loop(){ …; requestAnimationFrame(()=>this.loop()) }` **无条件常驻**
//                 + `bridge.js` 的 `setInterval(tick,1500)` **无可见性判断**（grep 0 命中）
// · **开关那一下卡** ← 打开时解码 tileset 4.93MB（单张 2.42MB）
// ⇒ 本段治的是**前者**（持续烧）；后者另算。
// ```
// ## 为什么不改 `office.js`（硬边界）
// `R.loop` 是**实例属性解析**：`office.js:1333` 写的是 `this.loop()`，
// ⇒ 我们在 `bridge.js` 里把 `R.loop` 换掉，**原版那一行照样调我们的包装** ⇒ **office.js 一行不改**。
// 复用渲染器（**不重建**）：只"暂停/恢复调度"，`camera` 位置、`animFrame`、状态全保留。
var lifecycle = {
  visible: true, rafRunning: false, pollRunning: false,
  stops: 0, resumes: 0, rendersBlocked: 0, ticksSkipped: 0,
  reason: '', ioIntersecting: null, canvasSize: null, forced: null,
}
var origLoop = R.loop.bind(R)

// ── R111（task-115 可交付部分）：**可见时的运行时节流** ──────────────────────
//
// ## 为什么要做（源文件实测，不是我猜的）
// ```
// 前台 962 帧 / 6.01s = **160 fps** · 后台 6 帧 / 6.00s = 1 fps · 重新置前 991 帧 / 165 fps
// ⇒ ★ **可见时它在跑 160fps** —— 这才是"面板开着就烧"的来源。
//   （R110 解决的是"不可见时不停"；这里是"可见时空转"—— 两件事，别混。）
// ```
// ## 160fps 里最贵的是什么（只读源码得出的三处）
// ```
// office.js:1319  for (let sy = 0; sy < cssH; sy += 2) ctx.fillRect(0, sy, cssW, 1)
//                 ⇒ 每帧 ~350 次 fillRect（扫描线）⇒ 160fps 下 ≈ **5.6 万次/秒**
// office.js:1325  this._updateTooltip()  ⇒ **每帧一次 DOM 读写**（会碰 layout）
// office.js:1324  this.minimap.draw(...) ⇒ 每帧再画一遍小地图
// ⇒ 这三处都**挂在 render() 里** ⇒ **只要不渲染，就全省掉**。
// ```
// ## 形态：**跳帧但续链**（★ 这是最容易做错的地方）
// ```
// 不可见            ⇒ 不调 origLoop、**不续链**（R110 现状，停死）
// 可见 + 有活动     ⇒ 调 origLoop（原版全速）
// 可见 + 全空闲     ⇒ **不调 origLoop**（不渲染、`animFrame` 不自增），
//                     但 **自己 `requestAnimationFrame` 续链** ← ⚠️ 少了这一步，
//                     那条 RAF 链就**断了** ⇒ 画面**永久冻结**（比卡还糟）。
// ```
// ## ⚠️ 一条用户看得见的代价（已报 product-director 裁 A/B）
// ```
// `office.js` 的**氛围动画全部按【帧数】算**（`animFrame * k`，实测 12 处）：
//   蒸汽 `Math.sin(this.animFrame * 0.06)` · LED `(this.animFrame + sy) % 60` ·
//   昼夜 `Math.sin(this.animFrame * 0.005)` · 星相位 `(this.animFrame + x * 7) % 200` …
// ⇒ **降帧数 ⇒ 这些氛围动画按同比例变慢**（画面主体静止时，它们慢下来）。
//   ⇒ 这是**用户看得见的变化**，不是缺陷 ⇒ 故做成可配置，默认取"空闲才降"。
// ```
var THROTTLE = {
  enabled: true,
  // ★ 空闲时的目标帧率。160 ⇒ 10 是 ~16× 的降幅；先取 10，可调。
  idleFps: 10,
  // ★ A/B 开关（product-director 裁）：
  //   false = **A**：可见但空闲就降帧（氛围动画会变慢）
  //   true  = **B**：只在**窗口失焦**时才降帧（用户在看时全速）
  onlyWhenUnfocused: false,
  // 刚拿到新状态后的"全速宽限期"（新数据来了要看清）
  graceMs: 2500,
}
var throttle = {
  active: true, lastActiveAt: Date.now(), lastRenderAt: 0, lastChainAt: 0,
  inputUntil: 0,
  renders: 0, skipped: 0, chains: 0, reasons: {},
}
function markActive(why) {
  throttle.active = true
  throttle.lastActiveAt = Date.now()
  if (why) throttle.reasons[why] = (throttle.reasons[why] || 0) + 1
}
/**
 * ★★ R111 核心：**"活动"是"有变化"，不是"有心跳"**。
 *
 * 为什么需要它：轮询每 **1.5s** 都来一次，但**内容常常完全一样**
 * （同一批人、同一批状态）⇒ 那**不构成"值得全速重绘的新东西"**。
 * 若把"每次 tick"当活动 ⇒ 宽限窗（2.5s）永远不过期 ⇒ **节流从不生效**
 * （我第一版就是这么错的：实测 164fps 纹丝不动，判据 A1/A2 报红）。
 *
 * 签名取"**会改变画面**"的那些字段（**只读、不写任何东西**）：
 *   员工 id/status/is_listening + 公司 id + 会议室占用/参与者 + HUD 那三个数。
 * ⇒ 任一变化 ⇒ 记 `markActive('state-changed')` ⇒ 全速宽限期（≥2.5s）。
 */
function stateSignature(st) {
  var parts = []
  var s = (st && st.summary) || {}
  parts.push(st && st.company ? st.company.id : '')
  parts.push(s.total, s.working, s.idle, s.sleep, s.bookedRooms, s.inMeeting)
  var emps = (st && st.employees) || []
  for (var i = 0; i < emps.length; i += 1) {
    var e = emps[i]
    parts.push(e.id, e.status, e.is_listening ? 1 : 0)
  }
  var rooms = (st && st.meeting_rooms) || []
  for (var j = 0; j < rooms.length; j += 1) {
    parts.push(rooms[j].name, rooms[j].is_booked ? 1 : 0, (rooms[j].participants || []).length)
  }
  return parts.join('|')
}
/** 只读判据：**现在算不算"有活动"**（任何一条成立 ⇒ 全速）。 */
function activityNow() {
  var why = []
  var now = Date.now()
  if (now - throttle.lastActiveAt < THROTTLE.graceMs) why.push('grace')
  try { if (countWalkers() > 0) why.push('walkers') } catch (e) { /* */ }
  try {
    var cam = R.camera
    if (cam && (Math.abs((cam.x || 0) - (cam._tx || 0)) > 0.5 ||
                Math.abs((cam.y || 0) - (cam._ty || 0)) > 0.5 ||
                Math.abs((cam.zoom || 1) - (cam._tz || 1)) > 0.001)) why.push('camera')
  } catch (e) { /* */ }
  try { if (modal && modal.classList.contains('open')) why.push('modal') } catch (e) { /* */ }
  // ★★ product-director 加的一条（我采纳）：**鼠标交互 = 最强的活动信号** ——
  //   "用户在动它"正是他要的**跟手体感**的一部分 ⇒ 交互后**立刻全速**（走 graceMs 同一个宽限窗口）。
  //   判据：`mousemove/mousedown/click/wheel` 都打 `lastActiveAt`（`inputUntil` 也一样起效）。
  if (now < (throttle.inputUntil || 0)) why.push('input')
  // A 档：窗口失焦本身不算"活动"；B 档也不看焦点 —— 失焦只影响"能不能降"（见 R.loop）
  return why
}
// ★ 鼠标交互 ⇒ 立刻全速（至少 graceMs）。用**捕获阶段**监听，保证在 office.js 自己的
//   `_bindEvents`（canvas 上的 mousedown/mousemove/wheel）之前也记录到。
;(function bindInputActivity() {
  var evs = ['mousemove', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'touchstart']
  function onInput() { throttle.inputUntil = Date.now() + THROTTLE.graceMs }
  for (var i = 0; i < evs.length; i += 1) {
    try { document.addEventListener(evs[i], onInput, { capture: true, passive: true }) } catch (e) {
      try { document.addEventListener(evs[i], onInput, true) } catch (e2) { /* */ }
    }
  }
})()

/** `R.loop` 的包装：不可见 ⇒ 停；可见但空闲 ⇒ **跳帧但续链**；有活动 ⇒ 原版全速。 */
R.loop = function () {
  if (!lifecycle.visible) {
    lifecycle.rafRunning = false
    lifecycle.rendersBlocked += 1
    return                       // ★ 关键：**不调 origLoop** ⇒ 不再 requestAnimationFrame
  }
  lifecycle.rafRunning = true

  if (THROTTLE.enabled) {
    var why = activityNow()
    var unfocused = false
    try { unfocused = (typeof document.hasFocus === 'function') ? !document.hasFocus() : false } catch (e) { /* */ }
    var canIdle = THROTTLE.onlyWhenUnfocused ? unfocused : true
    if (why.length === 0 && canIdle) {
      // 全空闲 ⇒ 按 idleFps 节流：到点才渲染，**不到点也要续链**（否则链断 ⇒ 冻死）
      var now = Date.now()
      if (now - throttle.lastRenderAt < (1000 / Math.max(1, THROTTLE.idleFps))) {
        throttle.skipped += 1
        throttle.chains += 1
        requestAnimationFrame(function () { R.loop() })   // ★ 跳帧但续链
        return
      }
      throttle.lastRenderAt = now
    }
  }
  throttle.renders += 1
  throttle.lastRenderAt = Date.now()
  return origLoop()
}

var pollTimer = null
function startPoll() {
  if (pollTimer !== null) return
  pollTimer = setInterval(function () {
    if (!lifecycle.visible) { lifecycle.ticksSkipped += 1; return }
    tick(false)
  }, INTERVAL)
  lifecycle.pollRunning = true
}
function stopPoll() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
  lifecycle.pollRunning = false
}

/**
 * 重新判定"可见性"，并**在状态翻转时停/启**。
 *
 * ⚠️ **为什么不只用 `document.visibilityState`**：侧边栏收起时，iframe 往往是
 * **`display:none`** 而不是顶层窗口最小化 ⇒ `document.hidden` **不会**变 true。
 * ⇒ 必须再加**本地的"我还在不在布局里"**判据：
 *   · `IntersectionObserver` 看 `#stage` 是否还与视口相交（`display:none` ⇒ not intersecting）
 *   · 画布尺寸为 0（`office.js:_resizeCanvas` 对 0 尺寸会早退 ⇒ 那种状态下画面本来也没在更新）
 */
function recomputeVisibility() {
  var io = lifecycle.ioIntersecting
  var cv = R.canvas
  var size = cv ? [cv.clientWidth || 0, cv.clientHeight || 0] : [0, 0]
  lifecycle.canvasSize = size
  var docHidden = (typeof document.visibilityState === 'string') ? document.visibilityState !== 'visible' : false
  var zeroSize = size[0] === 0 || size[1] === 0
  var hidden = docHidden || (io === false) || zeroSize
  var visible = !hidden
  if (lifecycle.forced !== null) { visible = !!lifecycle.forced; lifecycle.reason = 'forced-test-hook' }
  else lifecycle.reason = docHidden ? 'document.hidden' : (io === false ? 'not-intersecting' : (zeroSize ? 'zero-size' : 'visible'))
  if (visible === lifecycle.visible) return
  lifecycle.visible = visible
  if (visible) {
    lifecycle.resumes += 1
    startPoll()
    R.loop()                     // ★ 重新起链（原版 loop 会自己继续调度）
    tick(false)
  } else {
    lifecycle.stops += 1
    stopPoll()
    // 不主动调 R.loop：让**当前已排队的那一帧**跑到包装里、由它停止调度（避免出现两个链）
  }
}

/** 判据用测试钩子：`null` = 用真实判据；`true/false` = 强制。 */
obs.forceVisible = function (v) {
  lifecycle.forced = (v === null || v === undefined) ? null : !!v
  recomputeVisibility()
  return { forced: lifecycle.forced, visible: lifecycle.visible, reason: lifecycle.reason }
}
obs.lifecycle = function () { return Object.assign({}, lifecycle) }
/** R111 判据用：节流读数（含**实际渲染次数**与**跳过次数**，以及当时的"活动理由"）。 */
obs.throttle = function () {
  var now = Date.now()
  var spanMs = now - (obs.__throttleT0 || (obs.__throttleT0 = now))
  return {
    enabled: THROTTLE.enabled, onlyWhenUnfocused: THROTTLE.onlyWhenUnfocused, idleFps: THROTTLE.idleFps,
    renders: throttle.renders, skipped: throttle.skipped, chains: throttle.chains,
    rendersPerSec: spanMs > 0 ? Math.round((throttle.renders / spanMs) * 10000) / 10 : null,
    skippedPerSec: spanMs > 0 ? Math.round((throttle.skipped / spanMs) * 10000) / 10 : null,
    spanMs: spanMs, reasons: Object.assign({}, throttle.reasons),
    activityNow: activityNow(),
    visible: lifecycle.visible, rafRunning: lifecycle.rafRunning,
  }
}
/** 判据用：**重置节流计数并从此刻开始计**（让"改后 fps"与"改前 fps"同口径）。 */
obs.throttleReset = function () { throttle.renders = 0; throttle.skipped = 0; throttle.chains = 0; obs.__throttleT0 = Date.now(); return obs.throttle() }
/** 判据用：运行时开关（A/B 对照都靠它，不重建页面）。 */
obs.throttleSet = function (patch) { if (patch) Object.assign(THROTTLE, patch); return obs.throttle() }

// 启动：先把 RAF 链换到我们的包装上（原版 constructor 已经起了一条链；
// 那条链的下一帧会走到包装里，从而**由我们接管调度**）。
// 观察 ①：顶层文档可见性
document.addEventListener('visibilitychange', recomputeVisibility)
// 观察 ②：iframe 被 display:none / 移出视口（顶层可见时 `document.hidden` 不会变）
try {
  if (typeof IntersectionObserver === 'function') {
    var host = document.getElementById('stage') || R.canvas
    var io2 = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) {
        lifecycle.ioIntersecting = entries[i].isIntersecting
      }
      recomputeVisibility()
    }, { threshold: 0 })
    io2.observe(host)
  } else {
    lifecycle.reason = 'no-IntersectionObserver'
  }
} catch (e) { lifecycle.reason = 'io-error:' + (e && e.message) }
// 观察 ③：尺寸变化（ResizeObserver 已由 office.js 挂在 canvas 父元素上，这里只补"尺寸=0"这一条）
try {
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { recomputeVisibility() }).observe(R.canvas)
  }
} catch (e) { /* 可选 */ }

// ── ④ 拉状态 + 公司切换器 ─────────────────────────────────────────────────
  var sel = document.getElementById('company')
  if (sel) {
    sel.onchange = function () {
      chosenCompany = sel.value
      resolvedCompany = chosenCompany      // ★ 必须同步：否则下一次请求还带着旧公司 id（实测踩过）
      obs.chosen = chosenCompany
      tick(true)
    }
  }

  function fillCompanies(list, currentId) {
    if (!sel) return
    // ★ **R104：空公司不跟真公司平铺在一起**（2026-09-14）。
    //
    // ## 现象（委托方会一眼皱眉的那种）
    // 下拉里 **12 家公司有 11 家是 0 人**（历史上开过、没招过人的会话）。
    // 真正有 17 人的那家公司，**混在一堆空壳中间**，看不出哪个是"活的"。
    //
    // ## 为什么不是"干脆隐藏空公司"
    // 空公司**不是垃圾**：那是你按"一个会话一个公司"开的局，**随时可以进去招人**。
    // 隐藏掉 ⇒ 用户找不到"我那个会话的公司"了。
    // ## 所以：**分类，不删除**
    //   · 有人的公司 ⇒ 直接列
    //   · 没人的公司 ⇒ 收进一个**分组标签**（`── 空公司 N 家 ──`，`disabled`，选不中）
    //   · **当前选中的公司永远在列表里**（哪怕它是空的 —— 否则切过去之后下拉会"跳走"）
    var live = []
    var empty = []
    list.forEach(function (c) {
      var n = typeof c.teammates === 'number' ? c.teammates : 0
      if (n > 0 || c.id === currentId) live.push(c)
      else empty.push(c)
    })
    live.sort(function (a, b) { return (b.teammates || 0) - (a.teammates || 0) })

    var want = []
    live.forEach(function (c) {
      want.push({ id: c.id, text: c.name + '  ·  ' + c.teammates + '人' + (c.id === currentId ? '  ◀当前' : ''), head: false })
    })
    if (empty.length > 0) {
      want.push({ id: '__empty__', text: '── 空公司 ' + empty.length + ' 家（还没招人）──', head: true })
      empty.forEach(function (c) {
        want.push({ id: c.id, text: '　' + c.name + '  ·  0人', head: false })
      })
    }

    var sig = want.map(function (w) { return w.id + '|' + w.text }).join(';')
    if (sel.getAttribute('data-sig') !== sig) {
      sel.setAttribute('data-sig', sig)
      sel.innerHTML = ''
      want.forEach(function (w) {
        var o = document.createElement('option')
        o.value = w.id; o.textContent = w.text
        if (w.head) o.disabled = true      // 分组标签不可选
        sel.appendChild(o)
      })
    }
    var v = chosenCompany || currentId || (live[0] && live[0].id) || ''
    if (v && sel.value !== v) sel.value = v
  }

  /**
   * R107：**「读不到」与「0 人」必须分开**（委托方：公司一闪一闪，一会儿 EMPTY 一会儿满员）。
   *
   * ## 我自己取的读数（不是转述）
   * 同一 URL 连采 30 次：`22×15, 0,0,0, 22×12` ⇒ **3/30 拍到空**。
   * 撞上那一刻的原始 payload：
   * ```
   * total=0  building=true  source=pending  buildMs=0  company=null  employees=0
   * ```
   * ⇒ **空态里本来就带着"我在重算"的信号**，而 `paint()` **只读 `summary.total`**
   *   ⇒ 把"读不到"渲染成了"**0 人**"，于是画面 EMPTY↔满员 地闪。
   *
   * ## 供给源（在 `lib/index.js`，不归本次前端修）
   * `lib/index.js:548-554 stateFast()`：缓存是**单槽**（`cache.key`），
   * `!sameKey`（被别的键顶掉 / 冷键）时就 `return EMPTY_STATE`（清空），**不沿用旧值**。
   * 我的复核读数（交替两个 key）复现出**一模一样的闪**：`0,22,0,22,0,22…`（12 次里 6 次 0）。
   *
   * ## 本函数：只**读已有信号**，不发明数据源
   * 「真 0 人」与「读不到」所需的区分信息**都在 payload 里**：
   *   · `building === true` / `source === 'pending'` ⇒ **重算中**
   *   · `company === null` 且 `companies` 为空      ⇒ **连公司都没解出来**（= 读不到）
   *   · 其余（`building:false` + `source:'agentTeams'`）⇒ **才是有结论的状态**
   * ⇒ 有结论时才允许显示数字（**真·空公司照样显示 0**）；否则显示加载态。
   *
   * 返回：`'ready'`（有结论）/ `'pending'`（重算中）/ `'unknown'`（读不到）。
   */
  function classifyState(st) {
    if (!st || typeof st !== 'object') return 'unknown'
    if (st.building === true) return 'pending'
    if (String(st.source || '') === 'pending') return 'pending'
    // EMPTY_STATE 的特征：没有 company、也没有 companies
    if (!st.company && ((st.companies || []).length === 0)) return 'unknown'
    return 'ready'
  }
  var AVAIL_TEXT = { pending: '加载中…', unknown: '未获取' }

  /**
   * 非 ready 时只动 HUD 的**状态字**，**不动数字以外的画面**：
   * · 不调 `R.updateState` ⇒ **沿用上一帧**（这才是用户要的"不闪"）
   * · 不覆盖 `state` / 不刷公司下拉 ⇒ 否则下拉也会跟着闪
   */
  function paintUnavailable(avail) {
    var t = AVAIL_TEXT[avail] || '未获取'
    setHud('h-total', t)
    setHud('h-working', t)
    setHud('h-idle', t)
    setHud('h-sleep', t)
    // 「会议室」沿用上一帧的值（不清空），避免同一块 HUD 上只有它在跳
    obs.avail = avail
    obs.availText = t
    if (avail === 'pending') obs.pendingTicks = (obs.pendingTicks || 0) + 1
    else obs.unknownTicks = (obs.unknownTicks || 0) + 1
  }
  obs.stateAvailability = function () { return obs.avail || 'unknown' }

  function paint(st) {
    var s = (st && st.summary) || null
    var emps = (st && st.employees) || []
    setHud('h-total', s ? s.total : emps.length)
    setHud('h-working', s ? s.working : emps.filter(function (e) { return e.status === 'working' }).length)
    // ★ **R105 原口径**：用 `api_online === false` 拆出"休眠"。
    // ★ **R106 订正口径**：改用与**画布上那个安静标记完全相同**的判据 `_teamStatus === 'inactive'`。
    //
    // 为什么必须订正（否则 HUD 与画面会各说各话）：
    //   R102 让 `inactive`（休眠）**和** `failed`（真故障）**共用一个** `api_online:false`
    //   ⇒ 拿它数"休眠"，会把**真故障的人也算进"休眠"**。
    //   R106 把两者在画面上分开了（休眠=安静灰标 / 故障=红色闪烁报警）
    //   ⇒ HUD 的"休眠"这一档**必须跟着同一个判据走**，否则同一块屏幕上两个数字互相打脸。
    //   `failed` 不落在"休眠"里（它有自己的报警表达）；为使三档仍守恒，
    //   它归入**待命**那一档 —— 三档和仍 === 总人数（下一条断言盯着）。
    var dormant = function (e) { return String(e._teamStatus || '').toLowerCase() === QUIET.status }
    var sleepCount = emps.filter(function (e) { return e.status !== 'working' && dormant(e) }).length
    var readyCount = emps.filter(function (e) { return e.status !== 'working' && !dormant(e) }).length
    setHud('h-idle', readyCount)
    setHud('h-sleep', sleepCount)
    var rooms = (st && st.meeting_rooms) || []
    var booked = rooms.filter(function (r) { return r.is_booked }).length
    setHud('h-rooms', rooms.length + (booked ? '（占用 ' + booked + '）' : ''))
    obs.rooms = rooms.length
    obs.booked = booked
    obs.ready = readyCount
    obs.sleep = sleepCount
  }

  function tick(forceWait) {
    obs.ticks += 1
    obs.currentSession = readCurrentSession()
    if (!obs.parentSession) obs.parentSession = obs.currentSession
    // 缺省跟随当前会话：用户没手选时，每拍都用当前 session 解析公司
    if (chosenCompany !== '' && resolvedCompany === '') resolvedCompany = chosenCompany
    var url = BASE + '/state' + q((forceWait || state === null) ? '&wait=1' : '')
    fetch(url, { cache: 'no-store' })
      .then(function (res) {
        obs.lastHttp = res.status
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (st) {
        // ★ R107：**先分类，再决定要不要用它覆盖画面**。
        //   「读不到 / 重算中」⇒ 只改 HUD 状态字，**画面沿用上一帧**（`state` 不动）。
        //   真·空公司（ready 且 total=0）⇒ 照常显示 0（那是**事实**）。
        var avail = classifyState(st)
        obs.avail = avail
        obs.lastAvailAt = Date.now()
        if (avail !== 'ready') {
          paintUnavailable(avail)
          clearError()
          obs.ok += 1
          obs.lastError = ''
          obs.availability = obs.availability || {}
          obs.availability[avail] = (obs.availability[avail] || 0) + 1
          return                     // ★ 关键：**不 updateState、不刷下拉、不覆盖 state**
        }
        state = st
        obs.companies = (st.companies || []).length
        obs.companyId = st.company ? st.company.id : ''
        obs.companyName = st.company ? st.company.name : ''
        // 公司切换器的候选项
        fillCompanies(st.companies || [], obs.companyId)
        if (chosenCompany === '' && st.company) resolvedCompany = st.company.id
        if (st.company && st.company.id && !obs.firstCompanyAt) obs.firstCompanyAt = Date.now()
        R.updateState(st)
        // ★★ R111 关键修正：**只在"状态真的变了"时才算活动**。
        //   ⚠️ 第一版我写成"每次 tick 都 markActive" ⇒ 而轮询是 **1.5s** 一次、
        //      宽限窗是 **2.5s** ⇒ **宽限窗永远不过期** ⇒ 节流**从不生效**（实测 164 fps 纹丝不动，A1/A2 报红）。
        //   ⇒ 语义上本来就该这样：**"活动"是"有变化"，不是"有心跳"**。
        //      轮询本身每 1.5s 都来，但**内容一样 = 没新东西可看** ⇒ 不需要为之全速重绘。
        var sig = stateSignature(st)
        if (sig !== obs.__lastStateSig) {
          obs.__lastStateSig = sig
          markActive('state-changed')
        }
        paint(st)
        clearError()
        obs.ok += 1
        obs.lastError = ''
        obs.lastTotal = (st.employees || []).length
        obs.walkers = countWalkers()
      })
      .catch(function (err) {
        obs.lastError = err && err.message ? err.message : String(err)
        if (obs.ticks >= 2) showError('拉取状态失败：' + obs.lastError)
      })
  }

  tick(true)
  // ★ R110：轮询改由 `startPoll()` 管（不可见时**整拍跳过**，不是"继续请求只是不画"）。
  startPoll()
  // 启动即按当前可见性自检一次（若初拍时面板就是收起的，立刻停）
  recomputeVisibility()
})()
