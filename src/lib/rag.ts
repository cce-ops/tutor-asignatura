// RAG (Retrieval-Augmented Generation) gratuito en el navegador.
//
// Estrategia:
// - Chunking por secciones (encabezados/parrafos) con solapamiento.
// - Embeddings con la API gratuita de Gemini (text-embedding-004) usando la
//   API key del alumno (BYOK).
// - Almacenamiento persistente en IndexedDB (sin backend, sin coste).
// - Recuperacion por MMR (Maximal Marginal Relevance) para diversidad.
// - Query expansion: genera variantes de la pregunta para mejorar recall.
// - Cache por hash: no re-embedea si los apuntes no han cambiado.
//
// Si algo falla, el caller debe caer al modo clasico de "context-stuffing".

const DB_NAME = "tutor-rag";
const DB_VERSION = 2;
const STORE_NAME = "chunks";
const META_STORE = "meta";
const EMBED_MODEL = "text-embedding-004";
const EMBED_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:batchEmbedContents?key=${encodeURIComponent(key)}`;

export interface RagChunk {
  id: string;
  source: string;
  section: string;
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

// ---------- Hash (para cache) ----------

async function hashText(text: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // fallback simple
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

// ---------- Chunking por secciones ----------

export function chunkText(
  text: string,
  source: string,
  chunkSize = 900,
  overlap = 150,
): RagChunk[] {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];

  // 1. Dividir por secciones (encabezados Markdown o bloques separados por línea en blanco)
  const sections: { title: string; body: string }[] = [];
  const lines = cleaned.split("\n");
  let currentTitle = source;
  let currentBody: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headerMatch) {
      if (currentBody.length > 0) {
        sections.push({ title: currentTitle, body: currentBody.join("\n").trim() });
      }
      currentTitle = headerMatch[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    sections.push({ title: currentTitle, body: currentBody.join("\n").trim() });
  }

  // Si no hay secciones (texto plano sin encabezados), tratar todo como una sección
  if (sections.length === 0) {
    sections.push({ title: source, body: cleaned });
  }

  // 2. Chunk dentro de cada sección si es muy larga
  const chunks: RagChunk[] = [];
  let idx = 0;
  for (const sec of sections) {
    if (!sec.body) continue;
    if (sec.body.length <= chunkSize) {
      if (sec.body.length > 40) {
        chunks.push({ id: `${source}#${idx}`, source, section: sec.title, text: sec.body, embedding: [] });
        idx += 1;
      }
      continue;
    }
    // chunk con solapamiento, cortando en límites de frase
    let i = 0;
    while (i < sec.body.length) {
      const end = Math.min(i + chunkSize, sec.body.length);
      let slice = sec.body.slice(i, end);
      if (end < sec.body.length) {
        const lastNl = slice.lastIndexOf("\n");
        const lastDot = slice.lastIndexOf(". ");
        const cut = Math.max(lastNl, lastDot);
        if (cut > chunkSize * 0.5) {
          slice = slice.slice(0, cut + 1);
        }
      }
      const trimmed = slice.trim();
      if (trimmed.length > 40) {
        chunks.push({ id: `${source}#${idx}`, source, section: sec.title, text: trimmed, embedding: [] });
        idx += 1;
      }
      const advance = Math.max(1, slice.length - overlap);
      i += advance;
      if (i >= sec.body.length) break;
    }
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
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Error abriendo IndexedDB"));
  });
}

export async function clearRagStore(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, META_STORE], "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Error limpiando store"));
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

// ---------- Meta (hash de apuntes) ----------

async function saveMeta(key: string, value: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Error guardando meta"));
  });
  db.close();
}

async function loadMeta(key: string): Promise<string | null> {
  const db = await openDb();
  const val = await new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve((req.result as { value: string } | undefined)?.value ?? null);
    req.onerror = () => reject(req.error ?? new Error("Error leyendo meta"));
  });
  db.close();
  return val;
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
    if (i + BATCH < texts.length) await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

// ---------- Indexación con cache por hash ----------

export async function indexApuntes(
  apiKey: string,
  apuntesText: string,
  sources: { file: string }[],
  onProgress?: (p: RagProgress) => void,
): Promise<RagResult> {
  const textHash = await hashText(apuntesText);

  // Cache: si el hash coincide, no re-embedear
  const cachedHash = await loadMeta("apuntes_hash").catch(() => null);
  const existingChunks = await loadAllChunks().catch(() => []);
  if (cachedHash === textHash && existingChunks.length > 0) {
    onProgress?.({ stage: "ready", done: existingChunks.length, total: existingChunks.length, message: `Cache: ${existingChunks.length} fragmentos (sin re-indexar)` });
    return { chunks: existingChunks, progress: { stage: "ready", done: existingChunks.length, total: existingChunks.length } };
  }

  onProgress?.({ stage: "chunking", done: 0, total: 1, message: "Dividiendo en chunks…" });
  const allChunks: RagChunk[] = [];
  const fileSections = apuntesText.split(/===== Fuente: (.+?) =====/);
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
  await saveMeta("apuntes_hash", textHash);

  onProgress?.({ stage: "ready", done: allChunks.length, total: allChunks.length, message: `Indexados ${allChunks.length} fragmentos` });
  return { chunks: allChunks, progress: { stage: "ready", done: allChunks.length, total: allChunks.length } };
}

// ---------- Query expansion ----------

export async function expandQuery(apiKey: string, query: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Genera 2 variantes cortas de la siguiente pregunta de un alumno de ingeniería, usando sinónimos y reformulaciones. Devuelve SOLO las 2 variantes, una por línea, sin numeración ni explicación.\n\nPregunta: ${query}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 120 },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [query];
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const variants = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 5)
      .slice(0, 2);
    return [query, ...variants];
  } catch {
    return [query];
  }
}

// ---------- MMR retrieval ----------

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

function mmr(
  queryEmb: number[],
  candidates: { chunk: RagChunk; score: number }[],
  k: number,
  lambda = 0.7,
): RagChunk[] {
  const selected: RagChunk[] = [];
  const selectedEmbs: number[][] = [];
  const remaining = [...candidates];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const relevance = cand.score;
      let maxSim = 0;
      for (const se of selectedEmbs) {
        const sim = cosine(cand.chunk.embedding, se);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    selected.push(chosen.chunk);
    selectedEmbs.push(chosen.chunk.embedding);
  }
  return selected;
}

export async function retrieveTopK(
  apiKey: string,
  query: string,
  k = 6,
  useExpansion = true,
): Promise<{ text: string; sources: string[] }> {
  const chunks = await loadAllChunks();
  if (chunks.length === 0) {
    return { text: "", sources: [] };
  }

  // Query expansion
  const queries = useExpansion ? await expandQuery(apiKey, query) : [query];

  // Embed all queries
  const queryEmbs = await embedTexts(apiKey, queries);

  // Para cada query, puntuar todos los chunks
  const candidateMap = new Map<string, { chunk: RagChunk; score: number }>();
  for (const qEmb of queryEmbs) {
    for (const c of chunks) {
      const score = cosine(qEmb, c.embedding);
      const existing = candidateMap.get(c.id);
      if (!existing || score > existing.score) {
        candidateMap.set(c.id, { chunk: c, score });
      }
    }
  }
  const candidates = Array.from(candidateMap.values());

  // MMR para diversidad
  const selected = mmr(queryEmbs[0], candidates, k);

  // Deduplicación por similitud alta
  const deduped: RagChunk[] = [];
  for (const c of selected) {
    const isDup = deduped.some((d) => cosine(c.embedding, d.embedding) > 0.95);
    if (!isDup) deduped.push(c);
  }

  const sources = Array.from(new Set(deduped.map((s) => s.source)));
  const text = deduped
    .map((s, i) => `--- Fragmento ${i + 1} (${s.source}${s.section ? " · " + s.section : ""}) ---\n${s.text}`)
    .join("\n\n");
  return { text, sources };
}

export function hasIndexedChunks(): Promise<boolean> {
  return loadAllChunks().then((c) => c.length > 0);
}