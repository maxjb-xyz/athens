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
    else if (seg === "progress") await renderProgress();
    else if (seg === "settings") await renderSettings();
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

// ---------------- markdown ----------------
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function md(src) {
  if (!src) return "";
  const lines = escapeHtml(String(src)).split("\n");
  let html = "";
  let inList = null; // "ul" | "ol" | null
  let para = [];

  const flushPara = () => { if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; } };
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };

  for (const line of lines) {
    const t = line.trim();
    if (!t) { flushPara(); closeList(); continue; }
    let m = t.match(/^[-*•]\s+(.*)$/);
    if (m) {
      flushPara();
      if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; }
      html += `<li>${inlineMd(m[1])}</li>`;
      continue;
    }
    m = t.match(/^\d+[.)]\s+(.*)$/);
    if (m) {
      flushPara();
      if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; }
      html += `<li>${inlineMd(m[1])}</li>`;
      continue;
    }
    m = t.match(/^#{1,4}\s+(.*)$/);
    if (m) { flushPara(); closeList(); html += `<h4>${inlineMd(m[1])}</h4>`; continue; }
    closeList();
    para.push(inlineMd(t));
  }
  flushPara();
  closeList();
  return html;
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
          ${masteryPill(n.status, n.mastery)}
        </div>`).join("")}
    </div></div>
  `;
  wrap.querySelectorAll(".recent-item").forEach((el) =>
    el.addEventListener("click", () => navigate("node/" + el.dataset.id))
  );
}

const pillClass = (s) => s === "ready" ? "pill-ready" : s === "generating" ? "pill-gen" : s === "failed" ? "pill-failed" : "pill-pending";
const statusLabel = (s) => ({ ready: "Ready", generating: "Thinking…", pending: "Not yet", failed: "Failed" }[s] || s);

function masteryPill(status, mastery) {
  if (status === "generating") return `<span class="status-pill pill-gen">Thinking…</span>`;
  if (status === "failed") return `<span class="status-pill pill-failed">Failed</span>`;
  if (status === "pending") return `<span class="status-pill pill-pending">Not started</span>`;
  const m = Math.round((mastery || 0) * 100);
  if (m === 0) return `<span class="status-pill pill-ready">Ready</span>`;
  return `<span class="mastery-pill" data-m="${m}"><span class="mastery-bar"><span class="mastery-fill" style="width:${m}%"></span></span>${m}%</span>`;
}

// ---------------- lesson stepper ----------------
const STEPS = [
  { key: "intro", label: "Intro" },
  { key: "idea", label: "Idea" },
  { key: "example", label: "Example" },
  { key: "pitfall", label: "Pitfall" },
  { key: "diagram", label: "Diagram" },
  { key: "check", label: "Check" },
  { key: "done", label: "Done" },
];

let lessonCtx = null; // { node, step, maxStep, quiz: {index, answers, correct, results} }

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

  lessonCtx = {
    node,
    step: 0,
    maxStep: 0,
    quiz: { index: 0, answers: [], correct: 0, results: null },
    summary: null,
  };
  renderLesson();
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

async function renderLesson() {
  const c = lessonCtx;
  const lesson = c.node.lesson || {};
  const active = STEPS[c.step];
  const hasDiagram = !!lesson.diagram;

  const stepsHtml = STEPS.map((s, i) => {
    const reachable = i <= c.maxStep;
    const isActive = i === c.step;
    const skip = s.key === "diagram" && !hasDiagram;
    const cls = ["step-pill"];
    if (isActive) cls.push("active");
    if (reachable && !isActive) cls.push("seen");
    if (skip) cls.push("skip");
    return `<button class="${cls.join(" ")}" data-i="${i}" ${reachable && !skip ? "" : "disabled"}>${s.label}</button>`;
  }).join("");

  view.innerHTML = `
    <div class="lesson">
      <div class="lesson-crumb">
        <button class="crumb-link" data-nav="map">Map</button><span>/</span><span>${escapeHtml(c.node.title)}</span>
        <span class="crumb-spacer"></span>
        <button class="crumb-link" id="act-edit">Edit</button>
        <button class="crumb-link" id="act-regen">Regenerate</button>
        <button class="crumb-link danger" id="act-del">Delete</button>
      </div>
      <div class="stepper" id="stepper">${stepsHtml}</div>
      <div class="lesson-stage" id="stage"></div>
      <div class="lesson-nav" id="nav"></div>
    </div>
  `;

  document.querySelectorAll("[data-nav='map']").forEach((b) => b.addEventListener("click", () => navigate("map")));
  document.querySelectorAll(".step-pill").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.i;
    if (i <= c.maxStep && !b.disabled) { c.step = i; renderLesson(); }
  }));
  document.getElementById("act-regen").addEventListener("click", async () => {
    if (!confirm("Regenerate this lesson's content? Existing quiz and cards will be replaced.")) return;
    await api(`/api/nodes/${c.node.id}/regenerate`, { method: "POST" });
    navigate("node/" + c.node.id);
  });
  document.getElementById("act-del").addEventListener("click", async () => {
    if (!confirm("Delete this idea and everything connected to it? This can't be undone.")) return;
    await api(`/api/nodes/${c.node.id}`, { method: "DELETE" });
    navigate("map");
  });
  document.getElementById("act-edit").addEventListener("click", () => openEditor());

  await renderStep();
}

function lessonNavHtml(back = true, forward = true, forwardLabel = "Continue") {
  return `
    ${back ? '<button class="btn-secondary" id="nav-back">← Back</button>' : '<span></span>'}
    ${forward ? `<button class="btn-primary" id="nav-fwd">${forwardLabel}</button>` : '<span></span>'}
  `;
}

async function renderStep() {
  const c = lessonCtx;
  const stage = document.getElementById("stage");
  const nav = document.getElementById("nav");
  const lesson = c.node.lesson || {};
  const s = STEPS[c.step];

  stage.innerHTML = "";
  nav.innerHTML = "";

  switch (s.key) {
    case "intro": {
      stage.innerHTML = `
        <div class="step-intro">
          <div class="step-kicker">A new idea</div>
          <h2 class="step-title">${escapeHtml(c.node.title)}</h2>
          <p class="step-summary">${escapeHtml(lesson.summary || c.node.summary || "")}</p>
          <div class="step-toc">
            ${[["Idea", "the plain explanation"], ["Example", "one worked instance"], ["Pitfall", "what trips people up"], ["Check", "3 questions"]].map(([t, d]) => `<div class="toc-row"><span class="toc-t">${t}</span><span class="toc-d">${d}</span></div>`).join("")}
          </div>
        </div>`;
      nav.innerHTML = lessonNavHtml(false, true, "Begin");
      bindNav(1);
      break;
    }
    case "idea": {
      stage.innerHTML = `<div class="step"><div class="step-kicker">The idea</div><h2 class="step-title">In plain words</h2><div class="md step-body">${md(lesson.definition)}</div></div>`;
      nav.innerHTML = lessonNavHtml(true, true);
      bindNav(2);
      break;
    }
    case "example": {
      stage.innerHTML = `<div class="step"><div class="step-kicker">An example</div><h2 class="step-title">Watch it work</h2><div class="md step-body">${md(lesson.worked_example)}</div></div>`;
      nav.innerHTML = lessonNavHtml(true, true);
      bindNav(3);
      break;
    }
    case "pitfall": {
      stage.innerHTML = `<div class="step"><div class="step-kicker">A trap</div><h2 class="step-title">Watch out for this</h2><div class="callout">${md(lesson.misconception)}</div></div>`;
      nav.innerHTML = lessonNavHtml(true, true);
      bindNav(4);
      break;
    }
    case "diagram": {
      if (!lesson.diagram) { c.step++; renderLesson(); return; }
      stage.innerHTML = `<div class="step"><div class="step-kicker">The shape of it</div><h2 class="step-title">At a glance</h2><div class="diagram-box" id="diagram-box"></div></div>`;
      nav.innerHTML = lessonNavHtml(true, true);
      bindNav(5);
      await renderDiagram(lesson.diagram);
      break;
    }
    case "check": {
      renderQuizStep(stage, nav);
      break;
    }
    case "done": {
      await renderDoneStep(stage, nav);
      break;
    }
  }
}

function bindNav(nextStep) {
  const back = document.getElementById("nav-back");
  const fwd = document.getElementById("nav-fwd");
  if (back) back.addEventListener("click", () => { lessonCtx.step--; renderLesson(); });
  if (fwd) fwd.addEventListener("click", () => { advance(nextStep); });
}

function advance(nextStep) {
  const c = lessonCtx;
  c.step = nextStep;
  c.maxStep = Math.max(c.maxStep, nextStep);
  renderLesson();
}

async function renderDiagram(code) {
  const box = document.getElementById("diagram-box");
  if (!box) return;
  try {
    mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: {
      primaryColor: "#f6f0e6", primaryTextColor: "#2f2a24", primaryBorderColor: "#b8552b",
      lineColor: "#6b5f4f", secondaryColor: "#f3dccb", tertiaryColor: "#fffdf8",
      fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "17px",
    }, flowchart: { padding: 14, nodeSpacing: 60, rankSpacing: 60, useMaxWidth: true, htmlLabels: true } });
    const { svg } = await mermaid.render("diagram-" + Math.random().toString(36).slice(2), code);
    box.innerHTML = svg;
  } catch (e) {
    box.innerHTML = `<pre class="diagram-raw">${escapeHtml(code)}</pre>
      <span class="flip-hint">Couldn't render this diagram — showing the source.</span>`;
  }
}

// ---------------- quiz (one question at a time) ----------------
function renderQuizStep(stage, nav) {
  const c = lessonCtx;
  const items = c.node.quiz || [];
  if (!items.length) { stage.innerHTML = '<p class="flip-hint">No quiz for this one.</p>'; nav.innerHTML = lessonNavHtml(true, true); bindNav(6); return; }

  const q = c.quiz;
  nav.innerHTML = "";
  renderQuizQuestion(stage, q, items);
}

function renderQuizQuestion(stage, q, items) {
  const item = items[q.index];
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Check yourself</div>
      <div class="quiz-progress">
        <span class="quiz-count">Question ${q.index + 1} of ${items.length}</span>
        <span class="quiz-track">${items.map((_, i) => `<span class="quiz-dot ${i < q.index ? "seen" : i === q.index ? "current" : ""}"></span>`).join("")}</span>
      </div>
      <div class="quiz-q">
        <div class="qq">${md(item.question)}</div>
        <div class="quiz-opts">
          ${item.options.map((o, oi) => `
            <button class="option" data-oi="${oi}">
              <span class="marker">${String.fromCharCode(65 + oi)}</span><span>${md(o)}</span>
            </button>`).join("")}
        </div>
        <div class="explanation" hidden></div>
        <div class="quiz-nav" hidden>
          ${q.index < items.length - 1 ? '<button class="btn-primary" id="quiz-next">Next</button>' : '<button class="btn-primary" id="quiz-finish">See my score</button>'}
        </div>
      </div>
    </div>`;

  stage.querySelectorAll(".option").forEach((opt) => {
    opt.addEventListener("click", async () => {
      if (q.answers[q.index] !== undefined) return;
      const oi = +opt.dataset.oi;
      q.answers[q.index] = oi;

      const res = await api(`/api/nodes/${lessonCtx.node.id}/quiz/check`, { method: "POST", body: { index: q.index, answer: oi } });
      if (res.correct) q.correct++;

      const qEl = stage.querySelector(".quiz-q");
      qEl.querySelectorAll(".option").forEach((o) => {
        o.disabled = true;
        const oIdx = +o.dataset.oi;
        if (oIdx === res.correct_index) o.classList.add("correct");
        else if (oIdx === oi) o.classList.add("wrong");
        if (oIdx === oi) o.querySelector(".marker").textContent = res.correct ? "✓" : "✗";
      });
      const ex = qEl.querySelector(".explanation");
      ex.hidden = false;
      ex.innerHTML = md(res.explanation);
      qEl.querySelector(".quiz-nav").hidden = false;
    });
  });

  const nextBtn = stage.querySelector("#quiz-next");
  const finishBtn = stage.querySelector("#quiz-finish");
  if (nextBtn) nextBtn.addEventListener("click", () => { q.index++; renderQuizQuestion(stage, q, items); });
  if (finishBtn) finishBtn.addEventListener("click", async () => {
    const res = await api(`/api/nodes/${lessonCtx.node.id}/quiz`, { method: "POST", body: { answers: q.answers } });
    lessonCtx.summary = res;
    lessonCtx.step = 6; lessonCtx.maxStep = 6;
    renderLesson();
  });
}

async function renderDoneStep(stage, nav) {
  const c = lessonCtx;
  const s = c.summary;
  const pct = s ? Math.round(s.score * 100) : null;
  const verdict = pct === null ? "" : pct === 100 ? "Perfect. You've got this." : pct >= 67 ? "Solid. One more pass and it'll stick." : "Keep going. The gaps will close.";

  const data = await api("/api/nodes");
  const prereqIds = data.edges.filter((e) => e.to === c.node.id && e.relation === "prerequisite").map((e) => e.from);
  const extIds = data.edges.filter((e) => e.from === c.node.id && e.relation === "extension").map((e) => e.to);
  const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));

  const relList = (title, ids, rel) => {
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

  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Done</div>
      <h2 class="step-title">${escapeHtml(c.node.title)}</h2>
      ${s ? `
        <div class="quiz-score">
          <div class="quiz-score-big">${s.correct} / ${s.total}</div>
          <div class="quiz-score-sub">${verdict}</div>
          <div class="mastery-pill big" data-m="${Math.round(s.mastery * 100)}"><span class="mastery-bar"><span class="mastery-fill" style="width:${Math.round(s.mastery * 100)}%"></span></span>${Math.round(s.mastery * 100)}% mastery</div>
        </div>` : ""}
      <div class="cards-added">${(c.node.flashcards || []).length} cards added to your review</div>
      <div class="related">
        ${relList("Before you can fully get this", prereqIds, "prereq")}
        ${relList("Where this leads next", extIds, "ext")}
      </div>
    </div>`;
  nav.innerHTML = `<button class="btn-primary" id="nav-fwd">Back to your map</button>`;
  document.getElementById("nav-fwd").addEventListener("click", () => navigate("map"));

  stage.querySelectorAll(".rel-item").forEach((b) => b.addEventListener("click", async () => {
    const cid = b.dataset.id;
    const n = byId[cid];
    if (n && n.status === "pending") await api(`/api/nodes/${cid}/generate`, { method: "POST" });
    navigate("node/" + cid);
  }));
}

// ---------------- edit lesson ----------------
function openEditor() {
  const c = lessonCtx;
  const lesson = c.node.lesson || {};
  const stage = document.getElementById("stage");
  const nav = document.getElementById("nav");
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Edit</div>
      <h2 class="step-title">Fix anything that's off</h2>
      <div class="edit-form">
        <label>Title <input id="ed-title" value="${escapeHtml(c.node.title)}" /></label>
        <label>Summary <textarea id="ed-summary" rows="2">${escapeHtml(lesson.summary || c.node.summary || "")}</textarea></label>
        <label>Definition <textarea id="ed-def" rows="4">${escapeHtml(lesson.definition || "")}</textarea></label>
        <label>Worked example <textarea id="ed-ex" rows="4">${escapeHtml(lesson.worked_example || "")}</textarea></label>
        <label>Misconception <textarea id="ed-mis" rows="3">${escapeHtml(lesson.misconception || "")}</textarea></label>
        <label>Diagram (Mermaid) <textarea id="ed-diagram" rows="5">${escapeHtml(lesson.diagram || "")}</textarea></label>
      </div>
    </div>`;
  nav.innerHTML = `
    <button class="btn-secondary" id="ed-cancel">Cancel</button>
    <button class="btn-primary" id="ed-save">Save changes</button>`;
  document.getElementById("ed-cancel").addEventListener("click", () => renderLesson());
  document.getElementById("ed-save").addEventListener("click", async () => {
    const body = {
      title: document.getElementById("ed-title").value.trim() || null,
      summary: document.getElementById("ed-summary").value.trim() || null,
      definition: document.getElementById("ed-def").value.trim() || null,
      worked_example: document.getElementById("ed-ex").value.trim() || null,
      misconception: document.getElementById("ed-mis").value.trim() || null,
      diagram: document.getElementById("ed-diagram").value.trim() || null,
    };
    await api(`/api/nodes/${c.node.id}`, { method: "PATCH", body });
    render();
  });
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
        <span><span class="legend-dot" style="background:#5b7d5b"></span>Mastered</span>
        <span><span class="legend-dot" style="background:#c9973f"></span>In progress</span>
        <span><span class="legend-dot" style="background:#f3dccb"></span>Not started</span>
      </div>
    </div>`;
  drawGraph(data.nodes, data.edges);
}

function drawGraph(nodes, edges) {
  const svg = document.getElementById("map-svg");
  const W = svg.clientWidth || 1000;
  const H = 640;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const pos = {};
  const spread = Math.min(W, H) / 2.4;
  nodes.forEach((n, i) => {
    pos[n.id] = { x: W / 2 + Math.cos((i / nodes.length) * Math.PI * 2) * spread, y: H / 2 + Math.sin((i / nodes.length) * Math.PI * 2) * spread };
  });

  for (let iter = 0; iter < 140; iter++) {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id === b.id) continue;
        const dx = pos[a.id].x - pos[b.id].x;
        const dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(40, Math.hypot(dx, dy));
        const f = 6000 / (d * d);
        pos[a.id].x += (dx / d) * f; pos[a.id].y += (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 240) * 0.03;
      a.x += (dx / d) * f * 0.5; a.y += (dy / d) * f * 0.5;
      b.x -= (dx / d) * f * 0.5; b.y -= (dy / d) * f * 0.5;
    }
    for (const n of nodes) {
      pos[n.id].x += (W / 2 - pos[n.id].x) * 0.015;
      pos[n.id].y += (H / 2 - pos[n.id].y) * 0.015;
      pos[n.id].x = Math.max(90, Math.min(W - 90, pos[n.id].x));
      pos[n.id].y = Math.max(80, Math.min(H - 80, pos[n.id].y));
    }
  }

  const defs = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#c9973f"/></marker></defs>`;

  const edgeSvg = edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return "";
    const dash = e.relation === "prerequisite" ? "stroke-dasharray:5 5" : "";
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#c9973f" stroke-width="1.8" marker-end="url(#arrow)" ${dash} opacity="0.7"/>`;
  }).join("");

  const nodeSvg = nodes.map((n) => {
    const p = pos[n.id];
    const isRoot = n.kind === "root";
    const pending = n.status === "pending";
    const generating = n.status === "generating";
    const failed = n.status === "failed";
    const m = n.mastery || 0;
    let fill = "#fffdf8", stroke = "#b8552b";
    if (isRoot) { fill = "#b8552b"; stroke = "#96431f"; }
    else if (generating) { fill = "#f3dccb"; stroke = "#b8552b"; }
    else if (failed) { fill = "#f3dede"; stroke = "#c95f5f"; }
    else if (pending) { fill = "#f3dccb"; stroke = "#b8552b"; }
    else if (m >= 0.8) { fill = "#e4ede0"; stroke = "#5b7d5b"; }
    else if (m > 0) { fill = "#f6e8cf"; stroke = "#c9973f"; }
    const txt = n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title;
    const textColor = isRoot ? "#fff7ee" : "#2f2a24";
    const r = isRoot ? 34 : 28;
    return `<g class="map-node" data-id="${n.id}" style="cursor:pointer">
      <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${isRoot ? 2.5 : 1.8}"/>
      <text x="${p.x}" y="${p.y - r - 12}" text-anchor="middle" font-size="14" fill="#4a4236" font-family="Georgia, serif">${escapeHtml(txt)}</text>
      <text x="${p.x}" y="${p.y + 6}" text-anchor="middle" font-size="15" fill="${textColor}" font-family="Georgia, serif" font-weight="600">${isRoot ? "?" : generating ? "…" : "•"}</text>
    </g>`;
  }).join("");

  svg.innerHTML = defs + edgeSvg + nodeSvg;
  svg.querySelectorAll(".map-node").forEach((g) => g.addEventListener("click", () => navigate("node/" + g.dataset.id)));
}

// ---------------- review ----------------
let reviewQueue = [];
let reviewQuizzes = [];

async function renderReview() {
  const data = await api("/api/review");
  reviewQueue = data.cards || [];
  reviewQuizzes = data.quizzes || [];
  if (!reviewQueue.length && !reviewQuizzes.length) {
    view.innerHTML = `<div class="review-wrap"><div class="review-empty">
      <h2>Nothing due right now</h2><p>Come back after you've learned a few things.</p>
      <p style="margin-top:14px"><button class="btn-primary" data-nav="home">Ask a question</button></p>
    </div></div>`;
    view.querySelector("[data-nav='home']").addEventListener("click", () => navigate("home"));
    return;
  }
  // quizzes first (quick re-test), then cards
  if (reviewQuizzes.length) { showReviewQuiz(); return; }
  showReviewCard();
}

function showReviewQuiz() {
  const q = reviewQuizzes[0];
  view.innerHTML = `
    <div class="review-wrap">
      <div class="review-head">
        <h1>Review</h1>
        <p>${reviewQuizzes.length} quiz${reviewQuizzes.length > 1 ? "zes" : ""} due · <em>${escapeHtml(q.title)}</em></p>
      </div>
      <div class="review-quiz-card">
        <p class="rq-title">Your understanding of this idea is due for a re-test.</p>
        <div class="rq-actions">
          <button class="btn-primary" id="rq-go">Re-test now</button>
          <button class="btn-secondary" id="rq-skip">Skip</button>
        </div>
      </div>
    </div>`;
  document.getElementById("rq-go").addEventListener("click", () => navigate("node/" + q.node_id));
  document.getElementById("rq-skip").addEventListener("click", () => { reviewQuizzes.shift(); if (reviewQuizzes.length) showReviewQuiz(); else if (reviewQueue.length) showReviewCard(); else render(); });
}

function showReviewCard() {
  if (!reviewQueue.length) { render(); return; }
  const card = reviewQueue[0];
  const newTag = card.is_new ? '<span class="status-pill pill-gen" style="margin-left:8px">New</span>' : '';
  view.innerHTML = `
    <div class="review-wrap">
      <div class="review-head">
        <h1>Review</h1>
        <p>${reviewQueue.length} card${reviewQueue.length > 1 ? "s" : ""} due · <button class="crumb-link" id="rv-lesson-link">${escapeHtml(card.node_title)}</button>${newTag}</p>
      </div>
      <div class="review-card" id="review-card">
        <div class="flipcard-inner">
          <div class="flipcard-face front">${md(card.front)}</div>
          <div class="flipcard-face back">${md(card.back)}</div>
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

  document.getElementById("rv-lesson-link").addEventListener("click", () => navigate("node/" + card.node_id));

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

// ---------------- progress / stats ----------------
async function renderProgress() {
  const s = await api("/api/stats");
  const pct = s.nodes_ready ? Math.round((s.nodes_mastered / s.nodes_ready) * 100) : 0;
  view.innerHTML = `
    <div class="progress-wrap">
      <div class="progress-head"><h1>Your progress</h1></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${s.streak_days}</div><div class="stat-label">day streak</div></div>
        <div class="stat-card"><div class="stat-num">${s.nodes_mastered}<span class="stat-den">/${s.nodes_ready}</span></div><div class="stat-label">ideas mastered</div></div>
        <div class="stat-card"><div class="stat-num">${s.due_cards}</div><div class="stat-label">cards due</div></div>
        <div class="stat-card"><div class="stat-num">${s.due_quizzes}</div><div class="stat-label">quizzes due</div></div>
      </div>
      <div class="mastery-bar wide"><span class="mastery-fill" style="width:${pct}%"></span></div>
      <p class="progress-sub">${s.nodes_mastered} of ${s.nodes_ready} ready ideas mastered (${pct}%)</p>
      <div class="progress-actions">
        <button class="btn-primary" data-nav="review">Review now</button>
        <button class="btn-secondary" data-nav="home">Ask something new</button>
      </div>
    </div>`;
  view.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.nav)));
}

// ---------------- settings ----------------
async function renderSettings() {
  const s = await api("/api/settings");
  const probe = await api("/api/health/llm");
  const llmStatus = probe.ok
    ? `<span class="status-pill pill-ready">${probe.provider === "mock" ? "mock (offline demo)" : probe.model} · ${probe.latency_ms}ms</span>`
    : `<span class="status-pill pill-failed">unreachable</span>`;
  view.innerHTML = `
    <div class="settings-wrap">
      <div class="progress-head"><h1>Settings</h1></div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Model</span>
          <span>${llmStatus}</span>
        </div>
        <div class="settings-form">
          <label>Provider
            <select id="set-provider">
              <option value="mock" ${s.llm_provider === "mock" ? "selected" : ""}>Mock (offline demo)</option>
              <option value="openai" ${s.llm_provider === "openai" ? "selected" : ""}>OpenAI-compatible (Ollama, OpenAI, DeepSeek…)</option>
            </select>
          </label>
          <label>Model
            <input id="set-model" value="${escapeHtml(s.llm_model || "")}" placeholder="llama3.1:8b" />
          </label>
          <label>Base URL
            <input id="set-base" value="${escapeHtml(s.llm_base_url || "")}" placeholder="http://localhost:11434/v1" />
          </label>
          <label>API key (optional for local Ollama)
            <input id="set-key" type="password" value="${escapeHtml(s.llm_api_key || "")}" placeholder="sk-..." />
          </label>
          <label>New cards per day
            <input id="set-daily" type="number" min="1" max="200" value="${escapeHtml(s.daily_new_limit || "20")}" />
          </label>
          <button class="btn-primary" id="set-save">Save</button>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-row"><span class="settings-label">Your data</span></div>
        <div class="progress-actions">
          <a class="btn-secondary" href="/api/export" download>Export JSON</a>
          <a class="btn-secondary" href="/api/export/anki" download>Export for Anki</a>
        </div>
        <p class="progress-sub">Your whole library is one SQLite file. Export a backup anytime.</p>
      </div>
    </div>`;

  document.getElementById("set-save").addEventListener("click", async () => {
    const body = {
      llm_provider: document.getElementById("set-provider").value,
      llm_model: document.getElementById("set-model").value.trim() || null,
      llm_base_url: document.getElementById("set-base").value.trim() || null,
      llm_api_key: document.getElementById("set-key").value.trim() || null,
      daily_new_limit: parseInt(document.getElementById("set-daily").value, 10) || null,
    };
    await api("/api/settings", { method: "PUT", body });
    render();
  });
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

// wire the persistent header nav (delegated so it survives re-renders)
document.querySelector(".topbar").addEventListener("click", (e) => {
  const target = e.target.closest("[data-nav]");
  if (target) navigate(target.dataset.nav);
});

render();
