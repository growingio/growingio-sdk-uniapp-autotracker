<script>
export default {
  methods: { save(event) { return event } },
}
</script>

<template>
  <button @tap="save($event)">返回</button>
</template>
