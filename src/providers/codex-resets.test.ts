import { afterEach, describe, expect, it, vi } from "vitest";
import { inMemoryAuthStorage } from "../lib/auth.js";
import {
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  formatCodexResetOutcome,
  parseCodexResetCredits,
} from "./codex-resets.js";

const auth = inMemoryAuthStorage({
  "openai-codex": { apiKey: "token-123", accountId: "acct-1" },
});

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseCodexResetCredits", () => {
  it("keeps available Codex credits sorted by expiry", () => {
    const parsed = parseCodexResetCredits({
      available_count: 3,
      credits: [
        { id: "never", status: "available", reset_type: "codex_rate_limits" },
        {
          id: "late",
          status: "available",
          reset_type: "codex_rate_limits",
          title: "Weekly reset",
          expires_at: "2026-12-01T00:00:00Z",
        },
        {
          id: "soon",
          status: "available",
          reset_type: "codex_rate_limits",
          expires_at: "2026-11-01T00:00:00Z",
        },
        { id: "used", status: "redeemed", reset_type: "codex_rate_limits" },
        { id: "other", status: "available", reset_type: "something_else" },
      ],
    });
    expect(parsed.availableCount).toBe(3);
    expect(parsed.options.map((o) => o.creditId)).toEqual(["soon", "late", "never"]);
    expect(parsed.options[1]?.title).toBe("Weekly reset");
    expect(parsed.options[0]?.title).toBe("Full reset");
    expect(parsed.options[2]?.expiresAt).toBeUndefined();
  });

  it("falls back to a generic option when credits are missing", () => {
    const parsed = parseCodexResetCredits({ available_count: 1 });
    expect(parsed.options).toEqual([
      { title: "Full reset", description: "Reset your current usage limits." },
    ]);
  });

  it("reports nothing when no resets are available", () => {
    expect(parseCodexResetCredits({ available_count: 0, credits: [] })).toEqual({
      availableCount: 0,
      options: [],
    });
  });
});

describe("fetchCodexResetCredits", () => {
  it("requests the credits endpoint with Codex auth headers", async () => {
    const fetchMock = mockFetch({ available_count: 0, credits: [] });
    const result = await fetchCodexResetCredits(auth);
    expect(result).toEqual({ ok: true, availableCount: 0, options: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token-123",
      "ChatGPT-Account-Id": "acct-1",
    });
  });

  it("fails without a Codex token", async () => {
    const result = await fetchCodexResetCredits(inMemoryAuthStorage());
    expect(result).toEqual({ ok: false, message: "No Codex access token found" });
  });
});

describe("consumeCodexResetCredit", () => {
  it("posts a redemption request with the chosen credit", async () => {
    const fetchMock = mockFetch({ code: "reset", windows_reset: 2 });
    const result = await consumeCodexResetCredit(auth, {
      creditId: "credit-9",
      title: "Full reset",
      description: "",
    });
    expect(result).toEqual({ ok: true, code: "reset", windowsReset: 2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    );
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.credit_id).toBe("credit-9");
    expect(typeof body.redeem_request_id).toBe("string");
    expect(body.redeem_request_id.length).toBeGreaterThan(0);
  });

  it("omits credit_id for the generic option", async () => {
    const fetchMock = mockFetch({ code: "nothing_to_reset" });
    const result = await consumeCodexResetCredit(auth, {
      title: "Full reset",
      description: "",
    });
    expect(result).toEqual({ ok: true, code: "nothing_to_reset", windowsReset: 0 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("credit_id");
  });

  it("rejects unknown outcome codes and HTTP errors", async () => {
    mockFetch({ code: "surprise" });
    expect(
      await consumeCodexResetCredit(auth, { title: "x", description: "" }),
    ).toEqual({ ok: false, message: "Unexpected reset outcome: surprise" });

    mockFetch({ error: { message: "Forbidden" } }, 403);
    expect(
      await consumeCodexResetCredit(auth, { title: "x", description: "" }),
    ).toEqual({ ok: false, message: "Forbidden" });
  });
});

describe("formatCodexResetOutcome", () => {
  it("describes each outcome", () => {
    expect(formatCodexResetOutcome({ code: "reset", windowsReset: 2 }, 1)).toBe(
      "Usage reset. 1 usage limit reset left.",
    );
    expect(formatCodexResetOutcome({ code: "reset", windowsReset: 2 })).toBe("Usage reset.");
    expect(formatCodexResetOutcome({ code: "nothing_to_reset", windowsReset: 0 }, 2)).toBe(
      "Your usage does not need a reset right now.",
    );
    expect(formatCodexResetOutcome({ code: "no_credit", windowsReset: 0 })).toBe(
      "No usage limit resets are available.",
    );
  });
});
