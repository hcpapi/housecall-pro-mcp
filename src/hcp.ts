/**
 * Minimal Housecall Pro API client. Handles auth, pagination envelopes,
 * money conversion, and retry policy so the tools don't have to.
 */

const BASE_URL = "https://api.housecallpro.com";

export class HcpApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId?: string,
    /** The raw response body, so callers can tell one 400 from another. */
    public body?: string,
  ) {
    super(message);
    this.name = "HcpApiError";
  }
}

export interface ListPage {
  items: unknown[];
  page?: number;
  page_size?: number;
  total_pages?: number;
  total_items?: number;
  /** True when more pages exist beyond this one; undefined when it can't be told. */
  has_more?: boolean;
}

/** Whether more pages follow, from the pagination envelope or a full last page. */
export function computeHasMore(p: {
  page?: number;
  page_size?: number;
  total_pages?: number;
  items: unknown[];
}): boolean | undefined {
  if (typeof p.page === "number" && typeof p.total_pages === "number") {
    return p.page < p.total_pages;
  }
  if (typeof p.page_size === "number") return p.items.length >= p.page_size;
  return undefined;
}

/**
 * Routes no Housecall Pro API key reaches, with the path that does work.
 *
 * Housecall Pro issues two kinds of key, read-only and full access, and the
 * choice is fixed when the key is generated. On these routes both kinds are
 * refused with the same permissions message, so the ordinary advice - go and
 * make a wider key - costs someone a key and changes nothing. Worse, an agent
 * reads "your key lacks access" as "this cannot be done" and stops, while the
 * same information is sitting one call away.
 */
const NO_KEY_REACHES: Array<{ method: string; match: RegExp; instead: string }> = [
  {
    method: "GET",
    match: /^\/(?:api\/)?jobs\/[^/]+\/notes\/?$/,
    instead:
      "No Housecall Pro API key reads a job's notes on this route - both kinds of key are refused here, so a " +
      "new key will not open it, and this is not a wall. The notes come back on the job record itself: call " +
      "hcp_get_job with the same job id and read its notes. What a technician wrote down also tends to show up " +
      "in the job's line items, or on a nameplate photo in the job's attachments (include_attachments). " +
      'Topic "job-notes-ride-the-job-record" in hcp_api_notes has it.',
  },
];

/**
 * Where else the same information lives, for routes a key can be refused.
 * Named beside the refusal so a permission failure hands over the next call
 * rather than only the bad news.
 */
const ELSEWHERE: Array<{ match: RegExp; instead: string }> = [
  {
    match: /^\/(?:api\/)?employees/,
    instead:
      "Who is on a job does not depend on this route: each row from hcp_list_jobs carries its assigned " +
      "employees, and hcp_list_jobs takes an employee to narrow a page to one technician.",
  },
  {
    match: /^\/api\/price_book\//,
    instead:
      "What the account actually charges also reads out of what it has billed: the line items on " +
      "hcp_get_invoice carry the names, quantities and prices as sold.",
  },
];

function elsewhereFor(path: string): string {
  return ELSEWHERE.find((e) => e.match.test(path))?.instead ?? "";
}

/**
 * What a refused request means, and what to do about it.
 *
 * Housecall Pro returns THREE different refusal bodies that mean different
 * things, and telling a user the wrong one sends them to fix the wrong
 * problem.
 *
 * A body naming permissions means the key is too narrow for a route a wider
 * key reaches - except on the routes above, where no key reaches it at all.
 *
 * A body naming a missing application is not about the key at all: the account
 * has no API application, and the routes that hang off one answer 401 even for
 * a key that reads and writes everywhere else. Measured on a live account:
 * `GET /jobs` 200 and `POST /jobs/{id}/notes` 201 with the same key that gets
 * `POST /jobs/{id}/links` 401 `{"error":{"message":"Application not found"}}`.
 * Reading that as a key fault sends the owner to mint a replacement that fails
 * identically.
 *
 * A bare Unauthorized means the key was not accepted here, and when the same
 * key works elsewhere that is the route not taking an API key at all, which no
 * key changes.
 */
export function explainRefusal(body: string, method: string, path: string): string {
  const blocked = NO_KEY_REACHES.find((e) => e.method === method && e.match.test(path));
  if (blocked) return blocked.instead;

  const alternative = elsewhereFor(path);
  const notes =
    'Topic "key-access-fixed-at-creation" in hcp_api_notes says which refusals a different key can fix.';

  if (/application not found/i.test(body)) {
    return [
      "This is not a key problem - do not replace the key. This Housecall Pro account has no API " +
        "application, and the routes that hang off one (job links, webhook subscriptions) refuse even a " +
        "key that reads and writes everywhere else. Creating an API application on the account is what " +
        "opens them; a new key will not.",
      alternative,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/necessary permissions/i.test(body)) {
    return [
      "Your API key is valid but does not have access for this. Key access is chosen when the key is created " +
        "and cannot be changed later, so this needs a new full-access key from Housecall Pro (My Apps, Go to App store, " +
        "API Key Management).",
      alternative,
      notes,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    "Housecall Pro did not accept this API key here. Check that it was copied whole and has not been revoked - " +
      "and if the same key works on other calls, this route does not take an API key at all rather than the key " +
      "being wrong, which no key changes.",
    alternative,
    notes,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What replaces something that must not reach the model. */
export const REDACTED = "[redacted]";

/**
 * An unbroken run of 32 or more hexadecimal characters: the shape of a key.
 *
 * The guards on either side are what keep it off Housecall Pro's own
 * identifiers. Those are prefixed - job_, cus_, est_, nte_, atc_, pro_,
 * pbmcat_ and the rest - and an underscore is a word character, so a run that
 * begins after one never starts at a boundary and is left whole. A dashed
 * identifier is excluded the same way, so nothing of the shape of a UUID is
 * touched either.
 */
const KEY_SHAPED = /(?<![\w-])[0-9a-fA-F]{32,}(?![\w-])/g;

/** A URL inside a body, up to the first character no URL would carry. */
const URL_SHAPED = /\bhttps?:\/\/[^\s"'<>)\]}\\]+/gi;

/**
 * Take out of an upstream body the two things that must not survive into a
 * transcript.
 *
 * The first is the caller's own credential. Housecall Pro echoes the API key it
 * was given back inside its 401 body - measured, not supposed - and an upstream
 * body is appended to the error a tool returns. Without this pass the
 * customer's key lands in the model's context, in the session transcript, and
 * in every log downstream of both.
 *
 * The second is the detail of a link. A file link is a working handle on a
 * customer's premises, and not all of them expire, so one copied into an error
 * message keeps working wherever that message ends up. The host is what tells
 * an agent which fetch failed; the path and the query are the part worth not
 * repeating.
 *
 * Three passes, in order:
 *
 * 1. The configured key values, matched literally. Exact, and always safe.
 * 2. Any URL carrying more than a host, cut back to its host.
 * 3. Anything else key-shaped, per KEY_SHAPED above.
 *
 * This runs on upstream text only - never on our own wording, and never on a
 * successful payload, where a link is the thing that was asked for and has to
 * be passed onward.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let clean = text;
  for (const secret of secrets) {
    if (typeof secret !== "string") continue;
    const value = secret.trim();
    // A short value is not a credential, and blanking every occurrence of one
    // would eat ordinary words out of the message.
    if (value.length < 8) continue;
    clean = clean.split(value).join(REDACTED);
  }
  clean = clean.replace(URL_SHAPED, (found) => {
    const parts = /^(https?:\/\/[^/?#]+)([/?#].*)?$/i.exec(found);
    if (!parts || !parts[2] || parts[2] === "/") return found;
    return `${parts[1]}/${REDACTED}`;
  });
  return clean.replace(KEY_SHAPED, REDACTED);
}

const LIST_KEYS = [
  "jobs",
  "customers",
  "invoices",
  "estimates",
  "employees",
  "tags",
  "leads",
  "appointments",
  "checklists",
  "data",
];

/**
 * How long to wait before a retry. Housecall Pro publishes no rate limit and no
 * X-RateLimit-* headers, so a Retry-After on a 429 is the only real backoff
 * signal it gives — honour it when present (seconds, or an HTTP date), capped so
 * a hostile value can't stall the client, and fall back to a fixed ramp.
 */
export function retryDelayMs(res: Response, attempt: number, baseMs: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    let ms = NaN;
    const secs = Number(ra);
    if (ra.trim() !== "" && Number.isFinite(secs)) ms = secs * 1000;
    else {
      const when = Date.parse(ra);
      if (!Number.isNaN(when)) ms = when - Date.now();
    }
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 30000);
  }
  return baseMs * (attempt + 1);
}

export class HcpClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = BASE_URL,
  ) {}

  /** Memoised /company lookup behind accountTimeZone(); null means "not known". */
  private timeZonePromise?: Promise<string | null>;

  /**
   * An upstream body, made safe to hand to the model. Redaction runs BEFORE
   * the length cap: capping first would cut a key in half and leave the front
   * of it in the message, which is still the customer's credential in a
   * transcript.
   */
  private safeDetail(body: string, max: number): string {
    return redactSecrets(body, [this.apiKey]).slice(0, max);
  }

  async request(path: string, params?: Record<string, unknown>): Promise<any> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
          Accept: "application/json",
        },
      });
      if (res.ok) return res.json();
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt, 1000)));
        continue;
      }
      let detail = "";
      try {
        detail = this.safeDetail(await res.text(), 300);
      } catch {
        /* body unavailable */
      }
      // 403 is the same conversation as 401 - the account was reached and the
      // request was refused - so it gets the same explanation and the same
      // pointer at what does work.
      if (res.status === 401 || res.status === 403) {
        throw new HcpApiError(
          `${res.status} ${res.status === 401 ? "Unauthorized" : "Forbidden"}. ${explainRefusal(detail, "GET", path)} ${detail}`,
          res.status,
          requestId,
          detail,
        );
      }
      if (res.status === 404) {
        throw new HcpApiError(
          `404 Not Found for ${path}. ${detail}`,
          404,
          requestId,
          detail,
        );
      }
      throw new HcpApiError(`HTTP ${res.status} for ${path}. ${detail}`, res.status, requestId, detail);
    }
  }

  /**
   * The account's own IANA time zone, read once and remembered for the life of
   * the process. Every timestamp Housecall Pro returns is UTC, and a shop reads
   * its day in local time - so a job at 16:00Z is noon to the office, and an
   * answer that says four o'clock names a time nobody is working.
   *
   * The lookup is best-effort by design: an account that has never set a zone,
   * a key too narrow for /company, or an outage all resolve to null, and the
   * caller falls back to reporting UTC plainly rather than failing the read.
   * One /company call per process, so a hundred rows cost nothing extra.
   */
  async accountTimeZone(): Promise<string | null> {
    if (this.timeZonePromise === undefined) {
      this.timeZonePromise = this.request("/company")
        .then((json: any) => {
          const tz = json?.time_zone;
          return typeof tz === "string" && tz.trim() !== "" ? tz : null;
        })
        .catch(() => null);
    }
    return this.timeZonePromise;
  }

  /**
   * GET a route that answers with a document rather than JSON. The invoice
   * preview returns rendered HTML, so its body is handed back as text.
   */
  async requestText(path: string): Promise<{ text: string; contentType: string }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.baseUrl + path, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      if (res.ok) {
        return {
          text: await res.text(),
          contentType: res.headers.get("content-type") ?? "",
        };
      }
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt, 1000)));
        continue;
      }
      let detail = "";
      try {
        detail = this.safeDetail(await res.text(), 300);
      } catch {
        /* body unavailable */
      }
      if (res.status === 401 || res.status === 403) {
        throw new HcpApiError(
          `${res.status} ${res.status === 401 ? "Unauthorized" : "Forbidden"}. ${explainRefusal(detail, "GET", path)} ${detail}`,
          res.status,
          requestId,
          detail,
        );
      }
      throw new HcpApiError(`HTTP ${res.status} for ${path}. ${detail}`, res.status, requestId, detail);
    }
  }

  /** Writes retry only on 429; a failed write is never blindly repeated. */
  async patch(path: string, body: unknown): Promise<any> {
    return this.write("PATCH", path, body);
  }

  async post(path: string, body: unknown): Promise<any> {
    return this.write("POST", path, body);
  }

  /** Several update routes answer on PUT and nothing else. */
  async put(path: string, body: unknown): Promise<any> {
    return this.write("PUT", path, body);
  }

  async del(path: string): Promise<any> {
    return this.write("DELETE", path, undefined);
  }

  private async write(method: string, path: string, body: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // A delete can answer 204 with no body at all.
        const text = await res.text();
        if (!text.trim()) return {};
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt, 1500)));
        continue;
      }
      let detail = "";
      try {
        detail = this.safeDetail(await res.text(), 400);
      } catch {
        /* body unavailable */
      }
      if (res.status === 401 || res.status === 403) {
        throw new HcpApiError(
          `${res.status} ${res.status === 401 ? "Unauthorized" : "Forbidden"} on write. ${explainRefusal(detail, method, path)} ${detail}`,
          res.status,
          requestId,
          detail,
        );
      }
      throw new HcpApiError(`HTTP ${res.status} for ${method} ${path}. ${detail}`, res.status, requestId, detail);
    }
  }

  /**
   * Upload a file as multipart/form-data.
   *
   * The one route on this API that does not take JSON. Content-Type is
   * deliberately NOT set: fetch derives it from the FormData and appends the
   * boundary, and a hand-set header loses that boundary and yields a 422 that
   * reads like a bad body rather than a malformed request.
   */
  async postMultipartFile(
    path: string,
    file: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }),
        file.filename,
      );
      const res = await fetch(this.baseUrl + path, {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}`, Accept: "application/json" },
        body: form,
      });
      if (res.ok) {
        const text = await res.text();
        if (!text.trim()) return {};
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }
      const requestId = res.headers.get("x-request-id") ?? undefined;
      // An upload is NOT idempotent: a retry that lands after a success the
      // client never saw leaves two files on the job. Only 429 is retried,
      // because that one provably did not reach the handler.
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt, 1500)));
        continue;
      }
      let detail = "";
      try {
        detail = this.safeDetail(await res.text(), 400);
      } catch {
        /* body unavailable */
      }
      if (res.status === 401 || res.status === 403) {
        throw new HcpApiError(
          `${res.status} ${res.status === 401 ? "Unauthorized" : "Forbidden"} on upload. ${explainRefusal(detail, "POST", path)} ${detail}`,
          res.status,
          requestId,
          detail,
        );
      }
      throw new HcpApiError(
        `HTTP ${res.status} for POST ${path}. ${detail}`,
        res.status,
        requestId,
        detail,
      );
    }
  }

  /** Normalize HCP's list envelopes ({jobs:[...],page,...} etc.) to one shape. */
  normalizeList(json: any): ListPage {
    if (Array.isArray(json)) return { items: json };
    if (json && typeof json === "object") {
      for (const key of LIST_KEYS) {
        if (Array.isArray(json[key])) {
          const lp: ListPage = {
            items: json[key],
            page: json.page,
            page_size: json.page_size,
            total_pages: json.total_pages ?? json.total_pages_count,
            total_items: json.total_items ?? json.total_count,
          };
          lp.has_more = computeHasMore(lp);
          return lp;
        }
      }
      // Fall back to the first array present, keeping pagination metadata.
      const firstArray = Object.values(json).find((v) => Array.isArray(v));
      if (firstArray) {
        const lp: ListPage = {
          items: firstArray as unknown[],
          page: json.page,
          page_size: json.page_size,
          total_pages: json.total_pages ?? json.total_pages_count,
          total_items: json.total_items ?? json.total_count,
        };
        lp.has_more = computeHasMore(lp);
        return lp;
      }
    }
    return { items: [] };
  }

  /** Walk pages of a list endpoint. Stops at maxPages or when a page is short/empty. */
  async *paginate(
    path: string,
    params: Record<string, unknown> = {},
    maxPages = 10,
    pageSize = 100,
  ): AsyncGenerator<unknown, void, void> {
    for (let page = 1; page <= maxPages; page++) {
      const json = await this.request(path, { ...params, page, page_size: pageSize });
      const { items, total_pages } = this.normalizeList(json);
      for (const item of items) yield item;
      if (items.length === 0) return;
      if (total_pages !== undefined && page >= total_pages) return;
      if (items.length < pageSize) return;
    }
  }
}

/** HCP money fields are integer cents. 25000 means $250.00. */
export function centsToDollars(cents: unknown): number | null {
  return typeof cents === "number" && Number.isFinite(cents)
    ? Math.round(cents) / 100
    : null;
}

/**
 * A UTC timestamp rendered in the account's own zone, as a person would say it:
 * "2026-08-18 12:00 PM EDT". Housecall Pro answers in UTC and a shop speaks
 * local, and the arithmetic between the two is where an agent quotes a job four
 * hours off - twice in one dogfood session, including two different times for
 * the same job in a single answer.
 *
 * Returns undefined rather than a guess whenever the conversion cannot be
 * trusted: no zone known, no timestamp, an unparseable value, or a zone this
 * runtime's ICU data does not carry. The raw UTC field is always still there.
 */
export function localTime(iso: unknown, timeZone: string | null): string | undefined {
  if (!timeZone || typeof iso !== "string" || iso.trim() === "") return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const date = `${at("year")}-${at("month")}-${at("day")}`;
    const time = `${at("hour")}:${at("minute")} ${at("dayPeriod")}`.trim();
    const zone = at("timeZoneName");
    if (!at("year") || !at("hour")) return undefined;
    return zone ? `${date} ${time} ${zone}` : `${date} ${time}`;
  } catch {
    // An unknown zone throws rather than falling back, and a wrong local time
    // is worse than none: let the caller report UTC.
    return undefined;
  }
}

/** Normalize Housecall Pro's work_status values into stable buckets. */
export function workStatusBucket(
  status: unknown,
): "completed" | "canceled" | "in_progress" | "scheduled" | "unscheduled" | "other" {
  const s = String(status ?? "").toLowerCase();
  if (s.startsWith("complete")) return "completed";
  if (s.includes("canceled") || s.includes("cancelled")) return "canceled";
  if (s.includes("progress")) return "in_progress";
  if (s.includes("needs scheduling") || s.startsWith("unscheduled")) return "unscheduled";
  if (s.includes("scheduled")) return "scheduled";
  return "other";
}
