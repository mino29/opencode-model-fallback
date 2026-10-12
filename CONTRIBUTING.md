# Contributing

Thanks for helping improve `opencode-model-fallback`. This is a small, focused
plugin; the goal is to keep it dependency-free, predictable and easy to audit.

## Prerequisites

- [Bun](https://bun.sh) — the runtime OpenCode uses and the one the tests run on.
- No other dependencies; the plugin uses only Node built-ins (`fs`, `os`, `path`).

## Development loop

```sh
git clone https://github.com/mino29/opencode-model-fallback.git
cd opencode-model-fallback
bun test/test.mjs      # or: bun run test
```

`test/test.mjs` mocks the OpenCode plugin context (`model.list`, `provider.list`,
`session.hook/get/switchModel/prompt`, `event.subscribe`) and drives both switch
mechanisms — the native `retry` hook and the failure-event stream. It exits
non-zero on the first failed assertion, so it works as a CI gate as-is.

When you change behavior, add or update a test case. Keep the two mechanisms
independent: the retry hook handles retryable failures, the event stream handles
terminal ones (e.g. the free-tier `provider.quota` limit) that the hook never
sees.

## Privacy & secret hygiene

This project is intentionally privacy-respecting. Please keep it that way:

- **Never commit secrets.** No API keys, tokens, tokens-in-URLs, or
  `.git-credentials`. The plugin needs none.
- **No personal data.** Don't hardcode home directories, usernames or email
  addresses. Use `os.homedir()` / `~` expansion and make paths configurable.
- **Commits use a private identity.** This repository is configured to commit as
  `42552577+mino29@users.noreply.github.com`. If you commit with a real address,
  set it per-repo:

  ```sh
  git config user.email "42552577+mino29@users.noreply.github.com"
  ```
- **The plugin stays offline.** It must not make network requests or collect
  telemetry. It only reads the local config, talks to the local OpenCode server,
  and writes local logs.

## Commit & PR conventions

- Small, self-contained commits with an imperative subject
  (`switch: retry when the chain head is benched`, `docs: ...`).
- Describe the failure mode being fixed and how you verified it. Live evidence
  (a log line) is ideal.
- CI (`.github/workflows/ci.yml`) must be green. Actions are pinned to commit
  SHAs; Dependabot will keep them fresh.

## Release process

Releases are automated by `.github/workflows/release.yml`:

1. Bump `version` in `package.json` and add a matching `CHANGELOG.md` entry.
2. Merge to `main`.
3. The workflow re-runs the tests, and — if `v<version>` does not already exist —
   creates an annotated tag, pushes it, and publishes a GitHub Release with
   generated notes.

Publishing to npm is **opt-in and tokenless**. To enable it, configure a
[Trusted Publisher](https://docs.npmjs.com/trusted-publishers) on npmjs.com for
this repo/workflow and set the repository variable `NPM_PUBLISH=true`. No
`NPM_TOKEN` secret is ever stored; GitHub mints a short-lived OIDC token and the
package is published with build provenance.

## Reporting security issues

Please do not open a public issue for vulnerabilities — see
[SECURITY.md](./SECURITY.md).
