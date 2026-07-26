import { useState, useEffect, useRef, useMemo } from "react";

// ─── Formatting ──────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const fmtMoney  = (n) => (Math.round(Number(n) || 0)).toLocaleString("he-IL") + " ₪";
const fmtMoney1 = (n) => (Number(n) || 0).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtPct    = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const fmtDateISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtMonth  = (d) => `${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
const fmtDateHe = (s) => { const d = new Date(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };

// ─── Spitzer (equal-payment) loan math ───────────────────────────────────────
const spitzerPayment = (balance, annualRatePct, months) => {
  if (!months || months <= 0 || balance <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return balance / months;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
};
const effectiveRate = (loan, primeOrRate) =>
  loan.linkedToPrime ? Number(primeOrRate) + Number(loan.spread || 0) : Number(primeOrRate);

// Month-by-month amortization, recomputing the payment at each rate change.
const buildSchedule = (loan, changes) => {
  const rows = [];
  const start = new Date(loan.startDate);
  const changeByMonth = {};
  changes.forEach((c) => {
    const d = new Date(c.date);
    const mi = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
    if (mi >= 0 && mi < loan.months) changeByMonth[mi] = effectiveRate(loan, c.value);
  });
  let balance = loan.principal;
  let annualRate = effectiveRate(loan, loan.initialValue);
  let payment = spitzerPayment(balance, annualRate, loan.months);
  let cumInterest = 0, cumPrincipal = 0;
  for (let m = 0; m < loan.months; m++) {
    const remaining = loan.months - m;
    if (changeByMonth[m] != null) {
      annualRate = changeByMonth[m];
      payment = spitzerPayment(balance, annualRate, remaining);
    }
    const r = annualRate / 100 / 12;
    let interest = balance * r;
    let principalPaid = payment - interest;
    let pay = payment;
    if (principalPaid > balance) { principalPaid = balance; pay = interest + principalPaid; }
    balance -= principalPaid;
    cumInterest += interest; cumPrincipal += principalPaid;
    rows.push({
      month: m, date: new Date(start.getFullYear(), start.getMonth() + m, 1),
      annualRate, prime: loan.linkedToPrime ? annualRate - Number(loan.spread || 0) : null,
      payment: pay, interest, principalPaid,
      balance: Math.max(balance, 0), cumInterest, cumPrincipal,
    });
  }
  return rows;
};
const monthsElapsed = (startDate) => {
  const s = new Date(startDate), t = new Date();
  return Math.max(0, (t.getFullYear() - s.getFullYear()) * 12 + (t.getMonth() - s.getMonth()));
};

// ─── Palette (validated dark categorical, Grafana surface) ───────────────────
const C = {
  page: "#0d0f14", panel: "#181b22", panelHead: "#1f232c",
  ink: "#eaecef", ink2: "#a7adba", muted: "#6b7280",
  grid: "#242833", axis: "#333846", border: "rgba(255,255,255,0.08)",
  blue: "#3987e5", orange: "#d95926", aqua: "#199e70", yellow: "#c98500",
  good: "#0ca30c", warn: "#fab219", crit: "#e66767",
};

// ─── SVG time-series chart (stepped line / area, hover crosshair) ────────────
function TimeChart({ series, dates, height = 200, unit = "", stepped = true,
                    area = false, zeroBaseline = false, nowIndex = -1, decimals = 0 }) {
  const [hi, setHi] = useState(-1);
  const n = dates.length;
  const W = 640, H = height, PL = 52, PR = 14, PT = 14, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;

  const allVals = series.flatMap((s) => s.data).filter((v) => v != null);
  let lo = zeroBaseline ? 0 : Math.min(...allVals);
  let hix = Math.max(...allVals);
  if (lo === hix) { hix = lo + 1; }
  const padv = (hix - lo) * 0.12 || 1;
  if (!zeroBaseline) lo -= padv;
  hix += padv;
  const x = (i) => PL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PT + ih - ((v - lo) / (hix - lo)) * ih;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, k) => lo + ((hix - lo) * k) / ticks);

  const linePath = (data) => {
    let d = "";
    data.forEach((v, i) => {
      if (v == null) return;
      if (d === "") { d = `M${x(i)},${y(v)}`; }
      else if (stepped) { d += ` H${x(i)} V${y(v)}`; }
      else { d += ` L${x(i)},${y(v)}`; }
    });
    return d;
  };
  const areaPath = (data) => {
    const lp = linePath(data);
    if (!lp) return "";
    return `${lp} V${y(lo)} H${x(0)} Z`;
  };

  const xLabelIdx = [];
  dates.forEach((d, i) => {
    const dt = new Date(d);
    if (i === 0 || (dt.getMonth() === 0) || i === n - 1) {
      if (!xLabelIdx.some((j) => Math.abs(x(j) - x(i)) < 46)) xLabelIdx.push(i);
    }
  });

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    setHi(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  return (
    <div dir="ltr" style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible" }}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
            <text x={PL - 8} y={y(t) + 3} fill={C.muted} fontSize="10" textAnchor="end"
              style={{ fontVariantNumeric: "tabular-nums" }}>
              {unit === "₪" ? fmtMoney1(t) : t.toFixed(decimals)}{unit && unit !== "₪" ? unit : ""}
            </text>
          </g>
        ))}
        {xLabelIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 8} fill={C.muted} fontSize="10" textAnchor="middle">
            {fmtMonth(new Date(dates[i]))}
          </text>
        ))}
        {nowIndex >= 0 && (
          <g>
            <line x1={x(nowIndex)} x2={x(nowIndex)} y1={PT} y2={PT + ih} stroke={C.warn}
              strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
            <text x={x(nowIndex)} y={PT - 3} fill={C.warn} fontSize="9" textAnchor="middle">היום</text>
          </g>
        )}
        {series.map((s, si) => (
          <g key={si}>
            {area && <path d={areaPath(s.data)} fill={s.color} opacity="0.13" />}
            <path d={linePath(s.data)} fill="none" stroke={s.color} strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {hi >= 0 && (
          <g>
            <line x1={x(hi)} x2={x(hi)} y1={PT} y2={PT + ih} stroke={C.ink2} strokeWidth="1" opacity="0.4" />
            {series.map((s, si) => s.data[hi] != null && (
              <circle key={si} cx={x(hi)} cy={y(s.data[hi])} r="3.5" fill={s.color}
                stroke={C.panel} strokeWidth="2" />
            ))}
          </g>
        )}
        <rect x={PL} y={PT} width={iw} height={ih} fill="transparent"
          onMouseMove={onMove} onMouseLeave={() => setHi(-1)} />
      </svg>
      {hi >= 0 && (
        <div style={{ ...St.tip, left: `${(x(hi) / W) * 100}%`,
          transform: `translateX(${x(hi) > W / 2 ? "-105%" : "5%"})` }}>
          <div style={{ color: C.ink2, fontSize: 11, marginBottom: 4 }}>{fmtDateHe(dates[hi])}</div>
          {series.map((s, si) => s.data[hi] != null && (
            <div key={si} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
              <span style={{ color: C.ink2 }}>{s.name}</span>
              <span style={{ color: C.ink, fontWeight: 700, marginInlineStart: "auto",
                fontVariantNumeric: "tabular-nums" }}>
                {unit === "₪" ? fmtMoney(s.data[hi]) : s.data[hi].toFixed(decimals) + unit}
              </span>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div style={St.legend}>
          {series.map((s, si) => (
            <span key={si} style={St.legItem}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />
              <span style={{ color: C.ink2, fontSize: 12 }}>{s.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Panel({ title, sub, children, span }) {
  return (
    <div style={{ ...St.panel, gridColumn: span ? "1 / -1" : "auto" }}>
      <div style={St.panelHead}>
        <span style={St.panelTitle}>{title}</span>
        {sub && <span style={St.panelSub}>{sub}</span>}
      </div>
      <div style={St.panelBody}>{children}</div>
    </div>
  );
}

function Stat({ label, value, color, delta, deltaGood }) {
  return (
    <div style={St.stat}>
      <div style={St.statLabel}>{label}</div>
      <div style={{ ...St.statValue, color: color || C.ink }}>{value}</div>
      {delta != null && (
        <div style={{ ...St.statDelta, color: deltaGood ? C.good : C.crit }}>{delta}</div>
      )}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────
const DEFAULT_DRAFT = { principal: "", months: "", startDate: fmtDateISO(new Date()),
  linkedToPrime: true, spread: "", initialValue: "" };

export default function App() {
  const [loan, setLoan] = useState(() => {
    try { return JSON.parse(localStorage.getItem("loan_v2")) || null; } catch { return null; }
  });
  const [rateChanges, setRateChanges] = useState(() => {
    try { return JSON.parse(localStorage.getItem("rateChanges_v2")) || []; } catch { return []; }
  });
  const [draft, setDraft] = useState(loan ? null : DEFAULT_DRAFT);
  const [pull, setPull] = useState({ state: "loading" }); // loading | ok | fail
  const [banner, setBanner] = useState(null);
  const [nc, setNc] = useState({ date: "", value: "", note: "" });
  const [showChanges, setShowChanges] = useState(false);

  useEffect(() => { localStorage.setItem("loan_v2", JSON.stringify(loan)); }, [loan]);
  useEffect(() => { localStorage.setItem("rateChanges_v2", JSON.stringify(rateChanges)); }, [rateChanges]);

  const sortedChanges = useMemo(
    () => [...rateChanges].sort((a, b) => new Date(a.date) - new Date(b.date)), [rateChanges]);

  // ── Auto-pull the prime from Bank of Israel (via /api/prime) ──
  const fetchPrime = async () => {
    setPull({ state: "loading" });
    try {
      const res = await fetch("/api/prime", { cache: "no-store" });
      const d = await res.json();
      if (!d || d.ok === false || typeof d.prime !== "number") { setPull({ state: "fail", reason: d && d.reason }); return; }
      setPull({ state: "ok", ...d });
      if (loan && loan.linkedToPrime) {
        const latest = sortedChanges.length ? sortedChanges[sortedChanges.length - 1].value : loan.initialValue;
        if (Math.abs(d.prime - latest) >= 0.01 && !rateChanges.some((c) => c.date === d.effectiveDate)) {
          setRateChanges((p) => [...p, { id: Date.now(), date: d.effectiveDate, value: d.prime,
            note: "עודכן אוטומטית מבנק ישראל", auto: true }]);
          setBanner(`🔔 עודכן אוטומטית: פריים ${fmtPct(d.prime)} (בנק ישראל ${fmtPct(d.boiRate)}) מ-${fmtDateHe(d.effectiveDate)}`);
        }
      }
    } catch { setPull({ state: "fail" }); }
  };
  useEffect(() => { fetchPrime(); /* eslint-disable-next-line */ }, [loan?.principal, loan?.linkedToPrime]);

  // ── Derived ──
  const data = useMemo(() => {
    if (!loan) return null;
    const schedule = buildSchedule(loan, sortedChanges);
    if (!schedule.length) return null;
    const base = buildSchedule(loan, []);
    const elapsed = Math.min(monthsElapsed(loan.startDate), loan.months);
    const idx = Math.min(elapsed, loan.months - 1);
    const prev = idx > 0 ? schedule[idx - 1] : null;
    const origPayment = spitzerPayment(loan.principal, effectiveRate(loan, loan.initialValue), loan.months);
    return {
      schedule, base, elapsed, idx,
      currentPayment: schedule[idx].payment,
      currentRate: schedule[idx].annualRate,
      origPayment,
      balanceNow: prev ? prev.balance : loan.principal,
      interestPaid: prev ? prev.cumInterest : 0,
      principalPaid: prev ? prev.cumPrincipal : 0,
      totalInterest: schedule[schedule.length - 1].cumInterest,
      baseTotalInterest: base[base.length - 1].cumInterest,
    };
  }, [loan, sortedChanges]);

  const saveLoan = () => {
    const d = draft, principal = Number(d.principal), months = Number(d.months);
    if (!principal || principal <= 0) return setBanner("⚠ הזן סכום קרן תקין");
    if (!months || months <= 0) return setBanner("⚠ הזן מספר חודשים תקין");
    if (!d.startDate) return setBanner("⚠ בחר תאריך התחלה");
    if (d.initialValue === "" || isNaN(Number(d.initialValue))) return setBanner("⚠ הזן ריבית התחלתית");
    setLoan({ principal, months, startDate: d.startDate, linkedToPrime: !!d.linkedToPrime,
      spread: d.linkedToPrime ? Number(d.spread || 0) : 0, initialValue: Number(d.initialValue) });
    setDraft(null); setBanner(null);
  };
  const addChange = () => {
    if (!nc.date || nc.value === "" || isNaN(Number(nc.value))) return setBanner("⚠ בחר תאריך והזן ריבית");
    setRateChanges((p) => [...p, { id: Date.now(), date: nc.date, value: Number(nc.value), note: nc.note.trim() }]);
    setNc({ date: "", value: "", note: "" });
  };
  const delChange = (id) => setRateChanges((p) => p.filter((c) => c.id !== id));

  // chart datasets
  const charts = useMemo(() => {
    if (!data) return null;
    const s = data.schedule, dates = s.map((r) => fmtDateISO(r.date));
    return {
      dates, nowIndex: data.idx,
      rate: [
        { name: "הריבית שלך", color: C.orange, data: s.map((r) => +r.annualRate.toFixed(2)) },
        ...(loan.linkedToPrime ? [{ name: "פריים", color: C.blue, data: s.map((r) => +r.prime.toFixed(2)) }] : []),
      ],
      payment: [{ name: "תשלום חודשי", color: C.aqua, data: s.map((r) => Math.round(r.payment)) }],
      balance: [{ name: "יתרת קרן", color: C.blue, data: s.map((r) => Math.round(r.balance)) }],
      split: [
        { name: "ריבית מצטברת", color: C.orange, data: s.map((r) => Math.round(r.cumInterest)) },
        { name: "קרן מצטברת", color: C.aqua, data: s.map((r) => Math.round(r.cumPrincipal)) },
      ],
    };
  }, [data, loan]);

  return (
    <div style={St.page}>
      {/* Top bar */}
      <div style={St.topbar}>
        <div style={St.brand}>
          <span style={{ fontSize: 20 }}>📊</span>
          <div>
            <div style={St.brandTitle}>מעקב הלוואת רכב</div>
            <div style={St.brandSub}>
              {loan ? `${fmtMoney(loan.principal)} · ${loan.months} ח' · ${loan.linkedToPrime ? `פריים + ${fmtPct(loan.spread).replace("%", "")}%` : "ריבית קבועה"}` : "לא הוגדרה הלוואה"}
            </div>
          </div>
        </div>
        <div style={St.topActions}>
          <PullChip pull={pull} onRefresh={fetchPrime} />
          {loan && <button style={St.iconBtn} title="הגדרות"
            onClick={() => setDraft({ ...loan, principal: String(loan.principal), months: String(loan.months),
              spread: String(loan.spread), initialValue: String(loan.initialValue) })}>⚙️</button>}
        </div>
      </div>

      {banner && (
        <div style={St.banner} onClick={() => setBanner(null)}>{banner} <span style={{ opacity: .6 }}>✕</span></div>
      )}

      {/* Config modal */}
      {draft && (
        <div style={St.modalBg} onClick={() => loan && setDraft(null)}>
          <div style={St.modal} onClick={(e) => e.stopPropagation()}>
            <div style={St.modalTitle}>💰 {loan ? "הגדרות הלוואה" : "הגדרת ההלוואה"}</div>
            <div style={St.formGrid}>
              <Field label="סכום הקרן (₪)"><input style={St.input} type="number" placeholder="100000"
                value={draft.principal} onChange={(e) => setDraft({ ...draft, principal: e.target.value })} /></Field>
              <Field label="תקופה (חודשים)"><input style={St.input} type="number" placeholder="60"
                value={draft.months} onChange={(e) => setDraft({ ...draft, months: e.target.value })} /></Field>
              <Field label="תאריך התחלה"><input style={St.input} type="date"
                value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} /></Field>
              <Field label={draft.linkedToPrime ? "פריים התחלתי (%)" : "ריבית שנתית (%)"}>
                <input style={St.input} type="number" step="0.01" placeholder="6"
                value={draft.initialValue} onChange={(e) => setDraft({ ...draft, initialValue: e.target.value })} /></Field>
            </div>
            <label style={St.check}>
              <input type="checkbox" checked={draft.linkedToPrime}
                onChange={(e) => setDraft({ ...draft, linkedToPrime: e.target.checked })} />
              צמוד לריבית הפריים (משתנה עם המשק — מתעדכן אוטומטית מבנק ישראל)
            </label>
            {draft.linkedToPrime && (
              <Field label="מרווח מעל הפריים (%) — לדוגמה P+1.5"><input style={St.input} type="number" step="0.01"
                placeholder="1.5" value={draft.spread} onChange={(e) => setDraft({ ...draft, spread: e.target.value })} /></Field>
            )}
            {draft.linkedToPrime && draft.initialValue !== "" && (
              <div style={St.hint}>ריבית אפקטיבית התחלתית: {fmtPct(Number(draft.initialValue || 0) + Number(draft.spread || 0))}</div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <button style={{ ...St.btn, ...St.btnPrimary, flex: 1 }} onClick={saveLoan}>שמור</button>
              {loan && <button style={{ ...St.btn, ...St.btnGhost, flex: 1 }} onClick={() => setDraft(null)}>סגור</button>}
            </div>
          </div>
        </div>
      )}

      {!loan && !draft && (
        <div style={St.empty}>
          <div style={{ fontSize: 40 }}>📊</div>
          <div style={{ color: C.ink, fontWeight: 700, fontSize: 17 }}>אין עדיין הלוואה</div>
          <button style={{ ...St.btn, ...St.btnPrimary }} onClick={() => setDraft(DEFAULT_DRAFT)}>➕ הגדר הלוואה</button>
        </div>
      )}

      {loan && data && charts && (
        <div style={St.dashboard}>
          {/* KPI row */}
          <div style={St.kpiRow}>
            <Stat label="תשלום חודשי נוכחי" value={fmtMoney(data.currentPayment)} color={C.aqua}
              delta={Math.abs(data.currentPayment - data.origPayment) >= 1
                ? `${data.currentPayment < data.origPayment ? "▼" : "▲"} ${fmtMoney(Math.abs(data.currentPayment - data.origPayment))} מההתחלה` : null}
              deltaGood={data.currentPayment < data.origPayment} />
            <Stat label="ריבית נוכחית" value={fmtPct(data.currentRate)} color={C.orange}
              delta={loan.linkedToPrime ? `פריים ${fmtPct(data.currentRate - loan.spread)}` : null} deltaGood />
            <Stat label="יתרת קרן" value={fmtMoney(data.balanceNow)} color={C.blue} />
            <Stat label="התקדמות" value={`${data.elapsed}/${loan.months}`} color={C.ink}
              delta={`${Math.round((data.elapsed / loan.months) * 100)}% שולם`} deltaGood />
            <Stat label="ריבית ששולמה" value={fmtMoney(data.interestPaid)} color={C.ink} />
            <Stat label="סה״כ ריבית (צפי)" value={fmtMoney(data.totalInterest)} color={C.ink}
              delta={Math.abs(data.totalInterest - data.baseTotalInterest) >= 1
                ? `${data.totalInterest < data.baseTotalInterest ? "▼" : "▲"} ${fmtMoney(Math.abs(data.totalInterest - data.baseTotalInterest))} מול קבועה` : null}
              deltaGood={data.totalInterest < data.baseTotalInterest} />
          </div>

          {/* Charts */}
          <div style={St.grid}>
            <Panel title="ריבית לאורך זמן" sub={loan.linkedToPrime ? "פריים מול הריבית האפקטיבית" : "ריבית ההלוואה"}>
              <TimeChart series={charts.rate} dates={charts.dates} unit="%" decimals={2}
                nowIndex={charts.nowIndex} height={200} />
            </Panel>
            <Panel title="תשלום חודשי לאורך זמן" sub="מחושב מחדש בכל שינוי ריבית">
              <TimeChart series={charts.payment} dates={charts.dates} unit="₪"
                nowIndex={charts.nowIndex} height={200} />
            </Panel>
            <Panel title="יתרת קרן" sub="לוח סילוקין">
              <TimeChart series={charts.balance} dates={charts.dates} unit="₪" area zeroBaseline
                nowIndex={charts.nowIndex} height={200} />
            </Panel>
            <Panel title="קרן מול ריבית (מצטבר)" sub="לאן הולך הכסף">
              <TimeChart series={charts.split} dates={charts.dates} unit="₪" area zeroBaseline
                nowIndex={charts.nowIndex} height={200} />
            </Panel>
          </div>

          {/* Rate changes */}
          <Panel title="שינויי ריבית" sub={`${sortedChanges.length} עדכונים · הפריים מתעדכן אוטומטית מבנק ישראל`} span>
            <div style={St.ncRow}>
              <input style={St.input} type="date" value={nc.date} onChange={(e) => setNc({ ...nc, date: e.target.value })} />
              <input style={St.input} type="number" step="0.01"
                placeholder={loan.linkedToPrime ? "פריים חדש %" : "ריבית חדשה %"}
                value={nc.value} onChange={(e) => setNc({ ...nc, value: e.target.value })} />
              <input style={{ ...St.input, flex: 2 }} placeholder="הערה (אופציונלי)"
                value={nc.note} onChange={(e) => setNc({ ...nc, note: e.target.value })} />
              <button style={{ ...St.btn, ...St.btnPrimary }} onClick={addChange}>הוסף</button>
            </div>
            {sortedChanges.length === 0
              ? <div style={{ ...St.hint, textAlign: "center", padding: "8px 0" }}>אין שינויי ריבית עדיין</div>
              : (
                <table style={St.table}>
                  <thead><tr>
                    {["תאריך", loan.linkedToPrime ? "פריים" : "", "ריבית", "תשלום חדש", "שינוי", "מקור", ""].map((h, i) =>
                      <th key={i} style={St.th}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {sortedChanges.map((c) => {
                      const start = new Date(loan.startDate);
                      const mi = (new Date(c.date).getFullYear() - start.getFullYear()) * 12 + (new Date(c.date).getMonth() - start.getMonth());
                      const after = mi >= 0 && mi < data.schedule.length ? data.schedule[mi] : null;
                      const before = mi > 0 && mi <= data.schedule.length ? data.schedule[mi - 1] : null;
                      const delta = after && before ? after.payment - before.payment : 0;
                      const inRange = mi >= 0 && mi < loan.months;
                      return (
                        <tr key={c.id}>
                          <td style={St.td}>{fmtDateHe(c.date)}</td>
                          {loan.linkedToPrime && <td style={St.td}>{fmtPct(c.value)}</td>}
                          <td style={{ ...St.td, color: C.orange, fontWeight: 700 }}>{fmtPct(effectiveRate(loan, c.value))}</td>
                          <td style={St.td}>{after && inRange ? fmtMoney(after.payment) : "—"}</td>
                          <td style={{ ...St.td, color: delta < 0 ? C.good : delta > 0 ? C.crit : C.muted, fontWeight: 700 }}>
                            {!inRange ? "מחוץ לטווח" : delta ? `${delta < 0 ? "▼" : "▲"} ${fmtMoney(Math.abs(delta))}` : "—"}
                          </td>
                          <td style={St.td}>{c.auto ? <span style={St.autoTag}>אוטומטי</span> : <span style={{ color: C.muted }}>ידני</span>}</td>
                          <td style={St.td}><button style={St.del} onClick={() => delChange(c.id)}>🗑</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
          </Panel>
        </div>
      )}

      <div style={St.foot}>
        הריבית נמשכת מבנק ישראל · פריים = ריבית בנק ישראל + 1.5% · הנתונים נשמרים מקומית בדפדפן שלך
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Heebo',system-ui,sans-serif;direction:rtl;background:${C.page}}
        button{transition:all .15s;cursor:pointer;font-family:inherit}
        button:hover{filter:brightness(1.12)}
        input{font-family:inherit}
        ::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:#ffffff18;border-radius:3px}
      `}</style>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={St.field}><span style={St.fieldLabel}>{label}</span>{children}</label>;
}
function PullChip({ pull, onRefresh }) {
  const map = {
    loading: { c: C.muted, t: "מסנכרן…", d: "●" },
    ok: { c: C.good, t: pull.prime != null ? `פריים ${fmtPct(pull.prime)}` : "מעודכן", d: "●" },
    fail: { c: C.warn, t: "ידני (אין חיבור)", d: "○" },
  }[pull.state] || { c: C.muted, t: "", d: "●" };
  return (
    <button style={St.chip} onClick={onRefresh} title={pull.state === "ok" && pull.asOf ? `נכון ל-${fmtDateHe(pull.asOf)}` : "רענן מבנק ישראל"}>
      <span style={{ color: map.c, fontSize: 10 }}>{map.d}</span>
      <span style={{ color: C.ink2, fontSize: 12 }}>{map.t}</span>
      <span style={{ color: C.muted, fontSize: 12 }}>↻</span>
    </button>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const St = {
  page: { minHeight: "100vh", background: C.page, color: C.ink, padding: "0 0 40px",
    fontFamily: "'Heebo',system-ui,sans-serif", direction: "rtl" },
  topbar: { display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.panel,
    position: "sticky", top: 0, zIndex: 50, flexWrap: "wrap", gap: 10 },
  brand: { display: "flex", alignItems: "center", gap: 10 },
  brandTitle: { fontWeight: 800, fontSize: 16, color: C.ink },
  brandSub: { fontSize: 12, color: C.ink2, marginTop: 1 },
  topActions: { display: "flex", alignItems: "center", gap: 8 },
  chip: { display: "flex", alignItems: "center", gap: 6, background: C.page,
    border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px" },
  iconBtn: { background: C.page, border: `1px solid ${C.border}`, borderRadius: 8,
    padding: "6px 9px", fontSize: 15 },
  banner: { margin: "12px 18px 0", background: "#1f2a1c", border: `1px solid ${C.good}55`,
    color: "#c9f0c0", padding: "10px 14px", borderRadius: 10, fontSize: 13, cursor: "pointer",
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  dashboard: { padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 1280, margin: "0 auto" },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 },
  stat: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 15px" },
  statLabel: { color: C.ink2, fontSize: 12, marginBottom: 6 },
  statValue: { fontSize: 24, fontWeight: 800, letterSpacing: -0.3 },
  statDelta: { fontSize: 12, fontWeight: 600, marginTop: 4 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,440px),1fr))", gap: 14 },
  panel: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" },
  panelHead: { display: "flex", alignItems: "baseline", gap: 8, padding: "12px 16px 0" },
  panelTitle: { fontWeight: 700, fontSize: 14, color: C.ink },
  panelSub: { fontSize: 11, color: C.muted },
  panelBody: { padding: "10px 14px 16px" },
  legend: { display: "flex", gap: 16, justifyContent: "center", marginTop: 8 },
  legItem: { display: "flex", alignItems: "center", gap: 6 },
  tip: { position: "absolute", top: 6, background: "#0b0d11ee", border: `1px solid ${C.border}`,
    borderRadius: 8, padding: "8px 10px", pointerEvents: "none", minWidth: 150, zIndex: 20,
    boxShadow: "0 8px 24px #00000070" },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  fieldLabel: { color: C.ink2, fontSize: 12, fontWeight: 600 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  input: { background: C.page, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink,
    padding: "9px 11px", fontSize: 13, outline: "none", width: "100%", textAlign: "right" },
  check: { display: "flex", alignItems: "center", gap: 8, color: C.ink2, fontSize: 13, cursor: "pointer" },
  hint: { color: C.muted, fontSize: 12 },
  btn: { padding: "10px 16px", borderRadius: 9, border: "none", fontSize: 14, fontWeight: 700 },
  btnPrimary: { background: C.blue, color: "#fff" },
  btnGhost: { background: "#ffffff12", color: C.ink2 },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "80px 20px" },
  modalBg: { position: "fixed", inset: 0, background: "#000000a0", backdropFilter: "blur(4px)",
    zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 18 },
  modal: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: "22px 20px",
    width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 12 },
  modalTitle: { fontWeight: 800, fontSize: 17, color: C.ink },
  ncRow: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { color: C.muted, fontWeight: 600, padding: "8px 10px", textAlign: "right",
    borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" },
  td: { color: C.ink2, padding: "9px 10px", textAlign: "right", whiteSpace: "nowrap",
    borderBottom: `1px solid ${C.grid}`, fontVariantNumeric: "tabular-nums" },
  autoTag: { background: `${C.blue}22`, color: C.blue, fontSize: 11, fontWeight: 700,
    padding: "2px 7px", borderRadius: 6 },
  del: { background: "transparent", border: "none", fontSize: 13, opacity: 0.6 },
  foot: { textAlign: "center", color: C.muted, fontSize: 11, padding: "24px 18px 0", lineHeight: 1.7 },
};
