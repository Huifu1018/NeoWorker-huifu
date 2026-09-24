import { describe, expect, it } from "vitest";
import { buildPDFHTML } from "../document-generators/pdf-generator";

describe("PDF equation typesetting", () => {
  it("typesets numbered fractions, sums and scripts with embedded offline fonts", () => {
    const html = buildPDFHTML({ markdown: String.raw`$$
L_{re}=-\frac{1}{n}\sum_i\log\frac{e^{s(q,d^+)/\tau}}{e^{s(q,d^+)/\tau}+\sum_j e^{s(q,d_j^-)/\tau}}\tag{1}
$$` });
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("mfrac");
    expect(html).toContain("msup");
    expect(html).toContain("msub");
    expect(html).toContain('class="tag"');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/url\(["']?fonts\//);
  });
  it.each([String.raw`变量 $s(q,d)$ 与 $\tau$。`, String.raw`变量 \(s(q,d)\) 与 \(\tau\)。`, String.raw`\[\frac{a}{b}\]`, '```math\n\\frac{a}{b}\n```'])("supports math notation: %s", (markdown) => {
    expect(buildPDFHTML({ markdown })).toContain('class="katex');
  });
  it("keeps code and prices literal, and never executes raw HTML", () => {
    const html = buildPDFHTML({ markdown: '`$x_i$`\n\n```js\nconst x = "$x$";\n```\n\nPrices: $5 and $10. Escaped: \\$20.\n\n<script>alert(1)</script>' });
    expect(html).not.toContain('class="katex');
    expect(html).toContain('$x_i$');
    expect(html).toContain('$5 and $10');
    expect(html).not.toContain('<script>');
  });
  it("rejects malformed equations instead of publishing raw or broken LaTeX", () => {
    expect(() => buildPDFHTML({ markdown: '$$\\frac{1}{\\unknownCommand{x}}$$' })).toThrow('PDF formula could not be typeset');
    expect(() => buildPDFHTML({ markdown: '$$ x + y' })).toThrow('unclosed display math');
  });
});
