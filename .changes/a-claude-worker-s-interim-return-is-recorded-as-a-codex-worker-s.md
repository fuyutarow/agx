---
bump: patch
---

A Claude worker's interim RETURN is recorded as a progress checkpoint, as a Codex worker's always was; the Claude wrapper recorded it only when AGX_LAST_MESSAGE_FILE was set, and nothing set it. That variable is removed
