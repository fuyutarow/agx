# Configuration contracts

Repository owners declare shared policy; machine operators declare local paths and user
routing policy. agx reads these declarations and does not rewrite them. This document
separates implemented readers from retained design requirements that are not yet implemented.
The schemas currently live in TypeScript validators, not JSON schema files.

## Repository policy and local overrides

The shared reader is `tools/shared/src/agx-config.ts`. Worker ticket-home resolution,
agx-ticket and agx-ws use it. Workspace policy details are described in
[agx-ws](../tools/agx-ws/README.md#repository-policy-agxtoml).

| Layer   | Declaration                                                                         | Writer                                      | Selection                                                |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| L1      | Optional root `agx.toml`                                                            | Repository owner, through review and commit | Main checkout `trunk()` revision; Git uses HEAD          |
| L2      | `$XDG_CONFIG_HOME/agx/repos/<name>.toml`, default `~/.config/agx/repos/<name>.toml` | Machine operator                            | One file whose `root` equals the real main-checkout path |
| L3      | User policy, described below                                                        | Operator                                    | One user policy file, independent of repository          |
| Catalog | Shipped model data                                                                  | agx maintainers                             | Installed agx version                                    |

Defaults are `tickets = ".agents/tickets"`, no readiness commands, no keep entries and no
repository verification commands. Merge order is defaults, L1, L2; later values replace each
key, and an array in a later layer replaces the earlier layer's array, with one exception:
`[ws].keep` is the union of L1 and L2 entries (duplicates removed), so L2 adds to L1's keep
list and never removes from it. L1 is optional: local-only operation needs no tracked file or
ignore rule. No repository working file supplies L2.

```toml
# L1: agx.toml, committed at trunk() (Git: HEAD)
schema = 1
tickets = "plans/tickets"

[ws]
ready = ["mise trust -q", "bun install --frozen-lockfile"]

[verify]
always = ["mise run check"]

[check]
commands = ['test -s "$AGX_TICKET_PATH"']
timeout_ms = 10000
```

L1 accepts `schema`, `tickets`, `[ws]`, `[verify]`, `[check]` and `[route]`. Its `[ws]` table
accepts `ready`, `trunk`, `keep`, `regenerable` and `unjudged_warn_hours`; `[ws].keep` is
accepted at L1. Schema must equal 1.
`[route]` accepts only `allow`, with the same meaning as the user policy key of the same
name (see [User policy and catalog](#user-policy-and-catalog)). When present, it replaces the
user policy's `route.allow` for runs whose repository is this one; every other route key stays
user-global. `default` was removed (routing never substitutes a row when Jev cannot route); a
`[route]` that sets it is rejected with a message saying the key was removed, as is any other
invalid `[route]`, before any effect. L2 rejects `[route]`.
Declarations use TOML 1.0 syntax. Unknown keys, malformed TOML, duplicate TOML keys and unsupported or missing schema fail.
Ticket paths must be nonempty relative strings; absolute POSIX and Windows paths and `~/`
are rejected at L1. Relative ticket paths resolve from the main checkout. Paths are UTF-8
strings; no canonicalization or signature is applied.

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

L2 requires absolute `root` and schema 1. It accepts `schema`, `tickets`, `[verify]` and a `[ws]`
table limited to `ready` and `keep`, plus `[usehooks]` with required `hooks`, `link_task`,
`link_path` strings and nonempty `command` string array when present. `[check]` and `[route]`
are rejected, and so are the L1-only `[ws]` keys `trunk`, `regenerable` and `unjudged_warn_hours`.
L2 `[ws].keep` is added to L1 `[ws].keep` as a set union with duplicates removed; L2 `[ws].ready`
replaces L1 `[ws].ready`. Readiness, keep and verification arrays contain nonblank strings.
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

Before a worker starts, `check` and `dispatch` run `[check].commands` in order in
the selected `--cd` workspace through `sh -c`. `AGX_TICKET_PATH` contains the
absolute ticket path. A declaration of `[check].commands` requires `[check].timeout_ms`;
the commands share that budget in milliseconds, with a permitted range of 1–10000.
A nonzero exit or timeout refuses
the ticket and reports the command and its output. Commands are repository-owned;
agx does not interpret their rules. With no commands declared, none run. The key is
repository policy only and has no local override.

Worker runs execute `[verify].always` first and then ticket verification, in order in the same
workspace. The brief includes these commands as checks to pass before returning. No declaration
adds no commands. Results carry command, exit, log path and outcome kind (`passed`, `failed`,
`unrunnable` or `killed`); repository checks carry `source = "[verify].always"`, rather than
`kind = "repo"`. Verification failures are evidence for acceptance, not a replacement for the
worker process exit. They do prevent an `ok` outcome. All verification commands run even after a
failure; capacity runs skip verification. `tools/agx-worker/src/next/run.ts` and its verification
code own execution. L1 and L3 are human-authored inputs to gated decisions; L2 is an operator-owned
local declaration. Catalog changes are reviewed and versioned with agx.

## Seeing effective values

`agx worker config [--repo <path>] [--json]` is the way to see the effective configuration. It
prints, read-only, the repository values a dispatch from `--repo` (default: the working directory)
would use with the layer each came from (`default`, `L1 <trunk agx.toml>` or `L2 <file>`, with
`ws.keep` entries labelled per layer), the user routing policy as `roster --json` computes it
(`policy` and `auto`), and the Claude credential choice (`credential`, `credential_source`, the
`claude-credits-unavailable` marker and its expiry) without the key. It writes nothing, starts no
worker and does not call Jev; a configuration error exits 2 and unavailable inspection exits 75.

## User policy and catalog

The routing reader is `tools/agx-worker/src/roster/load.ts`. It combines the catalog embedded
from `tools/agx-worker/src/roster/catalog.toml` with one user policy. A nonempty `AGX_CONFIG`
selects the policy path; otherwise nonempty `XDG_CONFIG_HOME` selects `agx/agx.toml`, otherwise
`~/.config/agx/agx.toml`. Library callers may explicitly select catalog and policy paths.
The selected file must exist and contain every required policy value. An absent, unreadable,
invalid or incomplete file fails with its path and points to policy.example.toml. The example
is not installed automatically.

Both declarations are human-authored TOML, schema 1, parsed with Bun TOML and strict validators.
Unknown keys and duplicate TOML keys fail. There is no signing or canonicalization. Operators
own policy; maintainers review and version the catalog. The catalog supplies model facts,
benchmark values, prices, use descriptions, source URLs and an `as_of` date; absent measurements
remain absent rather than being estimated. Policy must not replace catalog row values.

Policy contains explicit `[route]`, `[route.jev]` and `[claude_run]` values. The
example file shows a complete policy. `route.allow` names one or more of `codex`,
`claude-session` and `claude-api`; `route.on_window_exhausted` must name each allowed
route. The old `claude` route is rejected. A session route uses the subscription and never
resolves or passes Anthropic credentials. The API route resolves a key only when declared and
is filtered when no key resolves or its 24-hour credits marker is fresh. A credits failure
ends the attempt as capacity and routing continues to another eligible route. Declared API
candidates have the prepaid preference; the presence of a key does not enable a route.

Anthropic's prepaid API credit balance is not observable through an API, so agx cannot
know before a run whether `claude-api` will succeed. It uses `claude-api` only when
explicitly allowed; `claude-session` never uses a key. Credit exhaustion is detected
only when a run fails with a message such as `Credit balance is too low`. A run may
spend part of its budget before credits run out mid-run. The resulting marker defaults
to `~/.local/state/agx/claude-credits-unavailable`; its 24-hour pause is the fixed
`CREDITS_MARKER_TTL_MS` constant at `tools/agx-worker/src/workers/claude-credential.ts:47`,
unrelated to when credits actually renew.

The catalog stores each Claude model and effort once with its prices and scores. The loader
expands each into session and API candidates; eligibility is governed by the allow list.
Excluded IDs must exist in the catalog. Catalog IDs are unique before expansion.

`agx worker roster --json` exports the combined roster; worker routing, continuation and
preflight consume it. External integrations should use this interface rather than parse an
internal file. Price reporting reads row values from
`tools/agx-worker/src/roster/catalog.toml` through `tools/shared/src/dispatch-pricing.ts`; the
machine routing policy remains separate. There is no independent roster-path override for price
reporting. Shell-command model-floor enforcement belongs to the invoking host, not this routing
policy.

## Public roster pricing projection

`agx worker roster --json` without a ticket is the public JSON surface for the current
effective roster and pricing. It writes one JSON object to stdout and exits 0 on success.
A policy or catalog load failure exits 1 with a diagnostic on stderr and no successful
JSON; invoking roster without a ticket or `--json` exits 2. Do not interpret failed
output as an empty roster. The response has `schema: 1`, catalog `as_of` (a date, not a
live price timestamp), `auto`, `claude_run`, `sources`, `choice`, `objective`, and `policy`.
`policy.source` names the policy file. `auto.routes` contains the effective allowed routes,
including a repository override when present. Jev prices come from the catalog. Inspection
launches neither a worker nor a Jev request.

Each `choice` row exposes these pricing fields:

| Field             | JSON type                                       | Meaning                                                         |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `id`              | string                                          | Choice identifier used to join a worker row to this projection. |
| `route`           | `"codex"`, `"claude-api"` or `"claude-session"` | Execution route.                                                |
| `price_in`        | number, optional                                | USD per million uncached input tokens.                          |
| `price_cached_in` | number, optional                                | USD per million cached input tokens.                            |
| `price_out`       | number, optional                                | USD per million output tokens.                                  |

An absent price key means unknown, never zero. JSON omits missing prices rather than
emitting null or a default. A numeric zero is an explicit catalog value. The current
validator accepts numeric row prices without enforcing nonnegativity. Consumers must
preserve unknown cost for any token category whose required price is missing; they
must not substitute the uncached input price for a missing cached input price.

The effective `route.allow` projects to `auto.routes`; presence in `choice` alone does
not establish eligibility. `route.exclude` removes matching IDs from the projection.

This is a current effective projection, not a historical price catalog. Retired or
removed IDs are not retained as tombstones or aliases. If a historical run's ID is
absent, its price and estimated cost are unknown through this surface; do not map it
to a similarly named replacement or assume zero. Current prices also do not certify
the price charged for an earlier run. Consumers should use this CLI instead of
discovering or parsing private catalog files. Additive fields may be ignored;
breaking changes follow the major-version contract in [Consumer contracts](README.md).

`tools/agx-worker/tests/next/roster-pricing.test.ts` runs the source CLI with a fixture
policy and isolated state. It checks exported prices, an omitted cached-input price,
route allowance, exclusions, and retired-ID absence against actual JSON output.

### Operator input contract (schema 1)

The user policy above is the public operator input, owned and read by agx. It is distinct
from the repository-root `agx.toml`. Consumers should inspect effective values through
`agx worker roster --json` without a ticket; they should not copy the reader's schema.
Every policy key is required: `schema = 1`, `route.allow`,
`route.on_window_exhausted` (an entry for each allowed route), `route.exclude`,
`route.max_task_chars`, `route.timeout_ms`, `route.pick_temperature`,
`route.jev.api`, `route.jev.url`, `route.jev.model`,
`claude_run.max_budget_usd`, `claude_run.max_turns` and `claude_run.reason`.
Missing keys fail with a named example. Unknown keys and invalid values fail. The removed
`route.default`, `route.no_egress` and `claude_run.on_credits_unavailable` are rejected.

### Discovery, compatibility and refusal

Discovery selects exactly one file; it does not merge user policies or search upward from
the workspace. A nonempty `AGX_CONFIG` wins over `XDG_CONFIG_HOME`; an empty value is treated
as unset. With no nonempty override, use `<XDG_CONFIG_HOME>/agx/agx.toml`, or
`<homedir>/.config/agx/agx.toml` when XDG is empty or unset. Values are not trimmed, expanded
as shell expressions, or required to be absolute; a relative explicit path is read relative
to the CLI working directory. This selection is implemented in
`tools/agx-worker/src/roster/load.ts:146–155`. The example file is a deployment starting
point, never a fallback for an absent selected file.

The catalog is coupled to the installed agx version, so accepted policy IDs can change
when that version changes.

Unreadable or missing policy, malformed TOML, unknown keys, missing required keys,
unsupported schema, unknown excluded IDs, a policy that sets the removed `route.default`,
and invalid composed catalog/generation data refuse the read. The diagnostic is flattened
to one line; its exact text is not a parsing interface. See
`tools/agx-worker/src/roster/load.ts:158–257` and
`tools/agx-worker/src/next/public.ts:30–42`. Invocation errors are separate from this
configuration failure path.

Schema 1 is the current accepted format, not a promise that arbitrary older agx versions
accept every schema-1 key. Pin the agx version and validate deployed policy with the roster
command on upgrade. Breaking public contract changes require a major release; automatic
migration, old-schema acceptance, JSON Schema publication and a configuration-error exit 2
are not current guarantees. The retained requirements below describe future policy, not
additional behavior that consumers may assume today.

## Implemented workspace policy

`agx-ws` reads `[ws]` through the shared `tools/shared/src/agx-config.ts` reader. L1
repository-root `agx.toml` accepts `ready`, `trunk`, `keep` and `regenerable`; L2
`repos/*.toml` accepts `ready` and `keep`. L2 `ready` replaces L1 `ready`, while L2 `keep`
is unioned with L1 `keep`. `trunk` and `regenerable` are L1-only. Unknown keys are errors.
A repository-root `.ws.toml` is refused by agx-ws commands with exit 2 and a one-line
diagnostic containing the equivalent `[ws]` table and a direction to delete the old file.
`gc --all` reports a refused repository row and continues with the other repositories.

## Retained design requirements

These requirements preserve the intended configuration design. They are not promises of
commands or schemas that the present code does not implement.

- Shared policy should be reviewed and portable; machine paths and machine-local keep entries
  should remain outside version control (shared keep entries may live in L1). Every declaration should have one writer and one authority.
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
exercise the shared ticket home. Workspace add, rm, gc and doctor use the same L1/L2 reader for
`[ws]` policy. `tools/shared/tests/agx-config.test.ts` verifies the L1 fields and L2 merge;
`tools/agx-ws/tests/workspace.test.ts` verifies legacy refusal and command behavior, while
`tools/agx-ws/tests/gc-contract.test.ts` verifies GC inventory. Routing can be inspected with
`agx worker roster --json`; unknown exclusions, a policy that sets `route.default` and invalid policy fail loading.
Repository verification is covered by `tools/agx-worker/tests/next/run.test.ts`.

Migration status: shared L1/L2 and workspace-policy unification are implemented; legacy
price-reader removal, JSON schema publication and migration filters remain incomplete.
Historical implementation-stage labels and host deployment tasks are not public interfaces.

The intended publication names are `agx-toml.schema.json`, `repo-override.schema.json`,
`user-config.schema.json` and `roster-catalog.schema.json` in this directory. Until published,
they are design targets rather than validation authorities. Intended acceptance examples pair
worker check with workspace add JSON for identical ticket/readiness values, and pair workspace
dry-run GC with add JSON for identical keep/readiness values. The shared reader and agx-ws
fixtures now cover that workspace integration across add, gc, rm and doctor. A local-only setup
still needs policy declarations in the matching L2 repository file.

Claude workers resolve `ANTHROPIC_API_KEY` from the environment, then `fnox get
ANTHROPIC_API_KEY`, then the regular mode-0600 file
`~/.config/agx/anthropic-api-key`. The worker repeats the lookup in its own
execution environment. When API credits are unavailable the attempt ends as
outcome `capacity` with cause `credits_unavailable` and writes the 24 h marker;
on the declared API route the Claude attempt ends as capacity and the run continues on another eligible route while the marker is
fresh. With `"subscription"` the worker retries on the subscription and records
that credential, and the marker selects the subscription for 24 hours. The run
record includes the credential and API-key source, not the key.
