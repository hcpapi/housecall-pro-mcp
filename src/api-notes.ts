/**
 * What the Housecall Pro API actually does, as opposed to what its published
 * documentation says it does.
 *
 * This file exists because the README's version of this knowledge is read by
 * people and never by the model. An agent that has not been told that
 * `PATCH /jobs` answers 200 without changing anything will report a successful
 * write that did not happen, and an agent that has not been told
 * `POST /invoices` is absent will keep trying it. Both are confident wrong
 * answers rather than errors, which is the failure mode worth engineering
 * against.
 *
 * Three surfaces are built from the tables below:
 *   - the server `instructions` string, which lands in the client's context at
 *     connect time, before any tool is called;
 *   - two MCP resources, so a client can read the whole table without spending
 *     a tool call;
 *   - the `hcp_api_notes` tool, for a targeted lookup mid-task.
 */

export interface ApiNote {
  /** Stable slug, usable as a lookup key. */
  id: string;
  /** Terms a caller might search for. Matched case-insensitively. */
  tags: string[];
  /** What the API does. */
  what: string;
  /** What this server does about it, or what the caller should do instead. */
  handling: string;
  /**
   * `silent` means a request is accepted and has no effect - the dangerous
   * class, because a 2xx is not evidence of a change. `shape` means the data
   * arrives in a form that misleads. `absent` is covered by PHANTOM_ROUTES.
   */
  kind: "silent" | "shape";
}

/**
 * The single most load-bearing sentence in this package. Repeated in the
 * server instructions, in both resources, and in every `hcp_api_notes` answer,
 * because it is the rule that prevents the worst failure.
 */
export const CORE_RULE =
  "Never trust a 2xx on a Housecall Pro write. Several routes answer 200 without changing anything. " +
  "Read the record back before reporting a write as done.";

export const API_NOTES: ApiNote[] = [
  {
    id: "invoice-status-needs-array-syntax",
    tags: ["invoice", "status", "filter", "paid", "unpaid", "open", "array"],
    what:
      "The /invoices status filter works, but only in array form. status[]=paid returns only paid invoices and status[]=open only open ones, while a bare status=paid returns nothing usable.",
    handling:
      "hcp_list_invoices sends the array form. If you are reading raw API results elsewhere, use status[] rather than status, the same way payment_method needs it.",
    kind: "shape",
  },
  {
    id: "estimate-work-status-filter-vocabulary",
    tags: ["estimate", "work_status", "filter", "vocabulary", "empty"],
    what:
      "The /estimates work_status filter does not accept the values /estimates returns. Filtering on 'complete rated' or 'pro canceled' - both values the API itself reports - matches nothing at all.",
    handling:
      "Do not filter estimates by the work_status you read back; you will get a confident empty list. Filter client-side on the returned value instead. This is the same input-versus-output split as jobs, and it is worse here because no input vocabulary is documented.",
    kind: "silent",
  },
  {
    id: "pipeline-empty-until-configured",
    tags: ["pipeline", "status", "stage", "kanban", "empty", "workflow"],
    what:
      "The /pipeline/statuses routes are real, but an account that has never set up pipeline stages in Housecall Pro answers 200 with an empty statuses list for job, lead and estimate alike. The empty answer is not a permissions problem, a wrong parameter or an outage - the resource_type parameter is validated properly and returns a named error when it is wrong, so an empty list means the account simply has no stages. Moving a record needs a status_id, and there are none to move it to until stages exist.",
    handling:
      "Read an empty statuses list as 'this account has not configured a pipeline', and say that. Do not report the pipeline as unavailable, the call as failed, or the records as having no stage - those are three different claims and only the first is true. One account having no stages says nothing about another.",
    kind: "shape",
  },
  {
    id: "expand-only-attachments",
    tags: ["expand", "attachments", "equipment", "line items", "invoices", "nested"],
    what:
      "expand[] is real but almost empty. Across jobs, customers, invoices and estimates the only value that adds anything is attachments on jobs and customers. equipment, invoices, line_items, checklists, items, options and notes are all accepted and ignored.",
    handling:
      "An unsupported expand value returns 200 with the payload unchanged, so a status code proves nothing - compare the keys before and after. Fetch nested data through its own route instead.",
    kind: "silent",
  },
  {
    id: "money-is-cents",
    tags: ["money", "cents", "dollars", "price", "amount", "total", "currency"],
    what: "Money is integer cents, so $250 arrives and must be sent as 25000.",
    handling:
      "This server converts in both directions and names converted fields *_dollars. $250 stays $250 and never arrives as $2.50.",
    kind: "shape",
  },
  {
    id: "patch-jobs-silent-200",
    tags: ["patch", "job", "update", "schedule", "description", "tags", "silent", "200"],
    what:
      "PATCH /jobs answers 200 and changes nothing when sent a flat schedule key, a description, or tags.",
    handling:
      "Send only the nested schedule object the API honours. For a description, write line items instead - see job-description-derived. For tags, use hcp_add_job_tag.",
    kind: "silent",
  },
  {
    id: "job-description-derived",
    tags: ["description", "job", "line items", "update"],
    what:
      "A job's description is derived from its line items and cannot be set directly.",
    handling:
      "There is no description field to write. Add or update line items with hcp_add_job_line_items or hcp_update_job_line_items and the description follows.",
    kind: "silent",
  },
  {
    id: "invoice-date-filters-are-name-specific",
    tags: [
      "invoice",
      "date",
      "filter",
      "since",
      "until",
      "range",
      "created_at",
      "service_date",
      "paid_at",
    ],
    what:
      "Invoices filter server-side on created_at, due_at, paid_at and amount_due, in *_min and *_max form. There is no filter for service_date or invoice_date, and passing one of those is accepted and ignored rather than refused.",
    handling:
      "Use created_at_min/max, due_at_min/max or paid_at_min/max when one of those is the date you mean. A service-date window has to be walked client-side, which is what this server does.",
    kind: "silent",
  },
  {
    id: "ignored-filter-may-be-a-wrong-name",
    tags: ["filter", "ignored", "parameter", "query", "documented", "name"],
    what:
      "An unrecognised query parameter is accepted and ignored rather than refused, so a filter that does nothing looks identical to a filter the API does not support.",
    handling:
      "Before concluding an endpoint cannot filter, check the parameter name against the published documentation for that endpoint. The names differ per endpoint: invoices take created_at_min, jobs take scheduled_start_min, and neither accepts the other's. Through this server that hazard is closed off at the door - see unknown-parameter-refused - but it is live on any request made outside it.",
    kind: "silent",
  },
  {
    id: "unknown-parameter-refused",
    tags: [
      "parameter",
      "argument",
      "unknown",
      "unrecognised",
      "invented",
      "filter",
      "refused",
      "typo",
      "name",
      "schema",
      "widening",
    ],
    what:
      "A parameter a tool does not define is refused here before anything is sent, naming what was not recognised, the closest parameter that exists, and every parameter the tool takes. Housecall Pro itself does the opposite: it drops an unrecognised query parameter and answers as though it had never been asked for.",
    handling:
      "Read the refusal and re-send with the name it gives; nothing was sent, so nothing was charged and nothing changed. The refusal exists because the alternative is worse than an error: a filter name that does not exist becomes NO filter, and the answer is the whole account wearing the shape of the narrow question - a job history read as a day's work, an aging list read as a segment, a campaign audience far wider than intended. Never widen a call by guessing a parameter name, and never read a large result as confirmation that a filter applied.",
    kind: "silent",
  },
  {
    id: "job-notes-ride-the-job-record",
    tags: [
      "notes",
      "note",
      "job",
      "401",
      "permissions",
      "unauthorized",
      "key",
      "read-only",
      "full access",
      "history",
      "what happened",
    ],
    what:
      "The job-notes route is refused to every kind of Housecall Pro API key. Read-only and full access are both answered with the same permissions message, so no key opens it and generating a wider one changes nothing. The notes themselves are not out of reach: the job record carries them inline.",
    handling:
      "Call hcp_get_job for that job and read its notes rather than the notes route, and do not send anyone to make a new key for this. Adding a note still works normally. If the notes are empty and you are after what happened on the visit, the job's line items say what was done and sold, and the job's attachments (include_attachments) hold the photos.",
    kind: "shape",
  },
  {
    id: "sort-by-updated-at-enables-change-detection",
    tags: ["sort", "sort_by", "updated_at", "changed", "since", "incremental", "sync"],
    what:
      "Customers, jobs and estimates accept sort_by=updated_at with sort_direction, and the ordering is honoured and stays continuous across pages. Invoices carry no updated_at field at all. An unknown sort field is refused rather than ignored.",
    handling:
      "To find what changed without re-reading everything, walk newest-first and stop at the first record older than your last read. Invoices cannot be walked that way; use created_at_min for new ones and paid_at_min for newly settled ones.",
    kind: "shape",
  },
  {
    id: "work-status-vocabulary",
    tags: ["work_status", "status", "completed", "filter", "vocabulary"],
    what:
      "work_status reads back in a different vocabulary than it is written - for example 'complete unrated' rather than 'completed'.",
    handling:
      "This server normalises on read and exposes work_status_bucket alongside the raw value. Filter on the bucket, not on a guessed literal, or a filter matches nothing.",
    kind: "shape",
  },
  {
    id: "deleted-jobs-in-lists",
    tags: ["deleted", "deleted_at", "job", "list", "revenue", "totals"],
    what:
      "Deleted jobs still appear in list responses and still count toward returned totals.",
    handling:
      "This server surfaces deleted_at on every row and warns. Filter deleted rows out before reporting revenue, or the figure is overstated.",
    kind: "shape",
  },
  {
    id: "tag-removal-unconfirmable",
    tags: ["tag", "remove", "delete", "job"],
    what:
      "Removing a tag from a job answers with an empty success whether or not the tag was there.",
    handling:
      "The result is reported as accepted rather than as a confirmed removal. Read the job back if it matters.",
    kind: "silent",
  },
  {
    id: "archived-job-appointments",
    tags: ["archived", "job", "appointment", "400"],
    what:
      "An archived job answers a 400 rather than an empty result when asked to describe its appointments.",
    handling:
      "This server flags the job as archived and returns an empty list, so a sweep over many jobs never stops part way.",
    kind: "shape",
  },
  {
    id: "invoice-document-is-html",
    tags: ["invoice", "document", "pdf", "html", "preview"],
    what:
      "The invoice document is a very long rendered HTML page, not a PDF. Even a short one runs past 200,000 characters.",
    handling:
      "This server returns the opening of the page and says how much of it that was. Do not expect a PDF or a complete document.",
    kind: "shape",
  },
  {
    id: "put-only-routes",
    tags: ["put", "post", "404", "method", "dispatch", "bulk"],
    what:
      "Some routes answer only on PUT, and a POST to the same path returns an HTML 404 page - which reads as 'no such route' rather than as the wrong method.",
    handling:
      "This server uses the method each route actually takes. A 404 from Housecall Pro is not proof a route is absent; it may be the wrong verb.",
    kind: "shape",
  },
  {
    id: "quantities-in-hundredths",
    tags: ["quantity", "qty", "hundredths", "line item"],
    what:
      "Line-item quantities arrive in hundredths on the invoice detail record: 100 means one.",
    handling: "This server divides on read and reports a plain quantity.",
    kind: "shape",
  },
  {
    id: "tax-rates-in-thousandths",
    tags: ["tax", "rate", "percent", "thousandths"],
    what:
      "Tax rates arrive in thousandths of a percent: 8750 means 8.75%.",
    handling: "This server converts and reports rate_percent.",
    kind: "shape",
  },
  {
    id: "arrival-window-fixed-set",
    tags: ["arrival", "window", "appointment", "schedule", "booking"],
    what:
      "Housecall Pro accepts an arrival window only from a fixed set - 0, 15, 20, 60, 120, 180 or 240 minutes - and rejects anything else outright.",
    handling:
      "This server offers the set as a constrained choice rather than a free number, so an unacceptable value cannot be sent.",
    kind: "shape",
  },
  {
    id: "tags-identified-by-id",
    tags: ["tag", "name", "id", "resolve"],
    what: "Tags attach to a job by id, never by name.",
    handling:
      "This server resolves a name against the account's tags before writing, and says so when the search was incomplete rather than claiming the tag does not exist.",
    kind: "shape",
  },
  {
    id: "attachments-need-expand",
    tags: ["attachment", "file", "upload", "download", "photo", "document", "expand", "url"],
    what:
      "Attachments have no route of their own - a GET on a job's attachments path serves an HTML 404 - but they are readable by asking for them. expand[]=attachments on a job, on the job list, or on a customer returns each file's id, name, type and a signed download link.",
    handling:
      "Ask with expand rather than concluding attachments are unreachable. The download link is minted per request and a re-listed attachment carries a different one, so fetch it when you get it and never store it.",
    kind: "shape",
  },
  {
    id: "expand-is-swallowed-when-unsupported",
    tags: ["expand", "nested", "related", "swallowed", "attachments", "appointments"],
    what:
      "expand[] takes attachments on jobs and customers, and appointments on jobs. An expand value the endpoint does not support is accepted and ignored rather than refused, exactly like an unsupported filter.",
    handling:
      "Check that the data actually came back rather than trusting the request was accepted. A quiet 200 means nothing was expanded.",
    kind: "silent",
  },
  {
    id: "read-only-keys-can-still-write-the-price-book",
    tags: ["read-only", "key", "permissions", "price book", "pricebook", "material", "category", "safety"],
    what:
      "A key generated as read-only refuses writes across the account, except under /api/price_book/. Measured: a read-only key created a price-book material category and deleted it again, both answering 200, while the same key was correctly refused on a job note.",
    handling:
      "Do not treat a read-only key as a guarantee that nothing can change. It is close to one everywhere else, and not one here. This server's --read-only flag is the stronger guarantee, because it does not register a write tool at all.",
    kind: "shape",
  },
  {
    id: "material-categories-nest-and-list-roots-only",
    tags: ["pricebook", "price book", "material", "category", "materials", "nesting", "parent_uuid", "coverage"],
    what:
      "GET /api/price_book/material_categories returns only the ROOT categories, and its total_count counts only them. Categories nest via parent_uuid (children come back when the request passes parent_uuid=<uuid>), and on a real book the materials sit almost entirely in the child categories, not the roots.",
    handling:
      "Never enumerate a book from the plain category list - a per-root materials pull reads a large book as nearly empty and the response gives no hint anything is missing. Walk the tree (hcp_search_pricebook whole_tree=true does it in one call), then pull materials per category at every depth.",
    kind: "shape",
  },
  {
    id: "active-job-detection",
    tags: [
      "in progress",
      "active",
      "right now",
      "working",
      "on site",
      "today",
      "on_my_way_at",
      "started_at",
      "route",
      "dispatch",
      "technician",
      "employee",
      "timezone",
      "utc",
      "offset",
    ],
    what:
      "The 'in progress' work status is rarely maintained on a real account - technicians move between jobs faster than anyone updates a status - so filtering jobs by it can return nothing at all on a busy day, which reads as 'nobody is working' rather than 'this field is not kept'. Route listings are empty too on an account that does not build routes, which many do not.",
    handling:
      "To find who is working now, list today's scheduled jobs and read on_my_way_at and started_at on the rows - a job with either set and no completed_at is being worked - then confirm the technician against the row's employees, or pass hcp_list_jobs an employee to narrow the page to one person. Bound the day in your own local offset (2026-08-13T00:00:00-04:00, not a bare UTC midnight): a UTC window against a business in a local timezone shifts the day, dropping an evening job out of 'today' and pulling in a late one from the day before. Never infer whose job it is from a single scheduled row - one row on the list is not evidence it is the right technician's.",
    kind: "shape",
  },
  {
    id: "equipment-not-on-public-api",
    tags: [
      "equipment",
      "property profile",
      "custom field",
      "unit",
      "serial",
      "model",
      "installed",
      "hvac",
      "boiler",
      "furnace",
      "water heater",
      "missing",
    ],
    what:
      "Equipment records and property-profile data are not reachable through this API. Searching for a route that reads them finds nothing however the query is phrased, so an empty result here is the surface, not an absent unit.",
    handling:
      "Stop looking for an equipment route and take one of the paths that work: a nameplate photo on the job's attachments (list the job with include_attachments; the download URL is a working link to the plate); a serial or model written into the job's notes or line items; or asking the customer. If none of those has it, say the unit's identity is not on this surface and name where it is - the equipment record in the Housecall Pro dashboard - rather than reporting an empty search as an absent unit.",
    kind: "shape",
  },
  {
    id: "calls-and-messages-not-on-public-api",
    tags: [
      "call",
      "recording",
      "transcript",
      "transcription",
      "voicemail",
      "phone",
      "voice",
      "sms",
      "text",
      "message",
      "conversation",
      "chat",
      "email",
      "communication",
      "activity",
      "history",
    ],
    what:
      "Phone calls, call recordings and transcriptions, texts, emails and the customer conversation thread are not on this API. Every route that would hold them - calls, voice, communications, conversations, messages, activities - answers with an HTML 404, which is routing refusing a path that does not exist rather than a key being too narrow, so no key reaches them. Attachments are files on a job or customer and a recording is not filed as one, so an empty attachment list is not evidence the call was never made.",
    handling:
      "Answer in one step rather than searching. Say plainly that Housecall Pro does not expose call recordings or transcripts on the public API, and name where the record does live: the customer's activity feed and the Voice section in the Housecall Pro dashboard. What IS readable and usually carries the same content is the job's own paperwork - the office notes on the job record (often a verbatim intake answer, e.g. \"Are you currently experiencing any issues?\"), lead_source on the job row for the channel it came in through, and the job's line items. Reach for those instead of checking attachments on the job, then the customer, then the leads list, which is three calls to reach the same no.",
    kind: "shape",
  },
  {
    id: "estimate-and-invoice-views-not-on-public-api",
    tags: [
      "viewed",
      "view",
      "opened",
      "read",
      "seen",
      "clicked",
      "click",
      "engagement",
      "receipt",
      "delivered",
      "delivery",
      "sent",
      "tracking",
      "followup",
      "follow up",
      "ignored",
      "activity",
      "feed",
    ],
    what:
      "Whether a customer opened or clicked an estimate or invoice IS tracked by Housecall Pro, but not on this API. The record lives on the activity feed, where a notification row carries a receipt list reading 'sent', 'delivered', 'link clicked (N)' and 'opened (N)' with timestamps and counts. That feed answers 401 to every key whatever its scope, so no key reaches it and an empty search is the surface refusing, not an unopened estimate. hcp_list_events and hcp_get_event are deliveries of YOUR webhook subscriptions and carry no customer view data - the word 'event' on this API never means the activity feed.",
    handling:
      "Answer in one step rather than searching. Say plainly that open and click tracking is not on the public API, and name where it is: the activity feed on the estimate or invoice in the Housecall Pro dashboard, which lists sent, delivered, link clicked and opened with times. What IS readable here is whether they ACTED - approval_status on each estimate option (see estimate-answer-confirm-by-status) and the invoice status. Never read an unanswered estimate as an unopened one: approval_status says nothing about viewing, and 'they have not looked at it yet' inferred from silence there is a confident wrong answer about a customer who may have opened it twice. ★ The same trap catches anyone reading the activity feed through a customer-scoped view rather than the estimate's own: that view returns only the newest handful of rows and does not page, and sending a multi-option estimate writes a row per option for create, schedule, dispatch and complete - roughly nine rows for three options - so the send receipt is pushed out of the window by the estimate's own paperwork. Finding no 'link clicked' row there means it is not in that window, never that it was not clicked. Absence is only evidence on the estimate's own feed.",
    kind: "shape",
  },
  {
    id: "job-fields-beyond-job-type-not-on-public-api",
    tags: [
      "callback",
      "callbacks",
      "business unit",
      "business_unit",
      "job field",
      "job fields",
      "rework",
      "return visit",
      "warranty",
      "segment",
      "division",
    ],
    what:
      "Job Type is the only Job Field this API exposes. Callback and Business Unit are first-class Job Fields in Housecall Pro - they sit beside Job Type on the job, drive callback-rate and per-unit reporting, and are configured in the dashboard - but neither appears on the job record and neither has a route in any spelling: /job_fields/job_types returns 200 while /job_fields/business_units, /job_fields/callbacks, /job_fields/callback and bare /job_fields are all HTML 404. Ticking Callback on a job adds no key to its API record; a control experiment that set Job Type and Callback on the same job saw only job_type appear, which rules out 'the write never saved' as the explanation.",
    handling:
      "Do not offer callback tracking or business-unit segmentation from this API and do not build a filter on them - ?callback=true, ?callback[]=true and ?is_callback=true are accepted and ignored, returning the whole unfiltered list, which reads as a confident 'no callbacks found' (see ignored-filter-may-be-a-wrong-name). hcp_export_csv will not rescue it either: that export is built from these same job records, so the column is absent there too. Say the field is not on this surface and name where it is - the job's Job Fields section in the dashboard, and the dashboard's own job export, whose Callback column does carry it. If a pro needs callbacks visible to the API, a tag on the job is the usual workaround; ask before assuming one is already in use.",
    kind: "shape",
  },
  {
    id: "job-times-are-utc",
    tags: [
      "timezone",
      "time zone",
      "utc",
      "local",
      "offset",
      "scheduled_start",
      "scheduled_end",
      "time",
      "appointment",
      "morning",
      "afternoon",
    ],
    what:
      "Every timestamp Housecall Pro returns is UTC with a Z suffix, and a shop reads its day in local time. A job at 16:00Z is noon to an Eastern office; read out as-is it becomes four o'clock, which names a time nobody is working and can move a job to the wrong half of the day.",
    handling:
      "Job rows from hcp_list_jobs carry scheduled_start_local and scheduled_end_local already rendered in the account's zone, and hcp_get_job carries the same under schedule_local - quote those to a person and compute on the UTC fields. For any other timestamp, read the account's zone from hcp_get_company (time_zone) and convert before saying it aloud. The same fault line runs the other way on input: bound a day window with your own local offset, not a bare UTC midnight - topic \"active-job-detection\" has it.",
    kind: "shape",
  },
  {
    id: "key-access-fixed-at-creation",
    tags: ["401", "permissions", "key", "access", "read-only", "auth", "404", "unauthorized"],
    what:
      "A 401 naming permissions means the key is real but too narrow, and its access level was fixed when it was generated and cannot be widened. Any other refusal - a bare 401 Unauthorized on a correct key, or an HTML 404 page - means what you asked for is not part of the public API, and no key changes that.",
    handling:
      "Only the permissions message is worth a new key, and it names no scope to request, so a full-access key generated fresh is the only lever. Anything else is out of reach however privileged the key - treat it as a limit of the public API, not a key problem.",
    kind: "shape",
  },
  {
    id: "estimate-answer-confirm-by-status",
    tags: [
      "estimate",
      "option",
      "approve",
      "decline",
      "approval_status",
      "answer",
      "recorded",
      "confirm",
      "status",
      "silent",
      "200",
    ],
    what:
      "Approving or declining an estimate option answers 200 without echoing the option's new state, so the 2xx alone is not evidence the answer was recorded.",
    handling:
      "Read the option's approval_status back with hcp_list_estimates - it reads \"pro approved\" or \"pro declined\" once the answer landed - before reporting it recorded.",
    kind: "silent",
  },
  {
    id: "estimate-schedule-confirm-by-status",
    tags: [
      "estimate",
      "option",
      "schedule",
      "book",
      "visit",
      "work_status",
      "scheduled",
      "confirm",
      "silent",
      "200",
    ],
    what:
      "Scheduling an estimate option answers 200 without echoing the schedule, so the 2xx alone is not evidence the visit was booked.",
    handling:
      "Re-read the estimate's work_status with hcp_list_estimates and confirm it moved to scheduled before reporting the visit as booked.",
    kind: "silent",
  },
  {
    id: "job-has-no-invoice-yet",
    tags: [
      "invoice",
      "job",
      "empty",
      "none",
      "not invoiced",
      "billing",
      "billed",
    ],
    what:
      "A job with no invoice returns an empty list on its invoices route. An invoice exists only once the job has been invoiced in Housecall Pro, so a worked-but-not-invoiced job has none - and there is no route to create one - rather than the job id being wrong.",
    handling:
      "Read an empty result as \"not invoiced yet\", not as a bad id. hcp_list_invoices finds invoices across the account when you need to reach one another way.",
    kind: "shape",
  },
  // ---- the paid equipment tools (the hcpapi API, not Housecall Pro) ----
];

export interface PhantomRoute {
  /** The route as the published documentation describes it. */
  documented: string;
  /** What is actually there. */
  reality: string;
  tags: string[];
}

/**
 * Routes the published documentation describes that are not there. An
 * integration built from the docs alone ships a broken code path for each one,
 * and an agent that has not been told will keep retrying them.
 */
export const PHANTOM_ROUTES: PhantomRoute[] = [
  {
    documented: "POST, PUT, DELETE /appointments",
    reality: "Absent. Appointments exist only nested under a job.",
    tags: ["appointment", "schedule", "booking"],
  },
  {
    documented: "PUT /jobs/{id}",
    reality: "Absent. PATCH /jobs honours only the nested schedule object.",
    tags: ["job", "update", "put", "patch"],
  },
  {
    documented: "POST /invoices",
    reality: "Absent. An invoice cannot be created through the API.",
    tags: ["invoice", "create"],
  },
  {
    documented: "DELETE /customers/{id}",
    reality: "Absent. There is no public customer delete.",
    tags: ["customer", "delete"],
  },
  {
    documented: "PUT or DELETE /customers/{id}/addresses/{adr}",
    reality: "Absent. Addresses are append-only.",
    tags: ["customer", "address", "delete", "update"],
  },
  {
    documented: "PUT or DELETE /estimates/{id} and /estimates/{id}/options/{opt}",
    reality: "Absent. An estimate and its options cannot be updated or deleted.",
    tags: ["estimate", "option", "update", "delete"],
  },
  {
    documented: "PUT or DELETE /leads/{id}",
    reality:
      "Absent as writes - a lead cannot be updated or deleted. Reading them is fine: GET /leads lists them and GET /leads/{id} returns one, as does GET /leads/{id}/line_items.",
    tags: ["lead", "update", "delete", "read", "list"],
  },
  {
    documented: "DELETE /tags/{id}",
    reality: "Absent. A tag can never be deleted through the API.",
    tags: ["tag", "delete"],
  },
  {
    documented: "DELETE /jobs/{id}/tags",
    reality: "Absent.",
    tags: ["job", "tag", "delete"],
  },
  {
    documented: "PUT /jobs/{id}/lock",
    reality:
      "The PUT verb is absent, but the route is not: POST /jobs/{id}/lock locks a single job. The bulk POST /jobs/lock also exists and keys on starting_at rather than a list of job ids.",
    tags: ["job", "lock", "put", "post"],
  },
  {
    documented: "POST /api/price_book/services",
    reality: "Absent. Materials and categories create normally; services do not.",
    tags: ["pricebook", "service", "create", "material"],
  },
  {
    documented: "GET /webhooks/subscription",
    reality: "Absent.",
    tags: ["webhook", "subscription"],
  },
  {
    documented: "GET /employees/{id}",
    reality:
      "Absent. There is no employee detail route - an id that GET /employees returned a moment earlier serves an HTML 404. Read the row from the listing, which already carries the whole record.",
    tags: ["employee", "technician", "detail", "get"],
  },
];

/**
 * The instructions string handed to the client at connect time. Kept short on
 * purpose: it is paid for on every session whether it is used or not, so it
 * carries the rule that prevents wrong answers and a pointer to the detail
 * rather than the detail itself.
 */
export const SERVER_INSTRUCTIONS = [
  "This server talks to the Housecall Pro public API for a real service business. Its records are live.",
  "",
  `CRITICAL: ${CORE_RULE}`,
  "",
  "The published Housecall Pro documentation is wrong in places this server knows about:",
  `${PHANTOM_ROUTES.length} documented routes do not exist, and several writes are accepted with no effect.`,
  "So: never report that something cannot be done until you have called hcp_api_notes with the topic you",
  "are working on. It answers from a table of verified API behaviour and says whether the route is absent,",
  "the verb is wrong, the write is silently ignored, or what you want is reachable another way. A refusal,",
  "a 404 and an empty result are none of them proof that a thing is impossible.",
  "Refusals from this server name the topic that covers them and the path that does work - read one as the",
  "next call rather than as a wall.",
  "",
  "A parameter a tool does not define is refused before anything is sent, with the closest real name. Do not",
  "invent parameter names: unrecognised ones are dropped upstream, and a filter that never applied answers",
  "with the whole account.",
  "",
  "Money is integer cents in the API; this server converts and names converted fields *_dollars.",
  "Deleted jobs remain in list responses and count toward totals - filter on deleted_at before reporting revenue.",
].join("\n");

/** Markdown rendering of the quirks table, for the resource and the tool. */
export function renderNotes(notes: ApiNote[] = API_NOTES): string {
  const lines = [
    "# Housecall Pro API behaviour notes",
    "",
    CORE_RULE,
    "",
  ];
  for (const n of notes) {
    lines.push(`## ${n.id}${n.kind === "silent" ? "  [SILENT FAILURE]" : ""}`);
    lines.push(`**What the API does:** ${n.what}`);
    lines.push(`**What to do:** ${n.handling}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Markdown rendering of the absent-routes table. */
export function renderPhantomRoutes(routes: PhantomRoute[] = PHANTOM_ROUTES): string {
  const lines = [
    "# Documented Housecall Pro routes that do not exist",
    "",
    "The published documentation describes each of these. They are not there.",
    "A 404 on one of them is the route being absent, not a bad request.",
    "",
  ];
  for (const r of routes) {
    lines.push(`- \`${r.documented}\` - ${r.reality}`);
  }
  return lines.join("\n");
}

/**
 * Find the notes and absent routes relevant to a topic. Matching is deliberately
 * generous: a caller asking about "invoice pdf" should be told the document is
 * HTML even though neither word is the note's id. An empty query returns
 * everything, because the whole table is small enough to read.
 */
export function searchApiNotes(query: string): {
  notes: ApiNote[];
  phantom_routes: PhantomRoute[];
} {
  const q = query.trim().toLowerCase();
  if (!q) return { notes: API_NOTES, phantom_routes: PHANTOM_ROUTES };

  // Split on anything that is not a word character so "PATCH /jobs" and
  // "patch, jobs" behave the same.
  const terms = q.split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
  const hay = (parts: string[]) => parts.join(" ").toLowerCase();

  const scoreNote = (n: ApiNote) => {
    const text = hay([n.id, ...n.tags, n.what, n.handling]);
    return terms.filter((t) => text.includes(t)).length;
  };
  const scoreRoute = (r: PhantomRoute) => {
    const text = hay([r.documented, r.reality, ...r.tags]);
    return terms.filter((t) => text.includes(t)).length;
  };

  const notes = API_NOTES.map((n) => ({ n, s: scoreNote(n) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.n);
  const phantom_routes = PHANTOM_ROUTES.map((r) => ({ r, s: scoreRoute(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);

  return { notes, phantom_routes };
}
