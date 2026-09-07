import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  PageSummary,
  PreviewView,
  SearchHit,
  WorkspaceView,
} from "./types";
import { pngUrl, slugify } from "./types";
import "./App.css";

const DEFAULT_THRESHOLD = 15;

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [coloringUrl, setColoringUrl] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewTimer = useRef<number | null>(null);
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

  const applyWorkspace = useCallback((view: WorkspaceView) => {
    setWorkspace(view);
    setColoringUrl(pngUrl(view.coloring_png_base64));
    setThreshold(Math.round(view.threshold));
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

  const searchWiki = useCallback(async () => {
    await run("Searching Bulbapedia…", async () => {
      const results = await invoke<SearchHit[]>("search_bulbapedia", {
        query,
      });
      setHits(results);
      if (results.length === 0) {
        setError("No illustrated pages found for that search.");
      }
    });
  }, [query, run]);

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
      applyWorkspace(view);
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
  }, [pasteClipboard]);

  return (
    <div className="studio">
      <header className="masthead">
        <div>
          <p className="eyebrow">Local studio</p>
          <h1>Coloring Book</h1>
        </div>
        <div className="masthead-actions">
          <button type="button" onClick={() => void openFile()} disabled={!!busy}>
            Open file
          </button>
          <button type="button" onClick={() => void pasteClipboard()} disabled={!!busy}>
            Paste
          </button>
        </div>
      </header>

      <section className="search-bar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void searchWiki();
          }}
        >
          <label htmlFor="wiki-search">Bulbapedia</label>
          <input
            id="wiki-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search Pokémon art, e.g. Pikachu"
            autoComplete="off"
          />
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
            <h2>Coloring page</h2>
            {coloringUrl ? (
              <img src={coloringUrl} alt={`${workspace?.title ?? "Page"} line art`} />
            ) : (
              <p className="empty">Line art appears here. Scrub the threshold after loading an image.</p>
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
                      <small>
                        {page.source} · {Math.round(page.threshold)}%
                      </small>
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
        <label className="slider">
          <span>
            Threshold <strong>{threshold}%</strong>
          </span>
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
        <div className="controls-actions">
          <button type="button" onClick={() => void savePage()} disabled={!hasImage || !!busy}>
            Save to library
          </button>
          <button type="button" onClick={() => void exportCurrent()} disabled={!hasImage || !!busy}>
            Export PNG
          </button>
        </div>
      </footer>
    </div>
  );
}

export default App;
