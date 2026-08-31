import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { planContinuation, isSupportedQuotaFailure } from "./quota.js";
import { type FormatUsageOptions, UsageSnapshotStore, formatUsageStatus } from "./snapshot.js";
import {
  ContinuationTimerRegistry,
  formatContinuationCountdown,
  systemTimerScheduler,
  type TimerScheduler,
} from "./timer.js";
import {
  OPENAI_CODEX_PROVIDER,
  type UsageTransport,
  createOpenAIUsageTransport,
} from "./usage.js";

const STATUS_ID = "openai-usage";

export interface OpenAIUsageExtensionOptions extends FormatUsageOptions {
  now?: () => number;
  onContinuation?: (resetAt: number) => void;
  scheduler?: TimerScheduler;
  transport?: UsageTransport;
}

type UsageContext = Pick<ExtensionContext, "mode" | "model" | "modelRegistry" | "ui" | "signal">;

export function createPiOpenAiLimits(options: OpenAIUsageExtensionOptions = {}) {
  return function piOpenAiLimits(pi: ExtensionAPI): void {
    const now = options.now ?? Date.now;
    const store = new UsageSnapshotStore(options.transport ?? createOpenAIUsageTransport(), now);
    const timers = new ContinuationTimerRegistry(options.scheduler ?? systemTimerScheduler, now);
    let generation = 0;
    let refreshInFlight: { generation: number; promise: Promise<boolean> } | undefined;

    const render = (ctx: UsageContext): void => {
      const snapshot = store.snapshot;
      const remainingMs = timers.remainingMs;
      const usageStatus = snapshot
        ? formatUsageStatus(snapshot, now(), { locale: options.locale, timeZone: options.timeZone })
        : undefined;
      const countdown = remainingMs === undefined
        ? undefined
        : `continue in ${formatContinuationCountdown(remainingMs)}`;
      ctx.ui.setStatus(STATUS_ID, [usageStatus, countdown].filter(Boolean).join(" | ") || undefined);
    };

    const resolveAccess = async (ctx: UsageContext): Promise<string | undefined> => {
      const model = ctx.model;
      if (ctx.mode !== "tui" || !model || model.provider !== OPENAI_CODEX_PROVIDER) return undefined;
      if (!ctx.modelRegistry.isUsingOAuth(model)) return undefined;

      const resolved = await ctx.modelRegistry.getProviderAuth(OPENAI_CODEX_PROVIDER);
      return resolved?.auth.apiKey;
    };

    const deactivate = (ctx: UsageContext): void => {
      generation++;
      timers.clear();
      store.clear();
      ctx.ui.setStatus(STATUS_ID, undefined);
    };

    const refresh = async (ctx: UsageContext, force: boolean): Promise<boolean> => {
      const requestedGeneration = generation;
      let access: string | undefined;
      try {
        access = await resolveAccess(ctx);
      } catch {
        if (requestedGeneration === generation) {
          if (store.snapshot) {
            store.markStale();
            render(ctx);
          } else {
            deactivate(ctx);
          }
        }
        return false;
      }

      if (requestedGeneration !== generation) return false;
      if (!access) {
        deactivate(ctx);
        return false;
      }
      if (!force && !store.canRefresh()) {
        render(ctx);
        return false;
      }
      if (refreshInFlight?.generation === generation) return refreshInFlight.promise;

      const refreshGeneration = requestedGeneration;
      const promise = (async () => {
        const refreshed = await store.refresh(access, ctx.signal, () => refreshGeneration === generation);
        if (refreshGeneration === generation) render(ctx);
        return refreshed;
      })().finally(() => {
        if (refreshInFlight?.promise === promise) refreshInFlight = undefined;
      });
      refreshInFlight = { generation: refreshGeneration, promise };
      return promise;
    };

    pi.on("session_start", async (_event, ctx) => {
      deactivate(ctx);
      await refresh(ctx, true);
    });

    pi.on("model_select", async (_event, ctx) => {
      generation++;
      store.markStale();
      await refresh(ctx, true);
    });

    pi.on("before_agent_start", (_event, ctx) => {
      store.markStale();
      render(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      await refresh(ctx, false);
    });

    const handleQuotaFailure = async (ctx: UsageContext, requestedGeneration: number): Promise<void> => {
      const refreshed = await refresh(ctx, true);
      if (requestedGeneration !== generation) return;

      const snapshot = store.snapshot;
      const plan = snapshot ? planContinuation(snapshot.usage, now()) : undefined;
      if (!plan) {
        const active = timers.plan;
        if (refreshed && active && now() < active.resetAt * 1000) {
          timers.clear();
          render(ctx);
        }
        return;
      }

      timers.schedule(
        plan,
        (fired) => {
          try {
            options.onContinuation?.(fired.resetAt);
          } catch {
            // Continuation observers must not break timer cleanup.
          }
          try {
            pi.events.emit("openai-limits:continuation", { resetAt: fired.resetAt });
          } catch {
            // Inter-extension observers must not break timer cleanup.
          }
        },
        () => render(ctx),
      );
    };

    pi.on("after_provider_response", (event, ctx) => {
      if (!isSupportedQuotaFailure(event.status, ctx.model?.provider) || ctx.mode !== "tui") return;
      const requestedGeneration = generation;
      void handleQuotaFailure(ctx, requestedGeneration).catch(() => {});
    });

    pi.on("session_shutdown", (_event, ctx) => {
      deactivate(ctx);
    });
  };
}

export default createPiOpenAiLimits();

export { CONTINUATION_GRACE_MS, MAX_TIMER_DELAY_MS, isSupportedQuotaFailure, planContinuation } from "./quota.js";
export { formatCompactAge, formatUsageStatus, REFRESH_COOLDOWN_MS, UsageSnapshotStore } from "./snapshot.js";
export { ContinuationTimerRegistry, formatContinuationCountdown, systemTimerScheduler } from "./timer.js";
export type { TimerScheduler } from "./timer.js";
export {
  createOpenAIUsageTransport,
  normalizeOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
  OPENAI_USAGE_URL,
} from "./usage.js";
export type { OpenAIUsage, UsageTransport, UsageWindow } from "./usage.js";
