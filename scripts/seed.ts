/**
 * Fills a development journal with plausible history.
 *
 * The heatmap, the streaks and the filters are all features about *shape over
 * time*: with four hand-typed entries they look fine and prove nothing. This
 * generates months of nights with realistic gaps, so a broken week boundary or
 * an off-by-one streak is visible immediately.
 *
 *   npm run seed -- --email you@example.com --password '...' --days 400
 *
 * Run through `tsx --conditions=react-server` (see package.json): the journal
 * modules import `server-only`, which throws under Node's default resolution
 * and resolves to a no-op under that condition — the same one Next uses.
 *
 * Requires an account to already exist: the data key is recovered from the
 * password exactly as a login would, because there is no other way to write an
 * entry this instance will be able to read back.
 */
import { readFileSync } from "node:fs";

// Loaded before anything that reads env(), which caches on first use.
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
}

const { db } = await import("../src/db/index.js");
const { dreams } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { checkPassword } = await import("../src/lib/auth/accounts.js");
const { createDream } = await import("../src/lib/journal/dreams.js");
const { saveNight } = await import("../src/lib/journal/nights.js");
const { addDays, toIsoDate } = await import("../src/lib/journal/dates.js");
const { TECHNIQUES } = await import("../src/lib/journal/labels.js");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const email = flag("email") ?? process.env.DREM_SEED_EMAIL;
const password = flag("password") ?? process.env.DREM_SEED_PASSWORD;
const days = Number.parseInt(flag("days") ?? "400", 10);
const force = process.argv.includes("--force");

if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to seed a production database.");
}
if (!email || !password) {
  throw new Error(
    "Usage: npm run seed -- --email <email> --password <password> [--days 400] [--force]",
  );
}

/*
 * Deterministic, so two runs produce the same journal and a bug found once can
 * be found again. Small xorshift rather than Math.random for that reason alone.
 */
let state = 0x9e3779b9;
function random(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return ((state >>> 0) % 100_000) / 100_000;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

const PLACES = [
  "my grandmother's kitchen",
  "a train station that was also a library",
  "the coast road",
  "an office I have never worked in",
  "the flat I grew up in, but larger",
  "a cathedral with no roof",
];
const EVENTS = [
  "I was late for something I could not name",
  "the stairs kept adding floors",
  "someone I knew was speaking a language I could not place",
  "I could breathe underwater and nobody found it strange",
  "my teeth felt loose and I kept checking them",
  "I was carrying something heavy that changed shape",
];
const ENDINGS = [
  "Then the light changed and I woke up.",
  "It ended without ending.",
  "I woke with the feeling still on me.",
  "I remember the colour more than anything else.",
];
const LUCID_MOMENTS = [
  "I looked at my hands and counted six fingers, and knew.",
  "The door handle came away in my hand and that was the tell.",
  "I checked the clock twice and the numbers would not hold still.",
];
const TAG_POOL = [
  "flying",
  "water",
  "childhood home",
  "being late",
  "teeth",
  "stairs",
  "strangers",
  "the coast",
];

function dreamText(lucid: boolean): string {
  const parts = [
    `I was in ${pick(PLACES)}. ${pick(EVENTS)}.`,
    random() > 0.5 ? `${pick(EVENTS)}, though it made sense at the time.` : "",
    lucid ? pick(LUCID_MOMENTS) : "",
    lucid && random() > 0.4 ? "I tried to stay in it by looking at the ground." : "",
    pick(ENDINGS),
  ];
  return parts.filter(Boolean).join("\n\n");
}

const check = await checkPassword(email, password);
const { userId, keys } = check;

const [existing] = await db.select({ id: dreams.id }).from(dreams).where(eq(dreams.userId, userId)).limit(1);
if (existing && !force) {
  throw new Error("This journal already has entries. Re-run with --force to add more anyway.");
}

const today = toIsoDate(new Date());
let nightsWritten = 0;
let dreamsWritten = 0;

for (let offset = days - 1; offset >= 0; offset -= 1) {
  const date = addDays(today, -offset);

  // Recall improves over the seeded period, and weekends are better than
  // weekdays — the shape a real journal has, rather than uniform noise.
  const progress = 1 - offset / days;
  const journalChance = 0.55 + progress * 0.35;
  if (random() > journalChance) continue;

  const recalled = random() < 0.55 + progress * 0.3;
  const lucid = recalled && random() < 0.04 + progress * 0.18;

  await saveNight(userId, keys, {
    date,
    bedTime: random() > 0.5 ? "23:15" : "00:05",
    wakeTime: random() > 0.5 ? "07:10" : "06:40",
    wbtbTime: random() > 0.75 ? "04:00" : null,
    sleepQuality: 1 + Math.floor(random() * 5),
    techniques: random() > 0.6 ? [pick(TECHNIQUES)] : [],
    noRecall: !recalled,
    notes: random() > 0.85 ? "Late meal, restless first half." : null,
  });
  nightsWritten += 1;

  if (!recalled) continue;

  const count = random() > 0.8 ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    const isLucid = lucid && index === 0;
    await createDream(userId, keys, {
      nightDate: date,
      title: pick(PLACES).replace(/^(a|an|the|my) /, ""),
      body: dreamText(isLucid),
      lucidity: isLucid ? 2 + Math.floor(random() * 4) : 0,
      vividness: 1 + Math.floor(random() * 5),
      control: isLucid ? 1 + Math.floor(random() * 5) : null,
      recallClarity: 1 + Math.floor(random() * 5),
      emotionalValence: -2 + Math.floor(random() * 5),
      isNightmare: random() > 0.92,
      isRecurring: random() > 0.9,
      isFragment: random() > 0.85,
      isDraft: false,
      tags: random() > 0.4 ? [pick(TAG_POOL), pick(TAG_POOL)] : [],
    });
    dreamsWritten += 1;
  }
}

// Counts only. Nothing generated here is ever printed: a seeded journal is
// still a journal, and this script must not set the precedent.
console.log(`Seeded ${nightsWritten} nights and ${dreamsWritten} dreams.`);
process.exit(0);
