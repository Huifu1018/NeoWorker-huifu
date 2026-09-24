import type { PaperNewsSource, PaperNewsSourceState } from "../../shared/paper-news";

export type PaperNewsErrorCode = NonNullable<PaperNewsSourceState["error"]>;
export class PaperNewsRequestError extends Error {
  constructor(
    public readonly code: PaperNewsErrorCode,
    public readonly retryAt?: number,
    public readonly httpStatus?: number,
  ) {
    super(code);
  }
}

/** Respect server deadlines; never shorten a Retry-After to our local cooldown. */
export function retryDeadline(headers: Headers, now: number): number | undefined {
  const after = headers.get("retry-after")?.trim();
  let deadline: number | undefined;
  if (after) {
    const seconds = /^\d+$/.test(after) ? Number(after) : NaN;
    const candidate = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(after);
    if (Number.isFinite(candidate) && candidate >= now && candidate <= 8.64e15)
      deadline = candidate;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (
    headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset) &&
    reset * 1000 > now &&
    reset * 1000 <= 8.64e15
  ) {
    deadline = Math.max(deadline || 0, reset * 1000);
  }
  return deadline;
}

export function paperNewsHttpError(
  response: Response,
  source: PaperNewsSource,
  now: number,
): PaperNewsRequestError {
  const status = response.status;
  const retryAt = retryDeadline(response.headers, now);
  const limited =
    status === 429 ||
    (source === "github" &&
      status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || retryAt !== undefined));
  return new PaperNewsRequestError(
    limited
      ? "rateLimit"
      : status === 401 || status === 403
        ? "accessDenied"
        : status >= 500
          ? "unavailable"
          : "invalidResponse",
    retryAt,
    status,
  );
}
