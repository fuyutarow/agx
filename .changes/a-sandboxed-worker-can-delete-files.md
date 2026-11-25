bump: patch

A workspace-write worker can delete files with `rip`. The graveyard it inherited is outside the sandbox, so every deletion failed with "Failed to bury file". `run` now points `GRAVEYARD` and `RIP_GRAVEYARD` at `$AGX_RUN_DIR/graveyard` for such a worker and its verification; the deleted files stay there with the run.
