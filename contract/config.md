# Configuration contracts

Repository owners declare shared policy; machine operators declare local paths and user
routing policy. agx reads these declarations and does not rewrite them. This document
separates implemented readers from retained design requirements that are not yet implemented.
The schemas currently live in TypeScript validators, not JSON schema files.

## Repository policy and local overrides

The shared reader is `tools/shared/src/agx-config.ts`. Worker ticket-home resolution and
agx-ticket use it. Workspace lifecycle commands still use the separate policy described in
[agx-ws](../tools/agx-ws/README.md#repo-configuration-wstoml).

| Layer   | Declaration                                                                         | Writer                                      | Selection                                                |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| L1      | Optional root `agx.toml`                                                            | Repository owner, through review and commit | Main checkout `trunk()` revision; Git uses HEAD          |
| L2      | `$XDG_CONFIG_HOME/agx/repos/<name>.toml`, default `~/.config/agx/repos/<name>.toml` | Machine operator                            | One file whose `root` equals the real main-checkout path |
| L3      | User policy, described below                                                        | Operator                                    | One user policy file, independent of repository          |
| Catalog | Shipped model data                                                                  | agx maintainers                             | Installed agx version                                    |

Defaults are `tickets = ".agents/tickets"`, no readiness commands, no keep entries and no
repository verification commands. Merge order is defaults, L1, L2; later values replace each
key, and arrays are replaced rather than concatenated. L1 is optional: local-only operation
needs no tracked file or ignore rule. No repository working file supplies L2.

```toml
# L1: agx.toml, committed at trunk() (Git: HEAD)
schema = 1
tickets = "plans/tickets"

[ws]
ready = ["mise trust -q", "bun install --frozen-lockfile"]

[verify]
always = ["mise run check"]
```

L1 accepts only `schema`, `tickets`, `[ws].ready` and `[verify].always`. Schema must equal 1.
Declarations use TOML 1.0 syntax. Unknown keys, malformed TOML, duplicate TOML keys and unsupported or missing schema fail.
Ticket paths must be nonempty relative strings; absolute POSIX and Windows paths and `~/`
are rejected at L1. Relative ticket paths resolve from the main checkout. Paths are UTF-8
strings; no canonicalization or signature is applied. Numeric settings other than schema
are absent from L1. `[ws].keep` is rejected with guidance to put it in L2.

```toml
# L2: ~/.config/agx/repos/project.toml (filename is arbitrary)
schema = 1
root = "/srv/project"
tickets = "/srv/project-tickets"

[ws]
ready = ["bun install --frozen-lockfile"]
keep = ["/srv/project.ws/ws-reference"]

[verify]
always = []
```

L2 requires absolute `root` and schema 1. It accepts the L1 keys plus `[ws].keep` and
`[usehooks]` with required `hooks`, `link_task`, `link_path` strings and nonempty `command`
string array when present. Readiness, keep and verification arrays contain nonblank strings.
Absolute ticket paths and `~/` expansion are allowed only here; relative paths still resolve
from the main checkout. The reader canonicalizes the main checkout with realpath, but compares
L2 `root` literally: operators must declare that real path, not a symlink alias.

All regular or symlinked `.toml` entries in the L2 directory are parsed, in filename order.
A malformed unrelated entry also fails the read. Duplicate literal roots fail, even if the
duplicate is unrelated to the current repository. No match leaves defaults and L1 in effect.
L2 has one operator as writer; machine-specific keep lists should stay local. The operator
chooses how declarations are deployed. Repository review/history records L1 decisions; local
operator ownership is the record for L2. Neither layer has a separate exception format,
canonicalization, signing input or decision ledger.

Only committed `.agx.toml` at the inspected L1 revision is rejected with the rename instruction
`mv .agx.toml agx.toml` and guidance for moving absolute paths into L2. A working-only legacy
file is not inspected by this reader. Uncommitted L1 edits have no effect. Invalid configuration
produces a configuration error; ticket CLI reports one diagnostic and exit 2. Read-only VCS
inspection is bounded at 60,000 ms; unavailable inspection, including timeout, is represented
as `InspectionUnavailable` rather than a successful policy read. Worker inspection preserves
exit 75; the ticket CLI currently treats this subclass as a configuration error and exits 2.

## Repository verification

Worker runs execute `[verify].always` first and then ticket verification, in order in the same
workspace. The brief includes these commands as checks to pass before returning. No declaration
adds no commands. Results carry command, exit, log path and outcome kind (`passed`, `failed`,
`unrunnable` or `killed`); repository checks carry `source = "[verify].always"`, rather than
`kind = "repo"`. Verification failures are evidence for acceptance, not a replacement for the
worker process exit. They do prevent an `ok` outcome. All verification commands run even after a
failure; capacity runs skip verification. `tools/agx-worker/src/next/run.ts` and its verification
code own execution. L1 and L3 are human-authored inputs to gated decisions; L2 is an operator-owned
local declaration. Catalog changes are reviewed and versioned with agx.

## User policy and catalog

The routing reader is `tools/agx-worker/src/roster/load.ts`. It combines the catalog embedded
from `tools/agx-worker/src/roster/catalog.toml` with one user policy. A nonempty `AGX_CONFIG`
selects the policy path; otherwise nonempty `XDG_CONFIG_HOME` selects `agx/agx.toml`, otherwise
`~/.config/agx/agx.toml`. Library callers may explicitly select catalog and policy paths.
Missing or invalid explicit inputs do not fall back to the shipped defaults. Policy is
required. The distributed `tools/agx-worker/src/roster/policy.example.toml` is an example,
not automatically installed configuration.

Both declarations are human-authored TOML, schema 1, parsed with Bun TOML and strict validators.
Unknown keys and duplicate TOML keys fail. There is no signing or canonicalization. Operators
own policy; maintainers review and version the catalog. The catalog supplies model facts,
benchmark values, prices, use descriptions, source URLs and an `as_of` date; absent measurements
remain absent rather than being estimated. Policy must not replace catalog row values.

Policy contains `[route]` and `[claude_run]`. Route requires `default`, positive integer
`max_task_chars` and `timeout_ms`, `no_egress` string array, `pick_temperature` in [0, 5], and
`jev`. Optional `allow` is a nonempty array of `codex`/`claude`; optional `exclude` defaults to
empty; optional `on_window_exhausted` maps each vendor to `continue` or `stop`.
`jev` requires `api = "typesafe"`, URL and nonempty model, or `api = "reseller"` and URL.
Claude policy requires positive `max_budget_usd`, positive integer `max_turns`, and a `reason`
of at least 20 characters. Numbers use JavaScript binary64 with the stated validator bounds.

Default and excluded IDs must exist in the catalog. Excluded rows disappear; default must
remain a non-excluded codex row. `allow` becomes the router's allowed routes, rather than
removing rows from the exported choice array. Catalog Jev prices join the endpoint policy.
Catalog IDs must be unique; routes are codex or claude. Catalog-level `as_of`, `sources` URL
map, `jev` price table and nonempty `choice` are required. Individual benchmark source fields
are optional; the loader does not require a source/date on every row or nonnegative row prices.
The composed roster also passes generation-exclusivity validation.

`agx worker roster --json` exports the combined roster; worker routing, continuation and
preflight consume it. External integrations should use this interface rather than parse an
internal file. Legacy price reporting still reads the embedded `agents/models/dispatch-roster.toml`
or `DISPATCH_ROSTER_PATH` through `tools/shared/src/dispatch-pricing.ts`. That variable is not
currently rejected by the routing loader. Price reporting therefore remains a second reader.
Shell-command model-floor enforcement belongs to the invoking host, not this routing policy.

## Retained design requirements

These requirements preserve the intended configuration design. They are not promises of
commands or schemas that the present code does not implement.

- Shared policy should be reviewed and portable; machine paths and keep lists should remain
  outside version control. Every declaration should have one writer and one authority.
- All repository consumers should use the same parser and effective revision. Workspace
  readiness should come from L1/L2, keep only from L2, and landed history only from jj `trunk()`.
  The present workspace reader still uses `.ws.toml`; do not delete it on this release.
- Unsupported schema versions should fail with exit 2 and one line explaining migration or
  upgrade. Optional keys with defaults should retain schema version and use a minor release.
  Changing meaning, deleting a key or making one required should increment schema by one and
  require a major release. Contracts use major releases for breaking changes.
- A future `agx config migrate --from <version> <file>` should be a filter: emit new content to
  stdout, never rewrite the operator's file. That command is not implemented today.
- Preserve versioned fixtures under `tests/fixtures/config/v<version>/` when shipping migrations:
  prior versions should fail with migration guidance; migrated output should validate with the
  same resolution result. This fixture layout and migration coverage are not implemented yet.
- Catalog and user policy should have one reader each, including pricing. The intended catalog
  home is `packages/roster/catalog.toml`; the current home is the worker catalog described above.
  Public model-release audit data should travel with the catalog. A per-row source/date and
  model-audit gate remain intended checks, not guarantees of the current loader.
- Consumer owners control upgrades of their pinned agx version. A breaking-release upgrade
  should include a migration request to those owners. Prepare L2 before adopting the new
  reader, then remove retired repository declarations promptly; local-only repositories put
  all supported repository policy in L2. Validate with worker check and workspace dry-run GC.

## Verification examples and migration status

For implemented L1/L2 behavior, shared fixtures are in `tools/shared/tests/agx-config.test.ts`,
worker ticket-home fixtures in `tools/agx-worker/tests/next/ticket-home.test.ts`, and ticket
lifecycle fixtures in `tools/agx-ticket/tests/lifecycle.test.ts`. Cases include relative L1,
local absolute paths, array replacement, missing/unsupported schema, unknown keys, duplicate
roots and retired committed files. A known L2 root must be its real main-checkout path.

`agx worker check <ticket> --cd <workspace>` and `agx ticket ls --repo <workspace> --json`
exercise the shared ticket home. Workspace add and dry-run GC exercise the separate `.ws.toml`
policy, so they cannot currently prove shared L1/L2 readiness or keep behavior. Routing can be
inspected with `agx worker roster --json`; unknown defaults/exclusions and invalid policy fail
loading. Repository verification is covered by `tools/agx-worker/tests/next/run.test.ts`.

Migration status: shared L1/L2 and repository verification exist; workspace-policy unification,
legacy price-reader removal, JSON schema publication and migration filters remain incomplete.
Historical implementation-stage labels and host deployment tasks are not public interfaces.

The intended publication names are `agx-toml.schema.json`, `repo-override.schema.json`,
`user-config.schema.json` and `roster-catalog.schema.json` in this directory. Until published,
they are design targets rather than validation authorities. Intended acceptance examples pair
worker check with workspace add JSON for identical ticket/readiness values, and pair workspace
dry-run GC with add JSON for identical keep/readiness values. These pairs do not currently
report those configuration values or share the workspace reader; use the fixtures above for
implemented behavior. A local-only setup should eventually make all repository values effective
across add, gc, rm, doctor, check and run. That workspace integration is still pending.
