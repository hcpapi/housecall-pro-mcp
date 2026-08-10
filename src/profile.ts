/**
 * The business profile: what a skill's first-run interview learns about the
 * shop, kept on the machine this server runs on so no skill asks twice.
 *
 * Tool surface, wired up in the tool registration:
 *
 *   hcp_get_business_profile -> readBusinessProfile()   no arguments; returns
 *                                every stored section, when each was last
 *                                confirmed, the file location, and a note when
 *                                the file could not be used
 *   hcp_set_business_profile -> setBusinessProfile(sections)  one or more
 *                                sections; each replaces the stored section
 *                                whole, and null clears one
 *
 * Where the file lives, in order of precedence:
 *
 *   1. the HCP_MCP_PROFILE_PATH environment variable, when it names a file
 *   2. %APPDATA%/housecall-pro-mcp/profile.json on Windows, or
 *      $XDG_CONFIG_HOME/housecall-pro-mcp/profile.json elsewhere
 *   3. <home>/.config/housecall-pro-mcp/profile.json as the last resort
 *
 * Per machine by design, like the defaults file it sits beside, and never
 * transmitted: nothing here is sent to Housecall Pro or anywhere else.
 *
 * The top-level sections are a closed set - shop, vendors, pricing, payroll,
 * comms - so a caller cannot park arbitrary data here by inventing a key. And
 * the sections hold the SHOP's own facts, never a customer's: no customer
 * names, no credentials, no full account numbers. The one field that hints at
 * an account (a vendor's account_hint) refuses anything with a long digit run
 * so a full number cannot be stored even on purpose.
 *
 * Sections are replaced whole rather than merged. The interview convention
 * reads a whole section back for a yes before saving, so the confirmed unit
 * IS the section; merging would let a stale half survive a re-interview. Each
 * write stamps the section's confirmed date, which is how a skill decides a
 * section is stale enough to re-confirm.
 *
 * Every failure is soft, exactly as with the defaults file: a missing file, an
 * unreadable one, malformed JSON each read back as "no profile yet" plus a
 * note saying why. readBusinessProfile never rejects and never throws.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DIR_NAME = "housecall-pro-mcp";
const FILE_NAME = "profile.json";

/** Names the profile file outright, ahead of any platform convention. */
export const PROFILE_PATH_ENV_VAR = "HCP_MCP_PROFILE_PATH";

/* ------------------------------------------------------------ sections ---- */

export interface ShopSection {
  trade?: string[];
  region?: string;
  team_size?: number;
  peer_group?: string;
}

export interface VendorEntry {
  name: string;
  /** A shipped vendor pack this vendor matches ("ferguson", "supplyhouse", ...), if any. */
  pack?: string | null;
  delivery?: string;
  /** Deliberately weak: a branch name or last digits, never a full account number. */
  account_hint?: string;
  /** A layout learned from one of the vendor's own documents, saved by the skill. */
  custom_format?: Record<string, unknown> | null;
}

export interface PricingSection {
  margin_floor_pct?: number;
  category_overrides?: { category: string; floor_pct: number }[];
  rounding?: string;
}

export interface PayrollSection {
  pay_week_start?: string;
  commission_rules?: { who: string; basis: string; pct: number; applies_to?: string }[];
}

export interface CommsSection {
  sender_name?: string;
  voice_sample?: string;
  followup_cadence_days?: number[];
}

export interface BusinessProfile {
  shop?: ShopSection;
  vendors?: VendorEntry[];
  pricing?: PricingSection;
  payroll?: PayrollSection;
  comms?: CommsSection;
}

export type ProfileSectionKey = keyof BusinessProfile;

/** ISO dates of the last confirmed write, one per stored section. */
export type ProfileConfirmed = Partial<Record<ProfileSectionKey, string>>;

export const DELIVERY_KINDS = [
  "email-pdf",
  "email-html",
  "portal-pdf",
  "portal-csv",
  "paper",
  "edi",
  "other",
];

export const ROUNDING_KINDS = [".00", ".95", ".99", "none"];
export const COMMISSION_BASES = ["job_revenue", "job_margin"];
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

type Checked<T> = { ok: true; value: T } | { ok: false; why: string };

function fail<T>(why: string): Checked<T> {
  return { ok: false, why };
}

function text(value: unknown, what: string, max: number): Checked<string> {
  if (typeof value !== "string") return fail(`${what} must be text`);
  const t = value.trim();
  if (!t) return fail(`${what} must not be blank`);
  if (t.length > max) return fail(`${what} must be ${max} characters or fewer`);
  return { ok: true, value: t };
}

function oneOf(value: unknown, what: string, accepted: string[]): Checked<string> {
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!accepted.includes(t)) return fail(`${what} must be one of ${accepted.join(", ")}`);
  return { ok: true, value: t };
}

function pct(value: unknown, what: string): Checked<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(`${what} must be a number`);
  }
  if (value < 0 || value > 100) return fail(`${what} must be between 0 and 100`);
  return { ok: true, value };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The guard that keeps account numbers out of the one field that gestures at
 * one. Eight consecutive digits is shorter than any card or bank number and
 * longer than any honest hint, so it is where the line is drawn.
 */
function looksLikeAccountNumber(s: string): boolean {
  return /\d{8,}/.test(s.replace(/[\s-]/g, ""));
}

function checkShop(value: unknown): Checked<ShopSection> {
  if (!isPlainObject(value)) return fail("shop must be an object");
  const out: ShopSection = {};
  if (value.trade !== undefined) {
    if (!Array.isArray(value.trade) || value.trade.length > 6) {
      return fail("shop.trade must be a list of at most 6 trades");
    }
    const trades: string[] = [];
    for (const t of value.trade) {
      const c = text(t, "each shop.trade entry", 40);
      if (!c.ok) return c;
      trades.push(c.value);
    }
    out.trade = trades;
  }
  if (value.region !== undefined) {
    const c = text(value.region, "shop.region", 80);
    if (!c.ok) return c;
    out.region = c.value;
  }
  if (value.team_size !== undefined) {
    const n = value.team_size;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 500) {
      return fail("shop.team_size must be a whole number between 1 and 500");
    }
    out.team_size = n;
  }
  if (value.peer_group !== undefined) {
    const c = text(value.peer_group, "shop.peer_group", 40);
    if (!c.ok) return c;
    out.peer_group = c.value;
  }
  return { ok: true, value: out };
}

function checkVendors(value: unknown): Checked<VendorEntry[]> {
  if (!Array.isArray(value)) return fail("vendors must be a list");
  if (value.length > 25) return fail("vendors must hold at most 25 entries");
  const out: VendorEntry[] = [];
  for (const [i, raw] of value.entries()) {
    const what = `vendors[${i}]`;
    if (!isPlainObject(raw)) return fail(`${what} must be an object`);
    const name = text(raw.name, `${what}.name`, 60);
    if (!name.ok) return name;
    const entry: VendorEntry = { name: name.value };
    if (raw.pack !== undefined && raw.pack !== null) {
      const c = text(raw.pack, `${what}.pack`, 40);
      if (!c.ok) return c;
      entry.pack = c.value.toLowerCase();
    } else if (raw.pack === null) {
      entry.pack = null;
    }
    if (raw.delivery !== undefined) {
      const c = oneOf(raw.delivery, `${what}.delivery`, DELIVERY_KINDS);
      if (!c.ok) return c;
      entry.delivery = c.value;
    }
    if (raw.account_hint !== undefined) {
      const c = text(raw.account_hint, `${what}.account_hint`, 20);
      if (!c.ok) return c;
      if (looksLikeAccountNumber(c.value)) {
        return fail(
          `${what}.account_hint looks like a full account number; store a branch name or the last few digits only`,
        );
      }
      entry.account_hint = c.value;
    }
    if (raw.custom_format !== undefined && raw.custom_format !== null) {
      if (!isPlainObject(raw.custom_format)) {
        return fail(`${what}.custom_format must be an object`);
      }
      const serialized = JSON.stringify(raw.custom_format);
      if (serialized.length > 4000) {
        return fail(`${what}.custom_format is too large; keep the learned layout under 4000 characters`);
      }
      entry.custom_format = raw.custom_format;
    } else if (raw.custom_format === null) {
      entry.custom_format = null;
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function checkPricing(value: unknown): Checked<PricingSection> {
  if (!isPlainObject(value)) return fail("pricing must be an object");
  const out: PricingSection = {};
  if (value.margin_floor_pct !== undefined) {
    const c = pct(value.margin_floor_pct, "pricing.margin_floor_pct");
    if (!c.ok) return c;
    out.margin_floor_pct = c.value;
  }
  if (value.category_overrides !== undefined) {
    if (!Array.isArray(value.category_overrides) || value.category_overrides.length > 40) {
      return fail("pricing.category_overrides must be a list of at most 40 entries");
    }
    const overrides: { category: string; floor_pct: number }[] = [];
    for (const [i, raw] of value.category_overrides.entries()) {
      const what = `pricing.category_overrides[${i}]`;
      if (!isPlainObject(raw)) return fail(`${what} must be an object`);
      const cat = text(raw.category, `${what}.category`, 80);
      if (!cat.ok) return cat;
      const floor = pct(raw.floor_pct, `${what}.floor_pct`);
      if (!floor.ok) return floor;
      overrides.push({ category: cat.value, floor_pct: floor.value });
    }
    out.category_overrides = overrides;
  }
  if (value.rounding !== undefined) {
    const t = typeof value.rounding === "string" ? value.rounding.trim() : "";
    if (!ROUNDING_KINDS.includes(t)) {
      return fail(`pricing.rounding must be one of ${ROUNDING_KINDS.join(", ")}`);
    }
    out.rounding = t;
  }
  return { ok: true, value: out };
}

function checkPayroll(value: unknown): Checked<PayrollSection> {
  if (!isPlainObject(value)) return fail("payroll must be an object");
  const out: PayrollSection = {};
  if (value.pay_week_start !== undefined) {
    const c = oneOf(value.pay_week_start, "payroll.pay_week_start", WEEKDAYS);
    if (!c.ok) return c;
    out.pay_week_start = c.value;
  }
  if (value.commission_rules !== undefined) {
    if (!Array.isArray(value.commission_rules) || value.commission_rules.length > 20) {
      return fail("payroll.commission_rules must be a list of at most 20 entries");
    }
    const rules: { who: string; basis: string; pct: number; applies_to?: string }[] = [];
    for (const [i, raw] of value.commission_rules.entries()) {
      const what = `payroll.commission_rules[${i}]`;
      if (!isPlainObject(raw)) return fail(`${what} must be an object`);
      const who = text(raw.who, `${what}.who`, 60);
      if (!who.ok) return who;
      const basis = oneOf(raw.basis, `${what}.basis`, COMMISSION_BASES);
      if (!basis.ok) return basis;
      const p = pct(raw.pct, `${what}.pct`);
      if (!p.ok) return p;
      const rule: { who: string; basis: string; pct: number; applies_to?: string } = {
        who: who.value,
        basis: basis.value,
        pct: p.value,
      };
      if (raw.applies_to !== undefined) {
        const a = text(raw.applies_to, `${what}.applies_to`, 80);
        if (!a.ok) return a;
        rule.applies_to = a.value;
      }
      rules.push(rule);
    }
    out.commission_rules = rules;
  }
  return { ok: true, value: out };
}

function checkComms(value: unknown): Checked<CommsSection> {
  if (!isPlainObject(value)) return fail("comms must be an object");
  const out: CommsSection = {};
  if (value.sender_name !== undefined) {
    const c = text(value.sender_name, "comms.sender_name", 60);
    if (!c.ok) return c;
    out.sender_name = c.value;
  }
  if (value.voice_sample !== undefined) {
    const c = text(value.voice_sample, "comms.voice_sample", 600);
    if (!c.ok) return c;
    out.voice_sample = c.value;
  }
  if (value.followup_cadence_days !== undefined) {
    if (!Array.isArray(value.followup_cadence_days) || value.followup_cadence_days.length > 10) {
      return fail("comms.followup_cadence_days must be a list of at most 10 day counts");
    }
    const days: number[] = [];
    for (const d of value.followup_cadence_days) {
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 365) {
        return fail("each comms.followup_cadence_days entry must be a whole number of days between 1 and 365");
      }
      days.push(d);
    }
    out.followup_cadence_days = days;
  }
  return { ok: true, value: out };
}

interface SectionSpec {
  description: string;
  check(value: unknown): Checked<BusinessProfile[ProfileSectionKey]>;
}

/**
 * The closed set of sections. Adding one here is the only way to widen what
 * this file can hold, which is what keeps everything else out of it.
 */
const SECTION_SPECS: Record<ProfileSectionKey, SectionSpec> = {
  shop: {
    description:
      "Who the shop is: trade(s), region, team size, and any peer group they benchmark against.",
    check: checkShop,
  },
  vendors: {
    description:
      "Who they buy from: vendor name, a shipped pack name when one matches, how purchase documents arrive, an account hint (never a full number), and any learned custom layout.",
    check: checkVendors,
  },
  pricing: {
    description:
      "Pricing rules: the margin floor, per-category overrides, and how prices are rounded.",
    check: checkPricing,
  },
  payroll: {
    description: "Payroll rules: when the pay week starts and the commission rules by role.",
    check: checkPayroll,
  },
  comms: {
    description:
      "How outbound messages should sound: sender name, a short voice sample in the shop's own tone, and the follow-up cadence in days.",
    check: checkComms,
  },
};

export const PROFILE_SECTION_KEYS: ProfileSectionKey[] = Object.keys(
  SECTION_SPECS,
) as ProfileSectionKey[];

export const PROFILE_SECTION_DESCRIPTIONS: Record<ProfileSectionKey, string> = Object.fromEntries(
  PROFILE_SECTION_KEYS.map((key) => [key, SECTION_SPECS[key].description]),
) as Record<ProfileSectionKey, string>;

/* ------------------------------------------------------------ the store ---- */

export interface ProfileStoreOptions {
  /** Full path to the profile file, ahead of the environment variable. */
  path?: string;
  /** Injectable environment, so a test never reads or writes a real user directory. */
  env?: NodeJS.ProcessEnv;
  /** Injectable platform, so path resolution is testable on and off Windows. */
  platform?: NodeJS.Platform;
  /** Injectable home directory, used only by the last-resort fallback. */
  home?: string;
  /** Injectable clock for the confirmed stamps, so tests are deterministic. */
  today?: () => string;
}

/** Where the profile file is, whether or not anything has been written to it. */
export function resolveProfilePath(options: ProfileStoreOptions = {}): string {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const override = env[PROFILE_PATH_ENV_VAR]?.trim();
  if (override) return override;

  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const base =
    platform === "win32"
      ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, DIR_NAME, FILE_NAME);
}

export interface ProfileReadResult {
  /** Every stored section. Empty when none are set, and empty when the file could not be used. */
  profile: BusinessProfile;
  /** When each stored section was last confirmed, as an ISO date. */
  confirmed: ProfileConfirmed;
  /** Sections with nothing stored - what a first-run interview still has to ask. */
  missing_sections: ProfileSectionKey[];
  /** Where the file is, whether or not it exists. */
  path: string;
  /** Set only when something was wrong with the file. Callers surface it. */
  note?: string;
}

export interface ProfileWriteResult {
  /** False when nothing was stored, in which case the file is unchanged. */
  ok: boolean;
  profile: BusinessProfile;
  confirmed: ProfileConfirmed;
  path: string;
  /** The sections this call changed, in the order they were given. */
  written: ProfileSectionKey[];
  /** Sections that were not stored, each with the reason. Empty on a clean write. */
  ignored: { key: string; why: string }[];
  /** Set when the caller needs to be told something. Callers surface it. */
  note?: string;
}

function reason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code) return code;
  return e instanceof Error ? e.message : String(e);
}

function isSectionKey(key: string): key is ProfileSectionKey {
  return Object.prototype.hasOwnProperty.call(SECTION_SPECS, key);
}

interface StoredShape {
  profile: BusinessProfile;
  confirmed: ProfileConfirmed;
  dropped: string[];
}

/** Keeps the recognised, valid sections and reports the rest by name. */
function select(source: Record<string, unknown>): StoredShape {
  const profile: BusinessProfile = {};
  const confirmed: ProfileConfirmed = {};
  const dropped: string[] = [];

  const rawSections = isPlainObject(source.profile) ? source.profile : source;
  const rawConfirmed = isPlainObject(source.confirmed) ? source.confirmed : {};

  for (const [key, value] of Object.entries(rawSections)) {
    if (!isSectionKey(key)) {
      // The wrapper keys of our own file shape are not stray data.
      if (key !== "profile" && key !== "confirmed") dropped.push(key);
      continue;
    }
    const checked = SECTION_SPECS[key].check(value);
    if (!checked.ok) {
      dropped.push(key);
      continue;
    }
    (profile as Record<string, unknown>)[key] = checked.value;
    const stamp = rawConfirmed[key];
    if (typeof stamp === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
      confirmed[key] = stamp;
    }
  }
  return { profile, confirmed, dropped };
}

function missing(profile: BusinessProfile): ProfileSectionKey[] {
  return PROFILE_SECTION_KEYS.filter((key) => profile[key] === undefined);
}

/** A stable section order and a trailing newline, since a buyer may open this file. */
function serialize(profile: BusinessProfile, confirmed: ProfileConfirmed): string {
  const orderedProfile: Record<string, unknown> = {};
  const orderedConfirmed: Record<string, string> = {};
  for (const key of PROFILE_SECTION_KEYS) {
    if (profile[key] !== undefined) orderedProfile[key] = profile[key];
    const stamp = confirmed[key];
    if (stamp && profile[key] !== undefined) orderedConfirmed[key] = stamp;
  }
  return `${JSON.stringify({ profile: orderedProfile, confirmed: orderedConfirmed }, null, 2)}\n`;
}

/**
 * Reads the stored profile. Anything wrong with the file reads back as an
 * empty profile plus a note; this never rejects.
 */
export async function readBusinessProfile(
  options: ProfileStoreOptions = {},
): Promise<ProfileReadResult> {
  let path = "";
  try {
    path = resolveProfilePath(options);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return { profile: {}, confirmed: {}, missing_sections: missing({}), path };
      }
      return {
        profile: {},
        confirmed: {},
        missing_sections: missing({}),
        path,
        note: `No profile is in effect: ${path} could not be read (${reason(e)}).`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        profile: {},
        confirmed: {},
        missing_sections: missing({}),
        path,
        note: `No profile is in effect: ${path} is not valid JSON. Saving a section rewrites the file.`,
      };
    }

    if (!isPlainObject(parsed)) {
      return {
        profile: {},
        confirmed: {},
        missing_sections: missing({}),
        path,
        note: `No profile is in effect: ${path} does not hold a JSON object. Saving a section rewrites the file.`,
      };
    }

    const { profile, confirmed, dropped } = select(parsed);
    const note = dropped.length
      ? `Ignored ${dropped.length} unusable entr${dropped.length === 1 ? "y" : "ies"} in ${path}: ${dropped.join(", ")}.`
      : undefined;
    return { profile, confirmed, missing_sections: missing(profile), path, note };
  } catch (e) {
    return {
      profile: {},
      confirmed: {},
      missing_sections: missing({}),
      path,
      note: `No profile is in effect: the profile file could not be read (${reason(e)}).`,
    };
  }
}

/**
 * Stores one or more sections. Each section replaces the stored section whole
 * rather than merging into it - the interview confirms whole sections, so a
 * partial merge would let a stale half survive a re-interview. A null clears
 * a section. Unrecognised sections and invalid shapes are refused by name and
 * change nothing.
 */
export async function setBusinessProfile(
  sections: Record<string, unknown>,
  options: ProfileStoreOptions = {},
): Promise<ProfileWriteResult> {
  const current = await readBusinessProfile(options);
  const path = current.path;
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const profile: BusinessProfile = { ...current.profile };
  const confirmed: ProfileConfirmed = { ...current.confirmed };
  const written: ProfileSectionKey[] = [];
  const ignored: { key: string; why: string }[] = [];

  for (const [key, value] of Object.entries(sections ?? {})) {
    if (!isSectionKey(key)) {
      ignored.push({
        key,
        why: `not a profile section; the accepted sections are ${PROFILE_SECTION_KEYS.join(", ")}`,
      });
      continue;
    }
    if (value === null) {
      delete profile[key];
      delete confirmed[key];
      written.push(key);
      continue;
    }
    const checked = SECTION_SPECS[key].check(value);
    if (!checked.ok) {
      ignored.push({ key, why: checked.why });
      continue;
    }
    (profile as Record<string, unknown>)[key] = checked.value;
    confirmed[key] = today();
    written.push(key);
  }

  if (!written.length) {
    return {
      ok: false,
      profile: current.profile,
      confirmed: current.confirmed,
      path,
      written,
      ignored,
      note: "Nothing was stored, so the profile is unchanged.",
    };
  }

  const temp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, serialize(profile, confirmed), "utf8");
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {
      /* nothing to clean up */
    });
    return {
      ok: false,
      profile: current.profile,
      confirmed: current.confirmed,
      path,
      written: [],
      ignored,
      note: `Nothing was stored: ${path} could not be written (${reason(e)}).`,
    };
  }

  return { ok: true, profile, confirmed, path, written, ignored };
}
