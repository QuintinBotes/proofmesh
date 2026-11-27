using System.Runtime.InteropServices;

public static class Calc
{
    [DllImport("calc")]
    static extern int calc_add(int a, int b);
}
