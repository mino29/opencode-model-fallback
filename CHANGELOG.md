# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `CONTRIBUTING.md` and `SECURITY.md`.
- Dependabot configuration for GitHub Actions.

### Changed
- CI and release workflows pin actions to commit SHAs and use least-privilege
  `permissions`.
- `release.yml`: tests gate an automatic tag + GitHub Release on a version bump;
  npm publishing is opt-in and tokenless via OIDC Trusted Publishing.
- Commits use a GitHub noreply identity; no personal email is published.

## [1.0.0] - 2026-10-12

### Added
- Initial release.
- Fallback chain of `{providerID, id}` models, tried in order.
- `retry` hook: switches and retries on retryable provider failures (HTTP 429,
  provider-internal/transport errors).
- Event-stream handler: switches and **resumes** the turn on terminal failures
  the retry hook never sees — notably the free-tier usage limit
  (`provider.quota`).
- Structured-error classifier that never switches on content-filter, genuine
  invalid requests, unsupported operations or aborts, but does switch on
  deprecated/retired/unknown models.
- Per-model cooldown with exponential penalty and a longer auth cooldown.
- Cross-instance/cross-process claim locking plus in-process event debounce and
  throttle to avoid duplicate switches.
- Optional chained file logging (with `~/` expansion) and live config reload.
- Automatic return to the chain head on a new user prompt.
- Zero runtime dependencies (Node built-ins only).
- Self-test harness (`bun test/test.mjs`), installer/uninstaller scripts, and a
  portable example config.

[1.0.0]: https://github.com/mino29/opencode-model-fallback/releases/tag/v1.0.0
