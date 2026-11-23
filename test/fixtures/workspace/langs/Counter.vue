<template>
  <button @click="save">{{ label }}</button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const label = ref<string>("Don't");
function save(): void {
  label.value = 'saved';
}
const reset = () => {
  label.value = '';
};
</script>

<style scoped>
button { color: red; }
</style>
