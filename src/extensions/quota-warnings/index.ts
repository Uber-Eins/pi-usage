import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  USAGE_CONFIG_UPDATED_EVENT,
  USAGE_EXTENSIONS_REGISTER_EVENT,
  USAGE_EXTENSIONS_REQUEST_EVENT,
  type UsageConfigUpdatedPayload,
  configLoader,
} from "../../config.js";
import { quotaAuthStorage } from "../../lib/auth.js";
import {
  fetchProviderQuotas,
  isSupportedProvider,
  PROVIDER_LABELS,
} from "../../lib/quotas.js";
import {
  assessWindow,
  formatTimeRemaining,
  type RiskSeverity,
} from "../../utils/quotas-severity.js";

const COOLDOWN_MS = 60 * 60 * 1000;
const MIN_FETCH_INTERVAL_MS = 30_000;

type AlertState = { lastSeverity: RiskSeverity; lastNotifiedAt: number };
const alertState = new Map<string, AlertState>();
let lastFetchAt = 0;

function shouldNotify(key: string, severity: RiskSeverity): boolean {
  const current = alertState.get(key);
  if (!current) return true;
  const order: RiskSeverity[] = ["none", "warning", "high", "critical"];
  if (order.indexOf(severity) > order.indexOf(current.lastSeverity))
    return true;
  return Date.now() - current.lastNotifiedAt >= COOLDOWN_MS;
}

function markNotified(key: string, severity: RiskSeverity): void {
  alertState.set(key, { lastSeverity: severity, lastNotifiedAt: Date.now() });
}

function clearAlertState(): void {
  alertState.clear();
  lastFetchAt = 0;
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  let enabled = configLoader.getConfig().quotaWarnings;
  let currentContext: ExtensionContext | undefined;
  async function check(ctx: ExtensionContext, onlyNew: boolean): Promise<void> {
    const provider = ctx.model?.provider;
    if (!ctx.hasUI || !provider || !isSupportedProvider(provider)) return;
    const now = Date.now();
    if (onlyNew && now - lastFetchAt < MIN_FETCH_INTERVAL_MS) return;
    lastFetchAt = now;

    const result = await fetchProviderQuotas(
      quotaAuthStorage(ctx.modelRegistry),
      provider,
    );
    if (!result.success) return;

    const risky = result.data.windows
      .map((window) => ({ window, assessment: assessWindow(window) }))
      .filter((entry) => entry.assessment.severity !== "none");
    if (risky.length === 0) return;

    const toNotify = onlyNew
      ? risky.filter((entry) =>
        shouldNotify(
          `${provider}:${entry.window.label}`,
          entry.assessment.severity,
        ),
      )
      : risky;
    if (toNotify.length === 0) return;

    for (const entry of toNotify) {
      markNotified(
        `${provider}:${entry.window.label}`,
        entry.assessment.severity,
      );
    }

    const providerName = PROVIDER_LABELS[provider];

    const lines = toNotify.map(({ window, assessment }) => {
      // A zero resetsAt means "reset time unknown" — never claim it resets now.
      const hasReset = window.resetsAt.getTime() > 0;
      const resetsIn = hasReset
        ? `; resets in ${formatTimeRemaining(window.resetsAt)}`
        : "";
      if (window.limited || window.usedPercent >= 100) {
        return `- ${window.label}: limit reached${resetsIn}`;
      }

      const used = Math.round(window.usedPercent);
      if (assessment.pacePercent === null) {
        return `- ${window.label}: ${used}% used${resetsIn} (${assessment.severity} risk)`;
      }

      const projected = Math.round(assessment.projectedPercent);
      const byReset = hasReset
        ? ` by reset in ${formatTimeRemaining(window.resetsAt)}`
        : "";
      return `- ${window.label}: ${used}% used, projected ${projected}%${byReset} (${assessment.severity} risk)`;
    });

    // Quota risk is actionable but is not an extension or API failure. Using
    // the warning level avoids Pi presenting these notifications as errors.
    ctx.ui.notify(`${providerName} quota warning:\n${lines.join("\n")}`, "warning");
  }

  function scheduleCheck(ctx: ExtensionContext, onlyNew: boolean): void {
    void check(ctx, onlyNew).catch(() => {
      // Quota warnings are opportunistic; never let a failed quota check block Pi events.
    });
  }

  pi.events.on(USAGE_CONFIG_UPDATED_EVENT, (data: unknown) => {
    enabled = (data as UsageConfigUpdatedPayload).config.quotaWarnings;
    if (!enabled) {
      clearAlertState();
      return;
    }
    if (currentContext) {
      clearAlertState();
      scheduleCheck(currentContext, false);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    clearAlertState();
    if (!enabled) return;
    scheduleCheck(ctx, false);
  });

  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) return;
    scheduleCheck(ctx, true);
  });

  pi.on("model_select", async (_event, ctx) => {
    currentContext = ctx;
    clearAlertState();
  });

  pi.on("session_shutdown", async () => {
    currentContext = undefined;
    clearAlertState();
  });

  // Register regardless of the enabled flag so /usage settings can re-enable
  // a feature that was disabled at startup.
  pi.events.on(USAGE_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, {
      feature: "quotaWarnings",
    });
  });
}
