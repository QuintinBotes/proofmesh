import { CardPayment, Order } from './entities'

export function placeOrder(): Order {
  return new Order()
}

export function chargeCard(): CardPayment {
  return new CardPayment()
}
