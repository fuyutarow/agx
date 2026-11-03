---
bump: patch
---

end-notice process ends by its deadline (hard timer, sender process group killed, pipes drained with a bound) and runs in its own transient unit, so a pending notice no longer keeps the run's unit active or blocks --continue
