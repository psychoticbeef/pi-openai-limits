export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface UsageWindow {
  usedPercent: number;
  resetAt: number;
  windowSeconds: number;
}

export interface OpenAIUsage {
  fiveHour: UsageWindow;
  weekly: UsageWindow;
}

export type UsageTransport = (access: string, signal?: AbortSignal) => Promise<unknown>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid OpenAI Usage field: ${field}`);
  }
  return value;
}

function normalizeWindow(value: unknown, field: string): UsageWindow {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid OpenAI Usage field: ${field}`);
  }

  const window = value as Record<string, unknown>;
  const usedPercent = requiredNumber(window.used_percent, `${field}.used_percent`);
  const resetAt = requiredNumber(window.reset_at, `${field}.reset_at`);
  const windowSeconds = requiredNumber(window.limit_window_seconds, `${field}.limit_window_seconds`);

  if (usedPercent < 0 || usedPercent > 100 || resetAt <= 0 || windowSeconds <= 0) {
    throw new Error(`Invalid OpenAI Usage values: ${field}`);
  }

  return { usedPercent, resetAt, windowSeconds };
}

export function normalizeOpenAIUsage(payload: unknown): OpenAIUsage {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid OpenAI Usage response");
  }

  const rateLimit = (payload as Record<string, unknown>).rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") {
    throw new Error("Invalid OpenAI Usage field: rate_limit");
  }

  const limits = rateLimit as Record<string, unknown>;
  return {
    fiveHour: normalizeWindow(limits.primary_window, "rate_limit.primary_window"),
    weekly: normalizeWindow(limits.secondary_window, "rate_limit.secondary_window"),
  };
}

function decodeJwtPayload(access: string): Record<string, unknown> {
  const part = access.split(".")[1];
  if (!part) throw new Error("Pi OAuth Access has invalid token shape");

  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Pi OAuth Access has invalid token payload");
  }
}

function getAccountId(access: string): string {
  const payload = decodeJwtPayload(access);
  const auth = payload["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object"
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined;

  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Pi OAuth Access lacks ChatGPT account ID");
  }
  return accountId;
}

export function createOpenAIUsageTransport(fetchImpl: FetchLike = fetch): UsageTransport {
  return async (access, signal) => {
    const response = await fetchImpl(OPENAI_USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${access}`,
        "chatgpt-account-id": getAccountId(access),
        originator: "pi",
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI Usage request failed: HTTP ${response.status}`);
    }
    return response.json();
  };
}
