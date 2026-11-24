# Languages and what Proofmesh knows about them

This is the capability statement for each ecosystem (FR077). Every file in a snapshot also records its own capabilities, and those are what queries report: a file can fall short of its adapter's statement, for example when a package it imports is not installed.

No adapter runs a project's code, build, or package manager, unless a person grants a repository build evaluation (D14), which only the C# adapter uses.

## TypeScript and JavaScript

The TypeScript compiler's type checker, over every `tsconfig.json` and `jsconfig.json` in the repository, or a default project without one.

- Symbols: functions, classes, methods, interfaces, enums, type aliases, variables and modules, with signatures. Interface members (method signatures, and property signatures holding a function type) and abstract members are `method` symbols named like class members (`<module>:<Interface>.<member>`); an overloaded member is one symbol, which every overload resolves to (FR083).
- Imports: resolved to files in the repository, or to a package; an import of a package that is not installed is unresolved with `dependency_missing`. Each import has a kind: `static`, `type_only` (`import type`, `export type`), `re_export` (`export ... from`) or `dynamic` (`import()` with a literal or no-substitution template specifier); an `import()` with a computed specifier is unresolved with `dynamic_specifier`. A Node.js built-in (`node:fs`, or a bare name such as `path`) is the external module `node:<name>`, with or without `@types/node`, unless a tsconfig `paths` entry maps the name to a repository file, which it then is, as tsc resolves it. An import of a repository file that is not indexed, such as a JSON data file, is unresolved with `not_indexed`; one the snapshot excludes by rule is `import_unresolved`, because the adapter reads only the files the snapshot captures. CommonJS `require()` and `import x = require()` are not recorded as imports.
- Calls: resolved to their declarations, including calls through instances whose type the checker infers. The checker reads installed packages' type declarations from `node_modules`, and each package version is an external input of the snapshot (A2).
- Heritage (FR084, FR085, FR087): a class `implements` each interface its `implements` clause names and `inherits` the class it extends; an interface `inherits` each interface it extends; each is cited at the clause, one row per declaration named. A call through a value typed as an interface or abstract class resolves to that member. A concrete member `implements` or `overrides` each member of its name declared by a class or interface above it, at any distance, so a caller query on it also lists the calls through those members, marked `via`; an abstract member links nothing and is never a dispatch target, and a static member neither links nor is linked, since a call to it names its class. Only declared clauses count: a class that satisfies an interface structurally gets no `implements` and no dispatch rows; a member inherited from a class that does not itself implement the interface is not linked to it; a typed constant's member that names a function instead of defining one (`{ find }`, `{ find: findImpl }`) is not a symbol, so that function is not linked to the interface member; members declared through mapped or intersection types are not symbols, so a call to one stays resolved to the declaration the checker returns, such as the type alias that holds it.
- References (FR086, FR101): a use of a repository class, interface, enum or type alias other than its declaration (type annotations, generics, `implements` and `extends`, `satisfies`, `as`, `typeof`, `new`, and value uses such as an enum member read) is a `references`, one per user and target at its first site, with its uses in `detail.use`. A use of a repository variable (read or assigned), and a function or method used as a value without being called (passed, assigned, a JSX attribute), is a `references` too, with use `value`; a call is a `calls` and a JSX tag a `renders`. Import and export specifiers, re-exports included, are not references. Uses of properties that are not methods are not recorded, so every file reports references as partial.
- React (A20): `renders`, `uses_hook`, `provides_context` and `uses_context`, from JSX, `lazy`, hooks, and `createContext`.
- Prisma Client (A36): the adapter reads the repository's `*.prisma` files as configuration and names each model's table as the Prisma rule does. A model access `client.<model>.<operation>(...)` on a client typed or created as `PrismaClient` from `@prisma/client`, or as a repository class whose extends chain reaches it (NestJS's `PrismaService`), is a `references` (rule `prisma_client`) from the enclosing function to a `table` symbol of that name, declared at the first access. An accessor naming no model is unresolved. Clients through aliases, factories, `$extends` or a transaction's parameter are not recognised, and one model map serves the whole repository.
- HTTP endpoints (A7): Express routes (`app.get('/path', ...)` and the other verbs on an `express()` app or an `express.Router()`, `all` as `ANY`, routers mounted with `use(prefix, router)` composed across modules) and NestJS controller actions (`@Controller('prefix')` with `@Get(':id')` and the other verb decorators) are `endpoint` symbols named `VERB path`, `:param` written `{param}`, each `exposes` its handler (rules `express_route`, `nestjs_route`), as the C# rules shape them. An inline handler becomes a function symbol named after its registration. A path or mount prefix that is not a literal, or a router no application mounts, stays unresolved with the reason. CommonJS `require('express')`, `app.route(...)` chains, receivers held in parameters or properties, routers returned by calls, Express 5 path syntax, and NestJS global prefixes, router modules and versioning are not modelled; Koa is not recognised.
- TypeORM tables (A9): `@Entity()`, `@Entity('name')` and `@Entity({ name, schema })` map their class to a `table` symbol (rule `Entity`); a bare `@Entity()` takes TypeORM's default name, the class name in snake case, marked `inferred`. `@ChildEntity()` `inherits` its parent and shares its table. The decorators are recognised by their import from `typeorm`, so it need not be installed; a decorator re-exported through a local module is not followed.
- Pulumi (A8, A25): each resource a program constructs is a `resource` symbol named by its type and name, as its URN names it. A resource `references` each resource whose outputs its arguments read, and `depends_on` each resource its `dependsOn` option names.

## C#

Roslyn, over the solution's projects, with no restore and no build unless the repository is trusted for build evaluation.

- Symbols, inheritance, interface implementations and overrides; calls resolved to declarations in the repository. A call into a package that would need a restore or generated code is unresolved.
- Framework rules: ASP.NET Core endpoints (`exposes`, `maps_to`), dependency injection (`registered_as`, `injects`), Entity Framework tables, hosted services (`runs`), MediatR (`dispatches_to`, `handles`), Kafka (`publishes`, `consumes`), configuration (`reads_config`), package references (`depends_on_package`), named HTTP clients (`AddHttpClient("name")` gives a `service` symbol and `calls_service`, rule `http_client_name`), and Pulumi resources (`new T("name", ...)` for a type deriving from Pulumi's `CustomResource` or `ComponentResource`, named as the TypeScript rules name them, with `references` and `depends_on`).
- References: a use of a repository declaration other than a call (a type named, a property or field read or written, a constant or enum member used, an object created, an attribute, a method passed as a delegate, a `nameof`) is a `references` relationship, one per user and target at its first site, with its uses in `detail.use`. Enum members are `field` symbols. Names that bind outside the repository, or not at all, are not recorded, so the capability is partial.
- A call that does not bind carries the name it calls (`detail.callee`), its argument count (`detail.arity`) and the compiler's first error inside it (`detail.compiler`); a failure caused only by a name that does not bind is blamed on that name. `nameof(...)` is not a call.
- A repository's conventions file adds jobs, feature flags and code-declared owners (see `conventions.md`).

EF6 entities without an explicit mapping get the pluralised table name by a simple English rule, marked `inferred` in the mapping's detail, unless the context removes the pluralizing convention. A context that names tables through a lightweight convention (`modelBuilder.Types().Configure(c => c.ToTable(...))`) is evaluated when the name is built from constants and `c.ClrType.Name`; a name built from `Helper(c.ClrType).Name` is taken as the entity's own name and marked `inferred`, because the helper may map a type to another, and a schema that is not a compile-time constant is left out and noted. Any other convention leaves `maps_to` unresolved as `outside_capability`; a repository-specific extension installed with `proofmesh extension add` can supply those tables, and `get_table_reach` says so when a snapshot has no table at all. A package reference written with an MSBuild property (`$(Name).Core`) is recorded as an unevaluated input, not a missing one.

## Python

Tree-sitter for declarations and imports, and Pyright's language server for the target of every call. Pyright starts with an empty `PATH`, so no interpreter, and no start-up file of any environment, ever runs.

- Symbols: modules, classes, functions and methods, with their headers as signatures. An empty file, such as a bare `__init__.py`, has no symbol.
- Imports: resolved to files in the repository, for relative and absolute imports, including a package's `__init__.py`. Imports of the standard library and of packages are not reported, so a file that has them reports its imports as partial.
- Calls: resolved across modules, including methods on instances whose type Pyright infers. A call into the standard library or an installed package is `resolved_external`. A call into a package that is not installed is unresolved with `dependency_missing`, and a callee read from a variable or attribute whose value is not known statically is unresolved with `untyped_receiver`. `getattr(...)()` is `dynamic_element_access`.
- Pyright is given 60 s per definition request; a call it does not answer in time is unresolved with `outside_capability` and the file says so in a warning. Pyright is replaced after every 40 files, because a long session answers ever more slowly on untyped code. `PROOFMESH_PYRIGHT_UNANNOTATED=off` makes Pyright skip unannotated function bodies, trading resolution inside them for bounded time.
- Installed packages: read, never run, from the repository's `.venv` or `venv`. Each distribution is an external input. An editable install of the repository's own package resolves to the indexed copy of that package, never to the checkout its `.pth` file names.
- HTTP clients (A7): a call whose name says the verb (`get`, `post`, `_push`, `request`, ...) with a path literal, an f-string or a module constant as its first argument becomes an `endpoint` symbol (`VERB path`, interpolations as `{param}`) and an outbound `dispatches_to`, for the workspace link rules to match. The path starts with `/` or a scheme, or is a route relative to a base URL (`rates/add`); `request("POST", path)` takes its verb from the first argument. A path built any other way is not reported, nor is a decorated route (`@router.get("/x")`) or a route registration, which declare what the service exposes.
- Inheritance: a class `inherits` each repository class Pyright resolves a base to.
- Entry points (A7, A9): FastAPI routes on `FastAPI()` apps and `APIRouter(prefix=...)` routers composed by `include_router` (rule `fastapi_route`), Flask routes on apps and blueprints with their registered prefixes (`flask_route`), and Django URLconfs from `ROOT_URLCONF` through `include()` (`django_path`) are `endpoint` symbols named `VERB path` that `expose` their handlers; a Django function view is `ANY path`, and a class-based view exposes each of its own verb methods. Celery `@shared_task` and `@app.task` functions are `job` symbols that `run` them. Path converters take the ASP.NET form (`<int:id>` as `{id:int}`, a path converter as a catch-all). A router or blueprint nothing mounts is placed at the root, marked `inferred`. A route, method list, prefix or URLconf the rules cannot read stays unresolved on its handler, and `re_path` is skipped with the reason. Routes added by call (`add_api_route`, `add_url_rule`), `app.mount`, Django REST framework and included lists are not read.
- Tables (A9): SQLAlchemy `__tablename__` (rule `tablename`), a module-level `Table("name", ...)` (rule `table`, its variable the entity) and `__table__` (rule `table_attribute`); Django models in an app's `models.py` or `models/` package, by `Meta.db_table` (rule `db_table`) or else `<app_label>_<model>` (rule `django_convention`, marked `inferred` unless `Meta.app_label` names the label). Each table is one `table` symbol declared at its first mapping, and `maps_to` runs from each entity to it. Single-table subclasses and Django proxy models map nothing and reach their parent's table through `inherits`; abstract models map nothing. Django and SQLAlchemy need not be installed: their classes are recognised by import. Schemas, `@declared_attr` names, mixins, Flask-SQLAlchemy's automatic names and imperative mappings are not read.
- Pulumi (A8, A25): resources constructed from a `pulumi_*` provider package, named through the imports, or from a repository class deriving from a Pulumi resource, named as the TypeScript rules name them; `references` from an argument that reads another resource's output, and `depends_on` from `ResourceOptions(depends_on=[...])`. An `opts` held in a variable is not followed, and resources of the core `pulumi` package such as `StackReference` are not recognised.
- A repository's conventions file adds jobs, feature flags and code-declared owners (see `conventions.md`).
- Incremental indexing (A16): an edit reanalyses the edited file and every file that imports it, directly or not. Adding or removing a module reanalyses every Python file.

## Terraform

Static HCL through Tree-sitter. Proofmesh never runs `terraform init`, so remote modules are not fetched.

- Symbols, named by their Terraform address within their module directory: resources and data sources (`resource`), variables and locals (`variable`), outputs (`output`), module calls (`module_call`), and each file (`module`).
- References: from a block to each variable, local, resource, data source and module output it reads; an undeclared name is unresolved with `unknown_name`.
- `depends_on`: from each `depends_on` entry, and from a module call to the files of a local child module. A remote module call is unresolved with `dependency_missing`.
- The link from cloud resources to the services that run on them waits for M6 (A26).

## The syntax tier

Tree-sitter grammars on WebAssembly (A6, A23) for Java, Go, Rust, Ruby, PHP, C, C++, Bash, Scala, Kotlin, Swift and SQL, and for Prisma schemas.

- Symbols: the declarations each grammar's tags query finds.
- Calls: every call site, unresolved with `outside_capability`, with the callee's name as detail. The syntax tier never claims a call target.
- Imports (FR115): one `imports` row per import statement, from the file, with the module as written in `detail.module` (a Java wildcard ends in `.*`, a Go alias is `detail.alias`). Each is unresolved with `outside_capability` (FR117), so a file in Go or Java reports its imports as partial, with or without an import statement, and nothing reports them complete. A Java static import, and a Go dot or blank import, is recorded like any other, not told apart.
- Heritage (FR116): a Java class `inherits` the class it extends and `implements` each interface it names, as do a Java enum and record; a Go struct `inherits` each type it embeds, with `detail.relation` `embedding`. Each row runs from the declaring type, at the supertype's name, with that name in `detail.name`, and is unresolved with `outside_capability` (FR117). A Java interface's `extends` and a Go interface's embedded interfaces are not recorded yet.

- Names (FR146): every symbol's qualified name is the one the SCIP importer also gives it. Java, Kotlin, Scala and PHP start from the declared package or namespace (Scala's nested and chained packages and PHP's several namespaces are each declaration's own); every other language starts from the file path. A Go method is named under its receiver type, a Rust method under its `impl` type and, in a trait impl, the trait (`X.<Display>.fmt`), and a C++ member defined outside its class under that class. Overloads of one name in a file take their parameter types, as written. Limitation: a C or C++ prototype is merged into its definition only inside one file, so a prototype in a header and its definition in a `.c` file stay two symbols, one per file.

What the tier records per language (FR118):

| Language | Imports | Heritage | Calls |
|---|---|---|---|
| Go | yes, with module and alias | struct embedding | yes |
| Java | yes, with module | `extends`, `implements` | yes |
| Swift | statements, without the module | no | yes |
| Bash, Kotlin, PHP, Ruby, Rust, Scala | no | no | yes |
| C, C++ | no | no | no |
| SQL | no | no | no; table references instead |
| Prisma | no | no | no; model references instead |
- Grammars: each is pinned by its package version and the hash of its WebAssembly, which join the adapter's identity. Swift, SQL and Prisma ship no WebAssembly, so `adapters/syntax/grammars/rebuild.mjs` builds them from their packages' source with the Tree-sitter CLI 0.27.2; the build is reproducible, and the syntax adapter's build refuses a grammar whose hash or version differs from `grammars/built.json`, or whose license `policy/licenses.json` does not allow. Each grammar's license text ships beside it, and `THIRD_PARTY_NOTICES.md` lists every grammar.
- Swift: classes and actors, structs, enums, protocols, functions, methods and properties; members of an `extension X` are named `X.member`. Imports are unresolved import statements. Initializers, subscripts, enum cases and top-level `let` and `var` are not symbols.
- SQL: `CREATE TABLE`, `VIEW` and `MATERIALIZED VIEW` are `table` symbols named by their schema-qualified name, and functions and procedures are functions. A table named in FROM, JOIN, UPDATE, INSERT INTO, DELETE FROM or a `REFERENCES` clause is a `references` candidate when the same file declares it, and unresolved otherwise. T-SQL bracket identifiers do not parse, so such names are skipped and the file reports partial.
- Prisma (A9): each model and view is a class that `maps_to` a `table` symbol: the name `@@map` gives (rule `prisma_map`) or else the model's own (rule `prisma_convention`, marked `inferred`), qualified by `@@schema`. A field whose type is a model in the same file is a resolved `references`; a relation to a model another file declares is unresolved. Prisma Client calls in TypeScript reach these tables (see the TypeScript section).

## The build graph: JavaScript and Go modules

The build adapter (FR124 to FR129) reads manifests as captured text and never runs a build tool, package manager or script, so a `preinstall` script in a `package.json` is data (FR079).

- Projects: a `package.json` that names a package and a `go.mod` are `project` symbols, named by the npm name or the Go module path and declared at the line of that name. A `package.json` with no name (a workspace root, or a `{"type": "module"}` marker) declares none and does not hide the project above it. Manifests under `testdata` and `vendor` directories declare none.
- Containment: each source file is contained by the project of its nearest enclosing manifest that declares one, so `analyze_impact` groups dependents by project. A file under none is contained by none. A directory with both a `go.mod` and a `package.json` gives its files to the Go project.
- Dependencies inside the repository (`depends_on`, resolved, at the declaring line): a `package.json` dependency on a workspace member (the root's `workspaces`, as an array or `{"packages": [...]}`, or a `pnpm-workspace.yaml` `packages` list read line by line; `**` matches zero or more directories, `{a,b}` either, `!` excludes), a `workspace:` dependency when the repository lists no workspaces at all (any named package), or a `file:` or `link:` to a project directory; a `tsconfig.json` `references` entry, to the referenced directory's own project only (its `extends` is not read); a `go.mod` `require` that a local `replace` (in the `go.mod` or a `go.work` that uses the module) or a module the same `go.work` uses satisfies. A path outside the repository, or into a directory with no manifest, is unresolved with `dependency_missing` and the path as written; two projects of one name make a dependency on it ambiguous.
- Packages outside it (`depends_on_package`, `resolved_external`): `npm:<name>` and `go:<module>` with the declared version in `detail.version`; a `file:` or `link:` to a tarball or to a directory that is no project is a package, with the spec as its version. A Go `require` that no `go.work` or local `replace` satisfies is a package even when a repository module has that path, because Go would fetch it.
- A manifest that does not parse fails that file with the line in its disposition detail; every other manifest is still read.
- Not read yet: Cargo, pyproject, Composer and gemspec manifests, Maven and Gradle, and a dependency list a script edits.

## SCIP indexes a person produces

A person who runs a SCIP indexer can name its output: `proofmesh scip add <repository> <index.scip>`. Proofmesh reads the file and never runs an indexer (A24).

- An index covers only files no semantic adapter analyses, so it upgrades the syntax tier and languages with no adapter (A27).
- Symbols: each definition, with its kind and signature as the indexer recorded them, named by its SCIP descriptors. A definition's span is the indexer's enclosing range; when the index records none, it is the syntax tier's span of the declaration that holds the name, so a line inside the body has an enclosing symbol (FR121).
- References: from the innermost definition that encloses each occurrence, resolved to a definition the index serves, or to an external symbol named by its package. A symbol the index defines in a file whose facts come from another adapter is unresolved with `outside_capability`.
- Calls and imports are not reported: SCIP does not distinguish a call from another reference.
- Staleness: Proofmesh records each covered file's content when the index is named. A file edited after that, or every file of an index whose own file changed, goes back to its usual adapter, and its disposition says `scip_stale:<name>` until the person produces the index again and names it again.

## Other languages

`proofmesh adapter add` installs an adapter a contributor wrote for another language (US18). Its capabilities are unverified until it passes the conformance kit; see `adapter-authoring.md`.

## The language census

`workspace_status` returns `languages` and `proofmesh status` prints it, with no configuration (FR136 to FR141). Every discovered file is in exactly one row: the language by GitHub Linguist's name, a kind (`code`, `template`, `data`, `prose`), or `unknown` with its extension, or `binary`. Rows list code and template kinds first, then by file count, then by name.

- Detection uses the file name, the longest known extension (`.html.erb` is ERB, not HTML), the shebang of a file with no extension, and a content check for `.h` (C++ or Objective-C when the text says so, C otherwise). An extension several languages share and nothing settles, such as `.m`, `.pl` or `.v`, is `unknown` with the extension, never a guess. Comments and string literals are blanked before a header is read, and up to 64 KB of it is scanned, so a long licence banner does not hide C++. Only a short final suffix of letters and digits is an extension: files without one share one `(no extension)` row and files with an implausible one (`app.log.2024-11-24`) one `(other)` row, and past 64 rows the smallest are summed into a last `other` row, so the rows always sum to the inventory. An Objective-C header has its own row (no grammar, tier `none`) and is not given to the C parser. The names, kinds, extensions, file names and interpreters come from a trimmed copy of Linguist's `languages.yml` (MIT; `THIRD_PARTY_NOTICES.md` carries its notice), vendored as data in `packages/proofmesh/src/indexer/linguist-table.ts`.
- A file whose language only its shebang or content gives is routed to that language when the syntax tier reads it, so an extensionless bash script is Shell and its functions are symbols. A script in a language a semantic adapter reads, such as Python, still waits for its extension.
- `tier` is the tier that read most of the row's files: `precise:<adapter>`, `scip:<index>`, `syntax` or `none`, and `tiers` lists each with its file count. Each indexed source file records its tier as the `tier` key of its capabilities. Files left out by rule are counted under `excluded`, by rule, and are in no tier.
- `capabilities` counts the row's files at each level (`complete`, `partial`, `unsupported`, `failed`, `not_run`) for `symbols`, `imports`, `references` and `resolved_calls`; each capability's counts sum to `files`.
- `reason` says why the row's weakest files stop where they do (`no_precise_tier`, `no_grammar`, `not_code`, `adapter_unavailable:<id>`, `scip_stale:<index>`, `unknown_language`, `binary`, `excluded`), and `remedy` is advice from the table below. The census runs nothing and installs nothing; a SCIP indexer runs only in a repository you trust.

### Remedies

Every remedy comes from this one table of language to precise route:

| Language | Built-in precise adapter | SDK and build it needs | SCIP indexer |
|---|---|---|---|
| `C` | none | none | `scip-clang --compdb-path=compile_commands.json` (needs a compile_commands.json) |
| `C#` | csharp | .NET 10 SDK; `dotnet build adapters/csharp -c Release` | `scip-dotnet index` |
| `C++` | none | none | `scip-clang --compdb-path=compile_commands.json` (needs a compile_commands.json) |
| `Go` | none | none | `scip-go` |
| `HCL` | terraform | none | none |
| `Java` | none | none | `scip-java index` |
| `JavaScript` | typescript | none | `scip-typescript index` |
| `Kotlin` | none | none | `scip-java index` |
| `PHP` | none | none | scip-php, see https://github.com/davidrjenni/scip-php |
| `Python` | python | none | `scip-python index . --project-name <name>` |
| `Ruby` | none | none | scip-ruby, see https://github.com/sourcegraph/scip-ruby |
| `Rust` | none | none | `rust-analyzer scip .` |
| `Scala` | none | none | `scip-java index` |
| `TypeScript` | typescript | none | `scip-typescript index` |

A language not in the table that a grammar reads gets `proofmesh adapter add`; one with no grammar gets the same, and until a person adds an adapter it stays at tier `none` or `syntax`.
