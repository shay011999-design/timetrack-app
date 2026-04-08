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
  const [activePlace, setActivePlace] = useState(null); // id of place being tracked
  const [checkIn, setCheckIn]   = useState(null);
  const [breakStart, setBreakStart] = useState(null);
  const [totalBreak, setTotalBreak] = useState(0);
  const [status, setStatus]     = useState("idle");
  const [elapsed, setElapsed]   = useState(0);
  const [view, setView]         = useState("home"); // home | history | settings
  const [filterPlace, setFilterPlace] = useState("all");
  const [editingPlace, setEditingPlace] = useState(null);
  const [newName, setNewName]   = useState("");
  const [newIcon, setNewIcon]   = useState("🏢");
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [showAddPlace, setShowAddPlace] = useState(false);
  const [toast, setToast]       = useState(null);
  const timerRef = useRef(null);

  // persist
  useEffect(() => { localStorage.setItem("wt_places", JSON.stringify(places)); }, [places]);
  useEffect(() => { localStorage.setItem("wt_sessions", JSON.stringify(sessions)); }, [sessions]);

  // clock
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  // timer
  useEffect(() => {
    clearInterval(timerRef.current);
    if (status === "working" && checkIn) {
      timerRef.current = setInterval(() => setElapsed(Date.now() - checkIn - totalBreak), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [status, checkIn, totalBreak]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleCheckIn = (placeId) => {
    setActivePlace(placeId);
    setCheckIn(Date.now());
    setTotalBreak(0);
    setElapsed(0);
    setBreakStart(null);
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
    const s = {
      id: now2, placeId: activePlace,
      date: fmtDate(new Date(checkIn)),
      checkIn: fmtTime(new Date(checkIn)),
      checkOut: fmtTime(new Date(now2)),
      breakMs: fb, workedMs: worked,
    };
    setSessions(p => [s, ...p]);
    setStatus("idle"); setActivePlace(null); setCheckIn(null);
    setBreakStart(null); setTotalBreak(0); setElapsed(0);
    showToast("🏁 משמרת נשמרה!");
  };

  const deleteSession = (id) => setSessions(p => p.filter(s => s.id !== id));

  // ── Export ───────────────────────────────────────────────────────────────────
  const buildText = (placeId) => {
    const pl = places.find(p => p.id === placeId);
    const list = sessions.filter(s => s.placeId === placeId);
    if (!list.length) return null;
    let txt = `${pl.icon} דוח שעות — ${pl.name}\n`;
    txt += `─────────────────────\n`;
    list.forEach(s => {
      txt += `📅 ${s.date}  ⏰ ${s.checkIn}–${s.checkOut}  ✅ ${fmtDurShort(s.workedMs)}\n`;
    });
    const total = list.reduce((a, s) => a + s.workedMs, 0);
    txt += `─────────────────────\nסה"כ: ${fmtDurShort(total)}`;
    return txt;
  };

  const shareWhatsApp = (placeId) => {
    const txt = buildText(placeId);
    if (!txt) { showToast("אין נתונים לשליחה"); return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, "_blank");
  };

  const shareEmail = (placeId) => {
    const pl = places.find(p => p.id === placeId);
    const txt = buildText(placeId);
    if (!txt) { showToast("אין נתונים לשליחה"); return; }
    const sub = `דוח שעות — ${pl.name}`;
    window.open(`mailto:?subject=${encodeURIComponent(sub)}&body=${encodeURIComponent(txt)}`, "_blank");
  };

  // ── Places management ────────────────────────────────────────────────────────
  const addPlace = () => {
    if (!newName.trim()) return;
    setPlaces(p => [...p, { id: Date.now(), name: newName.trim(), color: newColor, icon: newIcon }]);
    setNewName(""); setShowAddPlace(false); showToast("✅ מקום עבודה נוסף");
  };

  const saveEditPlace = () => {
    setPlaces(p => p.map(pl => pl.id === editingPlace.id ? { ...pl, name: newName || pl.name, color: newColor, icon: newIcon } : pl));
    setEditingPlace(null); showToast("✅ נשמר");
  };

  const deletePlace = (id) => {
    if (activePlace === id) { showToast("לא ניתן למחוק מקום פעיל"); return; }
    setPlaces(p => p.filter(pl => pl.id !== id));
    setSessions(p => p.filter(s => s.placeId !== id));
    showToast("🗑 נמחק");
  };

  // ── Stats ────────────────────────────────────────────────────────────────────
  const statsFor = (placeId) => {
    const list = sessions.filter(s => s.placeId === placeId);
    return { count: list.length, total: list.reduce((a, s) => a + s.workedMs, 0) };
  };

  const filteredSessions = filterPlace === "all" ? sessions : sessions.filter(s => s.placeId === Number(filterPlace));
  const activePlaceObj = places.find(p => p.id === activePlace);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <div style={S.blob1}/><div style={S.blob2}/>

      {/* Toast */}
      {toast && <div style={S.toast}>{toast}</div>}

      {/* Modal: edit/add place */}
      {(showAddPlace || editingPlace) && (
        <div style={S.modalBg} onClick={() => { setShowAddPlace(false); setEditingPlace(null); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalTitle}>{editingPlace ? "✏️ עריכת מקום" : "➕ מקום עבודה חדש"}</div>
            <input
              style={S.input} placeholder="שם מקום העבודה"
              value={newName} onChange={e => setNewName(e.target.value)}
            />
            <div style={S.modalLabel}>אייקון</div>
            <div style={S.iconGrid}>
              {ICONS.map(ic => (
                <button key={ic} onClick={() => setNewIcon(ic)}
                  style={{ ...S.iconBtn, background: newIcon === ic ? "#ffffff25" : "transparent", border: newIcon === ic ? "2px solid #fff" : "2px solid transparent" }}>
                  {ic}
                </button>
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
              <button style={{ ...S.btn, background:"#ffffff15", color:"#94a3b8", flex:1 }} onClick={() => { setShowAddPlace(false); setEditingPlace(null); }}>ביטול</button>
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
          {[["home","🏠 ראשי"],["history","📋 היסטוריה"],["settings","⚙️ הגדרות"]].map(([v,l]) => (
            <button key={v} onClick={() => setView(v)}
              style={{ ...S.navBtn, ...(view===v ? S.navBtnActive : {}) }}>{l}</button>
          ))}
        </div>

        {/* ── HOME ── */}
        {view === "home" && (
          <div style={S.section}>
            {/* Active timer */}
            {status !== "idle" && activePlaceObj && (
              <div style={{ ...S.timerCard, borderColor: activePlaceObj.color + "50", boxShadow:`0 0 24px ${activePlaceObj.color}25` }}>
                <div style={{ color: activePlaceObj.color, fontWeight:700, fontSize:14, marginBottom:4 }}>
                  {activePlaceObj.icon} {activePlaceObj.name}
                </div>
                <div style={S.timerDisplay}>{fmtDur(elapsed)}</div>
                <div style={S.timerSub}>
                  {status === "working" ? "🟢 בעבודה" : "🟡 הפסקה"} · כניסה {fmtTime(new Date(checkIn))}
                </div>
                <div style={{ display:"flex", gap:10, marginTop:14 }}>
                  <button style={{ ...S.btn, ...(status==="break"?S.btnGreen:S.btnAmber), flex:1 }} onClick={handleBreak}>
                    {status==="break" ? "▶ חזור לעבודה" : "⏸ הפסקה"}
                  </button>
                  <button style={{ ...S.btn, ...S.btnRed, flex:1 }} onClick={handleCheckOut}>🔴 סיום</button>
                </div>
              </div>
            )}

            {/* Places cards */}
            <div style={S.placesGrid}>
              {places.map(pl => {
                const st = statsFor(pl.id);
                const isActive = activePlace === pl.id;
                return (
                  <div key={pl.id} style={{ ...S.placeCard, borderColor: pl.color + "40", opacity: (status!=="idle" && !isActive) ? 0.45 : 1 }}>
                    <div style={{ ...S.placeHeader, background: pl.color + "18" }}>
                      <span style={S.placeIcon}>{pl.icon}</span>
                      <div>
                        <div style={{ ...S.placeName, color: pl.color }}>{pl.name}</div>
                        <div style={S.placeStat}>{st.count} משמרות · {fmtDurShort(st.total)}</div>
                      </div>
                    </div>
                    <div style={S.placeActions}>
                      {status === "idle" && (
                        <button style={{ ...S.btn, background: pl.color, color:"#fff", flex:1, boxShadow:`0 4px 14px ${pl.color}45` }}
                          onClick={() => handleCheckIn(pl.id)}>🟢 התחל</button>
                      )}
                      <button style={{ ...S.iconActionBtn }} onClick={() => shareWhatsApp(pl.id)} title="שלח בוואטסאפ">📲</button>
                      <button style={{ ...S.iconActionBtn }} onClick={() => shareEmail(pl.id)} title="שלח במייל">📧</button>
                    </div>
                  </div>
                );
              })}
            </div>
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
            {filteredSessions.length === 0 ? (
              <div style={S.empty}>📭<br/>אין משמרות עדיין</div>
            ) : filteredSessions.map(s => {
              const pl = places.find(p => p.id === s.placeId) || { name:"?", color:"#64748b", icon:"❓" };
              return (
                <div key={s.id} style={{ ...S.sessionCard, borderRightColor: pl.color }}>
                  <div style={S.sessionTop}>
                    <span style={{ color: pl.color, fontWeight:700 }}>{pl.icon} {pl.name}</span>
                    <span style={S.sessionDate}>{s.date}</span>
                  </div>
                  <div style={S.sessionRow}>
                    <span>⏰ {s.checkIn} – {s.checkOut}</span>
                    <span style={{ color:"#10b981", fontWeight:700 }}>✅ {fmtDurShort(s.workedMs)}</span>
                  </div>
                  <div style={S.sessionRow}>
                    <span style={{ color:"#64748b", fontSize:12 }}>הפסקה: {fmtDurShort(s.breakMs)}</span>
                    <button onClick={() => deleteSession(s.id)} style={S.delBtn}>🗑</button>
                  </div>
                </div>
              );
            })}
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
            <button style={{ ...S.btn, background:"#ef444420", color:"#ef4444", border:"1px solid #ef444430", marginTop:8 }}
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
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#ffffff20;border-radius:2px}
      `}</style>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const S = {
  page:{ minHeight:"100vh", background:"linear-gradient(145deg,#080e1a 0%,#0f1e2e 50%,#080e1a 100%)",
    display:"flex", justifyContent:"center", padding:"20px 14px 60px", position:"relative", overflow:"hidden",
    fontFamily:"'Heebo',sans-serif", direction:"rtl" },
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
  placesGrid:{ display:"flex", flexDirection:"column", gap:10 },
  placeCard:{ background:"#0f1a2e", border:"1px solid", borderRadius:16, overflow:"hidden" },
  placeHeader:{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px" },
  placeIcon:{ fontSize:28 },
  placeName:{ fontWeight:700, fontSize:15 },
  placeStat:{ color:"#475569", fontSize:12 },
  placeActions:{ display:"flex", gap:8, padding:"10px 14px 14px" },
  sessionCard:{ background:"#0f1a2e", borderRadius:14, padding:"12px 14px",
    borderRight:"3px solid", display:"flex", flexDirection:"column", gap:6 },
  sessionTop:{ display:"flex", justifyContent:"space-between", alignItems:"center" },
  sessionDate:{ color:"#475569", fontSize:12 },
  sessionRow:{ display:"flex", justifyContent:"space-between", alignItems:"center",
    color:"#94a3b8", fontSize:13 },
  filterRow:{ display:"flex", gap:8 },
  select:{ flex:1, background:"#0f1a2e", border:"1px solid #ffffff15", borderRadius:10,
    color:"#e2e8f0", padding:"9px 12px", fontSize:13, fontFamily:"'Heebo',sans-serif" },
  settingsTitle:{ color:"#94a3b8", fontSize:12, fontWeight:700, textTransform:"uppercase",
    letterSpacing:1, marginBottom:2 },
  settingRow:{ background:"#0f1a2e", borderRadius:12, padding:"12px 14px",
    display:"flex", alignItems:"center", gap:10, borderRight:"3px solid #6366f1" },
  empty:{ textAlign:"center", color:"#334155", padding:"40px 0", fontSize:15, lineHeight:2 },
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
  modalBg:{ position:"fixed", inset:0, background:"#00000080", backdropFilter:"blur(6px)",
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
  colorDot:{ width:28, height:28, borderRadius:"50%", cursor:"pointer", border:"3px solid transparent" },
};
