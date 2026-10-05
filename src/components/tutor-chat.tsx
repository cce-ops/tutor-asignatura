"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import MessageBody from "@/components/message-body";
import { loadApuntesFromFolder, type ApunteSource } from "@/lib/apuntes";
import {
  DEFAULT_MODEL,
  GEMINI_MODELS,
  buildSystemPrompt,
  fileToOutgoing,
  sendToGeminiWithFallback,
  type ChatTurn,
  type OutgoingFile,
} from "@/lib/gemini";

interface Message extends ChatTurn {
  files?: string[];
  modelUsed?: string;
}

const API_KEY_LS = "tutor.apiKey";
const MODEL_LS = "tutor.model";
const APUNTES_LS = "tutor.apuntes";

export default function TutorChat() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [apuntes, setApuntes] = useState("Cargando apuntes…");
  const [mode, setMode] = useState<"preguntar" | "corregir">("preguntar");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<OutgoingFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [sources, setSources] = useState<ApunteSource[]>([]);
  const [apuntesEdited, setApuntesEdited] = useState(false);
  const [apuntesLoading, setApuntesLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function reloadFromFolder() {
    setApuntesLoading(true);
    try {
      const loaded = await loadApuntesFromFolder();
      setApuntes(loaded.text || "No se pudo extraer texto de los archivos.");
      setSources(loaded.sources);
      setApuntesEdited(false);
      try {
        localStorage.removeItem(APUNTES_LS);
      } catch {
        // ignorar
      }
    } catch {
      setApuntes("Pega aquí los apuntes de la asignatura.");
      setSources([]);
    } finally {
      setApuntesLoading(false);
    }
  }

  useEffect(() => {
    try {
      const k = localStorage.getItem(API_KEY_LS);
      const m = localStorage.getItem(MODEL_LS);
      const a = localStorage.getItem(APUNTES_LS);
      if (k) setApiKey(k);
      if (m && GEMINI_MODELS.some((x) => x.id === m)) {
        setModel(m);
      } else {
        // Modelos antiguos (p. ej. gemini-2.5-*) ya no existen: migrar al actual
        setModel(DEFAULT_MODEL);
      }
      if (a) {
        setApuntes(a);
        setApuntesEdited(true);
        setApuntesLoading(false);
        // Cargar solo la lista de fuentes en segundo plano
        loadApuntesFromFolder()
          .then((loaded) => setSources(loaded.sources))
          .catch(() => {});
      } else {
        void reloadFromFolder();
      }
    } catch {
      void reloadFromFolder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function persist(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignorar
    }
  }

  async function onAttach(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    try {
      const converted = await Promise.all(files.map(fileToOutgoing));
      const total = [...pending, ...converted].reduce(
        (n, f) => n + f.base64.length,
        0,
      );
      if (total > 20_000_000) {
        setError("Archivos demasiado grandes (límite ~15 MB en total).");
        return;
      }
      setPending((p) => [...p, ...converted]);
    } catch {
      setError("No se pudieron leer los archivos.");
    } finally {
      e.target.value = "";
    }
  }

  async function onSend() {
    setError(null);
    const key = apiKey.trim();
    if (!key) {
      setError("Pega tu API key de Gemini (cada alumno usa la suya).");
      return;
    }
    if (!input.trim() && pending.length === 0) return;
    const userText = input.trim();
    const files = pending;
    setInput("");
    setPending([]);
    setLoading(true);
    setStatus("Enviando…");
    const userMsg: Message = {
      role: "user",
      text: userText,
      files: files.map((f) => f.name),
    };
    const history: ChatTurn[] = [...messages, userMsg]
      .slice(-12)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
    // history incluye el mensaje actual; sendToGemini lo añade de nuevo,
    // así que quitamos el último para no duplicar
    const past = history.slice(0, -1);
    setMessages((m) => [...m, userMsg]);
    try {
      const { text: reply, modelUsed } = await sendToGeminiWithFallback({
        apiKey: key,
        model,
        systemPrompt: buildSystemPrompt(apuntes, mode),
        history: past,
        userText:
          mode === "corregir" && !userText
            ? "Corrige el trabajo adjunto según los apuntes y da feedback detallado."
            : userText,
        files,
        onStatus: (s) => setStatus(s),
      });
      if (modelUsed !== model) {
        setModel(modelUsed);
        persist(MODEL_LS, modelUsed);
      }
      setMessages((m) => [
        ...m,
        { role: "model", text: reply, modelUsed },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
      setStatus(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Tutor de la asignatura</h1>
          <p className="text-sm text-muted-foreground">
            Cada alumno pone su propia API key de Gemini. La key solo vive en
            su navegador.{" "}
            <a
              className="underline"
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
            >
              Conseguir key gratis
            </a>
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={mode === "preguntar" ? "default" : "outline"}
            onClick={() => setMode("preguntar")}
          >
            Preguntar
          </Button>
          <Button
            variant={mode === "corregir" ? "default" : "outline"}
            onClick={() => setMode("corregir")}
          >
            Corregir trabajo
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <label className="text-sm font-medium">API key de Gemini</label>
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                persist(API_KEY_LS, e.target.value);
              }}
              placeholder="AIza…"
              className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
            />
            <Button
              variant="outline"
              onClick={() => setShowKey((s) => !s)}
              title="Mostrar / ocultar"
            >
              {showKey ? "Ocultar" : "Ver"}
            </Button>
          </div>

          <label className="text-sm font-medium">Modelo</label>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              persist(MODEL_LS, e.target.value);
            }}
            className="h-9 rounded-lg border bg-background px-2 text-sm"
          >
            {GEMINI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          <label className="text-sm font-medium">
            Apuntes (los sube el profesor)
          </label>
          <textarea
            value={apuntes}
            onChange={(e) => {
              setApuntes(e.target.value);
              setApuntesEdited(true);
              persist(APUNTES_LS, e.target.value);
            }}
            rows={14}
            className="w-full rounded-lg border bg-background p-2 font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            El profesor sube PDF, Word (.docx), PowerPoint (.pptx), Excel
            (.xlsx), MD o TXT a <code>public/apuntes/</code> y los lista en{" "}
            <code>public/apuntes/manifest.json</code>. Luego redespliega.
            También puedes pegar aquí el texto para probar sin redesplegar
            (queda guardado en este navegador).
          </p>
          {apuntesLoading ? (
            <p className="text-xs text-muted-foreground">
              Leyendo archivos de la carpeta…
            </p>
          ) : (
            sources.length > 0 && (
              <div className="rounded-lg bg-secondary/60 p-2 text-xs">
                <p className="font-medium">Fuentes cargadas:</p>
                <ul className="list-disc pl-4">
                  {sources.map((s) => (
                    <li key={s.file}>
                      {s.file}
                      {s.skipped
                        ? ` — omitido: ${s.skipped}`
                        : ` (${s.chars.toLocaleString("es")} caracteres${s.truncated ? ", recortado" : ""})`}
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
          {apuntesEdited && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                Estás viendo texto editado en este navegador, no la carpeta.
              </p>
              <Button variant="outline" onClick={() => void reloadFromFolder()}>
                Recargar desde la carpeta
              </Button>
            </div>
          )}
        </section>

        <section className="flex min-h-[60vh] flex-col rounded-xl border bg-card">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {mode === "corregir"
                  ? "Adjunta tu trabajo en PDF/imagen o pega tu solución y pulsa Enviar."
                  : "Haz una pregunta sobre los apuntes para empezar."}
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground"
                    : "mr-auto max-w-[95%] rounded-lg bg-muted px-3 py-2 text-sm"
                }
              >
                {m.files && m.files.length > 0 && (
                  <div className="mb-1 text-xs opacity-80">
                    📎 {m.files.join(", ")}
                  </div>
                )}
                {m.role === "user" ? (
                  m.text || "(adjunto)"
                ) : (
                  <>
                    {m.modelUsed && (
                      <div className="mb-1 inline-block rounded-full bg-background/60 px-2 py-0.5 font-mono text-[0.65rem] opacity-70">
                        {m.modelUsed}
                      </div>
                    )}
                    <MessageBody text={m.text} />
                  </>
                )}
              </div>
            ))}
            {loading && (
              <p className="text-sm text-muted-foreground">
                {status ?? "Pensando con Gemini…"}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          {error && (
            <p className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="border-t p-3">
            {pending.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {pending.map((f, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs"
                  >
                    📎 {f.name}
                    <button
                      className="ml-1 underline"
                      onClick={() =>
                        setPending((p) => p.filter((_, j) => j !== i))
                      }
                    >
                      quitar
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={onAttach}
              />
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                Adjuntar
              </Button>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                placeholder={
                  mode === "corregir"
                    ? "Pega tu solución o describe qué entregar…"
                    : "Escribe tu pregunta…"
                }
                className="h-9 flex-1 rounded-lg border bg-background px-2 text-sm"
              />
              <Button onClick={() => void onSend()} disabled={loading}>
                {loading ? "…" : "Enviar"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Gratis con cuota de Gemini. En free tier Google puede usar el
              contenido para mejorar sus productos: no subas datos personales.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
