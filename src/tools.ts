import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { HcpApiError, HcpClient, centsToDollars, workStatusBucket } from "./hcp.js";
import {
  DEFAULT_KEYS,
  DEFAULT_KEY_DESCRIPTIONS,
  readDefaults,
  setDefaults,
} from "./defaults.js";
import {
  PROFILE_SECTION_KEYS,
  PROFILE_SECTION_DESCRIPTIONS,
  readBusinessProfile,
  setBusinessProfile,
} from "./profile.js";
import { versionCheck } from "./version-check.js";
import { renderReport } from "./report/render.js";
import { MINIMAL_REPORT_EXAMPLE } from "./report/validate.js";
import { analyzeContactability, UNVERIFIABLE } from "./contact.js";
import {
  API_NOTES,
  CORE_RULE,
  PHANTOM_ROUTES,
  renderNotes,
  renderPhantomRoutes,
  searchApiNotes,
} from "./api-notes.js";
import {
  TOOLSETS,
  TOOL_SPECS,
  annotationsFor,
  shouldRegister,
  type SurfaceOptions,
} from "./toolsets.js";
import { unknownParameterRefusal } from "./params.js";

/** Serialize a result for the model, with an optional note about data quirks. */
function out(result: unknown, note?: string) {
  let text =
    (note ? `NOTE: ${note}\n\n` : "") + JSON.stringify(result, null, 2);
  // If the startup update check found a newer version, mention it once on the
  // next successful response. Desktop clients never show stderr, so this is
  // the only place a user would actually see it.
  const updateNotice = versionCheck.consumeNotice();
  if (updateNotice) text += `\n\n${updateNotice}`;
  return { content: [{ type: "text" as const, text }] };
}

/**
 * A failure, marked as one so a client never reads it as a result. A string is
 * a refusal raised here before anything was sent; anything else came back from
 * the API or the network and is labelled as such.
 */
function errOut(e: unknown) {
  const text =
    typeof e === "string"
      ? e
      : `Housecall Pro API error: ${e instanceof Error ? e.message : String(e)}`;
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * The invoice document is a full rendered web page. Even a short one runs past
 * 200,000 characters, so a preview goes back and the caller is told it is one.
 */
const DOCUMENT_PREVIEW_CHARS = 4000;

const MONEY_NOTE =
  "All *_dollars fields were converted from Housecall Pro's raw integer cents.";

/**
 * What to do when a read carries no equipment identity.
 *
 * Housecall Pro's equipment and property-profile records are not on the public
 * API, so an agent looking for the unit on a job or a customer finds nothing
 * and keeps hunting for a route that will never exist. Three paths do reach a
 * unit, and naming them here is the difference between "not possible" and the
 * next call. Said only on the two reads an agent actually looks at, and only
 * when the record really carries nothing.
 */
const EQUIPMENT_ON_A_JOB =
  "No equipment record comes back with a job - Housecall Pro does not expose one, and no query phrasing finds it. " +
  "Three paths do reach the unit: a nameplate photo on the job's attachments (read the job with include_attachments " +
  "and the download URL is a working link to the plate); a serial or model written into the line items; or asking " +
  'the technician on site. Topic "equipment-not-on-public-api" in hcp_api_notes has it.';

const EQUIPMENT_ON_A_CUSTOMER =
  "No equipment record comes back with a customer - Housecall Pro does not expose one. Reach the unit through this " +
  "customer's jobs instead: a nameplate photo on a job's attachments (hcp_get_job with include_attachments) is a " +
  "working link to the plate, a serial is often written into the line items, or the customer can be " +
  'asked. Topic "equipment-not-on-public-api" in hcp_api_notes has it.';

/**
 * Does this record name a unit at all? A serial or a model somewhere in the
 * payload means the pointer above would be noise, so it is not said. Depth is
 * capped because this runs on every job and customer read.
 */
export function carriesEquipmentIdentity(record: unknown, depth = 0): boolean {
  if (depth > 4 || !record || typeof record !== "object") return false;
  if (Array.isArray(record)) {
    return record.some((v) => carriesEquipmentIdentity(v, depth + 1));
  }
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (/^(serial|equipment|model)/i.test(key)) {
      if (typeof value === "string" && value.trim() !== "") return true;
      if (typeof value === "number") return true;
      if (Array.isArray(value) && value.length > 0) return true;
      if (value && typeof value === "object" && Object.keys(value).length > 0) return true;
    }
    if (value && typeof value === "object" && carriesEquipmentIdentity(value, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * What an empty filtered read means - which is two things, and the difference
 * matters. A filter can match nothing because nothing matches it, or because
 * the filter never applied: an unrecognised name is dropped rather than
 * refused upstream, and a value outside the vocabulary an endpoint accepts
 * matches nothing at all. Reported as an absence, either one reads as "there
 * is none", and one of them is wrong.
 */
export function emptyFilterNote(filters: Record<string, unknown>): string | undefined {
  const applied = Object.entries(filters).filter(([, v]) => {
    if (v === undefined || v === null || v === "") return false;
    return !(Array.isArray(v) && v.length === 0);
  });
  if (applied.length === 0) return undefined;

  const names = applied.map(([k]) => k).sort();
  const inProgress = applied.some(
    ([, v]) =>
      (Array.isArray(v) ? v : [v]).some(
        (x) => typeof x === "string" && /in\s*progress/i.test(x),
      ),
  );

  return (
    `Nothing matched ${names.join(", ")}. That is either the filter matching nothing or the filter not being ` +
    `the one you meant: an unrecognised filter name is dropped rather than refused upstream, and a value outside ` +
    `the vocabulary this endpoint accepts matches nothing at all. Drop a filter or widen the window before ` +
    `reporting an empty answer as an absence.` +
    (inProgress
      ? ` The "in progress" status in particular is rarely kept up to date on a real account, so it comes back ` +
        `empty on a busy day - topic "active-job-detection" in hcp_api_notes has how to find who is working now.`
      : "")
  );
}

const TOTAL_NOTES = API_NOTES.length;
const TOTAL_PHANTOM = PHANTOM_ROUTES.length;

/* ---------- row trimmers (keep list outputs model-sized) ---------- */

function trimCustomer(c: any) {
  const addr = Array.isArray(c?.addresses) ? c.addresses[0] : undefined;
  return {
    id: c?.id,
    first_name: c?.first_name,
    last_name: c?.last_name,
    company: c?.company || undefined,
    email: c?.email || undefined,
    mobile_number: c?.mobile_number || undefined,
    home_number: c?.home_number || undefined,
    city: addr?.city,
    state: addr?.state,
    tags: Array.isArray(c?.tags) && c.tags.length ? c.tags : undefined,
  };
}

function trimJob(j: any) {
  const employees = Array.isArray(j?.assigned_employees)
    ? j.assigned_employees
        .map((e: any) => ({
          id: e?.id,
          name: `${e?.first_name ?? ""} ${e?.last_name ?? ""}`.trim() || undefined,
        }))
        .filter((e: any) => e.id || e.name)
    : [];
  return {
    id: j?.id,
    // Deleted jobs still appear in list responses; callers filter on this.
    deleted_at: j?.deleted_at ?? undefined,
    invoice_number: j?.invoice_number,
    customer_id: j?.customer?.id ?? j?.customer_id,
    customer_name: j?.customer
      ? `${j.customer.first_name ?? ""} ${j.customer.last_name ?? ""}`.trim() || undefined
      : undefined,
    description: j?.description,
    work_status: j?.work_status,
    work_status_bucket: workStatusBucket(j?.work_status),
    created_at: j?.created_at,
    // A canceled job is evidence, not noise: the cancellation time plus the
    // note beside it is usually the whole story of a deal that died.
    canceled_at: j?.canceled_at ?? undefined,
    scheduled_start: j?.schedule?.scheduled_start ?? j?.scheduled_start,
    scheduled_end: j?.schedule?.scheduled_end ?? j?.scheduled_end,
    // The three work clocks. on_my_way_at and started_at are how a job that is
    // being worked right now shows itself: many accounts never move a job into
    // the "in progress" status, so these timestamps are the evidence that
    // filter cannot give. completed_at is when the work actually finished - the
    // clock a repeat-visit window runs from, which scheduled_start only
    // approximates.
    on_my_way_at: j?.work_timestamps?.on_my_way_at ?? undefined,
    started_at: j?.work_timestamps?.started_at ?? undefined,
    completed_at: j?.work_timestamps?.completed_at ?? undefined,
    job_type: j?.job_fields?.job_type?.name ?? undefined,
    // Same address_id means the same property even when a customer has
    // several; the street rides along for the human reading the row.
    address_id: j?.address?.id ?? undefined,
    address_street: j?.address?.street ?? undefined,
    // A recurring visit (maintenance plan) is not a return trip; callers
    // separating callbacks from plan visits filter on this.
    recurrence_id: j?.recurrence_id ?? undefined,
    // Set when the job was created through Housecall Pro's convert flow.
    // Its absence proves nothing: on a real book, none of 38 approved
    // estimates whose work was completed and paid carried the link -
    // shops book the job by hand and the estimate never learns.
    original_estimate_id: j?.original_estimate_id ?? undefined,
    employees: employees.length ? employees : undefined,
    total_dollars: centsToDollars(j?.total_amount),
    outstanding_dollars: centsToDollars(j?.outstanding_balance),
    tags: Array.isArray(j?.tags) && j.tags.length ? j.tags : undefined,
    // Office notes ride the job record and are usually the only place the
    // story lives - why a job was canceled, what the customer said. Long
    // ones are clipped; the row is a lead, not an archive.
    notes: Array.isArray(j?.notes) && j.notes.length
      ? j.notes.map((n: any) => {
          const content = String(n?.content ?? "");
          return content.length > 500 ? `${content.slice(0, 500)}…` : content;
        })
      : undefined,
  };
}

/**
 * Does a trimmed job row belong to this technician? Housecall Pro offers no
 * employee filter on /jobs, so this runs over the rows a query already
 * returned - never over the whole account. An id matches exactly; anything
 * else is a case-insensitive substring of the assigned employee's name, so
 * "smith" finds "Pat Smith" without needing the id first.
 */
function jobHasEmployee(row: any, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const employees = Array.isArray(row?.employees) ? row.employees : [];
  return employees.some((e: any) => {
    const id = String(e?.id ?? "").toLowerCase();
    const name = String(e?.name ?? "").toLowerCase();
    return (id !== "" && id === q) || (name !== "" && name.includes(q));
  });
}

function trimInvoice(inv: any) {
  return {
    id: inv?.id,
    invoice_number: inv?.invoice_number,
    job_id: inv?.job_id,
    status: inv?.status,
    service_date: inv?.service_date,
    due_at: inv?.due_at,
    amount_dollars: centsToDollars(inv?.amount),
    subtotal_dollars: centsToDollars(inv?.subtotal),
    due_amount_dollars: centsToDollars(inv?.due_amount),
    items: Array.isArray(inv?.items)
      ? inv.items.map((i: any) => i?.name).filter(Boolean)
      : undefined,
  };
}

/**
 * The detail record behind an invoice: richer than the row in a list, though
 * the job it belongs to is carried on the list row and not here.
 */
function trimInvoiceDetail(inv: any) {
  return {
    id: inv?.id,
    invoice_number: inv?.invoice_number,
    status: inv?.status,
    service_date: inv?.service_date,
    invoice_date: inv?.invoice_date,
    due_at: inv?.due_at,
    due_terms: inv?.display_due_concept || inv?.due_concept || undefined,
    sent_at: inv?.sent_at,
    paid_at: inv?.paid_at,
    amount_dollars: centsToDollars(inv?.amount),
    subtotal_dollars: centsToDollars(inv?.subtotal),
    due_amount_dollars: centsToDollars(inv?.due_amount),
    items: Array.isArray(inv?.items)
      ? inv.items.map((i: any) => ({
          id: i?.id,
          name: i?.name,
          description: i?.description || undefined,
          type: i?.type,
          // Quantities arrive in hundredths here: 100 means one.
          quantity:
            typeof i?.qty_in_hundredths === "number" ? i.qty_in_hundredths / 100 : i?.quantity,
          unit_price_dollars: centsToDollars(i?.unit_price),
          unit_cost_dollars: centsToDollars(i?.unit_cost),
          amount_dollars: centsToDollars(i?.amount),
        }))
      : undefined,
    payments: Array.isArray(inv?.payments)
      ? inv.payments.map((p: any) => ({
          id: p?.id,
          status: p?.status,
          payment_method: p?.payment_method,
          paid_at: p?.paid_at ?? p?.created_at,
          amount_dollars: centsToDollars(p?.amount),
          surcharge_fee_dollars: centsToDollars(p?.surcharge_fee_amount) ?? undefined,
          note: p?.note || undefined,
        }))
      : undefined,
    // Refunds arrive alongside payments. They are handed back as they came,
    // with the money in dollars like every other amount here.
    refunds: Array.isArray(inv?.refunds)
      ? inv.refunds.map((r: any) => {
          const { amount, ...rest } = r ?? {};
          return { ...rest, amount_dollars: centsToDollars(amount) };
        })
      : undefined,
    taxes: Array.isArray(inv?.taxes)
      ? inv.taxes.map((t: any) => ({
          name: t?.name,
          // Rates arrive in thousandths of a percent: 8750 means 8.75%.
          rate_percent: typeof t?.rate === "number" ? t.rate / 1000 : undefined,
          amount_dollars: centsToDollars(t?.amount),
        }))
      : undefined,
    discounts: Array.isArray(inv?.discounts)
      ? inv.discounts.map((d: any) => ({ name: d?.name, amount_dollars: centsToDollars(d?.amount) }))
      : undefined,
  };
}

function trimAppointment(a: any) {
  return {
    id: a?.id,
    start_date: a?.start_date ?? undefined,
    start_time: a?.start_time,
    end_time: a?.end_time,
    anytime: a?.anytime,
    arrival_window_minutes: a?.arrival_window_minutes,
    dispatched_employees_ids: Array.isArray(a?.dispatched_employees_ids)
      ? a.dispatched_employees_ids
      : undefined,
  };
}

/**
 * Housecall Pro takes an arrival window only from this list and rejects any
 * other number outright. Offering it as a list rather than a free number means
 * a caller cannot pick a value that was never going to be accepted.
 */
const ARRIVAL_WINDOW = z.union([
  z.literal(0),
  z.literal(15),
  z.literal(20),
  z.literal(60),
  z.literal(120),
  z.literal(180),
  z.literal(240),
]);

const ARRIVAL_WINDOW_VALUES = "0, 15, 20, 60, 120, 180 or 240";

/** One address, trimmed to what tells two of them apart. */
function trimAddress(a: any) {
  return {
    id: a?.id,
    street: a?.street,
    street_line_2: a?.street_line_2 || undefined,
    city: a?.city,
    state: a?.state,
    zip: a?.zip,
    country: a?.country || undefined,
  };
}

function trimEstimate(e: any) {
  const options = Array.isArray(e?.options) ? e.options : [];
  return {
    id: e?.id,
    estimate_number: e?.estimate_number,
    work_status: e?.work_status,
    created_at: e?.created_at,
    customer_id: e?.customer?.id,
    customer_name: e?.customer
      ? `${e.customer.first_name ?? ""} ${e.customer.last_name ?? ""}`.trim() || undefined
      : undefined,
    option_count: options.length || undefined,
    // The option ids here are what the approve/decline tools take, and the
    // per-option approval_status is what a follow-up queue filters on;
    // updated_at is when that status last moved, which is what "approved
    // five days ago and still not scheduled" is computed from.
    options: options.length
      ? options.map((o: any) => {
          // The pitch the shop sent with the option; a follow-up that
          // repeats it word for word reads as automation, so it rides
          // along (clipped) for drafts to reference instead.
          const msg = typeof o?.message_from_pro === "string" ? o.message_from_pro.trim() : "";
          return {
            id: o?.id,
            name: o?.name || undefined,
            approval_status: o?.approval_status ?? null,
            updated_at: o?.updated_at ?? undefined,
            total_dollars: centsToDollars(o?.total_amount ?? o?.amount),
            message_from_pro: msg ? (msg.length > 300 ? `${msg.slice(0, 300)}…` : msg) : undefined,
          };
        })
      : undefined,
  };
}

/* ---------- CSV export ---------- */

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvEscape(row[c])).join(","));
  return lines.join("\n");
}

/* ---------- date helpers ---------- */

function inWindow(dateStr: unknown, since?: string, until?: string): boolean {
  if (typeof dateStr !== "string" || !dateStr) return false;
  const d = dateStr.slice(0, 10);
  if (since && d < since) return false;
  if (until && d > until) return false;
  return true;
}

/* ---------- job and tag helpers ---------- */

/**
 * Housecall Pro answers reads on an archived job with a 400 rather than an
 * empty result. That is a fact about the job, not a failure of the request,
 * so a caller walking a list of jobs should skip it and keep going.
 *
 * The match is the phrase Housecall Pro uses for this, "archived job". A 400
 * about an archived customer, address or employee is a real failure and has to
 * surface as one, including when it mentions the job in passing.
 */
const ARCHIVED_JOB_MESSAGE = /\barchived\s+job\b/i;

function isArchivedJob(e: unknown): boolean {
  return (
    e instanceof HcpApiError &&
    e.status === 400 &&
    ARCHIVED_JOB_MESSAGE.test(`${e.body ?? ""} ${e.message}`)
  );
}

/**
 * A Housecall Pro tag id is the tag_ prefix followed by a long hexadecimal
 * string. Matching the whole shape rather than the prefix alone means a tag
 * whose name happens to start with "tag_" is still looked up by name.
 */
const TAG_ID_SHAPE = /^tag_[0-9a-f]{8,}$/i;

/** Pages of tags read while resolving a name. 100 tags a page. */
const TAG_SEARCH_PAGES = 50;

/**
 * Housecall Pro attaches tags to a job by id, never by name. Anything that is
 * not already a tag id is looked up against the account's tags by exact name,
 * so a name never reaches the API and comes back as a confusing error.
 *
 * If the account holds more tags than the search covers, the answer says the
 * search was incomplete rather than claiming the tag does not exist.
 */
async function resolveTagId(
  hcp: HcpClient,
  given: string,
): Promise<
  | { tag_id: string }
  | { error: string; tag_search_complete: boolean; near_matches?: string[] }
> {
  if (TAG_ID_SHAPE.test(given)) return { tag_id: given };

  const tags: any[] = [];
  let complete = true;
  for (let page = 1; page <= TAG_SEARCH_PAGES; page++) {
    const json = await hcp.request("/tags", { page, page_size: 100 });
    const { items, total_pages } = hcp.normalizeList(json);
    tags.push(...(items as any[]));
    if (items.length === 0) break;
    if (total_pages !== undefined && page >= total_pages) break;
    if (items.length < 100) break;
    if (page === TAG_SEARCH_PAGES) complete = false;
  }

  const wanted = given.trim().toLowerCase();
  const exact = tags.find((t) => String(t?.name ?? "").trim().toLowerCase() === wanted);
  if (exact?.id) return { tag_id: exact.id };

  const near = tags
    .filter((t) => {
      const name = String(t?.name ?? "").trim().toLowerCase();
      return name.length > 0 && (name.includes(wanted) || wanted.includes(name));
    })
    .map((t) => `${t?.name} (${t?.id})`)
    .slice(0, 10);

  const found = complete
    ? `no tag on this account is named exactly that`
    : `it did not match any of the ${tags.length} tags read, and the account holds more than that. ` +
      `The search is incomplete, so a tag with that name may still exist`;

  return {
    error:
      `"${given}" is not a tag id, and ${found}. ` +
      `Housecall Pro identifies tags by id (tag_...), so pass the id rather than the name. ` +
      `Use hcp_list_tags to see every tag, or hcp_create_tag to add one.`,
    tag_search_complete: complete,
    ...(near.length ? { near_matches: near } : {}),
  };
}

/* ---------- attachments ---------- */

/**
 * Attachments have no route of their own; they arrive by asking for them with
 * `expand`. The download link is an AWS signed URL minted per request - the same
 * attachment listed twice carries two different links - so it is handed to the
 * caller to use now, never stored.
 */
function trimAttachment(a: any) {
  return {
    id: a?.id,
    file_name: a?.file_name,
    file_type: a?.file_type,
    download_url: a?.url,
  };
}

/**
 * The link is the handle a tool needs, and nothing more than that.
 *
 * A download_url reaches a photo of someone's home or plant room without any
 * further credential, and the ones hanging off an equipment or customer record
 * carry no expiry at all - so a link repeated into a reply, a note or a message
 * is a working way in, left somewhere nobody is guarding. Job and estimate
 * links are minted per response and die within the hour, which is a different
 * problem with the same instruction: use it in the turn you read it.
 */
const ATTACHMENT_NOTE =
  "A download_url is the handle on the file: hand it straight to the tool that needs it, in the same turn, " +
  "and do not repeat it in a reply, a note or a message. Some of these are minted for this response and expire " +
  "within the hour; others carry no expiry at all, so a copy of one keeps working wherever it is left.";

/** Count attachments across a list response, for the note. */
function countAttachments(rows: any[]): number {
  return rows.reduce(
    (n, r) => n + (Array.isArray(r?.attachments) ? r.attachments.length : 0),
    0,
  );
}

/* ---------- write verification ---------- */

/**
 * Read a record back after writing it, and say plainly whether the write
 * actually landed.
 *
 * This exists because Housecall Pro answers 200 on writes that change nothing
 * (see api-notes: patch-jobs-silent-200). A 2xx is therefore not evidence, and
 * a tool that returns the API's success response is reporting something it has
 * not established. Every write that has a route to read back through goes
 * through here.
 *
 * `check` receives the re-read record and returns true when the intended change
 * is visible. A read-back that itself fails is reported as unknown rather than
 * as a failed write: the write may well have succeeded and the verification is
 * what broke, and claiming otherwise would be its own wrong answer.
 */
async function verifyWrite<T>(
  result: unknown,
  readBack: () => Promise<T>,
  check: (record: T) => boolean | "unknown",
  what: string,
): Promise<Record<string, unknown>> {
  let record: T;
  try {
    record = await readBack();
  } catch (e) {
    return {
      result,
      verified: "unknown",
      verification_note:
        `The write was accepted, but reading ${what} back to confirm it failed: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        `${CORE_RULE} Check the record in Housecall Pro before relying on this.`,
    };
  }

  const ok = check(record);

  // A check that cannot tell must say so. Reporting "not done" for a write that
  // did land is worse than reporting nothing: it invites a retry of a write that
  // already happened, and it is a confident wrong answer of exactly the kind
  // this whole mechanism exists to prevent.
  if (ok === "unknown") {
    return {
      result,
      verified: "unknown",
      verification_note:
        `The write was accepted and ${what} was read back, but the record did not carry the field ` +
        `in a form this server recognises, so the change could be neither confirmed nor ruled out. ` +
        `${CORE_RULE} Check it in Housecall Pro rather than assuming either way.`,
    };
  }

  return {
    result,
    verified: ok,
    ...(ok
      ? { verification_note: `Confirmed by reading ${what} back after the write.` }
      : {
          verification_note:
            `Housecall Pro accepted this write and answered success, but reading ${what} back ` +
            `does not show the change. This is the silent-success behaviour described in hcp_api_notes. ` +
            `Treat the write as NOT done and do not report it as done.`,
          record_after_write: record,
        }),
  };
}

/**
 * Whether a job record carries a given tag, by id or by name.
 *
 * Housecall Pro is not consistent about how tags ride on a job - they can arrive
 * as ids, as names, or as objects carrying both - so every shape that could
 * reasonably identify a tag is checked. If the record carries no tag field this
 * server can read, the answer is "unknown" and never false, because a shape this
 * code does not recognise says nothing about whether the write landed.
 */
function jobCarriesTag(job: any, tagId: string, tagName?: string): boolean | "unknown" {
  const tags = job?.tags;
  if (!Array.isArray(tags)) return "unknown";

  const wanted = new Set(
    [tagId, tagName].filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => v.toLowerCase()),
  );

  let recognised = false;
  for (const t of tags) {
    if (typeof t === "string") {
      recognised = true;
      if (wanted.has(t.toLowerCase())) return true;
    } else if (t && typeof t === "object") {
      const id = (t as any).id;
      const name = (t as any).name;
      if (typeof id === "string" || typeof name === "string") recognised = true;
      if (typeof id === "string" && wanted.has(id.toLowerCase())) return true;
      if (typeof name === "string" && wanted.has(name.toLowerCase())) return true;
    }
  }

  // An empty list is a real answer: the job carries no tags, so it does not
  // carry this one. A non-empty list of shapes we could not read is not.
  if (tags.length === 0) return false;
  return recognised ? false : "unknown";
}

/**
 * Whether a re-read record shows the scalar values a write sent. Only the fields
 * the write actually carried are weighed - a field it never sent says nothing
 * about whether the write landed. Arrays and nested objects are skipped: they do
 * not compare cleanly and a mismatch there would be a false negative. Numbers are
 * matched as rounded integers so cents and quantities line up; booleans and
 * strings by value. Returns false the moment a sent scalar disagrees, true when
 * at least one sent scalar agrees and none disagree, and "unknown" when nothing
 * could be compared - so a shape this code cannot read never reports a real write
 * as failed.
 */
export function writeLanded(record: unknown, sent: Record<string, unknown>): boolean | "unknown" {
  if (!record || typeof record !== "object") return "unknown";
  let comparable = 0;
  for (const [key, value] of Object.entries(sent)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) || typeof value === "object") continue;
    const got = (record as Record<string, unknown>)[key];
    if (got === undefined) continue;
    comparable++;
    const mismatch =
      typeof value === "number" && typeof got === "number"
        ? Math.round(value) !== Math.round(got)
        : typeof value === "boolean"
          ? Boolean(got) !== value
          : String(got) !== String(value);
    if (mismatch) return false;
  }
  return comparable > 0 ? true : "unknown";
}

/**
 * Whether a re-read record carries every id a crew write sent. Ids can ride as
 * bare strings or as objects that name one, so both shapes are read. A value that
 * is not a list of ids at all is "unknown" rather than a false negative, and an
 * empty target list is true (nothing was asked for). Used to confirm a dispatch
 * or an appointment's crew by reading the record back instead of echoing the
 * input as the result.
 */
export function recordHasIds(got: unknown, want: string[]): boolean | "unknown" {
  if (!Array.isArray(got)) return "unknown";
  const ids = new Set(
    got
      .map((x) => (typeof x === "string" ? x : (x as any)?.id))
      .filter((x): x is string => typeof x === "string" && x.length > 0),
  );
  if (got.length > 0 && ids.size === 0) return "unknown";
  return want.every((id) => ids.has(id));
}

/* ---------- tool registration ---------- */

/**
 * Build the registration helper every tool in this package goes through.
 *
 * Registration is centralised rather than each tool calling `server.tool`
 * itself, so that surface gating, annotations and the undeclared-parameter
 * refusal are applied once and inherited by anything added later. A tool
 * absent from TOOL_SPECS still registers - the hygiene check is what catches
 * it - but it registers without annotations rather than being mislabelled as
 * a read.
 *
 * The parameter refusal has two halves, because one is not enough. The
 * handler is wrapped so an undeclared argument is refused before a request is
 * built; and the registered schema is widened to let that argument reach the
 * wrapper at all, since the SDK otherwise parses it away silently - the tool
 * runs with the filter missing and the caller is told nothing. A schema that
 * advertises no extra properties does not prevent this: the invented filter
 * that prompted the guard was sent against a schema that already said so.
 */
export function makeToolRegistrar(server: McpServer, opts: SurfaceOptions) {
  return <Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    handler: ToolCallback<Args>,
  ) => {
    if (!shouldRegister(name, opts)) return;
    const declared = Object.keys(schema);
    const guarded = ((args: any, extra: any) => {
      const refusal = unknownParameterRefusal(name, args, declared);
      if (refusal) return errOut(refusal);
      return (handler as any)(args, extra);
    }) as ToolCallback<Args>;

    const spec = TOOL_SPECS[name];
    const registered = spec
      ? server.tool(name, description, schema, annotationsFor(name, spec), guarded)
      : server.tool(name, description, schema, guarded);

    // Keep undeclared arguments alive as far as the wrapper above. Without
    // this the SDK hands the handler a cleaned-up object and the refusal has
    // nothing to refuse. An embedder passing a stand-in server gets nothing
    // back here, and needs nothing: it calls the wrapped handler directly.
    if (registered && typeof registered === "object" && "inputSchema" in registered) {
      registered.inputSchema = z.object(schema as unknown as z.ZodRawShape).passthrough();
    }
  };
}

/**
 * Register the tool surface.
 *
 * `opts` decides which tools exist at all: a read-only install never registers
 * a mutating tool, and a toolset selection keeps the list a client has to hold
 * in context down to the groups actually in use. Defaults expose everything, so
 * an embedder that does not care gets the whole surface as before.
 */
export function registerTools(
  server: McpServer,
  hcp: HcpClient,
  opts: SurfaceOptions = { readOnly: false, toolsets: [...TOOLSETS] },
) {
  const tool = makeToolRegistrar(server, opts);

  tool(
    "hcp_get_company",
    "Get the Housecall Pro company profile (name, phone, address, logo URL) for the connected account, " +
      "along with the two scheduling defaults it carries: the account's time zone, and the arrival window it gives a customer unless a booking names another. " +
      "Either one is reported only when the account actually carries it, so a setting nobody has configured never reads as a configured zero.",
    {},
    async () => {
      try {
        const json = await hcp.request("/company");
        // Pulled out of the passthrough and named, because a booking is made in
        // the account's own time zone and rejected on an unaccepted window.
        const { time_zone, default_arrival_window, ...rest } = (json ?? {}) as any;
        const hasWindow = typeof default_arrival_window === "number";
        return out(
          {
            ...rest,
            ...(typeof time_zone === "string" && time_zone ? { time_zone } : {}),
            ...(hasWindow ? { default_arrival_window_minutes: default_arrival_window } : {}),
          },
          hasWindow
            ? `default_arrival_window_minutes is in minutes. Housecall Pro accepts ${ARRIVAL_WINDOW_VALUES} for an arrival window and rejects anything else.`
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_schedule_availability",
    "Read the account's own working hours: the weekly windows it takes work in, and how many days ahead a booking can be made. " +
      "Read it before offering a customer a time, so what you offer is a time the account actually works. " +
      "An account with nothing configured is a normal answer rather than a failure - it means these hours have never been set up in Housecall Pro, " +
      "and one account having them says nothing about another.",
    {},
    async () => {
      try {
        const json = await hcp.request("/company/schedule_availability");
        const root: any = json ?? {};
        // Working hours arrive as a day list, and each day carries its own list
        // of windows - two levels of Housecall Pro's list envelope, neither of
        // which is an array at the top. Flattening here is what lets a caller
        // ask "does this account work then?" without walking the shape.
        const days: any[] = hcp.normalizeList(root.daily_availabilities ?? []).items as any[];
        const windows = days.flatMap((day: any) =>
          (hcp.normalizeList(day?.schedule_windows ?? []).items as any[]).map((w: any) => ({
            day: day?.day_name,
            start_time: w?.start_time,
            end_time: w?.end_time,
          })),
        );
        const buffer = root?.availability_buffer_in_days;
        return out(
          {
            availability_buffer_in_days: typeof buffer === "number" ? buffer : undefined,
            window_count: windows.length,
            windows,
          },
          windows.length === 0
            ? "This account has no scheduling windows configured in Housecall Pro. That is a normal answer, not an error - nobody has set its working hours, so this read cannot tell you when it works. Ask before assuming a time is workable."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_booking_windows",
    "List the slots Housecall Pro reports as bookable for this account: each one's start, its end, and whether it is actually open. " +
      "Use it to answer what is free before booking a visit, rather than picking a time and finding out on the write. " +
      "An account reporting no slots is a normal answer rather than a failure, and one account having them says nothing about another.",
    {},
    async () => {
      try {
        const json = await hcp.request("/company/schedule_availability/booking_windows");
        const { items } = hcp.normalizeList(json);
        const slots = (items as any[]).map((s) => ({
          start_time: s?.start_time,
          end_time: s?.end_time,
          available: s?.available,
        }));
        return out(
          {
            slot_count: slots.length,
            available_count: slots.filter((s) => s.available === true).length,
            slots,
          },
          slots.length === 0
            ? "Housecall Pro reports no booking windows for this account. That is a normal answer, not an error - none is configured, so this read cannot tell you what is free."
            : "A slot carrying available false is passed on as it came back: the window exists but is not open to book.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_search_customers",
    "Search customers by name, email, phone, company, or service address, and/or filter by tag. " +
      "Housecall Pro matches the query against service addresses too, so a street can be searched for directly - useful when a caller gives an address and not a name. " +
      "Rows carry each customer's addresses, so two people with the same name can be told apart without a second call; use hcp_get_customer for full detail. " +
      "Free-text search does NOT cover tags - to find customers carrying a tag, pass tag_ids (get ids from hcp_list_tags).",
    {
      query: z
        .string()
        .optional()
        .describe("Free-text search (name, email, phone, company, service address)"),
      tag_ids: z
        .array(z.string())
        .optional()
        .describe("Only customers carrying these tag ids (tag_...), from hcp_list_tags"),
      page: z.number().int().min(1).optional().describe("Page number, default 1"),
      page_size: z.number().int().min(1).max(100).optional().describe("Rows per page, default 25, max 100"),
    },
    async ({ query, tag_ids, page, page_size }) => {
      try {
        const json = await hcp.request("/customers", {
          q: query,
          "tag_ids[]": tag_ids,
          page: page ?? 1,
          page_size: page_size ?? 25,
        });
        const { items, total_items, total_pages } = hcp.normalizeList(json);
        const customers = (items as any[]).map((c) => {
          // Every address, not just the first: a match may have been made on
          // the second one, and a caller disambiguating needs to see it.
          const addresses = Array.isArray(c?.addresses) ? c.addresses.map(trimAddress) : [];
          return { ...trimCustomer(c), ...(addresses.length ? { addresses } : {}) };
        });
        // An empty search is two different answers - nothing matched, or the
        // filter never applied - and on tag_ids a non-empty answer has its own
        // trap: a tag id dropped upstream returns the whole book, not a slice.
        const note =
          customers.length === 0
            ? emptyFilterNote({ query, tag_ids })
            : tag_ids?.length
              ? "Filtered by tag_ids. If this reads like the whole customer book rather than a slice, the tag filter may have been dropped upstream - an unrecognised tag_ids value is ignored, not refused - so verify the tag id against hcp_list_tags."
              : undefined;
        return out(
          {
            total_items,
            total_pages,
            has_more: typeof total_pages === "number" ? (page ?? 1) < total_pages : undefined,
            page: page ?? 1,
            customers,
          },
          note,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_customer",
    "Get one customer's full record (all addresses, notifications, tags) by customer id. " +
      "Set include_attachments to get the customer's files with download links.",
    {
      customer_id: z.string().describe("Customer id, e.g. cus_..."),
      include_attachments: z
        .boolean()
        .optional()
        .describe("Include the customer's files, each with a signed download link"),
    },
    async ({ customer_id, include_attachments }) => {
      try {
        const params = include_attachments ? { "expand[]": "attachments" } : undefined;
        const json = await hcp.request(`/customers/${customer_id}`, params);
        const equipment = carriesEquipmentIdentity(json) ? "" : ` ${EQUIPMENT_ON_A_CUSTOMER}`;
        if (!include_attachments) return out(json, equipment.trim() || undefined);
        const attachments = Array.isArray((json as any)?.attachments)
          ? (json as any).attachments.map(trimAttachment)
          : [];
        return out(
          { ...(json as any), attachments },
          `${attachments.length} attachment(s). ${ATTACHMENT_NOTE}${equipment}`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_contactability",
    "Check whether customers are safe to contact by reading every do-not-contact signal the API can see " +
      "and naming the one it cannot. For each customer id it reads the public record and reports three signals: " +
      "notifications switched off, a do-not-contact tag (Do Not Service, No Marketing, DNS, opt-out...), and " +
      "do-not-contact language in the customer notes. `contactable` is true only when none of those are present.\n\n" +
      "Notes are read clause by clause, so \"we do not service gas\" (about the shop's services) and \"customer " +
      "refused to pay\" (narrative) do not suppress anyone. Two kinds of clause come back under `review` with the " +
      "clause quoted, because neither verdict is safe without a human: a CONDITIONAL gate (\"do not schedule " +
      "without a deposit\") and a REVERSAL (\"removed from DNS\"). A customer with `needs_review: true` is not " +
      "cleared until someone reads the quoted clause.\n\n" +
      "Read this before any outreach. But note the hard limit: Housecall Pro's Do Not Service checkbox is a dashboard " +
      "setting this integration cannot read, so it is always returned under `unverifiable`. A `contactable: true` " +
      "therefore means \"no suppression signal was found on the readable surface\" - it is NOT a clearance to contact. " +
      "Confirm the Do Not Service checkbox in Housecall Pro before reaching a customer.",
    {
      customer_ids: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe("Customer ids (cus_...) to check, up to 100. One API read per id."),
    },
    async ({ customer_ids }) => {
      try {
        const results: Array<Record<string, unknown>> = [];
        for (const id of customer_ids) {
          let c: any;
          try {
            c = await hcp.request(`/customers/${encodeURIComponent(id)}`);
          } catch (e) {
            // One bad id must not sink the batch: record it and move on.
            results.push({
              customer_id: id,
              error: e instanceof HcpApiError ? e.message : String(e),
            });
            continue;
          }
          const { signals, review } = analyzeContactability(c);
          const name =
            [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() ||
            c?.company ||
            undefined;
          results.push({
            customer_id: id,
            ...(name ? { name } : {}),
            contactable: signals.length === 0,
            ...(review.length ? { needs_review: true } : {}),
            signals,
            ...(review.length ? { review } : {}),
            unverifiable: UNVERIFIABLE,
          });
        }
        const suppressed = results.filter((r) => r.contactable === false).length;
        const needsReview = results.filter((r) => r.needs_review === true).length;
        const errored = results.filter((r) => "error" in r).length;
        return out(
          {
            count: results.length,
            suppressed,
            ...(needsReview ? { needs_review: needsReview } : {}),
            ...(errored ? { errored } : {}),
            results,
          },
          "contactable:true means no suppression signal was found on the readable surface - it is NOT a clearance. " +
            "A needs_review customer is not cleared either way until a human reads the quoted clause. " +
            "The Do Not Service checkbox is a dashboard setting this integration cannot read; confirm it in Housecall Pro before contacting.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_jobs",
    "List jobs, optionally filtered by work status, scheduled date range, customer, or assigned technician. " +
      "Each row carries an employees field - the technicians assigned to that job, with id and name - so who is " +
      "on a job is read off the row rather than assumed. Rows also carry on_my_way_at and started_at, which are " +
      "how a job being worked right now shows itself. Rows carrying a deleted_at value are deleted jobs - " +
      "exclude them from counts and revenue.",
    {
      work_status: z
        .array(z.enum(["scheduled", "in progress", "completed", "canceled", "needs scheduling"]))
        .optional()
        .describe("Filter by one or more statuses (server-side)"),
      scheduled_start_min: z
        .string()
        .optional()
        .describe(
          "ISO date/datetime lower bound for the scheduled start. Pass your own local offset, e.g. " +
            "2026-08-13T00:00:00-04:00, not a bare UTC day: a UTC window against a business running in a local " +
            "timezone shifts the day, so an evening job falls outside \"today\" and a late job from the day " +
            "before falls inside it.",
        ),
      scheduled_start_max: z
        .string()
        .optional()
        .describe(
          "ISO date/datetime upper bound for the scheduled start. Use the same local offset as " +
            "scheduled_start_min, e.g. 2026-08-14T00:00:00-04:00 for the end of a local day.",
        ),
      customer_id: z.string().optional().describe("Only jobs for this customer id"),
      employee: z
        .string()
        .optional()
        .describe(
          "Keep only jobs assigned to this technician - an employee id (from hcp_list_employees), or part of a " +
            "name, matched case-insensitively against each row's employees. Housecall Pro has no employee filter " +
            "on this endpoint, so this narrows the rows the OTHER filters returned, page by page: pair it with a " +
            "tight scheduled window (and raise page_size) or a technician's job can sit on a page you never " +
            "fetched. The reported totals count the rows before this filter.",
        ),
      include_attachments: z
        .boolean()
        .optional()
        .describe(
          "Include each job's files with signed download links. This is the only way to reach attachments in bulk.",
        ),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ work_status, scheduled_start_min, scheduled_start_max, customer_id, employee, include_attachments, page, page_size }) => {
      try {
        const json = await hcp.request("/jobs", {
          "work_status[]": work_status,
          scheduled_start_min,
          scheduled_start_max,
          customer_id,
          ...(include_attachments ? { "expand[]": "attachments" } : {}),
          page: page ?? 1,
          page_size: page_size ?? 25,
        });
        const { items, total_items, total_pages } = hcp.normalizeList(json);
        const allRows = items.map((j: any) =>
          include_attachments
            ? {
                ...trimJob(j),
                attachments: Array.isArray(j?.attachments)
                  ? j.attachments.map(trimAttachment)
                  : [],
              }
            : trimJob(j),
        );
        // The employee narrowing happens here because the API offers none.
        // Both counts are reported so the caller can see what was dropped
        // rather than reading the result as the whole account's answer.
        const filtering = typeof employee === "string" && employee.trim() !== "";
        const rows = filtering ? allRows.filter((r) => jobHasEmployee(r, employee)) : allRows;
        const statusNote = `The work_status field in responses uses HCP's human vocabulary ("complete unrated", "user canceled", ...) - the work_status_bucket field normalizes it.`;
        const employeeNote = filtering
          ? ` Housecall Pro has no employee filter, so "${employee}" was matched here against the employees on ` +
            `the ${allRows.length} row(s) this page returned: ${rows.length} matched. total_items and total_pages ` +
            `count the rows before that match, and a job on another page was never looked at.`
          : "";
        // A filtered read that matched nothing is two different answers, and
        // an agent that cannot tell them apart reports the wrong one.
        const empty = rows.length
          ? ""
          : ` ${
              emptyFilterNote({
                work_status,
                scheduled_start_min,
                scheduled_start_max,
                customer_id,
                employee,
              }) ?? ""
            }`.trimEnd();
        return out(
          {
            total_items,
            total_pages,
            has_more: typeof total_pages === "number" ? (page ?? 1) < total_pages : undefined,
            page: page ?? 1,
            ...(filtering
              ? {
                  employee_filter: employee,
                  rows_on_page: allRows.length,
                  matched_on_page: rows.length,
                }
              : {}),
            jobs: rows,
          },
          include_attachments
            ? `${MONEY_NOTE} ${statusNote} ${countAttachments(filtering ? rows : (items as any[]))} attachment(s) on this page. ${ATTACHMENT_NOTE}${employeeNote}${empty}`
            : `${MONEY_NOTE} ${statusNote}${employeeNote}${empty}`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_job",
    "Get one job's full record by job id. For what was actually billed on a completed job, use the invoice items. " +
      "Set include_attachments to get the job's photos and documents with download links - there is no other way to reach them.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      include_attachments: z
        .boolean()
        .optional()
        .describe("Include the job's files, each with a signed download link"),
    },
    async ({ job_id, include_attachments }) => {
      try {
        const params = include_attachments ? { "expand[]": "attachments" } : undefined;
        const json = await hcp.request(`/jobs/${job_id}`, params);
        const equipment = carriesEquipmentIdentity(json) ? "" : ` ${EQUIPMENT_ON_A_JOB}`;
        if (!include_attachments) return out(json, `${MONEY_NOTE}${equipment}`);
        const attachments = Array.isArray((json as any)?.attachments)
          ? (json as any).attachments.map(trimAttachment)
          : [];
        return out(
          { ...(json as any), attachments },
          `${MONEY_NOTE} ${attachments.length} attachment(s). ${ATTACHMENT_NOTE}${equipment}`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_job_appointments",
    "List the appointments on a job: when the visit is booked, how long the arrival window is, and which technicians are dispatched. " +
      "A job can carry more than one appointment, which is how a multi-visit job is scheduled. " +
      "Archived jobs report no appointments and are flagged rather than treated as a failure, so walking a long list of jobs never stops part way.",
    { job_id: z.string().describe("Job id, e.g. job_...") },
    async ({ job_id }) => {
      try {
        const json = await hcp.request(`/jobs/${job_id}/appointments`);
        const { items } = hcp.normalizeList(json);
        return out({
          job_id,
          archived: false,
          appointment_count: items.length,
          appointments: items.map(trimAppointment),
        });
      } catch (e) {
        if (isArchivedJob(e)) {
          return out(
            {
              job_id,
              archived: true,
              appointment_count: 0,
              appointments: [],
            },
            "This job is archived, so Housecall Pro will not report its appointments. Nothing is wrong with the request. If you are working through a list of jobs, skip this one and carry on.",
          );
        }
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_checklists",
    "List the checklists attached to jobs or estimates - the task lists your technicians work through on site. " +
      "Pass one id or several. An empty list is a normal answer: it means no checklist has been set up for those records in Housecall Pro, not that anything failed.",
    {
      job_uuids: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("One job id or a list of them (job_...)"),
      estimate_uuids: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("One estimate id or a list of them (csr_...)"),
      page: z.number().int().min(1).optional(),
      per_page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Rows per page, as Housecall Pro names it on this route. Its own default is 10, and it may answer with 10 whatever you ask for.",
        ),
    },
    async ({ job_uuids, estimate_uuids, page, per_page }) => {
      const jobs = job_uuids === undefined ? [] : Array.isArray(job_uuids) ? job_uuids : [job_uuids];
      const estimates =
        estimate_uuids === undefined ? [] : Array.isArray(estimate_uuids) ? estimate_uuids : [estimate_uuids];
      if (jobs.length === 0 && estimates.length === 0) {
        return errOut(
          "Pass at least one job id or estimate id. Housecall Pro will not list checklists across the whole account, " +
            "so nothing was sent. Name the jobs or estimates you care about.",
        );
      }
      try {
        const json = await hcp.request("/checklists", {
          // The API requires these filters in array form.
          "job_uuids[]": jobs,
          "estimate_uuids[]": estimates,
          page: page ?? 1,
          per_page,
        });
        const { items, total_items, total_pages } = hcp.normalizeList(json);
        return out(
          {
            job_uuids: jobs.length ? jobs : undefined,
            estimate_uuids: estimates.length ? estimates : undefined,
            total_items,
            total_pages,
            page: page ?? 1,
            checklist_count: items.length,
            checklists: items,
          },
          items.length === 0
            ? "No checklists are attached to these records. That is a normal result, not an error - it means none has been set up for them in Housecall Pro."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_invoices",
    "List invoices, optionally within a date window and filtered by status. " +
      "Which date matters: service is when the work happened, created is when the invoice record was made, paid is when it settled, due is when payment is owed. " +
      "Only service is filtered by this server walking pages, because Housecall Pro has no server-side filter for it. " +
      "The other three are filtered by Housecall Pro itself, which is far faster and reads no more of the account than it has to - prefer one of them when it is the date you actually mean. " +
      "The status filter is applied by Housecall Pro and verified here, so an all-open or all-paid pull is one narrow read instead of a whole-account walk. " +
      "Canceled invoices keep their full balance, so anything summing money owed should filter them out.",
    {
      since: z.string().optional().describe("Earliest date in the window, YYYY-MM-DD"),
      until: z.string().optional().describe("Latest date in the window, YYYY-MM-DD"),
      date_field: z
        .enum(["service", "created", "paid", "due"])
        .optional()
        .describe(
          "Which date since/until apply to. Default service. created, paid and due are filtered by the API and are much cheaper than service.",
        ),
      statuses: z
        .array(z.enum(["paid", "open", "canceled"]))
        .optional()
        .describe(
          "Only invoices in these statuses, filtered by the API. paid, open and canceled are the vocabulary Housecall Pro actually uses on this route.",
        ),
      min_due_dollars: z
        .number()
        .optional()
        .describe("Only invoices owing at least this much, in dollars. Filtered by the API."),
      max_pages: z.number().int().min(1).max(50).optional().describe("Safety cap on pages walked (100 rows/page), default 10"),
    },
    async ({ since, until, date_field, statuses, min_due_dollars, max_pages }) => {
      try {
        const field = date_field ?? "service";
        // Housecall Pro takes an instant, not a date. The window is widened to
        // cover the whole of the last day so an inclusive date range behaves
        // like one.
        const from = since ? `${since}T00:00:00Z` : undefined;
        const to = until ? `${until}T23:59:59Z` : undefined;

        const serverParams: Record<string, unknown> = {};
        if (field === "created") {
          if (from) serverParams.created_at_min = from;
          if (to) serverParams.created_at_max = to;
        } else if (field === "paid") {
          if (from) serverParams.paid_at_min = from;
          if (to) serverParams.paid_at_max = to;
        } else if (field === "due") {
          if (from) serverParams.due_at_min = from;
          if (to) serverParams.due_at_max = to;
        }
        // Money crosses the boundary in dollars here and cents at the API.
        if (typeof min_due_dollars === "number") {
          serverParams.amount_due_min = Math.round(min_due_dollars * 100);
        }
        // The status filter only works in array form; the bare form is one of
        // the swallowed parameters. Verified below rather than trusted.
        if (statuses?.length) serverParams["status[]"] = statuses;

        const serverSide = field !== "service";
        const rows: any[] = [];
        let walked = 0;
        let stoppedEarly = false;
        let reportedTotal: number | undefined;

        outer: for (let page = 1; page <= (max_pages ?? 10); page++) {
          const json = await hcp.request("/invoices", { ...serverParams, page, page_size: 100 });
          const { items, total_pages, total_items } = hcp.normalizeList(json);
          walked = page;
          if (reportedTotal === undefined) reportedTotal = total_items;
          if (items.length === 0) break;
          for (const inv of items as any[]) {
            if (serverSide) {
              // The API already applied the window; re-filtering here would
              // drop rows whose service_date sits outside a created-date range.
              rows.push(trimInvoice(inv));
              continue;
            }
            const d = typeof inv?.service_date === "string" ? inv.service_date.slice(0, 10) : "";
            if (since && d && d < since) {
              // Page 1 returns newest first; once rows fall before the window, stop.
              stoppedEarly = true;
              break outer;
            }
            if (inWindow(inv?.service_date, since, until) || (!since && !until)) {
              rows.push(trimInvoice(inv));
            }
          }
          if (total_pages !== undefined && page >= total_pages) break;
        }

        // Prove the status filter filtered. An unsupported parameter on this
        // API is swallowed rather than refused, so rows are checked against
        // the request and any stray is removed here and called out.
        let statusStrays = 0;
        if (statuses?.length) {
          const want = new Set<string>(statuses);
          const kept = rows.filter((r: any) => want.has(String(r?.status)));
          statusStrays = rows.length - kept.length;
          if (statusStrays > 0) {
            rows.length = 0;
            rows.push(...kept);
          }
        }

        const truncated = !serverSide && !stoppedEarly && walked === (max_pages ?? 10);
        const empty = rows.length
          ? ""
          : ` ${
              emptyFilterNote({
                since,
                until,
                statuses,
                min_due_dollars,
              }) ?? ""
            }`.trimEnd();
        return out(
          {
            count: rows.length,
            date_field: field,
            filtered_by: serverSide ? "housecall pro" : "this server, page by page",
            statuses_requested: statuses?.length ? statuses : undefined,
            status_filter:
              statuses?.length
                ? statusStrays === 0
                  ? "applied by housecall pro, verified here"
                  : `housecall pro returned ${statusStrays} row(s) outside the requested statuses - removed here`
                : undefined,
            matching_invoices_on_account:
              serverSide || statuses?.length ? reportedTotal : undefined,
            pages_walked: walked,
            stopped_at_window_edge: stoppedEarly || undefined,
            may_be_incomplete: truncated || undefined,
            invoices: rows,
          },
          serverSide
            ? `${MONEY_NOTE} Housecall Pro applied this ${field}-date window itself.${empty}`
            : `${MONEY_NOTE} A service-date window is the one date Housecall Pro cannot filter on, so this server walked pages and filtered them. ` +
              (truncated
                ? `The page cap was reached, so older invoices in the window may be missing - raise max_pages, or use date_field "created" to let the API do it. `
                : "") +
              `If you meant the date the invoice was raised, settled, or is owed, pass date_field "created", "paid" or "due" and the API filters it directly.${empty}`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_invoice",
    "Get one invoice in full: line items, taxes, discounts, payments received, refunds, and what is still owed. " +
      "Use it when you need the detail behind a single invoice. The job an invoice belongs to is on its hcp_list_invoices row rather than here. Amounts in dollars.",
    { invoice_id: z.string().describe("Invoice id, e.g. invoice_...") },
    async ({ invoice_id }) => {
      try {
        const json = await hcp.request(`/api/invoices/${invoice_id}`);
        return out(trimInvoiceDetail(json), MONEY_NOTE);
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_invoice_document",
    "Get a preview of the invoice as the customer sees it: the opening of the finished, laid-out document rather than its underlying fields. " +
      "Useful for checking how an invoice reads. It is an HTML page, and these pages run to hundreds of thousands of characters, " +
      `so the first ${DOCUMENT_PREVIEW_CHARS} characters come back and the result says so. ` +
      "For the figures on an invoice use hcp_get_invoice instead. Reading a document does not send it to anyone.",
    { invoice_id: z.string().describe("Invoice id, e.g. invoice_...") },
    async ({ invoice_id }) => {
      try {
        // This route renders a document; it is never JSON, so it is never parsed.
        const { text, contentType } = await hcp.requestText(`/api/invoices/${invoice_id}/preview`);
        const truncated = text.length > DOCUMENT_PREVIEW_CHARS;
        const header = truncated
          ? `Rendered invoice document for ${invoice_id} (${contentType || "text/html"}), ` +
            `first ${DOCUMENT_PREVIEW_CHARS} of ${text.length} characters. The rest of the page was left out. ` +
            `Open the invoice in Housecall Pro for the whole document, or use hcp_get_invoice for its figures.`
          : `Rendered invoice document for ${invoice_id} (${contentType || "text/html"}), ` +
            `${text.length} characters, the whole page.`;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${header} This is the customer-facing page itself, not data. ` +
                `Reading it sent nothing to the customer.\n\n${text.slice(0, DOCUMENT_PREVIEW_CHARS)}`,
            },
          ],
        };
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_estimates",
    "List estimates (paginated, trimmed rows with option counts and totals).",
    {
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ page, page_size }) => {
      try {
        const json = await hcp.request("/estimates", {
          page: page ?? 1,
          page_size: page_size ?? 25,
        });
        const { items, total_items, total_pages } = hcp.normalizeList(json);
        return out({
          total_items,
          total_pages,
          has_more: typeof total_pages === "number" ? (page ?? 1) < total_pages : undefined,
          page: page ?? 1,
          estimates: items.map(trimEstimate),
        }, MONEY_NOTE);
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_employees",
    "List employees with roles and permissions.",
    {},
    async () => {
      try {
        const json = await hcp.request("/employees", { page_size: 100 });
        const items = hcp.normalizeList(json).items;
        return out(
          items,
          items.length === 0
            ? "No employees are configured on this account. That is a normal answer, not a failure or a permission wall."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_tags",
    "List the account's tags.",
    {},
    async () => {
      try {
        const json = await hcp.request("/tags", { page_size: 100 });
        const items = hcp.normalizeList(json).items;
        return out(
          items,
          items.length === 0
            ? "No tags on this account yet, which is normal, not a failure. Add one with hcp_create_tag."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_revenue_summary",
    "Summarize invoiced revenue for a service-date window, grouped by month or by line item. Amounts in dollars. " +
      "Canceled invoices are excluded from every figure and reported separately - they keep their full amount on this API, and counting them overstates revenue. " +
      "Two item modes: \"item\" is fast and approximate (an invoice's total split evenly across its line names); \"item_billed\" reads each invoice's detail and " +
      "sums what each line actually billed - exact, but one extra request per invoice. A month or a quarter is its comfortable size; a whole year runs minutes and " +
      "can outlast a client's own tool timeout, so for wide windows prefer \"item\" first and verify the items that matter with a narrower item_billed pass.",
    {
      since: z.string().describe("Earliest service date, YYYY-MM-DD"),
      until: z.string().optional().describe("Latest service date, YYYY-MM-DD (default: today)"),
      group_by: z.enum(["month", "item", "item_billed"]).optional().describe("Aggregation, default month. item_billed is exact per-line revenue at one detail read per invoice"),
      max_pages: z.number().int().min(1).max(50).optional().describe("Safety cap on pages walked (100 rows/page), default 20"),
      max_detail_reads: z.number().int().min(1).max(2000).optional().describe("item_billed only: cap on per-invoice detail reads, default 500. Invoices past the cap are counted, not silently dropped"),
    },
    async ({ since, until, group_by, max_pages, max_detail_reads }) => {
      try {
        const groups = new Map<string, { count: number; amount_cents: number }>();
        const mode = group_by ?? "month";
        const billedIds: string[] = [];
        let count = 0;
        let totalCents = 0;
        let canceledCount = 0;
        let canceledCents = 0;
        let walked = 0;
        let reachedWindowFloor = false;
        let ranOut = false;
        outer: for (let page = 1; page <= (max_pages ?? 20); page++) {
          const json = await hcp.request("/invoices", { page, page_size: 100 });
          const { items, total_pages } = hcp.normalizeList(json);
          walked = page;
          if (items.length === 0) {
            ranOut = true;
            break;
          }
          for (const inv of items as any[]) {
            const d = typeof inv?.service_date === "string" ? inv.service_date.slice(0, 10) : "";
            if (d && d < since) {
              reachedWindowFloor = true;
              break outer;
            }
            if (!inWindow(inv?.service_date, since, until)) continue;
            const cents = typeof inv?.amount === "number" ? inv.amount : 0;
            // A canceled invoice keeps its full amount on this API. It is not
            // revenue, so it stays out of the totals and is counted aside.
            if (String(inv?.status) === "canceled") {
              canceledCount++;
              canceledCents += cents;
              continue;
            }
            count++;
            totalCents += cents;
            if (mode === "month") {
              const key = d.slice(0, 7) || "unknown";
              const g = groups.get(key) ?? { count: 0, amount_cents: 0 };
              g.count++;
              g.amount_cents += cents;
              groups.set(key, g);
            } else if (mode === "item_billed") {
              if (inv?.id) billedIds.push(String(inv.id));
            } else {
              const names: string[] = Array.isArray(inv?.items)
                ? inv.items.map((i: any) => String(i?.name ?? "unnamed"))
                : ["(no items)"];
              for (const name of names) {
                const g = groups.get(name) ?? { count: 0, amount_cents: 0 };
                g.count++;
                g.amount_cents += Math.round(cents / names.length);
                groups.set(name, g);
              }
            }
          }
          if (total_pages !== undefined && page >= total_pages) {
            ranOut = true;
            break;
          }
        }
        // Exact per-line revenue: one detail read per in-window invoice, spent
        // here rather than approximated. The cap is stated, and invoices past
        // it are counted rather than silently dropped.
        let detailReads = 0;
        let detailSkipped = 0;
        if (mode === "item_billed") {
          const cap = max_detail_reads ?? 500;
          for (const id of billedIds) {
            if (detailReads >= cap) { detailSkipped++; continue; }
            detailReads++;
            const detail: any = await hcp.request(`/api/invoices/${encodeURIComponent(id)}`);
            const items: any[] = Array.isArray(detail?.items) ? detail.items : [];
            for (const li of items) {
              const name = String(li?.name ?? "unnamed");
              const g = groups.get(name) ?? { count: 0, amount_cents: 0 };
              g.count++;
              g.amount_cents += typeof li?.amount === "number" ? li.amount : 0;
              groups.set(name, g);
            }
          }
        }

        // The walk is complete only when it ran past the window's floor or ran
        // out of book. Stopping at the page cap with neither means older
        // invoices in the window were never read - a silent partial total is
        // the worst answer a revenue tool can give.
        const truncated = !reachedWindowFloor && !ranOut;
        const grouped = [...groups.entries()]
          .map(([key, g]) => ({
            [ (group_by ?? "month") === "month" ? "month" : "item" ]: key,
            invoice_count: g.count,
            amount_dollars: Math.round(g.amount_cents) / 100,
          }))
          .sort((a: any, b: any) => (b.amount_dollars as number) - (a.amount_dollars as number))
          .slice(0, 25);
        return out(
          {
            window: { since, until: until ?? "today" },
            invoice_count: count,
            total_amount_dollars: Math.round(totalCents) / 100,
            canceled_excluded: {
              invoice_count: canceledCount,
              amount_dollars: Math.round(canceledCents) / 100,
            },
            pages_walked: walked,
            may_be_incomplete: truncated || undefined,
            ...(mode === "item_billed"
              ? { detail_reads: detailReads, detail_skipped: detailSkipped || undefined }
              : {}),
            groups: grouped,
          },
          `${MONEY_NOTE} amount is HCP's post-discount, pre-tax figure. Canceled invoices are excluded from all figures above and totaled under canceled_excluded. ` +
            (mode === "item_billed"
              ? `item_billed sums what each line actually billed, from one detail read per invoice (${detailReads} spent${detailSkipped ? `, ${detailSkipped} invoices past the cap NOT included - raise max_detail_reads` : ""}).`
              : `Item grouping splits an invoice's total evenly across its line items (approximation); group_by "item_billed" reads each invoice's detail for exact per-line figures.`) +
            (truncated
              ? " THE WALK HIT ITS PAGE CAP BEFORE REACHING THE WINDOW'S FLOOR - older invoices in the window were not read, so these totals are a floor, not the answer. Raise max_pages."
              : ""),
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /* ---------- write tools (follow your API key's scope) ---------- */

  const WRITE_KEY_NOTE = "Requires a full-access Housecall Pro API key. ";

  /**
   * Several Housecall Pro update routes answer on PUT and nothing else. The
   * client's write path already carries the auth header, the two-way 401
   * diagnosis and the policy that a failed write is never blindly repeated, so
   * PUT goes through it rather than around it.
   */
  const put = (path: string, body: unknown) => hcp.put(path, body);

  /**
   * Booking and moving a visit both leave the customer alone at the moment of
   * the call. What they do not control is Housecall Pro's own reminders, which
   * go out on the account's settings as the date comes closer.
   */
  const REMINDER_NOTE =
    "This does not itself email or text the customer. Housecall Pro still sends its own reminders as the date approaches, and that depends on your account's settings. ";

  tool(
    "hcp_create_customer",
    "Create a new customer record in Housecall Pro. " +
      WRITE_KEY_NOTE +
      "Sends no notifications.",
    {
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      company: z.string().optional(),
      email: z.string().optional(),
      mobile_number: z.string().optional().describe('Format like "+1 555 123 4567"'),
      home_number: z.string().optional(),
      work_number: z.string().optional(),
      notifications_enabled: z
        .boolean()
        .optional()
        .describe("Whether Housecall Pro sends this customer automated job notifications"),
      lead_source: z
        .string()
        .optional()
        .describe(
          "Must exactly match an existing lead source in the account - arbitrary text is rejected",
        ),
      tags: z.array(z.string()).optional(),
      address: z
        .object({
          street: z.string().optional(),
          street_line_2: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          zip: z.string().optional(),
          country: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      try {
        const { address, ...rest } = args as any;
        const body: any = { ...rest };
        if (address) body.addresses = [address];
        const res = await hcp.post("/customers", body);
        return out(res, "Customer created. No notifications were sent.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  const lineItemSchema = z.object({
    name: z.string(),
    description: z
      .string()
      .optional()
      .describe("Line-item description/body; multi-line text is preserved"),
    kind: z.string().optional().describe('Line item kind, e.g. "labor" or "materials" (default labor)'),
    quantity: z.number().optional().describe("Default 1"),
    unit_price_dollars: z
      .number()
      .describe("Price per unit in DOLLARS - this server converts to Housecall Pro's integer cents for you"),
    unit_cost_dollars: z.number().optional().describe("Your cost per unit in dollars (optional)"),
  });

  const buildLineItem = (li: z.infer<typeof lineItemSchema>) => ({
    name: li.name,
    ...(li.description ? { description: li.description } : {}),
    kind: li.kind ?? "labor",
    quantity: li.quantity ?? 1,
    unit_price: Math.round(li.unit_price_dollars * 100),
    unit_cost: Math.round((li.unit_cost_dollars ?? 0) * 100),
  });

  tool(
    "hcp_create_estimate",
    "Create a draft estimate with one or more options for a customer. " +
      WRITE_KEY_NOTE +
      "The estimate is a DRAFT - it is not sent to the customer until you send it from Housecall Pro. Option blurbs and the estimate summary are set in Housecall Pro, not here. Confirm the result with hcp_get_estimate_line_items.",
    {
      customer_id: z.string().describe("Customer id, e.g. cus_..."),
      address_id: z.string().optional(),
      options: z
        .array(
          z.object({
            name: z.string().describe('Option name, e.g. "Good" / "Better" / "Best"'),
            message_from_pro: z.string().optional(),
            line_items: z.array(lineItemSchema).min(1),
          }),
        )
        .min(1),
    },
    async ({ customer_id, address_id, options }) => {
      try {
        const body = {
          customer_id,
          ...(address_id ? { address_id } : {}),
          options: options.map((o) => ({
            name: o.name,
            // Sent for forward-compat, but HCP's public create currently drops it (documented in the tool description).
            message_from_pro: o.message_from_pro ?? "",
            line_items: o.line_items.map(buildLineItem),
          })),
        };
        const res = await hcp.post("/estimates", body);
        return out(
          res,
          "Draft estimate created (your dollar amounts were converted to HCP's cents). It is NOT sent to the customer until you send it from Housecall Pro. Verify the result with hcp_get_estimate_line_items using the returned estimate and option ids.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_estimate_option",
    "Add a new option to an existing estimate. " +
      WRITE_KEY_NOTE +
      "Sends nothing to the customer. A deposit set on other options does not carry over to this one. Confirm the result with hcp_get_estimate_line_items.",
    {
      estimate_id: z.string().describe("The estimate id (csr_...) from hcp_list_estimates"),
      name: z.string().describe('Option name, e.g. "Premium install"'),
      line_items: z.array(lineItemSchema).min(1),
    },
    async ({ estimate_id, name, line_items }) => {
      try {
        const res = await hcp.post(`/estimates/${estimate_id}/options`, {
          name,
          line_items: line_items.map(buildLineItem),
        });
        return out(
          res,
          "Option added to the existing estimate (dollars converted to cents). Not sent to the customer. If sibling options carry a deposit, set this option's deposit in Housecall Pro - it does not inherit.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /**
   * Approving and declining are two routes with one shape, and they sit at the
   * top of /estimates rather than under the estimate the option belongs to.
   * They are registered as two tools on purpose: a single tool with a direction
   * flag would be one wrong argument away from recording the opposite of the
   * answer the customer actually gave.
   */
  const OPTION_IDS = z
    .union([z.string(), z.array(z.string())])
    .describe(
      "One option id (est_...) or several. Option ids come from hcp_list_estimates or an estimate write response - the estimate's own id (csr_...) is not one of them.",
    );

  /** Housecall Pro takes these as a list even when there is one of them. */
  const optionIdList = (given: string | string[]) =>
    (Array.isArray(given) ? given : [given]).filter(
      (id) => typeof id === "string" && id.trim() !== "",
    );

  /**
   * Recording an answer sent the customer nothing when it was exercised against
   * a record whose phone and email were the account owner's own. That is a
   * quiet observation on one account rather than a guarantee, so the wording
   * says what happened and stops short of promising silence.
   */
  const ESTIMATE_ANSWER_REACH =
    "Recording an answer did not email or text the customer when this was exercised. That is not a promise of silence: Housecall Pro's own automations and notification settings can send on their own, whatever any single call does, and one account's configuration says nothing about another's. ";

  tool(
    "hcp_approve_estimate_options",
    "Record an estimate option as approved. Housecall Pro's own word for the result is \"pro approved\" - the shop writing down the customer's answer, rather than a request going out to ask for one. " +
      WRITE_KEY_NOTE +
      ESTIMATE_ANSWER_REACH +
      "Housecall Pro takes the option ids at the top of the estimates route rather than under a particular estimate, so pass option ids (est_...) and not the estimate id (csr_...). " +
      "On an account configured to copy an approved option to a job, one is created and its id comes back as copied_on_approval_to_job_id; on an account that is not, that field is null and no job appears. " +
      "To record the other answer use hcp_decline_estimate_options - approving is not undone by declining afterwards.",
    { option_ids: OPTION_IDS },
    async ({ option_ids }) => {
      const ids = optionIdList(option_ids);
      if (ids.length === 0) {
        return errOut(
          "No option id was named, so nothing was sent. " +
            "Pass one or more option ids (est_...) in option_ids - hcp_list_estimates has them.",
        );
      }
      try {
        const res = await hcp.post("/estimates/options/approve", { option_ids: ids });
        return out(
          { option_ids: ids, ...(res as any) },
          "Housecall Pro recorded these options as pro approved - its own wording for the shop's record of the answer. " +
            "A 2xx is not proof the state moved: confirm each option's approval_status reads \"pro approved\" via hcp_list_estimates before reporting it recorded (topic \"estimate-answer-confirm-by-status\" in hcp_api_notes). " +
            "Nothing was emailed or texted to the customer when this was exercised, which is not a promise for your account: Housecall Pro's own automations and notification settings can send on their own. " +
            "copied_on_approval_to_job_id carries the job id when the account copies an approved option to a job, and is null when it does not.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_decline_estimate_options",
    "Record an estimate option as declined. Housecall Pro's own word for the result is \"pro declined\" - the shop writing down the customer's answer, rather than a request going out to ask for one. " +
      WRITE_KEY_NOTE +
      ESTIMATE_ANSWER_REACH +
      "Housecall Pro takes the option ids at the top of the estimates route rather than under a particular estimate, so pass option ids (est_...) and not the estimate id (csr_...). " +
      "To record the other answer use hcp_approve_estimate_options - declining is not undone by approving afterwards.",
    { option_ids: OPTION_IDS },
    async ({ option_ids }) => {
      const ids = optionIdList(option_ids);
      if (ids.length === 0) {
        return errOut(
          "No option id was named, so nothing was sent. " +
            "Pass one or more option ids (est_...) in option_ids - hcp_list_estimates has them.",
        );
      }
      try {
        const res = await hcp.post("/estimates/options/decline", { option_ids: ids });
        return out(
          { option_ids: ids, ...(res as any) },
          "Housecall Pro recorded these options as pro declined - its own wording for the shop's record of the answer. " +
            "A 2xx is not proof the state moved: confirm each option's approval_status reads \"pro declined\" via hcp_list_estimates before reporting it recorded (topic \"estimate-answer-confirm-by-status\" in hcp_api_notes). " +
            "Nothing was emailed or texted to the customer when this was exercised, which is not a promise for your account: Housecall Pro's own automations and notification settings can send on their own.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_update_customer",
    "Update fields on an existing customer. Fields you omit are left untouched. " +
      WRITE_KEY_NOTE +
      "There is no notes field here. To leave a note about the work, put it on the job with hcp_add_job_note (it rides the job record and reads back on it); a customer-level note is a Housecall Pro dashboard field this surface does not write, though it does read back inline on hcp_get_customer.",
    {
      customer_id: z.string(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      company: z.string().optional(),
      email: z.string().optional(),
      mobile_number: z.string().optional(),
      home_number: z.string().optional(),
      work_number: z.string().optional(),
      notifications_enabled: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ customer_id, ...fields }) => {
      try {
        const res = await hcp.patch(`/customers/${customer_id}`, fields);
        // The customer is read back rather than trusting the 2xx: this PATCH is
        // in the silent-success family, so the answer reports whether the change
        // is actually on the record instead of that a request was taken.
        const verified = await verifyWrite(
          res,
          () => hcp.request(`/customers/${customer_id}`),
          (customer) => writeLanded(customer, fields),
          "the customer",
        );
        return out(verified, "Merge semantics - omitted fields untouched.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_job",
    "Create a job for a customer. With only a customer_id it arrives unscheduled. " +
      WRITE_KEY_NOTE +
      "Add line items with hcp_add_job_line_items and book it with hcp_schedule_job_appointment, which schedules the job as it dispatches the visit. A job's description comes from its line items - it cannot be set directly.",
    {
      customer_id: z.string(),
      address_id: z.string().optional().describe("Service address id (adr_...). Optional: a job can be created without one."),
    },
    async ({ customer_id, address_id }) => {
      try {
        const res = await hcp.post("/jobs", { customer_id, ...(address_id ? { address_id } : {}) });
        return out(res, "Job created (unscheduled). Nothing was sent to anyone.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_job_line_items",
    "Add one or more line items to a job. Prices in dollars. " + WRITE_KEY_NOTE,
    {
      job_id: z.string(),
      line_items: z.array(lineItemSchema).min(1),
    },
    async ({ job_id, line_items }) => {
      try {
        const added: unknown[] = [];
        for (const li of line_items) {
          added.push(await hcp.post(`/jobs/${job_id}/line_items`, buildLineItem(li)));
        }
        return out(
          added,
          "Line items added (dollars converted to cents) - each created row is echoed above. The job's total_amount and derived description follow from these; a 2xx is not proof they moved (topic \"patch-jobs-silent-200\" in hcp_api_notes), so confirm the rows and the new total with hcp_get_job_line_items.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_job_note",
    "Add a note to a job. Notes are internal - no customer notification. " + WRITE_KEY_NOTE,
    {
      job_id: z.string(),
      content: z.string(),
    },
    async ({ job_id, content }) => {
      try {
        return out(await hcp.post(`/jobs/${job_id}/notes`, { content }), "Note added (internal only).");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_schedule_job_appointment",
    "Book an appointment on a job: a dated visit with a time window and the technicians assigned to it. " +
      "This is how a job gets scheduled. The job's own schedule follows the visit, so one call books the work and dispatches it, and calling it again on the same job adds a second visit. " +
      WRITE_KEY_NOTE +
      "Booking an appointment does not itself email or text the customer. Housecall Pro still sends its own reminders as the date approaches, and that depends on your account's settings. " +
      "To move a visit or change who is on it use hcp_update_job_appointment; to undo a booking use hcp_delete_job_appointment or hcp_unschedule_job. " +
      "Every appointment needs at least one technician - Housecall Pro rejects one with nobody assigned.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      start_time: z.string().describe("ISO 8601 start, e.g. 2027-03-01T15:00:00Z"),
      end_time: z.string().describe("ISO 8601 end"),
      employee_ids: z
        .array(z.string())
        .describe("Technicians to dispatch (pro_... ids from hcp_list_employees). At least one is required."),
      arrival_window_minutes: ARRIVAL_WINDOW.optional().describe(
        `How wide an arrival window to give the customer, in minutes. Housecall Pro accepts ${ARRIVAL_WINDOW_VALUES} and rejects anything else. Default 0.`,
      ),
    },
    async ({ job_id, start_time, end_time, employee_ids, arrival_window_minutes }) => {
      // Checked here so the caller gets a useful sentence instead of the API's
      // validation error, and so nothing is sent that cannot succeed.
      if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
        return errOut(
          `At least one technician is required to book an appointment on ${job_id}. ` +
            "Housecall Pro will not accept one with nobody assigned, so nothing was sent. " +
            "Pass one or more employee ids in employee_ids - hcp_list_employees has them.",
        );
      }
      try {
        // The four fields Housecall Pro's create-appointment schema names.
        const res = await hcp.post(`/jobs/${job_id}/appointments`, {
          start_time,
          end_time,
          dispatched_employees_ids: employee_ids,
          arrival_window_minutes: arrival_window_minutes ?? 0,
        });
        // The job's appointments are read back rather than trusting the 2xx: the
        // answer says a visit at these times is now on the job, not that a
        // request was taken.
        const bookedId = (res as any)?.id;
        const verified = await verifyWrite(
          res,
          () => hcp.request(`/jobs/${job_id}/appointments`),
          (list) => {
            const items = hcp.normalizeList(list).items as any[];
            if (!Array.isArray(items)) return "unknown";
            return items.some(
              (a) =>
                (bookedId && a?.id === bookedId) ||
                (String(a?.start_time) === String(start_time) &&
                  String(a?.end_time) === String(end_time)),
            );
          },
          "the job's appointments",
        );
        return out(
          verified,
          "The job's schedule follows the visit - booked, it reads as booked for these times. " +
            "Nothing was sent to the customer now; Housecall Pro may still send its own reminder nearer the date.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /**
   * The visit as Housecall Pro currently holds it. It comes from the
   * appointments subroute and never from the job record: a job's embedded
   * schedule.appointments array stays empty while the subroute reports the
   * visit, so reading the job would say there is nothing there.
   */
  async function readAppointment(job_id: string, appointment_id: string) {
    const json = await hcp.request(`/jobs/${job_id}/appointments`);
    const { items } = hcp.normalizeList(json);
    return (items as any[]).find((a) => a?.id === appointment_id);
  }

  /** Housecall Pro's answer for a job that has been archived, reported as a skip. */
  function archivedSkip(payload: Record<string, unknown>) {
    return out(
      { ...payload, archived: true },
      "This job is archived, so Housecall Pro will not act on its appointments. Nothing was changed and nothing was retried. If you are working through a list of jobs, skip this one and carry on.",
    );
  }

  tool(
    "hcp_update_job_appointment",
    "Move a booked visit, change who is dispatched to it, or both. The job's own schedule follows the visit, so moving the appointment moves the job. " +
      WRITE_KEY_NOTE +
      REMINDER_NOTE +
      "Housecall Pro requires the visit's start and end on every update to this route, even when only the technicians are changing, so they are read back from the appointment for you when you do not name them. " +
      "Every appointment needs at least one technician - an update that assigns nobody is refused here rather than sent. " +
      "Housecall Pro checks the technicians before it looks the appointment up, so a complaint about them tells you nothing about whether the appointment id is real.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      appointment_id: z
        .string()
        .describe("Appointment id (appt_...) from hcp_list_job_appointments"),
      start_time: z
        .string()
        .optional()
        .describe("New ISO 8601 start. Omit to keep the visit where it is."),
      end_time: z.string().optional().describe("New ISO 8601 end. Omit to keep the visit where it is."),
      employee_ids: z
        .array(z.string())
        .optional()
        .describe(
          "Technicians to dispatch (pro_... ids from hcp_list_employees), replacing whoever is on the visit now. Omit to keep the current crew. At least one technician must end up assigned.",
        ),
      arrival_window_minutes: ARRIVAL_WINDOW.optional().describe(
        `How wide an arrival window to give the customer, in minutes. Housecall Pro accepts ${ARRIVAL_WINDOW_VALUES} and rejects anything else. Omit to keep the current window.`,
      ),
    },
    async ({ job_id, appointment_id, start_time, end_time, employee_ids, arrival_window_minutes }) => {
      // Caught here so nothing that cannot succeed is sent, and so the caller
      // reads the requirement rather than the API's validation error.
      if (Array.isArray(employee_ids) && employee_ids.length === 0) {
        return errOut(
          `At least one technician must be assigned to appointment ${appointment_id} on ${job_id}. ` +
            "Housecall Pro will not accept a visit with nobody on it, so nothing was sent. " +
            "Pass one or more employee ids in employee_ids - hcp_list_employees has them - or omit employee_ids to keep the crew already on the visit.",
        );
      }
      if (
        start_time === undefined &&
        end_time === undefined &&
        employee_ids === undefined &&
        arrival_window_minutes === undefined
      ) {
        return errOut(
          `Nothing was named to change on appointment ${appointment_id}, so nothing was sent. ` +
            "Pass a new start_time and end_time to move the visit, employee_ids to change who is on it, or arrival_window_minutes to widen the window.",
        );
      }

      try {
        // The API rejects an update without start and end whatever else it
        // carries, so the current ones stand in when the caller changed only
        // the crew or the window.
        const needsCurrent =
          start_time === undefined || end_time === undefined || employee_ids === undefined;
        const current = needsCurrent ? await readAppointment(job_id, appointment_id) : undefined;
        if (needsCurrent && !current) {
          return errOut(
            `No appointment on ${job_id} carries the id ${appointment_id}, and the visit's current start and end were going to be read from it, so nothing was sent. ` +
              "hcp_list_job_appointments has the appointment ids on this job.",
          );
        }

        const employees = employee_ids ?? current?.dispatched_employees_ids;
        if (!Array.isArray(employees) || employees.length === 0) {
          return errOut(
            `Appointment ${appointment_id} on ${job_id} has no technician on it to keep, and none was named, so nothing was sent. ` +
              "Housecall Pro will not accept a visit with nobody assigned - pass employee_ids from hcp_list_employees.",
          );
        }

        const window = arrival_window_minutes ?? current?.arrival_window_minutes;
        const effStart = start_time ?? current?.start_time;
        const effEnd = end_time ?? current?.end_time;
        const res = await put(`/jobs/${job_id}/appointments/${appointment_id}`, {
          start_time: effStart,
          end_time: effEnd,
          dispatched_employees_ids: employees,
          ...(typeof window === "number" ? { arrival_window_minutes: window } : {}),
        });
        // The appointment is read back rather than trusting the 2xx: the answer
        // says the visit now carries these times and crew, not that a request
        // was taken. readAppointment reads the subroute, where the change shows.
        const verified = await verifyWrite(
          res,
          () => readAppointment(job_id, appointment_id),
          (appt) => {
            if (!appt || typeof appt !== "object") return "unknown";
            const a = appt as any;
            const timesOk =
              String(a.start_time) === String(effStart) &&
              String(a.end_time) === String(effEnd);
            const crew = recordHasIds(a.dispatched_employees_ids, employees as string[]);
            if (crew === "unknown") return timesOk ? true : false;
            return timesOk && crew;
          },
          "the appointment",
        );
        return out(
          verified,
          "The job's schedule follows the visit - moved, the job reads as booked for the visit's times. " +
            "Nothing was sent to the customer now; Housecall Pro may still send its own reminder nearer the date.",
        );
      } catch (e) {
        if (isArchivedJob(e)) return archivedSkip({ job_id, appointment_id, updated: false });
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_job_appointment",
    "Take one visit off a job. Use it to drop a visit from a job that has several. " +
      WRITE_KEY_NOTE +
      REMINDER_NOTE +
      "The job record stays, and so does its schedule - this removes a visit, not the job. To take the whole job back to needs scheduling, use hcp_unschedule_job.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      appointment_id: z
        .string()
        .describe("Appointment id (appt_...) from hcp_list_job_appointments"),
    },
    async ({ job_id, appointment_id }) => {
      try {
        const res = await hcp.del(`/jobs/${job_id}/appointments/${appointment_id}`);
        // A removal answers an empty success whether or not the visit was there,
        // so the job's appointments are read back and the answer says whether
        // the id is actually gone rather than that a request was taken.
        const verified = await verifyWrite(
          res,
          async () => hcp.normalizeList(await hcp.request(`/jobs/${job_id}/appointments`)).items,
          (items) => {
            if (!Array.isArray(items)) return "unknown";
            return !items.some((a: any) => a?.id === appointment_id);
          },
          "the job's appointments",
        );
        return out(
          verified,
          "The job itself is still there. Nothing was sent to the customer now; Housecall Pro may still send its own reminder nearer any date left on the job.",
        );
      } catch (e) {
        if (isArchivedJob(e)) return archivedSkip({ job_id, appointment_id, deleted: false });
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_unschedule_job",
    "Undo a booking: take the visits off a job and clear its schedule, returning it to needs scheduling. " +
      WRITE_KEY_NOTE +
      REMINDER_NOTE +
      "The job record remains, with its customer, line items and notes - this undoes the scheduling, not the job. " +
      "Housecall Pro's API has no route that deletes a job, so a job created by mistake is closed out in Housecall Pro itself.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      appointment_ids: z
        .array(z.string())
        .optional()
        .describe(
          "The visits to remove (appt_...). Omit to remove every visit currently on the job, which is read first.",
        ),
    },
    async ({ job_id, appointment_ids }) => {
      const deleted: string[] = [];
      try {
        let targets = appointment_ids;
        if (targets === undefined) {
          const json = await hcp.request(`/jobs/${job_id}/appointments`);
          targets = (hcp.normalizeList(json).items as any[])
            .map((a) => a?.id)
            .filter((id): id is string => typeof id === "string");
        }
        // The visits first, then the schedule: clearing the schedule alone
        // leaves the dispatched visits behind on a technician's day.
        for (const id of targets) {
          await hcp.del(`/jobs/${job_id}/appointments/${id}`);
          deleted.push(id);
        }
        const res = await hcp.del(`/jobs/${job_id}/schedule`);
        // The DELETEs answering success is not the same as the job being
        // unscheduled - this is the silent-success family. The job's real state
        // is read back so the answer reports its actual work_status and whatever
        // visits remain, rather than stating the outcome from the delete.
        let workStatus: unknown = "unknown";
        let remaining: unknown = "unknown";
        let cleared: boolean | "unknown" = "unknown";
        try {
          const job = await hcp.request(`/jobs/${job_id}`);
          workStatus = (job as any)?.work_status ?? "unknown";
          const appts = hcp.normalizeList(
            await hcp.request(`/jobs/${job_id}/appointments`),
          ).items as any[];
          remaining = appts.map((a) => a?.id).filter((id) => typeof id === "string");
          cleared = appts.length === 0;
        } catch {
          // The read-back itself failed; report the clear as accepted, not
          // confirmed, rather than claiming a state that was never read.
        }
        return out(
          {
            job_id,
            deleted_appointment_ids: deleted,
            schedule_cleared: cleared,
            work_status: workStatus,
            remaining_appointments: remaining,
            job_deleted: false,
            schedule_response: res,
          },
          (cleared === true
            ? "Confirmed by reading the job back: no visits remain and its work_status is above. "
            : cleared === false
              ? "Housecall Pro answered success but the job still shows visits on read-back - treat it as NOT unscheduled and check it in Housecall Pro. "
              : "The clear was accepted but reading the job back to confirm it failed - check the job in Housecall Pro. ") +
            "The job record remains - its customer, line items and notes are untouched, and nothing here deletes a job. " +
            "Nothing was sent to the customer now; Housecall Pro sends its own reminders on the account's settings, and there is no longer a date for one.",
        );
      } catch (e) {
        if (isArchivedJob(e)) return archivedSkip({ job_id, deleted_appointment_ids: deleted });
        const detail = e instanceof Error ? e.message : String(e);
        return errOut(
          new Error(
            `${detail} Nothing was retried. ` +
              (deleted.length
                ? `${deleted.length} visit(s) were already removed (${deleted.join(", ")}) and the job's schedule was left as it was. `
                : "No visit was removed and the job's schedule was left as it was. ") +
              "Check the job in Housecall Pro before trying again.",
          ),
        );
      }
    },
  );

  tool(
    "hcp_dispatch_job",
    "Dispatch a crew to a job: name the technicians who are on the work. " +
      WRITE_KEY_NOTE +
      "Dispatching did not email or text the customer when this was exercised, and Housecall Pro's own record of what it sent shows nothing going out for it. That is not a promise of silence: your account's automations and notification settings can send on their own, whatever any single call does, and one account's configuration says nothing about another's. " +
      "Every dispatch needs at least one technician - Housecall Pro rejects one that names nobody, and a request that names nobody is refused here rather than sent. " +
      "This sets who is on the job's work. To put a crew on a dated visit, or to move one, book or change the appointment with hcp_schedule_job_appointment or hcp_update_job_appointment instead.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      employee_ids: z
        .array(z.string())
        .describe("Technicians to dispatch (pro_... ids from hcp_list_employees). At least one is required."),
    },
    async ({ job_id, employee_ids }) => {
      // Refused here so nothing that cannot succeed is sent, and so the caller
      // reads the requirement rather than the API's validation error.
      if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
        return errOut(
          `At least one technician is required to dispatch ${job_id}. ` +
            "Housecall Pro answers this route with \"dispatched_employees is required\" when nobody is named, so nothing was sent. " +
            "Pass one or more employee ids in employee_ids - hcp_list_employees has them.",
        );
      }
      try {
        // Housecall Pro takes this route on PUT. A POST to the same path answers
        // with an HTML 404 page, which reads as no such route rather than as the
        // wrong method.
        // An array of OBJECTS keyed employee_id. A bare array of ids, and an
        // array of objects keyed id, are both refused with the same message,
        // which names the array and never the key.
        const res = await put(`/jobs/${job_id}/dispatch`, {
          dispatched_employees: employee_ids.map((id) => ({ employee_id: id })),
        });
        // The job is read back rather than echoing the requested ids as the
        // result: the answer confirms the crew Housecall Pro actually recorded,
        // so a silently-ignored dispatch does not read as a successful one.
        const verified = await verifyWrite(
          res,
          () => hcp.request(`/jobs/${job_id}`),
          (job) => recordHasIds((job as any)?.assigned_employees, employee_ids),
          "the job",
        );
        return out(
          { job_id, requested_employee_ids: employee_ids, ...verified },
          "Nothing was sent to the customer by the call itself, though your account's own automations can still send on their own.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_job_tag",
    "Put a tag on a job. Tags are how jobs get grouped for reporting and follow-up. " +
      WRITE_KEY_NOTE +
      "This tool sends nothing to the customer itself; what your own Housecall Pro automations do with a tagged job is set up in Housecall Pro and outside this server's control. " +
      "Housecall Pro identifies tags by id, so a tag name is looked up for you first and rejected with suggestions if it does not match one exactly.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      tag_id: z
        .string()
        .describe("Tag id (tag_...) from hcp_list_tags. A tag name is accepted only if it matches one exactly."),
    },
    async ({ job_id, tag_id }) => {
      try {
        const resolved = await resolveTagId(hcp, tag_id);
        if ("error" in resolved) {
          return out(resolved, "Nothing was sent to Housecall Pro.");
        }
        const res = await hcp.post(`/jobs/${job_id}/tags`, { tag_id: resolved.tag_id });
        // The job is read back rather than trusting the 2xx, so the answer says
        // whether the tag is on the job now instead of that a request was taken.
        const verified = await verifyWrite(
          res,
          () => hcp.request(`/jobs/${job_id}`),
          (job) => jobCarriesTag(job, resolved.tag_id, tag_id),
          "the job",
        );
        return out(
          verified,
          "Nothing was sent to the customer from here; any automation you have set up in Housecall Pro around this tag runs on its own.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_remove_job_tag",
    "Take a tag off a job. The tag itself stays on the account and stays on every other job carrying it. " +
      WRITE_KEY_NOTE +
      "This tool sends nothing to the customer itself; Housecall Pro's own automations are outside this server's control. " +
      "Housecall Pro does not record tag changes in the customer activity log, so tagging cannot be confirmed silent by inspection.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      tag_id: z
        .string()
        .describe("Tag id (tag_...) from hcp_list_tags. A tag name is accepted only if it matches one exactly."),
    },
    async ({ job_id, tag_id }) => {
      try {
        const resolved = await resolveTagId(hcp, tag_id);
        if ("error" in resolved) {
          return out(resolved, "Nothing was sent to Housecall Pro.");
        }
        const res = await hcp.del(`/jobs/${job_id}/tags/${resolved.tag_id}`);
        // This route answers an empty success whether or not the tag was there,
        // so the response carries no information. Reading the job back is the
        // only way to say anything true about what happened.
        const verified = await verifyWrite(
          res,
          () => hcp.request(`/jobs/${job_id}`),
          (job) => {
            const carries = jobCarriesTag(job, resolved.tag_id, tag_id);
            // Removal succeeded when the tag is now absent, so the sense of the
            // check is inverted. "unknown" passes straight through.
            return carries === "unknown" ? "unknown" : !carries;
          },
          "the job",
        );
        return out(
          verified,
          "The tag still exists on the account - tags themselves cannot be deleted through the API.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_lead",
    "Create a lead attached to a customer. It appears in Housecall Pro's Leads inbox. " +
      WRITE_KEY_NOTE,
    { customer_id: z.string() },
    async ({ customer_id }) => {
      try {
        return out(await hcp.post("/leads", { customer_id }), "Lead created - it will show in the HCP Leads inbox.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_tag",
    "Create a tag. CAUTION: tags cannot be deleted through the API - removal is done in Housecall Pro, so create sparingly. " +
      WRITE_KEY_NOTE,
    { name: z.string() },
    async ({ name }) => {
      try {
        return out(await hcp.post("/tags", { name }), "Tag created. Remember: tags can only be deleted from the Housecall Pro UI.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_rename_tag",
    "Rename a tag. Every job and customer carrying it keeps it - only the name changes, and it changes everywhere the tag shows. " +
      WRITE_KEY_NOTE +
      "Nothing is sent to any customer. " +
      "Housecall Pro identifies tags by id, so a tag name is looked up for you first and rejected with suggestions if it does not match one exactly.",
    {
      tag_id: z
        .string()
        .describe("Tag id (tag_...) from hcp_list_tags. A tag name is accepted only if it matches one exactly."),
      name: z.string().describe("The new name"),
    },
    async ({ tag_id, name }) => {
      try {
        const resolved = await resolveTagId(hcp, tag_id);
        if ("error" in resolved) {
          return out(resolved, "Nothing was sent to Housecall Pro.");
        }
        const res = await hcp.patch(`/tags/${resolved.tag_id}`, { name });
        return out(res, "Tag renamed. Every record carrying it now shows the new name. Confirm with hcp_list_tags.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_customer_address",
    "Add a service address to an existing customer - the place work is done, which a job is then booked against. " +
      WRITE_KEY_NOTE +
      "Housecall Pro wants street, city, state, zip and country together on this route and rejects a partial address, so all five are required here. " +
      "Nothing is sent to the customer. " +
      "Housecall Pro's API has no route that changes or removes an address once it is on a customer, so get it right before adding it - a wrong one is corrected in Housecall Pro.",
    {
      customer_id: z.string().describe("Customer id, e.g. cus_..."),
      street: z.string(),
      street_line_2: z.string().optional().describe("Unit, apartment or floor"),
      city: z.string(),
      state: z.string().describe('Two-letter state code, e.g. "NY"'),
      zip: z.string(),
      country: z.string().describe('Required on this route even for a domestic address, e.g. "US"'),
    },
    async ({ customer_id, ...address }) => {
      try {
        const res = await hcp.post(`/customers/${customer_id}/addresses`, address);
        return out(
          { customer_id, address_id: (res as any)?.id, address: res },
          "Address added to the customer, and its id (adr_...) is on the response - a job can be created against it. Nothing was sent to the customer. It cannot be edited or removed through the API afterwards.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_job_type",
    "Create a job type - one of the categories a job is filed under for reporting. " +
      WRITE_KEY_NOTE +
      "Nothing is sent to any customer. Confirm the result with hcp_list_job_types.",
    { name: z.string().describe("The job type's name, which Housecall Pro requires") },
    async ({ name }) => {
      try {
        return out(
          await hcp.post("/job_fields/job_types", { name }),
          "Job type created. Confirm it with hcp_list_job_types.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /** Price-book money crosses the boundary in dollars and goes out in cents, once. */
  const materialBody = (a: {
    name?: string;
    description?: string;
    price_dollars?: number;
    cost_dollars?: number;
    taxable?: boolean;
  }) => ({
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.description !== undefined ? { description: a.description } : {}),
    ...(a.price_dollars !== undefined ? { price: Math.round(a.price_dollars * 100) } : {}),
    ...(a.cost_dollars !== undefined ? { cost: Math.round(a.cost_dollars * 100) } : {}),
    ...(a.taxable !== undefined ? { taxable: a.taxable } : {}),
  });

  const MATERIAL_MONEY = "Prices in DOLLARS - this server converts to Housecall Pro's integer cents for you. ";

  tool(
    "hcp_create_pricebook_material",
    "Add a material to the price book, inside one of its categories. " +
      WRITE_KEY_NOTE +
      MATERIAL_MONEY +
      "A material belongs to a category, so a category uuid is required - hcp_search_pricebook with kind='material_categories' has them, and hcp_create_pricebook_material_category makes a new one. " +
      "Nothing is sent to any customer; this changes what your own price book offers.",
    {
      material_category_uuid: z
        .string()
        .describe("The category to file it under, from hcp_search_pricebook kind='material_categories'"),
      name: z.string(),
      description: z.string().optional(),
      price_dollars: z.number().optional().describe("What you sell it for, in dollars"),
      cost_dollars: z.number().optional().describe("What it costs you, in dollars"),
      taxable: z.boolean().optional(),
    },
    async ({ material_category_uuid, ...fields }) => {
      try {
        const res = await hcp.post("/api/price_book/materials", {
          material_category_uuid,
          ...materialBody(fields),
        });
        return out(
          res,
          "Material created (your dollar amounts were converted to HCP's cents). Its uuid (pbmat_...) is on the response. Confirm with hcp_search_pricebook using kind='materials' and this category uuid.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_update_pricebook_material",
    "Change a price-book material: its name, description, price, cost or whether it is taxable. Fields you omit are left alone. " +
      WRITE_KEY_NOTE +
      MATERIAL_MONEY +
      "Nothing is sent to any customer. Estimates and invoices already written keep the figures they were written with; this changes what the price book offers next time.",
    {
      material_uuid: z.string().describe("Material uuid (pbmat_...) from hcp_search_pricebook kind='materials'"),
      name: z.string().optional(),
      description: z.string().optional(),
      price_dollars: z.number().optional().describe("What you sell it for, in dollars"),
      cost_dollars: z.number().optional().describe("What it costs you, in dollars"),
      taxable: z.boolean().optional(),
    },
    async ({ material_uuid, ...fields }) => {
      const body = materialBody(fields);
      if (Object.keys(body).length === 0) {
        return errOut(
          `Nothing was named to change on material ${material_uuid}, so nothing was sent. ` +
            "Pass at least one of name, description, price_dollars, cost_dollars or taxable.",
        );
      }
      try {
        const res = await put(`/api/price_book/materials/${material_uuid}`, body);
        return out(
          res,
          "Material sent (dollars converted to cents); only the fields you named were sent. A 2xx is not proof the change landed (topic \"patch-jobs-silent-200\" in hcp_api_notes) - confirm the new values with hcp_search_pricebook kind='materials' before reporting the update as done.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_pricebook_material",
    "Remove a material from the price book. " +
      WRITE_KEY_NOTE +
      "Nothing is sent to any customer, and estimates or invoices already written keep the line they were written with. " +
      "Housecall Pro answers this with an empty success, which looks the same whether or not the material was there, so confirm with hcp_search_pricebook if it matters.",
    { material_uuid: z.string().describe("Material uuid (pbmat_...)") },
    async ({ material_uuid }) => {
      try {
        const res = await hcp.del(`/api/price_book/materials/${material_uuid}`);
        return out(
          res,
          "Housecall Pro accepted the request to remove that material. It answers with an empty success, so check with hcp_search_pricebook if you need to be sure it is gone.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_pricebook_material_category",
    "Create a price-book material category - the folder materials are filed in. " +
      WRITE_KEY_NOTE +
      "Nothing is sent to any customer. Its uuid is what hcp_create_pricebook_material files a material under.",
    { name: z.string().describe("The category's name, which Housecall Pro requires") },
    async ({ name }) => {
      try {
        return out(
          await hcp.post("/api/price_book/material_categories", { name }),
          "Category created. Its uuid is on the response - pass it as material_category_uuid when creating a material.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_pricebook_material_category",
    "Remove a price-book material category. " +
      WRITE_KEY_NOTE +
      "Nothing is sent to any customer. Check what is filed under it first with hcp_search_pricebook kind='materials' - this server cannot tell you what removing a category does to the materials inside it.",
    { category_uuid: z.string().describe("Category uuid from hcp_search_pricebook kind='material_categories'") },
    async ({ category_uuid }) => {
      try {
        const res = await hcp.del(`/api/price_book/material_categories/${category_uuid}`);
        return out(
          res,
          "Housecall Pro accepted the request to remove that category. Confirm with hcp_search_pricebook using kind='material_categories'.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /**
   * A job's line-item list is not all the caller's own work: Housecall Pro adds
   * rows of its own, a tax line among them. Nothing here can tell one from the
   * other, so both tools say so rather than letting a caller sweep the list.
   */
  const SYSTEM_ROWS_NOTE =
    "A job's line-item list also carries rows Housecall Pro added itself, an automatic tax line among them, so check what a row is before touching it rather than working through the whole list. ";

  tool(
    "hcp_update_job_line_item",
    "Change one line item on a job: its name, description, kind, quantity, price or cost. " +
      WRITE_KEY_NOTE +
      "Prices in DOLLARS - this server converts to Housecall Pro's integer cents for you. " +
      "Housecall Pro requires the name on every update to this route, so pass it even when only a price is changing; an update without it is rejected. " +
      SYSTEM_ROWS_NOTE +
      "Changing a line item changes the job's total and its derived description. Nothing is sent to the customer by itself, though a customer who opens an invoice they were already sent sees the new figure.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      line_item_id: z
        .string()
        .describe("Line item id (rli_...), from the hcp_add_job_line_items response or the job record"),
      name: z.string().describe("Required by Housecall Pro on every update, even when it is not changing"),
      description: z.string().optional(),
      kind: z.string().optional().describe('e.g. "labor" or "materials"'),
      quantity: z.number().optional(),
      unit_price_dollars: z.number().optional().describe("Price per unit in dollars"),
      unit_cost_dollars: z.number().optional().describe("Your cost per unit in dollars"),
    },
    async ({ job_id, line_item_id, name, description, kind, quantity, unit_price_dollars, unit_cost_dollars }) => {
      try {
        const sent = {
          name,
          ...(description !== undefined ? { description } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit_price_dollars !== undefined
            ? { unit_price: Math.round(unit_price_dollars * 100) }
            : {}),
          ...(unit_cost_dollars !== undefined ? { unit_cost: Math.round(unit_cost_dollars * 100) } : {}),
        };
        const res = await put(`/jobs/${job_id}/line_items/${line_item_id}`, sent);
        // The line item is read back rather than trusting the 2xx: the answer
        // reports the change only when it is visible on the row.
        const verified = await verifyWrite(
          res,
          async () => hcp.normalizeList(await hcp.request(`/jobs/${job_id}/line_items`)).items,
          (items) => {
            if (!Array.isArray(items)) return "unknown";
            const item = (items as any[]).find((li) => li?.id === line_item_id);
            if (!item) return "unknown";
            return writeLanded(item, sent);
          },
          "the job's line items",
        );
        return out(
          verified,
          "The job's total and derived description follow from its line items.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /**
   * One row of a bulk update. The id rides in the body here rather than in the
   * path, which is the whole difference between this route and the single-item
   * one, and money crosses the boundary in dollars exactly as it does there.
   */
  const bulkLineItemSchema = z.object({
    id: z
      .string()
      .describe("Line item id (rli_...), from the job record or an hcp_add_job_line_items response"),
    name: z.string().describe("Required by Housecall Pro on every item, even when it is not changing"),
    description: z.string().optional(),
    kind: z.string().optional().describe('e.g. "labor" or "materials"'),
    quantity: z.number().optional(),
    unit_price_dollars: z.number().optional().describe("Price per unit in dollars"),
    unit_cost_dollars: z.number().optional().describe("Your cost per unit in dollars"),
  });

  const buildBulkLineItem = (li: z.infer<typeof bulkLineItemSchema>) => ({
    id: li.id,
    name: li.name,
    ...(li.description !== undefined ? { description: li.description } : {}),
    ...(li.kind !== undefined ? { kind: li.kind } : {}),
    ...(li.quantity !== undefined ? { quantity: li.quantity } : {}),
    ...(li.unit_price_dollars !== undefined
      ? { unit_price: Math.round(li.unit_price_dollars * 100) }
      : {}),
    ...(li.unit_cost_dollars !== undefined
      ? { unit_cost: Math.round(li.unit_cost_dollars * 100) }
      : {}),
  });

  tool(
    "hcp_update_job_line_items",
    "Change several line items on a job in one call - each one's name, description, kind, quantity, price or cost. " +
      WRITE_KEY_NOTE +
      "Prices in DOLLARS - this server converts to Housecall Pro's integer cents for you. " +
      "Reach for this rather than hcp_update_job_line_item whenever more than one row is changing: it is a single request Housecall Pro applies to the whole list, where the single-item tool is one request per row and can leave a job half-repriced if a later one fails. Use the single-item tool when exactly one row is changing. " +
      "Housecall Pro requires the id and the name on every item in the list, so pass the name even when only a price is changing. " +
      SYSTEM_ROWS_NOTE +
      "Changing line items changes the job's total and its derived description. Nothing is sent to the customer by itself, though a customer who opens an invoice they were already sent sees the new figures.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      line_items: z
        .array(bulkLineItemSchema)
        .describe("The items to change, each carrying its own line item id (rli_...)"),
    },
    async ({ job_id, line_items }) => {
      // Refused here so nothing that cannot succeed is sent, and so the caller
      // reads the requirement rather than the API's validation error.
      if (!Array.isArray(line_items) || line_items.length === 0) {
        return errOut(
          `No line item was named to change on ${job_id}. ` +
            "Housecall Pro answers this route with \"line_items: is missing\" when the list is empty, so nothing was sent. " +
            "Pass the items you want changed, each with its line item id (rli_...) and its name.",
        );
      }
      try {
        // Housecall Pro takes this route on PUT, and only at the bulk_update
        // path: the bare line_items path answers with an HTML 404 page.
        const built = line_items.map(buildBulkLineItem);
        const res = await put(`/jobs/${job_id}/line_items/bulk_update`, {
          line_items: built,
        });
        // The list is read back once and every changed row is confirmed against
        // it, the way the estimate-option bulk update does: a 2xx on this route
        // is not evidence the rows moved.
        const verified = await verifyWrite(
          res,
          async () => hcp.normalizeList(await hcp.request(`/jobs/${job_id}/line_items`)).items,
          (items) => {
            if (!Array.isArray(items)) return "unknown";
            const rows = items as any[];
            const results = built.map((sent) => {
              const item = rows.find((li) => li?.id === sent.id);
              return item ? writeLanded(item, sent) : "unknown";
            });
            if (results.includes(false)) return false;
            return results.every((r) => r === true) ? true : "unknown";
          },
          "the job's line items",
        );
        return out(
          verified,
          `${line_items.length} line item(s) sent in one call (dollars converted to cents). The job's total and derived description follow from its line items.`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_job_line_item",
    "Remove one line item from a job. The job stays; its total and derived description follow from what is left on it. " +
      WRITE_KEY_NOTE +
      SYSTEM_ROWS_NOTE +
      "Nothing is sent to the customer by itself, though a customer who opens an invoice they were already sent sees the new figure.",
    {
      job_id: z.string().describe("Job id, e.g. job_..."),
      line_item_id: z.string().describe("Line item id (rli_...)"),
    },
    async ({ job_id, line_item_id }) => {
      try {
        const res = await hcp.del(`/jobs/${job_id}/line_items/${line_item_id}`);
        // A removal on this API answers an empty success whether or not the row
        // was there, so the list is read back and the answer says whether the
        // row is actually gone.
        const verified = await verifyWrite(
          res,
          async () => hcp.normalizeList(await hcp.request(`/jobs/${job_id}/line_items`)).items,
          (items) => {
            if (!Array.isArray(items)) return "unknown";
            return !(items as any[]).some((li) => li?.id === line_item_id);
          },
          "the job's line items",
        );
        return out(verified, "The job's total follows from the items left on it.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_estimate_line_items",
    "Read the line items of one estimate option - name, description, quantity, and prices in dollars. Use it to confirm what an estimate write created. " +
      "The account's own tax row (kind \"tax\") is system-added to an option and rides in this list - do not count it as a line somebody entered.",
    {
      estimate_id: z.string().describe("Estimate id (csr_...)"),
      option_id: z.string().describe("Option id (est_...) - from hcp_list_estimates or an estimate write response"),
    },
    async ({ estimate_id, option_id }) => {
      try {
        const json = await hcp.request(`/estimates/${estimate_id}/options/${option_id}/line_items`);
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          {
            total_items,
            line_items: (items as any[]).map((li) => ({
              id: li?.id,
              name: li?.name,
              description: li?.description || undefined,
              kind: li?.kind,
              quantity: li?.quantity,
              unit_price_dollars: centsToDollars(li?.unit_price),
              unit_cost_dollars: centsToDollars(li?.unit_cost),
              amount_dollars: centsToDollars(li?.amount),
              taxable: li?.taxable,
              order_index: li?.order_index,
            })),
          },
          (items as any[]).length === 0
            ? "No line items came back. An empty result here is usually a mismatched id rather than an option with no items: the estimate's own csr_ id is not an option id, so pass the est_ option id from hcp_list_estimates or the estimate write response. As a read to confirm an estimate write, an empty answer reads as a failed write when the id is the real problem."
            : MONEY_NOTE,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_job_notes",
    "Read the notes on a job through their own route. Prefer hcp_get_job: the job record already carries its " +
      "notes, and this route is refused to every kind of Housecall Pro API key, so it answers a permission " +
      "failure rather than the notes - which is not the same as the notes being unreachable.",
    { job_id: z.string().describe("Job id (job_...)") },
    async ({ job_id }) => {
      try {
        const json = await hcp.request(`/api/jobs/${job_id}/notes`);
        const { items } = hcp.normalizeList(json);
        return out(
          (items as any[]).map((n) => ({
            id: n?.id,
            content: n?.content,
            pinned: n?.pinned,
            updated_at: n?.updated_at,
          })),
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_job_count",
    "Get the total number of jobs on the account.",
    {},
    async () => {
      try {
        return out(await hcp.request("/api/jobs/job_count"));
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_search_pricebook",
    "Search the Housecall Pro price book: services, material categories, materials, or price forms. For materials, pass a category_uuid (get one from kind=material_categories). " +
      "Material categories NEST: the plain list returns only the roots, and materials mostly live in the child categories - pass whole_tree=true to walk every level in one call before enumerating a book. " +
      "For services, include_flat_rate adds each service's recipe - its labor hours and rates and its component materials with quantities - plus computed margin where both price and cost exist.",
    {
      kind: z.enum(["services", "material_categories", "materials", "price_forms"]),
      category_uuid: z
        .string()
        .optional()
        .describe("Required when kind=materials; get it from kind=material_categories"),
      parent_uuid: z
        .string()
        .optional()
        .describe(
          "material_categories only: list the children of this category instead of the roots. Categories nest, and materials usually live in the leaves.",
        ),
      whole_tree: z
        .boolean()
        .optional()
        .describe(
          "material_categories only: walk the whole nested tree and return every category with its parent_uuid and depth. Use this before enumerating a book's materials - the plain list returns only the roots.",
        ),
      query: z.string().optional().describe("Case-insensitive filter applied to names client-side"),
      include_flat_rate: z
        .boolean()
        .optional()
        .describe(
          "services only: include each service's labor rates and component materials (the flat-rate recipe), plus margin_percent where computable",
        ),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ kind, category_uuid, parent_uuid, whole_tree, query, include_flat_rate, page, page_size }) => {
      try {
        if (kind === "materials" && !category_uuid) {
          return out(
            { error: "category_uuid is required for materials" },
            "Housecall Pro returns 404 'The material category could not be found' for an unfiltered materials request. Call this tool with kind='material_categories' first, then pass one category_uuid.",
          );
        }

        if (kind === "material_categories" && whole_tree) {
          // Categories nest via parent_uuid and the API lists one level at a
          // time (no filter = roots). A book's materials sit mostly in the
          // leaves, so "every category" takes a breadth-first walk - done here
          // so a caller gets the tree in one call instead of one per branch.
          const all: any[] = [];
          const queue: { uuid: string | undefined; depth: number }[] = [
            { uuid: undefined, depth: 0 },
          ];
          const seen = new Set<string>();
          while (queue.length) {
            const { uuid, depth } = queue.shift()!;
            let p = 1;
            for (;;) {
              const json = await hcp.request("/api/price_book/material_categories", {
                parent_uuid: uuid,
                page: p,
                page_size: 100,
              });
              const { items } = hcp.normalizeList(json);
              for (const c of items as any[]) {
                const id = c?.uuid;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                all.push({
                  uuid: id,
                  name: c?.name,
                  parent_uuid: c?.parent_uuid ?? null,
                  depth,
                });
                queue.push({ uuid: id, depth: depth + 1 });
                // A malformed tree cannot walk forever.
                if (seen.size >= 2000) queue.length = 0;
              }
              if ((items as any[]).length < 100) break;
              p++;
            }
          }
          let rows = all;
          if (query) {
            const q = query.toLowerCase();
            rows = rows.filter((r) => String(r.name ?? "").toLowerCase().includes(q));
          }
          return out(
            { total_items: rows.length, page: 1, material_categories: rows },
            "The whole category tree, walked. Materials mostly live in the deepest categories - call kind='materials' once per category uuid to enumerate them.",
          );
        }

        const expandFlatRate = include_flat_rate && kind === "services";
        const params: Record<string, unknown> = {
          material_category_uuid: category_uuid,
          page: page ?? 1,
          page_size: page_size ?? 50,
        };
        if (kind === "material_categories" && parent_uuid) params.parent_uuid = parent_uuid;
        // The composition arrives only by asking for it: the same fields exist
        // unexpanded and are empty lists, which reads as "this service has no
        // recipe" when it merely was not asked for.
        if (expandFlatRate) params["expand[]"] = ["service_materials", "service_labor_rates"];
        const json = await hcp.request(`/api/price_book/${kind}`, params);
        const { items, total_items } = hcp.normalizeList(json);
        let rows = (items as any[]).map((r) => {
          const base: Record<string, unknown> = {
            uuid: r?.uuid ?? r?.id,
            name: r?.name,
            description: r?.description || undefined,
            // Materials carry a part number when the book records one; it is
            // the match key against a supplier document, so it rides along.
            part_number: r?.part_number || undefined,
            // Categories nest; a child names its parent so a caller can see
            // the tree even without whole_tree.
            parent_uuid: r?.parent_uuid ?? undefined,
            price_dollars: centsToDollars(r?.price ?? r?.unit_price),
            cost_dollars: centsToDollars(r?.cost ?? r?.unit_cost),
            taxable: r?.taxable,
          };
          if (expandFlatRate) {
            const labor = ((r?.service_labor_rates?.data as any[]) ?? []).map((l: any) => ({
              name: l?.labor_rate?.name,
              hours: typeof l?.number_of_hours === "string" ? Number(l.number_of_hours) : l?.number_of_hours,
              hourly_cost_dollars: centsToDollars(l?.labor_rate?.hourly_cost),
              hourly_price_dollars: centsToDollars(l?.labor_rate?.hourly_price),
            }));
            const materials = ((r?.service_materials?.data as any[]) ?? []).map((m: any) => ({
              name: m?.material?.name,
              quantity: m?.quantity,
              material_uuid: m?.material?.uuid,
              unit_cost_dollars: centsToDollars(m?.material?.cost ?? m?.material?.unit_cost),
              unit_price_dollars: centsToDollars(m?.material?.price ?? m?.material?.unit_price),
            }));
            if (labor.length) base.labor = labor;
            if (materials.length) base.materials = materials;
            const p = base.price_dollars as number | null;
            const c = base.cost_dollars as number | null;
            // Margin only when both sides are real: on a typical book most
            // services carry no recorded cost, and a margin computed against a
            // missing cost would read as 100% profit.
            if (typeof p === "number" && p > 0 && typeof c === "number" && c > 0) {
              base.margin_percent = Math.round(((p - c) / p) * 1000) / 10;
            }
          }
          return base;
        });
        if (query) {
          const q = query.toLowerCase();
          rows = rows.filter(
            (r) =>
              String(r.name ?? "").toLowerCase().includes(q) ||
              String(r.description ?? "").toLowerCase().includes(q),
          );
        }
        const baseNote = expandFlatRate
          ? `${MONEY_NOTE} margin_percent is computed only where a service carries both a price and a cost; a missing cost yields no margin rather than a flattering one.`
          : MONEY_NOTE;
        // An empty result is two answers - nothing matched, or a filter that
        // never applied - and on materials it has a third: a root or plain pull
        // reads empty because materials sit in the child categories.
        const emptyNote =
          rows.length === 0
            ? [
                emptyFilterNote({ query, category_uuid }),
                kind === "materials" || kind === "material_categories"
                  ? "Materials nest under child categories, so an empty pull against a root or a plain list reads as an empty book - walk the tree first with whole_tree=true, then pull materials per category at every depth (topic \"material-categories-nest-and-list-roots-only\" in hcp_api_notes)."
                  : undefined,
              ]
                .filter(Boolean)
                .join(" ")
            : "";
        return out(
          { kind, total_items: total_items ?? (json as any)?.total_count, count: rows.length, items: rows },
          emptyNote ? `${baseNote} ${emptyNote}` : baseNote,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_job_types",
    "List the account's job types.",
    {},
    async () => {
      try {
        const json = await hcp.request("/job_fields/job_types", { page_size: 100 });
        const items = hcp.normalizeList(json).items;
        return out(
          items,
          items.length === 0
            ? "No job types are configured on this account, which is an ordinary state and not an error."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_lead_sources",
    "List valid lead sources for this account. Use before setting lead_source on a customer or lead - an unrecognized value is rejected by the API.",
    {},
    async () => {
      try {
        const json = await hcp.request("/lead_sources", { page_size: 100 });
        return out(hcp.normalizeList(json).items);
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_leads",
    "List leads - unconverted enquiries, which are a separate record type from jobs and estimates. " +
      "Filter by customer, or sort by most recently updated to see what moved.",
    {
      customer_id: z.string().optional().describe("Only this customer's leads"),
      newest_first: z
        .boolean()
        .optional()
        .describe("Sort by most recently updated rather than the default order"),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ customer_id, newest_first, page, page_size }) => {
      try {
        const json = await hcp.request("/leads", {
          customer_id,
          sort_by: newest_first ? "updated_at" : undefined,
          sort_direction: newest_first ? "desc" : undefined,
          page,
          page_size: page_size ?? 25,
        });
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          { total_items, count: items.length, leads: items },
          items.length === 0 && !customer_id
            ? "No leads on this account. Leads are optional in Housecall Pro, so an empty list means the shop does not use them rather than that something failed."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_lead",
    "Get one lead, optionally with its line items. Note the lead's own line items are a separate list from any estimate or job it was converted into.",
    {
      lead_id: z.string().describe("The lead id, lea_-prefixed"),
      include_line_items: z.boolean().optional().describe("Also fetch the lead's line items"),
    },
    async ({ lead_id, include_line_items }) => {
      try {
        const lead = await hcp.request(`/leads/${encodeURIComponent(lead_id)}`);
        if (!include_line_items) return out(lead);
        const li = await hcp.request(`/leads/${encodeURIComponent(lead_id)}/line_items`);
        return out({ lead, line_items: hcp.normalizeList(li).items }, MONEY_NOTE);
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_events",
    "List calendar events - non-job entries on the schedule such as meetings and time off. " +
      "Each carries its recurrence rule, address and assigned employees.",
    {
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ page, page_size }) => {
      try {
        const json = await hcp.request("/events", { page, page_size: page_size ?? 25 });
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          { total_items, count: items.length, events: items },
          "Events carry no date filter. Narrow the window in your own code rather than with a query parameter, which this endpoint accepts and ignores.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_service_zones",
    "List the account's service zones with their zip codes and trip charges. " +
      "Pass a zip code to ask whether it is covered.",
    {
      zip_code: z.string().optional().describe("Return only zones covering this zip code"),
      address: z.string().optional().describe("Return only zones covering this address"),
    },
    async ({ zip_code, address }) => {
      try {
        const json = await hcp.request("/service_zones", {
          zip_code,
          address,
          page_size: 100,
        });
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          {
            total_items,
            count: items.length,
            service_zones: items,
            covered: zip_code ? items.length > 0 : undefined,
          },
          zip_code && items.length === 0
            ? `No zone covers ${zip_code}. On this API an empty result is a real answer here, because the zip_code filter is applied server-side.`
            : "trip_charge is in integer cents.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_routes",
    "List routes for a date - employees grouped with the appointments, events and estimates assigned to them.",
    {
      date: z
        .string()
        .optional()
        .describe(
          "ISO date, e.g. 2026-08-07. Omit for the default window. Bound the day in the account's own local offset, not a bare UTC date: a UTC day against a business in a local timezone shifts the day and can name the wrong day's routes - topic \"active-job-detection\" in hcp_api_notes.",
        ),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async ({ date, page, page_size }) => {
      try {
        const json = await hcp.request("/routes", { date, page, page_size });
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          { total_items, count: items.length, routes: items },
          items.length === 0
            ? "No routes returned. Routes exist only where the account builds them, so an empty list usually means the feature is unused rather than that the date was wrong."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_pipeline_statuses",
    "List the pipeline statuses configured for jobs, leads or estimates - the workflow stages a record moves through.",
    {
      resource_type: z
        .enum(["job", "lead", "estimate"])
        .describe("Which record type's pipeline to list. The API requires this"),
    },
    async ({ resource_type }) => {
      try {
        const json = await hcp.request("/pipeline/statuses", { resource_type });
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          { resource_type, total_items, count: items.length, statuses: items },
          items.length === 0
            ? "No pipeline statuses configured for this record type on this account."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_job_invoices",
    "Get the invoices belonging to one job, without walking the whole invoice list.",
    { job_id: z.string().describe("The job id, job_-prefixed") },
    async ({ job_id }) => {
      try {
        const json = await hcp.request(`/jobs/${encodeURIComponent(job_id)}/invoices`);
        const items = hcp.normalizeList(json).items.map(trimInvoice);
        return out(
          { count: items.length, invoices: items },
          items.length === 0
            ? "No invoice belongs to this job. That is not a bad job id: an invoice exists only once the job has been invoiced in Housecall Pro, so a worked-but-not-invoiced job has none, and there is no route to create one (topic \"job-has-no-invoice-yet\" in hcp_api_notes). hcp_list_invoices finds invoices across the account another way."
            : MONEY_NOTE,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_job_line_items",
    "Get one job's line items, with money converted to dollars.",
    { job_id: z.string().describe("The job id, job_-prefixed") },
    async ({ job_id }) => {
      try {
        const json = await hcp.request(`/jobs/${encodeURIComponent(job_id)}/line_items`);
        const items = hcp.normalizeList(json).items.map((li: any) => ({
          id: li?.id,
          name: li?.name,
          description: li?.description || undefined,
          kind: li?.kind,
          quantity: li?.quantity,
          unit_price_dollars: centsToDollars(li?.unit_price),
          unit_cost_dollars: centsToDollars(li?.unit_cost),
          taxable: li?.taxable,
        }));
        return out(
          { count: items.length, line_items: items },
          `${MONEY_NOTE} A line-item list can include rows the system added, such as tax, so do not read every row as something a person entered.`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_job_input_materials",
    "Get the materials recorded against one job - what was actually used on site, as distinct from the priced line items.",
    { job_id: z.string().describe("The job id, job_-prefixed") },
    async ({ job_id }) => {
      try {
        const json = await hcp.request(
          `/jobs/${encodeURIComponent(job_id)}/job_input_materials`,
        );
        const items = hcp.normalizeList(json).items.map((m: any) => ({
          uuid: m?.uuid,
          name: m?.name,
          description: m?.description || undefined,
          part_number: m?.part_number || undefined,
          quantity: m?.quantity,
          unit_cost_dollars: centsToDollars(m?.unit_cost),
        }));
        return out(
          { count: items.length, job_input_materials: items },
          items.length === 0
            ? "No materials are recorded against this job. That is a normal result, not an error - it means none were entered in Housecall Pro, which is common; the priced line items (hcp_get_job_line_items) are separate from what was recorded as used on site."
            : MONEY_NOTE,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_event",
    "Get one calendar event in full, with its recurrence rule, address and assigned employees.",
    { event_id: z.string().describe("The event id, evt_-prefixed") },
    async ({ event_id }) => {
      try {
        return out(await hcp.request(`/events/${encodeURIComponent(event_id)}`));
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_customer_address",
    "Get one of a customer's addresses. The customer record already embeds its addresses, so reach for this only when you have an address id and not the customer's record.",
    {
      customer_id: z.string().describe("The customer id, cus_-prefixed"),
      address_id: z.string().describe("The address id, adr_-prefixed"),
    },
    async ({ customer_id, address_id }) => {
      try {
        return out(
          await hcp.request(
            `/customers/${encodeURIComponent(customer_id)}/addresses/${encodeURIComponent(address_id)}`,
          ),
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_schedule_estimate_option",
    "Book a visit for an estimate option, optionally dispatching technicians to it. This sets the estimate's schedule and moves its work status to scheduled. " +
      "notify controls whether Housecall Pro tells the customer; it defaults to false here, and on one measured account the call sent nothing either way. " +
      "That is one account's configuration and not a promise: Housecall Pro's own automations and reminders can send independently, and it may still remind the customer as the date approaches.",
    {
      estimate_id: z.string().describe("The estimate id, csr_-prefixed"),
      option_id: z.string().describe("The option id, est_-prefixed"),
      start_time: z.string().describe("ISO 8601 start, e.g. 2027-03-01T15:00:00Z"),
      end_time: z.string().optional().describe("ISO 8601 end"),
      arrival_window_in_minutes: z
        .number()
        .int()
        .optional()
        .describe("Arrival window. Housecall Pro accepts only 0, 15, 20, 60, 120, 180 or 240"),
      employee_ids: z
        .array(z.string())
        .optional()
        .describe("Employees to dispatch, pro_-prefixed"),
      notify: z
        .boolean()
        .optional()
        .describe("Tell the customer. Defaults to false - say so explicitly to send"),
    },
    async ({ estimate_id, option_id, start_time, end_time, arrival_window_in_minutes, employee_ids, notify }) => {
      try {
        const body: Record<string, unknown> = {
          start_time,
          notify: notify ?? false,
          notify_pro: false,
        };
        if (end_time) body.end_time = end_time;
        if (arrival_window_in_minutes !== undefined) {
          body.arrival_window_in_minutes = arrival_window_in_minutes;
        }
        if (employee_ids?.length) {
          body.dispatched_employees = employee_ids.map((id) => ({ employee_id: id }));
        }
        const res = await hcp.put(
          `/estimates/${encodeURIComponent(estimate_id)}/options/${encodeURIComponent(option_id)}/schedule`,
          body,
        );
        return out(
          res,
          (notify
            ? "notify was true, so Housecall Pro was asked to tell the customer. "
            : "notify was false. Housecall Pro may still send its own reminder as the date approaches. ") +
            "A 2xx here is not proof the visit was booked: re-read the estimate's work_status with hcp_list_estimates and confirm it moved to scheduled before reporting the visit as booked (topic \"estimate-schedule-confirm-by-status\" in hcp_api_notes).",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_upload_estimate_option_attachment",
    "Attach a file to an estimate option, passed as base64. Unlike a job attachment this cannot be read back - estimate option attachments have no list route - so the response id is the only handle on it.",
    {
      estimate_id: z.string().describe("The estimate id, csr_-prefixed"),
      option_id: z.string().describe("The option id, est_-prefixed"),
      filename: z.string().describe("The filename to store it under"),
      content_base64: z.string().describe("The file's bytes, base64-encoded"),
      content_type: z.string().optional().describe("MIME type. Defaults to application/octet-stream"),
    },
    async ({ estimate_id, option_id, filename, content_base64, content_type }) => {
      try {
        const cleaned = content_base64.replace(/^data:[^;]*;base64,/, "").trim();
        const bytes = Buffer.from(cleaned, "base64");
        if (bytes.length === 0) {
          return errOut(
            "content_base64 decoded to zero bytes. Housecall Pro would store an empty file, so it is refused here instead.",
          );
        }
        const res = await hcp.postMultipartFile(
          `/estimates/${encodeURIComponent(estimate_id)}/options/${encodeURIComponent(option_id)}/attachments`,
          { filename, contentType: content_type || "application/octet-stream", bytes },
        );
        return out(
          res,
          "Not verified by read-back: this is the one attachment route with no list to read. Do not retry on a timeout - a second attempt attaches the file twice and nothing removes either copy.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_lock_job",
    "Lock one job, which freezes it against further edits. " +
      "★ There is no unlock on this API in any form, so this cannot be undone by any tool here - unlocking is a dashboard action. Ask the user before calling it.",
    { job_id: z.string().describe("The job id, job_-prefixed") },
    async ({ job_id }) => {
      try {
        const res = await hcp.post(`/jobs/${encodeURIComponent(job_id)}/lock`, {});
        const job = await hcp.request(`/jobs/${encodeURIComponent(job_id)}`);
        return out(
          { locked: res, locked_at: (job as any)?.locked_at ?? null },
          (job as any)?.locked_at
            ? "Confirmed by re-reading the job. This cannot be reversed through the API."
            : "The API accepted the lock but locked_at is not set on the job. Treat it as not locked.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_lock_jobs_by_date",
    "Bulk-lock jobs from a date onward. Note this keys on a DATE, not a list of job ids - it locks everything in the window, which is a much wider action than it sounds. " +
      "★ Irreversible through this API: there is no unlock. Confirm the date range with the user first.",
    {
      starting_at: z.string().describe("ISO date or timestamp. Everything from here is locked"),
      ending_at: z.string().optional().describe("ISO date or timestamp to bound the window"),
    },
    async ({ starting_at, ending_at }) => {
      try {
        const body: Record<string, unknown> = { starting_at };
        if (ending_at) body.ending_at = ending_at;
        return out(
          await hcp.post("/jobs/lock", body),
          "This targets every job in the window, not a chosen few, and nothing here can unlock them. The API answers 200 even when the window matched no jobs, so spot-check a job in the range with hcp_get_job (read locked_at) before reporting the batch as locked.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_job_link",
    "Attach a titled link to a job. " +
      "Requires an application context on the Housecall Pro account: where that is absent this returns 'Application not found' whatever the key's access level, which is an account-configuration limit rather than a permission one.",
    {
      job_id: z.string().describe("The job id, job_-prefixed"),
      title: z.string().describe("Link text"),
      url: z.string().describe("The URL"),
    },
    async ({ job_id, title, url }) => {
      try {
        return out(
          await hcp.post(`/jobs/${encodeURIComponent(job_id)}/links`, { title, url }),
          "Accepted, not confirmed: job links have no list route to read back through, so the 2xx is the only signal and the returned id is the only handle on it - keep it. An \"Application not found\" answer is the account lacking an API application (a configuration limit), not a permission wall.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_estimate_option_link",
    "Attach a titled link to an estimate option. Same application-context requirement as job links, and the same 'Application not found' where the account lacks it.",
    {
      estimate_id: z.string().describe("The estimate id, csr_-prefixed"),
      option_id: z.string().describe("The option id, est_-prefixed"),
      title: z.string().describe("Link text"),
      url: z.string().describe("The URL"),
    },
    async ({ estimate_id, option_id, title, url }) => {
      try {
        return out(
          await hcp.post(
            `/estimates/${encodeURIComponent(estimate_id)}/options/${encodeURIComponent(option_id)}/links`,
            { title, url },
          ),
          "Accepted, not confirmed: estimate option links have no list route to read back through, so treat the 2xx as accepted rather than confirmed and keep the returned id. An \"Application not found\" answer is the account lacking an API application, not a permission wall.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_get_application",
    "Read the API application registered against this Housecall Pro account. " +
      "An account with no application answers 'Application not found', which also explains why the link routes and webhook subscription are unreachable there.",
    {},
    async () => {
      try {
        return out(await hcp.request("/application"));
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_set_application_enabled",
    "Enable or disable this account's API application. Account-wide: disabling it affects every integration on the account, not just this one. Confirm with the user before calling.",
    { enabled: z.boolean().describe("true enables the application, false disables it") },
    async ({ enabled }) => {
      try {
        const res = await hcp.post(
          enabled ? "/application/enable" : "/application/disable",
          {},
        );
        return out(res, "Account-wide change. Re-read with hcp_get_application to confirm.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_webhook_subscription",
    "Subscribe a URL to Housecall Pro webhooks. " +
      "★ Partner-gated: a plain MAX key gets 'Organization app not found' regardless of access level, because subscribing needs an approved partner application. " +
      "★ Also worth knowing before relying on one: a Housecall Pro subscription is dropped after a single 5xx from your endpoint, so the receiver has to answer 2xx and do its work afterwards.",
    {
      url: z.string().describe("The HTTPS endpoint to deliver to"),
      events: z
        .array(z.string())
        .optional()
        .describe("Event names to subscribe to, where the account's application supports selecting them"),
    },
    async ({ url, events }) => {
      try {
        const body: Record<string, unknown> = { url };
        if (events?.length) body.events = events;
        return out(
          await hcp.post("/webhooks/subscription", body),
          "Accepted, not confirmed: there is no route to list webhook subscriptions afterwards (GET /webhooks is absent), so the returned subscription body is the only confirmation available and a delivery cannot be verified through this API. Keep the id.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_webhook_subscription",
    "Remove a webhook subscription. " +
      "★ This silences deliveries for whatever is subscribed on this account, which may be an integration other than yours. There is no read route to check what exists first - GET /webhooks is absent - so confirm with the user before calling.",
    {
      subscription_id: z
        .string()
        .optional()
        .describe("The subscription to remove, where the account's application identifies them individually"),
    },
    async ({ subscription_id }) => {
      try {
        const path = subscription_id
          ? `/webhooks/subscription/${encodeURIComponent(subscription_id)}`
          : "/webhooks/subscription";
        return out(await hcp.del(path), "There is no way to list subscriptions afterwards to confirm this.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_upload_job_attachment",
    "Attach a file to a job - a photo, a PDF, a report. The content is passed as base64 because a desktop assistant has no filesystem of its own. " +
      "The upload is confirmed by listing the job's attachments afterwards.",
    {
      job_id: z.string().describe("The job id, job_-prefixed"),
      filename: z
        .string()
        .describe("The filename to store it under, e.g. nameplate.jpg. Housecall Pro may transcode and rename it"),
      content_base64: z
        .string()
        .describe("The file's bytes, base64-encoded. No data: URI prefix"),
      content_type: z
        .string()
        .optional()
        .describe("MIME type, e.g. image/jpeg or application/pdf. Defaults to application/octet-stream"),
    },
    async ({ job_id, filename, content_base64, content_type }) => {
      try {
        let bytes: Uint8Array;
        try {
          // Tolerate a data: URI even though the schema asks for raw base64 -
          // it is the commonest way this argument arrives wrong, and the
          // failure it would otherwise cause is an opaque upload error.
          const cleaned = content_base64.replace(/^data:[^;]*;base64,/, "").trim();
          bytes = Buffer.from(cleaned, "base64");
        } catch {
          return errOut("content_base64 is not valid base64.");
        }
        if (bytes.length === 0) {
          return errOut(
            "content_base64 decoded to zero bytes. Housecall Pro would accept the upload and store an empty file, so it is refused here instead.",
          );
        }
        const created = await hcp.postMultipartFile(
          `/jobs/${encodeURIComponent(job_id)}/attachments`,
          {
            filename,
            contentType: content_type || "application/octet-stream",
            bytes,
          },
        );
        // Read back rather than trusting the 201: this is a write, and the
        // rule on this API is that a 2xx is not evidence.
        const job = await hcp.request(`/jobs/${encodeURIComponent(job_id)}`, {
          "expand[]": "attachments",
        });
        const listed = Array.isArray((job as any)?.attachments)
          ? (job as any).attachments.map(trimAttachment)
          : [];
        const present = listed.some((a: any) => a?.id === (created as any)?.id);
        // The created record without its link. The same file's link is in
        // job_attachments below, and a link returned twice is a second copy of
        // a working handle on the file for anything that reads this response.
        const { download_url: _uploadedLink, ...uploaded } = trimAttachment(created);
        return out(
          { uploaded, verified: present, job_attachments: listed },
          present
            ? `Confirmed against the job's attachment list. ${ATTACHMENT_NOTE}`
            : "The upload was accepted but the file is not in the job's attachment list yet. Housecall Pro commits an upload a moment after accepting it, so re-read the job before concluding it failed - and do not retry blindly, which would attach it twice.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_job_note",
    "Delete a note from a job. Notes are internal, so nothing reaches the customer. " +
      "This is the one write on this API that fully reverses itself, which makes it the safe way to test that writing works at all.",
    {
      job_id: z.string().describe("The job id, job_-prefixed"),
      note_id: z.string().describe("The note id, nte_-prefixed. Read it from hcp_get_job_notes"),
    },
    async ({ job_id, note_id }) => {
      try {
        await hcp.del(
          `/jobs/${encodeURIComponent(job_id)}/notes/${encodeURIComponent(note_id)}`,
        );
        const job = await hcp.request(`/jobs/${encodeURIComponent(job_id)}`);
        const still = (job?.notes ?? []).some((n: any) => n?.id === note_id);
        return out(
          { deleted: !still, note_id, remaining_notes: (job?.notes ?? []).length },
          still
            ? "The API accepted the delete but the note is still on the job. Treat it as not deleted."
            : "Confirmed by re-reading the job.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_convert_lead",
    "Convert a lead into an estimate or a job. Returns the id of the record created. " +
      "The lead itself survives the conversion rather than being consumed.",
    {
      lead_id: z.string().describe("The lead id, lea_-prefixed"),
      type: z
        .enum(["estimate", "job"])
        .describe("What to create from the lead. The API requires this and rejects other values"),
    },
    async ({ lead_id, type }) => {
      try {
        const res = await hcp.post(`/leads/${encodeURIComponent(lead_id)}/convert`, { type });
        return out(
          res,
          "Only one of job_id and estimate_id is populated - the other stays null. The lead remains readable afterwards.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_rename_job_type",
    "Rename a job type. There is no way to delete one through this API - removing a job type is a dashboard action, " +
      "and Housecall Pro warns there that deleting erases the value from previous jobs and estimates.",
    {
      job_type_id: z.string().describe("The job type id, jbt_-prefixed"),
      name: z.string().describe("The new name"),
    },
    async ({ job_type_id, name }) => {
      try {
        return out(
          await hcp.put(`/job_fields/job_types/${encodeURIComponent(job_type_id)}`, { name }),
          "Confirm with hcp_list_job_types. Nothing was sent to any customer.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_lead_source",
    "Create a lead source. Lead sources are the validation list for lead_source on customers and leads, so a value must exist here before it can be set. " +
      "There is no delete on this API - removing one is a dashboard action.",
    { name: z.string().describe("The lead source's name") },
    async ({ name }) => {
      try {
        return out(
          await hcp.post("/lead_sources", { name }),
          "Nothing was sent to any customer. Confirm with hcp_list_lead_sources.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_rename_lead_source",
    "Rename a lead source. Existing records keep pointing at it, so this renames the label rather than moving anything.",
    {
      lead_source_id: z.string().describe("The lead source id, lsrc_-prefixed"),
      name: z.string().describe("The new name"),
    },
    async ({ lead_source_id, name }) => {
      try {
        return out(
          await hcp.put(`/lead_sources/${encodeURIComponent(lead_source_id)}`, { name }),
          "Confirm with hcp_list_lead_sources.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_update_pricebook_material_category",
    "Rename a price-book material category.",
    {
      category_id: z.string().describe("The category uuid, pbmcat_-prefixed"),
      name: z.string().describe("The new name"),
    },
    async ({ category_id, name }) => {
      try {
        return out(
          await hcp.put(
            `/api/price_book/material_categories/${encodeURIComponent(category_id)}`,
            { name },
          ),
          "Rename sent. A 2xx is not proof the rename took (topic \"patch-jobs-silent-200\" in hcp_api_notes) - confirm the new name with hcp_search_pricebook kind='material_categories' before reporting it done.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_create_price_form",
    "Create a price-book price form - a bookable service template used by online booking.",
    {
      name: z.string().describe("The price form's name"),
      description: z.string().optional(),
      duration_in_minutes: z.number().int().min(0).optional(),
      taxable: z.boolean().optional(),
      automatically_add_to_new_job: z.boolean().optional(),
    },
    async (args) => {
      try {
        return out(
          await hcp.post("/api/price_book/price_forms", args),
          "Price form created - its id is on the response. Confirm it with hcp_list_price_forms.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_update_price_form",
    "Update a price-book price form. Only the fields you send change.",
    {
      price_form_id: z.string().describe("The price form id, pbpf_-prefixed"),
      name: z.string().optional(),
      description: z.string().optional(),
      duration_in_minutes: z.number().int().min(0).optional(),
      taxable: z.boolean().optional(),
      automatically_add_to_new_job: z.boolean().optional(),
    },
    async ({ price_form_id, ...rest }) => {
      try {
        return out(
          await hcp.put(
            `/api/price_book/price_forms/${encodeURIComponent(price_form_id)}`,
            rest,
          ),
          "Update sent. A success answer is not evidence the fields changed - confirm them with hcp_list_price_forms (pass price_form_id to read one back) before reporting the update as done.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_price_form",
    "Delete a price-book price form. This one really is removed, unlike most Housecall Pro deletes.",
    { price_form_id: z.string().describe("The price form id, pbpf_-prefixed") },
    async ({ price_form_id }) => {
      try {
        await hcp.del(`/api/price_book/price_forms/${encodeURIComponent(price_form_id)}`);
        return out({ deleted: true, price_form_id }, "Confirm with hcp_list_price_forms.");
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_update_job_input_materials",
    "Replace the materials recorded against a job - what was actually used on site. " +
      "This is a whole-list replace, not an append: anything you leave out is dropped. Read the current list first with hcp_get_job_input_materials.",
    {
      job_id: z.string().describe("The job id, job_-prefixed"),
      materials: z
        .array(
          z.object({
            uuid: z.string().optional().describe("Include to keep an existing row; omit to add one"),
            name: z.string(),
            description: z.string().optional(),
            part_number: z.string().optional(),
            quantity: z.number(),
            unit_cost_dollars: z.number().describe("In dollars; converted to cents on the way out"),
          }),
        )
        .describe("The complete list the job should end up with"),
    },
    async ({ job_id, materials }) => {
      try {
        const payload = materials.map((m) => ({
          uuid: m.uuid,
          name: m.name,
          description: m.description,
          part_number: m.part_number,
          quantity: m.quantity,
          unit_cost: Math.round(m.unit_cost_dollars * 100),
        }));
        await hcp.put(`/jobs/${encodeURIComponent(job_id)}/job_input_materials/bulk_update`, {
          job_input_materials: payload,
        });
        const after = await hcp.request(
          `/jobs/${encodeURIComponent(job_id)}/job_input_materials`,
        );
        const rows = hcp.normalizeList(after).items;
        return out(
          { count: rows.length, job_input_materials: rows },
          `${MONEY_NOTE} Confirmed by re-reading the job's materials. There is no single-item route; the bulk form is the only way to change these.`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_update_estimate_option_line_items",
    "Replace the line items on an estimate option. A whole-list replace: anything you leave out is dropped. " +
      "Read the current items first with hcp_get_estimate_line_items.",
    {
      estimate_id: z.string().describe("The estimate id, csr_-prefixed"),
      option_id: z.string().describe("The option id, est_-prefixed"),
      line_items: z
        .array(
          z.object({
            id: z.string().optional().describe("Include to update an existing item; omit to add one"),
            name: z.string(),
            description: z.string().optional(),
            kind: z.string().optional(),
            quantity: z.number(),
            unit_price_dollars: z.number().describe("In dollars; converted to cents on the way out"),
            unit_cost_dollars: z.number().optional(),
            taxable: z.boolean().optional(),
          }),
        )
        .describe("The complete list the option should end up with"),
    },
    async ({ estimate_id, option_id, line_items }) => {
      try {
        const payload = line_items.map((li) => ({
          id: li.id,
          name: li.name,
          description: li.description,
          kind: li.kind ?? "labor",
          quantity: li.quantity,
          unit_price: Math.round(li.unit_price_dollars * 100),
          unit_cost: Math.round((li.unit_cost_dollars ?? 0) * 100),
          taxable: li.taxable,
        }));
        const base = `/estimates/${encodeURIComponent(estimate_id)}/options/${encodeURIComponent(option_id)}`;
        await hcp.put(`${base}/line_items/bulk_update`, { line_items: payload });
        const after = await hcp.request(`${base}/line_items`);
        // Same converted shape as hcp_get_estimate_line_items - the raw rows
        // carry integer cents, and a confirmation read that emits them raw
        // invites a hundred-fold misread.
        const rows = hcp.normalizeList(after).items.map((li: any) => ({
          id: li?.id,
          name: li?.name,
          description: li?.description || undefined,
          kind: li?.kind,
          quantity: li?.quantity,
          unit_price_dollars: centsToDollars(li?.unit_price),
          unit_cost_dollars: centsToDollars(li?.unit_cost),
          taxable: li?.taxable,
        }));
        return out(
          { count: rows.length, line_items: rows },
          `${MONEY_NOTE} Confirmed by re-reading the option's line items. There is no single-item route here; the bulk form is the only way. ` +
            `The account's own tax row (kind "tax") rides in this list and survives a replace - it is system-added, not one of yours.`,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_add_estimate_option_note",
    "Add a note to an estimate option. Internal - nothing reaches the customer. " +
      "Note that these cannot be read back through this API, so record the returned id if you will need it.",
    {
      estimate_id: z.string().describe("The estimate id, csr_-prefixed"),
      option_id: z.string().describe("The option id, est_-prefixed"),
      content: z.string().describe("The note text"),
    },
    async ({ estimate_id, option_id, content }) => {
      try {
        const res = await hcp.post(
          `/estimates/${encodeURIComponent(estimate_id)}/options/${encodeURIComponent(option_id)}/notes`,
          { content },
        );
        return out(
          res,
          "There is no route to list estimate option notes, so this id is the only handle on it. Keep it if the note may need deleting.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_delete_estimate_option_note",
    "Delete a note from an estimate option. The delete cannot be confirmed by reading back, because these notes have no list route.",
    {
      estimate_id: z.string().describe("The estimate id, csr_-prefixed"),
      option_id: z.string().describe("The option id, est_-prefixed"),
      note_id: z.string().describe("The note id, nte_-prefixed, as returned when it was added"),
    },
    async ({ estimate_id, option_id, note_id }) => {
      try {
        await hcp.del(
          `/estimates/${encodeURIComponent(estimate_id)}/options/${encodeURIComponent(option_id)}/notes/${encodeURIComponent(note_id)}`,
        );
        return out(
          { deleted: true, note_id },
          "Reported as deleted by the API. This one cannot be verified by re-reading - estimate option notes have no list route.",
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_list_price_forms",
    "List price-book price forms - the bookable service templates behind online booking, with their durations and questions.",
    {
      price_form_id: z
        .string()
        .optional()
        .describe("Fetch one price form in full instead of listing them"),
    },
    async ({ price_form_id }) => {
      try {
        if (price_form_id) {
          return out(
            await hcp.request(`/api/price_book/price_forms/${encodeURIComponent(price_form_id)}`),
          );
        }
        const json = await hcp.request("/api/price_book/price_forms", { page_size: 100 });
        const { items, total_items } = hcp.normalizeList(json);
        return out(
          { total_items, count: items.length, price_forms: items },
          items.length === 0
            ? "No price forms are set up on this account. Online booking is optional, so an empty list is a normal answer rather than a failure."
            : undefined,
        );
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_render_report",
    "Render a findings report into one self-contained, offline, interactive HTML file — " +
      "sortable and filterable tables, severity-coded sections, collapsible worklists, selectable " +
      "rows that copy back to chat, light and dark theme, print. This is a presentation tool: it " +
      "makes no Housecall Pro call and takes findings you already have.\n\n" +
      "Pass a `report` contract. Required keys: `skill`, `title`, `sections` (an array). Each section " +
      "has a `title`, an optional `severity` (confident|ok|warning|blocked|info|neutral), and `blocks` " +
      "(an array). A block is one of: `table` ({columns:[{label,numeric?}], rows:[[cells]], " +
      "selectable?, collapsedRows?, defaultSort?}), `prose`/`lead` ({html}), `list` ({items,crosses?}), " +
      "`subhead` ({text}). Optional top-level keys: `kicker`, `stats` (cards), `coverage`, `headline`, " +
      "`order` (suggested work), `meta`, `generated`, `provenance`, `closing`. In table cells and list " +
      "items, `` `backticks` `` render as chips, `**stars**` as bold, and `[text](https://...)` as a " +
      "link opening in a new tab (http/https only) - use it to link records to their pages in the " +
      "owner's own dashboard. Keep money as display strings; exports and paste-backs show a link's " +
      "text without the URL.\n\n" +
      "The tool returns the finished HTML. In Claude Code, write it to a `.html` file and give the owner " +
      "the path; on Claude Desktop, present it as an HTML artifact. On a contract error nothing renders " +
      "and the exact problems are listed so you can fix and re-call.",
    {
      report: z
        .object({})
        .passthrough()
        .describe("The report contract object (see the description for its shape)."),
    },
    async ({ report }) => {
      try {
        const { html, errors, warnings } = renderReport(report);
        if (errors.length || !html) {
          // Every problem at once, then a skeleton that renders. The errors say
          // what is wrong; the example says what right looks like, which is what
          // stops a caller fixing one layer per round trip.
          return errOut(
            "The report was not rendered — the contract has errors:\n- " +
              errors.join("\n- ") +
              "\n\nA minimal contract that renders:\n" +
              MINIMAL_REPORT_EXAMPLE,
          );
        }
        const rep = report as { sections?: unknown[] };
        const secN = Array.isArray(rep.sections) ? rep.sections.length : 0;
        const kb = Math.round(Buffer.byteLength(html, "utf8") / 1024);
        const summary =
          `Report rendered: ${secN} section(s), ${kb}KB, self-contained and offline. ` +
          `In Claude Code write the HTML below to a .html file and tell the owner the path; ` +
          `on Claude Desktop present it as an HTML artifact.` +
          (warnings.length ? `\nRendered with warnings: ${warnings.join("; ")}` : "");
        const notice = versionCheck.consumeNotice();
        return {
          content: [
            { type: "text" as const, text: summary + (notice ? `\n\n${notice}` : "") + "\n\n" + html },
          ],
        };
      } catch (e) {
        return errOut(e);
      }
    },
  );

  tool(
    "hcp_export_csv",
    "Export customers, jobs, invoices, or estimates as CSV text (trimmed columns, money in dollars). " +
      "For invoices, since/until narrow the export to a service-date range.",
    {
      entity: z.enum(["customers", "jobs", "invoices", "estimates"]),
      since: z.string().optional().describe("Invoices only: earliest service date, YYYY-MM-DD"),
      until: z.string().optional().describe("Invoices only: latest service date, YYYY-MM-DD"),
      max_rows: z.number().int().min(1).max(5000).optional().describe("Row cap, default 500"),
    },
    async ({ entity, since, until, max_rows }) => {
      try {
        const cap = max_rows ?? 500;
        const trimmers: Record<string, (x: any) => Record<string, unknown>> = {
          customers: trimCustomer,
          jobs: trimJob,
          invoices: trimInvoice,
          estimates: trimEstimate,
        };
        const prepRow = (item: unknown) => {
          const trimmed = trimmers[entity](item);
          if (entity === "invoices" || entity === "estimates") {
            // flatten arrays for CSV
            for (const [k, v] of Object.entries(trimmed)) {
              if (Array.isArray(v)) trimmed[k] = v.join("; ");
            }
          }
          if (Array.isArray(trimmed.tags)) trimmed.tags = (trimmed.tags as unknown[]).join("; ");
          return trimmed;
        };
        const rows: Record<string, unknown>[] = [];
        const dateWindowed = entity === "invoices" && (since || until);
        let mayBeIncomplete = false;

        if (dateWindowed) {
          // Walk pages explicitly so the reason the walk stopped is known.
          // Reaching the window's oldest invoice, the row cap, or the end of the
          // data is a complete window; stopping on the page cap while still
          // inside the window is not - and a bare row count would read a
          // truncated export as the whole window. This is the may_be_incomplete
          // flag hcp_list_invoices and hcp_revenue_summary already carry.
          const maxPages = 50;
          let stop = "pagecap";
          outer: for (let page = 1; page <= maxPages; page++) {
            const { items } = hcp.normalizeList(
              await hcp.request(`/${entity}`, { page, page_size: 100 }),
            );
            if ((items as any[]).length === 0) {
              stop = "exhausted";
              break;
            }
            for (const item of items as any[]) {
              const d = String(item?.service_date ?? "").slice(0, 10);
              // Invoices arrive newest-first, so once rows predate the window we are done.
              if (since && d && d < since) {
                stop = "windowfloor";
                break outer;
              }
              if (!inWindow(item?.service_date, since, until)) continue;
              rows.push(prepRow(item));
              if (rows.length >= cap) {
                stop = "rowcap";
                break outer;
              }
            }
            if ((items as any[]).length < 100) {
              stop = "exhausted";
              break;
            }
          }
          mayBeIncomplete = stop === "pagecap";
        } else {
          const maxPages = Math.ceil(cap / 100);
          for await (const item of hcp.paginate(`/${entity}`, {}, maxPages)) {
            rows.push(prepRow(item));
            if (rows.length >= cap) break;
          }
        }

        const csv = toCsv(rows);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${rows.length} rows (cap ${cap})` +
                (mayBeIncomplete
                  ? ", may_be_incomplete=true: the export stopped on its page cap before reaching the window's oldest invoice, so the window may extend past the rows walked - narrow since/until, or read the rest with hcp_list_invoices"
                  : "") +
                `. ${MONEY_NOTE}\n\n${csv}`,
            },
          ],
        };
      } catch (e) {
        return errOut(e);
      }
    },
  );

  /* ---------- shop defaults (this machine, never the account) ---------- */

  const DEFAULTS_SCOPE_NOTE =
    "These are this installation's own preferences, kept in a file on the machine the server runs on rather than in Housecall Pro. Nothing here is read from Housecall Pro or sent to it. ";

  /**
   * One stored preference. A number or a string because that is what the store
   * accepts, and null because that is how a key is cleared.
   */
  const DEFAULT_VALUE = z.union([z.number(), z.string(), z.null()]);

  /**
   * The write tool's arguments come from the store's own key list and its own
   * descriptions, so the schema a caller reads cannot drift from the keys the
   * store will actually accept.
   */
  const defaultsShape = Object.fromEntries(
    DEFAULT_KEYS.map((key) => [
      key,
      DEFAULT_VALUE.optional().describe(
        `${DEFAULT_KEY_DESCRIPTIONS[key]} Pass null to clear it.`,
      ),
    ]),
  ) as Record<string, z.ZodOptional<typeof DEFAULT_VALUE>>;

  /** Refused keys, named with the reason, so a caller can fix the one that failed. */
  const refusals = (ignored: { key: string; why: string }[]) =>
    ignored.length ? ` Refused ${ignored.map((i) => `${i.key} (${i.why})`).join("; ")}.` : "";

  tool(
    "hcp_get_defaults",
    "Read the shop defaults stored for this installation: how long a job runs, how wide an arrival window is, and the line item most jobs start from. " +
      "Read them before proposing a booking, so a preference the shop confirmed once does not have to be asked for again. " +
      DEFAULTS_SCOPE_NOTE +
      "An empty answer means none has been set, which is the ordinary state of a fresh install.",
    {},
    async () => {
      // No try/catch: readDefaults never rejects. A missing, unreadable or
      // malformed file reads back as no defaults plus the reason it could not
      // be used, and that reason is what the note carries.
      const r = await readDefaults();
      return out(r, r.note);
    },
  );

  tool(
    "hcp_set_defaults",
    "Store one or more shop defaults for this installation. Each key replaces the value already there, and null clears one. " +
      "Set one when the shop states a standing preference, not when a single job happens to differ from it. " +
      DEFAULTS_SCOPE_NOTE +
      "The file belongs to the installed server, so a shop running this on two computers sets its defaults on each. " +
      `An arrival window has to be a width Housecall Pro accepts (${ARRIVAL_WINDOW_VALUES} minutes), because one it does not accept would only surface later, as a failure on a booking.`,
    defaultsShape,
    async (values) => {
      // A key the caller left out arrives as undefined. Passing it on would read
      // as an attempt to set it and come back refused by name, so it is dropped.
      const given = Object.fromEntries(
        Object.entries(values ?? {}).filter(([, v]) => v !== undefined),
      );
      const r = await setDefaults(given);
      if (!r.ok) {
        return errOut(
          `${r.note ?? "Nothing was stored, so the defaults are unchanged."}${refusals(r.ignored)}`,
        );
      }
      return out(
        r,
        `${r.note ?? "Stored on this machine. Nothing was sent to Housecall Pro."}${refusals(r.ignored)}`,
      );
    },
  );

  /* ---------- business profile (the first-run interview's memory) ---------- */

  const PROFILE_SCOPE_NOTE =
    "The profile is this installation's own file, on this machine, beside the defaults file. Nothing in it is read from Housecall Pro or sent to it, or to anyone else. ";

  /**
   * Section payloads are validated by the store, which refuses bad shapes by
   * name. The schema here stays permissive so the store remains the one place
   * the rules live; the descriptions carry what each section holds.
   */
  const profileShape = Object.fromEntries(
    PROFILE_SECTION_KEYS.map((key) => [
      key,
      z
        .unknown()
        .optional()
        .describe(`${PROFILE_SECTION_DESCRIPTIONS[key]} Pass null to clear the section.`),
    ]),
  ) as Record<string, z.ZodOptional<z.ZodUnknown>>;

  tool(
    "hcp_get_business_profile",
    "Read the business profile stored for this installation: who the shop is, who they buy from, their pricing rules, their payroll rules, and how their outbound messages should sound. " +
      "Skills read this before asking setup questions, so an interview answered once is never asked twice; missing_sections is what a first run still has to ask, and each stored section carries the date it was last confirmed. " +
      PROFILE_SCOPE_NOTE +
      "An empty profile is the ordinary state of a fresh install, not a problem.",
    {},
    async () => {
      // No try/catch: readBusinessProfile never rejects. Anything wrong with
      // the file reads back as an empty profile plus the reason, in the note.
      const r = await readBusinessProfile();
      return out(r, r.note);
    },
  );

  tool(
    "hcp_set_business_profile",
    "Store one or more business-profile sections for this installation: shop, vendors, pricing, payroll, comms. " +
      "Each section replaces the stored section whole, and null clears one - so save a section only after reading the whole section back to the user for a yes. " +
      PROFILE_SCOPE_NOTE +
      "The sections hold the shop's own facts, never a customer's, and never credentials: a vendor's account_hint refuses anything that looks like a full account number.",
    profileShape,
    async (values) => {
      const given = Object.fromEntries(
        Object.entries(values ?? {}).filter(([, v]) => v !== undefined),
      );
      const r = await setBusinessProfile(given);
      if (!r.ok) {
        return errOut(
          `${r.note ?? "Nothing was stored, so the profile is unchanged."}${refusals(r.ignored)}`,
        );
      }
      return out(
        r,
        `${r.note ?? "Stored on this machine. Nothing was sent to Housecall Pro."}${refusals(r.ignored)}`,
      );
    },
  );

  tool(
    "hcp_api_notes",
    "Look up what the Housecall Pro API actually does for a given topic, as opposed to what its published documentation says. " +
      "Call this BEFORE concluding that something cannot be done, before retrying a route that returned 404, and after any write that reported success but looks like it changed nothing. " +
      "It answers from a table of verified behaviour: routes the documentation describes that do not exist, writes that are accepted and silently ignored, and fields whose units are not what they appear to be. " +
      "Ask in plain words - a topic, a route, a field name, or the thing you were trying to do. Omit the topic to read the whole table. " +
      "This tool reads a table compiled into this server and makes no API call, so it costs nothing and cannot fail.",
    {
      topic: z
        .string()
        .optional()
        .describe(
          "What you are working on. A route (\"PATCH /jobs\"), a field (\"work_status\"), or a goal (\"set a job description\", \"create an invoice\"). Omit for everything.",
        ),
    },
    async ({ topic }: { topic?: string }) => {
      const { notes, phantom_routes } = searchApiNotes(topic ?? "");

      if (topic && notes.length === 0 && phantom_routes.length === 0) {
        // Nothing matched. Saying so plainly matters more than guessing, but a
        // caller should not read "no note" as "no problem" - the table is
        // curated, not exhaustive.
        return out(
          {
            topic,
            notes: [],
            phantom_routes: [],
            core_rule: CORE_RULE,
          },
          `No note covers "${topic}". That means this table has nothing recorded for it, not that the API behaves as documented there. ` +
            `${CORE_RULE} Omit the topic to read all ${TOTAL_NOTES} notes and ${TOTAL_PHANTOM} absent routes.`,
        );
      }

      const silent = notes.filter((n) => n.kind === "silent");
      return out(
        {
          topic: topic ?? "(all)",
          core_rule: CORE_RULE,
          notes,
          phantom_routes,
        },
        [
          phantom_routes.length
            ? `${phantom_routes.length} documented route(s) here DO NOT EXIST - a 404 on those is the route being absent, not a bad request.`
            : "",
          silent.length
            ? `${silent.length} note(s) here describe writes that are ACCEPTED AND SILENTLY IGNORED. Do not report those as done without reading the record back.`
            : "",
        ]
          .filter(Boolean)
          .join(" ") || CORE_RULE,
      );
    },
  );
}

/**
 * Register the API-behaviour tables as readable resources. A client that
 * supports resources can pull the whole table in without spending a tool call,
 * which is the cheaper path when an agent is about to do a lot of writes.
 *
 * Kept separate from registerTools because the test harness stands in a bare
 * object for the server and has no resource support; a caller that cannot do
 * resources simply does not call this.
 */
export function registerApiNoteResources(server: McpServer) {
  const reg = (server as any).registerResource?.bind(server);
  if (!reg) return;

  reg(
    "hcp-api-quirks",
    "hcp://api-notes/quirks",
    {
      title: "Housecall Pro API behaviour notes",
      description:
        "Verified Housecall Pro API behaviour that differs from its published documentation, including the writes that are accepted and silently ignored.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "hcp://api-notes/quirks",
          mimeType: "text/markdown",
          text: renderNotes(),
        },
      ],
    }),
  );

  reg(
    "hcp-api-phantom-routes",
    "hcp://api-notes/phantom-routes",
    {
      title: "Documented Housecall Pro routes that do not exist",
      description:
        "Routes the published Housecall Pro documentation describes which are absent from the API. A 404 on one of these is the route being absent, not a bad request.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "hcp://api-notes/phantom-routes",
          mimeType: "text/markdown",
          text: renderPhantomRoutes(),
        },
      ],
    }),
  );
}
