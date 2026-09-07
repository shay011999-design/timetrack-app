import UploadDoc from "./UploadDoc.jsx";

const STATUS = {
  parsed: { label: "נקרא", cls: "ok" },
  transcribed: { label: "תומלל", cls: "ok" },
  needs_transcription: { label: "סריקה — ממתין לתמלול", cls: "warn" },
  unrecognised: { label: "פורמט לא מוכר", cls: "warn" },
};

// After dropping a batch in, the question is not "what failed" but "what
// happened to each of the files I just added" — so every document is listed,
// the ones that worked included, and the outstanding ones are counted up front.
export default function Documents({ documents, repo }) {
  if (!documents?.length) return null;

  const pending = documents.filter(
    (d) => d.status === "needs_transcription" || d.status === "unrecognised"
  );

  return (
    <section>
      <h2>
        מסמכי מקור ({documents.length})
        <UploadDoc
          repo={repo}
          dir={repo?.docs_dir ?? "pipeline/data/pdfs"}
          label="העלאת חשבוניות"
          hint="אפשר לגרור כמה קבצים יחד"
        />
        <UploadDoc
          repo={repo}
          dir={repo?.fuel_dir ?? "pipeline/data/fuel"}
          label="העלאת קבלות"
          hint="אפשר לגרור כמה קבצים יחד"
        />
      </h2>

      {pending.length > 0 && (
        <div className="alert soon" style={{ marginBottom: 10 }}>
          <span className="dot" />
          <div>
            <div className="t">
              {pending.length} מסמכים ממתינים לטיפול
            </div>
            <div className="d">
              סריקות ללא שכבת טקסט אינן נקראות אוטומטית. הריצו{" "}
              <code>python -m vehicle_maintenance.ocr &lt;תיקייה&gt; --kind
              service --all --write</code>{" "}
              כדי לעבד את כולן בבת אחת, או הזינו ידנית.
            </div>
          </div>
        </div>
      )}

      <div className="docs card">
        <table>
          <thead>
            <tr>
              <th>קובץ</th>
              <th>סוג</th>
              <th>רשומות</th>
              <th>מצב</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((d, i) => {
              const s = STATUS[d.status] ?? { label: d.status, cls: "" };
              return (
                <tr key={i}>
                  <td className="fname">{d.name}</td>
                  <td>{d.kind === "fuel" ? "דלק" : "טיפולים"}</td>
                  <td>{d.records || "—"}</td>
                  <td>
                    <span className={`dstat ${s.cls}`}>{s.label}</span>
                    {d.parser && <span className="via">{d.parser}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
