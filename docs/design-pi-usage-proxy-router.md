# Design: pi-usage 接入 pi-proxy-router 代理路由

Status: draft (待确认)
Date: 2025-10-24
Scope: `/opt/ops/agent-tools/pi-exts/pi-proxy-router` + `/opt/ops/agent-tools/pi-exts/pi-usage`

## 1. 问题与根因

### 现象
pi 内执行 `/usage` 报 codex api access error（Codex 行显示 fetch/连接类错误）。

### 根因（已实证）
pi-usage 所有出站 HTTP 都经由 `src/http.ts` 的 3 个 helper（`fetchSameOrigin` / `fetchWithTimeout` / `fetchSameOriginWithTimeout`，见 `src/http.ts:96-145`），最终调用 **global `fetch`**。pi 是 Bun 编译二进制，进程内 global fetch = Bun native fetch，直连出网。

pi-proxy-router 的两条拦截路径都覆盖不到 pi-usage：

| 拦截路径 | 机制 | 为何对 pi-usage 无效 |
|---|---|---|
| 模型路由 | wrap provider 的 `streamSimple/stream/fetchDeferred/...`（`pi-proxy-router/index.ts` makeRoutedProvider） | 只影响模型 API 调用，pi-usage 的 usage/quota 请求不经过 provider 对象 |
| auth 路由 | `setGlobalDispatcher(GlobalRoutingDispatcher)`（npm undici 全局 dispatcher） | Bun native fetch 不走 npm undici 的 global dispatcher，静默绕过 |

网络实证（本机）：

```
curl direct   https://chatgpt.com/backend-api/wham/usage  → 000 (0.11s, 被墙 RST)
curl -x http://ai-proxy.lan:7890 同 URL                  → 401 (0.82s, 已到达 API，401=未带 token，正常)
```

当前规则 `~/.pi/agent/proxy-router.json`：`openai-codex/*` 与 `openai/*`、`antigravity/*` → `http://ai-proxy.lan:7890`；即模型流量走代理、usage 检查直连，故只有 usage 检查失败。

## 2. 方案比较

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. globalThis bridge（推荐）** | pi-proxy-router 在激活时向 `globalThis.__piProxyRouter` 发布一个小型路由 API；pi-usage 在 fetch 层按 credentialBaseUrl 的 origin 查询并取回"绑定了代理的 fetch" | ✅ 单一事实来源：规则文件 + 会话态（/noproxy、/allproxy）全部生效；pi-usage 保持零依赖；router 缺席时优雅降级直连 |
| B. pi-usage 自读 proxy-router.json | 复制配置解析 + 规则匹配 + socks/http 代理栈 | ❌ 看不到会话运行态（/noproxy、/allproxy 失效）；重复实现 socks dispatcher；pi-usage 需新增 undici/socks 依赖（目前零依赖） |
| C. 进程级 HTTP(S)_PROXY 环境变量 | 启动 pi 时注入 | ❌ 全局无差别代理，破坏 kimi/zai/opencode 等国内直连 provider；与按模型路由的目标相悖 |
| D. pi-usage 直接 `import "../pi-proxy-router/index.ts"` | 跨包源码导入 | ❌ 耦合安装布局（path package / npm 安装位置不同）；/reload 时模块双实例；router 内部函数未导出，需大改 |

## 3. 详细设计（方案 A）

### 3.1 pi-proxy-router：发布 bridge

在 `pi-proxy-router/index.ts` activation 时发布（/reload 后新模块实例覆盖旧 key，天然自愈）：

```ts
export type RoutedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface PiProxyRouterBridge {
  version: 1;
  /** 按.origin 的 key（"https://chatgpt.com" 或完整 base URL 均可）解析代理路由。
   *  返回绑定了该路由的 fetch；undefined = 无规则/已禁用，调用方走默认链路。 */
  fetchForOrigin(origin: string): RoutedFetch | undefined;
  /** 按 provider id 解析（auth 规则 + 该 provider 全部模型一致路由）。 */
  fetchForProvider(provider: string): RoutedFetch | undefined;
  /** 诊断用：返回该 origin 命中的规则（matched/url），供错误信息展示 "via <proxy>"。 */
  resolveForOrigin(origin: string): { matched: boolean; url: string | null } | undefined;
  status(): { disabled: boolean; allProxy: string | null };
}
```

解析优先级（与模型路由一致）：

```
--noproxy / /noproxy（禁用）→ undefined（默认链路=直连）
/allproxy                   → 绑定 allProxyUrl 的 fetch
origin 分组规则             → 见下
```

origin 分组规则（复用现有 `knownModels`，与 `rebuildModelEndpointRoutes` 同源思路）：

1. 取 registry 中所有 baseUrl origin 与查询 origin 相同的模型（≥1 个）；
2. 这些模型的 `resolveModelRoute()` 决策**完全一致**（matched 与 url 都相同）→ 采用该决策；
3. 无模型或决策冲突 → `undefined`（直连，等价现状，无回归）。

决策 → fetch 的映射（全部为现成代码的复用/抽取）：

| 决策 | fetch 实现 |
|---|---|
| `url = http(s)://…` + Bun 运行时 | Bun native `fetch(url, {...init, proxy: url})`（现有 `makeBunProxyFetch`，http 代理流式安全） |
| `url = http(s)://…` + Node | npm-undici `undiciFetch(input, {...init, dispatcher: ProxyAgent})` |
| `url = socks5(h)://…` | npm-undici `SocksDispatcher`（现有 `dispatcherCache`） |
| `url = null`（显式 direct） | npm-undici 裸 `Agent` 直连（绕过环境变量代理） |
| 未命中 | `undefined` → 调用方默认 global fetch |

实现要点：把 `modelFetchRoute()` 内部的"route→fetch"构造抽成 `makeRoutedFetch(routeUrl: string | null): RoutedFetch`，供模型路径与 bridge 共用；bridge 发布放在 default export activation 里（`ensureGlobalDispatcher` 旁边）。

### 3.2 pi-usage：http.ts 单点接入

`src/http.ts` 增加（约 +25 行）：

```ts
function routedFetchFor(routeKey: string | undefined): RoutedFetch | undefined {
  if (!routeKey) return undefined;
  const bridge = (globalThis as { __piProxyRouter?: PiProxyRouterBridge }).__piProxyRouter;
  try { return bridge?.fetchForOrigin?.(routeKey); } catch { return undefined; }
}
```

三个 helper 改为 `const f = routedFetchFor(credentialBaseUrl) ?? fetch;`：

- `fetchSameOrigin(url, credentialBaseUrl, init)` — `src/http.ts:96`
- `fetchSameOriginWithTimeout(...)` — 复用上者
- `fetchWithTimeout(url, init, signal, routeKey?)` — 新增可选参数；唯一需要传参的调用点是 `src/opencode-go.ts:165`（dashboard URL），传入其 provider base origin

**不改任何业务调用方签名**（codex/anthropic/copilot/openrouter/subscription-probe 全部经由 credentialBaseUrl 自动路由）。

`assertCredentialOrigin` 的同源校验保持不变——凭据永远不会发往与 credentialBaseUrl 不同源的地址，按 origin 路由天然对齐安全边界。

### 3.3 降级与边界

| 场景 | 行为 |
|---|---|
| pi-proxy-router 未安装/未加载 | bridge 不存在 → 直接 global fetch（= 现状，无回归） |
| 规则未覆盖该 origin（如 api.anthropic.com、api.github.com） | undefined → 直连（现状） |
| 同 origin 多 provider 且规则冲突 | undefined → 直连（安全侧） |
| registry 尚未同步（session 未 start） | 无模型可分组 → 直连；`/usage` 总在活会话内执行，实际不受影响 |
| `direct` 显式规则 | 裸 Agent 直连 fetch（比 global fetch 更严格：不受 env 代理影响） |
| socks5 + Bun 的 npm-undici 流式 hang（已知问题，见 pi-proxy-router 源码注释） | usage 主路径（`/wham/usage`）为小 JSON 非流式，不受影响；probe 兜底是流式，受 `CHECK_TIMEOUT_MS=15s` 兜底，且仅在 usage_api 失败后触发。当前用户代理为 `http://`（Bun native 路径），完全不涉及 |

### 3.4 诊断增强（可选但推荐）

- pi-usage 检查失败且为网络类错误（TypeError: fetch failed / Unable to connect / ECONNRESET）时，错误尾注：
  - bridge 存在：`via http://ai-proxy.lan:7890`（来自 `resolveForOrigin`）或 `via direct`
  - bridge 不存在：`[hint] pi-proxy-router not loaded; usage checks go direct`
- pi-proxy-router 侧沿用 `PI_MODEL_PROXY_DEBUG=1` 日志：`[proxy-router] bridge route: https://chatgpt.com -> http://ai-proxy.lan:7890 (pi-usage)`。

## 4. 改动清单

| 仓库 | 文件 | 改动量 | 内容 |
|---|---|---|---|
| pi-proxy-router | `index.ts` | ~+90 行（含抽取重构） | `makeRoutedFetch` 抽取；origin/provider 分组解析；bridge 发布；README 增 "Extension bridge" 一节 |
| pi-proxy-router | `test.mjs` | ~+60 行 | origin 分组解析纯函数的单测（一致/冲突/空 registry/allproxy/noproxy） |
| pi-usage | `src/http.ts` | ~+30 行 | `routedFetchFor` + 3 个 helper 接入 + 错误尾注 |
| pi-usage | `src/opencode-go.ts` | 1 行 | `fetchWithTimeout` 传 routeKey |
| pi-usage | 新增 `src/http.test.ts` 或扩展现有测试 | ~+40 行 | bridge 缺席/在场/抛异常三种路径 |

## 5. 测试与验收

1. `cd pi-proxy-router && node test.mjs`（现有 + 新增）
2. `cd pi-usage && npm run check && npm test`（tsx --test）
3. 手动验收：
   - 重启 pi（或 `/reload`）→ 启动日志见 `[proxy-router] loaded`
   - `/usage` → Codex 行出现真实配额（plan/primary/secondary %），非连接错误
   - `/proxy openai-codex/gpt-5.4-mini` 显示规则仍正常
   - `/noproxy on` + `/usage` → Codex 报连接错误且尾注 `via direct`（证明会话态生效）；`/noproxy off` 恢复
   - `/allproxy http://ai-proxy.lan:7890` + `/usage` → 尾注 `via http://ai-proxy.lan:7890`（证明 allproxy 生效）
4. 回归：anthropic/copilot/openrouter 行为不变（本地可达的照常直连）。

## 6. 风险与备注

- globalThis key 命名空间唯一（`__piProxyRouter`），带 `version: 1` 字段做前向兼容判别。
- 两包分别独立 git 仓库，均在 `/opt/ops/agent-tools/pi-exts/` 本地路径安装（settings.json `packages`），改动即生效于下次重启//reload，无需发版。
- pi-usage `peerDependencies` 声明 `pi-coding-agent <1` 与当前 pi 1.4.0 不符（既有问题，与本次无关，顺带记录）。
- 未来 pi-chrome / pi-web-access 等扩展如需代理，可复用同一 bridge（本设计不展开）。
