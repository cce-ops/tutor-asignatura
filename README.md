# IA PE Chatbot — Tutor de la asignatura

Chat web donde los alumnos preguntan sobre los apuntes y envían sus trabajos para recibir
corrección y feedback con IA. Cada alumno usa su **propia API key gratuita de Gemini**
(BYOK): el profesor no paga nada y no necesita dejar ningún PC encendido.

- **Demo en producción:** https://ia-pe-gamma.vercel.app/
- **Repo:** https://github.com/cce-ops/tutor-asignatura

> Proyecto basado en la plantilla
> [ai-website-cloner-template](https://github.com/JCodesMore/ai-website-cloner-template),
> reutilizada como base Next.js (no como clonador).

## Cómo lo usa el alumno

1. Consigue una API key gratuita en [Google AI Studio](https://aistudio.google.com/apikey)
   y pégala en la web. La key **solo vive en su navegador** (`localStorage`); nunca pasa
   por ningún servidor nuestro: las llamadas van directas del navegador a Google.
2. Elige modo **Preguntar** (dudas sobre los apuntes) o **Corregir trabajo**
   (adjunta PDF/imagen o pega su solución y recibe qué está bien, errores,
   cómo mejorarlo y nota orientativa 0–10).
3. Puede adjuntar archivos a sus mensajes (PDF, imágenes, TXT/MD).

### Modelos y reintentos automáticos

Selector con los modelos Gemini vigentes (`3.5-flash-lite` por defecto por su mayor
cuota gratuita, además de `3.1-flash-lite`, `3.5/3.6/3.7/3.8-flash`). Si un modelo
falla o deja de existir, la app **reintenta unos segundos y pasa automáticamente al
siguiente** hasta conseguir respuesta o agotar la lista. La respuesta indica con qué
modelo se obtuvo.

Las respuestas se muestran con formato (Markdown + fórmulas LaTeX).

## Cómo sube apuntes el profesor

1. Copia los archivos en [`public/apuntes/`](public/apuntes/).
   Formatos: PDF, Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), MD, TXT.
2. Lístalos en [`public/apuntes/manifest.json`](public/apuntes/manifest.json).
3. Haz `push` a `main` (o súbelos desde la web de GitHub). Con el auto-despliegue
   conectado, Vercel publica solos los cambios.

### Actualizar apuntes sin terminal (solo navegador)

1. Entra en https://github.com/cce-ops/tutor-asignatura/tree/main/public/apuntes.
2. **Add file → Upload files**: arrastra los PDF/Word/PPT/Excel y **Commit changes**.
3. Abre `manifest.json` (lápiz ✏️): añade cada nombre entre comillas en la lista
   y **Commit changes**. Ejemplo:
   ```json
   { "files": ["tema1.pdf", "tema2.pptx"] }
   ```
4. Para borrar un tema: elimina el archivo (menú `···` → Delete) y quítalo de la
   lista de `manifest.json`.
5. Vercel redespliega solo en 1–2 minutos.

La web extrae el texto en el navegador (pdf.js, mammoth y lector propio de Excel
sobre JSZip), lo muestra en el recuadro de apuntes separado por fuente y se lo
pasa a Gemini como conocimiento.
Límites para no fundir la cuota gratuita: 120.000 caracteres por archivo y 400.000
en total (si se recorta, se avisa en “Fuentes cargadas”).

## Desarrollo en local

Requiere **Node.js 24+**.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 24
cd tutor-asignatura
npm install
npm run dev -- -p 3100   # http://localhost:3100 (el 3000 suele ocuparlo OpenWebUI)
```

Comprobación completa (lint + typecheck + build):

```bash
npm run check
```

## Despliegue

Despliegue manual a producción:

```bash
vercel --prod --yes
```

Auto-despliegue con cada `push`: en el dashboard de Vercel, Settings → Git → Connect
al repo (instala la integración de GitHub si la pide). Vercel acepta repos privados
en el plan gratuito.

## Costes y privacidad

- **Coste:** 0 €. Hosting en el free tier de Vercel + cuota gratuita de Gemini por
  alumno (cada key tiene su propia cuota).
- **Privacidad:** en el free tier de Gemini, Google puede usar el contenido para
  mejorar sus productos. No subir datos personales de alumnos.

## Estructura

```
src/
  app/                    # Next.js (page.tsx, layout.tsx)
  components/
    tutor-chat.tsx        # Chat, API key, modos, adjuntos
    message-body.tsx      # Render Markdown + KaTeX
    ui/button.tsx         # shadcn/ui
  lib/
    gemini.ts             # Llamadas a Gemini + fallback entre modelos
    apuntes.ts            # Carga y extracción de public/apuntes
  types/mammoth.d.ts
public/apuntes/           # Apuntes del profesor + manifest.json
```

## Licencia

MIT.
