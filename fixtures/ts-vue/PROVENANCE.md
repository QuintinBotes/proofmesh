# Provenance

Project-authored for Proofmesh (#252). Apache-2.0. No third-party code. A Vue 3 shop: `cart.ts` holds the `useCart` composable; `Button.vue` (`<script setup lang="ts">`) calls it; `App.vue` (a `<script>` and a `<script setup>`) renders `Button` and `Badge` and uses `<router-view>`, which no script imports; `Badge.vue` uses the Options API; `Legacy.vue` is in CoffeeScript, which the adapter does not read; `App.test.ts` mounts `App`. Neither `vue` nor `@vue/test-utils` is installed: no framework compiler is needed. The expected facts in `expected.json` are written by hand.
