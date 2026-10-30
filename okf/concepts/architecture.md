---
type: Reference
title: Architecture
description: Provider abstraction, footer rendering, lifecycle hooks, and extension entry point.
status: stable
generated: { by: process:pi-session, at: 2026-09-09T06:23:19Z }
tags: [architecture, code]
---

# Module map

```
src/
├── index.ts                 # Pi extension entry, registers hooks + commands
├── footer.ts                # renderUsageSegment(): short footer text
├── config.ts                # configLoader(): reads ~/.pi/agent/extensions/usage.json
└── providers/
    ├── types.ts             # Provider, QuotaWindow, ProviderFetchOutcome
    ├── index.ts             # buildProviderFor(): registry + auth resolver
    └── minimax.ts           # MiniMaxProvider + parseMiniMaxUsage
```

# Provider abstraction

A provider implements `src/providers/types.ts:Provider` — four members:

```ts
interface Provider {
  readonly id: string;                  // matches ctx.model.provider
  readonly displayName: string;          // "MiniMax"
  readonly fallbackEnvVar?: string;      // e.g. "MINIMAX_API_KEY"
  fetch(signal?: AbortSignal): Promise<ProviderFetchOutcome>;
}
```

`ProviderFetchOutcome` is a discriminated union: `{ ok: true, result: { windows, limited? } }` or `{ ok: false, error }`. The fetcher owns its own HTTP, JSON parsing, and timeout — the rest of the package only deals in `QuotaWindow[]`.

# Adding a provider

1. Create `src/providers/<id>.ts` implementing `Provider`.
2. Add a case to `buildProviderFor` in `src/providers/index.ts` that pulls the credential via `resolveApiKey(authStorage, "<id>", "<ENV_VAR>")`.
3. Add a concept doc at `okf/concepts/providers/<id>.md` describing the endpoint contract.
4. Add tests under `test/providers/`.

No changes are required to `index.ts` or `footer.ts`.

# Footer rendering

`renderUsageSegment(displayName, windows, { availableWidth? })` produces a one-line summary. Rules:

- Windows are sorted by `windowSeconds` ascending so the most-imminent reset is primary.
- If any window has `limited: true`, the segment collapses to a single `Limited` line.
- Otherwise the primary and secondary windows are joined with `│`, unless `availableWidth` is below 38 columns.
- The `●` prefix matches `@kaishin/pi-footer`'s activity indicator so the two extensions render coherently.

The extension writes the segment via `ctx.ui.setFooter(segment, 1)` — priority 1 so it sits above pi's default status line but below any higher-priority overlay.

# Lifecycle

| Hook / command | Where | Purpose | Gated by |
|---|---|---|---|
| `session_start` | `index.ts` | Fetch initial snapshot, write footer, and check quota risk | `usageStatus` / `quotaWarnings` |
| `turn_end` | `extensions/quota-warnings/index.ts` | Check active-provider risk without blocking the turn | `quotaWarnings` |
| `/usage` | `index.ts` | Force-refresh and print all windows for the active provider | `usageCommand` |
| `/usage <provider>` | `extensions/command-quotas/command.ts` | Dashboard for one provider, e.g. `/usage minimax` | `providerCommands` |
| `/usage settings` | `config.ts` (`openUsageSettings`) | Toggle features and save `usage.json` | — |

Snapshots are cached per-provider for 60 seconds (`CACHE_TTL_MS`). The cache lives in module scope and is dropped on extension reload.

# Configuration

The extension reads `~/.pi/agent/extensions/usage.json` on every command invocation and on `session_start`. The file is intended to be rcm-tracked (`~/.dotfiles/tag-pi/pi/agent/extensions/usage.json`). Schema mirrors what `@latentminds/pi-quotas` exposed under `quotas.json` for one-file migration:

| Field | Default | Effect |
|---|---|---|
| `usageCommand` | `true` | Toggle `/usage` |
| `providerCommands` | `true` | Toggle `/usage <provider>` views |
| `usageStatus` | `true` | Toggle the footer status segment |
| `quotaWarnings` | `true` | Toggle projected-usage warning notifications |
| `deferToSynthetic` | `true` | Suppress our footer when another extension reports the same data (reserved) |

Missing fields fall back to defaults. Missing or malformed JSON is treated as \"all defaults\", so the extension runs out of the box and only deliberate edits opt features out.

# Quota warning behavior

Risk is assessed from absolute usage and, when a window supports it, projected usage at the current pace. Notifications use Pi's warning presentation rather than its error presentation. A severity increase is reported immediately; otherwise the same risky window is repeated no more than once per hour. Exhausted windows say `limit reached`, while pace-aware warnings include the projected percentage by reset.

# Auth

`buildProviderFor` calls `authStorage.getApiKey(providerId)` first and falls back to the provider's `fallbackEnvVar`. This matches the convention used by [`@latentminds/pi-quotas`](https://github.com/latentminds-ai/pi-quotas).

# See also

- [Overview](overview.md)
- [Provider: MiniMax](providers/minimax.md)
