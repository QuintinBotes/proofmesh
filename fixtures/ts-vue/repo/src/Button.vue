<!-- Botón: one line before the script, with a two-byte character, so byte offsets differ from character offsets. -->
<script setup lang="ts">
import { useCart } from './cart'

const cart = useCart()

function press() {
  cart.add('apple')
}
</script>

<template>
  <button class="button" @click="press">Add</button>
</template>
