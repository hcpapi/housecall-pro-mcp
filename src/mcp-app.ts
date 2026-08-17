/**
 * MCP Apps support for the report renderer.
 *
 * `hcp_render_report` has always produced a single self-contained interactive
 * HTML document: everything inlined, no network request, works offline. Getting
 * it in front of the owner was the awkward part - the tool description had to
 * tell the assistant to write a file and hand over a path, or to re-present the
 * HTML as an artifact, which is a manual step in the middle of an answer.
 *
 * MCP Apps (SEP-1865) is the standard way to skip that: a tool points at a
 * `ui://` resource, and a supporting host renders it inline in the conversation
 * inside a sandboxed iframe. The renderer already satisfies the extension's
 * restrictive default CSP (`default-src 'none'`) by construction, because it was
 * written to make no request in the first place.
 *
 * This module holds only the wiring - the URI, the mime type, the capability,
 * and the resource. The document itself is `reportAppTemplate`, built from the
 * same renderer the downloadable file uses.
 *
 * Support is host-dependent (Claude and Claude Desktop yes, Claude Code no as of
 * 2026-08), which is why nothing here replaces the existing HTML return: the
 * tool still hands back the full document, so a host that cannot render an app
 * behaves exactly as before.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reportAppTemplate } from "./report/template.js";

/**
 * The mime type that marks a resource as an MCP App. The `profile` parameter is
 * what distinguishes it from an ordinary HTML resource, and hosts match on the
 * exact string.
 */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The extension key a server declares to say it can serve MCP App resources. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

/** The report UI. One resource, reused for every report this server renders. */
export const REPORT_UI_URI = "ui://housecall-pro/report.html";

/**
 * The `_meta` a tool carries to say "render me as this app".
 *
 * `_meta.ui.resourceUri` is the current spelling; `_meta["ui/resourceUri"]` is
 * the deprecated one kept for older hosts. Both are emitted, because the cost is
 * one key and the failure mode of picking wrong is that nothing renders at all.
 */
export function appToolMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

/**
 * Declare that this server serves MCP App resources.
 *
 * Capabilities can only be registered before the transport connects, and a host
 * that never sees this declaration will not ask for the UI resource. Guarded
 * because the test harness stands in a bare object for the server.
 */
export function declareAppCapability(server: McpServer) {
  const inner = (server as any).server;
  const register = inner?.registerCapabilities?.bind(inner);
  if (!register) return;
  register({ extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } } });
}

/**
 * Whether the connected host said it can render MCP Apps.
 *
 * Read from the capabilities the client sent at initialize, so it is only
 * meaningful after the handshake - which is always true by the time a tool
 * runs. A host that says nothing is treated as not supporting apps, which is
 * the safe direction: it gets the standalone HTML exactly as before.
 */
export function hostRendersApps(server: McpServer): boolean {
  const inner = (server as any).server;
  const caps = inner?.getClientCapabilities?.();
  return Boolean(caps?.extensions?.[UI_EXTENSION]);
}

/**
 * Serve the report UI.
 *
 * The document carries no report data: a host may fetch it once, before the
 * tool has even been called, and reuse it across renders. The data arrives
 * separately, in the tool result the host pushes to the running app.
 */
export function registerReportApp(server: McpServer, version: string) {
  const reg = (server as any).registerResource?.bind(server);
  if (!reg) return;

  reg(
    "hcp-report-app",
    REPORT_UI_URI,
    {
      title: "Housecall Pro report",
      description:
        "The interactive report surface: sortable and filterable tables, severity-coded sections, " +
        "collapsible worklists, selectable rows that copy back to chat, light and dark theme, print. " +
        "Rendered inline by hosts that support MCP Apps; the same report is also returned as a " +
        "standalone HTML file for hosts that do not.",
      mimeType: APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: REPORT_UI_URI,
          mimeType: APP_MIME_TYPE,
          text: reportAppTemplate(version),
        },
      ],
    }),
  );
}
