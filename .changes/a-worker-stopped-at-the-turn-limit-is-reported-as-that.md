bump: patch

A Claude worker that stops at the turn limit before writing its final message is now reported as that. The report used to say "the final message is JSON of the wrong shape", because agx read its own receipt as the worker's message. The manager-written report now names the turn limit, the number of turns and the setting (`claude_run.max_turns`), and lists the changed paths and verification results.
