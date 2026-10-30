import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import tokenStatusExtension from "./index.js";
import { configLoader } from "../../config.js";
import { aggregateAllSessions } from "../../lib/session-tokens.js";

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
    getConfig: vi.fn(() => ({ ...BASE_CONFIG })),
  },
}));

vi.mock("../../lib/session-tokens.js", () => ({
  aggregateAllSessions: vi.fn(async () => ({
    totals: { costTotal: 1.5 },
    entries: [],
  })),
  formatCost: (cost: number) => `$${cost.toFixed(2)}`,
}));

const EXTENSION_ID = "pi-usage-token-status";

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
        eventBusHandlers.set(channel, [...handlers, handler]);
        return () => {
          eventBusHandlers.set(
            channel,
            (eventBusHandlers.get(channel) ?? []).filter((e) => e !== handler),
          );
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
  };
}

function createContext(provider: string) {
  const setStatus = vi.fn();
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: { provider },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus,
    },
  } as unknown as ExtensionContext;
  return { ctx, setStatus };
}

beforeEach(() => {
  vi.mocked(configLoader.getConfig).mockReturnValue({ ...BASE_CONFIG });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("token-status config updates", () => {
  it("does not start the Go cost refresher for a non-Go provider when enabled at runtime", async () => {
    // Token-status starts disabled: before the self-registration fix this
    // state was permanent, so this exact sequence is newly reachable.
    vi.useFakeTimers();
    vi.mocked(configLoader.getConfig).mockReturnValue({
      ...BASE_CONFIG,
      tokenStatus: false,
    });

    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");

    await tokenStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);

    // Enabling token-status from /usage:settings must apply the same
    // isGoProvider guard as session_start: a non-Go provider never renders
    // the Go rolling-cost line. Advance past a refresh interval to prove no
    // interval was left running either.
    emitBusEvent("usage:config:updated", { config: { ...BASE_CONFIG } });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(aggregateAllSessions).not.toHaveBeenCalled();
    const statusCalls = setStatus.mock.calls as unknown as Array<
      [string, string | undefined]
    >;
    expect(statusCalls.length).toBeGreaterThan(0);
    expect(statusCalls.every(([, value]) => value === undefined)).toBe(true);
  });
});
