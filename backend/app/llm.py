"""LLM provider abstraction.

Two providers:
  - "mock"   : deterministic, offline, returns realistic lesson JSON so the
               whole app runs and demos with zero configuration.
  - "openai" : any OpenAI-compatible /chat/completions endpoint. Covers
               OpenAI, DeepSeek, Anthropic-compatible proxies, Ollama's
               /v1 endpoint, LM Studio, vLLM, etc.
"""
import json
import re

import httpx

from . import config


def _clean_question(text: str) -> str:
    return (text or "").strip().rstrip("?").strip()


def _title_case(t: str) -> str:
    """Convert a question into a clean noun-phrase title (mock provider only)."""
    t = _clean_question(t)
    low = t.lower()
    prefixes = (
        "how does ", "how do ", "what is ", "what are ", "why does ", "why do ",
        "why is ", "when does ", "when is ", "where does ", "where is ", "who is ",
        "how ", "what ", "why ", "when ", "where ", "who ", "which ",
        "does ", "do ", "is ", "are ", "did ", "can ", "will ", "should ",
    )
    for p in prefixes:
        if low.startswith(p):
            t = t[len(p):]
            break
    for tail in (" actually work", " actually works", " work", " works"):
        if t.lower().endswith(tail):
            t = t[: -len(tail)]
            break
    t = t.strip().rstrip("? .")
    if t and not t[0].isupper():
        t = t[0].upper() + t[1:]
    return t[:70] or "this idea"


def mock_lesson(topic: str) -> dict:
    """Produce a coherent, topic-aware stand-in lesson for demo / testing."""
    t = _clean_question(topic) or "this idea"
    title = _title_case(t)

    definition = (
        f"{title} is easier to hold onto once you can say it in one plain sentence: what it is, "
        "and why it matters before you go deeper. Keep that sentence as your anchor and build the "
        "details onto it. Most confusion comes from losing the anchor and memorising fragments out "
        "of order."
    )
    worked_example = (
        f"Take one concrete instance of {t} and walk it slowly. Name the input, name each step "
        "that transforms it, and name the output. Then ask what would break if one step changed. "
        "Working the example forwards and backwards is what turns 'I recognise this' into "
        "'I could rebuild this from nothing'."
    )
    misconception = (
        f"The most common mistake is treating the surface definition as the whole thing. People can "
        "repeat the words but can't apply them. The fix is to re-derive the idea from a concrete "
        "example every time, rather than trusting the label."
    )
    diagram = (
        "flowchart TD\n"
        "    A[What it is] --> B[Core principle]\n"
        "    B --> C[Worked example]\n"
        "    B --> D[Common mistake]\n"
        "    C --> E[Why it matters]\n"
        "    E --> F[What to learn next]"
    )
    quiz = [
        {
            "question": f"What is the most reliable way to genuinely understand {t}?",
            "options": [
                "Start from its core principle and check your understanding as you go",
                "Memorise every fact you can find, as fast as possible",
                "Skip the basics and jump straight to advanced edge cases",
                "Read a single summary once and move on",
            ],
            "answer": 0,
            "explanation": (
                "Understanding is built from a stable core, then tested. Memorising fragments "
                "or skipping the basics leaves you able to repeat words without applying them."
            ),
        },
        {
            "question": f"Why does a worked example help more than a definition of {t}?",
            "options": [
                "It turns an abstract idea into something concrete and testable",
                "Definitions are always wrong",
                "Examples are shorter to read",
                "It lets you skip the core principle",
            ],
            "answer": 0,
            "explanation": (
                "A worked example forces the idea to do work on real inputs, which exposes "
                "whether you actually understand it or just recognise the label."
            ),
        },
        {
            "question": f"When you get stuck on {t}, what is the best first move?",
            "options": [
                "Revisit the prerequisite you are least sure about",
                "Read a harder, more advanced source",
                "Move on and hope it resolves later",
                "Reread the same explanation you already didn't follow",
            ],
            "answer": 0,
            "explanation": (
                "Gaps almost always sit one level below the thing that feels stuck. "
                "Rechecking the shaky prerequisite fixes the cause instead of the symptom."
            ),
        },
    ]
    flashcards = [
        {
            "front": f"In one sentence, what is {title}?",
            "back": definition,
        },
        {
            "front": f"What is the most common misconception about {title}?",
            "back": misconception,
        },
        {
            "front": f"Give one concrete worked example of {title}.",
            "back": worked_example,
        },
    ]
    return {
        "title": title,
        "summary": f"A self-contained walkthrough of {t}, with a worked example and a check on your understanding.",
        "definition": definition,
        "worked_example": worked_example,
        "misconception": misconception,
        "diagram": diagram,
        "quiz": quiz,
        "flashcards": flashcards,
        "prerequisites": ["The core idea this builds on"],
        "extensions": ["Where this idea leads next"],
    }


def _parse_json(text: str) -> dict:
    """Tolerantly extract a JSON object from an LLM response."""
    if text is None:
        raise ValueError("empty LLM response")
    text = text.strip()
    # strip code fences
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # fall back to first balanced {...} block
    start = text.find("{")
    if start == -1:
        raise ValueError("no JSON object in LLM response")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ValueError("unbalanced JSON in LLM response")


class OpenAIProvider:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def complete_json(self, system: str, user: str) -> dict:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.7,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        with httpx.Client(timeout=180.0) as client:
            resp = client.post(
                f"{self.base_url}/chat/completions", json=payload, headers=headers
            )
            resp.raise_for_status()
            data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return _parse_json(content)


def get_provider():
    from . import db as dbmod

    provider = dbmod.get_setting("llm_provider", config.LLM_PROVIDER).strip().lower()
    if provider == "openai":
        base_url = dbmod.get_setting("llm_base_url", config.LLM_BASE_URL)
        api_key = dbmod.get_setting("llm_api_key", config.LLM_API_KEY)
        model = dbmod.get_setting("llm_model", config.LLM_MODEL)
        return OpenAIProvider(base_url, api_key, model)
    # mock is the default
    return None


def probe() -> dict:
    """Cheap health check on the configured LLM. Returns ok=True if reachable."""
    provider = get_provider()
    if provider is None:
        return {"ok": True, "provider": "mock", "latency_ms": 0}
    import time as _t

    start = _t.time()
    try:
        payload = {
            "model": provider.model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }
        headers = {"Content-Type": "application/json"}
        if provider.api_key:
            headers["Authorization"] = f"Bearer {provider.api_key}"
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(f"{provider.base_url}/chat/completions", json=payload, headers=headers)
            resp.raise_for_status()
        return {"ok": True, "provider": "openai", "model": provider.model, "latency_ms": int((_t.time() - start) * 1000)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "provider": "openai", "model": provider.model, "error": str(exc)[:200]}


def complete_json(system: str, user: str, topic: str) -> dict:
    provider = get_provider()
    if provider is None:
        return mock_lesson(topic)
    return provider.complete_json(system, user)
