// Downstream agent server (separate process from the eval).
//
// The agent (Strands-style) emits its OWN OTel spans. To make those OTel LLM
// spans nest under the eval's experiment trace, the server must:
//   1. export OTel spans via BraintrustSpanProcessor,
//   2. extract the incoming trace context (traceparent -> trace id),
//   3. promote braintrust.parent from BAGGAGE to a CONTEXT VALUE (onStart reads
//      the context value, never baggage),
//   4. run the agent inside context.with(ctx) so every OTel span inherits the
//      trace id and gets the experiment parent stamped by onStart.
//
// No braintrust auto-instrumentation and no setupOtelCompat() here: these are
// plain OTel spans routed by the processor via the context value.
import "dotenv/config";

import http from "node:http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BraintrustSpanProcessor } from "@braintrust/otel";
import { context, propagation } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
} from "@opentelemetry/core";
import { runHelloWorldAgent } from "./agent.ts";

// Keep a reference so we can force-flush per request (batch processor otherwise
// exports on an interval and the demo spans may not appear immediately).
const processor = new BraintrustSpanProcessor({
  parent: "project_name:otel-eval-hello", // fallback only; overridden per-request
  apiKey: process.env.BRAINTRUST_API_KEY,
});

const otelSdk = new NodeSDK({
  serviceName: "strands-agent-server",
  spanProcessors: [processor],
});
otelSdk.start();

// Global propagator MUST include the baggage propagator or the incoming
// braintrust.parent (in baggage) is dropped on extract.
propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
    ],
  }),
);

const PORT = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("strands-agent-server up\n");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    try {
      const headers = req.headers as Record<string, string>;
      const { prompt } = JSON.parse(raw || "{}") as { prompt?: string };

      // Extract remote trace context (traceparent -> trace id, baggage -> parent).
      const parentCtx = propagation.extract(context.active(), headers);

      // Promote braintrust.parent from baggage to a context VALUE so
      // BraintrustSpanProcessor.onStart (which reads the context value, not
      // baggage) stamps experiment_id on every strands OTel span.
      const btParent = propagation
        .getBaggage(parentCtx)
        ?.getEntry("braintrust.parent")?.value;

      if (!btParent) {
        console.warn(
          "braintrust.parent missing from baggage -- check the eval injects it and " +
            "this server's global propagator includes W3CBaggagePropagator. Spans will " +
            "fall back to project_name:otel-eval-hello.",
        );
      }

      const ctx = btParent
        ? parentCtx.setValue("braintrust.parent" as any, btParent)
        : parentCtx;

      // Run the strands agent inside the context: its OTel spans inherit the
      // trace id and nest under the incoming agent.api-call span.
      const output = await context.with(ctx, () =>
        runHelloWorldAgent(prompt ?? "Say hi"),
      );

      // Flush so spans export before we respond (demo visibility).
      await processor.forceFlush();

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output }));
    } catch (err) {
      console.error("request failed", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

process.on("SIGTERM", () => {
  otelSdk.shutdown().finally(() => process.exit(0));
});

server.listen(PORT, () => {
  console.log(`strands-agent-server listening on http://localhost:${PORT}`);
});
