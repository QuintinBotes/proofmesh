class Sampleone {
    public static int one(int value) {
        int doubled = value * 2;
        return doubled > 10 ? doubled + value + 1 : value - doubled;
    }
}
