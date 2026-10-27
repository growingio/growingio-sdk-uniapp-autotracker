<script setup lang="ts">
import { ref } from 'vue'
import gdp from 'gio-uniapp-autotracker'
const value = ref('')
const rows = ref([{ id: 1, title: '商品 A' }])
const save = (event: unknown) => { gdp('track', 'fixture_click'); return event }
const complete = (event: { detail: { value: string } }) => { value.value = event.detail.value }
</script>

<template>
  <view>
    <button id="save" @tap="save($event)">保存</button>
    <input v-model="value" data-growing-track @blur="complete($event)" />
    <input password data-growing-track @blur="complete($event)" />
    <picker :range="['A', 'B']" @change="complete($event)"><view>选择</view></picker>
    <view v-for="row in rows" :key="row.id" :data-title="row.title" :data-index="row.id" @tap="save($event)">{{ row.title }}</view>
  </view>
</template>
