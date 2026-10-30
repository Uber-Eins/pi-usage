import { describe, expect, it } from "vitest";
import { SUPPORTED_PROVIDERS } from "../../lib/quotas.js";
import {
  getProviderCommandInfo,
  resolveProviderSubcommand,
} from "./provider-commands.js";

describe("getProviderCommandInfo", () => {
  it.each([
    ["anthropic", "anthropic", "Anthropic Usage"],
    ["openai-codex", "codex", "OpenAI Codex Usage"],
    ["github-copilot", "github", "GitHub Copilot Usage"],
    ["openrouter", "openrouter", "OpenRouter Usage"],
    ["xai", "grok", "Grok Usage"],
    ["zai", "zai", "Z.ai Usage"],
    ["kimi-coding", "kimi", "Kimi Code Usage"],
    ["minimax", "minimax", "MiniMax Usage"],
    ["commandcode", "commandcode", "Command Code Usage"],
  ] as const)("maps %s to /usage %s", (provider, subcommand, title) => {
    expect(getProviderCommandInfo(provider)).toEqual({ provider, subcommand, title });
  });

  it("gives every provider a unique subcommand", () => {
    const names = SUPPORTED_PROVIDERS.map((p) => getProviderCommandInfo(p).subcommand);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("settings");
  });
});

describe("resolveProviderSubcommand", () => {
  it("accepts short names and full provider ids, case-insensitively", () => {
    expect(resolveProviderSubcommand("codex")).toBe("openai-codex");
    expect(resolveProviderSubcommand(" Codex ")).toBe("openai-codex");
    expect(resolveProviderSubcommand("openai-codex")).toBe("openai-codex");
    expect(resolveProviderSubcommand("grok")).toBe("xai");
    expect(resolveProviderSubcommand("xai")).toBe("xai");
  });

  it("rejects unknown names", () => {
    expect(resolveProviderSubcommand("nope")).toBeUndefined();
    expect(resolveProviderSubcommand("settings")).toBeUndefined();
  });
});
