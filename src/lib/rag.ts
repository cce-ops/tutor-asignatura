// RAG (Retrieval-Augmented Generation) gratuito en el navegador.
//
// Estrategia:
// - Chunking del texto de los apuntes.
// - Embeddings con la API gratuita de Gemini (text-embedding-004) usando la
//   API key del alumno (BYOK).
// - Almacenamiento persistente en IndexedDB (sin backend, sin coste).
// - Recuperación por similitud coseno (top-k) y paso solo de los chunks
//   relevantes al modelo generativo.
//
// Si algo falla (sin key, cuota agotada, IndexedDB bloqueado), el caller
// debe caer al modo clásico de "context-stuffing" (todo el texto en el prompt).

const DB_NAME = "tutor-rag";
const DB_VERSION = 1;
const STORE_NAME = "chunks";
const EMBED_MODEL = "text-embedding-004";
const EMBED_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:batchEmbedContents?key=${encodeURIComponent(key)}`;

export interface RagChunk {
  id: string;
  source: string;
  text: string;
  embedding: number[];
}

export interface RagProgress {
  stage: "idle" | "chunking" | "embedding" | "storing" | "ready" | "error";
  done: number;
  total: number;
  message?: string;
}

export interface RagResult {
  chunks: RagChunk[];
  progress: RagProgress;
}

// ---------- Chunking ----------

export function chunkText(
  text: string,
  source: string,
  chunkSize = 900,
  overlap = 150,
): RagChunk[] {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  const chunks: RagChunk[] = [];
  let i = 0;
  let idx = 0;
  while (i < cleaned.length) {
    const end = Math.min(i + chunkSize, cleaned.length);
    let slice = cleaned.slice(i, end);
    // intentar cortar en límite de párrafo o frase para no partir a mitad
    if (end < cleaned.length) {
      const lastNl = slice.lastIndexOf("\n");
      const lastDot = slice.lastIndexOf(". ");
      const cut = Math.max(lastNl, lastDot);
      if (cut > chunkSize * 0.5) {
        slice = slice.slice(0, cut + 1);
      }
    }
    const trimmed = slice.trim();
    if (trimmed.length > 40) {
      chunks.push({
        id: `${source}#${idx}`,
        source,
        text: trimmed,
        embedding: [],
      });
      idx += 1;
    }
    const advance = Math.max(1, slice.length - overlap);
    i += advance;
    if (i >= cleaned.length) break;
  }
  return chunks;
}

// ---------- IndexedDB helpers ----------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB no disponible"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("source", "source", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Error abriendo IndexedDB"));
  });
}

export async function clearRagStore(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("Error limpiando store"));
  });
  db.close();
}

export async function saveChunks(chunks: RagChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const c of chunks) store.put(c);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Error guardando chunks"));
    tx.onabort = () => reject(tx.error ?? new Error("Transacción abortada"));
  });
  db.close();
}

export async function loadAllChunks(): Promise<RagChunk[]> {
  const db = await openDb();
  const chunks = await new Promise<RagChunk[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as RagChunk[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("Error leyendo chunks"));
  });
  db.close();
  return chunks;
}

// ---------- Embeddings (Gemini, gratuito) ----------

async function embedBatch(
  apiKey: string,
  texts: string[],
): Promise<number[][]> {
  const url = EMBED_ENDPOINT(EMBED_MODEL, apiKey);
  const body = {
    requests: texts.map((t) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: t }] },
    })),
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Embedding falló (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embeddings?: { values: number[] }[] };
  const embs = data.embeddings ?? [];
  if (embs.length !== texts.length) {
    throw new Error("Número de embeddings recibido no coincide");
  }
  return embs.map((e) => e.values);
}

export async function embedTexts(
  apiKey: string,
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const BATCH = 50;
  const out: number[][] = [];
  let done = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const embs = await embedBatch(apiKey, batch);
    out.push(...embs);
    done += batch.length;
    onProgress?.(done, texts.length);
    // pequeña pausa para no saturar la cuota gratuita
    if (i + BATCH < texts.length) await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

// ---------- Indexación ----------

export async function indexApuntes(
  apiKey: string,
  apuntesText: string,
  sources: { file: string }[],
  onProgress?: (p: RagProgress) => void,
): Promise<RagResult> {
  onProgress?.({ stage: "chunking", done: 0, total: 1, message: "Dividiendo en chunks…" });
  // chunk por fuente si es posible; si no, chunk del texto completo
  const allChunks: RagChunk[] = [];
  const fileSections = apuntesText.split(/===== Fuente: (.+?) =====/);
  // fileSections: [pre, file1, text1, file2, text2, ...]
  if (fileSections.length >= 3) {
    for (let i = 1; i < fileSections.length; i += 2) {
      const file = fileSections[i].trim();
      const text = fileSections[i + 1] ?? "";
      allChunks.push(...chunkText(text, file));
    }
  } else {
    allChunks.push(...chunkText(apuntesText, "apuntes"));
  }
  if (allChunks.length === 0) {
    return { chunks: [], progress: { stage: "ready", done: 0, total: 0, message: "Sin texto indexable" } };
  }

  onProgress?.({ stage: "embedding", done: 0, total: allChunks.length, message: "Generando embeddings…" });
  const texts = allChunks.map((c) => c.text);
  const embs = await embedTexts(apiKey, texts, (d, t) => {
    onProgress?.({ stage: "embedding", done: d, total: t, message: `Embeddings ${d}/${t}` });
  });
  allChunks.forEach((c, i) => (c.embedding = embs[i]));

  onProgress?.({ stage: "storing", done: 0, total: allChunks.length, message: "Guardando en IndexedDB…" });
  await clearRagStore();
  await saveChunks(allChunks);

  onProgress?.({ stage: "ready", done: allChunks.length, total: allChunks.length, message: `Indexados ${allChunks.length} chunks` });
  return { chunks: allChunks, progress: { stage: "ready", done: allChunks.length, total: allChunks.length } };
}

// ---------- Retrieval ----------

export async function retrieveTopK(
  apiKey: string,
  query: string,
  k = 6,
): Promise<{ text: string; sources: string[] }> {
  const chunks = await loadAllChunks();
  if (chunks.length === 0) {
    return { text: "", sources: [] };
  }
  // embed query
  const qEmb = (await embedTexts(apiKey, [query]))[0];
  const scored = chunks.map((c) => ({
    chunk: c,
    score: cosine(qEmb, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  const sources = Array.from(new Set(top.map((s) => s.chunk.source)));
  const text = top
    .map((s, i) => `--- Fragmento ${i + 1} (${s.chunk.source}) ---\n${s.chunk.text}`)
    .join("\n\n");
  return { text, sources };
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------- Helpers ----------

export function hasIndexedChunks(): Promise<boolean> {
  return loadAllChunks().then((c) => c.length > 0);
}