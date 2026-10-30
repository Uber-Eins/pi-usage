import { describe, expect, it } from "vitest";
import { SUPPORTED_PROVIDERS } from "./quotas.js";
import {
  isProviderConfigured,
  type ProviderAvailabilityDeps,
} from "./provider-availability.js";

const EMPTY: ProviderAvailabilityDeps = {
  env: {} as NodeJS.ProcessEnv,
  hasStoredCredential: () => false,
  fileExists: () => false,
};

describe("isProviderConfigured", () => {
  it("is false for every provider when nothing is set", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(isProviderConfigured(provider, EMPTY)).toBe(false);
    }
  });

  it("is true when the provider's env var is set", () => {
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ["anthropic", { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["anthropic", { ANTHROPIC_AUTH_TOKEN: "k" } as NodeJS.ProcessEnv],
      ["anthropic", { ANTHROPIC_OAUTH_TOKEN: "k" } as NodeJS.ProcessEnv],
      ["openrouter", { OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["synthetic", { SYNTHETIC_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["xai", { XAI_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["zai", { ZAI_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["opencode-go", { OPENCODE_GO_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["opencode-go", { OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["kimi-coding", { KIMI_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["ollama-cloud", { OLLAMA_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["minimax", { MINIMAX_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["commandcode", { COMMAND_CODE_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["commandcode", { COMMANDCODE_API_KEY: "k" } as NodeJS.ProcessEnv],
      ["github-copilot", { COPILOT_GITHUB_TOKEN: "k" } as NodeJS.ProcessEnv],
    ];
    for (const [provider, env] of cases) {
      expect(
        isProviderConfigured(provider as (typeof SUPPORTED_PROVIDERS)[number], {
          ...EMPTY,
          env,
        }),
      ).toBe(true);
    }
  });

  it("ignores blank env values", () => {
    expect(
      isProviderConfigured("xai", {
        ...EMPTY,
        env: { XAI_API_KEY: "   " } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("does not treat another provider's key as a credential", () => {
    // openai-codex authenticates via OAuth or ~/.codex/auth.json; a plain
    // OPENAI_API_KEY belongs to the `openai` provider and would only leave
    // /usage codex offered and failing.
    expect(
      isProviderConfigured("openai-codex", {
        ...EMPTY,
        env: { OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
    expect(
      isProviderConfigured("kimi-coding", {
        ...EMPTY,
        env: { MOONSHOT_API_KEY: "k" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
    expect(
      isProviderConfigured("minimax", {
        ...EMPTY,
        env: { MINIMAX_CN_API_KEY: "k" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("is true when auth.json holds a credential", () => {
    expect(
      isProviderConfigured("anthropic", {
        ...EMPTY,
        hasStoredCredential: (provider) => provider === "anthropic",
      }),
    ).toBe(true);
    expect(
      isProviderConfigured("xai", {
        ...EMPTY,
        hasStoredCredential: (provider) => provider === "anthropic",
      }),
    ).toBe(false);
  });

  it("is true when a provider-specific config file exists", () => {
    expect(
      isProviderConfigured("openai-codex", {
        ...EMPTY,
        fileExists: (path) => path.endsWith(".codex/auth.json"),
      }),
    ).toBe(true);
    expect(
      isProviderConfigured("opencode-go", {
        ...EMPTY,
        fileExists: (path) => path.endsWith("opencode-go.json"),
      }),
    ).toBe(true);
    expect(
      isProviderConfigured("commandcode", {
        ...EMPTY,
        fileExists: (path) => path.endsWith(".commandcode/auth.json"),
      }),
    ).toBe(true);
    expect(
      isProviderConfigured("commandcode", {
        ...EMPTY,
        fileExists: (path) => path.endsWith(".omp/agent/auth.json"),
      }),
    ).toBe(true);
  });

  it("does not treat the removed OPENCODE_GO_WORKSPACE_ID as a credential", () => {
    // Dashboard scraping was removed in #1; the workspace ID no longer
    // authenticates anything and must not keep /usage opencode-go offered.
    expect(
      isProviderConfigured("opencode-go", {
        ...EMPTY,
        env: { OPENCODE_GO_WORKSPACE_ID: "wrk_1" } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("does not treat the OpenCode CLI credential store as a credential", () => {
    // The CLI's auth.json is a multi-provider store owned by another
    // application. Its presence must not make opencode-go look configured.
    expect(
      isProviderConfigured("opencode-go", {
        ...EMPTY,
        fileExists: (path) => path.endsWith("opencode/auth.json"),
      }),
    ).toBe(false);
  });

  it("does not treat unrelated files as credentials for env-only providers", () => {
    expect(
      isProviderConfigured("xai", { ...EMPTY, fileExists: () => true }),
    ).toBe(false);
    expect(
      isProviderConfigured("minimax", { ...EMPTY, fileExists: () => true }),
    ).toBe(false);
  });
});
