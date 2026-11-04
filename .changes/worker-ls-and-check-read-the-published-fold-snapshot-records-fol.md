---
bump: patch
---

worker ls and check read the published fold snapshot (records.snapshot.json, identified by log inode, folded length and the hash of its last record) plus the appended tail instead of re-folding the whole log; check no longer replays every record for its overlap warning: on the real state dir ls --json user CPU 3.7 s to 1.7 s and check 3.9 s to 1.0 s, output byte-identical to a full fold
