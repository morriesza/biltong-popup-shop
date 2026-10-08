# Biltong Floor Log (Safari Cafe pop-up) - project notes

Internal staff app for a biltong pop-up shop. Owner: Morne Roets. Hosted free on GitHub Pages
(https://morriesza.github.io/biltong-popup-shop/). Repo: morriesza/biltong-popup-shop.

## Files
- `index.html` - the entire app: one self-contained file (HTML + CSS + inline JS IIFE). No build step, no frameworks.
- `manifest.json`, `sw.js` - PWA install support (Android "Install app" prompt; iOS only supports Add to Home Screen).
- `img/SafariCafe-logo.png` - logo, shown full width at the top of every screen.
- `square-worker/worker.js` - Cloudflare Worker that reads Square sales (holds the Square token as a secret).

## What the app does
- 6-character PIN login (characters 0-9 and A/B/C). Employees are stored in Firestore.
- Staff flow: Time-In, Cash-In, Stock-In at start; Stock-Out, Cash-Out, Time-Out at end. Stock Delivery (restock) any time.
- Cash is counted per denomination (AUD: $100, $50, $20, $10, $5, $2, $1, 50c, 20c, 10c, 5c); total is calculated live; breakdown is saved on the event.
- Stock is weighed in grams per flavour. Flavours have low-stock thresholds; a red banner shows when any flavour is at or below threshold.
- Boss (isAdmin) gets Manage: Flavours, Staff, Activity log, Stock Log (closing-stock trend per flavour + deliveries), Email Reports, Database.
- Captured events (time/cash/stock/restock) are an append-only audit trail. The UI never offers edit or delete for them.
  Firestore rules enforce `allow update, delete: if false` on `events`. Corrections are new entries.

## Data (Firebase Firestore, project biltong-popup-toowong)
- Collections: `employees`, `flavours`, `events`.
- Event types: `time`, `cash` (amount + breakdown), `stock` (readings map, flagged list), `restock` (flavourId, flavourName, amountG, note),
  `sales` (Square stock check: day, orders, rows, unmatched, unweighed, flagged).
- The Firebase web config is embedded in `index.html` (EMBEDDED_FIREBASE_CONFIG) on purpose: it is not a secret, staff must never have
  to paste credentials on their own phones, and the real protection is the Firestore security rules. Do NOT change this to a per-device setup.
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
- `square-worker/worker.js` is a Cloudflare Worker that holds the Square access token as the secret `SQUARE_TOKEN` (never in this repo,
  never in chat). Also `ALLOWED_ORIGIN` = https://morriesza.github.io and optional `LOCATION_IDS`. It returns only grams/cents per item.
- App config: `EMBEDDED_SQUARE_CONFIG = { salesUrl: "<worker URL>" }` (null = check skipped). The worker URL is not a secret.
- At Stock-Out the app fetches sales since that day's Stock-In and logs a `sales` event (append-only) with per-flavour rows:
  missing = open + deliveries - sold - close; drying estimated from the overnight drop (Stock-Out -> next Stock-In, avg of last 10 nights);
  tasters = missing - drying. Flag when unexplained > RECON_TOLERANCE_G and > RECON_TOLERANCE_PCT of sold, or over by RECON_OVER_G.
- Square items match flavours by name (item, variation or both; case/punctuation ignored) or the flavour's `squareName` override.
- Screens: `stockcheck` (shown after Stock-Out; staff see sold + re-weigh prompts) and Manage -> Stock Check (boss detail, 7-day totals).
- Drying estimates depend on Stock-In being a real weigh-in (it is pre-filled with last close).
- Firestore rules must allow creating `events` with type `sales` (check if rules validate event types).

## Hard-won rules (do not repeat these mistakes)
- Keep the file ASCII-only. Earlier, UTF-8 double-encoding produced "A-circumflex" junk characters in the UI.
- JS strings use single quotes: escape apostrophes in contractions (\') or the whole script breaks and the page goes blank.
- Before shipping ANY edit: extract the inline `<script>`, run `node --check` on it, and smoke-test with stubbed browser globals
  (document, window, localStorage, firebase, emailjs). The owner has hit blank-page bugs before.
- Firestore cannot connect inside the Claude artifact preview (sandbox blocks the connections). It only works once hosted (GitHub Pages).
  The app shows a timeout error screen there; that is expected.
- Shared config ships with the file. Never require staff to enter database or email details.

## Open items / ideas
- Confirm the first real end-of-day email arrives and looks right.
- Square: worker deployed at https://biltong-square.mroets.workers.dev and wired in; confirm SQUARE_TOKEN/ALLOWED_ORIGIN are set and Test connection works.
- Owner was walked through restricting the Firebase API key in Google Cloud Console (HTTP referrer = the GitHub Pages site, API = Firestore only);
  completion not confirmed.
- Firestore rules currently allow open writes to `flavours` (needed for renames and restock increments); `events` are append-only.
  Consider tightening later.
- Consider more history than the latest 400 events for long-term trend views (e.g. a daily snapshot collection).

## Workflow
The owner works from a Samsung tablet and prefers plain, short explanations and no CLI steps. Changes go to `index.html`
(rename of the old biltong-app.html). GitHub Pages redeploys within a minute or two of a push.
