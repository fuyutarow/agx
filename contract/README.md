# Consumer contracts

The following contracts now exist:

- [Release assets](release.md): supported suite platforms and separate library releases.

- [Doctor aggregation](doctor.md): bounded refresh, JSON, exit codes and owner snapshots.
- [Configuration](config.md): repository `agx.toml`, machine-local overrides, user policy and
  the public operator;
  schema 1, `AGX_CONFIG`/XDG discovery, catalog selection, precedence, effective roster JSON,
  compatibility, refusal rules, retired declarations and implementation limits.
- [Workspace lifecycle](../tools/agx-ws/README.md): creation, readiness, refresh, removal,
  collection, locks and workspace policy. GC judges the current working-copy chain by unlanded
  content and reports differing paths; obsolete run-end commit reachability does not prevent
  collection after squash, rebase or a superseding continuation. Before any removable verdict, ignored and untracked disk content is inventoried and retained unless regenerable (node_modules directories or literal paths in the backing checkout's optional .ws.toml regenerable list). Inventory failures yield unknown and incomplete coverage; the guard is repeated under the removal lock.
  Protect a workspace with `keep = ["ws_<name>"]` in the main checkout root `.ws.toml`, for
  example `keep = ["ws_reference"]`; GC reads the working file or, when absent, its parent-revision version.
- [Ticket lifecycle](../tools/agx-ticket/README.md): issuance, derived states, landing and collection.
- [Worker contract](../tools/agx-worker/contract.md): worker execution and records.
- [Compiled runtime paths](../tools/shared/compiled-runtime.md): shipped data and runtime inputs.

JSON schemas (`ticket.schema.json`, `agx-toml.schema.json` and the configuration-layer schemas)
and dedicated `records.md`, `cli.md` and `env.md` contracts have not been published here.
Current validation lives in the code; the linked documents describe the implemented interfaces
and identify retained design requirements separately. Breaking contract changes require a major version.
