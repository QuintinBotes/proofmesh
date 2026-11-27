// Answers recorded from fixtures/ts-invoicing (#115): a copy indexed (snap_ecab...), formatAmount's toFixed(2) edited to toFixed(3) and indexed
// again (snap_fe58...), then each tool asked over `proofmesh mcp` as the hooks module asks it, on the second snapshot. impact.test.ts serves them. `impact` was asked again, compact, once rows carried line and relationship (#159).
export const RECORDED = {
  "symbolsAt": {
    "schema_version": "0.1",
    "query_id": "q_my7sg6l72ut3h6d2",
    "tool": "get_symbols_at",
    "snapshot": {
      "id": "snap_fe5883e5a2f3e34be3610da7",
      "repository_id": "repo_39445429d857",
      "analysis_mode": "no_execution",
      "published_at": "2026-11-27T10:19:02.586Z",
      "commit": null,
      "ref": null,
      "behind_remote": null,
      "behind_ref": null,
      "fetched_at": null
    },
    "freshness": {
      "mode": "snapshot",
      "status": "as_of_snapshot"
    },
    "coverage": null,
    "data": {
      "results": [
        {
          "location": "packages/format/src/currency.ts:1",
          "symbol": {
            "id": "sym_af2600a282f3149e81bc772f",
            "kind": "function",
            "name": "formatAmount",
            "qualified_name": "packages/format/src/currency:formatAmount",
            "stable_key": "packages/format/src/currency.ts#packages/format/src/currency:formatAmount#function",
            "path": "packages/format/src/currency.ts",
            "start_line": 1,
            "end_line": 3,
            "tier": "precise"
          }
        },
        {
          "location": "packages/format/src/currency.ts:2",
          "symbol": {
            "id": "sym_af2600a282f3149e81bc772f",
            "kind": "function",
            "name": "formatAmount",
            "qualified_name": "packages/format/src/currency:formatAmount",
            "stable_key": "packages/format/src/currency.ts#packages/format/src/currency:formatAmount#function",
            "path": "packages/format/src/currency.ts",
            "start_line": 1,
            "end_line": 3,
            "tier": "precise"
          }
        },
        {
          "location": "packages/format/src/currency.ts:3",
          "symbol": {
            "id": "sym_af2600a282f3149e81bc772f",
            "kind": "function",
            "name": "formatAmount",
            "qualified_name": "packages/format/src/currency:formatAmount",
            "stable_key": "packages/format/src/currency.ts#packages/format/src/currency:formatAmount#function",
            "path": "packages/format/src/currency.ts",
            "start_line": 1,
            "end_line": 3,
            "tier": "precise"
          }
        }
      ]
    },
    "evidence_ids": [],
    "unresolved": {
      "count": 1,
      "scope": "snapshot",
      "sample": [],
      "by_reason": {}
    },
    "completion": {
      "truncated": false,
      "stop_reasons": [],
      "timed_out": false,
      "next_cursor": null
    },
    "limits": {
      "requested": {},
      "applied": {
        "timeout_ms": 10000,
        "max_rows": 100,
        "max_bytes": 65536,
        "max_depth": 6
      }
    },
    "limitations": [],
    "envelope": "compact"
  },
  "baseSymbol": {
    "schema_version": "0.1",
    "query_id": "q_wec45vnxaenrytac",
    "tool": "get_symbol",
    "snapshot": {
      "id": "snap_ecab4d4a04c0ffb169159239",
      "repository_id": "repo_39445429d857",
      "analysis_mode": "no_execution",
      "published_at": "2026-11-27T10:08:24.370Z",
      "commit": null,
      "ref": null,
      "behind_remote": null,
      "behind_ref": null,
      "fetched_at": null
    },
    "freshness": {
      "mode": "snapshot",
      "status": "as_of_snapshot"
    },
    "coverage": null,
    "data": {
      "symbol": {
        "id": "sym_2f7f03527636fd96a4917c39",
        "kind": "function",
        "name": "formatAmount",
        "qualified_name": "packages/format/src/currency:formatAmount",
        "path": "packages/format/src/currency.ts",
        "start_line": 1,
        "end_line": 3,
        "signature": "formatAmount(cents: number, currency: string): string",
        "evidence_id": "ev_3a982c0631dba8f16e71215e",
        "stable_key": "packages/format/src/currency.ts#packages/format/src/currency:formatAmount#function",
        "body_hash": "addca3447cd0659e93127fc04f9a846b0713d7e96d70ed876336c89e16b9ee66"
      }
    },
    "evidence_ids": [
      "ev_3a982c0631dba8f16e71215e"
    ],
    "unresolved": {
      "count": 1,
      "scope": "snapshot",
      "sample": [],
      "by_reason": {}
    },
    "completion": {
      "truncated": false,
      "stop_reasons": [],
      "timed_out": false,
      "next_cursor": null
    },
    "limits": {
      "requested": {},
      "applied": {
        "timeout_ms": 10000,
        "max_rows": 100,
        "max_bytes": 65536,
        "max_depth": 6
      }
    },
    "limitations": [],
    "envelope": "compact"
  },
  "headSymbol": {
    "schema_version": "0.1",
    "query_id": "q_rpwfuteyhnu2rmzn",
    "tool": "get_symbol",
    "snapshot": {
      "id": "snap_fe5883e5a2f3e34be3610da7",
      "repository_id": "repo_39445429d857",
      "analysis_mode": "no_execution",
      "published_at": "2026-11-27T10:19:02.586Z",
      "commit": null,
      "ref": null,
      "behind_remote": null,
      "behind_ref": null,
      "fetched_at": null
    },
    "freshness": {
      "mode": "snapshot",
      "status": "as_of_snapshot"
    },
    "coverage": null,
    "data": {
      "symbol": {
        "id": "sym_af2600a282f3149e81bc772f",
        "kind": "function",
        "name": "formatAmount",
        "qualified_name": "packages/format/src/currency:formatAmount",
        "path": "packages/format/src/currency.ts",
        "start_line": 1,
        "end_line": 3,
        "signature": "formatAmount(cents: number, currency: string): string",
        "evidence_id": "ev_2147eb37d489328338e38b9a",
        "stable_key": "packages/format/src/currency.ts#packages/format/src/currency:formatAmount#function",
        "body_hash": "fa6a9307ded7515cb1fdccc01dba0f3493422d6c0ee8d15332005e23ed0c48d6"
      }
    },
    "evidence_ids": [
      "ev_2147eb37d489328338e38b9a"
    ],
    "unresolved": {
      "count": 1,
      "scope": "snapshot",
      "sample": [],
      "by_reason": {}
    },
    "completion": {
      "truncated": false,
      "stop_reasons": [],
      "timed_out": false,
      "next_cursor": null
    },
    "limits": {
      "requested": {},
      "applied": {
        "timeout_ms": 10000,
        "max_rows": 100,
        "max_bytes": 65536,
        "max_depth": 6
      }
    },
    "limitations": [],
    "envelope": "compact"
  },
  "impact": {
    "schema_version": "0.1",
    "query_id": "q_dn7kawokvzfsbkiz",
    "tool": "analyze_impact",
    "snapshot": {
      "id": "snap_fe5883e5a2f3e34be3610da7",
      "repository_id": "repo_39445429d857",
      "analysis_mode": "no_execution",
      "published_at": "2026-11-27T10:19:02.586Z",
      "commit": null,
      "ref": null,
      "behind_remote": null,
      "behind_ref": null,
      "fetched_at": null
    },
    "freshness": {
      "mode": "snapshot",
      "status": "as_of_snapshot"
    },
    "coverage": null,
    "data": {
      "subjects": [
        "sym_af2600a282f3149e81bc772f"
      ],
      "types": [
        "calls",
        "inherits",
        "implements",
        "overrides",
        "injects",
        "registered_as",
        "handles",
        "dispatches_to",
        "evaluates_flag",
        "maps_to",
        "exposes",
        "consumes",
        "reads_config",
        "runs",
        "calls_service",
        "renders",
        "uses_hook",
        "provides_context",
        "uses_context"
      ],
      "dependents": [
        {
          "id": "sym_670aa7a6366d972543cc975a",
          "kind": "function",
          "name": "invoiceTotal",
          "qualified_name": "packages/billing/src/invoice:invoiceTotal",
          "path": "packages/billing/src/invoice.ts",
          "project": null,
          "depth": 1,
          "basis": "observed",
          "line": 9,
          "relationship": "calls",
          "key": "packages/billing/src/invoice.ts#packages/billing/src/invoice:invoiceTotal#function"
        },
        {
          "id": "sym_e92cf3bbedde7baf0927f5f6",
          "kind": "function",
          "name": "handleInvoice",
          "qualified_name": "packages/api/src/handler:handleInvoice",
          "path": "packages/api/src/handler.ts",
          "project": null,
          "depth": 2,
          "basis": "observed",
          "line": 5,
          "relationship": "calls",
          "key": "packages/api/src/handler.ts#packages/api/src/handler:handleInvoice#function"
        }
      ],
      "totals": {
        "dependents": 2,
        "by_basis": {
          "observed": 2,
          "inferred": 0
        },
        "by_depth": {
          "1": 1,
          "2": 1
        },
        "by_project": [
          {
            "name": "(no project)",
            "count": 2
          }
        ],
        "by_area": [
          {
            "name": "packages/api/src",
            "count": 1
          },
          {
            "name": "packages/billing/src",
            "count": 1
          }
        ],
        "by_team": []
      },
      "stopped_by": null,
      "subject_members": 0
    },
    "evidence_ids": [],
    "unresolved": {
      "count": 1,
      "scope": "snapshot",
      "sample": [],
      "by_reason": {}
    },
    "completion": {
      "truncated": false,
      "stop_reasons": [],
      "timed_out": false,
      "next_cursor": null,
      "total": 2
    },
    "limits": {
      "requested": {},
      "applied": {
        "timeout_ms": 10000,
        "max_rows": 100,
        "max_bytes": 65536,
        "max_depth": 6
      }
    },
    "limitations": [
      "Potential impact, not a safety proof: only resolved relationships of the listed types are followed.",
      "1 unresolved call site in this snapshot has an unknown target and could also reach these symbols."
    ],
    "envelope": "compact"
  },
  "tests": {
    "schema_version": "0.1",
    "query_id": "q_u4fnptglsuo7bmru",
    "tool": "find_tests",
    "snapshot": {
      "id": "snap_fe5883e5a2f3e34be3610da7",
      "repository_id": "repo_39445429d857",
      "analysis_mode": "no_execution",
      "published_at": "2026-11-27T10:19:02.586Z",
      "commit": null,
      "ref": null,
      "behind_remote": null,
      "behind_ref": null,
      "fetched_at": null
    },
    "freshness": {
      "mode": "snapshot",
      "status": "as_of_snapshot"
    },
    "coverage": null,
    "data": {
      "tests": [],
      "totals": {
        "tests": 0,
        "executing": 0,
        "not_executing": 0,
        "by_basis": {
          "observed": 0,
          "inferred": 0
        },
        "by_project": []
      },
      "observed": {
        "available": false,
        "reason": "No coverage data has been imported for this snapshot."
      },
      "stopped_by": null
    },
    "evidence_ids": [],
    "unresolved": {
      "count": 1,
      "scope": "snapshot",
      "sample": [],
      "by_reason": {}
    },
    "completion": {
      "truncated": false,
      "stop_reasons": [],
      "timed_out": false,
      "next_cursor": null
    },
    "limits": {
      "requested": {},
      "applied": {
        "timeout_ms": 10000,
        "max_rows": 100,
        "max_bytes": 65536,
        "max_depth": 6
      }
    },
    "limitations": [
      "Static reach only: tests that reach the code through unresolved calls, reflection, or configuration are missed.",
      "Test code is recognised by file convention and project naming, and by the roles an adapter gave each symbol (a test entry point, or code in a test-only scope).",
      "In a file whose adapter sent no test roles (TypeScript, JavaScript, a language with no markers, a file with no test attribute or marker), every symbol in test code counts as a test, so a helper there, such as a fixture builder or a beforeEach body, is listed as one."
    ],
    "envelope": "compact"
  },
  "readmeAt": {
    "schema_version": "0.1",
    "query_id": "q_23fpom326rmtsjrv",
    "tool": "get_symbols_at",
    "snapshot": {
      "id": "snap_fe5883e5a2f3e34be3610da7",
      "repository_id": "repo_39445429d857",
      "analysis_mode": "no_execution",
      "published_at": "2026-11-27T10:19:02.586Z",
      "commit": null,
      "ref": null,
      "behind_remote": null,
      "behind_ref": null,
      "fetched_at": null
    },
    "freshness": {
      "mode": "snapshot",
      "status": "as_of_snapshot"
    },
    "coverage": null,
    "data": {
      "results": [
        {
          "location": "README.md:1",
          "symbol": null,
          "disposition": "unsupported",
          "reason": "not_indexed"
        }
      ]
    },
    "evidence_ids": [],
    "unresolved": {
      "count": 1,
      "scope": "snapshot",
      "sample": [],
      "by_reason": {}
    },
    "completion": {
      "truncated": false,
      "stop_reasons": [],
      "timed_out": false,
      "next_cursor": null
    },
    "limits": {
      "requested": {},
      "applied": {
        "timeout_ms": 10000,
        "max_rows": 100,
        "max_bytes": 65536,
        "max_depth": 6
      }
    },
    "limitations": [],
    "envelope": "compact"
  }
} as const
