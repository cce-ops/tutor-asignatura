"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { extractAttachment } from "@/lib/apuntes";
import { capText, type OutgoingFile } from "@/lib/gemini";

const ACCEPT =
  ".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.html";

/** Convierte [Diapositiva N] / [Hoja: X] en encabezados Markdown. */
function toMarkdownDoc(sourceName: string, text: string): string {
  const body = text
    .replace(/^\[Diapositiva (\d+)\]/gm, "## Diapositiva $1")
    .replace(/^\[Hoja: ([^\]]+)\]/gm, "## Hoja: $1");
  const date = new Date().toISOString().slice(0, 10);
  return `# ${sourceName}\n\n_Convertido a Markdown el ${date}._\n\n${body.trim()}\n`;
}

export default function ConvertCard({
  onUseInChat,
}: {
  onUseInChat: (file: OutgoingFile) => void;
}) {
  const [mdName, setMdName] = useState<string | null>(null);
  const [mdText, setMdText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    setError(null);
    setMdText(null);
    setMdName(null);
    try {
      if (f.size > 50 * 1024 * 1024) {
        throw new Error("Archivo demasiado grande (límite 50 MB).");
      }
      const buf = await f.arrayBuffer();
      const text = await extractAttachment(f.name, buf);
      const base = f.name.replace(/\.[^.]+$/, "") || "documento";
      setMdName(`${base}.md`);
      setMdText(toMarkdownDoc(f.name, capText(text)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo convertir");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!mdText || !mdName) return;
    const url = URL.createObjectURL(
      new Blob([mdText], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = mdName;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <p className="text-sm font-medium">Convertir a Markdown</p>
      <p className="text-xs text-muted-foreground">
        Sube un PDF, Word, PowerPoint, Excel, CSV, TXT, MD o HTML y descárgalo
        como `.md` para adjuntarlo al chat (gasta menos cuota).
      </p>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={onFile}
      />
      <Button
        variant="outline"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      >
        {busy ? "Convirtiendo…" : "Elegir archivo"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {mdText && mdName && (
        <div className="flex flex-col gap-2">
          <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-2 text-xs whitespace-pre-wrap">
            {mdText.slice(0, 1500)}
            {mdText.length > 1500 ? "\n[…]" : ""}
          </pre>
          <div className="flex gap-2">
            <Button variant="outline" onClick={download}>
              Descargar {mdName}
            </Button>
            <Button
              onClick={() =>
                onUseInChat({
                  name: mdName,
                  mimeType: "text/markdown",
                  base64: "",
                  asText: mdText,
                })
              }
            >
              Usar en el chat
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
