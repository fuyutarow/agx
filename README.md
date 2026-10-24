# agx

agx operates and observes local agent sessions and runs. A suite member owns one state or is stateless; members compose through CLI commands and `--json` output, importing only their own package and `packages/core`. General filters that also accept non-agent input, and tools for machine-wide resources, display, or search, are outside the suite. The planned colocated non-member `jex` shares the Jev client in core. Consumer-facing specifications live in [contract/](contract/); this repository currently contains only its independent build and gate skeleton.

## Agent skill

Install the suite-wide skill with the open skills CLI:

```sh
bunx skills add fuyutarow/agx
```

For Claude Code specifically:

```sh
bunx skills add fuyutarow/agx --skill driving-agx -a claude-code
```

[driving-agx](skills/driving-agx/SKILL.md) covers workers, tickets, workspaces,
messaging and health. It supersedes the separate driving-xmsg skill; use the
skill from the same release tag as your installed suite.
