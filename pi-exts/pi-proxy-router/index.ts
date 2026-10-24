import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  Context,
  DeferredCancelOptions,
  DeferredFetchOptions,
  DeferredHandle,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
// ── 为什么不能直接 `import ... from "undici"` ─────────────────────────
//
// 这个扩展运行在 pi 进程内，pi 是 Bun 编译的二进制，而 Bun 会把 bare
// specifier "undici" 别名到自己的内置模块：在 pi 进程里
// `require.resolve("undici")` 返回的是字符串 "node:undici"，根本不是
// node_modules 里的 npm 包。于是 import 进来的 `fetch` / `ProxyAgent`
// 是 Bun 内置副本——内置 fetch 不会把 init.dispatcher 交给 npm 的
// ProxyAgent 使用，代理被静默忽略，请求退化为直连，被墙的域名
// （chatgpt.com 等）立刻被 RST，表现为 "Unable to connect" 或
// ECONNRESET（The socket connection was closed unexpectedly）。
//
// 两个排查时容易踩的坑：
// 1. `require("undici/package.json")` 不受影响，仍按 node_modules 解析。
//    所以打印版本号得到的是 npm 包版本（如 7.30.1），会误以为加载的
//    就是 npm 包——version 日志具有欺骗性。
// 2. 在 CLI Bun 下用 `import "undici"` 做对照实验同样命中别名，必须
//    用显式文件路径 import 才能测到 npm 包；且 CLI Bun（1.4.2）与 pi
//    内嵌 Bun（1.3.14）行为不同，孤立实验测不出 pi 内的问题。
//
// 解决办法：package.json 子路径（"undici/package.json"）的解析不受
// builtin 别名影响，先定位到 npm 包真实目录，再对该目录做 require——
// 目录/文件路径加载是纯文件操作，Bun 不会拦截。undici v7 是 CJS
//（无 "type":"module"），require 即可。这样修复只依赖源码和
// package.json 声明的版本（^7.0.0），node_modules 删了重装功能不丢。
// 用 createRequire 而不是裸 require：pi（Bun）内两者都有，但 node 以
// ESM 加载本文件时（test.mjs 直接 import）裸 require 不存在。
const nodeRequire = createRequire(import.meta.url);
const undiciDir = dirname(nodeRequire.resolve("undici/package.json"));
const undiciMod: typeof import("undici") = nodeRequire(undiciDir);
const {
  Agent,
  fetch: undiciFetch,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
} = undiciMod;
type Dispatcher = import("undici").Dispatcher;
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SocksDispatcher } from "./socks-dispatcher.ts";

// 日志开关：默认静默（console 输出会污染 pi 的 TUI 输入框）。
// 需要调试时设置环境变量 PI_MODEL_PROXY_DEBUG=1。
const DEBUG = process.env.PI_MODEL_PROXY_DEBUG === "1";
const log = (...args: unknown[]) => {
  if (DEBUG) console.log("[proxy-router]", ...args);
};
const logError = (...args: unknown[]) => {
  if (DEBUG) console.error("[proxy-router]", ...args);
};

function displayProxyUrl(proxyUrl: string | null): string {
  if (proxyUrl === null) return "direct";
  try {
    const url = new URL(proxyUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[invalid proxy URL]";
  }
}

function displayEnvValue(name: string, value: string): string {
  if (!value) return "(not set)";
  if (name === "NO_PROXY") return "(set)";
  return displayProxyUrl(value);
}

/**
 * pi-proxy-router：按模型路由代理。
 *
 * 配置在独立的 proxy-router.json（全局 ~/.pi/agent/proxy-router.json 与项目
 * .pi/proxy-router.json，项目覆盖全局）；settings.json 中的旧配置仍兼容：
 *
 *   "proxy-router": {
 *     "models": {
 *       "openai-codex/*":  "socks5h://localhost:7890",
 *       "opencode-go/gpt*": "socks5h://proxy.example.test:7890"
 *     },
 *     "auth": {
 *       "openai-codex": "socks5h://localhost:7890"
 *     }
 *   }
 *
 * - models 的 key 为 "provider/模型模式"，* 通配（provider 用实际 id，如 opencode-go）
 * - auth 按 provider 配置会话内 OAuth 登录、token exchange 和 refresh 的代理
 * - value 为代理 URL（http://、https://、socks5h://）或 "direct"（直连）
 * - 优先级：--noproxy / /noproxy（禁用）> /allproxy（全局代理，临时）
 *   > 独立配置规则 > settings 兼容规则 > Pi 默认链路
 * - 后台子 agent 可直接加载本扩展；前台子 agent 不会重新加载 ambient
 *   extensions，因此额外使用进程级 endpoint 路由兜底
 * - 规则自动对主 agent 和子 agent 生效
 */

// ── 配置加载（mtime 缓存，改文件后自动重载）────────────────────────────

interface ProxyRule {
  pattern: string;
  url: string | null; // null = 显式直连
  regex: RegExp;
}

interface AuthRule {
  provider: string;
  url: string | null; // null = 显式直连
}

interface RouteDecision {
  matched: boolean;
  url: string | null;
}

interface LoadedRules {
  modelRules: ProxyRule[];
  authRules: AuthRule[];
}

const RULE_SOURCES = [
  { path: join(homedir(), ".pi", "agent", "settings.json"), dedicated: false },
  { path: join(process.cwd(), ".pi", "settings.json"), dedicated: false },
  { path: join(homedir(), ".pi", "agent", "proxy-router.json"), dedicated: true },
  { path: join(process.cwd(), ".pi", "proxy-router.json"), dedicated: true },
];

let rulesCache: (LoadedRules & { mtimes: number[] }) | null = null;

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

function loadRules(): LoadedRules {
  const mtimes = RULE_SOURCES.map(({ path }) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  });
  if (rulesCache && mtimes.every((m, i) => m === rulesCache!.mtimes[i])) {
    return rulesCache;
  }
  const mergedModels: Record<string, string | null> = {};
  const mergedAuth: Record<string, string | null> = {};
  for (const source of RULE_SOURCES) {
    try {
      if (!existsSync(source.path)) continue;
      const settings = JSON.parse(readFileSync(source.path, "utf8")) as Record<string, unknown>;
      const node = (source.dedicated
        ? (settings["proxy-router"] ?? settings)
        : (settings["proxy-router"] ?? settings["model-proxy"])) as
        | Record<string, unknown>
        | undefined;
      if (!node || typeof node !== "object") continue;
      const modelNode =
        node.models && typeof node.models === "object" && !Array.isArray(node.models)
          ? (node.models as Record<string, unknown>)
          : node;
      for (const [pattern, value] of Object.entries(modelNode)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        mergedModels[pattern] = trimmed && !/^direct$/i.test(trimmed) ? trimmed : null;
      }
      const authNode = node.auth;
      if (authNode && typeof authNode === "object" && !Array.isArray(authNode)) {
        for (const [provider, value] of Object.entries(authNode as Record<string, unknown>)) {
          if (typeof value !== "string") continue;
          const trimmed = value.trim();
          mergedAuth[provider] = trimmed && !/^direct$/i.test(trimmed) ? trimmed : null;
        }
      }
    } catch (err) {
      logError(`config parse error (${source.path}):`, err);
    }
  }
  const modelRules = Object.entries(mergedModels).map(([pattern, url]) => ({
    pattern,
    url,
    regex: globToRegExp(pattern),
  }));
  const authRules = Object.entries(mergedAuth).map(([provider, url]) => ({ provider, url }));
  rulesCache = { modelRules, authRules, mtimes };
  return rulesCache;
}

// ── 代理 dispatcher 缓存 ─────────────────────────────────────────────

const dispatcherCache = new Map<string, Dispatcher>();
let directDispatcher: Dispatcher | undefined;

function getDispatcher(proxyUrl: string): Dispatcher {
  let dispatcher = dispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    if (/^https?:\/\//i.test(proxyUrl)) {
      dispatcher = new ProxyAgent(proxyUrl) as Dispatcher;
    } else if (/^socks5/i.test(proxyUrl)) {
      dispatcher = new SocksDispatcher(proxyUrl) as unknown as Dispatcher;
    } else {
      throw new Error(`Unsupported proxy URL: ${proxyUrl}`);
    }
    dispatcherCache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

function getRouteDispatcher(proxyUrl: string | null): Dispatcher {
  if (proxyUrl === null) {
    directDispatcher ??= new Agent() as Dispatcher;
    return directDispatcher;
  }
  return getDispatcher(proxyUrl);
}

// 运行时状态
let commandDisabled = false; // /noproxy 禁用所有代理
let allProxyUrl: string | null = null; // /allproxy 全局代理（最高优先级，临时）
let activeNoproxyFlag = false;

// 只匹配 Pi 已知的认证 endpoint；不开放任意 URL 通配，避免演变成
// GFWList。浏览器页面本身不会经过这里，只有 Pi 进程内的 token/device 请求会匹配。
const AUTH_ENDPOINTS = [
  {
    provider: "openai-codex",
    hostname: "auth.openai.com",
    path: /^\/(?:oauth\/token|api\/accounts\/deviceauth\/(?:usercode|token))$/,
  },
  {
    // Pi's `openai` provider ("Sign in with ChatGPT") exchanges and refreshes
    // tokens on a different path than openai-codex, on the same host.
    provider: "openai",
    hostname: "auth.openai.com",
    path: /^\/api\/accounts\/oauth\/token$/,
  },
  { provider: "anthropic", hostname: "platform.claude.com", path: /^\/v1\/oauth\/token$/ },
  {
    provider: "github-copilot",
    hostname: "github.com",
    path: /^\/login\/(?:device\/code|oauth\/access_token)$/,
  },
  {
    provider: "github-copilot",
    hostname: "api.github.com",
    path: /^\/copilot_internal\/v2\/token$/,
  },
  {
    provider: "github-copilot",
    hostname: "api.individual.githubcopilot.com",
    path: /^\/copilot_internal\/v2\/token$/,
  },
  { provider: "kimi-coding", hostname: "auth.kimi.com", path: /^\/api\/oauth\/(?:device_authorization|token)$/ },
  { provider: "openrouter", hostname: "openrouter.ai", path: /^\/api\/v1\/auth\/keys$/ },
  { provider: "xai", hostname: "auth.x.ai", path: /^\/oauth2\/(?:device\/code|token)$/ },
  // antigravity (Google OAuth): token exchange/refresh plus the userinfo
  // lookup during login. The browser authorization page stays outside Pi.
  { provider: "antigravity", hostname: "oauth2.googleapis.com", path: /^\/token$/ },
  { provider: "antigravity", hostname: "www.googleapis.com", path: /^\/oauth2\/v1\/userinfo$/ },
];

type ModelEndpointRoute = {
  base: URL;
  basePath: string;
  target: string;
  route: RouteDecision;
};

type ModelEndpointGroup = {
  base: URL;
  basePath: string;
  models: { target: string; route: RouteDecision }[];
};

// Routing only needs the provider and model id; every model type carries them.
type RoutedModel = { provider: string; id: string };

// The model fields the endpoint fallback needs, shared by chat, image, and
// classifier models (Model/ImageModel/ClassifierModel all carry these).
type KnownModel = RoutedModel & {
  baseUrl: string;
};

// Foreground subagents run in the parent process without ambient extensions.
// A URL cannot identify its model, so only install a fallback when every known
// model sharing that endpoint resolves to the same routing decision.
let knownModels: readonly KnownModel[] = [];
let modelEndpointRoutes: ModelEndpointRoute[] = [];
let endpointRoutesRules: LoadedRules | null = null;

function normalizeEndpointBase(raw: string): { base: URL; basePath: string } | null {
  try {
    const base = new URL(raw);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    const basePath = base.pathname.replace(/\/+$/, "") || "/";
    base.pathname = basePath;
    base.search = "";
    base.hash = "";
    return { base, basePath };
  } catch {
    return null;
  }
}

function endpointMatches(url: URL, route: ModelEndpointRoute): boolean {
  const protocol =
    url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  if (protocol !== route.base.protocol || url.host !== route.base.host) return false;
  if (route.basePath === "/") return true;
  return url.pathname === route.basePath || url.pathname.startsWith(`${route.basePath}/`);
}

function rebuildModelEndpointRoutes(): void {
  const byBase = new Map<string, ModelEndpointGroup>();
  for (const model of knownModels) {
    const route = resolveModelRoute(false, model.provider, model.id);
    const normalized = normalizeEndpointBase(model.baseUrl);
    if (!normalized) {
      if (route.matched) {
        logError(`cannot route model with invalid base URL: ${model.provider}/${model.id}`);
      }
      continue;
    }
    const key = normalized.base.toString();
    const group = byBase.get(key) ?? { ...normalized, models: [] };
    group.models.push({ target: `${model.provider}/${model.id}`, route });
    byBase.set(key, group);
  }

  const routes: ModelEndpointRoute[] = [];
  for (const [key, group] of byBase) {
    const first = group.models[0];
    if (!first) continue;
    const conflict = group.models.find(
      ({ route }) => route.matched !== first.route.matched || route.url !== first.route.url,
    );
    if (conflict) {
      logError(
        `conflicting model rules share endpoint ${key}: ${first.target}, ${conflict.target}; ` +
          "skipping URL fallback",
      );
      continue;
    }
    if (!first.route.matched) continue;
    routes.push({
      base: group.base,
      basePath: group.basePath,
      target: first.target,
      route: first.route,
    });
  }

  modelEndpointRoutes = routes.sort((a, b) => b.basePath.length - a.basePath.length);
  endpointRoutesRules = loadRules();
}

function refreshModelEndpointRoutes(models: readonly KnownModel[]): void {
  knownModels = [...models];
  rebuildModelEndpointRoutes();
}

function ensureModelEndpointRoutesFresh(): void {
  const rules = loadRules();
  if (knownModels.length > 0 && endpointRoutesRules !== rules) rebuildModelEndpointRoutes();
}

function resolveModelEndpointRoute(url: URL): RouteDecision | null {
  ensureModelEndpointRoutesFresh();
  const matched = modelEndpointRoutes.find((entry) => endpointMatches(url, entry));
  if (!matched) return null;
  log(`model endpoint route: ${matched.target} ${url.pathname} -> ${displayProxyUrl(matched.route.url)}`);
  return matched.route;
}

type ManagedDispatcher = Dispatcher & {
  __piProxyRouterGlobalDispatcher?: { fallback: Dispatcher };
};

const globalDispatcherState: { applied: Dispatcher | undefined } = { applied: undefined };

class GlobalRoutingDispatcher {
  readonly __piProxyRouterGlobalDispatcher: { fallback: Dispatcher };
  private readonly fallback: Dispatcher;

  constructor(fallback: Dispatcher) {
    this.fallback = fallback;
    this.__piProxyRouterGlobalDispatcher = { fallback };
  }

  dispatch(options: any, handler: any): boolean {
    const route = resolveGlobalRoute(activeNoproxyFlag, options);
    if (route.matched) {
      return getRouteDispatcher(route.url).dispatch(options, handler);
    }
    return this.fallback.dispatch(options, handler);
  }

  close(): Promise<void> {
    return this.fallback.close();
  }

  destroy(): Promise<void> {
    return this.fallback.destroy();
  }
}

function unwrapManagedDispatcher(current: Dispatcher): Dispatcher {
  let base = current;
  const seen = new Set<Dispatcher>();
  while (!seen.has(base)) {
    seen.add(base);
    const marker = (base as ManagedDispatcher).__piProxyRouterGlobalDispatcher;
    if (!marker?.fallback) break;
    base = marker.fallback;
  }
  return base;
}

function ensureGlobalDispatcher(noproxyFlag: boolean): void {
  const current = getGlobalDispatcher() as Dispatcher;
  if (current === globalDispatcherState.applied) return;
  const dispatcher = new GlobalRoutingDispatcher(
    unwrapManagedDispatcher(current),
  ) as unknown as Dispatcher;
  setGlobalDispatcher(dispatcher);
  globalDispatcherState.applied = dispatcher;
  log("global auth dispatcher installed");
}

function applyAllProxy(noproxyFlag: boolean): void {
  // The dispatcher stays installed for auth rules; /allproxy only changes the
  // dynamic decision made by that dispatcher.
  ensureGlobalDispatcher(noproxyFlag);
}

function getRequestUrl(options: any): URL | null {
  try {
    if (!options?.origin) return null;
    return new URL(options.path || "/", String(options.origin));
  } catch {
    return null;
  }
}

function resolveAuthProvider(url: URL): string | null {
  const hostname = url.hostname.toLowerCase();
  return (
    AUTH_ENDPOINTS.find(
      (endpoint) => endpoint.hostname === hostname && endpoint.path.test(url.pathname),
    )?.provider ?? null
  );
}

function resolveGlobalRoute(noproxyFlag: boolean, options: any): RouteDecision {
  if (noproxyFlag || commandDisabled) return { matched: false, url: null };
  if (allProxyUrl) return { matched: true, url: allProxyUrl };

  const url = getRequestUrl(options);
  if (!url) return { matched: false, url: null };

  const provider = resolveAuthProvider(url);
  if (provider) {
    const rule = loadRules().authRules.find((entry) => entry.provider === provider);
    if (rule) {
      log(`auth route: ${provider}${url.pathname} -> ${displayProxyUrl(rule.url)}`);
      return { matched: true, url: rule.url };
    }
  }

  const modelRoute = resolveModelEndpointRoute(url);
  if (modelRoute) return modelRoute;
  return { matched: false, url: null };
}

function routeStreamOptions(
  noproxyFlag: boolean,
  model: Model<any>,
  options?: StreamOptions,
): StreamOptions | undefined {
  const route = modelFetchRoute(noproxyFlag, model);
  if (!route) return options;

  const routedOptions: StreamOptions = { ...options, fetch: route.fetch };

  // openai-codex-responses may choose WebSocket by default. A routed proxy
  // supports the HTTP/SSE path; force that path instead of leaking a direct WS.
  if (model.provider === "openai-codex" && route.url !== null) {
    routedOptions.transport = "sse";
  }
  return routedOptions;
}

// Bun runtime detection. pi is a Bun-compiled binary; pi 1.3.0 embeds Bun
// 1.3.14, whose event loop never wakes npm-undici socket reads after the first
// buffered chunk: response headers (and any body bytes that arrived with
// them) come through, but reader.read() then hangs forever on streaming
// bodies — pi drains its event loop and exits 0 with an empty assistant
// message. Small non-streaming responses survive only because their whole
// body arrives in the initial read. Bun's native fetch with its `proxy`
// option streams correctly on those same versions, so http(s) proxies are
// handled through the native path when running under Bun. Node keeps the
// npm-undici path (the require-by-directory trick above exists precisely
// because Bun aliases bare "undici" imports to its builtin copy).
const isBun =
  typeof process !== "undefined" &&
  typeof (process.versions as Record<string, string> | undefined)?.bun === "string";

function makeBunProxyFetch(proxyUrl: string): NonNullable<StreamOptions["fetch"]> {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // init.dispatcher targets npm undici; Bun's native fetch takes `proxy`.
    const { dispatcher: _omit, ...rest } = (init ?? {}) as RequestInit & {
      dispatcher?: unknown;
    };
    try {
      return (await globalThis.fetch(input as never, {
        ...rest,
        proxy: proxyUrl,
      } as never)) as unknown as Response;
    } catch (err) {
      logError("proxyFetch (bun native) failed:", err);
      throw err;
    }
  }) as NonNullable<StreamOptions["fetch"]>;
}

/** Fetch bound to a route decision's proxy (null = explicit direct connection). */
export type RoutedFetch = (url: string, init?: RequestInit) => Promise<Response>;

// Under Bun an http(s) proxy goes through the native fetch `proxy` option;
// everything else (socks5, explicit direct, or Node http proxies) uses npm
// undici with an explicit dispatcher. See the note above `isBun` for the
// streaming bug that rules out npm-undici streaming under Bun.
function makeRoutedFetch(proxyUrl: string | null): RoutedFetch {
  if (proxyUrl !== null && isBun && /^https?:\/\//i.test(proxyUrl)) {
    return makeBunProxyFetch(proxyUrl) as unknown as RoutedFetch;
  }
  const dispatcher = getRouteDispatcher(proxyUrl);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return (await undiciFetch(input as never, {
        ...(init as Record<string, unknown>),
        dispatcher: dispatcher as never,
      } as never)) as unknown as Response;
    } catch (err) {
      logError("proxyFetch failed:", err);
      throw err;
    }
  }) as RoutedFetch;
}

// Per-model route decision plus the fetch bound to that route's dispatcher.
// Undefined means the model has no rule, so callers keep the options as-is.
function modelFetchRoute(
  noproxyFlag: boolean,
  model: RoutedModel,
): { fetch: NonNullable<StreamOptions["fetch"]>; url: string | null } | undefined {
  const route = resolveModelRoute(noproxyFlag, model.provider, model.id);
  if (!route.matched) return undefined;

  log(`route: ${model.provider}/${model.id} -> ${displayProxyUrl(route.url)}`);
  return { fetch: makeRoutedFetch(route.url) as NonNullable<StreamOptions["fetch"]>, url: route.url };
}

// Deferred fetch/cancel, image generation, and classification take the same
// provider request options as chat (fetch, headers, signal, ...) but no
// transport: inject the routed fetch and keep every other option untouched.
function routeProviderRequest<TOptions extends { fetch?: unknown }>(
  noproxyFlag: boolean,
  model: RoutedModel,
  options: TOptions | undefined,
): TOptions | undefined {
  const route = modelFetchRoute(noproxyFlag, model);
  if (!route) return options;
  return { ...options, fetch: route.fetch } as TOptions;
}

const ROUTED_PROVIDER = Symbol.for("pi-proxy-router.routed-provider");

type ProviderMarker = {
  original: any;
  noproxyFlag: boolean;
};

type ModelRegistryLike = {
  getAll?: () => readonly KnownModel[];
  /** `getAll()` returns chat models only; image and classifier models need this. */
  getModelsOfType?: (type: "image" | "classifier") => readonly KnownModel[];
  getProvider?: (provider: string) => any;
  registerProvider?: (provider: any) => void;
};

function providerOriginal(provider: any): any {
  let original = provider;
  const seen = new Set<any>();
  while (!seen.has(original)) {
    seen.add(original);
    const marker = original?.[ROUTED_PROVIDER] as ProviderMarker | undefined;
    if (!marker?.original) break;
    original = marker.original;
  }
  return original;
}

function makeRoutedProvider(base: any, noproxyFlag: boolean): any {
  const wrapped = { ...base };
  wrapped.streamSimple = (model: Model<any>, context: Context, options?: SimpleStreamOptions) =>
    base.streamSimple(model, context, routeStreamOptions(noproxyFlag, model, options));
  if (typeof base.stream === "function") {
    wrapped.stream = (model: Model<any>, context: Context, options?: StreamOptions) =>
      base.stream(model, context, routeStreamOptions(noproxyFlag, model, options));
  }
  // Non-chat model requests are wrapped per model too. Methods the provider
  // does not implement stay absent so Pi keeps reporting "unsupported".
  if (typeof base.fetchDeferred === "function") {
    wrapped.fetchDeferred = (
      model: Model<any>,
      handle: DeferredHandle,
      options?: DeferredFetchOptions,
    ) => base.fetchDeferred(model, handle, routeProviderRequest(noproxyFlag, model, options));
  }
  if (typeof base.cancelDeferred === "function") {
    wrapped.cancelDeferred = (
      model: Model<any>,
      handle: DeferredHandle,
      options?: DeferredCancelOptions,
    ) => base.cancelDeferred(model, handle, routeProviderRequest(noproxyFlag, model, options));
  }
  if (typeof base.generateImages === "function") {
    wrapped.generateImages = (
      model: ImageModel<ImageApi>,
      context: ImagesContext,
      options?: ImagesOptions,
    ) => base.generateImages(model, context, routeProviderRequest(noproxyFlag, model, options));
  }
  if (typeof base.classify === "function") {
    wrapped.classify = (
      model: ClassifierModel<ClassifierApi>,
      context: ClassifierContext,
      options?: ClassifierOptions,
    ) => base.classify(model, context, routeProviderRequest(noproxyFlag, model, options));
  }
  Object.defineProperty(wrapped, ROUTED_PROVIDER, {
    value: { original: base, noproxyFlag } satisfies ProviderMarker,
    enumerable: false,
  });
  return wrapped;
}

function syncModelRouting(noproxyFlag: boolean, registry: ModelRegistryLike | undefined): void {
  if (!registry?.getAll) return;
  let models: readonly KnownModel[];
  try {
    models = registry.getAll();
  } catch (err) {
    logError("cannot read model registry:", err);
    return;
  }

  // Chat models come from getAll(); image and classifier models share provider
  // base URLs, so they take part in the endpoint fallback and provider wrapping.
  if (registry.getModelsOfType) {
    for (const type of ["image", "classifier"] as const) {
      try {
        models = [...models, ...registry.getModelsOfType(type)];
      } catch (err) {
        logError(`cannot read ${type} models from registry:`, err);
      }
    }
  }

  refreshModelEndpointRoutes(models);
  ensureWebSocketFallback();

  if (!registry.getProvider || !registry.registerProvider) return;
  const providerIds = new Set(models.map((model) => model.provider));
  for (const providerId of providerIds) {
    const current = registry.getProvider(providerId);
    if (!current) continue;
    const original = providerOriginal(current);
    const shouldWrap = models.some(
      (model) =>
        model.provider === providerId &&
        resolveModelRoute(noproxyFlag, model.provider, model.id).matched,
    );
    const marker = current[ROUTED_PROVIDER] as ProviderMarker | undefined;
    try {
      if (shouldWrap) {
        if (!marker || marker.noproxyFlag !== noproxyFlag) {
          registry.registerProvider(makeRoutedProvider(original, noproxyFlag));
        }
      } else if (marker) {
        registry.registerProvider(original);
      }
    } catch (err) {
      logError(`cannot install model route for provider ${providerId}:`, err);
    }
  }
}

type WebSocketConstructor = new (...args: any[]) => any;
let wrappedWebSocket: WebSocketConstructor | undefined;

function shouldFallbackWebSocket(value: unknown): boolean {
  if (activeNoproxyFlag || commandDisabled) return false;
  try {
    const url = new URL(String(value));
    const route = resolveModelEndpointRoute(url);
    return Boolean(route?.matched && (allProxyUrl !== null || route.url !== null));
  } catch {
    return false;
  }
}

function ensureWebSocketFallback(): void {
  const globals = globalThis as unknown as { WebSocket?: WebSocketConstructor };
  const current = globals.WebSocket;
  if (!current || current === wrappedWebSocket) return;
  const BaseWebSocket = current as any;
  const RoutedWebSocket = class extends BaseWebSocket {
    constructor(...args: any[]) {
      if (shouldFallbackWebSocket(args[0])) {
        throw new Error("pi-proxy-router: routed WebSocket is disabled; retrying with SSE");
      }
      super(...args);
    }
  } as WebSocketConstructor;
  try {
    globals.WebSocket = RoutedWebSocket;
    wrappedWebSocket = RoutedWebSocket;
  } catch (err) {
    logError("cannot install WebSocket fallback:", err);
  }
}

// ── Extension bridge (globalThis.__piProxyRouter) ──────────────────────
//
// Extensions that make their own HTTP calls (e.g. pi-usage quota checks)
// cannot go through the wrapped providers or Pi's fetch pipeline, and under
// Bun the native fetch ignores the global undici dispatcher installed for
// auth endpoints. They resolve their provider API origin through this bridge
// so their requests follow the same rules (models/auth, /allproxy, /noproxy)
// as model traffic. Callers must treat `undefined` as "no rule applies" and
// fall back to their default pipeline.

export interface PiProxyRouterBridge {
  version: 1;
  /** Routed fetch for an HTTP(S) origin or base URL ("https://chatgpt.com"). */
  fetchForOrigin(origin: string): RoutedFetch | undefined;
  /** Routed fetch for a provider id: unanimous model rules, else its auth rule. */
  fetchForProvider(provider: string): RoutedFetch | undefined;
  /** Route decision for an origin; undefined when the origin is unknown. */
  resolveForOrigin(origin: string): { matched: boolean; url: string | null } | undefined;
  /** Session routing state for diagnostics. */
  status(): { disabled: boolean; allProxy: string | null };
}

function originKeyOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

// Unanimous decision across a group of models; undefined when the group is
// empty or its models resolve to conflicting routes (conflicts stay direct).
function resolveModelsRoute(models: readonly KnownModel[]): RouteDecision | undefined {
  if (models.length === 0) return undefined;
  const first = resolveModelRoute(activeNoproxyFlag, models[0].provider, models[0].id);
  for (const model of models.slice(1)) {
    const route = resolveModelRoute(activeNoproxyFlag, model.provider, model.id);
    if (route.matched !== first.matched || route.url !== first.url) return undefined;
  }
  return first;
}

function bridgeFetch(decision: RouteDecision | undefined): RoutedFetch | undefined {
  if (!decision?.matched) return undefined;
  return makeRoutedFetch(decision.url);
}

function publishBridge(): void {
  const bridge: PiProxyRouterBridge = {
    version: 1,
    fetchForOrigin(origin) {
      if (activeNoproxyFlag || commandDisabled) return undefined;
      // /allproxy covers every origin, including ones no model uses.
      if (allProxyUrl) return makeRoutedFetch(allProxyUrl);
      const key = originKeyOf(origin);
      if (!key) return undefined;
      const decision = resolveModelsRoute(
        knownModels.filter((model) => originKeyOf(model.baseUrl) === key),
      );
      if (decision) log(`bridge route: ${key} -> ${displayProxyUrl(decision.url)}`);
      return bridgeFetch(decision);
    },
    fetchForProvider(provider) {
      if (activeNoproxyFlag || commandDisabled) return undefined;
      if (allProxyUrl) return makeRoutedFetch(allProxyUrl);
      const decision = resolveModelsRoute(
        knownModels.filter((model) => model.provider === provider),
      );
      if (decision?.matched) return makeRoutedFetch(decision.url);
      // Providers without registered models (or without matching model rules)
      // fall back to their auth rule, which already describes how this
      // provider's OpenAI/GitHub/... traffic should leave the machine.
      const rule = loadRules().authRules.find((entry) => entry.provider === provider);
      return rule ? makeRoutedFetch(rule.url) : undefined;
    },
    resolveForOrigin(origin) {
      const key = originKeyOf(origin);
      if (!key) return undefined;
      return resolveModelsRoute(
        knownModels.filter((model) => originKeyOf(model.baseUrl) === key),
      );
    },
    status() {
      return { disabled: Boolean(activeNoproxyFlag || commandDisabled), allProxy: allProxyUrl };
    },
  };
  (globalThis as unknown as { __piProxyRouter?: PiProxyRouterBridge }).__piProxyRouter = bridge;
  log("bridge published on globalThis.__piProxyRouter");
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("noproxy", {
    description: "Disable proxy routing (models and temporary /allproxy requests go direct)",
    type: "boolean",
    default: false,
  });

  // Provider callbacks can outlive this extension activation across /reload or
  // session replacement. Snapshot the immutable CLI flag here so those
  // callbacks never call methods on the old ExtensionAPI instance later.
  const noproxyFlag = Boolean(pi.getFlag("noproxy"));
  activeNoproxyFlag = noproxyFlag;

  pi.registerCommand("proxy", {
    description:
      "Show current proxy routing status: /proxy [provider/model] — optional arg resolves that model",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const target = args.trim();
      const lines: string[] = [];
      lines.push("[proxy-router] status");
      lines.push(`  --noproxy flag:  ${noproxyFlag ? "on (disabled)" : "off"}`);
      lines.push(`  /noproxy:        ${commandDisabled ? "off (direct)" : "on (rules active)"}`);
      lines.push(`  /allproxy:       ${allProxyUrl ? displayProxyUrl(allProxyUrl) : "not set"}`);
      // 环境变量中的代理设置（影响 pi 的 EnvHttpProxyAgent 默认链路）
      const envVars: [string, string][] = [
        ["HTTP_PROXY", process.env.HTTP_PROXY ?? ""],
        ["HTTPS_PROXY", process.env.HTTPS_PROXY ?? ""],
        ["ALL_PROXY", process.env.ALL_PROXY ?? ""],
        ["NO_PROXY", process.env.NO_PROXY ?? ""],
      ];
      lines.push("  env:");
      for (const [name, value] of envVars) {
        lines.push(`    ${name.padEnd(12)} ${displayEnvValue(name, value)}`);
      }
      const rules = loadRules();
      lines.push(`  model rules (${rules.modelRules.length}):`);
      for (const r of rules.modelRules) {
        lines.push(`    ${r.pattern.padEnd(24)} -> ${displayProxyUrl(r.url)}`);
      }
      lines.push(`  auth rules (${rules.authRules.length}):`);
      for (const r of rules.authRules) {
        lines.push(`    ${r.provider.padEnd(24)} -> ${displayProxyUrl(r.url)}`);
      }
      lines.push(`  model endpoint fallbacks: ${modelEndpointRoutes.length}`);
      if (target) {
        const slash = target.indexOf("/");
        if (slash > 0 && slash < target.length - 1) {
          const provider = target.slice(0, slash);
          const model = target.slice(slash + 1);
          lines.push(
            `  resolve ${target} -> ${displayProxyUrl(resolveProxyUrl(noproxyFlag, provider, model))}`,
          );
        } else {
          lines.push(`  (usage: /proxy [provider/model] e.g. openai-codex/gpt-5.6-luna)`);
        }
      }
      const msg = lines.join("\n");
      log(msg);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("noproxy", {
    description: "Toggle proxy routing for this session: /noproxy [on|off]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") commandDisabled = false;
      else if (arg === "off") commandDisabled = true;
      else commandDisabled = !commandDisabled;
      applyAllProxy(noproxyFlag);
      syncModelRouting(noproxyFlag, ctx.modelRegistry);
      const state = commandDisabled ? "off (direct)" : "on (rules active)";
      log(`/noproxy -> ${state}`);
      ctx.ui.notify(`proxy-router: ${state}`, "info");
    },
  });

  pi.registerCommand("allproxy", {
    description:
      "Force Pi HTTP(S) and all models through a proxy (session-only, not persisted): /allproxy [url] — no arg to cancel",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const url = args.trim();
      if (!url) {
        allProxyUrl = null;
        applyAllProxy(noproxyFlag);
        syncModelRouting(noproxyFlag, ctx.modelRegistry);
        log("/allproxy -> off (rules active)");
        ctx.ui.notify("proxy-router: /allproxy off", "info");
        return;
      }
      if (!/^(https?|socks5h?):\/\//i.test(url)) {
        ctx.ui.notify("proxy-router: invalid proxy URL", "error");
        return;
      }
      allProxyUrl = url;
      applyAllProxy(noproxyFlag);
      syncModelRouting(noproxyFlag, ctx.modelRegistry);
      log(`/allproxy -> ${displayProxyUrl(url)} (all models)`);
      ctx.ui.notify(`proxy-router: all models -> ${displayProxyUrl(url)}`, "info");
    },
  });

  // The model registry wrapper covers every provider/API in the current session,
  // including openai-completions and anthropic-messages. The URL-level fallback
  // remains active for foreground subagents that do not load this extension.
  pi.on("session_start", (_event, ctx) => {
    syncModelRouting(noproxyFlag, ctx.modelRegistry);
  });

  // Pi may recreate its default dispatcher while runtime settings change.
  // Reinstall the auth/model-aware wrapper before every model turn.
  pi.on("before_agent_start", (_event, ctx) => {
    applyAllProxy(noproxyFlag);
    syncModelRouting(noproxyFlag, ctx.modelRegistry);
  });

  ensureGlobalDispatcher(noproxyFlag);
  ensureWebSocketFallback();
  publishBridge();
  const rules = loadRules();
  log(
    `loaded (${rules.modelRules.length} model rules, ${rules.authRules.length} auth rules ` +
      `from proxy-router config). ` +
      `--noproxy / /noproxy to disable.`,
  );
}

function resolveModelRoute(
  noproxyFlag: boolean,
  provider: string,
  modelId: string,
): RouteDecision {
  if (commandDisabled || noproxyFlag) {
    return { matched: false, url: null };
  }
  // /allproxy 临时全局代理优先于模型规则
  if (allProxyUrl) {
    return { matched: true, url: allProxyUrl };
  }
  const target = `${provider}/${modelId}`;
  for (const rule of loadRules().modelRules) {
    if (rule.regex.test(target)) {
      return { matched: true, url: rule.url };
    }
  }
  return { matched: false, url: null };
}

function resolveProxyUrl(
  noproxyFlag: boolean,
  provider: string,
  modelId: string,
): string | null {
  const route = resolveModelRoute(noproxyFlag, provider, modelId);
  return route.matched ? route.url : null;
}
