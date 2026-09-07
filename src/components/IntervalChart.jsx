import { km, monthHe } from "../format.js";

// Bars are the km between consecutive services; the dashed line is the
// manufacturer's plan, so overshoot is visible at a glance.
export default function IntervalChart({ intervals, planKm }) {
  if (!intervals.length) return null;
  const max = Math.max(planKm, ...intervals.map((i) => i.km)) * 1.12;
  const planPct = (planKm / max) * 100;

  return (
    <section>
      <h2>מרווחים בין טיפולים</h2>
      <div className="card chart">
        <div className="bars">
          <div className="planline" style={{ bottom: `${planPct}%` }}>
            <span>תוכנית {km(planKm)}</span>
          </div>
          {intervals.map((i, idx) => (
            <div
              className={`bar ${i.over_plan ? "over" : ""}`}
              key={idx}
              title={`${monthHe(i.from_date)} → ${monthHe(i.to_date)}\n${km(i.km)} ק"מ ב-${i.days} ימים`}
            >
              <span className="val">{Math.round(i.km / 1000)}k</span>
              <div className="fill" style={{ height: `${(i.km / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="axis">
          {intervals.map((i, idx) => (
            <span key={idx}>{monthHe(i.to_date)}</span>
          ))}
        </div>
        <div className="legend">
          <span>
            <i style={{ background: "var(--accent)" }} />
            בתוך התוכנית
          </span>
          <span>
            <i style={{ background: "var(--soon)" }} />
            חריגה מהתוכנית
          </span>
        </div>
      </div>
    </section>
  );
}
