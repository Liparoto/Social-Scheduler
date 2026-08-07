/**
 * Generate lib/emoji-data.ts from Unicode's own emoji-test.txt.
 *
 * Why generate rather than install a package: the dashboard runs on six runtime
 * dependencies and an emoji picker is, in the end, a filtered list and a grid. A library
 * like emoji-mart would bring a large tree for that. The data itself comes straight from
 * Unicode, so it is as authoritative as it gets, and this script records where it came from.
 *
 * Usage:
 *   node scripts/build-emoji-data.mjs                 # fetch the latest from unicode.org
 *   node scripts/build-emoji-data.mjs path/to/emoji-test.txt
 *
 * Re-run when Unicode publishes a new emoji version. The output is a build artifact —
 * never hand-edit lib/emoji-data.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "lib", "emoji-data.ts");
const DEFAULT_URL = "https://unicode.org/Public/emoji/latest/emoji-test.txt";

// Words carrying no search value — every emoji is a "face" or has a "with", so keeping them
// would make those terms match hundreds of entries and drown the useful hits.
const STOPWORDS = new Set([
  "with", "and", "the", "in", "of", "a", "an", "or", "on", "for", "to",
]);

// A skin-tone variant is a near-duplicate of its base emoji. Keeping all five floods the
// grid with five identical-looking hands per gesture, which makes it harder to use, not
// easier. The base emoji stands for the set.
//
// Matched anywhere in the name, not just after a colon: multi-person emoji list their tones
// after COMMAS ("kiss: person, person, light skin tone, dark skin tone"), and a
// colon-anchored pattern let 190 of those through — one entry per pair of tones, which is
// exactly the flooding this filter exists to prevent.
const SKIN_TONE = /\b(light|medium-light|medium|medium-dark|dark) skin tone\b/;

async function readSource(arg) {
  if (arg) return { text: await fs.readFile(arg, "utf8"), origin: arg };
  const res = await fetch(DEFAULT_URL);
  if (!res.ok) throw new Error(`fetching ${DEFAULT_URL} failed: HTTP ${res.status}`);
  return { text: await res.text(), origin: DEFAULT_URL };
}

function keywordsFor(name) {
  return [
    ...new Set(
      name
        .split(/[\s:,()-]+/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    ),
  ];
}

function parse(text) {
  const emoji = [];
  const groups = [];
  let group = "Other";
  let version = "unknown";

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (line.startsWith("# group:")) {
      group = line.slice("# group:".length).trim();
      if (!groups.includes(group)) groups.push(group);
      continue;
    }
    // The file's header carries e.g. "# Version: 16.0" — worth recording in the output so a
    // reader can tell how stale the data is without diffing it.
    const v = line.match(/^#\s*Version:\s*(.+)$/);
    if (v) version = v[1].trim();
    if (line.startsWith("#") || line === "") continue;

    // Data line shape:
    //   1F600  ; fully-qualified  # 😀 E1.0 grinning face
    const m = line.match(/^([0-9A-F ]+);\s*(\S+)\s*#\s*(\S+)\s+E\d+\.\d+\s+(.+)$/);
    if (!m) continue;

    const [, , status, char, name] = m;
    // Only fully-qualified sequences. minimally-qualified and unqualified render
    // inconsistently across platforms and would appear as near-duplicate grid entries.
    if (status !== "fully-qualified") continue;
    if (SKIN_TONE.test(name)) continue;

    emoji.push({ char, name: name.toLowerCase(), group, keywords: keywordsFor(name) });
  }

  // Only groups that actually kept an entry. "Component" survives the group headers but
  // holds nothing but skin-tone and hair modifiers, all filtered above — leaving it in the
  // list would render a category tab that shows an empty grid when clicked.
  const used = new Set(emoji.map((e) => e.group));
  return { emoji, groups: groups.filter((g) => used.has(g)), version };
}

const { text, origin } = await readSource(process.argv[2]);
const { emoji, groups, version } = parse(text);

if (emoji.length < 500) {
  // A parser that silently matches nothing would emit a valid-but-empty file and the picker
  // would look merely "empty" rather than broken. Fail loudly instead.
  throw new Error(`only ${emoji.length} emoji parsed — the source format probably changed`);
}

const body = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by dashboard/scripts/build-emoji-data.mjs from Unicode's emoji-test.txt
// (Unicode emoji version ${version}, read from ${origin}).
// Re-run that script to regenerate; edits here will be overwritten.
//
// Only fully-qualified sequences are included, and skin-tone variants are collapsed into
// their base emoji — see the script for why.
import type { Emoji } from "./emoji-search";

export type { Emoji };

export const EMOJI_UNICODE_VERSION = ${JSON.stringify(version)};

export const EMOJI_GROUPS: string[] = ${JSON.stringify(groups, null, 2)};

export const EMOJI: Emoji[] = ${JSON.stringify(emoji)};
`;

await fs.writeFile(OUT, body);
console.log(
  `wrote ${path.relative(process.cwd(), OUT)}: ${emoji.length} emoji, ` +
    `${groups.length} groups, Unicode ${version}`
);
