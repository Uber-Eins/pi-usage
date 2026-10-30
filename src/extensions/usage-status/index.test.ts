import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import usageStatusExtension from "./index.js";
import { fetchProviderQuotas } from "../../lib/quotas.js";
import { configLoader } from "../../config.js";

const BASE_CONFIG = {
  configVersion: "test",
  usageCommand: true,
  providerCommands: true,
  usageStatus: true,
  usageStatusPlacement: "statusBar" as const,
  tokenStatus: true,
  quotaWarnings: true,
  usageTool: true,
  deferToSynthetic: true,
  hideUnconfiguredProviders: true,
};

vi.mock("../../config.js", () => ({
  USAGE_CONFIG_UPDATED_EVENT: "usage:config:updated",
  USAGE_EXTENSIONS_REGISTER_EVENT: "usage:extensions:register",
  USAGE_EXTENSIONS_REQUEST_EVENT: "usage:extensions:request",
  configLoader: {
    load: vi.fn(async () => undefined),
    getConfig: vi.fn(() => ({
      configVersion: "test",
      usageCommand: true,
      providerCommands: true,
      usageStatus: true,
      usageStatusPlacement: "statusBar",
      tokenStatus: true,
      quotaWarnings: true,
      deferToSynthetic: true,
      hideUnconfiguredProviders: true,
    })),
  },
}));

vi.mock("../../lib/quotas.js", () => ({
  // "synthetic" is included so the Synthetic-deferral tests exercise a real
  // refresh path; other tests use "anthropic".
  isSupportedProvider: (provider: string | undefined) =>
    provider === "anthropic" || provider === "synthetic",
  fetchProviderQuotas: vi.fn(async () => ({
    success: true,
    data: { provider: "anthropic", windows: [] },
  })),
}));

const STALE_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload.";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createFakePi() {
  const extensionHandlers = new Map<string, EventHandler[]>();
  const eventBusHandlers = new Map<string, Array<(data: unknown) => void>>();

  const pi = {
    on(event: string, handler: EventHandler) {
      const handlers = extensionHandlers.get(event) ?? [];
      handlers.push(handler);
      extensionHandlers.set(event, handlers);
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = eventBusHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventBusHandlers.set(channel, handlers);
        return () => {
          const current = eventBusHandlers.get(channel) ?? [];
          eventBusHandlers.set(channel, current.filter((entry) => entry !== handler));
        };
      },
      emit(channel: string, data: unknown) {
        for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    async emitExtensionEvent(event: string, ctx: ExtensionContext) {
      for (const handler of extensionHandlers.get(event) ?? []) {
        await handler({ type: event, reason: "test" }, ctx);
      }
    },
    emitBusEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
    listenerCount(channel: string) {
      return eventBusHandlers.get(channel)?.length ?? 0;
    },
  };
}

function createContext(provider: string, mode: "tui" | "rpc" = "tui") {
  let stale = false;
  const setStatus = vi.fn(() => {
    if (stale) throw new Error(STALE_CONTEXT_ERROR);
  });
  const setWidget = vi.fn(() => {
    if (stale) throw new Error(STALE_CONTEXT_ERROR);
  });

  const ctx = {
    mode,
    get hasUI() {
      if (stale) throw new Error(STALE_CONTEXT_ERROR);
      return true;
    },
    get model() {
      if (stale) throw new Error(STALE_CONTEXT_ERROR);
      return { provider };
    },
    modelRegistry: { authStorage: {} },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus,
      setWidget,
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    setStale() {
      stale = true;
    },
    setStatus,
    setWidget,
  };
}

function quotaWindow(): Record<string, unknown> {
  return {
    provider: "anthropic",
    label: "Credits",
    usedPercent: 25,
    resetsAt: new Date(Date.now() + 60 * 60 * 1000),
    windowSeconds: 3600,
    usedValue: 25,
    limitValue: 100,
  };
}

beforeEach(() => {
  vi.mocked(configLoader.getConfig).mockReturnValue({ ...BASE_CONFIG });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("usage-status extension lifecycle", () => {
  it("ignores interval refreshes for stale session contexts", async () => {
    vi.useFakeTimers();
    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStale } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    setStale();

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
  });

  it("does not throw when event-bus callbacks see a stale session context", async () => {
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStale } = createContext("synthetic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    setStale();

    expect(() => {
      emitBusEvent("synthetic:extensions:register", { feature: "usageStatus" });
      emitBusEvent("usage:config:updated", {
        config: { usageStatus: true, deferToSynthetic: true },
      });
    }).not.toThrow();
  });

  it("unsubscribes event-bus listeners during session shutdown", async () => {
    const { pi, emitExtensionEvent, listenerCount } = createFakePi();
    const { ctx } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    expect(listenerCount("usage:config:updated")).toBe(1);
    expect(listenerCount("synthetic:extensions:register")).toBe(1);
    expect(listenerCount("usage:extensions:request")).toBe(1);

    await emitExtensionEvent("session_shutdown", ctx);

    expect(listenerCount("usage:config:updated")).toBe(0);
    expect(listenerCount("synthetic:extensions:register")).toBe(0);
    expect(listenerCount("usage:extensions:request")).toBe(0);
  });

  it("clears the footer silently for not_applicable credentials instead of warning", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: false,
      error: { kind: "not_applicable", message: "Direct API key" },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(0);

    const calls = setStatus.mock.calls as unknown as Array<[string, string | undefined]>;
    const last = calls[calls.length - 1]?.[1];
    expect(last).toBeUndefined();
    expect(calls.some((c) => c[1] === "usage unavailable")).toBe(false);
  });

  it("renders in the shared status row by default", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: true,
      data: { provider: "anthropic", windows: [quotaWindow()] },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus, setWidget } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    const calls = setStatus.mock.calls as unknown as Array<[string, string | undefined]>;
    const last = calls[calls.length - 1]?.[1];
    expect(typeof last).toBe("string");
    expect(last).toContain("credits:");
    expect(setWidget).toHaveBeenCalledWith("pi-usage", undefined);
  });

  it("renders on a dedicated widget line when placement is aboveEditor", async () => {
    vi.useFakeTimers();
    vi.mocked(configLoader.getConfig).mockReturnValue({
      ...BASE_CONFIG,
      usageStatusPlacement: "aboveEditor",
    });
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: true,
      data: { provider: "anthropic", windows: [quotaWindow()] },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus, setWidget } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    // Shared status row must stay clear so other extensions are not displaced.
    const calls = setStatus.mock.calls as unknown as Array<[string, string | undefined]>;
    expect(calls.every((call) => call[1] === undefined)).toBe(true);

    const widgetCall = (setWidget.mock.calls as any[]).find(
      (call) => typeof call[1] === "function",
    );
    expect(widgetCall?.[2]).toEqual({ placement: "aboveEditor" });

    const component = widgetCall[1]();
    const lines = component.render(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("credits:");
  });

  it("clears the widget when placement returns to statusBar", async () => {
    vi.useFakeTimers();
    vi.mocked(configLoader.getConfig).mockReturnValue({
      ...BASE_CONFIG,
      usageStatusPlacement: "aboveEditor",
    });
    vi.mocked(fetchProviderQuotas).mockResolvedValue({
      success: true,
      data: { provider: "anthropic", windows: [quotaWindow()] },
    } as any);

    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStatus, setWidget } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    // A widget must have been installed while in aboveEditor mode.
    const installed = (setWidget.mock.calls as any[]).some(
      (call) =>
        typeof call[1] === "function" &&
        call[2]?.placement === "aboveEditor",
    );
    expect(installed).toBe(true);

    // Switch back to the shared status row and prove the widget is removed.
    // Keep the loader mock stale (still aboveEditor) and change only the event
    // payload: this is what proves placement is read from the event rather than
    // from a stale config-store snapshot.
    setWidget.mockClear();
    emitBusEvent("usage:config:updated", { config: { ...BASE_CONFIG } });
    await vi.advanceTimersByTimeAsync(0);

    expect(setWidget).toHaveBeenCalledWith("pi-usage", undefined);
    const statusCalls = setStatus.mock.calls as unknown as Array<
      [string, string | undefined]
    >;
    expect(
      statusCalls.some(
        (call) => typeof call[1] === "string" && call[1].includes("credits:"),
      ),
    ).toBe(true);
  });

  it("does not resurrect the footer after a settings save while pi-synthetic is active", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchProviderQuotas).mockResolvedValue({
      success: true,
      data: { provider: "synthetic", windows: [quotaWindow()] },
    } as any);

    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStatus } = createContext("synthetic");

    await usageStatusExtension(pi);
    // pi-synthetic registers its usage footer, then the session starts on the
    // Synthetic provider: the deferral guard stops our refresher.
    emitBusEvent("synthetic:extensions:register", { feature: "usageStatus" });
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    // Saving any setting re-emits the config payload; the handler must not
    // restart the refresher while the deferral still applies. Advance past a
    // refresh interval to prove no interval was left running either.
    emitBusEvent("usage:config:updated", { config: { ...BASE_CONFIG } });
    await vi.advanceTimersByTimeAsync(30_000);

    const statusCalls = setStatus.mock.calls as unknown as Array<
      [string, string | undefined]
    >;
    expect(statusCalls.length).toBeGreaterThan(0);
    expect(statusCalls.every(([, value]) => value === undefined)).toBe(true);
  });

  it("falls back to the shared status row in non-TUI modes", async () => {
    vi.useFakeTimers();
    vi.mocked(configLoader.getConfig).mockReturnValue({
      ...BASE_CONFIG,
      usageStatusPlacement: "aboveEditor",
    });
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: true,
      data: { provider: "anthropic", windows: [quotaWindow()] },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus, setWidget } = createContext("anthropic", "rpc");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    // No widget factory in RPC mode; the status must still reach setStatus.
    expect(
      (setWidget.mock.calls as any[]).some(
        (call) => typeof call[1] === "function",
      ),
    ).toBe(false);
    const statusCalls = setStatus.mock.calls as unknown as Array<
      [string, string | undefined]
    >;
    expect(
      statusCalls.some(
        (call) => typeof call[1] === "string" && call[1].includes("credits:"),
      ),
    ).toBe(true);
    // The shared row must stay compact: no severity glyph, no exhaustion hint.
    const lastStatus = statusCalls
      .map((call) => call[1])
      .reverse()
      .find((text): text is string => typeof text === "string");
    expect(lastStatus).not.toContain("●");
    expect(lastStatus).not.toContain("runs out");
  });

  it("never renders wider than the requested widget width", async () => {
    vi.useFakeTimers();
    vi.mocked(configLoader.getConfig).mockReturnValue({
      ...BASE_CONFIG,
      usageStatusPlacement: "aboveEditor",
    });
    vi.mocked(fetchProviderQuotas).mockResolvedValue({
      success: true,
      data: { provider: "anthropic", windows: [quotaWindow()] },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setWidget } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    const widgetCall = (setWidget.mock.calls as any[]).find(
      (call) => typeof call[1] === "function",
    );
    const component = widgetCall[1]();
    for (const width of [0, 1, 5, 40, 200]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(0, width));
      }
    }
  });

  it("self-registers while enabled is false so settings can re-enable it", async () => {
    vi.mocked(configLoader.getConfig).mockReturnValue({
      ...BASE_CONFIG,
      usageStatus: false,
    });

    const { pi, emitBusEvent } = createFakePi();
    const registered: Array<{ feature: string }> = [];
    pi.events.on("usage:extensions:register", (data: unknown) => {
      registered.push(data as { feature: string });
    });

    await usageStatusExtension(pi);
    emitBusEvent("usage:extensions:request", undefined);

    expect(registered).toContainEqual({ feature: "usageStatus" });
  });
});
