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
    var OFFICE_URL = '/@dsh-external/dsh-org-panel/office/index.html'

    function OfficePane() {
      return createElement('iframe', {
        src: OFFICE_URL,
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
        const body = (props) => createElement(OfficePane, props)
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
