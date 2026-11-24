# Repository conventions

Some constructs only the repository can name: the base class its scheduled jobs derive from, the class or type its feature flag keys are declared with, the enum whose members name its teams. A conventions file names those types, and rules that ship with the C# adapter match them. The file is data: registering it runs nothing and grants no trust (A32).

```
proofmesh repo conventions <repository> conventions.json   # register, applied at the next index
proofmesh repo conventions <repository>                    # print what is registered
proofmesh repo conventions <repository> --clear            # remove it
```

The file follows `schemas/conventions/0.1.schema.json`. Type names are qualified, with or without type parameters.

```json
{
  "schema_version": "0.1",
  "csharp": {
    "jobs": [{ "base_type": "Example.Work.BackgroundTask" }],
    "feature_flags": [{ "declared_in": "Example.Toggles.ToggleNames" }, { "key_type": "Example.Toggles.Toggle<T>" }],
    "teams": [{ "enum_type": "Example.Ownership.Squad", "parameter": "squad" }]
  }
}
```

| Entry | What it adds |
|---|---|
| `jobs[].base_type` | Every concrete class deriving from the type, directly or not, is a `job` symbol that `runs` the class (rule `job_base`). |
| `feature_flags[].declared_in` | Each string constant or string member with a literal initializer declared in the class is a `feature_flag` symbol named by its value. |
| `feature_flags[].key_type` | Each field or property of that type created with a constant first argument, such as `new("fast-search")`, is a `feature_flag` named by that argument. |
| (both) | Code that reads a key `evaluates_flag` the flag (rule `flag_key`), one relationship per reader and flag. |
| `teams[].enum_type` | An enum member passed as an argument, to a call or an attribute, makes the calling code or the decorated declaration `owned_by` a `team` symbol named after the member (rule `team_argument`, `source: code`). With `parameter`, only arguments to a parameter of that name count. |

The file is part of the C# adapter's configuration for the repository, so it is part of snapshot identity: changing or clearing it gives the next index a new snapshot. A rule that needs code, not names, still belongs in an extension (`proofmesh extension add`), which only a person installs.
