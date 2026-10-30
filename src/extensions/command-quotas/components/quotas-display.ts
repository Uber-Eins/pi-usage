import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Loader, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import pkg from "../../../../package.json" with { type: "json" };
import { PROVIDER_LABELS } from "../../../lib/quotas.js";
import type { CodexResetAvailability, CodexResetOption } from "../../../providers/codex-resets.js";
import type { QuotasResult, SupportedQuotaProvider } from "../../../types/quotas.js";
import {
  assessWindow,
  formatTimeRemaining,
  getPacePercent,
  getSeverityColor,
} from "../../../utils/quotas-severity.js";

type Snapshot = {
  provider: SupportedQuotaProvider;
  result: QuotasResult;
};

type QuotasState =
  | { type: "loading" }
  | { type: "loaded"; snapshots: Snapshot[] };

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

function isHourlyOrWeeklyWindow(windowSeconds: number): boolean {
  if (windowSeconds < HOUR_SECONDS) return false;
  if (windowSeconds <= 12 * HOUR_SECONDS) return true;
  return windowSeconds >= 6 * DAY_SECONDS && windowSeconds <= 8 * DAY_SECONDS;
}

function renderProgressBar(
  percent: number,
  width: number,
  theme: Theme,
  fillColor: "success" | "warning" | "error",
  timePercent?: number | null,
): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const timeIndex =
    timePercent === null || timePercent === undefined || !Number.isFinite(timePercent)
      ? null
      : Math.min(
          width - 1,
          Math.round((Math.max(0, Math.min(100, timePercent)) / 100) * width),
        );
  const parts: string[] = [];
  for (let idx = 0; idx < width; idx++) {
    if (timeIndex !== null && idx === timeIndex) {
      parts.push(theme.fg("dim", "|"));
    } else if (idx < filled) {
      parts.push(theme.fg(fillColor, "█"));
    } else {
      parts.push(theme.fg("dim", "░"));
    }
  }
  return parts.join("");
}

export interface CodexResetActions {
  /** Redeem one reset and return a human-readable outcome message. */
  redeem: (option: CodexResetOption) => Promise<string>;
}

function formatExpiry(option: CodexResetOption): string {
  if (!option.expiresAt) return "does not expire";
  return `expires ${option.expiresAt.toLocaleString()}`;
}

export class QuotasComponent implements Component {
  private state: QuotasState = { type: "loading" };
  private loader: Loader | null = null;
  private codexResets: CodexResetAvailability | undefined;
  /** Index of the highlighted reset option while the confirmation is open. */
  private resetPicker: number | null = null;
  private redeeming = false;
  private resetMessage: string | undefined;

  constructor(
    private theme: Theme,
    private tui: any,
    private title: string,
    private onClose: () => void,
    private onRefetch: () => void,
    private resetActions?: CodexResetActions,
  ) {
    this.startLoader();
  }

  private startLoader(): void {
    this.loader = new Loader(
      this.tui,
      (s: string) => this.theme.fg("accent", s),
      (s: string) => this.theme.fg("muted", s),
      "Fetching usage...",
    );
  }

  destroy(): void {
    this.loader?.stop();
    this.loader = null;
  }

  setState(state: QuotasState): void {
    if (state.type === "loading") {
      this.loader?.stop();
      this.startLoader();
    } else if (this.state.type === "loading") {
      this.loader?.stop();
      this.loader = null;
    }
    this.state = state;
  }

  setCodexResets(resets: CodexResetAvailability | undefined): void {
    this.codexResets = resets;
    if (!this.canRedeem()) this.resetPicker = null;
  }

  private canRedeem(): boolean {
    return (
      !!this.resetActions &&
      this.state.type === "loaded" &&
      (this.codexResets?.options.length ?? 0) > 0
    );
  }

  private async redeem(option: CodexResetOption): Promise<void> {
    if (!this.resetActions) return;
    this.redeeming = true;
    this.resetMessage = "Redeeming usage limit reset...";
    this.tui.requestRender();
    try {
      this.resetMessage = await this.resetActions.redeem(option);
    } catch (err) {
      this.resetMessage = `Reset failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.redeeming = false;
      this.resetPicker = null;
    }
    this.onRefetch();
  }

  private handleResetPickerInput(data: string): boolean {
    const options = this.codexResets?.options ?? [];
    const index = this.resetPicker ?? 0;
    if (matchesKey(data, "escape") || data === "n") {
      this.resetPicker = null;
    } else if (matchesKey(data, "up")) {
      this.resetPicker = (index - 1 + options.length) % options.length;
    } else if (matchesKey(data, "down")) {
      this.resetPicker = (index + 1) % options.length;
    } else if (matchesKey(data, "enter") || data === "y") {
      const option = options[index];
      if (option) void this.redeem(option);
    }
    this.tui.requestRender();
    return true;
  }

  handleInput(data: string): boolean {
    // A redemption cannot be cancelled once it was confirmed.
    if (this.redeeming) return true;
    if (this.resetPicker !== null) return this.handleResetPickerInput(data);
    if (data === "x" && this.canRedeem()) {
      this.resetPicker = 0;
      this.resetMessage = undefined;
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return true;
    }
    if (data === "r") {
      this.onRefetch();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const border = new DynamicBorder((s: string) => this.theme.fg("border", s));
    lines.push(...border.render(width));
    lines.push(truncateToWidth(` ${this.theme.fg("accent", this.theme.bold(this.title))}`, width));

    if (this.state.type === "loading") {
      lines.push(...(this.loader ? this.loader.render(width) : [this.theme.fg("muted", "  Fetching quotas...")]));
    } else {
      lines.push(...this.renderLoaded(this.state.snapshots, width));
      if (this.resetPicker !== null) lines.push(...this.renderResetPicker());
    }

    if (this.resetMessage) {
      lines.push("");
      lines.push(`  ${this.theme.fg("accent", this.resetMessage)}`);
    }

    lines.push("");
    const resetHint = this.canRedeem() && this.resetPicker === null ? "  x reset codex" : "";
    lines.push(
      this.theme.fg(
        "dim",
        this.resetPicker !== null
          ? "  ↑↓ select  enter/y redeem  n/Esc cancel"
          : `  pi-usage v${pkg.version}  ·  r to refresh${resetHint}  q/Esc to close`,
      ),
    );
    lines.push(...border.render(width));
    // Pi rejects over-wide lines. Bound the complete output, including help
    // text and loader output, when the terminal is narrow or resized.
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderLoaded(snapshots: Snapshot[], maxWidth: number): string[] {
    if (snapshots.length === 0) {
      return [
        "",
        truncateToWidth(
          `  ${this.theme.fg("dim", "No active quota subscriptions detected")}`,
          maxWidth,
        ),
      ];
    }

    const lines: string[] = [""];
    for (const snapshot of snapshots) {
      lines.push(...this.renderProvider(snapshot, maxWidth));
      lines.push("");
    }
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  private renderResetPicker(): string[] {
    const options = this.codexResets?.options ?? [];
    const lines = ["", `  ${this.theme.fg("accent", this.theme.bold("Redeem a Codex usage limit reset?"))}`];
    options.forEach((option, index) => {
      const selected = index === this.resetPicker;
      const marker = selected ? this.theme.fg("accent", "›") : " ";
      const title = selected ? this.theme.bold(option.title) : option.title;
      lines.push(`  ${marker} ${title} ${this.theme.fg("dim", `(${formatExpiry(option)})`)}`);
      if (selected) lines.push(`      ${this.theme.fg("dim", option.description)}`);
    });
    lines.push(
      `  ${this.theme.fg("warning", "This consumes one earned reset for the current OpenAI Codex account.")}`,
    );
    return lines;
  }

  private renderResetLine(): string | undefined {
    const resets = this.codexResets;
    if (!resets) return undefined;
    if (resets.availableCount === 0) {
      return `    ${this.theme.fg("dim", "Resets: none available")}`;
    }
    const label = resets.availableCount === 1 ? "reset" : "resets";
    const hint = this.resetActions ? this.theme.fg("dim", "  (x to redeem)") : "";
    return `    ${this.theme.fg("accent", `Resets: ${resets.availableCount} ${label} available`)}${hint}`;
  }

  private renderProvider(snapshot: Snapshot, maxWidth: number): string[] {
    const lines: string[] = [];
    const title = PROVIDER_LABELS[snapshot.provider];
    lines.push(truncateToWidth(`  ${this.theme.fg("accent", title)}`, maxWidth));

    if (!snapshot.result.success) {
      // "not applicable" is an expected, non-error state (e.g. a direct
      // Anthropic API key with no subscription usage) — show a dim note,
      // not a warning-coloured error.
      const { error } = snapshot.result;
      const tone = error.kind === "not_applicable" ? "dim" : "warning";
      lines.push(
        truncateToWidth(`  ${this.theme.fg(tone, error.message)}`, maxWidth),
      );
      return lines;
    }

    const windows = snapshot.result.data.windows;
    if (windows.length === 0) {
      lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No quota windows available")}`, maxWidth));
      return lines;
    }

    const barWidth = Math.min(42, Math.max(18, maxWidth - 28));
    for (const window of windows) {
      const assessment = assessWindow(window);
      const color = getSeverityColor(assessment.severity);

      // Format the usage string depending on window type
      let usedStr: string;
      if (window.isCurrency) {
        if (window.isBalance) {
          usedStr = `$${window.usedValue.toFixed(2)} remaining`;
        } else if (window.limitValue === 0) {
          // Tracking-only windows have limitValue=0, show just usage
          usedStr = `$${window.usedValue.toFixed(2)} used`;
        } else {
          usedStr = `$${window.usedValue.toFixed(2)} / $${window.limitValue.toFixed(2)}`;
        }
      } else if (window.limitValue <= 1 && window.label === "Spend cap") {
        usedStr = window.limited ? "REACHED" : "OK";
      } else if (window.limitValue > 0 && window.limitValue !== 100) {
        // Real counts: show remaining/total (e.g. "293/300")
        const remaining = Math.max(0, Math.round(window.limitValue - window.usedValue));
        usedStr = `${remaining}/${window.limitValue} left`;
      } else {
        const remaining = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
        usedStr = `${remaining}% left`;
      }

      const timePercent =
        isHourlyOrWeeklyWindow(window.windowSeconds) && window.resetsAt.getTime() > 0
          ? getPacePercent(window)
          : null;
      const bar = renderProgressBar(window.usedPercent, barWidth, this.theme, color, timePercent);
      const limitedBadge = window.limited ? this.theme.fg("error", " LIMITED") : "";
      // Color the label based on severity: dim when safe, colored when at risk
      const isAtRisk = assessment.severity !== "none";
      const labelColor = isAtRisk ? color : "dim";
      lines.push(truncateToWidth(`    ${this.theme.fg(labelColor, `${window.label}:`)}`, maxWidth));
      lines.push(truncateToWidth(`    ${bar} ${this.theme.fg(color, usedStr)}${limitedBadge}`, maxWidth));

      // Subtitle: next event info + overage
      const subtitleParts: string[] = [];
      if (window.resetsAt.getTime() > 0) {
        subtitleParts.push(`${window.nextLabel ?? "Resets"} in ${formatTimeRemaining(window.resetsAt)}`);
      } else if (window.nextLabel) {
        subtitleParts.push(window.nextLabel);
      }
      if (window.nextAmount) {
        subtitleParts.push(window.nextAmount);
      }
      if (subtitleParts.length > 0) {
        lines.push(
          truncateToWidth(
            `    ${this.theme.fg("dim", subtitleParts.join("  ·  "))}`,
            maxWidth,
          ),
        );
      }
    }

    if (snapshot.provider === "openai-codex") {
      const resetLine = this.renderResetLine();
      if (resetLine) lines.push(truncateToWidth(resetLine, maxWidth));
    }

    return lines;
  }

  invalidate(): void {}
}
