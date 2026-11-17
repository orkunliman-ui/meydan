#!/usr/bin/env bash
# Lance Meydan dans un environnement propre : aucune variable du shell appelant (ni celles d'une session d'agent) ne
# passe au serveur, donc aux consoles. Seuls passent les réglages MEYDAN_* écrits dans meydan.env (voir
# meydan.env.example). Avec pm2 :
#   pm2 start scripts/run.sh --name meydan --interpreter bash --cwd <dossier de meydan>
# `exec` : pm2 suit directement le processus node (même PID), ses signaux l'atteignent.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_BIN="$(dirname "$(command -v node)")"
reglages=()
if [ -f meydan.env ]; then
  while IFS= read -r ligne || [ -n "$ligne" ]; do
    case "$ligne" in ''|'#'*) continue ;; esac
    [[ "$ligne" =~ ^MEYDAN_[A-Z0-9_]+=.*$ ]] || { echo "meydan.env : ligne ignorée (seules les lignes MEYDAN_…=… comptent) : ${ligne%%=*}" >&2; continue; }
    reglages+=("$ligne")
  done < meydan.env
fi
exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/bash LANG="${LANG:-C.UTF-8}" TERM=xterm-256color \
  PATH="${NODE_BIN}:${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" \
  MEYDAN_PORT="${MEYDAN_PORT:-3070}" "${reglages[@]}" \
  node server.mjs
