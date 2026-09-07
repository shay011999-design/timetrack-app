import { useMemo, useState } from "react";
import { km } from "../format.js";

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v === "" || v == null ? null : Number(v));

// The file the pipeline reads. Building it here keeps git the single source of
// truth: the form produces the same record a person would write by hand, and
// the rebuild workflow picks it up from there.
function buildRecord(f) {
  const rec = { date: f.date, odometer: num(f.odometer), litres: num(f.litres) };
  if (num(f.pricePerLitre) != null) rec.price_per_litre = num(f.pricePerLitre);
  if (num(f.total) != null) rec.total = num(f.total);
  rec.full_tank = f.fullTank;
  if (num(f.kmSince) != null) rec.km_since_last_fill = num(f.kmSince);
  if (num(f.computer) != null) rec.computer_l_per_100km = num(f.computer);
  if (f.station.trim()) rec.station = f.station.trim();
  if (f.note.trim()) rec.notes = [f.note.trim()];
  return rec;
}

// Mirrors the pipeline's rule for which distance describes this tank.
// The odometer gap measures distance since the last *logged* fill; the trip
// computer measures distance since the last *actual* one, since it resets at
// every refuelling whether or not it was written down. They are only
// interchangeable when they agree.
const DISTANCE_AGREEMENT = 0.15;

function preview(f, prev, band) {
  const litres = num(f.litres);
  if (!litres) return null;

  const trip = num(f.kmSince);
  const odo = num(f.odometer);
  const gap =
    odo != null && prev?.odometer != null && odo > prev.odometer
      ? odo - prev.odometer
      : null;

  let dist = null;
  let basis = null;
  let gapNote = null;
  if (gap && trip) {
    if (Math.abs(gap - trip) <= DISTANCE_AGREEMENT * trip) {
      dist = gap;
      basis = "מהפרש מד האוץ";
    } else {
      dist = trip;
      basis = "לפי מחשב הדרך";
      gapNote =
        `מד האוץ מראה ${km(gap)} ק"מ מהתדלוק הרשום הקודם אבל מחשב הדרך מדווח ` +
        `${km(trip)} — יש תדלוקים שלא נרשמו ביניהם, והחישוב יסתמך על מחשב הדרך.`;
    }
  } else if (gap) {
    dist = gap;
    basis = "מהפרש מד האוץ";
  } else if (trip) {
    dist = trip;
    basis = "לפי מחשב הדרך";
  }
  if (!dist) return null;

  const value = (litres / dist) * 100;
  const [lo, hi] = band || [4, 20];
  return {
    value,
    dist,
    basis,
    gapNote,
    ok: f.fullTank && value >= lo && value <= hi,
    partial: !f.fullTank,
    lo,
    hi,
  };
}

export default function AddFillup({ fuel, repo, onClose }) {
  const prev = fuel?.fillups?.[fuel.fillups.length - 1] ?? null;

  const [f, setF] = useState({
    date: today(),
    odometer: "",
    litres: "",
    pricePerLitre: fuel?.price_per_litre ?? "",
    total: "",
    fullTank: true,
    kmSince: "",
    computer: "",
    station: "",
    note: "",
  });
  const set = (k) => (e) =>
    setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const record = useMemo(() => buildRecord(f), [f]);
  const json = useMemo(() => JSON.stringify(record, null, 2) + "\n", [record]);
  const pv = useMemo(
    () => preview(f, prev, fuel?.plausible_l_per_100km),
    [f, prev, fuel]
  );

  const filename = `${repo?.fuel_dir ?? "pipeline/data/fuel"}/${f.date}.json`;
  const commitUrl = repo
    ? `https://github.com/${repo.owner}/${repo.name}/new/${repo.branch}` +
      `?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(json)}`
    : null;

  const ready = f.date && num(f.litres) != null;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="sheet" role="dialog" aria-label="הוספת תדלוק">
      <div className="sheethead">
        <h3>הוספת תדלוק</h3>
        <button className="x" onClick={onClose} aria-label="סגירה">
          ✕
        </button>
      </div>

      <div className="fields">
        <label>
          <span>תאריך</span>
          <input type="date" value={f.date} onChange={set("date")} />
        </label>
        <label className="key">
          <span>
            מד אוץ <em>הכי חשוב</em>
          </span>
          <input
            type="number"
            inputMode="numeric"
            placeholder={prev?.odometer ? `אחרון: ${km(prev.odometer)}` : 'ק"מ'}
            value={f.odometer}
            onChange={set("odometer")}
          />
        </label>
        <label>
          <span>ליטרים</span>
          <input
            type="number"
            step="0.001"
            inputMode="decimal"
            value={f.litres}
            onChange={set("litres")}
          />
        </label>
        <label>
          <span>מחיר לליטר</span>
          <input
            type="number"
            step="0.001"
            inputMode="decimal"
            value={f.pricePerLitre}
            onChange={set("pricePerLitre")}
          />
        </label>
        <label>
          <span>
            ק"מ מאז התדלוק הקודם <em>ממחשב הדרך</em>
          </span>
          <input
            type="number"
            inputMode="numeric"
            value={f.kmSince}
            onChange={set("kmSince")}
          />
        </label>
        <label>
          <span>
            צריכה לפי מחשב הדרך <em>לא חובה</em>
          </span>
          <input
            type="number"
            step="0.1"
            inputMode="decimal"
            value={f.computer}
            onChange={set("computer")}
          />
        </label>
        <label className="wide">
          <span>
            תחנה <em>לא חובה</em>
          </span>
          <input type="text" value={f.station} onChange={set("station")} />
        </label>
        <label className="check wide">
          <input type="checkbox" checked={f.fullTank} onChange={set("fullTank")} />
          <span>
            מכל מלא
            <em>תדלוק חלקי נספר בהוצאה אבל לא מודד צריכה</em>
          </span>
        </label>
      </div>

      {pv && (
        <div className={`pv ${pv.ok && !pv.gapNote ? "ok" : "warn"}`}>
          <b>{pv.value.toFixed(2)} ל׳/100 ק"מ</b> על פני {km(pv.dist)} ק"מ ({pv.basis}).
          {pv.gapNote && <div className="pvnote">{pv.gapNote}</div>}
          {pv.partial && " מכל לא מלא — לא ייכנס למדידת הצריכה."}
          {!pv.partial && !pv.ok && (
            <>
              {" "}
              מחוץ לטווח הסביר ({pv.lo}–{pv.hi}) — בדוק את המספרים, או שחסר תדלוק
              ברצף. המכל הזה ייפסל בחישוב.
            </>
          )}
        </div>
      )}

      <pre className="jsonout">{json}</pre>

      <div className="sheetfoot">
        {commitUrl && (
          <a
            className={`btn primary ${ready ? "" : "off"}`}
            href={ready ? commitUrl : undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            שמירה ב-GitHub ←
          </a>
        )}
        <button className="btn" onClick={copy} disabled={!ready}>
          {copied ? "הועתק ✓" : "העתקת JSON"}
        </button>
      </div>
      <p className="sheetnote">
        הקישור פותח את הקובץ <code>{filename}</code> מוכן לקומיט. אחרי השמירה
        הנתונים נבנים מחדש אוטומטית והדשבורד מתעדכן.
      </p>
    </div>
  );
}
