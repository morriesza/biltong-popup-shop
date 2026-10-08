// Biltong Floor Log - Square sales go-between (Cloudflare Worker).
//
// The Square access token is a real secret (it can read and act on the whole
// Square account), so it must never ship in the public app. It lives only
// here, as a Cloudflare secret named SQUARE_TOKEN. The app calls this
// worker's public URL and gets back grams sold (and sales dollars) per item
// for a time window - no customer, card or payment details.
//
// Cloudflare settings (Worker -> Settings -> Variables and Secrets):
//   SQUARE_TOKEN    (Secret) Square production access token
//   ALLOWED_ORIGIN  (Text)   https://morriesza.github.io
//   LOCATION_IDS    (Text, optional) comma-separated Square location IDs;
//                   leave unset to include every location on the account
//
// Endpoints:
//   GET /status                          -> { ok, locations: [names] }
//   GET /sales?from=<ISO>&to=<ISO>       -> { ok, orders, items, unweighed }

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";
const MAX_WINDOW_MS = 36 * 60 * 60 * 1000;

const GRAMS_PER_UNIT = {
  METRIC_MILLIGRAM: 0.001,
  METRIC_GRAM: 1,
  METRIC_KILOGRAM: 1000,
  IMPERIAL_WEIGHT_OUNCE: 28.349523125,
  IMPERIAL_POUND: 453.59237,
  IMPERIAL_STONE: 6350.29318
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin"
    };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors)
    });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return reply(405, { ok: false, error: "GET only" });
    // Browsers always send Origin on cross-site fetches; refuse other sites.
    if (!allowed || origin !== allowed) return reply(403, { ok: false, error: "Origin not allowed" });
    if (!env.SQUARE_TOKEN) return reply(500, { ok: false, error: "SQUARE_TOKEN is not set" });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/status") {
        const locations = await listLocations(env);
        return reply(200, { ok: true, locations: locations.map((l) => l.name) });
      }
      if (url.pathname === "/sales") {
        const from = Date.parse(url.searchParams.get("from") || "");
        const to = Date.parse(url.searchParams.get("to") || "");
        if (isNaN(from) || isNaN(to) || to <= from || to - from > MAX_WINDOW_MS) {
          return reply(400, { ok: false, error: "from/to must be ISO times, at most 36 hours apart" });
        }
        return reply(200, Object.assign({ ok: true }, await salesSummary(env, from, to)));
      }
      return reply(404, { ok: false, error: "Not found" });
    } catch (err) {
      return reply(502, { ok: false, error: String(err && err.message || err) });
    }
  }
};

async function square(env, path, body) {
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
