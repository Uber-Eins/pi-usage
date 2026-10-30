import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import pkg from "../../../../package.json" with { type: "json" };
import { QuotasComponent } from "./quotas-display.js";

const ansi = {
  accent: "\x1b[32m",
  border: "\x1b[36m",
  dim: "\x1b[2m",
  error: "\x1b[31m",
  muted: "\x1b[90m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
} as const;

function fakeTheme() {
  return {
    bold: (text: string) => text,
    fg: (color: keyof typeof ansi, text: string) => `${ansi[color] ?? ""}${text}\x1b[0m`,
    getFgAnsi: (color: keyof typeof ansi) => ansi[color] ?? "",
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function barLine(output: string, label: string): string {
  const lines = stripAnsi(output).split("\n");
  const labelIndex = lines.findIndex((line) => line.includes(`${label}:`));
  if (labelIndex < 0) throw new Error(`missing label ${label}`);
  return lines[labelIndex + 1] ?? "";
}

function makeComponent(): QuotasComponent {
  return new QuotasComponent(
    fakeTheme() as any,
    { requestRender: () => {} } as any,
    "Quotas",
    () => {},
    () => {},
  );
}

describe("QuotasComponent", () => {
  it("keeps loading and loaded output within the terminal width after resizing", () => {
    const component = makeComponent();
    const checkWidths = () => {
      for (const width of [80, 48, 20, 1, 0, 48, 80]) {
        for (const line of component.render(width)) {
          expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    };

    try {
      // The loading footer caused a crash at 48 columns.
      checkWidths();
      component.setState({ type: "loaded", snapshots: [] });
      checkWidths();
      component.setState({
        type: "loaded",
        snapshots: [{
          provider: "anthropic",
          result: {
            success: false,
            error: { kind: "network", message: "Quota unavailable 界".repeat(10) },
          },
        }],
      });
      checkWidths();
      component.setState({
        type: "loaded",
        snapshots: [{
          provider: "anthropic",
          result: {
            success: true,
            data: {
              provider: "anthropic",
              windows: [{
                provider: "anthropic",
                label: "Quota-界".repeat(12),
                usedPercent: 25,
                usedValue: 25,
                limitValue: 100,
                windowSeconds: 5 * 3600,
                resetsAt: new Date(0),
                nextLabel: "Reset-界".repeat(12),
              }],
            },
          },
        }],
      });
      const output = component.render(80).join("\n");
      expect(output).toContain("Quota-界");
      expect(output).toContain("█");
      expect(output).toContain("75% left");
      checkWidths();
    } finally {
      component.destroy();
    }
  });

  it("renders the pi-usage package version in the dashboard footer", () => {
    const component = makeComponent();
    component.setState({ type: "loaded", snapshots: [] });

    expect(component.render(70).join("\n")).toContain(`pi-usage v${pkg.version}`);
  });

  it("explains when no active quota subscriptions are detected", () => {
    const component = makeComponent();
    component.setState({ type: "loaded", snapshots: [] });

    expect(component.render(70).join("\n")).toContain(
      "No active quota subscriptions detected",
    );
  });

  it("draws a dim time-progress line on hourly and weekly bars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T13:42:11Z"));

    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "anthropic",
          result: {
            success: true,
            data: {
              provider: "anthropic",
              windows: [
                {
                  provider: "anthropic",
                  label: "5h",
                  usedPercent: 9,
                  resetsAt: new Date("2026-05-14T16:18:11Z"),
                  windowSeconds: 5 * 3600,
                  usedValue: 9,
                  limitValue: 100,
                  showPace: false,
                  nextLabel: "Resets",
                },
                {
                  provider: "anthropic",
                  label: "7d",
                  usedPercent: 31,
                  resetsAt: new Date("2026-05-16T06:18:11Z"),
                  windowSeconds: 7 * 24 * 3600,
                  usedValue: 31,
                  limitValue: 100,
                  showPace: false,
                  nextLabel: "Resets",
                },
                {
                  provider: "anthropic",
                  label: "Extra (AUD)",
                  usedPercent: 78,
                  resetsAt: new Date("2026-06-01T00:00:00Z"),
                  windowSeconds: 30 * 24 * 3600,
                  usedValue: 233.68,
                  limitValue: 300,
                  isCurrency: true,
                  showPace: true,
                  nextLabel: "Resets",
                },
              ],
            },
          },
        },
        {
          provider: "openai-codex",
          result: {
            success: true,
            data: {
              provider: "openai-codex",
              windows: [
                {
                  provider: "openai-codex",
                  label: "5h",
                  usedPercent: 45,
                  resetsAt: new Date("2026-05-14T17:23:11Z"),
                  windowSeconds: 5 * 3600,
                  usedValue: 45,
                  limitValue: 100,
                  showPace: false,
                  nextLabel: "Resets",
                },
              ],
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");
    const hourly = barLine(output, "5h");
    const weekly = barLine(output, "7d");
    const extra = barLine(output, "Extra (AUD)");
    const ahead = stripAnsi(output)
      .split("\n")
      .filter((line) => line.includes("█") || line.includes("|"))
      .at(-1) ?? "";

    expect(hourly).toMatch(/█{4}░+\|/);
    expect(output).toContain(`${ansi.dim}|`);
    expect(weekly).toMatch(/█{13}░+\|/);
    expect(extra).not.toContain("|");
    expect(ahead).toMatch(/█+\|█+/);

    vi.useRealTimers();
  });

  it("does not draw a time-progress line on monthly bars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T13:42:11Z"));

    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "github-copilot",
          result: {
            success: true,
            data: {
              provider: "github-copilot",
              windows: [
                {
                  provider: "github-copilot",
                  label: "Premium / month",
                  usedPercent: 83,
                  resetsAt: new Date("2026-06-01T10:00:00Z"),
                  windowSeconds: 31 * 24 * 3600,
                  usedValue: 249,
                  limitValue: 300,
                  showPace: true,
                  nextLabel: "Resets",
                  nextAmount: "overage allowed",
                },
              ],
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");

    expect(output).toContain("51/300 left");
    expect(barLine(output, "Premium / month")).not.toContain("|");

    vi.useRealTimers();
  });

  it("still draws the time-progress line on unused hourly and weekly bars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T13:49:29Z"));

    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "anthropic",
          result: {
            success: true,
            data: {
              provider: "anthropic",
              windows: [
                {
                  provider: "anthropic",
                  label: "7d",
                  usedPercent: 0,
                  resetsAt: new Date("2026-05-16T06:18:11Z"),
                  windowSeconds: 7 * 24 * 3600,
                  usedValue: 0,
                  limitValue: 100,
                  showPace: false,
                  nextLabel: "Resets",
                },
              ],
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");

    expect(output).toContain("100% left");
    expect(barLine(output, "7d")).toContain("|");
    expect(barLine(output, "7d")).not.toContain("█");

    vi.useRealTimers();
  });

  it("renders a not_applicable provider silently with a dim note, not a warning", () => {
    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "anthropic",
          result: {
            success: false,
            error: {
              kind: "not_applicable",
              message: "Direct API key — no subscription usage to report",
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");

    expect(output).toContain("Anthropic");
    expect(output).toContain("Direct API key");
    // Rendered as a dim informational note, not a warning.
    expect(output).toContain("\x1b[2m");
    expect(output).not.toContain("\x1b[33m");
    expect(output).not.toContain("usage unavailable");
    expect(output).not.toContain("{");
  });

  it("renders a balance window as remaining, not a used/limit ratio", () => {
    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "commandcode",
          result: {
            success: true,
            data: {
              provider: "commandcode",
              windows: [
                {
                  provider: "commandcode",
                  label: "Credits Remaining",
                  usedPercent: 0,
                  resetsAt: new Date(0),
                  windowSeconds: 30 * 24 * 3600,
                  usedValue: 12.5,
                  limitValue: 12.5,
                  isCurrency: true,
                  isBalance: true,
                  showPace: false,
                },
              ],
            },
          },
        },
      ],
    });

    const output = stripAnsi(component.render(70).join("\n"));
    expect(output).toContain("Credits Remaining");
    expect(output).toContain("$12.50 remaining");
    expect(output).not.toContain("$12.50 / $12.50");
  });
});

describe("QuotasComponent Codex resets", () => {
  const codexSnapshot = {
    provider: "openai-codex" as const,
    result: {
      success: true as const,
      data: {
        provider: "openai-codex" as const,
        windows: [
          {
            provider: "openai-codex" as const,
            label: "5h",
            usedPercent: 100,
            resetsAt: new Date(Date.now() + 60 * 60 * 1000),
            windowSeconds: 5 * 60 * 60,
            usedValue: 100,
            limitValue: 100,
            showPace: false,
          },
        ],
      },
    },
  };

  const resets = {
    availableCount: 2,
    options: [
      { creditId: "a", title: "Full reset", description: "Reset now." },
      { creditId: "b", title: "Weekly reset", description: "Reset the week." },
    ],
  };

  function setup() {
    const redeem = vi.fn(async () => "Usage reset. 1 usage limit reset left.");
    const onRefetch = vi.fn();
    const component = new QuotasComponent(
      fakeTheme() as any,
      { requestRender: () => {} } as any,
      "Quotas",
      () => {},
      onRefetch,
      { redeem },
    );
    component.setState({ type: "loaded", snapshots: [codexSnapshot] });
    component.setCodexResets(resets);
    const text = () => stripAnsi(component.render(100).join("\n"));
    return { component, redeem, onRefetch, text };
  }

  it("shows the available resets and the redeem hint", () => {
    const { component, text } = setup();
    try {
      expect(text()).toContain("Resets: 2 resets available");
      expect(text()).toContain("x reset codex");
      component.setCodexResets({ availableCount: 0, options: [] });
      expect(text()).toContain("Resets: none available");
      expect(text()).not.toContain("x reset codex");
    } finally {
      component.destroy();
    }
  });

  it("confirms, redeems the selected reset, and refreshes", async () => {
    const { component, redeem, onRefetch, text } = setup();
    try {
      expect(component.handleInput("x")).toBe(true);
      expect(text()).toContain("Redeem a Codex usage limit reset?");
      component.handleInput("\x1b[B"); // down
      component.handleInput("y");
      await vi.waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
      expect(redeem).toHaveBeenCalledWith(resets.options[1]);
      expect(text()).toContain("Usage reset. 1 usage limit reset left.");
      expect(text()).not.toContain("Redeem a Codex usage limit reset?");
    } finally {
      component.destroy();
    }
  });

  it("cancels the confirmation without closing the dashboard", () => {
    const onClose = vi.fn();
    const redeem = vi.fn(async () => "");
    const component = new QuotasComponent(
      fakeTheme() as any,
      { requestRender: () => {} } as any,
      "Quotas",
      onClose,
      () => {},
      { redeem },
    );
    try {
      component.setState({ type: "loaded", snapshots: [codexSnapshot] });
      component.setCodexResets(resets);
      component.handleInput("x");
      component.handleInput("\x1b");
      expect(onClose).not.toHaveBeenCalled();
      expect(redeem).not.toHaveBeenCalled();
      component.handleInput("\x1b");
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      component.destroy();
    }
  });
});
