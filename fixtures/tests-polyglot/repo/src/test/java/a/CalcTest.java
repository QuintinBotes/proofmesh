package a;

import org.junit.jupiter.api.Test;

class CalcTest {
    @Test
    void adds() {
        new Calc().add(1, 2);
    }

    int make() {
        return new Calc().add(0, 0);
    }
}
