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

export type StageShape = "circle" | "star" | "triangle" | "square" | "pentagon";

export type StageMark = {
  shape: StageShape;
  number: 1 | 2 | 3;
};

const STAGE_MARKS = new Map<string, StageMark>();

function chainStage(species: Species, byId: Map<number, Species>, seen: Set<number>): number {
  if (species.evolvesFrom == null || seen.has(species.id)) {
    return 1;
  }
  const parent = byId.get(species.evolvesFrom);
  if (!parent) {
    return 1;
  }
  seen.add(species.id);
  return chainStage(parent, byId, seen) + 1;
}

function buildStageMarks(): void {
  const byId = new Map(CATALOG.map((species) => [species.id, species]));
  const chains = new Map<number, Species[]>();
  for (const species of CATALOG) {
    if (species.evolution == null) {
      continue;
    }
    const members = chains.get(species.evolution) ?? [];
    members.push(species);
    chains.set(species.evolution, members);
  }
  for (const members of chains.values()) {
    const staged = members.map((species) => ({ species, stage: chainStage(species, byId, new Set()) }));
    const longest = Math.max(...staged.map((item) => item.stage));
    if (longest < 2) {
      continue;
    }
    const shapes: StageShape[] = longest === 2 ? ["circle", "star"] : ["triangle", "square", "pentagon"];
    for (const item of staged) {
      const index = Math.min(item.stage, shapes.length) - 1;
      STAGE_MARKS.set(item.species.name, { shape: shapes[index], number: (index + 1) as 1 | 2 | 3 });
    }
  }
}

buildStageMarks();

/** A basic-only line has no mark. Two-stage lines use a circle then a star. Three-stage lines use a triangle, square, and pentagon. */
export function stageMark(name: string): StageMark | null {
  return STAGE_MARKS.get(name) ?? null;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export function generationLabel(generation: number): string {
  const roman = ROMAN[generation];
  return roman ? `Generation ${roman}` : `Generation ${generation}`;
}

export function typeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
