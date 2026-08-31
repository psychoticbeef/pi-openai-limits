import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type FormatUsageOptions, UsageSnapshotStore, formatUsageStatus } from "./snapshot.js";
import {
  OPENAI_CODEX_PROVIDER,
  type UsageTransport,
  createOpenAIUsageTransport,
} from "./usage.js";

const STATUS_ID = "openai-usage";

export interface OpenAIUsageExtensionOptions extends FormatUsageOptions {
  now?: () => number;
  transport?: UsageTransport;
}

type UsageContext = Pick<ExtensionContext, "mode" | "model" | "modelRegistry" | "ui" | "signal">;

export function createPiOpenAiLimits(options: OpenAIUsageExtensionOptions = {}) {
  return function piOpenAiLimits(pi: ExtensionAPI): void {
    const now = options.now ?? Date.now;
    const store = new UsageSnapshotStore(options.transport ?? createOpenAIUsageTransport(), now);
    let generation = 0;
    let refreshInFlight: { generation: number; promise: Promise<void> } | undefined;

    const render = (ctx: UsageContext): void => {
      const snapshot = store.snapshot;
      ctx.ui.setStatus(
        STATUS_ID,
        snapshot
          ? formatUsageStatus(snapshot, now(), { locale: options.locale, timeZone: options.timeZone })
          : undefined,
      );
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
      store.clear();
      ctx.ui.setStatus(STATUS_ID, undefined);
    };

    const refresh = async (ctx: UsageContext, force: boolean): Promise<void> => {
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
        return;
      }

      if (requestedGeneration !== generation) return;
      if (!access) {
        deactivate(ctx);
        return;
      }
      if (!force && !store.canRefresh()) {
        render(ctx);
        return;
      }
      if (refreshInFlight?.generation === generation) return refreshInFlight.promise;

      const refreshGeneration = requestedGeneration;
      const promise = (async () => {
        await store.refresh(access, ctx.signal, () => refreshGeneration === generation);
        if (refreshGeneration === generation) render(ctx);
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

    pi.on("session_shutdown", (_event, ctx) => {
      deactivate(ctx);
    });
  };
}

export default createPiOpenAiLimits();

export { formatCompactAge, formatUsageStatus, REFRESH_COOLDOWN_MS, UsageSnapshotStore } from "./snapshot.js";
export {
  createOpenAIUsageTransport,
  normalizeOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
  OPENAI_USAGE_URL,
} from "./usage.js";
export type { OpenAIUsage, UsageTransport, UsageWindow } from "./usage.js";
