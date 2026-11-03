---
bump: patch
---

agx worker dispatch exits as soon as its receipt is written: it no longer schedules a run-publication for its dispatching record, so it no longer waits after the receipt on a full log replay and a publication lock held by other dispatches (the run's own started record publishes the snapshot)
