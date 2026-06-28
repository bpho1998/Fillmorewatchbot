# SF Fillmore Watchbot 🔍

A GitHub Actions bot that monitors San Francisco open data for activity related to Neil Mehta, the Upper Fillmore Revitalization Project, and associated entities — and sends real-time Discord notifications.

## What It Watches

### Data Sources

| Source | Dataset | Update Frequency |
|--------|---------|-----------------|
| SF Ethics Commission | Lobbyist Activity | Nightly |
| SF Ethics Commission | Campaign Finance Transactions | Nightly |
| SF Dept. of Building Inspection | Building Permits | Weekly |
| SF Assessor-Recorder | Property Transfer Tax Records | Varies |

All data is fetched from [DataSF](https://data.sfgov.org) via the public SODA API — **no API key required**.

### Search Terms

The bot searches for any of the following (case-insensitive) across all relevant text fields in each dataset:

- `Upper Fillmore Revitalization`
- `Aegis Reserve`
- `Fillmore Reserve`
- `Cody Allen`
- `Maven Properties`
- `SF Reserve Foundation`
- `Sam Singer`
- `Singer Associates`
- `Neil Mehta`

## Setup

### 1. Create a Discord Webhook

1. Open your Discord server → channel settings → **Integrations** → **Webhooks**
2. Click **New Webhook**, give it a name (e.g. "SF Watchbot"), copy the URL
3. Keep the URL secret — treat it like a password

### 2. Fork or clone this repository

```bash
git clone https://github.com/YOUR_USERNAME/sf-fillmore-watchbot.git
cd sf-fillmore-watchbot
```

### 3. Add your Discord Webhook URL as a GitHub Secret

1. Go to your repo on GitHub → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `DISCORD_WEBHOOK_URL`
4. Value: paste your Discord webhook URL
5. Click **Add secret**

### 4. Enable GitHub Actions

Go to the **Actions** tab of your repo and enable workflows if prompted.

That's it! The bot will run automatically every 6 hours.

## Running Manually

### Trigger from GitHub

Go to **Actions** → **SF Fillmore Watchbot** → **Run workflow**

### Run locally (dry run — no Discord messages sent)

```bash
node src/watchbot.js
# Or:
npm test
```

To test with real Discord notifications locally:

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." node src/watchbot.js
```

## How It Works

1. **Polls** each DataSF SODA API endpoint for records from the last 90 days
2. **Searches** all text fields in each record for the configured search terms
3. **Deduplicates** using a local `state/seen.json` file committed back to the repo — so you never get the same alert twice, even across separate runs
4. **Sends** a rich Discord embed for each new match, including:
   - Source name and color-coded category
   - Record summary (names, amounts, addresses, etc.)
   - Which search term(s) matched
   - Link to the original record where possible

## Discord Alert Format

Each alert looks like this:

```
🚨 New match in 🏛 SF Ethics — Lobbyist Activity
─────────────────────────────────────────────────
Lobbyist: Jane Smith (Dewey Cheatem LLP)
Client: Upper Fillmore Revitalization Project
Action: Zoning variance for 2261 Fillmore St

🔍 Matched Terms: `Upper Fillmore Revitalization`, `Cody Allen`

SF Fillmore Watchbot • 2025-01-15 12:00 UTC
```

## Customization

### Change the schedule

Edit `.github/workflows/watchbot.yml` and update the `cron` expression:

```yaml
- cron: "0 */6 * * *"   # Every 6 hours (default)
- cron: "0 8 * * *"     # Daily at 8am UTC
- cron: "0 */2 * * *"   # Every 2 hours
```

### Add or remove search terms

Edit `src/watchbot.js` and update the `SEARCH_TERMS` array:

```js
const SEARCH_TERMS = [
  "Upper Fillmore Revitalization",
  "Neil Mehta",
  // Add more here...
];
```

### Add more data sources

Add a new entry to the `SOURCES` array in `src/watchbot.js`. You need:
- A DataSF dataset URL ending in `.json`
- The name of the date field for filtering
- Which text fields to search
- A summary function and link template

Find datasets at [data.sfgov.org](https://data.sfgov.org).

## Data Source Details

### Lobbyist Activity (`s4ub-8j3t`)
Fields searched: `lobbyist_name`, `lobbyist_firm`, `client_name`, `local_legislative_action`, `specific_action`, `subject_matter`

### Campaign Finance (`pitq-26ib`)
Fields searched: `contributor_name`, `recipient_name`, `employer`, `contributor_address`

### Building Permits (`i98e-djp9`)
Fields searched: `applicant_name`, `owner_name`, `permit_address`, `description`, `contractor_name`

### Property Transfers (`wv5m-vpq2`)
Fields searched: `buyer_name`, `seller_name`, `property_location`, `buyer_mail_address`

## Limitations

- The SF Assessor's property transfer dataset may lag real-world recordings by days to weeks
- Lobbyist filings are only as current as the lobbyist's most recent monthly statement
- LLC names used in property purchases (North Room LLC, Pointed Blue LLC, etc.) will only appear if they are explicitly listed in the dataset fields — they are not included in the current search terms since they are the property holders, not necessarily the lobbyists
- The bot catches **new** records only. It won't retroactively alert you to records filed before you first run it (those will be silently added to `state/seen.json`)

## Repo Structure

```
sf-fillmore-watchbot/
├── .github/
│   └── workflows/
│       └── watchbot.yml     # GitHub Actions schedule + job
├── src/
│   └── watchbot.js          # Main bot logic
├── state/
│   └── seen.json            # Deduplication state (auto-updated by bot)
├── package.json
└── README.md
```

## License

MIT
