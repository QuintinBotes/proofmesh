namespace Ops;

public sealed class Toggle<T>(string key)
{
    public string Key { get; } = key;
}

public static class ToggleNames
{
    public const string LegacyExport = "legacy-export";
    public static Toggle<bool> FastSearch { get; } = new("fast-search");
    public static readonly Toggle<int> BatchSize = new Toggle<int>("batch-size");
}

public sealed class Flags
{
    public bool IsEnabled(string key) => key.Length > 0;
    public bool IsEnabled<T>(Toggle<T> key) => key.Key.Length > 0;
}
