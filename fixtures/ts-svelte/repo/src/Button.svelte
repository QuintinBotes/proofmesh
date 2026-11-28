<script lang="ts">
  import { useCart } from './cart'

  const cart = useCart()

  function press() {
    cart.add('apple')
  }
</script>

<button class="button" on:click={press}>Add</button>

<style>
  .button { color: red; }
</style>
