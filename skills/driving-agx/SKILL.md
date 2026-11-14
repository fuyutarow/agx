---
name: driving-agx
description: >-
  Use the installed agx suite to dispatch, inspect and judge worker runs; create,
  inspect and collect tickets; manage workspaces; read suite status; and refresh
  suite health with doctor. The installed CLI help is the manual. Messaging other
  sessions belongs to Reason Network, not agx.
---

# Driving agx

Use the installed suite as the command manual. Start at `agx --help`, then
read `agx <tool> --help`, then `agx <tool> <command> --help`. Help describes
the installed suite's available commands and behavior.

Use agx worker config to see effective configuration and its sources.

Agx operates workers, tickets, workspaces, suite status and doctor. Message
other sessions through Reason Network (`send_message`, `list_team`) or
`reason-network send`.

Install the suite with `brew install fuyutarow/tap/agx`; upgrade it with
`brew upgrade fuyutarow/tap/agx`.

After each worker run ends, inspect its state and artifacts and make an explicit
acceptance judgment. A running worker does not read later edits to its brief;
stop it and continue the run when its instructions need to change.
