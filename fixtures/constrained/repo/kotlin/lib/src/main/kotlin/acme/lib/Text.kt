package acme.lib

fun format(x: String): String = x

internal fun secret(): Int = 1

private fun hidden(): Int = 2

fun shown(): Int = hidden()

open class Order {
    fun total(): Int = count()

    private fun count(): Int = 1

    companion object {
        fun make(): Order = Order()
    }
}
