import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };

export type UsageFeatureId =
  | "usageCommand"
  | "providerCommands"
  | "usageStatus"
  | "usageStatusPlacement"
  | "tokenStatus"
  | "quotaWarnings"
  | "usageTool"
  | "deferToSynthetic"
  | "hideUnconfiguredProviders";

/**
 * Where the usage status renders. `statusBar` uses the shared footer status
 * channel; `aboveEditor`/`belowEditor` use a dedicated widget line, which
 * avoids collisions with other extensions in the shared status row.
 */
export type UsageStatusPlacement =
  | "statusBar"
  | "aboveEditor"
  | "belowEditor";

export const USAGE_EXTENSIONS_REQUEST_EVENT =
  "usage:extensions:request" as const;
export const USAGE_EXTENSIONS_REGISTER_EVENT =
  "usage:extensions:register" as const;
export const USAGE_CONFIG_UPDATED_EVENT = "usage:config:updated" as const;

export interface UsageExtensionsRegisterPayload {
  feature: UsageFeatureId;
}

export interface UsageConfig {
  configVersion?: string;
  usageCommand?: boolean;
  providerCommands?: boolean;
  usageStatus?: boolean;
  /** Where the usage status renders (defaults to the shared footer `statusBar`). */
  usageStatusPlacement?: UsageStatusPlacement;
  tokenStatus?: boolean;
  quotaWarnings?: boolean;
  /** Register the `get_usage` tool so the agent can read provider usage. */
  usageTool?: boolean;
  /** When true and pi-synthetic's usage footer is active, hide pi-usage's Synthetic footer. */
  deferToSynthetic?: boolean;
  /** When true, only register `/provider:usage` commands for providers with credentials. */
  hideUnconfiguredProviders?: boolean;
}

export interface ResolvedUsageConfig {
  configVersion: string;
  usageCommand: boolean;
  providerCommands: boolean;
  usageStatus: boolean;
  usageStatusPlacement: UsageStatusPlacement;
  tokenStatus: boolean;
  quotaWarnings: boolean;
  usageTool: boolean;
  deferToSynthetic: boolean;
  hideUnconfiguredProviders: boolean;
}

const DEFAULT_CONFIG: ResolvedUsageConfig = {
  configVersion: pkg.version,
  usageCommand: true,
  providerCommands: true,
  usageStatus: true,
  usageStatusPlacement: "statusBar",
  tokenStatus: true,
  quotaWarnings: true,
  usageTool: true,
  deferToSynthetic: true,
  hideUnconfiguredProviders: true,
};

let pendingMigrationNotice = false;

function markMigrationNoticePending(): void {
  pendingMigrationNotice = true;
}

export function hasPendingMigrationNotice(): boolean {
  return pendingMigrationNotice;
}

export function clearPendingMigrationNotice(): void {
  pendingMigrationNotice = false;
}

class UsageConfigStore {
  private config: ResolvedUsageConfig = DEFAULT_CONFIG;
  private cwd = process.cwd();

  private globalPath(): string {
    return join(homedir(), ".pi", "agent", "extensions", "usage.json");
  }

  private localPath(): string {
    return join(this.cwd, ".pi", "usage.json");
  }

  private resolve(input?: UsageConfig): ResolvedUsageConfig {
    return {
      configVersion: input?.configVersion ?? DEFAULT_CONFIG.configVersion,
      usageCommand: input?.usageCommand ?? DEFAULT_CONFIG.usageCommand,
      providerCommands:
        input?.providerCommands ?? DEFAULT_CONFIG.providerCommands,
      usageStatus: input?.usageStatus ?? DEFAULT_CONFIG.usageStatus,
      usageStatusPlacement:
        input?.usageStatusPlacement === "aboveEditor" ||
        input?.usageStatusPlacement === "belowEditor"
          ? input.usageStatusPlacement
          : DEFAULT_CONFIG.usageStatusPlacement,
      tokenStatus: input?.tokenStatus ?? DEFAULT_CONFIG.tokenStatus,
      quotaWarnings: input?.quotaWarnings ?? DEFAULT_CONFIG.quotaWarnings,
      usageTool: input?.usageTool ?? DEFAULT_CONFIG.usageTool,
      deferToSynthetic:
        input?.deferToSynthetic ?? DEFAULT_CONFIG.deferToSynthetic,
      hideUnconfiguredProviders:
        input?.hideUnconfiguredProviders ??
        DEFAULT_CONFIG.hideUnconfiguredProviders,
    };
  }

  private async readConfig(path: string): Promise<UsageConfig | undefined> {
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as UsageConfig;
      return data;
    } catch {
      return undefined;
    }
  }

  async load(cwd = process.cwd()): Promise<void> {
    this.cwd = cwd;
    const global = await this.readConfig(this.globalPath());
    const local = await this.readConfig(this.localPath());
    const merged = { ...global, ...local };
    if (!global && !local) markMigrationNoticePending();
    this.config = this.resolve(merged);
  }

  getConfig(): ResolvedUsageConfig {
    return this.config;
  }

  hasConfig(scope: "global" | "local"): boolean {
    const path = scope === "global" ? this.globalPath() : this.localPath();
    return existsSync(path);
  }

  async save(scope: "global" | "local", config: UsageConfig): Promise<void> {
    const path = scope === "global" ? this.globalPath() : this.localPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(this.resolve(config), null, 2) + "\n",
      "utf8",
    );
    await this.load(this.cwd);
  }
}

export const configLoader = new UsageConfigStore();

export async function seedUsageConfigIfMissing(): Promise<void> {
  if (configLoader.hasConfig("global") || configLoader.hasConfig("local"))
    return;
  markMigrationNoticePending();
  try {
    await configLoader.save("global", DEFAULT_CONFIG);
  } catch {
    // ignore
  }
}

export interface UsageConfigUpdatedPayload {
  config: ResolvedUsageConfig;
}

export function emitUsageConfigUpdated(pi: ExtensionAPI): void {
  pi.events.emit(USAGE_CONFIG_UPDATED_EVENT, {
    config: configLoader.getConfig(),
  });
}

const FEATURE_META: Array<{
  id: UsageFeatureId;
  label: string;
  description: string;
}> = [
  {
    id: "usageCommand",
    label: "Combined usage command",
    description: "Toggle the `/usage` command",
  },
  {
    id: "providerCommands",
    label: "Provider usage commands",
    description:
      "Toggle `/anthropic:usage`, `/codex:usage`, `/github:usage`, `/openrouter:usage`, and `/synthetic:usage`",
  },
  {
    id: "usageStatus",
    label: "Usage status",
    description: "Toggle footer quota status for the active provider",
  },
  {
    id: "usageStatusPlacement",
    label: "Usage status placement",
    description:
      "Render usage status in the shared footer bar, or on its own line above/below the editor",
  },
  {
    id: "tokenStatus",
    label: "Token usage status",
    description: "Toggle the footer token-usage status and /tokens command",
  },
  {
    id: "quotaWarnings",
    label: "Quota warnings",
    description: "Toggle projected-usage warning notifications",
  },
  {
    id: "usageTool",
    label: "Usage tool",
    description: "Toggle the `get_usage` tool that lets the agent read provider usage",
  },
  {
    id: "deferToSynthetic",
    label: "Defer to Synthetic",
    description:
      "When pi-synthetic is loaded, hide pi-usage's Synthetic footer to avoid duplicates",
  },
  {
    id: "hideUnconfiguredProviders",
    label: "Hide unconfigured providers",
    description:
      "Only register `/provider:usage` commands for providers that have credentials",
  },
];

/**
 * Behaviour switches rather than loadable sub-extensions. The settings UI must
 * not require these to be registered by a sub-extension.
 */
const NON_LOADABLE_FEATURES = new Set<UsageFeatureId>([
  "deferToSynthetic",
  "hideUnconfiguredProviders",
  "usageStatusPlacement",
]);

const USAGE_STATUS_PLACEMENTS: UsageStatusPlacement[] = [
  "statusBar",
  "aboveEditor",
  "belowEditor",
];

export function registerUsageSettings(
  pi: ExtensionAPI,
  getLoadedFeatures: () => Set<UsageFeatureId>,
): void {
  pi.registerCommand("usage:settings", {
    description: "Configure quota extension settings",
    handler: async (_args, ctx) => {
      await configLoader.load(ctx.cwd);
      const scopeChoice = await ctx.ui.select("Save settings to", [
        "global",
        "local",
        "cancel",
      ]);
      if (!scopeChoice || scopeChoice === "cancel") return;
      const scope = scopeChoice as "global" | "local";
      const draft: ResolvedUsageConfig = { ...configLoader.getConfig() };

      while (true) {
        const choices = FEATURE_META.map((feature) => {
          // Behaviour switches are never registered by a sub-extension, so
          // they must not be annotated as unloaded.
          const registered =
            NON_LOADABLE_FEATURES.has(feature.id) ||
            getLoadedFeatures().has(feature.id);
          const loaded = registered ? "" : " (not loaded)";
          const value =
            feature.id === "usageStatusPlacement"
              ? draft.usageStatusPlacement
              : draft[feature.id]
                ? "enabled"
                : "disabled";
          return `${feature.label}: ${value}${loaded}`;
        });
        choices.push("Save and exit", "Cancel");

        const selected = await ctx.ui.select("Usage Settings", choices);
        if (!selected || selected === "Cancel") return;
        if (selected === "Save and exit") {
          await configLoader.save(scope, draft);
          emitUsageConfigUpdated(pi);
          ctx.ui.notify(
            "Quota settings saved. Run /reload to fully apply command visibility changes.",
            "info",
          );
          return;
        }

        const feature = FEATURE_META.find((item) =>
          selected.startsWith(`${item.label}:`),
        );
        if (!feature) continue;
        if (
          !NON_LOADABLE_FEATURES.has(feature.id) &&
          !getLoadedFeatures().has(feature.id)
        ) {
          ctx.ui.notify(
            `${feature.label} is not loaded by Pi in this session.`,
            "warning",
          );
          continue;
        }
        if (feature.id === "usageStatusPlacement") {
          const index = USAGE_STATUS_PLACEMENTS.indexOf(
            draft.usageStatusPlacement,
          );
          draft.usageStatusPlacement =
            USAGE_STATUS_PLACEMENTS[
              (index + 1) % USAGE_STATUS_PLACEMENTS.length
            ];
        } else {
          (draft as unknown as Record<string, boolean>)[feature.id] = !(
            draft as unknown as Record<string, boolean>
          )[feature.id];
        }
      }
    },
  });
}
