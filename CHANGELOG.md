# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **One `/usage` command**: provider views moved from `/codex:usage`-style commands to `/usage codex`, and `/usage:settings` became `/usage settings`. The old commands are removed. Typing `/usage ` completes `settings` and the configured providers; full provider ids such as `/usage openai-codex` also work. The provider list follows **Hide unconfigured providers** live, without `/reload`.

### Added
- **`get_usage` agent tool**: the agent can read quota windows, reset times, projected usage, balances, and available Codex resets for every configured provider (or a single requested one). Toggle it with the new **Usage tool** setting.
- **Codex usage limit resets in `/usage`**: the OpenAI Codex section shows how many earned resets are available, and `x` opens a confirmation to redeem one.

### Fixed
- **OpenCode Go weekly projections were seven times too high**: the weekly window was scaled by 1/7 on top of already spanning the full week, which inflated projected usage and raised false critical quota warnings.

## [2.4.0] - 2026-10-29

### Removed
- **The OpenCode CLI credential store is no longer read**: pi-usage no longer looks for an OpenCode Go key in `~/.local/share/opencode/auth.json`. That file is a multi-provider credential store owned by another application, so a stale key in it made pi-usage report on a provider the user never configured for Pi. Configure OpenCode Go with `pi /login opencode-go`, `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`, or `~/.config/opencode/opencode-quota/opencode-go.json` instead.

### Fixed
- **Rejected credentials no longer nag from the combined dashboard**: a provider whose key is refused (HTTP 401) is treated as a credential problem, not a provider outage, so `/usage` no longer shows a warning row for a provider you may not even be using. The per-provider commands still report the failure.
- **Expired OpenCode Go keys report the real cause**: the usage API distinguishes an expired key from other rejections and states that signing in again will not renew it. The dashboard now says so instead of pointing at `pi /login`, which cannot fix an expired key.

## [2.3.1] - 2026-10-25

### Fixed
- `/usage` and `/tokens` no longer crash Pi in narrow terminals. All dashboard lines now fit the available terminal width, including after resizing (#12).

## [2.3.0] - 2026-10-05

### Added
- **`usageStatusPlacement` setting** (#9): render the usage status in the shared footer status row (default), or on a dedicated widget line above/below the editor — avoiding truncation and collisions with other extensions that consume the shared status channel. Applies live from `/usage:settings`; the dedicated line adds a severity glyph (● / ▲ / ✕) and a time-to-exhaustion estimate for windows projected to run out before reset.

### Fixed
- Features disabled at startup can now be re-enabled from `/usage:settings`; sub-extension self-registration no longer depends on the enabled flag (#9).
- Saving any setting no longer resurrects the usage footer while pi-synthetic is showing the same data (#10).
- Enabling token-status at runtime for a non-Go provider no longer leaves a Go rolling-cost interval running (#10).

## [2.2.1] - 2026-10-03

### Fixed
- **Z.ai credit-based plans**: the GLM Coding Plan migrated quotas from tokens to credits, so `parseZaiUsage` returned zero windows and z.ai silently disappeared from the dashboard. `CREDIT_LIMIT` windows are now mapped with their real credit counts (5h and weekly), falling back to percentages when counts are absent. (Ported from latentminds-ai/pi-quotas #42.)

## [2.2.0] - 2026-10-03

### Added
- **Command Code provider**: reads account quota from the Command Code API (`/alpha/whoami`, `/alpha/billing/credits`, `/alpha/billing/subscriptions`, `/alpha/usage/summary`) using the same endpoints and window semantics as `pi-commandcode-provider`. Renders like the OpenCode Go provider: a 5-hour rolling and a weekly credit window plus a monthly budget window, shown in `/usage` and `/commandcode:usage`. Reads the API key from `pi /login`, `COMMAND_CODE_API_KEY` / `COMMANDCODE_API_KEY`, or `~/.commandcode/auth.json` / `~/.omp/agent/auth.json`.
- **Hide unconfigured provider commands**: pi-usage registered a `/provider:usage` command for every supported provider, so a command like `/grok:usage` showed up in the command list even with no credentials, and only ever reported a config error. Commands are now registered only for providers that have an environment variable, an `auth.json` entry, or a provider config file. On by default; toggle it under `/usage:settings` (`hideUnconfiguredProviders`). Run `/reload` after logging into a new provider so its command appears.

### Changed
- **OpenCode Go provider**: replaced dashboard SSR scraping (workspace ID + auth cookie) with the official `GET https://opencode.ai/zen/go/v1/usage` endpoint authenticated by an OpenCode Go API key. Reads the key from `OPENCODE_GO_API_KEY`, then `pi /login opencode-go` (`auth.json`), then `OPENCODE_API_KEY` (the shared variable Pi's own opencode-go provider authenticates with), then a config file `apiKey` / the OpenCode CLI `auth.json`. The dashboard no longer server-renders usage data, so the previous scraper always failed with "Could not parse OpenCode Go dashboard usage windows"; legacy `workspaceId`/`authCookie` configs now report a migration hint. API windows reported as rate-limited now escalate to critical severity, matching every other provider.

### Fixed
- A known-zero credit balance now escalates to critical severity instead of rendering with the calmest state.
- Environment variables now take precedence over stored `pi /login` credentials for OpenCode Go and Command Code, and OAuth-shaped stored credentials are never sent to the OpenCode Go endpoint.
- Quota warnings no longer claim a quota "resets in now" when the reset time is unknown.

## [2.1.0] - 2026-09-11

### Added
- Dashboard hourly and weekly progress bars now show a vertical time-progress line so usage can be compared against elapsed window time.

## [2.0.1] - 2026-09-09

### Fixed
- MiniMax windows no longer treat undocumented status value `1` as exhaustion when quota remains.
- Quota risks use warning notifications instead of appearing as errors, show clearer limit/projection text, and repeat unchanged high or critical alerts no more than once per hour.

## [0.5.0] - 2026-08-31

### Added
- **Grok (xAI) provider**: SuperGrok credit usage from the xAI CLI billing endpoint — weekly/monthly credit period, per-product usage windows, and on-demand spend — with the `/grok:quotas` command, dashboard, footer status, and quota warnings. Contributed by @LJC-god in #25.
- **Hide inactive quota providers**: dashboard and `/quotas` output now hide providers with nothing to report (no windows, or config/not-applicable errors) instead of showing a wall of unconfigured providers. Contributed by @LJC-god in #26.
- **Ollama Cloud provider**: rolling 5-hour session and 7-day weekly usage windows from the undocumented `/api/usage` endpoint, with the `/ollama:quotas` command, dashboard, footer status, and quota warnings. Reads the `ollama-cloud` API key from `auth.json` (falls back to `OLLAMA_API_KEY`). Contributed by @tdslot in #24.

### Fixed
- **OAuth refresh failures crash Pi**: a failed OAuth token refresh (e.g. an expired Anthropic refresh token) threw a `ModelsError` out of the quota fetch and surfaced as an `uncaughtException`, killing the whole Pi process when running `/quotas` or refreshing the footer. Fetcher errors are now contained and rendered as a per-provider failure ("re-authenticate with /login") instead.
- **Anthropic OAuth token prefix**: OAuth subscription tokens (`sk-ant-oat...`) were misclassified as direct API keys, so subscription usage was never fetched. Only `sk-ant-api...` keys are now treated as direct API keys. Contributed by @shaharyair in #28.
- **Synthetic API key source**: the Synthetic provider now prefers the key stored via `pi /login` (auth storage) and falls back to the `SYNTHETIC_API_KEY` env var. Contributed by @tdslot in #22.
- **Reset-time readability**: adjacent time units are now separated by a space (`2h 19m`, `1d 2h 19m` instead of `2h19m`, `1d2h19m`). Contributed by @shaharyair in #31.

## [0.4.0] - 2026-08-04

### Added
- **Kimi Code provider**: rolling five-hour and weekly Coding Plan usage windows, with the `/kimi:quotas` command, dashboard, footer status, and quota warnings. Contributed by @tdslot in #19.

### Fixed
- **Modern Pi authentication compatibility**: quota checks now resolve provider credentials through `ModelRegistry` instead of relying on its removed public `authStorage` property. This restores footer quota status, quota warnings, and `/codex:quotas` on newer Pi releases while remaining compatible with older releases, preserving stored OAuth metadata (GitHub Copilot `refresh`, Codex `accountId`) and adding `getProviderAuth()` header-based Bearer extraction. Contributed by @tdslot in #18.
- **Codex quota window labels**: footer and dashboard labels now follow the server-provided window duration instead of assuming every primary window is 5h. Weekly-only responses now correctly show `7d` alongside their reset countdown. Contributed by @tdslot in #20.

## [0.3.1] - 2026-07-09

### Fixed
- **Direct Anthropic API key users**: quota monitoring no longer fails for users who registered a direct API key (`sk-ant-...`) via `pi /login` rather than an OAuth subscription token. The `/api/oauth/usage` endpoint requires OAuth credentials, so the fetch is now skipped for direct keys with a silent "not applicable" result — the footer shows nothing instead of a persistent "usage unavailable" warning, and the dashboard shows a dim note instead of a raw JSON error body. Fixes #14 (reported by @vkarasen).
- **Raw JSON error bodies**: HTTP error responses that return a JSON object (e.g. `{"error":{"message":"..."}}`) are now reduced to a clean, human-readable message across all providers, so the dashboard and notifications no longer leak raw JSON.
- **Non-interactive `/quotas` fallback**: when the TUI custom view is unavailable, the command now renders a readable per-provider summary instead of dumping raw JSON snapshots (which previously included raw HTTP error bodies).

## [0.3.0] - 2026-07-09

### Added
- **Z.ai (GLM Coding Plan) provider**: 5h/7d rolling token windows and a monthly web-search count window, with the `/zai:quotas` command and footer status. Contributed by @tdslot in #15.
- **OpenCode Go provider**: dashboard scraper for rolling 5h / weekly / monthly USD usage against Go tier limits, with the `/opencode-go:quotas` command and a token-status footer for `opencode-go*` models. Configured via `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` (env or config file). Contributed by @gretel (DO2THX) in #11.
- **Token usage tracking**: `/tokens` command with cross-session token/cost aggregation from JSONL session files. Contributed by @gretel (DO2THX) in #11.
- **Token usage status** footer extension and a per-feature toggle in `/quotas:settings`.
- ESLint linting is now part of the repo (`npm run lint` / `npm run lint:fix`), codifying the existing 2-space / double-quote / semicolon style as the enforced default.

### Fixed
- **Stale usage-status context**: the footer no longer repaints stale provider data after a session reload or a switch to a deferred Synthetic footer, using a generation token to cancel in-flight fetches and guarding status writes against stale-context errors. Fix contributed by @aserper in #13, with an independent approach by @Fadouse in #12 (superseded by #13 and credited here).
- Quota warning labels now use `PROVIDER_LABELS` instead of a hardcoded Anthropic label. Contributed by @gretel in #11.
- `formatTimeRemaining` now shows days when the remaining time is >= 24h (e.g. `649h30m` → `27d1h30m`). Contributed by @gretel in #11.

### Changed
- Lint conformance is now required before merge; PR #11 was converted from tab to 2-space indentation to match the repo style.

## [0.2.6] - 2026-05-14

### Added
- Quotas dashboard footer now shows the running `pi-quotas` package version.
- Dashboard render tests cover version display and pace-marker edge cases.

### Fixed
- Pace-aware quota windows now still switch to warning/high/critical colors at absolute 80%/90%/100% usage thresholds, preventing high-usage monthly quotas from staying green.
- Quotas dashboard progress bars no longer show stray accent-colored pace markers inside filled warning bars or on zero-usage bars.

## [0.2.5] - 2026-05-14

### Fixed
- Pi startup and turn handling no longer wait for footer quota refreshes or quota warning checks; remote quota requests now run in the background.
- GitHub Copilot quota checks now use Pi's stored GitHub OAuth token for the `/copilot_internal/user` endpoint, fixing `401 Bad credentials` failures with Pi 0.74 auth credentials. Reported by @6aKa in #8.

## [0.2.4] - 2026-05-06

### Added
- **Defer to Synthetic**: When pi-synthetic's usage footer is active, pi-quotas now hides its own Synthetic footer to avoid duplicate quota displays. This behavior is enabled by default and can be toggled via `/quotas:settings` → "Defer to Synthetic".

## [0.2.3] - 2026-05-06

### Changed
- Version bump only.

## [0.2.2] - 2026-05-06

### Fixed
- Anthropic subscription quota windows are hidden from the footer status line while remaining available in quota dashboards and warnings.
- README updated with Synthetic provider commands, quota windows, and credential setup.

## [0.2.1] - 2026-05-06

### Added
- Synthetic quota monitoring support, including the `/synthetic:quotas` command.
- Synthetic quota parsing for subscription requests, hourly search limits, free tool calls, weekly tokens, and rolling five-hour limits.
- Synthetic API quota fetching via the `SYNTHETIC_API_KEY` environment variable.

### Fixed
- Footer reset times now use minute precision across supported providers, matching quota warning output.
- Footer status no longer shows misleading reset tags for non-reset windows such as Codex spend cap and credit balances.
- Elapsed reset times render as `now` instead of `in now`.

## [0.2.0] - 2026-04-22

### Added
- OpenRouter quota monitoring support
- `/openrouter:quotas` command
- OpenRouter footer usage status for active OpenRouter sessions
- OpenRouter daily, weekly, and monthly USD usage tracking
- Optional OpenRouter monthly budget display when per-key spending limits are configured
- OpenRouter fetch and parser test coverage

### Improved
- Currency values now display with cents precision across the UI
- Tracking-only usage windows now show `$X.XX used` instead of confusing `$X.XX/$0.00`
- OpenRouter tracking labels are clearer: `Daily`, `Weekly`, `Monthly`
- OpenRouter period rollover times use UTC-based calculations
- README updated with OpenRouter commands, credentials, and provider details

### Fixed
- Footer status formatting for OpenRouter currency windows
- Clarity of OpenRouter tracking window presentation in the TUI
- Package lockfile version synced for the 0.2.0 release
