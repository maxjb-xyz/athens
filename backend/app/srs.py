"""Adaptive spaced-repetition scheduler with new-card introduction.

Card states:
  0 = new       (never seen; introduced gradually, capped by a daily budget)
  1 = learning  (short intra-session steps; graduates to review on Good/Easy)
  2 = review    (long-term SM-2 intervals)

The learner only ever taps Again / Hard / Good / Easy. Nothing else is exposed.
"""
from .db import now

# quality grades derived from the four learner-facing buttons
_QUALITY = {"again": 0, "hard": 3, "good": 4, "easy": 5}

# learning steps (seconds): how soon a "learning" card reappears in this session
_STEPS_AGAIN = 60      # forgot it — 1 minute
_STEPS_HARD = 600      # hard — 10 minutes
# graduation intervals (days) when a new/learning card graduates to review
_GRAD_GOOD = 1
_GRAD_EASY = 4


def review(card: dict, quality: int) -> dict:
    state = card["state"]
    ease = card["ease"]
    interval = card["interval"]
    reps = card["reps"]
    lapses = card["lapses"]

    if state in (0, 1):
        # new or learning card — run learning steps, graduate on Good/Easy
        if quality < 3:
            return {
                "due": now() + (_STEPS_AGAIN if quality == 0 else _STEPS_HARD),
                "interval": 0,
                "ease": round(max(1.3, ease - 0.2), 2),
                "reps": reps,
                "lapses": lapses + (1 if quality == 0 else 0),
                "state": 1,
            }
        # graduate to review
        interval = _GRAD_EASY if quality == 5 else _GRAD_GOOD
        return {
            "due": now() + interval * 86400,
            "interval": interval,
            "ease": round(ease, 2),
            "reps": reps + 1,
            "lapses": lapses,
            "state": 2,
        }

    # review card — standard SM-2
    if quality < 3:
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
        "state": 2,
    }
