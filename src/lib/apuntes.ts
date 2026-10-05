import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import { extractRawText } from "mammoth";
import JSZip from "jszip";
import { read, utils } from "xlsx";

// Versión instalada de pdfjs-dist (actualizar si se actualiza el paquete).
const PDFJS_VERSION = "6.4.299";

// Límite por archivo y total para no saturar la cuota gratuita de Gemini.
const MAX_CHARS_PER_FILE = 120_000;
const MAX_TOTAL_CHARS = 400_000;

let workerReady = false;
function ensureWorker() {
  if (!workerReady && typeof window !== "undefined") {
    GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
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

function extractSheet(buf: ArrayBuffer): string {
  const wb = read(buf, { type: "array" });
  const out: string[] = [];
  for (const name of wb.SheetNames.slice(0, 10)) {
    const csv = utils.sheet_to_csv(wb.Sheets[name]);
    if (csv.trim()) out.push(`[Hoja: ${name}]\n${csv.slice(0, 40_000)}`);
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
