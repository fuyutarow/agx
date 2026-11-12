---
bump: patch
---

Recognize the Claude CLI result text "Credit balance is too low" (with or without "is") as credit exhaustion, so the claude-credits-unavailable marker is written and the run moves to another row.
