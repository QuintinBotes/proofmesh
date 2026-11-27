# Orders

`listOrders()` serves `GET /orders`. A placed order is mailed through the `Mailer` the container resolves.

Another service sends an order as an `OrderDto`, whose `OrderDto.CustomerName` travels under the wire key `CustomerName`.
