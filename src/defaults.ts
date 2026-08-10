/**
 * Shop defaults: the small preferences file this server keeps on the machine
 * it runs on, so a default confirmed once survives into later conversations.
 *
 * Intended tool surface, wired up in the tool registration by a later change:
 *
 *   hcp_get_defaults -> readDefaults()        no arguments; returns every
 *                                             stored preference, its file
 *                                             location, and a note when the
 *                                             file could not be used
 *   hcp_set_defaults -> setDefaults(values)   one or more keys; each replaces
 *                                             the stored value, and null
 *                                             clears one
 *
 * DEFAULT_KEYS and DEFAULT_KEY_DESCRIPTIONS carry the accepted keys and what
 * each one means, so the tool schema can be built from them rather than
 * restated.
 *
 * Where the file lives, in order of precedence:
 *
 *   1. the HCP_MCP_DEFAULTS_PATH environment variable, when it names a file
 *   2. %APPDATA%/housecall-pro-mcp/defaults.json on Windows, or
 *      $XDG_CONFIG_HOME/housecall-pro-mcp/defaults.json elsewhere
 *   3. <home>/.config/housecall-pro-mcp/defaults.json as the last resort
 *      (<home>/AppData/Roaming/... on Windows)
 *
 * That location is per machine by design, not per Housecall Pro account. The
 * file belongs to the installed server, so a shop running this on two
 * computers sets its defaults on each one. Nothing here is synchronised
 * anywhere, and nothing here is sent to Housecall Pro.
 *
 * Only the shop's own preferences go in it. The accepted keys are a closed
 * set, so a caller cannot park a customer, a job, an address or an API key in
 * this file by inventing a key name: an unrecognised key is refused on write
 * and dropped on read.
 *
 * Every failure is soft. A missing file, an unreadable one, malformed JSON, a
 * directory that cannot be created: each reads back as "no defaults set", with
 * a note saying why. readDefaults never rejects and never throws, because a
 * booking must not fail on account of this file.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DIR_NAME = "housecall-pro-mcp";
const FILE_NAME = "defaults.json";

/** Names the settings file outright, ahead of any platform convention. */
export const DEFAULTS_PATH_ENV_VAR = "HCP_MCP_DEFAULTS_PATH";

type DefaultValue = number | string;

type Coerced = { ok: true; value: DefaultValue } | { ok: false; why: string };

interface KeySpec {
  /** What the preference means, in the words a tool description can reuse. */
  description: string;
  /** Validates one candidate value. Returns the reason on refusal; never throws. */
  coerce(value: unknown): Coerced;
}

/** The shop's own preferences. Nothing about a customer or a job belongs here. */
export interface ShopDefaults {
  job_duration_minutes?: number;
  arrival_window_minutes?: number;
  service_line_item_name?: string;
}

export type DefaultKey = keyof ShopDefaults;

function wholeMinutes(min: number, max: number): KeySpec["coerce"] {
  return (value: unknown): Coerced => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { ok: false, why: "must be a whole number of minutes" };
    }
    if (value < min || value > max) {
      return { ok: false, why: `must be between ${min} and ${max} minutes` };
    }
    return { ok: true, value };
  };
}

/**
 * The arrival-window widths Housecall Pro accepts. Any other width is refused
 * by the API when the booking is written, so storing one as a default would
 * only surface as a failure later, on a job somebody was trying to book.
 */
export const ARRIVAL_WINDOW_MINUTES = [0, 15, 20, 60, 120, 180, 240];

function oneOfMinutes(accepted: number[]): KeySpec["coerce"] {
  return (value: unknown): Coerced => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { ok: false, why: "must be a whole number of minutes" };
    }
    if (!accepted.includes(value)) {
      return { ok: false, why: `must be one of ${accepted.join(", ")} minutes` };
    }
    return { ok: true, value };
  };
}

function shortText(max: number): KeySpec["coerce"] {
  return (value: unknown): Coerced => {
    if (typeof value !== "string") return { ok: false, why: "must be text" };
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, why: "must not be blank" };
    if (trimmed.length > max) {
      return { ok: false, why: `must be ${max} characters or fewer` };
    }
    return { ok: true, value: trimmed };
  };
}

/**
 * The closed set of accepted keys. Adding one here is the only way to widen
 * what this file can hold, which is what keeps account data out of it.
 */
const KEY_SPECS: Record<DefaultKey, KeySpec> = {
  job_duration_minutes: {
    description: "How long a job is scheduled for when nobody says otherwise.",
    // A default longer than a day is a data-entry slip, not a preference.
    coerce: wholeMinutes(1, 1440),
  },
  arrival_window_minutes: {
    description:
      "How wide the arrival window quoted to the customer is by default. 0 means an exact time.",
    coerce: oneOfMinutes(ARRIVAL_WINDOW_MINUTES),
  },
  service_line_item_name: {
    description: "The name of the line item most jobs start from.",
    coerce: shortText(200),
  },
};

/** Every accepted key, in the order they are written to the file. */
export const DEFAULT_KEYS: DefaultKey[] = Object.keys(KEY_SPECS) as DefaultKey[];

/** What each key means, for a tool schema that would otherwise restate it. */
export const DEFAULT_KEY_DESCRIPTIONS: Record<DefaultKey, string> = Object.fromEntries(
  DEFAULT_KEYS.map((key) => [key, KEY_SPECS[key].description]),
) as Record<DefaultKey, string>;

export interface DefaultsStoreOptions {
  /** Full path to the settings file, ahead of the environment variable. */
  path?: string;
  /** Injectable environment, so a test never reads or writes a real user directory. */
  env?: NodeJS.ProcessEnv;
  /** Injectable platform, so path resolution is testable on and off Windows. */
  platform?: NodeJS.Platform;
  /** Injectable home directory, used only by the last-resort fallback. */
  home?: string;
}

/** Where the settings file is, whether or not anything has been written to it. */
export function resolveDefaultsPath(options: DefaultsStoreOptions = {}): string {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const override = env[DEFAULTS_PATH_ENV_VAR]?.trim();
  if (override) return override;

  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const base =
    platform === "win32"
      ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, DIR_NAME, FILE_NAME);
}

export interface DefaultsReadResult {
  /** Every stored preference. Empty when none are set, and empty when the file could not be used. */
  defaults: ShopDefaults;
  /** Where the file is, whether or not it exists. */
  path: string;
  /** Set only when something was wrong with the file. Callers surface it. */
  note?: string;
}

export interface DefaultsWriteResult {
  /** False when nothing was stored, in which case the file is unchanged. */
  ok: boolean;
  /** Every stored preference after the write. */
  defaults: ShopDefaults;
  path: string;
  /** The keys this call changed, in the order they were given. */
  written: DefaultKey[];
  /** Keys that were not stored, each with the reason. Empty on a clean write. */
  ignored: { key: string; why: string }[];
  /** Set when the caller needs to be told something. Callers surface it. */
  note?: string;
}

/** An error's code where there is one, since that is what names the failure. */
function reason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code) return code;
  return e instanceof Error ? e.message : String(e);
}

function isDefaultKey(key: string): key is DefaultKey {
  return Object.prototype.hasOwnProperty.call(KEY_SPECS, key);
}

function put(defaults: ShopDefaults, key: DefaultKey, value: DefaultValue): void {
  // One cast: the per-key specs already narrowed the value to this key's type.
  (defaults as Record<string, DefaultValue>)[key] = value;
}

/** Keeps the recognised, valid entries and reports the rest by name. */
function select(source: Record<string, unknown>): {
  defaults: ShopDefaults;
  dropped: string[];
} {
  const defaults: ShopDefaults = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!isDefaultKey(key)) {
      dropped.push(key);
      continue;
    }
    const coerced = KEY_SPECS[key].coerce(value);
    if (!coerced.ok) {
      dropped.push(key);
      continue;
    }
    put(defaults, key, coerced.value);
  }
  return { defaults, dropped };
}

/** A stable key order and a trailing newline, since a buyer may open this file. */
function serialize(defaults: ShopDefaults): string {
  const ordered: Record<string, DefaultValue> = {};
  for (const key of DEFAULT_KEYS) {
    const value = (defaults as Record<string, DefaultValue | undefined>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Reads the stored preferences. Anything wrong with the file reads back as no
 * preferences plus a note; this never rejects.
 */
export async function readDefaults(
  options: DefaultsStoreOptions = {},
): Promise<DefaultsReadResult> {
  let path = "";
  try {
    path = resolveDefaultsPath(options);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      // No file yet is the ordinary case on a fresh install, not a problem.
      if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return { defaults: {}, path };
      }
      return {
        defaults: {},
        path,
        note: `No defaults are in effect: ${path} could not be read (${reason(e)}).`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        defaults: {},
        path,
        note: `No defaults are in effect: ${path} is not valid JSON. Setting a default rewrites the file.`,
      };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        defaults: {},
        path,
        note: `No defaults are in effect: ${path} does not hold a JSON object. Setting a default rewrites the file.`,
      };
    }

    const { defaults, dropped } = select(parsed as Record<string, unknown>);
    const note = dropped.length
      ? `Ignored ${dropped.length} unusable entr${dropped.length === 1 ? "y" : "ies"} in ${path}: ${dropped.join(", ")}.`
      : undefined;
    return { defaults, path, note };
  } catch (e) {
    return {
      defaults: {},
      path,
      note: `No defaults are in effect: the defaults file could not be read (${reason(e)}).`,
    };
  }
}

/**
 * Stores one or more preferences. Each key replaces the value already there
 * rather than adding to it, and a null value clears the key. Unrecognised keys
 * and values outside their range are refused by name and change nothing.
 */
export async function setDefaults(
  values: Record<string, unknown>,
  options: DefaultsStoreOptions = {},
): Promise<DefaultsWriteResult> {
  const current = await readDefaults(options);
  const path = current.path;
  const next: ShopDefaults = { ...current.defaults };
  const written: DefaultKey[] = [];
  const ignored: { key: string; why: string }[] = [];

  for (const [key, value] of Object.entries(values ?? {})) {
    if (!isDefaultKey(key)) {
      ignored.push({
        key,
        why: `not a shop preference; the accepted keys are ${DEFAULT_KEYS.join(", ")}`,
      });
      continue;
    }
    if (value === null) {
      delete next[key];
      written.push(key);
      continue;
    }
    const coerced = KEY_SPECS[key].coerce(value);
    if (!coerced.ok) {
      ignored.push({ key, why: coerced.why });
      continue;
    }
    put(next, key, coerced.value);
    written.push(key);
  }

  if (!written.length) {
    return {
      ok: false,
      defaults: current.defaults,
      path,
      written,
      ignored,
      note: "Nothing was stored, so the defaults are unchanged.",
    };
  }

  // Write beside the target and rename over it, so an interrupted write leaves
  // the previous file intact rather than a truncated one.
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, serialize(next), "utf8");
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {
      /* nothing to clean up */
    });
    return {
      ok: false,
      defaults: current.defaults,
      path,
      written: [],
      ignored,
      note: `Nothing was stored: ${path} could not be written (${reason(e)}).`,
    };
  }

  return { ok: true, defaults: next, path, written, ignored };
}
