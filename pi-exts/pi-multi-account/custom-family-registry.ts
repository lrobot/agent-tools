import type { UsageCredential, UsageSnapshot } from "./usage.ts";

export interface CustomFamilyDescriptor {
  family: string;
  label: string;
  idPattern: RegExp;
  fetchUsageSnapshot?: (
    provider: string,
    credential: UsageCredential,
    options?: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      credentialHash?: string;
    },
  ) => Promise<UsageSnapshot>;
  qualityBand?: (modelId: string) => "frontier" | "balanced" | "fast" | "apex" | undefined;
}

const customFamilies = new Map<string, CustomFamilyDescriptor>();

export function registerCustomFamily(descriptor: CustomFamilyDescriptor): void {
  customFamilies.set(descriptor.family, descriptor);
}

export function findCustomFamily(providerId: string): CustomFamilyDescriptor | undefined {
  for (const descriptor of customFamilies.values()) {
    if (
      descriptor.idPattern.test(providerId) ||
      providerId === descriptor.family ||
      providerId.startsWith(`${descriptor.family}-account-`)
    ) {
      return descriptor;
    }
  }
  return undefined;
}

export function getAllCustomFamilies(): CustomFamilyDescriptor[] {
  return Array.from(customFamilies.values());
}
