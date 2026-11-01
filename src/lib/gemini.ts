export const GEMINI_MODELS = [
  { id: "gemini-flash-latest", label: "Flash Latest (Alias actualizado automáticamente)", recommended: true },
  { id: "gemini-3.5-flash-lite", label: "Flash-Lite 3.5 (recomendado: más cuota)" },
  { id: "gemini-3.1-flash-lite", label: "Flash-Lite 3.1 (alternativa con cuota)" },
  { id: "gemini-3.5-flash", label: "Flash 3.5 (mejor calidad)" },
  { id: "gemini-3.6-flash", label: "Flash 3.6" },
  { id: "gemini-3.7-flash", label: "Flash 3.7" },
  { id: "gemini-3.8-flash", label: "Flash 3.8 (más nuevo)" },
] as const;

export const DEFAULT_MODEL = "gemini-flash-latest";

export type ChatRole = "user" | "model";

export interface ChatTurn {
  role: ChatRole;
  text: string;
}

export interface OutgoingFile {
  name: string;
  mimeType: string;
  /** base64 sin prefijo data: */
  base64: string;
  /** true si es texto plano y preferimos enviarlo como texto */
  asText?: string;
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

import { extractAttachment } from "./apuntes";

export function fileToOutgoing(file: File): Promise<OutgoingFile> {
  const lower = file.name.toLowerCase();
  // Word/Excel/PowerPoint: Gemini no los acepta como adjunto directo,
  // se extrae el texto en el navegador igual que con los apuntes.
  if (
    lower.endsWith(".docx") ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".pptx")
  ) {
    return file
      .arrayBuffer()
      .then(async (buf) => {
        const text = await extractAttachment(file.name, buf);
        return {
          name: file.name,
          mimeType: "text/plain",
          base64: "",
          asText: capText(text),
        };
      })
      .catch((e) => {
        throw new Error(
          e instanceof Error ? e.message : `No se pudo leer ${file.name}`,
        );
      });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("No se pudo leer el archivo"));
        return;
      }
      // data:<mime>;base64,<datos>
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      const isText =
        file.type.startsWith("text/") ||
        file.name.endsWith(".txt") ||
        file.name.endsWith(".md");
      if (isText) {
        try {
          const text = atob(base64);
          const decoded = decodeURIComponent(
            Array.prototype.map
              .call(text, (c: string) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
              .join(""),
          );
          resolve({
            name: file.name,
            mimeType: file.type || "text/plain",
            base64,
            asText: capText(decoded),
          });
          return;
        } catch {
          // si falla la decodificación, seguir como binario
        }
      }
      resolve({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        base64,
      });
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

export function capText(text: string): string {
  const MAX = 60_000;
  return text.length > MAX
    ? text.slice(0, MAX) + "\n[…adjunto recortado por tamaño…]"
    : text;
}

function toGeminiParts(userText: string, files: OutgoingFile[]): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const f of files) {
    if (f.asText !== undefined) {
      parts.push({ text: `--- Archivo adjunto: ${f.name} ---\n${f.asText}` });
    } else {
      parts.push({
        inline_data: { mime_type: f.mimeType, data: f.base64 },
      });
      parts.push({ text: `(Archivo adjunto: ${f.name})` });
    }
  }
  parts.push({ text: userText || "(sin mensaje, revisa los archivos adjuntos)" });
  return parts;
}

interface RequestError extends Error {
  status?: number;
  /** ¿tiene sentido reintentar el mismo modelo unos segundos? */
  retryable: boolean;
  /** ¿tiene sentido probar con el siguiente modelo? */
  next: boolean;
}

function makeError(
  message: string,
  opts: { status?: number; retryable: boolean; next: boolean },
): RequestError {
  const e = new Error(message) as RequestError;
  e.status = opts.status;
  e.retryable = opts.retryable;
  e.next = opts.next;
  return e;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Un solo intento contra un modelo concreto. */
async function requestOnce(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatTurn[];
  userText: string;
  files: OutgoingFile[];
}): Promise<string> {
  const { apiKey, model, systemPrompt, history, userText, files } = args;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const contents = [
    ...history.map((t) => ({
      role: t.role,
      parts: [{ text: t.text }] as GeminiPart[],
    })),
    { role: "user" as const, parts: toGeminiParts(userText, files) },
  ];

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    });
  } catch {
    throw makeError("Sin conexión con Gemini. Revisa tu internet.", {
      retryable: true,
      next: true,
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const lower = body.toLowerCase();
    const modelGone =
      res.status === 404 ||
      lower.includes("no longer available") ||
      lower.includes("not found") ||
      lower.includes("not supported");
    if (modelGone) {
      throw makeError(
        `El modelo ${model} ya no está disponible (${res.status}). Se probará con el siguiente.`,
        { status: res.status, retryable: false, next: true },
      );
    }
    if (res.status === 400) {
      throw makeError(
        "Clave rechazada o petición inválida. Revisa la API key. Detalle: " +
          body.slice(0, 300),
        { status: 400, retryable: false, next: false },
      );
    }
    if (res.status === 403) {
      throw makeError(
        "Acceso denegado (403). La key no tiene permiso o está restringida.",
        { status: 403, retryable: false, next: false },
      );
    }
    if (res.status === 429) {
      throw makeError(
        `Cuota agotada en ${model} (429). Reintentando y pasando al siguiente modelo…`,
        { status: 429, retryable: true, next: true },
      );
    }
    if (res.status >= 500) {
      throw makeError(`Error temporal de Gemini (${res.status}). Reintentando…`, {
        status: res.status,
        retryable: true,
        next: true,
      });
    }
    throw makeError(`Error de Gemini (${res.status}). ${body.slice(0, 300)}`, {
      status: res.status,
      retryable: true,
      next: true,
    });
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? "";
  if (!text) {
    const reason = data.promptFeedback?.blockReason;
    throw makeError(
      reason
        ? `Gemini bloqueó la respuesta (${reason}). Reformula o quita datos personales.`
        : "Gemini devolvió una respuesta vacía.",
      { retryable: true, next: true },
    );
  }
  return text;
}

export async function sendToGemini(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatTurn[];
  userText: string;
  files: OutgoingFile[];
}): Promise<string> {
  const r = await sendToGeminiWithFallback(args);
  return r.text;
}

/**
 * Envía con reintentos por modelo y fallback en bucle al siguiente modelo
 * hasta conseguir respuesta o hasta que fallen todos.
 */
export async function sendToGeminiWithFallback(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatTurn[];
  userText: string;
  files: OutgoingFile[];
  onStatus?: (msg: string) => void;
}): Promise<{ text: string; modelUsed: string }> {
  const { model, onStatus, ...rest } = args;
  const known = GEMINI_MODELS.map((m) => m.id);
  const ordered = [model, ...known.filter((id) => id !== model)];
  const failures: string[] = [];

  for (const modelId of ordered) {
    // Hasta 3 intentos por modelo (~unos segundos con backoff 1s, 2s)
    const delays = [1000, 2000];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        onStatus?.(
          ordered.length > 1
            ? `Probando ${modelId} (intento ${attempt}/3)…`
            : `Llamando a ${modelId} (intento ${attempt}/3)…`,
        );
        const text = await requestOnce({ ...rest, apiKey: args.apiKey, model: modelId });
        return { text, modelUsed: modelId };
      } catch (e) {
        const err = e as RequestError;
        const canRetry = err.retryable !== false;
        const canNext = err.next !== false;
        if (!canRetry && !canNext) throw e;
        if (!canRetry && canNext) {
          failures.push(`${modelId}: ${err.message}`);
          onStatus?.(`${modelId} no disponible, pasando al siguiente…`);
          break; // al siguiente modelo sin reintentar
        }
        if (attempt < 3) {
          onStatus?.(`${modelId} falló (${err.message}). Reintentando…`);
          await sleep(delays[attempt - 1] ?? 2000);
        } else {
          failures.push(`${modelId}: ${err.message}`);
          onStatus?.(`${modelId} falló tras 3 intentos, pasando al siguiente…`);
        }
      }
    }
  }
  throw new Error(
    "Fallaron todos los modelos de Gemini. " + failures.join(" | ").slice(0, 800),
  );
}

export function buildSystemPrompt(apuntes: string): string {
  return `Eres un tutor de ingeniería. Respondes en español, de forma clara y directa.
Usa EXCLUSIVAMENTE los apuntes de la asignatura como fuente principal. Si algo no está en los apuntes, dilo y responde con conocimiento general marcándolo como tal.
No inventes fórmulas ni datos de los apuntes. Revisa siempre unidades y órdenes de magnitud.

FORMATO OBLIGATORIO (la respuesta se renderiza como Markdown + LaTeX):
- Usa encabezados ## y ###, negritas **texto**, listas con - o 1. y párrafos separados. No uses ### pegado al texto sin espacio.
- Fórmulas inline con $...$ (ej. $\\sigma = N/A$) y centradas con $$...$$ para las importantes.
- Unidades en texto normal dentro de la fórmula con \\text{} (ej. $210\\,\\text{GPa}$).
- Nunca dejes sintaxis LaTeX rota ni marcadores sueltos: si una fórmula no compila, escríbela en texto plano.

FUNCIONAMIENTO (un solo chat):
- Si el alumno adjunta un trabajo o pega su solución: MODO CORRECCIÓN.
  1. Indica qué está bien (breve).
  2. Señala cada error con su causa (fórmula mal aplicada, unidades, concepto).
  3. Da feedback accionable para corregirlo, sin hacer el trabajo completo si es un ejercicio formativo: guía con pasos.
  4. Cierra con una nota orientativa (0-10) y qué falta para el 10.
- Si hace una pregunta sobre los apuntes: MODO PREGUNTAS. Explica paso a paso,
  con un ejemplo numérico corto cuando aplique, y sugiere 1 pregunta de
  autoevaluación al final.
- Si el mensaje es ambiguo, pregunta qué necesita antes de responder.

APUNTES DE LA ASIGNATURA:
---
${apuntes.slice(0, 60000)}
---`;
}
