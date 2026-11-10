---
bump: minor
---

A Claude API credit failure no longer moves worker load onto the Claude subscription: the run ends the attempt as capacity (credits_unavailable) and continues on the next eligible row, claude rows stay out of routing while the 24 h marker is fresh, and policy key claude_run.on_credits_unavailable = "subscription" restores the in-process subscription retry
