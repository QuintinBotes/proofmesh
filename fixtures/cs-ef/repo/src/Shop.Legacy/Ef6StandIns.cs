// Minimal stand-ins for the EF6 types the rules match, so the fixture needs no package.
namespace System.Data.Entity
{
    public class DbContext { }

    public class DbSet<TEntity> where TEntity : class { }

    public class DbModelBuilder
    {
        public ModelConfiguration.Configuration.ConventionsConfiguration Conventions { get; } = new();

        public ModelConfiguration.Configuration.TypeConventionConfiguration Types() => new();
    }
}

namespace System.Data.Entity.ModelConfiguration
{
    public class EntityTypeConfiguration<TEntity> where TEntity : class
    {
        public EntityTypeConfiguration<TEntity> ToTable(string tableName, string schemaName) => this;
    }
}

namespace System.Data.Entity.ModelConfiguration.Configuration
{
    public class ConventionsConfiguration
    {
        public void Remove<TConvention>() { }
    }

    public class TypeConventionConfiguration
    {
        public void Configure(System.Action<ConventionTypeConfiguration> configure) { }
    }

    public class ConventionTypeConfiguration
    {
        public System.Type ClrType => typeof(object);
        public ConventionTypeConfiguration ToTable(string tableName) => this;
        public ConventionTypeConfiguration ToTable(string tableName, string schemaName) => this;
        public ConventionTypeConfiguration Ignore(string propertyName) => this;
    }
}

namespace System.Data.Entity.ModelConfiguration.Conventions
{
    public class PluralizingTableNameConvention { }
}
