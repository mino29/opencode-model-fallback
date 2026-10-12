# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-12

### Added
- `CONTRIBUTING.md` and `SECURITY.md`.
- Dependabot configuration for GitHub Actions.

### Changed
- CI and release workflows pin actions to commit SHAs and use least-privilege
  `permissions`.
- `release.yml`: tests gate an automatic tag + GitHub Release on a version bump;
  npm publishing is opt-in and tokenless via OIDC Trusted Publishing.
- Commits use a GitHub noreply identity; no personal email is published.
- Example/default chain: free models first, then paid models with
  `opencode-go/deepseek-v4-flash` first among them.

### Fixed
- Free→paid fallback stalled after a single step. Failure de-duplication keyed
  only on the error message, so a failure on the model just switched to (usually
  the same "rate limit" text) was mistaken for a duplicate and swallowed. The
  claim key now includes the current model and a successful switch clears the
  per-session throttle, so the chain keeps descending within one turn and
  actually reaches the paid section.
- A failure on a paid model could downgrade the session to a healthy free model.
  `pick` now keeps a session that is already on a paid entry inside the paid
  section until the whole paid section is benched.

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
[1.0.1]: https://github.com/mino29/opencode-model-fallback/releases/tag/v1.0.1
