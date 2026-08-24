"""SQLite storage layer. One connection per operation; WAL mode for concurrency."""
import json
import os
import sqlite3
import threading
import time
import uuid

from . import config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    question    TEXT,
    summary     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|generating|ready|failed
    kind        TEXT NOT NULL DEFAULT 'root',     -- root|prereq|extension
    source_id   TEXT,
    error       TEXT,
    created_at  REAL,
    content     TEXT
);
CREATE TABLE IF NOT EXISTS edges (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id   TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    relation  TEXT NOT NULL,   -- prerequisite|extension
    UNIQUE(from_id, to_id, relation)
);
CREATE TABLE IF NOT EXISTS flashcards (
    id       TEXT PRIMARY KEY,
    node_id  TEXT NOT NULL,
    front    TEXT,
    back     TEXT,
    due      REAL DEFAULT 0,
    interval REAL DEFAULT 0,
    ease     REAL DEFAULT 2.5,
    reps     INTEGER DEFAULT 0,
    lapses   INTEGER DEFAULT 0,
    state    INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quiz_items (
    id          TEXT PRIMARY KEY,
    node_id     TEXT NOT NULL,
    question    TEXT,
    options     TEXT,
    answer      INTEGER,
    explanation TEXT
);
CREATE TABLE IF NOT EXISTS mastery (
    node_id     TEXT PRIMARY KEY,
    score       REAL DEFAULT 0,
    attempts    INTEGER DEFAULT 0,
    correct     INTEGER DEFAULT 0,
    total       INTEGER DEFAULT 0,
    next_quiz_at REAL DEFAULT 0,
    updated_at  REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sources (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    content    TEXT,
    created_at REAL
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_due ON flashcards(due);
"""


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
    return conn


def init() -> None:
    conn = _connect()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def now() -> float:
    return time.time()


def row_to_dict(row) -> dict:
    return dict(row) if row is not None else None
