"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export default function MessageBody({ text }: { text: string }) {
  return (
    <div className="space-y-2 leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children }) => (
            <h3 className="pt-1 text-base font-semibold">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="pt-1 text-base font-semibold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="pt-1 text-sm font-semibold">{children}</h4>
          ),
          p: ({ children }) => <p className="text-sm">{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5 text-sm">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5 text-sm">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          code: ({ children }) => (
            <code className="rounded bg-background/60 px-1 font-mono text-[0.8rem]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg bg-background/60 p-2 text-xs">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 pl-2 text-sm opacity-80">
              {children}
            </blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
