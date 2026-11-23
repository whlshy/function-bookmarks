<script context="module">
  export function preload() {
    return {};
  }
</script>

<script>
  let count = 0;
  function increment() {
    count += 1;
  }
</script>

{#if count > 0}
  <p>{count}</p>
{/if}
<button on:click={increment}>+</button>
