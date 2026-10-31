---
bump: patch
---

Revert re-entry through /proc/self/exe; 1.22.55 put /proc/self/exe into the systemd-run argv and every worker dispatch ended lost
