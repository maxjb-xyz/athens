"use strict";

// ---------------- API ----------------
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed (${res.status})`);
  }
  return res.json();
};

// ---------------- router ----------------
const view = document.getElementById("view");
let currentRoute = null;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [seg, id] = h.split("/");
  return { seg: seg || "home", id };
}

function navigate(path) {
  location.hash = "#/" + path;
}

async function render() {
  const { seg, id } = parseHash();
  currentRoute = { seg, id };
  document.querySelectorAll(".navlink").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === seg || (seg === "node" && b.dataset.nav === "home"));
  });
  try {
    if (seg === "home") await renderHome();
    else if (seg === "map") await renderMap();
    else if (seg === "review") await renderReview();
    else if (seg === "node" && id) await renderNode(id);
    else await renderHome();
  } catch (e) {
    view.innerHTML = `<div class="failed-note">${escapeHtml(e.message)}</div>`;
  }
  refreshDueBadge();
}

window.addEventListener("hashchange", render);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- home ----------------
async function renderHome() {
  view.innerHTML = `
    <div class="ask-hero">
      <div class="ask-eyebrow">Question-first learning</div>
      <h1 class="ask-title">What do you want to understand?</h1>
      <p class="ask-sub">Ask a question. Athens builds you a lesson, tests you on it, and grows a map of everything around it.</p>
    </div>
    <div class="ask-card">
      <textarea id="ask-q" class="ask-input" placeholder="e.g. How does the Fourier transform actually work?" rows="2"></textarea>
      <div><button id="source-toggle" class="source-toggle">+ Paste source material (optional)</button></div>
      <textarea id="ask-source" class="source-input" placeholder="Paste an article, notes, or a textbook excerpt. Athens will ground the lesson in it." hidden></textarea>
      <div class="ask-actions">
        <button id="ask-btn" class="btn-primary">Begin</button>
        <span class="ask-hint">No account. Runs on your own machine.</span>
      </div>
    </div>
    <div id="recent-wrap"></div>
  `;

  const q = document.getElementById("ask-q");
  const src = document.getElementById("ask-source");
  const toggle = document.getElementById("source-toggle");
  const btn = document.getElementById("ask-btn");

  toggle.addEventListener("click", () => {
    const hidden = src.hidden;
    src.hidden = !hidden;
    toggle.textContent = hidden ? "− Hide source material" : "+ Paste source material (optional)";
    if (!hidden) src.focus();
  });

  const doAsk = async () => {
    const question = q.value.trim();
    if (!question) { q.focus(); return; }
    btn.disabled = true; btn.textContent = "Thinking…";
    try {
      const { id } = await api("/api/ask", { method: "POST", body: { question, source: src.value.trim() || null } });
      navigate("node/" + id);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Begin";
      alert(e.message);
    }
  };
  btn.addEventListener("click", doAsk);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doAsk(); } });

  loadRecent();
}

async function loadRecent() {
  const wrap = document.getElementById("recent-wrap");
  const data = await api("/api/nodes");
  const roots = data.nodes.filter((n) => n.kind === "root");
  if (!roots.length) return;
  wrap.innerHTML = `
    <div class="recent"><h2>Your threads</h2><div class="recent-list">
      ${roots.map((n) => `
        <div class="recent-item" data-id="${n.id}">
          <span class="rt">${escapeHtml(n.title)}</span>
          <span class="status-pill ${pillClass(n.status)}">${statusLabel(n.status)}</span>
        </div>`).join("")}
    </div></div>
  `;
  wrap.querySelectorAll(".recent-item").forEach((el) =>
    el.addEventListener("click", () => navigate("node/" + el.dataset.id))
  );
}

const pillClass = (s) => s === "ready" ? "pill-ready" : s === "generating" ? "pill-gen" : s === "failed" ? "pill-failed" : "pill-pending";
const statusLabel = (s) => ({ ready: "Ready", generating: "Thinking…", pending: "Not yet", failed: "Failed" }[s] || s);

// ---------------- node / lesson ----------------
async function renderNode(id) {
  const node = await api("/api/nodes/" + id);
  if (node.status === "generating") {
    view.innerHTML = `<div class="loading"><div class="spinner"></div><p>Building your lesson…</p></div>`;
    pollNode(id);
    return;
  }
  if (node.status === "failed") {
    view.innerHTML = `
      <div class="failed-note">
        <strong>Couldn't build this lesson.</strong><br>${escapeHtml(node.error || "Unknown error")}
        <br><br><button class="btn-primary" id="retry-btn">Try again</button>
      </div>`;
    document.getElementById("retry-btn").addEventListener("click", async () => {
      await api(`/api/nodes/${id}/generate`, { method: "POST" });
      render();
    });
    return;
  }

  const lesson = node.lesson || {};
  view.innerHTML = `
    <div class="lesson">
      <div class="lesson-crumb">
        <button class="crumb-link" data-nav="map">Map</button><span>/</span><span>${escapeHtml(node.title)}</span>
      </div>
      <h2 class="lesson-title">${escapeHtml(node.title)}</h2>
      <p class="lesson-summary">${escapeHtml(lesson.summary || node.summary || "")}</p>

      <div class="prose">
        <h3>In plain words</h3>
        <p>${escapeHtml(lesson.definition || "")}</p>

        <h3>A worked example</h3>
        <p>${escapeHtml(lesson.worked_example || "")}</p>

        <h3>Watch out for this</h3>
        <div class="callout">${escapeHtml(lesson.misconception || "")}</div>

        <h3>The idea at a glance</h3>
        <div class="diagram-box" id="diagram-box"></div>
      </div>

      <h3>Check your understanding</h3>
      <div class="quiz-block" id="quiz-block"></div>

      <h3>Remember these</h3>
      <div class="cards-row" id="cards-row"></div>
      <div class="flip-hint">Tap a card to flip it.</div>

      <div class="related" id="related"></div>
    </div>
  `;

  document.querySelectorAll("[data-nav='map']").forEach((b) => b.addEventListener("click", () => navigate("map")));

  if (lesson.diagram) renderDiagram(lesson.diagram);
  else document.getElementById("diagram-box").innerHTML = '<span class="flip-hint">No diagram for this one.</span>';

  renderQuiz(node);
  renderCards(node);
  renderRelated(node);
}

async function pollNode(id) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) {
    await wait(2500);
    const node = await api("/api/nodes/" + id);
    if (node.status === "ready" || node.status === "failed") { render(); return; }
  }
  render();
}

async function renderDiagram(code) {
  const box = document.getElementById("diagram-box");
  try {
    mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: {
      primaryColor: "#f6f0e6", primaryTextColor: "#2f2a24", primaryBorderColor: "#b8552b",
      lineColor: "#6b5f4f", secondaryColor: "#f3dccb", tertiaryColor: "#fffdf8",
      fontFamily: "Georgia, serif", fontSize: "15px",
    }});
    const { svg } = await mermaid.render("diagram-" + Math.random().toString(36).slice(2), code);
    box.innerHTML = svg;
  } catch (e) {
    box.innerHTML = `<span class="flip-hint">Couldn't render the diagram.</span>`;
  }
}

// ---------------- quiz ----------------
let quizState = { answered: 0, total: 0, answers: [] };

function renderQuiz(node) {
  const block = document.getElementById("quiz-block");
  const items = node.quiz || [];
  if (!items.length) { block.innerHTML = '<p class="flip-hint">No quiz yet.</p>'; return; }
  quizState = { answered: 0, total: items.length, answers: new Array(items.length).fill(null) };
  block.innerHTML = `
    <p class="quiz-intro">${items.length} questions. Pick an answer for each, then submit.</p>
    ${items.map((q, qi) => `
      <div class="quiz-q" data-qi="${qi}">
        <div class="qq">${qi + 1}. ${escapeHtml(q.question)}</div>
        ${q.options.map((o, oi) => `
          <button class="option" data-qi="${qi}" data-oi="${oi}">
            <span class="marker">${String.fromCharCode(65 + oi)}</span><span>${escapeHtml(o)}</span>
          </button>`).join("")}
        <div class="explanation" data-qi="${qi}" hidden></div>
      </div>`).join("")}
    <div class="quiz-submit"><button id="quiz-submit-btn" class="btn-primary" disabled>Submit</button></div>
    <div id="quiz-score"></div>
  `;

  block.querySelectorAll(".option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const qi = +opt.dataset.qi;
      const oi = +opt.dataset.oi;
      const q = block.querySelector(`.quiz-q[data-qi="${qi}"]`);
      q.querySelectorAll(".option").forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");
      quizState.answers[qi] = oi;
      const allAnswered = quizState.answers.every((a) => a !== null);
      document.getElementById("quiz-submit-btn").disabled = !allAnswered;
    });
  });

  document.getElementById("quiz-submit-btn").addEventListener("click", async () => {
    const res = await api(`/api/nodes/${node.id}/quiz`, { method: "POST", body: { answers: quizState.answers } });
    // reveal
    res.results.forEach((r, i) => {
      const q = block.querySelector(`.quiz-q[data-qi="${i}"]`);
      q.querySelectorAll(".option").forEach((o) => {
        const oi = +o.dataset.oi;
        o.disabled = true;
        if (oi === r.correct_index) o.classList.add("correct");
        else if (oi === r.chosen) o.classList.add("wrong");
      });
      const ex = q.querySelector(".explanation");
      ex.hidden = false;
      ex.textContent = r.explanation || "";
    });
    document.getElementById("quiz-submit-btn").style.display = "none";
    const scoreEl = document.getElementById("quiz-score");
    const pct = Math.round(res.score * 100);
    const verdict = pct === 100 ? "Perfect. You've got this." : pct >= 67 ? "Solid. One more pass and it'll stick." : "Keep going. The gaps will close.";
    scoreEl.innerHTML = `
      <div class="quiz-score">
        <strong>${res.correct} of ${res.total} correct</strong> · ${verdict}
        ${res.next && res.next.kind !== "done" ? `<br><br>Next up: <button class="crumb-link" id="next-link">${escapeHtml(res.next.label)}</button>` : ""}
      </div>`;
    const nl = document.getElementById("next-link");
    if (nl) nl.addEventListener("click", () => {
      if (res.next.kind === "review") navigate("review");
      else navigate("node/" + res.next.node_id);
    });
  });
}

// ---------------- flashcards (study) ----------------
function renderCards(node) {
  const row = document.getElementById("cards-row");
  const cards = node.flashcards || [];
  if (!cards.length) { row.innerHTML = '<p class="flip-hint">No flashcards yet.</p>'; return; }
  row.innerHTML = cards.map((c) => `
    <div class="flipcard" data-id="${c.id}">
      <div class="flipcard-inner">
        <div class="flipcard-face front">${escapeHtml(c.front)}</div>
        <div class="flipcard-face back">${escapeHtml(c.back)}</div>
      </div>
    </div>`).join("");
  row.querySelectorAll(".flipcard").forEach((c) => c.addEventListener("click", () => c.classList.toggle("flipped")));
}

// ---------------- related / grow ----------------
async function renderRelated(node) {
  const el = document.getElementById("related");
  const data = await api("/api/nodes");
  const prereqIds = data.edges.filter((e) => e.to === node.id && e.relation === "prerequisite").map((e) => e.from);
  const extIds = data.edges.filter((e) => e.from === node.id && e.relation === "extension").map((e) => e.to);
  const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));

  const col = (title, ids, rel) => {
    if (!ids.length) return "";
    return `<div class="rel-col"><h4>${title}</h4>${ids.map((cid) => {
      const n = byId[cid];
      if (!n) return "";
      return `<button class="rel-item ${n.status === "pending" ? "pending" : ""}" data-id="${cid}">
        <span>${escapeHtml(n.title)}${n.status === "pending" ? ' <span class="rel-tag">(tap to generate)</span>' : ""}</span>
        <span class="rel-arrow">${rel === "prereq" ? "←" : "→"}</span>
      </button>`;
    }).join("")}</div>`;
  };

  el.innerHTML = `
    ${col("Before you can fully get this", prereqIds, "prereq")}
    ${col("Where this leads next", extIds, "ext")}
  `;

  el.querySelectorAll(".rel-item").forEach((b) => b.addEventListener("click", async () => {
    const cid = b.dataset.id;
    const n = byId[cid];
    if (n && n.status === "pending") {
      await api(`/api/nodes/${cid}/generate`, { method: "POST" });
    }
    navigate("node/" + cid);
  }));
}

// ---------------- map ----------------
async function renderMap() {
  const data = await api("/api/nodes");
  if (!data.nodes.length) {
    view.innerHTML = `<div class="map-wrap"><div class="map-head"><h1>Your map</h1></div><div class="empty-note">Nothing here yet. Ask a question to plant the first idea.</div></div>`;
    return;
  }
  view.innerHTML = `
    <div class="map-wrap">
      <div class="map-head"><h1>Your map</h1><p>Ideas you're growing. Click any to open it.</p></div>
      <svg id="map-svg"></svg>
      <div class="map-legend">
        <span><span class="legend-dot" style="background:#b8552b"></span>Your question</span>
        <span><span class="legend-dot" style="background:#fffdf8;border:1.5px solid #b8552b"></span>Ready to learn</span>
        <span><span class="legend-dot" style="background:#f3dccb"></span>Next idea (not generated)</span>
      </div>
    </div>`;
  drawGraph(data.nodes, data.edges);
}

function drawGraph(nodes, edges) {
  const svg = document.getElementById("map-svg");
  const W = svg.clientWidth || 800;
  const H = 560;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const pos = {};
  nodes.forEach((n, i) => {
    pos[n.id] = { x: W / 2 + Math.cos((i / nodes.length) * Math.PI * 2) * (Math.min(W, H) / 3), y: H / 2 + Math.sin((i / nodes.length) * Math.PI * 2) * (Math.min(W, H) / 3) };
  });

  // simple force relax
  for (let iter = 0; iter < 120; iter++) {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id === b.id) continue;
        const dx = pos[a.id].x - pos[b.id].x;
        const dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(20, Math.hypot(dx, dy));
        const f = 2200 / (d * d);
        pos[a.id].x += (dx / d) * f; pos[a.id].y += (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 170) * 0.02;
      a.x += (dx / d) * f * 0.5; a.y += (dy / d) * f * 0.5;
      b.x -= (dx / d) * f * 0.5; b.y -= (dy / d) * f * 0.5;
    }
    for (const n of nodes) {
      pos[n.id].x += (W / 2 - pos[n.id].x) * 0.02;
      pos[n.id].y += (H / 2 - pos[n.id].y) * 0.02;
      pos[n.id].x = Math.max(60, Math.min(W - 60, pos[n.id].x));
      pos[n.id].y = Math.max(50, Math.min(H - 50, pos[n.id].y));
    }
  }

  const defs = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#c9973f"/></marker></defs>`;

  const edgeSvg = edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return "";
    const dash = e.relation === "prerequisite" ? "stroke-dasharray:5 5" : "";
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#c9973f" stroke-width="1.6" marker-end="url(#arrow)" ${dash} opacity="0.7"/>`;
  }).join("");

  const nodeSvg = nodes.map((n) => {
    const p = pos[n.id];
    const isRoot = n.kind === "root";
    const pending = n.status === "pending";
    const generating = n.status === "generating";
    const failed = n.status === "failed";
    const fill = isRoot ? "#b8552b" : pending ? "#f3dccb" : failed ? "#f3dede" : "#fffdf8";
    const stroke = isRoot ? "#96431f" : pending ? "#b8552b" : failed ? "#c95f5f" : "#b8552b";
    const txt = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;
    const textColor = isRoot ? "#fff7ee" : "#2f2a24";
    const r = isRoot ? 30 : 24;
    return `<g class="map-node" data-id="${n.id}" style="cursor:pointer">
      <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${isRoot ? 2.5 : 1.6}"/>
      <text x="${p.x}" y="${p.y - r - 10}" text-anchor="middle" font-size="12.5" fill="#4a4236" font-family="Georgia, serif">${escapeHtml(txt)}</text>
      <text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="13" fill="${textColor}" font-family="Georgia, serif" font-weight="600">${isRoot ? "?" : generating ? "…" : "•"}</text>
    </g>`;
  }).join("");

  svg.innerHTML = defs + edgeSvg + nodeSvg;
  svg.querySelectorAll(".map-node").forEach((g) => g.addEventListener("click", () => navigate("node/" + g.dataset.id)));
}

// ---------------- review ----------------
let reviewQueue = [];

async function renderReview() {
  const data = await api("/api/review");
  reviewQueue = data.cards || [];
  if (!reviewQueue.length) {
    view.innerHTML = `<div class="review-wrap"><div class="review-empty">
      <h2>Nothing due right now</h2><p>Come back after you've learned a few things.</p>
      <p style="margin-top:14px"><button class="btn-primary" data-nav="home">Ask a question</button></p>
    </div></div>`;
    view.querySelector("[data-nav='home']").addEventListener("click", () => navigate("home"));
    return;
  }
  showReviewCard();
}

function showReviewCard() {
  if (!reviewQueue.length) { render(); return; }
  const card = reviewQueue[0];
  view.innerHTML = `
    <div class="review-wrap">
      <div class="review-head">
        <h1>Review</h1>
        <p>${reviewQueue.length} card${reviewQueue.length > 1 ? "s" : ""} due · <em>${escapeHtml(card.node_title)}</em></p>
      </div>
      <div class="review-card" id="review-card">
        <div class="flipcard-inner">
          <div class="flipcard-face front">${escapeHtml(card.front)}</div>
          <div class="flipcard-face back">${escapeHtml(card.back)}</div>
        </div>
      </div>
      <div class="review-meta" id="review-meta">Tap the card to reveal the answer</div>
      <div class="rate-row" id="rate-row" hidden>
        <button class="rate-btn again" data-r="again">Again</button>
        <button class="rate-btn" data-r="hard">Hard</button>
        <button class="rate-btn good" data-r="good">Good</button>
        <button class="rate-btn" data-r="easy">Easy</button>
      </div>
    </div>`;

  const cardEl = document.getElementById("review-card");
  cardEl.addEventListener("click", () => {
    cardEl.classList.toggle("flipped");
    const meta = document.getElementById("review-meta");
    const row = document.getElementById("rate-row");
    if (cardEl.classList.contains("flipped")) {
      meta.textContent = "How well did you remember it?";
      row.hidden = false;
    } else {
      meta.textContent = "Tap the card to reveal the answer";
      row.hidden = true;
    }
  });

  document.querySelectorAll(".rate-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/flashcards/${card.id}`, { method: "POST", body: { rating: b.dataset.r } });
      reviewQueue.shift();
      showReviewCard();
    })
  );
}

// ---------------- due badge ----------------
async function refreshDueBadge() {
  try {
    const data = await api("/api/review");
    const n = (data.cards || []).length;
    const badge = document.getElementById("due-badge");
    if (badge) { badge.hidden = n === 0; badge.textContent = n; }
  } catch (e) { /* ignore */ }
}

// ---------------- boot ----------------
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
render();
