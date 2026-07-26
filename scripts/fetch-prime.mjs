#!/usr/bin/env node
/**
 * Fetches the Bank of Israel interest rate from the BOI "new series database"
 * (Fusion Edge Server, SDMX 2.1 REST) and writes public/prime.json.
 *
 *   prime = Bank of Israel rate + 1.5%
 *
 * Runs in GitHub Actions (open network, no CORS), so the browser never touches
 * the BOI API directly — the static app reads the committed JSON from
 * raw.githubusercontent.com (CORS-open).
 *
 * Interest data lives in the BIR dataflow. The working data path is
 * ws/public/sdmxapi/rest/data/{DATAFLOW} (the sdmx/v2/data/dataflow/BOI/... path
 * 404s). The edge server rejects the default agent, so a browser User-Agent is
 * sent. Observations are flat <Obs TIME_PERIOD="YYYY-MM-DD" OBS_VALUE="3.5" .../>
 * inside <Series SERIES_CODE="..." ...> blocks. BIR holds several rate series;
 * BIR_SERIES pins the headline policy-rate series once its code is known.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const UA = "Mozilla/5.0 (compatible; loan-dashboard-prime/1.0; +github-actions)";
const OUT = "public/prime.json";
const PRIME_SPREAD = 1.5;                 // prime = BOI rate + 1.5%
const BIR_SERIES = process.env.BIR_SERIES || ""; // headline series code, once known

const BASE = "https://edge.boi.gov.il/FusionEdgeServer/ws/public/sdmxapi/rest/data/BIR";
// Pull the last year so every series has a recent observation.
const since = new Date(); since.setFullYear(since.getFullYear() - 1);
const ENDPOINTS = [
  `${BASE}?startPeriod=${since.toISOString().slice(0, 10)}`,
  `${BASE}?lastNObservations=1`,
  BASE,
];

async function getXml(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/xml", "User-Agent": UA },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Parse <Series ...>…</Series> blocks into { code, attrs, latest:{date,value} }.
function parseSeries(xml) {
  const out = [];
  const blocks = xml.match(/<(?:\w+:)?Series\b[\s\S]*?<\/(?:\w+:)?Series>/g) || [];
  for (const b of blocks) {
    const head = b.match(/<(?:\w+:)?Series\b[^>]*>/)?.[0] || "";
    const code = /SERIES_CODE="([^"]+)"/.exec(head)?.[1]
      || /(?:KEY|SERIES_NAME|NAME)="([^"]+)"/.exec(head)?.[1] || "(unknown)";
    const obs = [...b.matchAll(/<(?:\w+:)?Obs\b[^>]*\/?>/g)]
      .map((m) => ({
        date: /TIME_PERIOD="([^"]+)"/.exec(m[0])?.[1],
        value: parseFloat(/OBS_VALUE="([^"]+)"/.exec(m[0])?.[1]),
      }))
      .filter((o) => o.date && Number.isFinite(o.value))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (obs.length) out.push({ code, attrs: head.slice(0, 400), latest: obs[0], count: obs.length });
  }
  // Fallback: flat <Obs> with no <Series> wrapper.
  if (!out.length) {
    const obs = [...xml.matchAll(/<(?:\w+:)?Obs\b[^>]*\/?>/g)]
      .map((m) => ({
        date: /TIME_PERIOD="([^"]+)"/.exec(m[0])?.[1],
        value: parseFloat(/OBS_VALUE="([^"]+)"/.exec(m[0])?.[1]),
      }))
      .filter((o) => o.date && Number.isFinite(o.value))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (obs.length) out.push({ code: "(flat)", attrs: "", latest: obs[0], count: obs.length });
  }
  return out;
}

function pickHeadline(series) {
  if (BIR_SERIES) {
    const hit = series.find((s) => s.code === BIR_SERIES);
    if (hit) return hit;
    console.log(`⚠ BIR_SERIES="${BIR_SERIES}" not found; falling back to heuristic.`);
  }
  // Heuristic: newest observation, value a clean 0.25 step in a policy-rate band.
  const plausible = series.filter((s) => s.latest.value >= 0.1 && s.latest.value <= 8);
  const scored = (plausible.length ? plausible : series)
    .map((s) => ({ s, near: Math.abs(s.latest.value / 0.25 - Math.round(s.latest.value / 0.25)) }))
    .sort((a, b) => (a.s.latest.date < b.s.latest.date ? 1 : a.s.latest.date > b.s.latest.date ? -1 : a.near - b.near));
  return scored[0].s;
}

async function main() {
  let series = [], usedUrl = null, lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      console.log(`→ ${url}`);
      const xml = await getXml(url);
      console.log(`  ${xml.length} bytes`);
      series = parseSeries(xml);
      console.log(`  found ${series.length} series`);
      if (series.length) { usedUrl = url; break; }
      console.log("  raw head:", xml.slice(0, 800).replace(/\s+/g, " "));
    } catch (e) { console.log(`  failed: ${e.message}`); lastErr = e; }
  }
  if (!series.length) { console.error("ERROR: no BIR series parsed.", lastErr?.message || ""); process.exit(1); }

  console.log("── candidate series ──");
  series.forEach((s) => console.log(`  ${s.code}: ${s.latest.value} @ ${s.latest.date} (${s.count} obs)`));

  const chosen = pickHeadline(series);
  const boiRateRaw = chosen.latest.value;
  const boiRate = Math.round(boiRateRaw / 0.25) * 0.25;   // headline moves in 0.25 steps
  const prime = +(boiRate + PRIME_SPREAD).toFixed(2);

  const out = {
    ok: true,
    prime, boiRate, boiRateRaw,
    effectiveDate: chosen.latest.date,
    asOf: new Date().toISOString().slice(0, 10),
    seriesCode: chosen.code,
    source: "Bank of Israel — BIR dataflow (Fusion Edge Server SDMX)",
    sourceUrl: usedUrl,
    candidates: series.map((s) => ({ code: s.code, value: s.latest.value, date: s.latest.date })),
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("✔ wrote", OUT, "→ prime", prime, "from", chosen.code, boiRateRaw);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
