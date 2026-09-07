import { useState } from "react";
import UploadDoc from "./UploadDoc.jsx";
import { km, money, dateHe, SYSTEM_LABELS, KIND_LABELS } from "../format.js";

function summarise(visit) {
  if (visit.plan_label) return `טיפול ${visit.plan_label}`;
  const first = visit.jobs[0]?.description;
  if (first) return first;
  return KIND_LABELS[visit.kind] ?? visit.kind;
}

function Visit({ visit }) {
  const [open, setOpen] = useState(false);
  const hasDetail = visit.jobs.length || visit.parts.length || visit.notes.length;

  return (
    <div className={`card visit ${open ? "open" : ""}`}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chev">{hasDetail ? "▶" : ""}</span>
        <span className="date">{dateHe(visit.date)}</span>
        <span className="odo2">{visit.odometer ? km(visit.odometer) : "—"}</span>
        <span className={`tag ${visit.kind}`}>{KIND_LABELS[visit.kind] ?? visit.kind}</span>
        <span className="title">{summarise(visit)}</span>
        {visit.total != null && <span className="money">{money(visit.total)}</span>}
      </button>

      {open && hasDetail && (
        <div className="detail">
          {visit.jobs.length > 0 && (
            <>
              <h4>עבודות</h4>
              <ul>
                {visit.jobs.map((j, i) => (
                  <li key={i}>
                    {j.description}
                    {j.system !== "general" && (
                      <span className="sys">· {SYSTEM_LABELS[j.system] ?? j.system}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {visit.parts.length > 0 && (
            <>
              <h4>חלפים</h4>
              <table className="parts">
                <tbody>
                  {visit.parts.map((p, i) => (
                    <tr key={i}>
                      <td>
                        {p.name}
                        <span className="sys"> · {SYSTEM_LABELS[p.system] ?? p.system}</span>
                      </td>
                      <td>{money(p.total)}</td>
                    </tr>
                  ))}
                  {visit.labor_total != null && (
                    <tr>
                      <td>עבודה</td>
                      <td>{money(visit.labor_total)}</td>
                    </tr>
                  )}
                  {visit.total != null && (
                    <tr>
                      <td>
                        סה"כ לתשלום
                        {visit.vat_rate ? ` (כולל מע"מ ${visit.vat_rate}%)` : ""}
                      </td>
                      <td>{money(visit.total)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}

          {visit.notes.map((n, i) => (
            <div className="note" key={i}>
              {n}
            </div>
          ))}

          <div className="src">
            {visit.provider ? `${visit.provider} · ` : ""}
            {visit.invoice_no ? `חשבונית ${visit.invoice_no} · ` : ""}
            {visit.document}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Timeline({ visits, repo }) {
  // Newest first: the recent history is what gets checked.
  const ordered = [...visits].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section>
      <h2>
        היסטוריית ביקורים ({visits.length})
        <UploadDoc
          repo={repo}
          dir={repo?.docs_dir ?? "pipeline/data/pdfs"}
          label="העלאת חשבונית"
          hint="חשבונית מוסך או דו״ח טיפולים; מסמך עם שכבת טקסט נקרא אוטומטית"
        />
      </h2>
      <div className="timeline">
        {ordered.map((v, i) => (
          <Visit visit={v} key={`${v.date}-${i}`} />
        ))}
      </div>
    </section>
  );
}
