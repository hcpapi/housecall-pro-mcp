#!/usr/bin/env node
/**
 * `hcp` - the same Housecall Pro surface, from a terminal.
 *
 * This is a second front-end, not a second product. Every command here is one
 * of the MCP server's own tools, reached through the same registrar, the same
 * handlers and the same client. Nothing about a route, a quirk or a conversion
 * is restated: `collectTools` stands in a fake server object, lets
 * `registerTools` register into it, and keeps the handlers. So the two surfaces
 * cannot drift, because there is only one implementation of anything.
 *
 * Why a CLI exists at all, given the MCP server: an MCP server has no cron. It
 * runs when an assistant is in the room. A scheduled task that writes an aging
 * CSV every Monday morning is not something any MCP client can do, and it is a
 * large part of what this account's owner actually wants.
 */
import { HcpClient } from "./hcp.js";
import { registerTools } from "./tools.js";
import { INSTALLED_VERSION } from "./version-check.js";
import { TOOLSETS, TOOL_SPECS, parseSurfaceOptions, shouldRegister } from "./toolsets.js";

const VERSION = INSTALLED_VERSION;

// ---------------------------------------------------------------------------
// Collecting the tools
// ---------------------------------------------------------------------------

interface CollectedTool {
  name: string;
  description: string;
  schema: Record<string, any>;
  handler: (args: any, extra: any) => Promise<any> | any;
}

/**
 * Register the whole tool surface into a stand-in server and keep what lands.
 *
 * `makeToolRegistrar` already anticipates this: it calls `registerTool` if the
 * object has one, and its own comment notes that an embedder passing a stand-in
 * gets nothing back and needs nothing, because it calls the handler directly.
 * That is exactly what happens here. Returning `undefined` keeps the registrar
 * from trying to relax an input schema that does not exist.
 *
 * The handler collected is the *guarded* one, so the CLI inherits the unknown-
 * parameter refusal for free - a mistyped flag is answered with the closest
 * real name instead of being dropped, which on a filtered list would otherwise
 * silently return the whole account.
 */
function collectTools(hcp: HcpClient, opts: any): Map<string, CollectedTool> {
  const found = new Map<string, CollectedTool>();
  const stand = {
    registerTool(name: string, config: any, handler: any) {
      found.set(name, {
        name,
        description: config?.description ?? "",
        schema: config?.inputSchema ?? {},
        handler,
      });
      return undefined;
    },
  };
  registerTools(stand as any, hcp, opts);
  return found;
}

// ---------------------------------------------------------------------------
// Tool name <-> command
// ---------------------------------------------------------------------------

/**
 * Leading words that read as an action. A tool whose name starts with one
 * splits into `<verb> <noun>`; anything else becomes a single command word.
 *
 * The point of deriving rather than hand-listing commands is completeness: a
 * table of 95 entries drifts the first time a tool is added and nobody notices
 * the omission, whereas a derivation cannot omit anything. The hygiene test
 * asserts the derived set covers every registered tool and that no two tools
 * claim the same command.
 */
const VERBS = new Set([
  "add", "approve", "convert", "create", "decline", "delete", "dispatch",
  "discard", "draft", "export", "fill", "get", "list", "lock", "remove",
  "rename", "render", "resume", "schedule", "search", "set", "unschedule",
  "update", "upload", "void",
]);

export interface Command {
  /** The canonical form, e.g. "list jobs". */
  canonical: string;
  /** The noun-first form a `gh` user will try first, e.g. "jobs list". */
  reversed?: string;
  tool: string;
}

export function commandFor(toolName: string): Command {
  const parts = toolName.replace(/^hcp_/, "").split("_");
  if (parts.length > 1 && VERBS.has(parts[0])) {
    const verb = parts[0];
    const noun = parts.slice(1).join("-");
    return { canonical: `${verb} ${noun}`, reversed: `${noun} ${verb}`, tool: toolName };
  }
  return { canonical: parts.join("-"), tool: toolName };
}

/**
 * Both spellings resolve to the same tool. `hcp list jobs` is the canonical
 * form because it falls straight out of the tool name; `hcp jobs list` is what
 * anyone who has used `gh` or `docker` will type first, and refusing it to
 * protect a naming rule would be pedantry.
 */
export function buildIndex(toolNames: Iterable<string>) {
  const byCommand = new Map<string, string>();
  const collisions: string[] = [];
  const commands: Command[] = [];

  for (const name of toolNames) {
    const cmd = commandFor(name);
    commands.push(cmd);
    if (byCommand.has(cmd.canonical)) collisions.push(cmd.canonical);
    byCommand.set(cmd.canonical, name);
  }
  // Reversed forms are added second and never overwrite a canonical one, so an
  // alias can't shadow a real command if a future tool name inverts.
  for (const cmd of commands) {
    if (cmd.reversed && !byCommand.has(cmd.reversed)) byCommand.set(cmd.reversed, cmd.tool);
  }
  return { byCommand, commands, collisions };
}

// ---------------------------------------------------------------------------
// Flags -> tool arguments
// ---------------------------------------------------------------------------

/** Unwrap optional/default/nullable wrappers to get at the underlying zod type. */
function baseType(schema: any): any {
  let node = schema;
  for (let i = 0; i < 10 && node?._def; i++) {
    const kind = node._def.typeName;
    if (kind === "ZodOptional" || kind === "ZodNullable") node = node._def.innerType;
    else if (kind === "ZodDefault") node = node._def.innerType;
    else if (kind === "ZodEffects") node = node._def.schema;
    else break;
  }
  return node;
}

function typeNameOf(schema: any): string {
  return baseType(schema)?._def?.typeName ?? "";
}

/**
 * Turn `--work-status completed --limit 50 --json` into a typed argument object.
 *
 * Types come from the tool's own zod schema rather than from guesswork, so a
 * numeric field arrives as a number and a boolean flag needs no value. Unknown
 * flags are deliberately passed through untouched: the registrar's guard is
 * what answers them, and it names the closest real parameter, which is a better
 * error than anything this function could produce.
 */
export function parseArgs(
  tokens: string[],
  schema: Record<string, any>,
): { args: Record<string, unknown>; positional: string[] } {
  const args: Record<string, unknown> = {};
  const positional: string[] = [];

  const fieldFor = (flag: string) => {
    const snake = flag.replace(/-/g, "_");
    if (Object.hasOwn(schema, snake)) return snake;
    if (Object.hasOwn(schema, flag)) return flag;
    return snake; // unknown: hand it on and let the guard name the near miss
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);

    const field = fieldFor(rawName);
    const kind = typeNameOf(schema[field]);

    if (kind === "ZodBoolean") {
      // `--flag` means true; `--flag=false` still means false.
      args[field] = value === undefined ? true : !/^(0|false|no)$/i.test(value);
      continue;
    }

    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // A valueless non-boolean is almost always a typo for a boolean one.
        args[field] = true;
        continue;
      }
      value = next;
      i++;
    }

    if (kind === "ZodNumber") {
      const n = Number(value);
      args[field] = Number.isNaN(n) ? value : n;
    } else if (kind === "ZodArray") {
      const items = value.includes(",") ? value.split(",").map((s) => s.trim()) : [value];
      const itemKind = typeNameOf(baseType(schema[field])?._def?.type);
      const cast = itemKind === "ZodNumber" ? items.map(Number) : items;
      // Repeating a flag appends rather than replaces, so `--ids a --ids b` works.
      const existing = args[field];
      args[field] = Array.isArray(existing) ? [...existing, ...cast] : cast;
    } else {
      args[field] = value;
    }
  }

  return { args, positional };
}

/** Fields a bare word could plausibly be, in the order they are preferred. */
const PRIMARY_NAMES = ["query", "q", "search", "term"];

/**
 * Place a bare argument, so `hcp get job job_abc123` and
 * `hcp search customers smith` work without naming the flag.
 *
 * The hard rule here is that it never *silently* fails to place one. An
 * unplaced positional on a search means the search runs with no query and
 * returns the whole account wearing the shape of a filtered result - the same
 * silent-wrong-answer this codebase refuses unknown flags to prevent. So an
 * argument that cannot be placed confidently is refused, not dropped.
 */
export function applyPositional(
  args: Record<string, unknown>,
  positional: string[],
  schema: Record<string, any>,
): string | null {
  if (!positional.length) return null;

  const candidates = Object.keys(schema).filter(
    (k) => !Object.hasOwn(args, k) && typeNameOf(schema[k]) === "ZodString",
  );
  const required = candidates.filter((k) => schema[k]?.isOptional?.() !== true);

  // One required string is unambiguous. Otherwise a conventionally-named search
  // field wins, and failing that a single candidate of any kind.
  const target =
    required.length === 1
      ? required[0]
      : (PRIMARY_NAMES.find((n) => candidates.includes(n)) ??
        (candidates.length === 1 ? candidates[0] : undefined));

  if (!target) {
    const flags = candidates.map((c) => `--${c.replace(/_/g, "-")}`);
    return candidates.length
      ? `Not sure which parameter "${positional[0]}" is meant to be. Name it: ${flags.join(", ")}.`
      : `This command takes no bare arguments, so "${positional[0]}" has nowhere to go. Run it with --describe to see its parameters.`;
  }

  if (positional.length > 1) {
    return `Only one bare argument is understood (taken as --${target.replace(/_/g, "-")}). Name the rest as flags: ${positional
      .slice(1)
      .map((p) => `"${p}"`)
      .join(", ")}.`;
  }

  args[target] = positional[0];
  return null;
}

// ---------------------------------------------------------------------------
// Handler result -> something to print
// ---------------------------------------------------------------------------

/**
 * Pull the balanced JSON value off the front of a string.
 *
 * `out()` builds its text as an optional `NOTE:` block, the JSON, and then
 * possibly an update notice appended after it. Parsing the whole string
 * therefore fails whenever a notice is pending, and trimming from the end
 * guesses. Scanning for the matching bracket is exact, and cheap.
 */
export function sliceJson(text: string): { value: unknown; rest: string } | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return { value: JSON.parse(slice), rest: text.slice(i + 1).trim() };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface Decoded {
  ok: boolean;
  note?: string;
  value?: unknown;
  text: string;
}

export function decode(result: any): Decoded {
  const text = (result?.content ?? [])
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .join("\n");

  if (result?.isError) return { ok: false, text };

  // The note is commentary about the data rather than part of it, so it stays
  // in the text block and is lifted off here whichever way the value arrives.
  let body = text;
  let note: string | undefined;
  const noteMatch = /^NOTE: ([\s\S]*?)\n\n/.exec(body);
  if (noteMatch) {
    note = noteMatch[1];
    body = body.slice(noteMatch[0].length);
  }

  // The data comes back as structured content, so it is read rather than
  // recovered. `out` wraps a bare array or scalar under `result`; unwrap it so
  // the caller sees what the tool actually returned.
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") {
    const keys = Object.keys(structured);
    const value = keys.length === 1 && keys[0] === "result" ? structured.result : structured;
    return { ok: true, note, value, text: body };
  }

  // Fallback for a result that carries no structured content: the report
  // renderer hands back a document, and an embedder standing in its own server
  // may return whatever it likes. A failure to parse is a plain-text result,
  // not an error.
  const sliced = sliceJson(body);
  if (!sliced) return { ok: true, note, text: body };
  return { ok: true, note, value: sliced.value, text: body };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The array inside a list response, whatever the tool called it. */
function rowsOf(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value.every((v) => v && typeof v === "object") ? (value as any) : null;
  if (!value || typeof value !== "object") return null;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length && v.every((item) => item && typeof item === "object")) {
      return v as any;
    }
  }
  return null;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{…}";
  return String(v);
}

function csvCell(v: unknown): string {
  const s = cell(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

/**
 * A table sized to the terminal. Columns are dropped from the right rather than
 * wrapped, because a wrapped row is unreadable and the full record is one
 * `--json` away - and the count of what was dropped is printed, so nothing is
 * hidden silently.
 */
function toTable(rows: Record<string, unknown>[], width: number): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));

  const kept: number[] = [];
  let used = 0;
  for (let i = 0; i < cols.length; i++) {
    const w = Math.min(widths[i], 40) + 2;
    if (used + w > width && kept.length) break;
    kept.push(i);
    used += w;
  }

  const fmt = (values: string[]) =>
    kept.map((i, n) => values[n].slice(0, 40).padEnd(Math.min(widths[i], 40))).join("  ");

  const lines = [
    fmt(kept.map((i) => cols[i])),
    kept.map((i) => "─".repeat(Math.min(widths[i], 40))).join("  "),
    ...rows.map((r) => fmt(kept.map((i) => cell(r[cols[i]])))),
  ];
  if (kept.length < cols.length) {
    lines.push("", `${cols.length - kept.length} more column(s) hidden - use --json for the full records.`);
  }
  return lines.join("\n");
}

function renderObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  const pad = Math.max(...keys.map((k) => k.length));
  return keys.map((k) => `${k.padEnd(pad)}  ${cell(value[k])}`).join("\n");
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpText(commands: Command[]): string {
  const byToolset = new Map<string, Command[]>();
  for (const cmd of commands) {
    const set = TOOL_SPECS[cmd.tool]?.toolset ?? "other";
    if (!byToolset.has(set)) byToolset.set(set, []);
    byToolset.get(set)!.push(cmd);
  }

  const groups = [...byToolset.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([set, cmds]) => {
      const names = cmds.map((c) => c.canonical).sort();
      return `  ${set}\n${names.map((n) => `    hcp ${n}`).join("\n")}`;
    });

  return [
    `hcp v${VERSION} - the Housecall Pro API from a terminal.`,
    "",
    "Usage:",
    "  hcp <verb> <noun> [--flag value]      e.g. hcp list jobs --work-status completed",
    "  hcp <noun> <verb> [--flag value]      the same command, read the other way round",
    "",
    "Output:",
    "  --json              the full records, unformatted",
    "  --csv               comma-separated, for a spreadsheet or a scheduled export",
    "  (default)           a table sized to the terminal",
    "",
    "Safety:",
    "  --dry-run           print what a write would send, and send nothing",
    "  --read-only         refuse to run any command that changes Housecall Pro",
    "                      Also settable with HCP_READ_ONLY=1.",
    "",
    "Other:",
    "  --toolsets=a,b      limit the commands available. Also HCP_TOOLSETS.",
    `                      Groups: ${TOOLSETS.join(", ")}`,
    "  --describe          print the tool's own description and parameters, run nothing",
    "  --version, --help",
    "  hcp commands        every command, one per line (add --json for the full table)",
    "",
    "Reads HCP_API_KEY from the environment. It needs a Housecall Pro MAX plan and",
    "an admin login: My Apps, Go to App store, API Key Management.",
    "",
    "Commands:",
    ...groups,
  ].join("\n");
}

function describe(tool: CollectedTool): string {
  const fields = Object.entries(tool.schema);
  const lines = [`hcp ${commandFor(tool.name).canonical}   (${tool.name})`, "", tool.description, ""];
  if (!fields.length) {
    lines.push("Takes no parameters.");
    return lines.join("\n");
  }
  lines.push("Parameters:");
  const pad = Math.max(...fields.map(([k]) => k.length));
  for (const [key, node] of fields) {
    const optional = node?.isOptional?.() === true;
    const kind = typeNameOf(node).replace(/^Zod/, "").toLowerCase();
    const flag = `--${key.replace(/_/g, "-")}`;
    const desc = node?._def?.description ? ` ${node._def.description}` : "";
    lines.push(`  ${flag.padEnd(pad + 3)}  ${kind}${optional ? "" : "  (required)"}${desc}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const OUTPUT_FLAGS = new Set(["--json", "--csv", "--dry-run", "--describe", "--read-only", "--help", "-h", "--version"]);

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let options;
  try {
    options = parseSurfaceOptions(argv, process.env);
  } catch (e) {
    process.stderr.write(`hcp: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const apiKey = process.env.HCP_API_KEY;
  if (!apiKey) options.keyless = true;

  // Commands are resolved against the WHOLE surface, and availability is checked
  // separately. Resolving against the filtered set instead would answer a
  // disabled write with "unknown command", which sends the reader looking for a
  // typo in a command that exists and is simply switched off.
  const tools = collectTools(new HcpClient(apiKey ?? "keyless"), {
    readOnly: false,
    toolsets: [...TOOLSETS],
  });
  const { byCommand, commands } = buildIndex(tools.keys());

  // Everything that is not a flag, in order. The command is the longest leading
  // run of these that names something.
  const words = argv.filter((a) => !a.startsWith("-"));

  if (!words.length || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${helpText(commands)}\n`);
    return 0;
  }

  if (words[0] === "commands") {
    if (argv.includes("--json")) {
      const table = commands
        .map((c) => ({
          command: `hcp ${c.canonical}`,
          alias: c.reversed ? `hcp ${c.reversed}` : "",
          tool: c.tool,
          toolset: TOOL_SPECS[c.tool]?.toolset ?? "",
          writes: Boolean(TOOL_SPECS[c.tool]?.write),
        }))
        .sort((a, b) => a.command.localeCompare(b.command));
      process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
    } else {
      for (const c of commands.map((c) => `hcp ${c.canonical}`).sort()) process.stdout.write(`${c}\n`);
    }
    return 0;
  }

  // Try the two-word command first, then the one-word form.
  const twoWord = words.slice(0, 2).join(" ");
  const oneWord = words[0];
  const toolName = byCommand.get(twoWord) ?? byCommand.get(oneWord);
  const consumed = byCommand.has(twoWord) ? 2 : 1;

  if (!toolName) {
    process.stderr.write(`hcp: unknown command "${words.slice(0, 2).join(" ")}".\n`);
    // Suggest on any word the two share. A wrong verb against a real noun
    // ("hcp show jobs") and a wrong noun against a real verb ("hcp list job")
    // are the two ways this goes wrong, and each leaves one word intact.
    const typed = words.slice(0, 2);
    const near = commands
      .map((c) => c.canonical)
      .filter((c) => {
        const parts = c.split(/[ -]/);
        return typed.some((word) => parts.some((p) => p === word || p.startsWith(word) || word.startsWith(p)));
      })
      .slice(0, 8);
    if (near.length) process.stderr.write(`Did you mean:\n${near.map((n) => `  hcp ${n}`).join("\n")}\n`);
    process.stderr.write(`Run "hcp commands" for all of them.\n`);
    return 1;
  }

  const tool = tools.get(toolName)!;

  if (argv.includes("--describe")) {
    process.stdout.write(`${describe(tool)}\n`);
    return 0;
  }

  // Strip the command words and the CLI's own flags; everything else is the
  // tool's business. `--toolsets=` is matched by prefix because it carries a value.
  const rest = argv.filter(
    (a) => !OUTPUT_FLAGS.has(a) && !a.startsWith("--toolsets=") && !a.startsWith("--tools="),
  );
  const commandWords = words.slice(0, consumed);
  const toolTokens = rest.filter((a) => !commandWords.includes(a));

  const { args, positional } = parseArgs(toolTokens, tool.schema);
  const misplaced = applyPositional(args, positional, tool.schema);
  if (misplaced) {
    process.stderr.write(`hcp: ${misplaced}\nNothing was sent.\n`);
    return 1;
  }

  const isWrite = Boolean(TOOL_SPECS[toolName]?.write);
  const command = commandFor(toolName).canonical;

  // A real command that is switched off says which switch did it. Three
  // different settings can hide the same command and the fix differs for each.
  if (!shouldRegister(toolName, options)) {
    if (options.keyless) {
      process.stderr.write(
        `hcp: "${command}" needs a Housecall Pro account and there is no HCP_API_KEY in the environment.\n` +
          `Generate one under My Apps, Go to App store, API Key Management. It needs their MAX plan and an admin login.\n`,
      );
    } else if (isWrite && options.readOnly) {
      process.stderr.write(
        `hcp: "${command}" changes Housecall Pro, and this run is read-only.\n` +
          `Drop --read-only, or unset HCP_READ_ONLY, to allow it.\n`,
      );
    } else {
      const needed = TOOL_SPECS[toolName]?.toolset;
      process.stderr.write(
        `hcp: "${command}" is in the "${needed}" toolset, which this run did not select.\n` +
          `Add it: --toolsets=${[...new Set([...options.toolsets, needed])].join(",")}\n`,
      );
    }
    return 1;
  }

  if (argv.includes("--dry-run")) {
    process.stdout.write(
      [
        `Would call ${toolName} with:`,
        JSON.stringify(args, null, 2),
        "",
        isWrite
          ? "This command CHANGES Housecall Pro. Nothing was sent."
          : "This command only reads. Nothing was sent.",
      ].join("\n") + "\n",
    );
    return 0;
  }

  let result;
  try {
    result = await tool.handler(args, {});
  } catch (e) {
    process.stderr.write(`hcp: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const decoded = decode(result);

  if (!decoded.ok) {
    process.stderr.write(`${decoded.text}\n`);
    return 1;
  }

  if (argv.includes("--json")) {
    process.stdout.write(`${decoded.value === undefined ? decoded.text : JSON.stringify(decoded.value, null, 2)}\n`);
    return 0;
  }

  const rows = rowsOf(decoded.value);

  if (argv.includes("--csv")) {
    if (!rows) {
      process.stderr.write("hcp: this command does not return rows, so there is nothing to put in a CSV. Use --json.\n");
      return 1;
    }
    process.stdout.write(`${toCsv(rows)}\n`);
    return 0;
  }

  // A note earns stderr rather than stdout: it is commentary, and piping the
  // command into a file should get the data, not the commentary.
  if (decoded.note) process.stderr.write(`note: ${decoded.note}\n`);

  if (rows) {
    const width = process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : 120;
    process.stdout.write(`${toTable(rows, width)}\n`);
    if (decoded.value && typeof decoded.value === "object" && !Array.isArray(decoded.value)) {
      const meta = decoded.value as Record<string, unknown>;
      const bits = ["total_items", "total_pages", "page", "has_more"]
        .filter((k) => meta[k] !== undefined)
        .map((k) => `${k}=${meta[k]}`);
      if (bits.length) process.stderr.write(`${bits.join("  ")}\n`);
    }
    return 0;
  }

  if (decoded.value && typeof decoded.value === "object" && !Array.isArray(decoded.value)) {
    process.stdout.write(`${renderObject(decoded.value as Record<string, unknown>)}\n`);
    return 0;
  }

  process.stdout.write(`${decoded.value === undefined ? decoded.text : JSON.stringify(decoded.value, null, 2)}\n`);
  return 0;
}

// Only run when invoked as the binary, so the test harness can import the
// parsing and command-mapping pieces without the process exiting under it.
const invokedDirectly =
  process.argv[1] && /(?:^|[\\/])cli\.js$|(?:^|[\\/])hcp(?:\.[a-z]+)?$/.test(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`hcp: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
