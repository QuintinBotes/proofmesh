class Samplealmost {
    public static int almost(int value) {
        int doubled = value * 2;
        return doubled > 10 ? doubled + value + 2 : value - doubled;
    }
}
