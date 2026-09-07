import { useEffect, useState } from "react";
import "./styles.css";

import Alerts from "./components/Alerts.jsx";
import IntervalChart from "./components/IntervalChart.jsx";
import Kpis from "./components/Kpis.jsx";
import Timeline from "./components/Timeline.jsx";
import Wear from "./components/Wear.jsx";
import { km, dateHe } from "./format.js";

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}vehicle-data.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="wrap">
        <div className="card empty">
          לא ניתן לטעון את נתוני הרכב ({error}).
          <br />
          יש להריץ את הפייפליין: <code>python -m vehicle_maintenance.build</code>
        </div>
      </div>
    );
  }
  if (!data) return <div className="wrap"><div className="empty">טוען…</div></div>;

  const { vehicle, stats, forecast, costs, plan, alerts, wear, intervals, visits, warnings } = data;
  const odoNow = forecast.estimated_odometer_today ?? vehicle.current_odometer;

  return (
    <div className="wrap">
      <header className="head">
        <h1>
          {vehicle.make} {vehicle.model} {vehicle.year}
        </h1>
        <div className="sub">
          מס' רישוי <b>{vehicle.plate}</b>
          {vehicle.gearbox ? ` · תיבת הילוכים ${vehicle.gearbox}` : ""}
          {" · "}שגרת טיפולים מנותחת מ-{stats.total_visits} ביקורים מתועדים
        </div>

        <div className="odo">
          <div>
            <span className="k">מד אוץ אחרון מתועד</span>
            <span className="v">
              {km(vehicle.current_odometer)}{" "}
              <small>ק"מ · {dateHe(vehicle.odometer_as_of)}</small>
            </span>
          </div>
          <div>
            <span className="k">הערכה להיום</span>
            <span className="v">
              {km(odoNow)} <small>ק"מ · לפי קצב נסיעה נוכחי</small>
            </span>
          </div>
          <div>
            <span className="k">תוכנית יצרן</span>
            <span className="v">
              {km(plan.km)} <small>ק"מ / {plan.months} חודשים</small>
            </span>
          </div>
        </div>
      </header>

      <Alerts alerts={alerts} />

      <section>
        <h2>מדדים</h2>
        <Kpis stats={stats} forecast={forecast} costs={costs} plan={plan} />
      </section>

      <IntervalChart intervals={intervals} planKm={plan.km} />
      <Wear wear={wear} />
      <Timeline visits={visits} />

      <footer className="foot">
        <div>
          הנתונים נבנו מקבצי ה-PDF שבתיקייה <code>pipeline/data</code> ועודכנו לאחרונה
          ב-{dateHe(data.generated_at)}. להוספת מסמכים: הוסיפו קובץ ל-
          <code>pipeline/data/pdfs</code> והריצו{" "}
          <code>python -m vehicle_maintenance.build</code>.
        </div>
        {costs.note && <div style={{ marginTop: 6 }}>{costs.note}</div>}
        {warnings.length > 0 && (
          <>
            <div style={{ marginTop: 10 }}>מסמכים שלא נטענו:</div>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        )}
      </footer>
    </div>
  );
}
