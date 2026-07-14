// Braintrust Eval whose task calls the downstream agent server over HTTP,
// propagating trace context so the server's OpenAI spans nest under this
// experiment's trace. Run with:  npm run eval   (i.e. `braintrust eval src/eval.ts`)
import "dotenv/config";
import {
  setupOtelCompat,
  BraintrustSpanProcessor,
  addSpanParentToBaggage,
} from "@braintrust/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { trace, propagation } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
} from "@opentelemetry/core";
import { Eval, getContextManager, currentSpan } from "braintrust";

// Engage OTel-compat mode. This makes Braintrust spans OTel-backed (hex ids,
// 32-hex rootSpanId) and routes the context manager through OTel, so the OTel
// span we create below nests under the Braintrust task span. It resets the
// braintrust compat caches, so calling it here (after imports) is fine.
setupOtelCompat();

// Export the eval-side OTel span (agent.api-call) to Braintrust. No `parent`
// needed: it inherits braintrust.parent=experiment_id:... from the task span
// via the compat context.
const otelSdk = new NodeSDK({
  serviceName: "hello-eval",
  spanProcessors: [
    new BraintrustSpanProcessor({ apiKey: process.env.BRAINTRUST_API_KEY }),
  ],
});
otelSdk.start();

// Must include the baggage propagator so `propagation.inject` writes the
// `baggage` header (braintrust.parent). W3CTraceContext alone won't.
propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
    ],
  }),
);

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";

// Run standalone (NOT via `braintrust eval`). The CLI sets globalThis._lazy_load
// so Eval() only registers, and it eval's this file inside the CLI's bundled
// braintrust -- a second instance from the node_modules copy that @braintrust/otel
// links, which breaks setupOtelCompat/currentSpan resolution. Running as a plain
// script keeps a single braintrust instance. We await Eval, then shut the OTel
// SDK down so the agent.api-call span actually flushes before the process exits.
async function main() {
  await Eval("otel-eval-hello", {
    data: [
      { input: "Introduce yourself in one line." },
      { input: "Give me a cheerful hello." },
    ],
  task: async (input, { span: btTask }) => {
    const tracer = trace.getTracer("hello-eval");

    // Rebuild the OTel active context from the current Braintrust task span
    // immediately before creating the OTel span. This guarantees both
    // (a) trace-id inheritance and (b) the braintrust.parent context value.
    return getContextManager().runInContext(currentSpan(), () =>
      tracer.startActiveSpan("agent.api-call", async (span) => {
        try {
          // Nesting check: these must be EQUAL (both 32-hex).
          console.log(
            "api-call traceId",
            span.spanContext().traceId,
            "| BT task rootSpanId",
            btTask.rootSpanId,
          );

          // Routing check: this must print "experiment_id:<id>", NOT undefined
          // and NOT project_name:default-otel-project. If it's experiment_id,
          // the "No parent specified" startup log is just cosmetic.
          console.log(
            "resolved braintrust.parent =",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (span as any).attributes?.["braintrust.parent"],
          );

          // onStart has already stamped braintrust.parent on the span; pull it
          // into baggage for propagation.
          const ctxWithParent = addSpanParentToBaggage(span);
          if (!ctxWithParent) {
            throw new Error(
              "braintrust.parent not set on span -- experiment parent unresolved at span start",
            );
          }

          const traceHeaders: Record<string, string> = {};
          propagation.inject(ctxWithParent, traceHeaders);

          const res = await fetch(SERVER_URL, {
            method: "POST",
            headers: { "content-type": "application/json", ...traceHeaders },
            body: JSON.stringify({ prompt: input }),
          });
          if (!res.ok) {
            throw new Error(`server ${res.status}: ${await res.text()}`);
          }
          const json = (await res.json()) as { output: string };
          span.setAttribute("output.preview", (json.output ?? "").slice(0, 200));
          return json.output;
        } catch (err) {
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      }),
    );
  },
    scores: [
      ({ output }) => ({
        name: "non_empty",
        score: output && output.length > 0 ? 1 : 0,
      }),
    ],
  });

  await otelSdk.shutdown(); // flush the agent.api-call span to Braintrust
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
