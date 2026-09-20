import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRailPageEvidence, isRailQuery } from "../rail-evidence";

// Public Ctrip listing captured 2026-09-20; an extraction fixture, not live inventory.
const listing = readFileSync(new URL("./fixtures/ctrip-rail-listing.txt", import.meta.url), "utf8");
const url = "https://trains.ctrip.com/TrainBooking/beijing-hangzhou/gaotie/";

describe("rail listing evidence", () => {
  it("preserves all 29 rows, distinguishes G services and retains different stops of one train", () => {
    const evidence = extractRailPageEvidence(url, listing, false)!;
    expect(evidence).toMatchObject({
      sourceKind: "third_party_listing", pageTravelDate: "2026-09-21",
      pageReportedTotal: 29, parsedRowCount: 29, uniqueTrainCount: 28,
      gPrefixRowCount: 25, uniqueGPrefixTrainCount: 24,
      extractionCoverage: "matches_page_total", liveAvailabilityVerified: false,
      liveFaresVerified: false, loginRequiredForLiveDetails: true,
    });
    expect(evidence.rows.filter(row => row.trainNumber === "G811").map(row => row.arrivalStation))
      .toEqual(["杭州东", "杭州南"]);
    expect(evidence.rows.find(row => row.trainNumber === "G49")).toMatchObject({
      departureStation: "北京南", arrivalStation: "杭州东", departureTime: "19:04",
      arrivalTime: "23:21", arrivalDayOffset: 0, duration: "4时17分",
      referenceFaresCny: { 二等座: 597, 一等座: 991, 商务座: 2202 },
    });
    expect(evidence.rows.find(row => row.trainNumber === "K1275")).toMatchObject({
      arrivalDayOffset: 1, referenceFaresCny: { 硬座: 189.5 },
    });
    expect(evidence.rows.some(row => row.trainNumber === "G7629")).toBe(false); // transfer suggestion
  });

  it("does not present a truncated or changed listing as complete", () => {
    expect(extractRailPageEvidence(url, listing.slice(0, 3000), true)).toMatchObject({
      extractionCoverage: "partial", liveAvailabilityVerified: false,
    });
    expect(extractRailPageEvidence(url, listing.replace("共29车次", "共30车次"), false)?.extractionCoverage).toBe("partial");
    expect(extractRailPageEvidence(url, listing, true)?.extractionCoverage).toBe("partial");
  });

  it("does not infer a schedule from a title, search snippet, unknown layout or lookalike host", () => {
    expect(extractRailPageEvidence(url, "北京到杭州 共29车次 G49 19:04 23:21", false)).toBeUndefined();
    expect(extractRailPageEvidence("https://trains.ctrip.com.example.org/TrainBooking/x", listing, false)).toBeUndefined();
    expect(extractRailPageEvidence("https://www.12306.cn/", listing, false)).toBeUndefined();
    expect(extractRailPageEvidence(url, listing.replace(/单程/g, "网页内容"), false)).toBeUndefined();
  });

  it("does not treat the page date as the requested date or login absence as verification", () => {
    const evidence = extractRailPageEvidence(url, listing.replace(/2026-09-21/g, "2025-01-01").replace(/登录可查看余票\/票价/g, ""), false)!;
    expect(evidence.pageTravelDate).toBe("2025-01-01");
    expect(evidence.loginRequiredForLiveDetails).toBe(false);
    expect(evidence.liveFaresVerified).toBe(false);
  });

  it("recognizes train requests without treating model training as travel", () => {
    for (const query of ["帮我查一下明天北京到杭州的高铁信息", "12306余票", "train tickets Beijing to Hangzhou", "high-speed rail timetable"]) expect(isRailQuery(query)).toBe(true);
    for (const query of ["train an AI model", "train station architecture", "北京天气", "航班信息"]) expect(isRailQuery(query)).toBe(false);
  });
});
