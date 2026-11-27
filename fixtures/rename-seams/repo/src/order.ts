export interface Order {
    id: string
    customerName: string
    total: number
}

/** The order as the API sends it: the keys are the wire format. */
export function toWire(order: Order): string {
    return JSON.stringify({ "id": order.id, "customerName": order.customerName, "total": order.total })
}

/** An order read back from the wire. */
export function fromWire(text: string): Order {
    const payload = JSON.parse(text)
    return { id: payload["id"], customerName: payload["customerName"], total: Number(payload["total"]) }
}
