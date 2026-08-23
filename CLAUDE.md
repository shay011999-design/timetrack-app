# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A single-page **car-loan tracking dashboard** (Hebrew, RTL) styled after Grafana.
It amortizes a **Spitzer** (equal-payment) loan whose rate is **variable, linked to
the Israeli prime rate**: every prime change recomputes the monthly payment over
the remaining term.

Despite the repo name (`timetrack-app`), this is a loan dashboard, not a
time-tracking app. The name is historical — don't "fix" it.

Domain rule that drives everything: **prime = Bank of Israel rate + 1.5%**, and
the user's effective rate = `prime + spread` (or a fixed rate if not linked).

## Stack & commands

React 18 + Vite 4, no router, no state library, no test runner, no linter config.

```bash
npm install
npm run dev       # Vite dev server
npm run build     # → dist/
npm run preview   # serve the build
node scripts/fetch-prime.mjs   # refresh public/prime.json from Bank of Israel
```

There are **no tests and no lint step**. Verification is manual: `npm run build`
must succeed, then check the dashboard in the browser.

## Layout

```
index.html               Vite entry. lang="he" dir="rtl" — keep it that way.
src/main.jsx             9 lines: React root mount. Rarely changes.
src/App.jsx              ~590 lines. The entire application (see below).
scripts/fetch-prime.mjs  Node script: BOI SDMX API → public/prime.json.
public/prime.json        Committed output of the above. Read by the app at runtime.
.github/workflows/update-prime.yml   Cron that runs the script and commits.
vite.config.js           Default React plugin config, outDir: dist.
```

### src/App.jsx is deliberately one file

It is organized top-to-bottom by banner comments (`// ─── Section ───`) rather
than split into modules. Preserve that structure when editing:

1. **Formatting** — `fmtMoney`, `fmtPct`, `fmtDateISO`, `fmtMonth`, `fmtDateHe`.
   All money/date formatting goes through these, with `he-IL` locale.
2. **Loan math** — `spitzerPayment`, `effectiveRate`, `buildSchedule`,
   `monthsElapsed`. Pure functions, no React. This is the part worth the most care.
3. **Palette `C`** — dark Grafana-like tokens. Never hardcode a hex outside `C`.
4. **`TimeChart`** — hand-rolled SVG time-series (stepped line / area, hover
   crosshair, "today" marker). No charting library is used, on purpose.
5. **`Panel` / `Stat` / `Field` / `PullChip`** — presentational primitives.
6. **`App`** — all state, the prime fetch, derived `useMemo` data, and layout.
7. **`St`** — one object holding every inline style. There is no CSS file.

## Core model

**`buildSchedule(loan, changes)`** is the heart of the app. It walks month by
month from `loan.startDate` for `loan.months`:

- Rate changes are bucketed by month index relative to the loan start; a change
  outside `[0, months)` is ignored.
- On a change month the payment is **recomputed over the *remaining* term**
  (`spitzerPayment(balance, newRate, remaining)`), not the original term. That is
  the defining behavior of this dashboard — don't "simplify" it away.
- The final month clamps `principalPaid` to the outstanding balance so the loan
  ends at exactly zero.
- Each row carries `annualRate`, `prime` (null when not prime-linked), `payment`,
  `interest`, `principalPaid`, `balance`, `cumInterest`, `cumPrincipal`.

`App` builds the schedule twice: once with the real rate changes, once with
`[]` (the `base` schedule) so the UI can show what the loan *would* have cost at
the original rate.

### Shapes

```js
loan   = { principal, months, startDate: "YYYY-MM-DD",
           linkedToPrime, spread, initialValue }
change = { id, date: "YYYY-MM-DD", value, note, auto? }
```

`value` on a change is the **prime** when `linkedToPrime`, otherwise the rate
itself; `effectiveRate()` is the only place that distinction is resolved.

## Persistence

`localStorage` only — no backend, no accounts.

| Key              | Contents                |
| ---------------- | ----------------------- |
| `loan_v2`        | the `loan` object       |
| `rateChanges_v2` | array of rate changes   |

The `_v2` suffix is a schema version. **If you change either shape
incompatibly, bump to `_v3`** rather than silently reading stale data.

## The prime-rate pipeline

Getting the Bank of Israel rate into the browser is the one non-obvious piece of
infrastructure. The BOI edge server is not CORS-open and rejects non-browser
user agents, so the browser never calls it directly:

```
GitHub Actions (cron, Mon+Thu 05:00 UTC)
  └─ node scripts/fetch-prime.mjs
       └─ https://edge.boi.gov.il  (SDMX 2.1 REST, browser User-Agent required)
            └─ writes public/prime.json  → committed with "[skip ci]"
                 └─ browser reads it from raw.githubusercontent.com (CORS-open)
```

In `App.jsx`, `PRIME_SOURCES` is tried in order:

1. `/api/prime` — a serverless endpoint, **only if the app is hosted somewhere
   that provides one**. No `api/` directory exists in this repo, so on the
   current deployment this always misses and falls through.
2. the `raw.githubusercontent.com` URL of `public/prime.json` on `main`.

If both fail the UI degrades to manual entry (`pull.state === "fail"`, the
`PullChip` shows "ידני"). Keep that fallback working — it is what makes the app
usable from a local `file://` open.

When a new prime arrives and it differs from the latest known rate, the app
**auto-appends a rate change** marked `auto: true` and shows a banner.
De-duplication is by `effectiveDate`.

### fetch-prime.mjs specifics

- Tries dataflow `BR` first (headline policy rate), falls back to `BIR` (bank
  lending rates).
- Pins the series to `MNT_RIB_BOI_D` via `POLICY_SERIES` (override with the
  `BIR_SERIES` env var). Falls back to a name match, then to a value-range
  heuristic, and logs a warning when it has to guess.
- Rounds the raw BOI value to the nearest 0.25 (policy rates move in quarter
  points) before adding `PRIME_SPREAD = 1.5`.
- `DISCOVER=1` logs the full dataflow catalogue — use it when the API shape
  changes and a series needs re-pinning.
- XML is parsed with regexes, not a parser. That is a deliberate
  zero-dependency choice; if the BOI response shape shifts, fix the regexes.
- Always writes every candidate series into `prime.json` so a wrong pick can be
  diagnosed from the committed file alone.

### About the workflow

`schedule:` triggers **only fire from the repository's default branch**. A
change to the cron on a feature branch does nothing until merged to `main`. Use
`workflow_dispatch` ("Run workflow") to test. The commit message carries
`[skip ci]` to avoid loops.

## Conventions

- **Hebrew, RTL.** All user-facing strings are Hebrew. The page is `dir="rtl"`;
  charts are individually wrapped in `dir="ltr"` because time flows
  left-to-right. Keep new UI text Hebrew and mirror that pattern.
- **Comments and identifiers are English**, UI strings are Hebrew.
- **Styling is inline objects in `St`.** No CSS files, no Tailwind, no CSS-in-JS
  library. Colors come from `C`.
- **No new dependencies without a strong reason.** The charts, XML parsing and
  layout are all hand-rolled specifically to keep the tree at
  react + react-dom + vite.
- Money is displayed rounded to whole shekels; rates to two decimals.
- Section banner comments (`// ─── … ───`) delimit regions in both `App.jsx`
  and the scripts — match the style when adding one.

## Watch out for

- Editing `buildSchedule` changes every KPI, chart and table at once. Sanity
  check against a known loan before and after.
- `public/prime.json` is machine-generated and committed. Don't hand-edit it;
  run the script.
- The `raw.githubusercontent.com` URL in `PRIME_SOURCES` hardcodes
  `shay011999-design/timetrack-app` and the `main` branch. A fork or a rename
  needs that URL updated.
- `monthsElapsed` compares against the real clock, so "current payment" and
  "balance now" move with today's date — tests or screenshots are not stable
  over time.
