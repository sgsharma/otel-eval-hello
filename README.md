# otel-eval-hello

Minimal repro of the pattern we debugged: a Braintrust `Eval()` calls a downstream
OpenAI "agent" server over HTTP, and the server's spans — including the OpenAI
`chat.completions` call — nest under the **same experiment trace**.

```
eval                     (experiment)
└─ task                  (Braintrust eval task span)
   └─ agent.api-call     (OTel span, eval side)  ── HTTP: traceparent + baggage ──▶
      └─ agent.run       (Braintrust span, server side)
         └─ Chat Completion  (type=llm, auto-instrumented OpenAI, server side)
```

Verified end-to-end: the `Chat Completion` span nests under `agent.run`, which
nests under `agent.api-call` across the process boundary, all inside the
experiment.

Two processes:
- **eval.ts** = the client. `setupOtelCompat()`; creates the OTel `agent.api-call`
  span nested under the Braintrust task span; injects `traceparent` + `baggage`.
- **server.ts** = the downstream agent. Turns the incoming headers into a
  Braintrust parent and runs the OpenAI call under a Braintrust span.

## The two things that make it work

**1. Eval side — nest the OTel span under the task span.** Rebuild the OTel
context from the Braintrust task span immediately before creating the OTel span:

```ts
getContextManager().runInContext(currentSpan(), () =>
  tracer.startActiveSpan("agent.api-call", async (span) => { ... }),
);
```

**2. Server side — root a *Braintrust* span on the incoming experiment.** This is
the key subtlety for the LLM span: `braintrust/apply-auto-instrumentation` emits
**Braintrust** spans and attaches them to the active span in the **Braintrust**
context. A raw OTel span (`tracer.startActiveSpan`) never enters that context, so
the OpenAI span would have no parent and never appear. So the server wraps the
work in `logger.traced(...)` with a parent built from the headers:

```ts
const parent = parentFromHeaders(headers); // reads traceparent + baggage(experiment_id)
await logger.traced(async (span) => {
  const text = await runHelloWorldAgent(prompt);  // auto-instrumented chat.completions nests here
  span.log({ input: prompt, output: text });
  return text;
}, { name: "agent.run", parent });
```

`parentFromHeaders` needs the server's global propagator to include
`W3CBaggagePropagator`, or the `experiment_id` in baggage is dropped and it
returns `undefined`.

## Setup

```bash
cd otel-eval-hello
npm install
cp .env.example .env   # fill in BRAINTRUST_API_KEY and OPENAI_API_KEY
```

## Run

Terminal 1 — start the agent server:
```bash
npm run server
# hello-agent-server listening on http://localhost:3000
```

Terminal 2 — run the eval (standalone script, **not** `braintrust eval`):
```bash
npm run eval          # → tsx src/eval.ts
```

> Do not run the eval via the `braintrust eval` CLI. The CLI sets
> `globalThis._lazy_load` (so `Eval()` only registers) and eval's the file inside
> its **bundled** `braintrust`, a different instance from the `node_modules` copy
> `@braintrust/otel` links. That dual-instance split makes
> `setupOtelCompat()`/`currentSpan()` fail to resolve the experiment parent →
> `braintrust.parent not set on span`. Running as a plain `tsx` script keeps one
> `braintrust` instance.

Watch the eval log: `api-call traceId <X> | BT task rootSpanId <X>` — the two
values must be **equal** (both 32-hex) for the eval-side span to nest.

## Verify

Open the `otel-eval-hello` project in Braintrust → the experiment. Each task row
should show `agent.api-call` → `agent.run` → `Chat Completion`, all under one
trace. If `Chat Completion` is missing, the auto-instrumentation didn't hook
`openai` — see the note below.

## Why the OpenAI span needs a preload hook

`chat.completions` is instrumented by transforming the `openai` module **at load
time**. That only works if the hook is registered **before** `openai` is linked.
An in-file `import "braintrust/apply-auto-instrumentation"` runs too late (the
module graph, including `openai`, is already linked), so no LLM span appears.

The fix is a Node preload (see the `server` script):

```bash
node --import braintrust/hook.mjs --import tsx src/server.ts
```

`--import braintrust/hook.mjs` registers the transform before the app graph
loads; `--import tsx` transpiles the TS entry. This repro pins `openai@^4` (the
instrumentation config covers `>=4.0.0 <5.0.0` and `>=5.0.0`).

## Notes
- `setupOtelCompat()` is only used on the **eval** side (it makes the Braintrust
  task span OTel-backed so the OTel `agent.api-call` span nests under it). The
  server is Braintrust-native and doesn't need it.
- The server span must be a **Braintrust** span (`traced(...)`), not a raw OTel
  span: the OpenAI auto-instrumentation attaches to the active *Braintrust* span.
  A raw OTel `startActiveSpan` won't hold an LLM child.
- Use the free `traced(cb, { parent })` (not `logger.traced`): it derives the
  parent object type (EXPERIMENT) from the `parentFromHeaders` export. A project
  `initLogger` would throw `Mismatch between expected span parent object type 2
  and provided type 1` (PROJECT_LOGS vs EXPERIMENT).
- The server exports via the Braintrust logger, the eval side via
  `BraintrustSpanProcessor`. They share one trace because the server's `parent`
  (from `parentFromHeaders`) carries the incoming trace/span ids.
- Env: the app reads keys from `.env` via `dotenv`. If a key is already exported
  (even empty) in your shell, `dotenv` won't override it — unset it first or the
  login will fail with `Please specify an api key`.
