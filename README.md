<!-- mcp-name: io.github.hcpapi/housecall-pro-mcp -->

# Housecall Pro MCP Server

An open-source MCP server for the [Housecall Pro](https://www.housecallpro.com)
API. Connect Claude, ChatGPT, Cursor, or any MCP-compatible AI agent to your
Housecall Pro account, so you can ask for what you need instead of clicking
through reports.

Independent project, not affiliated with, endorsed by, or sponsored by Housecall
Pro. We run a service company on Housecall Pro ourselves, which is why it exists.

## Install

Needs Node 18 or newer and a Housecall Pro API key. API access comes with the
MAX plan and is not available on lower tiers.

**Claude Desktop.** Open **Settings**, then **Developer**, then **Edit Config**,
and add:

```json
{
  "mcpServers": {
    "housecall-pro": {
      "command": "npx",
      "args": ["-y", "housecall-pro-mcp"],
      "env": { "HCP_API_KEY": "your-api-key-here" }
    }
  }
}
```

Restart Claude Desktop and the Housecall Pro tools will appear.

**Claude Code.** Add it directly:

```bash
claude mcp add housecall-pro -e HCP_API_KEY=your-api-key-here -- npx -y housecall-pro-mcp
```

Or install it as a plugin, which prompts for the key (stored in your keychain, never
in a config file) and exposes the read-only and toolset switches as install-time options:

```bash
/plugin marketplace add hcpapi/housecall-pro-mcp
/plugin install housecall-pro@hcpapi
```

**Cursor, Codex, and other MCP clients.** Any client that speaks MCP over stdio
works. Use `npx` as the command, `["-y", "housecall-pro-mcp"]` as the arguments,
and put `HCP_API_KEY` in the environment.

Getting a key takes about a minute and is described under
[Getting your Housecall Pro API key](#getting-your-housecall-pro-api-key).

## Housecall Pro API quirks, and what this server does about them

These are the edges of the Housecall Pro API itself. Each one is a place an
integration built from the documentation alone gets a wrong answer rather than
an error.

| What the API does | What this server does about it |
|---|---|
| Money is integer cents, so $250 is `25000`. | Converts in both directions. $250 stays $250 and never arrives as $2.50. |
| `PATCH /jobs` answers **200 and changes nothing** when sent a flat schedule key, a description, or tags. | Sends only the nested schedule object the API honours, so a reported success is a real one. |
| A job's description is derived from its line items and cannot be set directly. | Exposes line-item writes rather than a description field that would silently do nothing. |
| Invoices filter on `created_at`, `due_at`, `paid_at` and `amount_due`, but not on `service_date` or `invoice_date`. An unsupported filter name is accepted and ignored rather than refused. | Uses the names the endpoint actually takes, and walks a service-date window client-side because no server-side equivalent exists. |
| `work_status` reads back in a different vocabulary than it is written, for example `complete unrated` rather than `completed`. | Normalises on read, so a status filter matches real records instead of nothing. |
| Deleted jobs still appear in list responses and count toward totals. | Surfaces `deleted_at` on every row and warns, so revenue is not overstated. |
| Removing a tag from a job answers with an empty success whether or not the tag was there. | Reports the request as accepted rather than claiming a removal it cannot confirm. |
| An archived job refuses to describe its appointments. | Flags the job as archived and returns an empty list, so a sweep never stops part way. |
| The invoice document is a very long HTML page, not a PDF. | Returns the opening of the page and says how much of it that was. |
| Attachments have no route of their own — `GET` on a job's attachments path serves an HTML 404 — but `expand[]=attachments` returns them with a signed download link. | Asks with `expand` and hands back the files. The link is minted per request, so it is fetched when given and never stored. |
| Some routes answer only on `PUT`, and a `POST` to the same path returns an HTML 404 page, which reads as "no such route" rather than as the wrong method. | Uses the method each route actually takes, so dispatching a crew and bulk line-item updates work instead of looking absent. |

**Never trust a 2xx on a Housecall Pro write.** Read the record back. Several
routes answer 200 without changing anything, which is why the rows above exist.

## The `hcp` command line

The same package installs `hcp`, which reaches the same Housecall Pro surface
from a terminal. It is the same code — every command is one of the tools below,
with the same conversions, the same filters and the same refusals.

It exists because an MCP server only runs while an assistant is in the room.
A scheduled task that writes an aging report every Monday morning is not
something an MCP client can do.

```bash
npm install -g housecall-pro-mcp     # or run it once with: npx -p housecall-pro-mcp hcp
export HCP_API_KEY=your-api-key-here

hcp list jobs --work-status completed --page-size 20
hcp jobs list --page-size 20                    # the same command, read either way round
hcp get customer cus_1a2b3c
hcp search customers "smith"
hcp list invoices --csv > unpaid.csv
```

Windows, macOS and Linux, wherever Node 18+ runs.

**Output.** A table sized to your terminal by default, `--json` for the full
records, `--csv` for a spreadsheet or a scheduled export. Data goes to stdout and
commentary to stderr, so a redirect gets the data and nothing else.

**Before you change anything.** `--dry-run` prints exactly what a command would
send and sends nothing. `--read-only` refuses any command that could change your
account, and says which switch stopped it.

**Finding your way around.** `hcp` on its own lists the commands by group.
`hcp commands` prints them one per line, and `hcp commands --json` gives the
whole table, including which ones write. `hcp <command> --describe` prints that
command's parameters without running it.

```bash
hcp create customer --first-name Alex --last-name Rivera --dry-run
hcp list jobs --describe
```

Every switch below that applies to the server applies here too, including
`--toolsets`.

## Documented routes that do not exist

Housecall Pro's published documentation describes these. They are not there. An
integration built from the docs alone ships broken code paths for each one.

| Documented | Reality |
|---|---|
| `POST`, `PUT`, `DELETE /appointments` | Absent. Appointments exist only nested under a job. |
| `PUT /jobs/{id}` | Absent. `PATCH /jobs` honours only the nested schedule object. |
| `POST /invoices` | Absent. |
| `DELETE /customers/{id}` | Absent. There is no public customer delete. |
| `PUT` or `DELETE /customers/{id}/addresses/{adr}` | Absent. Addresses are append-only. |
| `PUT` or `DELETE /estimates/{id}` and `/estimates/{id}/options/{opt}` | Absent. |
| `PUT` or `DELETE /leads/{id}` | Absent as writes: a lead cannot be updated or deleted. Reading works — `GET /leads`, `GET /leads/{id}` and `GET /leads/{id}/line_items` are all live. |
| `DELETE /tags/{id}` | Absent. A tag can never be deleted through the API. |
| `DELETE /jobs/{id}/tags` | Absent. |
| `PUT /jobs/{id}/lock` | The verb is absent, not the route: `POST /jobs/{id}/lock` locks one job. The bulk `POST /jobs/lock` also exists and keys on `starting_at` rather than a list of job ids. |
| `POST /api/price_book/services` | Absent. Materials and categories create normally. |
| `GET /webhooks/subscription` | Absent. |
| `GET /employees/{id}` | Absent. There is no employee detail route — an id that `GET /employees` just returned serves an HTML 404. Read the row from the listing. |

## What you can ask

- "How much did we invoice in June, grouped by service?"
- "List this week's scheduled jobs with outstanding balances"
- "Pull up the customer record for the Smiths on Elm Street"
- "Which customers are tagged 'Service Plan'?"
- "Export Q2 invoices as CSV"
- "What's in our price book for water heaters?"
- "When is job_123 booked, and who is going?"
- "Show me invoice_123 the way the customer sees it"
- "Add a new customer: John Baker, 22 Elm St, Springfield IL, +1 555 123 4567"
- "Draft a good/better/best estimate for cus_123: water heater replacement at
  $2,400 / $3,100 / $3,900"
- "Book Tuesday 8-10am on job_123 for Mike"
- "Move that visit to Thursday morning and put Dave on it instead"
- "Dispatch Mike and Dave to job_123"
- "Reprice every labor line on job_123 in one go"
- "The customer went with the middle option on that estimate - mark it approved"
- "What hours do we work, and what's free next week?"
- "Default our jobs to 90 minutes with a two-hour arrival window"

## Getting your Housecall Pro API key

1. Sign in to Housecall Pro as an admin. Office staff logins cannot generate
   keys.
2. Open **My Apps**, the grid icon in the top bar
3. Click **Go to App store**, search for API, and open **API Key Management**.
   It will usually not be sitting in the My Apps menu already, because that
   menu lists a subset rather than the whole catalogue.
4. Click **Generate new API key**, name it, and choose its access level:
   - Read-only, for reporting, lookups and exports. It refuses writes across the
     account **with one exception we have measured**: the price-book routes under
     `/api/price_book/` are not covered by that gate, and a read-only key can
     create and delete price-book categories there. If you want a guarantee
     rather than nearly one, run this server with `--read-only`, which does not
     register a write tool at all.
   - Full access, which also allows creating customers, jobs and estimates.
5. Copy the key. Housecall Pro keeps it visible on that page afterwards, so you
   can come back and copy it again. What you cannot do is edit a key: changing
   the access level means generating a new one and deleting the old.

The walkthrough with screenshots is at <https://hcpapi.com/mcp/#key>.

The access level you pick is the real boundary. This server follows whatever
you generated, so a read-only key cannot reach the write tools at all. If you
want an assistant that only answers questions, generate a read-only key and
Housecall Pro enforces that limit for you.

Only an admin can generate a key, and admins have full account access, so the
key reaches the whole account rather than one person's slice of it.

## Tools

95 tools. Reading works with any key; writing needs a full-access one. They are
grouped into toolsets, so an install can register only the groups it needs -
see [Choosing which tools to register](#choosing-which-tools-to-register).

### Reading

| Tool | What it does |
|---|---|
| `hcp_get_company` | Company profile, with the account's time zone and its default arrival window |
| `hcp_get_schedule_availability` | The hours the account works, and how far ahead it takes bookings |
| `hcp_list_booking_windows` | The slots Housecall Pro reports as bookable, and which of them are open |
| `hcp_search_customers` | Search or list customers, or filter by tag |
| `hcp_get_customer` | One customer's full record |
| `hcp_contactability` | Whether customers are safe to contact - unions every do-not-contact signal the API can read, and names the one it can't |
| `hcp_list_jobs` | Jobs by status, schedule window, or customer |
| `hcp_get_job` | One job's full record |
| `hcp_get_job_notes` · `hcp_get_job_count` | A job's notes, and the account's total job count |
| `hcp_list_job_appointments` | A job's booked visits, windows and technicians |
| `hcp_get_job_line_items` | One job's line items, priced in dollars |
| `hcp_get_job_input_materials` | What was actually used on a job, as distinct from what was billed |
| `hcp_list_checklists` | Checklists attached to jobs or estimates |
| `hcp_list_invoices` | Invoices in a date range, filterable by status (`paid`, `open`, `canceled`) |
| `hcp_get_invoice` | One invoice in full, with payments, refunds and balance |
| `hcp_get_job_invoices` | A single job's invoices, without walking the whole list |
| `hcp_get_invoice_document` | A preview of the invoice page as the customer sees it |
| `hcp_list_estimates` | Estimates with option totals |
| `hcp_get_estimate_line_items` | Line items on an estimate option |
| `hcp_list_leads` · `hcp_get_lead` | Unconverted enquiries, and one lead with its line items |
| `hcp_list_events` · `hcp_get_event` | Calendar entries that are not jobs, with recurrence and attendees |
| `hcp_get_customer_address` | One address by id, when you have the id and not the customer |
| `hcp_get_application` | The API application registered on the account, if any |
| `hcp_list_routes` | A date's routes: employees grouped with their assigned work |
| `hcp_list_service_zones` | Service areas with zip codes and trip charges, and whether a zip is covered |
| `hcp_list_pipeline_statuses` | The workflow stages configured for jobs, leads or estimates |
| `hcp_search_pricebook` | Services, materials, categories, price forms |
| `hcp_list_price_forms` | Bookable service templates, with durations and booking questions |
| `hcp_list_employees` | Employees and roles |
| `hcp_list_tags` · `hcp_list_job_types` · `hcp_list_lead_sources` | Account lookups |
| `hcp_revenue_summary` | Invoiced revenue by month or line item |
| `hcp_render_report` | Turn findings into one interactive report — sortable tables, selectable rows, print. Opens in the conversation on clients that support it, and comes back as a self-contained HTML file everywhere else. Makes no API call |
| `hcp_export_csv` | CSV export of customers, jobs, invoices or estimates |
| `hcp_api_notes` | What the API actually does for a topic, where that differs from its documentation. Answers from a compiled table, so it makes no request |

### Writing

Needs a full-access key.

| Tool | What it does |
|---|---|
| `hcp_create_customer` · `hcp_update_customer` | Create a customer, or change one's fields |
| `hcp_create_customer_address` | Add a service address to a customer |
| `hcp_create_job` | Create an unscheduled job |
| `hcp_add_job_line_items` | Add line items to a job |
| `hcp_update_job_line_item` · `hcp_delete_job_line_item` | Change one line item on a job, or take it off |
| `hcp_update_job_line_items` | Change several of a job's line items in one call |
| `hcp_add_job_note` · `hcp_delete_job_note` | Add an internal note, or take one off. The delete is confirmed by re-reading the job |
| `hcp_upload_job_attachment` | Attach a photo or document to a job, passed as base64. Confirmed against the job's attachment list. There is no public route to remove one |
| `hcp_upload_estimate_option_attachment` | The same for an estimate option. Cannot be read back, so keep the returned id |
| `hcp_schedule_estimate_option` | Book a visit for an estimate option and dispatch to it. `notify` defaults to false; Housecall Pro may still remind the customer nearer the date |
| `hcp_add_job_link` · `hcp_add_estimate_option_link` | Attach a titled link. Needs an application on the account, or answers "Application not found" |
| `hcp_lock_job` · `hcp_lock_jobs_by_date` | Freeze a job, or everything from a date. **No unlock exists on this API** — a dashboard action, so ask first |
| `hcp_set_application_enabled` | Enable or disable the account's API application. Affects every integration on the account |
| `hcp_create_webhook_subscription` · `hcp_delete_webhook_subscription` | Subscribe or unsubscribe a delivery URL. Partner-gated, and a subscription is dropped after one 5xx from your endpoint |
| `hcp_update_job_input_materials` | Replace what a job records as used on site. A whole-list replace, so read it first |
| `hcp_add_job_tag` · `hcp_remove_job_tag` | Put a tag on a job, or take it off |
| `hcp_schedule_job_appointment` | Book a visit on a job with technicians dispatched, which schedules the job |
| `hcp_update_job_appointment` | Move a visit, change who is dispatched to it, or both |
| `hcp_delete_job_appointment` | Take one visit off a job |
| `hcp_unschedule_job` | Clear a job's visits and its schedule, back to needs scheduling |
| `hcp_dispatch_job` | Put a crew on a job's work. Customer-visible, so treat it as reaching them |
| `hcp_create_estimate` · `hcp_add_estimate_option` | Draft a multi-option estimate, or add an option to one |
| `hcp_approve_estimate_options` · `hcp_decline_estimate_options` | Record the customer's answer on one or more estimate options |
| `hcp_update_estimate_option_line_items` | Replace the line items on an estimate option. A whole-list replace |
| `hcp_add_estimate_option_note` · `hcp_delete_estimate_option_note` | Note an estimate option. These cannot be read back, so keep the id |
| `hcp_create_lead` | Create a lead |
| `hcp_convert_lead` | Turn a lead into an estimate or a job. The lead survives it |
| `hcp_create_tag` · `hcp_rename_tag` | Create a tag, or rename one |
| `hcp_create_job_type` · `hcp_rename_job_type` | Create a job type, or rename one. Deleting one is a dashboard action |
| `hcp_create_lead_source` · `hcp_rename_lead_source` | Create or rename a lead source, the validation list for `lead_source` |
| `hcp_create_pricebook_material` · `hcp_update_pricebook_material` · `hcp_delete_pricebook_material` | Add, change or remove a price-book material |
| `hcp_create_pricebook_material_category` · `hcp_update_pricebook_material_category` · `hcp_delete_pricebook_material_category` | Add, rename or remove a price-book material category |
| `hcp_create_price_form` · `hcp_update_price_form` · `hcp_delete_price_form` | Add, change or remove a bookable service template |

### Shop defaults

| Tool | What it does |
|---|---|
| `hcp_get_defaults` | Read the defaults stored for this installation |
| `hcp_set_defaults` | Store one or more, or clear one by passing null |
| `hcp_get_business_profile` | Read the business profile: who the shop is, their vendors, pricing, payroll and messaging rules |
| `hcp_set_business_profile` | Store one or more profile sections, or clear one by passing null |

Three preferences are kept: how long a job is scheduled for when nobody says
otherwise, how wide an arrival window is by default, and the name of the line
item most jobs start from. They save answering the same question twice.

They live in a file the server owns. `HCP_MCP_DEFAULTS_PATH` names it outright
if you set it; otherwise it is `%APPDATA%\housecall-pro-mcp\defaults.json` on
Windows and `$XDG_CONFIG_HOME/housecall-pro-mcp/defaults.json` elsewhere,
falling back to `.config/housecall-pro-mcp/defaults.json` under your home
directory. That location is per machine and not per Housecall Pro account: the
file belongs to the installed server, so a shop running this on two computers
sets its defaults on each. Nothing in it is sent to Housecall Pro, and the keys
it accepts are a closed set, so nothing about a customer or a job can be parked
in it.

The **business profile** is the bigger sibling, made for skills that run a
setup interview: five sections - `shop`, `vendors`, `pricing`, `payroll`,
`comms` - covering who the shop is, who they buy from and how their documents
arrive, margin and rounding rules, pay-week and commission rules, and how
outbound messages should sound. A skill reads it before asking setup questions
so nothing is asked twice; each section records the date it was last confirmed,
and sections are replaced whole, which is why a skill saves only after reading
the section back for a yes. Same file conventions as the defaults
(`HCP_MCP_PROFILE_PATH` override, `profile.json` beside `defaults.json`), same
privacy posture: per machine, never transmitted, closed section set, nothing
about any customer - and a vendor `account_hint` refuses anything that looks
like a full account number.

## Building the desktop bundle

`manifest.json` describes this server as an MCP bundle, which installs into a
desktop client by drag-and-drop with no Node install and no config file to edit.

```bash
npx -y @anthropic-ai/mcpb pack .
```

That writes `housecall-pro-mcp-<version>.mcpb`. `.mcpbignore` keeps build-time
dependencies out of it; without those rules the bundle carries the TypeScript
compiler and is nearly three times the size. The bundle asks the user for their
API key, and optionally for read-only mode and a toolset list, in the client's
own settings interface rather than in a file.

## Choosing which tools to register

Every tool the server registers is a tool the client has to hold in context
before it does any work, and a longer list makes a client choose worse among the
tools that matter. So the surface is selectable.

```bash
# Only what a reporting session needs, and nothing that can change anything
npx -y housecall-pro-mcp --read-only --toolsets=reports,invoices,customers
```

| Option | Effect |
|---|---|
| `--read-only` | Registers no tool that can change anything. Also `HCP_READ_ONLY=1` |
| `--toolsets=a,b` | Registers only these groups. Also `HCP_TOOLSETS` |
| `--help` | Lists the groups and exits |

Groups: `company`, `customers`, `jobs`, `estimates`, `invoices`, `pricebook`,
`schedule`, `reports`, `admin`. Also `all`, and `default` for the default set.

`admin` is tag, job-type and price-book structure **maintenance** - the writes
that reshape those registries. It is **not** in the default set, because a
booking or reporting session never needs it and leaving it out keeps the
starting surface smaller. Ask for it by name, or use `--toolsets=default,admin`.
Listing tags and job types is not admin: those reads are how ordinary job data
gets interpreted, so they are always in the default set.

A misspelled group name stops the server with a message naming the valid ones,
rather than starting with tools missing. An install that quietly exposed nothing
would look exactly like the API being unreachable.

`--read-only` is a second, independent thing from the access level of your key.
A read-only key already refuses writes at the API. This refuses to register them
at all, which is what you want when pointing an agent at a live account to look
around: the write tools are not merely guarded, they are absent.

Without `HCP_API_KEY` the server still starts, **keyless**: only the tools
that never call Housecall Pro register - `hcp_render_report`, `hcp_api_notes`
and the business-profile pair - and nothing can reach a Housecall Pro account.
That keeps the report renderer available when you are working from dashboard
CSV exports rather than the API, and lets a skill's setup interview run before
a key exists.

## What the server tells the model up front

Two of this project's tables are compiled into the server rather than left in
this README, because a README is read by people and never by the model.

- The **connect-time instructions** carry the rule that prevents the worst
  failure: never trust a 2xx on a Housecall Pro write, read the record back.
- **`hcp_api_notes`** answers a plain-language question about what the API
  actually does - a route, a field, or the thing you were trying to do - from
  the same verified table behind the two sections above. It makes no request, so
  it costs nothing. Ask it before concluding something cannot be done, and after
  any write that reported success but looks like it changed nothing.
- The same tables are also exposed as MCP **resources**
  (`hcp://api-notes/quirks` and `hcp://api-notes/phantom-routes`) for clients
  that can read a resource without spending a tool call.

## How it behaves

The write tools only work with a full-access key. Call one with a read-only
key and it fails with a plain message telling you why, rather than doing
something you did not expect.

Every tool carries the spec's annotations, so a client can tell a read from a
write, a write from a delete, and either from something that reaches the
customer, without having to infer it from the name. `hcp_dispatch_job` and the
estimate approve and decline tools are marked as possibly notifying the
customer, because they are.

No tool here sends an email, a text or an estimate on your behalf. Drafting an
estimate leaves it sitting as a draft, and sending it stays a deliberate action
you take inside Housecall Pro.

Reports open where you are reading. On a client that supports MCP Apps —
Claude and Claude Desktop today, not Claude Code — `hcp_render_report` renders
in the conversation itself: the same sortable, filterable report, with its rows
still selectable back into chat. Nothing is downloaded and no file is written.
Everywhere else the tool returns the report as one self-contained HTML file
exactly as before, so nothing depends on the feature being there. The report
makes no network request in either form, which is also what lets it run under
the strict content policy those clients apply. If your client says it supports
this and you still see nothing, ask for the report again with `as_file` and you
will get the file version back.

**Dispatching a crew is customer-visible.** `hcp_dispatch_job` puts technicians
on a job's work, and that route is one the customer can see: Housecall Pro may
tell them who is coming and that someone is on the way. What it sends has not
been watched either way, so treat it as reaching the customer rather than
assuming it does not.

Recording an answer on an estimate option is the shop writing down what the
customer said, not a request going out to ask. Housecall Pro's own word for the
result is "pro approved" or "pro declined", which is what
`hcp_approve_estimate_options` and `hcp_decline_estimate_options` record. Doing
it emailed and texted nobody when it was exercised. That is not a promise for
your account: Housecall Pro's automations and notification settings send on
their own, whatever any single call does, and one account's configuration says
nothing about another's. On an account set up to copy an approved option to a
job, approving creates one and the response names it.

**Changing several line items is one call.**
`hcp_update_job_line_items` hands Housecall Pro the whole list in a single
request. `hcp_update_job_line_item` is one request per row, so a run of them can
stop half way and leave a job part-repriced; use it when exactly one row is
changing and the bulk tool when more than one is.

**Booking a job is one call.** Creating an appointment on a job also sets that
job's schedule, so `hcp_schedule_job_appointment` books the work and dispatches
it together: the job stops reading as needs scheduling, and the visit lands on
the technicians you named. Call it again on the same job to add a second visit.
Every appointment needs at least one technician, and one that names nobody is
refused here rather than sent.

Moving a visit with `hcp_update_job_appointment` moves the job's schedule with
it, so a reschedule is also one call. Undoing a booking is
`hcp_delete_job_appointment` for a single visit, or `hcp_unschedule_job` to take
every visit off and return the whole job to needs scheduling.

Before offering a customer a time, `hcp_get_schedule_availability` gives the
hours the account works and `hcp_list_booking_windows` gives the slots it
reports as bookable, so what you offer matches what the account actually does.

None of these calls emails or texts the customer itself. What Housecall Pro does
send is its own appointment reminders as the date approaches, which depends on
your account's settings rather than on this server. Automations you have set up
in Housecall Pro run on their own, outside this server's control.

A failed write is never retried automatically, so a network hiccup cannot
quietly create the same record twice.

Your API key goes only to `api.housecallpro.com`. The only other request this
server ever makes is the version check described under Updating, which carries
no account data.

## Where your keys go

One key is configured, and it reaches exactly one host.

- Your **Housecall Pro API key** (`HCP_API_KEY`) goes only to
  `api.housecallpro.com`. Nothing read from your Housecall Pro account is sent
  anywhere else.

The only other request this server ever makes is the version check described
under Updating, which carries the product name and installed version and
nothing else.

## Limitations

A few more edges that are shape rather than quirk.

**Appointments belong to a job.** There is no account-wide appointment list, so
you reach visits one job at a time. Ask for a job's appointments, not for
"every appointment this week". The account's own schedule does read account
wide: `hcp_get_schedule_availability` returns the hours it works and
`hcp_list_booking_windows` the slots it reports as bookable.

**An arrival window has to be a width Housecall Pro accepts:** 0, 15, 20, 60,
120, 180 or 240 minutes, where 0 means an exact time. It rejects any other
number on the write, so the booking tools offer the accepted widths as a list
rather than a free number.

**A booking can be undone; the job cannot be deleted.** `hcp_unschedule_job`
takes the visits off and clears the schedule, leaving the job at needs
scheduling with its customer, line items and notes intact. Housecall Pro's API
has no route that deletes a job, so a job created by mistake is closed out in
Housecall Pro itself.

**A customer address is append-only.** `hcp_create_customer_address` adds one,
and no route changes or removes it afterwards. Get it right before adding it; a
wrong one is corrected in Housecall Pro.

**Taking a tag off a job is one tag at a time.** `hcp_remove_job_tag` needs the
job and the tag; there is no call that clears every tag from a job at once. It
also needs a key whose permissions cover tag changes, so a 401 here means the
key's access level rather than a missing feature.

**Checklists must be asked for by job or estimate.** There is no way to list
every checklist on the account, and an empty answer means no checklist has been
set up for those records rather than that something went wrong.

**Tags are created and renamed, never deleted.** Deleting a tag from the
account is done in Housecall Pro. Create them sparingly.

## Updating

On startup the server checks hcpapi.com for a newer version; the request
carries the product name and installed version, and nothing else. If a newer
version exists, the next tool response mentions it once. If the check cannot
complete, the server just carries on.

To update, re-run the install command for your client; the `npx` setups in
Install pull the latest published version. If your client is holding on to an
older cached copy, change the arguments to
`["-y", "housecall-pro-mcp@latest"]` to force the newest release.

## Troubleshooting

**401 Unauthorized.** Either the key is read-only and you called a write tool,
or the employee who created it does not have permission for that data.
Generate a full-access key, or check that employee's permissions.

**Empty results where you expected data.** Usually the same cause. An
employee-scoped key only returns what that employee can see.

**No tools appear in your client.** Check that you have Node 18 or newer with
`node --version`, and that `HCP_API_KEY` is set inside the MCP server's `env`
block rather than in your shell.

## Going further

This server covers the Housecall Pro API itself. We are building the layer that
sits on top of it: reporting and export workflows, price book tooling, and
webhook setup. If that sounds useful, email hello@hcpapi.com and we will tell
you when it is ready.

## Issues and pull requests

Bug reports and feature requests are welcome in the issue tracker, and the more
of them the better — say what you asked your assistant to do and what came back.

Pull requests are closed automatically. Releases are validated against an
internal test suite that a pull request cannot run, so there is no honest way to
review one here. Telling us what is broken in an issue gets it fixed faster than
a patch would.

## License

MIT, copyright HCP API. Independent project, not affiliated with Housecall Pro.
"Housecall Pro" is a trademark of its owner, used here only to describe
compatibility.
