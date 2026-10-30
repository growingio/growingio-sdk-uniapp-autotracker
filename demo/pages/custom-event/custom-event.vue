<template>
  <scroll-view class="page" scroll-y>
    <view class="section">
      <text class="title">自定义事件 / track</text>
      <text class="hint">事件只有在 dataCollect=true 且 SDK 已就绪时才会进入队列。属性会被 SDK 归一化，非法值不会原样出站。</text>
    </view>
    <view class="section">
      <button data-title="发送商品曝光事件" @click="trackProduct($event)">发送 product_exposure</button>
      <button data-title="发送边界属性事件" @click="trackBoundary($event)">发送含边界属性的事件</button>
      <button class="secondary" data-title="发送非法事件名" @click="trackInvalid($event)">尝试非法事件名</button>
      <button class="secondary" data-title="调用未知命令" @click="unknownCommand($event)">尝试未知命令</button>
    </view>
    <view class="section">
      <text class="section-title">结果</text>
      <text class="result">{{ result }}</text>
      <text class="hint">开发环境请查看 console 的 [GrowingIO Debug] 输出和 mock collector 的摘要；页面不会记录输入原文。</text>
    </view>
  </scroll-view>
</template>

<script>
export default {
  /** 初始化手动事件演示的结果提示。 */
  data() {
    return { result: '尚未操作。' }
  },
  methods: {
    /** 展示 SDK 命令接纳结果；本地接纳不代表采集服务已收到。 */
    showResult(name, ok) {
      this.result = `${name}：${ok ? '已入队' : '未入队（检查采集开关或参数）'}`
    },
    /** 发送包含字符串、数值和布尔属性的标准业务事件。 */
    trackProduct() {
      const ok = gdp('track', 'product_exposure', { sku: 'demo-sku-001', category: 'showcase', price: 99, available: true })
      this.showResult('product_exposure', ok)
    },
    /** 提交混合合法与非法属性，验证属性归一化和剔除边界。 */
    trackBoundary() {
      const ok = gdp('track', 'demo_attribute_boundary', {
        kept: 'yes', labels: ['demo', true, 1], nested: { mustBeDiscarded: true }, nonFinite: Number.NaN,
      })
      this.result = ok
        ? '事件已入队：collector 中应只保留 kept 和 labels，嵌套对象与 NaN 会被剔除。'
        : '未入队：先开启采集开关。'
    },
    /** 提交空事件名，验证整条非法 CUSTOM 被拒绝。 */
    trackInvalid() {
      const ok = gdp('track', '', { ignored: true })
      this.showResult('track(空事件名)', ok)
    },
    /** 调用未知命令，验证防御性入口返回失败。 */
    unknownCommand() { this.showResult('未知 gdp 命令', gdp('not_a_public_command')) },
  },
}
</script>

<style>
.page { height: 100%; padding: 20rpx; box-sizing: border-box; }
.section { margin-bottom: 20rpx; padding: 24rpx; border-radius: 12rpx; background: #fff; }
.title, .section-title, .hint, .result { display: block; }
.title { font-size: 36rpx; font-weight: 600; color: #222; }
.section-title { font-size: 28rpx; font-weight: 600; }
.hint { margin-top: 14rpx; font-size: 24rpx; color: #666; line-height: 1.6; }
.result { color: #1677ff; font-size: 26rpx; line-height: 1.5; }
button { margin-top: 16rpx; background: #1677ff; color: #fff; font-size: 26rpx; }
.secondary { background: #fff; color: #1677ff; border: 1rpx solid #1677ff; }
</style>
