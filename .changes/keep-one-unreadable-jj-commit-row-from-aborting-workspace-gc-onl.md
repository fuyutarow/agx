---
bump: patch
---

Keep one unreadable jj commit row from aborting workspace gc: only workspaces whose decision reads that commit are reported broken with its reason; the rest are classified and collected.
