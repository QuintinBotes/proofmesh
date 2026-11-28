<script lang="ts">
  import Button from './Button.svelte'
  import Badge from './Badge.svelte'
  import { items } from './cart'

  let added = 0

  function add() {
    added += 1
  }
</script>

<main>
  {#if $items.length > 0}
    <Badge count={$items.length + added} />
  {/if}
  <Button on:click={add} />
  <Missing />
</main>
