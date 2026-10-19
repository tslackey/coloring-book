import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { suggestPokemon } from "../pokemon";
import { qualityLabel, scoreRoster, type SwapSuggestion } from "./balance";
import GenerateWizard from "./GenerateWizard";
import { BOARD_CSS, copySheetHtml, memberKey } from "./board";
import { BY_NAME, GENERATIONS, generationLabel, typeLabel } from "./catalog";
import { printRoster } from "./print";
import {
  TYPE_COLORS,
  TYPE_ORDER,
  biasTotal,
  blankRoster,
  evenBias,
  fieldAndSky,
  freshSeed,
  parseDefinition,
  rosterMembers,
  sameBias,
  stoneAndScale,
  type Frame,
  type PokemonType,
  type RosterDefinition,
  typeInk,
} from "./roster";

type ArtResult = {
  name: string;
  png_base64: string | null;
  error: string | null;
};

type SavedRow = {
  id: number;
  name: string;
  definition: string;
  created_at: string;
  updated_at: string;
};

type Entry = {
  key: string;
  id: number | null;
  builtin: boolean;
  name: string;
  definition: RosterDefinition;
};

const BUILTIN_ENTRIES: Entry[] = [
  { key: "builtin:field-sky", id: null, builtin: true, name: "Field & Sky", definition: fieldAndSky() },
  { key: "builtin:stone-scale", id: null, builtin: true, name: "Stone & Scale", definition: stoneAndScale() },
];

function entryFromRow(row: SavedRow): Entry | null {
  const definition = parseDefinition(row.definition);
  if (!definition) {
    return null;
  }
  return {
    key: `saved:${row.id}`,
    id: row.id,
    builtin: false,
    name: row.name,
    definition,
  };
}

function slotChoices(
  query: string,
  type: PokemonType,
  generations: number[],
  taken: Set<string>,
): { options: string[]; note: string | null } {
  const matches = suggestPokemon(query, 16);
  const allowed = new Set(generations);
  const options = matches
    .filter((name) => {
      const species = BY_NAME.get(name);
      return (
        species !== undefined &&
        allowed.has(species.generation) &&
        species.types.includes(type) &&
        !taken.has(name)
      );
    })
    .slice(0, 8);
  if (options.length > 0 || query.trim().length === 0) {
    return { options, note: null };
  }
  const species = matches[0] ? BY_NAME.get(matches[0]) : undefined;
  if (!species) {
    return { options, note: "No Pokémon matches that search." };
  }
  if (taken.has(species.name)) {
    return { options, note: `${species.name} is already on this roster.` };
  }
  const current = species.types.map(typeLabel).join(" / ");
  if (!species.types.includes(type)) {
    return { options, note: `${species.name}'s current type is ${current}.` };
  }
  if (!allowed.has(species.generation)) {
    return {
      options,
      note: `${species.name} debuted in ${generationLabel(species.generation)}, which is not checked. Its current type is still ${current}.`,
    };
  }
  return { options, note: null };
}

function SlotSearch({
  type,
  generations,
  taken,
  onPick,
}: {
  type: PokemonType;
  generations: number[];
  taken: Set<string>;
  onPick: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const { options, note } = slotChoices(query, type, generations, taken);
  return (
    <div className="gw-slot-search">
      <input
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={`Add a ${typeLabel(type)}`}
        aria-label={`Add a ${typeLabel(type)} Pokémon`}
      />
      {options.length > 0 && (
        <ul>
          {options.map((name) => {
            const species = BY_NAME.get(name);
            return (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(name);
                    setQuery("");
                  }}
                >
                  <strong>{name}</strong>
                  <small>
                    {species ? `${generationLabel(species.generation)} · ${species.types.map(typeLabel).join(" / ")}` : ""}
                  </small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p>{note}</p>}
    </div>
  );
}

function ScaledSheet({ html }: { html: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.45);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) {
      return;
    }
    const update = () => {
      const natural = 7.6 * 96;
      setScale(Math.min(1, element.clientWidth / natural));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="gw-preview" ref={wrapRef}>
      <div className="gw-preview-clip" style={{ height: `${10.1 * scale}in` }}>
        <div
          className="gw-preview-sheet"
          style={{ transform: `scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

export default function GuessWho() {
  const [entries, setEntries] = useState<Entry[]>(BUILTIN_ENTRIES);
  const [selectedKey, setSelectedKey] = useState(BUILTIN_ENTRIES[0].key);
  const [query, setQuery] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [copy, setCopy] = useState<"a" | "b">("a");
  const [art, setArt] = useState<Record<string, string>>({});
  const [failedArt, setFailedArt] = useState<Record<string, string>>({});
  const [artNote, setArtNote] = useState<string | null>(null);
  const [desktopArt, setDesktopArt] = useState(true);
  const [artRetry, setArtRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const artRef = useRef(art);
  const failedRef = useRef(failedArt);
  artRef.current = art;
  failedRef.current = failedArt;

  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0];

  const refreshSaved = useCallback(async () => {
    try {
      const rows = await invoke<SavedRow[]>("list_rosters");
      setEntries((current) => {
        const builtins = current.filter((entry) => entry.builtin);
        const drafts = current.filter((entry) => !entry.builtin && entry.id === null);
        const saved = rows.map(entryFromRow).filter((entry): entry is Entry => entry !== null);
        return [...builtins, ...saved, ...drafts];
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("invoke") || message.includes("undefined")) {
        return;
      }
      setError(message);
    }
  }, []);

  useEffect(() => {
    refreshSaved().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshSaved]);

  const namesKey = memberKey(selected.definition);
  useEffect(() => {
    if (!desktopArt) {
      return;
    }
    const names = namesKey.split("|").filter((name) => name.length > 0);
    const missing = names.filter((name) => !artRef.current[name] && !failedRef.current[name]);
    if (missing.length === 0) {
      return;
    }
    let cancel = false;
    setArtNote(
      missing.length === 1 ? "Loading 1 image from Bulbapedia…" : `Loading ${missing.length} images from Bulbapedia…`,
    );
    invoke<ArtResult[]>("cache_roster_art", { names: missing })
      .then((rows) => {
        if (cancel) {
          return;
        }
        setArt((current) => {
          const next = { ...current };
          for (const row of rows) {
            if (row.png_base64) {
              next[row.name] = row.png_base64;
            }
          }
          return next;
        });
        setFailedArt((current) => {
          const next = { ...current };
          for (const row of rows) {
            if (row.error) {
              next[row.name] = row.error;
            }
          }
          return next;
        });
        setArtNote(null);
      })
      .catch((err: unknown) => {
        if (cancel) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setArtNote(null);
        if (message.includes("invoke") || message.includes("undefined")) {
          setDesktopArt(false);
          return;
        }
        setError(message);
      });
    return () => {
      cancel = true;
    };
  }, [artRetry, desktopArt, namesKey]);

  const updateSelected = useCallback(
    (recipe: (entry: Entry) => Entry) => {
      setEntries((current) => current.map((entry) => (entry.key === selectedKey ? recipe(entry) : entry)));
    },
    [selectedKey],
  );

  const patchDefinition = useCallback(
    (definition: RosterDefinition) => {
      updateSelected((entry) => ({ ...entry, definition }));
    },
    [updateSelected],
  );

  const report = useMemo(() => scoreRoster(selected.definition), [selected.definition]);
  const taken = useMemo(() => new Set(rosterMembers(selected.definition)), [selected.definition]);
  const readOnly = selected.builtin;
  const previewHtml = useMemo(() => {
    const seed = copy === "a" ? selected.definition.shuffleA : selected.definition.shuffleB;
    return copySheetHtml(selected.definition, seed, art);
  }, [art, copy, selected.definition]);

  const visible = entries.filter((entry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    if (entry.name.toLowerCase().includes(needle)) {
      return true;
    }
    return rosterMembers(entry.definition).some((name) => name.toLowerCase().includes(needle));
  });

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const saveSelected = useCallback(async () => {
    if (selected.builtin) {
      return;
    }
    const name = selected.name.trim();
    if (!name) {
      setError("Name the roster before saving.");
      return;
    }
    await run("Saving roster…", async () => {
      const id = await invoke<number>("save_roster", {
        id: selected.id,
        name,
        definition: JSON.stringify(selected.definition),
      });
      setEntries((current) =>
        current.map((entry) =>
          entry.key === selected.key ? { ...entry, id, key: `saved:${id}`, name } : entry,
        ),
      );
      setSelectedKey(`saved:${id}`);
    });
  }, [run, selected]);

  const removeSelected = useCallback(async () => {
    if (selected.builtin) {
      return;
    }
    if (selected.id === null) {
      setEntries((current) => current.filter((entry) => entry.key !== selected.key));
      setSelectedKey(BUILTIN_ENTRIES[0].key);
      return;
    }
    await run("Deleting roster…", async () => {
      await invoke("delete_roster", { id: selected.id });
      setEntries((current) => current.filter((entry) => entry.key !== selected.key));
      setSelectedKey(BUILTIN_ENTRIES[0].key);
    });
  }, [run, selected]);

  const duplicateSelected = useCallback(async () => {
    const definition: RosterDefinition = {
      ...selected.definition,
      categories: selected.definition.categories.map((category) => ({
        ...category,
        members: category.members.slice(),
      })),
      bias: { ...selected.definition.bias },
      generations: selected.definition.generations.slice(),
      shuffleA: freshSeed(),
      shuffleB: freshSeed(),
    };
    const name = `${selected.name} copy`;
    await run("Saving copy…", async () => {
      try {
        const id = await invoke<number>("save_roster", {
          id: null,
          name,
          definition: JSON.stringify(definition),
        });
        const entry: Entry = { key: `saved:${id}`, id, builtin: false, name, definition };
        setEntries((current) => [...current, entry]);
        setSelectedKey(entry.key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("invoke") && !message.includes("undefined")) {
          throw err;
        }
        const entry: Entry = {
          key: `draft:${crypto.randomUUID()}`,
          id: null,
          builtin: false,
          name,
          definition,
        };
        setEntries((current) => [...current, entry]);
        setSelectedKey(entry.key);
      }
    });
  }, [run, selected]);

  const startBlank = useCallback(() => {
    const draft: Entry = {
      key: `draft:${crypto.randomUUID()}`,
      id: null,
      builtin: false,
      name: "New roster",
      definition: blankRoster(),
    };
    setEntries((current) => [...current, draft]);
    setSelectedKey(draft.key);
  }, []);

  const toggleGeneration = (generation: number) => {
    const definition = selected.definition;
    const has = definition.generations.includes(generation);
    if (has && definition.generations.length === 1) {
      return;
    }
    const generations = has
      ? definition.generations.filter((item) => item !== generation)
      : [...definition.generations, generation].sort((a, b) => a - b);
    const wasEven = sameBias(definition.bias, evenBias(definition.generations));
    let bias: Record<number, number>;
    if (generations.length <= 1 || wasEven) {
      bias = evenBias(generations);
    } else if (has) {
      const removed = definition.bias[generation] ?? 0;
      bias = {};
      for (const item of generations) {
        bias[item] = definition.bias[item] ?? 0;
      }
      bias[generations[0]] = (bias[generations[0]] ?? 0) + removed;
    } else {
      bias = {};
      for (const item of generations) {
        bias[item] = definition.bias[item] ?? 0;
      }
    }
    patchDefinition({ ...definition, generations, bias });
  };

  const setColumnType = (index: number, type: PokemonType) => {
    if (selected.definition.categories.some((category, categoryIndex) => categoryIndex !== index && category.type === type)) {
      return;
    }
    patchDefinition({
      ...selected.definition,
      categories: selected.definition.categories.map((category, categoryIndex) => {
        if (categoryIndex !== index) {
          return category;
        }
        return {
          type,
          members: category.members.filter((name) => BY_NAME.get(name)?.types.includes(type)),
        };
      }),
    });
  };

  const addMember = (index: number, name: string) => {
    if (taken.has(name)) {
      return;
    }
    patchDefinition({
      ...selected.definition,
      categories: selected.definition.categories.map((category, categoryIndex) => {
        if (categoryIndex !== index || category.members.length >= 6) {
          return category;
        }
        return { ...category, members: [...category.members, name] };
      }),
    });
  };

  const removeMember = (index: number, name: string) => {
    patchDefinition({
      ...selected.definition,
      categories: selected.definition.categories.map((category, categoryIndex) => {
        if (categoryIndex !== index) {
          return category;
        }
        return { ...category, members: category.members.filter((member) => member !== name) };
      }),
    });
  };

  const applySwap = (swap: SwapSuggestion) => {
    patchDefinition({
      ...selected.definition,
      categories: selected.definition.categories.map((category) => {
        if (category.type !== swap.type) {
          return category;
        }
        if (swap.remove) {
          return {
            ...category,
            members: category.members.map((member) => (member === swap.remove ? swap.add : member)),
          };
        }
        if (category.members.length >= 6 || category.members.includes(swap.add)) {
          return category;
        }
        return { ...category, members: [...category.members, swap.add] };
      }),
    });
  };

  const failedNames = rosterMembers(selected.definition).filter((name) => failedArt[name]);
  const half = Math.floor(report.filled / 2);

  return (
    <div className="guess-who">
      <style>{BOARD_CSS}</style>
      {wizardOpen && (
        <GenerateWizard
          onClose={() => setWizardOpen(false)}
          onCreate={(name, definition) => {
            const draft: Entry = {
              key: `draft:${crypto.randomUUID()}`,
              id: null,
              builtin: false,
              name,
              definition,
            };
            setEntries((current) => [...current, draft]);
            setSelectedKey(draft.key);
            setCopy("a");
            setWizardOpen(false);
          }}
        />
      )}
      <aside className="library gw-library">
        <h2>Rosters</h2>
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search name or Pokémon"
          aria-label="Search rosters"
        />
        <div className="gw-library-actions">
          <button type="button" onClick={startBlank} disabled={!!busy}>
            New roster
          </button>
          <button type="button" className="gw-secondary" onClick={() => setWizardOpen(true)} disabled={!!busy}>
            Generate
          </button>
        </div>
        {visible.length === 0 ? (
          <p className="empty">No roster matches that search.</p>
        ) : (
          <ul>
            {visible.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className={`library-item${entry.key === selected.key ? " active" : ""}`}
                  onClick={() => {
                    setSelectedKey(entry.key);
                    setCopy("a");
                  }}
                >
                  <span className={`gw-swatch ${entry.definition.frame}`} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.builtin ? "Built in · " : entry.id === null ? "Not saved · " : ""}
                      {entry.definition.categories.map((category) => typeLabel(category.type)).join(" · ")}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="guess-main">
        {error && <p className="banner error">{error}</p>}
        {busy && <p className="banner status">{busy}</p>}
        <div className="gw-toolbar">
          <label>
            Name
            <input
              value={selected.name}
              disabled={readOnly || !!busy}
              onChange={(event) => updateSelected((entry) => ({ ...entry, name: event.currentTarget.value }))}
            />
          </label>
          <div className="mode-toggle" role="group" aria-label="Board frame">
            {(["blue", "red"] as Frame[]).map((frame) => (
              <button
                key={frame}
                type="button"
                className={selected.definition.frame === frame ? "active" : ""}
                disabled={readOnly}
                onClick={() => patchDefinition({ ...selected.definition, frame })}
              >
                {frame === "blue" ? "Blue" : "Red"}
              </button>
            ))}
          </div>
          <div className="gw-actions">
            {readOnly ? (
              <button type="button" onClick={() => void duplicateSelected()} disabled={!!busy}>
                Duplicate to edit
              </button>
            ) : (
              <button type="button" onClick={() => void saveSelected()} disabled={!!busy}>
                Save
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                patchDefinition({
                  ...selected.definition,
                  shuffleA: freshSeed(),
                  shuffleB: freshSeed(),
                })
              }
              disabled={!!busy}
            >
              Reshuffle
            </button>
            <button
              type="button"
              onClick={() =>
                void run("Preparing print…", () => printRoster(selected.name, selected.definition, art))
              }
              disabled={!!busy}
            >
              Print both copies
            </button>
            {!readOnly && (
              <button type="button" className="ghost" onClick={() => void removeSelected()} disabled={!!busy}>
                Delete
              </button>
            )}
          </div>
        </div>

        <section className="gw-settings">
          <div>
            <h3>Generations</h3>
            <p>Checked generations can be added. Types stay on the current chart either way.</p>
            <div className="gw-gen-checks">
              {GENERATIONS.map((generation) => (
                <label key={generation}>
                  <input
                    type="checkbox"
                    checked={selected.definition.generations.includes(generation)}
                    disabled={readOnly}
                    onChange={() => toggleGeneration(generation)}
                  />
                  {generationLabel(generation).replace("Generation ", "")}
                </label>
              ))}
            </div>
          </div>
          <div>
            <h3>Generation bias</h3>
            {selected.definition.generations.length <= 1 ? (
              <p>Every legal pick is from {generationLabel(selected.definition.generations[0] ?? 1)}, so there is no split to balance.</p>
            ) : (
              <>
                <p>Targets always describe a full board of 24. Even splits them as equally as the count allows.</p>
                <div className="gw-bias">
                  {selected.definition.generations.map((generation) => (
                    <label key={generation}>
                      {generationLabel(generation).replace("Generation ", "")}
                      <input
                        type="number"
                        min={0}
                        max={24}
                        value={selected.definition.bias[generation] ?? 0}
                        disabled={readOnly}
                        onChange={(event) => {
                          const weight = Math.max(0, Math.min(24, Math.round(Number(event.currentTarget.value) || 0)));
                          patchDefinition({
                            ...selected.definition,
                            bias: { ...selected.definition.bias, [generation]: weight },
                          });
                        }}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="ghost"
                    disabled={readOnly}
                    onClick={() =>
                      patchDefinition({
                        ...selected.definition,
                        bias: evenBias(selected.definition.generations),
                      })
                    }
                  >
                    Even
                  </button>
                  <span className={biasTotal(selected.definition) === 24 ? "" : "gw-warn"}>
                    {biasTotal(selected.definition)} / 24
                  </span>
                </div>
              </>
            )}
          </div>
        </section>

        <div className="gw-columns">
          {selected.definition.categories.map((category, index) => (
            <section key={category.type} style={{ background: TYPE_COLORS[category.type], color: typeInk(category.type) }}>
              <label>
                Type
                <select
                  value={category.type}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (isType(next)) {
                      setColumnType(index, next);
                    }
                  }}
                >
                  {TYPE_ORDER.map((type) => (
                    <option
                      key={type}
                      value={type}
                      disabled={selected.definition.categories.some(
                        (other, otherIndex) => otherIndex !== index && other.type === type,
                      )}
                    >
                      {typeLabel(type)}
                    </option>
                  ))}
                </select>
              </label>
              <ol>
                {Array.from({ length: 6 }, (_, slot) => {
                  const name = category.members[slot];
                  if (!name) {
                    return (
                      <li key={`empty-${slot}`} className="gw-empty-slot">
                        Empty
                      </li>
                    );
                  }
                  const species = BY_NAME.get(name);
                  return (
                    <li key={name}>
                      <span>
                        <strong>{name}</strong>
                        <small>
                          {species
                            ? `${generationLabel(species.generation)} · ${species.types.map(typeLabel).join(" / ")}`
                            : "Unknown"}
                        </small>
                      </span>
                      {!readOnly && (
                        <button type="button" className="ghost" onClick={() => removeMember(index, name)}>
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
              {!readOnly && category.members.length < 6 && (
                <SlotSearch
                  type={category.type}
                  generations={selected.definition.generations}
                  taken={taken}
                  onPick={(name) => addMember(index, name)}
                />
              )}
            </section>
          ))}
        </div>

        <div className="guess-lower">
          <section className="gw-balance">
            <h3>Balance</h3>
            <p>
              A fair roster lets a yes-or-no question cut the remaining Pokémon in half.
              {report.filled > 1
                ? ` With ${report.filled} Pokémon, the best first question splits ${half} and ${report.filled - half}.`
                : " Add at least two Pokémon to score a question."}{" "}
              A type row of six is a 6-and-18 split: useful, and lopsided.
            </p>
            <p>{report.summary}</p>
            {report.best.length > 0 && (
              <ul className="gw-questions">
                {report.best.map((question) => (
                  <li key={question.id}>
                    <span className={`gw-quality ${question.quality}`}>{qualityLabel(question.quality)}</span>
                    <span>
                      {question.prompt}
                      <small>
                        {question.yes} yes / {question.no} no
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <h4>Generations</h4>
            <ul className="gw-gen-counts">
              {report.generationCounts.map((row) => (
                <li key={row.generation}>
                  {generationLabel(row.generation)}: {row.count}
                  {row.target === null ? "" : ` (target ${row.target})`}
                </li>
              ))}
            </ul>
            {!report.biasReady && selected.definition.generations.length > 1 && (
              <p className="gw-warn">Generation targets add up to {biasTotal(selected.definition)}, not 24.</p>
            )}
            {report.outsideFilter.length > 0 && (
              <p>Outside the generation filter: {report.outsideFilter.join(", ")}.</p>
            )}
            {report.mismatched.length > 0 && (
              <p>
                {report.mismatched
                  .map((item) => `${item.name}'s current type is ${item.types.map(typeLabel).join(" / ")}`)
                  .join(". ")}
                .
              </p>
            )}
            {report.families.length > 0 && (
              <p>
                Same evolution family:{" "}
                {report.families.map((family) => family.names.join(" and ")).join("; ")}.
              </p>
            )}
            {report.swaps.length > 0 && (
              <>
                <h4>Closer to this bias</h4>
                <ul className="gw-swaps">
                  {report.swaps.map((swap) => (
                    <li key={`${swap.type}-${swap.add}`}>
                      <span>{swap.text}</span>
                      {!readOnly && (
                        <button type="button" onClick={() => applySwap(swap)}>
                          Apply
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.questions.length > 0 && (
              <details>
                <summary>All {report.questions.length} questions</summary>
                <ul className="gw-questions">
                  {report.questions.map((question) => (
                    <li key={question.id}>
                      <span className={`gw-quality ${question.quality}`}>{qualityLabel(question.quality)}</span>
                      <span>
                        {question.prompt}
                        <small>
                          {question.yes} yes / {question.no} no
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="gw-stage">
            <div className="frame-heading">
              <h3>Print preview</h3>
              <div className="mode-toggle" role="group" aria-label="Which shuffled copy">
                <button type="button" className={copy === "a" ? "active" : ""} onClick={() => setCopy("a")}>
                  Copy A
                </button>
                <button type="button" className={copy === "b" ? "active" : ""} onClick={() => setCopy("b")}>
                  Copy B
                </button>
              </div>
            </div>
            <p className="gw-print-note">
              Each copy is one letter sheet with a 0.45 in margin. The top strip is where you mark the Pokémon your opponent is guessing, and it is shuffled separately from the play grid. Copy A and copy B do not share either arrangement.
            </p>
            {artNote && <p className="banner status">{artNote}</p>}
            {!desktopArt && <p>Artwork downloads in the desktop app. Names and colors still preview here.</p>}
            {failedNames.length > 0 && (
              <p className="gw-warn">
                Could not load art for {failedNames.join(", ")}.{" "}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setFailedArt((current) => {
                      const next = { ...current };
                      for (const name of failedNames) {
                        delete next[name];
                      }
                      return next;
                    });
                    setArtRetry((retry) => retry + 1);
                  }}
                >
                  Try again
                </button>
              </p>
            )}
            <ScaledSheet html={previewHtml} />
          </section>
        </div>
      </div>
    </div>
  );
}

function isType(value: string): value is PokemonType {
  return (TYPE_ORDER as readonly string[]).includes(value);
}
