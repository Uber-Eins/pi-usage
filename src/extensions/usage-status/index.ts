import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  USAGE_CONFIG_UPDATED_EVENT,
  USAGE_EXTENSIONS_REGISTER_EVENT,
  USAGE_EXTENSIONS_REQUEST_EVENT,
  type UsageConfigUpdatedPayload,
  type UsageStatusPlacement,
  configLoader,
} from "../../config.js";

/** Event emitted by pi-synthetic when its usage-status extension registers. */
const SYNTHETIC_EXTENSIONS_REGISTER_EVENT = "synthetic:extensions:register";
interface SyntheticExtensionsRegisterPayload {
  feature: string;
}
import { quotaAuthStorage } from "../../lib/auth.js";
import {
  fetchProviderQuotas,
  isSupportedProvider,
} from "../../lib/quotas.js";
import {
  assessWindow,
  formatTimeRemaining,
  getSeverityColor,
  type RiskSeverity,
} from "../../utils/quotas-severity.js";
import type { QuotaWindow } from "../../types/quotas.js";
import { formatWindowStatus, type WindowStatus } from "./format-status.js";

const EXTENSION_ID = "pi-usage";
const REFRESH_INTERVAL_MS = 60_000;
const STALE_CONTEXT_MESSAGE = "This extension ctx is stale";

function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_CONTEXT_MESSAGE);
}

function getContextProvider(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  try {
    return ctx.model?.provider;
  } catch (error) {
    if (isStaleContextError(error)) return undefined;
    throw error;
  }
}

function formatFooterResetTime(resetsAt: string): string {
  const remaining = formatTimeRemaining(new Date(resetsAt));
  return remaining === "now" ? "now" : `in ${remaining}`;
}

const SEVERITY_GLYPHS: Record<RiskSeverity, string> = {
  none: "●",
  warning: "▲",
  high: "✕",
  critical: "✕",
};
const SEVERITY_ORDER: RiskSeverity[] = ["none", "warning", "high", "critical"];

/**
 * Format the status line. When `detailed` (dedicated widget line), prepend a
 * severity glyph and include pace/exhaustion hints that would not fit in the
 * shared footer row.
 */
export function formatStatus(
  ctx: Pick<ExtensionContext, "ui">,
  windows: WindowStatus[],
  detailed = false,
): string {
  const theme = ctx.ui.theme;
  const body = windows
    .map((w) => {
      const core = formatWindowStatus(theme, w, detailed);
      const reset = w.resetsAt ? theme.fg("dim", ` (↺${formatFooterResetTime(w.resetsAt)})`) : "";
      return `${core}${reset}`;
    })
    .join(" ");

  if (!detailed || windows.length === 0) return body;

  const maxSeverity = windows.reduce<RiskSeverity>(
    (acc, w) =>
      SEVERITY_ORDER.indexOf(w.severity) > SEVERITY_ORDER.indexOf(acc)
        ? w.severity
        : acc,
    "none",
  );
  return `${theme.fg(getSeverityColor(maxSeverity), SEVERITY_GLYPHS[maxSeverity])} ${body}`;
}

const ANTHROPIC_SUBSCRIPTION_WINDOW_LABELS = new Set([
  "5h",
  "7d",
  "7d Sonnet",
  "7d Opus",
  "7d Opus (legacy)",
]);

function shouldShowInStatus(window: QuotaWindow): boolean {
  return !(
    window.provider === "anthropic" &&
    ANTHROPIC_SUBSCRIPTION_WINDOW_LABELS.has(window.label)
  );
}

export function toWindowStatus(window: QuotaWindow): WindowStatus {
  return {
    label: window.label,
    usedPercent: window.usedPercent,
    severity: assessWindow(window).severity,
    resetsAt: window.resetsAt.getTime() > 0 ? window.resetsAt.toISOString() : null,
    limited: window.limited ?? false,
    isCurrency: window.isCurrency,
    usedValue: window.usedValue,
    limitValue: window.limitValue,
    windowSeconds: window.windowSeconds,
  };
}

export function toStatusWindows(windows: QuotaWindow[]): WindowStatus[] {
  return windows.filter(shouldShowInStatus).map(toWindowStatus);
}

export function formatStatusForFooter(
  ctx: Pick<ExtensionContext, "ui">,
  windows: WindowStatus[],
  detailed = false,
): string | undefined {
  if (windows.length === 0) return undefined;
  return formatStatus(ctx, windows, detailed);
}

function createStatusRefresher() {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let activeProvider: string | undefined;
  let lastStatus: WindowStatus[] | undefined;
  let inFlight = false;
  let queued = false;
  // Render target for the status. Kept in sync with the config rather than
  // re-read from the config store so an in-session placement change applies
  // even when the extension's module instance has a stale config snapshot.
  let placement: UsageStatusPlacement = "statusBar";

  // Bumped whenever the active ctx/provider is replaced or the refresher stops.
  // This prevents an old async fetch from writing to a replacement session.
  let generation = 0;

  function deactivate(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    activeContext = undefined;
    activeProvider = undefined;
    lastStatus = undefined;
    queued = false;
    generation++;
  }

  function setStatusSafely(
    ctx: ExtensionContext | undefined,
    text: string | undefined | ((ctx: ExtensionContext) => string | undefined),
  ): boolean {
    if (!ctx) return false;
    try {
      if (!ctx.hasUI) return true;
      const value = typeof text === "function" ? text(ctx) : text;

      // Widget component factories only render in the TUI. In RPC/print/json
      // modes, fall back to the shared status row so the status is not lost.
      if (placement === "statusBar" || ctx.mode !== "tui") {
        // Vacate the widget channel when switching back to the shared row.
        ctx.ui.setWidget(EXTENSION_ID, undefined);
        ctx.ui.setStatus(EXTENSION_ID, value);
        return true;
      }

      // Dedicated line: keep the shared status row clear so other extensions
      // are not displaced, and render the status in our own widget. A factory
      // (not a string array) lets us truncate to a single line instead of
      // letting `Text` wrap into multiple rows.
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      if (!value) {
        ctx.ui.setWidget(EXTENSION_ID, undefined, { placement });
        return true;
      }
      ctx.ui.setWidget(
        EXTENSION_ID,
        () => ({
          render(width: number): string[] {
            if (width <= 0) return [""];
            return [` ${truncateToWidth(value, Math.max(0, width - 1), "...")}`];
          },
          invalidate(): void {},
        }),
        { placement },
      );
      return true;
    } catch (error) {
      if (isStaleContextError(error) && activeContext === ctx) deactivate();
      return false;
    }
  }

  async function update(ctx: ExtensionContext, requestGeneration = generation): Promise<void> {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      if (requestGeneration !== generation || activeContext !== ctx) return;
      if (!ctx.hasUI || !activeProvider || !isSupportedProvider(activeProvider)) return;

      const provider = activeProvider;
      const result = await fetchProviderQuotas(quotaAuthStorage(ctx.modelRegistry), provider);
      if (requestGeneration !== generation || activeContext !== ctx) return;

      if (!result.success) {
        // A "not applicable" result (e.g. a direct Anthropic API key with no
        // OAuth subscription usage) is expected, not a failure — show nothing
        // rather than a persistent "usage unavailable" warning.
        if (result.error.kind === "not_applicable") {
          setStatusSafely(ctx, undefined);
          return;
        }
        setStatusSafely(ctx, (ctx) => ctx.ui.theme.fg("warning", "usage unavailable"));
        return;
      }
      const windows: WindowStatus[] = toStatusWindows(result.data.windows);
      // Only the TUI renders widget factories; other modes fall back to the
      // shared row, which must stay compact.
      const detailed = placement !== "statusBar" && ctx.mode === "tui";
      const status = formatStatusForFooter(ctx, windows, detailed);
      lastStatus = status === undefined ? undefined : windows;
      setStatusSafely(ctx, status);
    } catch (error) {
      if (isStaleContextError(error)) {
        if (activeContext === ctx) deactivate();
        return;
      }
      setStatusSafely(ctx, (ctx) => ctx.ui.theme.fg("warning", "usage unavailable"));
    } finally {
      inFlight = false;
      if (queued && activeContext) {
        queued = false;
        void update(activeContext, generation).catch(() => undefined);
      }
    }
  }

  return {
    setPlacement(next: UsageStatusPlacement): void {
      placement = next;
    },
    async refreshFor(ctx: ExtensionContext): Promise<void> {
      activeContext = ctx;
      activeProvider = getContextProvider(ctx);
      generation++;
      const requestGeneration = generation;
      if (!activeProvider || !isSupportedProvider(activeProvider)) {
        setStatusSafely(ctx, undefined);
        return;
      }
      await update(ctx, requestGeneration);
    },
    start(): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (activeContext) void update(activeContext, generation).catch(() => undefined);
      }, REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
    },
    stop(ctx?: ExtensionContext): void {
      deactivate();
      setStatusSafely(ctx, undefined);
    },
    renderLast(ctx: ExtensionContext): boolean {
      if (!lastStatus) return false;
      return setStatusSafely(ctx, (ctx) =>
        formatStatusForFooter(
          ctx,
          lastStatus ?? [],
          placement !== "statusBar" && ctx.mode === "tui",
        ),
      );
    },
  };
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const refresher = createStatusRefresher();
  refresher.setPlacement(
    configLoader.getConfig().usageStatusPlacement ?? "statusBar",
  );
  const unsubscribeEventBusListeners: Array<() => void> = [];
  let enabled = configLoader.getConfig().usageStatus;
  let deferToSynthetic = configLoader.getConfig().deferToSynthetic;
  let currentContext: ExtensionContext | undefined;

  /** Whether pi-synthetic's usage footer is active in this session. */
  let syntheticUsageActive = false;

  unsubscribeEventBusListeners.push(pi.events.on(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, (data: unknown) => {
    const { feature } = data as SyntheticExtensionsRegisterPayload;
    if (feature === "usageStatus") {
      syntheticUsageActive = true;
      // If currently showing synthetic data, clear our footer
      if (currentContext && enabled && deferToSynthetic && getContextProvider(currentContext) === "synthetic") {
        refresher.stop(currentContext);
      }
    }
  }));

  function scheduleRefresh(ctx: ExtensionContext): void {
    void refresher.refreshFor(ctx).catch(() => undefined);
  }

  unsubscribeEventBusListeners.push(pi.events.on(USAGE_CONFIG_UPDATED_EVENT, (data: unknown) => {
    const config = (data as UsageConfigUpdatedPayload).config;
    enabled = config.usageStatus;
    deferToSynthetic = config.deferToSynthetic;
    refresher.setPlacement(config.usageStatusPlacement ?? "statusBar");
    if (!enabled) {
      refresher.stop(currentContext);
      return;
    }
    if (currentContext) {
      // Same guard as session_start / turn_end / model_select: saving any
      // setting must not resurrect our footer while pi-synthetic is showing
      // the same data and deferToSynthetic is on.
      if (shouldDeferToSynthetic(getContextProvider(currentContext))) {
        refresher.stop(currentContext);
        return;
      }
      refresher.start();
      scheduleRefresh(currentContext);
    }
  }));

  /**
   * Whether to suppress our footer because pi-synthetic is showing
   * the same data for the Synthetic provider.
   */
  function shouldDeferToSynthetic(provider: string | undefined): boolean {
    return deferToSynthetic && syntheticUsageActive && provider === "synthetic";
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    refresher.setPlacement(
      configLoader.getConfig().usageStatusPlacement ?? "statusBar",
    );
    if (!enabled) {
      refresher.stop(ctx);
      return;
    }
    if (shouldDeferToSynthetic(getContextProvider(ctx))) {
      refresher.stop(ctx);
      return;
    }
    refresher.start();
    scheduleRefresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) return;
    if (shouldDeferToSynthetic(getContextProvider(ctx))) {
      refresher.stop(ctx);
      return;
    }
    scheduleRefresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) {
      refresher.stop(ctx);
      return;
    }
    if (shouldDeferToSynthetic(getContextProvider(ctx))) {
      refresher.stop(ctx);
      return;
    }
    scheduleRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    currentContext = undefined;
    syntheticUsageActive = false;
    refresher.stop(ctx);
    for (const unsubscribe of unsubscribeEventBusListeners.splice(0)) {
      unsubscribe();
    }
  });

  // Register regardless of the enabled flag: registration means "pi loaded
  // this sub-extension", which is what makes the feature toggleable in
  // /usage settings. Gating on the flag here prevented re-enabling a feature
  // that was disabled at startup.
  unsubscribeEventBusListeners.push(pi.events.on(USAGE_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, { feature: "usageStatus" });
  }));
}
