import type { Root, RootContent, Link, Text } from "mdast";

/** GFM treats full-width prose punctuation as URL characters. Repair only
 * implicit links; explicit Markdown links can intentionally contain Unicode. */
export function remarkSourceLinks() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
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
          const suffix: Text = { type: "text", value: label.slice(boundary) };
          link.url = /^www\./i.test(url) ? `http://${url}` : url;
          link.children = [{ type: "text", value: url }];
          parent.children.splice(i + 1, 0, suffix);
          i++;
        } else if ("children" in node) {
          visit(node as { children: RootContent[] });
        }
      }
    }
    visit(tree);
  };
}
