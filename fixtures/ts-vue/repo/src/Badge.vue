<script lang="ts">
export default {
  props: { count: Number },
  methods: {
    label(): string {
      return `${this.count} items`
    },
  },
}
</script>

<template>
  <span class="badge">{{ label() }}</span>
</template>
