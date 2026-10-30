<template>
  <navigator class="link" :url="href" :data-title="label" :data-src="href" @click="openURL($event)"><slot /></navigator>
</template>

<script>
export default {
  name: 'UniLink',
  props: {
    href: { type: String, required: true },
    label: { type: String, default: 'uni-link 动态链接' },
  },
  emits: ['click'],
  methods: {
    /** 将链接交互原样通知父组件，供自动链接探针验证。 */
    openURL(event) { this.$emit('click', event) },
  },
}
</script>

<style>
.link { display: block; margin-top: 16rpx; padding: 22rpx; border: 1rpx solid #1677ff; border-radius: 10rpx; color: #1677ff; text-align: center; }
</style>
