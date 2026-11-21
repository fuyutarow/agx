---
bump: minor
---

agx worker stats --routing now counts routing events whose time is later than now under ahead_of_clock_events and prints one stderr line with the count, instead of leaving them out of the interval without a word
