/**
 * What to say out loud, as opposed to what to show.
 *
 * Character cards written for text chat are full of stage directions — （笑）,
 * *sighs*, [smiles] — and a speech engine reads them literally. The transcript
 * should keep them; the voice should not.
 *
 * This is deliberately not character-specific: any card may use parentheses,
 * so the engine strips them for every character and lets the card say
 * otherwise in prose.
 */

/** Bracket pairs that wrap a non-spoken aside. */
const ASIDES: [string, string][] = [
  ["（", "）"],
  ["(", ")"],
  ["【", "】"],
  ["[", "]"],
  ["〔", "〕"],
  ["《", "》"],
];

/** A run of asterisks wrapping an action, e.g. *sighs* or *轻轻点头*. */
const STAR_ASIDE = /\*[^*\n]{1,40}\*/g;

/** Characters that carry sound: letters, digits, CJK ideographs, kana. */
const SPEAKABLE = /[\p{L}\p{N}]/u;

function stripBalanced(text: string, open: string, close: string): string {
  let out = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === open) {
      depth++;
      continue;
    }
    if (ch === close) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  // An unbalanced open bracket means the rest of the line was an aside.
  return out;
}

export function speakableText(text: string): string {
  let out = text;
  for (const [open, close] of ASIDES) out = stripBalanced(out, open, close);
  out = out.replace(STAR_ASIDE, " ");
  // Collapse the whitespace and punctuation the removals leave behind.
  out = out
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[，、,]+\s*(?=[。！？!?]|$)/g, "")
    .replace(/\s*([。！？!?])\s*/g, "$1")
    .replace(/^[\s。！？!?，、,]+/, "")
    .replace(/[\s]+$/g, "")
    .trim();
  return out;
}

/** True when there is something an engine could actually pronounce. */
export function isSpeakable(text: string): boolean {
  return SPEAKABLE.test(text);
}
