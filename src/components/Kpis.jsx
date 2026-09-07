import { km, money, dateHe, days } from "../format.js";

function Kpi({ label, value, unit, note }) {
  return (
    <div className="card kpi">
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {note && <div className="n">{note}</div>}
    </div>
  );
}

export default function Kpis({ stats, forecast, costs, plan }) {
  return (
    <div className="kpis">
      <Kpi
        label="הטיפול הבא"
        value={dateHe(forecast.due_date)}
        note={
          forecast.due_km
            ? `${days(forecast.days_remaining)} · סביב ${km(forecast.due_km)} ק"מ`
            : days(forecast.days_remaining)
        }
      />
      <Kpi
        label="קצב נסיעה נוכחי"
        value={km(stats.km_per_year_recent)}
        unit={'ק"מ/שנה'}
        note={
          stats.km_per_year_lifetime
            ? `ממוצע כל התקופה: ${km(stats.km_per_year_lifetime)}`
            : null
        }
      />
      <Kpi
        label="מרווח טיפול אחרון"
        value={km(stats.recent_interval_km)}
        unit={'ק"מ'}
        note={`חציון היסטורי: ${km(stats.median_interval_km)} · תוכנית: ${km(plan.km)}`}
      />
      <Kpi
        label="עמידה בתוכנית"
        value={stats.adherence_pct == null ? "—" : `${stats.adherence_pct}%`}
        note={`${stats.service_count} טיפולים מתועדים מאז ${dateHe(stats.first_record).slice(3)}`}
      />
      <Kpi
        label="עלות לקילומטר"
        value={costs.per_km == null ? "—" : costs.per_km.toFixed(3)}
        unit="₪"
        note={
          costs.documented_visits
            ? `${costs.documented_visits} חשבוניות · ${money(costs.total)} סה"כ`
            : "אין חשבוניות"
        }
      />
      <Kpi
        label="עלות ממוצעת לטיפול"
        value={costs.average_per_visit == null ? "—" : km(Math.round(costs.average_per_visit))}
        unit="₪"
        note={costs.documented_visits ? "לפי הטיפולים במוסך הפרטי" : null}
      />
    </div>
  );
}
