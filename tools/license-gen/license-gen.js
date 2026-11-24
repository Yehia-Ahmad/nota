#!/usr/bin/env node
// Nota vendor license tool (Stage 24). Runs on the vendor's own PC only. Never ships with the app.
//
//   node license-gen.js keygen --out <dir>
//   node license-gen.js issue  --key <private.pem> --machine XXXX-XXXX-XXXX-XXXX --shop "الاسم التجاري" [--shop-en "Name"] --max-clients N [--out file.lic]
//   node license-gen.js issue  --type trial (--days <1-90> | --hours <1-72> | --expires <ISO datetime>) ...same flags as above
//   (a license is lifetime unless --type trial is given)
//   node license-gen.js verify --pub <public.pem> <file.lic>
//
// The license text format comes from the backend's own module, so what this tool issues is exactly what the backend checks.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { encodePayload, buildText, parseText, payloadProblem, MACHINE_ID_PATTERN } = require("../../nota-backend/src/license/format");

const CSV_NAME = "issued-licenses.csv";

const fail = (message) => { process.stderr.write(`error: ${message}\n`); process.exit(1); };

/** `--name value` pairs and bare words. */
const parseArgs = (argv) => {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`missing value for ${argv[i]}`);
      flags[argv[i].slice(2)] = next; i += 1;
    } else rest.push(argv[i]);
  }
  return { flags, rest };
};

const keygen = ({ out }) => {
  if (!out) fail("keygen needs --out <dir>");
  const dir = path.resolve(out);
  const privatePath = path.join(dir, "private.pem");
  const publicPath = path.join(dir, "public.pem");
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) fail(`a key already exists in ${dir}. Refusing to overwrite it (delete it by hand only if you are sure)`);
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(publicPath, publicPem, { flag: "wx" });
  process.stdout.write(`Created ${privatePath} (KEEP OFFLINE, back it up) and ${publicPath}.\n\nPublic key to compile into nota-backend/src/license/keys.js:\n${publicPem}`);
};

const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;

const CSV_HEADER = "licenseId,date,shop,machine,maxClients,type,expiresAt";
const OLD_CSV_HEADER = "licenseId,date,shop,machine,maxClients";
const BOM = "﻿";

/** The expiry flags of a trial: exactly one of --days (1..90), --hours (1..72), --expires <ISO datetime with a time zone>. Returns an ISO string. */
const trialExpiry = (flags, issuedAt) => {
  const given = ["days", "hours", "expires"].filter((name) => flags[name] !== undefined);
  if (given.length !== 1) fail("a trial needs exactly one of --days <1-90>, --hours <1-72> or --expires <ISO datetime>" + (given.length ? ` (got ${given.map((name) => `--${name}`).join(" and ")})` : ""));
  const [name] = given;
  const value = flags[name].trim();
  if (name === "expires") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) fail("--expires must be an ISO datetime with a time zone, e.g. 2026-12-31T23:59:00+02:00 or 2026-12-31T21:59:00Z");
    const at = new Date(value);
    if (at.getTime() <= issuedAt.getTime()) fail("--expires must be in the future");
    return at.toISOString();
  }
  const [max, unit, ms] = name === "days" ? [90, "days", 86400000] : [72, "hours", 3600000];
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) fail(`--${name} must be a whole number from 1 to ${max}`);
  return new Date(issuedAt.getTime() + Number(value) * ms).toISOString();
};

/** Splits one CSV line into cells (quoted cells, "" for a quote). Enough for the lines this tool writes. */
const csvCells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]));

/** Machine IDs that already have a trial in the log (old rows have no type column and are never a trial). */
const trialMachinesInLog = (csv) => {
  if (!fs.existsSync(csv)) return new Set();
  const lines = fs.readFileSync(csv, "utf8").replace(new RegExp(`^${BOM}`), "").split(/\r?\n/).filter(Boolean).slice(1);
  return new Set(lines.map(csvCells).filter((cells) => cells[5] === "trial").map((cells) => cells[3]));
};

/** Appends a row. A log written before the type/expiresAt columns gets its header line extended; its old rows are left as they are. */
const appendLog = (csv, row) => {
  if (!fs.existsSync(csv)) {
    fs.writeFileSync(csv, `${BOM}${CSV_HEADER}\n`, "utf8");
  } else {
    const text = fs.readFileSync(csv, "utf8");
    const first = text.replace(new RegExp(`^${BOM}`), "").split(/\r?\n/)[0];
    if (first === OLD_CSV_HEADER) fs.writeFileSync(csv, text.replace(OLD_CSV_HEADER, CSV_HEADER), "utf8");
    if (!text.endsWith("\n")) fs.appendFileSync(csv, "\n", "utf8");
  }
  fs.appendFileSync(csv, `${row.map(csvCell).join(",")}\n`, "utf8");
};

const cairoTime = (date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", dateStyle: "full", timeStyle: "medium" }).format(date);

const issue = (flags) => {
  const { key, machine, shop, "shop-en": shopEn, "max-clients": maxClientsText, out } = flags;
  const type = flags.type === undefined ? "lifetime" : flags.type.trim();
  if (type !== "lifetime" && type !== "trial") fail("--type must be lifetime or trial");
  if (type === "lifetime" && ["days", "hours", "expires"].some((name) => flags[name] !== undefined)) fail("--days, --hours and --expires are only for --type trial");
  if (!key || !machine || !shop || maxClientsText === undefined) fail("issue needs --key, --machine, --shop and --max-clients");
  const machineId = machine.trim().toUpperCase();
  if (!MACHINE_ID_PATTERN.test(machineId)) fail("--machine must look like XXXX-XXXX-XXXX-XXXX (hex)");
  if (!/^\d+$/.test(maxClientsText)) fail("--max-clients must be a whole number (0 = main PC only)");
  const maxClients = Number(maxClientsText);
  const issuedAtDate = new Date();
  const expiresAt = type === "trial" ? trialExpiry(flags, issuedAtDate) : null;
  let privateKey;
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(key))); } catch (error) { fail(`cannot read the private key: ${error.message}`); }
  const payload = {
    v: 1,
    licenseId: `NOTA-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    type,
    shopName: shop.trim(),
    ...(shopEn && shopEn.trim() ? { shopNameEn: shopEn.trim() } : {}),
    machineId,
    maxClients,
    issuedAt: issuedAtDate.toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
  };
  const problem = payloadProblem(payload);
  if (problem) fail(`the license would be invalid (${problem}): check the business name length and --max-clients (0 to 1000)`);
  const bytes = encodePayload(payload);
  const text = buildText(bytes, crypto.sign(null, bytes, privateKey));
  if (out) fs.writeFileSync(path.resolve(out), `${text}\n`, "utf8");
  const csv = path.join(path.dirname(path.resolve(key)), CSV_NAME);
  if (type === "trial" && trialMachinesInLog(csv).has(machineId)) process.stderr.write(`warning: ${machineId} already has a trial license in ${csv}. Issuing another one anyway.\n`);
  appendLog(csv, [payload.licenseId, payload.issuedAt, payload.shopName, machineId, maxClients, type, expiresAt || ""]);
  process.stdout.write(`${text}\n`);
  process.stderr.write(`${type === "trial" ? "Trial license" : "License"} ${payload.licenseId} for "${payload.shopName}" (${machineId}, ${maxClients} client PCs)${out ? `, written to ${out}` : ""}. Logged in ${csv}
`);
  if (expiresAt) process.stderr.write(`Expires: ${expiresAt} (Cairo time: ${cairoTime(new Date(expiresAt))})\n`);
};

const verify = ({ pub }, files) => {
  if (!pub || files.length !== 1) fail("verify needs --pub <public.pem> <file.lic>");
  let publicKey;
  try { publicKey = crypto.createPublicKey(fs.readFileSync(path.resolve(pub))); } catch (error) { fail(`cannot read the public key: ${error.message}`); }
  const parsed = parseText(fs.readFileSync(path.resolve(files[0]), "utf8"));
  if (!parsed) fail("not a Nota license (expected NOTA1.<payload>.<signature>)");
  let signed = false;
  try { signed = crypto.verify(null, parsed.payloadBytes, publicKey, parsed.signature); } catch { signed = false; }
  process.stdout.write(`${JSON.stringify(parsed.payload, null, 2)}\n`);
  if (!signed) fail("INVALID: the signature does not match this public key");
  const problem = payloadProblem(parsed.payload);
  if (problem) fail(`INVALID: ${problem}`);
  process.stdout.write("OK: signature valid. (It still only works on the PC whose Machine ID is in the license.)\n");
};

const main = () => {
  const [command, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);
  if (command === "keygen") return keygen(flags);
  if (command === "issue") return issue(flags);
  if (command === "verify") return verify(flags, rest);
  return fail("usage: license-gen.js keygen --out <dir> | issue --key <private.pem> --machine <ID> --shop <name> [--shop-en <name>] --max-clients <N> [--out file.lic] [--type trial --days N|--hours N|--expires ISO] | verify --pub <public.pem> <file.lic>");
};

main();
