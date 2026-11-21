---
bump: minor
---

agx worker stats --usage jev now reports captured calls whose time is later than now under ahead_of_clock, with their call count and known tokens, instead of dropping them silently; when there are any, the complete totals are null and one stderr line gives the count, and captured_at is counted from the window end on the monotonic clock so a wall clock that moves back cannot put it earlier
