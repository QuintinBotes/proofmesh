# Provenance

Project-authored for Proofmesh (#252). Apache-2.0. No third-party code. A Svelte shop: `cart.ts` holds the `useCart` store helper; `Button.svelte` (`<script lang="ts">`) calls it; `App.svelte` renders `Button` and `Badge`, reads the `$items` store, and uses `<Missing />`, which no script imports; `Badge.svelte` is plain JavaScript; `Broken.svelte` has a script that does not parse; `App.test.ts` renders `App`. Neither `svelte` nor `@testing-library/svelte` is installed: no framework compiler is needed. The expected facts in `expected.json` are written by hand.
