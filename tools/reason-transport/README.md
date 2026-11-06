# Reason Network transport

`Session.open({ binary, session, deadlineMs })` starts the supplied Reason Network binary as an MCP server. Supply a stable session name and a positive deadline for every operation. The caller must close the returned session.

Missing or empty required arguments and deadlines outside the positive finite timer range (up to 2,147,483,647 ms) return `usage` before starting or calling the server. Failure to start or initialize the server, or a missing required MCP tool, returns `unavailable`.

`send({ to, message, idempotencyKey, deadlineMs })` returns an accepted result only with a message ID. If its result is unknown, resend the identical message with the same idempotency key and stable session name to settle it. Reusing a key for a different message is invalid. A refusal is reported only for a recognized pre-dispatch error; other tool errors and lost replies are unknown and preserve available server text. `status(ids, deadlineMs)` reads outgoing receipt status, and `address(deadlineMs)` reads the current session's address. Acceptance does not mean the recipient read the message.
