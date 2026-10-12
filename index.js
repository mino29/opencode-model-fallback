// @bun
// Model fallback plugin for OpenCode V2 (server >= 2.0.21).
//
// There are TWO independent mechanisms here on purpose, because OpenCode only
// invokes the `retry` hook for *retryable* failures:
//
//   1. retry hook  -> provider failures OpenCode already wants to retry
//                     (HTTP 429 RateLimit, ProviderInternal, Transport, ...).
//                     The hook benches the current model, switches the session
//                     to the next chain entry and retries with delay 0.
//
//   2. event stream -> terminal failures OpenCode does NOT retry. The important
//                     one is the free-tier usage limit, which is classified as
//                     AI.Error.QuotaExceeded -> structured type "provider.quota".
//                     For those failures the retry hook is never called, so the
//                     plugin listens for session failure events, benches the
//                     model, switches to the next chain entry and resumes the
//                     turn. Without this the plugin appears to "do nothing" and
//                     the free model just gets throttled.
//
// Config: ~/.config/opencode/model-fallback.json (chain of {providerID, id}).
import fs from "fs";
import os from "os";
import path from "path";
// Kept in step with package.json; surfaced in the startup log so the loaded
// version of a running server can be identified and plugin hot-reloads verified.
var PLUGIN_VERSION = "1.0.1";

var DEFAULTS = {
  enabled: true,
  cooldownMs: 1800000,
  cooldownMaxMs: 21600000,
  consecutivePenalty: 2,
  authCooldownMs: 7200000,
  restoreChainHeadOnNewPrompt: true,
  reloadMs: 15000,
  eventDebounceMs: 1200,
  eventThrottleMs: 5000,
  logFile: "",
  chain: []
};
var HARD_ATTEMPT_CEILING = 5;
var RATE_PATTERNS = [
  /\b429\b/,
  /rate[\s_-]*limit/i,
  /too many requests/i,
  /quota/i,
  /usage limit/i,
  /resource[\s_-]*exhausted/i,
  /try again later/i,
  /overloaded/i,
  /capacity/i,
  /high concurrency/i
];
var AUTH_PATTERNS = [
  /invalid credential/i,
  /invalid api key/i,
  /unauthorized/i,
  /authentication/i,
  /\b401\b/,
  /\b403\b/,
  /forbidden/i
];
var TRANSIENT_PATTERNS = [
  /endpoint is unavailable/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /temporarily unavailable/i
];
// Structured error types (Session.StructuredError.type) that must NEVER trigger
// a model switch: the request/response itself is the problem, not the model.
var NO_SWITCH_TYPES = new Set([
  "provider.content-filter",
  "provider.invalid-request",
  "provider.unsupported-operation",
  "aborted"
]);
function classify(error) {
  if (!error || typeof error !== "object")
    return null;
  const status = typeof error.status === "number" ? error.status : undefined;
  if (status === 429)
    return "rate";
  if (status === 401 || status === 403)
    return "auth";
  const text = `${error.type ?? ""} ${error.message ?? ""} ${error.response?.body ?? ""}`;
  if (RATE_PATTERNS.some((p) => p.test(text)))
    return "rate";
  if (AUTH_PATTERNS.some((p) => p.test(text)))
    return "auth";
  if (TRANSIENT_PATTERNS.some((p) => p.test(text)))
    return "transient";
  return null;
}
// A retired / unknown / unavailable model is a *model* problem even when the
// server classifies the failure as an invalid request: switching to another
// chain entry fixes it, so it must be treated as switch-worthy.
var MODEL_GONE_PATTERNS = [
  /deprecat/i,
  /no longer (available|supported)/i,
  /has been (retired|removed|disabled)/i,
  /unknown model/i,
  /model .*(not found|unavailable|does not exist)/i
];
// Classifier used for terminal failure events emitted by the server. Accepts
// the already-normalised Session.StructuredError ({type,message,status?}) and
// falls back to the message/status heuristic above.
function classifyFailure(error) {
  if (!error || typeof error !== "object")
    return null;
  const type = String(error.type ?? "").toLowerCase();
  const message = String(error.message ?? "");
  if (MODEL_GONE_PATTERNS.some((p) => p.test(message)))
    return "rate";
  if (NO_SWITCH_TYPES.has(type))
    return null;
  if (type === "provider.auth")
    return "auth";
  if (type.startsWith("provider."))
    return "rate";
  return classify(error);
}
var keyOf = (ref) => `${ref.providerID}/${ref.id}`;
function isModelList(value) {
  return Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === "object" && typeof entry.providerID === "string" && typeof entry.id === "string");
}
var FAILURE_EVENTS = new Set([
  "session.execution.failed",
  "session.step.failed",
  "session.error"
]);
var GUARD = Symbol.for("opencode.model-fallback.cleanup");
function priorCleanup() {
  return globalThis[GUARD];
}
function setCleanup(fn) {
  globalThis[GUARD] = fn;
}

var src_default = {
  id: "model-fallback",
  async setup(ctx) {
    const stale = priorCleanup();
    if (stale) {
      try {
        await stale();
      } catch {}
      setCleanup(undefined);
    }
    const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
    const searchPaths = [
      path.join(configDir, "model-fallback.json"),
      path.join(ctx?.location?.directory ?? ".", ".opencode", "model-fallback.json")
    ];
    let cfg = { ...DEFAULTS, chain: [] };
    let loadedFrom = "";
    let lastRaw = null;
    const log = (message) => {
      const line = `[${new Date().toISOString()}] ${message}`;
      try {
        console.log(line);
      } catch {}
      if (cfg.logFile) {
        try {
          const file = String(cfg.logFile).replace(/^~(?=$|[\\/])/, os.homedir());
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, line + "\n");
        } catch {}
      }
    };
    const load = (force = false) => {
      for (const candidate of searchPaths) {
        let raw;
        try {
          raw = fs.readFileSync(candidate, "utf8");
        } catch {
          continue;
        }
        if (!force && loadedFrom === candidate && raw === lastRaw)
          return;
        try {
          const parsed = JSON.parse(raw);
          if (!isModelList(parsed.chain))
            throw new Error("chain must be an array of {providerID,id}");
          cfg = { ...DEFAULTS, ...parsed, chain: parsed.chain };
          loadedFrom = candidate;
          lastRaw = raw;
          log(`config ${force ? "loaded" : "reloaded"} from ${candidate} (chain=${cfg.chain.length})`);
          return;
        } catch (error) {
          lastRaw = raw;
          log(`config error in ${candidate}: ${error?.message ?? error}; keeping previous config`);
          return;
        }
      }
      if (force) {
        cfg = { ...DEFAULTS, chain: [] };
        loadedFrom = "";
        lastRaw = null;
        log(`no model-fallback.json found in ${searchPaths.join(", ")}; plugin idle`);
      }
    };
    load(true);
    const reloadTimer = setInterval(() => load(false), Math.max(250, cfg.reloadMs));
    reloadTimer.unref?.();

    const cooldown = new Map();
    const streaks = new Map();
    const walked = new Map();
    const waits = new Map();
    const displaced = new Set();
    const resumeTimers = new Map();
    const failureTimers = new Map();
    const handlingUntil = new Map();
    let lastRejections = "";

    // Cross-instance / cross-process de-duplication. OpenCode can end up with
    // more than one live copy of a global plugin (one per discovered location
    // and/or process), and a single failure would then switch the model twice.
    // An exclusive lock file keyed by session + failure lets exactly one copy
    // act; the lock goes stale after lockTtlMs so a genuine later failure on the
    // newly selected model can still be handled.
    const LOCK_DIR = path.join(os.tmpdir(), "opencode-model-fallback-locks");
    const LOCK_TTL_MS = 3000;
    const LOCK_MAX_AGE_MS = 120000;
    const fingerprint = (text) => {
      let hash = 0;
      for (let i = 0; i < text.length; i++)
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
      return (hash >>> 0).toString(36);
    };
    const claim = (sessionID, failure) => {
      try {
        fs.mkdirSync(LOCK_DIR, { recursive: true });
      } catch {}
      const now = Date.now();
      try {
        for (const entry of fs.readdirSync(LOCK_DIR)) {
          const candidate = path.join(LOCK_DIR, entry);
          try {
            if (now - fs.statSync(candidate).mtimeMs > LOCK_MAX_AGE_MS)
              fs.unlinkSync(candidate);
          } catch {}
        }
      } catch {}
      const name = `${sessionID}__${failure}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) + ".lock";
      const file = path.join(LOCK_DIR, name);
      const write = () => {
        const fd = fs.openSync(file, "wx");
        fs.writeSync(fd, `${process.pid} ${now}`);
        fs.closeSync(fd);
      };
      try {
        write();
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST")
          return true;
      }
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > LOCK_TTL_MS) {
          fs.unlinkSync(file);
          write();
          return true;
        }
      } catch {}
      return false;
    };

    const bench = (ref, failure) => {
      const key = keyOf(ref);
      const streak = (streaks.get(key) ?? 0) + 1;
      streaks.set(key, streak);
      const base = failure === "auth" ? Math.max(cfg.authCooldownMs, cfg.cooldownMs) : Math.max(1000, cfg.cooldownMs);
      const duration = Math.min(cfg.cooldownMaxMs, base * cfg.consecutivePenalty ** (streak - 1));
      const until = Date.now() + duration;
      cooldown.set(key, until);
      return { streak, duration, until };
    };

    // V2: ctx.model.list() is async and returns { location, data: ModelInfo[] }.
    const isAvailable = async (ref) => {
      try {
        const out = await ctx.model.list();
        const list = out?.data ?? [];
        const found = list.find((m) =>
          m.providerID === ref.providerID && (m.id === ref.id || m.modelID === ref.id)
        );
        return Boolean(found) && found.enabled !== false;
      } catch {
        return false;
      }
    };

    // V2: ctx.provider.list() is async and returns { location, data: ProviderInfo[] }.
    // Audit is best-effort and must never crash plugin setup.
    const auditProviders = async () => {
      try {
        const [pOut, mOut] = await Promise.all([ctx.provider.list(), ctx.model.list()]);
        const providers = pOut?.data ?? [];
        const models = mOut?.data ?? [];
        const byID = new Map(providers.map((p) => [p?.id, p]));
        for (const providerID of new Set(cfg.chain.map((entry) => entry.providerID))) {
          const record = byID.get(providerID);
          if (!record) {
            log(`chain provider ${providerID}: NOT FOUND in the provider list`);
            continue;
          }
          const count = models.filter((m) => m.providerID === providerID).length;
          log(`chain provider ${providerID}: offers ${count} models (activation=${record.activation ?? "?"})`);
        }
      } catch (error) {
        log(`provider audit skipped: ${error?.message ?? error}`);
      }
    };

    // A chain entry is "free" when its id ends in "-free" (every free model in
    // the OpenCode catalog does; paid models never do). Used so that a fallback
    // already running on a paid model never silently downgrades to a free one.
    const isFreeRef = (ref) => /-free$/i.test(String(ref?.id ?? ""));
    const pick = async (sessionID, current) => {
      const now = Date.now();
      const seen = walked.get(sessionID);
      const rejected = new Map();
      const reject = (reason, key) => {
        let set = rejected.get(reason);
        if (!set) {
          set = new Set();
          rejected.set(reason, set);
        }
        set.add(key);
      };
      const tryRef = async (ref) => {
        const key = keyOf(ref);
        if (current && key === keyOf(current)) {
          reject("current", key);
          return undefined;
        }
        if (seen?.has(key)) {
          reject("already-tried", key);
          return undefined;
        }
        const until = cooldown.get(key) ?? 0;
        if (until > now) {
          reject(`benched-${Math.ceil((until - now) / 60000)}m`, key);
          return undefined;
        }
        const available = await isAvailable(ref);
        if (!available) {
          reject("unavailable", key);
          return undefined;
        }
        return ref;
      };
      const scan = async (entries) => {
        for (const ref of entries) {
          const hit = await tryRef(ref);
          if (hit) return hit;
        }
        return undefined;
      };
      let target;
      // Already on a paid model: stay in the paid section if anything there is
      // healthy, so we never bounce from paid back to a healthy free model.
      if (current && !isFreeRef(current)) {
        target = await scan(cfg.chain.filter((ref) => !isFreeRef(ref)));
        if (target) {
          lastRejections = "";
          return target;
        }
      }
      target = await scan(cfg.chain);
      lastRejections = [...rejected.entries()]
        .map(([reason, keys]) => `${reason}: ${[...keys].join(", ")}`)
        .join(" | ");
      return target;
    };

    const clearResume = (sessionID) => {
      const timer = resumeTimers.get(sessionID);
      if (timer) {
        clearTimeout(timer);
        resumeTimers.delete(sessionID);
      }
    };
    const scheduleResume = (sessionID, delay) => {
      clearResume(sessionID);
      const timer = setTimeout(() => {
        resumeTimers.delete(sessionID);
        Promise.resolve()
          .then(() => ctx.session.prompt({ sessionID, text: "", resume: true }))
          .then(() => log(`resumed ${sessionID.slice(0, 12)}`))
          .catch((error) => log(`resume of ${sessionID.slice(0, 12)} failed: ${error?.message ?? error}`));
      }, delay + 250);
      timer.unref?.();
      resumeTimers.set(sessionID, timer);
    };
    const switchTo = async (sessionID, from, to, note) => {
      await ctx.session.switchModel({
        sessionID,
        model: { providerID: to.providerID, id: to.id }
      });
      displaced.add(sessionID);
      // A switch resolves the failure that triggered it: drop the throttle so a
      // genuine failure on the *new* model is handled right away instead of
      // being swallowed (which used to stall the cascade at one step).
      handlingUntil.delete(sessionID);
      const fromText = from ? keyOf(from) : "unknown";
      log(`switch ${sessionID.slice(0, 12)} ${fromText} -> ${keyOf(to)} (${note})`);
    };

    const currentModelOf = async (sessionID) => {
      const session = await ctx.session.get({ sessionID });
      const model = session?.model;
      if (!model || typeof model.providerID !== "string" || typeof model.id !== "string")
        return undefined;
      return { providerID: model.providerID, id: model.id };
    };

    // ---------------------------------------------------------------------
    // Mechanism 1: retry hook (retryable provider failures only).
    // ---------------------------------------------------------------------
    const retryRegistration = await ctx.session.hook("retry", async (event) => {
      if (!cfg.enabled || cfg.chain.length === 0)
        return;
      const failure = classify(event.error);
      if (failure === null || failure === "transient")
        return;
      const sessionID = event.sessionID;
      const current = {
        providerID: event.model.providerID,
        id: event.model.id
      };
      clearResume(sessionID);
      const { streak, duration } = bench(current, failure);
      let seen = walked.get(sessionID);
      if (!seen) {
        seen = new Set();
        walked.set(sessionID, seen);
      }
      seen.add(keyOf(current));
      const reason = `${failure} status=${event.error?.status ?? "?"} streak=${streak} bench=${Math.round(duration / 1000)}s`;
      const target = await pick(sessionID, current);
      if (!target) {
        const count = (waits.get(sessionID) ?? 0) + 1;
        waits.set(sessionID, count);
        const delay = Math.min(cfg.cooldownMs * count, cfg.cooldownMaxMs);
        event.decision = { retry: true, delay };
        log(`retry: no fallback left for ${sessionID.slice(0, 12)}; waiting ${Math.round(delay / 1000)}s (${reason}) rejected -> ${lastRejections || "none"}`);
        if (event.attempt >= HARD_ATTEMPT_CEILING)
          scheduleResume(sessionID, delay);
        return;
      }
      try {
        await switchTo(sessionID, current, target, `retry ${reason}`);
        event.decision = { retry: true, delay: 0 };
      } catch (error) {
        seen.add(keyOf(target));
        const delay = Math.min(cfg.cooldownMs * 2, cfg.cooldownMaxMs);
        event.decision = { retry: true, delay };
        log(`retry: switch to ${keyOf(target)} failed: ${error?.message ?? error}; waiting ${Math.round(delay / 1000)}s`);
        if (event.attempt >= HARD_ATTEMPT_CEILING)
          scheduleResume(sessionID, delay);
        return;
      }
      if (event.attempt >= HARD_ATTEMPT_CEILING)
        scheduleResume(sessionID, 0);
    });

    // ---------------------------------------------------------------------
    // Mechanism 2: event stream (terminal failures the retry hook never sees,
    // most importantly provider.quota from the free-tier usage limit).
    // ---------------------------------------------------------------------
    const handleTerminalFailure = async (sessionID, error, failure) => {
      if (!cfg.enabled || cfg.chain.length === 0)
        return;
      handlingUntil.set(sessionID, Date.now() + Math.max(1000, cfg.eventThrottleMs));
      let current;
      try {
        current = await currentModelOf(sessionID);
      } catch (e) {
        log(`event: could not read model for ${sessionID.slice(0, 12)}: ${e?.message ?? e}`);
        return;
      }
      if (!current) {
        log(`event: no model on ${sessionID.slice(0, 12)}; ignoring`);
        return;
      }
      const { streak, duration } = bench(current, failure);
      let seen = walked.get(sessionID);
      if (!seen) {
        seen = new Set();
        walked.set(sessionID, seen);
      }
      seen.add(keyOf(current));
      const reason = `event ${failure} type=${error?.type ?? "?"} streak=${streak} bench=${Math.round(duration / 1000)}s`;
      const target = await pick(sessionID, current);
      if (!target) {
        const wait = Math.min(cfg.cooldownMaxMs, Math.max(cfg.cooldownMs, duration));
        log(`event: no fallback left for ${sessionID.slice(0, 12)} (${reason}); resuming in ${Math.round(wait / 1000)}s rejected -> ${lastRejections || "none"}`);
        scheduleResume(sessionID, wait);
        return;
      }
      try {
        await switchTo(sessionID, current, target, reason);
        scheduleResume(sessionID, 0);
      } catch (e) {
        seen.add(keyOf(target));
        log(`event: switch to ${keyOf(target)} failed: ${e?.message ?? e}; resuming in 5s`);
        scheduleResume(sessionID, 5000);
      }
    };
    // Coalesce the burst of events a single failed turn emits
    // (session.step.failed followed by session.execution.failed / session.error).
    const onEvent = async (event) => {
      if (!event || !FAILURE_EVENTS.has(event.type))
        return;
      if (!cfg.enabled || cfg.chain.length === 0)
        return;
      const sessionID = event.data?.sessionID;
      if (typeof sessionID !== "string")
        return;
      const now = Date.now();
      if ((handlingUntil.get(sessionID) ?? 0) > now)
        return;
      const error = event.data?.error;
      const failure = classifyFailure(error);
      if (!failure)
        return;
      // Include the *current* model in the claim. The event burst for one
      // failure names the model that failed, but a later failure on the model we
      // just switched TO (typically the same "rate limit" text) must NOT be
      // mistaken for a duplicate of the earlier one -- doing so stalled the
      // fallback at a single step and it never reached the paid section.
      let modelKey = "unknown";
      try {
        const current = await currentModelOf(sessionID);
        if (current)
          modelKey = keyOf(current);
      } catch {}
      // group the step.failed + execution.failed (+ session.error) event burst
      // that describes the same underlying failure into one claim.
      if (!claim(sessionID, `${failure}-${modelKey}-${fingerprint(`${error?.type ?? ""}|${error?.message ?? ""}`)}`))
        return;
      const pending = failureTimers.get(sessionID);
      if (pending?.timer)
        clearTimeout(pending.timer);
      const entry = { error, failure };
      entry.timer = setTimeout(() => {
        failureTimers.delete(sessionID);
        handleTerminalFailure(sessionID, entry.error, entry.failure).catch((e) => {
          log(`event handler crashed: ${e?.message ?? e}`);
        });
      }, Math.max(0, cfg.eventDebounceMs));
      entry.timer.unref?.();
      failureTimers.set(sessionID, entry);
    };

    const eventController = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          try {
            await onEvent(event);
          } catch {}
        }
      } catch (error) {
        if (!eventController.signal.aborted)
          log(`event stream ended: ${error?.message ?? error}`);
      }
    })();

    const promptRegistration = await ctx.session.hook("prompt", async (event) => {
      const text = String(event?.prompt?.text ?? "").trim();
      if (text.length === 0)
        return;
      const sessionID = event.sessionID;
      clearResume(sessionID);
      walked.delete(sessionID);
      waits.delete(sessionID);
      handlingUntil.delete(sessionID);
      const pending = failureTimers.get(sessionID);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        failureTimers.delete(sessionID);
      }
      if (!cfg.enabled || !cfg.restoreChainHeadOnNewPrompt)
        return;
      if (!displaced.has(sessionID))
        return;
      const head = cfg.chain[0];
      if (!head)
        return;
      if ((cooldown.get(keyOf(head)) ?? 0) > Date.now())
        return;
      const available = await isAvailable(head);
      if (!available)
        return;
      try {
        await switchTo(sessionID, undefined, head, "new prompt, returning to chain head");
        displaced.delete(sessionID);
      } catch (error) {
        log(`restore to ${keyOf(head)} failed: ${error?.message ?? error}`);
      }
    });

    log(`armed (v${PLUGIN_VERSION}): chain=${cfg.chain.length} head=${cfg.chain[0] ? keyOf(cfg.chain[0]) : "none"} tail=${cfg.chain.length ? keyOf(cfg.chain[cfg.chain.length - 1]) : "none"}`);
    await auditProviders();

    const dispose = async () => {
      if (priorCleanup() === dispose)
        setCleanup(undefined);
      log("releasing the retry/prompt hooks and event subscription");
      clearInterval(reloadTimer);
      try {
        eventController.abort();
      } catch {}
      await retryRegistration?.dispose?.();
      await promptRegistration?.dispose?.();
      for (const timer of resumeTimers.values())
        clearTimeout(timer);
      resumeTimers.clear();
      for (const entry of failureTimers.values())
        if (entry?.timer)
          clearTimeout(entry.timer);
      failureTimers.clear();
      handlingUntil.clear();
      walked.clear();
      waits.clear();
      displaced.clear();
      cooldown.clear();
      streaks.clear();
    };
    setCleanup(dispose);
    return dispose;
  }
};

export {
  src_default as default
};
