package acme.app

import acme.lib.Order

fun helper() {}

class Rush : Order() {
    fun go() {
        paint()
        this.paint()
        total()
    }

    fun paint() {}
}
