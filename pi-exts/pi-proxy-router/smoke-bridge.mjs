// Live smoke: load pi-proxy-router with a mock pi API + codex model registry,
// then run a bridge-routed fetch against the real Codex usage endpoint.
// Expected WITHOUT routing: connection reset / 000. Expected WITH routing via
// http://ai-proxy.lan:7890: HTTP 401 (reaches the API, no token attached).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ppr-smoke-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(home, ".pi", "agent", "proxy-router.json"),
  JSON.stringify({ models: { "openai-codex/*": "http://ai-proxy.lan:7890" } }),
);

const commands = new Map();
const handlers = new Map();
const CODEX_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};
const modelRegistry = {
  getAll: () => [CODEX_MODEL],
  getProviders: () => new Map([["openai-codex", {
    chat: (model) => model,
    stream: (model) => model,
  }]]),
  getModelsOfType: () => [CODEX_MODEL],
};
const mockApi = {
  registerFlag: () => {},
  getFlag: () => false,
  registerCommand: (name, fn) => commands.set(name, fn),
  on: (event, fn) => handlers.set(event, fn),
  getSession() {
    return { workspaceDirectory: home, models: modelRegistry };
  },
};

process.env.PI_MODEL_PROXY_DEBUG = "1";
const { default: factory } = await import("./index.ts");
factory(mockApi); // registers handlers, installs dispatcher, publishes bridge
handlers.get("session_start")(undefined, { modelRegistry });

const bridge = globalThis.__piProxyRouter;
if (!bridge) throw new Error("bridge not published");
console.log("status:", JSON.stringify(bridge.status()));
const routed = bridge.fetchForOrigin("https://chatgpt.com");
if (typeof routed !== "function") throw new Error("no routed fetch for chatgpt.com");
console.log("resolve:", JSON.stringify(bridge.resolveForOrigin("https://chatgpt.com")));

try {
  const res = await routed("https://chatgpt.com/backend-api/wham/usage", {
    headers: { "User-Agent": "pi-usage smoke" },
  });
  console.log(`RESULT: HTTP ${res.status}`);
  await res.body?.cancel();
} catch (error) {
  const chain = [];
  let cursor = error;
  while (cursor && chain.length < 5) {
    chain.push(`${cursor.name}: ${cursor.message}`);
    cursor = cursor.cause;
  }
  console.log("RESULT: fetch failed |", chain.join(" | "));
}
