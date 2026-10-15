/**
 * Which toolset each tool belongs to, and how it behaves.
 *
 * Two problems are solved by one table. First, 54 tools is more than a client
 * should be asked to hold in context at once - every published guideline puts
 * the useful number far lower, and tool-selection accuracy falls as the list
 * grows. `--toolsets` lets an install expose only the groups it needs. Second,
 * a client cannot currently tell `hcp_get_company` from
 * `hcp_delete_job_appointment`, because this server ships no tool annotations.
 * The spec defines hints for exactly that, and clients use them to decide when
 * to ask a human first.
 *
 * Keeping both in one table rather than spread across 54 registration sites
 * means the classification is reviewable in one screen, and the hygiene check
 * can assert that no tool is missing from it.
 */

export const TOOLSETS = [
  "company",
  "customers",
  "jobs",
  "estimates",
  "invoices",
  "pricebook",
  "schedule",
  "reports",
  "admin",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/**
 * Groups a fresh install gets when nothing is specified. `admin` is held back
 * deliberately: it is tag, job-type and price-book structure maintenance, which
 * a reporting or booking session never needs, and leaving it out of the default
 * keeps the starting surface smaller. Turn it on with
 * `--toolsets=default,admin` or name the groups explicitly.
 *
 * The line admin is drawn on is maintenance, not subject matter: LISTING tags
 * and job types is how ordinary job data gets interpreted (a job row carries
 * tag names; resolving one to an id needs the registry), so those reads live in
 * `company` with the other account lookups. Only the writes that reshape the
 * registries stay behind the admin switch.
 */
export const DEFAULT_TOOLSETS: Toolset[] = [
  "company",
  "customers",
  "jobs",
  "estimates",
  "invoices",
  "pricebook",
  "schedule",
  "reports",
];

export interface ToolSpec {
  toolset: Toolset;
  /** True when the tool changes data in Housecall Pro. */
  write?: boolean;
  /**
   * True when the change removes or overwrites rather than adds. Deletes
   * qualify; so does anything that replaces a set wholesale.
   */
  destructive?: boolean;
  /** True when calling twice with the same arguments lands the same state. */
  idempotent?: boolean;
  /**
   * True when the effect reaches the customer - a text, an email, or a
   * notification. This is not a spec field; it is surfaced in the tool
   * annotations' title so a client's confirmation prompt can say so.
   */
  customerVisible?: boolean;
}

/**
 * Every tool this server registers. A name missing here fails the hygiene
 * check rather than registering unclassified, because an unclassified tool
 * would silently be treated as a read.
 */
export const TOOL_SPECS: Record<string, ToolSpec> = {
  /* ---- company ---- */
  hcp_get_company: { toolset: "company" },
  hcp_list_employees: { toolset: "company" },
  hcp_get_defaults: { toolset: "company" },
  hcp_set_defaults: { toolset: "company", write: true, idempotent: true },
  hcp_get_business_profile: { toolset: "company" },
  hcp_set_business_profile: { toolset: "company", write: true, idempotent: true },
  // Registry READS live here, not in admin: a job row carries tag names, and
  // resolving a name to an id needs the registry, so a default install must be
  // able to list them. The create/rename writes stay behind the admin switch.
  hcp_list_tags: { toolset: "company" },
  hcp_list_job_types: { toolset: "company" },

  /* ---- schedule ---- */
  hcp_get_schedule_availability: { toolset: "schedule" },
  hcp_list_booking_windows: { toolset: "schedule" },
  hcp_list_events: { toolset: "schedule" },
  hcp_get_event: { toolset: "schedule" },
  // Sets the estimate's schedule and dispatches. notify defaults false, but
  // Housecall Pro's own reminders can still reach the customer nearer the date.
  hcp_schedule_estimate_option: {
    toolset: "estimates",
    write: true,
    idempotent: true,
    customerVisible: true,
  },
  hcp_list_routes: { toolset: "schedule" },
  hcp_list_service_zones: { toolset: "schedule" },
  hcp_list_job_appointments: { toolset: "schedule" },
  hcp_schedule_job_appointment: { toolset: "schedule", write: true },
  hcp_update_job_appointment: { toolset: "schedule", write: true, idempotent: true },
  hcp_delete_job_appointment: {
    toolset: "schedule",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_unschedule_job: { toolset: "schedule", write: true, destructive: true, idempotent: true },
  // Dispatch is the on-my-way trigger, so it reaches the customer.
  hcp_dispatch_job: { toolset: "schedule", write: true, customerVisible: true },

  /* ---- customers ---- */
  hcp_search_customers: { toolset: "customers" },
  hcp_get_customer: { toolset: "customers" },
  hcp_contactability: { toolset: "customers" },
  hcp_create_customer: { toolset: "customers", write: true },
  hcp_update_customer: { toolset: "customers", write: true, idempotent: true },
  hcp_create_customer_address: { toolset: "customers", write: true },
  hcp_create_lead: { toolset: "customers", write: true },
  hcp_list_lead_sources: { toolset: "customers" },
  hcp_list_leads: { toolset: "customers" },
  hcp_get_lead: { toolset: "customers" },
  hcp_get_customer_address: { toolset: "customers" },
  // Creates an estimate or a job from the lead; the lead itself survives.
  hcp_convert_lead: { toolset: "customers", write: true },
  hcp_create_lead_source: { toolset: "admin", write: true },
  hcp_rename_lead_source: { toolset: "admin", write: true, idempotent: true },

  /* ---- jobs ---- */
  hcp_list_jobs: { toolset: "jobs" },
  hcp_get_job: { toolset: "jobs" },
  hcp_get_job_count: { toolset: "jobs" },
  hcp_get_job_notes: { toolset: "jobs" },
  hcp_list_checklists: { toolset: "jobs" },
  hcp_get_job_line_items: { toolset: "jobs" },
  hcp_get_job_input_materials: { toolset: "jobs" },
  hcp_list_pipeline_statuses: { toolset: "jobs" },
  hcp_delete_job_note: { toolset: "jobs", write: true, destructive: true, idempotent: true },
  // Not idempotent: calling twice attaches the file twice, and there is no
  // public route to remove either copy.
  hcp_upload_job_attachment: { toolset: "jobs", write: true },
  hcp_upload_estimate_option_attachment: { toolset: "estimates", write: true },
  hcp_add_job_link: { toolset: "jobs", write: true },
  hcp_add_estimate_option_link: { toolset: "estimates", write: true },
  // Locking has no counterpart on this API in any shape: no unlock route
  // exists, so both of these are one-way through every tool here.
  hcp_lock_job: { toolset: "admin", write: true, destructive: true, idempotent: true },
  hcp_lock_jobs_by_date: { toolset: "admin", write: true, destructive: true },
  hcp_get_application: { toolset: "admin" },
  hcp_set_application_enabled: {
    toolset: "admin",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_create_webhook_subscription: { toolset: "admin", write: true },
  hcp_delete_webhook_subscription: {
    toolset: "admin",
    write: true,
    destructive: true,
    idempotent: true,
  },
  // A whole-list replace, so anything omitted is dropped.
  hcp_update_job_input_materials: {
    toolset: "jobs",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_create_job: { toolset: "jobs", write: true },
  hcp_add_job_note: { toolset: "jobs", write: true },
  hcp_add_job_line_items: { toolset: "jobs", write: true },
  hcp_update_job_line_item: { toolset: "jobs", write: true, idempotent: true },
  // Replaces the set of line items wholesale, so a partial list overwrites.
  hcp_update_job_line_items: {
    toolset: "jobs",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_delete_job_line_item: {
    toolset: "jobs",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_add_job_tag: { toolset: "jobs", write: true, idempotent: true },
  hcp_remove_job_tag: { toolset: "jobs", write: true, destructive: true, idempotent: true },

  /* ---- estimates ---- */
  hcp_list_estimates: { toolset: "estimates" },
  hcp_get_estimate: { toolset: "estimates" },
  hcp_get_estimate_line_items: { toolset: "estimates" },
  hcp_create_estimate: { toolset: "estimates", write: true },
  hcp_add_estimate_option: { toolset: "estimates", write: true },
  // A whole-list replace on the option's line items.
  hcp_update_estimate_option_line_items: {
    toolset: "estimates",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_add_estimate_option_note: { toolset: "estimates", write: true },
  hcp_delete_estimate_option_note: {
    toolset: "estimates",
    write: true,
    destructive: true,
    idempotent: true,
  },
  // Recording a customer's answer on an estimate is likely to notify them.
  hcp_approve_estimate_options: {
    toolset: "estimates",
    write: true,
    idempotent: true,
    customerVisible: true,
  },
  hcp_decline_estimate_options: {
    toolset: "estimates",
    write: true,
    idempotent: true,
    customerVisible: true,
  },

  /* ---- invoices ---- */
  hcp_list_invoices: { toolset: "invoices" },
  hcp_get_invoice: { toolset: "invoices" },
  hcp_get_job_invoices: { toolset: "invoices" },
  hcp_get_invoice_document: { toolset: "invoices" },

  /* ---- pricebook ---- */
  hcp_search_pricebook: { toolset: "pricebook" },
  hcp_list_price_forms: { toolset: "pricebook" },
  hcp_create_price_form: { toolset: "pricebook", write: true },
  hcp_update_price_form: { toolset: "pricebook", write: true, idempotent: true },
  hcp_delete_price_form: {
    toolset: "pricebook",
    write: true,
    destructive: true,
    idempotent: true,
  },
  hcp_update_pricebook_material_category: {
    toolset: "pricebook",
    write: true,
    idempotent: true,
  },
  hcp_create_pricebook_material: { toolset: "pricebook", write: true },
  hcp_update_pricebook_material: { toolset: "pricebook", write: true, idempotent: true },
  hcp_delete_pricebook_material: {
    toolset: "pricebook",
    write: true,
    destructive: true,
    idempotent: true,
  },

  /* ---- reports ---- */
  hcp_revenue_summary: { toolset: "reports" },
  // Pure presentation: turns a findings contract into a self-contained HTML
  // report. No HCP call, so read-only.
  hcp_render_report: { toolset: "reports" },
  hcp_export_csv: { toolset: "reports" },
  hcp_api_notes: { toolset: "reports" },

  /* ---- admin ---- */
  hcp_create_tag: { toolset: "admin", write: true },
  hcp_rename_tag: { toolset: "admin", write: true, idempotent: true },
  hcp_create_job_type: { toolset: "admin", write: true },
  hcp_rename_job_type: { toolset: "admin", write: true, idempotent: true },
  hcp_create_pricebook_material_category: { toolset: "admin", write: true },
  hcp_delete_pricebook_material_category: {
    toolset: "admin",
    write: true,
    destructive: true,
    idempotent: true,
  },
};

/**
 * The spec's tool annotations, derived from the table so the two can never
 * disagree. `openWorldHint` is true throughout: every tool here reaches an
 * external account whose contents this server does not control.
 */
export function annotationsFor(name: string, spec: ToolSpec) {
  const readOnly = !spec.write;
  return {
    // The title is what a client is most likely to show a human in a
    // confirmation prompt, so the customer-visible warning goes here where it
    // will actually be read.
    title: spec.customerVisible
      ? `${name} (may notify the customer)`
      : name,
    readOnlyHint: readOnly,
    // The spec's destructiveHint is only meaningful for a write.
    destructiveHint: readOnly ? false : spec.destructive === true,
    idempotentHint: readOnly ? true : spec.idempotent === true,
    openWorldHint: true,
  };
}

export interface SurfaceOptions {
  readOnly: boolean;
  toolsets: Toolset[];
  /**
   * True when the server was started without an HCP_API_KEY. Only the tools
   * that never call Housecall Pro register, so nothing can fail on a missing
   * key at call time.
   */
  keyless?: boolean;
}

/**
 * The tools that make no Housecall Pro request. These are what a keyless start
 * registers: the report renderer is pure presentation over findings the caller
 * already has, the API-notes tool reads a compiled table, and the business
 * profile is a local file - so a skill's first-run interview can run before
 * any API key exists.
 */
export const KEY_FREE_TOOLS: ReadonlySet<string> = new Set([
  "hcp_render_report",
  "hcp_api_notes",
  "hcp_get_business_profile",
  "hcp_set_business_profile",
]);

/**
 * Parse `--read-only`, `--toolsets=a,b` and their environment equivalents.
 * Command-line arguments win over the environment, because a client config
 * that sets both is most likely overriding a shell default on purpose.
 *
 * An unknown toolset name is a hard failure rather than a silent skip: quietly
 * exposing nothing because of a typo looks identical to the API being down.
 */
export function parseSurfaceOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): SurfaceOptions {
  const readOnly =
    argv.includes("--read-only") ||
    /^(1|true|yes)$/i.test(env.HCP_READ_ONLY ?? "");

  const flag = argv.find((a) => a.startsWith("--toolsets="));
  const raw = flag ? flag.slice("--toolsets=".length) : env.HCP_TOOLSETS;

  if (!raw || !raw.trim()) return { readOnly, toolsets: [...DEFAULT_TOOLSETS] };

  const requested = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const chosen = new Set<Toolset>();
  const unknown: string[] = [];
  for (const item of requested) {
    if (item === "all") {
      for (const t of TOOLSETS) chosen.add(t);
    } else if (item === "default") {
      for (const t of DEFAULT_TOOLSETS) chosen.add(t);
    } else if ((TOOLSETS as readonly string[]).includes(item)) {
      chosen.add(item as Toolset);
    } else {
      unknown.push(item);
    }
  }

  if (unknown.length) {
    throw new Error(
      `Unknown toolset(s): ${unknown.join(", ")}. ` +
        `Valid names are ${TOOLSETS.join(", ")}, plus "all" and "default".`,
    );
  }

  return { readOnly, toolsets: [...chosen] };
}

/** Whether a given tool should be registered under these options. */
export function shouldRegister(name: string, opts: SurfaceOptions): boolean {
  // Keyless registers exactly the key-free tools, whatever the other switches
  // say: the point of starting without a key is that the renderer and the
  // notes still work, and toolset filtering of a two-tool surface only makes
  // a misconfigured install look like a broken one.
  if (opts.keyless) return KEY_FREE_TOOLS.has(name);
  const spec = TOOL_SPECS[name];
  // An unclassified tool is a bug in this table, not a reason to hide the tool.
  // Register it as a read and let the hygiene check fail the build.
  if (!spec) return true;
  if (opts.readOnly && spec.write) return false;
  return opts.toolsets.includes(spec.toolset);
}
