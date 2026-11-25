using System.Text.Json.Serialization;

namespace Proofmesh.Adapter.CSharp;

/// <summary>Adapter protocol 0.2 shapes. Ranges are UTF-8 byte offsets with 1-based lines.</summary>
public sealed record FactRange(int StartByte, int EndByte, int StartLine, int EndLine);

public sealed record FactSymbol(string LocalId, string Path, string Kind, string Name, string QualifiedName, FactRange Range,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Signature, string[]? Roles = null);

/// <summary>Exactly one of Symbol, File, or External is set.</summary>
public sealed record FactRef(string? Symbol = null, string? File = null, FactExternal? External = null)
{
    public static FactRef Sym(string id) => new(Symbol: id);
    public static FactRef OfFile(string path) => new(File: path);
    public static FactRef Ext(string module, string name) => new(External: new FactExternal(module, name));
}

public sealed record FactExternal(string Module, string Name);
public sealed record FactSite(string Path, FactRange Range);

public sealed record FactRelationship(string Type, string Origin, FactRef Source, FactSite Site, string Resolution,
    FactRef? Target = null, string? Reason = null, IReadOnlyList<string>? Candidates = null, IReadOnlyDictionary<string, string>? Detail = null);

public sealed record FileResult(string Path, string Status, IReadOnlyDictionary<string, string> Capabilities, string? Detail = null);
public sealed record Diagnostic(string Level, string Message, string? Path = null);

public sealed class AnalyzeResult
{
    public List<FactSymbol> Symbols { get; } = [];
    public List<FactRelationship> Relationships { get; } = [];
    public List<FileResult> FileResults { get; } = [];
    public List<Diagnostic> Diagnostics { get; } = [];
}
