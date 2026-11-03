---
bump: patch
---

Claude workspace-write workers can write the run temp directory, /tmp, and the same shared cache roots as codex, so tests that create temporary directories run under the claude route.
