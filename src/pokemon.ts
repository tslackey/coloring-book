import { POKEMON_NAMES } from "./pokemon-names";

const SUGGESTION_LIMIT = 10;

type MatchKind = "exact" | "prefix" | "wildcard" | "word" | "contains" | "typo" | "sound";

const KIND_RANK: Record<MatchKind, number> = {
  exact: 0,
  prefix: 1,
  wildcard: 2,
  word: 3,
  contains: 4,
  typo: 5,
  sound: 6,
};

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/♀/g, "f")
    .replace(/♂/g, "m")
    .replace(/['’`]/g, "")
    .replace(/[:.\- ]+/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardRegex(query: string): RegExp | null {
  const raw = query.trim().toLowerCase().replace(/%/g, "*");
  if (!/[*?]/.test(raw)) {
    return null;
  }
  const body = raw
    .split(/([*?])/)
    .map((part) => {
      if (part === "*") {
        return ".*";
      }
      if (part === "?") {
        return ".";
      }
      return escapeRegex(fold(part));
    })
    .join("");
  return new RegExp(`^${body}$`);
}

function soundsLike(value: string): string {
  let text = fold(value)
    .replace(/qu/g, "k")
    .replace(/x/g, "ks")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/ch/g, "x")
    .replace(/sh/g, "x")
    .replace(/th/g, "t")
    .replace(/wh/g, "w")
    .replace(/kn/g, "n")
    .replace(/wr/g, "r")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/dg/g, "j")
    .replace(/[aeiouy]+/g, "");
  text = text.replace(/(.)\1+/g, "$1");
  return text;
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev2 = new Array<number>(cols).fill(0);
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) {
    prev[j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    let rowBest = curr[0];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      curr[j] = value;
      rowBest = Math.min(rowBest, value);
    }
    if (rowBest > max) {
      return max + 1;
    }
    for (let j = 0; j < cols; j += 1) {
      prev2[j] = prev[j];
      prev[j] = curr[j];
    }
  }
  return prev[b.length];
}

function typoLimit(length: number): number {
  if (length < 3) {
    return 0;
  }
  if (length < 5) {
    return 1;
  }
  return 2;
}

function rankPokemon(query: string): { name: string; kind: MatchKind; rank: number }[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const wildcard = wildcardRegex(trimmed);
  const needle = fold(trimmed.replace(/[*?%]/g, ""));
  const needleSound = needle.length >= 3 ? soundsLike(needle) : "";
  const maxEdits = typoLimit(needle.length);
  const ranked: { name: string; kind: MatchKind; rank: number }[] = [];

  for (const name of POKEMON_NAMES) {
    const hay = fold(name);
    let kind: MatchKind | null = null;

    if (wildcard) {
      if (wildcard.test(hay)) {
        kind = "wildcard";
      }
    } else if (hay === needle) {
      kind = "exact";
    } else if (hay.startsWith(needle)) {
      kind = "prefix";
    } else if (name.toLowerCase().split(/[\s:\-]+/).some((part) => fold(part).startsWith(needle))) {
      kind = "word";
    } else if (needle.length >= 2 && hay.includes(needle)) {
      kind = "contains";
    } else if (maxEdits > 0 && editDistance(needle, hay, maxEdits) <= maxEdits) {
      kind = "typo";
    } else if (
      needleSound.length >= 2 &&
      (soundsLike(hay) === needleSound || soundsLike(hay).startsWith(needleSound))
    ) {
      kind = "sound";
    }

    if (!kind) {
      continue;
    }
    ranked.push({ name, kind, rank: KIND_RANK[kind] });
  }

  ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return ranked;
}

export function suggestPokemon(query: string, limit = SUGGESTION_LIMIT): string[] {
  return rankPokemon(query)
    .slice(0, limit)
    .map((item) => item.name);
}

export function resolvePokemonQuery(query: string): string {
  const trimmed = query.trim();
  const matches = rankPokemon(trimmed);
  if (matches.length === 0) {
    return trimmed;
  }
  const top = matches[0];
  if (top.kind === "exact" || top.kind === "typo" || top.kind === "sound" || top.kind === "wildcard") {
    return top.name;
  }
  if (top.kind === "prefix" && matches.filter((item) => item.kind === "prefix").length === 1) {
    return top.name;
  }
  return trimmed;
}

export function printDocument(documentHtml: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.srcdoc = documentHtml;

    const cleanup = () => {
      iframe.remove();
    };

    iframe.onload = () => {
      const frameWindow = iframe.contentWindow;
      const images = [...(iframe.contentDocument?.querySelectorAll("img") ?? [])];
      if (!frameWindow) {
        cleanup();
        reject(new Error("Could not open the print dialog"));
        return;
      }
      const go = () => {
        frameWindow.addEventListener("afterprint", cleanup, { once: true });
        frameWindow.focus();
        frameWindow.print();
        resolve();
        window.setTimeout(cleanup, 120000);
      };
      const pending = images.filter((image) => !image.complete);
      if (pending.length === 0) {
        go();
        return;
      }
      let left = pending.length;
      const done = () => {
        left -= 1;
        if (left <= 0) {
          go();
        }
      };
      for (const image of pending) {
        image.addEventListener("load", done, { once: true });
        image.addEventListener("error", done, { once: true });
      }
    };

    document.body.appendChild(iframe);
  });
}

export function printColoringPng(pngBase64: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.srcdoc = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { margin: 0.45in; }
      html, body {
        margin: 0;
        background: #fff;
      }
      img {
        display: block;
        width: 100%;
        height: auto;
        max-height: 100vh;
        object-fit: contain;
        page-break-inside: avoid;
      }
    </style>
  </head>
  <body>
    <img src="data:image/png;base64,${pngBase64}" alt="" />
  </body>
</html>`;

    const cleanup = () => {
      iframe.remove();
    };

    iframe.onload = () => {
      const frameWindow = iframe.contentWindow;
      const image = iframe.contentDocument?.querySelector("img");
      if (!frameWindow || !image) {
        cleanup();
        reject(new Error("Could not open the print dialog"));
        return;
      }
      const go = () => {
        frameWindow.addEventListener("afterprint", cleanup, { once: true });
        frameWindow.focus();
        frameWindow.print();
        resolve();
        window.setTimeout(cleanup, 120000);
      };
      if (image.complete) {
        go();
      } else {
        image.onload = go;
        image.onerror = () => {
          cleanup();
          reject(new Error("Could not load the coloring page for printing"));
        };
      }
    };

    document.body.appendChild(iframe);
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
