import { writable } from 'svelte/store'

export const items = writable<string[]>([])

export function useCart() {
  function add(item: string) {
    items.update((all) => [...all, item])
  }
  return { items, add }
}
