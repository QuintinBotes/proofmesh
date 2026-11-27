import { Order } from "./order"
import { container } from "./container"
import { Mailer } from "./mailer"

const orders: Order[] = []

/** Serves GET /orders: openapi.yaml names it by its operationId, and no code route does. */
export function listOrders(): Order[] {
    return orders
}

export function placeOrder(order: Order): void {
    orders.push(order)
    const mailer = container.resolve<Mailer>("Mailer")
    mailer.send(order.customerName, "Order placed")
    console.log("Mailer")
}
