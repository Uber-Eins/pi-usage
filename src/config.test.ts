import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectLoadedFeatures, openUsageSettings } from "./config.js";

const fakePi = { events: { on: () => () => {}, emit: () => {} } } as any;

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-usage-config-"));
  // Keep the config loader away from the developer's real usage.json.
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("usage settings", () => {
  it("does not mark behaviour switches as (not loaded)", async () => {

    const seen: string[][] = [];
    let call = 0;
    const ctx = {
      cwd: home,
      ui: {
        select: async (_title: string, choices: string[]) => {
          seen.push(choices);
          call += 1;
          return call === 1 ? "global" : "Cancel";
        },
        notify: () => {},
      },
    };

    await openUsageSettings(fakePi, ctx, () => new Set());

    const list = seen[1];
    expect(list).toBeDefined();
    // Non-loadable switches are active and toggleable, so they must not be
    // annotated.
    expect(list.find((c) => c.startsWith("Hide unconfigured providers"))).toBe(
      "Hide unconfigured providers: enabled",
    );
    expect(list.find((c) => c.startsWith("Defer to Synthetic"))).toBe(
      "Defer to Synthetic: enabled",
    );
    // Loadable features still get the annotation.
    expect(list.find((c) => c.startsWith("Combined usage command"))).toBe(
      "Combined usage command: enabled (not loaded)",
    );
  });

  it("cycles usage status placement without toggling usage status", async () => {

    const seen: string[][] = [];
    let phase = 0;
    const ctx = {
      cwd: home,
      ui: {
        select: async (_title: string, choices: string[]) => {
          seen.push(choices);
          if (phase === 0) {
            phase += 1;
            return "global";
          }
          if (phase === 1) {
            phase += 1;
            return choices.find((choice) =>
              choice.startsWith("Usage status placement:"),
            );
          }
          return "Cancel";
        },
        notify: () => {},
      },
    };

    await openUsageSettings(fakePi, ctx, () => new Set());

    const after = seen[seen.length - 1];
    // Selecting the placement entry must advance placement and must not touch
    // the separate usageStatus toggle.
    expect(
      after.find((choice) => choice.startsWith("Usage status placement:")),
    ).toBe("Usage status placement: aboveEditor");
    expect(after.find((choice) => choice.startsWith("Usage status:"))).toBe(
      "Usage status: enabled (not loaded)",
    );
  });
});

describe("collectLoadedFeatures", () => {
  it("gathers the features sub-extensions report on request", () => {
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const pi = {
      events: {
        on(channel: string, handler: (data: unknown) => void) {
          listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
          return () =>
            listeners.set(
              channel,
              (listeners.get(channel) ?? []).filter((h) => h !== handler),
            );
        },
        emit(channel: string, data: unknown) {
          for (const handler of listeners.get(channel) ?? []) handler(data);
        },
      },
    } as any;
    pi.events.on("usage:extensions:request", () => {
      pi.events.emit("usage:extensions:register", { feature: "usageCommand" });
      pi.events.emit("usage:extensions:register", { feature: "usageTool" });
    });

    expect(collectLoadedFeatures(pi)).toEqual(new Set(["usageCommand", "usageTool"]));
    // The temporary listener is removed again.
    expect(listeners.get("usage:extensions:register")).toEqual([]);
  });
});
