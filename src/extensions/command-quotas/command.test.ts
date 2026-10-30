import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAuthStorage } from "../../lib/auth.js";
import { SUPPORTED_PROVIDERS } from "../../lib/quotas.js";
import { registerUsageCommands, usageArgumentCompletions } from "./command.js";

// Provider credentials can leak in from the host environment (pi resolves
// API keys from env vars, and the Synthetic provider reads
// SYNTHETIC_API_KEY directly), which would turn these "no credentials"
// tests into live network calls. Keep them hermetic.
const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "SYNTHETIC_API_KEY",
  "OLLAMA_API_KEY",
  "MINIMAX_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENCODE_API_KEY",
  "COMMAND_CODE_API_KEY",
  "COMMANDCODE_API_KEY",
];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
  // Providers that fall back to credential files (Command Code, OpenCode Go,
  // Codex) would otherwise pick up the developer's real keys from their home
  // directory.
  vi.stubEnv("HOME", join(tmpdir(), "pi-usage-test-no-home"));
  globalThis.fetch = vi.fn().mockRejectedValue(
    new Error("network disabled in tests"),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

function registeredCommands(
  options: Parameters<typeof registerUsageCommands>[1] = {},
) {
  const commands = new Map<string, any>();
  registerUsageCommands(
    {
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      events: { on: () => () => {}, emit: () => {} },
    } as any,
    options,
  );
  return commands;
}

function contextWithoutCredentials(notify: ReturnType<typeof vi.fn>) {
  return {
    cwd: join(tmpdir(), "pi-usage-test-no-home"),
    modelRegistry: { authStorage: inMemoryAuthStorage() },
    ui: {
      custom: async () => undefined,
      notify,
      select: vi.fn(async () => "cancel"),
    },
  } as any;
}

function values(items: ReturnType<typeof usageArgumentCompletions>) {
  return items?.map((item) => item.value) ?? [];
}

describe("/usage command", () => {
  it("registers a single command", () => {
    expect([...registeredCommands().keys()]).toEqual(["usage"]);
  });

  it("hides unconfigured providers from the combined dashboard", async () => {
    const commands = registeredCommands({ isConfigured: () => false });
    const notify = vi.fn();

    await commands.get("usage").handler("", contextWithoutCredentials(notify));

    expect(notify).toHaveBeenCalledWith("No quota data available", "info");
  });

  it("keeps provider views diagnostic", async () => {
    const commands = registeredCommands({ hideUnconfigured: false });
    const notify = vi.fn();

    await commands.get("usage").handler(
      "anthropic",
      contextWithoutCredentials(notify),
    );

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("No Anthropic OAuth token found"),
      "info",
    );
  });

  it("opens settings from /usage settings", async () => {
    const commands = registeredCommands();
    const ctx = contextWithoutCredentials(vi.fn());

    await commands.get("usage").handler("settings", ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("Save settings to", [
      "global",
      "local",
      "cancel",
    ]);
  });

  it("explains unknown arguments", async () => {
    const commands = registeredCommands();
    const notify = vi.fn();

    await commands.get("usage").handler("nope", contextWithoutCredentials(notify));

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown /usage argument "nope"'),
      "warning",
    );
  });
});

describe("/usage argument completions", () => {
  it("offers settings and only configured providers", () => {
    const items = usageArgumentCompletions("", {
      isConfigured: (provider) => provider === "openai-codex",
    });
    expect(values(items)).toEqual(["settings", "codex"]);
  });

  it("offers every provider when hiding is disabled", () => {
    const all = values(usageArgumentCompletions("", { hideUnconfigured: false }));
    expect(all).toHaveLength(SUPPORTED_PROVIDERS.length + 1);
    expect(all).toContain("grok");
  });

  it("filters by the typed prefix", () => {
    const options = { hideUnconfigured: false };
    expect(values(usageArgumentCompletions("co", options))).toEqual([
      "codex",
      "commandcode",
    ]);
    expect(usageArgumentCompletions("zzz", options)).toBeNull();
  });
});
