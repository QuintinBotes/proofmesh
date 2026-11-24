export function listOrders() {
  return []
}

export function getOrder(id: string) {
  return { id }
}

export function placeOrder(body: unknown) {
  return { body }
}

export function cancelOrder(id: string) {
  return { id, cancelled: true }
}
