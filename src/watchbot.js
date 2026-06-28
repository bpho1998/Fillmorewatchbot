/**
 * SF Fillmore Watchbot
 * Monitors 4 SF open data sources for activity related to Neil Mehta /
 * Upper Fillmore Revitalization Project and sends Discord notifications.
 *
 * Data sources (all via DataSF SODA API — no auth required):
 *   1. SF Ethics Commission – Lobbyist Activity Directory
 *   2. SF Ethics Commission – Campaign Finance Transactions
 *   3. SF DBI – Building Permits
 *   4. SF Assessor-Recorder – Recorded Documents (property transfers)
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
    // DataSF: Lobbyist Activity Directory
    // https://data.sfgov.org/City-Management-and-Ethics/Lobbyist-Activity-Directory/s4ub-8j3t
    // NOTE: This dataset is synced nightly from the live Netfile/Ethics Commission
    // portal at https://netfile.com/lobbyistpub/#sfo — so monitoring this dataset
    // effectively monitors both sources with a ~24hr lag.
    url: "https://data.sfgov.org/resource/s4ub-8j3t.json",
    dateField: "date",
    textFields: [
      "lobbyistname",
      "firmname",
      "clientname",
      "description",
      "employeename",
      "candidatename",
    ],
    summaryFn: (r) =>
      `**Lobbyist:** ${r.lobbyistname || "—"} (${r.firmname || "—"})  \n**Client:** ${r.clientname || "—"}  \n**Description:** ${(r.description || "—").slice(0, 200)}  \n**Date:** ${r.date ? r.date.slice(0, 10) : "—"}`,
    linkTemplate: () => "https://netfile.com/lobbyistpub/#sfo",
  },
  {
    id: "campaign_finance",
    label: "💰 SF Ethics — Campaign Finance",
    color: 0x27ae60,
    // DataSF: Campaign Finance - Transactions (all FPPC forms filed with SFEC)
    // https://data.sfgov.org/City-Management-and-Ethics/Campaign-Finance-Transactions/pitq-e56w
    url: "https://data.sfgov.org/resource/pitq-e56w.json",
    dateField: "filing_date",
    textFields: [
      "filer_naml",
      "filer_namf",
      "tran_naml",
      "tran_namf",
      "tran_emp",
      "tran_occ",
      "memo_code",
      "memo_refno",
    ],
    summaryFn: (r) =>
      `**Filer/Committee:** ${r.filer_naml || "—"}  \n**Contributor/Payee:** ${[r.tran_namf, r.tran_naml].filter(Boolean).join(" ") || "—"}  \n**Employer:** ${r.tran_emp || "—"}  \n**Amount:** $${Number(r.tran_amt1 || 0).toLocaleString()}  \n**Date:** ${r.filing_date ? r.filing_date.slice(0, 10) : "—"}`,
    linkTemplate: () =>
      "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    label: "🏗 SF DBI — Building Permits",
    color: 0xf39c12,
    // DataSF: Building Permits
    // https://data.sfgov.org/Housing-and-Buildings/Building-Permits/i98e-djp9
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    textFields: [
      "applicant_name",
      "owner_name",
      "description",
      "contractor_name",
      "street_name",
    ],
    summaryFn: (r) =>
      `**Address:** ${[r.street_number, r.street_name, r.street_suffix].filter(Boolean).join(" ") || "—"}  \n**Applicant:** ${r.applicant_name || "—"}  \n**Description:** ${(r.description || "—").slice(0, 200)}  \n**Status:** ${r.status || "—"}  \n**Filed:** ${r.filed_date ? r.filed_date.slice(0, 10) : "—"}`,
    linkTemplate: (r) =>
      r.permit_number
        ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}`
        : "https://sfdbi.org/dbipts",
  },
  {
    id: "property_transfers",
    label: "🏠 SF Assessor — Recorded Documents",
    color: 0x9b59b6,
    // DataSF: Recorded Documents (property transfers / deeds)
    // https://data.sfgov.org/Housing-and-Buildings/Recorded-Documents/wv5m-vpq2
    url: "https://data.sfgov.org/resource/wv5m-vpq2.json",
    dateField: "recording_date",
    textFields: [
      "grantor_names",
      "grantee_names",
      "document_type",
      "legal_description",
    ],
    summaryFn: (r) =>
      `**Document Type:** ${r.document_type || "—"}  \n**Grantor (Seller):** ${r.grantor_names || "—"}  \n**Grantee (Buyer):** ${r.grantee_names || "—"}  \n**Recorded:** ${r.recording_date ? r.recording_date.slice(0, 10) : "—"}`,
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
  const pk =
    row.id ||
    row.record_id ||
    row.permit_number ||
    row.document_number ||
    row.transaction_id ||
    row.filing_id ||
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

    if (state.seen[id]) continue;

    const terms = matchedTerms(row, source.textFields);
    if (terms.length > 0) {
      console.log(`  🔔 Match found [${id}]: ${terms.join(", ")}`);
      await sendDiscordAlert(source, row, terms);
      newAlerts++;
      await new Promise((r) => setTimeout(r, 500));
    }

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

  console.log("\n" + "═".repeat(60));
  console.log(`Run complete. Total new alerts: ${totalAlerts}`);
  console.log(`State saved to ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
