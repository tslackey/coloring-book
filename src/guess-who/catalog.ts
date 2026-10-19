import raw from "./catalog.json";

export type Species = {
  id: number;
  name: string;
  types: string[];
  generation: number;
  evolution: number | null;
  evolvesFrom: number | null;
  shape: string;
};

/** Current official types from the latest games, not the types a species had when it debuted. */
export const CATALOG = raw as Species[];

export const BY_NAME = new Map(CATALOG.map((species) => [species.name, species]));

export const GENERATIONS = [...new Set(CATALOG.map((species) => species.generation))].sort(
  (a, b) => a - b,
);

const EVOLVED_INTO = new Set(
  CATALOG.map((species) => species.evolvesFrom).filter((id): id is number => id !== null),
);

export function isFinalForm(species: Species): boolean {
  return !EVOLVED_INTO.has(species.id);
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export function generationLabel(generation: number): string {
  const roman = ROMAN[generation];
  return roman ? `Generation ${roman}` : `Generation ${generation}`;
}

export function typeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
