# Reason Network transport

`lookupAddress({ binary, vendor, session, deadlineMs })` resolves a live local session by vendor (`codex` or `claude`) and vendor session ID using `reason-network who --json`. It returns the single `is_me` address, `refused` when the session is not registered or live, and `unknown` for multiple matches or a deadline. A failed command or invalid directory JSON is `unavailable`. Missing or empty arguments and a deadline outside the positive finite timer range (up to 2,147,483,647 ms) return `usage` before a process starts. It does not register a session or open MCP.

`parseProse("send", text)` returns the message ID of a `reason-network send` result: exactly one `message id <ULID>` line, otherwise `undefined`.

This package owns no session. Delivery and sender identity belong to Reason Network: callers send with the `reason-network send` command.
