---
bump: patch
---

When a ticket declares no min_class and the two most probable routing answers differ by less than 0.15, routing prints one stderr line naming both answers and the min_class field; the row and exit code are unchanged, and the routing audit records the difference as class_margin
