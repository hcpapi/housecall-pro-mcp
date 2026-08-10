/**
 * Startup update check, disclosed in the README's Updating section.
 *
 * One GET to https://hcpapi.com/v/<product>/<installed-version>. The request
 * carries the product name and installed version in the URL path, and nothing
 * else: no API key, no account data, no query strings, no extra headers.
 *
 * Any failure -- network error, bad status, an HTML body, malformed JSON,
 * timeout -- resolves to "no update known" in total silence. The server never
 * waits on this check and never retries it.
 */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pkg = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};

/** The version of this installed package, straight from package.json. */
export const INSTALLED_VERSION: string = pkg.version;

const PRODUCT = "housecall-pro-mcp";
const CHECK_URL_BASE = "https://hcpapi.com/v/";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;

export interface VersionCheckOptions {
  /** Injectable fetch, so tests never touch the network. */
  fetch?: typeof globalThis.fetch;
  installedVersion?: string;
  cachePath?: string;
  timeoutMs?: number;
}

export interface VersionCheck {
  /**
   * Kick off the check. Fire-and-forget: never throws, never blocks a tool
   * call. Resolves to the update notice, or null when there is nothing to say.
   */
  start(): Promise<string | null>;
  /**
   * The update notice, exactly once: null before the check resolves, the
   * notice on the first call after it resolves with a newer version, and
   * null on every call after that.
   */
  consumeNotice(): string | null;
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric per-segment comparison, so 0.10.0 beats 0.9.9. */
function isNewer(installed: string, candidate: string): boolean {
  const a = parseVersion(installed);
  const b = parseVersion(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

interface CacheEntry {
  checkedAt: number;
  latest: string;
  url: string;
}

/** A missing, unreadable, or malformed cache file is the same as no cache. */
async function readCache(path: string): Promise<CacheEntry | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (
      raw &&
      typeof raw === "object" &&
      typeof raw.checkedAt === "number" &&
      typeof raw.latest === "string" &&
      typeof raw.url === "string"
    ) {
      return raw as CacheEntry;
    }
  } catch {
    /* treated as absent */
  }
  return null;
}

async function fetchLatest(
  fetchImpl: typeof globalThis.fetch,
  installedVersion: string,
  timeoutMs: number,
): Promise<{ latest: string; url: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    const res = await fetchImpl(`${CHECK_URL_BASE}${PRODUCT}/${installedVersion}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const entry = json?.products?.[PRODUCT];
    if (typeof entry?.version !== "string" || typeof entry?.url !== "string") {
      return null;
    }
    return { latest: entry.version, url: entry.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createVersionCheck(options: VersionCheckOptions = {}): VersionCheck {
  const installed = options.installedVersion ?? INSTALLED_VERSION;
  const cachePath =
    options.cachePath ?? join(tmpdir(), "housecall-pro-mcp-version-check.json");
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let notice: string | null = null;
  let consumed = false;
  let started: Promise<string | null> | undefined;

  async function run(): Promise<string | null> {
    try {
      let info: { latest: string; url: string } | null = null;
      const cached = await readCache(cachePath);
      const age = cached ? Date.now() - cached.checkedAt : Infinity;
      if (cached && age >= 0 && age <= CACHE_TTL_MS) {
        info = { latest: cached.latest, url: cached.url };
      } else {
        const fetchImpl = options.fetch ?? globalThis.fetch;
        info = await fetchLatest(fetchImpl, installed, timeoutMs);
        if (info) {
          const entry: CacheEntry = {
            checkedAt: Date.now(),
            latest: info.latest,
            url: info.url,
          };
          try {
            await writeFile(cachePath, JSON.stringify(entry));
          } catch {
            /* the cache is best-effort */
          }
        }
      }
      if (info && isNewer(installed, info.latest)) {
        notice =
          `A newer version of ${PRODUCT} is available: ${installed} -> ${info.latest}. ` +
          `See the Updating section of the README (https://github.com/hcpapi/housecall-pro-mcp#updating).`;
        return notice;
      }
      return null;
    } catch {
      return null;
    }
  }

  return {
    start() {
      if (!started) started = run();
      return started;
    },
    consumeNotice() {
      if (consumed || notice === null) return null;
      consumed = true;
      return notice;
    },
  };
}

/** The instance the running server uses. Tests build their own with injected options. */
export const versionCheck: VersionCheck = createVersionCheck();
