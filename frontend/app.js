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
  const activeNav = seg === "node" ? "home" : seg;
  document.querySelectorAll(".navlink").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === activeNav);
  });
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === activeNav);
  });
  try {
    if (seg === "home") await renderHome();
    else if (seg === "map") await renderMap();
    else if (seg === "progress") await renderProgress();
    else if (seg === "settings") await renderSettings();
    else if (seg === "node" && id) await renderNode(id);
    else await renderHome();
  } catch (e) {
    view.innerHTML = `<div class="failed-note">${escapeHtml(e.message)}</div>`;
  }
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
    if (!t) { flushPara(); continue; }
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

// ---------------- lesson (section / module driven) ----------------
let lessonCtx = null; // { node, blocks, step, maxStep, quiz, summary }

// Flatten the lesson's sections into a linear list of renderable blocks:
// intro -> (each module) -> check (quiz) -> done.
function buildBlocks(node) {
  const lesson = node.lesson || {};
  const blocks = [];
  const toc = [];
  for (const sec of (lesson.sections || [])) {
    const n = (sec.modules || []).length;
    if (n) toc.push({ title: sec.title, count: n });
  }
  blocks.push({
    kind: "intro",
    toc,
    hasQuiz: (node.quiz || []).length > 0,
    hasCards: (node.flashcards || []).length > 0,
  });
  for (const sec of (lesson.sections || [])) {
    for (const m of (sec.modules || [])) {
      blocks.push({ section: sec.title, ...m });
    }
  }
  if ((node.quiz || []).length) blocks.push({ kind: "check" });
  blocks.push({ kind: "done" });
  return blocks;
}

function blockLabel(block) {
  if (block.kind === "intro") return "Intro";
  if (block.kind === "check") return "Test";
  if (block.kind === "done") return "Done";
  const labels = { text: "Explain", example: "Example", pitfall: "Pitfall", diagram: "Diagram", key_terms: "Key terms", summary: "Summary", quiz: "Quick check" };
  return labels[block.type] || "Learn";
}

function stepperHtml(blocks, step, maxStep) {
  const key = (b) => (b.section || "kind:" + b.kind);
  const introCount = blocks.filter(b => b.kind === "intro").length;
  let html = '';
  blocks.forEach((b, i) => {
    if (i > 0 && key(blocks[i-1]) !== key(b)) html += '<span class="stepper-divider"></span>';
    const cls = i < step ? 'seg done' : i === step ? 'seg cur' : 'seg';
    const locked = i > maxStep ? ' locked' : '';
    // the "Intro" section name already sits above the bar, so a lone intro
    // block keeps just its dash instead of a second "Intro" word
    const label = (b.kind === "intro" && introCount === 1) ? '' :
      `<span class="stepper-label">${escapeHtml(blockLabel(b))}</span>`;
    html += `<span class="stepper-dash-group">${label}<button class="${cls}${locked}" data-step="${i}" title="${escapeHtml(blockLabel(b))}"${locked ? ' disabled' : ''}></button></span>`;
  });
  return html;
}

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
  if (node.status === "pending") {
    // an ungenerated concept (a suggested prerequisite/extension) — generate it
    await api(`/api/nodes/${id}/generate`, { method: "POST" }).catch(() => {});
    view.innerHTML = `<div class="loading"><div class="spinner"></div><p>Building your lesson…</p></div>`;
    pollNode(id);
    return;
  }

  const blocks = buildBlocks(node);
  const done = node.mastery && node.mastery.attempts > 0;
  const saved = node.progress ? node.progress.step : 0;
  const startStep = done ? blocks.length - 1 : (saved > 0 && saved < blocks.length ? saved : 0);
  lessonCtx = {
    node,
    blocks,
    step: startStep,
    maxStep: done || saved > 0 ? blocks.length - 1 : 0,
    quiz: { index: 0, answers: [], correct: 0, results: null },
    summary: null,
  };
  renderLesson();
}

// persist per-node lesson progress on the server so it survives browser and
// device changes, not just this browser's localStorage
function saveProgress(nodeId, step) {
  api(`/api/nodes/${nodeId}/progress`, {
    method: "PUT",
    body: { step, max_step: lessonCtx.blocks.length - 1 },
  }).catch(() => { /* best-effort; don't interrupt the learner */ });
}

async function pollNode(id) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    await wait(2000);
    const node = await api("/api/nodes/" + id);
    if (node.status === "ready" || node.status === "failed") { render(); return; }
  }
  // safety valve — give up after ~5 minutes and let the user retry
  render();
}

async function renderLesson() {
  const c = lessonCtx;
  const blocks = c.blocks;
  const total = blocks.length;

  const curBlock = blocks[c.step];
  const curSection = curBlock.section || blockLabel(curBlock);

  view.innerHTML = `
    <div class="lesson">
      <div class="lesson-crumb">
        <button class="crumb-link" data-nav="map">← Map</button>
        <span class="crumb-spacer"></span>
        <button class="crumb-link" id="act-review">Review</button>
        <button class="crumb-link" id="act-edit">Edit</button>
        <button class="crumb-link" id="act-regen">Regenerate</button>
        <button class="crumb-link danger" id="act-del">Delete</button>
      </div>
      <div class="stepper">
        <div class="stepper-head">
          <span class="stepper-sec">${escapeHtml(curSection)}</span>
          <span class="stepper-count">${c.step + 1} / ${total}</span>
        </div>
        <div class="stepper-segs">${stepperHtml(blocks, c.step, c.maxStep)}</div>
      </div>
      <div class="lesson-stage" id="stage"></div>
      <div class="lesson-nav" id="nav"></div>
    </div>
  `;

  view.querySelectorAll(".stepper .seg:not(.locked)").forEach((b) => {
    b.addEventListener("click", () => {
      lessonCtx.step = parseInt(b.dataset.step, 10);
      saveProgress(lessonCtx.node.id, lessonCtx.step);
      renderLesson();
    });
  });

  document.querySelectorAll("[data-nav='map']").forEach((b) => b.addEventListener("click", () => navigate("map")));
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
  document.getElementById("act-review").addEventListener("click", () => openReviewChooser());

  await renderBlock();
}

function lessonNavHtml(back = true, forward = true, forwardLabel = "Continue") {
  return `
    ${back ? '<button class="btn-secondary" id="nav-back">← Back</button>' : '<span></span>'}
    ${forward ? `<button class="btn-primary" id="nav-fwd">${forwardLabel}</button>` : '<span></span>'}
  `;
}

function bindNav() {
  const back = document.getElementById("nav-back");
  const fwd = document.getElementById("nav-fwd");
  if (back) back.addEventListener("click", () => { lessonCtx.step--; renderLesson(); });
  if (fwd) fwd.addEventListener("click", () => advance());
}

function advance() {
  const c = lessonCtx;
  c.step++;
  c.maxStep = Math.max(c.maxStep, c.step);
  saveProgress(c.node.id, c.step);
  renderLesson();
}

async function renderBlock() {
  const c = lessonCtx;
  const stage = document.getElementById("stage");
  const nav = document.getElementById("nav");
  const block = c.blocks[c.step];

  stage.innerHTML = "";
  nav.innerHTML = "";

  if (block.kind === "intro") {
    const toc = block.toc.length
      ? block.toc.map((s) => `<div class="toc-row"><span class="toc-t">${escapeHtml(s.title || "—")}</span><span class="toc-d">${s.count} part${s.count > 1 ? "s" : ""}</span></div>`).join("")
      : "";
    stage.innerHTML = `
      <div class="step-intro">
        <div class="step-kicker">A new idea</div>
        <h2 class="step-title">${escapeHtml(c.node.title)}</h2>
        <p class="step-summary">${escapeHtml(c.node.summary || (c.node.lesson && c.node.lesson.summary) || "")}</p>
        ${toc ? `<div class="step-toc">${toc}</div>` : ""}
      </div>`;
    nav.innerHTML = lessonNavHtml(false, true, "Begin");
    bindNav();
    return;
  }

  if (block.kind === "check") {
    renderQuizStep(stage, nav);
    return;
  }

  if (block.kind === "done") {
    await renderDoneStep(stage, nav);
    return;
  }

  // content modules
  const heading = block.heading || blockLabel(block);
  switch (block.type) {
    case "text":
    case "example":
    case "summary":
      stage.innerHTML = `<div class="step"><div class="step-kicker">${escapeHtml(block.section || blockLabel(block))}</div><h2 class="step-title">${escapeHtml(heading)}</h2><div class="md step-body">${md(block.body)}</div></div>`;
      break;
    case "pitfall":
      stage.innerHTML = `<div class="step"><div class="step-kicker">${escapeHtml(block.section || "Pitfall")}</div><h2 class="step-title">${escapeHtml(heading || "Watch out")}</h2>
        <div class="callout trap"><strong>The trap:</strong> ${md(block.trap)}</div>
        <div class="callout truth"><strong>The truth:</strong> ${md(block.truth)}</div></div>`;
      break;
    case "diagram":
      stage.innerHTML = `<div class="step"><div class="step-kicker">${escapeHtml(block.section || "Diagram")}</div><h2 class="step-title">${escapeHtml(heading || "At a glance")}</h2><div class="diagram-box" id="diagram-box"></div></div>`;
      break;
    case "key_terms":
      stage.innerHTML = `<div class="step"><div class="step-kicker">${escapeHtml(block.section || "Key terms")}</div><h2 class="step-title">${escapeHtml(heading || "Words to know")}</h2>
        <div class="keyterms">${(block.items || []).map((it) => `<div class="keyterm"><span class="kt-t">${escapeHtml(it.term)}</span><span class="kt-d">${escapeHtml(it.def)}</span></div>`).join("")}</div></div>`;
      break;
    case "quiz":
      renderInlineQuiz(stage, block);
      break;
    default:
      stage.innerHTML = `<div class="step"><p class="flip-hint">(unknown module)</p></div>`;
  }
  nav.innerHTML = lessonNavHtml(true, true);
  bindNav();
  if (block.type === "diagram") await renderDiagram(block.body);
}

async function renderDiagram(code) {
  const box = document.getElementById("diagram-box");
  if (!box) return;
  try {
    mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: {
      primaryColor: "#f6f0e6", primaryTextColor: "#2f2a24", primaryBorderColor: "#b8552b",
      lineColor: "#6b5f4f", secondaryColor: "#f3dccb", tertiaryColor: "#fffdf8",
      // must match the CSS-rendered font, or mermaid under-measures and clips
      fontFamily: "Source Serif 4, Georgia, 'Times New Roman', serif", fontSize: "15px",
    }, flowchart: { padding: 16, nodeSpacing: 80, rankSpacing: 80, useMaxWidth: true } });
    const { svg } = await mermaid.render("diagram-" + Math.random().toString(36).slice(2), code);
    box.innerHTML = svg;
    // mermaid sizes foreignObject boxes from SVG text metrics, which are a
    // bit narrower than the HTML the label actually renders as — so text can
    // clip. Measure each label's real scrollWidth and widen the box to fit.
    requestAnimationFrame(() => {
      const svgEl = box.querySelector("svg");
      if (!svgEl) return;
      svgEl.querySelectorAll(".node").forEach((node) => {
        const fo = node.querySelector("foreignObject");
        const label = node.querySelector(".nodeLabel");
        const rect = node.querySelector("rect.label-container, rect");
        if (!fo || !label || !rect) return;
        // getBoundingClientRect reports the full nowrap text width even when
        // the foreignObject viewport clips it — that's the width we need
        const need = Math.ceil(label.getBoundingClientRect().width) + 8;
        const curW = parseFloat(fo.getAttribute("width")) || 0;
        const curX = parseFloat(fo.getAttribute("x")) || 0;
        const rectW = parseFloat(rect.getAttribute("width")) || 0;
        const rectX = parseFloat(rect.getAttribute("x")) || 0;
        if (need > curW) {
          const grow = need - curW;
          fo.setAttribute("width", need);
          fo.setAttribute("x", curX - grow / 2);
          rect.setAttribute("width", rectW + grow);
          rect.setAttribute("x", rectX - grow / 2);
        }
      });
    });
  } catch (e) {
    box.innerHTML = `<pre class="diagram-raw">${escapeHtml(code)}</pre>
      <span class="flip-hint">Couldn't render this diagram — showing the source.</span>`;
  }
}

// ---------------- quiz (one question at a time) ----------------
// Inline quiz module: quick self-check with instant feedback. The answer is
// embedded in the module (unlike the graded test), so this grades locally and
// does not touch mastery.
function renderInlineQuiz(stage, block) {
  const items = block.items || [];
  if (!items.length) { stage.innerHTML = '<p class="flip-hint">(empty quiz)</p>'; return; }
  const heading = block.heading || block.section || "Quick check";
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">${escapeHtml(block.section || "Quick check")}</div>
      <h2 class="step-title">${escapeHtml(heading)}</h2>
      <div class="quiz-progress">
        <span class="quiz-count">${items.length} quick check${items.length > 1 ? "s" : ""}</span>
      </div>
      <div id="inline-quiz"></div>
    </div>`;
  const wrap = stage.querySelector("#inline-quiz");
  let idx = 0;
  const renderItem = () => {
    if (idx >= items.length) {
      wrap.innerHTML = '<p class="flip-hint">All checked. Continue when ready.</p>';
      return;
    }
    const item = items[idx];
    wrap.innerHTML = `
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
          <button class="btn-primary" id="iq-next">${idx < items.length - 1 ? "Next" : "Done"}</button>
        </div>
      </div>`;
    wrap.querySelectorAll(".option").forEach((opt) => {
      opt.addEventListener("click", () => {
        if (opt.disabled) return;
        const oi = +opt.dataset.oi;
        wrap.querySelectorAll(".option").forEach((o) => {
          o.disabled = true;
          if (+o.dataset.oi === item.answer) o.classList.add("correct");
          else if (+o.dataset.oi === oi) o.classList.add("wrong");
        });
        const ex = wrap.querySelector(".explanation");
        ex.hidden = false;
        ex.innerHTML = md(item.explanation);
        wrap.querySelector(".quiz-nav").hidden = false;
      });
    });
    wrap.querySelector("#iq-next").addEventListener("click", () => { idx++; renderItem(); });
  };
  renderItem();
}
function renderQuizStep(stage, nav) {
  const c = lessonCtx;
  const items = c.node.quiz || [];
  if (!items.length) { stage.innerHTML = '<p class="flip-hint">No quiz for this one.</p>'; nav.innerHTML = lessonNavHtml(true, true); bindNav(); return; }

  const q = c.quiz;
  nav.innerHTML = "";
  renderQuizQuestion(stage, q, items);
}

function renderQuizQuestion(stage, q, items) {
  const item = items[q.index];
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Test yourself</div>
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
    lessonCtx.step = lessonCtx.blocks.length - 1; // jump to done
    lessonCtx.maxStep = lessonCtx.blocks.length - 1;
    saveProgress(lessonCtx.node.id, lessonCtx.step);
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
  // edit the live content shape: sections/modules + test + flashcards.
  // title/summary get dedicated fields; everything else is raw JSON.
  const contentOnly = { ...lesson };
  delete contentOnly.title;
  delete contentOnly.summary;
  const raw = JSON.stringify(contentOnly, null, 2) || "{}";
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Edit</div>
      <h2 class="step-title">Fix anything that's off</h2>
      <div class="edit-form">
        <label>Title <input id="ed-title" value="${escapeHtml(c.node.title)}" /></label>
        <label>Summary <textarea id="ed-summary" rows="2">${escapeHtml(lesson.summary || c.node.summary || "")}</textarea></label>
        <label>Content (JSON — sections, test, flashcards)
          <textarea id="ed-content" rows="18" spellcheck="false">${escapeHtml(raw)}</textarea>
        </label>
        <p class="progress-sub">Edit the structure freely: add/remove/reorder modules of any type. <code>quiz</code> modules are inline checks; <code>test</code> is the graded final check.</p>
      </div>
    </div>`;
  nav.innerHTML = `
    <button class="btn-secondary" id="ed-cancel">Cancel</button>
    <button class="btn-primary" id="ed-save">Save changes</button>`;
  document.getElementById("ed-cancel").addEventListener("click", () => renderLesson());
  document.getElementById("ed-save").addEventListener("click", async () => {
    let content = null;
    try {
      content = JSON.parse(document.getElementById("ed-content").value);
    } catch (e) {
      alert("Content isn't valid JSON: " + e.message);
      return;
    }
    const body = {
      title: document.getElementById("ed-title").value.trim() || null,
      summary: document.getElementById("ed-summary").value.trim() || null,
      content,
    };
    await api(`/api/nodes/${c.node.id}`, { method: "PATCH", body });
    render();
  });
}

// ---------------- map ----------------
function isMobile() {
  return window.matchMedia("(max-width: 640px)").matches;
}

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
  if (isMobile()) {
    renderMapList(data.nodes);
  } else {
    drawGraph(data.nodes, data.edges);
  }
}

function renderMapList(nodes) {
  const svg = document.getElementById("map-svg");
  svg.style.display = "none";
  document.querySelector(".map-legend").style.display = "none";
  const order = { root: 0, ready: 1, pending: 2, failed: 3 };
  const sorted = [...nodes].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  const list = document.createElement("div");
  list.className = "map-list";
  list.innerHTML = sorted.map((n) => {
    const mastery = n.mastery ? Math.round(n.mastery * 100) : 0;
    let pill;
    if (n.status === "failed") pill = '<span class="status-pill pill-failed">failed</span>';
    else if (n.status === "generating") pill = '<span class="status-pill pill-gen">building…</span>';
    else if (n.status === "pending") pill = '<span class="status-pill pill-pending">to explore</span>';
    else pill = `<span class="mastery-pill"><span class="mastery-bar"><span class="mastery-fill" style="width:${mastery}%"></span></span>${mastery}%</span>`;
    return `<button class="map-list-item" data-id="${n.id}">
      <span class="mli-title">${escapeHtml(n.title)}</span>${pill}
    </button>`;
  }).join("");
  svg.insertAdjacentElement("afterend", list);
  list.querySelectorAll(".map-list-item").forEach((b) => b.addEventListener("click", () => navigate("node/" + b.dataset.id)));
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

// ---------------- review (per-lesson) ----------------
function openReviewChooser() {
  const c = lessonCtx;
  const hasCards = (c.node.flashcards || []).length > 0;
  const hasQuiz = (c.node.quiz || []).length > 0;
  const stage = document.getElementById("stage");
  const nav = document.getElementById("nav");
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Review</div>
      <h2 class="step-title">${escapeHtml(c.node.title)}</h2>
      <p class="step-sub">How do you want to review this idea?</p>
      <div class="review-chooser">
        <button class="chooser-card" id="rv-cards" ${hasCards ? "" : "disabled"}>
          <div class="chooser-title">Flashcards</div>
          <div class="chooser-sub">${hasCards ? c.node.flashcards.length + " card" + (c.node.flashcards.length > 1 ? "s" : "") : "No cards yet"}</div>
        </button>
        <button class="chooser-card" id="rv-quiz" ${hasQuiz ? "" : "disabled"}>
          <div class="chooser-title">Quiz</div>
          <div class="chooser-sub">${hasQuiz ? c.node.quiz.length + " question" + (c.node.quiz.length > 1 ? "s" : "") : "No quiz yet"}</div>
        </button>
      </div>
    </div>`;
  nav.innerHTML = `<button class="btn-secondary" id="nav-back">← Back</button>`;
  document.getElementById("nav-back").addEventListener("click", () => renderLesson());
  if (hasCards) document.getElementById("rv-cards").addEventListener("click", () => reviewLessonCards());
  if (hasQuiz) document.getElementById("rv-quiz").addEventListener("click", () => reviewLessonQuiz());
}

function reviewLessonQuiz() {
  // jump to the graded test block and re-take it
  const c = lessonCtx;
  const idx = c.blocks.findIndex((b) => b.kind === "check");
  if (idx >= 0) { c.step = idx; c.maxStep = Math.max(c.maxStep, idx); }
  renderLesson();
}

function reviewLessonCards() {
  const c = lessonCtx;
  c._cards = (c.node.flashcards || []).slice();
  c._cardIdx = 0;
  showLessonCard();
}

function showLessonCard() {
  const c = lessonCtx;
  const stage = document.getElementById("stage");
  const nav = document.getElementById("nav");
  if (c._cardIdx >= c._cards.length) {
    stage.innerHTML = `<div class="step"><div class="step-kicker">Review</div><h2 class="step-title">Cards done</h2><p class="step-sub">You reviewed ${c._cards.length} card${c._cards.length > 1 ? "s" : ""} for this idea.</p></div>`;
    nav.innerHTML = `<button class="btn-primary" id="nav-fwd">Back to lesson</button>`;
    document.getElementById("nav-fwd").addEventListener("click", () => renderLesson());
    return;
  }
  const card = c._cards[c._cardIdx];
  stage.innerHTML = `
    <div class="step">
      <div class="step-kicker">Flashcard ${c._cardIdx + 1} of ${c._cards.length}</div>
      <div class="review-card flipcard" id="review-card">
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
  nav.innerHTML = "";

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
      c._cardIdx++;
      showLessonCard();
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
        <button class="btn-primary" data-nav="home">Ask something new</button>
      </div>
    </div>`;
  view.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.nav)));
}

// ---------------- settings ----------------
async function renderSettings() {
  const s = await api("/api/settings");
  view.innerHTML = `
    <div class="settings-wrap">
      <div class="progress-head"><h1>Settings</h1></div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Model</span>
          <span id="llm-status"><span class="status-pill pill-gen">checking…</span></span>
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

  // fire the LLM probe asynchronously — it can take several seconds with a
  // local model and we don't want to block the page render on it
  api("/api/health/llm").then((probe) => {
    const el = document.getElementById("llm-status");
    if (!el) return;
    const label = probe.ok
      ? (probe.provider === "mock" ? "mock (offline demo)" : probe.model) + " · " + probe.latency_ms + "ms"
      : "unreachable";
    const cls = probe.ok ? "pill-ready" : "pill-failed";
    el.innerHTML = `<span class="status-pill ${cls}">${label}</span>`;
  }).catch(() => {
    const el = document.getElementById("llm-status");
    if (el) el.innerHTML = '<span class="status-pill pill-failed">unreachable</span>';
  });
}

// ---------------- boot ----------------
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

// wire the persistent header + tab-bar nav (delegated so it survives re-renders)
document.addEventListener("click", (e) => {
  const target = e.target.closest(".topbar [data-nav], .tabbar [data-nav]");
  if (target) navigate(target.dataset.nav);
});

render();
