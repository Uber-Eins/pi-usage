import { PROVIDER_LABELS } from "../../lib/quotas.js";
import type {
  QuotaWindow,
  QuotasResult,
  SupportedQuotaProvider,
} from "../../types/quotas.js";
import { assessWindow, formatTimeRemaining } from "../../utils/quotas-severity.js";

export type ToolSnapshot = {
  provider: SupportedQuotaProvider;
  result: QuotasResult;
};

export interface ToolWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  used?: number;
  limit?: number;
  currency?: boolean;
  balance?: boolean;
  limited?: boolean;
  resetsAt?: string;
  resetsIn?: string;
  projectedPercent?: number;
  severity: string;
  note?: string;
}

export interface ToolProviderEntry {
  provider: SupportedQuotaProvider;
  label: string;
  active: boolean;
  ok: boolean;
  error?: string;
  windows: ToolWindow[];
  /** OpenAI Codex only: earned usage-limit resets that can be redeemed. */
  codexResets?: { available: number; nextExpiry?: string };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function toToolWindow(window: QuotaWindow): ToolWindow {
  const assessment = assessWindow(window);
  const hasReset = window.resetsAt.getTime() > 0;
  const counted =
    window.isCurrency ||
    (window.limitValue > 0 && window.limitValue !== 100 && window.label !== "Spend cap");
  // The spend cap's "OK"/"Reached" label just repeats its usage text.
  const statusLabel = window.label === "Spend cap" ? undefined : window.nextLabel;
  const note = [statusLabel && !hasReset ? statusLabel : undefined, window.nextAmount]
    .filter(Boolean)
    .join(" · ");
  return {
    label: window.label,
    usedPercent: round(window.usedPercent),
    remainingPercent: round(Math.max(0, 100 - window.usedPercent)),
    ...(counted ? { used: window.usedValue, limit: window.limitValue } : {}),
    ...(window.isCurrency ? { currency: true } : {}),
    ...(window.isBalance ? { balance: true } : {}),
    ...(window.limited ? { limited: true } : {}),
    ...(hasReset
      ? {
          resetsAt: window.resetsAt.toISOString(),
          resetsIn: formatTimeRemaining(window.resetsAt),
        }
      : {}),
    ...(assessment.pacePercent !== null
      ? { projectedPercent: round(assessment.projectedPercent) }
      : {}),
    severity: assessment.severity,
    ...(note ? { note } : {}),
  };
}

export function toProviderEntry(
  snapshot: ToolSnapshot,
  activeProvider: string | undefined,
): ToolProviderEntry {
  const base = {
    provider: snapshot.provider,
    label: PROVIDER_LABELS[snapshot.provider],
    active: snapshot.provider === activeProvider,
  };
  if (!snapshot.result.success) {
    return { ...base, ok: false, error: snapshot.result.error.message, windows: [] };
  }
  return { ...base, ok: true, windows: snapshot.result.data.windows.map(toToolWindow) };
}

function formatWindowLine(window: ToolWindow): string {
  let usage: string;
  if (window.currency) {
    const used = `$${(window.used ?? 0).toFixed(2)}`;
    if (window.balance) usage = `${used} remaining`;
    else if (!window.limit) usage = `${used} spent`;
    else usage = `${used} / $${window.limit.toFixed(2)} (${window.usedPercent}% used)`;
  } else if (window.label === "Spend cap") {
    usage = window.limited ? "reached" : "not reached";
  } else if (window.limit !== undefined) {
    usage = `${window.used}/${window.limit} used (${window.usedPercent}%)`;
  } else {
    usage = `${window.usedPercent}% used`;
  }

  const parts = [usage];
  if (window.resetsIn) parts.push(`resets in ${window.resetsIn} (${window.resetsAt})`);
  if (window.projectedPercent !== undefined) {
    parts.push(`projected ${Math.round(window.projectedPercent)}% at reset`);
  }
  if (window.note) parts.push(window.note);
  if (window.limited && window.label !== "Spend cap") parts.push("LIMITED");
  if (window.severity !== "none") parts.push(`risk: ${window.severity}`);
  return `  ${window.label}: ${parts.join(", ")}`;
}

export function formatProviderEntry(entry: ToolProviderEntry): string {
  const header = `${entry.label} (${entry.provider})${entry.active ? " [current model]" : ""}`;
  if (!entry.ok) return `${header}\n  error: ${entry.error}`;
  const lines = [header];
  if (entry.windows.length === 0) lines.push("  no quota windows reported");
  lines.push(...entry.windows.map(formatWindowLine));
  if (entry.codexResets) {
    const { available, nextExpiry } = entry.codexResets;
    lines.push(
      available > 0
        ? `  Usage limit resets: ${available} available (the user can redeem them from /usage)` +
            (nextExpiry ? `, next expires ${nextExpiry}` : "")
        : "  Usage limit resets: none available",
    );
  }
  return lines.join("\n");
}
