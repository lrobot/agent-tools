import assert from "node:assert/strict";
import test from "node:test";
import {
  findCustomFamily,
  getAllCustomFamilies,
  registerCustomFamily,
} from "../custom-family-registry.ts";
import {
  fetchUsageSnapshot,
  providerUsageLabel,
  usageFamily,
  type UsageCredential,
} from "../usage.ts";

test("custom family registration and discovery", () => {
  registerCustomFamily({
    family: "antigravity",
    label: "Gemini",
    idPattern: /^antigravity(-account-\d+)?$/,
    qualityBand: (modelId: string) => {
      const id = modelId.toLowerCase();
      if (id.includes("flash") || id.includes("lite")) return "fast";
      if (id.includes("pro") || id.includes("ultra")) return "frontier";
      return "balanced";
    },
    fetchUsageSnapshot: async (provider: string, credential: UsageCredential) => {
      return {
        provider,
        family: "antigravity",
        fetchedAt: 1234567890,
        plan: "Google Cloud Code Assist",
        account: credential.access ? "user@example.com" : undefined,
        primary: {
          usedPercent: 20,
          resetAt: 1234567890 + 3600 * 1000 * 4,
          windowSeconds: 5 * 3600,
        },
      };
    },
  });

  const foundBase = findCustomFamily("antigravity");
  assert.equal(foundBase?.family, "antigravity");
  assert.equal(foundBase?.label, "Gemini");

  const foundSlot2 = findCustomFamily("antigravity-account-2");
  assert.equal(foundSlot2?.family, "antigravity");

  const families = getAllCustomFamilies();
  assert.ok(families.some((f) => f.family === "antigravity"));
});

test("custom family usage resolution and label formatting", async () => {
  assert.equal(usageFamily("antigravity"), "antigravity");
  assert.equal(usageFamily("antigravity-account-2"), "antigravity");
  assert.equal(usageFamily("antigravity-account-5"), "antigravity");

  assert.equal(providerUsageLabel("antigravity"), "Gemini");
  assert.equal(providerUsageLabel("antigravity-account-2"), "Gemini A2");
  assert.equal(providerUsageLabel("antigravity-account-3"), "Gemini A3");

  const snapshot = await fetchUsageSnapshot(
    "antigravity-account-2",
    { access: "mock-token" },
  );
  assert.equal(snapshot.provider, "antigravity-account-2");
  assert.equal(snapshot.family, "antigravity");
  assert.equal(snapshot.plan, "Google Cloud Code Assist");
  assert.equal(snapshot.account, "user@example.com");
  assert.equal(snapshot.primary?.usedPercent, 20);
});

test("custom family quality band evaluation", () => {
  const family = findCustomFamily("antigravity");
  assert.ok(family);
  assert.equal(family.qualityBand?.("gemini-2.5-flash"), "fast");
  assert.equal(family.qualityBand?.("gemini-2.5-pro"), "frontier");
  assert.equal(family.qualityBand?.("claude-3-5-sonnet"), "balanced");
});
