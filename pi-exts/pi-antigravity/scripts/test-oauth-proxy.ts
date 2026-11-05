import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGlobalDispatcher,
  MockAgent,
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import {
  loginAntigravity,
  REDIRECT_URI,
  refreshAntigravityToken,
  type OAuthLoginCallbacks,
} from "../src/auth/oauth.js";

const proxyEnvNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const originalEnv = new Map(proxyEnvNames.map((name) => [name, process.env[name]]));
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
const originalProxyDispatch = ProxyAgent.prototype.dispatch;
const originalProxyClose = ProxyAgent.prototype.close;
const originalConsoleError = console.error;
const tempHome = mkdtempSync(join(tmpdir(), "antigravity-oauth-proxy-"));
const proxyDispatches: string[] = [];
const proxyAgents: ProxyAgent[] = [];
const closedProxyAgents: ProxyAgent[] = [];
const proxyEnvDuringRequests: string[] = [];
const logs: string[] = [];
const mock = new MockAgent();
mock.disableNetConnect();

try {
  const configDir = join(tempHome, ".pi", "agent");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "proxy-router.json"),
    JSON.stringify({
      auth: { antigravity: "http://proxy-user:proxy-pass@127.0.0.1:7890" },
    }),
  );
  process.env.HOME = tempHome;
  for (const name of proxyEnvNames) {
    process.env[name] = "http://environment-proxy.invalid:8080";
  }
  const expectedEnvSnapshot = JSON.stringify(
    proxyEnvNames.map((name) => [name, "http://environment-proxy.invalid:8080"]),
  );

  const mockDispatch = mock.dispatch.bind(mock);
  mock.dispatch = (options, handler) => {
    proxyEnvDuringRequests.push(
      JSON.stringify(proxyEnvNames.map((name) => [name, process.env[name]])),
    );
    return mockDispatch(options, handler);
  };
  ProxyAgent.prototype.dispatch = function (options, handler) {
    if (!proxyAgents.includes(this)) proxyAgents.push(this);
    proxyDispatches.push(`${options.method} ${options.origin}${options.path}`);
    return mock.dispatch(options, handler);
  };
  ProxyAgent.prototype.close = function (...args: unknown[]) {
    closedProxyAgents.push(this);
    return Reflect.apply(originalProxyClose, this, args) as Promise<void>;
  };
  setGlobalDispatcher(mock);
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  const tokenResponse = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
  };
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenResponse, { headers: { "content-type": "application/json" } });
  mock
    .get("https://www.googleapis.com")
    .intercept({ path: "/oauth2/v1/userinfo?alt=json", method: "GET" })
    .reply(200, { email: "oauth-test@example.com" }, {
      headers: { "content-type": "application/json" },
    });
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenResponse, { headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1internal:loadCodeAssist")) {
      return Response.json({ projectId: "test-project" });
    }
    throw new Error(`Unexpected native fetch: ${url}`);
  }) as typeof fetch;

  const callbackAbort = new AbortController();
  const credentials = await loginAntigravity({
    onAuth({ url }) {
      const callbackUrl = new URL(REDIRECT_URI);
      callbackUrl.searchParams.set("code", "test-code");
      callbackUrl.searchParams.set("state", new URL(url).searchParams.get("state") || "");
      const request = httpGet(callbackUrl, (response) => {
        if (response.statusCode !== 200) {
          callbackAbort.abort(new Error(`Callback status ${response.statusCode}`));
        }
        response.resume();
      });
      request.on("error", (error) => callbackAbort.abort(error));
    },
    onDeviceCode() {
      throw new Error("Unexpected device-code callback");
    },
    async onSelect() {
      return undefined;
    },
    signal: callbackAbort.signal,
  } as OAuthLoginCallbacks);
  assert.equal(credentials.access, "new-access");
  assert.equal(credentials.email, "oauth-test@example.com");
  assert.equal(credentials.projectId, "test-project");

  const refreshed = await refreshAntigravityToken(credentials);
  assert.equal(refreshed.access, "new-access");
  assert.equal(refreshed.refresh, "new-refresh");

  assert.deepEqual(proxyDispatches, [
    "POST https://oauth2.googleapis.com/token",
    "GET https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    "POST https://oauth2.googleapis.com/token",
  ]);
  assert.ok(proxyEnvDuringRequests.length > 0);
  assert.deepEqual(new Set(proxyEnvDuringRequests), new Set([expectedEnvSnapshot]));
  const proxyLogs = logs.filter((line) => line.includes("http://127.0.0.1:7890"));
  assert.equal(proxyLogs.length, 1);
  assert.ok(!logs.join("\n").includes("proxy-user"));
  assert.ok(!logs.join("\n").includes("proxy-pass"));

  let notifyFirstRequestStarted!: () => void;
  const firstRequestStarted = new Promise<void>((resolve) => {
    notifyFirstRequestStarted = resolve;
  });
  let releaseFirstResponse!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(async () => {
      notifyFirstRequestStarted();
      await firstResponseGate;
      return {
        statusCode: 200,
        data: tokenResponse,
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    });

  const firstAgent = proxyAgents[0];
  assert.ok(firstAgent);
  const firstRefresh = refreshAntigravityToken(credentials);
  await firstRequestStarted;
  writeFileSync(
    join(tempHome, ".pi", "agent", "proxy-router.json"),
    JSON.stringify({ auth: { antigravity: "http://127.0.0.1:7891" } }),
  );
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenResponse, { headers: { "content-type": "application/json" } });
  const secondRefresh = await refreshAntigravityToken(credentials);
  assert.equal(secondRefresh.access, "new-access");
  const secondAgent = proxyAgents[1];
  assert.ok(secondAgent);
  const firstAgentClosedWhilePending = closedProxyAgents.includes(firstAgent);
  releaseFirstResponse();
  assert.equal((await firstRefresh).access, "new-access");
  assert.equal(firstAgentClosedWhilePending, false);
  assert.ok(closedProxyAgents.includes(firstAgent));
  assert.deepEqual(proxyDispatches.slice(3), [
    "POST https://oauth2.googleapis.com/token",
    "POST https://oauth2.googleapis.com/token",
  ]);

  writeFileSync(
    join(tempHome, ".pi", "agent", "proxy-router.json"),
    JSON.stringify({ auth: { antigravity: null } }),
  );
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenResponse, { headers: { "content-type": "application/json" } });
  const directRefresh = await refreshAntigravityToken(credentials);
  assert.equal(directRefresh.access, "new-access");
  assert.equal(proxyDispatches.length, 5);
  assert.ok(closedProxyAgents.includes(secondAgent));
  mock.assertNoPendingInterceptors();
} finally {
  ProxyAgent.prototype.dispatch = originalProxyDispatch;
  ProxyAgent.prototype.close = originalProxyClose;
  setGlobalDispatcher(originalDispatcher);
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const name of proxyEnvNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await mock.close();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log("OAuth explicit ProxyAgent login, userinfo, refresh, and safe logging tests passed");
