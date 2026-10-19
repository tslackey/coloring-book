import { BY_NAME, CATALOG, isFinalForm, type Species, typeLabel } from "./catalog";
import { scoreRoster } from "./balance";
import {
  TYPE_ORDER,
  evenBias,
  mulberry32,
  shuffle,
  type Frame,
  type PokemonType,
  type RosterDefinition,
} from "./roster";

export type GenerateRequest = {
  generations: number[];
  bias: Record<number, number>;
  types: PokemonType[];
  frame: Frame;
  seed: number;
};

export function eligibleCount(type: PokemonType, generations: number[]): number {
  const allowed = new Set(generations);
  return CATALOG.filter((species) => allowed.has(species.generation) && species.types.includes(type)).length;
}

export function suggestTypes(generations: number[], seed: number): PokemonType[] {
  const ranked = TYPE_ORDER.map((type) => ({
    type,
    count: eligibleCount(type, generations),
    primary: CATALOG.filter(
      (species) =>
        generations.includes(species.generation) && species.types[0] === type && isFinalForm(species),
    ).length,
  }));
  const ready = ranked.filter((row) => row.count >= 6);
  const pool = ready.length >= 4 ? ready : ranked.filter((row) => row.count > 0);
  const ordered = shuffle(pool, seed).sort(
    (a, b) => b.primary - a.primary || b.count - a.count || a.type.localeCompare(b.type),
  );
  return ordered.slice(0, 4).map((row) => row.type);
}

export function leanBias(generations: number[], favored: number): Record<number, number> {
  const gens = [...generations].sort((a, b) => a - b);
  if (gens.length <= 1 || !gens.includes(favored)) {
    return evenBias(gens);
  }
  const rest = gens.filter((generation) => generation !== favored);
  const bias: Record<number, number> = { [favored]: 12 };
  const base = Math.floor(12 / rest.length);
  let remainder = 12 - base * rest.length;
  for (const generation of rest) {
    bias[generation] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) {
      remainder -= 1;
    }
  }
  return bias;
}

function generationQuotas(
  types: PokemonType[],
  generations: number[],
  bias: Record<number, number>,
): Record<string, Record<number, number>> {
  const assigned: Record<string, Record<number, number>> = {};
  const capacity: Record<string, Record<number, number>> = {};
  for (const type of types) {
    assigned[type] = {};
    capacity[type] = {};
    for (const generation of generations) {
      assigned[type][generation] = 0;
      capacity[type][generation] = CATALOG.filter(
        (species) => species.generation === generation && species.types.includes(type),
      ).length;
    }
  }
  const rowLeft = new Map(types.map((type) => [type, 6]));
  const colLeft = new Map(generations.map((generation) => [generation, bias[generation] ?? 0]));
  let guard = 0;
  while ([...rowLeft.values()].some((left) => left > 0) && guard < 200) {
    guard += 1;
    let placed = false;
    for (const type of types) {
      if ((rowLeft.get(type) ?? 0) <= 0) {
        continue;
      }
      const generation = generations
        .filter((item) => (colLeft.get(item) ?? 0) > 0 && assigned[type][item] < capacity[type][item])
        .sort((a, b) => (colLeft.get(b) ?? 0) - (colLeft.get(a) ?? 0) || a - b)[0];
      if (generation == null) {
        continue;
      }
      assigned[type][generation] += 1;
      rowLeft.set(type, (rowLeft.get(type) ?? 0) - 1);
      colLeft.set(generation, (colLeft.get(generation) ?? 0) - 1);
      placed = true;
    }
    if (!placed) {
      break;
    }
  }
  return assigned;
}

function pickSpecies(
  type: PokemonType,
  generation: number | null,
  count: number,
  generations: number[],
  used: Set<string>,
  usedFamilies: Set<number>,
  random: () => number,
): Species[] {
  if (count <= 0) {
    return [];
  }
  const allowed = new Set(generations);
  const pool = shuffle(
    CATALOG.filter(
      (species) =>
        !used.has(species.name) &&
        allowed.has(species.generation) &&
        species.types.includes(type) &&
        (generation == null || species.generation === generation),
    ),
    Math.floor(random() * 0x7fffffff) || 1,
  );
  pool.sort((a, b) => {
    const primary = Number(b.types[0] === type) - Number(a.types[0] === type);
    if (primary !== 0) {
      return primary;
    }
    const final = Number(isFinalForm(b)) - Number(isFinalForm(a));
    if (final !== 0) {
      return final;
    }
    const familyA = a.evolution != null && usedFamilies.has(a.evolution) ? 1 : 0;
    const familyB = b.evolution != null && usedFamilies.has(b.evolution) ? 1 : 0;
    return familyA - familyB;
  });
  const chosen = pool.slice(0, count);
  for (const species of chosen) {
    used.add(species.name);
    if (species.evolution != null) {
      usedFamilies.add(species.evolution);
    }
  }
  return chosen;
}

function buildOnce(request: GenerateRequest, seed: number): RosterDefinition {
  const generations = [...request.generations].sort((a, b) => a - b);
  const quotas = generationQuotas(request.types, generations, request.bias);
  const used = new Set<string>();
  const usedFamilies = new Set<number>();
  const random = mulberry32(seed);
  const categories = request.types.map((type) => {
    const members: string[] = [];
    for (const generation of generations) {
      const picked = pickSpecies(type, generation, quotas[type][generation] ?? 0, generations, used, usedFamilies, random);
      members.push(...picked.map((species) => species.name));
    }
    if (members.length < 6) {
      const extra = pickSpecies(type, null, 6 - members.length, generations, used, usedFamilies, random);
      members.push(...extra.map((species) => species.name));
    }
    return { type, members };
  });
  return {
    frame: request.frame,
    generations,
    bias: { ...request.bias },
    categories,
    shuffleA: (Math.imul(seed, 2) + 1) >>> 0 || 1,
    shuffleB: (Math.imul(seed, 2) + 97) >>> 0 || 2,
  };
}

function rosterScore(definition: RosterDefinition): number {
  const report = scoreRoster(definition);
  let score = report.filled * 1000;
  for (const row of report.generationCounts) {
    if (row.target != null) {
      score -= Math.abs(row.count - row.target) * 80;
    }
  }
  score -= report.families.length * 120;
  score -= report.outsideFilter.length * 200;
  score -= report.mismatched.length * 200;
  for (const question of report.questions) {
    if (question.quality === "great") {
      score += 12;
    } else if (question.quality === "okay") {
      score += 4;
    } else if (question.quality === "easy") {
      score -= 10;
    }
  }
  for (const category of definition.categories) {
    for (const name of category.members) {
      if (BY_NAME.get(name)?.types[0] === category.type) {
        score += 3;
      }
    }
  }
  return score;
}

export function generateRoster(request: GenerateRequest): RosterDefinition {
  const generations = [...request.generations].sort((a, b) => a - b);
  const bias = generations.length <= 1 ? evenBias(generations) : request.bias;
  const normalized: GenerateRequest = { ...request, generations, bias };
  let best = buildOnce(normalized, request.seed);
  let bestScore = rosterScore(best);
  for (let offset = 1; offset < 24; offset += 1) {
    const candidate = buildOnce(normalized, (request.seed + offset * 997) >>> 0 || 1);
    const score = rosterScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function generatedName(types: PokemonType[]): string {
  return types.map((type) => typeLabel(type)).join(" · ");
}
