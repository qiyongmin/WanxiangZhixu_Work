"""Tiny seeded property-testing helper (standard library only).

``forall(gen, prop, runs=200, seed=None)`` runs ``prop(value)`` for ``runs``
generated values. ``runs`` below 100 is refused so a property can never be
quietly weakened. The seed comes from ``KB_WORK_PBT_SEED`` or is random, and is
always printed (stderr) so any failure can be replayed. There is no automatic
shrinking; instead the generator ``size`` grows with the case index, so the
first failing case is usually already small.

A generator is a callable ``gen(rng, size) -> value``.
"""
from __future__ import annotations

import datetime as _dt
import os
import random
import sys

MIN_RUNS = 100
MAX_REPR = 10_000


def _resolve_seed(seed):
    if seed is not None:
        return int(seed)
    env = os.environ.get("KB_WORK_PBT_SEED")
    if env not in (None, ""):
        try:
            return int(env)
        except ValueError as exc:
            raise ValueError("KB_WORK_PBT_SEED must be an integer") from exc
    return random.SystemRandom().randrange(2 ** 32)


def forall(gen, prop, runs=200, seed=None):
    """Check ``prop`` for ``runs`` generated inputs; AssertionError on failure.

    ``prop`` fails by raising or by returning ``False`` (``None`` passes).
    """
    if not isinstance(runs, int) or isinstance(runs, bool) or runs < MIN_RUNS:
        raise ValueError(f"runs must be an integer >= {MIN_RUNS}, got {runs!r}")
    seed = _resolve_seed(seed)
    name = getattr(prop, "__name__", "property")
    print(f"[pbt] property={name} runs={runs} seed={seed} "
          f"(replay with KB_WORK_PBT_SEED={seed})", file=sys.stderr)
    rng = random.Random(seed)
    for index in range(runs):
        value = gen(rng, index)
        try:
            outcome = prop(value)
        except Exception as exc:  # noqa: BLE001 - any failure is a counterexample
            raise AssertionError(_message(name, index, seed, value, repr(exc))) from exc
        if outcome is False:
            raise AssertionError(_message(name, index, seed, value, "property returned False"))


def _message(name, index, seed, value, reason):
    shown = repr(value)
    if len(shown) > MAX_REPR:
        shown = shown[:MAX_REPR] + "...<truncated>"
    return (f"Property {name} failed at case {index} (seed={seed}; replay with "
            f"KB_WORK_PBT_SEED={seed}): {reason}\ninput: {shown}")


# -- generators ----------------------------------------------------------
_CHINESE = "万象知序笃行工作驾驶舱任务笔记资料部门项目计划风险决策里程碑重复提醒"
_ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.,:;!?"
_SPECIAL = "/\\\"'<>&%#@$*()[]{}|~`^+=\u00a0\u200b\u3000"
_CONTROL = "".join(chr(i) for i in list(range(0, 32)) + [127])


def _length(rng, size, max_len):
    ceiling = min(max_len, 1 + size // 8)
    return rng.randint(0, ceiling)


def text(max_len=40, alphabet=None, min_len=0):
    """Strings mixing ASCII, Chinese, slashes/backslashes and control characters."""
    pools = [alphabet] if alphabet else [_ASCII, _CHINESE, _SPECIAL, _CONTROL]

    def gen(rng, size):
        length = max(min_len, _length(rng, size, max_len))
        chars = []
        for _ in range(length):
            pool = pools[0] if len(pools) == 1 else rng.choices(pools, weights=(6, 3, 2, 1))[0]
            chars.append(rng.choice(pool))
        return "".join(chars)

    return gen


def ints(lo=-1000, hi=1000):
    def gen(rng, size):
        span = max(1, min(hi - lo, 4 + size * 10))
        mid = (lo + hi) // 2
        a = max(lo, mid - span // 2)
        b = min(hi, a + span)
        return rng.randint(a, b)

    return gen


def dates(start=_dt.date(1970, 1, 1), end=_dt.date(2100, 12, 31)):
    """datetime.date values with a bias towards month ends and leap days."""
    edge_days = [(2, 28), (2, 29), (1, 31), (3, 31), (4, 30), (12, 31), (1, 1)]

    def gen(rng, size):
        if rng.random() < 0.3:
            year = rng.randint(start.year, end.year)
            month, day = rng.choice(edge_days)
            try:
                candidate = _dt.date(year, month, day)
            except ValueError:
                candidate = _dt.date(year, 2, 28)
        else:
            candidate = start + _dt.timedelta(days=rng.randint(0, (end - start).days))
        return min(max(candidate, start), end)

    return gen


def booleans():
    return lambda rng, size: rng.random() < 0.5


def just(value):
    return lambda rng, size: value


def one_of(*gens):
    if not gens:
        raise ValueError("one_of needs at least one generator")
    return lambda rng, size: rng.choice(gens)(rng, size)


def lists(item, max_len=10, min_len=0):
    def gen(rng, size):
        length = max(min_len, _length(rng, size, max_len))
        return [item(rng, size) for _ in range(length)]

    return gen


def tuples(*gens):
    return lambda rng, size: tuple(g(rng, size) for g in gens)


def dicts(key, value, max_len=6):
    def gen(rng, size):
        result = {}
        for _ in range(_length(rng, size, max_len)):
            result[key(rng, size)] = value(rng, size)
        return result

    return gen


def mapped(gen, function):
    return lambda rng, size: function(gen(rng, size))
