# Nota license tool (vendor only)

Issues the lifetime licenses that unlock Nota on a business's main PC. It is plain Node code, with no dependencies, and runs on **your** PC. It never ships with the app. The **private key never enters this repo**.

## 1. Create the key pair (once)

```
node tools/license-gen/license-gen.js keygen --out D:\nota-keys
```

- Writes `private.pem` and `public.pem` into that folder. It refuses to overwrite an existing key.
- Put the folder **outside the repo**, on a USB stick you keep offline, **and make a second backup copy** (another USB or a safe). If the private key is lost you cannot issue licenses for any business, and if it leaks anyone can.
- `*.pem`, `*.key`, `issued-licenses.csv` and `tools/license-gen/keys/` are git-ignored, and a backend test fails if a private key shows up anywhere in the repo.

## 2. Give the public key to the release build (every release)

The **public** key is compiled into the app (no setting, file or environment variable of the business can replace it). The repo keeps its **placeholder** in `nota-backend/src/license/keys.js` on purpose: your real key is never committed. You point the release build to your `public.pem` and the build swaps it into the **staged copy only**:

```
set NOTA_RELEASE_PUBLIC_KEY_FILE=D:\nota-keys\public.pem
npm run release:win
```

(`npm run offline:stage` takes the same variable, for a stage you build by hand.)

- The build refuses the file if it is a **private** key, still the placeholder, not an Ed25519 key, or the **test** key. It records the key's fingerprint in `offline-stage/release-key.json`, and the release note (`release-offline/<version>/release-note.md`) prints it, so you can see which key a given installer carries.
- **Build guard:** `scripts/offline/build-guard.js` checks the **staged** backend (not the source tree) before electron-builder runs: no key record, a placeholder, the test key or a non-releasable marker all stop the build. It never honours `NOTA_ALLOW_PLACEHOLDER_KEY`.
- `NOTA_ALLOW_PLACEHOLDER_KEY=1 npm run offline:stage` builds a stage with the placeholder for development verification only: it is marked non-releasable (`offline-stage/NON_RELEASABLE.json`) and the installer build always refuses it, whatever the environment. `release:win` refuses to start while that variable is set.
- To try a release build without your real key, make a throwaway pair with `keygen` in a temp folder, point `NOTA_RELEASE_PUBLIC_KEY_FILE` to its `public.pem`, build, and **delete the temp folder**. Nothing in the repo changes, so there is nothing to put back.
- Only ever the **public** key is given to a build. `docs/release/RELEASE_CHECKLIST.md` has the full release procedure.

## 3. Issue a license for a business

1. On the business's main PC, install Nota. The activation screen shows the **Machine ID** (`XXXX-XXXX-XXXX-XXXX`) with a copy button. The customer sends it to you.
2. Issue the license:

```
node tools/license-gen/license-gen.js issue --key D:\nota-keys\private.pem ^
  --machine 1A2B-3C4D-5E6F-7A8B --shop "الاسم التجاري" --shop-en "Business Name" ^
  --max-clients 3 --out nota.lic
```

   - `--shop` is the name the app shows and prints. It is locked to the license, so check the spelling.
   - `--shop-en` is optional.
   - `--max-clients` is how many **client PCs** may pair with the main PC (`0` = main PC only).
   - It prints the license text (one line starting with `NOTA1.`), writes `nota.lic` if you passed `--out`, and appends a line to `issued-licenses.csv` **next to the private key** (licenseId, date, business, machine, maxClients).
3. Send the customer the text or the `nota.lic` file. They paste it into the activation screen or load the file.

A license is **lifetime** (no expiry) unless you pass `--type trial`. The first business gets a lifetime license exactly like any other, issued at no cost.

### Trial license (expires)

A trial is the same license (same Machine ID, business name and `--max-clients`) with an `expiresAt`. Add `--type trial` and **exactly one** of:

- `--days <1-90>`: expires after n × 24 hours from the moment you issue it.
- `--hours <1-72>`: expires after n hours (for your own testing).
- `--expires <ISO datetime>`: an exact end, with a time zone, in the future (for example `2026-12-31T23:59:00+02:00`).

None or more than one of them is refused, and so is a value outside the range.

```
:: 30 days
node tools/license-gen/license-gen.js issue --key D:\nota-keys\private.pem --machine 1A2B-3C4D-5E6F-7A8B --shop "الاسم التجاري" --max-clients 3 --type trial --days 30 --out nota-trial.lic

:: 1 day
node tools/license-gen/license-gen.js issue --key D:\nota-keys\private.pem --machine 1A2B-3C4D-5E6F-7A8B --shop "الاسم التجاري" --max-clients 3 --type trial --days 1 --out nota-trial.lic

:: 1 hour (testing)
node tools/license-gen/license-gen.js issue --key D:\nota-keys\private.pem --machine 1A2B-3C4D-5E6F-7A8B --shop "الاسم التجاري" --max-clients 3 --type trial --hours 1 --out nota-trial.lic
```

- After issuing, the tool prints the expiry in ISO form and in **Cairo local time**.
- `issued-licenses.csv` has two more columns, `type` and `expiresAt` (a log written by the older tool keeps its rows and gets the two columns in its header). It **warns** (and still issues) when the log already has a trial for the same Machine ID.
- While the trial runs the app works like a lifetime license and shows a countdown banner. After `expiresAt` it is **view-only** (reads, reports, export, printing old documents and backups work; every save is refused). If the PC's clock is moved back by more than an hour the trial stops until the clock is fixed.
- **Turn it into a lifetime license:** issue a normal license (no `--type`) for the same Machine ID. The owner uses "Replace license" in Business details. It works even when the trial has ended and even if the business name is different; no data is lost. A trial can never replace a lifetime license.

## Check a license

```
node tools/license-gen/license-gen.js verify --pub D:\nota-keys\public.pem nota.lic
```

Shows what is inside and whether the signature is valid.

## Good to know

- **A Windows reinstall changes the Machine ID.** The business sends the new ID and you issue a new license. Their data on disk is untouched.
- Copying the app, the data folder or the license file to another PC does not work: the license is tied to the Machine ID of the PC it was issued for.
- To replace a license (new Machine ID, more client PCs), issue a new one and the business owner uses "replace license" in the Business details.
