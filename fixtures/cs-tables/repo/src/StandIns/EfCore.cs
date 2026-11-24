// Minimal stand-ins for the EF Core types the rules match, so the fixture needs no package.
namespace Microsoft.EntityFrameworkCore;

public class DbContext { }

public class DbSet<TEntity> where TEntity : class { }

public class ModelBuilder
{
    public EntityTypeBuilder<TEntity> Entity<TEntity>() where TEntity : class => new();
}

public class EntityTypeBuilder<TEntity> where TEntity : class
{
    public EntityTypeBuilder<TEntity> ToTable(string name) => this;
    public EntityTypeBuilder<TEntity> ToTable(string name, string schema) => this;
}
