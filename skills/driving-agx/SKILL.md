---
name: driving-agx
description: >-
  Use the installed agx suite to operate local agent sessions and worker runs,
  manage tickets and workspaces, send messages, or inspect suite health. The
  installed CLI help is the manual; not for unrelated dispatch systems.
---

# Driving agx

Use the installed suite as the only command manual. Start at `agx --help`, then
read `agx <tool> --help`, then `agx <tool> <command> --help`. Help describes
the installed version; this skill intentionally does not duplicate its command
inventory or behavior.

Install the suite with `brew install fuyutarow/tap/agx`; upgrade it with
`brew upgrade fuyutarow/tap/agx`.

After each worker run ends, inspect its state and artifacts and make an explicit
acceptance judgment. A running worker does not read later edits to its brief; stop
it and continue the run when its instructions need to change.
