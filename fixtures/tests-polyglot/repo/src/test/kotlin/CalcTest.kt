import org.junit.Test

class CalcTest {
    @Test
    fun adds() {
        Calc().add(1, 2)
    }

    fun make(): Int = Calc().add(0, 0)
}
