export function StatusBadge({ passed }) {
  if (passed === null || passed === undefined) {
    return (
      <span className="inline-flex items-center rounded-full border border-provo-border bg-provo-surface px-3 py-1 text-xs font-medium text-provo-muted">
        Pending
      </span>
    );
  }

  return passed ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-provo-pass/15 px-3 py-1 text-xs font-semibold text-provo-pass ring-1 ring-inset ring-provo-pass/40">
      <span className="h-1.5 w-1.5 rounded-full bg-provo-pass" />
      Verified — Paid
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-provo-fail/15 px-3 py-1 text-xs font-semibold text-provo-fail ring-1 ring-inset ring-provo-fail/40">
      <span className="h-1.5 w-1.5 rounded-full bg-provo-fail" />
      Failed — Slashed
    </span>
  );
}

export function ReputationBadge({ scoreBps }) {
  const pct = Number(scoreBps) / 100;
  const tone = pct >= 90 ? "text-provo-pass ring-provo-pass/40 bg-provo-pass/10" : pct >= 60 ? "text-amber-400 ring-amber-400/40 bg-amber-400/10" : "text-provo-fail ring-provo-fail/40 bg-provo-fail/10";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone}`}>
      {pct.toFixed(0)}% reputation
    </span>
  );
}
