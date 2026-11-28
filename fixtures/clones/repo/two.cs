class Sampletwo {
    public static int two(int value) {
        int doubled = value * 2;
        return doubled > 10 ? doubled + value + 1 : value - doubled;
    }
}
