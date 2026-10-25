import { printDocument } from "../pokemon";
import { BOARD_CSS, copySheetHtml, cropMarksHtml } from "./board";
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
      @page { size: letter landscape; margin: 0; }
      html, body { margin: 0; background: #fff; }
      ${BOARD_CSS}
      .gw-page {
        position: relative;
        width: 11in;
        height: 8.5in;
        box-sizing: border-box;
        padding: 0.5625in 0.6875in;
        break-after: page;
        page-break-after: always;
      }
      .gw-page:last-child { break-after: auto; page-break-after: auto; }
    </style>
  </head>
  <body>
    <section class="gw-page">${cropMarksHtml()}${copySheetHtml(definition, definition.shuffleA, art)}</section>
    <section class="gw-page">${cropMarksHtml()}${copySheetHtml(definition, definition.shuffleB, art)}</section>
  </body>
</html>`;
  return printDocument(html);
}
