---
bump: patch
---

A ticket with writes = [] no longer loses a roster row each time a run succeeds in under two minutes: a zero-change run counts as an early quit only when the ticket declares writes. The time-box refusal now names timeout_s, the rows removed at earlier stages and the fix
