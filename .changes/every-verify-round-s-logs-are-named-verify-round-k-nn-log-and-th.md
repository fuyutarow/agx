---
bump: patch
---

Every verify round's logs are named verify-round-K-NN.log, and the end notice, the ended record (new verify_round field) and agx worker ls name the round of the reported verify exits and how earlier rounds ended, so a pass in a feedback round no longer reads like a first-round pass.
