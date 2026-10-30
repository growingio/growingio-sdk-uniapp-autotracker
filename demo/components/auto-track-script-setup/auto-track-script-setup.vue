<template>
  <view class="syntax-card">
    <text class="syntax-title">&lt;script setup&gt;</text>
    <button id="script-setup-action" data-title="script setup 按钮" @tap="submit($event)">执行 script setup handler</button>
    <text class="syntax-result">业务执行次数：{{ count }}</text>
    <text class="expected">预期：script-setup-action#submit，每次点击只增加 1</text>
  </view>
</template>

<script setup>
import { ref } from 'vue'

const count = ref(0)
/** 累加业务点击次数，验证脚本 setup 形式的监听器能够正常执行。 */
function submit() { count.value += 1 }
</script>

<style>
.syntax-card { margin-top: 18rpx; padding: 18rpx; border: 1rpx solid #d9d9d9; border-radius: 10rpx; }
.syntax-title, .syntax-result, .expected { display: block; }
.syntax-title { font-size: 25rpx; font-weight: 600; }
.syntax-result { margin-top: 10rpx; font-size: 24rpx; color: #1677ff; }
.expected { margin-top: 8rpx; font-size: 22rpx; color: #777; line-height: 1.5; }
button { margin-top: 12rpx; background: #1677ff; color: #fff; font-size: 26rpx; }
</style>
