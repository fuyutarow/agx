# SEP-S5C2-LINT-CONTRACT-1023

Outcome: both required gates pass. No lint rule was disabled, narrowed or changed.

## Failure and correction

Initial `mise run lint:all` exited 2 before checking files: the root and nested preset registered the same plugin name from different module paths. The root now uses the preset's module path, matching the source workspace's registration. After this one-path correction, the copied suite passed across 201 files. The final count is 202 because one regression test was added; this is the linter's checked-file count, not a test count. An independent comparison confirmed identical rule severities, selectors, options, categories and overrides against the source preset after removing diagnostic-message text; plugin bytes also match. Copied suite code was not edited.

Initial `mise run mise:contract` exited 1 with 30 hard findings:

| Findings                                                                                                         | Disposition                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service inspection/launch in jobs, dispatch, lease and resource probe; process inspection in lifecycle and lease | Declare host `systemctl`, `systemd-run`, `ps` with reasons.                                                                                                          |
| Repository fixture setup in run, ticket-home and ticket-repo tests                                               | Declare host `git`.                                                                                                                                                  |
| Workspace cleanup and cleanup tests                                                                              | Declare host `rip`.                                                                                                                                                  |
| Workspace's two local entrypoint probes                                                                          | Recognize root package binary declarations after checking that their target exists inside the repository.                                                            |
| Workspace and reference-lock process fixtures                                                                    | Declare host `sleep`.                                                                                                                                                |
| Read-only executor and open-reference inspection                                                                 | Declare `/usr/bin/sandbox-exec` and `lsof`.                                                                                                                          |
| Two optional secret-store calls                                                                                  | Declare host `fnox`.                                                                                                                                                 |
| Terminal fixture                                                                                                 | Declare host `stty`.                                                                                                                                                 |
| Two session-inventory providers                                                                                  | Declare both host provider commands.                                                                                                                                 |
| `2>`, `1`, `9<`                                                                                                  | False positives: shell redirection operators/targets, not executables. Parse them as redirections while continuing to inspect substitutions and subsequent commands. |

Declarations live in recognized `[vars]` entries named `host_command:<executable>`; every value must contain a reason. This separates host integrations from versioned runtime provisioning. Unknown commands remain hard findings. Earlier iterations tried a custom top-level table (runner warning) and a nested variable table (runner rejection); both were replaced. A lint finding in new code (nesting depth 3) was corrected by extracting local-binary validation, preserving the rule.

Regression tests exercise the exact redirection forms above, unknown commands after/before redirections, nested shell commands, substitutions in redirect targets, declared host commands, existing/missing local binary targets and an empty declaration reason. Fixtures only contain command text; no fixture subprocess runs.

## Verification

All commands ran in the foreground.

| Command                                                                                                                        | Exit and result                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `mise run lint:all`                                                                                                            | Initial 2; after plugin correction 0; intermediate new-code nesting finding 1; final 0, 202 files, no diagnostics.                |
| `bun lint-oxlint.ts --type-aware tools/mise-contract.ts`                                                                       | Intermediate 1, nesting finding subsequently corrected.                                                                           |
| `mise run mise:contract`                                                                                                       | Initial 1, 30 hard; after authority/parser correction 0; nested variable experiment 1; final 0, 0 hard / 2 existing pin warnings. |
| `bun test tools/mise-contract.test.ts`                                                                                         | Three runs, all 0; 2 tests / 10 assertions pass. Negative fixtures prove undeclared commands still produce findings.              |
| `bun x --bun --no-install oxfmt --check tools/mise-contract.ts tools/mise-contract.test.ts`                                    | 0, both formatted.                                                                                                                |
| `bun /home/fuyu/.agents/skills/writing-bun-scripts/scripts/script-check.ts tools/mise-contract.ts tools/mise-contract.test.ts` | Three runs, all 0; no failures, two warnings: inherited checker shebang and command strings in fixture data.                      |
| `bun -e '<source-preset rule/options/plugin comparison>'`                                                                      | 0, rule semantics and plugin bytes match.                                                                                         |
| `mise run lint:all && mise run mise:contract`                                                                                  | Final required combined run: 0.                                                                                                   |

Final combined-run tail:

```text
{ "diagnostics": [], "number_of_files": 202 }
lint-oxlint: checked 202 file(s)
OK    tools: bun declared (used by 11 task(s))
WARN  pin: formatter = "0.2.78" is a patch pin
WARN  pin: version-control tool = "0.46.0" is a patch pin
mise-contract: 0 hard, 2 warn
```

Exact final individual gate output is retained in `lint-final.log` and `contract-final.log` beside this report. The abbreviated tail above generalizes tool names; those logs preserve raw output.

Housekeeping: no tool release version or changelog change is needed for repository-only gate wiring. No changeset was created. The test sits beside its checker and uses temporary directories removed by teardown. No commit was attempted; broader check stages belong to sibling workspaces.

Completion ACK: exactly one authorized send attempted:

```text
xmsg send --to claude:agx-agt_df65 --message 'SEP-S5C2-LINT-CONTRACT-1023: completed successfully; result .agent-state/sep-s5c2-lint-contract-1023/result.md; mise run lint:all && mise run mise:contract exit 0 (202 files, zero diagnostics; zero hard findings, two existing pin warnings); remaining none within scope.'
exit: 4
xmsg: acceptance unknown (no confirmed SendMessage tool_result); do not resend without checking
```

No retry was made. Gate work is complete; ACK delivery remains unconfirmed.
