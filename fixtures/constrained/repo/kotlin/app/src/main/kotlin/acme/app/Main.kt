package acme.app

import acme.lib.Order
import acme.lib.format as fmt
import acme.lib.*
import acme.other.Thing

fun main() {
    format("x")
    fmt("y")
    helper()
    val o = Order()
    o.total()
    Order.make()
    secret()
    hidden()
    Thing.run()
    listOf(1).forEach { helper() }
}
