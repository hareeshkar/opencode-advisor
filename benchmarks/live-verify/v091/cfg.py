#!/usr/bin/env python3
"""Write opencode-advisor.json atomically, print sha256 before/after.

Usage:
  cfg.py write '<json>'      # overwrite config with json
  cfg.py reset               # restore INTENDED baseline
  cfg.py sha                 # print current sha256
  cfg.py show                # print current content
"""
import hashlib
import json
import os
import pathlib
import sys
import time

P = pathlib.Path.home() / ".config/opencode/opencode-advisor.json"
BASELINE = {
    "advisor": {"providerID": "zai-coding-plan", "id": "glm-5.3"},
    "transcriptBudgetTokens": 32000,
    "maxToolOutputChars": 3000,
}
BACKUP = pathlib.Path(__file__).parent / "baseline-config.json"


def sha(p=P):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else "MISSING"


def write(obj):
    before = sha()
    tmp = P.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    os.replace(tmp, P)
    after = sha()
    print(f"SHA_BEFORE={before}")
    print(f"SHA_AFTER={after}")
    print(f"CONTENT={P.read_text().strip()}")


cmd = sys.argv[1]
if cmd == "write":
    write(json.loads(sys.argv[2]))
elif cmd == "reset":
    write(BASELINE)
elif cmd == "sha":
    print(sha())
elif cmd == "show":
    print(P.read_text() if P.exists() else "MISSING")
elif cmd == "backup":
    BACKUP.write_bytes(P.read_bytes())
    print(f"BACKED_UP sha={sha()}")
else:
    print(__doc__)
    sys.exit(1)
