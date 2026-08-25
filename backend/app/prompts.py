"""Prompt templates. The lesson is generated as strict JSON so we can
validate it, render each slot, and turn quiz answers into mastery signal.

A lesson is a title + summary + an ordered list of `sections`. Each section
has an optional title and a list of typed modules. Quiz questions and
flashcards are collected as top-level arrays (any count) so the spaced-
repetition scheduler can manage them independently of how the prose flows."""

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
    '  "sections": [ { "title": "optional section heading", "modules": [ ... ] } ],\n'
    '  "quiz": [ ... ],\n'
    '  "flashcards": [ ... ],\n'
    '  "prerequisites": ["1-3 short titles of things to understand first"],\n'
    '  "extensions": ["1-3 short titles of natural next questions"]\n'
    "}\n\n"
    "MODULE TYPES (each module is a JSON object with a \"type\" field):\n"
    "- text: {\"type\":\"text\",\"heading\":\"short heading\",\"body\":\"Markdown prose. Start with a bold one-line definition, then bullet points, then a short why-it-matters paragraph.\"}\n"
    "- example: {\"type\":\"example\",\"heading\":\"short heading\",\"body\":\"Markdown. Numbered steps, each with a bold lead-in and a concrete detail.\"}\n"
    "- pitfall: {\"type\":\"pitfall\",\"trap\":\"what people wrongly think\",\"truth\":\"the correction\"}\n"
    "- diagram: {\"type\":\"diagram\",\"body\":\"a Mermaid flowchart (start with exactly: flowchart TD). Use ONLY these arrows: -->, -->|label|, -.->, ==> . Write every node as id['label'] with a no-space id (e.g. A['Input data']), one node per line, 6-10 nodes.\"}\n"
    "- key_terms: {\"type\":\"key_terms\",\"items\":[{\"term\":\"Word\",\"def\":\"one-line definition\"}]}\n"
    "- summary: {\"type\":\"summary\",\"body\":\"2-3 bullet takeaway points in Markdown\"}\n"
    "\n"
    "RULES:\n"
    "- sections is 2-5 sections; each has 1-6 modules. Structure the lesson as a coherent journey, not a fixed template.\n"
    "- You may repeat module types and include as many or as few of each as the topic needs.\n"
    "- quiz is 2-6 items: [ {\"question\":\"...\",\"options\":[\"a\",\"b\",\"c\",\"d\"],\"answer\":0,\"explanation\":\"why right and why others wrong\"} ]. answer is the integer index (0-3) of the correct option.\n"
    "- flashcards is 2-6 items: [ {\"front\":\"...\",\"back\":\"...\"} ].\n"
    "- Options must be plausible; distractors wrong but tempting.\n"
    "- If source material is provided, base everything strictly on it.\n"
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
