"""SQLite storage layer with a small versioned-migration framework.

One connection per thread; WAL mode for concurrency. Schema changes are
expressed as an ordered list of migrations, applied idempotently on startup.
"""
import json
import os
import sqlite3
import threading
import time
import uuid

from . import config

_local = threading.local()

# Ordered migrations. Each entry is (version, [sql, ...]). Never edit an
# already-shipped migration; append a new one instead.
MIGRATIONS = [
    (1, [
        # IF NOT EXISTS throughout: a pre-migration DB (created by the old
        # init) already has these tables but no schema_migrations table, so
        # v1 must be safe to re-apply over them.
        """
        CREATE TABLE IF NOT EXISTS nodes (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            question    TEXT,
            summary     TEXT,
            status      TEXT NOT NULL DEFAULT 'pending',
            kind        TEXT NOT NULL DEFAULT 'root',
            source_id   TEXT,
            error       TEXT,
            created_at  REAL,
            content     TEXT
        )""",
        """
        CREATE TABLE IF NOT EXISTS edges (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id   TEXT NOT NULL,
            to_id     TEXT NOT NULL,
            relation  TEXT NOT NULL,
            UNIQUE(from_id, to_id, relation)
        )""",
        """
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
        )""",
        """
        CREATE TABLE IF NOT EXISTS quiz_items (
            id          TEXT PRIMARY KEY,
            node_id     TEXT NOT NULL,
            question    TEXT,
            options     TEXT,
            answer      INTEGER,
            explanation TEXT
        )""",
        """
        CREATE TABLE IF NOT EXISTS mastery (
            node_id     TEXT PRIMARY KEY,
            score       REAL DEFAULT 0,
            attempts    INTEGER DEFAULT 0,
            correct     INTEGER DEFAULT 0,
            total       INTEGER DEFAULT 0,
            next_quiz_at REAL DEFAULT 0,
            updated_at  REAL DEFAULT 0
        )""",
        """
        CREATE TABLE IF NOT EXISTS sources (
            id         TEXT PRIMARY KEY,
            title      TEXT,
            content    TEXT,
            created_at REAL
        )""",
        "CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id)",
        "CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id)",
        "CREATE INDEX IF NOT EXISTS idx_flashcards_due ON flashcards(due)",
    ]),
    (2, [
        # per-question correctness tracking (adaptive targeting)
        """
        CREATE TABLE quiz_stats (
            quiz_item_id  TEXT PRIMARY KEY,
            times_seen    INTEGER DEFAULT 0,
            times_correct INTEGER DEFAULT 0,
            times_wrong   INTEGER DEFAULT 0
        )""",
        # runtime settings (config UI)
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
        "INSERT INTO settings (key, value) VALUES ('daily_new_limit', '20')",
        # daily activity for streaks
        """
        CREATE TABLE daily_activity (
            day           TEXT PRIMARY KEY,
            card_reviews  INTEGER DEFAULT 0,
            quiz_attempts INTEGER DEFAULT 0
        )""",
        # when a card was first introduced (for the daily new-card budget)
        "ALTER TABLE flashcards ADD COLUMN introduced_at REAL DEFAULT 0",
    ]),
]


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
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
    applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
    for version, statements in MIGRATIONS:
        if version in applied:
            continue
        for stmt in statements:
            conn.execute(stmt)
        conn.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
    conn.commit()
    conn.close()


def get_setting(key: str, default: str = "") -> str:
    row = db().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    conn = db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()


def all_settings() -> dict:
    return {r["key"]: r["value"] for r in db().execute("SELECT key, value FROM settings")}


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def now() -> float:
    return time.time()


def today() -> str:
    return time.strftime("%Y-%m-%d")


def row_to_dict(row) -> dict:
    return dict(row) if row is not None else None


def bump_activity(field: str, n: int = 1) -> None:
    """Increment a daily-activity counter for streak tracking."""
    if field not in ("card_reviews", "quiz_attempts"):
        return
    conn = db()
    conn.execute(
        "INSERT INTO daily_activity (day, card_reviews, quiz_attempts) VALUES (?, 0, 0) "
        "ON CONFLICT(day) DO NOTHING",
        (today(),),
    )
    conn.execute(f"UPDATE daily_activity SET {field} = {field} + ? WHERE day = ?", (n, today()))
    conn.commit()
