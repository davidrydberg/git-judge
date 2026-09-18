import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Generator } from "./writer.js";

export interface GeneratorKeys {
  openai?: string | undefined;
  anthropic?: string | undefined;
}

/** Picks the provider from the model name in the policy file. Claude models go to Anthropic, the rest to OpenAI. */
export function createGenerator(model: string, keys: GeneratorKeys): Generator {
  const anthropic = model.startsWith("claude-");
  const key = anthropic ? keys.anthropic : keys.openai;
  if (!key) {
    throw new Error(`Generator model "${model}" needs the ${anthropic ? "Anthropic" : "OpenAI"} API key`);
  }
  return anthropic ? anthropicGenerator(key, model) : openaiGenerator(key, model);
}

function openaiGenerator(apiKey: string, model: string): Generator {
  const client = new OpenAI({ apiKey });
  return {
    model,
    async generate({ system, prompt, schema, schemaName }) {
      const response = await client.responses.parse({
        model,
        instructions: system,
        input: prompt,
        text: { format: zodTextFormat(schema, schemaName) },
      });
      if (response.output_parsed === null) {
        throw new Error(`${model} returned no structured output (status: ${response.status})`);
      }
      return {
        value: response.output_parsed,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}

function anthropicGenerator(apiKey: string, model: string): Generator {
  const client = new Anthropic({ apiKey });
  return {
    model,
    async generate({ system, prompt, schema }) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: betaZodOutputFormat(schema) },
        // A refused request is re-run on a fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal" || response.parsed_output === null) {
        throw new Error(`${model} returned no structured output (stop reason: ${response.stop_reason})`);
      }
      return {
        value: response.parsed_output,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
