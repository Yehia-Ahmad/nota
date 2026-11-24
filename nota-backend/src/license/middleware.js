// Stage 24: the lock. Mounted on /api right after the LAN guard. With no valid license every route answers
// 402 LICENSE_REQUIRED, except the two license routes the activation screen needs (the health check `GET /` is not under /api).
// The result comes from the in-memory cache in ./index, never recomputed per request.
//
// Trial licenses (./trial.js) add two more answers, both decided here and nowhere else:
//   402 LICENSE_EXPIRED  the trial ended: every write is refused except EXEMPT_WRITES below. Reads (GET/HEAD) always work.
//   402 CLOCK_ROLLBACK   the PC's clock went back more than an hour: everything is refused except what the owner needs to fix it.
// A lifetime license never reaches that code.
const license = require("./index");
const trial = require("./trial");

const ALLOWED = new Set(["/license/status", "/license/activate"]);

// The ONLY writes that still work after a trial ended: signing in/out and the own password, recovery, replacing the license, and the
// print copy-number bookkeeping (a copy of an existing document may still be printed). Backup create/restore are desktop-app IPC, not API routes.
// verify-password only checks a password (it writes nothing); the lock screen and the backup restore ask need it.
const EXEMPT_WRITES = [
  "POST /auth/login",
  "POST /auth/logout",
  "POST /auth/refresh",
  "POST /auth/change-password",
  "POST /auth/verify-password",
  "POST /auth/recover",
  "POST /license/activate",
  "POST /print/reserve",
  "POST /print/confirm",
  "POST /print/release",
];
const exemptWrites = new Set(EXEMPT_WRITES);

// With a wrong clock the owner still has to sign in, look at the license card and replace the license. A client PC's link check
// (GET /lan/info) must still see a Nota server, or it would report "not a Nota server" instead of showing the clock banner.
const CLOCK_ROLLBACK_ALLOWED = new Set(["GET /license/status", "GET /license/info", "GET /lan/info"]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const routeKey = (req) => `${req.method} ${req.path.replace(/\/+$/, "") || "/"}`;
/** True for a request that changes (or may change) data and is not on the exempt list. */
const isBlockedWrite = (req) => !READ_METHODS.has(req.method) && !exemptWrites.has(routeKey(req));

const licenseRequiredError = () => {
  const error = new Error("النسخة دي مش مفعّلة. فعّل الترخيص الأول");
  error.statusCode = 402;
  error.responseData = { code: "LICENSE_REQUIRED", reason: license.summary().code };
  return error;
};

const licenseExpiredError = (expiresAt) => {
  const error = new Error("انتهت النسخة التجريبية — البرنامج للعرض بس");
  error.statusCode = 402;
  error.responseData = { code: "LICENSE_EXPIRED", expiresAt, messageEn: "The trial has ended. The program is view-only." };
  return error;
};

const clockRollbackError = () => {
  const error = new Error("ساعة الجهاز متأخرة — صلّحها وافتح البرنامج تاني");
  error.statusCode = 402;
  error.responseData = { code: "CLOCK_ROLLBACK", messageEn: "This PC's clock is behind. Fix it and open the program again." };
  return error;
};

const requireLicense = () => (req, _res, next) => {
  if (req.method === "OPTIONS" || ALLOWED.has(req.path)) return next();
  if (!license.isValid()) return next(licenseRequiredError());
  const t = trial.current(); // null for a lifetime license: nothing below applies
  if (!t || t.state === "active") return next();
  if (t.state === "clock-rollback") {
    const key = routeKey(req);
    return CLOCK_ROLLBACK_ALLOWED.has(key) || exemptWrites.has(key) ? next() : next(clockRollbackError());
  }
  return isBlockedWrite(req) ? next(licenseExpiredError(t.expiresAt)) : next();
};

module.exports = { requireLicense, licenseRequiredError, licenseExpiredError, clockRollbackError, EXEMPT_WRITES, isBlockedWrite };
