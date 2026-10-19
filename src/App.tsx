import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  ColoringPngView,
  PageSummary,
  PreviewView,
  SearchHit,
  TutorialStep,
  WorkspaceView,
} from "./types";
import { pngUrl, slugify } from "./types";
import GuessWho from "./guess-who/GuessWho";
import { printColoringPng, resolvePokemonQuery, suggestPokemon } from "./pokemon";
import "./App.css";

const DEFAULT_THRESHOLD = 50;

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [coloringUrl, setColoringUrl] = useState<string | null>(null);
  const [tutorial, setTutorial] = useState<TutorialStep[]>([]);
  const [mode, setMode] = useState<"page" | "tutorial">("page");
  const [stepIndex, setStepIndex] = useState(0);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<"coloring" | "guess">("coloring");
  const previewTimer = useRef<number | null>(null);
  const searchWrap = useRef<HTMLDivElement | null>(null);
  const hasImage = workspace !== null;

  const refreshLibrary = useCallback(async () => {
    try {
      const list = await invoke<PageSummary[]>("list_pages");
      setPages(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("invoke") && message.includes("undefined")) {
        return;
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    refreshLibrary().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshLibrary]);

  const applyWorkspace = useCallback((view: WorkspaceView, resetDetail = true) => {
    setWorkspace(view);
    setColoringUrl(pngUrl(view.coloring_png_base64));
    setTutorial(view.tutorial ?? []);
    setStepIndex(0);
    if (resetDetail) {
      setThreshold(DEFAULT_THRESHOLD);
      setMode("page");
    }
    setError(null);
  }, []);

  const run = useCallback(
    async (label: string, task: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await task();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const openFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: "Open source image",
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
      ],
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    await run("Opening image…", async () => {
      const view = await invoke<WorkspaceView>("import_file", { path: selected });
      applyWorkspace(view);
    });
  }, [applyWorkspace, run]);

  const pasteClipboard = useCallback(async () => {
    await run("Reading clipboard…", async () => {
      const view = await invoke<WorkspaceView>("import_clipboard");
      applyWorkspace(view);
    });
  }, [applyWorkspace, run]);

  const searchWiki = useCallback(
    async (name = query) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      const resolved = resolvePokemonQuery(trimmed);
      setQuery(resolved);
      setSuggestOpen(false);
      await run("Searching Bulbapedia…", async () => {
        const results = await invoke<SearchHit[]>("search_bulbapedia", {
          query: resolved,
        });
        setHits(results);
        if (results.length === 0) {
          setError("No illustrated pages found for that search.");
        }
      });
    },
    [query, run],
  );

  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    const next = suggestPokemon(value);
    setSuggestions(next);
    setSuggestIndex(0);
    setSuggestOpen(next.length > 0);
  }, []);

  const importHit = useCallback(
    async (hit: SearchHit) => {
      await run(`Loading ${hit.title}…`, async () => {
        const view = await invoke<WorkspaceView>("import_url", {
          url: hit.original_url,
          title: hit.title,
        });
        applyWorkspace(view);
      });
    },
    [applyWorkspace, run],
  );

  const savePage = useCallback(async () => {
    await run("Saving to library…", async () => {
      const view = await invoke<WorkspaceView>("save_page", { threshold });
      applyWorkspace(view, false);
      await refreshLibrary();
    });
  }, [applyWorkspace, refreshLibrary, run, threshold]);

  const exportCurrent = useCallback(async () => {
    if (!workspace) {
      return;
    }
    const dest = await save({
      title: "Export coloring page",
      defaultPath: `${slugify(workspace.title)}-coloring.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!dest) {
      return;
    }
    await run("Exporting…", async () => {
      await invoke("export_current", { path: dest, threshold });
    });
  }, [run, threshold, workspace]);

  const exportTutorial = useCallback(async () => {
    if (!workspace || tutorial.length === 0) {
      return;
    }
    const dest = await save({
      title: "Export draw-along",
      defaultPath: `${slugify(workspace.title)}-tutorial.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!dest) {
      return;
    }
    await run("Exporting tutorial…", async () => {
      await invoke("export_tutorial", { path: dest, threshold });
    });
  }, [run, threshold, tutorial.length, workspace]);

  const printCurrent = useCallback(async () => {
    if (!workspace) {
      return;
    }
    await run("Preparing print…", async () => {
      const page = await invoke<ColoringPngView>("current_coloring_png", { threshold });
      await printColoringPng(page.png_base64, `${page.title} coloring page`);
    });
  }, [run, threshold, workspace]);

  const loadPage = useCallback(
    async (id: number) => {
      await run("Loading page…", async () => {
        const view = await invoke<WorkspaceView>("load_page", { id });
        applyWorkspace(view);
      });
    },
    [applyWorkspace, run],
  );

  const removePage = useCallback(
    async (id: number) => {
      await run("Deleting…", async () => {
        await invoke("delete_page", { id });
        await refreshLibrary();
      });
    },
    [refreshLibrary, run],
  );

  useEffect(() => {
    if (!workspace) {
      return;
    }
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
    }
    previewTimer.current = window.setTimeout(() => {
      invoke<PreviewView>("preview", { threshold })
        .then((preview) => {
          setColoringUrl(pngUrl(preview.coloring_png_base64));
          setTutorial(preview.tutorial ?? []);
          setStepIndex((current) => Math.min(current, Math.max((preview.tutorial?.length ?? 1) - 1, 0)));
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 50);
    return () => {
      if (previewTimer.current !== null) {
        window.clearTimeout(previewTimer.current);
      }
    };
  }, [threshold, workspace]);

  useEffect(() => {
    if (mode !== "tutorial" || tutorial.length === 0) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (event.key === "ArrowRight") {
        setStepIndex((index) => Math.min(tutorial.length - 1, index + 1));
      } else if (event.key === "ArrowLeft") {
        setStepIndex((index) => Math.max(0, index - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, tutorial.length]);

  useEffect(() => {
    if (screen !== "coloring") {
      return;
    }
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      event.preventDefault();
      void pasteClipboard();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pasteClipboard, screen]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (searchWrap.current && !searchWrap.current.contains(event.target as Node)) {
        setSuggestOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  return (
    <div className={`studio${screen === "guess" ? " guess-mode" : ""}`}>
      <header className="masthead">
        <div>
          <p className="eyebrow">Local studio</p>
          <h1>Coloring Book</h1>
        </div>
        <div className="masthead-actions">
          <div className="mode-toggle" role="group" aria-label="Studio">
            <button
              type="button"
              className={screen === "coloring" ? "active" : ""}
              onClick={() => setScreen("coloring")}
            >
              Coloring
            </button>
            <button
              type="button"
              className={screen === "guess" ? "active" : ""}
              onClick={() => setScreen("guess")}
            >
              Guess Who
            </button>
          </div>
          {screen === "coloring" && (
            <>
              <button type="button" onClick={() => void openFile()} disabled={!!busy}>
                Open file
              </button>
              <button type="button" onClick={() => void pasteClipboard()} disabled={!!busy}>
                Paste
              </button>
            </>
          )}
        </div>
      </header>

      {screen === "guess" ? (
        <GuessWho />
      ) : (
      <>
      <section className="search-bar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const picked =
              suggestOpen && suggestions[suggestIndex] ? suggestions[suggestIndex] : query;
            void searchWiki(picked);
          }}
        >
          <label htmlFor="wiki-search">Bulbapedia</label>
          <div className="suggest-wrap" ref={searchWrap}>
            <input
              id="wiki-search"
              value={query}
              onChange={(event) => updateQuery(event.currentTarget.value)}
              onFocus={() => {
                const next = suggestPokemon(query);
                setSuggestions(next);
                setSuggestOpen(next.length > 0);
              }}
              onKeyDown={(event) => {
                if (!suggestOpen || suggestions.length === 0) {
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSuggestIndex((index) => (index + 1) % suggestions.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSuggestIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
                } else if (event.key === "Escape") {
                  setSuggestOpen(false);
                }
              }}
              placeholder="Pikachu, pikachoo, pi*chu, ?ikachu"
              autoComplete="off"
              role="combobox"
              aria-expanded={suggestOpen}
              aria-controls="pokemon-suggestions"
              aria-autocomplete="list"
            />
            {suggestOpen && suggestions.length > 0 && (
              <ul id="pokemon-suggestions" className="suggest-list" role="listbox">
                {suggestions.map((name, index) => (
                  <li key={name} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === suggestIndex}
                      className={index === suggestIndex ? "active" : ""}
                      onMouseEnter={() => setSuggestIndex(index)}
                      onClick={() => void searchWiki(name)}
                    >
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" disabled={!!busy || query.trim().length === 0}>
            Search
          </button>
        </form>
        {hits.length > 0 && (
          <div className="hit-grid">
            {hits.map((hit) => (
              <button
                key={`${hit.title}-${hit.original_url}`}
                type="button"
                className="hit"
                onClick={() => void importHit(hit)}
                disabled={!!busy}
              >
                {hit.thumb_data_url ? (
                  <img src={hit.thumb_data_url} alt="" />
                ) : (
                  <span className="hit-fallback">No art</span>
                )}
                <span>{hit.title}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {error && <p className="banner error">{error}</p>}
      {busy && <p className="banner status">{busy}</p>}

      <div className="workspace">
        <section className="stage">
          <div className="frame">
            <h2>Original</h2>
            {workspace ? (
              <img src={pngUrl(workspace.original_png_base64)} alt={workspace.title} />
            ) : (
              <p className="empty">Open a file, paste, or pick a Bulbapedia result.</p>
            )}
          </div>
          <div className="frame paper">
            <div className="frame-heading">
              <h2>{mode === "tutorial" ? "Draw along" : "Coloring page"}</h2>
              {tutorial.length > 0 && (
                <div className="mode-toggle" role="tablist" aria-label="Page or draw-along">
                  <button
                    type="button"
                    className={mode === "page" ? "active" : ""}
                    onClick={() => setMode("page")}
                  >
                    Page
                  </button>
                  <button
                    type="button"
                    className={mode === "tutorial" ? "active" : ""}
                    onClick={() => setMode("tutorial")}
                  >
                    Draw along
                  </button>
                </div>
              )}
            </div>
            {mode === "tutorial" && tutorial[stepIndex] ? (
              <>
                <img
                  src={pngUrl(tutorial[stepIndex].png_base64)}
                  alt={`${workspace?.title ?? "Page"} step ${tutorial[stepIndex].index}`}
                />
                <div className="step-bar">
                  <button
                    type="button"
                    className="ghost"
                    disabled={stepIndex === 0}
                    onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
                  >
                    Back
                  </button>
                  <p>
                    <strong>
                      Step {tutorial[stepIndex].index} of {tutorial.length}
                    </strong>
                    <span>{tutorial[stepIndex].label}</span>
                  </p>
                  <button
                    type="button"
                    className="ghost"
                    disabled={stepIndex >= tutorial.length - 1}
                    onClick={() => setStepIndex((index) => Math.min(tutorial.length - 1, index + 1))}
                  >
                    Next
                  </button>
                </div>
              </>
            ) : coloringUrl ? (
              <img src={coloringUrl} alt={`${workspace?.title ?? "Page"} line art`} />
            ) : (
              <p className="empty">Line art appears here after you load an image.</p>
            )}
          </div>
        </section>

        <aside className="library">
          <h2>Library</h2>
          {pages.length === 0 ? (
            <p className="empty">Saved pages stay on this machine in SQLite.</p>
          ) : (
            <ul>
              {pages.map((page) => (
                <li key={page.id}>
                  <button
                    type="button"
                    className="library-item"
                    onClick={() => void loadPage(page.id)}
                    disabled={!!busy}
                  >
                    <img src={pngUrl(page.thumb_png_base64)} alt="" />
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.source}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void removePage(page.id)}
                    disabled={!!busy}
                    aria-label={`Delete ${page.title}`}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <footer className="controls">
        <div className="controls-actions">
          <button type="button" onClick={() => void savePage()} disabled={!hasImage || !!busy}>
            Save to library
          </button>
          <button type="button" onClick={() => void printCurrent()} disabled={!hasImage || !!busy}>
            Print
          </button>
          <button type="button" onClick={() => void exportCurrent()} disabled={!hasImage || !!busy}>
            Export PNG
          </button>
          <button
            type="button"
            onClick={() => void exportTutorial()}
            disabled={!hasImage || tutorial.length === 0 || !!busy}
          >
            Export tutorial
          </button>
        </div>
        <details className="advanced">
          <summary>Advanced</summary>
          <label className="slider">
            <span>
              Detail <strong>{threshold}%</strong>
            </span>
            <small>
              Typical art should look right at 50%. Lower this only if a photo or painting draws too many lines.
            </small>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={threshold}
              disabled={!hasImage || !!busy}
              onChange={(event) => setThreshold(Number(event.currentTarget.value))}
            />
          </label>
        </details>
      </footer>
      </>
      )}
    </div>
  );
}

export default App;
