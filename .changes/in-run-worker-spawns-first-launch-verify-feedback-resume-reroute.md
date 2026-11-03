---
bump: patch
---

In-run worker spawns (first launch, verify-feedback resume, reroute) resolve a Homebrew Cellar path to the opt link so a run survives an agx upgrade; each spawn's executable is recorded in spawn-NN.json
