// Trial licenses: what "valid" means over time. A trial is a lifetime payload plus `expiresAt`.
//
//   active          before expiresAt: the app works like a lifetime license (the banner counts down)
//   expired         at/after expiresAt: read-only. The middleware (middleware.js) answers every write with 402 LICENSE_EXPIRED
//   clock-rollback  the PC's clock is more than 1 hour behind the highest time this PC has seen: 402 CLOCK_ROLLBACK
//
// Nothing here is cached per request: the state is computed from the current time on every call, so an expiry takes effect while the app runs.
// The "highest time seen" lives in the database (Meta "clock") and in memory. It only ever goes up, is written at most once a minute
// while running and at start. A lifetime license never reads or writes any of it.
const license = require("./index");

const ROLLBACK_TOLERANCE_MS = 60 * 60 * 1000;
const PERSIST_EVERY_MS = 60 * 1000;
const CLOCK_ID = "clock";

let highestSeen = null; // ms
let lastPersistAt = 0;
let loaded = false;

const meta = () => require("../models/meta.model");

const persist = async (ms) => {
  await meta().updateOne({ _id: CLOCK_ID }, { $max: { highestSeenAt: new Date(ms) } }, { upsert: true });
};

/** Start-up (and after a trial is activated): reads the stored highest time and records now. Never lowers it. */
const init = async () => {
  const stored = await meta().findById(CLOCK_ID).select("highestSeenAt").lean();
  const storedMs = stored && stored.highestSeenAt ? new Date(stored.highestSeenAt).getTime() : null;
  if (storedMs !== null && (highestSeen === null || storedMs > highestSeen)) highestSeen = storedMs;
  loaded = true;
  lastPersistAt = license.now(); // written below, so observe() does not write it a second time
  observe();
  await persist(highestSeen);
};

/** Called on every request of a trial: remembers the highest time seen, and writes it out at most once a minute. */
function observe() {
  const now = license.now();
  if (highestSeen === null || now > highestSeen) highestSeen = now;
  if (now - lastPersistAt >= PERSIST_EVERY_MS) {
    lastPersistAt = now;
    persist(highestSeen).catch(() => {});
  }
  return now;
}

/**
 * The trial's state right now, or null when the installed license is not a trial (lifetime, none, invalid).
 * { state, issuedAt, expiresAt, remainingMs, now }
 */
const current = () => {
  const payload = license.payload();
  if (!payload || payload.type !== "trial") return null;
  const now = observe();
  const expiresMs = Date.parse(payload.expiresAt);
  const remainingMs = Math.max(0, expiresMs - now);
  let state = "active";
  if (loaded && highestSeen !== null && now < highestSeen - ROLLBACK_TOLERANCE_MS) state = "clock-rollback";
  else if (now >= expiresMs) state = "expired";
  return { state, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt, remainingMs, now };
};

/** What GET /license/status adds for a trial (nothing for lifetime). */
const view = () => {
  const t = current();
  if (!t) return {};
  return { trial: { state: t.state, issuedAt: t.issuedAt, expiresAt: t.expiresAt, remainingMs: t.remainingMs, now: new Date(t.now).toISOString() } };
};

/** Tests only. */
const resetForTests = () => { highestSeen = null; lastPersistAt = 0; loaded = false; };

module.exports = { init, observe, current, view, resetForTests, ROLLBACK_TOLERANCE_MS, CLOCK_ID };
