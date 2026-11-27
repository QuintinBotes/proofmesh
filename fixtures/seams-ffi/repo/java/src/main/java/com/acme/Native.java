package com.acme;

public class Native {
    static {
        System.loadLibrary("calc");
    }

    public static native int add(int a, int b);
}
