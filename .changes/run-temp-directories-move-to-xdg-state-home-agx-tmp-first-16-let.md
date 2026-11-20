---
bump: patch
---

Run temp directories move to XDG_STATE_HOME/agx/tmp/<first 16 letters and digits of the run id>: the former runs/<id>/tmp path pushed Claude's Linux sandbox bridge socket past the unix socket limit, so every sandboxed Bash command failed; a sandboxed Claude worker whose TMPDIR is still too long is refused before it starts
