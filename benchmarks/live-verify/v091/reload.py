#!/usr/bin/env python3
"""Time-anchored reload verifier (v2).

The v1 cursor (`len(lines())` over a sliding 4MB tail) is unstable under
concurrent writers, so it both under- and over-counted. This version anchors on
the CONFIG FILE MTIME and looks for advisor `loading plugin` lines whose log
timestamp is newer than the write.

Usage:
  reload.py check                 # verify a burst exists after the config mtime
  reload.py audit <label>:<epoch> [...]   # verify each write epoch has a burst
"""
import pathlib
import re
import sys
import time

LOG = pathlib.Path.home() / ".local/share/opencode/log/opencode.log"
CFG = pathlib.Path.home() / ".config/opencode/opencode-advisor.json"
ADVISOR = "opencode-advisor"


def tail_lines(maxbytes=8_000_000):
    with LOG.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - maxbytes))
        return f.read().decode("utf-8", "replace").splitlines()


TS = re.compile(r"timestamp=(\S+?) ")
ADVISOR_PL = re.compile(r'msg="loading plugin" id=\S*opencode-advisor\b')


def epoch(ts):
    # 2026-09-26T21:39:12.583Z -> epoch ms
    t = ts.rstrip("Z")
    d, hms = t.split("T")
    h, m, s = hms.split(":")
    y, mo, da = (int(x) for x in d.split("-"))
    import calendar
    return calendar.timegm((y, mo, da, int(h), int(m), int(float(s)), 0, 0, 0)) * 1000 + int(
        round((float(s) % 1) * 1000))


def bursts_since(ms):
    out = []
    for l in tail_lines():
        if not ADVISOR_PL.search(l):
            continue
        m = TS.search(l)
        if not m:
            continue
        try:
            e = epoch(m.group(1))
        except Exception:
            continue
        if e >= ms:
            out.append((e, m.group(1)))
    return out


def local_mtime_ms():
    return int(CFG.stat().st_mtime * 1000)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        ms = local_mtime_ms()
        # the write may still be propagating; give it up to 30s
        deadline = time.time() + 30
        found = []
        while time.time() < deadline:
            found = bursts_since(ms)
            if found:
                break
            time.sleep(1)
        print(f"CONFIG_MTIME_EPOCH_MS={ms}")
        print(f"ADVISOR_RELOAD_LINES_SINCE_WRITE={len(found)}")
        if found:
            print(f"FIRST={found[0][1]} LAST={found[-1][1]}")
            print(f"DISTINCT_INSTANTS={len({e for e, _ in found})}")
        print("RELOAD_VERIFIED=" + ("YES" if found else "NO"))
    elif cmd == "audit":
        ok = True
        for arg in sys.argv[2:]:
            label, _, ep = arg.partition(":")
            ms = int(ep)
            found = bursts_since(ms)
            distinct = len({e for e, _ in found})
            good = distinct > 0
            ok = ok and good
            span = f"{found[0][1]}..{found[-1][1]}" if found else "none"
            print(f"{label}: write@{ms} advisor_reload_instances={len(found)} distinct_instants={distinct} "
                  f"span={span} -> {'OK' if good else 'MISSING'}")
        print("AUDIT=" + ("ALL_OK" if ok else "GAPS"))
    else:
        print(__doc__)
