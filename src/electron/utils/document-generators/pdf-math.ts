import * as fs from "node:fs";
import * as path from "node:path";
import katex from "katex";
import { Marked, type Renderer } from "marked";

function renderMath(text: string, displayMode: boolean): string {
  try {
    return katex.renderToString(text.trim(), {
      displayMode, output: "htmlAndMathml", throwOnError: true,
      trust: false, strict: "error", maxExpand: 1000, maxSize: 20,
    });
  } catch (error) {
    throw new Error(`PDF formula could not be typeset. Correct the LaTeX or preserve the original equation as an image: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse math before Markdown can consume backslashes, underscores or stars.
 * Code spans/fences remain literal, and escaped currency is never math. */
export function createPdfMarkdownParser(renderer: Renderer): Marked {
  const parser = new Marked({ gfm: true, breaks: false, renderer });
  parser.use({
    extensions: [
      {
        name: "pdfDisplayMath", level: "block",
        start: (src) => src.search(/^(?: {0,3})(?:\$\$|\\\[)/m),
        tokenizer(src) {
          const match = /^(?: {0,3})(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:[ \t]*(?:\n|$))/.exec(src);
          if (match) return { type: "pdfDisplayMath", raw: match[0], text: match[1] ?? match[2] };
          if (/^ {0,3}(?:\$\$|\\\[)/.test(src)) throw new Error("PDF formula could not be typeset: unclosed display math delimiter");
        },
        renderer: (token) => renderMath(token.text, true) + "\n",
      },
      {
        name: "pdfInlineMath", level: "inline",
        start: (src) => src.search(/\\\(|\$(?!\$)/),
        tokenizer(src) {
          const match = /^\\\(([^\n]+?)\\\)/.exec(src)
            || /^\$(?!\$|\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d|\$)/.exec(src);
          if (match) return { type: "pdfInlineMath", raw: match[0], text: match[1] };
        },
        renderer: (token) => renderMath(token.text, false),
      },
    ],
    renderer: {
      code(token) {
        if (/^(?:math|latex|tex)$/i.test(token.lang?.trim() || "")) return renderMath(token.text, true) + "\n";
        return false;
      },
    },
  });
  return parser;
}

let embeddedStyles: string | undefined;
/** Include the installed font bytes, so PDFs work offline and inside app.asar. */
export function getPdfMathStyles(): string {
  if (embeddedStyles) return embeddedStyles;
  const directory = path.dirname(require.resolve("katex/dist/katex.min.css"));
  embeddedStyles = fs.readFileSync(path.join(directory, "katex.min.css"), "utf8")
    .replace(/src:[^;}]+(?=[;}])/g, (source) => {
      const font = /url\((?:["']?)(fonts\/[^)"']+\.woff2)(?:["']?)\)/.exec(source);
      if (!font) throw new Error("PDF math font is missing its WOFF2 source");
      const data = fs.readFileSync(path.join(directory, font[1])).toString("base64");
      return `src:url(data:font/woff2;base64,${data}) format("woff2")`;
    });
  return embeddedStyles;
}
