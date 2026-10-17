import { remarkFileLinks } from "./remark-file-links.js";
import { FileLink, localFilePath } from "./file-links.js";
import remarkGfm from "remark-gfm";
import { useState, type ReactElement, type ReactNode, isValidElement } from "react";
import Markdown, { type Components } from "react-markdown";
import { copyTextToClipboard } from "./clipboard.js";

const components: Components = {
  a: ({ children, href }) =>
    href && localFilePath(href) ? (
      <FileLink path={localFilePath(href) ?? href}>{children}</FileLink>
    ) : href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  code: ({ children, className }) =>
    !className && typeof children === "string" && localFilePath(children) ? (
      <FileLink path={children}>{children}</FileLink>
    ) : (
      <code className={className ? "markdown-block-code" : "markdown-inline-code"}>{children}</code>
    ),
  pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
  // Images stay thumbnails (several sit side by side); a click opens the full image, unless the
  // image is itself a link.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <img
        className="markdown-image"
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        onClick={(event) => {
          if (!event.currentTarget.closest("a")) window.open(src, "_blank", "noreferrer");
        }}
      />
    ) : null,
};

export function ChatMarkdown({ text }: { text: string }): ReactElement {
  return (
    <div className="message-markdown">
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm, remarkFileLinks]}
        urlTransform={(url) => localFilePath(url) || (/^(https?:|mailto:|#)/i.test(url) ? url : "")}
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  );
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }): ReactElement {
  const [copyState, setCopyState] = useState<"Copy" | "Copied" | "Copy failed">("Copy");
  const text = codeText(children);
  const className = codeClassName(children);
  const language = className?.match(/(?:^|\s)language-([\w+-]+)/)?.[1];
  const copy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(text);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy failed");
    }
  };
  return (
    <figure
      className="markdown-code-block"
      aria-label={language ? `${language} code` : "Code block"}
    >
      <figcaption>
        <span>{language ?? "Code"}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">
          {copyState}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

function codeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return codeText(node.props.children);
  return "";
}

function codeClassName(node: ReactNode): string | undefined {
  if (Array.isArray(node)) return node.map(codeClassName).find(Boolean);
  if (isValidElement<{ children?: ReactNode; className?: string }>(node))
    return node.props.className ?? codeClassName(node.props.children);
  return undefined;
}
