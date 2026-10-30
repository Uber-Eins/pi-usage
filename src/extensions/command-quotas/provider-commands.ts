import { isSupportedProvider, SUPPORTED_PROVIDERS } from "../../lib/quotas.js";
import type { SupportedQuotaProvider } from "../../types/quotas.js";

export interface ProviderCommandInfo {
  provider: SupportedQuotaProvider;
  /** Argument for `/usage <subcommand>`. */
  subcommand: string;
  title: string;
}

const PROVIDER_COMMANDS: Record<
  SupportedQuotaProvider,
  { subcommand: string; title: string }
> = {
  anthropic: { subcommand: "anthropic", title: "Anthropic Usage" },
  "openai-codex": { subcommand: "codex", title: "OpenAI Codex Usage" },
  "github-copilot": { subcommand: "github", title: "GitHub Copilot Usage" },
  openrouter: { subcommand: "openrouter", title: "OpenRouter Usage" },
  synthetic: { subcommand: "synthetic", title: "Synthetic Usage" },
  xai: { subcommand: "grok", title: "Grok Usage" },
  zai: { subcommand: "zai", title: "Z.ai Usage" },
  "opencode-go": { subcommand: "opencode-go", title: "OpenCode Go Usage" },
  "kimi-coding": { subcommand: "kimi", title: "Kimi Code Usage" },
  "ollama-cloud": { subcommand: "ollama", title: "Ollama Cloud Usage" },
  minimax: { subcommand: "minimax", title: "MiniMax Usage" },
  commandcode: { subcommand: "commandcode", title: "Command Code Usage" },
};

export function getProviderCommandInfo(
  provider: SupportedQuotaProvider,
): ProviderCommandInfo {
  return { provider, ...PROVIDER_COMMANDS[provider] };
}

/** Resolve a `/usage` argument (short subcommand or full provider id). */
export function resolveProviderSubcommand(
  arg: string,
): SupportedQuotaProvider | undefined {
  const name = arg.trim().toLowerCase();
  const match = SUPPORTED_PROVIDERS.find(
    (provider) => PROVIDER_COMMANDS[provider].subcommand === name,
  );
  if (match) return match;
  return isSupportedProvider(name) ? name : undefined;
}
