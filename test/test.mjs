// Functional test harness for the model-fallback plugin (OpenCode V2 API).
//
// Mocks ctx (model.list, provider.list, session.hook/get/switchModel/prompt,
// event.subscribe) and drives:
//   - the retry hook for retryable failures (HTTP 429 / auth), and
//   - the event stream for terminal failures the retry hook never sees
//     (provider.quota from the free-tier usage limit).
//
// Run with Bun (the runtime OpenCode uses):
//   bun test/test.mjs
//
// Exits non-zero on the first failed assertion.
import { join, dirname } from "path";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = join(TEST_DIR, "..", "index.js");

// Start from a clean slate so stale cross-process claim locks cannot leak in.
const LOCK_DIR = join(tmpdir(), "opencode-model-fallback-locks");
rmSync(LOCK_DIR, { recursive: true, force: true });

const configDir = TEST_DIR;
process.env.OPENCODE_CONFIG_DIR = configDir;
const cfg = JSON.parse(readFileSync(join(configDir, "model-fallback.json"), "utf8"));

// ---- state mocks ----
const models = cfg.chain.map((c) => ({ providerID: c.providerID, id: c.id, modelID: c.id, enabled: true }));
const providers = [...new Set(cfg.chain.map((c) => c.providerID))].map((id) => ({ id, activation: "auto" }));

let switchLog = [];
let promptLog = [];
let retryHandler = null;
let promptHandler = null;
const sessionModel = new Map();

// push-based async iterable standing in for ctx.event.subscribe()
const stream = (() => {
  const queue = [];
  let waiter = null;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            return new Promise((res) => { waiter = res; });
          },
          return() { return Promise.resolve({ done: true }); },
        };
      },
    },
    push(ev) {
      if (waiter) { const r = waiter; waiter = null; r({ value: ev, done: false }); }
      else queue.push(ev);
    },
  };
})();

const SID = "ses_test0000000000000000000000000";

const ctx = {
  location: { directory: TEST_DIR },
  model: { list: async () => ({ location: {}, data: models }) },
  provider: { list: async () => ({ location: {}, data: providers }) },
  event: { subscribe: () => stream.iterable },
  session: {
    hook: async (name, handler) => {
      if (name === "retry") retryHandler = handler;
      if (name === "prompt") promptHandler = handler;
      return { dispose: async () => {} };
    },
    get: async ({ sessionID }) => ({ model: sessionModel.get(sessionID) }),
    switchModel: async ({ sessionID, model }) => {
      switchLog.push(model);
      sessionModel.set(sessionID, model);
    },
    prompt: async (input) => { promptLog.push(input); },
  },
};

const plugin = (await import(PLUGIN_PATH)).default;
const dispose = await plugin.setup(ctx);
console.log("setup ok, cleanup returned:", typeof dispose === "function");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fireRetry = async (model, status, message, attempt = 1) => {
  const event = {
    sessionID: SID,
    model: { providerID: model.providerID, id: model.id },
    error: { status, type: "provider.error", message, response: { body: "" } },
    attempt,
    decision: { retry: true, delay: 5000 },
  };
  await retryHandler(event);
  return event;
};

const head = cfg.chain[0];
const second = cfg.chain[1];
const third = cfg.chain[2];
const fourth = cfg.chain[3];

// ---- Test 1: 429 on head -> switch to second, retry delay 0 ----
switchLog = [];
let ev = await fireRetry(head, 429, "rate limit exceeded");
console.log("T1 decision:", JSON.stringify(ev.decision), "switch:", JSON.stringify(switchLog));
if (ev.decision.retry !== true || ev.decision.delay !== 0) throw new Error("T1 FAIL: expected retry delay 0");
if (switchLog.length !== 1 || switchLog[0].providerID !== second.providerID || switchLog[0].id !== second.id)
  throw new Error(`T1 FAIL: expected switch to ${second.providerID}/${second.id}, got ${JSON.stringify(switchLog)}`);
console.log("T1 PASS");

// ---- Test 2: auth failure (401) also switches ----
switchLog = [];
await fireRetry(second, 401, "invalid api key");
if (switchLog.length !== 1 || switchLog[0].id !== third.id) throw new Error("T2 FAIL");
console.log("T2 PASS: auth failure switched to", third.id);

// ---- Test 3: chain advances over walked/benched models ----
switchLog = [];
await fireRetry(third, 429, "too many requests");
if (switchLog.length !== 1 || switchLog[0].id !== fourth.id) throw new Error("T3 FAIL: expected 4th model");
console.log("T3 PASS: chain advances ->", fourth.id);

// ---- Test 4: transient errors are ignored (no switch) ----
switchLog = [];
await fireRetry(second, 502, "socket hang up");
if (switchLog.length !== 0) throw new Error("T4 FAIL: transient should not switch");
console.log("T4 PASS: transient ignored");

// ---- Test 5: empty prompt hook does nothing ----
const before = promptLog.length;
await promptHandler({ sessionID: SID, prompt: { text: "   " }, delivery: "steer" });
if (promptLog.length !== before) throw new Error("T5 FAIL: blank prompt should not schedule resume");
console.log("T5 PASS: blank prompt ignored");

// =====================================================================
// Event-stream mechanism (the free-tier quota case)
// =====================================================================

// ---- Test 6: provider.quota terminal event -> switch + resume ----
{
  const sid = "ses_evt" + Math.random().toString(36).slice(2, 12).padEnd(20, "0");
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = []; promptLog = [];
  stream.push({
    id: "evt_evtquota", type: "session.execution.failed",
    data: { sessionID: sid, error: { type: "provider.quota", message: "Rate limit exceeded. Please try again later." } },
  });
  await sleep(450);
  // earlier tests globally benched head/second/third, so the next healthy chain
  // entry after benching the current model is the 4th entry.
  if (switchLog.length !== 1 || switchLog[0].id !== fourth.id)
    throw new Error(`T6 FAIL: expected switch to ${fourth.id}, got ${JSON.stringify(switchLog)}`);
  if (!promptLog.some((p) => p.sessionID === sid && p.resume === true))
    throw new Error("T6 FAIL: expected a resume prompt");
  console.log("T6 PASS: provider.quota event switched", head.id, "->", fourth.id, "and resumed");
}

// ---- Test 7: quota event delivered twice (step.failed + execution.failed) -> one switch ----
{
  const sid = "ses_evtdouble000000000000000000";
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = []; promptLog = [];
  stream.push({ type: "session.step.failed", data: { sessionID: sid, assistantMessageID: "msg_x", error: { type: "provider.quota", message: "usage limit reached" } } });
  stream.push({ type: "session.execution.failed", data: { sessionID: sid, error: { type: "provider.quota", message: "usage limit reached" } } });
  await sleep(450);
  if (switchLog.length !== 1)
    throw new Error(`T7 FAIL: expected exactly 1 switch, got ${switchLog.length}`);
  console.log("T7 PASS: duplicate failure events coalesced to 1 switch");
}

// ---- Test 8: content-filter error is NOT a model problem -> no switch ----
{
  const sid = "ses_evtcontent000000000000000000";
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = []; promptLog = [];
  stream.push({ type: "session.step.failed", data: { sessionID: sid, error: { type: "provider.content-filter", message: "blocked by content filtering policy" } } });
  await sleep(450);
  if (switchLog.length !== 0) throw new Error("T8 FAIL: content-filter must not switch");
  console.log("T8 PASS: content-filter ignored");
}

// ---- Test 9: non-provider error -> no switch ----
{
  const sid = "ses_evtother00000000000000000000";
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = []; promptLog = [];
  stream.push({ type: "session.error", data: { sessionID: sid, error: { type: "tool.execution", message: "command failed" } } });
  await sleep(450);
  if (switchLog.length !== 0) throw new Error("T9 FAIL: tool error must not switch");
  console.log("T9 PASS: non-provider error ignored");
}

// ---- Test 10: deprecated model (classified invalid-request) IS switch-worthy ----
{
  const sid = "ses_evtdeprec000000000000000000";
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = []; promptLog = [];
  stream.push({ type: "session.step.failed", data: { sessionID: sid, error: { type: "provider.invalid-request", message: "Model exo-free has been deprecated." } } });
  await sleep(450);
  if (switchLog.length !== 1) throw new Error("T10 FAIL: deprecated model must switch");
  console.log("T10 PASS: deprecated model switched");
}

// ---- Test 11: genuine invalid request (bad tool JSON) must NOT switch ----
{
  const sid = "ses_evtbadreq0000000000000000000";
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = []; promptLog = [];
  stream.push({ type: "session.step.failed", data: { sessionID: sid, error: { type: "provider.invalid-request", message: "Upstream request failed: [400] Assistant tool call function.arguments must be a JSON object." } } });
  await sleep(450);
  if (switchLog.length !== 0) throw new Error("T11 FAIL: invalid request must not switch");
  console.log("T11 PASS: invalid request ignored");
}

// ---- Test 12: a fresh claim lock (another instance already handling this exact
// failure) must suppress the switch in this instance ----
{
  const sid = "ses_evtlock00000000000000000000";
  sessionModel.set(sid, { providerID: head.providerID, id: head.id });
  switchLog = [];
  const msg = "Rate limit exceeded. Please try again later.";
  const fingerprint = (text) => { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const key = `${sid}__rate-${fingerprint(`provider.quota|${msg}`)}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) + ".lock";
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(join(LOCK_DIR, key), "other-instance");
  stream.push({ type: "session.execution.failed", data: { sessionID: sid, error: { type: "provider.quota", message: msg } } });
  await sleep(450);
  rmSync(join(LOCK_DIR, key), { force: true });
  if (switchLog.length !== 0) throw new Error("T12 FAIL: held claim should suppress switch");
  console.log("T12 PASS: cross-instance claim suppresses duplicate switch");
}

await dispose();
console.log("\nALL TESTS PASSED");
