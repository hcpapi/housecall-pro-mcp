#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HcpClient } from "./hcp.js";
import { registerApiNoteResources, registerTools } from "./tools.js";
import { INSTALLED_VERSION, versionCheck } from "./version-check.js";
import { SERVER_INSTRUCTIONS } from "./api-notes.js";
import { declareAppCapability, registerReportApp } from "./mcp-app.js";
import { TOOLSETS, TOOL_SPECS, parseSurfaceOptions, shouldRegister } from "./toolsets.js";

const VERSION = INSTALLED_VERSION;

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      `housecall-pro-mcp v${VERSION}`,
      "",
      "An MCP server for the Housecall Pro API. Reads HCP_API_KEY from the environment.",
      "",
      "Options:",
      "  --read-only            Register no tool that can change anything in Housecall Pro.",
      "                         Also settable with HCP_READ_ONLY=1.",
      "  --toolsets=a,b         Register only these groups of tools. Also HCP_TOOLSETS.",
      `                         Groups: ${TOOLSETS.join(", ")}`,
      '                         Plus "all", "default", and "none" for no group at all.',
      "  --tools=a,b            Register these individual tools as well, by name. Also HCP_TOOLS.",
      "                         Additive to --toolsets, so it adds the one tool a group",
      '                         does not carry without taking the group. Pair with',
      '                         --toolsets=none for exactly the named tools and nothing else.',
      "  --version              Print the version and exit.",
      "  --help                 Print this and exit.",
      "",
      "Without HCP_API_KEY the server starts keyless: only hcp_render_report and",
      "hcp_api_notes register, and nothing can reach a Housecall Pro account.",
      "",
      "Fewer tools in context makes a client choose better between the ones that remain,",
      "so name the groups a session actually needs rather than taking everything.",
    ].join("\n"),
  );
  process.exit(0);
}

// Without a key the server still starts, keyless: only the tools that never
// call Housecall Pro register (the report renderer and the API notes). That
// keeps the renderer useful for people working from dashboard CSV exports,
// while a typo'd key variable still surfaces - the account tools are simply
// absent, and the connect-time instructions say why.
const apiKey = process.env.HCP_API_KEY;
if (!apiKey) {
  console.error("housecall-pro-mcp: no HCP_API_KEY in the environment - starting keyless.");
  console.error("Only hcp_render_report and hcp_api_notes are available; no tool can reach your account.");
  console.error("To connect: generate a key in Housecall Pro (My Apps, Go to App store, API Key Management).");
  console.error("It needs their MAX plan and an admin login. Setup guide: https://hcpapi.com/mcp/#key");
}

// A bad toolset name is fatal rather than ignored. Silently exposing nothing
// because of a typo is indistinguishable from the API being unreachable.
let options;
try {
  options = parseSurfaceOptions(process.argv.slice(2), process.env);
} catch (e) {
  console.error(`housecall-pro-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
if (!apiKey) options.keyless = true;

const KEYLESS_INSTRUCTIONS =
  "\n\nTHIS SERVER IS RUNNING KEYLESS: no HCP_API_KEY was set, so only the " +
  "tools that never call Housecall Pro are registered - hcp_render_report, " +
  "hcp_api_notes, and the business-profile pair (a local file, so a skill's " +
  "setup interview still works) - and nothing here can read or change a " +
  "Housecall Pro account. If the user expected account access, tell them to " +
  "set HCP_API_KEY in the server's environment (generated in Housecall Pro " +
  "under My Apps, Go to App store, API Key Management - MAX plan, admin " +
  "login) and restart the client.";

const server = new McpServer(
  { name: "housecall-pro-mcp", version: VERSION },
  // The instructions land in the client's context at connect time, before any
  // tool is called. This is the only place the "never trust a 2xx" rule can be
  // stated early enough to prevent the wrong answer rather than explain it
  // afterwards - and the only place a keyless start can be explained before a
  // missing tool reads as a broken server.
  { instructions: SERVER_INSTRUCTIONS + (apiKey ? "" : KEYLESS_INSTRUCTIONS) },
);

// Keyless registers only tools that never call the client, so the placeholder
// key can never reach a request.
registerTools(server, new HcpClient(apiKey ?? "keyless"), options);
registerApiNoteResources(server);

// The report surface. Both of these must happen before connect: capabilities
// can only be registered while the transport is still detached, and a host that
// never sees the declaration will not ask for the UI resource. Registered even
// keyless, because the report renderer itself is available keyless - somebody
// working from dashboard CSV exports gets the interactive report too.
declareAppCapability(server);
registerReportApp(server, VERSION);

// Disclosed update check (see the README's Updating section). Fire-and-forget:
// it never delays a tool call, and any failure is silent.
versionCheck.start();

const transport = new StdioServerTransport();
await server.connect(transport);

const registered = Object.keys(TOOL_SPECS).filter((n) => shouldRegister(n, options));
console.error(
  options.keyless
    ? `housecall-pro-mcp v${VERSION} ready KEYLESS - ${registered.length} tools (report renderer + API notes), no account access`
    : `housecall-pro-mcp v${VERSION} ready (connected to Housecall Pro) - ` +
        `${registered.length} tools across ${options.toolsets.length} toolset(s)` +
        `${options.readOnly ? ", READ-ONLY (no writes registered)" : ""}`,
);
