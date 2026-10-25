import { GENERATIONS } from "./catalog";

export const TYPE_ORDER = [
  "normal",
  "fire",
  "water",
  "electric",
  "grass",
  "ice",
  "fighting",
  "poison",
  "ground",
  "flying",
  "psychic",
  "bug",
  "rock",
  "ghost",
  "dragon",
  "dark",
  "steel",
  "fairy",
] as const;

export type PokemonType = (typeof TYPE_ORDER)[number];

export type Frame = "blue" | "red";

export type RosterCategory = {
  type: PokemonType;
  members: string[];
};

export type RosterDefinition = {
  frame: Frame;
  generations: number[];
  bias: Record<number, number>;
  categories: RosterCategory[];
  shuffleA: number;
  shuffleB: number;
};

const TYPE_SET = new Set<string>(TYPE_ORDER);

export function isPokemonType(value: string): value is PokemonType {
  return TYPE_SET.has(value);
}

export const TYPE_COLORS: Record<PokemonType, string> = {
  normal: "#f3d7a1",
  fire: "#f08060",
  water: "#6eb5e8",
  electric: "#f8d85a",
  grass: "#8ec96a",
  ice: "#8fd0e8",
  fighting: "#d4685a",
  poison: "#d7b0e8",
  ground: "#f0a04a",
  flying: "#8fd4ef",
  psychic: "#f0a0b8",
  bug: "#b7d36a",
  rock: "#c4a06a",
  ghost: "#8a78b0",
  dragon: "#8eb4e8",
  dark: "#8a7868",
  steel: "#c0c8d0",
  fairy: "#f0b0d0",
};

export function typeInk(type: PokemonType): string {
  if (type === "dark" || type === "ghost" || type === "fighting") {
    return "#fffaf2";
  }
  return "#1c1712";
}

/** Saturated chooser colors. Printed cards keep the softer TYPE_COLORS. */
export const TYPE_PICK_COLORS: Record<PokemonType, string> = {
  normal: "#e4d2a4",
  fire: "#f08030",
  water: "#2f6fbe",
  electric: "#f8d030",
  grass: "#4c9a38",
  ice: "#9ee7e4",
  fighting: "#d23a32",
  poison: "#a33aa3",
  ground: "#e0b85a",
  flying: "#6d56d0",
  psychic: "#ff7aa2",
  bug: "#c2d04a",
  rock: "#8c6a2f",
  ghost: "#6b548c",
  dragon: "#5b3fd6",
  dark: "#6b5346",
  steel: "#b8c0d0",
  fairy: "#f4b6c8",
};

function contrastAgainst(hex: string, ink: string): number {
  const luminance = (color: string) => {
    const channels = [1, 3, 5].map((start) => {
      const value = Number.parseInt(color.slice(start, start + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(luminance(hex), luminance(ink));
  const darker = Math.min(luminance(hex), luminance(ink));
  return (lighter + 0.05) / (darker + 0.05);
}

export function typePickInk(type: PokemonType): string {
  const hex = TYPE_PICK_COLORS[type];
  const dark = "#1c1712";
  const light = "#fffaf2";
  return contrastAgainst(hex, dark) >= contrastAgainst(hex, light) ? dark : light;
}

export function evenBias(generations: number[]): Record<number, number> {
  const gens = [...generations].sort((a, b) => a - b);
  const count = gens.length;
  if (count === 0) {
    return {};
  }
  const base = Math.floor(24 / count);
  let remainder = 24 - base * count;
  const bias: Record<number, number> = {};
  for (const generation of gens) {
    bias[generation] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) {
      remainder -= 1;
    }
  }
  return bias;
}

export function biasTotal(definition: RosterDefinition): number {
  return definition.generations.reduce((sum, generation) => sum + (definition.bias[generation] ?? 0), 0);
}

export function sameBias(a: Record<number, number>, b: Record<number, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[Number(key)] ?? 0) !== (b[Number(key)] ?? 0)) {
      return false;
    }
  }
  return true;
}

export function freshSeed(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] || 1;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = items.slice();
  const random = mulberry32(seed);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swap];
    copy[swap] = current;
  }
  return copy;
}

export function rosterMembers(definition: RosterDefinition): string[] {
  return definition.categories.flatMap((category) => category.members);
}

export function blankRoster(): RosterDefinition {
  return {
    frame: "blue",
    generations: [1, 2, 3],
    bias: evenBias([1, 2, 3]),
    categories: [
      { type: "normal", members: [] },
      { type: "flying", members: [] },
      { type: "poison", members: [] },
      { type: "ground", members: [] },
    ],
    shuffleA: freshSeed(),
    shuffleB: freshSeed(),
  };
}

export function fieldAndSky(): RosterDefinition {
  return {
    frame: "blue",
    generations: [1, 2, 3],
    bias: evenBias([1, 2, 3]),
    categories: [
      { type: "normal", members: ["Snorlax", "Tauros", "Ditto", "Porygon", "Kangaskhan", "Lickitung"] },
      { type: "flying", members: ["Pidgeot", "Fearow", "Dodrio", "Crobat", "Skarmory", "Swellow"] },
      { type: "poison", members: ["Arbok", "Muk", "Weezing", "Swalot", "Seviper", "Dustox"] },
      { type: "ground", members: ["Sandslash", "Dugtrio", "Marowak", "Donphan", "Camerupt", "Trapinch"] },
    ],
    shuffleA: 481516,
    shuffleB: 234208,
  };
}

export function stoneAndScale(): RosterDefinition {
  return {
    frame: "red",
    generations: [1, 2, 3],
    bias: evenBias([1, 2, 3]),
    categories: [
      { type: "rock", members: ["Golem", "Onix", "Sudowoodo", "Shuckle", "Nosepass", "Lunatone"] },
      { type: "bug", members: ["Scyther", "Pinsir", "Heracross", "Yanma", "Volbeat", "Illumise"] },
      { type: "ice", members: ["Dewgong", "Cloyster", "Jynx", "Lapras", "Sneasel", "Walrein"] },
      { type: "dragon", members: ["Dragonite", "Kingdra", "Flygon", "Altaria", "Salamence", "Latios"] },
    ],
    shuffleA: 662607,
    shuffleB: 891011,
  };
}

function readBias(value: unknown, generations: number[]): Record<number, number> {
  const bias: Record<number, number> = {};
  if (value && typeof value === "object") {
    for (const [key, weight] of Object.entries(value as Record<string, unknown>)) {
      const generation = Number(key);
      if (Number.isInteger(generation) && typeof weight === "number" && Number.isFinite(weight)) {
        bias[generation] = Math.max(0, Math.min(24, Math.round(weight)));
      }
    }
  }
  for (const generation of generations) {
    if (bias[generation] == null) {
      bias[generation] = 0;
    }
  }
  return bias;
}

export function parseDefinition(raw: string): RosterDefinition | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.frame !== "blue" && record.frame !== "red") {
    return null;
  }
  if (!Array.isArray(record.generations) || record.generations.length === 0) {
    return null;
  }
  const generations = [...new Set(record.generations.filter((item): item is number => Number.isInteger(item)))].sort(
    (a, b) => a - b,
  );
  if (generations.length === 0 || generations.some((generation) => !GENERATIONS.includes(generation))) {
    return null;
  }
  if (!Array.isArray(record.categories) || record.categories.length !== 4) {
    return null;
  }
  const categories: RosterCategory[] = [];
  const seenTypes = new Set<string>();
  const seenNames = new Set<string>();
  for (const category of record.categories) {
    if (!category || typeof category !== "object") {
      return null;
    }
    const typed = category as Record<string, unknown>;
    if (typeof typed.type !== "string" || !isPokemonType(typed.type) || seenTypes.has(typed.type)) {
      return null;
    }
    if (!Array.isArray(typed.members) || typed.members.length > 6) {
      return null;
    }
    const members: string[] = [];
    for (const member of typed.members) {
      if (typeof member !== "string" || member.length === 0 || seenNames.has(member)) {
        return null;
      }
      seenNames.add(member);
      members.push(member);
    }
    seenTypes.add(typed.type);
    categories.push({ type: typed.type, members });
  }
  if (typeof record.shuffleA !== "number" || typeof record.shuffleB !== "number") {
    return null;
  }
  return {
    frame: record.frame,
    generations,
    bias: readBias(record.bias, generations),
    categories,
    shuffleA: record.shuffleA >>> 0,
    shuffleB: record.shuffleB >>> 0,
  };
}
