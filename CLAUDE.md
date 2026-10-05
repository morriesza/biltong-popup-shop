# Biltong Floor Log (Safari Cafe pop-up) - project notes

Internal staff app for a biltong pop-up shop. Owner: Morne Roets. Hosted free on GitHub Pages
(https://morriesza.github.io/biltong-popup-shop/). Repo: morriesza/biltong-popup-shop.

## Files
- `index.html` - the entire app: one self-contained file (HTML + CSS + inline JS IIFE). No build step, no frameworks.
- `manifest.json`, `sw.js` - PWA install support (Android "Install app" prompt; iOS only supports Add to Home Screen).
- `img/SafariCafe-logo.png` - logo, shown full width at the top of every screen.

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
- Event types: `time`, `cash` (amount + breakdown), `stock` (readings map, flagged list), `restock` (flavourId, flavourName, amountG, note).
- The Firebase web config is embedded in `index.html` (EMBEDDED_FIREBASE_CONFIG) on purpose: it is not a secret, staff must never have
  to paste credentials on their own phones, and the real protection is the Firestore security rules. Do NOT change this to a per-device setup.
  A per-device override still exists under Manage -> Database for testing only.
- If the config is null the app falls back to a localStorage demo mode.

## End-of-day email (EmailJS)
- Sent after Cash-Out via EmailJS (client-side, free tier 200/month). SDK: `@emailjs/browser@3` from jsDelivr.
- Config is `EMBEDDED_EMAILJS_CONFIG` in index.html (currently null = no emails) or a per-device override under Manage -> Email Reports.
  Needs serviceId, templateId, publicKey, toEmail. Template variables: `to_email`, `subject`, `message`.
- STATUS: the owner has not yet signed up at emailjs.com / provided these IDs. Once provided, bake them into EMBEDDED_EMAILJS_CONFIG
  (same pattern as Firebase) so every device sends from the same setup.

## Hard-won rules (do not repeat these mistakes)
- Keep the file ASCII-only. Earlier, UTF-8 double-encoding produced "A-circumflex" junk characters in the UI.
- JS strings use single quotes: escape apostrophes in contractions (\') or the whole script breaks and the page goes blank.
- Before shipping ANY edit: extract the inline `<script>`, run `node --check` on it, and smoke-test with stubbed browser globals
  (document, window, localStorage, firebase, emailjs). The owner has hit blank-page bugs before.
- Firestore cannot connect inside the Claude artifact preview (sandbox blocks the connections). It only works once hosted (GitHub Pages).
  The app shows a timeout error screen there; that is expected.
- Shared config ships with the file. Never require staff to enter database or email details.

## Open items / ideas
- Enter EmailJS credentials once the owner has them.
- Owner was walked through restricting the Firebase API key in Google Cloud Console (HTTP referrer = the GitHub Pages site, API = Firestore only);
  completion not confirmed.
- Firestore rules currently allow open writes to `flavours` (needed for renames and restock increments); `events` are append-only.
  Consider tightening later.
- Consider more history than the latest 400 events for long-term trend views (e.g. a daily snapshot collection).

## Workflow
The owner works from a Samsung tablet and prefers plain, short explanations and no CLI steps. Changes go to `index.html`
(rename of the old biltong-app.html). GitHub Pages redeploys within a minute or two of a push.
