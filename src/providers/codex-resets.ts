import { randomUUID } from "node:crypto";
import type { AuthStorage } from "../lib/auth.js";
import {
  codexAccountId,
  codexHeaders,
  fetchJson,
  providerAccessToken,
} from "./fetch.js";

/**
 * Codex "earned usage-limit resets": credits the ChatGPT backend hands out
 * that reset the current Codex rate-limit windows when redeemed.
 */
const RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;

export interface CodexResetOption {
  /** Opaque credit id; absent for the generic fallback option. */
  creditId?: string;
  title: string;
  description: string;
  expiresAt?: Date;
}

export interface CodexResetAvailability {
  availableCount: number;
  options: CodexResetOption[];
}

export type CodexResetOutcomeCode =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export interface CodexResetOutcome {
  code: CodexResetOutcomeCode;
  windowsReset: number;
}

type Result<T> = ({ ok: true } & T) | { ok: false; message: string };

const OUTCOME_CODES: CodexResetOutcomeCode[] = [
  "reset",
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
];

function genericOption(): CodexResetOption {
  return { title: "Full reset", description: "Reset your current usage limits." };
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseCodexResetCredits(data: any): CodexResetAvailability {
  const availableCount = count(data?.available_count);
  const credits: any[] = Array.isArray(data?.credits) ? data.credits : [];
  const options = credits
    .filter(
      (credit) =>
        credit?.status === "available" &&
        credit?.reset_type === "codex_rate_limits" &&
        typeof credit?.id === "string" &&
        credit.id.length > 0,
    )
    .map((credit): CodexResetOption => {
      const expires = credit.expires_at ? new Date(credit.expires_at) : undefined;
      return {
        creditId: credit.id,
        title:
          typeof credit.title === "string" && credit.title.trim()
            ? credit.title.trim()
            : "Full reset",
        description:
          typeof credit.description === "string" && credit.description.trim()
            ? credit.description.trim()
            : "Reset your current usage limits.",
        ...(expires && !Number.isNaN(expires.getTime()) ? { expiresAt: expires } : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, availableCount);

  if (availableCount > 0 && options.length === 0) options.push(genericOption());
  return { availableCount, options };
}

async function codexAuth(
  authStorage: AuthStorage,
): Promise<Result<{ headers: Record<string, string> }>> {
  const token = await providerAccessToken(authStorage, "openai-codex");
  if (!token) return { ok: false, message: "No Codex access token found" };
  const accountId = codexAccountId(authStorage);
  if (!accountId) return { ok: false, message: "No Codex account id found" };
  return { ok: true, headers: codexHeaders(token, accountId) };
}

export async function fetchCodexResetCredits(
  authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<Result<CodexResetAvailability>> {
  const auth = await codexAuth(authStorage);
  if (!auth.ok) return auth;
  const result = await fetchJson(RESET_CREDITS_URL, { headers: auth.headers }, signal);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, ...parseCodexResetCredits(result.data) };
}

export async function consumeCodexResetCredit(
  authStorage: AuthStorage,
  option: CodexResetOption,
  signal?: AbortSignal,
): Promise<Result<CodexResetOutcome>> {
  const auth = await codexAuth(authStorage);
  if (!auth.ok) return auth;
  const result = await fetchJson(
    RESET_CONSUME_URL,
    {
      method: "POST",
      headers: { ...auth.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        redeem_request_id: randomUUID(),
        ...(option.creditId ? { credit_id: option.creditId } : {}),
      }),
    },
    signal,
  );
  if (!result.ok) return { ok: false, message: result.message };
  const code = result.data?.code;
  if (!OUTCOME_CODES.includes(code)) {
    return { ok: false, message: `Unexpected reset outcome: ${String(code)}` };
  }
  return { ok: true, code, windowsReset: count(result.data?.windows_reset) };
}

export function resetLabel(n: number): string {
  return n === 1 ? "usage limit reset" : "usage limit resets";
}

export function formatCodexResetOutcome(
  outcome: CodexResetOutcome,
  remaining?: number,
): string {
  const left =
    remaining === undefined ? "" : ` ${remaining} ${resetLabel(remaining)} left.`;
  switch (outcome.code) {
    case "reset":
      return `Usage reset.${left}`;
    case "already_redeemed":
      return `Usage reset was already completed.${left}`;
    case "nothing_to_reset":
      return "Your usage does not need a reset right now.";
    case "no_credit":
      return "No usage limit resets are available.";
  }
}
