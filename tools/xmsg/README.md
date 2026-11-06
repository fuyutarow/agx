# agx msg

`agx msg` sends one message through Reason Network. `xmsg` is an alias.
Install `reason-network` on PATH and ensure both sessions are live and registered
with Reason Network before sending.

```sh
agx msg send --from codex:<full-uuid> --to claude:<full-uuid> --message 'Hello' [--timeout-ms 60000]
```

Both addresses require `claude` or `codex` and a full canonical lowercase UUID.
The timeout covers both lookups and the send. Exit 0 prints `accepted message id
<ULID>`; exit 2 means invalid usage; exit 3 means the binary or lookup is
unavailable, or a session is unregistered; exit 4 means the outcome is unknown.
Do not resend an unknown acceptance without checking. The command never retries.
