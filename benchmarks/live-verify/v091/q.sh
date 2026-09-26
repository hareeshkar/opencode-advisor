#!/bin/zsh
# v0.9.1 verification query helper. Read-only sqlite against opencode.db.
# Usage: q.sh "<SQL>"
NS="plugin:006f00700065006e0063006f00640065002d00610064007600690073006f0072"
DB="file:$HOME/.local/share/opencode/opencode.db?mode=ro"
SQL="$1"
SQL="${SQL//NS/$NS}"
sqlite3 "$DB" "$SQL"
