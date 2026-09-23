"""Minimal SVG path parser/flattener for the Inkscape trace output."""
import os
import re

SVG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "Bioimmersion Background Photo masks.svg")

TOK = re.compile(r"[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


def load_paths():
    s = open(SVG, encoding="utf-8").read()
    m = re.search(r"<image.*?/>", s, re.S)
    s = s[m.end():]
    out = []
    for p in re.finditer(r"<path(.*?)/>", s, re.S):
        body = p.group(1)
        pid = re.search(r'\sid="(.*?)"', body).group(1)
        d = re.search(r'\sd="(.*?)"', body, re.S).group(1)
        out.append((pid, d))
    return out


def _cubic(p0, p1, p2, p3, n):
    pts = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        x = u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def flatten(d, seg=6):
    """Return list of subpaths (lists of (x, y))."""
    toks = TOK.findall(d)
    i = 0
    cmd = None
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    last_ctrl = None
    subs = []
    sub = []

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                if sub:
                    subs.append(sub)
                sub = []
                cur = start
                last_ctrl = None
                continue
        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = cur if rel else (0.0, 0.0)
        if c == "M":
            if sub:
                subs.append(sub)
            x, y = num() + ox, num() + oy
            cur = start = (x, y)
            sub = [cur]
            cmd = "l" if rel else "L"
            last_ctrl = None
        elif c == "L":
            cur = (num() + ox, num() + oy)
            sub.append(cur)
            last_ctrl = None
        elif c == "H":
            cur = (num() + (cur[0] if rel else 0), cur[1])
            sub.append(cur)
            last_ctrl = None
        elif c == "V":
            cur = (cur[0], num() + (cur[1] if rel else 0))
            sub.append(cur)
            last_ctrl = None
        elif c == "C":
            p1 = (num() + ox, num() + oy)
            p2 = (num() + ox, num() + oy)
            p3 = (num() + ox, num() + oy)
            sub.extend(_cubic(cur, p1, p2, p3, seg))
            last_ctrl = p2
            cur = p3
        elif c == "S":
            p1 = (2 * cur[0] - last_ctrl[0], 2 * cur[1] - last_ctrl[1]) if last_ctrl else cur
            p2 = (num() + ox, num() + oy)
            p3 = (num() + ox, num() + oy)
            sub.extend(_cubic(cur, p1, p2, p3, seg))
            last_ctrl = p2
            cur = p3
        else:
            raise ValueError("unsupported command " + cmd)
    if sub:
        subs.append(sub)
    return subs
