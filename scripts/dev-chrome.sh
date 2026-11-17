#!/usr/bin/env bash
# Chromium sans écran pour les captures d'essai (port de débogage 9222, boucle locale seulement).
set -euo pipefail
if ss -ltn | grep -qE '127\.0\.0\.1:9222\b'; then
  echo "chromium déjà à l'écoute sur 9222"
  exit 0
fi
PROFILE="$HOME/snap/chromium/common/meydan-dev-profile"
setsid nohup chromium --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --window-size=1680,1050 about:blank \
  > /dev/null 2>&1 < /dev/null &
for _ in $(seq 1 80); do
  if ss -ltn | grep -qE '127\.0\.0\.1:9222\b'; then
    echo "✅ chromium à l'écoute sur 127.0.0.1:9222"
    exit 0
  fi
  sleep 0.1
done
echo "❌ chromium n'écoute pas sur 9222" >&2
exit 1
