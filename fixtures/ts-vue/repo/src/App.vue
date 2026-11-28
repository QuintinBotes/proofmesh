<script lang="ts">
export const title = 'Shop'
</script>

<script setup lang="ts">
import Button from './Button.vue'
import Badge from './Badge.vue'

let added = 0

function add() {
  added += 1
}
</script>

<template>
  <main>
    <h1>{{ title }}</h1>
    <Button @click="add" />
    <Badge :count="added" />
    <router-view />
  </main>
</template>
