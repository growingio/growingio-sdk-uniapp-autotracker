<template>
  <scroll-view class="page" scroll-y>
    <view class="section">
      <text class="title">生命周期 / VISIT / PAGE / APP_CLOSED</text>
      <text class="hint">SDK 在 main.ts 初始化时安装全局 lifecycle mixin，自动转发 onLaunch/onShow/onHide 与页面 onLoad/onShow/onHide/onUnload。切换页面可验证 PAGE，应用退后台可验证 APP_CLOSED。</text>
    </view>
    <view class="section">
      <button data-title="发送生命周期示例事件" @click="trackAction($event)">发送 lifecycle_demo_action</button>
      <button class="secondary" data-title="前往路由演示页" @click="goRoute($event)">带参前往路由页</button>
      <button class="secondary" data-title="初始化后重复注册插件" @click="registerAfterInit($event)">验证初始化后重复注册插件</button>
      <text class="result">{{ result }}</text>
    </view>
    <view class="section">
      <text class="title">断网缓存 / 联网自动补发</text>
      <text class="hint">1. 关闭 Wi-Fi 和移动数据，在本页发送离线标记；也可断网冷启动后再发送。若连的是局域网 collector，请恢复同一 Wi-Fi。</text>
      <button id="network-offline" data-growing-ignore @click="offlineScenario($event)">发送离线标记</button>
      <text class="hint">2. 恢复网络后停留本页等待，无需再点击或重启，先确认离线标记自动补发。也可到系统设置恢复网络后再回 App。前台断网且有待发缓存时每 2 秒检查网络。</text>
      <button id="network-recovered" data-growing-ignore :disabled="!networkRunId" @click="recoveredScenario($event)">发送恢复对照标记（可选）</button>
      <text class="hint">预期：未按恢复按钮前，collector 已接收到 phase=offline 的 review_network_step。可选发送 phase=recovered，用同一 runId 对照。离线时返回 true 只表示入队；首次异步网络查询完成前 networkState 可能是 UNKNOWN。</text>
      <text class="result">{{ networkResult }}</text>
    </view>
    <view class="section">
      <text class="title">屏幕物理像素（本次修复）</text>
      <button id="screen-context" data-growing-ignore @click="screenScenario($event)">读取屏幕信息并发送核对事件</button>
      <text class="hint">将宿主逻辑尺寸乘以有效 DPR，四舍五入后按短边 / 长边排序。对照 review_screen_context 的 screenWidth / screenHeight；Android 的 PHONE / PAD 判定仍以逻辑短边 600 为界。请保持屏幕状态与启动时一致，折叠或改变显示配置后重新启动再核对。</text>
      <text class="result">{{ screenResult }}</text>
    </view>
    <view class="section"><text class="hint">APP_CLOSED 只能在真实 App 切到后台时触发；浏览器或静态检查不能替代这项验证。</text></view>
  </scroll-view>
</template>

<script>
export default {
  /** 初始化前后台、网络恢复和屏幕上下文验证状态。 */
  data() { return { result: '尚未操作。', networkRunId: '', networkRunCount: 0, networkResult: '尚未发送网络标记。', screenResult: '尚未读取屏幕信息。' } },
  methods: {
    /** 发送当前页面的生命周期对照业务事件。 */
    trackAction() { this.result = gdp('track', 'lifecycle_demo_action', { page: 'lifecycle' }) ? '事件已入队。' : '未入队：先开启采集开关。' },
    /** 携带时间标记导航，供 PAGE 来源与 query 核对。 */
    goRoute() { uni.navigateTo({ url: `/pages/route/route?from=lifecycle&tick=${Date.now()}` }) },
    /** 验证成功初始化后不再接受插件注册。 */
    registerAfterInit() { this.result = gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }]) ? '异常：初始化后仍允许注册插件。' : '已正确拒绝：插件只能在首次 init 前注册。' },
    /** 记录离线阶段的关联标记，不将入队结果当作联网或上传成功。 */
    offlineScenario() {
      if (this.networkRunId) { this.networkResult = '已有离线标记，请恢复网络并完成第 2 步后再开始。'; return false }
      const runId = `network-${Date.now()}-${++this.networkRunCount}`
      if (!gdp('track', 'review_network_step', { runId, phase: 'offline' })) { this.networkResult = '离线标记未入队：请开启采集并等待 SDK 就绪。'; return false }
      this.networkRunId = runId
      this.networkResult = `${runId}：离线标记已入队。恢复网络后无需点击即可自动补发；可选发送恢复标记做对照。`
      return true
    },
    /** 发送同组恢复标记，供在请求与采集服务中核对离线补发。 */
    recoveredScenario() {
      if (!this.networkRunId) { this.networkResult = '请先发送离线标记。'; return false }
      const runId = this.networkRunId
      if (!gdp('track', 'review_network_step', { runId, phase: 'recovered' })) { this.networkResult = '恢复标记未入队，可开启采集后重试。'; return false }
      this.networkRunId = ''
      this.networkResult = `${runId}：恢复标记已入队。请在 Debug JSON / 请求中对照两条标记，并在 collector 确认接收成功；当前界面未确认网络或发送结果。`
      return true
    },
    /** 独立读取逻辑尺寸和 DPR，计算预期物理像素并发送对照事件。 */
    screenScenario() {
      /** 安全读取宿主记录，缺失或异常时返回空对象。 */
      const read = (get) => { try { const value = get(); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} } }
      const device = read(() => uni.getDeviceInfo())
      const system = read(() => uni.getSystemInfoSync())
      /** 只接受有效正整数尺寸，避免展示错误的物理像素期望。 */
      const dimension = (value) => Number.isInteger(value) && value > 0 ? value : null
      /** 只接受有限正数像素比。 */
      const ratioValue = (value) => Number.isFinite(value) && value > 0 ? value : null
      const width = dimension(device.screenWidth) ?? dimension(system.screenWidth)
      const height = dimension(device.screenHeight) ?? dimension(system.screenHeight)
      const ratio = ratioValue(device.devicePixelRatio) ?? ratioValue(system.devicePixelRatio) ?? ratioValue(system.pixelRatio)
      if (width === null || height === null || ratio === null) {
        this.screenResult = '宿主未提供完整有效的逻辑尺寸 / DPR，无法独立核对物理像素。'
        return false
      }
      const shortEdge = Math.round(Math.min(width, height) * ratio)
      const longEdge = Math.round(Math.max(width, height) * ratio)
      if (!Number.isFinite(shortEdge) || !Number.isFinite(longEdge) || shortEdge < 1) { this.screenResult = '宿主屏幕数据无法换算成有效物理尺寸。'; return false }
      const queued = gdp('track', 'review_screen_context', { logicalWidth: width, logicalHeight: height, devicePixelRatio: ratio, expectedWidth: shortEdge, expectedHeight: longEdge })
      this.screenResult = `宿主逻辑尺寸 ${width} × ${height}，DPR=${ratio}；预期物理短边 / 长边 ${shortEdge} × ${longEdge}。${queued ? '核对事件已入队，请比对事件字段。' : '核对事件未入队，请先开启采集。'}`
      return queued
    },
  },
}
</script>

<style>
.page { height:100%;padding:20rpx;box-sizing:border-box; }.section { margin-bottom:20rpx;padding:24rpx;border-radius:12rpx;background:#fff; }.title,.hint,.result { display:block; }.title { font-size:34rpx;font-weight:600;color:#222; }.hint { margin-top:14rpx;font-size:24rpx;color:#666;line-height:1.6; }.result { margin-top:18rpx;color:#1677ff;font-size:26rpx; } button { margin-top:16rpx;background:#1677ff;color:#fff;font-size:26rpx; }.secondary { background:#fff;color:#1677ff;border:1rpx solid #1677ff; }
</style>
