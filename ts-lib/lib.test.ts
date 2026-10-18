// Regression tests for parseModelList: one case per provider spelling of the
// context/output/capability fields. Run from ~/.dotc/bin: bun test cld-ts
import { expect, test } from "bun:test";
import { lookupContextRef, parseContextRefCatalog, parseModelList } from "./lib";

test("DeepSeek spelling: context_window / max_output_tokens / input_modalities / effort", () => {
  const body = JSON.stringify({
    object: "list",
    data: [
      {
        id: "deepseek-flash",
        object: "model",
        name: "DeepSeek-V4.1-Flash",
        context_window: 1048576,
        max_output_tokens: 393216,
        input_modalities: ["text", "image"],
        effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
      },
      {
        id: "deepseek-v4-pro",
        object: "model",
        context_window: 1048576,
        max_output_tokens: 393216,
        input_modalities: ["text"],
        effort: { supported_levels: ["low", "high", "max"] },
      },
    ],
  });
  expect(parseModelList(body)).toEqual([
    { id: "deepseek-flash", contextWindow: 1048576, maxTokens: 393216, reasoning: true, images: true },
    { id: "deepseek-v4-pro", contextWindow: 1048576, maxTokens: 393216, reasoning: true, images: false },
  ]);
});

test("Kimi spelling: context_length / supports_reasoning / supports_image_in", () => {
  const body = JSON.stringify({
    data: [
      {
        id: "kimi-for-coding",
        type: "model",
        context_length: 1048576,
        supports_reasoning: true,
        supports_image_in: true,
      },
    ],
  });
  expect(parseModelList(body)).toEqual([
    { id: "kimi-for-coding", contextWindow: 1048576, maxTokens: undefined, reasoning: true, images: true },
  ]);
});

test("cliproxyapi spelling: max_input_tokens / max_tokens", () => {
  const body = JSON.stringify({
    data: [{ id: "claude-sonnet-4-5", type: "model", max_input_tokens: 200000, max_tokens: 64000 }],
  });
  expect(parseModelList(body)).toEqual([
    { id: "claude-sonnet-4-5", contextWindow: 200000, maxTokens: 64000, reasoning: undefined, images: undefined },
  ]);
});

test("OpenRouter spelling: top_provider / supported_parameters / architecture", () => {
  const body = JSON.stringify({
    data: [
      {
        id: "meta-llama/llama-3.3-70b-instruct",
        context_length: 131072,
        max_tokens: 4096,
        top_provider: { max_completion_tokens: 16384 },
        supported_parameters: ["temperature", "reasoning"],
        architecture: { input_modalities: ["text"] },
      },
    ],
  });
  // top_provider wins over the top-level max_tokens for OpenRouter.
  expect(parseModelList(body)).toEqual([
    {
      id: "meta-llama/llama-3.3-70b-instruct",
      contextWindow: 131072,
      maxTokens: 16384,
      reasoning: true,
      images: false,
    },
  ]);
});

test("Volcengine spelling: nested token_limits / modalities", () => {
  const body = JSON.stringify({
    data: [
      {
        id: "deepseek-v4-1-flash-260910",
        object: "model",
        name: "deepseek-v4.1-flash",
        modalities: { input_modalities: ["text"], output_modalities: ["text"] },
        token_limits: {
          context_window: 1048576,
          max_input_token_length: 1048576,
          max_output_token_length: 393216,
          max_reasoning_token_length: 131072,
        },
      },
      {
        // No max_reasoning_token_length -> a non-reasoning model, not "unknown".
        id: "doubao-lite-128k-240828",
        object: "model",
        modalities: { input_modalities: ["text", "image"] },
        token_limits: { context_window: 131072, max_output_token_length: 4096 },
      },
      {
        // Retiring (not Shutdown) - still serving, but with empty objects
        // there is nothing to claim about its limits.
        id: "deepseek-v3-241226",
        object: "model",
        status: "Retiring",
        modalities: {},
        token_limits: {},
      },
    ],
  });
  expect(parseModelList(body)).toEqual([
    {
      id: "deepseek-v4-1-flash-260910",
      contextWindow: 1048576,
      maxTokens: 393216,
      reasoning: true,
      images: false,
    },
    {
      id: "doubao-lite-128k-240828",
      contextWindow: 131072,
      maxTokens: 4096,
      reasoning: false,
      images: true,
    },
    {
      id: "deepseek-v3-241226",
      contextWindow: undefined,
      maxTokens: undefined,
      reasoning: undefined,
      images: undefined,
    },
  ]);
});

test("retired models are dropped, scheduled-for-retirement ones are kept", () => {
  const body = JSON.stringify({
    data: [
      { id: "live", object: "model", token_limits: { context_window: 131072 } },
      { id: "gone", object: "model", status: "Shutdown", token_limits: {} },
      // Still serving today - keeping it is the whole point of the denylist.
      { id: "retiring", object: "model", status: "Retiring", token_limits: { context_window: 1048576 } },
      { id: "pre-offline", object: "model", status: "pre-offline" },
      // Unrecognised status is never a reason to hide a model.
      { id: "weird", object: "model", status: "beta" },
    ],
  });
  expect(parseModelList(body).map((m) => m.id)).toEqual(["live", "retiring", "pre-offline", "weird"]);
});

test("bare listing: everything unknown, nothing invented", () => {
  const body = JSON.stringify({
    object: "list",
    data: [{ id: "glm-4-plus", object: "model", created: 1, owned_by: "zhipu" }],
  });
  expect(parseModelList(body)).toEqual([
    { id: "glm-4-plus", contextWindow: undefined, maxTokens: undefined, reasoning: undefined, images: undefined },
  ]);
});

test("missing data array yields no models", () => {
  expect(parseModelList(JSON.stringify({ object: "list" }))).toEqual([]);
});

// ── parseContextRefCatalog / lookupContextRef (max_context_ref) ───────────
// models.dev shape: { [vendor]: { models: { [modelId]: { limit: { context, output } } } } }

test("parseContextRefCatalog collects one entry per vendor that lists the model", () => {
  const body = JSON.stringify({
    deepinfra: { models: { "deepseek-v4-flash": { limit: { context: 1048576, output: 384000 } } } },
    empiriolabs: { models: { "deepseek-v4-flash": { limit: { context: 1000000, output: 393216 } } } },
    other: { models: { "unrelated-model": { limit: { context: 8192, output: 4096 } } } },
  });
  const catalog = parseContextRefCatalog(body);
  expect(catalog.get("deepseek-v4-flash")).toEqual([
    { context: 1048576, output: 384000 },
    { context: 1000000, output: 393216 },
  ]);
  expect(catalog.get("unrelated-model")).toEqual([{ context: 8192, output: 4096 }]);
  expect(catalog.get("missing-model")).toBeUndefined();
});

test("parseContextRefCatalog skips entries with no usable limit fields", () => {
  const body = JSON.stringify({
    vendor: { models: { "no-limit-model": {}, "empty-limit-model": { limit: {} } } },
  });
  expect(parseContextRefCatalog(body).size).toBe(0);
});

test("lookupContextRef takes the mode across vendors, ignoring a lone outlier", () => {
  const body = JSON.stringify({
    a: { models: { m: { limit: { context: 1000000, output: 384000 } } } },
    b: { models: { m: { limit: { context: 1000000, output: 384000 } } } },
    c: { models: { m: { limit: { context: 1000000, output: 384000 } } } },
    d: { models: { m: { limit: { context: 256000, output: 16384 } } } }, // outlier reseller
  });
  const catalog = parseContextRefCatalog(body);
  expect(lookupContextRef(catalog, "m")).toEqual({ context: 1000000, output: 384000 });
});

test("lookupContextRef breaks a tie toward the smaller (safer under-estimate)", () => {
  const body = JSON.stringify({
    a: { models: { m: { limit: { context: 1048576 } } } },
    b: { models: { m: { limit: { context: 1000000 } } } },
  });
  expect(lookupContextRef(parseContextRefCatalog(body), "m")).toEqual({ context: 1000000, output: undefined });
});

test("lookupContextRef returns {} for a model id not present in the catalog", () => {
  const catalog = parseContextRefCatalog(JSON.stringify({ a: { models: { m: { limit: { context: 1000 } } } } }));
  expect(lookupContextRef(catalog, "unknown")).toEqual({ context: undefined, output: undefined });
});
