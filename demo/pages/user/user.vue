<template>
  <scroll-view class="page" scroll-y>
    <view class="section">
      <text class="title">用户身份 / setUserId</text>
      <text class="hint">idMapping 以 main.ts 首次初始化配置为准：true 时保存并上报 userKey，false 时忽略 userKey。修改后需停止运行并重新启动；重复 init 和 setOptions 不会切换此配置。</text>
      <text class="hint">设置成功后用 review_identity_set 核对新身份。按钮的 VIEW_CLICK 发生在设置前，使用此前身份；已生成的事件不会随身份更新而改变。</text>
    </view>
    <view class="section">
      <text class="label">用户 ID</text>
      <input v-model="userId" data-growing-track data-title="用户 ID" placeholder="例如 demo-user-001" @blur="onInputBlur($event)" />
      <text class="label">用户 Key（可选）</text>
      <input v-model="userKey" data-growing-track data-title="用户 Key" placeholder="例如 email" @blur="onInputBlur($event)" />
      <button data-title="设置用户身份" @click="setUser($event)">设置用户身份</button>
      <button class="secondary" data-title="清除用户身份" @click="clearUser($event)">清除用户身份</button>
      <button class="secondary" data-title="设置用户属性" @click="setAttributes($event)">设置示例用户属性</button>
      <button class="secondary" data-title="设置杭州位置" @click="setLocation($event)">设置杭州位置</button>
      <button class="secondary" data-title="清除位置" @click="clearLocation($event)">清除位置</button>
      <button class="secondary" data-title="验证非法身份值" @click="invalidUser($event)">验证非字符串 userId</button>
      <button class="secondary" data-title="验证越界位置" @click="invalidLocation($event)">验证越界位置</button>
    </view>
    <view class="section">
      <text class="title">退出后重新登录（本次修复）</text>
      <text class="hint">使用固定演示账号 A/B。每次会依次发送三条 review_identity_step，按同一 runId 对照 phase、userId 和 sessionId。操作会把当前身份改为演示账号，结束后可点击上方清除身份。</text>
      <button id="identity-same" data-growing-ignore @click="sameUserScenario($event)">A → 退出 → A</button>
      <text class="hint">预期：三条事件的 sessionId 相同；中间一条不携带 userId，最后一条恢复 demo-review-user-a。</text>
      <button id="identity-different" data-growing-ignore @click="differentUserScenario($event)">A → 退出 → B</button>
      <text class="hint">预期：A 与退出事件的 sessionId 相同，B 使用新的 sessionId；身份操作本身不额外发送 PAGE。</text>
      <button id="identity-invalid-utf16" class="secondary" data-growing-ignore @click="invalidEncodingScenario($event)">A → 非法编码身份 → 核对 A</button>
      <text class="hint">预期：非法身份返回 false；review_identity_encoding 仍携带演示账号 A，不清除身份或更换 session。</text>
    </view>
    <view class="section"><text class="result">{{ result }}</text></view>
  </scroll-view>
</template>

<script>
export default {
  /** 初始化身份输入、场景次数和结果提示。 */
  data() {
    return { userId: 'demo-user-001', userKey: 'demo-key', identityRunCount: 0, result: '尚未操作。' }
  },
  methods: {
    /** 保留业务输入完成监听，不主动读取身份输入原文。 */
    onInputBlur() {},
    /** 更新身份后发送核对事件，避免用设置前的自动点击判断新身份。 */
    setUser() {
      const ok = gdp('setUserId', this.userId, this.userKey || null)
      if (!ok) {
        this.result = '身份未更新：参数无效或 SDK 尚未就绪。'
        return false
      }
      const queued = gdp('track', 'review_identity_set')
      this.result = queued ? '身份已更新；review_identity_set 已入队，请在该事件核对 userId/userKey。' : '身份已更新，但核对事件未入队；请开启采集后重试。'
      return queued
    },
    /** 清除登录身份并展示结果。 */
    clearUser() {
      const ok = gdp('clearUserId')
      this.result = ok ? '用户身份已清除。' : '清除失败：SDK 尚未就绪。'
    },
    /** 发送固定用户属性，验证用户属性事件链路。 */
    setAttributes() {
      const ok = gdp('setUserAttributes', { membership: 'demo', source: 'user_page' })
      this.result = ok ? '用户属性事件已入队。' : '未入队：先开启采集开关。'
    },
    /** 设置显式业务位置，供后续事件公共字段核对。 */
    setLocation() { this.result = gdp('setLocation', 30.2741, 120.1551) ? '位置已设置；后续事件会携带经纬度。' : '位置未设置。' },
    /** 清除内存位置，后续事件不再附加原经纬度。 */
    clearLocation() { this.result = gdp('clearLocation') ? '位置已清除；后续事件不再携带经纬度。' : '位置清除失败：SDK 尚未就绪。' },
    /** 提交非字符串用户标识，验证既有合法身份保持不变。 */
    invalidUser() { this.result = gdp('setUserId', 12345) ? '异常：非字符串 userId 被接受。' : '非字符串 userId 已正确拒绝，既有身份不会被清除。' },
    /** 提交越界经纬度，验证非法位置不会覆盖现有状态。 */
    invalidLocation() { this.result = gdp('setLocation', 91, 120) ? '异常：越界位置被接受。' : '越界位置已正确拒绝，既有位置不会变化。' },
    /** 执行同一账号登录、退出、再登录场景，核对会话连续性。 */
    sameUserScenario() { return this.runIdentityScenario('a') },
    /** 执行换账号场景，核对新会话与 VISIT。 */
    differentUserScenario() { return this.runIdentityScenario('b') },
    /** 按顺序执行身份变更并发送关联标记；中途失败时保留已完成操作。 */
    runIdentityScenario(finalUser) {
      const runId = `identity-${Date.now()}-${++this.identityRunCount}`
      const scenario = finalUser === 'a' ? 'same_user' : 'different_user'
      const steps = [
        {
          phase: 'login_a',
          /** 执行当前步骤的登录或退出命令，返回 SDK 是否接纳。 */
          apply: () => gdp('setUserId', 'demo-review-user-a', 'demo-review-key')
        },
        {
          phase: 'logout',
          /** 执行当前步骤的登录或退出命令，返回 SDK 是否接纳。 */
          apply: () => gdp('clearUserId')
        },
        {
          phase: `login_${finalUser}`,
          /** 执行当前步骤的登录或退出命令，返回 SDK 是否接纳。 */
          apply: () => gdp('setUserId', `demo-review-user-${finalUser}`, 'demo-review-key')
        },
      ]
      for (const step of steps) {
        if (!step.apply() || !gdp('track', 'review_identity_step', { runId, scenario, phase: step.phase })) {
          this.result = `场景在 ${step.phase} 停止：身份或事件命令失败；已完成的身份操作不会回滚。请开启采集并等待 SDK 就绪。`
          return false
        }
      }
      this.result = `${runId}：三条标记事件已入队，当前为演示账号 ${finalUser.toUpperCase()}。请在事件 JSON 核对身份和 sessionId；入队不代表 collector 已接收。`
      return true
    },
    /** 提交非法代理项身份，验证拒绝前后合法身份与会话不被破坏。 */
    invalidEncodingScenario() {
      const runId = `encoding-${Date.now()}-${++this.identityRunCount}`
      if (!gdp('setUserId', 'demo-review-user-a', 'demo-review-key') || !gdp('track', 'review_identity_encoding', { runId, phase: 'before' })) {
        this.result = '场景未完成：请开启采集并等待 SDK 就绪；已完成的身份操作不会回滚。'
        return false
      }
      // 未配对的 UTF-16 代理项仅作为非法参数，不写入事件属性或页面日志。
      const accepted = gdp('setUserId', '\ud800')
      const queued = gdp('track', 'review_identity_encoding', { runId, phase: 'after' })
      this.result = accepted ? '异常：非法编码身份被接受。' : queued ? `${runId}：非法身份已拒绝，前后标记已入队；请核对两条事件仍为账号 A 且 sessionId 相同。` : '非法身份已拒绝，但核对事件未入队。'
      return !accepted && queued
    },
  },
}
</script>

<style>
.page { height: 100%; padding: 20rpx; box-sizing: border-box; }.section { margin-bottom: 20rpx; padding: 24rpx; border-radius: 12rpx; background: #fff; }.title,.hint,.label,.result { display:block; }.title { font-size:36rpx;font-weight:600;color:#222; }.hint { margin-top:14rpx;font-size:24rpx;color:#666;line-height:1.6; }.label { margin-top:20rpx;font-size:25rpx;color:#333; } input { margin-top:10rpx;padding:16rpx;border:1rpx solid #ddd;border-radius:8rpx;background:#fff; } button { margin-top:16rpx;background:#1677ff;color:#fff;font-size:26rpx; }.secondary { background:#fff;color:#1677ff;border:1rpx solid #1677ff; }.result { color:#1677ff;font-size:26rpx;line-height:1.5; }
</style>
