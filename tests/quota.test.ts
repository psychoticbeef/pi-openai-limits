import { describe, expect, it } from "vitest";

import {
  CONTINUATION_GRACE_MS,
  isSupportedQuotaFailure,
  planContinuation,
} from "../src/quota.js";
import type { OpenAIUsage } from "../src/usage.js";

const NOW = Date.UTC(2025, 0, 1, 12, 0, 0);

function usage(fiveHourUsed: number, weeklyUsed: number): OpenAIUsage {
  return {
    fiveHour: { usedPercent: fiveHourUsed, resetAt: NOW / 1000 + 3600, windowSeconds: 18_000 },
    weekly: { usedPercent: weeklyUsed, resetAt: NOW / 1000 + 86_400, windowSeconds: 604_800 },
  };
}

describe("Quota Failure Classifier and Reset Planner", () => {
  it("UT-3 classifies only supported OpenAI Usage exhaustion signals", () => {
    expect(isSupportedQuotaFailure(429, "openai-codex")).toBe(true);
    expect(isSupportedQuotaFailure(500, "openai-codex")).toBe(false);
    expect(isSupportedQuotaFailure(429, "anthropic")).toBe(false);
    expect(isSupportedQuotaFailure(429, undefined)).toBe(false);
  });

  it("UT-3 plans five-hour exhaustion for reset plus five minutes", () => {
    const plan = planContinuation(usage(100, 40), NOW);

    expect(plan).toEqual({
      key: `18000:${NOW / 1000 + 3600}`,
      resetAt: NOW / 1000 + 3600,
      continueAt: NOW + 3600_000 + CONTINUATION_GRACE_MS,
    });
  });

  it("UT-3 plans weekly-only exhaustion for reset plus five minutes", () => {
    const plan = planContinuation(usage(40, 100), NOW);

    expect(plan?.resetAt).toBe(NOW / 1000 + 86_400);
    expect(plan?.continueAt).toBe(NOW + 86_400_000 + CONTINUATION_GRACE_MS);
  });

  it("UT-3 selects later weekly reset when both OpenAI Usage windows are exhausted", () => {
    expect(planContinuation(usage(100, 100), NOW)?.resetAt).toBe(NOW / 1000 + 86_400);
  });

  it("UT-3 rejects unexhausted, missing, expired, and invalid reset timestamps", () => {
    expect(planContinuation(usage(99.9, 99.9), NOW)).toBeUndefined();

    const missing = usage(100, 0);
    (missing.fiveHour as unknown as { resetAt?: number }).resetAt = undefined;
    expect(planContinuation(missing, NOW)).toBeUndefined();

    const expired = usage(100, 0);
    expired.fiveHour.resetAt = NOW / 1000;
    expect(planContinuation(expired, NOW)).toBeUndefined();

    const invalid = usage(100, 0);
    invalid.fiveHour.resetAt = Number.NaN;
    expect(planContinuation(invalid, NOW)).toBeUndefined();

    const implausible = usage(100, 0);
    implausible.fiveHour.resetAt = NOW / 1000 + implausible.fiveHour.windowSeconds + 1;
    expect(planContinuation(implausible, NOW)).toBeUndefined();
  });
});
