# opencode-model-fallback

An [OpenCode](https://opencode.ai) plugin that keeps a session alive when the
model it is using starts failing. When a provider rate-limits the request or the
free-tier quota runs out, the plugin **switches the session to the next model in
a configurable fallback chain** and resumes the turn instead of just letting the
request fail.

It was written for the free OpenCode model tier (where the free usage limit is a
non-retryable `provider.quota` error) but is generic: the chain can point at any
providers/models you have configured.

---

## Features

- **Two switch mechanisms, on purpose:**
  1. **`retry` hook** — for failures OpenCode already wants to retry (HTTP 429,
     provider-internal/transport errors). The plugin benches the current model,
     switches the session and retries immediately.
  2. **Event stream** — for *terminal* failures the retry hook never sees. The
     important one is the free-tier usage limit, emitted as
     `provider.quota`. The plugin listens for session failure events, benches +
     switches the model, then **resumes** the turn.
- **Fallback chain** — an ordered list of `{providerID, id}` entries. The plugin
  picks the first healthy, not-benched, not-already-tried entry.
- **Per-model cooldown / bench** with exponential penalty for consecutive
  failures, plus a longer cooldown for auth failures.
- **Cross-instance de-duplication** — an exclusive lock file keyed by
  session+failure ensures only one copy switches when OpenCode loads the plugin
  more than once (global discovery + per-process), plus in-process debounce so a
  burst of failure events triggers a single switch.
- **Smart classification** — never switches on content-filter, genuine invalid
  requests, unsupported operations or aborts; *does* switch on
  deprecated/unknown/no-longer-available models (a model problem, not a request
  problem).
- **Restores the chain head on a new prompt** so a new turn starts from the
  preferred (usually free) model again.
- **Zero dependencies** — only Node built-ins (`fs`, `os`, `path`).
- **Live config reload** — edits to `model-fallback.json` are picked up without
  restarting.

---

## Requirements

- OpenCode V2 (server `>= 2.0.21`).
- No install-time dependencies. Tests use [Bun](https://bun.sh), the runtime
  OpenCode uses.

---

## Install

### Option A — copy the folder (simplest)

OpenCode auto-discovers plugins under the global plugins directory:

```
~/.config/opencode/plugins/<anything>/index.js
```

So:

1. Copy this folder to `~/.config/opencode/plugins/opencode-model-fallback/`
   (or run the bundled installer, see Option C).
2. Put a config at `~/.config/opencode/model-fallback.json`
   (copy `model-fallback.example.json` and edit the chain).
3. Restart OpenCode.

### Option B — reference it by path or as a package

In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    // local directory
    "/home/me/opencode-model-fallback",
    // or a file URL
    // "file:///home/me/opencode-model-fallback",
    // or a published npm package
    // "opencode-model-fallback",
    // or a pinned version
    // "opencode-model-fallback@1.0.0"
  ]
}
```

> If you install by directory (Option A) do **not** also add it to `plugins` —
> global plugins are auto-discovered, and listing it too can load it twice.

### Option C — installer script

```sh
./install.sh
# or into a custom config dir:
OPENCODE_CONFIG_DIR=/path/to/opencode-config ./install.sh
```

`install.sh` copies the plugin into
`$CONFIG_DIR/plugins/opencode-model-fallback/` and creates
`$CONFIG_DIR/model-fallback.json` from the example **only if one does not already
exist** (your chain is never overwritten). `uninstall.sh` removes the plugin
directory and leaves the config file in place.

---

## Configuration

The plugin looks for a config in this order (first match wins):

1. `$OPENCODE_CONFIG_DIR/model-fallback.json`
2. `~/.config/opencode/model-fallback.json`
3. `<project>/.opencode/model-fallback.json`

```jsonc
{
  "enabled": true,
  // How long a failed model is benched, in ms.
  "cooldownMs": 1800000,
  // Upper bound for the exponential bench, in ms.
  "cooldownMaxMs": 21600000,
  // Bench multiplier applied for consecutive failures of the same model.
  "consecutivePenalty": 2,
  // Minimum bench for auth failures (401/403/etc.).
  "authCooldownMs": 7200000,
  // Switch back to chain[0] on the next real user prompt (if healthy).
  "restoreChainHeadOnNewPrompt": true,
  // Re-read the config file every N ms.
  "reloadMs": 15000,
  // Collapse a burst of failure events (step.failed + execution.failed + error)
  // into one switch.
  "eventDebounceMs": 1200,
  // Ignore further failures for a session for this long after handling one.
  "eventThrottleMs": 5000,
  // Optional log file. A leading "~/" is expanded to your home directory.
  // Empty string = console only (OpenCode captures console output).
  "logFile": "~/.local/share/opencode/log/model-fallback.log",
  // Ordered fallback chain.
  "chain": [
    { "providerID": "opencode", "id": "step-5-preview-free" },
    { "providerID": "opencode-go", "id": "deepseek-v4-pro" }
  ]
}
```

Only `chain` is really required; everything else falls back to the defaults
shown above. The chain is validated at load time (`{providerID, id}` objects) —
an invalid file logs an error and the previous config is kept.

---

## How it works

```
provider failure
      │
      ├── retryable (429, provider-internal, transport, …)
      │        └─ retry hook ──▶ bench current ─▶ switch ─▶ retry (delay 0)
      │
      └── terminal (quota, auth, invalid-output, …)
               └─ session.*.failed event ──▶ classify ─▶ bench current
                       ─▶ switch ─▶ schedule resume (session.prompt {resume:true})
```

The classifier maps OpenCode's structured error types
(`provider.rate-limit`, `provider.quota`, `provider.auth`, `provider.no-route`,
`provider.invalid-output`, …) to "switch", and explicitly ignores
`provider.content-filter`, `provider.invalid-request`,
`provider.unsupported-operation` and `aborted`. Messages that indicate a
retired/deprecated/unknown model override the "invalid request" verdict and are
treated as switch-worthy.

---

## Logging & troubleshooting

Set `logFile` to get a dedicated log (recommended). Lines look like:

```
[2026-10-12T13:40:49.000Z] armed: chain=13 head=opencode/step-5-preview-free tail=opencode/deepseek-v4-pro
[2026-10-12T13:41:02.000Z] config loaded from /home/me/.config/opencode/model-fallback.json (chain=13)
[2026-10-12T13:41:10.000Z] switch ses_ed194bf7 opencode/step-5-preview-free -> opencode/ling-3.1-flash-free (retry rate status=429 streak=1 bench=1800s)
[2026-10-12T13:41:10.000Z] switch ses_ed194bf7 opencode/space-bunny-free -> opencode/step-5-preview-free (event rate type=provider.invalid-output streak=1 bench=1800s)
[2026-10-12T13:41:10.000Z] resumed ses_ed194bf7
```

- `armed: chain=0` → no config found; check the search paths above.
- `chain provider X: NOT FOUND in the provider list` → that provider isn't
  configured in OpenCode; entries for it are skipped.
- `event: no fallback left …` → every chain entry is benched/tried; the plugin
  waits out the cooldown and resumes.
- When `logFile` is empty, the same lines go to stdout, which OpenCode records in
  its own log (`~/.local/share/opencode/log/`).

---

## Development

```sh
bun test/test.mjs   # or: bun run test
```

The harness mocks the OpenCode plugin context and drives both mechanisms; it
exits non-zero on the first failure. It covers rate/auth retries, chain
advancing, transient-error ignoring, the quota event path (+ resume), event
de-duplication, content-filter/invalid-request non-switching, deprecated-model
switching, and cross-instance claim locking.

---

## Packaging / using on another machine

- **Folder**: copy this directory over and run `install.sh`.
- **Tarball**: `npm pack` (or `tar czf`) and extract on the target, then
  `install.sh`.
- **npm**: publish with `npm publish` (adjust `name`/`license` first), then add
  `"opencode-model-fallback"` to your `plugins` array or let OpenCode resolve it.

## Uninstall

```sh
./uninstall.sh
```

Then delete `~/.config/opencode/model-fallback.json` if you no longer want it.

## License

MIT — see [LICENSE](./LICENSE).
