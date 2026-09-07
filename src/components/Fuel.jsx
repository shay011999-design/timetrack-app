import { useState } from "react";
import AddFillup from "./AddFillup.jsx";
import UploadDoc from "./UploadDoc.jsx";
import { km, money } from "../format.js";

const L = (n, digits = 2) =>
  n == null ? "—" : Number(n).toLocaleString("he-IL", { maximumFractionDigits: digits });

// Fuel is usually the largest running cost, so the split against servicing is
// the point of this section — and the basis badge says whether the fuel half is
// measured from receipts or projected from mileage.
export default function Fuel({ fuel, running, repo }) {
  const [adding, setAdding] = useState(false);
  if (!fuel) return null;
  const measured = fuel.basis === "measured";

  return (
    <section>
      <h2>
        דלק ועלות אחזקה
        <span className={`basis ${fuel.low_confidence ? "provisional" : fuel.basis}`}>
          {!measured
            ? "אומדן"
            : fuel.tanks_measured === 1
              ? "נמדד ממיכל אחד — ארעי"
              : `נמדד מ-${fuel.tanks_measured} מיכלים`}
        </span>
        <button className="addbtn" onClick={() => setAdding((v) => !v)}>
          {adding ? "ביטול" : "+ תדלוק"}
        </button>
        <UploadDoc
          repo={repo}
          dir={repo?.fuel_dir ?? "pipeline/data/fuel"}
          label="העלאת קבלה"
          hint="אפשר לגרור כמה קבצים יחד; קבלה עם שכבת טקסט נקראת אוטומטית"
        />
      </h2>

      {adding && (
        <AddFillup fuel={fuel} repo={repo} onClose={() => setAdding(false)} />
      )}

      <div className="kpis">
        <div className="card kpi">
          <div className="k">עלות דלק לחודש</div>
          <div className="v">
            {km(fuel.cost_per_month)}
            <span className="unit">₪</span>
          </div>
          <div className="n">
            {fuel.cost_per_year ? `${km(fuel.cost_per_year)} ₪ לשנה` : null}
            {fuel.litres_per_year ? ` · ${km(fuel.litres_per_year)} ליטר` : null}
          </div>
        </div>

        <div className="card kpi">
          <div className="k">צריכה</div>
          <div className="v">
            {L(fuel.consumption_l_per_100km)}
            <span className="unit">ל׳/100 ק"מ</span>
          </div>
          <div className="n">
            {fuel.consumption_km_per_litre
              ? `${L(fuel.consumption_km_per_litre, 1)} ק"מ לליטר`
              : null}
            {measured && fuel.measured_km ? ` · על פני ${km(fuel.measured_km)} ק"מ` : null}
            {fuel.computer_l_per_100km
              ? ` · מחשב הדרך: ${L(fuel.computer_l_per_100km)}`
              : null}
          </div>
        </div>

        <div className="card kpi">
          <div className="k">מחיר לליטר</div>
          <div className="v">
            {L(fuel.price_per_litre)}
            <span className="unit">₪ · {fuel.fuel_type}</span>
          </div>
          <div className="n">
            {fuel.cost_per_km ? `${L(fuel.cost_per_km, 3)} ₪ לק"מ בדלק` : null}
          </div>
        </div>
      </div>

      {running?.total_per_km != null && (
        <div className="card split">
          <div className="splittop">
            <span>
              סה"כ אחזקה: <b>{L(running.total_per_km, 3)} ₪ לק"מ</b>
              {running.total_per_month ? ` · כ-${km(running.total_per_month)} ₪ לחודש` : ""}
            </span>
            <span className="pct">{running.fuel_share_pct}% דלק</span>
          </div>
          <div className="splitbar">
            <div className="f" style={{ width: `${running.fuel_share_pct}%` }} />
            <div className="m" style={{ width: `${100 - running.fuel_share_pct}%` }} />
          </div>
          <div className="splitlegend">
            <span>
              <i className="f" />
              דלק · {L(running.fuel_per_km, 3)} ₪/ק"מ
            </span>
            <span>
              <i className="m" />
              טיפולים · {L(running.maintenance_per_km, 3)} ₪/ק"מ
            </span>
          </div>
        </div>
      )}

      {fuel.fillups?.length > 0 && (
        <div className="card legs">
          <table>
            <thead>
              <tr>
                <th>תדלוק</th>
                <th>מד אוץ</th>
                <th>ליטרים</th>
                <th>₪/ל׳</th>
                <th>עלות</th>
                <th>ל׳/100</th>
              </tr>
            </thead>
            <tbody>
              {[...fuel.fillups].reverse().map((f, i) => (
                <tr key={i} className={f.odometer == null ? "noodo" : ""}>
                  <td>
                    {f.date.split("-").reverse().join("/")}
                    {f.station ? <span className="sub">{f.station}</span> : null}
                  </td>
                  <td>
                    {f.odometer == null ? (
                      <span className="missing" title="לא נרשם — הקבלה לא מדפיסה מד אוץ">
                        חסר
                      </span>
                    ) : (
                      km(f.odometer)
                    )}
                  </td>
                  <td>{L(f.litres)}</td>
                  <td>{L(f.price_per_litre)}</td>
                  <td>{money(f.total)}</td>
                  <td>
                    {f.l_per_100km ? L(f.l_per_100km) : <span className="missing">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fuel.warnings?.length > 0 && (
        <div className="card fuelwarn">
          {fuel.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div className="basisnote">
        {measured ? (
          <>
            {fuel.low_confidence ? (
              <>
                <b>מבוסס על מיכל אחד בלבד.</b> מספיק כדי להחליף את הניחוש, אבל לא
                כדי לקבוע הרגל — תדלוק שלא היה מלא לגמרי, או שבוע נהיגה חריג, מזיזים
                את המספר הרבה. אחרי שניים-שלושה מיכלים נוספים זה יתייצב.{" "}
              </>
            ) : null}
            הצריכה נמדדת מהליטרים בפועל חלקי המרחק
            {fuel.legs?.some((l) => l.basis === "trip")
              ? " שנקרא ממחשב הדרך"
              : " שבין תדלוקי מכל מלא"}
            .
            {fuel.computer_vs_pump_pct != null
              ? ` מחשב הדרך מדווח ${L(fuel.computer_l_per_100km)} — ${
                  fuel.computer_vs_pump_pct > 0 ? "גבוה" : "נמוך"
                } ב-${L(Math.abs(fuel.computer_vs_pump_pct), 1)}% מהמדידה במשאבה.`
              : ""}
            {fuel.recorded_spend
              ? ` הוצאה מתועדת: ${money(fuel.recorded_spend)}.`
              : ""}
          </>
        ) : (
          <>
            אין עדיין רישומי תדלוק, ולכן זהו <b>אומדן</b> ולא מדידה:{" "}
            {km(fuel.km_per_year)} ק"מ בשנה × {L(fuel.consumption_l_per_100km)} ל׳/100 ק"מ ×{" "}
            {L(fuel.price_per_litre)} ₪. {fuel.consumption_source}
          </>
        )}
        {fuel.price_source ? ` ${fuel.price_source}` : ""}
      </div>
    </section>
  );
}
