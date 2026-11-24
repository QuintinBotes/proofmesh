namespace Ops;

public abstract class BackgroundTask
{
    public abstract void Execute();
}

public abstract class BackgroundTask<TData> : BackgroundTask
{
    public TData Data { get; set; } = default!;
}

[TendedBy(Crew.Billing)]
public sealed class InvoiceExportJob : BackgroundTask<int>
{
    private readonly Flags flags = new();

    public override void Execute()
    {
        if (flags.IsEnabled(ToggleNames.LegacyExport)) Log.Write("legacy", crew: Crew.Billing);
        if (flags.IsEnabled(ToggleNames.FastSearch)) Log.Write("fast");
    }
}

public sealed class ReindexJob : BackgroundTask
{
    public override void Execute() => Log.Write($"batch {ToggleNames.BatchSize.Key}", Crew.Search);
}

public abstract class DraftJob : BackgroundTask { }
