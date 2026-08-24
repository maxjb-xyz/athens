# Athens

A self-hostable, question-first AI learning app. Ask a question; Athens builds
you a lesson, tests you on it, schedules reviews so it sticks, and grows a map
of everything around it.

ChatGPT and Claude are good at *answering* and bad at *teaching*. They generate
a wall of text you'll forget tomorrow. Athens keeps three things separate that
chatbots collapse into one:

- **a model of the subject** — a knowledge graph, not a flat essay
- **a model of you** — per-idea mastery, updated from your quiz answers
- **a strategy** — spaced repetition on flashcards and a hidden re-test
  scheduler for quizzes

## What it does

- **Question-first.** You don't pick a 10-module syllabus. You ask
  "How does the Fourier transform actually work?" and Athens builds one
  self-contained lesson, then grows the graph outward: prerequisites on one
  side, extensions on the other.
- **Structured lessons, not essays.** Every lesson has the same bones: a plain
  definition, one worked example, the most common misconception, a diagram, a
  3-question quiz, and 3 flashcards. The model fills the slots; the skeleton is
  deterministic, so output is testable.
- **Source-grounded.** Paste an article, notes, or a textbook excerpt and the
  lesson is built from *that* material instead of the model's priors.
- **Adaptive review, zero knobs.** Flashcards use SM-2 spaced repetition with
  proper new-card introduction (a daily budget, learning steps, graduation).
  Quizzes re-test sooner when you're shaky and later when you're solid, and a
  re-test surfaces the exact questions you've been getting wrong first. You
  only ever see Again / Hard / Good / Easy.
- **A model of you that's actually consulted.** Per-idea mastery, per-question
  correctness, a daily streak, and recommendations that respect the graph — you
  won't be pointed at an extension before its prerequisite is mastered.
- **You can fix the model's mistakes.** Edit any lesson field, delete a thread,
  or regenerate a single lesson. A hallucinated fact doesn't poison a lesson
  forever.
- **Your data is yours.** One SQLite file. Export a full JSON backup or a
  tab-separated deck Anki can import directly.

## Quick start

```bash
docker compose up -d
# pull a local model once (or set ATHENS_LLM_PROVIDER=mock to skip this)
docker compose exec ollama ollama pull llama3.1
```

Open http://localhost:8000.

To use an external model instead of local Ollama:

```bash
ATHENS_LLM_PROVIDER=openai \
ATHENS_LLM_BASE_URL=https://api.openai.com/v1 \
ATHENS_LLM_MODEL=gpt-4o-mini \
ATHENS_LLM_API_KEY=sk-... \
docker compose up -d
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `ATHENS_LLM_PROVIDER` | `mock` | `mock` (no model, offline demo) or `openai` (any OpenAI-compatible endpoint) |
| `ATHENS_LLM_BASE_URL` | `http://localhost:11434/v1` | Base URL of the chat-completions endpoint |
| `ATHENS_LLM_MODEL` | `llama3.1` | Model name |
| `ATHENS_LLM_API_KEY` | *(empty)* | API key; leave empty for local Ollama |
| `ATHENS_DATA_DIR` | `./data` | Where the SQLite database lives |

The `openai` provider covers OpenAI, DeepSeek, Anthropic-compatible proxies,
Ollama's `/v1` endpoint, LM Studio, and vLLM — anything that speaks
`/chat/completions`.

Provider, model, base URL, and API key can also be changed at runtime from the
Settings page (stored in the SQLite DB, overriding env defaults).

## Running without Docker (dev)

```bash
cd backend
uv venv .venv && source .venv/bin/activate
uv pip install -r requirements.txt
ATHENS_LLM_PROVIDER=mock uvicorn app.main:app --reload
```

The frontend is served by the same process; no separate build step.

## Architecture

- **FastAPI** backend (single process, serves API + static frontend)
- **SQLite** (WAL mode) with a versioned-migration framework — no separate
  database to run, and schema changes are ordered and idempotent
- **Mermaid** (vendored) for diagrams
- **SM-2** spaced repetition with new/learning/review card states, wrapped in
  four learner-facing buttons
- Background threads run generation so the API stays responsive

Data model: `nodes` (questions/concepts), `edges` (prerequisite/extension),
`quiz_items`, `quiz_stats` (per-question correctness), `flashcards` (SRS state),
`mastery` (the learner model), `sources`, `daily_activity` (streaks), `settings`.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE).
