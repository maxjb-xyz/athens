"""Athens — a self-hostable, question-first AI learning app.

Single-user. Generation runs on background threads; the API stays responsive.
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, generator, llm, srs

app = FastAPI(title="Athens", version="0.2.0")

_executor = ThreadPoolExecutor(max_workers=2)


# --------------------------------------------------------------------------
# request models
# --------------------------------------------------------------------------
class AskRequest(BaseModel):
    question: str
    source: str | None = None


class QuizSubmit(BaseModel):
    answers: list[int]


class QuizCheck(BaseModel):
    index: int
    answer: int


class ReviewSubmit(BaseModel):
    rating: str  # again|hard|good|easy


class EditNodeRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    definition: str | None = None
    worked_example: str | None = None
    misconception: str | None = None
    diagram: str | None = None


class SettingsRequest(BaseModel):
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    daily_new_limit: int | None = None


class ProgressRequest(BaseModel):
    step: int
    max_step: int


_RATING_TO_QUALITY = {"again": 0, "hard": 3, "good": 4, "easy": 5}


# --------------------------------------------------------------------------
# serializers
# --------------------------------------------------------------------------
def _node_dict(row) -> dict:
    d = db.row_to_dict(row)
    d.pop("content", None)
    d.pop("error", None)
    return d


def _mastery(node_id: str) -> dict:
    row = db.db().execute("SELECT * FROM mastery WHERE node_id = ?", (node_id,)).fetchone()
    if row is None:
        return {"score": 0.0, "attempts": 0, "next_quiz_at": 0}
    return {"score": round(row["score"], 3), "attempts": row["attempts"], "next_quiz_at": row["next_quiz_at"]}


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/health/llm")
def health_llm():
    return llm.probe()


@app.get("/api/meta")
def meta():
    return {"provider": config.LLM_PROVIDER, "model": config.LLM_MODEL}


@app.get("/api/settings")
def get_settings():
    # merge effective values (env/config defaults) with any stored overrides
    effective = {
        "llm_provider": config.LLM_PROVIDER,
        "llm_model": config.LLM_MODEL,
        "llm_base_url": config.LLM_BASE_URL,
        "llm_api_key": config.LLM_API_KEY,
        "daily_new_limit": "20",
    }
    effective.update(db.all_settings())
    return effective


@app.put("/api/settings")
def put_settings(req: SettingsRequest):
    for key, val in req.model_dump().items():
        if val is None:
            continue
        db.set_setting(key, str(val))
    return db.all_settings()


@app.post("/api/ask")
def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(400, "question is required")
    conn = db.db()
    source_id = None
    if req.source and req.source.strip():
        source_id = db.new_id()
        conn.execute(
            "INSERT INTO sources (id, title, content, created_at) VALUES (?, ?, ?, ?)",
            (source_id, req.question.strip()[:80], req.source.strip(), db.now()),
        )
    node_id = db.new_id()
    conn.execute(
        "INSERT INTO nodes (id, title, question, status, kind, source_id, created_at) "
        "VALUES (?, ?, ?, 'generating', 'root', ?, ?)",
        (node_id, req.question.strip()[:120], req.question.strip(), source_id, db.now()),
    )
    conn.commit()
    _executor.submit(generator.generate, node_id)
    return {"id": node_id, "status": "generating"}


@app.get("/api/nodes")
def list_nodes():
    conn = db.db()
    nodes = conn.execute("SELECT * FROM nodes ORDER BY created_at").fetchall()
    edges = conn.execute("SELECT from_id, to_id, relation FROM edges").fetchall()
    mastery = {r["node_id"]: r for r in conn.execute("SELECT * FROM mastery").fetchall()}
    return {
        "nodes": [
            {
                **_node_dict(n),
                "mastery": round(mastery[n["id"]]["score"], 3) if n["id"] in mastery else 0.0,
            }
            for n in nodes
        ],
        "edges": [{"from": e["from_id"], "to": e["to_id"], "relation": e["relation"]} for e in edges],
    }


@app.get("/api/nodes/{node_id}")
def get_node(node_id: str):
    conn = db.db()
    row = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    lesson = {}
    if row["content"]:
        try:
            lesson = json.loads(row["content"])
        except json.JSONDecodeError:
            lesson = {}
    quiz = [
        {
            "id": q["id"],
            "question": q["question"],
            "options": json.loads(q["options"]),
            # answer withheld from the client until submission
        }
        for q in conn.execute(
            "SELECT qi.id, qi.question, qi.options, qi.answer "
            "FROM quiz_items qi LEFT JOIN quiz_stats qs ON qs.quiz_item_id = qi.id "
            "WHERE qi.node_id = ? "
            "ORDER BY qs.times_wrong DESC, qi.rowid",
            (node_id,),
        )
    ]
    cards = [
        {"id": c["id"], "front": c["front"], "back": c["back"], "due": c["due"], "state": c["state"]}
        for c in conn.execute(
            "SELECT id, front, back, due, state FROM flashcards WHERE node_id = ? ORDER BY rowid", (node_id,)
        )
    ]
    out = _node_dict(row)
    out["lesson"] = lesson
    out["quiz"] = quiz
    out["flashcards"] = cards
    out["mastery"] = _mastery(node_id)
    out["error"] = row["error"]
    prog = conn.execute("SELECT step, max_step FROM node_progress WHERE node_id = ?", (node_id,)).fetchone()
    out["progress"] = {"step": prog["step"] if prog else 0, "max_step": prog["max_step"] if prog else 0}
    return out


@app.put("/api/nodes/{node_id}/progress")
def save_progress(node_id: str, req: ProgressRequest):
    conn = db.db()
    row = conn.execute("SELECT id FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    conn.execute(
        "INSERT INTO node_progress (node_id, step, max_step, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(node_id) DO UPDATE SET step=excluded.step, max_step=excluded.max_step, updated_at=excluded.updated_at",
        (node_id, req.step, req.max_step, db.now()),
    )
    conn.commit()
    return {"ok": True}


@app.patch("/api/nodes/{node_id}")
def edit_node(node_id: str, req: EditNodeRequest):
    conn = db.db()
    row = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")

    lesson = {}
    if row["content"]:
        try:
            lesson = json.loads(row["content"])
        except json.JSONDecodeError:
            lesson = {}

    if req.title is not None:
        conn.execute("UPDATE nodes SET title = ? WHERE id = ?", (req.title, node_id))
    if req.summary is not None:
        conn.execute("UPDATE nodes SET summary = ? WHERE id = ?", (req.summary, node_id))
    for field in ("definition", "worked_example", "misconception", "diagram"):
        val = getattr(req, field)
        if val is not None:
            lesson[field] = val
    if any(getattr(req, f) is not None for f in ("definition", "worked_example", "misconception", "diagram")):
        conn.execute("UPDATE nodes SET content = ? WHERE id = ?", (json.dumps(lesson, ensure_ascii=False), node_id))
    conn.commit()
    return {"ok": True}


@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: str):
    conn = db.db()
    row = conn.execute("SELECT id FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    # delete quiz_stats before quiz_items — the cleanup references quiz_items
    conn.execute(
        "DELETE FROM quiz_stats WHERE quiz_item_id IN (SELECT id FROM quiz_items WHERE node_id = ?)",
        (node_id,),
    )
    conn.execute("DELETE FROM quiz_items WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM edges WHERE from_id = ? OR to_id = ?", (node_id, node_id))
    conn.execute("DELETE FROM flashcards WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM mastery WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
    conn.commit()
    return {"ok": True}


@app.post("/api/nodes/{node_id}/generate")
def generate_node(node_id: str):
    conn = db.db()
    row = conn.execute("SELECT status FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    if row["status"] not in ("pending", "failed"):
        raise HTTPException(409, "node is already generating or ready")
    conn.execute("UPDATE nodes SET status = 'generating' WHERE id = ?", (node_id,))
    conn.commit()
    _executor.submit(generator.generate, node_id)
    return {"id": node_id, "status": "generating"}


@app.post("/api/nodes/{node_id}/regenerate")
def regenerate_node(node_id: str):
    """Regenerate a ready node's content (e.g. after a bad hallucination)."""
    conn = db.db()
    row = conn.execute("SELECT status FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    conn.execute("UPDATE nodes SET status = 'generating', error = NULL WHERE id = ?", (node_id,))
    conn.commit()
    _executor.submit(generator.generate, node_id)
    return {"id": node_id, "status": "generating"}


@app.post("/api/nodes/{node_id}/quiz/check")
def check_answer(node_id: str, req: QuizCheck):
    """Grade a single answer immediately, without revealing the whole key."""
    conn = db.db()
    items = conn.execute(
        "SELECT qi.id, qi.answer, qi.explanation "
        "FROM quiz_items qi LEFT JOIN quiz_stats qs ON qs.quiz_item_id = qi.id "
        "WHERE qi.node_id = ? ORDER BY qs.times_wrong DESC, qi.rowid", (node_id,)
    ).fetchall()
    if not items or req.index < 0 or req.index >= len(items):
        raise HTTPException(404, "question not found")
    item = items[req.index]
    return {
        "index": req.index,
        "correct_index": item["answer"],
        "correct": req.answer == item["answer"],
        "explanation": item["explanation"],
    }


@app.post("/api/nodes/{node_id}/quiz")
def submit_quiz(node_id: str, req: QuizSubmit):
    conn = db.db()
    row = conn.execute("SELECT id FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    items = conn.execute(
        "SELECT qi.id, qi.answer, qi.explanation "
        "FROM quiz_items qi LEFT JOIN quiz_stats qs ON qs.quiz_item_id = qi.id "
        "WHERE qi.node_id = ? ORDER BY qs.times_wrong DESC, qi.rowid", (node_id,)
    ).fetchall()
    if not items:
        raise HTTPException(400, "no quiz for this node")

    answers = req.answers
    correct = 0
    results = []
    for i, item in enumerate(items):
        chosen = answers[i] if i < len(answers) else None
        is_correct = chosen == item["answer"]
        if is_correct:
            correct += 1
        results.append(
            {
                "question_id": item["id"],
                "chosen": chosen,
                "correct_index": item["answer"],
                "correct": is_correct,
                "explanation": item["explanation"],
            }
        )
        # per-question tracking
        conn.execute(
            "INSERT INTO quiz_stats (quiz_item_id, times_seen, times_correct, times_wrong) "
            "VALUES (?, 1, ?, ?) "
            "ON CONFLICT(quiz_item_id) DO UPDATE SET times_seen = times_seen + 1, "
            "times_correct = times_correct + ?, times_wrong = times_wrong + ?",
            (item["id"], 1 if is_correct else 0, 1 if not is_correct else 0,
             1 if is_correct else 0, 1 if not is_correct else 0),
        )

    total = len(items)
    score = correct / total

    m = conn.execute("SELECT * FROM mastery WHERE node_id = ?", (node_id,)).fetchone()
    if m is None:
        new_score = score
        attempts = 1
        prev_correct = 0
        prev_total = 0
    else:
        new_score = 0.5 * m["score"] + 0.5 * score
        attempts = m["attempts"] + 1
        prev_correct = m["correct"]
        prev_total = m["total"]

    if score >= 0.8:
        next_quiz_at = db.now() + [3, 7, 14, 30][min(attempts - 1, 3)] * 86400
    else:
        next_quiz_at = db.now() + 12 * 3600

    conn.execute(
        "INSERT INTO mastery (node_id, score, attempts, correct, total, next_quiz_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(node_id) DO UPDATE SET score=excluded.score, attempts=excluded.attempts, "
        "correct=excluded.correct, total=excluded.total, next_quiz_at=excluded.next_quiz_at, "
        "updated_at=excluded.updated_at",
        (node_id, new_score, attempts, prev_correct + correct, prev_total + total, next_quiz_at, db.now()),
    )
    conn.commit()
    db.bump_activity("quiz_attempts", 1)

    return {
        "score": score,
        "correct": correct,
        "total": total,
        "mastery": round(new_score, 3),
        "results": results,
        "next": _recommend(),
    }


@app.post("/api/flashcards/{card_id}")
def review_card(card_id: str, req: ReviewSubmit):
    quality = _RATING_TO_QUALITY.get(req.rating)
    if quality is None:
        raise HTTPException(400, "rating must be again|hard|good|easy")
    conn = db.db()
    card = conn.execute("SELECT * FROM flashcards WHERE id = ?", (card_id,)).fetchone()
    if card is None:
        raise HTTPException(404, "card not found")
    was_new = card["state"] == 0
    updated = srs.review(db.row_to_dict(card), quality)
    conn.execute(
        "UPDATE flashcards SET due=?, interval=?, ease=?, reps=?, lapses=?, state=?, "
        "introduced_at = CASE WHEN ? THEN ? ELSE introduced_at END WHERE id=?",
        (
            updated["due"],
            updated["interval"],
            updated["ease"],
            updated["reps"],
            updated["lapses"],
            updated["state"],
            1 if was_new else 0,
            db.now() if was_new else 0,
            card_id,
        ),
    )
    conn.commit()
    db.bump_activity("card_reviews", 1)
    return {"id": card_id, **updated}


@app.get("/api/review")
def due_review():
    """Due cards: learning/review cards that are due, plus new cards up to the daily budget."""
    conn = db.db()
    now = db.now()
    today = db.today()
    daily_limit = int(db.get_setting("daily_new_limit", "20") or 20)
    introduced_today = conn.execute(
        "SELECT COUNT(*) AS c FROM flashcards WHERE introduced_at >= ?", (start_of_day(),)
    ).fetchone()["c"]
    new_budget = max(0, daily_limit - introduced_today)

    # learning + review cards that are due
    due = conn.execute(
        "SELECT f.id, f.front, f.back, f.due, f.state, n.title AS node_title, n.id AS node_id "
        "FROM flashcards f JOIN nodes n ON n.id = f.node_id "
        "WHERE f.state IN (1, 2) AND f.due <= ? ORDER BY f.due LIMIT 100",
        (now,),
    ).fetchall()
    cards = [
        {"id": c["id"], "front": c["front"], "back": c["back"], "state": c["state"],
         "node_title": c["node_title"], "node_id": c["node_id"], "is_new": False}
        for c in due
    ]
    # new cards, up to budget
    new_cards = conn.execute(
        "SELECT f.id, f.front, f.back, n.title AS node_title, n.id AS node_id "
        "FROM flashcards f JOIN nodes n ON n.id = f.node_id "
        "WHERE f.state = 0 ORDER BY f.node_id, f.rowid LIMIT ?",
        (new_budget,),
    ).fetchall()
    for c in new_cards:
        cards.append({
            "id": c["id"], "front": c["front"], "back": c["back"], "state": 0,
            "node_title": c["node_title"], "node_id": c["node_id"], "is_new": True,
        })

    # due quiz re-tests
    due_quizzes = conn.execute(
        "SELECT n.id, n.title FROM nodes n JOIN mastery m ON m.node_id = n.id "
        "WHERE m.next_quiz_at > 0 AND m.next_quiz_at <= ? AND n.status = 'ready' LIMIT 10",
        (now,),
    ).fetchall()

    return {
        "cards": cards,
        "quizzes": [{"node_id": q["id"], "title": q["title"]} for q in due_quizzes],
    }


@app.get("/api/next")
def next_up():
    return _recommend()


def start_of_day() -> float:
    import datetime
    today = datetime.date.today()
    return datetime.datetime.combine(today, datetime.time.min).timestamp()


def _recommend() -> dict:
    conn = db.db()
    now = db.now()

    # 1) due cards (learning/review that are due, or new cards available)
    due = conn.execute(
        "SELECT COUNT(*) AS c FROM flashcards WHERE state IN (1,2) AND due <= ?", (now,)
    ).fetchone()["c"]
    daily_limit = int(db.get_setting("daily_new_limit", "20") or 20)
    introduced_today = conn.execute(
        "SELECT COUNT(*) AS c FROM flashcards WHERE introduced_at >= ?", (start_of_day(),)
    ).fetchone()["c"]
    new_available = conn.execute("SELECT COUNT(*) AS c FROM flashcards WHERE state = 0").fetchone()["c"]
    if due > 0 or (new_available > 0 and introduced_today < daily_limit):
        return {"kind": "review", "label": "Cards ready to review"}

    # 2) due quiz re-test
    due_quiz = conn.execute(
        "SELECT n.id, n.title FROM nodes n JOIN mastery m ON m.node_id = n.id "
        "WHERE m.next_quiz_at > 0 AND m.next_quiz_at <= ? AND n.status = 'ready' LIMIT 1",
        (now,),
    ).fetchone()
    if due_quiz:
        return {"kind": "quiz", "node_id": due_quiz["id"], "label": f"Re-test: {due_quiz['title']}"}

    # 3) lowest-mastery ready node whose prerequisites are all mastered
    ready = _next_ready_respecting_prereqs(conn)
    if ready and ready["score"] < 0.8:
        return {"kind": "learn", "node_id": ready["id"], "label": f"Strengthen: {ready['title']}"}

    # 4) grow the graph: next pending node whose parent is ready/mastered
    pending = _next_growable_pending(conn)
    if pending:
        return {"kind": "grow", "node_id": pending["id"], "label": f"Explore: {pending['title']}"}

    # 5) all mastered
    return {"kind": "done", "label": "You've mastered everything here. Ask something new."}


def _next_ready_respecting_prereqs(conn) -> dict | None:
    """Return the lowest-mastery ready node whose prerequisites are all mastered."""
    nodes = conn.execute("SELECT n.id, n.title FROM nodes n WHERE n.status = 'ready'").fetchall()
    mastery = {r["node_id"]: r["score"] for r in conn.execute("SELECT node_id, score FROM mastery")}
    edges = conn.execute("SELECT from_id, to_id FROM edges WHERE relation = 'prerequisite'").fetchall()
    prereqs = {}
    for e in edges:
        prereqs.setdefault(e["to_id"], set()).add(e["from_id"])

    candidates = []
    for n in nodes:
        score = mastery.get(n["id"], 0.0)
        if score >= 0.8:
            continue
        deps = prereqs.get(n["id"], set())
        if all(mastery.get(d, 0.0) >= 0.8 for d in deps):
            candidates.append({"id": n["id"], "title": n["title"], "score": score})
    if not candidates:
        return None
    candidates.sort(key=lambda c: c["score"])
    return candidates[0]


def _next_growable_pending(conn) -> dict | None:
    """Return a pending node the learner is ready to explore next.

    A pending prerequisite is growable when the node that depends on it is
    ready (you learn the prerequisite before the dependent). A pending
    extension is growable when its parent is mastered (you extend outward
    after mastering). Falls back to the oldest pending node.
    """
    pending = conn.execute("SELECT id, title FROM nodes WHERE status = 'pending' ORDER BY created_at").fetchall()
    mastery = {r["node_id"]: r["score"] for r in conn.execute("SELECT node_id, score FROM mastery")}
    ready_ids = {r["id"] for r in conn.execute("SELECT id FROM nodes WHERE status = 'ready'")}
    for p in pending:
        # pending prerequisite: growable if its dependent node is ready
        dep = conn.execute(
            "SELECT from_id FROM edges WHERE to_id = ? AND relation = 'prerequisite' LIMIT 1", (p["id"],)
        ).fetchone()
        if dep and dep["from_id"] in ready_ids:
            return {"id": p["id"], "title": p["title"]}
        # pending extension: growable if its parent is mastered
        parent = conn.execute(
            "SELECT to_id FROM edges WHERE from_id = ? AND relation = 'extension' LIMIT 1", (p["id"],)
        ).fetchone()
        if parent and mastery.get(parent["to_id"], 0.0) >= 0.8:
            return {"id": p["id"], "title": p["title"]}
    # fallback: any pending node (oldest first)
    if pending:
        return {"id": pending[0]["id"], "title": pending[0]["title"]}
    return None


# --------------------------------------------------------------------------
# stats + export
# --------------------------------------------------------------------------
@app.get("/api/stats")
def stats():
    conn = db.db()
    now = db.now()
    total = conn.execute("SELECT COUNT(*) AS c FROM nodes").fetchone()["c"]
    ready = conn.execute("SELECT COUNT(*) AS c FROM nodes WHERE status = 'ready'").fetchone()["c"]
    mastered = conn.execute(
        "SELECT COUNT(*) AS c FROM nodes n JOIN mastery m ON m.node_id = n.id WHERE m.score >= 0.8"
    ).fetchone()["c"]
    due_cards = conn.execute(
        "SELECT COUNT(*) AS c FROM flashcards WHERE state IN (1,2) AND due <= ?", (now,)
    ).fetchone()["c"]
    new_cards = conn.execute("SELECT COUNT(*) AS c FROM flashcards WHERE state = 0").fetchone()["c"]
    daily_limit = int(db.get_setting("daily_new_limit", "20") or 20)
    introduced_today = conn.execute(
        "SELECT COUNT(*) AS c FROM flashcards WHERE introduced_at >= ?", (start_of_day(),)
    ).fetchone()["c"]
    due_quizzes = conn.execute(
        "SELECT COUNT(*) AS c FROM nodes n JOIN mastery m ON m.node_id = n.id "
        "WHERE m.next_quiz_at > 0 AND m.next_quiz_at <= ? AND n.status = 'ready'", (now,)
    ).fetchone()["c"]
    streak = _streak(conn)
    return {
        "nodes_total": total,
        "nodes_ready": ready,
        "nodes_mastered": mastered,
        "due_cards": due_cards,
        "new_cards_remaining": max(0, daily_limit - introduced_today),
        "due_quizzes": due_quizzes,
        "streak_days": streak,
    }


def _streak(conn) -> int:
    import datetime
    days = sorted(r["day"] for r in conn.execute(
        "SELECT day FROM daily_activity WHERE card_reviews > 0 OR quiz_attempts > 0"
    ))
    if not days:
        return 0
    today = datetime.date.today()
    streak = 0
    cursor = today
    have = set(days)
    # today may not have activity yet; streak counts back from today or yesterday
    if today.isoformat() not in have:
        cursor = today - datetime.timedelta(days=1)
    while cursor.isoformat() in have:
        streak += 1
        cursor = cursor - datetime.timedelta(days=1)
    return streak


@app.get("/api/export")
def export_json():
    conn = db.db()
    data = {
        "nodes": [db.row_to_dict(r) for r in conn.execute("SELECT * FROM nodes")],
        "edges": [db.row_to_dict(r) for r in conn.execute("SELECT * FROM edges")],
        "flashcards": [db.row_to_dict(r) for r in conn.execute("SELECT * FROM flashcards")],
        "quiz_items": [db.row_to_dict(r) for r in conn.execute("SELECT * FROM quiz_items")],
        "mastery": [db.row_to_dict(r) for r in conn.execute("SELECT * FROM mastery")],
        "sources": [db.row_to_dict(r) for r in conn.execute("SELECT * FROM sources")],
    }
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=athens-export.json"},
    )


@app.get("/api/export/anki")
def export_anki():
    """Export flashcards as a tab-separated text file Anki can import directly."""
    conn = db.db()
    cards = conn.execute("SELECT front, back FROM flashcards ORDER BY node_id").fetchall()
    lines = ["#separator:tab", "#html:true"] + [f"{c['front']}\t{c['back']}" for c in cards]
    return Response(
        content="\n".join(lines),
        media_type="text/plain",
        headers={"Content-Disposition": "attachment; filename=athens-anki.txt"},
    )


# --------------------------------------------------------------------------
# static frontend (served last so /api wins)
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")


@app.on_event("startup")
def _startup():
    db.init()
    # recover nodes stranded mid-generation by a previous process exit
    conn = db.db()
    conn.execute("UPDATE nodes SET status = 'pending' WHERE status = 'generating'")
    conn.commit()
