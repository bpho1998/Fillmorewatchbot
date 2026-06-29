/**
 * SF Fillmore Watchbot
 *
 * Monitors SF open data sources for activity related to Neil Mehta /
 * Upper Fillmore Revitalization Project and sends Discord alerts for
 * each new matching filing.
 *
 * SOURCES:
 *   1. SF Ethics — Lobbyist Activity     (s4ub-8j3t)
 *   2. SF Ethics — Campaign Finance      (pitq-e56w)
 *   3. SF DBI — Building Permits         (i98e-djp9)
 *   4. SF Assessor — Property Transfers  REMOVED: wv5m-vpq2 is the tax roll,
 *      not recorded deeds. No public API exists for recorded documents.
 *      Search manually at https://recorder.sfgov.org
 *
 * MATCHING STRATEGY (field-aware, learned from digest development):
 *
 *   LOBBYIST: match subject terms in client name or description.
 *     Agent terms (Lighthouse, Peterson) only count when a subject term
 *     also appears in the same record — prevents alerting on all their
 *     unrelated client work.
 *
 *   CAMPAIGN FINANCE: match subject terms in contributor name or
 *     filer/recipient name only. Do NOT match on employer field —
 *     that pulls all of Lighthouse's unrelated political donations.
 *
 *   BUILDING PERMITS: match on 2000–2299 Fillmore St address block.
 *     Dataset has no applicant/owner name fields — address range is
 *     the reliable signal for Mehta's properties.
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ─── Configuration ────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = path.join(__dirname, "../state/seen.json");

// Subject terms — the actual Mehta/Fillmore entities
const SUBJECT_TERMS = [
  "Upper Fillmore Revitalization",
  "Aegis Reserve",
  "Fillmore Reserve",
  "Cody Allen",
  "Maven Properties",
  "SF Reserve Foundation",
  "Sam Singer",
  "Singer Associates",
  "Neil Mehta",
  "North Room LLC",
  "Pointed Blue LLC",
  "Shaded Flame LLC",
  "Temperate Lands LLC",
  "White Birches LLC",
];

// Agent terms — lobbyists acting for Mehta interests
// Only used in lobbyist source, and only when a subject term also appears
const AGENT_TERMS = [
  "Lighthouse Public Affairs",
  "Peterson, Rich",
];

// Fillmore St address range covering Mehta's properties
const FILLMORE_RANGE = { street: "fillmore", min: 2000, max: 2299 };

// ─── Sources ──────────────────────────────────────────────────────────────────

const SOURCES = [
  {
    id: "lobbyist_activity",
    label: "🏛 SF Ethics — Lobbyist Activity",
    color: 0xe74c3c,
    // https://data.sfgov.org/City-Management-and-Ethics/Lobbyist-Activity-Directory/s4ub-8j3t
    // Confirmed field names from DataSF schema
    url: "https://data.sfgov.org/resource/s4ub-8j3t.json",
    dateField: "date",
    matchFn: matchLobbyist,
    summaryFn: (r) =>
      `**Lobbyist:** ${r.lobbyistname || "—"} (${r.firmname || "—"})\n` +
      `**Client:** ${r.clientname || "—"}\n` +
      `**Description:** ${(r.description || "—").slice(0, 200)}\n` +
      `**Date:** ${r.date ? r.date.slice(0, 10) : "—"}`,
    linkTemplate: (r) =>
      r.fromfiling
        ? `https://netfile.com/app/lobbyist/filing/${r.fromfiling}/report`
        : "https://netfile.com/lobbyistpub/#sfo",
  },
  {
    id: "campaign_finance",
    label: "💰 SF Ethics — Campaign Finance",
    color: 0x27ae60,
    // https://data.sfgov.org/City-Management-and-Ethics/Campaign-Finance-Transactions/pitq-e56w
    // Confirmed field names: filer_name, transaction_first_name, transaction_last_name,
    // transaction_amount_1, transaction_date, filing_date
    url: "https://data.sfgov.org/resource/pitq-e56w.json",
    dateField: "filing_date",
    matchFn: matchFinance,
    summaryFn: (r) => {
      const contributor = [r.transaction_first_name, r.transaction_last_name].filter(Boolean).join(" ") || "—";
      const amount = Number(r.transaction_amount_1 || 0);
      const date = (r.transaction_date || r.filing_date || "").slice(0, 10);
      return (
        `**Filer/Committee:** ${r.filer_name || "—"}\n` +
        `**Contributor:** ${contributor}\n` +
        `**Employer:** ${r.transaction_employer || "—"}\n` +
        `**Amount:** $${amount.toLocaleString()}\n` +
        `**Date:** ${date}`
      );
    },
    linkTemplate: (r) =>
      r.filing_id_number
        ? `https://netfile.com/pub2/api/filing/${r.filing_id_number}/detail?aid=sfo`
        : "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    label: "🏗 SF DBI — Building Permits",
    color: 0xf39c12,
    // https://data.sfgov.org/Housing-and-Buildings/Building-Permits/i98e-djp9
    // No applicant/owner name fields exist — address range is the signal.
    // Alerts on any permit filed for 2000–2299 Fillmore St.
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    matchFn: matchPermit,
    summaryFn: (r) => {
      const addr = [r.street_number, r.street_name, r.street_suffix].filter(Boolean).join(" ");
      const cost = r.estimated_cost ? `$${Number(r.estimated_cost).toLocaleString()}` : "—";
      return (
        `**Address:** ${addr || "—"}\n` +
        `**Permit #:** ${r.permit_number || "—"}\n` +
        `**Status:** ${r.status || "—"}\n` +
        `**Work:** ${(r.description || "—").slice(0, 200)}\n` +
        `**Est. Cost:** ${cost}\n` +
        `**Filed:** ${r.filed_date ? r.filed_date.slice(0, 10) : "—"}`
      );
    },
    linkTemplate: (r) =>
      r.permit_number
        ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}`
        : "https://sfdbi.org/dbipts",
  },
];

// ─── Matching functions ───────────────────────────────────────────────────────

function termIn(value, terms) {
  const v = (value || "").toString().toLowerCase();
  return terms.filter((t) => v.includes(t.toLowerCase()));
}

function matchLobbyist(row) {
  // Primary: client name contains a subject term
  const clientHits = termIn(row.clientname, SUBJECT_TERMS);
  if (clientHits.length > 0) return clientHits;

  // Secondary: description contains a subject term
  const descHits = termIn(row.description, SUBJECT_TERMS);
  if (descHits.length > 0) return descHits;

  // Tertiary: agent term in firm/lobbyist AND subject term elsewhere in record
  const isAgent =
    termIn(row.firmname, AGENT_TERMS).length > 0 ||
    termIn(row.lobbyistname, AGENT_TERMS).length > 0;
  if (isAgent) {
    const allText = [row.clientname, row.description, row.candidatename, row.employeename]
      .map((f) => (f || "").toLowerCase()).join(" ");
    const subjectHits = SUBJECT_TERMS.filter((t) => allText.includes(t.toLowerCase()));
    if (subjectHits.length > 0) {
      return [
        ...termIn(row.firmname, AGENT_TERMS),
        ...termIn(row.lobbyistname, AGENT_TERMS),
      ];
    }
  }

  return [];
}

function matchFinance(row) {
  // Only match on contributor name or filer/recipient name — not employer
  const filerHits = termIn(row.filer_name, SUBJECT_TERMS);
  const contributor = [row.transaction_first_name, row.transaction_last_name]
    .filter(Boolean).join(" ");
  const contribHits = termIn(contributor, SUBJECT_TERMS);
  const descHits = termIn(row.transaction_description, SUBJECT_TERMS);
  return [...new Set([...filerHits, ...contribHits, ...descHits])];
}

function matchPermit(row) {
  const street = (row.street_name || "").toLowerCase();
  const num = parseInt(row.street_number || "0", 10);
  if (street === FILLMORE_RANGE.street && num >= FILLMORE_RANGE.min && num <= FILLMORE_RANGE.max) {
    return [`${row.street_number} Fillmore St`];
  }
  return [];
}

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

function recordId(sourceId, row) {
  const pk =
    row.id ||
    row.record_id ||
    row.permit_number ||
    row.document_number ||
    row.transaction_id ||
    row.filing_id_number ||
    JSON.stringify(row);
  return `${sourceId}::${pk}`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Discord alert ────────────────────────────────────────────────────────────

async function sendDiscordAlert(source, row, terms) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("[DRY RUN] Would send alert:", { source: source.id, terms });
    return;
  }

  const link = source.linkTemplate(row);

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
      {
        name: "🔗 View Filing",
        value: link,
        inline: false,
      },
    ],
    footer: {
      text: `SF Fillmore Watchbot • ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    },
    url: link,
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
    .toISOString().slice(0, 10);
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
    console.error(`  ❌ Fetch error: ${err.message}`);
    return 0;
  }

  if (!Array.isArray(rows)) {
    console.warn(`  ⚠️  Unexpected response shape`);
    return 0;
  }

  console.log(`  ↳ ${rows.length} rows retrieved`);
  let newAlerts = 0;

  for (const row of rows) {
    const id = recordId(source.id, row);
    if (state.seen[id]) continue;

    const terms = source.matchFn(row);
    if (terms.length > 0) {
      console.log(`  🔔 Match [${id}]: ${terms.join(", ")}`);
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
  console.log(`  Time:    ${new Date().toISOString()}`);
  console.log(`  Webhook: ${!!DISCORD_WEBHOOK_URL}`);
  console.log(`  Subject terms (${SUBJECT_TERMS.length}):`, SUBJECT_TERMS);
  console.log(`  Agent terms (${AGENT_TERMS.length}):`, AGENT_TERMS);
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
  console.log(`Run complete. New alerts: ${totalAlerts}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
