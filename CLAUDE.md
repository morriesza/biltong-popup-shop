# Biltong Floor Log (Safari Cafe pop-up) - project notes

Internal staff app for a biltong pop-up shop. Owner: Morne Roets. Hosted free on GitHub Pages
(https://morriesza.github.io/biltong-popup-shop/). Repo: morriesza/biltong-popup-shop.

## Files
- `index.html` - the entire app: one self-contained file (HTML + CSS + inline JS IIFE). No build step, no frameworks.
- `manifest.json`, `sw.js` - PWA install support (Android "Install app" prompt; iOS only supports Add to Home Screen).
- `img/SafariCafe-logo.png` - logo, shown full width at the top of every screen.
- `square-worker/worker.js` - Cloudflare Worker ("the worker"): PIN login + Square sales. Holds the secrets. Owner pastes it into the
  Cloudflare dashboard by hand (Workers & Pages -> biltong-square -> Edit code), so every change to it needs that step.
- `firestore.rules` - the Firestore security rules; owner pastes them into the Firebase console (Firestore -> Rules) and publishes.

## What the app does
- 6-character PIN login (characters 0-9 and A/B/C). Employees are stored in Firestore.
- Cloud login: the app POSTs the PIN to the worker's /login, which looks it up with the Firebase service account, rate limits
  wrong guesses (10 per device / 100 overall per 15 min, counters in the `loginGuard` collection), and returns a Firebase custom
  token (uid = employees doc id, claims `boss`, `staffName`). The app signs in with it; the Firebase session persists across reloads.
  The app never reads PINs except on the boss's Staff screen. Nothing is loaded before sign-in. Demo mode still checks PINs locally.
- There is no automatic owner seeding any more: a brand-new project needs its first boss added in the Firebase console
  (employees doc with name, pin, isAdmin=true).
- Staff flow: Time-In, Cash-In, Stock-In at start; Stock-Out, Cash-Out, Time-Out at end. Stock Delivery (restock) any time.
- Cash is counted per denomination (AUD: $100, $50, $20, $10, $5, $2, $1, 50c, 20c, 10c, 5c); total is calculated live; breakdown is saved on the event.
- Stock is weighed in grams per flavour. Flavours have low-stock thresholds; a red banner shows when any flavour is at or below threshold.
- Boss (isAdmin) gets Manage: Flavours, Staff, Staff Hours, Activity log, Stock Log (closing-stock trend per flavour + deliveries),
  Stock Check, Weekly Sales, Email Reports, Database.
- Staff Hours: one shift per person per day (earliest Time-In, latest Time-Out; boss-added entries win, latest added counts),
  hours per day and 7-day totals, "Missing - add" for gaps. The boss can add a missed Time-In/Out for anyone: a new `time` event
  with `atMs` (the real time), `manual: true`, `enteredById`/`enteredByName` (the boss) and optional `note`. Use `eventTime(e)`
  (atMs || createdAt) wherever a time entry's time matters.
- Captured events (time/cash/stock/restock) are an append-only audit trail. The UI never offers edit or delete for them.
  Firestore rules enforce `allow update, delete: if false` on `events`. Corrections are new entries.

## Data (Firebase Firestore, project biltong-popup-toowong)
- Collections: `employees`, `flavours`, `events`, `loginGuard` (worker only; closed to the app).
- Event types: `time` (dir; boss-added ones also atMs, manual, enteredById, enteredByName, note), `cash` (amount + breakdown), `stock` (readings map, flagged list), `restock` (flavourId, flavourName, amountG, note),
  `sales` (Square stock check: day, orders, rows, unmatched, unweighed, flagged).
- The Firebase web config is embedded in `index.html` (EMBEDDED_FIREBASE_CONFIG) on purpose: it is not a secret, staff must never have
  to paste credentials on their own phones, and the real protection is the Firestore security rules (`firestore.rules`):
  signed-in staff only (and their employees doc must still exist), events append-only and stamped with their own uid
  (or, for boss-added `time` events, enteredById == the boss's uid),
  staff may only change flavours' lastStockG/lastStockAt, employees (PINs) boss only. Do NOT change this to a per-device setup.
  A per-device override still exists under Manage -> Database for testing only.
- If the config is null the app falls back to a localStorage demo mode.

## End-of-day email (EmailJS)
- Sent after Cash-Out via EmailJS (client-side, free tier 200/month). SDK: `@emailjs/browser@3` from jsDelivr.
- Config is `EMBEDDED_EMAILJS_CONFIG` in index.html (baked in, same pattern as Firebase) or a per-device override under Manage -> Email Reports.
  Template variables sent: `subject`, `message` (plain text with line breaks), plus `title` and `name` for EmailJS's default template.
  `to_email` is only sent for a per-device override that sets a recipient.
- PUBLIC REPO: never commit email addresses, private keys or other personal details. The report recipient is typed directly into the
  EmailJS template's "To Email" field (not `{{to_email}}`), so the address stays out of the code and nobody can reuse the public
  IDs to email anyone else. Template content should be `<div style="white-space:pre-wrap">{{message}}</div>` (double braces = escaped)
  so line breaks show; never use triple braces. The EmailJS private key is never needed by the app.

## Square stock check
- Square sells biltong by weight on the scale; all sales (cash too) go through Square. Tasters are NOT rung up - the app estimates them.
- The worker (https://biltong-square.mroets.workers.dev) holds secrets `SQUARE_TOKEN` and `FIREBASE_SERVICE_ACCOUNT` (never in this repo,
  never in chat), plus `ALLOWED_ORIGIN` = https://morriesza.github.io and optional `LOCATION_IDS`. /sales and /status need the app's
  Firebase ID token (verified against Google's keys). It returns only grams/cents per item.
- App config: `EMBEDDED_WORKER_URL` (login + Square) and `EMBEDDED_SQUARE_CONFIG = { salesUrl: EMBEDDED_WORKER_URL }` (null = check skipped).
  The worker URL is not a secret.
- At Stock-Out the app fetches sales since that day's Stock-In and logs a `sales` event (append-only) with per-flavour rows:
  missing = open + deliveries - sold - close; drying estimated from the overnight drop (Stock-Out -> next Stock-In, avg of last 10 nights);
  tasters = missing - drying. Flag when unexplained > RECON_TOLERANCE_G and > RECON_TOLERANCE_PCT of sold, or over by RECON_OVER_G.
- Square items match flavours by name (item, variation or both; case/punctuation ignored) or the flavour's `squareName` override.
- Screens: `stockcheck` (shown after Stock-Out; staff see sold + re-weigh prompts) and Manage -> Stock Check (boss detail, 7-day totals).
- Manage -> Weekly Sales (boss): live Square sales for a Monday-Sunday week, grouped per flavour (grams, $, avg $/kg, share) and
  per day, with previous/next week. Fetched one day per /sales call (worker max window is 36 h), nothing saved.
  Amounts are Square gross sales (before discounts). The end-of-day email also includes this week's Square sales per flavour
  (fetchWeekSales(0)); if Square can't be reached the email still sends with a note.
- Drying estimates depend on Stock-In being a real weigh-in (it is pre-filled with last close).

## Hard-won rules (do not repeat these mistakes)
- Bump `APP_VERSION` in index.html on every change that ships (format YYYY-MM-DD.N). The app fetches the live page every 5 min and
  when it comes back on screen, and shows an "Update now" banner when the version differs - tablets/home-screen apps otherwise keep
  showing an old cached copy. The version is shown on the PIN screen and under Manage.
- Smoke-test harnesses should stub setInterval (the update check's 5-minute timer keeps node running).
- Keep the file ASCII-only. Earlier, UTF-8 double-encoding produced "A-circumflex" junk characters in the UI.
- JS strings use single quotes: escape apostrophes in contractions (\') or the whole script breaks and the page goes blank.
- Before shipping ANY edit: extract the inline `<script>`, run `node --check` on it, and smoke-test with stubbed browser globals
  (document, window, localStorage, firebase incl. firebase.auth, emailjs, fetch). The owner has hit blank-page bugs before.
- Any client write must still pass `firestore.rules` (events need employeeId == signed-in uid; staff flavour updates only touch
  lastStockG/lastStockAt). Change the rules file alongside the code when that changes.
- Firestore cannot connect inside the Claude artifact preview (sandbox blocks the connections). It only works once hosted (GitHub Pages).
  The app shows a timeout error screen there; that is expected.
- Shared config ships with the file. Never require staff to enter database or email details.

## Open items / ideas
- Confirm the first real end-of-day email arrives and looks right.
- PIN login via the worker is live (Firebase Authentication on, FIREBASE_SERVICE_ACCOUNT set, firestore.rules published).
  PINs were publicly readable before this; owner advised to change all PINs (boss first).
- Owner was walked through restricting the Firebase API key in Google Cloud Console (HTTP referrer = the GitHub Pages site, API = Firestore only);
  done: the app's key (Sep 29) is referrer-restricted and allows Cloud Firestore, Identity Toolkit and Token Service APIs.
  A second auto-created browser key (Oct 8) is unused by the app.
- Consider more history than the latest 400 events for long-term trend views (e.g. a daily snapshot collection).

## Workflow
The owner works from a Samsung tablet and prefers plain, short explanations and no CLI steps. Changes go to `index.html`
(rename of the old biltong-app.html). GitHub Pages redeploys within a minute or two of a push.
