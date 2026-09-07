import { km, money } from "../format.js";

const L = (n, digits = 2) =>
  n == null ? "—" : Number(n).toLocaleString("he-IL", { maximumFractionDigits: digits });

// Fuel is usually the largest running cost, so the split against servicing is
// the point of this section — and the basis badge says whether the fuel half is
// measured from receipts or projected from mileage.
export default function Fuel({ fuel, running }) {
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
      </h2>

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

      {measured && fuel.legs?.length > 0 && (
        <div className="card legs">
          <table>
            <thead>
              <tr>
                <th>תדלוק</th>
                <th>מרחק</th>
                <th>ליטרים</th>
                <th>ל׳/100</th>
                <th>עלות</th>
              </tr>
            </thead>
            <tbody>
              {fuel.legs.map((l, i) => (
                <tr key={i}>
                  <td>{l.to_date.split("-").reverse().join("/")}</td>
                  <td>{km(l.km)}</td>
                  <td>{L(l.litres)}</td>
                  <td>{L(l.l_per_100km)}</td>
                  <td>{money(l.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
