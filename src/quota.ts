import { OPENAI_CODEX_PROVIDER, type OpenAIUsage, type UsageWindow } from "./usage.js";

export const CONTINUATION_GRACE_MS = 5 * 60 * 1000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ContinuationPlan {
  key: string;
  resetAt: number;
  continueAt: number;
}

export function isSupportedQuotaFailure(status: number, provider: string | undefined): boolean {
  return provider === OPENAI_CODEX_PROVIDER && status === 429;
}

function isExhausted(window: UsageWindow, nowSeconds: number): boolean {
  const resetDelaySeconds = window.resetAt - nowSeconds;
  return Number.isFinite(window.usedPercent)
    && window.usedPercent >= 100
    && Number.isFinite(window.resetAt)
    && Number.isFinite(window.windowSeconds)
    && window.windowSeconds > 0
    && resetDelaySeconds > 0
    && resetDelaySeconds <= window.windowSeconds
    && resetDelaySeconds * 1000 + CONTINUATION_GRACE_MS <= MAX_TIMER_DELAY_MS;
}

export function planContinuation(usage: OpenAIUsage, now: number): ContinuationPlan | undefined {
  const nowSeconds = now / 1000;
  const exhausted = usage.windows
    .filter((window) => isExhausted(window, nowSeconds))
    .sort((left, right) => right.resetAt - left.resetAt);
  const blockingWindow = exhausted[0];
  if (!blockingWindow) return undefined;

  return {
    key: `${blockingWindow.windowSeconds}:${blockingWindow.resetAt}`,
    resetAt: blockingWindow.resetAt,
    continueAt: blockingWindow.resetAt * 1000 + CONTINUATION_GRACE_MS,
  };
}
