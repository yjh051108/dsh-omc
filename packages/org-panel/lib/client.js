/**
 * @dsh-external/dsh-org-panel — client half.
 *
 * 只在右侧栏登记一个 tab，内容是一张 iframe 指向 host 侧的办公室页面。
 * 全部绘制逻辑在 OMC 原版 office.js 里，这里一行绘制都不重复实现。
 *
 * 模式抄自实测可用的 @dsh-external/dsh-agent-browser（同一条 sidebar.right.pane.tab 座位）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-org-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var createElement = react.createElement

    var TAB_ID = '@dsh-external/dsh-org-panel'
    var TAB_KIND = 'org-office'
    // ★★ 2026-09-18（B163 修）：**切会话时面板要跟着切**。
    //   症状（委托方亲自报）：侧边栏切到另一个会话 ⇒ 面板【还停在上一个公司】。
    //   根因（取证结论，两条读数）：
    //     ① `src` 原先是**恒定字符串**（不含会话）⇒ 切会话时 iframe 不重载 ⇒ 画面不动；
    //     ② 而 iframe 里 `bridge.js:104-125` 的 `readCurrentSession()` 有**四级回退**，
    //        四级全部依赖"宿主 URL 里带 `?session=`"——**而 DSH 是 SPA，切会话时 URL 不变**
    //        ⇒ 四级全落空 ⇒ 它退到"公司列表第一个"⇒ 面板停住。
    //   修法（甲-1）：把**当前会话 id** 放进 iframe 的 `src` 查询串 ⇒ 切会话 ⇒ `src` 变 ⇒ 重载。
    //   ⚠️ 用什么参数：**`?company=` 而不是 `?session=`** —— 依据是实测：
    //     · `?company=<rootId>` ⇒ 正常（total=23）
    //     · `?session=<rootId>` ⇒ **空**（快路零 IO，无法做 session→company 解析，见 `lib/index.js:910-918`）
    //     · 而 DSH 的 **sessionId 恰好就是 company.id**（`session-fa986645-…`）
    //   代价（已由 CEO 裁定接受）：重载 ⇒ 办公室地图会闪一下；**闪远好于不切**。
    var OFFICE_URL = '/@dsh-external/dsh-org-panel/office/index.html'

    // 拿"当前会话 id"：**只从可靠来源取**，取不到就退回原行为（不带参数 ⇒ 与修前一致，不倒退）。
    //   ★ 来源①：`ctx.sidebarRight` 若暴露了当前绑定/会话（不同 DSH 版本可能不同 ⇒ 一律做 typeof 检查）
    //   ★ 来源②：宿主 URL 的 `?session=`（DSH 会话入口形态 `/?session=<id>`）
    //   ⚠️ 两条都拿不到 ⇒ **返回 ''** ⇒ 行为与修前完全一致（**不猜、不编**）。
    function currentSessionId(ctx) {
      try {
        var b = ctx && ctx.sidebarRight && (ctx.sidebarRight.binding || ctx.sidebarRight.current)
        if (b) {
          var v = b.sessionId || b.key || (b.session && b.session.id)
          if (typeof v === 'string' && v) return v
        }
      } catch (e) { obs.sessionFrom = 'sidebarRight:' + (e && e.message) }
      try {
        var m = String(window.location.search || '').match(/[?&]session=([^&#]+)/)
        if (m) { obs.sessionFrom = 'location'; return decodeURIComponent(m[1]) }
      } catch (e2) { obs.sessionFrom = 'location:' + (e2 && e2.message) }
      obs.sessionFrom = 'none'
      return ''
    }

    function OfficePane(props) {
      // ★ 会话 id 变了 ⇒ 这个字符串变 ⇒ React 换 iframe ⇒ 重载到新公司
      var sid = ''
      try { if (props && typeof props.__orgPanelSessionId === 'string') sid = props.__orgPanelSessionId } catch (e) {}
      var src = sid ? OFFICE_URL + '?company=' + encodeURIComponent(sid) : OFFICE_URL
      return createElement('iframe', {
        src: src,
        title: '办公室',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '360px',
          border: '0',
          display: 'block',
          background: '#0d0b09',
        },
      })
    }

    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

    // 可观测面：判据脚本在真实 GUI 里读它，证明 client 半真的装载并登记了座位
    var obs = { applied: false, type: false, body: false, opened: false, error: '', openError: '', at: 0 }
    window.__orgPanelClient = obs

    exports.apply = function apply(ctx) {
      obs.applied = true
      obs.at = Date.now()
      obs.hasTabs = typeof ctx.sidebarRightTabs?.register === 'function'
      obs.hasSlots = typeof ctx.slots?.register === 'function'
      obs.hasNav = typeof ctx.sidebarRight?.openTab === 'function'

      // 手动/程序化打开（判据用同一条路径：这就是 UI 的加号按钮会走的那一步）
      obs.open = function () {
        try {
          ctx.sidebarRight.openTab(TAB_KIND)
          obs.opened = true
          return true
        } catch (e) {
          obs.openError = e && e.message ? e.message : String(e)
          return false
        }
      }

      ctx.effect(() => {
        const d = ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => '办公室',
          guide: [{
            order: 40,
            title: () => '办公室',
            description: () => 'Agent Team 办公室：一个会话一个公司，只显示 teammate',
          }],
        })
        obs.type = true
        return d
      }, 'org-panel:tab-type')

      ctx.effect(() => {
        // ★ B163：body 每渲染一次读一次"当前会话"，把它作为 `key` 与 `src` 的来源。
        //   为什么用 `key`：React 对**不同 key** 的同一组件会**卸载+重建** ⇒ iframe 一定重载
        //   （只改 `src` 属性在某些浏览器里不会可靠地重载 iframe）。
        const body = (props) => {
          const sid = currentSessionId(ctx)
          obs.sessionId = sid
          // ⚠️ 用包装组件的 `key` 强制重建；`sid` 为空时 key 固定 ⇒ 行为与修前一致
          const pane = createElement(OfficePane, Object.assign({}, props, { __orgPanelSessionId: sid }))
          return sid
            ? createElement('div', { key: sid, style: { width: '100%', height: '100%' } }, pane)
            : pane
        }
        const d = (typeof ctx.slots.inject === 'function')
          ? ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, body))
          : ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, body)
        obs.body = true
        return d
      }, 'org-panel:tab-body')

      // 首次装载自动把办公室开出来——"看得见"是这面板存在的唯一理由。
      // openTab 需要一个已挂载的会话面；应用可能停在会话列表，所以带重试。
      // 每次页面装载只尝试一轮；用户手动关掉后不会被反复弹开。
      try {
        if (window.sessionStorage.getItem('orgPanel.autoOpened') !== '1') {
          window.sessionStorage.setItem('orgPanel.autoOpened', '1')
          var tries = 0
          var tryOpen = function () {
            if (obs.opened) return
            tries += 1
            obs.openTries = tries
            var did = obs.open()
            if (!did && tries < 15) window.setTimeout(tryOpen, 2000)
          }
          window.setTimeout(tryOpen, 1500)
        }
      } catch (e) {
        obs.autoOpenError = e && e.message ? e.message : String(e)
      }
    }

    return module.exports
  },
})
