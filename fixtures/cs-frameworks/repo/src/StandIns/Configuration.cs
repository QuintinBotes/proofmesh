// Minimal stand-ins for Microsoft.Extensions.Configuration, so the fixture needs no package.
namespace Microsoft.Extensions.Configuration
{
    public interface IConfiguration
    {
        string? this[string key] { get; set; }
        IConfigurationSection GetSection(string key);
    }

    public interface IConfigurationSection : IConfiguration
    {
        string? Value { get; set; }
    }

    public static class ConfigurationExtensions
    {
        public static string? GetConnectionString(this IConfiguration configuration, string name) => null;
    }

    public static class ConfigurationBinder
    {
        public static T? GetValue<T>(this IConfiguration configuration, string key) => default;
    }
}
