import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  clearPendingMigrationNotice,
  emitUsageConfigUpdated,
  hasPendingMigrationNotice,
  configLoader,
  seedUsageConfigIfMissing,
} from "../../config.js";

const NOTICE_TYPE = "usage:migration-notice";
const NOTICE_TITLE = "pi-usage";
const NOTICE_CONTENT = [
  "Optional features available in `pi-usage`:",
  "- Combined usage command",
  "- Provider usage views (`/usage codex`, ...)",
  "- Usage footer status",
  "- Quota warnings",
  "",
  "Use `/usage settings` to enable or disable them.",
].join("\n");

function wrapInRoundedBorder(
  lines: string[],
  width: number,
  colorFn: (text: string) => string,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const hBar = "─".repeat(innerWidth);
  const top = colorFn(`╭${hBar}╮`);
  const bottom = colorFn(`╰${hBar}╯`);
  const left = colorFn("│");
  const right = colorFn("│");
  return [
    top,
    ...lines.map((line) => {
      const fill = Math.max(0, innerWidth - visibleWidth(line));
      return `${left}${line}${" ".repeat(fill)}${right}`;
    }),
    bottom,
  ];
}

function highlightInlineCode(text: string, colorFn: (text: string) => string): string {
  return text.replace(/`([^`]+)`/g, (_, code) => colorFn(code));
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  await seedUsageConfigIfMissing();

  pi.registerMessageRenderer(NOTICE_TYPE, (message, _options, theme) => {
    const rawContent = typeof message.content === "string" ? message.content : NOTICE_CONTENT;
    const accent = (t: string) => theme.fg("accent", t);
    const title = theme.bold(accent(NOTICE_TITLE));
    const body = highlightInlineCode(rawContent, accent);
    return {
      render(width: number) {
        const contentWidth = Math.max(1, width - 4);
        const bodyLines = wrapTextWithAnsi(body, contentWidth);
        return wrapInRoundedBorder([` ${title} `, " ", ...bodyLines.map((line) => ` ${line} `)], width, accent);
      },
      handleInput() {
        return false;
      },
      invalidate() {},
    };
  });

  pi.on("session_start", async () => {
    emitUsageConfigUpdated(pi);
    if (hasPendingMigrationNotice()) {
      clearPendingMigrationNotice();
      pi.sendMessage(
        { customType: NOTICE_TYPE, content: NOTICE_CONTENT, display: true },
        { triggerTurn: false },
      );
    }
  });
}
