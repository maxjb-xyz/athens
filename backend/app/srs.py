"""Adaptive spaced-repetition scheduler (SM-2 core, all knobs hidden).

The learner only ever picks Again / Hard / Good / Easy. We map those to
SM-2 quality grades and run the standard algorithm. Nothing is exposed.
"""
from .db import now

# quality grades derived from the four learner-facing buttons
# Again=0, Hard=3, Good=4, Easy=5


def review(card: dict, quality: int) -> dict:
    ease = card["ease"]
    interval = card["interval"]
    reps = card["reps"]
    lapses = card["lapses"]

    if quality < 3:  # a lapse: forgot it
        reps = 0
        interval = 1
        lapses += 1
        ease = max(1.3, ease - 0.2)
    else:
        if reps == 0:
            interval = 1
        elif reps == 1:
            interval = 6
        else:
            interval = round(interval * ease)
        ease = ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        ease = max(1.3, ease)
        reps += 1

    return {
        "due": now() + interval * 86400,
        "interval": interval,
        "ease": round(ease, 2),
        "reps": reps,
        "lapses": lapses,
        "state": 2 if reps > 0 else 1,
    }
