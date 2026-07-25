import { useState, useEffect, useRef } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtDate = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const fmtDur = (ms) => {
  if (!ms || ms < 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const fmtDurShort = (ms) => {
  if (!ms || ms < 0) return "0ד'";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}ש' ${m % 60}ד'` : `${m}ד'`;
};
const fmtDurDecimal = (ms) => {
  if (!ms || ms < 0) return "0.00";
  return (ms / 3600000).toFixed(2);
};

// ─── Loan (Spitzer) helpers ──────────────────────────────────────────────────
const fmtMoney = (n) => (Math.round(Number(n) || 0)).toLocaleString("he-IL") + " ₪";
const fmtPct   = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const fmtMonth = (d) => `${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const fmtDateISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// חישוב התשלום החודשי בשיטת שפיצר (תשלום קבוע): P·r / (1-(1+r)^-n)
const spitzerPayment = (balance, annualRatePct, months) => {
  if (!months || months <= 0 || balance <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return balance / months;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
};

// הריבית האפקטיבית לפי הזנת המשתמש (פריים+מרווח או ריבית מלאה)
const effectiveRate = (loan, value) =>
  loan.linkedToPrime ? Number(value) + Number(loan.spread || 0) : Number(value);

// בניית לוח סילוקין חודש-אחר-חודש, כולל שינויי ריבית לאורך התקופה
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
  let cumInterest = 0;

  for (let m = 0; m < loan.months; m++) {
    const remaining = loan.months - m;
    if (changeByMonth[m] != null) {
      annualRate = changeByMonth[m];
      payment = spitzerPayment(balance, annualRate, remaining); // חישוב מחדש על היתרה והתקופה שנותרה
    }
    const r = annualRate / 100 / 12;
    let interest = balance * r;
    let principalPaid = payment - interest;
    let pay = payment;
    if (principalPaid > balance) { principalPaid = balance; pay = interest + principalPaid; } // תשלום אחרון
    balance -= principalPaid;
    cumInterest += interest;
    rows.push({
      month: m,
      date: new Date(start.getFullYear(), start.getMonth() + m, 1),
      annualRate, payment: pay, interest, principalPaid,
      balance: Math.max(balance, 0), cumInterest,
    });
  }
  return rows;
};

const monthsElapsed = (startDate) => {
  const s = new Date(startDate), t = new Date();
  return Math.max(0, (t.getFullYear() - s.getFullYear()) * 12 + (t.getMonth() - s.getMonth()));
};

// ─── Default workplaces ──────────────────────────────────────────────────────
const DEFAULT_PLACES = [
  { id: 1, name: "מקום עבודה 1", color: "#6366f1", icon: "🏢" },
  { id: 2, name: "מקום עבודה 2", color: "#10b981", icon: "🏪" },
];

const COLORS = ["#6366f1","#10b981","#f59e0b","#ef4444","#3b82f6","#ec4899","#14b8a6","#f97316"];
const ICONS  = ["🏢","🏪","🏗","🏥","🍽","🛒","💼","🏠","🎓","🔧"];

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [now, setNow]           = useState(new Date());
  const [places, setPlaces]     = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_places")) || DEFAULT_PLACES; } catch { return DEFAULT_PLACES; }
  });
  const [sessions, setSessions] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_sessions")) || []; } catch { return []; }
  });
  const [activePlace, setActivePlace] = useState(null);
  const [checkIn, setCheckIn]   = useState(null);
  const [breakStart, setBreakStart] = useState(null);
  const [totalBreak, setTotalBreak] = useState(0);
  const [status, setStatus]     = useState("idle");
  const [elapsed, setElapsed]   = useState(0);
  const [view, setView]         = useState("home");
  const [filterPlace, setFilterPlace] = useState("all");
  const [editingPlace, setEditingPlace] = useState(null);
  const [newName, setNewName]   = useState("");
  const [newIcon, setNewIcon]   = useState("🏢");
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [showAddPlace, setShowAddPlace] = useState(false);
  const [toast, setToast]       = useState(null);
  const [exportModal, setExportModal] = useState(null); // placeId
  const [copied, setCopied]     = useState(false);
  // ── Loan tracker state ──
  const [loan, setLoan] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_loan")) || null; } catch { return null; }
  });
  const [rateChanges, setRateChanges] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_rateChanges")) || []; } catch { return []; }
  });
  const [loanDraft, setLoanDraft] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [ncDate, setNcDate] = useState("");
  const [ncValue, setNcValue] = useState("");
  const [ncNote, setNcNote] = useState("");
  const timerRef = useRef(null);

  useEffect(() => { localStorage.setItem("wt_places", JSON.stringify(places)); }, [places]);
  useEffect(() => { localStorage.setItem("wt_sessions", JSON.stringify(sessions)); }, [sessions]);
  useEffect(() => { localStorage.setItem("wt_loan", JSON.stringify(loan)); }, [loan]);
  useEffect(() => { localStorage.setItem("wt_rateChanges", JSON.stringify(rateChanges)); }, [rateChanges]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (status === "working" && checkIn) {
      timerRef.current = setInterval(() => setElapsed(Date.now() - checkIn - totalBreak), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [status, checkIn, totalBreak]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleCheckIn = (placeId) => {
    setActivePlace(placeId);
    setCheckIn(Date.now());
    setTotalBreak(0); setElapsed(0); setBreakStart(null);
    setStatus("working");
    showToast("✅ המשמרת התחילה!");
  };

  const handleBreak = () => {
    if (status === "working") { setBreakStart(Date.now()); setStatus("break"); showToast("⏸ הפסקה"); }
    else if (status === "break") {
      setTotalBreak(p => p + (Date.now() - breakStart));
      setBreakStart(null); setStatus("working"); showToast("▶ חזרת לעבודה");
    }
  };

  const handleCheckOut = () => {
    const now2 = Date.now();
    let fb = totalBreak;
    if (status === "break" && breakStart) fb += now2 - breakStart;
    const worked = now2 - checkIn - fb;
    setSessions(p => [{
      id: now2, placeId: activePlace,
      date: fmtDate(new Date(checkIn)),
      checkIn: fmtTime(new Date(checkIn)),
      checkOut: fmtTime(new Date(now2)),
      breakMs: fb, workedMs: worked,
    }, ...p]);
    setStatus("idle"); setActivePlace(null); setCheckIn(null);
    setBreakStart(null); setTotalBreak(0); setElapsed(0);
    showToast("🏁 משמרת נשמרה!");
  };

  const deleteSession = (id) => setSessions(p => p.filter(s => s.id !== id));

  // ── Export helpers ────────────────────────────────────────────────────────
  const buildTextReport = (placeId) => {
    const pl = places.find(p => p.id === placeId);
    const list = sessions.filter(s => s.placeId === placeId);
    if (!list.length) return null;
    const total = list.reduce((a, s) => a + s.workedMs, 0);
    let txt = `${pl.icon} דוח שעות — ${pl.name}\n`;
    txt += `══════════════════════\n`;
    list.forEach((s, i) => {
      txt += `${i + 1}. ${s.date}\n`;
      txt += `   כניסה: ${s.checkIn}  יציאה: ${s.checkOut}\n`;
      txt += `   הפסקה: ${fmtDurShort(s.breakMs)}  עבודה: ${fmtDurShort(s.workedMs)} (${fmtDurDecimal(s.workedMs)} שעות)\n`;
    });
    txt += `══════════════════════\n`;
    txt += `סה"כ משמרות: ${list.length}\n`;
    txt += `סה"כ שעות: ${fmtDurShort(total)} (${fmtDurDecimal(total)} שעות)`;
    return txt;
  };

  const handleCopy = (placeId) => {
    const txt = buildTextReport(placeId);
    if (!txt) { showToast("אין נתונים לייצוא"); return; }
    navigator.clipboard.writeText(txt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showToast("✅ הועתק! אפשר להדביק בכל מקום");
    });
  };

  const handleExcelExport = (placeId) => {
    const pl = places.find(p => p.id === placeId);
    const list = sessions.filter(s => s.placeId === placeId);
    if (!list.length) { showToast("אין נתונים לייצוא"); return; }

    // Build CSV with BOM for Hebrew support
    const BOM = "\uFEFF";
    const headers = ["#", "תאריך", "כניסה", "יציאה", "הפסקה", "שעות עבודה", "שעות (עשרוני)"];
    const rows = list.map((s, i) => [
      i + 1, s.date, s.checkIn, s.checkOut,
      fmtDurShort(s.breakMs), fmtDurShort(s.workedMs), fmtDurDecimal(s.workedMs)
    ]);
    const total = list.reduce((a, s) => a + s.workedMs, 0);
    rows.push(["", "", "", "", "סה\"כ:", fmtDurShort(total), fmtDurDecimal(total)]);

    const csv = BOM + [headers, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `שעות_${pl.name}.csv`;
    a.click(); URL.revokeObjectURL(url);
    showToast("📊 הקובץ הורד!");
  };

  const shareWhatsApp = (placeId) => {
    const txt = buildTextReport(placeId);
    if (!txt) { showToast("אין נתונים לשליחה"); return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, "_blank");
  };

  const shareEmail = (placeId) => {
    const pl = places.find(p => p.id === placeId);
    const txt = buildTextReport(placeId);
    if (!txt) { showToast("אין נתונים לשליחה"); return; }
    window.open(`mailto:?subject=${encodeURIComponent(`דוח שעות — ${pl.name}`)}&body=${encodeURIComponent(txt)}`, "_blank");
  };

  // ── Places management ─────────────────────────────────────────────────────
  const addPlace = () => {
    if (!newName.trim()) return;
    setPlaces(p => [...p, { id: Date.now(), name: newName.trim(), color: newColor, icon: newIcon }]);
    setNewName(""); setShowAddPlace(false); showToast("✅ מקום עבודה נוסף");
  };

  const saveEditPlace = () => {
    setPlaces(p => p.map(pl => pl.id === editingPlace.id
      ? { ...pl, name: newName || pl.name, color: newColor, icon: newIcon } : pl));
    setEditingPlace(null); showToast("✅ נשמר");
  };

  const deletePlace = (id) => {
    if (activePlace === id) { showToast("לא ניתן למחוק מקום פעיל"); return; }
    setPlaces(p => p.filter(pl => pl.id !== id));
    setSessions(p => p.filter(s => s.placeId !== id));
    showToast("🗑 נמחק");
  };

  // ── Loan tracker actions ───────────────────────────────────────────────────
  const openLoanForm = () => {
    setLoanDraft(loan ? { ...loan } : {
      principal: "", months: "", startDate: fmtDateISO(new Date()),
      linkedToPrime: true, spread: "1.5", initialValue: "6",
    });
  };

  const saveLoan = () => {
    const d = loanDraft;
    const principal = Number(d.principal), months = Number(d.months);
    if (!principal || principal <= 0) { showToast("הזן סכום קרן תקין"); return; }
    if (!months || months <= 0) { showToast("הזן מספר חודשים תקין"); return; }
    if (!d.startDate) { showToast("בחר תאריך התחלה"); return; }
    if (d.initialValue === "" || isNaN(Number(d.initialValue))) { showToast("הזן ריבית התחלתית"); return; }
    setLoan({
      principal, months, startDate: d.startDate,
      linkedToPrime: !!d.linkedToPrime,
      spread: d.linkedToPrime ? Number(d.spread || 0) : 0,
      initialValue: Number(d.initialValue),
    });
    setLoanDraft(null);
    showToast("✅ פרטי ההלוואה נשמרו");
  };

  const addRateChange = () => {
    if (!ncDate) { showToast("בחר תאריך לעדכון"); return; }
    if (ncValue === "" || isNaN(Number(ncValue))) { showToast("הזן ערך ריבית"); return; }
    setRateChanges(p => [...p, { id: Date.now(), date: ncDate, value: Number(ncValue), note: ncNote.trim() }]);
    setNcDate(""); setNcValue(""); setNcNote("");
    showToast("✅ עדכון ריבית נוסף");
  };

  const deleteRateChange = (id) => setRateChanges(p => p.filter(c => c.id !== id));

  // ── Stats ─────────────────────────────────────────────────────────────────
  const statsFor = (placeId) => {
    const list = sessions.filter(s => s.placeId === placeId);
    return { count: list.length, total: list.reduce((a, s) => a + s.workedMs, 0) };
  };

  const filteredSessions = filterPlace === "all" ? sessions : sessions.filter(s => s.placeId === Number(filterPlace));
  const activePlaceObj = places.find(p => p.id === activePlace);
  const exportPlaceObj = places.find(p => p.id === exportModal);

  // ── Loan derived data ──
  const sortedChanges = [...rateChanges].sort((a, b) => new Date(a.date) - new Date(b.date));
  const schedule = loan ? buildSchedule(loan, sortedChanges) : [];
  let loanData = null;
  if (loan && schedule.length) {
    const elapsed = Math.min(monthsElapsed(loan.startDate), loan.months);
    const idxNow = Math.min(elapsed, loan.months - 1);
    const rowNow = schedule[idxNow];
    const prevRow = idxNow > 0 ? schedule[idxNow - 1] : null;
    const origPayment = spitzerPayment(loan.principal, effectiveRate(loan, loan.initialValue), loan.months);
    const baseSchedule = buildSchedule(loan, []); // תרחיש ללא שינויי ריבית
    loanData = {
      elapsed, idxNow, rowNow, origPayment,
      currentPayment: rowNow.payment,
      currentRate: rowNow.annualRate,
      balanceNow: prevRow ? prevRow.balance : loan.principal,
      interestPaid: prevRow ? prevRow.cumInterest : 0,
      totalInterest: schedule[schedule.length - 1].cumInterest,
      baseTotalInterest: baseSchedule[baseSchedule.length - 1].cumInterest,
      endDate: schedule[schedule.length - 1].date,
    };
  }

  return (
    <div style={S.page}>
      <div style={S.blob1}/><div style={S.blob2}/>
      {toast && <div style={S.toast}>{toast}</div>}

      {/* ── Export Modal ── */}
      {exportModal && exportPlaceObj && (
        <div style={S.modalBg} onClick={() => setExportModal(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>{exportPlaceObj.icon} ייצוא — {exportPlaceObj.name}</div>

            {/* Summary inside modal */}
            {(() => {
              const list = sessions.filter(s => s.placeId === exportModal);
              const total = list.reduce((a, s) => a + s.workedMs, 0);
              return list.length > 0 ? (
                <div style={S.summaryBox}>
                  <div style={S.summaryRow2}>
                    <span style={S.summaryLabel2}>סה"כ משמרות</span>
                    <span style={S.summaryVal}>{list.length}</span>
                  </div>
                  <div style={S.summaryRow2}>
                    <span style={S.summaryLabel2}>סה"כ שעות</span>
                    <span style={{ ...S.summaryVal, color: exportPlaceObj.color }}>{fmtDurShort(total)}</span>
                  </div>
                  <div style={S.summaryRow2}>
                    <span style={S.summaryLabel2}>בעשרוני</span>
                    <span style={{ ...S.summaryVal, color: exportPlaceObj.color }}>{fmtDurDecimal(total)} ש'</span>
                  </div>
                </div>
              ) : <div style={{ color:"#475569", fontSize:13, textAlign:"center", padding:"10px 0" }}>אין נתונים עדיין</div>;
            })()}

            <div style={S.exportOptions}>
              <button style={{ ...S.exportBtn2, background:"#25D36615", borderColor:"#25D36640", color:"#25D366" }}
                onClick={() => { shareWhatsApp(exportModal); setExportModal(null); }}>
                <span style={S.exportIcon}>📲</span>
                <div><div style={S.exportBtnTitle}>וואטסאפ</div><div style={S.exportBtnSub}>שלח כהודעה</div></div>
              </button>
              <button style={{ ...S.exportBtn2, background:"#3b82f615", borderColor:"#3b82f640", color:"#3b82f6" }}
                onClick={() => { shareEmail(exportModal); setExportModal(null); }}>
                <span style={S.exportIcon}>📧</span>
                <div><div style={S.exportBtnTitle}>מייל</div><div style={S.exportBtnSub}>שלח כמייל</div></div>
              </button>
              <button style={{ ...S.exportBtn2, background:"#10b98115", borderColor:"#10b98140", color:"#10b981" }}
                onClick={() => { handleExcelExport(exportModal); setExportModal(null); }}>
                <span style={S.exportIcon}>📊</span>
                <div><div style={S.exportBtnTitle}>אקסל / CSV</div><div style={S.exportBtnSub}>הורד קובץ</div></div>
              </button>
              <button style={{ ...S.exportBtn2, background:"#f59e0b15", borderColor:"#f59e0b40", color:"#f59e0b" }}
                onClick={() => { handleCopy(exportModal); }}>
                <span style={S.exportIcon}>{copied ? "✅" : "📋"}</span>
                <div><div style={S.exportBtnTitle}>{copied ? "הועתק!" : "העתק טקסט"}</div><div style={S.exportBtnSub}>הדבק בכל מקום</div></div>
              </button>
            </div>

            <button style={{ ...S.btn, background:"#ffffff10", color:"#64748b", marginTop:4 }}
              onClick={() => setExportModal(null)}>סגור</button>
          </div>
        </div>
      )}

      {/* ── Edit / Add Place Modal ── */}
      {(showAddPlace || editingPlace) && (
        <div style={S.modalBg} onClick={() => { setShowAddPlace(false); setEditingPlace(null); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>{editingPlace ? "✏️ עריכת מקום" : "➕ מקום עבודה חדש"}</div>
            <input style={S.input} placeholder="שם מקום העבודה"
              value={newName} onChange={e => setNewName(e.target.value)} />
            <div style={S.modalLabel}>אייקון</div>
            <div style={S.iconGrid}>
              {ICONS.map(ic => (
                <button key={ic} onClick={() => setNewIcon(ic)}
                  style={{ ...S.iconBtn, background: newIcon === ic ? "#ffffff25" : "transparent",
                    border: newIcon === ic ? "2px solid #fff" : "2px solid transparent" }}>{ic}</button>
              ))}
            </div>
            <div style={S.modalLabel}>צבע</div>
            <div style={S.colorRow}>
              {COLORS.map(c => (
                <button key={c} onClick={() => setNewColor(c)}
                  style={{ ...S.colorDot, background: c, border: newColor === c ? "3px solid #fff" : "3px solid transparent" }}/>
              ))}
            </div>
            <div style={{ display:"flex", gap:10, marginTop:8 }}>
              <button style={{ ...S.btn, ...S.btnGreen, flex:1 }} onClick={editingPlace ? saveEditPlace : addPlace}>שמור</button>
              <button style={{ ...S.btn, background:"#ffffff15", color:"#94a3b8", flex:1 }}
                onClick={() => { setShowAddPlace(false); setEditingPlace(null); }}>ביטול</button>
            </div>
          </div>
        </div>
      )}

      <div style={S.container}>
        {/* Header */}
        <div style={S.header}>
          <div style={S.logoRow}><span style={{fontSize:26}}>⏱</span><span style={S.logoText}>TimeTrack</span></div>
          <div style={S.clockTime}>{fmtTime(now)}</div>
          <div style={S.clockDate}>{now.toLocaleDateString("he-IL",{weekday:"long"})}, {fmtDate(now)}</div>
        </div>

        {/* Nav */}
        <div style={S.nav}>
          {[["home","🏠 ראשי"],["history","📋 היסטוריה"],["loan","💰 הלוואה"],["settings","⚙️ הגדרות"]].map(([v,l]) => (
            <button key={v} onClick={() => setView(v)}
              style={{ ...S.navBtn, ...(view===v ? S.navBtnActive : {}) }}>{l}</button>
          ))}
        </div>

        {/* ── HOME ── */}
        {view === "home" && (
          <div style={S.section}>
            {status !== "idle" && activePlaceObj && (
              <div style={{ ...S.timerCard, borderColor: activePlaceObj.color + "50",
                boxShadow:`0 0 24px ${activePlaceObj.color}25` }}>
                <div style={{ color: activePlaceObj.color, fontWeight:700, fontSize:14, marginBottom:4 }}>
                  {activePlaceObj.icon} {activePlaceObj.name}
                </div>
                <div style={S.timerDisplay}>{fmtDur(elapsed)}</div>
                <div style={S.timerSub}>
                  {status === "working" ? "🟢 בעבודה" : "🟡 הפסקה"} · כניסה {fmtTime(new Date(checkIn))}
                  {totalBreak > 0 && ` · הפסקות: ${fmtDurShort(totalBreak)}`}
                </div>
                <div style={{ display:"flex", gap:10, marginTop:14 }}>
                  <button style={{ ...S.btn, ...(status==="break"?S.btnGreen:S.btnAmber), flex:1 }} onClick={handleBreak}>
                    {status==="break" ? "▶ חזור לעבודה" : "⏸ הפסקה"}
                  </button>
                  <button style={{ ...S.btn, ...S.btnRed, flex:1 }} onClick={handleCheckOut}>🔴 סיום</button>
                </div>
              </div>
            )}

            {places.map(pl => {
              const st = statsFor(pl.id);
              const isActive = activePlace === pl.id;
              return (
                <div key={pl.id} style={{ ...S.placeCard, borderColor: pl.color + "40",
                  opacity: (status!=="idle" && !isActive) ? 0.45 : 1 }}>
                  <div style={{ ...S.placeHeader, background: pl.color + "18" }}>
                    <span style={S.placeIcon}>{pl.icon}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ ...S.placeName, color: pl.color }}>{pl.name}</div>
                      <div style={S.placeStat}>{st.count} משמרות · {fmtDurShort(st.total)} ({fmtDurDecimal(st.total)} ש')</div>
                    </div>
                  </div>
                  <div style={S.placeActions}>
                    {status === "idle" && (
                      <button style={{ ...S.btn, background: pl.color, color:"#fff", flex:1,
                        boxShadow:`0 4px 14px ${pl.color}45` }} onClick={() => handleCheckIn(pl.id)}>
                        🟢 התחל משמרת
                      </button>
                    )}
                    <button style={{ ...S.iconActionBtn }} onClick={() => {
                      setExportModal(pl.id); setCopied(false);
                    }} title="ייצוא">📤</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── HISTORY ── */}
        {view === "history" && (
          <div style={S.section}>
            <div style={S.filterRow}>
              <select style={S.select} value={filterPlace} onChange={e => setFilterPlace(e.target.value)}>
                <option value="all">כל המקומות</option>
                {places.map(p => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
              </select>
            </div>

            {/* Summary bar */}
            {filteredSessions.length > 0 && (
              <div style={S.summaryBar}>
                <div style={S.summaryBarItem}>
                  <span style={S.summaryBarNum}>{filteredSessions.length}</span>
                  <span style={S.summaryBarLabel}>משמרות</span>
                </div>
                <div style={S.summaryBarDivider}/>
                <div style={S.summaryBarItem}>
                  <span style={S.summaryBarNum}>{fmtDurShort(filteredSessions.reduce((a,s)=>a+s.workedMs,0))}</span>
                  <span style={S.summaryBarLabel}>סה"כ שעות</span>
                </div>
                <div style={S.summaryBarDivider}/>
                <div style={S.summaryBarItem}>
                  <span style={S.summaryBarNum}>{fmtDurDecimal(filteredSessions.reduce((a,s)=>a+s.workedMs,0))}</span>
                  <span style={S.summaryBarLabel}>שעות עשרוני</span>
                </div>
              </div>
            )}

            {filteredSessions.length === 0
              ? <div style={S.empty}>📭<br/>אין משמרות עדיין</div>
              : filteredSessions.map(s => {
                const pl = places.find(p => p.id === s.placeId) || { name:"?", color:"#64748b", icon:"❓" };
                return (
                  <div key={s.id} style={{ ...S.sessionCard, borderRightColor: pl.color }}>
                    <div style={S.sessionTop}>
                      <span style={{ color: pl.color, fontWeight:700 }}>{pl.icon} {pl.name}</span>
                      <span style={S.sessionDate}>{s.date}</span>
                    </div>
                    <div style={S.sessionRow}>
                      <span style={{ color:"#94a3b8" }}>⏰ {s.checkIn} – {s.checkOut}</span>
                      <span style={{ color:"#10b981", fontWeight:700 }}>✅ {fmtDurShort(s.workedMs)}</span>
                    </div>
                    <div style={S.sessionRow}>
                      <span style={{ color:"#475569", fontSize:12 }}>
                        הפסקה: {fmtDurShort(s.breakMs)} · {fmtDurDecimal(s.workedMs)} שעות
                      </span>
                      <button onClick={() => deleteSession(s.id)} style={S.delBtn}>🗑</button>
                    </div>
                  </div>
                );
              })
            }
          </div>
        )}

        {/* ── LOAN ── */}
        {view === "loan" && (
          <div style={S.section}>
            {/* Setup / edit form */}
            {(loanDraft || !loan) && (
              <div style={S.loanForm}>
                <div style={S.modalTitle}>💰 {loan ? "עריכת ההלוואה" : "פרטי ההלוואה"}</div>
                <div style={S.loanHint}>הלוואת שפיצר = תשלום חודשי קבוע, שמתחשב מחדש בכל שינוי ריבית</div>
                <div style={S.formGrid}>
                  <label style={S.fLabel}>סכום הקרן (₪)
                    <input style={S.input} type="number" inputMode="numeric" placeholder="לדוגמה 120000"
                      value={loanDraft?.principal ?? ""} onChange={e => setLoanDraft(d => ({ ...d, principal: e.target.value }))} />
                  </label>
                  <label style={S.fLabel}>תקופה (חודשים)
                    <input style={S.input} type="number" inputMode="numeric" placeholder="לדוגמה 60"
                      value={loanDraft?.months ?? ""} onChange={e => setLoanDraft(d => ({ ...d, months: e.target.value }))} />
                  </label>
                  <label style={S.fLabel}>תאריך התחלה
                    <input style={S.input} type="date"
                      value={loanDraft?.startDate ?? ""} onChange={e => setLoanDraft(d => ({ ...d, startDate: e.target.value }))} />
                  </label>
                  <label style={S.fLabel}>{loanDraft?.linkedToPrime ? "פריים התחלתי (%)" : "ריבית שנתית (%)"}
                    <input style={S.input} type="number" step="0.01" inputMode="decimal" placeholder="לדוגמה 6"
                      value={loanDraft?.initialValue ?? ""} onChange={e => setLoanDraft(d => ({ ...d, initialValue: e.target.value }))} />
                  </label>
                </div>

                <label style={S.checkRow}>
                  <input type="checkbox" checked={!!loanDraft?.linkedToPrime}
                    onChange={e => setLoanDraft(d => ({ ...d, linkedToPrime: e.target.checked }))} />
                  <span>צמוד לריבית הפריים (ריבית משתנה לפי המשק)</span>
                </label>
                {loanDraft?.linkedToPrime && (
                  <label style={S.fLabel}>מרווח מעל הפריים (%) — לדוגמה P+1.5
                    <input style={S.input} type="number" step="0.01" inputMode="decimal" placeholder="1.5"
                      value={loanDraft?.spread ?? ""} onChange={e => setLoanDraft(d => ({ ...d, spread: e.target.value }))} />
                  </label>
                )}
                {loanDraft?.linkedToPrime && loanDraft?.initialValue !== "" && (
                  <div style={S.loanHint}>ריבית אפקטיבית התחלתית: {fmtPct(Number(loanDraft.initialValue || 0) + Number(loanDraft.spread || 0))}</div>
                )}

                <div style={{ display:"flex", gap:10, marginTop:6 }}>
                  <button style={{ ...S.btn, ...S.btnGreen, flex:1 }} onClick={saveLoan}>שמור</button>
                  {loan && <button style={{ ...S.btn, background:"#ffffff15", color:"#94a3b8", flex:1 }}
                    onClick={() => setLoanDraft(null)}>ביטול</button>}
                </div>
              </div>
            )}

            {/* Results */}
            {loan && !loanDraft && loanData && (
              <>
                <div style={S.loanHero}>
                  <div style={S.loanHeroLabel}>התשלום החודשי הנוכחי</div>
                  <div style={S.loanHeroVal}>{fmtMoney(loanData.currentPayment)}</div>
                  <div style={S.loanHeroSub}>
                    ריבית נוכחית {fmtPct(loanData.currentRate)}
                    {loan.linkedToPrime && ` (פריים ${fmtPct(loanData.currentRate - loan.spread)} + ${fmtPct(loan.spread).replace("%","")}%)`}
                  </div>
                  {Math.abs(loanData.currentPayment - loanData.origPayment) >= 1 && (
                    <div style={{ ...S.loanDelta, color: loanData.currentPayment > loanData.origPayment ? "#ef4444" : "#10b981" }}>
                      {loanData.currentPayment > loanData.origPayment ? "▲" : "▼"} {fmtMoney(Math.abs(loanData.currentPayment - loanData.origPayment))} לחודש מאז ההתחלה
                      ({fmtMoney(loanData.origPayment)} בתחילה)
                    </div>
                  )}
                </div>

                <div style={S.loanGrid}>
                  <div style={S.loanStat}><div style={S.loanStatVal}>{fmtMoney(loanData.balanceNow)}</div><div style={S.loanStatLbl}>יתרת קרן להיום</div></div>
                  <div style={S.loanStat}><div style={S.loanStatVal}>{loanData.elapsed}/{loan.months}</div><div style={S.loanStatLbl}>חודשים ששולמו</div></div>
                  <div style={S.loanStat}><div style={S.loanStatVal}>{fmtMoney(loanData.interestPaid)}</div><div style={S.loanStatLbl}>ריבית ששולמה עד היום</div></div>
                  <div style={S.loanStat}><div style={S.loanStatVal}>{fmtMoney(loanData.totalInterest)}</div><div style={S.loanStatLbl}>סה"כ ריבית (צפי)</div></div>
                </div>

                {Math.abs(loanData.totalInterest - loanData.baseTotalInterest) >= 1 && (
                  <div style={{ ...S.loanCompare, color: loanData.totalInterest > loanData.baseTotalInterest ? "#f59e0b" : "#10b981" }}>
                    {loanData.totalInterest > loanData.baseTotalInterest ? "📈" : "📉"} שינויי הריבית {loanData.totalInterest > loanData.baseTotalInterest ? "מייקרים" : "מוזילים"} את ההלוואה בכ־{fmtMoney(Math.abs(loanData.totalInterest - loanData.baseTotalInterest))} לעומת ריבית קבועה
                  </div>
                )}

                {/* Rate changes */}
                <div style={S.settingsTitle}>מעקב שינויי ריבית</div>
                <div style={S.loanForm}>
                  <div style={S.loanHint}>
                    {loan.linkedToPrime
                      ? "כשבנק ישראל משנה ריבית — עדכן כאן את הפריים החדש והתשלום יחושב מחדש."
                      : "הזן כאן כל עדכון ריבית שקיבלת מהבנק."}
                  </div>
                  <div style={S.ncGrid}>
                    <input style={S.input} type="date" value={ncDate} onChange={e => setNcDate(e.target.value)} />
                    <input style={S.input} type="number" step="0.01" inputMode="decimal"
                      placeholder={loan.linkedToPrime ? "פריים חדש %" : "ריבית חדשה %"}
                      value={ncValue} onChange={e => setNcValue(e.target.value)} />
                  </div>
                  <input style={S.input} placeholder="הערה (אופציונלי) — לדוגמה: העלאת בנק ישראל"
                    value={ncNote} onChange={e => setNcNote(e.target.value)} />
                  <button style={{ ...S.btn, ...S.btnGreen }} onClick={addRateChange}>➕ הוסף עדכון ריבית</button>
                </div>

                {sortedChanges.length === 0
                  ? <div style={{ ...S.loanHint, textAlign:"center", padding:"6px 0" }}>עדיין לא נרשמו שינויי ריבית</div>
                  : sortedChanges.map(c => {
                    const eff = effectiveRate(loan, c.value);
                    const start = new Date(loan.startDate);
                    const mi = (new Date(c.date).getFullYear() - start.getFullYear()) * 12 + (new Date(c.date).getMonth() - start.getMonth());
                    const before = mi > 0 && mi <= schedule.length ? schedule[mi - 1] : null;
                    const after = mi >= 0 && mi < schedule.length ? schedule[mi] : null;
                    const delta = before && after ? after.payment - before.payment : 0;
                    return (
                      <div key={c.id} style={{ ...S.sessionCard, borderRightColor: delta > 0 ? "#ef4444" : delta < 0 ? "#10b981" : "#64748b" }}>
                        <div style={S.sessionTop}>
                          <span style={{ color:"#e2e8f0", fontWeight:700 }}>
                            {fmtMonth(new Date(c.date))} · {loan.linkedToPrime ? `פריים ${fmtPct(c.value)}` : ""} ריבית {fmtPct(eff)}
                          </span>
                          <button onClick={() => deleteRateChange(c.id)} style={S.delBtn}>🗑</button>
                        </div>
                        {after && (mi >= 0 && mi < loan.months) && (
                          <div style={S.sessionRow}>
                            <span style={{ color:"#94a3b8", fontSize:13 }}>תשלום חדש: {fmtMoney(after.payment)}</span>
                            {before && <span style={{ color: delta > 0 ? "#ef4444" : delta < 0 ? "#10b981" : "#64748b", fontWeight:700, fontSize:13 }}>
                              {delta > 0 ? "▲ +" : delta < 0 ? "▼ " : ""}{delta !== 0 ? fmtMoney(delta) : "ללא שינוי"}
                            </span>}
                          </div>
                        )}
                        {(mi < 0 || mi >= loan.months) && <div style={{ color:"#f59e0b", fontSize:12 }}>⚠ התאריך מחוץ לתקופת ההלוואה</div>}
                        {c.note && <div style={{ color:"#475569", fontSize:12 }}>{c.note}</div>}
                      </div>
                    );
                  })
                }

                {/* Schedule */}
                <button style={{ ...S.btn, background:"#ffffff10", color:"#94a3b8", marginTop:4 }}
                  onClick={() => setShowSchedule(s => !s)}>
                  {showSchedule ? "▲ הסתר לוח סילוקין" : "▼ הצג לוח סילוקין מלא"}
                </button>
                {showSchedule && (
                  <div style={S.tableWrap}>
                    <table style={S.table}>
                      <thead>
                        <tr>
                          {["חודש","ריבית","תשלום","מזה ריבית","מזה קרן","יתרה"].map(h => <th key={h} style={S.th}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {schedule.map((r) => (
                          <tr key={r.month} style={r.month === loanData.idxNow ? S.trNow : undefined}>
                            <td style={S.td}>{fmtMonth(r.date)}</td>
                            <td style={S.td}>{fmtPct(r.annualRate)}</td>
                            <td style={S.td}>{fmtMoney(r.payment)}</td>
                            <td style={S.td}>{fmtMoney(r.interest)}</td>
                            <td style={S.td}>{fmtMoney(r.principalPaid)}</td>
                            <td style={S.td}>{fmtMoney(r.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ display:"flex", gap:10 }}>
                  <button style={{ ...S.btn, background:"#ffffff10", color:"#94a3b8", flex:1 }} onClick={openLoanForm}>✏️ ערוך הלוואה</button>
                  <button style={{ ...S.btn, background:"#ef444420", color:"#ef4444", border:"1px solid #ef444430", flex:1 }}
                    onClick={() => { if (window.confirm("למחוק את ההלוואה ואת כל שינויי הריבית?")) { setLoan(null); setRateChanges([]); showToast("🗑 נמחק"); } }}>
                    🗑 מחק הלוואה
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── SETTINGS ── */}
        {view === "settings" && (
          <div style={S.section}>
            <div style={S.settingsTitle}>מקומות עבודה</div>
            {places.map(pl => (
              <div key={pl.id} style={{ ...S.settingRow, borderRightColor: pl.color }}>
                <span style={{ fontSize:22 }}>{pl.icon}</span>
                <span style={{ flex:1, color:"#e2e8f0", fontWeight:600 }}>{pl.name}</span>
                <button style={S.iconActionBtn} onClick={() => {
                  setEditingPlace(pl); setNewName(pl.name); setNewColor(pl.color); setNewIcon(pl.icon);
                }}>✏️</button>
                <button style={S.iconActionBtn} onClick={() => deletePlace(pl.id)}>🗑</button>
              </div>
            ))}
            <button style={{ ...S.btn, ...S.btnGreen, marginTop:8 }} onClick={() => {
              setNewName(""); setNewColor(COLORS[0]); setNewIcon("🏢"); setShowAddPlace(true);
            }}>➕ הוסף מקום עבודה</button>
            <button style={{ ...S.btn, background:"#ef444420", color:"#ef4444",
              border:"1px solid #ef444430", marginTop:8 }}
              onClick={() => { if(window.confirm("למחוק את כל ההיסטוריה?")) { setSessions([]); showToast("🗑 נמחק"); } }}>
              🗑 מחק את כל ההיסטוריה
            </button>
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Heebo',sans-serif;direction:rtl}
        button{transition:all .15s;cursor:pointer}
        button:hover{filter:brightness(1.1);transform:scale(1.02)}
        button:active{transform:scale(.97)}
        select{outline:none}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#ffffff20;border-radius:2px}
      `}</style>
    </div>
  );
}

const S = {
  page:{ minHeight:"100vh", background:"linear-gradient(145deg,#080e1a 0%,#0f1e2e 50%,#080e1a 100%)",
    display:"flex", justifyContent:"center", padding:"20px 14px 60px", position:"relative",
    overflow:"hidden", fontFamily:"'Heebo',sans-serif", direction:"rtl" },
  blob1:{ position:"fixed", top:-100, right:-100, width:350, height:350, borderRadius:"50%",
    background:"radial-gradient(circle,#6366f130 0%,transparent 70%)", pointerEvents:"none" },
  blob2:{ position:"fixed", bottom:-80, left:-80, width:300, height:300, borderRadius:"50%",
    background:"radial-gradient(circle,#10b98125 0%,transparent 70%)", pointerEvents:"none" },
  container:{ width:"100%", maxWidth:460, display:"flex", flexDirection:"column", gap:14,
    animation:"fadeUp .5s ease" },
  header:{ textAlign:"center", paddingTop:4 },
  logoRow:{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, marginBottom:2 },
  logoText:{ fontSize:24, fontWeight:800, color:"#fff", letterSpacing:-0.5 },
  clockTime:{ fontSize:46, fontWeight:800, color:"#fff", letterSpacing:2, lineHeight:1.1,
    fontVariantNumeric:"tabular-nums" },
  clockDate:{ color:"#475569", fontSize:13, marginTop:2 },
  nav:{ display:"flex", gap:6, background:"#ffffff08", padding:5, borderRadius:14,
    border:"1px solid #ffffff0d" },
  navBtn:{ flex:1, padding:"9px 6px", borderRadius:10, border:"none", background:"transparent",
    color:"#64748b", fontSize:12, fontWeight:600 },
  navBtnActive:{ background:"#ffffff15", color:"#e2e8f0" },
  section:{ display:"flex", flexDirection:"column", gap:12 },
  timerCard:{ background:"#0f172a", border:"1px solid", borderRadius:18, padding:"20px 20px 16px",
    textAlign:"center" },
  timerDisplay:{ fontSize:42, fontWeight:800, color:"#fff", fontVariantNumeric:"tabular-nums",
    letterSpacing:2 },
  timerSub:{ color:"#475569", fontSize:12, marginTop:4 },
  placeCard:{ background:"#0f1a2e", border:"1px solid", borderRadius:16, overflow:"hidden" },
  placeHeader:{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px" },
  placeIcon:{ fontSize:28 },
  placeName:{ fontWeight:700, fontSize:15 },
  placeStat:{ color:"#475569", fontSize:12 },
  placeActions:{ display:"flex", gap:8, padding:"10px 14px 14px" },
  summaryBar:{ background:"#0f1a2e", border:"1px solid #ffffff10", borderRadius:14,
    padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-around" },
  summaryBarItem:{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 },
  summaryBarNum:{ color:"#e2e8f0", fontWeight:800, fontSize:18 },
  summaryBarLabel:{ color:"#475569", fontSize:11 },
  summaryBarDivider:{ width:1, height:30, background:"#ffffff10" },
  sessionCard:{ background:"#0f1a2e", borderRadius:14, padding:"12px 14px",
    borderRight:"3px solid", display:"flex", flexDirection:"column", gap:6 },
  sessionTop:{ display:"flex", justifyContent:"space-between", alignItems:"center" },
  sessionDate:{ color:"#475569", fontSize:12 },
  sessionRow:{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:13 },
  filterRow:{ display:"flex", gap:8 },
  select:{ flex:1, background:"#0f1a2e", border:"1px solid #ffffff15", borderRadius:10,
    color:"#e2e8f0", padding:"9px 12px", fontSize:13, fontFamily:"'Heebo',sans-serif" },
  settingsTitle:{ color:"#94a3b8", fontSize:12, fontWeight:700, letterSpacing:1, marginBottom:2 },
  settingRow:{ background:"#0f1a2e", borderRadius:12, padding:"12px 14px",
    display:"flex", alignItems:"center", gap:10, borderRight:"3px solid #6366f1" },
  empty:{ textAlign:"center", color:"#334155", padding:"40px 0", fontSize:15, lineHeight:2.2 },
  btn:{ padding:"12px 16px", borderRadius:12, border:"none", fontSize:14, fontWeight:700,
    display:"flex", alignItems:"center", justifyContent:"center", gap:7 },
  btnGreen:{ background:"linear-gradient(135deg,#10b981,#059669)", color:"#fff",
    boxShadow:"0 4px 14px #10b98135" },
  btnAmber:{ background:"linear-gradient(135deg,#f59e0b,#d97706)", color:"#fff" },
  btnRed:{ background:"linear-gradient(135deg,#ef4444,#dc2626)", color:"#fff" },
  iconActionBtn:{ background:"#ffffff0d", border:"1px solid #ffffff12", borderRadius:10,
    padding:"8px 10px", fontSize:16, color:"#e2e8f0" },
  delBtn:{ background:"transparent", border:"none", color:"#ef444460", fontSize:14,
    padding:"2px 6px", borderRadius:6 },
  toast:{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
    background:"#1e293b", border:"1px solid #ffffff20", color:"#e2e8f0",
    padding:"10px 20px", borderRadius:12, fontSize:14, fontWeight:600, zIndex:9999,
    animation:"toastIn .3s ease", whiteSpace:"nowrap", boxShadow:"0 8px 24px #00000060" },
  modalBg:{ position:"fixed", inset:0, background:"#00000085", backdropFilter:"blur(6px)",
    zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 },
  modal:{ background:"#0f1e2e", border:"1px solid #ffffff15", borderRadius:20,
    padding:"24px 20px", width:"100%", maxWidth:360, display:"flex", flexDirection:"column", gap:12 },
  modalTitle:{ color:"#e2e8f0", fontWeight:800, fontSize:18 },
  modalLabel:{ color:"#64748b", fontSize:12, fontWeight:600 },
  input:{ background:"#ffffff0d", border:"1px solid #ffffff15", borderRadius:10,
    color:"#e2e8f0", padding:"10px 14px", fontSize:14, fontFamily:"'Heebo',sans-serif",
    outline:"none", textAlign:"right" },
  iconGrid:{ display:"flex", flexWrap:"wrap", gap:6 },
  iconBtn:{ width:38, height:38, borderRadius:8, border:"none", fontSize:20, cursor:"pointer" },
  colorRow:{ display:"flex", gap:8, flexWrap:"wrap" },
  colorDot:{ width:28, height:28, borderRadius:"50%", cursor:"pointer" },
  summaryBox:{ background:"#ffffff08", borderRadius:12, padding:"12px 14px",
    display:"flex", flexDirection:"column", gap:8 },
  summaryRow2:{ display:"flex", justifyContent:"space-between", alignItems:"center" },
  summaryLabel2:{ color:"#64748b", fontSize:13 },
  summaryVal:{ color:"#e2e8f0", fontWeight:700, fontSize:15 },
  exportOptions:{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
  exportBtn2:{ background:"transparent", border:"1px solid", borderRadius:12,
    padding:"12px 10px", display:"flex", alignItems:"center", gap:10, cursor:"pointer",
    textAlign:"right" },
  exportIcon:{ fontSize:22 },
  exportBtnTitle:{ fontWeight:700, fontSize:13 },
  exportBtnSub:{ fontSize:11, opacity:0.7, marginTop:1 },

  // ── Loan ──
  loanForm:{ background:"#0f1e2e", border:"1px solid #ffffff12", borderRadius:16,
    padding:"16px 16px", display:"flex", flexDirection:"column", gap:12 },
  loanHint:{ color:"#64748b", fontSize:12, lineHeight:1.5 },
  formGrid:{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
  fLabel:{ display:"flex", flexDirection:"column", gap:5, color:"#94a3b8",
    fontSize:12, fontWeight:600 },
  checkRow:{ display:"flex", alignItems:"center", gap:8, color:"#cbd5e1",
    fontSize:13, cursor:"pointer" },
  loanHero:{ background:"linear-gradient(135deg,#101f36,#0f2a24)", border:"1px solid #10b98130",
    borderRadius:18, padding:"20px 18px", textAlign:"center" },
  loanHeroLabel:{ color:"#64748b", fontSize:13, marginBottom:4 },
  loanHeroVal:{ color:"#fff", fontSize:38, fontWeight:800, letterSpacing:1,
    fontVariantNumeric:"tabular-nums" },
  loanHeroSub:{ color:"#94a3b8", fontSize:13, marginTop:4 },
  loanDelta:{ fontSize:13, fontWeight:700, marginTop:10 },
  loanGrid:{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
  loanStat:{ background:"#0f1a2e", border:"1px solid #ffffff10", borderRadius:14,
    padding:"14px 12px", textAlign:"center" },
  loanStatVal:{ color:"#e2e8f0", fontWeight:800, fontSize:19, fontVariantNumeric:"tabular-nums" },
  loanStatLbl:{ color:"#475569", fontSize:11, marginTop:3 },
  loanCompare:{ background:"#ffffff08", border:"1px solid #ffffff10", borderRadius:12,
    padding:"12px 14px", fontSize:13, fontWeight:600, lineHeight:1.5 },
  ncGrid:{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
  tableWrap:{ overflowX:"auto", background:"#0f1a2e", border:"1px solid #ffffff10",
    borderRadius:12, WebkitOverflowScrolling:"touch" },
  table:{ width:"100%", borderCollapse:"collapse", fontSize:12, minWidth:420 },
  th:{ color:"#64748b", fontWeight:700, padding:"9px 8px", textAlign:"center",
    borderBottom:"1px solid #ffffff12", whiteSpace:"nowrap", position:"sticky", top:0,
    background:"#0f1a2e" },
  td:{ color:"#cbd5e1", padding:"7px 8px", textAlign:"center", whiteSpace:"nowrap",
    borderBottom:"1px solid #ffffff08", fontVariantNumeric:"tabular-nums" },
  trNow:{ background:"#10b98118" },
};
