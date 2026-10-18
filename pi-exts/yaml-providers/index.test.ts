import { test, expect } from "bun:test";
import { groupModelsByApi, resolveBaseUrlV1, toModelConfigs } from "./index";

test("resolveBaseUrlV1 prefers base_url_v1 when present", () => {
  expect(resolveBaseUrlV1({ base_url: "https://api.example.com", base_url_v1: "https://api.example.com/v1" })).toBe(
    "https://api.example.com/v1",
  );
});

test("resolveBaseUrlV1 falls back to base_url plus /v1", () => {
  expect(resolveBaseUrlV1({ base_url: "https://api.example.com" })).toBe("https://api.example.com/v1");
  expect(resolveBaseUrlV1({ base_url: "https://api.example.com/" })).toBe("https://api.example.com/v1");
});
test("groupModelsByApi sends gpt/codex models to openai-completions and others to anthropic-messages", () => {
  const groups = groupModelsByApi([
    { id: "gpt-5", name: "gpt-5" },
    { id: "codex-mini", name: "codex-mini" },
    { id: "claude-sonnet-4", name: "claude-sonnet-4" },
    { id: "deepseek-chat", name: "deepseek-chat" },
  ]);

  expect(groups.get("openai-completions")?.map((model) => model.id)).toEqual(["gpt-5", "codex-mini"]);
  expect(groups.get("anthropic-messages")?.map((model) => model.id)).toEqual([
    "claude-sonnet-4",
    "deepseek-chat",
  ]);
});

test("toModelConfigs: live values win, then max_context_ref, then placeholder defaults", () => {
  const configs = toModelConfigs(
    [
      { id: "has-live", contextWindow: 200000, maxTokens: 8000 },
      { id: "needs-ref" },
      { id: "no-ref-no-live" },
    ],
    (id) => (id === "needs-ref" ? { context: 1000000, output: 393216 } : {}),
  );
  expect(configs.map((c) => ({ id: c.id, contextWindow: c.contextWindow, maxTokens: c.maxTokens }))).toEqual([
    { id: "has-live", contextWindow: 200000, maxTokens: 8000 },
    { id: "needs-ref", contextWindow: 1000000, maxTokens: 393216 },
    { id: "no-ref-no-live", contextWindow: 128000, maxTokens: 8192 },
  ]);
});

test("toModelConfigs: with no contextRefFor at all, falls straight to placeholder defaults", () => {
  const configs = toModelConfigs([{ id: "x" }]);
  expect(configs[0].contextWindow).toBe(128000);
  expect(configs[0].maxTokens).toBe(8192);
});
