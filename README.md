# agx

agx operates and observes local agent sessions and runs. A suite member owns one state or is stateless; members compose through CLI commands and `--json` output, importing only their own package and `packages/core`. General filters that also accept non-agent input, and tools for machine-wide resources, display, or search, are outside the suite. The planned colocated non-member `jex` shares the Jev client in core. Consumer-facing specifications live in [contract/](contract/).

For a standalone checkout, run `mise run setup` to install locked dependencies;
`mise run up` updates them. Command installation and distribution are described in
[Suite releases](docs/release.md). For installation changes, active-run safety,
and rollback, see [Upgrading agx](docs/upgrading.md). Suite archives support
linux-x64, linux-arm64, darwin-x64, and darwin-arm64. Local library linking is documented in
[agx-usehooks](tools/agx-usehooks/README.md). Acceptance, landing, and host hook
deployment belong to the consumer repository.

Releases are prepared with `mise run release:version`, committed on alpha, then
started with `mise run release:publish -- suite --yes`. The local command pushes
alpha and both tags, then triggers the Homebrew tap formula update workflow.
GitHub Actions builds and uploads the four platform archives and the usehooks
package.

Install the released suite with Homebrew:

```sh
brew install fuyutarow/tap/agx
```

Release completion waits for the tap formula to name the new version, upgrades
this machine through Homebrew, and verifies that Homebrew's `agx` is selected
through `PATH` in the home directory and each requested consumer.

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
