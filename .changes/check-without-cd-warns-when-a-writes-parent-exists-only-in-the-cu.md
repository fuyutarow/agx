---
bump: patch
---

agx worker check without --cd warns when a writes parent exists only in the current tree and not at trunk, where agx worker dispatch starts its workspace and refuses the ticket; the same ticket used to pass check silently and fail at dispatch
