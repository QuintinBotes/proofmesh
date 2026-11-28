<script>
  export let count = 0

  function label() {
    return `${count} items`
  }
</script>

<span class="badge">{label()}</span>
