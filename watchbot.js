/**
 * SF Fillmore Watchbot
 * Monitors 4 SF open data sources for activity related to Neil Mehta /
 * Upper Fillmore Revitalization Project and sends Discord notifications.
 *
 * Data sources (all via DataSF SODA API — no auth required):
 *   1. SF Ethics Commission – Lobbyist Activity
 *   2. SF Ethics Commission – Campaign Finance Transactions
 *   3. SF DBI – Building Permits
 *   4. SF Assessor-Recorder – Property Transfer Tax filings
 */

const fs   = require("fs");
const path = require("path");
const https = require("https");

// ─── Configuration ────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = path.join(__dirname, "../state/seen.json");

/** Search terms — all checked case-insensitively against text fields */
const SEARCH_TERMS = [
  "Upper Fillmore Revitalization",
  "Aegis Reserve",
  "Fillmore Reserve",
  "Cody Allen",
  "Maven Properties",
  "SF Reserve Foundation",
  "Sam Singer",
  "Singer Associates",
  "Neil Mehta",
];

/**
 * DataSF SODA endpoints and field configs.
 *
 * Each source defines:
 *   id           – unique key for this source
 *   label        – human-readable name
 *   url          – SODA API base URL
 *   dateField    – the field to sort/filter by recency
 *   textFields   – fields to search for our terms
 *   linkTemplate – fn(row) → URL to the record (best effort)
 *   summaryFn    – fn(row) → one-line description for the Discord embed
 */
const SOURCES = [
  {
    id: "lobbyist_activity",
    label: "🏛 SF Ethics — Lobbyist Activity",
    color: 0xe74c3c,
    url: "https://data.sfgov.org/resource/s4ub-8j3t.json",
    dateField: "period_start",
    textFields: [
      "lobbyist_name",
      "lobbyist_firm",
      "client_name",
      "local_legislative_action",
      "specific_action",
      "subject_matter",
    ],
    summaryFn: (r) =>
      `**Lobbyist:** ${r.lobbyist_name || "—"} (${r.lobbyist_firm || "—"})  \n**Client:** ${r.client_name || "—"}  \n**Action:** ${r.local_legislative_action || r.specific_action || "—"}`,
    linkTemplate: () => "https://sfethics.org/disclosures/lobbyist-disclosure",
  },
  {
    id: "campaign_finance",
    label: "💰 SF Ethics — Campaign Finance",
    color: 0x27ae60,
    url: "https://data.sfgov.org/resource/pitq-26ib.json",
    dateField: "date",
    textFields: [
      "contributor_name",
      "recipient_name",
      "employer",
      "contributor_address",
      "contributor_city",
    ],
    summaryFn: (r) =>
      `**Contributor:** ${r.contributor_name || "—"}  \n**Recipient:** ${r.recipient_name || "—"}  \n**Amount:** $${Number(r.amount || 0).toLocaleString()}  \n**Date:** ${r.date ? r.date.slice(0, 10) : "—"}`,
    linkTemplate: () =>
      "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    label: "🏗 SF DBI — Building Permits",
    color: 0xf39c12,
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    textFields: [
      "applicant_name",
      "owner_name",
      "permit_address",
      "description",
      "contractor_name",
    ],
    summaryFn: (r) =>
      `**Address:** ${r.permit_address || r.street_number + " " + r.street_name || "—"}  \n**Applicant:** ${r.applicant_name || "—"}  \n**Description:** ${(r.description || "—").slice(0, 200)}  \n**Status:** ${r.status || "—"}`,
    linkTemplate: (r) =>
      r.permit_number
        ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}`
        : "https://sfdbi.org/dbipts",
  },
  {
    id: "property_sales",
    label: "🏠 SF Assessor — Property Transfers",
    color: 0x9b59b6,
    url: "https://data.sfgov.org/resource/wv5m-vpq2.json",
    dateField: "sale_date",
    textFields: [
      "buyer_name",
      "seller_name",
      "property_location",
      "buyer_mail_address",
    ],
    summaryFn: (r) =>
      `**Property:** ${r.property_location || "—"}  \n**Buyer:** ${r.buyer_name || "—"}  \n**Seller:** ${r.seller_name || "—"}  \n**Sale Price:** $${Number(r.sale_price || 0).toLocaleString()}  \n**Date:** ${r.sale_date ? r.sale_date.slice(0, 10) : "—"}`,
    linkTemplate: () =>
      "https://sfassessor.org/recorder-information/recorded-documents",
  },
];

// ─── State helpers ────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { seen: {}, lastRun: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Stable ID for a record — used to deduplicate across runs */
function recordId(sourceId, row) {
  // Try common primary-key fields, fall back to a hash of the whole row
  const pk =
    row.id ||
    row.record_id ||
    row.permit_number ||
    row.document_number ||
    row.transaction_id ||
    JSON.stringify(row);
  return `${sourceId}::${pk}`;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "Accept": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error for ${url}: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Matching logic ───────────────────────────────────────────────────────────

/**
 * Returns the matched search terms found in a row's text fields.
 */
function matchedTerms(row, textFields) {
  const haystack = textFields
    .map((f) => (row[f] || "").toString().toLowerCase())
    .join(" ");

  return SEARCH_TERMS.filter((term) =>
    haystack.includes(term.toLowerCase())
  );
}

// ─── Discord notification ─────────────────────────────────────────────────────

async function sendDiscordAlert(source, row, terms) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("[DRY RUN] Would send Discord alert:", { source: source.id, terms, row });
    return;
  }

  const embed = {
    title: `🚨 New match in ${source.label}`,
    color: source.color,
    description: source.summaryFn(row),
    fields: [
      {
        name: "🔍 Matched Terms",
        value: terms.map((t) => `\`${t}\``).join(", "),
        inline: false,
      },
    ],
    footer: {
      text: `SF Fillmore Watchbot • ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    },
    url: source.linkTemplate(row),
    timestamp: new Date().toISOString(),
  };

  const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: [embed] });
  if (result.status >= 300) {
    console.error(`Discord webhook error ${result.status}:`, result.body);
  } else {
    console.log(`✅ Discord alert sent for ${source.id}`);
  }
}

// ─── Per-source polling ───────────────────────────────────────────────────────

/**
 * Builds a SODA query URL that fetches the last 90 days of records,
 * ordered newest-first, limited to 1000 rows.
 */
function buildSodaUrl(source) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const where = encodeURIComponent(`${source.dateField} >= '${since}'`);
  const order = encodeURIComponent(`${source.dateField} DESC`);
  return `${source.url}?$where=${where}&$order=${order}&$limit=1000`;
}

async function pollSource(source, state) {
  const url = buildSodaUrl(source);
  console.log(`\n📡 Polling ${source.id}…`);

  let rows;
  try {
    rows = await fetchJSON(url);
  } catch (err) {
    console.error(`  ❌ Fetch error for ${source.id}: ${err.message}`);
    return 0;
  }

  if (!Array.isArray(rows)) {
    console.warn(`  ⚠️  Unexpected response shape for ${source.id}`);
    return 0;
  }

  console.log(`  ↳ ${rows.length} rows retrieved`);
  let newAlerts = 0;

  for (const row of rows) {
    const id = recordId(source.id, row);

    // Skip already-seen records
    if (state.seen[id]) continue;

    const terms = matchedTerms(row, source.textFields);
    if (terms.length > 0) {
      console.log(`  🔔 Match found [${id}]: ${terms.join(", ")}`);
      await sendDiscordAlert(source, row, terms);
      newAlerts++;

      // Rate-limit: avoid hitting Discord too fast
      await new Promise((r) => setTimeout(r, 500));
    }

    // Mark as seen regardless of match (to avoid re-checking old records)
    state.seen[id] = new Date().toISOString();
  }

  return newAlerts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("SF Fillmore Watchbot — starting run");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Webhook configured: ${!!DISCORD_WEBHOOK_URL}`);
  console.log(`  Search terms (${SEARCH_TERMS.length}):`, SEARCH_TERMS);
  console.log("═".repeat(60));

  const state = loadState();
  let totalAlerts = 0;

  for (const source of SOURCES) {
    try {
      const alerts = await pollSource(source, state);
      totalAlerts += alerts;
    } catch (err) {
      console.error(`Unhandled error for ${source.id}:`, err);
    }
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  console.log("\n═".repeat(60));
  console.log(`Run complete. Total new alerts: ${totalAlerts}`);
  console.log(`State saved to ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
