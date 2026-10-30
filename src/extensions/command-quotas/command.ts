import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  USAGE_EXTENSIONS_REGISTER_EVENT,
  USAGE_EXTENSIONS_REQUEST_EVENT,
  configLoader,
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
import { getProviderCommandInfo } from "./provider-commands.js";
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

export function registerUsageCommands(
  pi: ExtensionAPI,
  options: RegisterUsageCommandsOptions = {},
): void {
  pi.registerCommand("usage", {
    description: "Display remaining usage for all supported providers",
    handler: async (_args, ctx) => {
      if (!configLoader.getConfig().usageCommand) {
        ctx.ui.notify("/usage is disabled. Re-enable it in /usage:settings.", "warning");
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
    },
  });

  // Unconfigured providers would otherwise add a `/grok:usage`-style command
  // that only ever reports "no credentials". Pi has no way to hide a
  // registered command, so skip registration instead.
  const hideUnconfigured =
    options.hideUnconfigured ??
    configLoader.getConfig().hideUnconfiguredProviders;
  const isConfigured = options.isConfigured ?? isProviderConfigured;

  for (const provider of SUPPORTED_PROVIDERS) {
    if (hideUnconfigured && !isConfigured(provider)) continue;
    const info = getProviderCommandInfo(provider);
    pi.registerCommand(info.commandName, {
      description: `Display remaining ${info.title.toLowerCase()}`,
      handler: async (_args, ctx) => {
        if (!configLoader.getConfig().providerCommands) {
          ctx.ui.notify(`${info.commandName} is disabled. Re-enable it in /usage:settings.`, "warning");
          return;
        }
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
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();

  const config = configLoader.getConfig();
  if (config.usageCommand || config.providerCommands) {
    registerUsageCommands(pi);
  }

  // Register regardless of the enabled flag so /usage:settings can toggle
  // command visibility in both directions. The command handlers still check
  // the config at call time.
  pi.events.on(USAGE_EXTENSIONS_REQUEST_EVENT, () => {
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, { feature: "usageCommand" });
    pi.events.emit(USAGE_EXTENSIONS_REGISTER_EVENT, { feature: "providerCommands" });
  });
}
