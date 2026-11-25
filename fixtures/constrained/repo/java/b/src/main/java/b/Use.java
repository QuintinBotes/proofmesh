package b;

import a.Util;

public class Use extends Util {
    String run(String x) {
        new Order();
        return Util.format(x);
    }

    void other(Object x) {
        x.p();
        x.q();
        x.shown();
        x.format("y");
    }

    String viaLocal() {
        b.Util Util = null;
        return Util.format("x");
    }
}
