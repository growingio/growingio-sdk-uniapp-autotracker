<template>
  <scroll-view class="page" scroll-y>
    <view class="section">
      <text class="title">预期不采集的写法</text>
      <text class="hint">本页展示当前不支持自动采集的写法，均明确标记 ignore，构建不产生采集告警。以下操作只更新业务计数，不产生 VIEW_CLICK / VIEW_CHANGE。</text>
      <text class="result">业务执行次数：{{ count }}；{{ lastAction }}</text>
    </view>
    <view class="section">
      <button id="boundary-reference" data-growing-ignore @tap="onReference">直接函数引用</button>
      <text class="hint">保留 Vue 的引用行为，不强制改成调用。</text>
      <button id="boundary-computed" data-growing-ignore @tap="handlers[handlerKey]($event)">计算成员调用</button>
      <text class="hint">无法固定业务函数名，保留原表达式。</text>
      <view id="boundary-stop-parent" data-growing-ignore @tap="onParent">
        <button id="boundary-stop" data-growing-ignore @tap.stop="onStopped($event)">带 .stop 的按钮</button>
      </view>
      <text class="hint">保留 .stop；子按钮业务执行，父层不执行。父层也使用函数引用，不生成自动事件。</text>
      <button id="boundary-dynamic" data-growing-ignore v-on:[nativeEventName]="onDynamic($event)">动态事件名</button>
      <text class="hint">动态事件仍交给 Vue 绑定。</text>
      <auto-track-boundary-emit data-growing-ignore @click="onCustomClick($event)" />
      <text class="hint">自定义组件 emit 不插桩；内部按钮明确 ignore，父层业务计数每次增加 1。</text>
      <input id="boundary-input" data-growing-ignore placeholder="仅填演示值，观察 input 业务" @input="onTyping($event)" />
      <text class="hint">input 打字事件不属于当前完成事件白名单，业务仍可处理。</text>
    </view>
    <view class="section">
      <button id="boundary-back" data-growing-ignore @tap="back($event)">返回无埋点验收页</button>
      <text class="hint">.nvue、render / JSX、动态组件及 web-view 内 H5 不属于此传统 Vue 模板采集范围。对应编译边界由独立测试覆盖，不能据本页业务计数判断这些能力已开放。</text>
    </view>
  </scroll-view>
</template>

<script>
import AutoTrackBoundaryEmit from '@/components/auto-track-boundary-emit/auto-track-boundary-emit.vue'

export default {
  components: { AutoTrackBoundaryEmit },
  /** 初始化边界演示状态，不保存实际输入内容。 */
  data() { return { count: 0, lastAction: '尚未操作。', nativeEventName: 'click', handlerKey: 'save' } },
  computed: {
    /** 提供计算成员访问的业务函数，验证不安全表达式保持原样。 */
    handlers() { return { save: this.onComputed } }
  },
  methods: {
    /** 更新页面业务计数和最近动作，用于确认监听器确实执行。 */
    mark(name) { this.count++; this.lastAction = name },
    /** 记录函数引用监听的业务执行结果，采集侧保持既有边界。 */
    onReference() { this.mark('函数引用业务已执行') },
    /** 记录计算成员监听的业务执行结果。 */
    onComputed() { this.mark('计算成员业务已执行') },
    /** 记录带停止冒泡修饰符的子层业务调用。 */
    onStopped() { this.mark('.stop 子按钮业务已执行') },
    /** 记录父层业务调用，用于核对停止冒泡是否仍生效。 */
    onParent() { this.mark('父层业务已执行；点击子按钮不应走到这里') },
    /** 记录动态事件名监听的业务执行结果。 */
    onDynamic() { this.mark('动态事件业务已执行') },
    /** 记录自定义组件 emit 到达父层的业务结果。 */
    onCustomClick() { this.mark('自定义组件 emit 业务已执行') },
    /** 只记录输入交互发生，不读取或展示输入原文。 */
    onTyping() { this.mark('input 业务已执行，不记录输入原文') },
    /** 返回上一页面，结束边界演示。 */
    back() { uni.navigateBack() },
  },
}
</script>

<style>
.page { height: 100%; padding: 20rpx; box-sizing: border-box; }
.section { margin-bottom: 20rpx; padding: 24rpx; border-radius: 12rpx; background: #fff; }
.title, .hint, .result { display: block; }
.title { font-size: 32rpx; font-weight: 600; color: #222; }
.hint { margin-top: 12rpx; font-size: 24rpx; color: #666; line-height: 1.6; }
.result { margin-top: 18rpx; font-size: 26rpx; color: #1677ff; }
button { margin-top: 16rpx; background: #1677ff; color: #fff; font-size: 26rpx; }
input { margin-top: 16rpx; padding: 16rpx; border: 1rpx solid #ddd; border-radius: 8rpx; }
</style>
