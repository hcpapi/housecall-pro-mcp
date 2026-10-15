# Changelog

Release notes live on [GitHub Releases](https://github.com/hcpapi/housecall-pro-mcp/releases);
this file is the summary per version.

## 1.19.0 — 2026-10-14

**Who is on an estimate, and when it was answered.** Housecall Pro added two
fields to the estimate record this month, and both now ride every estimate
row. `employees` is the assigned technicians as id and name, the same shape a
job row has carried all along; an estimate that has not been assigned and
scheduled in the app has an empty list. Each option now has
`approval_status_updated_at`, the moment its `approval_status` last changed,
null until the customer or the office answered. "Approved five days ago and
still not scheduled" was computed from the option's `updated_at` before, a
clock that moves for other reasons too; now it reads from the field that means
it. `lead_source` rides along as well, as it has on jobs since 1.17.0.

**`hcp_get_estimate` reads one estimate in full.** Every option, the assigned
employees, the customer, the address, and the schedule with the same
account-zone rendering a job record gets. Line items stay a separate read per
option, as before.

**The estimates CSV no longer says `[object Object]`.** The options column was
a list of records joined as strings, which is what JavaScript prints for one.
Lists of records now render field by field (`id=est_... name=Option 1
approval_status=approved total_dollars=1500`), in every export, which also puts
a job's employees into the jobs export readably.

Requested in hcpapi/housecall-pro-mcp#2.

## 1.18.0 — 2026-08-16

**"Has the customer opened my estimate yet?" no longer gets a wrong answer.**
Housecall Pro tracks whether a customer opened or clicked an estimate — sent,
delivered, link clicked, opened, each with a time and a count — but keeps it on
the activity feed, which no API key of any scope can read. Asked that question,
an agent would read the estimate list, see an unanswered `approval_status`, and
report that the customer had not looked at it. That is a confident wrong answer
about a live quote, and this release removes both halves of it: a new note says
the tracking exists and names where it lives, and the estimate listing now says
outright that nothing in its payload is evidence about viewing. An unanswered
estimate is not an unopened one.

Two more gaps in the same shape are now documented rather than guessed at.
**Callback and Business Unit** are real Job Fields, configured on accounts and
absent from this API in every spelling — and their filters are accepted and
silently ignored, so `?callback=true` returns the whole list and reads as "no
callbacks found". **Estimate view receipts** read through a customer-scoped
activity view are truncated by the sending estimate's own rows, so finding no
"clicked" line there means it is not in that window, never that it was not
clicked.

The pointers ride on successful reads, which is deliberate. A refusal already
corrects a bad call; these correct a *good* one whose payload simply does not
contain what was asked, and measurement across repeated runs showed a warning
delivered in the response the model is already reading changes its answer where
the same words in the connect-time instructions and the tool description did
not.

## 1.17.0 — 2026-08-15

**Which jobs came in through online booking is now one call.** Every job row
carries `lead_source` — the channel the job arrived through, such as *Online
Booking* or *Reserve with Google* — so asking which of this week's jobs were
booked online is answered by the listing itself. It was already in Housecall
Pro's response on every row and this server was discarding it, which turned the
question into one job read per job and still left it unanswerable for the rest.
Rows also carry `updated_at`, which walking a list newest-first to find what
changed has always needed and never had.

**Visit times come back in your own time zone.** Housecall Pro answers in UTC,
and a job at `16:00Z` is noon to a shop running Eastern — read back as-is it
becomes four o'clock, which is the wrong half of the day. Job rows now carry
`scheduled_start_local` and `scheduled_end_local` rendered in the account's own
zone, and a single job carries the same under `schedule_local`. The UTC fields
are untouched, so anything computing on them is unaffected: quote the local
ones, compute on the raw ones. The zone is read once per process from the
company profile; an account that has never set one, or a key that cannot read
it, degrades to UTC with a note saying so rather than to a guess.

**Dead ends name the way out.** An empty attachment list now says what is never
filed as an attachment: calls, call recordings and transcripts, texts and
emails are not on Housecall Pro's public API at all — no route reaches them and
no key changes that — and they live in the Voice and call-log section of the
dashboard instead. Previously an empty list read as *not filed yet*, sending a
search on to the customer and then the leads list to reach the same answer.
`hcp_list_leads` says the same in its own description, and a new
`calls-and-messages-not-on-public-api` topic in `hcp_api_notes` has the detail.

**A missing API application is no longer reported as a key problem.** Housecall
Pro returns 401 for a third reason the explanation did not know about: routes
that hang off an API application — job links and webhook subscriptions —
refuse with *Application not found* on a key that is provably fine everywhere
else. The old wording sent the owner to mint a replacement key that would fail
identically. The refusal now names the real cause, says plainly not to replace
the key, and names which routes are affected.

**A malformed report comes back with every problem at once.** `hcp_render_report`
promised the exact problems so a caller could fix and re-call, then returned
the first one and stopped — four round trips to fix one payload. Everything
checkable is now checked in one pass, and a contract error carries a minimal
report that actually renders, so a caller told *prose block needs html* can see
the shape rather than guess it.

**No guidance names a tool that is not there.** Three strings still pointed at
an equipment tool this package no longer registers. Naming a tool that does not
exist is worse than naming none — it reads as a working path — so the guidance
now names the attachment link, which is the route that works. A test asserts no
description or note names an unregistered tool.

## 1.16.0 — 2026-08-14

**A parameter a tool does not take is now refused, by name.** Housecall Pro
accepts an unrecognised query parameter and answers as though it had never been
asked for, so a filter name that does not exist silently becomes *no* filter and
the whole account comes back wearing the shape of a narrow question. Invented or
mistyped parameters are now caught here before anything is sent, naming what was
not recognised, the closest parameter that does exist, and everything the tool
takes.

**Credentials and file links stay out of what a tool returns.** Whatever an
upstream service says when a call fails is cleaned before it reaches the
assistant: the API key this server holds, and anything else key-shaped, is
replaced with `[redacted]`. Housecall Pro's own identifiers and ordinary error
prose are untouched. Attachment links are handed over once rather than echoed.

**A write is no longer reported as done off a bare success.** Where the record
can be read back, the tool reads it and reports the confirmed state, so a change
that did not take is called out rather than announced as done. Where there is no
route to read a write back, the tool says so and hands you the id instead of
implying a confirmation it cannot give.

**An empty list says which kind of empty it is.** "Nothing matched" and "the
filter never applied" no longer look identical, so a dropped filter stops reading
as an absent customer, invoice or job.

**Jobs can be filtered by technician, and carry their work clocks.** Each row
names the technicians assigned to it, and `on_my_way_at` / `started_at` /
`completed_at` come back so a job in progress is visible as one.

**New:** a "Where your keys go" section in the README, stating the one host your
Housecall Pro key reaches.

## 1.15.1 — 2026-08-10

- Listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as
  `io.github.hcpapi/housecall-pro-mcp`. The registry verifies that a package
  belongs to the server claiming it, so `package.json` now carries the matching
  `mcpName` marker. No change to how the server behaves.

## 1.15.0 — Initial public release

An MCP server for the Housecall Pro API. It registers 95 tools across nine
toolsets — company, customers, jobs, estimates, invoices, price book, schedule,
reports and admin — so an MCP-compatible agent can work an account directly.

**Reading.** Customers, jobs, estimates, invoices, employees, tags, the price
book and the schedule, plus revenue summaries grouped by period, customer, job
type or line item, CSV export of any of it, and self-contained HTML reports
whose cells link back to the records they name.

**Writing.** Customers and jobs, estimates and their options, line items in one
call or one at a time, appointments and scheduling, dispatch, notes, links,
tags, attachments, and recording a customer's answer on an estimate option.
Write tools need a full-access key; with a read-only key they refuse with a
plain reason instead of failing strangely.

**Money is in dollars.** Every amount a tool returns or accepts is dollars, and
a total is a total rather than something you have to convert.

**Nothing goes out on your behalf.** No tool here sends an email, a text or an
estimate. Drafting an estimate leaves a draft; sending it stays a deliberate act
inside Housecall Pro. Every tool carries the MCP spec's annotations, so a client
can tell a read from a write, a write from a delete, and either from a route the
customer may see — dispatch and the estimate approve and decline tools are
marked as possibly reaching the customer, because they are.

**Failed writes are never retried automatically**, so a network hiccup cannot
quietly create the same record twice.

**Choosing a smaller surface.** `HCP_TOOLSETS` registers only the groups you
want, and `HCP_READ_ONLY` leaves every tool that could change anything out of
the session entirely — absent rather than merely refused.

**Starting without a key.** The report renderer and the API notes register on a
keyless start, so a client can be set up and explored before a key exists.

**The shop profile.** What a first-run interview learns about a business — its
name and trade, vendors, pricing conventions, payroll rules and how it talks to
customers — is kept in a local file, per machine, never transmitted, and holds
nothing about any customer, so nothing set up once is asked twice.

**Where your key goes.** Only to `api.housecallpro.com`. The single other
request the server makes is the update check described in the README, which
carries the product name and installed version and nothing else.

Node 18 or newer. Runs with `npx` and no install step, as a Claude Code plugin,
or from any MCP client that speaks stdio. MIT licensed. Independent project, not
affiliated with, endorsed by, or sponsored by Housecall Pro.
