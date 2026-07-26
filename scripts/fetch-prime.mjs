#!/usr/bin/env node
/**
 * Fetches the Bank of Israel headline interest rate from the BOI "new series
 * database" (Fusion Edge Server, SDMX 2.1 REST) and writes public/prime.json.
 *
 *   prime = Bank of Israel rate + 1.5%
 *
 * Runs in GitHub Actions (open network, no CORS) so the browser never touches
 * the BOI API; the static app reads the committed JSON from
 * raw.githubusercontent.com (CORS-open).
 *
 * The working data path is ws/public/sdmxapi/rest/data/{DATAFLOW}; the edge
 * server rejects the default agent, so a browser User-Agent is sent. The BIR
 * dataflow holds many *bank* rate series; the headline *policy* rate is a
 * specific series identified here by its name via the structure metadata.
 * Once its code is known it is pinned in POLICY_SERIES (env BIR_SERIES).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const UA = "Mozilla/5.0 (compatible; loan-dashboard-prime/1.0; +github-actions)";
const OUT = "public/prime.json";
const PRIME_SPREAD = 1.5;
const POLICY_SERIES = process.env.BIR_SERIES || "";      // pinned headline series code
const DISCOVER = process.env.DISCOVER !== "0";           // log structure metadata
const EDGE = "https://edge.boi.gov.il/FusionEdgeServer";
const DATA = `${EDGE}/ws/public/sdmxapi/rest/data`;
const STRUCT = `${EDGE}/sdmx/v2/structure`;
const since = new Date(); since.setFullYear(since.getFullYear() - 1);
const START = since.toISOString().slice(0, 10);

async function get(url) {
  const res = await fetch(url, { headers: { Accept: "application/xml", "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// name of a series/dataflow from its metadata block (prefers English, then any).
const nameOf = (block) =>
  /<(?:\w+:)?Name[^>]*xml:lang="en"[^>]*>([^<]+)</.exec(block)?.[1]
  || /<(?:\w+:)?Name[^>]*>([^<]+)</.exec(block)?.[1] || "";

// Log dataflows + their names so the policy-rate dataflow can be identified.
async function discoverDataflows() {
  try {
    const xml = await get(`${STRUCT}/dataflow/BOI.STATISTICS?detail=full`);
    const flows = xml.match(/<(?:\w+:)?Dataflow\b[\s\S]*?<\/(?:\w+:)?Dataflow>/g) || [];
    console.log(`── ${flows.length} dataflows ──`);
    for (const f of flows) {
      const id = /\bid="([^"]+)"/.exec(f.match(/<(?:\w+:)?Dataflow\b[^>]*>/)?.[0] || "")?.[1] || "?";
      const nm = nameOf(f);
      if (/interest|ריבית|monetary|מוניטרי|policy|prime|בנק ישראל/i.test(`${id} ${nm}`))
        console.log(`  ★ ${id}: ${nm}`);
      else console.log(`    ${id}: ${nm}`);
    }
  } catch (e) { console.log("dataflow discovery failed:", e.message); }
}

// Fetch a dataflow's data, returning per-series {code,name,latest}.
async function seriesOf(dataflow) {
  const xml = await get(`${DATA}/${dataflow}?startPeriod=${START}`);
  const out = [];
  const blocks = xml.match(/<(?:\w+:)?Series\b[\s\S]*?<\/(?:\w+:)?Series>/g) || [];
  for (const b of blocks) {
    const head = b.match(/<(?:\w+:)?Series\b[^>]*>/)?.[0] || "";
    const code = /SERIES_CODE="([^"]+)"/.exec(head)?.[1] || "(unknown)";
    const name = nameOf(b) || /(?:SERIES_NAME|TITLE|DESC[^=]*)="([^"]+)"/.exec(head)?.[1] || "";
    const obs = [...b.matchAll(/<(?:\w+:)?Obs\b[^>]*\/?>/g)]
      .map((m) => ({ date: /TIME_PERIOD="([^"]+)"/.exec(m[0])?.[1], value: parseFloat(/OBS_VALUE="([^"]+)"/.exec(m[0])?.[1]) }))
      .filter((o) => o.date && Number.isFinite(o.value))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (obs.length) out.push({ code, name, latest: obs[0], attrs: head.slice(0, 500) });
  }
  return out;
}

async function main() {
  if (DISCOVER) await discoverDataflows();

  let series = [];
  for (const df of ["BIR"]) {
    try { series = await seriesOf(df); console.log(`${df}: ${series.length} series`); if (series.length) break; }
    catch (e) { console.log(`${df} failed: ${e.message}`); }
  }
  if (!series.length) { console.error("ERROR: no series parsed."); process.exit(1); }

  console.log("── candidate series (code · name · latest) ──");
  series.forEach((s) => console.log(`  ${s.code} · ${s.name || "(no name)"} · ${s.latest.value} @ ${s.latest.date}`));

  // Selection: pinned code → else a series whose NAME marks it the BOI policy
  // rate → else a plausible clean-0.25 policy-band value.
  let chosen = POLICY_SERIES && series.find((s) => s.code === POLICY_SERIES);
  if (!chosen) chosen = series.find((s) => /ריבית בנק ישראל|bank of israel.*interest|policy rate|מוניטרי/i.test(s.name));
  if (!chosen) {
    const band = series.filter((s) => s.latest.value >= 0.1 && s.latest.value <= 8);
    chosen = (band[0] || series[0]);
    console.log("⚠ no name/pin match — using heuristic; inspect candidates above to pin BIR_SERIES.");
  }

  const boiRateRaw = chosen.latest.value;
  const boiRate = Math.round(boiRateRaw / 0.25) * 0.25;
  const prime = +(boiRate + PRIME_SPREAD).toFixed(2);
  const out = {
    ok: true, prime, boiRate, boiRateRaw,
    effectiveDate: chosen.latest.date,
    asOf: new Date().toISOString().slice(0, 10),
    seriesCode: chosen.code, seriesName: chosen.name || null,
    source: "Bank of Israel — Fusion Edge Server SDMX",
    candidates: series.map((s) => ({ code: s.code, name: s.name || null, value: s.latest.value, date: s.latest.date })),
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`✔ wrote ${OUT} → prime ${prime} from ${chosen.code} (${chosen.name || "no name"}) raw ${boiRateRaw}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
