import { Store } from './db'

export function handle(id: string): string {
  const store = new Store()
  return store.find(id)
}
