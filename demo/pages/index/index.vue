<template>
  <scroll-view class="page" scroll-y>
    <view class="header">
      <text class="title">GrowingIO uni-app SDK</text>
      <text class="subtitle">传统 uni-app Vue 3 feature showcase</text>
    </view>
    <view class="section">
      <text class="section-title">开始前</text>
      <text class="hint">默认已开启 dataCollect：App:onShow 会创建 VISIT，并在 uploader 真正发送前输出 Debug JSON。需要等待隐私同意时，可在 sdk-state.ts 将 enabled 设为 false 并通过「采集开关」页开启。</text>
    </view>
    <view class="section">
      <text class="section-title">功能演示</text>
      <view v-for="item in items" :key="item.path" class="card" :data-title="item.title" :data-src="item.path" @click="go(item)">
        <text class="card-title">{{ item.title }}</text>
        <text class="card-desc">{{ item.description }}</text>
      </view>
    </view>
    <view class="section">
      <text class="section-title">当前能力边界</text>
      <text class="hint">已支持：生命周期、PAGE 上下文、自定义事件、用户身份与属性、dataCollect 开关，以及 Vue 3 原生组件无埋点。</text>
      <text class="hint">当前未实现：gioABTest、微信分享、.nvue 与 Vue 2 / Webpack 无埋点。SDK 不会伪造这些能力的成功结果。</text>
    </view>
    <view class="section">
      <text class="section-title">快捷动作</text>
      <button data-title="发送首页自定义事件" @click="trackQuick($event)">发送 home_quick_track</button>
      <button class="secondary" data-title="带参数前往路由页" @click="goRoute($event)">前往路由页（带参数）</button>
      <text class="hint">{{ note }}</text>
    </view>
  </scroll-view>
</template>

<script>
export default {
  /** 创建演示入口列表及首页状态提示。 */
  data() {
    return {
      note: '建议同时打开控制台和 mock collector 观察事件。',
      items: [
        { path: 'custom-event', title: '① 自定义事件 / track', description: '发送业务事件和用户属性，观察属性归一化。' },
        { path: 'user', title: '② 用户身份 / setUserId', description: '退出后登录同一 / 不同账号，核对会话；验证非法编码不改变身份。' },
        { path: 'lifecycle', title: '③ 生命周期 / VISIT / PAGE / APP_CLOSED', description: '切页、前后台、断网恢复与 DPR 屏幕物理尺寸核对。' },
        { path: 'autotrack', title: '④ 无埋点 / VIEW_CLICK / VIEW_CHANGE', description: '六组实机用例：动态隐私、完成事件、冒泡去重、列表更新、文案映射和预期不采集边界。' },
        { path: 'route', title: '⑤ 路由 / query / referralPage', description: '带 query 跳转，验证 PAGE 上下文。' },
        { path: 'datacollect', title: '⑥ 数据采集开关 / setOptions', description: '同页暂停再恢复，核对新 PAGE 时间与后续事件页面时间一致。' },
      ],
    }
  },
  methods: {
    /** 按页面类型选择 tab 切换或普通导航。 */
    go(item) {
      const url = `/pages/${item.path}/${item.path}`
      if (['custom-event', 'user', 'autotrack'].includes(item.path)) uni.switchTab({ url })
      else uni.navigateTo({ url })
    },
    /** 携带 query 打开路由对照页。 */
    goRoute() {
      uni.navigateTo({ url: `/pages/route/route?from=index&tick=${Date.now()}&source=quick` })
    },
    /** 发送首页快速事件并展示是否已被 SDK 接纳。 */
    trackQuick() {
      const queued = gdp('track', 'home_quick_track', { from: 'index', tick: Date.now() })
      this.note = queued ? '已入队 home_quick_track。' : '未入队：请先在采集开关页开启 dataCollect，并等待 SDK 就绪。'
    },
  },
}
</script>

<style>
.page { height: 100%; padding: 20rpx; box-sizing: border-box; }
.header { padding: 40rpx 20rpx; }
.title, .subtitle, .section-title, .hint, .card-title, .card-desc { display: block; }
.title { font-size: 40rpx; font-weight: 600; text-align: center; }
.subtitle { margin-top: 10rpx; font-size: 24rpx; color: #888; text-align: center; }
.section { margin-top: 20rpx; padding: 24rpx; border-radius: 12rpx; background: #fff; }
.section-title { margin-bottom: 18rpx; font-size: 28rpx; font-weight: 600; color: #333; }
.hint { font-size: 24rpx; color: #666; line-height: 1.6; }
.card { margin-top: 16rpx; padding: 24rpx; border: 1rpx solid #eee; border-radius: 10rpx; }
.card-title { font-size: 28rpx; color: #1677ff; }
.card-desc { margin-top: 8rpx; font-size: 24rpx; color: #666; line-height: 1.5; }
button { margin-top: 16rpx; background: #1677ff; color: #fff; font-size: 26rpx; }
.secondary { background: #fff; color: #1677ff; border: 1rpx solid #1677ff; }
</style>
