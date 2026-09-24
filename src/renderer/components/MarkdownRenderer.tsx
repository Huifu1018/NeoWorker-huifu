import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkSourceLinks } from "../utils/remark-source-links";

type MarkdownRendererProps = {
  children: string;
  components?: unknown;
  withBreaks?: boolean;
};

const gfmPlugins = [remarkGfm, remarkSourceLinks];
const gfmBreaksPlugins = [remarkGfm, remarkSourceLinks, remarkBreaks];

export function MarkdownRenderer({
  children,
  components,
  withBreaks = false,
}: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={withBreaks ? gfmBreaksPlugins : gfmPlugins}
      components={components as any}
    >
      {children}
    </ReactMarkdown>
  );
}
