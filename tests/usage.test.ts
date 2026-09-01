import { describe, expect, it, vi } from "vitest";

import {
  OPENAI_USAGE_URL,
  createOpenAIUsageTransport,
  normalizeOpenAIUsage,
} from "../src/usage.js";

const payload = {
  rate_limit: {
    primary_window: {
      used_percent: 25.4,
      reset_at: 1_735_737_400,
      limit_window_seconds: 18_000,
    },
    secondary_window: {
      used_percent: 61,
      reset_at: 1_736_251_200,
      limit_window_seconds: 604_800,
    },
  },
};

function accessToken(accountId = "acct-123"): string {
  const body = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${body}.signature`;
}

describe("Eligibility and OpenAI Usage Client", () => {
  it("UT-1 normalizes five-hour and weekly OpenAI Usage without credential material", () => {
    const usage = normalizeOpenAIUsage(payload);

    const fiveHour = { usedPercent: 25.4, resetAt: 1_735_737_400, windowSeconds: 18_000 };
    const weekly = { usedPercent: 61, resetAt: 1_736_251_200, windowSeconds: 604_800 };
    expect(usage).toEqual({ windows: [fiveHour, weekly], fiveHour, weekly });
    expect(JSON.stringify(usage)).not.toContain("access");
    expect(JSON.stringify(usage)).not.toContain("acct-123");
  });

  it("UT-1 rejects malformed OpenAI Usage responses", () => {
    expect(() => normalizeOpenAIUsage({ rate_limit: { primary_window: {} } })).toThrow(
      "rate_limit.primary_window.used_percent",
    );
    expect(() => normalizeOpenAIUsage({ rate_limit: {
      primary_window: { ...payload.rate_limit.primary_window, used_percent: 101 },
      secondary_window: null,
    } })).toThrow("Invalid OpenAI Usage values");
    expect(() => normalizeOpenAIUsage({ rate_limit: {
      primary_window: null,
      secondary_window: null,
    } })).toThrow("rate_limit windows");
  });

  it.each([
    ["absent", null],
    ["malformed", { used_percent: 101 }],
  ])("UT-8 preserves one valid Reset Window when another is %s", (_case, secondaryWindow) => {
    const usage = normalizeOpenAIUsage({ rate_limit: {
      primary_window: payload.rate_limit.secondary_window,
      secondary_window: secondaryWindow,
    } });

    expect(usage).toEqual({
      windows: [{ usedPercent: 61, resetAt: 1_736_251_200, windowSeconds: 604_800 }],
      weekly: { usedPercent: 61, resetAt: 1_736_251_200, windowSeconds: 604_800 },
    });
  });

  it("UT-8 identifies reordered Reset Windows by duration", () => {
    const usage = normalizeOpenAIUsage({ rate_limit: {
      primary_window: payload.rate_limit.secondary_window,
      secondary_window: payload.rate_limit.primary_window,
    } });

    expect(usage.windows?.map((window) => window.windowSeconds)).toEqual([18_000, 604_800]);
    expect(usage.fiveHour?.usedPercent).toBe(25.4);
    expect(usage.weekly?.usedPercent).toBe(61);
  });

  it("UT-1 sends Pi OAuth Access directly to transport with transient account header", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const transport = createOpenAIUsageTransport(fetchImpl);
    const token = accessToken();

    const result = await transport(token);

    expect(result).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(OPENAI_USAGE_URL);
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "acct-123",
    });
  });

  it("UT-1 reports bounded diagnostics without exposing Pi OAuth Access", async () => {
    const token = accessToken("secret-account");
    const transport = createOpenAIUsageTransport(async () => new Response("denied", { status: 403 }));

    await expect(transport(token)).rejects.toThrow("OpenAI Usage request failed: HTTP 403");
    await expect(transport(token)).rejects.not.toThrow(token);
    await expect(transport("invalid-token")).rejects.toThrow("Pi OAuth Access has invalid token shape");
  });
});
