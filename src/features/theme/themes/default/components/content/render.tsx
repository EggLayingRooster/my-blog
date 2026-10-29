import type { JSONContent } from "@tiptap/react";
import { renderToReactElement } from "@tiptap/static-renderer/pm/react";
import { createElement } from "react";
import { headingClasses } from "@/features/posts/editor/extensions/typography/heading";
import { createHeadingIdGenerator } from "@/features/posts/utils/content";
import { MathFormula } from "@/components/content/math-formula";
import { extensions } from "@/features/posts/editor/config";
import { CodeBlock } from "@/features/theme/themes/default/components/content/code-block";
import { ImageDisplay } from "@/features/theme/themes/default/components/content/image-display";

export function renderReact(content: JSONContent) {
  const nextHeadingId = createHeadingIdGenerator();

  return renderToReactElement({
    extensions,
    content,
    options: {
      nodeMapping: {
        heading: ({ node, children }) => {
          const attrs = node.attrs as { level?: number };
          const level = Math.min(4, Math.max(1, Number(attrs.level) || 1));

          return createElement(
            `h${level}`,
            {
              className: headingClasses[level],
              id: nextHeadingId(node.textContent ?? ""),
            },
            children,
          );
        },
        image: ({ node }) => {
          const attrs = node.attrs as {
            src: string;
            alt?: string | null;
            width?: number | string;
            height?: number | string;
          };

          const alt =
            (attrs.alt && attrs.alt !== "null" ? attrs.alt : null) ||
            "blog image";

          const width =
            typeof attrs.width === "string"
              ? parseInt(attrs.width)
              : attrs.width;
          const height =
            typeof attrs.height === "string"
              ? parseInt(attrs.height)
              : attrs.height;

          return (
            <ImageDisplay
              src={attrs.src}
              alt={alt}
              width={width || undefined}
              height={height || undefined}
            />
          );
        },
        codeBlock: ({ node }) => {
          const code = node.textContent || "";
          const attrs = node.attrs as {
            language?: string | null;
            highlightedHtml?: string;
          };

          return (
            <CodeBlock
              code={code}
              language={attrs.language || null}
              highlightedHtml={attrs.highlightedHtml}
            />
          );
        },
        tableCell: ({ node, children }) => {
          const attrs = node.attrs as {
            colspan?: number;
            rowspan?: number;
            colwidth?: Array<number>;
            style?: string;
          };
          return (
            <td
              colSpan={attrs.colspan}
              rowSpan={attrs.rowspan}
              style={attrs.style ? { width: attrs.style } : undefined}
            >
              {children}
            </td>
          );
        },
        tableHeader: ({ node, children }) => {
          const attrs = node.attrs as {
            colspan?: number;
            rowspan?: number;
            colwidth?: Array<number>;
            style?: string;
          };
          return (
            <th
              colSpan={attrs.colspan}
              rowSpan={attrs.rowspan}
              style={attrs.style ? { width: attrs.style } : undefined}
            >
              {children}
            </th>
          );
        },
        inlineMath: ({ node }) => {
          const latex = (node.attrs as { latex?: string }).latex ?? "";
          return <MathFormula latex={latex} mode="inline" />;
        },
        blockMath: ({ node }) => {
          const latex = (node.attrs as { latex?: string }).latex ?? "";
          return <MathFormula latex={latex} mode="block" />;
        },
      },
    },
  });
}
