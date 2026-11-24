// Stage 24: license state for this backend process.
//
// The file (<NOTA_LICENSE_DIR>/nota.lic) is the source of truth. It is verified at start and again whenever the license
// changes (activate / reload); the result is cached in memory, never recomputed per request. A copy of the text is kept
// in the database (Meta "license") so client PCs can show the license info. An invalid license never deletes or changes data.
// The license code keeps its OWN references to everything it needs, taken when it loads (server.js loads it before express and every other
// dependency). Code loaded later that replaces crypto.verify, fs.readFileSync, ... cannot change what the license check does.
const { verify: cryptoVerify } = require("crypto");
const { readFileSync, mkdirSync, writeFileSync, renameSync } = require("fs");
const path = require("path");
const { acceptedPublicKeys } = require("./keys");
const { parseText, payloadProblem } = require("./format");
const { getMachineId } = require("./machineId");

const FILE_NAME = "nota.lic";

// The one clock the license code reads (ms). Captured at load; tests replace it with setClockForTests to move time.
const realNow = Date.now.bind(Date);
let clockOverride = null;
const now = () => (clockOverride ? clockOverride() : realNow());
const setClockForTests = (fn) => { clockOverride = typeof fn === "function" ? fn : null; };

// Reasons a license is not accepted.
const CODES = Object.freeze({
  NONE: "NO_LICENSE",
  MALFORMED: "MALFORMED",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  UNKNOWN_VERSION: "UNKNOWN_VERSION",
  UNKNOWN_TYPE: "UNKNOWN_TYPE",
  WRONG_MACHINE: "WRONG_MACHINE",
  NO_MACHINE_ID: "NO_MACHINE_ID",
  // install() only. An installed trial that later expires stays installed and valid: the app turns read-only (trial.js).
  EXPIRED: "EXPIRED",
  TRIAL_CANNOT_REPLACE_LIFETIME: "TRIAL_CANNOT_REPLACE_LIFETIME",
});

const licenseDir = () => process.env.NOTA_LICENSE_DIR || path.join(process.cwd(), ".nota-license");
const licensePath = () => path.join(licenseDir(), FILE_NAME);

/** Checks license text against the compiled-in keys and this PC. Returns { ok, code, payload }. */
const verifyText = (text) => {
  const parsed = parseText(text);
  if (!parsed) return { ok: false, code: CODES.MALFORMED };
  const keys = acceptedPublicKeys();
  const signed = keys.some((key) => {
    try { return cryptoVerify(null, parsed.payloadBytes, key, parsed.signature); } catch { return false; }
  });
  if (!signed) return { ok: false, code: CODES.BAD_SIGNATURE };
  const problem = payloadProblem(parsed.payload);
  if (problem) return { ok: false, code: problem };
  const machineId = getMachineId();
  if (!machineId) return { ok: false, code: CODES.NO_MACHINE_ID };
  if (parsed.payload.machineId !== machineId) return { ok: false, code: CODES.WRONG_MACHINE, payload: parsed.payload };
  return { ok: true, payload: parsed.payload };
};

// { loaded, ok, code, payload, text }
let state = { loaded: false, ok: false, code: CODES.NONE, payload: null, text: null };

const readFileText = () => {
  try { return readFileSync(licensePath(), "utf8").trim() || null; } catch { return null; }
};

/** Re-reads and verifies the license file. Called at start and after the license changes. */
const reload = () => {
  const text = readFileText();
  if (!text) {
    state = { loaded: true, ok: false, code: CODES.NONE, payload: null, text: null };
    return state;
  }
  const result = verifyText(text);
  state = { loaded: true, ok: result.ok, code: result.ok ? null : result.code, payload: result.ok ? result.payload : null, text };
  return state;
};

const current = () => (state.loaded ? state : reload());
const isValid = () => current().ok === true;
const payload = () => (isValid() ? state.payload : null);

/** Public view (no signature). */
const summary = () => {
  const s = current();
  const p = s.ok ? s.payload : null;
  return {
    licensed: s.ok,
    code: s.ok ? null : s.code,
    machineId: getMachineId(),
    shopName: p ? p.shopName : null,
    ...(p ? { shopNameEn: p.shopNameEn || null } : {}),
    ...(p && p.type === "trial" ? { type: "trial", expiresAt: p.expiresAt } : {}),
  };
};

/** Full view for the owner. */
const details = () => {
  const s = current();
  const p = s.ok ? s.payload : null;
  return p ? { licenseId: p.licenseId, type: p.type, shopName: p.shopName, shopNameEn: p.shopNameEn || null, machineId: p.machineId, maxClients: p.maxClients, issuedAt: p.issuedAt, ...(p.type === "trial" ? { expiresAt: p.expiresAt } : {}) } : null;
};

/**
 * Verifies and installs license text. Writes the file atomically and only after the text verified.
 * Returns { ok:true, payload } or { ok:false, code }. The old file stays when the new text is refused.
 */
const install = (text) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const result = verifyText(trimmed);
  if (!result.ok) return { ok: false, code: result.code };
  if (result.payload.type === "trial") {
    // A trial never replaces a lifetime license, and an already expired trial is not worth installing.
    const installed = current();
    if (installed.ok && installed.payload.type === "lifetime") return { ok: false, code: CODES.TRIAL_CANNOT_REPLACE_LIFETIME };
    if (Date.parse(result.payload.expiresAt) <= now()) return { ok: false, code: CODES.EXPIRED };
  }
  const dir = licenseDir();
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `${FILE_NAME}.${process.pid}.tmp`);
  writeFileSync(temp, trimmed, "utf8");
  renameSync(temp, licensePath());
  reload();
  return { ok: true, payload: result.payload };
};

/** Tests only: forget the cached state so the next call re-reads the file. */
const resetForTests = () => { state = { loaded: false, ok: false, code: CODES.NONE, payload: null, text: null }; };

module.exports = { CODES, FILE_NAME, licenseDir, licensePath, verifyText, reload, isValid, payload, summary, details, install, resetForTests, now, setClockForTests };
