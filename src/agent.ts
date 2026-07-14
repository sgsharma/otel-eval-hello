// The downstream "agent" — mimics a Strands agent that emits its OWN OTel spans.
//
// Strands doesn't use braintrust's auto-instrumentation; it creates OTel spans
// via an OTel tracer and sets gen_ai.* semantic-convention attributes. Those
// spans are exported by the OTel BraintrustSpanProcessor configured in server.ts
// and Braintrust maps gen_ai.*/llm.* attributes to input/output/metrics on
// ingestion.
//
// The only thing that makes these nest under the experiment is that server.ts
// runs this inside `context.with(<extracted parent ctx with braintrust.parent>)`,
// so every OTel span here inherits the trace id and gets the experiment parent
// stamped by BraintrustSpanProcessor.onStart.
import { trace, SpanStatusCode } from "@opentelemetry/api";
import OpenAI from "openai";

const client = new OpenAI();

export async function runHelloWorldAgent(prompt: string): Promise<string> {
  const tracer = trace.getTracer("strands-agent");

  return tracer.startActiveSpan("agent.run", async (agentSpan) => {
    try {
      // Child OTel LLM span, as a Strands agent would emit it.
      return await tracer.startActiveSpan("chat gpt-4o-mini", async (llmSpan) => {
        const messages = [
          {
            role: "system" as const,
            content:
              "You are a friendly hello-world agent. Reply in one short sentence.",
          },
          { role: "user" as const, content: prompt },
        ];

        llmSpan.setAttributes({
          "gen_ai.system": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4o-mini",
          "gen_ai.prompt": JSON.stringify(messages),
        });

        try {
          const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
          });
          const text = completion.choices[0]?.message?.content ?? "";

          llmSpan.setAttributes({
            "gen_ai.completion": JSON.stringify([
              { role: "assistant", content: text },
            ]),
            "gen_ai.response.model": completion.model,
            "gen_ai.usage.input_tokens": completion.usage?.prompt_tokens ?? 0,
            "gen_ai.usage.output_tokens":
              completion.usage?.completion_tokens ?? 0,
          });
          return text;
        } catch (err) {
          llmSpan.recordException(err as Error);
          llmSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          llmSpan.end();
        }
      });
    } finally {
      agentSpan.end();
    }
  });
}
