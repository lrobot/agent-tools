# pi-usage 支持 yaml-providers 实例的用量/余额展示

状态: 设计稿, 待确认
日期: 2026-10-24
关联: `design_pi_usage_proxy_router.md` (已完成并合入 subtree)

## 1. 背景与目标

yaml-providers 扩展从 `~/.agent_instances.yaml` + `~/.ssh/secret.yaml` 注册 pi provider,
注册 ID 形如 `dotc-<instance>-<api>`。当前 default profile 下活跃实例:

| instance | provider | baseUrl | 账号数 |
|---|---|---|---|
| openrouter | openrouter | https://openrouter.ai/api | 1 |
| bigmodeltoken | bigmodel | https://open.bigmodel.cn/api/anthropic | 1 |
| kimiqq | kimicoding | https://api.kimi.com/coding/ | 1 |
| kimitoken | kimicoding | https://api.kimi.com/coding/ | 1 (另一个账号) |
| deepseektoken | deepseek | https://api.deepseek.com/anthropic | 1 |
| globalaijc | globalai | https://globalai.vip | (本次不做) |

pi-usage 现在只认固定 provider id(`openrouter`/`kimi-coding` 等), 与 `dotc-*` id 对不上,
所以 `/usage` 和状态栏都不显示这些实例 —— 包括 openrouter(它的 auth 走
`getProviderAuth("openrouter")`, registry 里没有这个 id)。

目标: `/usage` 报告 + 状态栏展示上述每个实例的用量/配额/余额, 每 key 独立检查,
网络仍然走 pi-proxy-router bridge(已完成的能力, 免费获得)。

## 2. 各厂商 API 调研结果

来源: `info_widget/fetcher/src/adapters/`(用户自有项目, 已实测) + 官方文档/社区核实。

### 2.1 BigModel (open.bigmodel.cn) — 窗口配额

- `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`
- 认证: `Authorization: <原始key>`(**无 Bearer 前缀**, info_widget 实测验证过)
- 响应: `data.level` = tier; `data.limits[]` 中 `type=="TOKENS_LIMIT"` 的条目含
  `percentage`(0-100) 与 `nextResetTime`(epoch **ms**); 按 nextResetTime 升序,
  [0]=5h 窗口, [1]=7d 窗口, 需 >=2 条
- origin: quota URL 与 credential baseUrl (…/api/anthropic) 同 origin ✓
  → 复用 `fetchSameOriginWithTimeout` + bridge

### 2.2 Kimi Coding (api.kimi.com/coding) — 窗口配额 ×2 账号

- `GET https://api.kimi.com/coding/v1/usages` (即现有 `KIMI_CODING_USAGE_URL`)
- 认证: `Authorization: Bearer <key>`, UA 建议 `KimiCLI/1.6`(info_widget 带此 UA)
- 两种响应形态都要支持:
  - 旧: `usage`(周窗口 {limit,used,remaining,resetTime}) + `limits[]`(300 分钟=5h 滚动窗口)
    —— pi-usage 现有 `parseKimiUsagePayload` 已覆盖(数值是字符串, `jsonNumber` 已兼容)
  - 新(社区 issue #3908 / CodexBar 证实): 顶层 `usages` 聚合对象
    `limit_5h` / `limit_7d` / `limit_month_total` / `limit_month_code`,
    每个 `{used_ratio: 0..1, reset_time: ISO}` —— 需要给 parser 补这层
    (info_widget `ratioWin()` 逻辑可直接移植: pct = round(ratio*100))
- 两个 instance(kimiqq / kimitoken)是不同 secret = 不同账号, 必须各自检查、各自显示

### 2.3 DeepSeek (api.deepseek.com) — 余额(无用量 API)

- 官方开放平台 API 仅支持 `GET https://api.deepseek.com/user/balance` (Bearer)
- 响应: `{is_available, balance_infos[0]: {currency: "CNY"|"USD", total_balance,
  granted_balance(赠金), topped_up_balance(充值)}}`(字符串数字)
- 平台网页版确实有用量/费用接口(`platform.deepseek.com/api/v0/usage/by_api_key/*`),
  但 2026-08 起**拒绝 API Key**(40003), 只接受邮箱密码登录 token —— 涉及存储平台
  账号密码 + device_id 指纹, 不适合进 pi-usage, 本次不做(文档记录)
- 展示形态: 余额金额(类似 OpenRouter 的 money 风格), 而非百分比窗口

### 2.4 OpenRouter (openrouter.ai) — 复用现有模块

- 现有 `checkOpenRouterUsage(auth)` 调 `/api/v1/key` + `/api/v1/credits`,
  逻辑原样复用; 只是 auth 来源从"registry 里叫 openrouter 的 provider"改为
  "origin 匹配到的 dotc 实例"(逐实例)
- `API_URL = https://openrouter.ai/api/v1` 与 credential baseUrl 同 origin ✓

### 2.5 globalai (globalai.vip, newapi 聚合) — 本次不做

newapi 系有 `/v1/dashboard/billing/subscription|usage`(one-api 兼容), 但用户未列入
需求; 记为 future(加一行 origin 表条目即可扩展)。

## 3. 设计

### 3.1 发现机制 (新 `src/vendor-instances.ts`)

```
discoverVendorInstances(ctx):
  for providerId of ctx.modelRegistry.getProviders().keys():   // dotc-kimiqq-anthropic-messages, ...
    baseUrl = resolveProviderBaseUrl(ctx, providerId)          // 已有函数
    origin  = httpOrigin(baseUrl)                              // 已有函数
    vendor  = VENDOR_ORIGINS.get(origin)                       // 新表: 见下
    if !vendor: continue
    auth = await resolveBoundProviderAuth(ctx, providerId)     // 已有: getProviderAuth 读注册 apiKey
    if !auth: continue
    label = instanceLabel(providerId, vendor)                  // dotc-kimiqq-anthropic-messages → "kimiqq"
    → { providerId, vendor, label, auth }
```

`VENDOR_ORIGINS` 表(origin → vendor 检查器):

| origin | vendor | 检查 |
|---|---|---|
| https://open.bigmodel.cn | bigmodel | checkBigModelInstance |
| https://api.kimi.com | kimi-coding | checkKimiCodingInstance |
| https://api.deepseek.com | deepseek | checkDeepSeekBalance |
| https://openrouter.ai | openrouter | checkOpenRouterUsage(复用) |

要点:
- 按 **origin** 匹配而非 provider id → 对任意 instance 命名免疫; 未来加厂商 = 表加一行
- 同一账号注册到多个 pi provider id(理论上 openai+anthropic 两组)会按不同 providerId
  各查一次 —— 实际数据全部来自 anthropic-messages 组, 可接受; 用 providerId 做 key
- 通用订阅探针(SUBSCRIPTION_PROVIDERS 循环)不动, 两套并存不冲突(现有 kimi-coding
  provider id 无人注册, 自然隐藏)

### 3.2 数据模型 (`src/types.ts`)

```ts
export interface VendorInstanceUsage {
  providerId: string;        // dotc-kimiqq-anthropic-messages (runCheck 的 key)
  vendor: "bigmodel" | "kimi-coding" | "deepseek" | "openrouter";
  label: string;             // "kimiqq"
  // 窗口型(bigmodel / kimi-coding): rolling/weekly/monthly + status, 复用
  //   SubscriptionQuotaWindow 与 renderSubscriptionWindows 的渲染
  rolling?: SubscriptionQuotaWindow;
  weekly?: SubscriptionQuotaWindow;
  monthly?: SubscriptionQuotaWindow;
  // 金额型(deepseek / openrouter)
  balance?: { amount: number; currency: string; granted?: number; toppedUp?: number };
  openrouter?: OpenRouterUsage;      // 原样挂 openrouter 结果
  error?: string;
}

UsageSnapshot 增加: instances: VendorInstanceUsage[]
```

状态栏/报告里窗口型实例直接走现有 `footerSummary`/`renderSubscriptionWindows` 同款
样式(百分比+reset);金额型走新的两行小组件(报告)与 `¥40.41` / `$9.12`(状态栏)。

### 3.3 index.ts 接线

- `refreshUsage` 内、SUBSCRIPTION_PROVIDERS 循环之后: `discoverVendorInstances(ctx)`
  一次性枚举(try/catch 包住, registry 异常不拖垮整个刷新), 逐实例 `runCheck`:
  - key = providerId → 自动获得 auto-refresh 过期重查(`expiredProvidersNeedingRefresh`
    按 provider key 工作, 无需改)、manual filter、并发隔离
  - apply/update 写入 `Map<string, VendorInstanceUsage>`; onUnavailable 删除
- openrouter 特例: 现有 builtin `openrouter` 检查保留不动(registry 真有名为
  `openrouter` 的 provider 时仍然工作); dotc openrouter 实例走 instances 列表,
  两者不会同时出现(同一台机器只有一种注册方式)

### 3.4 渲染 (`src/render.ts`)

`/usage` 报告(窗口型在 subscriptions 之后, 金额型在 openrouter 之后):

```
⚡ Usage Limits
GLM (bigmodeltoken)                    ← sectionLines 现有样式
  5h   ▇▇▇▇▇ 42%   resets in 2h
  7d   ▇▇ 15%        resets in 3d
Kimi (kimiqq)
  5h … 7d …
Kimi (kimitoken)
  …
DeepSeek (deepseektoken)
  Balance ¥40.41 · 赠金 ¥10.00 · 充值 ¥30.41
OpenRouter (openrouter)
  Today $0.42 · Credit $9.12 · Budget $2/$10
```

状态栏(紧凑): `⚡ … │ GLM: 42%r/2h,15%w/3d │ Kimi(qq): … │ Kimi(token): … │ DS: ¥40.41 │ OR: $9.12`

shortLabel 规则: bigmodel→`GLM`, kimi-coding→`Kimi(qq)`/`Kimi(token)`(label 后缀),
deepseek→`DS`, openrouter→`OR`; 全部来自 VENDOR 表 + instance label。

### 3.5 Kimi parser 增强 (`src/kimi.ts`)

`parseKimiUsagePayload` 增加顶层 `usages` 聚合形态: `limit_5h→rolling`,
`limit_7d→weekly`, `limit_month_total/month_code→monthly`(取存在者, 不合并)。
**实施修订(2026-10-24 实测)**: 聚合形态与 detail/usage 形态冲突时**聚合优先**——
kimiqq 实测 detail 5h 窗口报 remaining=100 而聚合 used_ratio=0.4612,
detail 字段不稳定(kimi-code#3908 同源问题), 聚合才是权威。展示仍遵循原始形态:
月计划账号显示 5h+month, 周计划账号显示 5h+week, 互不换算。

### 3.6 网络

全部走现有 `fetchSameOriginWithTimeout(url, credentialBaseUrl)` → 已接入
`globalThis.__piProxyRouter` bridge。当前 proxy-router 规则未覆盖这 4 个 origin →
直连(国内站点本来就该直连);用户以后在 proxy-router.json 加规则即自动生效, 零改动。

## 4. 测试

- 新 `src/vendor-instances.test.ts`: origin 表匹配、label 提取、bigmodel/deepseek
  fixture 解析(info_widget 实测形态)、discover 的 registry mock、kimi 双实例独立检查
- `kimi.test.ts`: 补聚合形态 payload(used_ratio/reset_time)
- `render` 相关: instances 报告行 + footer part(现有 render 测试风格)
- 全量: `npm run check && npm test`

## 5. 改动清单

| 文件 | 动作 |
|---|---|
| src/vendor-instances.ts | 新增: VENDOR_ORIGINS 表 + discover + bigmodel/deepseek 检查器 |
| src/kimi.ts | 增强: usages.limit_* 聚合形态 |
| src/types.ts | VendorInstanceUsage + UsageSnapshot.instances |
| index.ts | 发现循环 + runCheck 接线 |
| src/render.ts | 报告 section + footer parts |
| src/vendor-instances.test.ts, kimi.test.ts | 测试 |
| README.md | providers 支持矩阵更新 |

## 6. 明确不做

- DeepSeek 平台账号密码登录拿用量(见 2.3)
- globalai/newapi billing(见 2.5)
- Moonshot(api.moonshot.cn)余额 —— 当前无活跃实例, 表里暂不收
