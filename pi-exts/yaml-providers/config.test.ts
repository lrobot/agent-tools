import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { loadProviders, loadInstances, inferApi, isInstanceInProfile } from "./config";

test("loadProviders parses a providers yaml file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
  const file = path.join(dir, "providers.yaml");
  writeFileSync(
    file,
    "deepseek:\n  base_url: https://api.deepseek.com/anthropic\n  models:\n    deepseek-chat: deepseek-chat\n",
  );
  const providers = loadProviders(file);
  expect(providers.deepseek.base_url).toBe("https://api.deepseek.com/anthropic");
  expect(providers.deepseek.models).toEqual({ "deepseek-chat": "deepseek-chat" });
});

test("inferApi matches anthropic-style base urls", () => {
  expect(inferApi("https://api.deepseek.com/anthropic")).toBe("anthropic-messages");
  expect(inferApi("https://api.kimi.com/coding/")).toBe("anthropic-messages");
  expect(inferApi("https://api.minimaxi.com/anthropic")).toBe("anthropic-messages");
});

test("inferApi matches openai-style base urls", () => {
  expect(inferApi("https://openrouter.ai/api/v1")).toBe("openai-completions");
  expect(inferApi("https://ark.cn-beijing.volces.com/api/compatible")).toBe("openai-completions");
});

test("inferApi falls back to anthropic-messages", () => {
  expect(inferApi("https://llm-proxy.jasm.top")).toBe("anthropic-messages");
});

test("loadProviders parses max_context_ref when present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
  const file = path.join(dir, "providers.yaml");
  writeFileSync(
    file,
    "globalai:\n  base_url: https://globalai.vip\n  max_context_ref: https://models.dev/api.json\n",
  );
  expect(loadProviders(file).globalai.max_context_ref).toBe("https://models.dev/api.json");
});

test("loadProviders leaves max_context_ref undefined when absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
  const file = path.join(dir, "providers.yaml");
  writeFileSync(file, "deepseek:\n  base_url: https://api.deepseek.com\n");
  expect(loadProviders(file).deepseek.max_context_ref).toBeUndefined();
});

test("loadInstances parses pi_profile array when present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
  const file = path.join(dir, "instances.yaml");
  writeFileSync(
    file,
    'inst1:\n  pi_profile: ["default"]\n  provider_name: p1\n  secret_key_name: s1\n' +
    'inst2:\n  pi_profile: []\n  provider_name: p2\n  secret_key_name: s2\n',
  );
  const instances = loadInstances(file);
  expect(instances.inst1.pi_profile).toEqual(["default"]);
  expect(instances.inst2.pi_profile).toEqual([]);
});

test("isInstanceInProfile handles default, custom, empty and wildcard profiles", () => {
  expect(isInstanceInProfile({ provider_name: "p", secret_key_name: "s", pi_profile: ["default"] })).toBe(true);
  expect(isInstanceInProfile({ provider_name: "p", secret_key_name: "s", pi_profile: [] })).toBe(false);
  expect(isInstanceInProfile({ provider_name: "p", secret_key_name: "s" })).toBe(true);
  expect(isInstanceInProfile({ provider_name: "p", secret_key_name: "s", pi_profile: ["work"] }, "default")).toBe(false);
  expect(isInstanceInProfile({ provider_name: "p", secret_key_name: "s", pi_profile: ["work"] }, "work")).toBe(true);
  expect(isInstanceInProfile({ provider_name: "p", secret_key_name: "s", pi_profile: ["*"] }, "custom")).toBe(true);
});
