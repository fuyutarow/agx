---
bump: patch
---

A run whose worker ends without a final message (timeout, kill, empty output) now gets a manager-written report (source: manager) with the changed paths, last progress, last interim result and verify results instead of only an empty-message error
