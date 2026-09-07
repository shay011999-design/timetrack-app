export default function Alerts({ alerts }) {
  if (!alerts.length) return null;
  return (
    <section>
      <h2>מה דורש תשומת לב</h2>
      <div className="alerts">
        {alerts.map((a, i) => (
          <div className={`alert ${a.level}`} key={i}>
            <span className="dot" />
            <div>
              <div className="t">{a.title}</div>
              <div className="d">{a.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
