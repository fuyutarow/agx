---
bump: patch
---

The run end notice now carries the full run id, the exit code and the read command, and the manager sends it as an explicit agx-manager sender so it is relayed to claude: dispatchers instead of refused as Claude-to-Claude; tests cover ok, verify-failed, timeout, stopped, no-dispatcher and failed-send notices.
