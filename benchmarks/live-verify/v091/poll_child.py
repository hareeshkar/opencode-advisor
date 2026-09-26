import sqlite3, pathlib, sys, json
db = pathlib.Path.home()/'.local/share/opencode/opencode.db'
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
ch = con.execute("SELECT id, time_created FROM session_v2 WHERE title='advisor consult' ORDER BY time_created DESC LIMIT 1").fetchone()
if not ch:
    print("no advisor child yet"); sys.exit(0)
cid, tcreated = ch
rows = [r[0] for r in con.execute("SELECT data FROM session_message WHERE session_id=?", (cid,))]
parts = sum(r.count('"type":"tool"') for r in rows)
names = []
for r in rows:
    import re
    names += re.findall(r'"type":"tool","tool":"([a-z_]+)"', r)
print(f"child={cid} rows={len(rows)} tool_PARTS={parts} elapsed_since_create={(int(__import__('time').time()*1000)-tcreated)//1000}s")
print("tool names:", names[:40])
