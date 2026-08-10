# Changelog

Release notes live on [GitHub Releases](https://github.com/hcpapi/housecall-pro-mcp/releases);
this file is the summary per version.

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
