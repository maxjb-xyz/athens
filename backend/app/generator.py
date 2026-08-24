"""Generation pipeline: turn a question into a structured, stored lesson.

A node starts `pending`, flips to `generating` while the LLM runs, then to
`ready` once its content, quiz items, flashcards and related (pending) child
nodes are persisted. Failures land on `failed` with the error message.
"""
import json
import logging

from . import db, llm, prompts

log = logging.getLogger("athens.generator")


def _persist_lesson(node_id: str, lesson: dict) -> None:
    conn = db.db()
    # replace quiz items
    conn.execute("DELETE FROM quiz_items WHERE node_id = ?", (node_id,))
    for q in lesson.get("quiz", []):
        conn.execute(
            "INSERT INTO quiz_items (id, node_id, question, options, answer, explanation) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                db.new_id(),
                node_id,
                q.get("question", ""),
                json.dumps(q.get("options", [])),
                int(q.get("answer", 0)),
                q.get("explanation", ""),
            ),
        )
    # replace flashcards
    conn.execute("DELETE FROM flashcards WHERE node_id = ?", (node_id,))
    for f in lesson.get("flashcards", []):
        conn.execute(
            "INSERT INTO flashcards (id, node_id, front, back, due, interval, ease, reps, lapses, state) "
            "VALUES (?, ?, ?, ?, 0, 0, 2.5, 0, 0, 0)",
            (db.new_id(), node_id, f.get("front", ""), f.get("back", "")),
        )
    # store the raw lesson (for the read/rendering path)
    conn.execute(
        "UPDATE nodes SET content = ? WHERE id = ?",
        (json.dumps(lesson, ensure_ascii=False), node_id),
    )
    conn.commit()


def _spawn_related(node_id: str, lesson: dict) -> None:
    """Create pending child nodes for prerequisites and extensions, linked by edges."""
    conn = db.db()
    prereqs = lesson.get("prerequisites", []) or []
    extensions = lesson.get("extensions", []) or []
    for title in prereqs:
        _new_related(conn, node_id, title, "prerequisite")
    for title in extensions:
        _new_related(conn, node_id, title, "extension")
    conn.commit()


def _new_related(conn, parent_id: str, title: str, relation: str) -> None:
    title = (title or "").strip()
    if not title:
        return
    child_id = db.new_id()
    conn.execute(
        "INSERT INTO nodes (id, title, status, kind, created_at) VALUES (?, ?, 'pending', ?, ?)",
        (child_id, title, relation, db.now()),
    )
    # edge direction: prerequisite -> parent (you need it first), parent -> extension
    if relation == "prerequisite":
        conn.execute(
            "INSERT OR IGNORE INTO edges (from_id, to_id, relation) VALUES (?, ?, ?)",
            (child_id, parent_id, "prerequisite"),
        )
    else:
        conn.execute(
            "INSERT OR IGNORE INTO edges (from_id, to_id, relation) VALUES (?, ?, ?)",
            (parent_id, child_id, "extension"),
        )


def generate(node_id: str) -> None:
    conn = db.db()
    row = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    question = row["question"] or row["title"]

    source_text = None
    if row["source_id"]:
        src = conn.execute(
            "SELECT content FROM sources WHERE id = ?", (row["source_id"],)
        ).fetchone()
        if src:
            source_text = src["content"]

    conn.execute("UPDATE nodes SET status = 'generating', error = NULL WHERE id = ?", (node_id,))
    conn.commit()

    try:
        lesson = llm.complete_json(
            prompts.SYSTEM_PROMPT, prompts.build_user_prompt(question, source_text), question
        )
        # minimal validation of the shape we rely on
        if not isinstance(lesson, dict):
            raise ValueError("LLM returned a non-object payload")
        for key in ("definition", "worked_example", "misconception", "diagram"):
            if not lesson.get(key):
                lesson[key] = f"({key.replace('_', ' ')} not generated)"
        lesson["quiz"] = lesson.get("quiz") or []
        lesson["flashcards"] = lesson.get("flashcards") or []
        lesson["title"] = lesson.get("title") or row["title"]
        lesson["summary"] = lesson.get("summary") or ""

        _persist_lesson(node_id, lesson)
        _spawn_related(node_id, lesson)
        conn.execute("UPDATE nodes SET status = 'ready', summary = ? WHERE id = ?",
                     (lesson["summary"], node_id))
        conn.commit()
        log.info("node %s ready", node_id)
    except Exception as exc:  # noqa: BLE001 - surface any failure to the node
        log.exception("generation failed for node %s", node_id)
        conn.execute("UPDATE nodes SET status = 'failed', error = ? WHERE id = ?",
                     (str(exc)[:1000], node_id))
        conn.commit()
