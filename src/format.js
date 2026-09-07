// Shared Hebrew/RTL formatting helpers.

export const km = (n) =>
  n == null ? "—" : Number(n).toLocaleString("he-IL");

export const money = (n) =>
  n == null ? "—" : `${Number(n).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;

export const dateHe = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

export const monthHe = (iso) => {
  if (!iso) return "—";
  const [y, m] = iso.split("-");
  return `${m}/${y.slice(2)}`;
};

// "בעוד 57 ימים" / "לפני 12 ימים" — days is signed, positive meaning future.
export const days = (n) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  const unit = a === 1 ? "יום" : "ימים";
  if (n === 0) return "היום";
  return n > 0 ? `בעוד ${a} ${unit}` : `לפני ${a} ${unit}`;
};

export const SYSTEM_LABELS = {
  engine: "מנוע",
  brakes: "בלמים",
  tires: "צמיגים",
  timing: "תזמון",
  fluids: "נוזלים",
  general: "כללי",
  labor: "עבודה",
};

export const KIND_LABELS = {
  service: "טיפול",
  repair: "תיקון",
  inspection: "מבחן רישוי",
};
