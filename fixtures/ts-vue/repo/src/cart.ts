import { ref } from 'vue'

export function useCart() {
  const items = ref<string[]>([])
  function add(item: string) {
    items.value.push(item)
  }
  return { items, add }
}
