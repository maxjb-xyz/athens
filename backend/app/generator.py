"""Generation pipeline: turn a question into a structured, stored lesson.

A node starts `pending`, flips to `generating` while the LLM runs, then to
`ready` once its content, quiz items, flashcards and related (pending) child
nodes are persisted. Failures land on `failed` with the error message.
"""
import json
import logging
import re

from . import db, llm, prompts

log = logging.getLogger("athens.generator")


def _clean_diagram(code: str) -> str:
    """Normalize LLM-emitted Mermaid so it actually renders as a flowchart.

    Models drift into sequence-diagram arrows (->>, -->>, -.->>) and wrap the
    block in fences. Strip the fences and map invalid arrows to valid flowchart
    syntax, keeping everything else untouched.
    """
    if not code:
        return ""
    code = code.strip()
    # strip ```mermaid / ``` fences
    code = re.sub(r"^```(?:mermaid)?\s*", "", code, flags=re.IGNORECASE)
    code = re.sub(r"\s*```$", "", code)
    code = code.strip()

    # sequence-diagram arrows -> flowchart arrows
    code = code.replace("-.->>", "-.->")
    code = code.replace("-->>", "-->")
    code = code.replace("->>", "-->")
    code = code.replace("<<->>", "---")

    # single-dash arrows -> double (but not inside an existing multi-dash arrow,
    # and not the valid dotted -.-> form)
    code = re.sub(r"(?<![-.|>])->(?!>)", "-->", code)
    # stray trailing dash before a label or end: "-->-|", "-->-"  ->  "-->"
    code = re.sub(r"-->-+(?=[|\s])", "-->", code)
    code = re.sub(r"==>-+(?=[|\s])", "==>", code)

    # models sometimes write -->|label|> instead of -->|label|
    code = code.replace("|> ", "| ").replace("|>\n", "|\n").replace("|>", "|")
    # join lines that were split wrongly:
    #   - previous line ends with "|"  (arrow split after its label)
    #   - this line starts with an arrow (arrow split onto its own line)
    lines = code.split("\n")
    merged = []
    for line in lines:
        stripped = line.strip()
        starts_arrow = bool(re.match(r"^(?:-->|==>|-\.->|--o|--x)", stripped))
        if merged and (merged[-1].rstrip().endswith("|") or starts_arrow):
            merged[-1] = merged[-1].rstrip() + " " + stripped
        else:
            merged.append(line)
    code = "\n".join(merged)
    # quote bare node labels that contain spaces (Mermaid rejects them unquoted).
    # skip the first line (the "flowchart TD" directive).
    lines = code.split("\n")
    out_lines = [lines[0]] if lines else []
    for line in lines[1:]:
        out_lines.append(_quote_bare_labels(line))
    code = "\n".join(out_lines)
    return code


def _quote_bare_labels(line: str) -> str:
    """Convert bare multi-word node names to Mermaid `id["label"]` form.

    Mermaid rejects both bare names with spaces and bare double-quoted node ids;
    the only reliable form is id["label"]. We strip spaces from the id and keep
    the original text as the label, so repeated references resolve to the same
    node id.
    """
    out = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if c in "[]()":
            close = "]" if c == "[" else ")"
            j = line.find(close, i + 1)
            if j == -1:
                out.append(line[i:]); break
            out.append(line[i:j + 1]); i = j + 1; continue
        if c == '"':
            j = line.find('"', i + 1)
            if j == -1:
                out.append(line[i:]); break
            out.append(line[i:j + 1]); i = j + 1; continue
        if c == "|":
            j = line.find("|", i + 1)
            if j == -1:
                out.append(line[i:]); break
            out.append(line[i:j + 1]); i = j + 1; continue
        if c.isalnum():
            j = i
            while j < n and (line[j].isalnum() or line[j] == " "):
                j += 1
            tok = line[i:j]
            stripped = tok.strip()
            # if a bracket shape follows immediately, it already supplies the
            # label; just strip spaces from the id (e.g. "Actual Value[(...)]")
            k = j
            while k < n and line[k] == " ":
                k += 1
            if " " in stripped and k < n and line[k] == "[":
                ident = re.sub(r"[^A-Za-z0-9_]", "", stripped)
                out.append(ident)
            elif " " in stripped:
                ident = re.sub(r"[^A-Za-z0-9_]", "", stripped)
                out.append(f'{ident}["{stripped}"]')
            else:
                out.append(tok)
            i = j; continue
        out.append(c); i += 1
    return "".join(out)


def _normalize_sections(lesson: dict) -> list:
    """Turn the model's `sections` into a clean, validated list of modules.

    Falls back to the legacy flat fields (definition/worked_example/
    misconception/diagram) so old-format lessons and misbehaving models still
    render. Every diagram module body is cleaned through _clean_diagram.
    """
    raw = lesson.get("sections")
    if isinstance(raw, list) and raw:
        sections = []
        for sec in raw:
            if not isinstance(sec, dict):
                continue
            modules = []
            for m in sec.get("modules") or []:
                if not isinstance(m, dict) or not m.get("type"):
                    continue
                t = str(m["type"]).strip().lower()
                if t == "diagram":
                    m["body"] = _clean_diagram(m.get("body") or "")
                elif t == "key_terms":
                    m["items"] = [
                        {"term": it.get("term", ""), "def": it.get("def", "")}
                        for it in (m.get("items") or [])
                        if isinstance(it, dict) and (it.get("term") or it.get("def"))
                    ]
                elif t == "quiz":
                    # inline self-check: validate items, keep answer inline (the
                    # client grades these locally; they don't touch mastery)
                    m["items"] = [
                        {
                            "question": it.get("question", ""),
                            "options": it.get("options") or [],
                            "answer": int(it.get("answer", 0)),
                            "explanation": it.get("explanation", ""),
                        }
                        for it in (m.get("items") or [])
                        if isinstance(it, dict) and it.get("question")
                    ]
                elif t not in ("text", "example", "pitfall", "summary"):
                    continue
                modules.append({**m, "type": t})
            if modules:
                sections.append({"title": sec.get("title") or "", "modules": modules})
        if sections:
            return sections
    # legacy flat-shape fallback
    secs = []
    if lesson.get("definition"):
        secs.append({"title": "The idea", "modules": [{"type": "text", "heading": "In plain words", "body": lesson["definition"]}]})
    if lesson.get("worked_example"):
        secs.append({"title": "An example", "modules": [{"type": "example", "heading": "Watch it work", "body": lesson["worked_example"]}]})
    if lesson.get("misconception"):
        secs.append({"title": "A trap", "modules": [{"type": "pitfall", "trap": "What people get wrong", "truth": lesson["misconception"]}]})
    if lesson.get("diagram"):
        secs.append({"title": "The shape of it", "modules": [{"type": "diagram", "body": _clean_diagram(lesson["diagram"])}]})
    if not secs:
        secs.append({"title": "", "modules": [{"type": "text", "heading": "", "body": "(content not generated)"}]})
    return secs


def _persist_lesson(node_id: str, lesson: dict) -> None:
    conn = db.db()
    # replace quiz items (clean quiz_stats first — it references quiz_items)
    conn.execute(
        "DELETE FROM quiz_stats WHERE quiz_item_id IN (SELECT id FROM quiz_items WHERE node_id = ?)",
        (node_id,),
    )
    conn.execute("DELETE FROM quiz_items WHERE node_id = ?", (node_id,))
    for q in lesson.get("test", []):
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
    # idempotent: don't create a duplicate pending child on regenerate
    if relation == "prerequisite":
        dup = conn.execute(
            "SELECT 1 FROM edges e JOIN nodes n ON n.id = e.from_id "
            "WHERE e.to_id = ? AND e.relation = 'prerequisite' AND n.title = ? LIMIT 1",
            (parent_id, title),
        ).fetchone()
    else:
        dup = conn.execute(
            "SELECT 1 FROM edges e JOIN nodes n ON n.id = e.to_id "
            "WHERE e.from_id = ? AND e.relation = 'extension' AND n.title = ? LIMIT 1",
            (parent_id, title),
        ).fetchone()
    if dup:
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
        lesson = None
        last_err = None
        for attempt in range(2):  # one retry for flaky local models that emit bad JSON
            try:
                lesson = llm.complete_json(
                    prompts.SYSTEM_PROMPT, prompts.build_user_prompt(question, source_text), question
                )
                break
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                log.warning("generation attempt %d failed for %s: %s", attempt + 1, node_id, exc)
                # don't retry on timeouts — the model is overloaded; let the user
                # retry manually when the GPU is free
                if isinstance(exc, (__import__("httpx").ReadTimeout, __import__("httpx").RemoteProtocolError)):
                    raise
        if lesson is None:
            raise last_err
        # minimal validation of the shape we rely on
        if not isinstance(lesson, dict):
            raise ValueError("LLM returned a non-object payload")
        lesson["test"] = lesson.get("test") or []
        lesson["flashcards"] = lesson.get("flashcards") or []
        lesson["title"] = lesson.get("title") or row["title"]
        lesson["summary"] = lesson.get("summary") or ""
        lesson["sections"] = _normalize_sections(lesson)

        _persist_lesson(node_id, lesson)
        # Only grow the graph on first generation. On regenerate, the graph
        # already exists and the model returns different related titles each
        # time, so re-spawning would pile up duplicate/divergent children.
        has_children = conn.execute(
            "SELECT 1 FROM edges WHERE from_id = ? OR to_id = ? LIMIT 1", (node_id, node_id)
        ).fetchone()
        if not has_children:
            _spawn_related(node_id, lesson)
        # surface the model's own title (cleaner than the raw question)
        conn.execute("UPDATE nodes SET status = 'ready', summary = ?, title = ? WHERE id = ?",
                     (lesson["summary"], lesson["title"], node_id))
        conn.commit()
        log.info("node %s ready", node_id)
    except Exception as exc:  # noqa: BLE001 - surface any failure to the node
        log.exception("generation failed for node %s", node_id)
        conn.execute("UPDATE nodes SET status = 'failed', error = ? WHERE id = ?",
                     (str(exc)[:1000], node_id))
        conn.commit()
