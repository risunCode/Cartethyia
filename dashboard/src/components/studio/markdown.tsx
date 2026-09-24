import { useRef } from "react";
import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "../../lib/toast";
import { useClipboard } from "../../lib/use-clipboard";
import { mermaidToAscii } from "../../routes/model-lab/tools";

function CodeBlock({ children }: { children?: ReactNode }): ReactNode {
  const ref = useRef<HTMLPreElement | null>(null);
  const { copied, copy } = useClipboard();
  return (
    <pre
      ref={ref}
      style={{
        position: "relative",
        background: "var(--code-surface)",
        border: "1px solid var(--inner-border)",
        borderRadius: "8px",
        padding: "10px 12px",
        overflowX: "auto",
        fontSize: "11.5px",
      }}
    >
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          void copy(ref.current?.innerText ?? "").then((ok) => {
            if (!ok) toast.error("Copy failed");
          });
        }}
        style={{
          position: "absolute",
          top: "6px",
          right: "6px",
          background: "var(--surface-2)",
          border: "1px solid var(--inner-border)",
          borderRadius: "6px",
          cursor: "pointer",
          color: copied ? "var(--status-success)" : "var(--text-tertiary)",
          padding: "3px",
          display: "inline-flex",
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {children}
    </pre>
  );
}

export function Markdown({ text }: { text: string }): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer" style={{ color: "var(--status-info)" }} />
        ),
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        code: ({ children, className }) => {
          const source = String(children).replace(/\n$/, "");
          const content = className?.includes("language-mermaid") ? mermaidToAscii(source) : source;
          return <code style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px" }}>{content}</code>;
        },
        p: ({ children }) => <p style={{ margin: "0 0 8px", lineHeight: 1.65 }}>{children}</p>,
        h1: ({ children }) => <h1 style={{ fontSize: "17px", fontWeight: 700, margin: "12px 0 6px" }}>{children}</h1>,
        h2: ({ children }) => <h2 style={{ fontSize: "15px", fontWeight: 700, margin: "12px 0 6px" }}>{children}</h2>,
        h3: ({ children }) => <h3 style={{ fontSize: "13.5px", fontWeight: 700, margin: "10px 0 4px" }}>{children}</h3>,
        ul: ({ children }) => <ul style={{ margin: "0 0 8px", paddingLeft: "20px", lineHeight: 1.65 }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ margin: "0 0 8px", paddingLeft: "20px", lineHeight: 1.65 }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: "2px" }}>{children}</li>,
        blockquote: ({ children }) => (
          <blockquote style={{ margin: "0 0 8px", borderLeft: "3px solid var(--border-strong)", paddingLeft: "10px", color: "var(--text-secondary)" }}>
            {children}
          </blockquote>
        ),
        hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--inner-border)", margin: "12px 0" }} />,
        table: ({ children }) => (
          <div style={{ overflowX: "auto", margin: "8px 0" }}>
            <table style={{ borderCollapse: "collapse", fontSize: "12px", width: "100%" }}>{children}</table>
          </div>
        ),
        th: ({ children }) => <th style={{ borderBottom: "1px solid var(--border-strong)", textAlign: "left", padding: "4px 8px" }}>{children}</th>,
        td: ({ children }) => <td style={{ borderBottom: "1px solid var(--inner-border)", padding: "4px 8px", verticalAlign: "top" }}>{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
