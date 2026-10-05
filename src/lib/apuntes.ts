import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import { extractRawText } from "mammoth";
import JSZip from "jszip";

// El worker de pdf.js se auto-hospeda en public/ (ver postinstall en
// package.json) para no ejecutar JS de un CDN en nuestro origen.
// Actualizar la copia al cambiar la versión de pdfjs-dist.

// Límite por archivo y total para no saturar la cuota gratuita de Gemini.
const MAX_CHARS_PER_FILE = 120_000;
const MAX_TOTAL_CHARS = 400_000;

let workerReady = false;
function ensureWorker() {
  if (!workerReady && typeof window !== "undefined") {
    GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    workerReady = true;
  }
}

export interface ApunteSource {
  file: string;
  chars: number;
  truncated: boolean;
  skipped?: string;
}

export interface ApuntesLoad {
  text: string;
  sources: ApunteSource[];
}

async function extractPdf(buf: ArrayBuffer): Promise<string> {
  ensureWorker();
  const pdf = await getDocument({ data: buf }).promise;
  const pages: string[] = [];
  const total = Math.min(pdf.numPages, 300);
  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => ("str" in it ? (it.str as string) : ""))
      .join(" ");
    if (line.trim()) pages.push(line);
  }
  return pages.join("\n\n");
}

async function extractPptx(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
      return na - nb;
    });
  if (slides.length === 0) throw new Error("PPTX sin diapositivas legibles");
  const out: string[] = [];
  let n = 0;
  for (const name of slides) {
    const xml = await zip.files[name].async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const nodes = doc.getElementsByTagName("a:t");
    const texts: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i].textContent?.trim();
      if (t) texts.push(t);
    }
    n += 1;
    if (texts.length > 0) out.push(`[Diapositiva ${n}]\n${texts.join(" ")}`);
  }
  return out.join("\n\n");
}

async function extractOne(file: string): Promise<string> {
  const res = await fetch(`/apuntes/${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`No se pudo descargar ${file} (${res.status})`);
  const lower = file.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".txt")) {
    return await res.text();
  }
  const buf = await res.arrayBuffer();
  if (lower.endsWith(".pdf")) return await extractPdf(buf);
  if (lower.endsWith(".docx")) {
    const r = await extractRawText({ arrayBuffer: buf });
    return r.value;
  }
  if (lower.endsWith(".pptx")) return await extractPptx(buf);
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv")) {
    return extractSheet(buf);
  }
  throw new Error(`Formato no soportado: ${file} (usa PDF, DOCX, PPTX, XLSX, MD o TXT)`);
}

function cellText(cell: Element, tag: string): string {
  const el = cell.getElementsByTagName(tag)[0];
  return el?.textContent ?? "";
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Lector mínimo de XLSX con JSZip (sin dependencias extra): resuelve
 * sharedStrings, nombres de hoja vía workbook.xml + rels y celdas por tipo.
 */
async function extractSheet(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const file = async (name: string): Promise<string> => {
    const f = zip.file(name);
    if (!f) throw new Error(`Excel sin ${name}`);
    return f.async("string");
  };
  const parser = new DOMParser();
  const parse = (xml: string): Document =>
    parser.parseFromString(xml, "application/xml");

  const wb = parse(await file("xl/workbook.xml"));
  const rels = parse(await file("xl/_rels/workbook.xml.rels"));
  const targets = new Map<string, string>();
  const relEls = rels.getElementsByTagName("Relationship");
  for (let i = 0; i < relEls.length; i++) {
    const id = relEls[i].getAttribute("Id") ?? "";
    const target = relEls[i].getAttribute("Target") ?? "";
    if (id && target) targets.set(id, target);
  }
  const sheets: { name: string; path: string }[] = [];
  const sheetEls = wb.getElementsByTagName("sheet");
  for (let i = 0; i < sheetEls.length; i++) {
    const name = sheetEls[i].getAttribute("name") ?? `Hoja${i + 1}`;
    const rid =
      sheetEls[i].getAttribute("r:id") ??
      sheetEls[i].getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      ) ??
      "";
    const target = targets.get(rid);
    if (target) sheets.push({ name, path: `xl/${target.replace(/^\//, "")}` });
  }
  if (sheets.length === 0) throw new Error("Excel sin hojas legibles");

  const shared: string[] = [];
  try {
    const ss = parse(await file("xl/sharedStrings.xml"));
    const siEls = ss.getElementsByTagName("si");
    for (let i = 0; i < siEls.length; i++) {
      const tEls = siEls[i].getElementsByTagName("t");
      let text = "";
      for (let j = 0; j < tEls.length; j++) text += tEls[j].textContent ?? "";
      shared.push(text);
    }
  } catch {
    // sin sharedStrings: se usan valores inline
  }

  const out: string[] = [];
  for (const sheet of sheets.slice(0, 10)) {
    const doc = parse(await file(sheet.path));
    const rowEls = doc.getElementsByTagName("row");
    const lines: string[] = [];
    for (let i = 0; i < rowEls.length; i++) {
      const cellEls = rowEls[i].getElementsByTagName("c");
      const parts: { col: number; v: string }[] = [];
      let maxCol = -1;
      for (let j = 0; j < cellEls.length; j++) {
        const c = cellEls[j];
        const ref = c.getAttribute("r") ?? "";
        const col = colToIndex(ref.replace(/[^A-Za-z]/g, "") || "A");
        const t = c.getAttribute("t");
        let v: string;
        if (t === "s") {
          const idx = parseInt(cellText(c, "v"), 10);
          v = Number.isFinite(idx) ? (shared[idx] ?? "") : "";
        } else if (t === "inlineStr") {
          v = cellText(c, "t");
        } else if (t === "b") {
          const raw = cellText(c, "v");
          v = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
        } else {
          v = cellText(c, "v");
        }
        parts.push({ col, v });
        if (col > maxCol) maxCol = col;
      }
      const arr: string[] = new Array(maxCol + 1).fill("");
      for (const p of parts) arr[p.col] = p.v;
      if (arr.join("").replace(/[\s,;]+/g, "")) lines.push(arr.join(","));
    }
    const text = lines.join("\n").slice(0, 40_000);
    if (text.trim()) out.push(`[Hoja: ${sheet.name}]\n${text}`);
  }
  if (out.length === 0) throw new Error("Excel sin celdas con texto legible");
  return out.join("\n\n");
}

/**
 * Lee public/apuntes/manifest.json y extrae el texto de cada archivo.
 * Si no hay manifiesto, usa el md de ejemplo como antes.
 */
export async function loadApuntesFromFolder(): Promise<ApuntesLoad> {
  let files: string[];
  try {
    const res = await fetch("/apuntes/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("sin manifiesto");
    const data = (await res.json()) as { files?: unknown };
    if (!Array.isArray(data.files) || data.files.length === 0) {
      throw new Error("manifiesto vacío");
    }
    files = data.files as string[];
  } catch {
    files = ["apuntes-ejemplo.md"];
  }

  const chunks: string[] = [];
  const sources: ApunteSource[] = [];
  let total = 0;
  for (const file of files) {
    if (total >= MAX_TOTAL_CHARS) {
      sources.push({
        file,
        chars: 0,
        truncated: true,
        skipped: "límite total alcanzado",
      });
      continue;
    }
    try {
      const raw = await extractOne(file);
      const cleaned = raw.replace(/\r/g, "").trim();
      let truncated = false;
      let kept = cleaned;
      const room = MAX_TOTAL_CHARS - total;
      const cap = Math.min(MAX_CHARS_PER_FILE, room);
      if (cleaned.length > cap) {
        kept = cleaned.slice(0, cap) + "\n[…texto recortado por límite de tamaño…]";
        truncated = true;
      }
      total += kept.length;
      sources.push({ file, chars: kept.length, truncated });
      chunks.push(`===== Fuente: ${file} =====\n${kept}`);
    } catch (e) {
      sources.push({
        file,
        chars: 0,
        truncated: false,
        skipped: e instanceof Error ? e.message : "error de lectura",
      });
    }
  }
  return { text: chunks.join("\n\n"), sources };
}
