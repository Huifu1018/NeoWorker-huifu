/** Guidance is identical on every desktop platform; no extra network requests. */
export const RAIL_EVIDENCE_POLICY =
  "For train schedules, search snippets are discovery evidence only. Read a route/date-specific source before answering. " +
  "By default list all retrieved services matching the user's route, date and train type, sorted by departure; do not silently replace the list with ten representative trains. " +
  "If the user asks for recommendations or a short answer, a subset is appropriate: label the displayed and retrieved counts. " +
  "Separate the page's total, matching rows and unique train numbers: a route total may include ordinary trains, overnight trains or multiple stops of the same train. " +
  "Cite the actual source URL and page date. A successful fetch is not verification of operation, availability or price; website retrieval time is not the travel date. " +
  "Never describe third-party data as a verified 12306 API response. Only claim an official live query when the actual successful response, route and travel date support it. " +
  "Label public page prices as reference fares and seat availability as unverified when login/live validation is missing. Report gaps without inventing rows or repeatedly retrying unavailable sources.";

export function isRailQuery(query: string): boolean {
  return /高铁|火车|列车|动车|车次|余票|铁路|12306|\b(?:train|rail|railway)\s+(?:schedule|timetable|ticket|fare|from|to)|\bhigh[ -]speed\s+(?:train|rail)/i.test(query);
}

export interface RailListingRow {
  trainNumber: string;
  departureStation: string;
  arrivalStation: string;
  departureTime: string;
  arrivalTime: string;
  arrivalDayOffset: number;
  duration: string;
  referenceFaresCny: Record<string, number>;
}

export interface RailPageEvidence {
  sourceUrl: string;
  sourceKind: "third_party_listing";
  pageTravelDate: string;
  pageRoute: string;
  pageReportedTotal: number;
  parsedRowCount: number;
  uniqueTrainCount: number;
  gPrefixRowCount: number;
  uniqueGPrefixTrainCount: number;
  extractionCoverage: "matches_page_total" | "partial";
  liveAvailabilityVerified: false;
  liveFaresVerified: false;
  loginRequiredForLiveDetails: boolean;
  rows: RailListingRow[];
}

/**
 * Read only the dated direct-service listing from the known Ctrip page format.
 * Do not infer inventory from navigation, transfer suggestions or the URL slug.
 * Unknown formats keep their original content and receive no fabricated rows.
 */
export function extractRailPageEvidence(
  sourceUrl: string,
  content: string,
  truncated: boolean,
): RailPageEvidence | undefined {
  let url: URL;
  try { url = new URL(sourceUrl); } catch { return undefined; }
  if (!/^(?:train|trains)\.ctrip\.com$/i.test(url.hostname) ||
      !/^\/TrainBooking\//i.test(url.pathname)) return undefined;

  const heading = /^##\s+([^\n]+?)\s+单程\s+(\d{4}-\d{2}-\d{2})\s*\(共(\d+)车次\)/m.exec(content);
  if (!heading) return undefined;
  const listing = content.slice(heading.index + heading[0].length).split(/^#{2,3}\s+/m)[0];
  const cleaned = listing.replace(/\*/g, "").replace(/\r/g, "");
  const pattern = /(?:^|\n)([0-2]\d:[0-5]\d)\s*\n\s*([^\n]+?)\s*\n\s*(\d+时(?:\d+分)?)\s*\n\s*([GDCZKT]\d+)\s*\n\s*([0-2]\d:[0-5]\d)(?:\s*\+(\d+))?\s*\n\s*([^\n]+?)\s*(?=\n|$)/g;
  const matches = Array.from(cleaned.matchAll(pattern));
  const rows = matches.map((match, index): RailListingRow => {
    const details = cleaned.slice(match.index! + match[0].length, matches[index + 1]?.index ?? cleaned.length);
    const fares: Record<string, number> = {};
    for (const fare of details.matchAll(/^-\s*(二等座|一等座|优选一等座|商务座|特等座|无座|硬座|软座|硬卧|软卧|二等卧|一等卧)\s*[¥￥]?\s*(\d+(?:\.\d+)?)(?=\s|$)/gm)) {
      fares[fare[1]] = Number(fare[2]);
    }
    return {
      trainNumber: match[4], departureStation: match[2].trim(), arrivalStation: match[7].trim(),
      departureTime: match[1], arrivalTime: match[5], arrivalDayOffset: Number(match[6] || 0),
      duration: match[3], referenceFaresCny: fares,
    };
  });
  const gRows = rows.filter(row => row.trainNumber.startsWith("G"));
  const total = Number(heading[3]);
  return {
    sourceUrl, sourceKind: "third_party_listing", pageTravelDate: heading[2], pageRoute: heading[1],
    pageReportedTotal: total, parsedRowCount: rows.length,
    uniqueTrainCount: new Set(rows.map(row => row.trainNumber)).size,
    gPrefixRowCount: gRows.length, uniqueGPrefixTrainCount: new Set(gRows.map(row => row.trainNumber)).size,
    extractionCoverage: !truncated && total > 0 && total === rows.length ? "matches_page_total" : "partial",
    liveAvailabilityVerified: false, liveFaresVerified: false,
    loginRequiredForLiveDetails: /登录可查看余票\/票价/.test(listing), rows,
  };
}
