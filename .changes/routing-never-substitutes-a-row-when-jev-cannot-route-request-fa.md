---
bump: patch
---

Routing never substitutes a row: when Jev cannot route (request failure, HTTP error, invalid or missing answer, invalid class, no candidate in the time box) the dispatch is refused before any effect with a 'route refused: <failed step>' first line and a recorded refusal. [route] default is removed from user and repository policy and rejected when set.
