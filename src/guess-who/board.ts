import { pngUrl } from "../types";
import { BY_NAME, stageMark, typeLabel, type StageMark } from "./catalog";
import {
  TYPE_COLORS,
  TYPE_PICK_COLORS,
  isPokemonType,
  rosterMembers,
  shuffle,
  type PokemonType,
  type RosterDefinition,
  typePickInk,
} from "./roster";

export type BoardSlot = {
  name: string;
  type: PokemonType;
  art: string | null;
};

/** Physical board: 9 5/8 in by 7 3/8 in. Centered on landscape letter (11 × 8.5). */
export const BOARD_WIDTH_IN = 9.625;
export const BOARD_HEIGHT_IN = 7.375;
export const LETTER_WIDTH_IN = 11;
export const LETTER_HEIGHT_IN = 8.5;

const TYPE_FOOTER: Record<PokemonType, string> = {
  normal: "#a8844e",
  fire: "#c4452d",
  water: "#2a6a9c",
  electric: "#b89216",
  grass: "#3a8632",
  ice: "#3a86a4",
  fighting: "#9a3830",
  poison: "#8654a0",
  ground: "#b87224",
  flying: "#3a86a6",
  psychic: "#b85472",
  bug: "#688628",
  rock: "#846838",
  ghost: "#564880",
  dragon: "#3a68a4",
  dark: "#564838",
  steel: "#66707c",
  fairy: "#b85486",
};

export const BOARD_CSS = `
.gw-sheet, .gw-sheet * { box-sizing: border-box; }
.gw-sheet {
  width: 9.625in;
  height: 7.375in;
  background: #fff;
  display: grid;
  grid-template-rows: 0.86in 0.72in 0.86in minmax(0, 1fr);
  padding: 0.10in 0.04in 0.10in;
  overflow: hidden;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-cast, .gw-play {
  display: grid;
  min-height: 0;
  min-width: 0;
}
.gw-cast {
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 0.045in;
}
.gw-play {
  margin-top: 0.40in;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(0, 1fr));
  gap: 0.28in 0.19in;
}
.gw-title {
  display: flex;
  align-items: center;
  justify-content: space-around;
  margin: 0;
  background: transparent;
}
.gw-guess, .gw-poke { margin: 0; }
.gw-guess {
  font-family: "Arial Rounded MT Bold", "Trebuchet MS", "Avenir Next", sans-serif;
  font-weight: 800;
  font-style: italic;
  font-size: 26pt;
  line-height: 1;
  color: #e23b3b;
  -webkit-text-stroke: 1.6px #fffaf2;
  paint-order: stroke fill;
}
.gw-poke {
  font-family: "Arial Rounded MT Bold", "Trebuchet MS", "Avenir Next", sans-serif;
  font-weight: 900;
  font-size: 24pt;
  line-height: 1;
  letter-spacing: 0.04em;
  color: #ffcb05;
  -webkit-text-stroke: 1.6px #2a75bb;
  paint-order: stroke fill;
}
.gw-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-end;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  text-align: center;
  font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-fill {
  position: absolute;
  inset: 0;
  z-index: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-fill > span {
  position: absolute;
  inset: 0;
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-stage-mark {
  position: absolute;
  z-index: 2;
  top: 0.035in;
  left: 0.03in;
  width: 0.34in;
  height: 0.34in;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.gw-stage-mark svg {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
}
.gw-stage-mark b {
  grid-area: 1 / 1;
  color: #fffaf2;
  font-weight: 800;
  font-size: 0.15in;
  line-height: 1;
  font-style: normal;
  text-shadow: 0 0 0.012in #1c1712;
}
.gw-stage-triangle b { transform: translateY(22%); }
.gw-stage-star b { font-size: 0.12in; transform: translateY(-6%); }
.gw-stage-pentagon b { transform: translateY(8%); }
.gw-mini .gw-stage-mark {
  top: 0.02in;
  left: 0.016in;
  width: 0.22in;
  height: 0.22in;
}
.gw-mini .gw-stage-mark b { font-size: 0.095in; }
.gw-mini .gw-stage-star b { font-size: 0.078in; }
.gw-mini {
  border-radius: 0.16in 0.16in 0.13in 0.13in;
}
.gw-play .gw-card {
  /* Folder window: flat top, notch dropping over the right quarter. */
  clip-path: polygon(
    1.5% 2.5%,
    4% 0%,
    71% 0%,
    76% 2.5%,
    80% 8%,
    85% 14.5%,
    90% 19%,
    95% 22%,
    100% 23.5%,
    100% 97%,
    97% 100%,
    3% 100%,
    0% 97%,
    0% 5%
  );
}
.gw-card img, .gw-art-fallback, .gw-foot {
  position: relative;
  z-index: 1;
}
.gw-card img, .gw-art-fallback {
  flex: 1 1 auto;
  width: auto;
  max-width: 92%;
  min-height: 0;
  margin: 0 auto;
  object-fit: contain;
}
.gw-art-fallback { display: block; }
.gw-foot {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.012in;
  width: 100%;
  padding: 0.03in 0.03in 0.04in;
  background: var(--gw-foot);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-mini .gw-foot { padding: 0.02in 0.015in 0.028in; gap: 0.008in; }
.gw-types {
  display: flex;
  flex-wrap: nowrap;
  justify-content: center;
  gap: 0.012in;
  max-width: 100%;
  min-width: 0;
}
.gw-name, .gw-type {
  max-width: 100%;
  line-height: 1;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
}
.gw-name {
  color: #fffaf2;
  font-weight: 800;
  font-size: 9pt;
  letter-spacing: 0.02em;
}
.gw-type {
  display: inline-block;
  padding: 0.014in 0.05in 0.016in;
  border-radius: 999px;
  background: #fffef8;
  color: #1c1712;
  font-weight: 800;
  font-size: 6.5pt;
  letter-spacing: 0.03em;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.gw-mini .gw-name { font-size: 6.5pt; letter-spacing: 0.01em; }
.gw-mini .gw-type { font-size: 4.6pt; padding: 0.006in 0.02in 0.008in; }
.gw-page { position: relative; overflow: visible; }
.gw-crops {
  position: absolute;
  left: 0;
  top: 0;
  width: 11in;
  height: 8.5in;
  pointer-events: none;
  overflow: visible;
}
.gw-crops rect {
  fill: #111;
}
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

/** Corner ticks in the letter margin, drawn as real lines so they survive printing. */
export function cropMarksHtml(): string {
  const gap = 0.05;
  const safe = 0.3;
  const board = { left: 0.6875, top: 0.5625, right: 10.3125, bottom: 7.9375 };
  const lines: number[][] = [
    [safe, board.top, board.left - gap, board.top],
    [board.left, safe, board.left, board.top - gap],
    [board.right + gap, board.top, 11 - safe, board.top],
    [board.right, safe, board.right, board.top - gap],
    [safe, board.bottom, board.left - gap, board.bottom],
    [board.left, board.bottom + gap, board.left, 8.5 - safe],
    [board.right + gap, board.bottom, 11 - safe, board.bottom],
    [board.right, board.bottom + gap, board.right, 8.5 - safe],
  ];
  const thickness = 0.028;
  const marks = lines
    .map(([x1, y1, x2, y2]) => {
      const horizontal = Math.abs(y1 - y2) < 0.001;
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2) - (horizontal ? thickness / 2 : 0);
      const width = horizontal ? Math.abs(x2 - x1) : thickness;
      const height = horizontal ? thickness : Math.abs(y2 - y1);
      const left = horizontal ? x : x - thickness / 2;
      return `<rect x="${left.toFixed(4)}" y="${y.toFixed(4)}" width="${width.toFixed(4)}" height="${height.toFixed(4)}" fill="#111"/>`;
    })
    .join("");
  return `<svg class="gw-crops" viewBox="0 0 11 8.5" aria-hidden="true">${marks}</svg>`;
}

function speciesTypes(name: string, fallback: PokemonType): PokemonType[] {
  const listed = BY_NAME.get(name)?.types.filter(isPokemonType) ?? [];
  return listed.length > 0 ? listed.slice(0, 2) : [fallback];
}

function stageSvg(mark: StageMark): string {
  const shapes: Record<StageMark["shape"], string> = {
    circle: `<circle cx="12" cy="12" r="10.5"/>`,
    star: `<polygon points="12,1.2 14.8,8.2 22.3,8.6 16.5,13.6 18.6,21.2 12,17.1 5.4,21.2 7.5,13.6 1.7,8.6 9.2,8.2"/>`,
    triangle: `<polygon points="12,1.4 22.6,22 1.4,22"/>`,
    square: `<rect x="1.6" y="1.6" width="20.8" height="20.8" rx="1.2"/>`,
    pentagon: `<polygon points="12,1.2 22.6,8.8 18.5,22 5.5,22 1.4,8.8"/>`,
  };
  return `<span class="gw-stage-mark gw-stage-${mark.shape}" aria-label="Stage ${mark.number}"><svg viewBox="0 0 24 24" aria-hidden="true"><g fill="#1c1712">${shapes[mark.shape]}</g></svg><b>${mark.number}</b></span>`;
}

function cardHtml(slot: BoardSlot, mini: boolean): string {
  const types = slot.name ? speciesTypes(slot.name, slot.type) : [slot.type];
  const footer = TYPE_FOOTER[slot.type];
  const second = types[1];
  const fill = `<div class="gw-fill" style="background:${TYPE_COLORS[types[0]]}">${
    second ? `<span style="background:${TYPE_COLORS[second]}"></span>` : ""
  }</div>`;
  const mark = slot.name ? stageMark(slot.name) : null;
  const image = slot.art
    ? `<img src="${escapeHtml(pngUrl(slot.art))}" alt="" />`
    : `<span class="gw-art-fallback"></span>`;
  const pills = types
    .map(
      (type) =>
        `<span class="gw-type" style="background:${TYPE_PICK_COLORS[type]};color:${typePickInk(type)}">${escapeHtml(typeLabel(type))}</span>`,
    )
    .join("");
  const caption = slot.name ? `<span class="gw-name">${escapeHtml(slot.name)}</span><span class="gw-types">${pills}</span>` : "";
  const pickable = slot.name
    ? ` class="gw-card gw-pick${mini ? " gw-mini" : ""}" data-name="${escapeHtml(slot.name)}" title="Choose a different picture"`
    : ` class="gw-card${mini ? " gw-mini" : ""}"`;
  return `<div${pickable} style="--gw-foot:${footer}">${fill}${mark ? stageSvg(mark) : ""}${image}<div class="gw-foot">${caption}</div></div>`;
}

export function sheetHtml(cast: BoardSlot[], play: BoardSlot[]): string {
  const top = cast.slice(0, 12);
  const middle = cast.slice(12, 24);
  return `<article class="gw-sheet">
    <div class="gw-cast">${top.map((slot) => cardHtml(slot, true)).join("")}</div>
    <div class="gw-title"><p class="gw-guess">Guess Who?</p><p class="gw-poke">Pokémon</p></div>
    <div class="gw-cast">${middle.map((slot) => cardHtml(slot, true)).join("")}</div>
    <div class="gw-play">${play.map((slot) => cardHtml(slot, false)).join("")}</div>
  </article>`;
}

export function copySheetHtml(definition: RosterDefinition, playSeed: number, art: Record<string, string>): string {
  return sheetHtml(secretSlots(definition, playSeed, art), playSlots(definition, playSeed, art));
}

export function rosterSheetsHtml(definition: RosterDefinition, art: Record<string, string>): string {
  return (
    copySheetHtml(definition, definition.shuffleA, art) + copySheetHtml(definition, definition.shuffleB, art)
  );
}

export function memberKey(definition: RosterDefinition): string {
  return rosterMembers(definition).join("|");
}
