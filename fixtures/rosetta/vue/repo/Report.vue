<script setup lang="ts">
import { total, Circle } from './shapes'

const label = `total ${total([new Circle(2)])}`
</script>

<template>
  <p>{{ label }}</p>
</template>
