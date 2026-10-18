import assert from "node:assert/strict";
import test from "node:test";
import { fetchUsageSnapshot, parseZaiCodingCnUsageBody, usageFamily, ZAI_CODING_CN_USAGE_URL } from "../usage.ts";

const now = Date.now();
const body = {
  success: true, code: 200,
  data: { level: "pro", limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: now + 3_600_000 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 81, nextResetTime: now + 86_400_000 },
    { type: "TIME_LIMIT", unit: 6, number: 1, percentage: 100, nextResetTime: now + 86_400_000 },
  ] },
};

test("GLM CN parses explicit credit windows without confusing MCP quota", () => {
  assert.equal(usageFamily("zai-coding-cn"), "zai-coding-cn");
  assert.equal(usageFamily("zai-coding-cn-account-2"), "zai-coding-cn");
  assert.equal(usageFamily("zai"), undefined, "global keys must not be sent to the CN endpoint");
  const result = parseZaiCodingCnUsageBody("zai-coding-cn", body, now, "safe-hash");
  assert.equal(result?.plan, "pro");
  assert.equal(result?.primary?.usedPercent, 42);
  assert.equal(result?.primary?.windowSeconds, 18_000);
  assert.equal(result?.secondary?.usedPercent, 81);
  assert.equal(result?.secondary?.windowSeconds, 604_800);
});

test("GLM CN missing, expired and failed quota responses never invent headroom", () => {
  for (const value of [undefined, null, "", false, "invalid"]) {
    const input = structuredClone(body) as any;
    input.data.limits = [{ ...input.data.limits[0], percentage: value }];
    assert.equal(parseZaiCodingCnUsageBody("zai-coding-cn", input, now), undefined);
  }
  assert.equal(parseZaiCodingCnUsageBody("zai-coding-cn", { ...body, success: false }, now), undefined);
  assert.equal(parseZaiCodingCnUsageBody("zai-coding-cn", { ...body, code: 401 }, now), undefined);
  assert.equal(parseZaiCodingCnUsageBody("zai-coding-cn", body, now + 2 * 86_400_000), undefined);
});

test("GLM CN uses raw API-key authorization only at the fixed HTTPS endpoint", async () => {
  let calls = 0;
  const result = await fetchUsageSnapshot("zai-coding-cn", { type: "api_key", key: "fixture-coding-key" }, {
    fetchImpl: (async (url, options) => {
      calls++;
      assert.equal(url, ZAI_CODING_CN_USAGE_URL);
      assert.equal(new Headers(options?.headers).get("Authorization"), "fixture-coding-key");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      return Response.json(body);
    }) as typeof fetch,
  });
  assert.equal(calls, 1);
  assert.equal(result.primary?.usedPercent, 42);
  assert.doesNotMatch(JSON.stringify(result), /fixture-coding-key/);
});
