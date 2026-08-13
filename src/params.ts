/**
 * Refusing a parameter a tool does not define.
 *
 * An unrecognised query parameter is dropped by Housecall Pro rather than
 * refused, and the MCP SDK strips an argument the tool's schema does not name
 * before the tool ever sees it - so an invented filter name becomes NO filter,
 * and the answer that comes back is the whole account wearing the shape of a
 * narrow one. That is the worst failure available here: it is not an error, it
 * looks authoritative, and it is wrong. A revenue figure, an aging list or a
 * campaign audience built that way is silently too big.
 *
 * So an undeclared parameter is refused before anything is sent, and the
 * refusal names what was not recognised, what to use instead, and every
 * parameter the tool does take. The suggestion is deliberately simple - a
 * shared prefix, then an edit distance - because it only has to be good enough
 * to turn a dead end into the next call.
 */

/** A shared prefix this long is treated as a near miss (scheduled_start_...). */
const MIN_SHARED_PREFIX = 4;

/** Beyond this many single-character edits, two names are not the same idea. */
const MAX_EDITS = 3;

/** More than this many guesses is noise rather than help. */
const MAX_SUGGESTIONS = 3;

/** Single-character edits between two strings (insert, delete, substitute). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** How many leading characters two names have in common. */
export function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * The declared names closest to one that was not recognised, best first.
 *
 * A long shared prefix wins first: scheduled_start_date_from is not within any
 * sane edit distance of scheduled_start_min, but it is obviously reaching for
 * the same family, and naming both ends of that family is more use than naming
 * neither. Ties are broken by edit distance, so pages resolves to page rather
 * than dragging page_size along with it. Failing a prefix, a plain typo is
 * caught by edit distance alone. Nothing close returns nothing: a wrong guess
 * offered confidently is worse than none.
 */
export function suggestParameters(unrecognised: string, declared: string[]): string[] {
  const needle = unrecognised.toLowerCase();
  const scored = declared.map((name) => ({
    name,
    prefix: sharedPrefix(needle, name.toLowerCase()),
    edits: editDistance(needle, name.toLowerCase()),
  }));

  const bestPrefix = Math.max(0, ...scored.map((s) => s.prefix));
  if (bestPrefix >= MIN_SHARED_PREFIX) {
    // The whole family, not the nearest member of it. scheduled_start_date_from
    // is nearer to scheduled_start_max by raw edits and means
    // scheduled_start_min, so picking one would be picking the wrong one -
    // naming both ends leaves the choice where the knowledge is.
    return scored
      .filter((s) => s.prefix === bestPrefix)
      .sort((a, b) => a.edits - b.edits || a.name.localeCompare(b.name))
      .slice(0, MAX_SUGGESTIONS)
      .map((s) => s.name)
      .sort();
  }

  // No family: a plain typo, or nothing at all. One guess or none.
  const pool = scored.filter((s) => s.edits <= MAX_EDITS);
  if (pool.length === 0) return [];
  const bestEdits = Math.min(...pool.map((s) => s.edits));
  return pool
    .filter((s) => s.edits === bestEdits)
    .map((s) => s.name)
    .sort()
    .slice(0, MAX_SUGGESTIONS);
}

/** The argument keys a tool does not declare, in the order they were given. */
export function unknownParameters(args: unknown, declared: string[]): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const known = new Set(declared);
  return Object.keys(args as Record<string, unknown>).filter((k) => !known.has(k));
}

/** "a", "a and b", "a, b or c" - a list a person reads rather than parses. */
function readable(names: string[], conjunction: "and" | "or" = "and"): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

/**
 * The refusal an agent sees, or undefined when every argument is one the tool
 * declared. Returned as text for errOut: a refusal is a result to act on, not
 * a crash, and the next call is named in it.
 */
export function unknownParameterRefusal(
  toolName: string,
  args: unknown,
  declared: string[],
): string | undefined {
  const unrecognised = unknownParameters(args, declared);
  if (unrecognised.length === 0) return undefined;

  const suggestions = [
    ...new Set(unrecognised.flatMap((name) => suggestParameters(name, declared))),
  ].sort();

  return (
    `${toolName} does not take ${readable(unrecognised)}. Nothing was sent. ` +
    `An unrecognised parameter is dropped rather than refused upstream, so the call would have run ` +
    `without it and answered as if you had never passed it - on a filtered read that is every row on ` +
    `the account wearing the shape of the slice you asked for.` +
    (suggestions.length ? ` Did you mean ${readable(suggestions, "or")}?` : "") +
    (declared.length
      ? ` ${toolName} takes: ${[...declared].sort().join(", ")}.`
      : ` ${toolName} takes no parameters.`) +
    ` Call hcp_api_notes with topic "unknown-parameter-refused" for why this one is refused here ` +
    `rather than quietly ignored.`
  );
}
