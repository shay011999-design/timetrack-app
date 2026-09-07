import { km, dateHe } from "../format.js";

// How far through its replacement interval each long-life item is.
export default function Wear({ wear }) {
  const rows = wear.filter((w) => w.last_date);
  if (!rows.length) return null;

  return (
    <section>
      <h2>מצב פריטי בלאי</h2>
      <div className="wear">
        {rows.map((w) => {
          const used = w.km_since != null ? w.km_since / w.interval_km : null;
          const pct = used == null ? 0 : Math.min(100, used * 100);
          const state = used == null ? "" : used >= 1 ? "over" : used >= 0.75 ? "warn" : "";
          return (
            <div className="card wearrow" key={w.system}>
              <div className="top">
                <span className="name">{w.label}</span>
                <span className="last">
                  אחרון: {dateHe(w.last_date)}
                  {w.last_odometer ? ` · ${km(w.last_odometer)} ק"מ` : ""}
                </span>
              </div>
              <div className={`track ${state}`}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="foot">
                <span>
                  {w.km_since != null ? `${km(w.km_since)} ק"מ מאז` : `${w.months_since} חודשים מאז`}
                </span>
                <span>
                  {w.km_to_go != null
                    ? w.km_to_go > 0
                      ? `עוד ${km(w.km_to_go)} ק"מ`
                      : `חריגה של ${km(-w.km_to_go)} ק"מ`
                    : `מרווח ${km(w.interval_km)} ק"מ`}
                </span>
              </div>
              {w.last_description && (
                <div className="foot" style={{ fontFamily: "inherit" }}>
                  <span>{w.last_description}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
