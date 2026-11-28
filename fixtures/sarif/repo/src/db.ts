export function runQuery(sql: string): string {
  return `ran ${sql}`
}

export class Store {
  find(id: string): string {
    return runQuery(`select * from orders where id = '${id}'`)
  }
}
