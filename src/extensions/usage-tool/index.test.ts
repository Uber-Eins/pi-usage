import { describe, expect, it, vi } from "vitest";
import { inMemoryAuthStorage } from "../../lib/auth.js";
import type { QuotasResult, SupportedQuotaProvider } from "../../types/quotas.js";
import { runUsageTool } from "./index.js";

const HOUR = 60 * 60 * 1000;

function codexResult(): QuotasResult {
  return {
    success: true,
    data: {
      provider: "openai-codex",
      windows: [
        {
          provider: "openai-codex",
          label: "5h",
          usedPercent: 42,
          resetsAt: new Date(Date.now() + 2 * HOUR),
          windowSeconds: 5 * 60 * 60,
          usedValue: 42,
          limitValue: 100,
          showPace: false,
          nextLabel: "Resets",
        },
        {
          provider: "openai-codex",
          label: "Credits",
          usedPercent: 0,
          resetsAt: new Date(0),
          windowSeconds: 0,
          usedValue: 12.5,
          limitValue: 12.5,
          isCurrency: true,
          isBalance: true,
        },
      ],
    },
  };
}

function fetcher(results: Partial<Record<SupportedQuotaProvider, QuotasResult>>) {
  return vi.fn(async (_auth: unknown, provider: SupportedQuotaProvider, _options?: { force?: boolean }) =>
    results[provider] ?? {
      success: false as const,
      error: { message: "No credentials", kind: "config" as const },
    },
  );
}

const auth = inMemoryAuthStorage();
const model = { provider: "openai-codex", id: "gpt-6.1-sol" };

describe("runUsageTool", () => {
  it("reports every configured provider and marks the current one", async () => {
    const fetchQuotas = fetcher({
      "openai-codex": codexResult(),
      anthropic: {
        success: false,
        error: { message: "HTTP 500", kind: "http" },
      },
    });
    const result = await runUsageTool({}, auth, model, undefined, {
      isConfigured: (p) => p === "openai-codex" || p === "anthropic" || p === "zai",
      fetchQuotas: fetchQuotas as never,
      fetchCodexResets: async () => ({
        ok: true,
        availableCount: 2,
        options: [
          { creditId: "a", title: "Full reset", description: "", expiresAt: new Date("2026-11-05T00:00:00Z") },
        ],
      }),
    });

    expect(fetchQuotas).toHaveBeenCalledTimes(3);
    expect(result.text).toContain(
      "Usage limit resets: 2 available (the user can redeem them from /usage), next expires 2026-11-05T00:00:00.000Z",
    );
    expect(result.details.providers.find((p) => p.provider === "openai-codex")?.codexResets).toEqual({
      available: 2,
      nextExpiry: "2026-11-05T00:00:00.000Z",
    });
    // zai only produced a "config" error, so it is hidden from the overview.
    expect(result.details.providers.map((p) => p.provider)).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    expect(result.text).toContain("Current model: openai-codex/gpt-6.1-sol");
    expect(result.text).toContain("OpenAI Codex (openai-codex) [current model]");
    expect(result.text).toMatch(/5h: 42% used, resets in 2h/);
    expect(result.text).toContain("Credits: $12.50 remaining");
    expect(result.text).toContain("error: HTTP 500");

    const codex = result.details.providers.find((p) => p.provider === "openai-codex");
    expect(codex?.active).toBe(true);
    expect(codex?.windows[0]).toMatchObject({
      label: "5h",
      usedPercent: 42,
      remainingPercent: 58,
      severity: "none",
    });
  });

  it("queries only the requested provider and keeps its errors", async () => {
    const fetchQuotas = fetcher({});
    const result = await runUsageTool({ provider: "zai", force: true }, auth, model, undefined, {
      isConfigured: () => true,
      fetchQuotas: fetchQuotas as never,
    });
    expect(fetchQuotas).toHaveBeenCalledTimes(1);
    expect(fetchQuotas.mock.calls[0]?.[2]).toMatchObject({ force: true });
    expect(result.text).toContain("Z.ai (zai)\n  error: No credentials");
  });

  it("rejects unknown providers without fetching", async () => {
    const fetchQuotas = fetcher({});
    const result = await runUsageTool({ provider: "nope" }, auth, model, undefined, {
      fetchQuotas: fetchQuotas as never,
    });
    expect(fetchQuotas).not.toHaveBeenCalled();
    expect(result.text).toContain('Unknown provider "nope"');
  });

  it("notes when the current model's provider has no usage data", async () => {
    const result = await runUsageTool(
      {},
      auth,
      { provider: "codearts", id: "glm-5.3" },
      undefined,
      { isConfigured: () => false, fetchQuotas: fetcher({}) as never },
    );
    expect(result.text).toContain(
      "Current model: codearts/glm-5.3 (no usage data available for this provider)",
    );
    expect(result.text).toContain("No provider usage data available.");
  });
});
