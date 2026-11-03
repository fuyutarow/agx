---
bump: patch
---

A live run's publication no longer holds the current-runs lock while it rewrites the per-workspace files, so judge and dispatch get the lock within moments instead of waiting out 30 s
