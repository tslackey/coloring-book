import { BY_NAME, CATALOG, generationLabel, isFinalForm, type Species, typeLabel } from "./catalog";
import { biasTotal, type PokemonType, type RosterDefinition } from "./roster";

export type SplitQuality = "great" | "okay" | "lopsided" | "easy";

export type Question = {
  id: string;
  prompt: string;
  yes: number;
  no: number;
  imbalance: number;
  quality: SplitQuality;
};

export type GenerationCount = {
  generation: number;
  count: number;
  target: number | null;
};

export type FamilyClash = {
  names: string[];
};

export type SwapSuggestion = {
  remove: string | null;
  add: string;
  type: PokemonType;
  text: string;
};

export type BalanceReport = {
  filled: number;
  questions: Question[];
  best: Question[];
  summary: string;
  generationCounts: GenerationCount[];
  biasReady: boolean;
  outsideFilter: string[];
  mismatched: { name: string; category: PokemonType; types: string[] }[];
  families: FamilyClash[];
  swaps: SwapSuggestion[];
};

const SHAPE_QUESTIONS: Record<string, string> = {
  ball: "Is it round?",
  squiggle: "Is it long and serpentine?",
  fish: "Does it look like a fish?",
  arms: "Does it have arms and no legs?",
  blob: "Is it a blob?",
  upright: "Does it stand upright?",
  legs: "Does it have many legs?",
  quadruped: "Does it walk on four legs?",
  wings: "Does it have feathered wings?",
  tentacles: "Does it have tentacles?",
  heads: "Is it mostly a head?",
  humanoid: "Does it look humanoid?",
  "bug-wings": "Does it have insect wings?",
  armor: "Does it look armored?",
};

type Placed = {
  name: string;
  category: PokemonType;
  species: Species;
};

function qualityFor(yes: number, total: number): { imbalance: number; quality: SplitQuality } {
  const imbalance = Math.abs(yes - (total - yes));
  if (yes === 1) {
    return { imbalance, quality: "easy" };
  }
  if (imbalance <= 2) {
    return { imbalance, quality: "great" };
  }
  if (imbalance <= 6) {
    return { imbalance, quality: "okay" };
  }
  return { imbalance, quality: "lopsided" };
}

function pushQuestion(questions: Question[], id: string, prompt: string, yes: number, total: number) {
  if (yes <= 0 || yes >= total) {
    return;
  }
  const no = total - yes;
  const scored = qualityFor(yes, total);
  questions.push({ id, prompt, yes, no, imbalance: scored.imbalance, quality: scored.quality });
}

function suggestSwaps(definition: RosterDefinition, placed: Placed[]): SwapSuggestion[] {
  const taken = new Set(placed.map((pokemon) => pokemon.name));
  const checked = new Set(definition.generations);
  const counts = new Map<number, number>();
  for (const generation of definition.generations) {
    counts.set(generation, 0);
  }
  for (const pokemon of placed) {
    if (checked.has(pokemon.species.generation)) {
      counts.set(pokemon.species.generation, (counts.get(pokemon.species.generation) ?? 0) + 1);
    }
  }
  const short = definition.generations
    .map((generation) => ({
      generation,
      deficit: (definition.bias[generation] ?? 0) - (counts.get(generation) ?? 0),
    }))
    .filter((entry) => entry.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit || a.generation - b.generation);
  const long = new Set(
    definition.generations.filter(
      (generation) => (counts.get(generation) ?? 0) > (definition.bias[generation] ?? 0),
    ),
  );
  const usedAdd = new Set<string>();
  const usedRemove = new Set<string>();
  const pendingAdds = new Map<PokemonType, number>();
  const suggestions: SwapSuggestion[] = [];

  const candidatesFor = (generation: number, type: PokemonType) =>
    CATALOG.filter(
      (species) =>
        species.generation === generation &&
        species.types.includes(type) &&
        checked.has(species.generation) &&
        !taken.has(species.name) &&
        !usedAdd.has(species.name),
    ).sort(
      (a, b) =>
        Number(b.types[0] === type) - Number(a.types[0] === type) ||
        Number(isFinalForm(b)) - Number(isFinalForm(a)) ||
        a.id - b.id,
    );

  for (const entry of short) {
    if (suggestions.length >= 3) {
      break;
    }
    for (const category of definition.categories) {
      if (suggestions.length >= 3) {
        break;
      }
      const candidate = candidatesFor(entry.generation, category.type)[0];
      if (!candidate) {
        continue;
      }
      const reserved = pendingAdds.get(category.type) ?? 0;
      const openSlots = 6 - category.members.length - reserved;
      const donor = placed
        .filter(
          (pokemon) =>
            pokemon.category === category.type &&
            long.has(pokemon.species.generation) &&
            !usedRemove.has(pokemon.name),
        )
        .sort((a, b) => {
          const overA = (counts.get(a.species.generation) ?? 0) - (definition.bias[a.species.generation] ?? 0);
          const overB = (counts.get(b.species.generation) ?? 0) - (definition.bias[b.species.generation] ?? 0);
          return overB - overA || a.species.id - b.species.id;
        })[0];
      const count = counts.get(entry.generation) ?? 0;
      const target = definition.bias[entry.generation] ?? 0;
      const label = generationLabel(entry.generation);
      if (openSlots > 0) {
        suggestions.push({
          remove: null,
          add: candidate.name,
          type: category.type,
          text: `${label} is ${count}, target ${target}; ${candidate.name} is a free ${typeLabel(category.type)} from that generation.`,
        });
        usedAdd.add(candidate.name);
        pendingAdds.set(category.type, reserved + 1);
      } else if (donor) {
        suggestions.push({
          remove: donor.name,
          add: candidate.name,
          type: category.type,
          text: `${label} is ${count}, target ${target}; swap ${donor.name} for ${candidate.name}.`,
        });
        usedAdd.add(candidate.name);
        usedRemove.add(donor.name);
      }
    }
  }
  return suggestions;
}

export function scoreRoster(definition: RosterDefinition): BalanceReport {
  const placed: Placed[] = [];
  const mismatched: BalanceReport["mismatched"] = [];
  for (const category of definition.categories) {
    for (const name of category.members) {
      const species = BY_NAME.get(name);
      if (!species) {
        continue;
      }
      placed.push({ name, category: category.type, species });
      if (!species.types.includes(category.type)) {
        mismatched.push({ name, category: category.type, types: species.types });
      }
    }
  }

  const total = placed.length;
  const checked = new Set(definition.generations);
  const outsideFilter = placed
    .filter((pokemon) => !checked.has(pokemon.species.generation))
    .map((pokemon) => pokemon.name);

  const questions: Question[] = [];
  if (total > 0) {
    const typeCounts = new Map<string, number>();
    const generationCounts = new Map<number, number>();
    const shapeCounts = new Map<string, number>();
    for (const pokemon of placed) {
      for (const type of pokemon.species.types) {
        typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      }
      generationCounts.set(
        pokemon.species.generation,
        (generationCounts.get(pokemon.species.generation) ?? 0) + 1,
      );
      shapeCounts.set(pokemon.species.shape, (shapeCounts.get(pokemon.species.shape) ?? 0) + 1);
    }
    for (const [type, yes] of typeCounts) {
      pushQuestion(questions, `type:${type}`, `Is it a ${typeLabel(type)} type?`, yes, total);
    }
    for (const [generation, yes] of generationCounts) {
      pushQuestion(questions, `gen:${generation}`, `Is it from ${generationLabel(generation)}?`, yes, total);
    }
    for (const [shape, yes] of shapeCounts) {
      pushQuestion(
        questions,
        `shape:${shape}`,
        SHAPE_QUESTIONS[shape] ?? `Is its shape ${shape}?`,
        yes,
        total,
      );
    }
  }

  questions.sort((a, b) => a.imbalance - b.imbalance || a.prompt.localeCompare(b.prompt));
  const useful = questions.filter((question) => question.yes !== 1);
  const best = (useful.length > 0 ? useful : questions).slice(0, 3);

  const useTargets = definition.generations.length > 1;
  const biasReady = useTargets && biasTotal(definition) === 24;
  const generationRows: GenerationCount[] = definition.generations.map((generation) => ({
    generation,
    count: placed.filter((pokemon) => pokemon.species.generation === generation).length,
    target: useTargets ? (definition.bias[generation] ?? 0) : null,
  }));
  const extra = [...new Set(placed.map((pokemon) => pokemon.species.generation))]
    .filter((generation) => !checked.has(generation))
    .sort((a, b) => a - b);
  for (const generation of extra) {
    generationRows.push({
      generation,
      count: placed.filter((pokemon) => pokemon.species.generation === generation).length,
      target: null,
    });
  }

  const families = new Map<number, string[]>();
  for (const pokemon of placed) {
    if (pokemon.species.evolution == null) {
      continue;
    }
    const names = families.get(pokemon.species.evolution) ?? [];
    names.push(pokemon.name);
    families.set(pokemon.species.evolution, names);
  }

  let summary = "Add Pokémon to see which questions this roster supports.";
  if (best[0]) {
    const opener = best[0];
    summary =
      opener.quality === "great"
        ? `Best opener: “${opener.prompt}” splits ${opener.yes} yes / ${opener.no} no.`
        : `No question splits the cast evenly. The closest is “${opener.prompt}” at ${opener.yes} yes / ${opener.no} no.`;
  }

  return {
    filled: total,
    questions,
    best,
    summary,
    generationCounts: generationRows,
    biasReady,
    outsideFilter,
    mismatched,
    families: [...families.values()]
      .filter((names) => names.length > 1)
      .map((names) => ({ names })),
    swaps: biasReady ? suggestSwaps(definition, placed) : [],
  };
}

export function qualityLabel(quality: SplitQuality): string {
  if (quality === "great") {
    return "Great";
  }
  if (quality === "okay") {
    return "Okay";
  }
  if (quality === "easy") {
    return "Too easy";
  }
  return "Lopsided";
}
