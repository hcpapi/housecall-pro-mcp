# Changelog

Release notes live on [GitHub Releases](https://github.com/hcpapi/housecall-pro-mcp/releases);
this file is the summary per version.

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
