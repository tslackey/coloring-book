import { printDocument } from "../pokemon";
import { BOARD_CSS, rosterSheetsHtml } from "./board";
import type { RosterDefinition } from "./roster";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function printRoster(name: string, definition: RosterDefinition, art: Record<string, string>): Promise<void> {
  const title = escapeHtml(`${name} Guess Who`);
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      @page { size: letter portrait; margin: 0.45in; }
      html, body { margin: 0; background: #fff; }
      ${BOARD_CSS}
      .gw-sheet { break-after: page; page-break-after: always; }
      .gw-sheet:last-child { break-after: auto; page-break-after: auto; }
    </style>
  </head>
  <body>
    ${rosterSheetsHtml(definition, art)}
  </body>
</html>`;
  return printDocument(html);
}
