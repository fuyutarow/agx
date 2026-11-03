---
bump: patch
---

A finished run process now exits once its ended record is written: it no longer waits for a log-replay publication under the current-runs lock (held by other writers and judges), so its workspace lock and unit end with the run; judge's lock failure names the publication lock file and its holder
