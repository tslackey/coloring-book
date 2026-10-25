import { useMemo, useState } from "react";
import { GENERATIONS, generationLabel, typeLabel } from "./catalog";
import { qualityLabel, scoreRoster } from "./balance";
import { eligibleCount, generateRoster, generatedName, leanBias, suggestTypes } from "./generate";
import {
  TYPE_ORDER,
  TYPE_PICK_COLORS,
  evenBias,
  freshSeed,
  type PokemonType,
  type RosterDefinition,
  typePickInk,
} from "./roster";

type GenerateWizardProps = {
  onClose: () => void;
  onCreate: (name: string, definition: RosterDefinition) => void;
};

export default function GenerateWizard({ onClose, onCreate }: GenerateWizardProps) {
  const [step, setStep] = useState(0);
  const [generations, setGenerations] = useState<number[]>([1, 2, 3]);
  const [split, setSplit] = useState<"even" | "lean">("even");
  const [favored, setFavored] = useState(1);
  const [autoTypes, setAutoTypes] = useState(true);
  const [picked, setPicked] = useState<PokemonType[]>([]);
  const [seed, setSeed] = useState(() => freshSeed());

  const bias = useMemo(() => {
    if (split === "lean" && generations.length > 1) {
      const favoredGeneration = generations.includes(favored) ? favored : generations[0];
      return leanBias(generations, favoredGeneration);
    }
    return evenBias(generations);
  }, [favored, generations, split]);

  const types = useMemo(
    () => (autoTypes ? suggestTypes(generations, seed) : picked),
    [autoTypes, generations, picked, seed],
  );

  const generated = useMemo(() => {
    if (step < 3 || types.length !== 4 || generations.length === 0) {
      return null;
    }
    return generateRoster({ generations, bias, types, frame: "blue", seed });
  }, [bias, generations, seed, step, types]);

  const report = useMemo(() => (generated ? scoreRoster(generated) : null), [generated]);

  const toggleGeneration = (generation: number) => {
    setGenerations((current) => {
      if (current.includes(generation)) {
        if (current.length === 1) {
          return current;
        }
        return current.filter((item) => item !== generation);
      }
      return [...current, generation].sort((a, b) => a - b);
    });
  };

  const toggleType = (type: PokemonType) => {
    setAutoTypes(false);
    setPicked((current) => {
      if (current.includes(type)) {
        return current.filter((item) => item !== type);
      }
      if (current.length >= 4) {
        return current;
      }
      return [...current, type];
    });
  };

  const goNext = () => {
    if (step === 0) {
      setStep(generations.length > 1 ? 1 : 2);
      return;
    }
    setStep((current) => Math.min(3, current + 1));
  };

  const goBack = () => {
    if (step === 2 && generations.length < 2) {
      setStep(0);
      return;
    }
    setStep((current) => Math.max(0, current - 1));
  };

  const shortTypes = generated?.categories.filter((category) => category.members.length < 6) ?? [];

  return (
    <div className="gw-wizard-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="gw-wizard"
        role="dialog"
        aria-labelledby="gw-wizard-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="gw-wizard-head">
          <h2 id="gw-wizard-title">Generate a roster</h2>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="gw-wizard-step">Step {Math.min(step + 1, 4)} of 4</p>

        {step === 0 && (
          <>
            <h3>Which generations can be dealt?</h3>
            <p>This only limits when a Pokémon debuted. Its type stays the current one.</p>
            <div className="gw-gen-checks">
              {GENERATIONS.map((generation) => (
                <label key={generation}>
                  <input
                    type="checkbox"
                    checked={generations.includes(generation)}
                    onChange={() => toggleGeneration(generation)}
                  />
                  {generationLabel(generation).replace("Generation ", "")}
                </label>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h3>How should those generations be split?</h3>
            <p>A full board is 24 Pokémon. Even divides them as equally as the count allows.</p>
            <div className="gw-choice">
              <button type="button" className={split === "even" ? "active" : ""} onClick={() => setSplit("even")}>
                Even
                <small>
                  {generations.map((generation) => `${generationLabel(generation).replace("Generation ", "")} ${evenBias(generations)[generation]}`).join(" · ")}
                </small>
              </button>
              <button type="button" className={split === "lean" ? "active" : ""} onClick={() => setSplit("lean")}>
                Lean toward one generation
                <small>That generation gets 12. The rest share the other 12.</small>
              </button>
            </div>
            {split === "lean" && (
              <div className="gw-gen-checks">
                {generations.map((generation) => (
                  <label key={generation}>
                    <input
                      type="radio"
                      name="favored-generation"
                      checked={(generations.includes(favored) ? favored : generations[0]) === generation}
                      onChange={() => setFavored(generation)}
                    />
                    {generationLabel(generation)}
                  </label>
                ))}
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h3>Which four types?</h3>
            <p>
              A Pokémon can sit in a column when that type is one of its current types. Clefable counts as Fairy, even
              on a Generation I roster. The number is how many match the generations you checked.
            </p>
            <button
              type="button"
              className={autoTypes ? "active" : ""}
              onClick={() => setAutoTypes(true)}
            >
              Pick four for me
            </button>
            <div className="gw-type-picks">
              {TYPE_ORDER.map((type) => {
                const count = eligibleCount(type, generations);
                const selected = !autoTypes && picked.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={selected ? "active" : ""}
                    style={{ background: TYPE_PICK_COLORS[type], color: typePickInk(type) }}
                    onClick={() => toggleType(type)}
                    disabled={count === 0}
                  >
                    {typeLabel(type)}
                    <small>{count}</small>
                  </button>
                );
              })}
            </div>
            <p>{autoTypes ? "Four types will be chosen from the deepest pools." : `${picked.length} of 4 selected.`}</p>
          </>
        )}

        {step === 3 && !generated && (
          <p>Those answers do not leave four types with enough Pokémon. Go back and widen the generations or pick different types.</p>
        )}

        {step === 3 && generated && report && (
          <>
            <h3>{generatedName(generated.categories.map((category) => category.type))}</h3>
            <p>{report.summary}</p>
            <ul className="gw-gen-counts">
              {report.generationCounts.map((row) => (
                <li key={row.generation}>
                  {generationLabel(row.generation)}: {row.count}
                  {row.target == null ? "" : ` (target ${row.target})`}
                </li>
              ))}
            </ul>
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
            {report.families.length > 0 && (
              <p>Same evolution family: {report.families.map((family) => family.names.join(" and ")).join("; ")}.</p>
            )}
            {shortTypes.length > 0 && (
              <p className="gw-warn">
                {shortTypes
                  .map((category) => `${typeLabel(category.type)} has ${category.members.length} of 6 in these generations`)
                  .join(". ")}
                .
              </p>
            )}
          </>
        )}

        <div className="gw-wizard-actions">
          {step > 0 && (
            <button type="button" className="gw-secondary" onClick={goBack}>
              Back
            </button>
          )}
          {step < 2 && (
            <button type="button" onClick={goNext} disabled={generations.length === 0}>
              Next
            </button>
          )}
          {step === 2 && (
            <button type="button" onClick={goNext} disabled={!autoTypes && picked.length !== 4}>
              Generate
            </button>
          )}
          {step === 3 && generated && (
            <>
              <button type="button" className="gw-secondary" onClick={() => setSeed(freshSeed())}>
                Try another
              </button>
              <button
                type="button"
                onClick={() =>
                  onCreate(
                    generatedName(generated.categories.map((category) => category.type)),
                    generated,
                  )
                }
              >
                Use this roster
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
