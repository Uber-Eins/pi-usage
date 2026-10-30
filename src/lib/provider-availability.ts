import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SupportedQuotaProvider } from "../types/quotas.js";
import { hasStoredCredential } from "./auth.js";

/**
 * Environment variables Pi (or the provider itself) reads for each quota
 * provider. Names come from `@earendil-works/pi-ai`'s `env-api-keys.js` and
 * from the fetchers that read the environment directly (synthetic,
 * ollama-cloud).
 *
 * A variable only belongs here if it actually authenticates that provider's
 * quota endpoint. Adding an unrelated variable keeps a command visible that
 * can only fail, which is the noise this feature exists to remove.
 */
const PROVIDER_ENV_VARS: Record<SupportedQuotaProvider, readonly string[]> = {
  // pi-ai discovers all three for Anthropic (`env-api-keys.js`).
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
  ],
  // openai-codex has no environment credential in pi-ai; it is OAuth plus the
  // `~/.codex/auth.json` fallback below. OPENAI_API_KEY belongs to the `openai`
  // provider and does not authenticate openai-codex, so it is deliberately
  // absent — including it would leave `/usage codex` offered and broken.
  "openai-codex": [],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  openrouter: ["OPENROUTER_API_KEY"],
  synthetic: ["SYNTHETIC_API_KEY"],
  xai: ["XAI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  // OPENCODE_API_KEY is what pi-ai reads for opencode-go; OPENCODE_GO_API_KEY
  // is this package's Go-specific override. The legacy OPENCODE_GO_WORKSPACE_ID
  // no longer authenticates anything (dashboard scraping was removed), so it
  // is deliberately absent.
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "ollama-cloud": ["OLLAMA_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  commandcode: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
};

/** Config files that hold a credential for providers that use one. */
function providerConfigPaths(provider: SupportedQuotaProvider): string[] {
  const home = homedir();
  switch (provider) {
    case "opencode-go":
      // Only pi-usage's own config files. The OpenCode CLI's auth.json is a
      // multi-provider credential store owned by another application, so its
      // presence must not make this provider look configured.
      return [
        join(home, ".config", "opencode", "opencode-quota", "opencode-go.json"),
        join(home, ".config", "opencode-go", "config.json"),
      ];
    case "openai-codex":
      return [join(home, ".codex", "auth.json")];
    case "commandcode":
      return [
        join(home, ".commandcode", "auth.json"),
        join(home, ".omp", "agent", "auth.json"),
      ];
    default:
      return [];
  }
}

export interface ProviderAvailabilityDeps {
  env?: NodeJS.ProcessEnv;
  hasStoredCredential?: (provider: string) => boolean;
  fileExists?: (path: string) => boolean;
}

/**
 * Best-effort, offline check for whether a provider has any credential the
 * quota fetchers could use: an environment variable, an `auth.json` entry, or
 * a provider-specific config file.
 *
 * Registration-time only, so it never touches the network.
 */
export function isProviderConfigured(
  provider: SupportedQuotaProvider,
  deps: ProviderAvailabilityDeps = {},
): boolean {
  const env = deps.env ?? process.env;
  if (PROVIDER_ENV_VARS[provider].some((name) => Boolean(env[name]?.trim()))) {
    return true;
  }

  const credentialCheck = deps.hasStoredCredential ?? hasStoredCredential;
  if (credentialCheck(provider)) return true;

  const fileExists = deps.fileExists ?? existsSync;
  return providerConfigPaths(provider).some((path) => fileExists(path));
}
