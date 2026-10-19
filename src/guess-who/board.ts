import { pngUrl } from "../types";
import { typeLabel } from "./catalog";
import {
  FRAME_COLORS,
  TYPE_COLORS,
  rosterMembers,
  shuffle,
  type Frame,
  type PokemonType,
  type RosterDefinition,
  typeInk,
} from "./roster";

export type BoardSlot = {
  name: string;
  type: PokemonType;
  art: string | null;
};

export const BOARD_CSS = `
.gw-sheet, .gw-sheet * { box-sizing: border-box; }
.gw-sheet {
  width: 7.6in;
  height: 10.1in;
  background: var(--gw-frame);
  display: grid;
  grid-template-rows: 1.62in 0.62in minmax(0, 1fr);
  padding: 0.08in;
  overflow: hidden;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-cast, .gw-play {
  display: grid;
  gap: 0.045in;
  min-height: 0;
}
.gw-cast {
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
}
.gw-play {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-template-rows: repeat(4, minmax(0, 1fr));
}
.gw-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.16in;
  margin: 0.05in 0.02in;
  background: #fffaf2;
  border-radius: 0.08in;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-guess, .gw-poke { margin: 0; }
.gw-guess {
  font-family: "Arial Rounded MT Bold", "Trebuchet MS", "Avenir Next", sans-serif;
  font-weight: 800;
  font-style: italic;
  font-size: 22pt;
  line-height: 1;
  color: #e23b3b;
}
.gw-poke {
  font-family: "Arial Rounded MT Bold", "Trebuchet MS", "Avenir Next", sans-serif;
  font-weight: 900;
  font-size: 20pt;
  line-height: 1;
  letter-spacing: 0.04em;
  color: #ffcb05;
  -webkit-text-stroke: 1.5px #2a75bb;
  paint-order: stroke fill;
}
.gw-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 0.06in;
  padding: 0.02in 0.02in 0.025in;
  text-align: center;
  font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-card img, .gw-art-fallback {
  flex: 1 1 auto;
  width: auto;
  max-width: 100%;
  min-height: 0;
  object-fit: contain;
}
.gw-art-fallback { display: block; }
.gw-name, .gw-type {
  display: block;
  max-width: 100%;
  line-height: 1.05;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
}
.gw-name {
  font-weight: 800;
  font-size: 6.5pt;
}
.gw-type {
  font-size: 5.5pt;
  letter-spacing: 0.04em;
  opacity: 0.78;
}
.gw-mini { border-radius: 0.03in; padding: 0.01in; }
.gw-mini .gw-name { font-size: 3.7pt; }
.gw-mini .gw-type { font-size: 3.2pt; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function orderedSlots(definition: RosterDefinition, art: Record<string, string>): BoardSlot[] {
  const slots: BoardSlot[] = [];
  for (const category of definition.categories) {
    for (let index = 0; index < 6; index += 1) {
      const name = category.members[index] ?? "";
      slots.push({
        name,
        type: category.type,
        art: name ? (art[name] ?? null) : null,
      });
    }
  }
  return slots;
}

/** Different from the play-grid seed, so the secret-Pokémon strip is its own arrangement. */
export function secretSeed(playSeed: number): number {
  const mixed = Math.imul(playSeed ^ 0xa5a5a5a5, 0x9e3779b1) >>> 0;
  return mixed === (playSeed >>> 0) ? (mixed ^ 0x6d2b79f5) >>> 0 : mixed || 1;
}

export function secretSlots(definition: RosterDefinition, playSeed: number, art: Record<string, string>): BoardSlot[] {
  return shuffle(orderedSlots(definition, art), secretSeed(playSeed));
}

export function playSlots(definition: RosterDefinition, seed: number, art: Record<string, string>): BoardSlot[] {
  return shuffle(orderedSlots(definition, art), seed);
}

function cardHtml(slot: BoardSlot, mini: boolean): string {
  const fill = TYPE_COLORS[slot.type];
  const ink = typeInk(slot.type);
  const image = slot.art
    ? `<img src="${escapeHtml(pngUrl(slot.art))}" alt="" />`
    : `<span class="gw-art-fallback"></span>`;
  const caption = slot.name
    ? `<span class="gw-name">${escapeHtml(slot.name)}</span><span class="gw-type">${escapeHtml(typeLabel(slot.type))}</span>`
    : "";
  return `<div class="gw-card${mini ? " gw-mini" : ""}" style="background:${fill};color:${ink}">${image}${caption}</div>`;
}

export function sheetHtml(frame: Frame, cast: BoardSlot[], play: BoardSlot[]): string {
  return `<article class="gw-sheet" style="--gw-frame:${FRAME_COLORS[frame]}">
    <div class="gw-cast">${cast.map((slot) => cardHtml(slot, true)).join("")}</div>
    <div class="gw-title"><p class="gw-guess">Guess Who?</p><p class="gw-poke">Pokémon</p></div>
    <div class="gw-play">${play.map((slot) => cardHtml(slot, false)).join("")}</div>
  </article>`;
}

export function copySheetHtml(definition: RosterDefinition, playSeed: number, art: Record<string, string>): string {
  return sheetHtml(
    definition.frame,
    secretSlots(definition, playSeed, art),
    playSlots(definition, playSeed, art),
  );
}

export function rosterSheetsHtml(definition: RosterDefinition, art: Record<string, string>): string {
  return (
    copySheetHtml(definition, definition.shuffleA, art) + copySheetHtml(definition, definition.shuffleB, art)
  );
}

export function memberKey(definition: RosterDefinition): string {
  return rosterMembers(definition).join("|");
}
