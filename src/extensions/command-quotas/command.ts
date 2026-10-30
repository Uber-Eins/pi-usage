import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  USAGE_EXTENSIONS_REGISTER_EVENT,
  USAGE_EXTENSIONS_REQUEST_EVENT,
  configLoader,
  openUsageSettings,
} from "../../config.js";
import { type AuthStorage, quotaAuthStorage } from "../../lib/auth.js";
import { isProviderConfigured } from "../../lib/provider-availability.js";
import {
  fetchAllProviderQuotas,
  fetchProviderQuotas,
  SUPPORTED_PROVIDERS,
} from "../../lib/quotas.js";
import {
  type CodexResetOption,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  formatCodexResetOutcome,
} from "../../providers/codex-resets.js";
import type { QuotasResult, SupportedQuotaProvider } from "../../types/quotas.js";
import { type CodexResetActions, QuotasComponent } from "./components/quotas-display.js";
import {
  getProviderCommandInfo,
  resolveProviderSubcommand,
} from "./provider-commands.js";
import { filterDashboardSnapshots } from "./visibility.js";

type Snapshot = { provider: SupportedQuotaProvider; result: QuotasResult };

function showsCodex(snapshots: Snapshot[]): boolean {
  return snapshots.some(
    ({ provider, result }) => provider === "openai-codex" && result.success,
  );
}

export function codexResetActions(authStorage: AuthStorage): CodexResetActions {
  return {
    async redeem(option: CodexResetOption): Promise<string> {
      const outcome = await consumeCodexResetCredit(authStorage, option);
      if (!outcome.ok) return `Reset failed: ${outcome.message}`;
      const after = await fetchCodexResetCredits(authStorage);
      return formatCodexResetOutcome(outcome, after.ok ? after.availableCount : undefined);
    },
  };
}

async function openQuotaView(
  title: string,
  loadSnapshots: (force: boolean, signal?: AbortSignal) => Promise<Snapshot[]>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const authStorage = quotaAuthStorage(ctx.modelRegistry);
  const result = await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const controller = new AbortController();
    const component = new QuotasComponent(
      theme,
      tui,
      title,
      () => {
        controller.abort();
        done(null);
      },
      () => {
        component.setState({ type: "loading" });
        tui.requestRender();
        void load(true);
      },
      codexResetActions(authStorage),
    );

    async function load(force = false): Promise<void> {
      const snapshots = await loadSnapshots(force, controller.signal);
      if (controller.signal.aborted) return;
      component.setState({ type: "loaded", snapshots });
      tui.requestRender();

      if (!showsCodex(snapshots)) {
        component.setCodexResets(undefined);
        return;
      }
      const resets = await fetchCodexResetCredits(authStorage, controller.signal);
      if (controller.signal.aborted) return;
      // A failed lookup just hides the reset line; the quota view still works.
      component.setCodexResets(resets.ok ? resets : undefined);
      tui.requestRender();
    }

    void load();

    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => component.handleInput(data),
      dispose: () => {
        controller.abort();
        component.destroy();
      },
    };
  });

  if (result === undefined) {
    const snapshots = await loadSnapshots(true);
    ctx.ui.notify(formatSnapshotsForNotify(snapshots), "info");
  }
}

/**
 * Render quota snapshots as a readable multi-line summary for the
 * non-interactive fallback (when `ctx.ui.custom` returns undefined). Avoids
 * dumping raw JSON — which previously leaked raw HTTP error bodies — and
 * skips "not_applicable" providers since they have nothing to report.
 */
function formatSnapshotsForNotify(snapshots: Snapshot[]): string {
  const lines: string[] = [];
  for (const { provider, result } of snapshots) {
    if (!result.success) {
      if (result.error.kind === "not_applicable") continue;
      lines.push(`${provider}: ${result.error.message}`);
      continue;
    }
    const summary = result.data.windows
      .map((w) => `${w.label} ${w.usedPercent}%`)
      .join(", ");
    lines.push(`${provider}: ${summary || "no windows"}`);
  }
  return lines.join("\n") || "No quota data available";
}

export interface RegisterUsageCommandsOptions {
  /** Override the `hideUnconfiguredProviders` setting. */
  hideUnconfigured?: boolean;
  /** Override credential detection. */
  isConfigured?: (provider: SupportedQuotaProvider) => boolean;
}

const SETTINGS_SUBCOMMAND = "settings";

/**
 * Completions for `/usage <arg>`: `settings`, then one entry per provider.
 * Evaluated on every keystroke, so settings and credentials apply without a
 * reload.
 */
export function usageArgumentCompletions(
  prefix: string,
  options: RegisterUsageCommandsOptions = {},
): AutocompleteItem[] | null {
  const config = configLoader.getConfig();
  const hideUnconfigured =
    options.hideUnconfigured ?? config.hideUnconfiguredProviders;
  const isConfigured = options.isConfigured ?? isProviderConfigured;

  const items: AutocompleteItem[] = [
    {
      value: SETTINGS_SUBCOMMAND,
      label: SETTINGS_SUBCOMMAND,
      description: "Configure pi-usage features",
    },
  ];
  if (config.providerCommands) {
    for (const provider of SUPPORTED_PROVIDERS) {
      // A provider without credentials can only ever report "no credentials".
      if (hideUnconfigured && !isConfigured(provider)) continue;
      const info = getProviderCommandInfo(provider);
      items.push({
        value: info.subcommand,
        label: info.subcommand,
        description: `Display remaining ${info.title.toLowerCase()}`,
      });
    }
  }

  const needle = prefix.trim().toLowerCase();
  const matches = items.filter((item) => item.value.startsWith(needle));
  return matches.length > 0 ? matches : null;
}

export function registerUsageCommands(
  pi: ExtensionAPI,
  options: RegisterUsageCommandsOptions = {},
): void {
  pi.registerCommand("usage", {
    description: "Display provider usage (`/usage <provider>` for one, `/usage settings` to configure)",
    getArgumentCompletions: (prefix) => usageArgumentCompletions(prefix, options),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // Always reachable, so a disabled feature can be re-enabled.
      if (arg === SETTINGS_SUBCOMMAND) {
        await openUsageSettings(pi, ctx);
        return;
      }

      const config = configLoader.getConfig();
      if (!arg) {
        if (!config.usageCommand) {
          ctx.ui.notify("/usage is disabled. Re-enable it in /usage settings.", "warning");
          return;
        }
        await openQuotaView(
          "Provider Quotas",
          async (force, signal) =>
            filterDashboardSnapshots(
              await fetchAllProviderQuotas(
                quotaAuthStorage(ctx.modelRegistry),
                { force, signal },
              ),
            ),
          ctx,
        );
        return;
      }

      const provider = resolveProviderSubcommand(arg);
      if (!provider) {
        const known = SUPPORTED_PROVIDERS.map(
          (p) => getProviderCommandInfo(p).subcommand,
        ).join(", ");
        ctx.ui.notify(
          `Unknown /usage argument "${arg}". Use settings or one of: ${known}.`,
          "warning",
        );
        return;
      }
      if (!config.providerCommands) {
        ctx.ui.notify(
          "Provider usage views are disabled. Re-enable them in /usage settings.",
          "warning",
        );
        return;
      }
      const info = getProviderCommandInfo(provider);
      await openQuotaView(
        info.title,
        async (force, signal) => [
          {
            provider,
            result: await fetchProviderQuotas(quotaAuthStorage(ctx.modelRegistry), provider, { force, signal }),
          },
        ],
        ctx,
      );
    },
  });
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();

  // Always registered: `/usage settings` must stay reachable even when every
  // view is disabled. The handler checks the flags at call time.
  registerUsageCommands(pi);

  pi.events.on(USAGE_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, { feature: "usageCommand" });
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, { feature: "providerCommands" });
  });
}
