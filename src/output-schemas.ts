/**
 * What each tool promises to return.
 *
 * A tool that declares an `outputSchema` must return `structuredContent`
 * conforming to it, and the SDK raises an MCP error when it does not. That cuts
 * both ways: the schema is the strongest statement this server can make about
 * its own output, and a schema that is wrong about reality turns a working tool
 * into a hard failure.
 *
 * So the rule here is: **promise the shape, never the contents.**
 *
 * - Every field is `nullish` — present, null, or absent are all acceptable.
 *   Not merely optional: `centsToDollars` returns `null` when an amount is
 *   missing, so a money field declared `.optional()` refuses the very row it
 *   was written for. That shipped for about an hour and the round-trip test
 *   caught it; the `str`/`num`/`bool`/`arr` helpers below exist so the decision
 *   is made once instead of ninety times.
 * - Every object passes unknown keys through. We do not own the upstream
 *   payload and several tools spread it. A field Housecall Pro adds next month
 *   must not take the tool down.
 *
 * What that still buys, and it is the point: a client reading `tools/list` sees
 * the field names, their types and the nesting, without calling anything. That
 * is what a schema is for. Strictness is not.
 */
import { z } from "zod";

/* Leaf builders. Nullish is the default here rather than a thing to remember. */
const str = (d?: string) => (d ? z.string().nullish().describe(d) : z.string().nullish());
const num = (d?: string) => (d ? z.number().nullish().describe(d) : z.number().nullish());
const bool = (d?: string) => (d ? z.boolean().nullish().describe(d) : z.boolean().nullish());
const arr = (item: z.ZodTypeAny, d?: string) =>
  d ? z.array(item).nullish().describe(d) : z.array(item).nullish();
/** An id or number, because Housecall Pro is inconsistent about which it sends. */
const idish = (d?: string) => {
  const base = z.union([z.string(), z.number()]).nullish();
  return d ? base.describe(d) : base;
};
/** Anything the API hands back that we pass along without reshaping. */
const loose = () => z.object({}).passthrough();

/**
 * The envelope every list tool returns. Named here once because it is the shape
 * a consumer paginates on, and four spellings of it across ninety-five tools is
 * how a consumer ends up special-casing each one.
 */
const PAGINATION = {
  total_items: num("Rows across all pages, as Housecall Pro counts them"),
  total_pages: num(),
  has_more: bool("True when a page after this one exists"),
  page: num("The page this response is"),
};

/** A list response: the pagination envelope plus the rows under their own key. */
function listOf(collection: string, row: z.ZodTypeAny, extra: z.ZodRawShape = {}): z.ZodRawShape {
  return { ...PAGINATION, ...extra, [collection]: arr(row) };
}

/* ---------------------------------------------------------------- row shapes */
/* Each mirrors the trimmer of the same name in tools.ts. The suite calls every
 * declared tool through a real client-server round trip over a rich fixture, so
 * a field added to a trimmer without being added here is caught by the SDK's
 * own validation rather than by review. */

export const customerRow = z
  .object({
    id: str(),
    first_name: str(),
    last_name: str(),
    company: str(),
    email: str(),
    mobile_number: str(),
    home_number: str(),
    city: str(),
    state: str(),
    tags: arr(z.unknown()),
    addresses: arr(loose()),
  })
  .passthrough();

export const employeeRef = z.object({ id: str(), name: str() }).passthrough();

export const attachmentRow = z
  .object({
    id: str(),
    file_name: str(),
    file_type: str(),
    download_url: str("Signed and short-lived; fetch it when given, never store it"),
  })
  .passthrough();

export const jobRow = z
  .object({
    id: str(),
    deleted_at: str(
      "Set on a deleted job. Deleted jobs stay in list responses and count toward totals - exclude them from revenue",
    ),
    invoice_number: idish(),
    customer_id: str(),
    customer_name: str(),
    description: str(),
    work_status: str("Housecall Pro's own vocabulary, e.g. 'complete unrated'"),
    work_status_bucket: str("work_status normalized into a stable bucket"),
    created_at: str(),
    updated_at: str(),
    lead_source: str(),
    canceled_at: str(),
    scheduled_start: str("UTC"),
    scheduled_end: str("UTC"),
    scheduled_start_local: str("The same time in the account's zone. Quote this one to a person"),
    scheduled_end_local: str(),
    on_my_way_at: str(),
    started_at: str(),
    completed_at: str(),
    job_type: str(),
    address_id: str(),
    address_street: str(),
    recurrence_id: str(),
    original_estimate_id: str(
      "Set only when the job came through the convert flow. Its absence is not evidence the work was never done",
    ),
    employees: arr(employeeRef),
    total_dollars: num("Converted from Housecall Pro's integer cents"),
    outstanding_dollars: num(),
    tags: arr(z.unknown()),
    notes: arr(z.string(), "Office notes, clipped at 500 characters"),
    attachments: arr(attachmentRow),
  })
  .passthrough();

export const invoiceRow = z
  .object({
    id: str(),
    invoice_number: idish(),
    job_id: str(),
    status: str(),
    service_date: str(),
    due_at: str(),
    amount_dollars: num(),
    subtotal_dollars: num(),
    due_amount_dollars: num(),
    items: arr(z.string(), "Line-item names only"),
  })
  .passthrough();

export const invoiceDetail = z
  .object({
    id: str(),
    invoice_number: idish(),
    status: str(),
    service_date: str(),
    invoice_date: str(),
    due_at: str(),
    due_terms: str(),
    sent_at: str(),
    paid_at: str(),
    amount_dollars: num(),
    subtotal_dollars: num(),
    due_amount_dollars: num(),
    items: arr(loose()),
    payments: arr(loose()),
  })
  .passthrough();

export const addressRow = z
  .object({
    id: str(),
    street: str(),
    street_line_2: str(),
    city: str(),
    state: str(),
    zip: str(),
    country: str(),
  })
  .passthrough();

export const appointmentRow = z
  .object({
    id: str(),
    start_date: str(),
    start_time: str(),
    end_time: str(),
    anytime: bool(),
    arrival_window_minutes: num(),
    dispatched_employees_ids: arr(z.string()),
  })
  .passthrough();

export const estimateRow = z
  .object({
    id: str(),
    estimate_number: idish(),
    work_status: str(),
    created_at: str(),
    customer_id: str(),
    customer_name: str(),
    option_count: num(),
    options: arr(loose()),
  })
  .passthrough();

/* ------------------------------------------------------- per-tool declarations */

/**
 * Tool name to the shape it returns. A tool absent from this table declares no
 * output schema — which is valid, and it still returns `structuredContent`,
 * because `out()` always sets it. Absence costs a consumer the contract, never
 * the data. The table is grown deliberately, one modelled family at a time,
 * because declaring a schema obliges every success path of that tool to satisfy
 * it.
 */
export const OUTPUT_SCHEMAS: Record<string, z.ZodRawShape> = {
  /* --- paginated listings: the envelope plus rows --- */
  hcp_search_customers: listOf("customers", customerRow),
  hcp_list_estimates: listOf("estimates", estimateRow),
  hcp_list_jobs: listOf("jobs", jobRow, {
    employee_filter: str("Present only when an employee filter narrowed this page"),
    rows_on_page: num("Rows the API returned before the employee filter, present only when one was applied"),
    matched_on_page: num("Rows that survived it, present only when one was applied"),
  }),

  /* --- listings with their own envelope --- */
  // Not a mistake and not tidied up here: these three genuinely answer in
  // different shapes, because they do different work. hcp_list_invoices walks
  // pages client-side (Housecall Pro has no server-side service-date filter) and
  // reports what that walk covered, which a page number cannot express.
  hcp_list_invoices: {
    count: num("Rows in this response"),
    date_field: str("Which date field the window was applied to"),
    filtered_by: str(),
    statuses_requested: arr(z.string()),
    status_filter: str(),
    matching_invoices_on_account: num(),
    pages_walked: num("How many pages the client-side walk covered"),
    stopped_at_window_edge: bool(),
    may_be_incomplete: bool("True when the walk hit its page cap before the window closed"),
    invoices: arr(invoiceRow),
  },
  hcp_list_job_appointments: {
    job_id: str(),
    archived: bool("An archived job refuses to describe its appointments; the list comes back empty rather than failing"),
    appointment_count: num(),
    appointments: arr(appointmentRow),
  },
  hcp_get_job_invoices: {
    count: num(),
    invoices: arr(invoiceRow),
  },

  /* --- bare listings --- */
  // These return an array, which structuredContent cannot be, so `out()` wraps
  // it under `result`. Declaring that is the honest description of what a
  // consumer receives.
  hcp_list_employees: { result: arr(loose(), "Employee records as Housecall Pro sends them") },
  hcp_list_tags: { result: arr(loose(), "Tag records. Note that a row carries a tag NAME while writes take ids") },
  hcp_list_job_types: { result: arr(loose()) },
};

/**
 * Tools whose output is the upstream record passed through, and which therefore
 * declare no schema.
 *
 * `hcp_get_job`, `hcp_get_customer` and `hcp_get_invoice` hand back what
 * Housecall Pro sent, with our additions riding alongside - `schedule_local` on
 * a job, for instance - and the money fields deliberately left in the raw
 * integer cents the record carries, which the accompanying note explains.
 * Modelling those means owning Housecall Pro's own schema, which is not ours to
 * promise and would go stale silently. A schema that describes keys a tool does
 * not send validates perfectly and still lies to the consumer reading it, so
 * saying nothing is the honest option.
 */
export const PASSTHROUGH_TOOLS = [
  "hcp_get_job",
  "hcp_get_customer",
  "hcp_get_customer_address",
  "hcp_get_invoice",
] as const;

/**
 * Keys a tool sends only in some circumstances. The live verification compares
 * declared keys against what actually came back, and would otherwise read a
 * legitimately-conditional field as a phantom.
 */
export const CONDITIONAL_KEYS: Record<string, string[]> = {
  hcp_list_jobs: ["employee_filter", "rows_on_page", "matched_on_page"],
  hcp_list_invoices: ["filtered_by", "status_filter", "statuses_requested", "stopped_at_window_edge"],
};

export function outputSchemaFor(name: string): z.ZodRawShape | undefined {
  return OUTPUT_SCHEMAS[name];
}
