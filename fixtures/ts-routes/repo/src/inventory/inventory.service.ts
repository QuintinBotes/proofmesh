export class InventoryService {
  level(sku: string) {
    return { sku, level: 0 }
  }

  receive() {
    return { received: true }
  }
}
