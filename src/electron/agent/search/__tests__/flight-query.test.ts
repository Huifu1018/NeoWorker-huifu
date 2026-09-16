import { describe, expect, it } from "vitest";
import {
  buildFlightQueryVariants,
  extractFlightRoute,
  filterFlightResults,
  getFlightScheduleEvidenceScore,
  hasFlightScheduleDetails,
  isFlightQuery,
} from "../flight-query";

describe("flight query routing", () => {
  it("extracts a Chinese city route and date", () => {
    expect(extractFlightRoute("查询北京到上海 9月3日的航班信息")).toEqual({
      fromCity: "北京",
      fromCode: "PEK",
      toCity: "上海",
      toCode: "SHA",
      date: "9月3日",
    });
  });

  it("extracts an IATA route", () => {
    expect(extractFlightRoute("PEK to SHA flight schedule")).toMatchObject({
      fromCode: "PEK",
      toCode: "SHA",
    });
    expect(extractFlightRoute("HGH XIY flight schedule")).toMatchObject({
      fromCode: "HGH",
      toCode: "XIY",
    });
    expect(isFlightQuery("PEK to SHA flight schedule")).toBe(true);
  });

  it("builds bounded variants without inventing flight data", () => {
    const variants = buildFlightQueryVariants("北京→上海全天的航班信息");
    expect(variants.length).toBeGreaterThan(1);
    expect(variants.length).toBeLessThanOrEqual(4);
    expect(variants.some((variant) => variant.includes("PEK"))).toBe(true);
    expect(variants.some((variant) => variant.includes("SHA"))).toBe(true);
    expect(variants.some((variant) => variant.includes("PKX"))).toBe(true);
    expect(variants.some((variant) => variant.includes("PVG"))).toBe(true);
    expect(variants.some((variant) => variant.includes("official airline"))).toBe(true);
    expect(variants.some((variant) => variant.includes("site:trip.com"))).toBe(false);
  });

  it("detects and scores results with concrete flight schedule details", () => {
    const detailed = {
      title: "PEK to PVG flight schedule",
      url: "https://example.com/schedule",
      snippet: "MU5100 departs at 07:00 and arrives at 09:15.",
    };
    const summaryOnly = {
      title: "PEK to PVG flights",
      url: "https://example.com/summary",
      snippet: "Compare airlines flying between Beijing and Shanghai.",
    };

    expect(hasFlightScheduleDetails(detailed)).toBe(true);
    expect(hasFlightScheduleDetails(summaryOnly)).toBe(false);
    expect(getFlightScheduleEvidenceScore(detailed)).toBeGreaterThan(
      getFlightScheduleEvidenceScore(summaryOnly),
    );
  });

  it("prefers direction-confirmed results and falls back when a provider omits route tokens", () => {
    const route = extractFlightRoute("北京到上海航班")!;
    const results = [
      {
        title: "PEK to SHA schedule",
        url: "https://example.com/a",
        snippet: "PEK SHA",
      },
      {
        title: "Unrelated travel guide",
        url: "https://example.com/b",
        snippet: "city guide",
      },
    ];
    expect(filterFlightResults(results, route).results).toHaveLength(1);
    expect(filterFlightResults([results[1]], route).results).toEqual([results[1]]);
  });

  it("does not treat a reverse route page as evidence for the requested direction", () => {
    const route = extractFlightRoute("杭州到西安航班")!;
    expect(route).toMatchObject({ fromCode: "HGH", toCode: "XIY" });
    const results = [
      {
        title: "XIY to HGH flight schedule",
        url: "https://example.com/reverse",
        snippet: "XIY → HGH",
      },
      {
        title: "HGH to XIY flight schedule",
        url: "https://example.com/forward",
        snippet: "HGH → XIY",
      },
    ];

    expect(filterFlightResults(results, route).results).toEqual([results[1]]);
  });

  it("does not mix city names and airport codes when checking direction", () => {
    const route = extractFlightRoute("上海到北京 航班时刻表 2026年9月15日 虹桥 浦东")!;
    const reverseResult = {
      title: "2026 年 9 月 14 日 从 北京首都 到 上海浦东 的可用航班",
      url: "https://example.com/route/pek-beijing/pvg-shanghai",
      snippet: "2026 年 9 月 14 日 从 北京 到 上海 的航班（PEK-PVG），直飞航班有 MU5100。",
    };
    const forwardResult = {
      title: "上海浦东到北京大兴航班",
      url: "https://example.com/route/pvg-shanghai/pkx-beijing",
      snippet: "上海到北京的航班（PVG-PKX）",
    };

    expect(filterFlightResults([reverseResult], route)).toEqual({
      results: [],
      matchedCount: 0,
    });
    expect(filterFlightResults([reverseResult, forwardResult], route)).toEqual({
      results: [forwardResult],
      matchedCount: 1,
    });
  });

  it("recognizes additional domestic and regional city aliases", () => {
    expect(extractFlightRoute("广州到沈阳 9月3日航班")).toMatchObject({
      fromCity: "广州",
      fromCode: "CAN",
      toCity: "沈阳",
      toCode: "SHE",
      date: "9月3日",
    });
    expect(extractFlightRoute("HKG to TPE flight schedule")).toMatchObject({
      fromCity: "香港",
      fromCode: "HKG",
      toCity: "台北",
      toCode: "TPE",
    });
  });
});
