/**
 * Do-not-contact detection over a customer record.
 *
 * The union of suppression signals lives in more than one place and the places
 * disagree, so the safe move is to read every one the public API exposes and to
 * name the one it cannot. A public customer object carries three: the
 * notifications flag, the tag list, and free-text notes. It does NOT carry
 * Housecall Pro's Do Not Service checkbox, which this integration cannot read, so
 * that signal is always reported as unverifiable, and a `contactable: true` is
 * never a clearance on its own.
 *
 * Notes are read clause by clause, not by substring. A notes cell holds years
 * of entries, and each of the four cases below is a failure mode a substring
 * match cannot avoid:
 *
 * - "we do not service gas anymore" is a statement about what the SHOP sells,
 *   found in the notes of perfectly contactable customers who asked about the
 *   wrong appliance. A substring match suppresses them; this does not.
 * - "removed from DNS" contains the words that set the flag and means the
 *   opposite. It goes to review rather than into either verdict.
 * - "do not schedule without a deposit" is a gate on dispatch, not a ban on
 *   contact. Neither suppressing nor clearing is safe, so it goes to review
 *   with the clause quoted.
 * - "refused to pay", "no longer our customer" are narrative. Somebody who
 *   left is not somebody you were told not to contact.
 */

/** Do-not-contact language, matched against a TAG NAME. Tags are short labels,
 * so substring matching is right for them in a way it is not for prose. */
export const DNC_RE =
  /(do\s*-?\s*not\s*-?\s*(service|contact|call|email|text|market|solicit)|(^|\W)dns(\W|$)|no\s*-?\s*(marketing|solicit|contact)|unsubscrib|opt\s*-?\s*out)/i;

export interface ContactSignal {
  kind: "notifications_off" | "do_not_contact_tag" | "notes_language";
  source: string;
  value?: string;
}

/** A notes clause that needs a human reading rather than an automatic verdict. */
export interface ContactReviewItem {
  kind: "notes_conditional" | "notes_reversal";
  source: "customer.notes";
  /** The clause itself, so the human reads what was actually written. */
  value: string;
}

export interface ContactAnalysis {
  /** Suppression signals. Any of these present means not contactable. */
  signals: ContactSignal[];
  /** Clauses held for a human eye: conditional gates and lifted flags. */
  review: ContactReviewItem[];
}

/* ---------- the clause matcher ---------- */

/** A directive aimed at handling of this customer. Tight on purpose: loose
 * disappointment language ("refused to pay", "no service history") is wrong
 * about the customer far too often to sit near an automatic verdict. */
const DIRECTIVE_RE =
  /\b(?:do\s+not|don'?t|never)\s+(?:service|schedule|book|contact|call|text|email|market|solicit)\b|(^|\W)dns(\W|$)|\b(?:no\s+(?:marketing|solicit(?:ing|ation)?|contact)|unsubscrib\w*|opt(?:ed)?\s*-?\s*out)\b/i;

/** The flag being lifted: mentions of DNC state next to a removal verb. */
const REVERSAL_RE =
  /\b(?:removed?|taken?\s+off|took\s+off|lifted|cleared|un-?flagg?ed|no\s+longer\s+on)\b[^.!?\n]{0,40}\b(?:dns|do\s*-?\s*not\s*-?\s*(?:service|contact|call))(?:\s+list)?|\b(?:dns|do\s*-?\s*not\s*-?\s*(?:service|contact|call))(?:\s+list)?\b[^.!?\n]{0,40}\b(?:removed?|lifted|cleared|taken?\s+off)\b/i;

/** The shop talking about its own service lines: "we do not service gas". The
 * subject is the company or the object is a fuel, trade or appliance class. */
const SCOPE_SUBJECT_RE =
  /\b(?:we|our\s+(?:company|shop|techs?)|us)\b[^.!?\n]{0,24}\b(?:do\s+not|don'?t|no\s+longer|stopped|never)\b/i;
const SCOPE_OBJECT_RE =
  /\b(?:do\s+not|don'?t|never|no\s+longer)\s+servic\w*\s+(?:gas|oil|propane|electric\w*|hvac|plumb\w*|boilers?|furnaces?|burners?|appliance\w*|pools?|spas?|wells?|septic|generators?|a\/?c\b|air\s+condition\w*|water\s+heaters?|steam|mini\s*-?\s*splits?|that\s+(?:brand|make|model)|these)\b/i;

/** A condition attached to the directive: a gate on dispatch, not a ban. */
const CONDITIONAL_RE =
  /\b(?:without|until|unless|prior\s+to|before|after)\b|\b(?:needs?|requires?|pending)\s+\w{0,12}\s*(?:approval|deposit|payment|ok)\b|\b(?:deposit|approv\w*|balance|paid\s+in\s+full|c\.?o\.?d\.?|speak(?:ing)?\s+(?:to|with)|talk(?:ing)?\s+(?:to|with)|owner\s+(?:first|ok))\b/i;

/** Split years of notes entries into clauses so one clause's meaning cannot
 * leak into another. Sentence enders and line breaks both end a clause. */
function clauses(notes: string): string[] {
  return notes
    .split(/[.!?;]+\s+|[.!?;]+$|\r?\n+/m)
    .map((c) => c.trim())
    .filter(Boolean);
}

const MAX_NOTE_ITEMS = 3;
const MAX_CLAUSE_CHARS = 140;

function clip(clause: string): string {
  return clause.length > MAX_CLAUSE_CHARS
    ? `${clause.slice(0, MAX_CLAUSE_CHARS - 1)}…`
    : clause;
}

/** Every readable suppression signal on this customer record, plus the clauses
 * that need a human. Pure over the record shape — no network. */
export function analyzeContactability(c: any): ContactAnalysis {
  const signals: ContactSignal[] = [];
  const review: ContactReviewItem[] = [];

  if (c?.notifications_enabled === false) {
    signals.push({ kind: "notifications_off", source: "customer.notifications_enabled" });
  }

  const tags = Array.isArray(c?.tags) ? c.tags : [];
  for (const t of tags) {
    const name = typeof t === "string" ? t : String(t?.name ?? "");
    if (name && DNC_RE.test(name)) {
      signals.push({ kind: "do_not_contact_tag", source: "customer.tags", value: name });
    }
  }

  const notes = typeof c?.notes === "string" ? c.notes : "";
  if (notes) {
    let noteItems = 0;
    for (const clause of clauses(notes)) {
      if (noteItems >= MAX_NOTE_ITEMS) break;
      // Order matters. A reversal contains the directive's words and means the
      // opposite, so it is checked first.
      if (REVERSAL_RE.test(clause)) {
        review.push({ kind: "notes_reversal", source: "customer.notes", value: clip(clause) });
        noteItems++;
        continue;
      }
      if (!DIRECTIVE_RE.test(clause)) continue;
      // The shop describing its own service lines is not a customer flag.
      if (SCOPE_SUBJECT_RE.test(clause) || SCOPE_OBJECT_RE.test(clause)) continue;
      if (CONDITIONAL_RE.test(clause)) {
        review.push({ kind: "notes_conditional", source: "customer.notes", value: clip(clause) });
        noteItems++;
        continue;
      }
      signals.push({ kind: "notes_language", source: "customer.notes", value: clip(clause) });
      noteItems++;
    }
  }

  return { signals, review };
}

/** The suppression signals alone. Kept for callers that predate the review
 * list; new callers want analyzeContactability. */
export function contactSignals(c: any): ContactSignal[] {
  return analyzeContactability(c).signals;
}

/** The signal the public API can never see — always returned so no union reads as complete. */
export const UNVERIFIABLE = [
  "do_not_service_flag — Housecall Pro's Do Not Service checkbox is a dashboard setting this integration cannot read; confirm it in Housecall Pro",
];
