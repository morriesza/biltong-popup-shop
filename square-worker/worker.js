// Biltong Floor Log - private go-between (Cloudflare Worker).
//
// The app's code is public, so anything secret lives here instead, as
// Cloudflare secrets:
//   SQUARE_TOKEN              (Secret) Square production access token
//   FIREBASE_SERVICE_ACCOUNT  (Secret) the whole JSON key file from Firebase
//                             (Project settings -> Service accounts)
//   ALLOWED_ORIGIN            (Text)   https://morriesza.github.io
//   LOCATION_IDS              (Text, optional) comma-separated Square
//                             location IDs; unset = every location
//
// Endpoints:
//   POST /login   { pin }  -> { ok, token, employee }
//        Checks the PIN against the employees collection and returns a
//        Firebase sign-in token. Staff PINs never leave the database, and
//        wrong guesses are rate limited (per device and overall).
//   GET  /status                      (signed in) -> { ok, locations }
//   GET  /sales?from=<ISO>&to=<ISO>   (signed in) -> { ok, orders, items, unweighed }
//        Grams sold (and sales cents) per Square item for a time window -
//        no customer, card or payment details.

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";
const MAX_WINDOW_MS = 36 * 60 * 60 * 1000;
const PIN_PATTERN = /^[0-9ABC]{6}$/;

const GUARD_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_DEVICE = 10;
const MAX_FAILS_OVERALL = 100;

const FIREBASE_KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CUSTOM_TOKEN_AUD = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

const GRAMS_PER_UNIT = {
  METRIC_MILLIGRAM: 0.001,
  METRIC_GRAM: 1,
  METRIC_KILOGRAM: 1000,
  IMPERIAL_WEIGHT_OUNCE: 28.349523125,
  IMPERIAL_POUND: 453.59237,
  IMPERIAL_STONE: 6350.29318
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors)
    });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // Browsers always send Origin on cross-site requests; refuse other sites.
    if (!allowed || origin !== allowed) return reply(403, { ok: false, error: "Origin not allowed" });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/login" && request.method === "POST") {
        return reply(200, await login(request, env));
      }
      if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
      if (url.pathname === "/status") {
        await verifyIdToken(request, env);
        const locations = await listLocations(env);
        return reply(200, { ok: true, locations: locations.map((l) => l.name) });
      }
      if (url.pathname === "/sales") {
        await verifyIdToken(request, env);
        const from = Date.parse(url.searchParams.get("from") || "");
        const to = Date.parse(url.searchParams.get("to") || "");
        if (isNaN(from) || isNaN(to) || to <= from || to - from > MAX_WINDOW_MS) {
          throw new HttpError(400, "from/to must be ISO times, at most 36 hours apart");
        }
        return reply(200, Object.assign({ ok: true }, await salesSummary(env, from, to)));
      }
      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      return reply(status, { ok: false, error: String((err && err.message) || err) });
    }
  }
};

/* ============================== encoding helpers ============================== */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  const a = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ============================== Google / Firebase ============================== */

let saCache = null;
async function serviceAccount(env) {
  if (saCache) return saCache;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(500, "FIREBASE_SERVICE_ACCOUNT is not set");
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", b64urlDecode(pem.replace(/\+/g, "-").replace(/\//g, "_")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  saCache = { email: sa.client_email, projectId: sa.project_id, key };
  return saCache;
}

async function signJwt(sa, payload) {
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", sa.key, enc.encode(head + "." + body));
  return head + "." + body + "." + b64url(sig);
}

let googleTokenCache = null;
async function googleToken(env) {
  if (googleTokenCache && googleTokenCache.exp > Date.now() + 60000) return googleTokenCache.value;
  const sa = await serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(sa, {
    iss: sa.email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + assertion
  });
  const json = await res.json();
  if (!res.ok) throw new Error("Google sign-in failed: " + (json.error_description || json.error || res.status));
  googleTokenCache = { value: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return googleTokenCache.value;
}

// Firestore REST call as the service account (bypasses security rules).
// Returns null for a missing document.
async function firestore(env, method, path, body) {
  const sa = await serviceAccount(env);
  const url = "https://firestore.googleapis.com/v1/projects/" + sa.projectId + "/databases/(default)/documents" + path;
  const res = await fetch(url, {
    method,
    headers: { "Authorization": "Bearer " + await googleToken(env), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404) return null;
  const json = await res.json();
  if (!res.ok) throw new Error("Firestore " + res.status + ": " + ((json.error && json.error.message) || ""));
  return json;
}

// Checks the app's Firebase ID token (sent as "Authorization: Bearer ...").
let firebaseKeys = null;
async function verifyIdToken(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, "Not signed in");
  const parts = m[1].split(".");
  if (parts.length !== 3) throw new HttpError(401, "Bad sign-in token");
  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  } catch (e) { throw new HttpError(401, "Bad sign-in token"); }

  const loadKeys = async () => {
    const res = await fetch(FIREBASE_KEYS_URL);
    firebaseKeys = { keys: (await res.json()).keys || [], at: Date.now() };
  };
  if (!firebaseKeys || Date.now() - firebaseKeys.at > 3600000) await loadKeys();
  let jwk = firebaseKeys.keys.find((k) => k.kid === header.kid);
  if (!jwk && Date.now() - firebaseKeys.at > 60000) { await loadKeys(); jwk = firebaseKeys.keys.find((k) => k.kid === header.kid); }
  if (!jwk || header.alg !== "RS256") throw new HttpError(401, "Bad sign-in token");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  const projectId = (await serviceAccount(env)).projectId;
  const now = Date.now() / 1000;
  if (!valid || payload.aud !== projectId || payload.iss !== "https://securetoken.google.com/" + projectId ||
      !(payload.exp > now) || !payload.sub) {
    throw new HttpError(401, "Sign-in expired - log in again");
  }
  return payload;
}

/* ============================== PIN login ============================== */

async function guardRead(env, id) {
  const doc = await firestore(env, "GET", "/loginGuard/" + id);
  const fresh = { fails: 0, since: Date.now() };
  if (!doc || !doc.fields) return fresh;
  const since = Number(doc.fields.since && doc.fields.since.integerValue);
  if (!since || Date.now() - since > GUARD_WINDOW_MS) return fresh;
  return { fails: Number(doc.fields.fails && doc.fields.fails.integerValue) || 0, since };
}
function guardWrite(env, id, g) {
  return firestore(env, "PATCH", "/loginGuard/" + id, {
    fields: { fails: { integerValue: String(g.fails) }, since: { integerValue: String(g.since) } }
  });
}

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const pin = String(body.pin || "").toUpperCase();
  // Devices are told apart by a hash of their IP address; the IP itself is not stored.
  const deviceId = "ip_" + (await sha256Hex(request.headers.get("CF-Connecting-IP") || "unknown")).slice(0, 32);
  const [device, overall] = await Promise.all([guardRead(env, deviceId), guardRead(env, "all")]);
  if (device.fails >= MAX_FAILS_PER_DEVICE || overall.fails >= MAX_FAILS_OVERALL) {
    throw new HttpError(429, "Too many wrong PINs. Wait 15 minutes and try again.");
  }

  let employee = null;
  if (PIN_PATTERN.test(pin)) {
    const rows = await firestore(env, "POST", ":runQuery", {
      structuredQuery: {
        from: [{ collectionId: "employees" }],
        where: { fieldFilter: { field: { fieldPath: "pin" }, op: "EQUAL", value: { stringValue: pin } } },
        limit: 1
      }
    });
    const hit = (rows || []).find((r) => r.document);
    if (hit) {
      const f = hit.document.fields || {};
      employee = {
        id: hit.document.name.split("/").pop(),
        name: (f.name && f.name.stringValue) || "Staff",
        isAdmin: !!(f.isAdmin && f.isAdmin.booleanValue)
      };
    }
  }

  if (!employee) {
    device.fails++; overall.fails++;
    await Promise.all([guardWrite(env, deviceId, device), guardWrite(env, "all", overall)]);
    throw new HttpError(401, "PIN not recognised");
  }
  if (device.fails) await guardWrite(env, deviceId, { fails: 0, since: Date.now() });

  const sa = await serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(sa, {
    iss: sa.email, sub: sa.email, aud: CUSTOM_TOKEN_AUD, iat: now, exp: now + 3600,
    uid: employee.id, claims: { boss: employee.isAdmin, staffName: employee.name }
  });
  return { ok: true, token, employee };
}

/* ============================== Square ============================== */

async function square(env, path, body) {
  if (!env.SQUARE_TOKEN) throw new HttpError(500, "SQUARE_TOKEN is not set");
  const res = await fetch(SQUARE_API + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Authorization": "Bearer " + env.SQUARE_TOKEN,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!res.ok) {
    const e = json.errors && json.errors[0];
    throw new Error("Square " + res.status + (e ? ": " + (e.detail || e.code) : ""));
  }
  return json;
}

async function listLocations(env) {
  const json = await square(env, "/locations");
  const all = (json.locations || []).filter((l) => l.status === "ACTIVE");
  const wanted = (env.LOCATION_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return wanted.length ? all.filter((l) => wanted.indexOf(l.id) >= 0) : all;
}

// Weight-priced line items carry a quantity_unit with a weight_unit; convert
// to grams. Anything sold per piece comes back as null.
function toGrams(quantity, quantityUnit) {
  const unit = quantityUnit && quantityUnit.measurement_unit && quantityUnit.measurement_unit.weight_unit;
  const factor = unit && GRAMS_PER_UNIT[unit];
  if (!factor) return null;
  return parseFloat(quantity || "0") * factor;
}

async function salesSummary(env, from, to) {
  const locations = await listLocations(env);
  const locationIds = locations.map((l) => l.id).slice(0, 10);
  const items = {};
  const unweighed = {};
  let orders = 0;

  const add = (li, sign, money) => {
    const name = li.name || "Unnamed item";
    const variation = li.variation_name || "";
    const key = name + "|" + variation;
    const grams = toGrams(li.quantity, li.quantity_unit);
    if (grams == null) {
      unweighed[key] = unweighed[key] || { name, variation, qty: 0 };
      unweighed[key].qty += sign * parseFloat(li.quantity || "0");
      return;
    }
    items[key] = items[key] || { name, variation, grams: 0, cents: 0 };
    items[key].grams += sign * grams;
    items[key].cents += sign * ((money && money.amount) || 0);
  };

  let cursor;
  do {
    const page = await square(env, "/orders/search", {
      location_ids: locationIds,
      limit: 500,
      cursor,
      query: {
        filter: {
          state_filter: { states: ["COMPLETED"] },
          date_time_filter: { closed_at: { start_at: new Date(from).toISOString(), end_at: new Date(to).toISOString() } }
        },
        sort: { sort_field: "CLOSED_AT", sort_order: "ASC" }
      }
    });
    (page.orders || []).forEach((o) => {
      orders++;
      (o.line_items || []).forEach((li) => add(li, 1, li.gross_sales_money));
      (o.returns || []).forEach((r) => {
        (r.return_line_items || []).forEach((li) => add(li, -1, li.gross_return_money));
      });
    });
    cursor = page.cursor;
  } while (cursor);

  const round = (o) => Object.assign({}, o, o.grams != null ? { grams: Math.round(o.grams * 10) / 10 } : {});
  return {
    orders,
    items: Object.values(items).map(round),
    unweighed: Object.values(unweighed)
  };
}
