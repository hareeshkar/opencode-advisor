#!/usr/bin/env python3
"""Usage-ledger + consult-ledger snapshot / delta tool.

Usage:
  snap.py usage                 # print today's usage ledger JSON
  snap.py ledger                # print consult ledger summary (all records)
  snap.py session <sessionID>   # summary of records for one sessionID
  snap.py mark <label>          # record a spend baseline into marks.json
  snap.py delta <label>         # print usage delta since mark <label>
"""
import datetime
import json
import pathlib
import sqlite3
import sys

NS = "plugin:" + "opencode-advisor".encode("utf-16-be").hex() + ":"
DB = pathlib.Path.home() / ".local/share/opencode/opencode.db"
HERE = pathlib.Path(__file__).parent
MARKS = HERE / "marks.json"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def get(key):
    r = con.execute("SELECT value FROM kv WHERE key=?", (NS + key,)).fetchone()
    return json.loads(r[0]) if r else None


def usage():
    # The ledger key uses toISOString() (UTC), not local time.
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    return get("usage:" + day) or {"calls": 0, "errors": 0, "estTokensIn": 0, "estTokensOut": 0, "adviceChars": 0}


def ledger():
    return get("consult:ledger") or []


cmd = sys.argv[1]
if cmd == "usage":
    print(json.dumps(usage(), sort_keys=True))
elif cmd == "completed":
    sid = "ses_f206af9eaffe28wIOWXkTCG1RX"
    recs = [r for r in ledger() if r.get("sessionID") == sid]
    done = [r for r in recs if r.get("state") == "completed"]
    states = {}
    for r in recs:
        states[r.get("state")] = states.get(r.get("state"), 0) + 1
    print(f"SESSION_RECORDS={len(recs)} COMPLETED={len(done)} STATES={json.dumps(states, sort_keys=True)}")
    print(f"USED={len(done)} (successful consults this task = the cap counter)")
elif cmd == "ledger":
    recs = ledger()
    print(f"LEDGER_RECORDS={len(recs)}")
    for r in recs[-40:]:
        print("  " + json.dumps({k: r.get(k) for k in
              ("at", "id", "sessionID", "status", "mode", "delivery", "used", "cap",
               "error", "elapsedMs", "note") if k in r}, sort_keys=True)[:400])
elif cmd == "session":
    sid = sys.argv[2]
    recs = [r for r in ledger() if r.get("sessionID") == sid]
    print(f"SESSION_RECORDS={len(recs)} for {sid}")
    for r in recs:
        print("  " + json.dumps(r, sort_keys=True)[:500])
elif cmd == "mark":
    lab = sys.argv[2]
    m = json.loads(MARKS.read_text()) if MARKS.exists() else {}
    m[lab] = usage()
    MARKS.write_text(json.dumps(m, indent=2, sort_keys=True))
    print(f"MARKED {lab} = {json.dumps(m[lab], sort_keys=True)}")
elif cmd == "delta":
    lab = sys.argv[2]
    m = json.loads(MARKS.read_text())
    b = m[lab]
    a = usage()
    d = {k: a.get(k, 0) - b.get(k, 0) for k in ("calls", "errors", "estTokensIn", "estTokensOut", "adviceChars")}
    print(f"DELTA[{lab}] = {json.dumps(d, sort_keys=True)}")
    print(f"  USD_in=%.4f USD_out=%.4f USD_total=%.4f" % (
        d["estTokensIn"] / 1e6 * 1.40, d["estTokensOut"] / 1e6 * 4.40,
        d["estTokensIn"] / 1e6 * 1.40 + d["estTokensOut"] / 1e6 * 4.40))
else:
    print(__doc__)
