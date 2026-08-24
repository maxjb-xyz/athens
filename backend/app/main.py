"""Athens — a self-hostable, question-first AI learning app.

Run the generator in background threads so the API stays responsive while the
LLM produces a lesson. A small in-process queue caps concurrency.
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, generator, srs

app = FastAPI(title="Athens", version="0.1.0")

_executor = ThreadPoolExecutor(max_workers=2)


# --------------------------------------------------------------------------
# request models
# --------------------------------------------------------------------------
class AskRequest(BaseModel):
    question: str
    source: str | None = None


class QuizSubmit(BaseModel):
    answers: list[int]


class ReviewSubmit(BaseModel):
    rating: str  # again|hard|good|easy


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


@app.get("/api/meta")
def meta():
    return {"provider": config.LLM_PROVIDER, "model": config.LLM_MODEL}


@app.post("/api/ask")
def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(400, "question is required")
    conn = db.db()
    source_id = None
    if req.source and req.source.strip():
        source_id = db.new_id()
        title = req.question.strip()[:80]
        conn.execute(
            "INSERT INTO sources (id, title, content, created_at) VALUES (?, ?, ?, ?)",
            (source_id, title, req.source.strip(), db.now()),
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
            # answer is withheld from the client until submission
        }
        for q in conn.execute(
            "SELECT id, question, options, answer FROM quiz_items WHERE node_id = ? ORDER BY rowid",
            (node_id,),
        )
    ]
    cards = [
        {"id": c["id"], "front": c["front"], "back": c["back"], "due": c["due"]}
        for c in conn.execute(
            "SELECT id, front, back, due FROM flashcards WHERE node_id = ? ORDER BY rowid", (node_id,)
        )
    ]
    out = _node_dict(row)
    out["lesson"] = lesson
    out["quiz"] = quiz
    out["flashcards"] = cards
    out["mastery"] = _mastery(node_id)
    out["error"] = row["error"]
    return out


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


@app.post("/api/nodes/{node_id}/quiz")
def submit_quiz(node_id: str, req: QuizSubmit):
    conn = db.db()
    row = conn.execute("SELECT id FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "node not found")
    items = conn.execute(
        "SELECT id, answer, explanation FROM quiz_items WHERE node_id = ? ORDER BY rowid", (node_id,)
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
    total = len(items)
    score = correct / total

    # update the learner model for this node (exponential moving average)
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

    # re-test sooner when shaky, later when solid (hidden scheduler)
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
    updated = srs.review(db.row_to_dict(card), quality)
    conn.execute(
        "UPDATE flashcards SET due=?, interval=?, ease=?, reps=?, lapses=?, state=? WHERE id=?",
        (
            updated["due"],
            updated["interval"],
            updated["ease"],
            updated["reps"],
            updated["lapses"],
            updated["state"],
            card_id,
        ),
    )
    conn.commit()
    return {"id": card_id, **updated}


@app.get("/api/review")
def due_review():
    conn = db.db()
    cards = conn.execute(
        "SELECT f.id, f.front, f.back, f.due, n.title AS node_title "
        "FROM flashcards f JOIN nodes n ON n.id = f.node_id "
        "WHERE f.due <= ? ORDER BY f.due LIMIT 50",
        (db.now(),),
    ).fetchall()
    return {
        "cards": [
            {"id": c["id"], "front": c["front"], "back": c["back"], "node_title": c["node_title"]}
            for c in cards
        ]
    }


@app.get("/api/next")
def next_up():
    return _recommend()


def _recommend() -> dict:
    conn = db.db()
    # 1) due flashcards
    due = conn.execute("SELECT COUNT(*) AS c FROM flashcards WHERE due <= ?", (db.now(),)).fetchone()["c"]
    if due > 0:
        return {"kind": "review", "label": f"{due} card{'s' if due != 1 else ''} ready to review"}
    # 2) lowest-mastery ready node
    ready = conn.execute(
        "SELECT n.id, n.title, COALESCE(m.score, 0) AS score "
        "FROM nodes n LEFT JOIN mastery m ON m.node_id = n.id "
        "WHERE n.status = 'ready' ORDER BY score ASC LIMIT 1"
    ).fetchone()
    if ready and ready["score"] < 0.8:
        return {"kind": "learn", "node_id": ready["id"], "label": f"Strengthen: {ready['title']}"}
    # 3) grow the graph: next pending node
    pending = conn.execute(
        "SELECT id, title FROM nodes WHERE status = 'pending' ORDER BY created_at LIMIT 1"
    ).fetchone()
    if pending:
        return {"kind": "grow", "node_id": pending["id"], "label": f"Explore: {pending['title']}"}
    # 4) all mastered
    return {"kind": "done", "label": "You've mastered everything here. Ask something new."}


# --------------------------------------------------------------------------
# static frontend (served last so /api wins)
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")


@app.on_event("startup")
def _startup():
    db.init()
