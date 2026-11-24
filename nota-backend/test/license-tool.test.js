process.env.NODE_ENV = "test";

// Stage 24: tools/license-gen (keygen / issue / verify) and its tie to the backend's verification. No database needed.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const license = require("../src/license");
const { getMachineId } = require("../src/license/machineId");
const { testPrivateKey } = require("./helpers/license");

const TOOL = path.join(__dirname, "..", "..", "tools", "license-gen", "license-gen.js");
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nota-licgen-"));
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); license.resetForTests(); delete process.env.NOTA_LICENSE_DIR; });

test("keygen creates an Ed25519 pair and refuses to overwrite it", () => {
  const dir = path.join(tmp, "keys");
  const first = run("keygen", "--out", dir);
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(path.join(dir, "private.pem"), "utf8");
  assert.match(before, /BEGIN PRIVATE KEY/);
  assert.match(fs.readFileSync(path.join(dir, "public.pem"), "utf8"), /BEGIN PUBLIC KEY/);
  const second = run("keygen", "--out", dir);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, "private.pem"), "utf8"), before, "the key is unchanged");
});

test("issue -> verify round trip, the CSV line is written next to the key, a wrong key fails verify", () => {
  const dir = path.join(tmp, "keys2");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const lic = path.join(tmp, "shop.lic");
  const issued = run("issue", "--key", path.join(dir, "private.pem"), "--machine", "1a2b-3c4d-5e6f-7a8b", "--shop", "محل النور", "--shop-en", "Al Nour", "--max-clients", "3", "--out", lic);
  assert.equal(issued.status, 0, issued.stderr);
  const text = issued.stdout.trim();
  assert.ok(text.startsWith("NOTA1."));
  assert.equal(fs.readFileSync(lic, "utf8").trim(), text);

  const good = run("verify", "--pub", path.join(dir, "public.pem"), lic);
  assert.equal(good.status, 0, good.stderr);
  const payload = JSON.parse(good.stdout.slice(0, good.stdout.lastIndexOf("}") + 1));
  assert.equal(payload.shopName, "محل النور");
  assert.equal(payload.shopNameEn, "Al Nour");
  assert.equal(payload.machineId, "1A2B-3C4D-5E6F-7A8B");
  assert.equal(payload.maxClients, 3);
  assert.equal(payload.type, "lifetime");

  const csv = fs.readFileSync(path.join(dir, "issued-licenses.csv"), "utf8").replace(/^﻿/, "").trim().split("\n");
  assert.equal(csv[0], "licenseId,date,shop,machine,maxClients,type,expiresAt");
  assert.equal(csv.length, 2);
  assert.ok(csv[1].includes(payload.licenseId) && csv[1].includes("محل النور") && csv[1].includes("1A2B-3C4D-5E6F-7A8B") && csv[1].endsWith('"3","lifetime",""'));

  const other = path.join(tmp, "other");
  assert.equal(run("keygen", "--out", other).status, 0);
  assert.notEqual(run("verify", "--pub", path.join(other, "public.pem"), lic).status, 0, "another public key does not verify it");
});

test("issue refuses a bad machine id, a missing key and a non-numeric --max-clients", () => {
  const dir = path.join(tmp, "keys3");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const key = path.join(dir, "private.pem");
  assert.notEqual(run("issue", "--key", key, "--machine", "nope", "--shop", "x", "--max-clients", "1").status, 0);
  assert.notEqual(run("issue", "--key", key, "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "x", "--max-clients", "many").status, 0);
  assert.notEqual(run("issue", "--key", path.join(dir, "missing.pem"), "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "x", "--max-clients", "1").status, 0);
  assert.ok(!fs.existsSync(path.join(dir, "issued-licenses.csv")), "nothing is logged for a refused license");
});

test("the backend accepts what the tool issues (signed with the test key, for this PC) and refuses it signed by an unknown key", () => {
  const pem = path.join(tmp, "test-private.pem");
  fs.writeFileSync(pem, testPrivateKey().export({ type: "pkcs8", format: "pem" }));
  const issued = run("issue", "--key", pem, "--machine", getMachineId(), "--shop", "محل الاختبار", "--max-clients", "1");
  assert.equal(issued.status, 0, issued.stderr);
  const result = license.verifyText(issued.stdout.trim());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.payload.maxClients, 1);

  const unknown = path.join(tmp, "unknown");
  assert.equal(run("keygen", "--out", unknown).status, 0);
  const foreign = run("issue", "--key", path.join(unknown, "private.pem"), "--machine", getMachineId(), "--shop", "x", "--max-clients", "1");
  assert.equal(license.verifyText(foreign.stdout.trim()).code, "BAD_SIGNATURE");
});

test("the .gitignore covers keys, the issue log and license files", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", "..", ".gitignore"), "utf8");
  for (const pattern of ["*.pem", "*.key", "issued-licenses.csv", "tools/license-gen/keys/"]) assert.ok(ignore.split(/\r?\n/).includes(pattern), pattern);
  assert.ok(ignore.split(/\r?\n/).includes("nota-review/"), "the earlier entry is kept");
});

// ---- trial licenses ------------------------------------------------------------------------------------------------

const issueTrial = (dir, ...flags) => run("issue", "--key", path.join(dir, "private.pem"), "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "محل التجربة", "--max-clients", "1", "--type", "trial", ...flags);
const payloadOf = (result) => JSON.parse(Buffer.from(result.stdout.trim().split(".")[1], "base64url").toString("utf8"));
const HOUR = 3600 * 1000;

test("issue --type trial: --days 1, --days 30 and --hours 1 set expiresAt = issue time + n x 24h / n hours", () => {
  const dir = path.join(tmp, "trial-keys");
  assert.equal(run("keygen", "--out", dir).status, 0);
  for (const [flags, ms] of [[["--days", "1"], 24 * HOUR], [["--days", "30"], 30 * 24 * HOUR], [["--hours", "1"], HOUR], [["--days", "90"], 90 * 24 * HOUR], [["--hours", "72"], 72 * HOUR]]) {
    const issued = issueTrial(dir, ...flags);
    assert.equal(issued.status, 0, issued.stderr);
    const payload = payloadOf(issued);
    assert.equal(payload.type, "trial");
    assert.equal(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt), ms, flags.join(" "));
    assert.ok(/Expires: .*\(Cairo time: .+\)/.test(issued.stderr), "the expiry is printed in Cairo local time");
  }
});

test("issue --type trial --expires takes an ISO datetime with a time zone, in the future only", () => {
  const dir = path.join(tmp, "trial-keys-expires");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const future = new Date(Date.now() + 5 * 24 * HOUR).toISOString();
  const issued = issueTrial(dir, "--expires", future);
  assert.equal(issued.status, 0, issued.stderr);
  assert.equal(payloadOf(issued).expiresAt, future);
  const cairo = issueTrial(dir, "--expires", "2099-01-01T10:00:00+02:00");
  assert.equal(payloadOf(cairo).expiresAt, "2099-01-01T08:00:00.000Z");
  for (const bad of ["2099-01-01T10:00:00" /* no zone */, "tomorrow", "2099-01-01", new Date(Date.now() - HOUR).toISOString()]) {
    assert.notEqual(issueTrial(dir, "--expires", bad).status, 0, bad);
  }
});

test("issue --type trial refuses zero, negative, too large, fractional, missing and combined expiry flags; nothing is logged", () => {
  const dir = path.join(tmp, "trial-keys-bad");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const future = new Date(Date.now() + 5 * 24 * HOUR).toISOString();
  const refused = [
    [], ["--days", "0"], ["--days", "-1"], ["--days", "91"], ["--days", "1.5"], ["--days", "abc"],
    ["--hours", "0"], ["--hours", "-3"], ["--hours", "73"], ["--hours", "0.5"],
    ["--days", "1", "--hours", "1"], ["--days", "1", "--expires", future], ["--hours", "1", "--expires", future], ["--days", "1", "--hours", "1", "--expires", future],
  ];
  for (const flags of refused) {
    const result = issueTrial(dir, ...flags);
    assert.notEqual(result.status, 0, flags.join(" "));
    assert.ok(result.stderr.includes("error:"), flags.join(" "));
  }
  assert.match(issueTrial(dir).stderr, /exactly one of --days/);
  assert.match(issueTrial(dir, "--days", "1", "--hours", "1").stderr, /exactly one of --days/);
  assert.ok(!fs.existsSync(path.join(dir, "issued-licenses.csv")), "nothing is logged for a refused license");
  // the expiry flags only make sense for a trial; an unknown type is refused
  assert.notEqual(run("issue", "--key", path.join(dir, "private.pem"), "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "x", "--max-clients", "1", "--days", "5").status, 0);
  assert.notEqual(run("issue", "--key", path.join(dir, "private.pem"), "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "x", "--max-clients", "1", "--type", "yearly").status, 0);
});

test("the default type stays lifetime: no expiresAt in the payload, verify says OK", () => {
  const dir = path.join(tmp, "trial-keys-default");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const lic = path.join(tmp, "default.lic");
  const issued = run("issue", "--key", path.join(dir, "private.pem"), "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "محل", "--max-clients", "1", "--out", lic);
  assert.equal(issued.status, 0, issued.stderr);
  const payload = payloadOf(issued);
  assert.equal(payload.type, "lifetime");
  assert.equal("expiresAt" in payload, false);
  assert.ok(!issued.stderr.includes("Expires:"));
  assert.equal(run("verify", "--pub", path.join(dir, "public.pem"), lic).status, 0);
  const trial = path.join(tmp, "trial.lic");
  assert.equal(issueTrial(dir, "--days", "2", "--out", trial).status, 0);
  const verified = run("verify", "--pub", path.join(dir, "public.pem"), trial);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /"expiresAt"/);
});

test("issued-licenses.csv gets type and expiresAt columns, an old log stays readable, and a second trial for one machine warns", () => {
  const dir = path.join(tmp, "trial-keys-csv");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const csvPath = path.join(dir, "issued-licenses.csv");
  // a log written by the old tool
  fs.writeFileSync(csvPath, '﻿licenseId,date,shop,machine,maxClients\n"NOTA-OLD","2026-01-01T00:00:00.000Z","محل قديم","1A2B-3C4D-5E6F-7A8B","2"\n', "utf8");
  const first = issueTrial(dir, "--days", "1");
  assert.equal(first.status, 0, first.stderr);
  assert.ok(!first.stderr.includes("warning"), "the old lifetime row is not a trial");
  const second = issueTrial(dir, "--hours", "1");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /warning: 1A2B-3C4D-5E6F-7A8B already has a trial/);
  const lines = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "").trim().split("\n");
  assert.equal(lines[0], "licenseId,date,shop,machine,maxClients,type,expiresAt");
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes("NOTA-OLD") && lines[1].endsWith('"2"'), "the old row is unchanged");
  assert.ok(lines[2].includes('"trial","') && lines[3].includes('"trial","'));
  assert.ok(lines[2].includes(payloadOf(first).expiresAt));
});
