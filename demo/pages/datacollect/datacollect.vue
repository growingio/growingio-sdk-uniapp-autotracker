<template>
  <scroll-view class="page" scroll-y>
    <view class="section"><text class="title">数据采集开关 / setOptions</text><text class="hint">demo 默认开启采集。只有 { dataCollect: boolean } 是当前允许在初始化后修改的配置；从关闭变为开启时会重建访问边界并回放当前 PAGE。</text></view>
    <view class="section">
      <text class="state">当前选择：{{ collecting ? '开启采集' : '关闭采集' }}</text>
      <switch :checked="collecting" data-title="采集开关" @change="toggle($event)" />
      <button data-title="发送采集开关测试事件" @click="track($event)">发送 datacollect_test_event</button>
      <button class="secondary" data-title="验证非法 setOptions 参数" @click="invalidOptions($event)">验证非法参数</button>
      <button class="secondary" data-title="验证多字段 setOptions 参数" @click="multipleOptions($event)">验证多字段参数</button>
    </view>
    <view class="section">
      <text class="title">同页暂停与恢复（本次修复）</text>
      <text class="hint">先开启采集，点第 1 步，等待几秒再点第 2 步，期间保持在本页。控制按钮不产生自动点击事件。</text>
      <button id="collection-pause" data-growing-ignore :disabled="!collecting" @click="pauseScenario($event)">1. 发送基准事件并暂停采集</button>
      <button id="collection-resume" data-growing-ignore :disabled="!resumeRunId" @click="resumeScenario($event)">2. 恢复采集并发送核对事件</button>
      <text class="hint">预期：review_collection_blocked 返回 false 且不进入事件流；恢复后生成 VISIT 和当前页 PAGE。新 PAGE.timestamp 为恢复时刻，review_collection_resumed 使用新 sessionId 和当前页 path；两条标记使用同一 runId。</text>
    </view>
    <view class="section">
      <text class="title">关闭采集时业务照常执行</text>
      <button id="collection-view-click" data-title="采集开关下的业务按钮" @click="viewClick($event)">普通业务点击</button>
      <input id="collection-view-input" data-growing-track placeholder="仅填演示值后失焦" @blur="viewInput($event)" />
      <text class="hint">业务次数：点击 {{ viewClickCount }}，输入完成 {{ viewInputCount }}。先暂停，操作两个控件，再恢复后重复操作。关闭期间计数仍增加但没有 VIEW；恢复后的 VIEW 使用新 sessionId 和当前页 path。输入原文不在页面日志中展示。</text>
    </view>
    <view class="section"><text class="result">{{ result }}</text></view>
  </scroll-view>
</template>

<script>
import { dataCollectionState } from '../../sdk-state'
export default {
  /** 初始化暂停恢复场景的关联标识、观察时间和业务计数。 */
  data() { return { result: '尚未操作。', resumeRunId: '', pausedAt: 0, collectionRunCount: 0, viewClickCount: 0, viewInputCount: 0 } },
  computed: {
    /** 读取与初始化配置一致的演示采集开关状态。 */
    collecting() { return dataCollectionState.enabled }
  },
  methods: {
    /** 调用唯一可变配置并在接纳后同步页面状态。 */
    toggle(event) {
      const next = event.detail.value
      const ok = gdp('setOptions', { dataCollect: next })
      if (ok) { dataCollectionState.enabled = next; this.resumeRunId = '' }
      this.result = ok ? `setOptions({ dataCollect: ${next} }) 成功。` : 'setOptions 失败。'
    },
    /** 尝试发送采集开关对照事件，展示本地门控结果。 */
    track() { this.result = gdp('track', 'datacollect_test_event', { collecting: this.collecting }) ? '事件已入队。' : '事件未入队：采集关闭或 SDK 未就绪。' },
    /** 提交非布尔采集开关，验证非法配置被拒绝。 */
    invalidOptions() { this.result = gdp('setOptions', { dataCollect: 'yes' }) ? '异常：非法参数被接受。' : '非法参数已正确拒绝。' },
    /** 提交额外配置字段，验证运行时不接受多项配置变更。 */
    multipleOptions() { this.result = gdp('setOptions', { dataCollect: true, debug: true }) ? '异常：多字段配置被接受。' : '多字段配置已正确拒绝：运行时只允许 dataCollect。' },
    /** 只累计点击业务次数，供采集关闭期间的业务行为对照。 */
    viewClick() { this.viewClickCount++ },
    /** 只累计输入完成次数，不读取输入原文。 */
    viewInput() { this.viewInputCount++ },
    /** 发送暂停前标记并关闭采集，验证关闭期间新事件被拒绝。 */
    pauseScenario() {
      const runId = `collection-${Date.now()}-${++this.collectionRunCount}`
      if (!gdp('track', 'review_collection_before_pause', { runId }) || !gdp('setOptions', { dataCollect: false })) {
        this.result = '暂停场景未完成：请先开启采集并等待 SDK 就绪。'
        return false
      }
      dataCollectionState.enabled = false
      this.resumeRunId = runId
      this.pausedAt = Date.now()
      const blocked = !gdp('track', 'review_collection_blocked', { runId })
      this.result = blocked ? `${runId}：采集已暂停，关闭期间事件返回 false。等待几秒后点第 2 步。` : '异常：采集关闭期间仍接受事件。请继续恢复并检查事件流。'
      return blocked
    },
    /** 恢复采集并发送关联标记，供核对新会话与 PAGE 显示时间。 */
    resumeScenario() {
      if (!this.resumeRunId) { this.result = '请先完成第 1 步。'; return false }
      if (!gdp('setOptions', { dataCollect: true })) { this.result = '恢复失败，采集仍关闭，可重试第 2 步。'; return false }
      dataCollectionState.enabled = true
      const runId = this.resumeRunId
      this.resumeRunId = ''
      const pausedMs = Math.max(0, Date.now() - this.pausedAt)
      const queued = gdp('track', 'review_collection_resumed', { runId, pausedMs })
      this.result = queued ? `${runId}：采集已恢复，暂停 ${pausedMs} ms；核对事件已入队，请对照新 PAGE 的时间戳。` : '采集已恢复，但核对事件未入队。'
      return queued
    },
  },
}
</script>

<style>
.page { height:100%;padding:20rpx;box-sizing:border-box; }.section { margin-bottom:20rpx;padding:24rpx;border-radius:12rpx;background:#fff; }.title,.hint,.state,.result { display:block; }.title { font-size:34rpx;font-weight:600;color:#222; }.hint { margin-top:14rpx;font-size:24rpx;color:#666;line-height:1.6; }.state { margin-bottom:18rpx;font-size:28rpx;color:#1677ff; } .result { color:#1677ff;font-size:26rpx;line-height:1.5; } button { margin-top:16rpx;background:#1677ff;color:#fff;font-size:26rpx; }.secondary { background:#fff;color:#1677ff;border:1rpx solid #1677ff; }
input { width:100%;margin-top:16rpx;padding:16rpx;box-sizing:border-box;border:1rpx solid #ddd;border-radius:8rpx;background:#fff; }
</style>
