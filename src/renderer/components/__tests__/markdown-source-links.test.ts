import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../MarkdownRenderer";

const render = (children: string) =>
  renderToStaticMarkup(createElement(MarkdownRenderer, { children }));
describe("source link boundaries", () => {
  it("keeps Chinese source commentary outside arXiv and Hugging Face links", () => {
    const markup = render(
      "来源：arXiv（https://arxiv.org/pdf/2609.25186，v1，2026-09-21），页码标注对应该版本；Hugging Face（https://huggingface.co/papers/2609.25186）为同一论文的镜像条目。",
    );
    expect(markup).toContain('href="https://arxiv.org/pdf/2609.25186"');
    expect(markup).toContain('href="https://huggingface.co/papers/2609.25186"');
    expect(markup).toContain("</a>，v1，2026-09-21");
    expect(markup).toContain("</a>）为同一论文的镜像条目。");
  });
  it("retains both source links when Chinese punctuation has no adjacent spaces", () => {
    const markup = render(
      "来源：（https://arxiv.org/pdf/2609.25186，v1），原始论文；（https://huggingface.co/papers/2609.25186）为镜像条目。",
    );
    expect(markup).toContain('href="https://arxiv.org/pdf/2609.25186"');
    expect(markup).toContain('href="https://huggingface.co/papers/2609.25186"');
  });
  it("preserves explicit Unicode URLs, queries, fragments and code", () => {
    const markup = render(
      "[中文](https://example.com/文档（修订）?q=中文#章节)\n\nhttps://example.com/a(b)?q=x&v=2#section\n\n`https://example.com/，说明`",
    );
    expect(decodeURI(markup)).toContain('href="https://example.com/文档（修订）?q=中文#章节"');
    expect(markup).toContain('href="https://example.com/a(b)?q=x&amp;v=2#section"');
    expect(markup).toContain("<code>https://example.com/，说明</code>");
  });
});
