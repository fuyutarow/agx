---
bump: patch
---

Dispatch waits for agx ws add's own whole-command deadline (WS_ADD_TIMEOUT_MS, default 900 s, plus 30 s) instead of killing it at the 60 s inspection bound, which left a slow checkout on a large working copy half-made and unreported
