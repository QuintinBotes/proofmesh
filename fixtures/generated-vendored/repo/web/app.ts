import { fetchUsers } from '../docs/gen/client'

export function load(): string {
  return fetchUsers()
}
