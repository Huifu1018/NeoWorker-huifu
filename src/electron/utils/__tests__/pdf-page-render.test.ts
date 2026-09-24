import { expect, it } from "vitest";
import { pdfRegionRenderPlan } from "../pdf-page-render";

it("allocates export pixels to the figure region instead of the overview page", () => {
  const figure = pdfRegionRenderPlan(595, 842, { x: .15, y: .31, width: .31, height: .224 });
  expect(figure.width).toBeGreaterThanOrEqual(2400);
  expect(figure.left).toBeCloseTo(595 * .15 * figure.scale);
  expect(figure.renderDpi).toBeGreaterThan(900);
  expect(figure.resolutionLimited).toBe(false);
  expect(pdfRegionRenderPlan(595, 842).width).toBeGreaterThanOrEqual(2479);
  expect(pdfRegionRenderPlan(595, 842, undefined, 144).width).toBe(1190);
});

it("bounds extreme aspect ratios and rejects invalid DPI", () => {
  const tall = pdfRegionRenderPlan(595, 842, { x: 0, y: 0, width: .01, height: 1 });
  expect(tall.width * tall.height).toBeLessThanOrEqual(24_010_000);
  expect(tall.height).toBeLessThanOrEqual(6000);
  expect(tall.resolutionLimited).toBe(true);
  for (const dpi of [NaN, Infinity, 0, 601]) expect(() => pdfRegionRenderPlan(595, 842, undefined, dpi)).toThrow("dpi");
});
