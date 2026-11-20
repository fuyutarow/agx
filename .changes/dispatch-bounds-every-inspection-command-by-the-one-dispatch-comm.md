---
bump: patch
---

Dispatch bounds every inspection command it runs (check, the run listing and repository reads) by the one DISPATCH_COMMAND_TIMEOUT_MS, as the contract states. Check, listing and repository reads each had a fixed 60 s bound of their own that the variable did not change, and their timeout messages named bounds no one could set
