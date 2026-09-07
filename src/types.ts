export type WorkspaceView = {
  title: string;
  source: string;
  source_url: string | null;
  page_id: number | null;
  original_png_base64: string;
  coloring_png_base64: string;
  threshold: number;
};

export type PreviewView = {
  coloring_png_base64: string;
  threshold: number;
};

export type SearchHit = {
  title: string;
  original_url: string;
  thumb_data_url: string | null;
};

export type PageSummary = {
  id: number;
  title: string;
  source: string;
  source_url: string | null;
  threshold: number;
  created_at: string;
  updated_at: string;
  thumb_png_base64: string;
};

export function pngUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "coloring-page";
}
