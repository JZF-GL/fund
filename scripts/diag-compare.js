// 对比系统已落盘的每日估值 vs 真实净值（% 与净值两种口径）
(async () => {
  const est = await (await fetch("http://127.0.0.1:5173/api/daily-estimates")).json();
  const hist = await (await fetch("http://127.0.0.1:5173/api/history")).json();

  for (const id of ["ai", "nev"]) {
    const pts = hist.funds[id].points;
    const byDate = new Map();
    for (const p of pts) {
      const d = new Date(p.ts);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      byDate.set(k, p);
    }
    const rows = [];
    for (const [date, day] of Object.entries(est.days)) {
      const f = day.funds && day.funds[id];
      const real = byDate.get(date);
      if (!f || !real) continue;
      if (date < "2026-10-01") continue;
      const sysPct = f.pct;
      const realPct = real.dailyPct;
      const absErr = Math.abs(sysPct - realPct);
      const relErr = realPct !== 0 ? (absErr / Math.abs(realPct)) * 100 : null;
      const navErr = f.estNav != null ? Math.abs(f.estNav - real.nav) : null;
      rows.push({ date, sysPct, realPct, absErr, relErr, navErr });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    console.log(`\n=== ${id} ===`);
    console.log("日期        系统%   真实%   绝对差(pp)  相对误差%  净值差");
    let sumAbs = 0, sumRel = 0, cnt = 0;
    for (const r of rows) {
      sumAbs += r.absErr;
      if (r.relErr != null) sumRel += r.relErr;
      cnt++;
      console.log(
        `${r.date}  ${r.sysPct.toFixed(2).padStart(6)}  ${r.realPct.toFixed(2).padStart(6)}  ${r.absErr.toFixed(2).padStart(8)}  ${(r.relErr == null ? "--" : r.relErr.toFixed(0)).padStart(8)}  ${r.navErr == null ? "--" : r.navErr.toFixed(4)}`
      );
    }
    if (cnt) {
      console.log(`平均：绝对差 ${(sumAbs / cnt).toFixed(3)}pp，相对误差 ${(sumRel / cnt).toFixed(1)}%  (n=${cnt})`);
    }
  }
})().catch((e) => console.error("ERR", e.message));
