process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "trial-test-secret-0123456789abcdef-0123456789";

// Trial licenses: the payload rules, read-only after expiry (every write route walked), expiry while running, clock rollback,
// replacing a trial with a lifetime license, and that a lifetime license behaves exactly as before.

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const license = require("../src/license");
const trial = require("../src/license/trial");
const { EXEMPT_WRITES } = require("../src/license/middleware");
const Customer = require("../src/models/customer.model");
const Meta = require("../src/models/meta.model");
const ShopProfile = require("../src/models/shopProfile.model");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { resetDeviceGate } = require("../src/middlewares/deviceGate.middleware");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");
const { issueTestLicense, installTestLicense } = require("./helpers/license");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

let stop; let server; let baseUrl; let token; let fakeNow;
const setNow = (ms) => { fakeNow = ms; };
const trialLicense = (extra = {}) => issueTestLicense({ type: "trial", issuedAt: iso(T0 - HOUR), expiresAt: iso(T0 + 30 * DAY), ...extra });

test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27167, tag: "trial-" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  license.setClockForTests(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (stop) await stop();
});
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null; resetDeviceThrottle(); resetDeviceGate();
  trial.resetForTests();
  setNow(T0);
  license.setClockForTests(() => fakeNow);
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
}
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };

/** Installs a license (trial by default), starts the clock tracking the way server start does, and signs in as the owner. */
async function start({ text = trialLicense(), shopName = "محل النور" } = {}) {
  installTestLicense({}, text);
  if (license.payload() && license.payload().type === "trial") await trial.init();
  await ShopProfile.create({ key: "default", name: shopName });
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "trial-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201, JSON.stringify(owner.json));
  token = owner.json.token;
}
const saveProfile = () => call("PUT", "/api/shop-profile", { name: license.payload().shopName, phones: [] });

// ---- every route of the app -------------------------------------------------------------------------------------

/** Every { method, path } the app answers, paths with sample ids. Walks the express router stack (nested routers included). */
const listRoutes = () => {
  const found = [];
  const mountOf = (layer) => {
    const source = layer.regexp.source;
    if (source === "^\\/?(?=\\/|$)") return "";
    return source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");
  };
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const routePath of paths) {
          for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: `${prefix}${routePath === "/" ? "" : routePath}`.replace(/:[A-Za-z]+/g, "64b000000000000000000001") });
        }
      } else if (layer.handle && layer.handle.stack) walk(layer.handle.stack, prefix + mountOf(layer));
    }
  };
  walk(app._router.stack, "");
  return found.filter((r) => r.path.startsWith("/api"));
};
const routeKey = (r) => `${r.method} ${r.path.replace(/^\/api/, "")}`;
const isExempt = (r) => EXEMPT_WRITES.includes(routeKey(r));

// ---- payload and verification -----------------------------------------------------------------------------------

it("a trial license verifies, and the payload carries type trial and expiresAt", () => {
  const result = license.verifyText(trialLicense());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.payload.type, "trial");
  assert.equal(result.payload.expiresAt, iso(T0 + 30 * DAY));
});

it("a trial without expiresAt is invalid; so is one that expires before it was issued or has a bad date", () => {
  assert.deepEqual(license.verifyText(issueTestLicense({ type: "trial" })), { ok: false, code: "MALFORMED" });
  assert.equal(license.verifyText(trialLicense({ expiresAt: "not a date" })).code, "MALFORMED");
  assert.equal(license.verifyText(trialLicense({ expiresAt: iso(T0 - 2 * HOUR) })).code, "MALFORMED");
  assert.equal(license.verifyText(trialLicense({ expiresAt: 12345 })).code, "MALFORMED");
});

it("a lifetime license that carries expiresAt is invalid; a normal lifetime license has no expiresAt", () => {
  assert.deepEqual(license.verifyText(issueTestLicense({ expiresAt: iso(T0 + DAY) })), { ok: false, code: "MALFORMED" });
  const normal = license.verifyText(issueTestLicense({}));
  assert.equal(normal.ok, true);
  assert.equal("expiresAt" in normal.payload, false);
});

// ---- before expiry ----------------------------------------------------------------------------------------------

it("before expiry a trial works like a lifetime license: writes work and the status shows the remaining time", async () => {
  await start();
  ok(await saveProfile());
  ok(await call("POST", "/api/customers", { name: "عميل", phone: "01000000000" }), 201);
  const status = ok(await call("GET", "/api/license/status"));
  assert.equal(status.type, "trial");
  assert.equal(status.expiresAt, iso(T0 + 30 * DAY));
  assert.equal(status.trial.state, "active");
  assert.equal(status.trial.remainingMs, 30 * DAY);
  assert.equal(status.trial.now, iso(T0));
  assert.equal(status.trial.issuedAt, iso(T0 - HOUR));
  const info = ok(await call("GET", "/api/license/info"));
  assert.equal(info.type, "trial");
  assert.equal(info.expiresAt, iso(T0 + 30 * DAY));
});

// ---- after expiry: read-only ------------------------------------------------------------------------------------

it("after expiry EVERY write route answers 402 LICENSE_EXPIRED (the whole route table is walked), only the exempt list still works", async () => {
  await start();
  setNow(T0 + 30 * DAY + 1000);
  const routes = listRoutes();
  const writes = routes.filter((r) => !["GET", "HEAD"].includes(r.method));
  assert.ok(writes.length > 60, `walked ${writes.length} write routes`);
  const blocked = writes.filter((r) => !isExempt(r));
  for (const route of blocked) {
    const response = await call(route.method, route.path, route.method === "DELETE" ? undefined : {});
    assert.equal(response.status, 402, `${route.method} ${route.path} -> ${response.status}`);
    assert.equal(response.json.code, "LICENSE_EXPIRED", `${route.method} ${route.path}`);
    assert.match(response.json.message, /انتهت النسخة التجريبية/);
  }
  // every exempt route that exists is not stopped by the lock
  for (const route of writes.filter(isExempt)) {
    const response = await call(route.method, route.path, {});
    assert.notEqual(response.status, 402, `${route.method} ${route.path} is exempt`);
  }
  assert.equal(await Customer.countDocuments(), 0, "nothing was written");
});

it("after expiry every GET still works (view, reports, export, history, license info), and the sign-in, password and print routes keep working", async () => {
  await start();
  ok(await call("POST", "/api/customers", { name: "عميل", phone: "01000000000" }), 201);
  setNow(T0 + 31 * DAY);
  const gets = listRoutes().filter((r) => r.method === "GET" && !r.path.includes("64b000000000000000000001"));
  assert.ok(gets.length > 40, `walked ${gets.length} GET routes`);
  // These two answer 400/404 without their query input; they do so before the trial ended as well (the license is not the reason).
  const NEEDS_INPUT = new Set(["/api/accounting/accounts/next-code", "/api/products/search"]);
  for (const route of gets) {
    const response = await call("GET", route.path);
    if (NEEDS_INPUT.has(route.path)) assert.ok([400, 404].includes(response.status), `GET ${route.path} -> ${response.status}`);
    else assert.equal(response.status, 200, `GET ${route.path} -> ${response.status}`);
  }
  // exempt: sign in again, change the own password, recovery route reachable, print bookkeeping
  const login = ok(await call("POST", "/api/auth/login", { username: "trial-owner", password: "owner-pass-123" }));
  assert.ok(login.token);
  const changed = await call("POST", "/api/auth/change-password", { currentPassword: "owner-pass-123", newPassword: "owner-pass-456" });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.notEqual((await call("POST", "/api/print/reserve", {})).status, 402);
  assert.notEqual((await call("POST", "/api/print/confirm", {})).status, 402);
  assert.notEqual((await call("POST", "/api/print/release", {})).status, 402);
  assert.notEqual((await call("POST", "/api/auth/recover", {})).status, 402);
  assert.notEqual((await call("POST", "/api/auth/refresh", {})).status, 402);
});

it("the expiry takes effect while the app is running: the same server flips from working to read-only, no restart", async () => {
  await start();
  setNow(T0 + 30 * DAY - 1000);
  ok(await saveProfile());
  assert.equal(ok(await call("GET", "/api/license/status")).trial.state, "active");
  setNow(T0 + 30 * DAY); // exactly at expiresAt
  const refused = await call("POST", "/api/customers", { name: "متأخر", phone: "01000000001" });
  assert.equal(refused.status, 402);
  assert.equal(refused.json.code, "LICENSE_EXPIRED");
  assert.equal(ok(await call("GET", "/api/license/status")).trial.state, "expired");
  assert.equal(ok(await call("GET", "/api/license/status")).trial.remainingMs, 0);
  assert.equal(await Customer.countDocuments(), 0);
});

it("replacing the expired trial with a lifetime license makes the app writable again, with the same data", async () => {
  await start();
  ok(await call("POST", "/api/customers", { name: "عميل", phone: "01000000000" }), 201);
  setNow(T0 + 40 * DAY);
  assert.equal((await saveProfile()).status, 402);
  const done = ok(await call("POST", "/api/license/activate", { license: issueTestLicense({ shopName: "محل النور" }) }));
  assert.equal(done.licensed, true);
  assert.equal(done.trial, undefined);
  ok(await saveProfile());
  assert.equal(await Customer.countDocuments(), 1, "no data lost");
});

// ---- clock rollback ---------------------------------------------------------------------------------------------

it("clock rollback: more than an hour behind the highest time seen blocks a trial (402 CLOCK_ROLLBACK), a smaller step does not", async () => {
  await start();
  setNow(T0 + 2 * DAY);
  ok(await saveProfile());
  setNow(T0 + 2 * DAY - 30 * 60 * 1000); // 30 minutes back: tolerated
  ok(await saveProfile());
  setNow(T0 + 2 * DAY - 2 * HOUR); // 2 hours back
  for (const [method, path] of [["GET", "/api/products"], ["GET", "/api/shop-profile"], ["POST", "/api/customers"], ["PUT", "/api/shop-profile"]]) {
    const response = await call(method, path, method === "GET" ? undefined : {});
    assert.equal(response.status, 402, `${method} ${path}`);
    assert.equal(response.json.code, "CLOCK_ROLLBACK");
    assert.match(response.json.message, /ساعة الجهاز متأخرة/);
  }
  const status = ok(await call("GET", "/api/license/status"));
  assert.equal(status.trial.state, "clock-rollback");
  ok(await call("GET", "/api/license/info"));
  assert.notEqual((await call("GET", "/api/lan/info")).status, 402, "a client PC's link check still gets through");
  ok(await call("POST", "/api/auth/login", { username: "trial-owner", password: "owner-pass-123" }));
  setNow(T0 + 2 * DAY); // the clock is fixed
  ok(await saveProfile());
});

it("the highest time seen is stored in the database (at start, and at most once a minute) and survives a restart", async () => {
  await start();
  const stored = async () => (await Meta.findById("clock").lean()).highestSeenAt.getTime();
  assert.equal(await stored(), T0, "written at start");
  setNow(T0 + 30 * 1000);
  ok(await saveProfile());
  assert.equal(await stored(), T0, "not written again within a minute");
  setNow(T0 + 61 * 1000);
  ok(await saveProfile());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await stored(), T0 + 61 * 1000, "written after a minute");
  // restart with a clock set back 3 hours: still blocked, because the database remembers
  trial.resetForTests();
  setNow(T0 + 61 * 1000 - 3 * HOUR);
  await trial.init();
  assert.equal(trial.current().state, "clock-rollback");
  assert.equal(await stored(), T0 + 61 * 1000, "the stored time never goes down");
});

it("clock rollback never touches a lifetime license: nothing is stored and a clock far in the past changes nothing", async () => {
  await start({ text: issueTestLicense({}) });
  ok(await saveProfile());
  setNow(T0 - 400 * DAY);
  ok(await saveProfile());
  ok(await call("POST", "/api/customers", { name: "عميل", phone: "01000000000" }), 201);
  assert.equal(await Meta.findById("clock").lean(), null, "a lifetime license never stores the clock");
  const status = ok(await call("GET", "/api/license/status"));
  assert.equal(status.trial, undefined);
  assert.equal(status.type, undefined);
});

// ---- replacing --------------------------------------------------------------------------------------------------

it("a lifetime license replaces a trial on this PC even with a different business name; the data stays", async () => {
  await start();
  ok(await call("POST", "/api/customers", { name: "عميل", phone: "01000000000" }), 201);
  const done = ok(await call("POST", "/api/license/activate", { license: issueTestLicense({ shopName: "الاسم الجديد", shopNameEn: "New Name" }) }));
  assert.equal(done.shopName, "الاسم الجديد");
  assert.equal(license.details().type, "lifetime");
  assert.equal((await ShopProfile.findOne({ key: "default" }).lean()).name, "الاسم الجديد");
  assert.equal(await Customer.countDocuments(), 1);
});

it("a trial cannot replace a lifetime license (and the lifetime one stays), and an already expired trial is refused", async () => {
  await start({ text: issueTestLicense({}) });
  const refused = await call("POST", "/api/license/activate", { license: trialLicense() });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "LICENSE_INVALID");
  assert.equal(refused.json.reason, "TRIAL_CANNOT_REPLACE_LIFETIME");
  assert.equal(license.details().type, "lifetime");

  installTestLicense({}, trialLicense());
  setNow(T0 + 31 * DAY);
  const expired = await call("POST", "/api/license/activate", { license: trialLicense({ expiresAt: iso(T0 + 30 * DAY) }) });
  assert.equal(expired.status, 400);
  assert.equal(expired.json.reason, "EXPIRED");
  // a fresh trial may replace a trial
  setNow(T0);
  ok(await call("POST", "/api/license/activate", { license: trialLicense({ expiresAt: iso(T0 + 90 * DAY) }) }));
  assert.equal(license.details().expiresAt, iso(T0 + 90 * DAY));
});

it("a lifetime license behaves exactly as before: no trial fields, writes work however far the clock goes", async () => {
  await start({ text: issueTestLicense({}) });
  setNow(T0 + 5000 * DAY);
  ok(await saveProfile());
  ok(await call("POST", "/api/customers", { name: "عميل", phone: "01000000000" }), 201);
  const info = ok(await call("GET", "/api/license/info"));
  assert.equal(info.type, "lifetime");
  assert.equal(info.expiresAt, undefined);
  assert.equal(info.trial, undefined);
  const status = ok(await call("GET", "/api/license/status"));
  assert.deepEqual(Object.keys(status).sort(), ["code", "licensed", "machineId", "shopName", "shopNameEn"]);
});
