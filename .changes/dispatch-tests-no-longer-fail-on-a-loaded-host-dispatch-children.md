---
bump: patch
---

dispatch tests no longer fail on a loaded host: dispatch children get a 30 s budget instead of bun's 5 s default, the unresolvable-ACK test stubs claude instead of calling the host registry, and the unknown-run-prefix expectation matches resolveRunId's count-only message
