import { escapeHtml } from "./escape.mjs";

// engram signal lab — client renderer (vanilla, no deps)

const COLORS = { green: "#7cffb2", cyan: "#5ad1ff", amber: "#ffc857" };
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SOURCE_LABELS = {
  engram_asr: "ASR",
  engram_discdb: "DiscDB",
  bootstrap: "Bootstrap",
  user_review: "User review",
  engram_chromaprint_corroboration: "Chromaprint",
};

const state = {
  source: localStorage.getItem("sl.source") === "remote" ? "remote" : "local",
  growthMode: localStorage.getItem("sl.growthMode") === "daily" ? "daily" : "cumulative",
  auto: true,
  lastData: null,
  lastUpdated: 0,
  timer: null,
};

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const fmtNum = (n) => nf.format(n);
const fmtPct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function relTime(unixSeconds) {
  if (!unixSeconds) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function countUp(node, to, fmt = fmtNum) {
  const from = Number(node.dataset.val || 0);
  if (REDUCED || from === to) {
    node.textContent = fmt(to);
    node.dataset.val = String(to);
    return;
  }
  const dur = 700;
  const start = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    node.textContent = fmt(Math.round(from + (to - from) * ease(t)));
    if (t < 1) requestAnimationFrame(step);
    else {
      node.textContent = fmt(to);
      node.dataset.val = String(to);
    }
  };
  requestAnimationFrame(step);
}

// Let CSS transitions play: render bars at width 0, then set the target width.
function animateBars(root) {
  requestAnimationFrame(() => {
    for (const i of root.querySelectorAll("[data-w]")) i.style.width = `${i.dataset.w}%`;
  });
}

// ---- data load --------------------------------------------------------------

async function load(fresh = false) {
  setStatus("loading", "scanning…");
  $("refreshBtn").classList.add("spinning");
  try {
    const url = `/api/stats?source=${state.source}${fresh ? "&fresh=1" : ""}`;
    const res = await fetch(url);
    const payload = await res.json();
    if (!payload.ok) {
      showError(payload.error || "Unknown error from wrangler.");
      setStatus("err", "no signal");
      if (!state.lastData) renderEmptyAll();
      return;
    }
    hideError();
    state.lastData = payload.data;
    state.lastUpdated = payload.generatedAt;
    render(payload.data);
    setStatus("live", `updated ${relTime(payload.generatedAt / 1000)} ago`);
    $("footerStamp").textContent = new Date(payload.generatedAt).toLocaleString();
  } catch (err) {
    showError(`Could not reach the dashboard server: ${err.message}`);
    setStatus("err", "offline");
  } finally {
    $("refreshBtn").classList.remove("spinning");
  }
}

function setStatus(cls, text) {
  $("status").className = `status ${cls}`;
  $("statusText").textContent = text;
}
function showError(msg) {
  $("errorText").textContent = msg;
  $("errorBanner").hidden = false;
}
function hideError() {
  $("errorBanner").hidden = true;
}

// ---- master render ----------------------------------------------------------

function render(d) {
  renderTiles(d);
  renderFunnel(d);
  renderGrowth(d.timeseries, state.growthMode);
  renderTierLadder(d);
  renderSources(d.matchSources);
  renderPoison(d);
  renderShows(d.topShows, d.names);
  renderContributors(d.topContributors);
  renderFeed(d.recent, d.names);
}

function renderEmptyAll() {
  for (const id of ["funnel", "growthChart", "tierLadder", "sourceBars", "poison"]) {
    $(id).innerHTML = '<div class="empty-state">awaiting signal…</div>';
  }
}

function renderTiles(d) {
  const t = d.totals;
  const tiles = [
    { label: "Shows", val: t.shows, foot: `${fmtNum(t.episodes)} episodes` },
    { label: "Canonical", val: d.tiers.canonical, foot: "consensus-grade" },
    { label: "Packs", val: t.packs, foot: "shipped to R2" },
    { label: "Contributions", val: t.contributions, foot: `${fmtNum(t.unpromoted)} queued` },
    { label: "Contributors", val: t.contributors, foot: "unique" },
    { label: "Flagged", val: t.flagged, foot: "contributors", warn: t.flagged > 0 },
  ];
  const wrap = $("tiles");
  if (wrap.children.length !== tiles.length) {
    wrap.innerHTML = "";
    tiles.forEach((spec, idx) => {
      const tile = el("div", `tile${spec.warn ? " warn" : ""}`);
      tile.style.animationDelay = `${idx * 55}ms`;
      tile.innerHTML =
        `<div class="tile-label">${spec.label}</div>` +
        `<div class="tile-val" data-key="${spec.label}">0</div>` +
        `<div class="tile-foot">${spec.foot}</div>`;
      wrap.appendChild(tile);
    });
  }
  tiles.forEach((spec) => {
    const valNode = wrap.querySelector(`[data-key="${spec.label}"]`);
    countUp(valNode, spec.val);
    valNode.closest(".tile").querySelector(".tile-foot").textContent = spec.foot;
    valNode.closest(".tile").classList.toggle("warn", !!spec.warn);
  });
}

function renderFunnel(d) {
  const t = d.totals;
  const tiers = d.tiers;
  const ep = Math.max(1, t.episodes);
  const maxTier = Math.max(1, tiers.candidate, tiers.confirmed, tiers.canonical);
  const stages = [
    {
      tone: "raw",
      kicker: "Raw intake",
      val: t.contributions,
      label: "Contributions",
      sub: `${fmtNum(t.unpromoted)} awaiting promotion`,
      w: 100,
      conv: null,
    },
    {
      tone: "candidate",
      kicker: "Tier 1",
      val: tiers.candidate,
      label: "Candidate",
      sub: "1 contributor",
      w: (tiers.candidate / maxTier) * 100,
      conv: fmtPct(tiers.candidate / ep),
    },
    {
      tone: "confirmed",
      kicker: "Tier 2",
      val: tiers.confirmed,
      label: "Confirmed",
      sub: "2+ independent",
      w: (tiers.confirmed / maxTier) * 100,
      conv: fmtPct(tiers.confirmed / ep),
    },
    {
      tone: "canonical",
      kicker: "Tier 3",
      val: tiers.canonical,
      label: "Canonical",
      sub: "3+ · conf ≥ .85",
      w: (tiers.canonical / maxTier) * 100,
      conv: fmtPct(tiers.canonical / ep),
    },
    {
      tone: "pack",
      kicker: "Shipped",
      val: t.packs,
      label: "Packs",
      sub: "shows with a pack",
      w: (t.packs / Math.max(1, t.shows)) * 100,
      conv: `${fmtPct(t.packs / Math.max(1, t.shows))} of shows`,
    },
  ];
  const wrap = $("funnel");
  wrap.innerHTML = "";
  stages.forEach((s, idx) => {
    const node = el("div", "fstage");
    node.dataset.tone = s.tone;
    node.innerHTML =
      (s.conv ? `<span class="fconv">${s.conv}</span>` : "") +
      `<div class="fkicker">${s.kicker}</div>` +
      `<div class="fval" data-key="f${idx}">0</div>` +
      `<div class="flabel">${s.label}</div>` +
      `<div class="fsub">${s.sub}</div>` +
      `<div class="fbar"><i data-w="${s.w.toFixed(1)}"></i></div>`;
    wrap.appendChild(node);
    countUp(node.querySelector(`[data-key="f${idx}"]`), s.val);
  });
  $("heroSub").textContent =
    `${fmtPct(tiers.canonical / ep)} of ${fmtNum(t.episodes)} episodes canonical`;
  animateBars(wrap);
}

// ---- growth oscilloscope (hand-rolled SVG) ----------------------------------

function alignSeries(map, days, cumulative) {
  let run = 0;
  return days.map((day) => {
    const v = map.get(day) || 0;
    run += v;
    return cumulative ? run : v;
  });
}

function renderGrowth(ts, mode) {
  const host = $("growthChart");
  const cumulative = mode === "cumulative";
  const maps = {
    canonicals: new Map(ts.canonicals.map((r) => [r.day, r.n])),
    contributions: new Map(ts.contributions.map((r) => [r.day, r.n])),
    contributors: new Map(ts.contributors.map((r) => [r.day, r.n])),
  };
  const days = [
    ...new Set([
      ...maps.canonicals.keys(),
      ...maps.contributions.keys(),
      ...maps.contributors.keys(),
    ]),
  ].sort();

  $("growthLegend").innerHTML = [
    ["green", "Canonical episodes"],
    ["cyan", "Contributions"],
    ["amber", "New contributors"],
  ]
    .map(
      ([c, label]) =>
        `<span class="lg"><span class="swatch" style="background:${COLORS[c]}"></span>${label}</span>`,
    )
    .join("");

  if (days.length === 0) {
    host.innerHTML =
      '<div class="empty-state">no dated records yet — seed or wait for the first contributions</div>';
    return;
  }

  const series = [
    { key: "canonicals", color: COLORS.green, area: true },
    { key: "contributions", color: COLORS.cyan },
    { key: "contributors", color: COLORS.amber },
  ].map((s) => ({ ...s, values: alignSeries(maps[s.key], days, cumulative) }));

  const W = 1000;
  const H = 300;
  const padL = 46;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const yMax = Math.max(1, ...series.flatMap((s) => s.values));
  const n = days.length;
  const x = (i) => (n === 1 ? (padL + W - padR) / 2 : padL + (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);

  const gridLines = 4;
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Catalog growth over time">`;
  for (let g = 0; g <= gridLines; g++) {
    const gy = padT + (g / gridLines) * (H - padT - padB);
    const val = Math.round(yMax * (1 - g / gridLines));
    svg += `<line class="grid-line" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" />`;
    svg += `<text class="axis-label" x="${padL - 8}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${fmtNum(val)}</text>`;
  }
  const xticks = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  for (const i of xticks) {
    svg += `<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${days[i].slice(5)}</text>`;
  }

  for (const s of series) {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    if (s.area && n > 1) {
      const area = `${padL},${y(0).toFixed(1)} ${pts.join(" ")} ${(W - padR).toFixed(1)},${y(0).toFixed(1)}`;
      svg += `<polygon points="${area}" fill="${s.color}" opacity="0.08" />`;
    }
    if (s.area && n > 1) {
      // faux glow: thick low-opacity stroke under the crisp line
      svg += `<polyline class="series-path" points="${pts.join(" ")}" stroke="${s.color}" stroke-width="6" opacity="0.18" />`;
    }
    svg += `<polyline class="series-path" points="${pts.join(" ")}" stroke="${s.color}" />`;
    const li = n - 1;
    svg += `<circle class="series-dot" cx="${x(li).toFixed(1)}" cy="${y(s.values[li]).toFixed(1)}" r="3.5" fill="${s.color}" />`;
  }
  svg += "</svg>";
  host.innerHTML = svg;
}

function renderTierLadder(d) {
  const tiers = d.tiers;
  const confMap = new Map(d.confidenceByTier.map((r) => [r.tier, r]));
  const ep = Math.max(1, d.totals.episodes);
  const maxTier = Math.max(1, tiers.candidate, tiers.confirmed, tiers.canonical);
  const rows = [
    { tier: "canonical", name: "Canonical", count: tiers.canonical },
    { tier: "confirmed", name: "Confirmed", count: tiers.confirmed },
    { tier: "candidate", name: "Candidate", count: tiers.candidate },
  ];
  const host = $("tierLadder");
  host.innerHTML = rows
    .map((r) => {
      const conf = confMap.get(r.tier);
      const confStr = conf ? `conf ${conf.avg.toFixed(2)}` : "—";
      return (
        `<div class="trow" data-tier="${r.tier}">` +
        `<div class="trow-head"><span class="trow-name">${r.name}</span>` +
        `<span class="trow-count">${fmtNum(r.count)}</span></div>` +
        `<div class="trow-bar"><i data-w="${((r.count / maxTier) * 100).toFixed(1)}"></i></div>` +
        `<div class="trow-meta"><span>${fmtPct(r.count / ep)} of catalog</span><span>${confStr}</span></div>` +
        "</div>"
      );
    })
    .join("");
  $("tierSub").textContent = `${fmtPct(tiers.canonical / ep)} canonical`;
  animateBars(host);
}

function renderSources(sources) {
  const host = $("sourceBars");
  if (!sources.length) {
    host.innerHTML = '<div class="empty-state">no contributions yet</div>';
    return;
  }
  const max = Math.max(1, ...sources.map((s) => s.n));
  host.innerHTML = sources
    .map((s) => {
      const label = SOURCE_LABELS[s.source] || s.source;
      return (
        '<div class="brow">' +
        `<div class="brow-head"><b>${label}</b><span class="brow-n">${fmtNum(s.n)}</span></div>` +
        `<div class="brow-track"><i data-w="${((s.n / max) * 100).toFixed(1)}"></i></div>` +
        "</div>"
      );
    })
    .join("");
  animateBars(host);
}

function renderPoison(d) {
  const p = d.poison;
  const order = ["pass", "flag_conflict", "flag_duplicate", "pending"];
  const labels = {
    pass: "Pass",
    flag_conflict: "Conflict",
    flag_duplicate: "Duplicate",
    pending: "Pending",
  };
  const total = order.reduce((a, k) => a + (p[k] || 0), 0);
  const host = $("poison");
  const bar = order
    .map(
      (k) => `<i class="poison-seg-${k}" data-w="${total ? ((p[k] || 0) / total) * 100 : 0}"></i>`,
    )
    .join("");
  const legend = order
    .map(
      (k) =>
        `<div class="pl"><span class="sw poison-seg-${k}"></span>${labels[k]}<b>${fmtNum(p[k] || 0)}</b></div>`,
    )
    .join("");
  const flagged = d.totals.flagged;
  host.innerHTML =
    `<div class="poison-bar">${bar}</div>` +
    `<div class="poison-legend">${legend}</div>` +
    '<div class="poison-stats">' +
    `<div class="pstat ${flagged > 0 ? "danger" : "ok"}"><div class="pk">Flagged users</div><div class="pv">${fmtNum(flagged)}</div></div>` +
    `<div class="pstat"><div class="pk">Avg overlap</div><div class="pv">${fmtPct(d.overlap.avg)}</div></div>` +
    "</div>";
  animateBars(host);
}

// The "Show" identity cell: the resolved name (escaped — it is external text)
// as the primary label with a dim tmdb id beneath it, or just the id when no
// name resolved.
function showCell(tmdbId, names) {
  const name = names?.[tmdbId];
  return name
    ? `<td><div class="show-name">${escapeHtml(name)}</div><div class="show-id">tmdb:${tmdbId}</div></td>`
    : `<td class="id-cell">tmdb:${tmdbId}</td>`;
}

function renderShows(shows, names) {
  const host = $("showsTable");
  if (!shows.length) {
    host.innerHTML = '<div class="empty-state">no episodes tracked yet</div>';
    return;
  }
  const rows = shows
    .map((s) => {
      const total = Math.max(1, s.episodes);
      const seg = (cls, v) =>
        v ? `<i class="mb-${cls}" style="width:${(v / total) * 100}%"></i>` : "";
      return (
        "<tr>" +
        showCell(s.tmdb_id, names) +
        `<td class="num">${fmtNum(s.episodes)}</td>` +
        `<td><span class="minibar">${seg("canonical", s.canonical)}${seg("confirmed", s.confirmed)}${seg("candidate", s.candidate)}</span></td>` +
        `<td class="num">${fmtNum(s.canonical)}</td>` +
        `<td class="num mono-dim">${s.avg_conf ? s.avg_conf.toFixed(2) : "—"}</td>` +
        "</tr>"
      );
    })
    .join("");
  host.innerHTML =
    "<table><thead><tr>" +
    '<th>Show</th><th class="num">Eps</th><th>Mix</th><th class="num">Canon</th><th class="num">Conf</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderContributors(list) {
  const host = $("contributorsTable");
  if (!list.length) {
    host.innerHTML = '<div class="empty-state">no contributors yet</div>';
    return;
  }
  const rows = list
    .map((c) => {
      const id = `${String(c.pseudonym).slice(0, 8)}…`;
      const badge = c.flagged
        ? `<span class="badge flag">flagged ${c.flag_count}</span>`
        : '<span class="badge ok">ok</span>';
      return (
        "<tr>" +
        `<td class="mono-dim">${id}</td>` +
        `<td class="num">${fmtNum(c.count)}</td>` +
        `<td>${badge}</td>` +
        "</tr>"
      );
    })
    .join("");
  host.innerHTML =
    "<table><thead><tr>" +
    '<th>Pseudonym</th><th class="num">Submissions</th><th>Status</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>`;
}

function epLabel(r) {
  const s = r.season == null ? "—" : `S${String(r.season).padStart(2, "0")}`;
  const e = r.episode == null ? "" : `E${String(r.episode).padStart(2, "0")}`;
  return `${s}${e}`;
}

function renderFeed(recent, names) {
  const host = $("feed");
  if (!recent.length) {
    host.innerHTML = '<div class="empty-state">no contributions recorded yet</div>';
    return;
  }
  host.innerHTML = recent
    .map((r, i) => {
      const src = SOURCE_LABELS[r.match_source] || r.match_source;
      const promoted = r.promoted ? '<span class="promoted-mark" title="promoted">▲</span>' : "";
      const name = names?.[r.tmdb_id];
      const showSpan = name
        ? `<span class="show">${escapeHtml(name)}</span> <span class="show-id">tmdb:${r.tmdb_id}</span>`
        : `<span class="show">tmdb:${r.tmdb_id}</span>`;
      return (
        `<div class="feed-row" style="animation-delay:${Math.min(i * 25, 400)}ms">` +
        `<span class="feed-time">${relTime(r.received_at)}</span>` +
        `<span class="feed-ep">${showSpan} ${epLabel(r)}${promoted}</span>` +
        `<span class="feed-src">${src}</span>` +
        `<span class="feed-conf">${r.match_confidence.toFixed(2)}</span>` +
        `<span class="feed-tag"><span class="tag ${r.poison_check}">${r.poison_check.replace("flag_", "")}</span></span>` +
        "</div>"
      );
    })
    .join("");
}

// ---- controls + lifecycle ---------------------------------------------------

function setSource(source) {
  if (source === state.source) return;
  state.source = source;
  localStorage.setItem("sl.source", source);
  for (const b of $("sourceToggle").children)
    b.classList.toggle("active", b.dataset.source === source);
  $("footerSource").textContent = source.toUpperCase();
  state.lastData = null;
  load(true);
}

function setGrowthMode(mode) {
  state.growthMode = mode;
  localStorage.setItem("sl.growthMode", mode);
  for (const b of $("growthMode").children) b.classList.toggle("active", b.dataset.mode === mode);
  if (state.lastData) renderGrowth(state.lastData.timeseries, mode);
}

function startAuto() {
  clearInterval(state.timer);
  if (state.auto) state.timer = setInterval(() => load(false), 30_000);
}

function buildEqualizer() {
  const host = $("equalizer");
  let bars = "";
  for (let i = 0; i < 22; i++) {
    const delay = (Math.sin(i * 1.7) * 0.5 + 0.5) * 1.1;
    const dur = 0.7 + (i % 5) * 0.18;
    bars += `<span style="animation-delay:-${delay.toFixed(2)}s;animation-duration:${dur.toFixed(2)}s"></span>`;
  }
  host.innerHTML = bars;
}

function init() {
  buildEqualizer();
  for (const b of $("sourceToggle").children) {
    b.classList.toggle("active", b.dataset.source === state.source);
    b.addEventListener("click", () => setSource(b.dataset.source));
  }
  for (const b of $("growthMode").children) {
    b.classList.toggle("active", b.dataset.mode === state.growthMode);
    b.addEventListener("click", () => setGrowthMode(b.dataset.mode));
  }
  $("footerSource").textContent = state.source.toUpperCase();
  $("refreshBtn").addEventListener("click", () => load(true));
  $("autoToggle").addEventListener("change", (e) => {
    state.auto = e.target.checked;
    startAuto();
  });

  // keep the "updated Xs ago" readout ticking
  setInterval(() => {
    if (state.lastUpdated && $("status").classList.contains("live")) {
      $("statusText").textContent = `updated ${relTime(state.lastUpdated / 1000)} ago`;
    }
  }, 1000);

  load(true);
  startAuto();
}

init();
