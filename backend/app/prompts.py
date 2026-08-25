"""Prompt templates. The lesson is generated as strict JSON so we can
validate it, render each slot, and turn quiz answers into mastery signal."""

SYSTEM_PROMPT = (
    "You are Athens, a patient and expert tutor. You build clear, accurate learning "
    "material. You never talk down to the learner and you never invent facts. When "
    "source material is provided you ground everything in it and cite it. When no "
    "source is given you draw on established, verifiable knowledge.\n\n"
    "Respond ONLY with a single valid JSON object matching the requested schema. "
    "No markdown fences, no commentary, no extra text."
)

# NOTE: uses $question / $source tokens (replaced with .replace), because the
# JSON schema below contains literal { } braces that break str.format().
USER_TEMPLATE = (
    'Topic or question from the learner: "$question"\n\n'
    "$source_block\n"
    "Build one self-contained lesson and respond with a JSON object using EXACTLY these keys:\n"
    "{\n"
    '  "title": "a short, specific title",\n'
    '  "summary": "one sentence on what the learner will get from this",\n'
    '  "definition": "a rich explanation using Markdown. Start with a bold one-line plain-English definition, then 3-5 short bullet points (each one idea), then a short why-it-matters paragraph. Keep bullets under 20 words each.",\n'
    '  "worked_example": "a concrete worked example using Markdown. 3-5 numbered steps, each with a bold lead-in and a one-line concrete detail (real numbers, a named scenario). End with a one-line takeaway.",\n'
    '  "misconception": "the most common mistake, written as two short sections: a bold The trap line (what people wrongly think) and a bold The truth line (the correction).",\n'
    '  "diagram": "a Mermaid flowchart (start with exactly: flowchart TD). Use ONLY these arrow forms: -->, -->|label|, -.->, ==> . Write every node as id[\'label\'] with a short id that has no spaces (e.g. A[\'Input data\']), and keep each node on one line. Make it a real process with 6-10 nodes showing the full journey, not a trivial 2-3 node sketch. Short labels; no special characters except spaces, commas and question marks",\n'
    '  "quiz": [ {"question": "...", "options": ["a","b","c","d"], "answer": 0, "explanation": "why the answer is right and the others wrong"} ]  (exactly 3 items, 4 options each),\n'
    '  "flashcards": [ {"front": "...", "back": "..."} ]  (exactly 3 items),\n'
    '  "prerequisites": ["1-3 short titles of things to understand first"],\n'
    '  "extensions": ["1-3 short titles of natural next questions"]\n'
    "}\n\n"
    "Rules:\n"
    "- quiz.answer is the integer index (0-3) of the correct option.\n"
    "- Options must be plausible; distractors wrong but tempting.\n"
    "- If source material is provided, base definition, example and quiz strictly on it.\n"
    "- Diagram labels: plain text, at most six words each.\n"
    "- Write everything in the same language as the question."
)


def build_user_prompt(question: str, source_text: str | None) -> str:
    if source_text and source_text.strip():
        source_block = (
            "SOURCE MATERIAL (ground the lesson in this only):\n"
            "<<<\n" + source_text.strip() + "\n>>>"
        )
    else:
        source_block = "(no source provided; use established, verifiable knowledge)"
    return (
        USER_TEMPLATE.replace("$question", question).replace("$source_block", source_block)
    )
