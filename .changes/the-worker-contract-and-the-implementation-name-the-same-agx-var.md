---
bump: patch
---

The worker contract and the implementation name the same agx variables, and a test now fails when they diverge: the contract gains the variables the code already used and drops AGX_DISPATCH_WAIT_MS and AGX_TMP_ROOT, which nothing read. Removed because nothing set, read or tested them: the stall observer with AGX_WORKER_ACTIVITY_FILE and AGX_TEST_PROCESS_TREE_CPU, and AGX_DISPATCHER_VENDOR
