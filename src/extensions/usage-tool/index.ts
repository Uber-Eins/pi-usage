import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  USAGE_EXTENSIONS_REGISTER_EVENT,
  USAGE_EXTENSIONS_REQUEST_EVENT,
  configLoader,
} from "../../config.js";
import { type AuthStorage, quotaAuthStorage } from "../../lib/auth.js";
import { isProviderConfigured } from "../../lib/provider-availability.js";
import {
  fetchProviderQuotas,
  isSupportedProvider,
  SUPPORTED_PROVIDERS,
} from "../../lib/quotas.js";
import { fetchCodexResetCredits } from "../../providers/codex-resets.js";
import type { SupportedQuotaProvider } from "../../types/quotas.js";
import {
  formatProviderEntry,
  type ToolProviderEntry,
  type ToolSnapshot,
  toProviderEntry,
} from "./format.js";

export const USAGE_TOOL_NAME = "get_usage";

export interface UsageToolParams {
  provider?: string;
  force?: boolean;
}

export interface UsageToolDeps {
  isConfigured?: (provider: SupportedQuotaProvider) => boolean;
  fetchQuotas?: typeof fetchProviderQuotas;
  fetchCodexResets?: typeof fetchCodexResetCredits;
}

export interface UsageToolResult {
  text: string;
  details: {
    currentModel?: string;
    providers: ToolProviderEntry[];
  };
}

/**
 * Errors that only mean "this provider is not set up here". They are noise in
 * the all-providers overview, but still reported when a provider is requested
 * explicitly.
 */
const SILENT_ERROR_KINDS = new Set(["config", "not_applicable"]);

export async function runUsageTool(
  params: UsageToolParams,
  authStorage: AuthStorage,
  model: { provider: string; id: string } | undefined,
  signal?: AbortSignal,
  deps: UsageToolDeps = {},
): Promise<UsageToolResult> {
  const isConfigured = deps.isConfigured ?? isProviderConfigured;
  const fetchQuotas = deps.fetchQuotas ?? fetchProviderQuotas;
  const activeProvider = model?.provider;
  const currentModel = model ? `${model.provider}/${model.id}` : undefined;

  const requested = params.provider?.trim();
  if (requested && !isSupportedProvider(requested)) {
    return {
      text: `Unknown provider "${requested}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}.`,
      details: { currentModel, providers: [] },
    };
  }

  const targets: SupportedQuotaProvider[] = requested
    ? [requested as SupportedQuotaProvider]
    : SUPPORTED_PROVIDERS.filter((provider) => isConfigured(provider));

  const snapshots: ToolSnapshot[] = await Promise.all(
    targets.map(async (provider) => ({
      provider,
      result: await fetchQuotas(authStorage, provider, {
        force: params.force ?? false,
        signal,
      }),
    })),
  );

  const visible = requested
    ? snapshots
    : snapshots.filter(
        ({ result }) =>
          result.success || !SILENT_ERROR_KINDS.has(result.error.kind),
      );
  const providers = visible.map((snapshot) =>
    toProviderEntry(snapshot, activeProvider),
  );

  const codex = providers.find((entry) => entry.provider === "openai-codex" && entry.ok);
  if (codex) {
    const resets = await (deps.fetchCodexResets ?? fetchCodexResetCredits)(authStorage, signal);
    // Reset credits are a bonus; a failed lookup just omits the line.
    if (resets.ok) {
      const nextExpiry = resets.options.find((option) => option.expiresAt)?.expiresAt;
      codex.codexResets = {
        available: resets.availableCount,
        ...(nextExpiry ? { nextExpiry: nextExpiry.toISOString() } : {}),
      };
    }
  }

  const lines: string[] = [];
  if (currentModel) {
    const supported = activeProvider && isSupportedProvider(activeProvider);
    lines.push(
      `Current model: ${currentModel}${supported ? "" : " (no usage data available for this provider)"}`,
    );
  }
  lines.push(`Checked at: ${new Date().toISOString()}`);
  if (providers.length === 0) {
    lines.push("", "No provider usage data available.");
  }
  for (const entry of providers) {
    lines.push("", formatProviderEntry(entry));
  }

  return { text: lines.join("\n"), details: { currentModel, providers } };
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();

  if (configLoader.getConfig().usageTool) {
    pi.registerTool({
      name: USAGE_TOOL_NAME,
      label: "Usage",
      description:
        "Get subscription/quota usage for AI providers: used percentage per window (e.g. 5h, 7d), reset times, " +
        "projected usage at the current pace, balances, and limits. Without `provider`, returns every configured provider.",
      promptSnippet:
        "get_usage: check provider quota usage, remaining limits, and reset times",
      promptGuidelines: [
        "Use get_usage to check remaining provider quota and reset times before starting heavy or long-running work, or when the user asks about usage or limits.",
      ],
      parameters: Type.Object({
        provider: Type.Optional(
          Type.String({
            description: `Only this provider. One of: ${SUPPORTED_PROVIDERS.join(", ")}`,
          }),
        ),
        force: Type.Optional(
          Type.Boolean({
            description:
              "Bypass the short (about 1-5 minute) cache and refetch now",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const result = await runUsageTool(
          params as UsageToolParams,
          quotaAuthStorage(ctx.modelRegistry),
          ctx.model,
          signal,
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      },
    });
  }

  pi.events.on(USAGE_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, { feature: "usageTool" });
  });
}
