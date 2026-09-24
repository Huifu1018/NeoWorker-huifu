import type { Root, RootContent, Link } from "mdast";

/** GFM treats full-width prose punctuation as URL characters. Repair only
 * implicit links; explicit Markdown links can intentionally contain Unicode. */
export function remarkSourceLinks(this: { parse: (text: string) => unknown }) {
  const parse = this.parse.bind(this);
  function repair(tree: Root, source: string) {
    function visit(parent: { children: RootContent[] }) {
      for (let i = 0; i < parent.children.length; i++) {
        const node = parent.children[i];
        if (node.type === "link") {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          const raw = start !== undefined && end !== undefined ? source.slice(start, end) : "";
          // Bracketed links, reference links and explicit <autolinks> are authored URLs.
          if (!/^(?:https?:\/\/|www\.)/i.test(raw)) continue;
          const link = node as Link;
          const label =
            link.children.length === 1 && link.children[0].type === "text"
              ? link.children[0].value
              : "";
          const boundary = label.search(/[，。；：！？、（）【】《》「」『』]/u);
          if (boundary <= 0) continue;
          const url = label.slice(0, boundary);
          const suffix = label.slice(boundary);
          // One GFM autolink can swallow a second URL separated only by CJK
          // punctuation. Reparse the prose tail so that source stays clickable.
          const tail = parse(suffix) as Root;
          repair(tail, suffix);
          const children =
            tail.children.length === 1 && tail.children[0].type === "paragraph"
              ? tail.children[0].children
              : [{ type: "text" as const, value: suffix }];
          link.url = /^www\./i.test(url) ? `http://${url}` : url;
          link.children = [{ type: "text", value: url }];
          parent.children.splice(i + 1, 0, ...children);
          i += children.length;
        } else if ("children" in node) {
          visit(node as { children: RootContent[] });
        }
      }
    }
    visit(tree);
  }
  return (tree: Root, file: { value: unknown }) => repair(tree, String(file.value));
}
