const COUNTDOWN_MS = 500;
const FALLBACK_MS = 3 * 60 * 1000;

const FUNDS = [
  {
    id: "ai",
    name: "易方达人工智能ETF联接C",
    code: "012734",
    refName: "人工智能ETF易方达 159819",
    colorVar: "--line-1",
    lastNav: 2.0737,
    lastNavDate: "2026-09-22",
  },
  {
    id: "nev",
    name: "天弘中证新能源汽车指数C",
    code: "011513",
    refName: "中证新能源汽车指数 930997",
    colorVar: "--line-2",
    lastNav: 1.0172,
    lastNavDate: "2026-09-22",
  },
];

function cssVar(name, fallback = "#6b4c9a") {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function fundColor(fund) {
  return cssVar(fund.colorVar || "--line-1");
}

const state = {
  points: [],
  updatedAt: null,
  chart: null,
  countdownTimer: null,
  fallbackTimer: null,
  holdingsTimer: null,
  holdingsLive: null,
  nextAt: Date.now() + FALLBACK_MS,
  status: null,
  dayKey: dayKeyOf(Date.now()),
  es: null,
  connected: false,
  lastPushAt: null,
  hist: null,
  histRange: 30,
  histChartAi: null,
  histChartNev: null,
  activeFundId: FUNDS[0].id,
  dailyEstimates: null,
  compareChart: null,
  compareRange: 30,
  compareMode: "nav",
};

function isMarketView() {
  return false;
}

function activeFund() {
  return FUNDS.find((f) => f.id === state.activeFundId) || FUNDS[0];
}

function setActiveFund(id) {
  if (!FUNDS.some((f) => f.id === id) || id === state.activeFundId) return;
  state.activeFundId = id;
  renderFundTabs();
  applyViewVisibility();
  renderAll();
  updateHistoryCharts();
  if (state.holdingsLive) renderHoldings(state.holdingsLive);
  updateCompareChart();
  requestAnimationFrame(() => {
    if (state.chart) state.chart.resize();
    if (state.histChartAi) state.histChartAi.resize();
    if (state.histChartNev) state.histChartNev.resize();
    if (state.compareChart) state.compareChart.resize();
  });
}

function applyViewVisibility() {
  // 大盘页已关闭，始终显示基金相关区块
}

function renderFundTabs() {
  const el = $("#fundTabs");
  if (!el) return;
  el.innerHTML = FUNDS.map((f) => {
    const active = f.id === state.activeFundId ? " active" : "";
    return `<button type="button" class="fund-tab${active}" data-fund="${f.id}">
      <span class="ft-name">${f.name}</span>
      <span class="ft-code">${f.code} · ${f.refName}</span>
    </button>`;
  }).join("");
}

function bindFundTabs() {
  const el = $("#fundTabs");
  if (!el) return;
  el.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".fund-tab");
    if (!btn) return;
    setActiveFund(btn.dataset.fund);
  });
}

function $(sel) {
  return document.querySelector(sel);
}

function p2(n) {
  return String(n).padStart(2, "0");
}

function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function sessionRangeOf(ts) {
  const d = new Date(ts);
  const start = new Date(d);
  start.setHours(9, 30, 0, 0);
  const end = new Date(d);
  end.setHours(15, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function inSession(ts) {
  const { start, end } = sessionRangeOf(ts);
  if (ts < start || ts > end) return false;
  // 午休 11:30–13:00 不交易
  const d = new Date(ts);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins <= 11 * 60 + 30 || mins >= 13 * 60;
}

function formatPct(v) {
  if (v == null || Number.isNaN(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${Number(v).toFixed(2)}%`;
}

function textClass(v) {
  if (v == null || Number.isNaN(v) || Math.abs(v) < 0.00001) return "";
  return v > 0 ? "up-text" : "down-text";
}

function changeClass(v) {
  if (v == null || Number.isNaN(v) || Math.abs(v) < 0.00001) return "flat";
  return v > 0 ? "up" : "down";
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function lastPoint() {
  return state.points[state.points.length - 1] || null;
}

function applyDay(day) {
  if (!day) return;
  const nextKey = dayKeyOf(day.updatedAt || Date.now());
  if (nextKey !== state.dayKey) {
    state.dayKey = nextKey;
    state.points = [];
  }
  if (Array.isArray(day.points)) state.points = day.points;
  if (day.updatedAt) state.updatedAt = day.updatedAt;
}

function applyStatus(status) {
  if (!status) return;
  state.status = status;
  const c = status.collector || {};
  if (c.nextAt) state.nextAt = c.nextAt;

  if (!state.connected) {
    setStatus("实时连接断开，等待重连...", false);
    return;
  }

  if (c.lastOk === true) {
    setStatus(`实时推送 · 后端已采集 ${c.lastAtLabel || "--"}`, true);
  } else if (c.lastError === "非交易时段") {
    setStatus("实时连接正常 · 非交易时段", true);
  } else if (c.lastError) {
    setStatus(`实时连接 · ${c.lastError}`, false);
  } else {
    setStatus("实时连接正常 · 等待首次采集", true);
  }
}

function fmtNav(v) {
  if (v == null || Number.isNaN(Number(v))) return "--";
  return Number(v).toFixed(4);
}

function prevWorkdayActual(fundId) {
  if (!state.hist || !state.hist.funds || !state.hist.funds[fundId]) return null;
  const pts = state.hist.funds[fundId].points || [];
  if (!pts.length) return null;
  const today = dayKeyOf(Date.now());
  // 取严格早于今天的最后一个交易日
  for (let i = pts.length - 1; i >= 0; i--) {
    const key = dayKeyOf(pts[i].ts);
    if (key < today) {
      return { date: key, ...pts[i] };
    }
  }
  return null;
}

function prevWorkdaySystem(fundId, dateKey) {
  if (!dateKey || !state.dailyEstimates || !state.dailyEstimates.days) return null;
  const day = state.dailyEstimates.days[dateKey];
  if (!day || !day.funds) return null;
  return day.funds[fundId] || null;
}

function renderCards() {
  const root = $("#cards");
  const last = lastPoint();
  const fund = activeFund();
  const pct = last ? last.values[fund.id] : null;
  const detail = last && last.detail ? last.detail[fund.id] : null;
  const nav =
    detail && detail.estNav != null
      ? detail.estNav
      : pct != null
        ? Number((fund.lastNav * (1 + pct / 100)).toFixed(4))
        : null;

  const methodLabel =
    (detail && detail.methodLabel) ||
    (detail && detail.method === "holdings" ? "持仓加权主估值" : detail && detail.method === "index" ? "指数/ETF参考" : "估值");
  const hm = detail && detail.holdingsMeta;
  const holdingsLine = hm
    ? `持仓源 ${hm.holdingsSource} · ${hm.matched}/${hm.total} 只 · 覆盖 ${hm.coveredWeight}%（主估值）`
    : "无持仓数据，已回退指数/ETF";
  const compare =
    detail && detail.holdingsPct != null && detail.indexPct != null
      ? `<div class="meta-item">
          <div class="meta-label">持仓(主) / 指数(参考)</div>
          <div class="meta-value">${formatPct(detail.holdingsPct)} / ${formatPct(detail.indexPct)}</div>
        </div>`
      : detail && detail.indexPct != null
        ? `<div class="meta-item">
            <div class="meta-label">指数/ETF涨幅</div>
            <div class="meta-value">${formatPct(detail.indexPct)}</div>
          </div>`
        : "";

  const prevAct = prevWorkdayActual(fund.id);
  const prevSys = prevWorkdaySystem(fund.id, prevAct && prevAct.date);
  const prevActHtml = prevAct
    ? `<div class="meta-item">
        <div class="meta-label">前日真实(${prevAct.date})</div>
        <div class="meta-value">${fmtNav(prevAct.nav)} <span class="${textClass(prevAct.dailyPct)}">${formatPct(prevAct.dailyPct)}</span></div>
      </div>`
    : `<div class="meta-item">
        <div class="meta-label">前日真实</div>
        <div class="meta-value">--</div>
      </div>`;
  const prevSysHtml = prevSys
    ? `<div class="meta-item">
        <div class="meta-label">前日系统(${prevAct ? prevAct.date : ""})</div>
        <div class="meta-value">${fmtNav(prevSys.estNav)} <span class="${textClass(prevSys.pct)}">${formatPct(prevSys.pct)}</span></div>
      </div>`
    : `<div class="meta-item">
        <div class="meta-label">前日系统</div>
        <div class="meta-value">--</div>
      </div>`;

  root.innerHTML = `
    <article class="card">
      <div class="card-top">
        <div>
          <div class="card-name">${fund.name}</div>
          <div class="card-code">${fund.code} · ${fund.refName}</div>
        </div>
        <span class="badge">${methodLabel}${state.connected ? " · SSE" : ""}</span>
      </div>
      <div class="change ${changeClass(pct)}">${formatPct(pct)}</div>
      <div class="meta">
        ${prevActHtml}
        ${prevSysHtml}
        <div class="meta-item">
          <div class="meta-label">当前估算净值</div>
          <div class="meta-value">${nav != null ? nav : "--"}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">参考最新净值</div>
          <div class="meta-value">${fund.lastNav.toFixed(4)} <span style="color:var(--muted);font-size:12px">(${fund.lastNavDate})</span></div>
        </div>
        ${compare}
        <div class="meta-item">
          <div class="meta-label">记录时间</div>
          <div class="meta-value">${last ? last.timeLabel : "--"}</div>
        </div>
        <div class="meta-item" style="grid-column:1/-1">
          <div class="meta-label">天天基金持仓</div>
          <div class="meta-value" style="font-size:13px;color:var(--muted)">${holdingsLine}</div>
        </div>
      </div>
      </article>`;
}

function renderLegend() {
  if (!$("#legend")) return;
  const fund = activeFund();
  $("#legend").innerHTML = `<span><i style="background:${fundColor(fund)}"></i>${fund.name}</span>`;
}

function sliceHistory(points) {
  if (!Array.isArray(points)) return [];
  const range = state.histRange;
  if (!range) return points;
  const cutoff = Date.now() - range * 24 * 60 * 60 * 1000;
  return points.filter((p) => p.ts >= cutoff);
}

function renderHistoryChart(chart, fund, points) {
  if (!chart) return;
  const sliced = points.length ? sliceHistory(points) : [];
  if (sliced.length < 2) {
    chart.clear();
    return;
  }

  // 以当前区间起点净值为 0%
  const base = sliced[0].nav;
  const dates = sliced.map((p) => {
    const d = new Date(p.ts);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  });
  const seriesData = sliced.map((p) =>
    base > 0 ? Number((((p.nav / base) - 1) * 100).toFixed(4)) : null
  );
  const ret = seriesData[seriesData.length - 1];
  const titleEl = document.getElementById(fund.id === "ai" ? "histTitleAi" : "histTitleNev");
  if (titleEl) {
    titleEl.innerHTML = `${fund.name} <span class="${textClass(ret)}" style="font-weight:700;margin-left:8px">${formatPct(ret)}</span>`;
  }

  chart.setOption(
    {
      backgroundColor: "transparent",
      grid: { left: 48, right: 16, top: 24, bottom: 36 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(23,29,36,0.96)",
        borderColor: "#2a3441",
        textStyle: { color: "#e7edf3" },
        formatter: (params) => {
          if (!params || !params.length) return "";
          const dateStr = params[0].axisValue;
          const idx = params[0].dataIndex;
          const row = sliced[idx];
          const lines = [`<div style="margin-bottom:4px">${dateStr}</div>`];
          if (row) {
            lines.push(`单位净值：${row.nav}`);
            if (row.dailyPct != null) lines.push(`日涨幅：${formatPct(row.dailyPct)}`);
          }
          lines.push(`区间累计：${formatPct(params[0].value)}`);
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#2a3441" } },
        axisLabel: {
          color: "#8b98a5",
          formatter: (value) => value.slice(5),
          hideOverlap: true,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        // 强制包含 0 轴
        min: (value) => Math.min(0, Math.floor(value.min)),
        max: (value) => Math.max(0, Math.ceil(value.max)),
        axisLabel: { color: "#8b98a5", formatter: "{value}%" },
        splitLine: { lineStyle: { color: "#2a3441", type: "dashed" } },
      },
      series: [
        {
          name: "区间累计涨幅",
          type: "line",
          smooth: false,
          showSymbol: false,
          connectNulls: true,
          lineStyle: { width: 2, color: fundColor(fund) },
          itemStyle: { color: fundColor(fund) },
          areaStyle: { color: fundColor(fund), opacity: 0.08 },
          markLine: {
            silent: true,
            symbol: "none",
            data: [{ yAxis: 0 }],
            lineStyle: { color: "#8b98a5", type: "solid", width: 1 },
            label: { show: false },
          },
          data: seriesData,
        },
      ],
    },
    true
  );
}

function renderHistMeta(hist) {
  const el = $("#histMeta");
  if (!el) return;
  if (!hist) {
    el.textContent = "历史净值未加载";
    return;
  }
  const fund = activeFund();
  const h = hist.funds && hist.funds[fund.id];
  if (h && h.points && h.points.length) {
    const first = h.points[0];
    const last = h.points[h.points.length - 1];
    const f = new Date(first.ts);
    const l = new Date(last.ts);
    const p2 = (n) => String(n).padStart(2, "0");
    el.textContent = `天天基金净值 · ${fund.code}: ${f.getFullYear()}-${p2(f.getMonth() + 1)}-${p2(f.getDate())} ~ ${l.getFullYear()}-${p2(l.getMonth() + 1)}-${p2(l.getDate())} · ${h.points.length} 个交易日`;
  } else {
    el.textContent = "历史净值加载失败";
  }
}

function initChart() {
  const safeInit = (sel) => {
    const el = $(sel);
    if (!el || typeof echarts === "undefined") return null;
    try {
      return echarts.init(el, null, { renderer: "canvas" });
    } catch {
      return null;
    }
  };
  state.chart = safeInit("#chart");
  state.histChartAi = safeInit("#histChartAi");
  state.histChartNev = safeInit("#histChartNev");
  state.compareChart = safeInit("#compareChart");
  window.addEventListener("resize", () => {
    if (state.chart) state.chart.resize();
    if (state.histChartAi) state.histChartAi.resize();
    if (state.histChartNev) state.histChartNev.resize();
    if (state.compareChart) state.compareChart.resize();
  });
}

function updateHistoryCharts() {
  if (isMarketView()) return;
  if (!state.hist) return;
  const fund = activeFund();
  const chart = fund.id === "ai" ? state.histChartAi : state.histChartNev;
  const other = fund.id === "ai" ? state.histChartNev : state.histChartAi;
  const activeWrap = chart && chart.getDom() ? chart.getDom().parentElement : null;
  // 只显示当前基金的历史图
  if (other && other.getDom()) {
    const wrap = other.getDom().parentElement;
    if (wrap) wrap.style.display = "none";
  }
  if (activeWrap) activeWrap.style.display = "";
  const pts = (state.hist.funds && state.hist.funds[fund.id] && state.hist.funds[fund.id].points) || [];
  renderHistoryChart(chart, fund, pts);
  renderHistMeta(state.hist);
  requestAnimationFrame(() => {
    if (chart) chart.resize();
  });
}

async function refreshHistory() {
  const el = $("#histMeta");
  try {
    if (el && !state.hist) el.textContent = "加载历史净值...";
    const hist = await fetchJson("/api/history");
    state.hist = hist;
    updateHistoryCharts();
    renderCards();
    updateCompareChart();
  } catch (e) {
    if (el) el.textContent = `历史净值失败: ${e.message || e}`;
  }
}

async function refreshDailyEstimates() {
  try {
    const data = await fetchJson("/api/daily-estimates");
    state.dailyEstimates = data;
    if (!isMarketView()) {
      renderCards();
      updateCompareChart();
    }
  } catch {
    // 静默失败，卡片显示 --
  }
}

function buildCompareRows(fundId) {
  const hist = state.hist && state.hist.funds && state.hist.funds[fundId];
  const histPts = (hist && hist.points) || [];
  const estDays = (state.dailyEstimates && state.dailyEstimates.days) || {};

  const realByDate = new Map();
  for (const p of histPts) {
    realByDate.set(dayKeyOf(p.ts), p);
  }
  const estByDate = new Map();
  for (const [date, day] of Object.entries(estDays)) {
    const f = day && day.funds && day.funds[fundId];
    if (f && (f.estNav != null || f.pct != null)) estByDate.set(date, f);
  }

  const dates = [...new Set([...realByDate.keys(), ...estByDate.keys()])].sort();

  let absErrSum = 0;
  let signedErrSum = 0;
  let absPctErrSum = 0;
  let matchNav = 0;

  let absDailyPctErrSum = 0;
  let signedDailyPctErrSum = 0;
  let matchPct = 0;

  const rows = dates.map((date) => {
    const real = realByDate.get(date) || null;
    const est = estByDate.get(date) || null;

    const realNav = real && real.nav != null ? real.nav : null;
    const estNav = est && est.estNav != null ? est.estNav : null;
    // 真实日涨幅：优先历史 dailyPct，其次用相邻净值回算
    let realPct = real && real.dailyPct != null ? real.dailyPct : null;
    // 系统日涨幅：系统终值里的 pct
    let estPct = est && est.pct != null ? est.pct : null;

    let err = null;
    let pctErr = null;
    if (realNav != null && estNav != null) {
      err = Number((estNav - realNav).toFixed(6));
      pctErr = realNav > 0 ? Number((((estNav / realNav) - 1) * 100).toFixed(4)) : null;
      absErrSum += Math.abs(err);
      signedErrSum += err;
      if (pctErr != null) absPctErrSum += Math.abs(pctErr);
      matchNav += 1;
    }

    let dailyPctErr = null;
    if (realPct != null && estPct != null) {
      dailyPctErr = Number((estPct - realPct).toFixed(4));
      absDailyPctErrSum += Math.abs(dailyPctErr);
      signedDailyPctErrSum += dailyPctErr;
      matchPct += 1;
    }

    return {
      date,
      realNav,
      estNav,
      realPct,
      estPct,
      err,
      pctErr,
      dailyPctErr,
    };
  });

  const range = state.compareRange;
  const filtered = range
    ? rows.filter((r) => {
        const t = new Date(`${r.date}T00:00:00`).getTime();
        return t >= Date.now() - range * 24 * 60 * 60 * 1000;
      })
    : rows;

  return {
    rows: filtered,
    stats: {
      matchCount: matchNav,
      maeNav: matchNav ? absErrSum / matchNav : null,
      biasNav: matchNav ? signedErrSum / matchNav : null,
      maePct: matchNav ? absPctErrSum / matchNav : null,
      matchPct,
      maeDailyPct: matchPct ? absDailyPctErrSum / matchPct : null,
      biasDailyPct: matchPct ? signedDailyPctErrSum / matchPct : null,
      total: rows.length,
    },
  };
}

function updateCompareChart() {
  if (!state.compareChart || isMarketView()) return;
  const fund = activeFund();
  const { rows, stats } = buildCompareRows(fund.id);
  const metaEl = $("#compareMeta");
  const isPctMode = state.compareMode === "pct";

  if (rows.length < 1) {
    state.compareChart.clear();
    if (metaEl) metaEl.textContent = "暂无对比数据（需历史净值 + 每日系统终值）";
    return;
  }

  const line1 = fundColor(fund);
  const line2 = cssVar("--line-3", "#8b6a5a");

  let realData;
  let estData;
  let seriesNames;
  let yFormatter;

  if (isPctMode) {
    realData = rows.map((r) => (r.realPct != null ? [r.date, r.realPct] : [r.date, null]));
    estData = rows.map((r) => (r.estPct != null ? [r.date, r.estPct] : [r.date, null]));
    seriesNames = ["真实日涨幅", "系统日涨幅"];
    yFormatter = (v) => `${v}%`;
  } else {
    realData = rows.map((r) => (r.realNav != null ? [r.date, r.realNav] : [r.date, null]));
    estData = rows.map((r) => (r.estNav != null ? [r.date, r.estNav] : [r.date, null]));
    seriesNames = ["真实净值", "系统估值"];
    yFormatter = null;
  }

  if (metaEl) {
    if (isPctMode) {
      if (stats.matchPct > 0) {
        metaEl.textContent =
          `涨幅重叠 ${stats.matchPct}/${rows.length} 日 · 涨幅绝对误差均值 ${formatPct(stats.maeDailyPct)}` +
          ` · 偏差(系-真) ${formatPct(stats.biasDailyPct)}`;
      } else {
        metaEl.textContent = `共 ${rows.length} 个日期 · 暂无日涨幅重叠数据`;
      }
    } else if (stats.matchCount > 0) {
      metaEl.textContent =
        `重叠交易日 ${stats.matchCount}/${rows.length} · 净值绝对误差均值 ${stats.maeNav.toFixed(4)}` +
        ` · 相对误差均值 ${formatPct(stats.maePct)} · 偏差(系统-真实) ${stats.biasNav.toFixed(4)}`;
    } else {
      metaEl.textContent = `共 ${rows.length} 个日期 · 暂无系统估值与真实净值重叠，继续采集后可对比`;
    }
  }

  state.compareChart.setOption(
    {
      backgroundColor: "transparent",
      grid: { left: 56, right: 24, top: 32, bottom: 40 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(23,29,36,0.96)",
        borderColor: "var(--border)",
        textStyle: { color: "#e7edf3" },
        formatter: (params) => {
          if (!params || !params.length) return "";
          const date = params[0].axisValue;
          const idx = params[0].dataIndex;
          const row = rows[idx];
          const lines = [`<div style="margin-bottom:4px">${date}</div>`];
          if (isPctMode) {
            lines.push(`真实日涨幅：${formatPct(row && row.realPct)}`);
            lines.push(`系统日涨幅：${formatPct(row && row.estPct)}`);
            if (row && row.dailyPctErr != null) {
              lines.push(`涨幅误差(系-真)：${formatPct(row.dailyPctErr)}`);
            }
          } else {
            lines.push(`真实净值：${row && row.realNav != null ? row.realNav : "--"}`);
            lines.push(`系统估值：${row && row.estNav != null ? row.estNav : "--"}`);
            if (row && row.err != null) {
              lines.push(`误差(系-真)：${row.err.toFixed(4)}（${formatPct(row.pctErr)}）`);
            }
          }
          return lines.join("<br/>");
        },
      },
      legend: {
        show: true,
        top: 0,
        right: 8,
        textStyle: { color: "#8b98a5", fontSize: 12 },
        data: seriesNames,
      },
      xAxis: {
        type: "category",
        data: rows.map((r) => r.date),
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#2a3441" } },
        axisLabel: {
          color: "#8b98a5",
          formatter: (value) => value.slice(5),
          hideOverlap: true,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: "#8b98a5", formatter: yFormatter },
        splitLine: { lineStyle: { color: "#2a3441", type: "dashed" } },
      },
      series: [
        {
          name: seriesNames[0],
          type: "line",
          smooth: false,
          showSymbol: false,
          connectNulls: true,
          lineStyle: { width: 2, color: line1 },
          itemStyle: { color: line1 },
          data: realData,
        },
        {
          name: seriesNames[1],
          type: "line",
          smooth: false,
          showSymbol: false,
          connectNulls: true,
          lineStyle: { width: 2, color: line2, type: "dashed" },
          itemStyle: { color: line2 },
          data: estData,
        },
      ],
    },
    true
  );
}

function bindCompareRangeTabs() {
  const tabs = $("#compareRangeTabs");
  if (!tabs) return;
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".range-btn");
    if (!btn) return;
    tabs.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.compareRange = Number(btn.dataset.range) || 0;
    updateCompareChart();
  });
}

function bindCompareModeTabs() {
  const tabs = $("#compareModeTabs");
  if (!tabs) return;
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".range-btn");
    if (!btn) return;
    tabs.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.compareMode = btn.dataset.mode === "pct" ? "pct" : "nav";
    updateCompareChart();
  });
}

function bindHistTabs() {
  const tabs = $("#histTabs");
  if (!tabs) return;
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".range-btn");
    if (!btn) return;
    tabs.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.histRange = Number(btn.dataset.range) || 0;
    updateHistoryCharts();
  });
}

function updateChart() {
  if (!state.chart || isMarketView()) return;

  const fund = activeFund();
  const points = state.points.filter((p) => inSession(p.ts));
  const hasData = points.length > 0;
  const chartEl = $("#chart");
  const emptyEl = $("#chartEmpty");
  if (chartEl) chartEl.style.display = hasData ? "block" : "none";
  if (emptyEl) emptyEl.style.display = hasData ? "none" : "block";

  const { start, end } = sessionRangeOf(state.updatedAt || Date.now());
  const series = [
    {
      name: fund.name,
      type: "line",
      smooth: false,
      showSymbol: false,
      emphasis: { scale: false },
      connectNulls: true,
      lineStyle: { width: 2, color: fundColor(fund) },
      itemStyle: { color: fundColor(fund) },
      data: points.map((p) => [p.ts, p.values[fund.id]]),
    },
  ];

  state.chart.setOption(
    {
      backgroundColor: "transparent",
      grid: { left: 56, right: 24, top: 40, bottom: 48 },
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          if (!params || !params.length) return "";
          const ts = params[0].value[0];
          const lines = [`<div style="margin-bottom:4px">${formatTime(ts)}</div>`];
          params.forEach((item) => {
            const v = item.value[1];
            lines.push(
              `${item.marker}${item.seriesName}：${v == null ? "--" : formatPct(v)}`
            );
          });
          return lines.join("<br/>");
        },
        backgroundColor: "rgba(23,29,36,0.96)",
        borderColor: "#2a3441",
        textStyle: { color: "#e7edf3" },
      },
      legend: { show: false },
      xAxis: {
        type: "time",
        min: start,
        max: end,
        axisLine: { lineStyle: { color: "#2a3441" } },
        axisLabel: {
          color: "#8b98a5",
          formatter: (value) => formatTime(value).slice(0, 5),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: "#8b98a5", formatter: "{value}%" },
        splitLine: { lineStyle: { color: "#2a3441", type: "dashed" } },
      },
      series,
    },
    true
  );
}

function renderHistory() {}

function renderHoldings(live) {
  if (isMarketView()) return;
  const grid = $("#holdingsGrid");
  const meta = $("#liveMeta");
  const fund = activeFund();
  if (!live || !live.byFund) {
    grid.innerHTML = `<div class="muted">暂无持仓数据</div>`;
    meta.textContent = "--";
    return;
  }

  meta.textContent = `行情 ${formatTime(live.ts)} · 腾讯批量 · 持仓来源天天基金`;

  const block = live.byFund[fund.id];
  if (!block) {
    grid.innerHTML = `
      <div class="holdings-block">
        <div class="holdings-title">
          <span>${fund.name}</span>
          <span class="muted">无持仓</span>
        </div>
        <div class="muted">未加载到持仓，请刷新持仓</div>
      </div>`;
    return;
  }

  const rows = block.stocks
    .map((s) => {
      return `<tr>
        <td>${s.rank}</td>
        <td>${s.code}</td>
        <td>${s.name}</td>
        <td class="num">${s.weight.toFixed(2)}%</td>
        <td class="num">${s.price != null ? s.price : "--"}</td>
        <td class="num ${textClass(s.pct)}">${formatPct(s.pct)}</td>
        <td class="num ${textClass(s.contrib)}">${s.contrib != null ? (s.contrib > 0 ? "+" : "") + s.contrib.toFixed(3) : "--"}</td>
      </tr>`;
    })
    .join("");

  grid.innerHTML = `
    <div class="holdings-block">
      <div class="holdings-title">
        <span>${fund.name}</span>
        <span class="muted">源 ${block.source} · ${block.matched}/${block.total} 只 · 覆盖 ${block.coveredWeight}%</span>
      </div>
      <div class="muted" style="margin-bottom:6px">
        贡献合计 <span class="${textClass(block.contribPct)}">${formatPct(block.contribPct)}</span>
        （Σ 权重×涨幅，未含残差/系数；权重&lt;0.01% 的极小仓已剔除）
      </div>
      <div class="holdings-table-wrap">
        <table class="holdings-table">
          <thead>
            <tr>
              <th>#</th>
              <th>代码</th>
              <th>名称</th>
              <th class="num">权重</th>
              <th class="num">现价</th>
              <th class="num">涨跌幅</th>
              <th class="num">贡献%</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function refreshHoldingsLive() {
  try {
    const live = await fetchJson("/api/holdings/live");
    state.holdingsLive = live;
    renderHoldings(live);
  } catch (e) {
    const meta = $("#liveMeta");
    if (meta) meta.textContent = `持仓行情失败: ${e.message || e}`;
  }
}

function setStatus(text, ok) {
  const el = $("#status");
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (ok === true) el.classList.add("ok");
  if (ok === false) el.classList.add("err");
}

function renderAll() {
  renderCards();
  updateChart();
}

function handleStreamMessage(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  state.lastPushAt = Date.now();

  if (payload.type === "snapshot" || payload.type === "update") {
    applyDay(payload.day);
    applyStatus(payload.status);
    renderAll();
    updateCountdown();
    refreshHoldingsLive();
    return;
  }

  if (payload.type === "status" || payload.type === "error") {
    applyStatus(payload.status);
    if (payload.error) setStatus(`推送错误：${payload.error}`, false);
    renderAll();
    updateCountdown();
  }
}

function connectStream() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }

  setStatus("连接后端推送...");
  const es = new EventSource("/api/stream");
  state.es = es;

  es.onopen = () => {
    state.connected = true;
    setStatus("实时连接已建立", true);
    stopFallback();
  };

  es.onmessage = (event) => {
    handleStreamMessage(event.data);
  };

  es.onerror = () => {
    state.connected = false;
    setStatus("实时连接断开，3 秒后重连...", false);
    renderAll();
    startFallback();
    // EventSource 自带重连；这里兜底重建
    es.close();
    state.es = null;
    setTimeout(() => {
      if (!state.connected) connectStream();
    }, 3000);
  };
}

async function refreshData() {
  setStatus("读取服务端...");
  try {
    const dayKey = dayKeyOf(Date.now());
    const [day, status] = await Promise.all([
      fetchJson(`/api/day?date=${dayKey}`),
      fetchJson("/api/status"),
    ]);
    applyDay(day);
    applyStatus(status);
    renderAll();
    updateCountdown();
    refreshHoldingsLive();
    refreshDailyEstimates();
  } catch (e) {
    setStatus(`读取失败：${e.message || e}`, false);
  }
}

async function triggerCollect() {
  setStatus("触发采集...");
  try {
    await fetchJson("/api/collect", { method: "POST" });
    // 成功时后端会 SSE 推送；再兜底拉一次
    await refreshData();
  } catch (e) {
    setStatus(`采集失败：${e.message || e}`, false);
  }
}

function updateCountdown() {
  const left = Math.max(0, state.nextAt - Date.now());
  const sec = Math.ceil(left / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const prefix = state.connected ? "推送中 · 后端下次" : "后端下次";
  $("#countdown").textContent = `${prefix} ${m}:${String(s).padStart(2, "0")}`;
}

function startFallback() {
  if (state.fallbackTimer) return;
  state.fallbackTimer = setInterval(refreshData, FALLBACK_MS);
}

function stopFallback() {
  if (state.fallbackTimer) {
    clearInterval(state.fallbackTimer);
    state.fallbackTimer = null;
  }
}

function applyTheme(theme) {
  const t = theme === "slate" ? "slate" : "purple";
  document.body.dataset.theme = t;
  try {
    localStorage.setItem("fund-theme", t);
  } catch {
    // ignore
  }
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === t);
  });
  try {
    updateHistoryCharts();
    updateChart();
    updateCompareChart();
    if (state.holdingsLive) renderHoldings(state.holdingsLive);
  } catch {
    // 图表未就绪时忽略
  }
  renderLegend();
  renderCards();
}

function bindThemeSwitch() {
  let saved = "purple";
  try {
    saved = localStorage.getItem("fund-theme") || "purple";
  } catch {
    // ignore
  }
  applyTheme(saved);
  $("#themeSwitch")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".theme-btn");
    if (!btn) return;
    applyTheme(btn.dataset.theme);
  });
}

function main() {
  try {
    renderFundTabs();
    bindFundTabs();
    bindHistTabs();
    bindCompareRangeTabs();
    bindCompareModeTabs();
    renderLegend();
    initChart();
    applyViewVisibility();
    bindThemeSwitch();
    $("#refreshBtn").addEventListener("click", refreshData);
    $("#collectBtn").addEventListener("click", triggerCollect);

    state.countdownTimer = setInterval(updateCountdown, COUNTDOWN_MS);
    state.holdingsTimer = setInterval(refreshHoldingsLive, FALLBACK_MS);
    refreshData();
    refreshHistory();
    refreshDailyEstimates();
    connectStream();
  } catch (e) {
    setStatus(`初始化失败: ${e.message || e}`, false);
    // 兜底：即使图表失败也尝试拉数据和绑定 Tab
    try {
      renderFundTabs();
      bindFundTabs();
      refreshData();
      refreshHistory();
      refreshDailyEstimates();
    } catch {
      // ignore
    }
  }
}

main();
