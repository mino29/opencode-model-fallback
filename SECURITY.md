# Security Policy

## Supported versions

The latest `1.x` release receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or PRs.**

Use GitHub's private vulnerability reporting: go to the repository's
**Security** tab and choose **Report a vulnerability**. That opens a private
advisory visible only to the maintainers. If you cannot use that flow, contact
the maintainer privately via the GitHub profile [@mino29](https://github.com/mino29).

Please include:

- what the issue is and its impact,
- steps or a proof of concept to reproduce it,
- the affected version and environment.

You can expect an acknowledgement within a few days. Coordinated disclosure is
appreciated; we will credit you in the advisory unless you prefer otherwise.

## Scope and design notes

`opencode-model-fallback` is a local OpenCode plugin. Its security-relevant
properties are deliberately small:

- **No network access.** The plugin makes no outbound requests and collects no
  telemetry. It calls only the local OpenCode plugin API and reads/writes local
  files.
- **No secrets.** It stores no credentials and reads none. Provider credentials
  are handled entirely by OpenCode.
- **Local inputs only.** It reads `model-fallback.json` (from
  `$OPENCODE_CONFIG_DIR`, `~/.config/opencode`, or `<project>/.opencode`) and,
  if `logFile` is set, appends log lines to that path. Treat the config file and
  log path as you would any other local file you own.
- **Cross-process lock files** are created under the OS temp directory
  (`os.tmpdir()/opencode-model-fallback-locks`) solely to de-duplicate switches
  between concurrently loaded plugin copies.

Supply-chain hardening of the repository itself:

- Workflow actions are pinned to commit SHAs and kept current by Dependabot.
- Workflows run with least-privilege `permissions`; npm publishing is opt-in and
  uses OIDC Trusted Publishing (no long-lived tokens).
- Commits use a GitHub noreply identity, so no personal email is published.
