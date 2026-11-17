#!/usr/bin/env bash
# Arrête le serveur Meydan lancé par start-dev.sh (par le PID du port, jamais par motif).
# Les consoles tmux (-L meydan) continuent de tourner : c'est le but.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${MEYDAN_PORT:-3070}"

PID="$(ss -ltnpH "sport = :${PORT}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
if [ -z "$PID" ]; then
  echo "rien n'écoute sur ${PORT}"
  exit 0
fi
CMD="$(tr '\0' ' ' < "/proc/${PID}/cmdline")"
case "$CMD" in
  *server.mjs*) ;;
  *) echo "❌ le port ${PORT} appartient à autre chose : ${CMD}" >&2; exit 1 ;;
esac
kill "$PID"
for _ in $(seq 1 30); do
  if ! ss -ltn | grep -qE "127\.0\.0\.1:${PORT}\b"; then
    rm -f .dev.pid
    echo "✅ arrêté (pid ${PID}), port ${PORT} libre"
    exit 0
  fi
  sleep 0.1
done
echo "❌ le port ${PORT} écoute encore" >&2
exit 1
