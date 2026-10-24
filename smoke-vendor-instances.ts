// Live smoke: run the real discovery + per-vendor checks against the user's
// real instances and OAuth logins. Keys come from env/auth.json; nothing
// secret is printed. googleapis requests are routed through the local proxy
// the same way the pi-proxy-router bridge does inside pi.
import { createRequire } from "node:module";
import path from "node:path";
import { discoverAllVendorInstances, checkVendorInstance } from "./src/vendor-instances.ts";
import { renderVendorInstanceBalance, renderVendorInstanceWindows, renderVendorWindowGroups, renderOpenRouter } from "./src/render.ts";

const plain = (_c: string, t: string) => t;
const entries = [
	["kimiqq", "https://api.kimi.com/coding/", process.env.KIMIQQ_KEY],
	["kimitoken", "https://api.kimi.com/coding/", process.env.KIMITOKEN_KEY],
	["bigmodeltoken", "https://open.bigmodel.cn/api/anthropic", process.env.BIGMODEL_KEY],
	["deepseektoken", "https://api.deepseek.com/anthropic", process.env.DEEPSEEK_KEY],
	["openrouter", "https://openrouter.ai/api", process.env.OPENROUTER_KEY],
];
const auth = new Map(entries.map(([id, _base, key]) => [id, key]));
const registry = {
	getRegisteredProviderIds: () => entries.map(([id]) => id),
	getProvider: (id: string) => ({ baseUrl: entries.find(([e]) => e === id)?.[1], getModels: () => [] }),
	getProviderAuth: async (id: string) => (auth.get(id) ? { auth: { apiKey: auth.get(id) }, source: "smoke" } : undefined),
};

// Route only googleapis through the proxy (mirrors the bridge in real pi).
const proxyRouterRequire = createRequire(path.resolve("..", "pi-proxy-router", "index.ts"));
const undiciDir = path.dirname(proxyRouterRequire.resolve("undici/package.json"));
const { fetch: undiciFetch, ProxyAgent } = proxyRouterRequire(undiciDir);
const proxyDispatcher = new ProxyAgent("http://ai-proxy.lan:7890");
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
	if (String(url).includes("googleapis.com")) {
		return undiciFetch(url as never, { ...(init as Record<string, unknown>), dispatcher: proxyDispatcher } as never) as never;
	}
	return realFetch(url, init);
}) as typeof fetch;

const ctx = { modelRegistry: registry };
const instances = await discoverAllVendorInstances(ctx);
console.log("discovered:", instances.map((i) => `${i.vendor}:${i.label}${i.apiKey ? "(login)" : ""}`).join(", "));
for (const instance of instances) {
	const usage = await checkVendorInstance(instance, ctx);
	if (!usage) { console.log(`${instance.vendor}:${instance.label} -> no auth`); continue; }
	if (usage.error) console.log(`${instance.vendor}:${instance.label} -> ERROR ${usage.error}`);
	const lines = usage.windowGroups?.length
		? renderVendorWindowGroups(usage, plain, false)
		: usage.windows
			? renderVendorInstanceWindows(usage, plain, false)
			: usage.balance
				? renderVendorInstanceBalance(usage, plain)
				: usage.openrouter
					? renderOpenRouter(usage.openrouter, plain, "OpenRouter", `- ${usage.label}`)
					: [];
	console.log(lines.join("\n"));
}
