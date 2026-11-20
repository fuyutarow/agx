---
bump: patch
---

Only workspace changes within the ticket's writes count toward ok, as the contract states; changes elsewhere, such as a lint cache written by verification, are listed in workspace_changes.outside_writes and no longer turn a run that changed nothing into ok
