// Meydan — moteur : consoles = sessions tmux, servies au navigateur par WebSocket.
// Écoute sur 127.0.0.1 seulement. Accès par lien à clé (cookie), statut par hooks.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { verifyPassword, verifyTotp } from './lib/auth-core.mjs'
import * as envois from './lib/envois.mjs'
import * as fil from './lib/fil.mjs'
import * as sujet from './lib/sujet.mjs'
import * as question from './lib/question.mjs'
import * as relais from './lib/relais.mjs'
import * as boucle from './lib/boucle.mjs'
import { ouvreAlertes } from './lib/alertes.mjs'
import * as equipage from './lib/equipage.mjs'
import * as ordres from './lib/ordres.mjs'
import * as memoire from './lib/memoire.mjs'
import * as champ from './lib/champ.mjs'
// Le projet d'une console, calculé exactement comme le rangement par groupes de l'interface (module pur, sans importation).
import { projetDe, projetDeConsole } from './web/src/rangement.js'
import { autre, compteValide, ouvreComptes, quotaEcran } from './lib/comptes.mjs'
import { observeSilence, reporteSilence } from './lib/silence.mjs'
import * as verification from './lib/verification.mjs'
import { dossierSuggestions, listeSuggestions, leconDe } from './lib/suggestions.mjs'
import { racinesRevues, scanneRevues } from './lib/revues.mjs'
import { ouvreCartes } from './lib/cartes.mjs'
import { ouvreSur, envoieFd } from './lib/cartes-fichier.mjs'
import { ouvreRelais } from './lib/relais-web.mjs'
import { ouvreGit } from './lib/git-panneau.mjs'
// Volet « copies » (13/11, rattrapage de Symvibe 1.1.0) : copie de travail par console, et navigateur piloté par l'agent.
import { ouvreCopies } from './lib/copies.mjs'
import { ouvreNavigateurs } from './lib/navigateur.mjs'
import { ouvreOrdres } from './lib/ordres-serveur.mjs'
// Ateliers (volet du 13/11) : Document, Code, Markdown, Diagramme, en cartes (lib/ateliers.mjs, specs/001-ateliers/).
import { ouvreAteliers } from './lib/ateliers.mjs'
// Décisions d'Orkun du 17/11 (volet decisions-1711, lot « serveur ») : plafond de mémoire à l'ouverture d'une console.
import * as plafond from './lib/plafond.mjs'
import { ouvreNomsComptes } from './lib/comptes-noms.mjs'
import { ouvreEspaces } from './lib/espaces.mjs'
// Lot « sécurité » : garde du texte risqué dans la barre d'envoi (décision ordres-4).
import { gardeEnvoi } from './lib/garde-envoi.mjs'
import { ouvreBudget } from './lib/budget.mjs' // volet quota (17/11) : usage par console, budgets, validation des lancements

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.MEYDAN_DATA || path.join(ROOT, 'data')
const DIST = process.env.MEYDAN_DIST || path.join(ROOT, 'dist') // MEYDAN_DIST : une interface à l'essai, servie par un serveur d'aperçu à part
// La version de l'interface servie : le nom du script principal dans dist/index.html (« /assets/index-<empreinte>.js »),
// relu quand le fichier change. Vide si illisible : les pages ne comparent rien.
let versionLue = { mtime: 0, v: '' }
function versionInterface() {
  try {
    const f = path.join(DIST, 'index.html')
    const mtime = fs.statSync(f).mtimeMs
    if (mtime !== versionLue.mtime) versionLue = { mtime, v: /src="(\/assets\/index-[^"]+\.js)"/.exec(fs.readFileSync(f, 'utf8'))?.[1] || '' }
    return versionLue.v
  } catch {
    return ''
  }
}
const HOST = '127.0.0.1'
const PORT = Number(process.env.MEYDAN_PORT || 3070)
const SOCKET = process.env.MEYDAN_TMUX_SOCKET || 'meydan'
const HOME = os.homedir()
const TMUX = ['-L', SOCKET, '-f', path.join(ROOT, 'tmux.conf')]

// Environnement des consoles : liste blanche. Rien du processus parent ne fuit
// (en particulier les variables CLAUDE_* d'une session Claude Code qui lancerait le serveur).
const CHILD_ENV = {
  HOME,
  USER: os.userInfo().username,
  LOGNAME: os.userInfo().username,
  SHELL: process.env.SHELL || '/bin/bash',
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  LANG: process.env.LANG || 'C.UTF-8',
  TERM: 'xterm-256color',
}

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
// fichierPermis compare des chemins RÉELS : un MEYDAN_DATA avec une barre finale ou passant par un lien ferait servir les
// données de ce serveur (relecture du 13/11, volet plateau-creatif).
const DATA_REEL = fs.realpathSync(DATA)

function secret(name) {
  const file = path.join(DATA, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  const value = fs.readFileSync(file, 'utf8').trim()
  // Une clé vide ou tronquée (disque plein, fichier vidé à la main) s'ouvrirait à n'importe qui : on refuse de démarrer.
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`clé invalide : ${file} (le supprimer pour qu'il soit recréé)`)
  return value
}
const ACCESS_KEY = secret('access.key')
const HOOK_KEY = secret('hook.key')
// Jeton d'une console : dérivé d'une clé à part et de son identifiant, posé dans l'environnement de sa session tmux.
// Il ne vaut que pour cette console, sur les routes /agent/ de la boucle locale, et seulement si elle est dans une équipe.
const AGENT_KEY = secret('agent.key')
const tokenOf = (id) => crypto.createHmac('sha256', AGENT_KEY).update(id).digest('hex')
const SESSION = crypto.createHmac('sha256', ACCESS_KEY).update('meydan-session-v1').digest('hex')
const COOKIE = 'meydan_s'

// ── Accès public (téléphone) : derrière nginx, sous PUBLIC_HOST, avec les identifiants de data/auth.json (scripts/creer-acces.mjs)
// (mot de passe + code à 6 chiffres, toujours les deux). Le serveur n'écoute toujours que sur la boucle locale.
const PUBLIC_HOST = process.env.MEYDAN_PUBLIC_HOST ?? ''
const AUTH_FILE = process.env.MEYDAN_AUTH_FILE || path.join(DATA, 'auth.json')
let PUBLIC_KEY = secret('public.key') // propre à Meydan : remplacée à chaque déconnexion, ce qui ferme toutes les sessions publiques
const PCOOKIE = 'meydan_p'
const PUBLIC_TTL_S = 7 * 24 * 3600

// Identifiants lus à chaque usage : un changement de mot de passe vaut tout de suite. Fichier absent ou incomplet = accès public fermé.
function credentials() {
  try {
    const c = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    if (c.user && String(c.passwordHash).startsWith('scrypt$') && /^[A-Z2-7]{32}$/.test(c.totpSecret ?? '') && /^[0-9a-f]{64}$/.test(c.sessionSecret ?? '')) return c
  } catch {}
  return null
}
// Jeton de session publique « m1.<expiration>.<signature> ». La clé dérive du secret commun ET de la clé propre à Meydan :
// un cookie d'une autre application qui partage data/auth.json n'ouvre pas Meydan, et un cookie de Meydan n'ouvre aucune d'elles.
const publicMac = (c, body) =>
  crypto.createHmac('sha256', crypto.createHmac('sha256', Buffer.from(c.sessionSecret, 'hex')).update(`meydan-session-v1.${PUBLIC_KEY}`).digest()).update(body).digest('base64url')
function signPublic(c, now = Date.now()) {
  const body = `m1.${Math.floor(now / 1000) + PUBLIC_TTL_S}`
  return `${body}.${publicMac(c, body)}`
}
// Fin de validité du jeton (en ms), ou 0 s'il est faux, retouché ou périmé.
function publicExp(token, now = Date.now()) {
  const m = /^m1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''))
  // Borne haute : ce serveur n'émet aucun jeton qui expire plus tard que maintenant + sa durée de vie. Un jeton fabriqué
  // « pour toujours » avec des clés volées est refusé.
  if (!m || Number(m[1]) * 1000 <= now || Number(m[1]) > Math.floor(now / 1000) + PUBLIC_TTL_S) return 0
  const c = credentials()
  return c && same(m[2], publicMac(c, `m1.${m[1]}`)) ? Number(m[1]) * 1000 : 0
}
const publicSession = (token) => publicExp(token) > 0
// Déconnexion : la clé propre à Meydan est remplacée, donc TOUTES les sessions publiques tombent (un seul utilisateur :
// se déconnecter d'un appareil les ferme tous) et les liaisons ouvertes sous le nom public sont coupées.
function closePublicSessions() {
  fs.writeFileSync(path.join(DATA, 'public.key'), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  PUBLIC_KEY = secret('public.key')
  for (const ws of wss.clients) if (ws.publicExp) ws.close(4401, 'session finie')
}

// ── Hooks Claude Code : un fichier de réglages à part, passé par `claude --settings`.
// Le fichier global ~/.claude/settings.json n'est jamais touché.
const HOOK_HEADER = path.join(DATA, 'hook.header')
const CLAUDE_HOOKS = path.join(DATA, 'claude-hooks.json')
const CODEX_RUN = path.join(DATA, 'codex-meydan.sh')
// Commande de Codex lancée par ce script (les essais la remplacent par un faux, donné par son chemin complet, comme
// MEYDAN_CLAUDE_BIN plus bas). Jamais de caractère de shell : elle est écrite telle quelle dans le script.
const CODEX_BIN = process.env.MEYDAN_CODEX_BIN || 'codex'
if (!/^[A-Za-z0-9._\/@:=+-]+$/.test(CODEX_BIN)) throw new Error(`MEYDAN_CODEX_BIN invalide : ${CODEX_BIN}`)
const STATES = new Set(['starting', 'working', 'needs', 'ready', 'error', 'shell'])

function writeHookFiles() {
  fs.writeFileSync(HOOK_HEADER, `x-meydan-hook: ${HOOK_KEY}\n`, { mode: 0o600 })
  // Le corps (le JSON que l'agent donne au hook sur stdin) n'est transmis que là où il sert : « needs » et « error »
  // pour dire ce que l'agent attend ; début de session et fin de tour pour connaître la conversation à reprendre ; début
  // et fin de session aussi pour leur raison (une compaction, un /clear ne sont ni un repos ni une sortie).
  const cmd = (state, body = state === 'needs' || state === 'error') =>
    `curl -s --connect-timeout 1 -m 2 -o /dev/null -X POST -H @${HOOK_HEADER}${body ? ' --data-binary @-' : ''} "http://127.0.0.1:$MEYDAN_PORT/hook/$MEYDAN_ID/${state}" || true`
  const on = (state, matcher, body) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(state, body) }] }]
  const hooks = {
    SessionStart: on('ready', null, true),
    UserPromptSubmit: on('working'),
    PreToolUse: on('working'),
    PostToolUse: on('working'),
    PermissionRequest: on('needs'),
    Notification: [...on('needs', 'permission_prompt'), ...on('needs', 'elicitation_dialog'), ...on('ready', 'idle_prompt')],
    Stop: on('ready', null, true),
    StopFailure: on('error'),
    // 17/11 : avec son corps (sa raison). « clear » et « resume » ne quittent pas l'agent (lu dans le binaire 2.1.326 :
    // clear, resume, logout, prompt_input_exit, other) : voir la route des hooks.
    SessionEnd: on('shell', null, true),
  }
  fs.writeFileSync(CLAUDE_HOOKS, JSON.stringify({ hooks }, null, 2) + '\n', { mode: 0o600 })

  // Codex : mêmes hooks, passés par `-c hooks.<Événement>=…` le temps d'une session. ~/.codex/config.toml n'est jamais touché.
  // Codex ne lance un hook qu'après la revue de l'utilisateur (« Hooks need review ») : tant qu'elle n'est pas donnée,
  // aucun hook ne part et la console reste « EN COURS » comme avant.
  const codex = { SessionStart: ['ready', true], UserPromptSubmit: ['working'], PreToolUse: ['working'], PostToolUse: ['working'], PermissionRequest: ['needs'], Stop: ['ready', true], Interrupt: ['ready'], SessionEnd: ['shell'] }
  const args = Object.entries(codex).map(([event, [state, body]]) => `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(cmd(state, body))}}]}]`)
  if (args.some((a) => a.includes("'"))) throw new Error(`apostrophe dans le chemin ${DATA} : hooks Codex impossibles à citer`)
  fs.writeFileSync(CODEX_RUN, `#!/bin/sh\n# Écrit par Meydan à chaque démarrage — ne pas modifier à la main.\nexec ${equipage.sur(CODEX_BIN)} \\\n${args.map((a) => `  -c '${a}' \\\n`).join('')}  "$@"\n`, { mode: 0o700 })
}
writeHookFiles()

const onPath = (bin) =>
  CHILD_ENV.PATH.split(':').some((d) => {
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
// Commande de Claude Code (les essais la remplacent par un faux, donné par son chemin complet : le shell de la console
// remet ~/.local/bin en tête du PATH, où vit le vrai).
const CLAUDE_BIN = process.env.MEYDAN_CLAUDE_BIN || 'claude'
// Journaux de conversation des agents (remplacés par des dossiers jetables dans les essais).
const CLAUDE_PROJECTS = process.env.MEYDAN_CLAUDE_PROJECTS || path.join(HOME, '.claude', 'projects')
const CODEX_SESSIONS = process.env.MEYDAN_CODEX_SESSIONS || path.join(HOME, '.codex', 'sessions')
// Plusieurs comptes Claude / Codex (volet « comptes », docs/volets/comptes-contrat.md) : le compte 1 est l'actuel
// (~/.claude, ~/.codex : rien ne change), le compte 2 a son dossier à part (CLAUDE_CONFIG_DIR, CODEX_HOME), hors de
// ~/.claude* et ~/.codex*. Une console du compte 2 le dit dans `c.compte` ; ses journaux sont lus dans SES dossiers.
// Chemins résolus une fois (un chemin relatif passé à `tmux -e` vaudrait dans le dossier de chaque console).
const COMPTE2_CLAUDE = path.resolve(process.env.MEYDAN_COMPTE2_CLAUDE || path.join(HOME, '.meydan-comptes', 'claude-2'))
const COMPTE2_CODEX = path.resolve(process.env.MEYDAN_COMPTE2_CODEX || path.join(HOME, '.meydan-comptes', 'codex-2'))
const comptes = ouvreComptes({ home: HOME, claudeProjets: CLAUDE_PROJECTS, codexSessions: CODEX_SESSIONS, compte2Claude: COMPTE2_CLAUDE, compte2Codex: COMPTE2_CODEX })
// Fichiers d'identité des agents : jamais servis par Meydan, où qu'ils soient (route /fichier).
const IDENTITES = new Set(['.credentials.json', '.claude.json', 'auth.json'])
// Un chemin RÉEL (après realpath) que Meydan peut montrer : sous le dossier personnel, hors dossiers et fichiers cachés
// (`.env`, `.ssh`…), hors des dossiers du compte 2 (même placés ailleurs que sous un dossier caché), des fichiers
// d'identité d'agent et des données de Meydan. Rend '' ou la raison du refus. Partagé par la route /fichier des consoles
// et les cartes de fichiers du plateau (lib/cartes-fichier.mjs, volet plateau-creatif du 13/11).
// Les dossiers et fichiers exclus sont comparés par leur chemin réel (liens résolus), comme `reel`.
function fichierPermis(reel) {
  const reelOu = (p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const sous = (d) => reel === d || reel.startsWith(d + path.sep)
  if (typeof reel !== 'string' || !path.isAbsolute(reel) || !reel.startsWith(HOME + path.sep)) return 'hors du dossier personnel'
  if (reel.slice(HOME.length).split(path.sep).some((s) => s.startsWith('.'))) return 'dossier ou fichier caché'
  if ([COMPTE2_CLAUDE, COMPTE2_CODEX].map(reelOu).some(sous)) return 'dossier du compte 2'
  if (IDENTITES.has(path.basename(reel))) return 'fichier d’identité d’agent'
  if (sous(DATA_REEL)) return 'données de Meydan'
  // Les identifiants de la porte publique (mot de passe, code, secret de session) : refusés quel que soit leur nom.
  if (reel === reelOu(AUTH_FILE)) return 'identifiants de la porte publique'
  return ''
}
const compteDe = (c) => (c.compte === '2' ? '2' : '1') // champ absent = compte 1
// Le journal de la conversation d'une console : journalDe(c), plus bas (« Discussion poussée »), dans les dossiers de son compte.
const nonEmpty = (file) => {
  try {
    return fs.statSync(file).size > 0
  } catch {
    return false
  }
}
// Agents personnalisés : d'autres outils en ligne de commande (Gemini, OpenCode, aider…) proposés comme types de console.
// Orkun les déclare dans `data/agents.json` : [{ "id": "gemini", "label": "Gemini", "cmd": "gemini" }]. Pas de hooks pour
// eux : statut « EN COURS » tant qu'ils tournent, terminal seulement. Une entrée mal formée, un nom déjà pris ou une
// commande absente de la machine est ignorée (jamais de caractère de shell dans la commande).
function agentsPerso() {
  let liste
  try {
    liste = JSON.parse(fs.readFileSync(path.join(DATA, 'agents.json'), 'utf8'))
  } catch {
    return {} // pas de fichier (ou illisible) : aucun agent personnalisé
  }
  const pris = new Set(['shell', 'claude', 'codex', 'grok', 'equipe'])
  const out = {}
  for (const a of Array.isArray(liste) ? liste.slice(0, 12) : []) {
    const [id, cmd] = [String(a?.id ?? ''), String(a?.cmd ?? '')]
    if (!/^[a-z][a-z0-9-]{1,15}$/.test(id) || pris.has(id)) continue
    if (!/^[A-Za-z0-9._\/@:=+-]+( [A-Za-z0-9._\/@:=+-]+){0,11}$/.test(cmd) || !onPath(cmd.split(' ')[0])) continue
    pris.add(id)
    out[id] = { label: String(a.label ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 20) || id, cmd }
  }
  return out
}
// Les modèles qu'une console Claude peut recevoir à sa création (POST /api/consoles, `modele`) : posés par `--model` au lancement
// et repris à chaque relance. Sans `modele` : Opus, avec Fable en conseiller (`--advisor`, l'option de lancement derrière
// /advisor) — Orkun, 12/11 : « Je veux que le model soit Opus et que l'advisor (/advisor) soit Fable […] par défaut sur toutes
// les consoles ». Essayé le 12/11 (claude -p) : Opus, Sonnet et Haiku consultent bien Fable. Une console Fable n'en a pas.
// Les membres d'équipe gardent le modèle de leur rôle (claudeTeamArgs).
const MODELES = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'])
const MODELE_DEFAUT = 'claude-opus-5-5'
const CONSEILLER = 'claude-fable-5-2'
const lancementModele = (c) => {
  const m = MODELES.has(c.modele) ? c.modele : MODELE_DEFAUT
  return ` --model ${m}${m === CONSEILLER ? '' : ` --advisor ${CONSEILLER}`}`
}
const KINDS = {
  shell: { label: 'Shell', cmd: null },
  // --add-dir : Claude lit les pièces jointes de sa console (data/envois/<console>) sans demander de permission à chaque fois.
  // resume / journal : comment reprendre une conversation, et où voir qu'elle existe (voir « Reprise » plus bas).
  // memoireAuLancement : les faits validés du projet (voir « Mémoire du projet »), placés avant `--settings`, jamais après
  // `--add-dir` qui avalerait la valeur suivante. Aucun fait : rien d'ajouté, commande inchangée.
  claude: {
    label: 'Claude',
    cmd: (c) => `${CLAUDE_BIN}${c.team ? '' : lancementModele(c)}${!c.team && c.permission === 'auto' ? ' --permission-mode auto' : ''}${memoireAuLancement(c)} --settings ${c.team ? memberSettings(c) : CLAUDE_HOOKS} --add-dir ${envois.dirOf(DATA, c.id)}${c.team ? claudeTeamArgs(c) : ''}`,
    // Reprise d'une console hors équipe : `--system-prompt-snapshot off` (décision d'Orkun du 17/11, memoire-3 : « Rafraîchir
    // à chaque reprise »). Sans lui, Claude Code (2.1.326) renvoie l'invite système enregistrée à la première demande de la
    // conversation, faits de projet compris, même quand la relance passe un autre fichier (sondé le 17/11 avec Haiku :
    // ALPHA restait ALPHA ; avec « off », le nouveau mot était lu). Les équipiers ne reçoivent pas de faits : inchangés.
    resume: (base, agent, c) => `${base}${c?.team ? '' : ' --system-prompt-snapshot off'} --resume ${agent}`,
    journal: (agent, compte) => {
      const projets = comptes.journaux('claude', compte).projets
      return fs.readdirSync(projets).some((d) => nonEmpty(path.join(projets, d, `${agent}.jsonl`)))
    },
  },
  codex: {
    label: 'Codex',
    cmd: (c) => `${CODEX_RUN}${memoireAuLancement(c)}${c.team ? codexTeamArgs(c) : ''}`,
    resume: (base, agent) => `${base} resume ${agent}`,
    journal: (agent, compte) => fs.readdirSync(comptes.journaux('codex', compte).sessions, { recursive: true }).some((n) => String(n).endsWith(`-${agent}.jsonl`)),
  },
  // Grok (Orkun, 10/11 : « au cas où pour plus tard ») : proposé dès qu'une commande `grok` est installée (Grok Build, xAI).
  // Pas de hooks branchés : statut « EN COURS » tant qu'il tourne, comme Codex avant l'approbation des siens.
  ...(onPath('grok') ? { grok: { label: 'Grok', cmd: 'grok' } } : {}),
  ...agentsPerso(),
}
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash'])

// ── État (positions, noms, statuts) ─────────────────────────────────────────
const STATE_FILE = path.join(DATA, 'state.json')
let consoles = []
let teams = [] // équipes : un capitaine et ses équipiers (voir « Équipage » plus bas)
// Consoles bien formées dont le type n'est pas connu de CE démarrage (agent personnalisé dont la commande manque, `grok`
// absent du PATH, data/agents.json illisible) : gardées telles quelles et réécrites avec l'état, jamais montrées ni
// relancées ; elles reviennent au premier démarrage qui connaît leur type. Chasse du 17/11 : elles étaient écartées en
// silence et le premier `save()` les effaçait pour de bon (conversation à reprendre perdue, session tmux orpheline).
let horsType = []
try {
  // Seules les entrées de la forme attendue sont reprises : un état abîmé ne fait ni planter le démarrage (boucle de
  // relances pm2), ni sortir un chemin du dossier des équipes par un identifiant fantaisiste.
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const liste = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])
  teams = liste(state.teams).filter((t) => /^e[0-9a-f]{6}$/.test(t.id) && typeof t.projet === 'string')
  const bienFormees = liste(state.consoles).filter((c) => /^c[0-9a-f]{8}$/.test(c.id) && typeof c.cwd === 'string' && typeof c.kind === 'string' && (c.team === undefined || /^e[0-9a-f]{6}$/.test(c.team)))
  consoles = bienFormees.filter((c) => Object.hasOwn(KINDS, c.kind))
  horsType = bienFormees.filter((c) => !Object.hasOwn(KINDS, c.kind))
  if (horsType.length) console.error(`[état] ${horsType.length} console(s) d'un type inconnu de ce démarrage, gardée(s) à part : ${horsType.map((c) => `${c.id} (${c.kind})`).join(', ')}`)
} catch (e) {
  consoles = []
  // Fichier présent mais illisible (tronqué, abîmé) : mis de côté AVANT que le premier `save()` ne l'écrase par une liste
  // vide (chasse du 17/11 : toutes les consoles perdues, sans copie). Absent (premier lancement) : rien à garder.
  if (e.code !== 'ENOENT') {
    const cote = `${STATE_FILE}.illisible-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      fs.renameSync(STATE_FILE, cote)
      console.error(`[état] state.json illisible (${e.message}) : mis de côté dans ${path.basename(cote)}, départ sans console`)
    } catch (e2) {
      console.error(`[état] state.json illisible et impossible à mettre de côté (${e2.message})`)
    }
  }
}
function save() {
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ consoles: [...consoles, ...horsType], teams }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
}
const find = (id) => consoles.find((c) => c.id === id)

// ── tmux ────────────────────────────────────────────────────────────────────
// Délai maximal (chasse du 17/11) : un serveur tmux gelé (mémoire pleine, SIGSTOP) ne répondait jamais, et la
// réconciliation lançait un `tmux list-panes` de plus toutes les 3 s, sans limite ; tué au bout de 10 s, la commande
// échoue (tour de réconciliation sauté, voir `panes`).
const DELAI_COMMANDE = 10000
function commande(bin, args, env = CHILD_ENV) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, cwd: HOME, timeout: DELAI_COMMANDE }, (err, out, errOut) =>
      err ? reject(new Error((errOut || err.message).trim())) : resolve(out),
    )
  })
}
const tmux = (...args) => commande('tmux', [...TMUX, ...args])
// Le serveur tmux vit HORS du groupe de processus de pm2. 12/11 06:44 : la mise à jour automatique d'Ubuntu (needrestart)
// a relancé pm2-<utilisateur>.service (KillMode=control-group) ; le serveur tmux, né du moteur donc dans ce groupe, est mort avec
// lui : toutes les consoles fermées. `systemd-run --user --scope` démarre la commande dans un groupe à part, sous le
// gestionnaire de l'utilisateur (linger actif, sans sudo ; needrestart ne relance jamais user@.service) ; OOMPolicy=continue :
// un agent tué faute de mémoire ne fait pas tomber tout le groupe. Seul le premier `new-session` crée le serveur, mais chacun
// passe par là (le client sort aussitôt, --collect efface son groupe). Gestionnaire injoignable (essayé au démarrage) :
// tmux tel quel.
const ENV_SCOPE = { ...CHILD_ENV, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}` }
const SCOPE = ['--user', '--scope', '--quiet', '--collect', '-p', 'OOMPolicy=continue', '--']
const HORS_PM2 = (() => {
  try {
    execFileSync('systemd-run', [...SCOPE, 'true'], { env: ENV_SCOPE, stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
})()
console.log(`[tmux] serveur hors du groupe de pm2 : ${HORS_PM2 ? 'oui' : 'non (systemd-run --user injoignable)'}`)
const nouvelleSession = (...args) =>
  HORS_PM2 ? commande('systemd-run', [...SCOPE, 'tmux', ...TMUX, 'new-session', ...args], ENV_SCOPE) : tmux('new-session', ...args)
async function panes() {
  try {
    const out = await tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_current_command}\t#{window_activity}\t#{pane_title}')
    return new Map(
      out.split('\n').filter(Boolean).map((l) => {
        const [id, cmd, activity, ...titre] = l.split('\t')
        return [id, { cmd, sortie: Number(activity) * 1000 || undefined, titre: titre.join(' ') }]
      }),
    )
  } catch (e) {
    // Aucun serveur tmux (« no server running », socket absent) = aucune session. Toute autre erreur (fork impossible,
    // délai dépassé, serveur saturé) n'en dit rien : elle remonte, et la réconciliation saute ce tour au lieu de croire
    // toutes les sessions mortes (chasse du 17/11 : un seul échec passait toutes les consoles d'agents « fermées », durablement).
    if (/no server running|error connecting to/i.test(e.message)) return new Map()
    throw e
  }
}

export function safeDir(input, home = HOME) {
  if (typeof input !== 'string' || !input) throw new Error('dossier manquant')
  const real = fs.realpathSync(path.resolve(home, input))
  if (real !== home && !real.startsWith(home + path.sep)) throw new Error('dossier hors du répertoire personnel')
  if (!fs.statSync(real).isDirectory()) throw new Error("ce n'est pas un dossier")
  return real
}

function projects() {
  const out = [{ path: HOME, name: '~' }]
  for (const d of fs.readdirSync(HOME, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('_')) continue
    const p = path.join(HOME, d.name)
    if (['.git', 'tasks', 'package.json'].some((m) => fs.existsSync(path.join(p, m)))) out.push({ path: p, name: d.name })
  }
  return out.sort((a, b) => (a.name === '~' ? -1 : b.name === '~' ? 1 : a.name.localeCompare(b.name)))
}

function freeSlot() {
  const W = 720, H = 460, GAP = 48, COLS = 3
  for (let n = 0; ; n++) {
    const x = (n % COLS) * (W + GAP)
    const y = Math.floor(n / COLS) * (H + GAP)
    const taken = consoles.some((c) => Math.abs(c.x - x) < W / 2 && Math.abs(c.y - y) < H / 2)
    if (!taken) return { x, y, w: W, h: H }
  }
}

// ── Reprise : rouvrir une console terminée, avec la conversation de son agent ────────────────────────────
// Dessin : docs/specs/2026-11-10-reprise-apres-redemarrage.md (Orkun, 10/11 : « Automatique + bouton »).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// La conversation de cette console peut-elle être reprise ? Seulement si son journal existe sur le disque : une
// conversation jamais commencée n'en a pas, et demander sa reprise ferait échouer le lancement de l'agent.
function resumable(c) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(String(c.agent ?? '')) || !KINDS[c.kind]?.journal) return false
  try {
    return KINDS[c.kind].journal(c.agent, compteDe(c))
  } catch {
    return false // dossier des journaux absent ou illisible : on repart à neuf
  }
}

// Commande qui lance l'agent d'une console. `reprise` : reprendre sa conversation si c'est possible.
function launchOf(c, reprise = false) {
  if (c.verificationTeam) {
    const brief = path.join(DATA, 'verifications', c.id, 'brief.md')
    return `${CODEX_RUN} -s read-only -a on-request${codexSansMcp()} -- 'Lis ${equipage.sur(brief)} et applique uniquement ce mandat de vérification.'`
  }
  const k = KINDS[c.kind]
  const base = typeof k.cmd === 'function' ? k.cmd(c) : k.cmd
  if (base && reprise && k.resume && resumable(c)) return k.resume(base, c.agent, c)
  // Premier lancement d'un membre d'équipe : son brief lui est donné d'entrée. À une relance, il attend qu'on lui parle ;
  // s'il n'a aucune conversation à reprendre, il relit d'abord son brief (son rôle, ses règles) sans reprendre la tâche.
  // Console née d'un relais : au premier lancement, l'agent lit la conversation de celui qui lui passe la main.
  // « -- » pour Claude : sa commande finit par « --add-dir <dossier> », option qui prend plusieurs valeurs et avalait le
  // message (vu en production le 10/11 : la console du relais démarrait sans sa consigne ; sondé : avec « -- », il est pris).
  if (base && c.relais && !reprise && !c.team) return `${base}${c.kind === 'claude' ? ' --' : ''} '${RELAIS_MOT} ${equipage.sur(c.relais.fichier)}'`
  if (!base || !c.team) return base
  return `${base} '${reprise ? RELANCE_MOT : PREMIER_MOT} ${equipage.sur(path.join(memberDir(c), 'brief.md'))}'`
}

// Le jeton d'une console passe par un fichier (0600), pas par la ligne de commande : le serveur tmux garde pour toujours
// les arguments de la commande qui l'a démarré, lisibles par les autres comptes de la machine (ps). Un membre d'équipe
// l'a dans son dossier de serveur ; TOUTE autre console aussi, dans data/jetons/ : elle s'en sert pour devenir capitaine
// sur l'ordre d'Orkun (`meydan capitaine`, 11/11 : « c'est mon ordre qui prime sur tout »). Même valeur aux deux
// endroits (empreinte de l'identifiant) : une console promue garde son fichier d'avant.
function fichierJeton(c) {
  const f = c.team ? path.join(serverDir(c), 'jeton') : path.join(DATA, 'jetons', c.id)
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
  fs.writeFileSync(f, tokenOf(c.id) + '\n', { mode: 0o600 })
  return f
}

// tmux 3.4 lit l'argument de `-c` comme un FORMAT : un dossier nommé `#(commande)` faisait exécuter `sh` par le serveur
// tmux, hors de tout bac à sable (relecture du volet copies, 13/11, prouvé). `#` doublé = le dossier tel quel. Sondé le
// 13/11 : ni `-e`, ni `set-environment`, ni la commande d'un panneau, ni `send-keys -l`, ni `paste-buffer` ne sont lus
// comme des formats ; `load-buffer` ne reçoit qu'un chemin de DATA.
const dossierTmux = (d) => d.replaceAll('#', '##')

// Q10 (relecture n° 2 du volet quota, 17/11 ; volet dossier-equipier) : tmux fait son chdir sur la CHAÎNE de `-c`, dans
// le processus du terminal, après le fork, donc après tous les contrôles de Meydan. Un lien substitué entre les deux
// envoyait l'équipier ailleurs (au banc : 12 sur 40 hors du projet ou dans ~ entier), et un chdir raté le pose dans HOME
// sans rien dire (tmux 3.4, sondé le 17/11). Aucun chemin donné à tmux n'y échappe : `/proc/<pid>/fd/<n>` (dossier
// ouvert d'avance) donne bien le bon dossier, mais le shell garde PWD=/proc/…/fd/<n>, et le même repli sur HOME.
// Donc on lit le dossier du terminal lui-même, AVANT d'y taper la commande de l'agent : une fois sa commande exécutée
// (exe différent de celui du serveur tmux : le chdir est fait), il ne bouge plus tant que rien n'y est tapé. Chemin réel
// (readlink de /proc/<pid>/cwd) égal au dossier contrôlé ET, s'il est connu, son dev:ino (stat à travers ce même lien,
// sans résoudre de chemin). Écart, terminal parti ou délai dépassé : la session est fermée, rien n'est lancé.
const dossierChange = (detail) => Object.assign(new Error(`le dossier de travail a changé pendant le lancement (${detail}) : rien n’a été lancé`), { code: 409 })
async function terminalDans(id, dir, ident = null) {
  try {
    const [pid, serveur] = (await tmux('display', '-p', '-t', id, '#{pane_pid} #{pid}')).trim().split(' ')
    const exeServeur = fs.readlinkSync(`/proc/${serveur}/exe`)
    const t0 = Date.now()
    while (fs.readlinkSync(`/proc/${pid}/exe`) === exeServeur) {
      if (Date.now() - t0 > DELAI_COMMANDE) throw dossierChange('terminal pas démarré à temps')
      await sleep(5)
    }
    const reel = fs.readlinkSync(`/proc/${pid}/cwd`)
    const st = fs.statSync(`/proc/${pid}/cwd`, { bigint: true })
    if (reel !== dir) throw dossierChange(`contrôlé : ${dir} ; le terminal était dans : ${reel}`)
    if (ident && `${st.dev}:${st.ino}` !== ident) throw dossierChange(`${dir} n’est plus le dossier contrôlé : recréé ou remplacé`)
  } catch (e) {
    await tmux('kill-session', '-t', id).catch(() => {}) // déjà fermée : rien à faire
    throw e.code === 409 ? e : dossierChange(`terminal illisible : ${e.message}`)
  }
}

// `commande` (volet copies) : ce que le terminal montre au lieu du shell, le temps d'une installation (lib/copies.mjs,
// `affichage`) ; l'agent est lancé ensuite par demarreAgent. `ident` : dev:ino exigé du dossier (Q10, voir terminalDans).
async function openSession(c, dir, launch, commande = null, ident = null) {
  const id = c.id
  const env = ['-e', `MEYDAN_ID=${id}`, '-e', `MEYDAN_PORT=${PORT}`, '-e', `MEYDAN_TOKEN_FILE=${fichierJeton(c)}`]
  // Compte 2 (« Plusieurs comptes Claude / Codex ») : son dossier passe par l'environnement de la SESSION, pas devant la
  // commande : un `claude` ou un `codex login --device-auth` relancé à la main dans cette console reste sur ce compte.
  // `prepare` crée d'abord le dossier s'il manque (Codex refuse de démarrer sans lui). Compte 1 : rien de plus.
  let compteEnv
  try {
    compteEnv = comptes.prepare(c.kind, compteDe(c))
  } catch (e) {
    // Le détail (chemin complet) reste au journal du serveur ; la page reçoit un message clair (relecture du 11/11).
    console.error(`[comptes] dossier du compte ${compteDe(c)} (${c.kind}) inutilisable : ${e.message}`)
    throw Object.assign(new Error(`dossier du compte ${compteDe(c)} inutilisable (détail au journal du serveur)`), { code: 409 })
  }
  for (const [k, v] of Object.entries(compteEnv)) env.push('-e', `${k}=${v}`)
  await nouvelleSession('-d', '-s', id, '-x', '110', '-y', '30', '-c', dossierTmux(dir), ...env, ...(commande ? [commande] : []))
  await terminalDans(id, dir, ident) // Q10 : avant toute commande tapée
  fs.mkdirSync(envois.dirOf(DATA, id), { recursive: true, mode: 0o700 })
  if (launch) {
    await tmux('send-keys', '-t', id, '-l', launch)
    await tmux('send-keys', '-t', id, 'Enter')
  }
}

// Rouvre une console dont la session tmux n'existe plus : même identifiant, même dossier, agent relancé sur sa
// conversation. L'agent attend ensuite : rien n'est relancé tout seul.
async function revive(c) {
  const refus = (message) => Object.assign(new Error(message), { code: 409 })
  if (!Object.hasOwn(KINDS, c.kind)) throw refus(`type « ${c.kind} » indisponible sur ce serveur`)
  if ((await panes()).has(c.id)) throw refus('cette console tourne déjà')
  const dir = safeDir(c.cwd) // lève si le dossier a disparu
  await openSession(c, dir, launchOf(c, true))
  c.cmd = ''
  c.note = ''
  c.status = c.kind === 'shell' ? 'shell' : 'starting'
  c.since = Date.now()
  save()
  beat()
  broadcast({ type: 'console', console: c })
  return c
}

// Liste des consoles vivantes, écrite quand elle change. Une console terminée depuis moins d'une minute y reste : à
// l'arrêt du VPS, tmux peut tomber quelques secondes avant Meydan, qui marque alors tout « terminé ».
const ALIVE_FILE = path.join(DATA, 'vivantes.json')
let beatKey = null
function beat() {
  const now = Date.now()
  const ids = consoles.filter((c) => c.status !== 'closed' || now - c.since < 60000).map((c) => c.id)
  const key = ids.join(',')
  if (key === beatKey) return
  // Écriture qui échoue (disque plein, droits) : dite au journal et refaite au battement suivant. Chasse du 17/11 : levée
  // dans un minuteur, elle faisait tomber tout le moteur (et en boucle, `beat()` rejouant au démarrage).
  try {
    fs.writeFileSync(ALIVE_FILE + '.tmp', JSON.stringify({ at: now, ids }), { mode: 0o600 })
    fs.renameSync(ALIVE_FILE + '.tmp', ALIVE_FILE)
    beatKey = key
  } catch (e) {
    console.error(`[vivantes] écriture impossible : ${e.message}`)
  }
}

// Heure du démarrage du VPS (MEYDAN_BOOT_MS : pour les essais, qui ne peuvent pas redémarrer la machine).
const bootMs = () => (process.env.MEYDAN_BOOT_MS ? Number(process.env.MEYDAN_BOOT_MS) : Date.now() - parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000)

// Au lancement : si la liste des vivantes date d'avant le démarrage du VPS, c'est le premier lancement depuis un
// redémarrage. Les consoles de la liste dont la session manque sont rouvertes, une par une.
async function reviveAfterBoot() {
  let last
  try {
    last = JSON.parse(fs.readFileSync(ALIVE_FILE, 'utf8'))
  } catch {
    return 0 // pas de liste : rien à rouvrir
  }
  if (!Array.isArray(last.ids) || !(Number(last.at) < bootMs())) return 0
  const live = await panes().catch((e) => console.error(`[reprise] sessions tmux illisibles (${e.message}) : rien n'est rouvert`))
  if (!live) return 0
  let n = 0
  for (const id of last.ids) {
    const c = find(id)
    if (!c || live.has(id)) continue
    try {
      await revive(c)
      n++
      await sleep(700) // une par une : plusieurs agents qui démarrent ensemble chargent la machine
    } catch (e) {
      console.error(`[reprise] « ${c.name} » non rouverte : ${e.message}`)
    }
  }
  console.log(`[reprise] premier lancement depuis le redémarrage du VPS : ${n} console(s) rouverte(s) sur ${last.ids.length}`)
  return n
}
const newId = () => 'c' + crypto.randomBytes(4).toString('hex')
// `plus` : les champs d'un membre d'équipe (identifiant choisi d'avance, équipe, rôle…), connus avant le lancement.
// Volet copies : une console dont la copie a une installation (`plus.copie.installation`) s'ouvre sur le journal de
// l'installation ; son agent n'est lancé qu'à la fin de celle-ci (lib/copies.mjs, puis demarreAgent).
// `attendu` (Q10) : { reel, ident } du dossier que lancer() a contrôlé ; la console part là, pas dans ce qu'une nouvelle
// résolution du chemin donne (au banc, celle-ci rendait parfois la cible du lien : ~ entier passait safeDir).
async function createConsole({ kind, cwd, name, plus = {}, attendu = null }) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('type de console inconnu')
  const dir = safeDir(cwd)
  if (attendu && dir !== attendu.reel) throw dossierChange(`contrôlé : ${attendu.reel} ; maintenant : ${dir}`)
  const id = plus.id || newId()
  const now = Date.now()
  const c = {
    id,
    kind,
    cwd: dir,
    name: cleanName(name) || `${KINDS[kind].label} · ${path.basename(dir) || '~'}`,
    status: kind === 'shell' ? 'shell' : 'starting',
    since: now,
    createdAt: now,
    cmd: '',
    ...freeSlot(),
    ...plus,
  }
  // Volet copies : ouverte dans une copie existante (Dupliquer, relais…), elle en garde le repère, sans son installation.
  if (!c.copie && !c.team) {
    const herite = copies.herite(dir, consoles)
    if (herite) c.copie = herite
  }
  const installe = c.copie?.installation?.etat === 'en cours'
  await openSession(c, dir, installe ? null : launchOf(c), installe ? copies.affichage(c) : null, attendu?.ident)
  consoles.push(c)
  save()
  beat()
  broadcast({ type: 'console', console: c })
  if (installe) copies.installe(c)
  return c
}

// ── Copies de travail (volet « copies », 13/11 ; lib/copies.mjs) ──
// Une console lancée dans une copie neuve du dépôt de `cwd` : la copie d'abord (worktree, fichiers ignorés choisis),
// puis la console dedans ; la copie est retirée si la console ne peut pas être créée. `copie` : ce que rend
// copies.demande ({ motifs, fichiers, argv }).
async function creeEnCopie({ kind, cwd, name, plus = {}, copie }) {
  const dir = safeDir(cwd)
  const nom = cleanName(name) || `${KINDS[kind].label} · ${path.basename(dir) || '~'}` // le nom d'origine, pas celui de la copie
  const { cwdAgent, champ } = await copies.cree({ dossier: dir, nom, ...copie })
  try {
    return await createConsole({ kind, cwd: cwdAgent, name: nom, plus: { ...plus, copie: champ } })
  } catch (e) {
    await copies.retire(champ)
    throw e
  }
}
// L'installation finie (réussie ou non), l'agent est lancé dans la copie. Le terminal qui montrait le journal est
// remplacé par un shell neuf (respawn-pane : nouveau terminal, ce qui a pu y être tapé est jeté ; l'environnement de la
// session — MEYDAN_ID, jeton, compte — reste), puis la commande de l'agent y est tapée comme à toute création. La console
// repart « démarre » à cette heure-là : le délai de la question de démarrage compte depuis le lancement.
// `apresRedemarrage` : Meydan a redémarré pendant l'installation ; l'agent n'est lancé que si le terminal montre encore le
// journal (une console rouverte après un redémarrage du VPS a déjà le sien).
async function demarreAgent(c, { apresRedemarrage = false } = {}) {
  if (find(c.id) !== c || c.status === 'closed') return
  const pane = (await panes()).get(c.id)
  if (apresRedemarrage && pane?.cmd !== 'tail') return
  const dir = safeDir(c.cwd)
  c.status = 'starting'
  c.since = Date.now()
  c.note = ''
  if (pane) {
    await tmux('respawn-pane', '-k', '-t', c.id, '-c', dossierTmux(dir), `exec ${equipage.sur(CHILD_ENV.SHELL)} -l`)
    await terminalDans(c.id, dir) // Q10 : même chdir de tmux sur une chaîne, avant la commande de l'agent
    await tmux('send-keys', '-t', c.id, '-l', launchOf(c))
    await tmux('send-keys', '-t', c.id, 'Enter')
  } else await openSession(c, dir, launchOf(c)) // le terminal a été fermé pendant l'installation : session neuve
  save()
  broadcast({ type: 'console', console: c })
}

const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 48) : '')

// `note` = ce que l'agent attend (« Bash · npm test »). La première note d'une attente est gardée :
// la notification générique qui suit quelques secondes plus tard ne l'écrase pas.
// `parEcran` : l'état vient de ce que Meydan lit sur l'écran (un menu ouvert sans qu'aucun hook l'ait dit), pas d'un hook.
// Limite d'usage (limiteUsage, plus bas) : déclarées ici, avant setStatus qui les lit.
const quotaEcarte = new Map() // console → texte d'une limite effacée au retour au travail, encore à l'écran : pas reposée
const quotaAlerte = new Map() // console → heure de la dernière notification : une seule par demi-heure
const saisies = new Map() // console → texte d'Orkun pas encore envoyé dans son champ (voir noteFrappe, plus bas)
function setStatus(c, status, note = '', parEcran = false) {
  if (status === 'closed') saisies.delete(c.id) // une console relancée repart d'un champ vide
  if (parEcran) c.menuEcran = true
  else delete c.menuEcran // un hook (ou toute autre cause) reprend la main
  // Limite d'usage (voir limiteUsage) : effacée quand l'agent REPART au travail (passage, pas chaque hook « working »),
  // ou quand la console se ferme ; tant que sa ligne reste à l'écran, elle n'est pas reposée.
  if (c.quota && ((status === 'working' && c.status !== 'working') || status === 'closed')) {
    quotaEcarte.set(c.id, c.quota.texte)
    delete c.quota
  }
  const v = c.verificationTeam && (findTeam(c.verificationTeam)?.verification || c.verificationVerdict)
  const verdictFinal = v && v.etat !== 'active' && status !== 'closed'
  if (verdictFinal) { status = 'needs'; note = v.verdict || 'Vérification arrêtée : verdict à lire.' }
  // Le verdict remplace une éventuelle question antérieure du vérificateur, même déjà T'ATTEND.
  if (c.status === status && (verdictFinal ? c.note === note : c.note || !note)) return
  const attendait = c.status === 'needs'
  // 17/11 (chasse, n°6) : un équipier dont l'agent passe en erreur (limite d'usage, panne d'API : hook StopFailure) ou
  // revient au shell (SessionEnd, ou agent tué : vu par la réconciliation) ne disait rien au capitaine, qui a fini son tour
  // et attend d'être réveillé : l'équipe attendait en silence. Un réveil par passage (pas à chaque hook), jamais pour un
  // équipier qu'on ferme (`fermeture`), ni pour une console déjà terminée.
  if (c.team && !c.chief && !c.fermeture && c.status !== status && c.status !== 'closed' && (status === 'error' || status === 'shell'))
    wake(c.team, status === 'error'
      ? `${who(c)} : son agent est en erreur${note ? ` (${equipage.ligne(note, 200)})` : ''} : regarde sa console (voir ${c.id}), puis dis-lui de reprendre ou clos-le.`
      : `${who(c)} : son agent s'est arrêté (retour au shell) : il ne travaille plus. Clos-le et relance sa tâche si elle n'est pas finie (voir ${c.id}).`)
  // FINI (11/11, Orkun : « un signal quand une tache est terminé au lieu de juste dire au repos. Repos doit etre l'etat
  // apres que j'ai vu qu'il a terminé sa tache ») : un agent qui passe du travail au repos est marqué `fini` jusqu'à ce
  // qu'Orkun le voie (vuParOrkun) ; tout autre état (il repart, attend, se ferme…) efface la marque.
  if (status === 'ready' && (c.status === 'working' || c.status === 'running') && c.kind !== 'shell') c.fini = Date.now()
  else if (status !== 'ready') delete c.fini
  if (c.status !== status) c.since = Date.now()
  c.status = status
  c.note = note
  if (status === 'closed') lacheFil(c.id) // une console fermée ne garde pas de surveillant sur son journal
  if (!['working', 'running'].includes(status)) delete c.silence
  save()
  broadcast({ type: 'console', console: c })
  // Une console se met à l'attendre : notification du téléphone, quatre secondes plus tard si elle attend toujours (la
  // note précise d'une demande arrive parfois juste après le changement d'état).
  if (status === 'needs' && !attendait) {
    const depuis = c.since
    setTimeout(() => {
      if (find(c.id) === c && c.status === 'needs' && c.since === depuis) alerte({ title: `${c.name} t’attend`, body: c.note || 'Une question t’attend', tag: c.id, ouvre: c.id })
    }, 4000)
  }
}

// ── Notifications du téléphone (lib/alertes.mjs) ───────────────────────────────────────────────────────────────
// Seulement derrière le nom public (https). `MEYDAN_ALERTES=blanc` (essais) : rien ne part sur le réseau.
const alertes = PUBLIC_HOST ? ouvreAlertes(DATA, PUBLIC_HOST, { aBlanc: process.env.MEYDAN_ALERTES === 'blanc' }) : null
// Quelqu'un a-t-il Meydan sous les yeux ? Chaque page ouverte et visible le dit toutes les quinze secondes sur son flux
// d'état : dans ce cas le téléphone ne sonne pas pour ce qui est déjà à l'écran.
const regarde = () => [...watchers].some((w) => Date.now() - (w.vuLe || 0) < 25000)
function alerte(p) {
  if (!alertes || !alertes.nombre() || regarde()) return
  alertes.envoie(p).catch(() => {}) // un service de notification injoignable ne doit rien casser ici
}

// ── Plantage du moteur (17/11) ───────────────────────────────────────────────────────────────────────────────────
// Le 17/11 au matin, Meydan est tombé 3 fois (pm2 l'a relancé) sans que personne ne le voie : trouvé en lisant les
// journaux. Orkun, 17/11 : « Go pour tout » (« je te préviens sur le téléphone si Meydan redémarre sans mise en ligne »).
// Au moment où une exception non rattrapée fait tomber le processus, sa cause est écrite dans DATA/plantage.json
// (`uncaughtExceptionMonitor` observe sans rien changer : le processus tombe comme avant et pm2 le relance). Au démarrage
// suivant, ce fichier dit qu'on revient d'un plantage, pas d'une mise en ligne (une relance voulue ne l'écrit pas) : une
// notification part, l'entrée rejoint DATA/plantages.jsonl et le journal le dit. Pas couvert : un arrêt sans exception
// (manque de mémoire, SIGKILL).
const PLANTAGE = path.join(DATA, 'plantage.json')
process.on('uncaughtExceptionMonitor', (err, origine) => {
  try {
    fs.writeFileSync(PLANTAGE, JSON.stringify({ quand: Date.now(), origine, pile: String(err?.stack || err).slice(0, 4000) }), { mode: 0o600 })
  } catch {} // disque plein ou dossier absent : le plantage suit son cours
})
function revientDePlantage() {
  let p
  try {
    p = JSON.parse(fs.readFileSync(PLANTAGE, 'utf8'))
  } catch {
    return // démarrage normal (ou fichier illisible : rien à dire de sûr)
  } finally {
    fs.rmSync(PLANTAGE, { force: true })
  }
  const quand = Number.isFinite(p?.quand) ? p.quand : Date.now()
  const pile = String(p?.pile || '')
  const cause = pile.split('\n')[0].slice(0, 160) || 'cause inconnue'
  fs.appendFileSync(path.join(DATA, 'plantages.jsonl'), JSON.stringify({ quand, origine: String(p?.origine || ''), pile }) + '\n', { mode: 0o600 })
  const heure = new Date(quand).toLocaleTimeString('fr-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' })
  console.log(`[plantage] le moteur était tombé à ${heure} (${cause}) ; relancé par pm2`)
  alerte({ title: 'Meydan a redémarré seul', body: `Tombé à ${heure} : ${cause}. Relancé ; les consoles tournent toujours.`, tag: 'plantage' })
}

// ── Discussion poussée : le journal de chaque conversation est surveillé ─────────────────────────────────────────
// La discussion (web/src/Fil.jsx) relisait la route /fil en boucle : au repos, une bulle arrivait 2,7 à 3,7 s après
// (audits du 11/11), et un agent au travail coûtait 85 relectures par minute. Le serveur surveille maintenant le journal
// de chaque console Claude ou Codex ouverte et pousse sur /ws/events `{ type: 'fil', id, cle }` quand le fil montré
// change ; l'écran relit alors aussitôt. Aucun surveillant ne reste ouvert pour une console fermée ou retirée.

// Le chemin du journal, gardé par console tant que sa conversation (`c.agent`) ne change pas et que le fichier existe :
// sans lui, chaque lecture refaisait la recherche (un stat par dossier de projet pour Claude, une lecture récursive des
// sessions pour Codex ; moins d'une milliseconde mesurée le 11/11 sur les dossiers d'Orkun, mais à chaque lecture).
const journaux = new Map() // console → { agent, f }
function journalDe(c) {
  if (c.kind !== 'claude' && c.kind !== 'codex') return null
  const m = journaux.get(c.id)
  if (m && m.agent === c.agent && fs.existsSync(m.f)) return m.f
  // Dans les dossiers du compte de la console (volet comptes : le compte 2 a les siens).
  const f = c.kind === 'claude' ? fil.journalClaude(comptes.journaux('claude', compteDe(c)).projets, c.agent) : fil.journalCodex(comptes.journaux('codex', compteDe(c)).sessions, c.agent)
  if (f) journaux.set(c.id, { agent: c.agent, f })
  else journaux.delete(c.id)
  return f
}

// Le fil tel que la discussion le montre, et son empreinte. Un seul calcul, pour la route /fil et pour le surveillant :
// la `cle` poussée est exactement celle que la route rendra.
function filDe(c) {
  const journal = journalDe(c)
  // Les pièces jointes d'un message parti de la barre d'envoi : sorties du texte, montrées en vignettes par l'écran.
  const dossier = envois.dirOf(DATA, c.id)
  const lu = (journal ? fil.lireFil(c.kind, journal) : []).map((x) => {
    if (x.r !== 'toi' || !x.t.includes('Pièces jointes :')) return x
    const { texte, pieces } = envois.piecesDe(x.t, dossier)
    return pieces.length ? { ...x, t: texte, pieces } : x
  })
  return { lu, cle: crypto.createHash('sha1').update(JSON.stringify(lu)).digest('base64url').slice(0, 16) }
}

// Un surveillant par console au plus : { agent, f (journal surveillé), w (fs.watch), cle (dernière poussée), t }.
// Un agent écrit son journal par rafales (plusieurs lignes d'un coup, une ligne en deux écritures) : la première
// écriture arme un minuteur court, et le fil est relu quand il sonne. Une écriture arrivée pendant ou après cette
// relecture réarme un minuteur : la dernière n'est jamais perdue.
const surveilles = new Map()
const REGROUPE_MS = 80
function pousseFil(id) {
  const s = surveilles.get(id)
  const c = find(id)
  if (!s || !c) return
  let cle
  try {
    cle = filDe(c).cle
  } catch {
    return // journal illisible à l'instant : l'écriture suivante, ou le sondage lent de l'écran, le relira
  }
  if (cle === s.cle) return // ligne qui ne se montre pas (résultat d'outil, compte de jetons…) : rien à dire
  s.cle = cle
  broadcast({ type: 'fil', id, cle })
}
function lacheJournal(s) {
  clearTimeout(s.t)
  s.t = null
  s.w?.close()
  s.w = null
  s.f = null
}
function lacheFil(id) {
  const s = surveilles.get(id)
  if (s) lacheJournal(s)
  surveilles.delete(id)
}
// Appelé à chaque réconciliation (3 s) : surveillant posé dès que le journal d'une console existe, déplacé quand sa
// conversation change (relance, /clear : `c.agent` change), retiré pour une console fermée ou retirée. Une erreur ou un
// fichier renommé ferme le surveillant ; le journal est cherché de nouveau au tour suivant.
function surveilleFils() {
  for (const c of consoles) {
    if ((c.kind !== 'claude' && c.kind !== 'codex') || c.status === 'closed') continue
    let s = surveilles.get(c.id)
    if (s?.w && s.agent === c.agent) continue
    const connue = !!s // déjà vue à un tour précédent (pas au démarrage du serveur, ni à sa création)
    if (!s) surveilles.set(c.id, (s = { agent: c.agent, f: null, w: null, cle: undefined, t: null }))
    lacheJournal(s)
    s.agent = c.agent
    const f = journalDe(c)
    if (!f) continue
    const perdu = () => {
      lacheJournal(s)
      journaux.delete(c.id)
    }
    try {
      s.w = fs.watch(f, { persistent: false }, (quoi) => {
        if (quoi === 'rename') return perdu()
        if (s.t) return
        s.t = setTimeout(() => {
          s.t = null
          pousseFil(c.id)
        }, REGROUPE_MS)
      })
      s.w.on('error', perdu)
      s.f = f
    } catch {
      continue // fichier disparu entre la recherche et la pose
    }
    // Journal découvert, ou autre conversation : ce que l'écran a lu n'est peut-être plus le fil. Pas au démarrage :
    // personne n'est encore connecté, et la première lecture d'un gros journal coûte ~0,1 s.
    if (connue) pousseFil(c.id)
  }
  for (const id of surveilles.keys()) {
    const c = find(id)
    if (!c || c.status === 'closed') lacheFil(id)
  }
  for (const id of journaux.keys()) if (!find(id)) journaux.delete(id)
}

const VEILLE_FILE = path.join(DATA, 'veille.json')
let veille = { classes: [], notifiees: [], revues: [], fiable: true, derniereLecture: null }
try { Object.assign(veille, JSON.parse(fs.readFileSync(VEILLE_FILE, 'utf8'))) } catch {}
function gardeVeille() {
  const tmp = VEILLE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(veille), { mode: 0o600 }); fs.renameSync(tmp, VEILLE_FILE)
}
let scanEnCours = false
async function surveilleRevues() {
  if (scanEnCours) return
  scanEnCours = true
  try {
    const racines = process.env.MEYDAN_REVIEW_ROOTS ? JSON.parse(process.env.MEYDAN_REVIEW_ROOTS) : await racinesRevues(HOME)
    if (!Array.isArray(racines) || !racines.every((x) => typeof x === 'string' && path.isAbsolute(x))) throw new Error('racines invalides')
    const r = await scanneRevues(racines)
    veille.fiable = r.fiable
    veille.derniereLecture = Date.now()
    if (r.fiable) veille.revues = r.revues
    for (const x of r.revues) if (!veille.notifiees.includes(x.id)) {
      veille.notifiees.push(x.id)
      alerte({ title: 'Revue claudex-loop morte', body: `Aucun runner vivant pour ${path.basename(path.dirname(x.fichier))}. Consulte les alertes de Meydan.`, tag: `revue-${x.id}` })
    }
    gardeVeille()
  } catch { veille.fiable = false } finally { scanEnCours = false }
}

// Réconciliation : session morte → « closed » ; agent sorti (retour au shell) → « shell ».
// Un tour à la fois (chasse du 17/11) : avec tmux lent, les tours de 3 s s'empilaient. Un appel pendant un tour en cours
// rend la main aussitôt : le tour suivant verra tout.
let reconcileEnCours = false
async function reconcile() {
  if (reconcileEnCours) return
  reconcileEnCours = true
  try {
    await reconcile1()
  } finally {
    reconcileEnCours = false
  }
}
// Remise des messages en file : une erreur (écriture de l'état) est dite au journal, jamais laissée sans gestionnaire
// (promesse rejetée non attendue = processus tué sous Node 22).
const remets = (c) => flush(c).catch((e) => console.error(`[attente] ${c.name} : ${e.message}`))
async function reconcile1() {
  // Les consoles d'AVANT la lecture des sessions : une console créée pendant ce tour (createConsole ouvre sa session puis
  // l'ajoute ; un lancement de 12 agents dure ~6 s) n'est pas dans `live`, elle passait « closed » et aucune branche ne la
  // relevait ensuite (volet « raccourcis », 13/11 : 12 faux Claude lancés, plusieurs « closed » avec leur session tmux
  // vivante ; le volet plateau-pc l'avait soupçonné le 11/11). Elle est vue au tour suivant.
  const vues = [...consoles]
  const live = await panes()
  try { ordresWeb.tick() } catch (e) { console.error(`[ordres] ${e.message}`) } // barre d'ordres : retenues, réponses rendues
  for (const c of vues) {
    if (!consoles.includes(c)) continue // fermée et retirée pendant ce tour
    if (c.attente?.length || c.suspens) remets(c) // message en attente (ou collé sans Entrée) : remis dès que l'agent est au repos
    if (c.boucle?.etat === 'active') tourne(c).catch(() => {}) // boucle : un tour de plus, ou sa fin
    if (!live.has(c.id)) {
      if (c.status !== 'closed') {
        setStatus(c, 'closed')
        if (c.team && !c.chief && !c.fermeture) wake(c.team, `${who(c)} : sa console s'est fermée.`)
      }
      continue
    }
    // Volet copies : pendant l'installation de sa copie, l'agent n'est pas lancé (le terminal montre le journal) ; rien à
    // juger ici, sinon une installation longue la ferait passer « T'ATTEND · Question au démarrage » au bout de 15 s.
    if (copies.enInstallation(c)) continue
    const { cmd, titre } = live.get(c.id)
    // Le sujet de la session, dès que l'agent l'a nommée (lib/sujet.mjs). Rien de lu = on garde ce qu'on savait.
    const nom = SHELLS.has(cmd) ? null : c.kind === 'claude' ? sujet.sujetClaude(titre) : c.kind === 'codex' && c.agent ? (sujet.sujetsCodex(comptes.journaux('codex', compteDe(c)).index).get(c.agent) ?? null) : null
    const renomme = nom !== null && nom !== (c.sujet ?? '')
    if (renomme) {
      c.sujet = nom
      save()
    }
    if (cmd !== c.cmd || renomme) {
      c.cmd = cmd
      broadcast({ type: 'console', console: c })
    }
    const settling = c.status === 'starting' && Date.now() - c.since < 15000
    let ecranLu = null // l'écran capturé par menuSansHook pendant ce tour, repris par limiteUsage (une capture par console et par tour)
    if (SHELLS.has(cmd)) {
      if (c.status !== 'shell' && !settling) setStatus(c, 'shell')
    } else if (c.status === 'shell' || (c.kind !== 'claude' && !c.team && c.status === 'starting')) {
      // Un programme tourne mais aucun hook ne nous renseigne (Codex tant que ses hooks ne sont pas approuvés, ou commande lancée à la main).
      setStatus(c, 'running')
    } else if (c.status === 'starting' || (c.status === 'needs' && c.note === 'Question au démarrage')) {
      // Claude tourne sans avoir ouvert de session : il pose une question avant (confiance du dossier, serveur MCP, connexion).
      // La confiance du dossier, Meydan y répond « oui » lui-même (Orkun, 11/11) ; une autre question est dite dès que sa
      // boîte se voit à l'écran, à défaut au bout de 15 s.
      const ecran = await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => '')
      ecranLu = ecran // repris par limiteUsage (une capture par console et par tour)
      if (await accepteConfiance(c, ecran)) {
        if (c.status === 'needs') setStatus(c, 'starting')
      } else if (c.status === 'starting' && (!settling || question.menuOuvert(ecran))) setStatus(c, 'needs', 'Question au démarrage')
    } else if (AGENT_LU.has(c.status) || (c.status === 'needs' && c.menuEcran)) {
      ecranLu = await menuSansHook(c)
    }
    const silence = observeSilence(c, live.get(c.id).sortie)
    if (silence.change) { save(); broadcast({ type: 'console', console: c }) }
    if (silence.notifie) alerte({ title: `${c.name} est muette`, body: 'Aucune sortie depuis 15 minutes. Ouvre la console pour vérifier.', tag: `silence-${c.id}`, ouvre: c.id })
    await limiteUsage(c, ecranLu)
  }
  for (const t of teams) await verifieFin(t)
  surveilleFils()
}

// La question de confiance du dossier au lancement d'un agent : Meydan répond « Yes, I trust this folder » à la place
// d'Orkun (11/11 : « quand je lance une équipe ou lance une console claude, y a toujours la demande de "trust ce folder"
// […] mettre oui tout le temps par défaut de tout ce qui est lancé sur ce VPS »). Claude ne retient jamais la confiance
// du dossier personnel (doc. officielle : ni réglage ni option pour la garder), d'où la question à chaque console lancée
// dans ~ ; et ~/.claude.json, réécrit en permanence par les sessions ouvertes, n'est pas touché. La réponse passe par
// `question.repondre` (curseur relu avant Entrée : « No, exit » est le choix d'office), une tentative toutes les 15 s
// au plus par console. MEYDAN_CONFIANCE_AUTO=non coupe tout (les bancs d'essai, dont le décor garde cette question).
const CONFIANCE_AUTO = process.env.MEYDAN_CONFIANCE_AUTO !== 'non'
const confianceEssai = new Map() // console → heure de la dernière tentative
async function accepteConfiance(c, ecran) {
  if (!CONFIANCE_AUTO || (c.kind !== 'claude' && c.kind !== 'codex')) return false
  const rang = question.rangConfiance(ecran)
  if (rang < 0 || Date.now() - (confianceEssai.get(c.id) || 0) < 15000) return false
  confianceEssai.set(c.id, Date.now())
  try {
    await question.repondre({ ecran: () => tmux('capture-pane', '-p', '-J', '-t', c.id), touche: (t) => tmux('send-keys', '-t', c.id, t) }, rang, question.lireQuestion(ecran).options[rang].texte)
    console.log(`[confiance] ${c.name} : dossier ${c.cwd} approuvé (réponse automatique, ordre d'Orkun du 11/11)`)
    return true
  } catch (e) {
    console.error(`[confiance] ${c.name} : ${e.message}`)
    return false
  }
}

// Un menu ouvert à l'écran d'un agent sans qu'aucun hook l'ait dit : « /model », « /effort », un choix de Codex tant que
// ses hooks ne sont pas approuvés… (les questions et permissions de Claude, elles, arrivent par le hook PermissionRequest :
// vu sur un vrai Claude le 11/11, « T'ATTEND » en 3 s). La liste disait « PRÊT » ou « TRAVAILLE » alors qu'il attendait un
// choix. La console passe « T'ATTEND » (avec le titre de la question) dès que la boîte se voit, et retrouve son état
// d'avant quand elle se ferme — à moins qu'un hook ait parlé entre-temps.
const AGENT_LU = new Set(['ready', 'working', 'running'])
async function menuSansHook(c) {
  if (c.kind === 'shell') return
  const ecran = await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => '')
  if (await accepteConfiance(c, ecran)) return ecran // Codex, ou un équipier dans une copie neuve : la confiance du dossier, sans Orkun
  const ouvert = question.menuOuvert(ecran)
  if (ouvert && c.status !== 'needs') {
    c.avantMenu = c.status
    setStatus(c, 'needs', question.lireQuestion(ecran)?.titre || 'Un menu est ouvert', true)
  } else if (!ouvert && c.status === 'needs' && c.menuEcran) {
    const avant = c.avantMenu || 'ready'
    delete c.avantMenu
    setStatus(c, avant)
  }
  return ecran // repris par limiteUsage : une seule capture par console et par tour
}

// Limite d'usage du compte (« Plusieurs comptes Claude / Codex ») : aucun hook ne la dit, elle se lit sur l'écran
// (lib/comptes.mjs, quotaEcran) à chaque réconciliation, pour une console Claude ou Codex hors équipe au repos, en erreur
// ou qui tourne sans hooks. Trouvée : `c.quota = { depuis, texte }` est diffusé, le téléphone sonne une fois, et
// l'interface propose de relancer sur l'autre compte par le relais. Effacée quand l'agent repart au travail ou que la
// console se ferme (setStatus), ou quand la ligne n'est plus à l'écran. `ecran` : la capture de menuSansHook s'il y en a
// eu une pendant ce tour, sinon une seule capture ici.
// `working` et `needs` aussi (relecture du 11/11, lu dans Claude Code 2.1.322) : à la limite, Claude peut ouvrir tout seul
// son menu « What do you want to do? » (la console passe T'ATTEND) ou attendre la remise à zéro (« Usage limit reached ·
// continuing automatically … », toujours au travail). Lue seulement en tête de ligne propre à l'agent (quotaEcran).
const QUOTA_LU = new Set(['ready', 'error', 'running', 'working', 'needs'])
async function limiteUsage(c, ecran) {
  if ((c.kind !== 'claude' && c.kind !== 'codex') || c.team || !QUOTA_LU.has(c.status)) return
  ecran ??= await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => '')
  if (!ecran || !QUOTA_LU.has(c.status)) return // capture ratée (on garde ce qu'on savait), ou un hook a parlé pendant la capture
  const vu = quotaEcran(c.kind, ecran)
  if (!vu) quotaEcarte.delete(c.id)
  else if (quotaEcarte.get(c.id) === vu.texte) return // l'ancienne ligne, pas encore sortie de l'écran
  if (!vu) {
    if (!c.quota) return
    delete c.quota
  } else if (!c.quota) {
    c.quota = { depuis: Date.now(), texte: vu.texte }
    if (Date.now() - (quotaAlerte.get(c.id) || 0) > 30 * 60000) {
      quotaAlerte.set(c.id, Date.now())
      alerte({ title: `${c.name} : limite d'usage`, body: `Relancer sur le compte ${autre(compteDe(c))} ?`, tag: `q${c.id}`, ouvre: c.id })
    }
  } else if (c.quota.texte !== vu.texte) c.quota.texte = vu.texte
  else return
  broadcast({ type: 'console', console: c })
}

// ── Boucles : un message renvoyé à un agent jusqu'à une fin (lib/boucle.mjs) ─────────────────────────────
// Appelé à chaque réconciliation (3 s) pour une console dont la boucle est active. La dernière réponse de l'agent n'est
// relue qu'une fois par retour au repos (`vu`), pour y chercher la marque de fin.
const enBoucle = new Set()
async function tourne(c) {
  const b = c.boucle
  if (enBoucle.has(c.id) || (retard.get(c.id) || 0) > Date.now()) return
  enBoucle.add(c.id)
  try {
    let reponse = ''
    // Lue seulement une fois l'agent VRAIMENT au repos (le même délai que la décision) : lue plus tôt, elle était notée
    // comme vue puis ignorée, et la boucle passait devant la marque (vu sur un vrai agent : 6 tours au lieu de 3).
    if (c.status === 'ready' && Date.now() - c.since >= boucle.REPOS_MS && b.n > 0 && b.marque && c.since > b.dernier && b.vu !== c.since) {
      const journal = journalDe(c)
      reponse = journal ? relais.derniereReponse(fil.lireFil(c.kind, journal)) : ''
      b.vu = c.since
    }
    // Boucle « sur la sortie » : ce que la console guettée affiche (historique compris) ; un texte nouveau déclenche.
    if (b.quand === 'sortie') {
      const src = find(b.source)
      if (!src || src.status === 'closed') {
        Object.assign(b, { etat: 'finie', raison: 'console guettée fermée', attend: '' })
        save()
        broadcast({ type: 'console', console: c })
        return
      }
      if (boucle.guette(b, await tmux('capture-pane', '-p', '-J', '-S', '-', '-t', src.id).catch(() => ''))) save()
    }
    const d = boucle.decide(b, c, Date.now(), reponse)
    if (d.action === 'finit') {
      b.etat = 'finie'
      b.raison = d.raison
      alerte({ title: `Boucle finie : ${c.name}`, body: `${b.n} tour${b.n > 1 ? 's' : ''} — ${d.raison}`, tag: `b${c.id}`, ouvre: c.id })
    } else if (d.action === 'envoie') {
      // Jamais dans un menu ouvert ; Entrée ne part que si le message se voit à l'écran (comme les messages d'équipe).
      // Rien non plus par-dessus un message collé qui attend son Entrée, ni pendant une remise de la file (flush).
      if (c.suspens || delivering.has(c.id)) return
      if (question.menuOuvert(await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => ''))) return
      const texte = boucle.message(b)
      try {
        await pasteMessage(c.id, texte, { vuAvantEntree: true })
        boucle.envoye(b)
      } catch (e) {
        retard.set(c.id, Date.now() + 15000) // collage refusé par la console : nouvel essai dans 15 s
        if (!e.colle) return
        // Collé sans Entrée : ce tour est dans la console et n'y sera pas recollé (même défaut que la file, 13/11) ; son
        // Entrée, au repos suivant, passe par flush (acheve).
        boucle.envoye(b)
        suspend(c, texte, e.colle)
      }
    } else if (b.attend === d.raison) {
      return // rien de neuf à dire
    }
    b.attend = d.action === 'rien' ? d.raison : ''
    save()
    broadcast({ type: 'console', console: c })
  } finally {
    enBoucle.delete(c.id)
  }
}

// ── Mémoire du projet ───────────────────────────────────────────────────────
// Dessin : docs/specs/2026-11-11-memoire-projet.md (écart avec Symvibe, point 6 : « mémoire de projet (faits validés,
// poussés aux consoles) »). Fichiers et bornes : lib/memoire.mjs. Le projet d'une console : celui de son équipe (son
// dossier de travail, un worktree sous ~/meydan-equipes, ne le dit pas), sinon celui du rangement par groupes. Une clé
// invalide = pas de mémoire pour cette console.
function projetMemoire(c) {
  const team = c.team && findTeam(c.team)
  const projet = team ? projetDe(team.projet) : projetDeConsole(c)
  return memoire.cleValide(projet) ? projet : ''
}
const faitsValides = (projet) => (memoire.cleValide(projet) ? memoire.valides(DATA, projet) : [])
// Le brief d'un membre d'équipe : les faits du projet (tableau, même vide : il apprend `meydan fait`), ou null sans projet.
const memoireEquipe = (team) => {
  const projet = projetDe(team.projet)
  return memoire.cleValide(projet) ? memoire.valides(DATA, projet) : null
}
const diffuseMemoire = (projet) => broadcast({ type: 'memoire', ...memoire.resume(DATA, projet) })

// Console Claude ou Codex hors équipe, à chaque lancement (premier et relance) : les faits validés de son projet (aucun,
// s'il n'en a pas encore) et la façon d'en proposer (`meydan fait`), dans un fichier réécrit à chaque fois, et l'option
// qui le donne à l'agent. Pas de projet reconnu : rien (commande inchangée). Un membre d'équipe reçoit la même chose dans
// son brief. La mémoire n'empêche jamais une console de démarrer : un échec (disque plein, chemin refusé par `sur`,
// dossier abîmé) est écrit au journal et la console part sans elle, commande inchangée.
function memoireAuLancement(c) {
  if (c.team) return ''
  try {
    const projet = projetMemoire(c)
    if (!projet) {
      memoire.oublieLancement(DATA, c.id) // pas de projet : pas d'ancien fichier qui traîne
      return ''
    }
    const f = memoire.ecritLancement(DATA, c.id, memoire.texteLancement(projet, faitsValides(projet), CLI))
    return c.kind === 'codex' ? memoire.optionCodex(f.toml) : memoire.optionClaude(f.md)
  } catch (e) {
    console.error(`[memoire] lancement sans mémoire pour ${c.id} : ${e.message}`)
    return ''
  }
}

// Routes d'Orkun : /api/memoire (les projets), /api/memoire/<projet> (lire, ajouter), /api/memoire/<projet>/<id>
// (modifier et/ou valider, supprimer ou refuser). Écrit par Orkun = validé d'office.
async function memoireApi(req, res, parts, m) {
  if (parts.length === 2 && m === 'GET') {
    const noms = new Set([...consoles.map(projetMemoire).filter(Boolean), ...memoire.projets(DATA)])
    return send(res, 200, { projets: [...noms].sort((a, b) => a.localeCompare(b)).map((p) => memoire.resume(DATA, p)), bornes: memoire.BORNES })
  }
  const projet = parts[2]
  if (!memoire.cleValide(projet)) return send(res, 400, { error: 'projet invalide' })
  if (parts.length === 3 && m === 'GET') return send(res, 200, memoire.lire(DATA, projet))
  let reponse
  if (parts.length === 3 && m === 'POST') reponse = [201, { fait: memoire.ajoute(DATA, projet, (await readJson(req))?.texte) }]
  else if (parts.length === 4 && m === 'PATCH') reponse = [200, { fait: memoire.modifie(DATA, projet, parts[3], await readJson(req)) }]
  else if (parts.length === 4 && m === 'DELETE') {
    memoire.supprime(DATA, projet, parts[3])
    reponse = [200, { ok: true }]
  } else return send(res, 404, { error: 'route inconnue' })
  diffuseMemoire(projet)
  return send(res, ...reponse)
}

// Routes d'un agent (`meydan fait`, `meydan faits`), ouvertes à TOUTE console Meydan. Le projet est celui de la console
// qui appelle, jamais un argument : un agent ne propose que pour son propre projet, et Orkun valide.
function projetAgent(me) {
  const projet = projetMemoire(me)
  if (!projet) throw refus('pas de mémoire de projet pour cette console (son projet n’a pas de nom utilisable)', 409)
  return projet
}
async function agentFait(req, res, me) {
  const projet = projetAgent(me)
  const r = memoire.propose(DATA, projet, (await readJson(req))?.texte, { console: me.id, nom: me.name }) // corps « null » : « fait vide »
  if (r.deja) return send(res, 200, { deja: r.deja, projet })
  diffuseMemoire(projet)
  return send(res, 201, { id: r.fait.id, projet })
}
function agentFaits(res, me) {
  const projet = projetAgent(me)
  const { faits } = memoire.lire(DATA, projet)
  return send(res, 200, { projet, faits: faits.filter((f) => f.etat === 'valide').map((f) => f.texte), proposes: faits.filter((f) => f.etat === 'propose').length })
}

// ── Équipage : un capitaine et ses équipiers ────────────────────────────────
// Dessin : docs/specs/2026-11-10-equipage.md (validé par Orkun le 10/11 : « go »). Chaque membre est une console
// ordinaire (session tmux, statut par hooks) ; l'équipe lui ajoute un rôle, un brief, un dossier de travail à part
// (worktree git) et une commande, bin/meydan, qui parle aux routes /agent/ avec le jeton de sa console.
const TEAMS_DIR = process.env.MEYDAN_TEAMS_DIR || path.join(HOME, 'meydan-equipes') // worktrees des équipes
// Copies de travail d'une console seule (« Nouvelle copie », volet copies du 13/11) : hors du dépôt, sous ~.
const COPIES_DIR = process.env.MEYDAN_COPIES_DIR || path.join(HOME, 'meydan-copies')
const TEAMS_DATA = path.join(DATA, 'equipes') // mission, briefs, rapports : le dossier d'équipe, ouvert en écriture aux membres
// Ce que le serveur écrit pour un membre APRÈS son lancement (journal de ses statuts, réglages Claude) vit à part, hors
// de portée du bac à sable : dans le dossier d'équipe, un membre remplacerait le fichier par un lien et ferait écrire le
// serveur (qui n'a pas de bac à sable) là où pointe le lien.
const TEAMS_LOG = path.join(DATA, 'equipes-journal')
function serverDir(c) {
  const d = path.join(TEAMS_LOG, c.team, c.id)
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}
const MAX_ATTENTE = 20 // messages en attente par console d'équipe
const ROLES_DIR = process.env.MEYDAN_ROLES_DIR || path.join(ROOT, 'agents')
const CLI = path.join(ROOT, 'bin', 'meydan')
const PREMIER_MOT = 'Lis ton brief et suis-le :'
// Premier message d'une console née d'un relais (pas d'apostrophe droite : il part entre apostrophes sur la ligne de commande).
const RELAIS_MOT = 'Tu prends le relais d’un autre agent, dans ce même dossier. Lis d’abord sa conversation, puis dis en quelques lignes où en est le travail et ce que tu proposes de faire ensuite. Ne modifie rien avant ma réponse. La conversation :'
// Membre relancé sans conversation à reprendre (pas d'apostrophe : la phrase part entre apostrophes dans le shell).
const RELANCE_MOT = 'Relance sans conversation a reprendre. Relis ton brief pour retrouver ton role et tes regles, puis attends un message avant de reprendre la tache :'
// Outils d'un membre Claude en mode restreint : commandes et fichiers, aucun serveur MCP sauf le navigateur d'Orkun
// (Orkun Browser par `--mcp-config`, Claude in Chrome en secours par `--chrome`, dans claudeTeamArgs, hors de cette
// liste). Le web et les sous-agents ne
// viennent qu'avec un rôle qui les demande (`outils:` dans agents/<rôle>.md, pris dans equipage.OUTILS_EN_PLUS : depuis le
// 16/11, l'éclaireur) ; les refus de `--settings` (pm2, git push, sudo…) tiennent aussi pour ses sous-agents (sondé en vrai).
const OUTILS_MEMBRE = 'Bash,Read,Edit,Write,Grep,Glob'
// Ce que le brief interdit déjà (règle 5) : `git push`, pm2, sudo, systemctl. Ces quatre refus de Claude Code ne lisent
// que le DÉBUT de la commande (préfixes) : `env pm2 …`, `bash -c 'pm2 …'`, `git -C x push` passaient (chasse du 17/11,
// n°13 ; le commentaire disait « rendu impossible », c'était faux). Ils restent, et la garde lib/garde-bash.mjs (hook
// PreToolUse des membres, GARDE_BASH plus bas) relit la commande entière. Ni l'un ni l'autre n'est une barrière : le
// membre tourne sous l'utilisateur d'Orkun, Bash sans bac à sable ; un script écrit puis lancé passe encore. La barrière
// (bac à sable de Claude Code) est une décision d'Orkun (docs/volets/equipes-robustes.md, D1).
const REFUS_MEMBRE = ['Bash(git push:*)', 'Bash(pm2:*)', 'Bash(sudo:*)', 'Bash(systemctl:*)']
// Le node qui fait tourner Meydan, par son chemin (le PATH d'une session d'agent peut en désigner un autre, ou aucun).
const GARDE_BASH = `${equipage.sur(process.execPath)} ${equipage.sur(path.join(ROOT, 'lib', 'garde-bash.mjs'))}`
const { refus } = equipage
const findTeam = (id) => teams.find((t) => t.id === id)
const teamDir = (teamId) => path.join(TEAMS_DATA, teamId)
const memberDir = (c) => path.join(TEAMS_DATA, c.team, c.id)
const membersOf = (teamId) => consoles.filter((c) => c.team === teamId)
const chiefOf = (teamId) => consoles.find((c) => c.team === teamId && c.chief)
const who = (c) => `${c.role} « ${c.nom} » (${c.id})`
const slug = (s) => s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'projet'

// Réglages Claude d'un membre : les hooks de statut, plus le refus d'avance des serveurs MCP de projet (sinon Claude
// pose la question dans chaque dossier neuf, et l'équipier attendrait Orkun). Rien n'est approuvé à sa place.
function memberSettings(c) {
  const file = path.join(serverDir(c), 'reglages.json')
  const { hooks } = JSON.parse(fs.readFileSync(CLAUDE_HOOKS, 'utf8'))
  // La garde des commandes Bash (n°13) : un refus (sortie 2) bloque la commande et son message va au modèle.
  hooks.PreToolUse = [...(hooks.PreToolUse || []), { matcher: 'Bash', hooks: [{ type: 'command', command: GARDE_BASH }] }]
  fs.writeFileSync(file, JSON.stringify({ hooks, permissions: { deny: REFUS_MEMBRE }, disabledMcpjsonServers: equipage.mcpNames(c.cwd) }, null, 2) + '\n', { mode: 0o600 })
  return equipage.sur(file)
}
// Le navigateur d'Orkun pour un membre Claude : Orkun Browser (~/chrome-bridge, l'extension de son profil
// Chrome habituel, le même serveur que `orkun-browser` chez Codex), seul serveur de `--mcp-config`. Réécrit à chaque
// lancement, à côté de reglages.json et comme lui hors de portée du membre.
const NAVIGATEUR_MCP = { mcpServers: { 'orkun-browser': { command: '/usr/bin/node', args: ['~/chrome-bridge/src/mcp.mjs'] } } }
function memberNavigateur(c) {
  const file = path.join(serverDir(c), 'navigateur-mcp.json')
  fs.writeFileSync(file, JSON.stringify(NAVIGATEUR_MCP) + '\n', { mode: 0o600 })
  return equipage.sur(file)
}
// Le capitaine lit et écrit tout le dossier de l'équipe ; un équipier, seulement le sien. Permissions surveillées (« auto »),
// jamais sautées. `--permission-mode` vient en dernier : `--add-dir` accepte plusieurs valeurs et avalerait le brief.
// Décision d'Orkun du 10/11 (« Go pour le reste ») : un membre ne reprend ni ses autorisations (scripts de déploiement,
// pm2, nginx), ni ses serveurs MCP et connecteurs (courrier, navigateur). `--restricted` écarte ses fichiers de
// réglages (ceux de `--settings` restent : nos hooks de statut, nos refus), borne les outils de fichiers au dossier de
// travail et aux dossiers ajoutés, et réserve à une personne toute écriture de réglages d'agents ;
// `--strict-mcp-config` = aucun serveur MCP hors de `--mcp-config` (et de `--chrome`). Sondé en vrai le 10/11 (Claude Code 2.1.322).
// 16/11, Orkun : option B, le navigateur pour toutes les consoles (capitaine compris, tous rôles) ; le reste de la
// décision du 10/11 est inchangé (courrier et autres connecteurs toujours coupés).
// 17/11, Orkun : Orkun Browser pour les équipiers (« au lieu de claude in chrome » : Claude in Chrome refuse des
// sites, reddit.com compris, Orkun Browser n'a pas cette liste), puis « laisse claude in chrome au cas ou je suis sur
// mon telephone et aucun pc allumé pour activer l'extension » et « Les deux » : `--chrome` gardé en secours (le brief
// dit Orkun Browser d'abord), plus `--mcp-config <navigateur-mcp.json>` (orkun-browser seul), `--strict-mcp-config`
// gardé. Les deux ensemble, sondé le 17/11 : 2 serveurs « dynamic » connectés, 12 + 19 outils, toujours sans
// `javascript_tool`. Orkun Browser seul, sondé en vrai le 17/11
// (Claude Code 2.1.326, la ligne d'un membre avec Haiku) : `--restricted` le laisse passer, seul serveur MCP
// (« dynamic », connecté), 12 outils mcp__orkun-browser__* sans rien ajouter à `--tools`, `list_browsers` appelé sous
// « auto » sans question ; en interactif, aucune question au démarrage, outils là dès le pas qui suit la lecture du
// brief (la toute première réponse d'une session peut partir avant la connexion du serveur). `--restricted` ne retire
// rien à ce serveur : `evaluate_script` (code dans la page) reste, le brief le borne à la lecture.
// `--mcp-config` prend plusieurs valeurs (comme `--add-dir`) : une option le suit toujours.
// 16/11 (Orkun : « les éclaireurs peuvent travailler sous Fable 5.2 en /advisor ») : un rôle peut ajouter un conseiller
// (`conseiller:` → `--advisor`, sauf si le membre tourne déjà sur ce modèle) et des outils pris dans
// equipage.OUTILS_EN_PLUS (`outils:` : recherche web, lecture de page, sous-agents), relus sur la console à chaque relance.
const outilsMembre = (c) => [OUTILS_MEMBRE, ...(Array.isArray(c.outils) ? c.outils.filter((t) => equipage.OUTILS_EN_PLUS.has(t)) : [])].join(',')
const claudeTeamArgs = (c) =>
  ` --chrome --mcp-config ${memberNavigateur(c)} --restricted --strict-mcp-config --tools ${outilsMembre(c)} --add-dir ${equipage.sur(c.chief ? teamDir(c.team) : memberDir(c))}${c.modele ? ` --model ${equipage.sur(c.modele)}` : ''}${c.conseiller && c.conseiller !== c.modele ? ` --advisor ${equipage.sur(c.conseiller)}` : ''}${c.effort ? ` --effort ${equipage.sur(c.effort)}` : ''} --permission-mode auto`
// Codex : écriture limitée à son dossier de travail et à son dossier d'équipe ; réseau ouvert (dépendances, commande
// meydan). Son bac à sable garde les métadonnées git en lecture seule, même déclarées inscriptibles (essai réel du
// 10/11 : « index.lock » refusé) : il ne peut pas commiter, c'est Meydan qui commite à son « done » (voir declare).
// Ses serveurs MCP (documentation, courrier…) sont coupés un par un, relus dans la configuration de Codex à chaque
// lancement ; son navigateur `orkun-browser` reste (16/11, option B : equipage.NAVIGATEUR_CODEX). Vaut aussi pour la
// console Codex de vérification (launchOf, `-a on-request` : un appel au navigateur y demande l'accord). Un membre, lui,
// a les outils du navigateur approuvés d'avance (equipage.navigateurCodexApprouve), sinon ils lui sont tous refusés.
const configCodex = () => {
  try {
    return fs.readFileSync(path.join(path.dirname(CODEX_SESSIONS), 'config.toml'), 'utf8')
  } catch {
    return '' // pas de configuration lisible : rien à couper, rien à approuver
  }
}
const codexSansMcp = () => equipage.sansMcpCodex(configCodex())
const codexTeamArgs = (c) =>
  ` -s workspace-write -c sandbox_workspace_write.network_access=true${codexSansMcp()}${equipage.navigateurCodexApprouve(configCodex())} --add-dir ${equipage.sur(c.chief ? teamDir(c.team) : memberDir(c))}${c.modele ? ` -m ${equipage.sur(c.modele)}` : ''}`

// File de messages vers une console d'équipe : remis quand l'agent est au repos (« ready »), jamais pendant qu'il
// travaille ni devant une question. Gardée dans l'état : un redémarrage du serveur ne perd pas un réveil.
const delivering = new Set()
function enqueue(c, text) {
  const file = (c.attente ||= [])
  if (!file.length) c.attenteDepuis = Date.now() // ce que l'agent reçoit après cette heure-là peut être ce message (flush)
  // File pleine (agent qui ne revient pas au repos, équipier qui déclare en boucle) : rien ne s'empile au-delà, le
  // dernier message devient un renvoi vers l'état de l'équipe.
  if (file.length >= MAX_ATTENTE) file[MAX_ATTENTE - 1] = '[Meydan] D’autres messages ont suivi et n’ont pas été gardés : lance « meydan etat » pour voir où en est chacun.'
  else file.push(text)
  save()
  remets(c)
}
// Un message de la file (consigne de départ, message d'équipe) ne repart jamais une fois reçu par l'agent. 13/11
// (une session, 13:20) : des consignes collées sans Entrée étaient REMISES dans la file ; l'Entrée donnée à la main a
// lancé la mission, et au retour au repos Meydan recollait la consigne — désormais suivie de l'Entrée (correctif du champ
// borné), donc la mission repartait et écrasait ses sorties. Trois garde-fous :
//  - collé mais pas envoyé (pas vu à temps, question surgie avant l'Entrée) : le texte est dans la console ; il sort de
//    la file pour de bon et devient `c.suspens`, réglé au repos suivant (acheve) ;
//  - avant de coller, ce que la conversation de l'agent a déjà reçu depuis la mise en file est retiré (Entrée donnée à
//    la main, état écrit par un Meydan d'avant ce correctif) ;
//  - seul un échec AVANT le collage remet le lot dans la file.
const retard = new Map() // console → heure avant laquelle on ne retente pas de lui remettre ses messages
async function flush(c) {
  if ((!c.attente?.length && !c.suspens) || c.status !== 'ready' || delivering.has(c.id) || (retard.get(c.id) || 0) > Date.now()) return
  delivering.add(c.id)
  let lot = []
  const depuis = c.attenteDepuis ?? c.createdAt // file d'un état d'avant ce correctif : la naissance de la console
  try {
    await sleep(400) // l'agent vient de rendre la main : son invite doit être affichée
    if (find(c.id) !== c || c.status !== 'ready') return
    // L'agent a pu sortir sans que le statut le sache encore (réconciliation toutes les 3 s) : dans un shell, la ligne
    // collée puis validée serait exécutée comme une commande.
    if (SHELLS.has((await panes()).get(c.id)?.cmd)) return
    if (c.suspens) return await acheve(c) // un message collé attend encore son Entrée : rien par-dessus
    lot = c.attente.splice(0)
    const recu = recuDepuis(c, depuis)
    const deja = lot.filter(recu)
    if (deja.length) {
      lot = lot.filter((t) => !recu(t))
      console.log(`[attente] ${c.name} : ${deja.length} message(s) déjà reçu(s) par l’agent, retiré(s) de la file sans être recollé(s)`)
    }
    const t0 = Date.now()
    if (lot.length) await pasteMessage(c.id, lot.join('\n'), { vuAvantEntree: true })
    try { ordresWeb.remis(c, lot, t0) } catch (e) { console.error(`[ordres] ${e.message}`) } // barre d'ordres : les ordres de ce lot sont remis (lib/ordres-serveur.mjs) ; jamais une erreur qui ferait recoller le lot
    lot = []
  } catch (e) {
    retard.set(c.id, Date.now() + 15000) // collage refusé par la console (boîte ouverte…) : pas de nouvel essai avant 15 s
    if (e.colle) {
      suspend(c, lot.join('\n'), e.colle)
      lot = []
    }
  } finally {
    if (lot.length) {
      c.attente = [...lot, ...(c.attente || [])] // pas collé : remis plus tard, dans l'ordre
      c.attenteDepuis = depuis
    } else if (!c.attente?.length) delete c.attenteDepuis
    delivering.delete(c.id)
    save()
  }
}
// Ce que l'agent a reçu depuis `depuis` : les messages de sa conversation, lus dans son journal (Claude, Codex). Un texte
// est reçu si l'un d'eux le contient, blancs retirés (le collage d'Orkun du 11/11 y est en 5 exemplaires d'un seul
// message) ; ses 1 000 premiers caractères suffisent (un long message est coupé à la lecture). Sans journal : rien.
function recuDepuis(c, depuis) {
  let recus = []
  try {
    const f = journalDe(c)
    if (f) recus = fil.recus(c.kind, f).filter((x) => Date.parse(x.at) >= depuis).map((x) => sansBlancs(x.t))
  } catch {} // journal illisible à l'instant : rien de tenu pour reçu
  return (texte) => {
    const cle = sansBlancs(texte).slice(0, 1000)
    return !!cle && recus.some((t) => t.includes(cle))
  }
}
function suspend(c, texte, { avant, depuis, vu }) {
  c.suspens = { texte, avant, depuis, vu }
  console.log(`[attente] ${c.name} : message collé sans Entrée (${vu ? 'question surgie' : 'pas vu à temps'}) : hors de la file, jamais recollé`)
}
// Au repos suivant, le message collé sans Entrée :
//  - reçu par l'agent depuis le collage (Entrée donnée à la main) : fini ;
//  - encore à l'écran (une de ses traces a monté depuis le collage) : l'Entrée seule, jamais un second exemplaire ;
//  - plus aucune trace alors qu'il avait été vu : effacé du champ par Orkun, laissé tel quel ;
//  - jamais vu, toujours aucune trace : il n'est pas arrivé (avalé par une boîte) : remis en tête de la file.
async function acheve(c) {
  const s = c.suspens
  if (recuDepuis(c, s.depuis)(s.texte)) {
    delete c.suspens
    return console.log(`[attente] ${c.name} : message collé reçu par l’agent (Entrée donnée à la main)`)
  }
  if ((await tracesDe(c.id, s.texte)).some((n, k) => n > s.avant[k])) {
    // Comme pasteMessage : jamais d'Entrée devant une question ou un menu, elle y validerait le choix par défaut.
    if (AWAITS.has(c.status) || question.menuOuvert(await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => ''))) return
    // Orkun a écrit derrière le message collé : Entrée enverrait les deux (17/11, n°15). Le message attend dans le champ.
    if (saisies.has(c.id)) return
    delete c.suspens
    await tmux('send-keys', '-t', c.id, 'Enter')
    return console.log(`[attente] ${c.name} : message collé encore dans le champ, Entrée donnée`)
  }
  delete c.suspens
  if (s.vu) return console.log(`[attente] ${c.name} : message collé effacé du champ, laissé tel quel`)
  c.attente = [s.texte, ...(c.attente || [])]
  c.attenteDepuis = Math.min(c.attenteDepuis ?? s.depuis, s.depuis)
  console.log(`[attente] ${c.name} : message collé jamais arrivé (aucune trace), remis en file`)
}
// Réveil du capitaine : une ligne dans sa console. Entre deux réveils il ne consomme rien.
function wake(teamId, text) {
  const chief = chiefOf(teamId)
  if (chief) enqueue(chief, `[Meydan] ${text}`)
}
// Des sous-agents d'un équipier Claude encore au travail en arrière-plan : le corps du hook « Stop » les liste
// (`background_tasks` ; sondé en vrai le 17/11, Claude Code 2.1.326 : { type: 'subagent', status: 'running' } tant
// qu'il tourne, absent une fois rendu). Une commande de fond (`type: 'shell'`, un serveur de dev…) ne compte pas : elle
// peut tourner sans fin et retiendrait l'alerte pour toujours.
function sousAgentsAuTravail(raw) {
  try {
    const t = JSON.parse(raw || '{}').background_tasks
    return Array.isArray(t) && t.some((x) => x?.type === 'subagent' && x.status === 'running')
  } catch {
    return false
  }
}
// Après un hook d'un membre d'équipe : à son retour au repos, ses messages en attente lui sont remis ; et si un équipier
// a fini son tour sans statut décisif (fini, bloqué, décision), le capitaine est prévenu. 17/11 (bruit signalé par la
// une autre session : ~4 alertes par éclaireur) : chaque retour d'un sous-agent de fond rouvre puis referme le tour de
// l'équipier ; tant qu'il lui en reste au travail, il n'a pas fini et le capitaine n'est pas dérangé. Sa dernière fin
// de tour, sous-agents rendus, alerte comme avant.
function afterHook(c, avant, state, raw = '') {
  if (state !== 'ready') return
  if (!c.chief && ['working', 'running', 'needs'].includes(avant) && !equipage.WAKES.has(c.tour) && !sousAgentsAuTravail(raw))
    wake(c.team, `${who(c)} a fini son tour sans statut décisif${c.tour ? ` (dernier : ${c.tour})` : ''} : regarde sa console (voir ${c.id}).`)
  c.tour = ''
  const team = findTeam(c.team), v = team?.verification
  if (v?.etat === 'active' && v.attend[c.id] && c.etat?.verbe === 'done') {
    delete v.attend[c.id]
    const juge = find(v.console)
    if (juge) enqueue(juge, `[Meydan] ${who(c)} a redéclaré done. Relis ses preuves avec « ${CLI} verification etat » avant ton verdict.`)
    save(); broadcast({ type: 'team', team })
  }
  remets(c)
}

async function openMember(team, role, m) {
  const plus = { id: m.id, team: team.id, role: role.nom, nom: m.nom, chief: !!m.chief, ecrit: role.ecrit, modele: role.modele, effort: role.effort, ...(role.conseiller && { conseiller: role.conseiller }), ...(role.outils?.length && { outils: role.outils }), branch: m.branch || '', base: m.base || '', etat: null, tour: '' }
  const dossier = path.join(TEAMS_DATA, team.id, m.id)
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 })
  const texte = equipage.brief({ role, tache: m.tache || '', membre: { ...plus, cwd: m.cwd, baseRef: m.baseRef || '' }, equipe: team, cli: CLI, dossier: m.chief ? teamDir(team.id) : dossier, memoire: memoireEquipe(team) })
  fs.writeFileSync(path.join(dossier, 'brief.md'), texte, { mode: 0o600 })
  return createConsole({ kind: role.agent, cwd: m.cwd, name: m.chief ? `Capitaine · ${team.nom}` : `${role.titre} · ${m.nom}`, plus, attendu: m.attendu })
}

// Une console qui tourne déjà devient capitaine, sur l'ordre d'Orkun donné dans la console elle-même (11/11 : « quand je
// demande a une console d'agir en capitaine, qu'il le fasse. Je donne les droits, c'est mon ordre qui prime sur tout »).
// L'équipe est posée sur le dossier de la console, sans copie de travail (règle « sans git » : un équipier qui écrit par
// dossier) ; la console garde ses droits et son dossier. Arrêter l'équipe lui retire le rôle sans la fermer.
async function promouvoir(me, mission) {
  if (me.team) throw refus(me.chief ? 'cette console est déjà capitaine' : 'cette console est équipière d’une équipe', 409)
  if (me.kind !== 'claude' && me.kind !== 'codex') throw refus('seule une console Claude ou Codex peut être capitaine', 409)
  if (me.status === 'closed') throw refus('console terminée', 409)
  const role = equipage.loadRoles(ROLES_DIR).capitaine
  if (!role) throw refus('rôle « capitaine » introuvable dans agents/', 500)
  mission = String(mission ?? '').replace(/\r/g, '').trim() || 'Mission donnée par Orkun dans la console du capitaine.'
  if (mission.length > equipage.MAX_TASK) throw refus(`mission trop longue (${equipage.MAX_TASK} caractères au plus)`)
  const projet = safeDir(me.cwd)
  const id = 'e' + crypto.randomBytes(3).toString('hex')
  const team = { id, nom: equipage.ligne(mission, 48), mission, projet, git: false, branche: '', base: '', integration: '', promu: true, createdAt: Date.now(), pret: null, livre: null, chief: me.id }
  fs.mkdirSync(teamDir(id), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(teamDir(id), 'mission.md'), mission + '\n', { mode: 0o600 })
  teams.push(team)
  // Son modèle et son effort restent les siens (17/11, chasse n°8) : elle tourne déjà avec eux, et les remplacer par ceux
  // du rôle (vides) les perdait pour toujours — l'arrêt les effaçait, la relance repartait sur Opus + Fable au lieu de son
  // modèle choisi (Sonnet…), avec le coût qui va avec.
  Object.assign(me, { team: id, chief: true, role: role.nom, nom: 'capitaine', ecrit: role.ecrit, branch: '', base: '', etat: null, tour: '' })
  fichierJeton(me) // aussi dans son dossier de serveur d'équipe (même valeur que l'ancien fichier, qui reste valable)
  const dossier = memberDir(me)
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dossier, 'brief.md'), equipage.brief({ role, tache: '', membre: { ...me, cwd: me.cwd }, equipe: team, cli: CLI, dossier: teamDir(id), memoire: memoireEquipe(team) }), { mode: 0o600 })
  save()
  broadcast({ type: 'team', team })
  broadcast({ type: 'console', console: me })
  return team
}

// Une mission d'Orkun → une équipe et son capitaine. Sous git : le capitaine reçoit un worktree sur la branche
// d'intégration, partie de la tête du projet ; le dossier en service n'est pas touché.
async function createTeam({ cwd, mission, nom, verifierFin = false }) {
  const role = equipage.loadRoles(ROLES_DIR).capitaine
  if (!role) throw refus('rôle « capitaine » introuvable dans agents/', 500)
  mission = String(mission ?? '').replace(/\r/g, '').trim()
  if (!mission) throw refus('mission vide')
  if (mission.length > equipage.MAX_TASK) throw refus(`mission trop longue (${equipage.MAX_TASK} caractères au plus)`)
  const dir = safeDir(cwd)
  const d = await equipage.depot(dir)
  const id = 'e' + crypto.randomBytes(3).toString('hex')
  const projet = d ? safeDir(d.top) : dir
  if (typeof verifierFin !== 'boolean') throw refus('réglage Vérifier à la fin invalide')
  plafond.verifie() // décision d'Orkun du 17/11, raccourcis-3 : « refuser sous 4 Go de mémoire disponible » : avant le worktree du capitaine (lib/plafond.mjs)
  const team = { verifierFin, id, nom: cleanName(nom) || equipage.ligne(mission, 48), mission, projet, git: !!d, branche: d?.branche || '', base: d?.head || '', integration: d ? `meydan/${id}/integration` : '', createdAt: Date.now(), pret: null, livre: null }
  // 17/11 (chasse, n°11) : le travail non commité d'Orkun n'entre pas dans l'équipe (les worktrees partent du dernier
  // commit), et une tête détachée rend la livraison impossible : ni le brief ni l'écran ne le disaient, la livraison
  // l'apprenait à la fin, après tout le travail. Mesuré au départ, dit au capitaine (brief) et à Orkun (liste).
  if (d) {
    const sale = await equipage.nonCommites(projet).catch(() => null)
    const depart = { ...(sale?.length && { nonCommites: sale.length, fichiers: sale.slice(0, 6).map((f) => equipage.ligne(f, 120)) }), ...(!d.branche && { detachee: true }) }
    if (Object.keys(depart).length) team.depart = depart
  }
  const wt = d ? path.join(TEAMS_DIR, slug(path.basename(projet)), id, 'capitaine') : projet
  if (d) await equipage.addWorktree(projet, wt, { branche: team.integration, base: d.head, prive: TEAMS_LOG })
  fs.mkdirSync(teamDir(id), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(teamDir(id), 'mission.md'), mission + '\n', { mode: 0o600 })
  teams.push(team)
  try {
    team.chief = (await openMember(team, role, { id: newId(), nom: 'capitaine', chief: true, cwd: wt, branch: team.integration, base: team.base })).id
  } catch (e) {
    teams = teams.filter((t) => t !== team)
    // 17/11 (chasse, n°10) : la branche d'intégration restait dans le dépôt d'Orkun, et les dossiers de l'équipe dans les
    // données, à chaque tentative ratée. Tout ce que ce lancement a créé part (aucun agent n'a tourné) ; la branche,
    // seulement si elle n'a pas bougé depuis sa création.
    if (d) {
      await equipage.dropWorktree(projet, wt, true).catch(() => {}) // worktree créé à l'instant, vide de tout travail
      await equipage.supprimeBrancheNeuve(projet, team.integration, d.head)
      for (const x of [path.dirname(wt), path.dirname(path.dirname(wt))]) await fs.promises.rmdir(x).catch(() => {}) // dossiers vides seulement
    }
    for (const x of [teamDir(id), path.join(TEAMS_LOG, id)]) fs.rmSync(x, { recursive: true, force: true })
    throw e
  }
  save()
  broadcast({ type: 'team', team })
  return team
}

// Le capitaine lance un équipier : rôle, nom court, tâche. Sous git, l'équipier reçoit son worktree : sur sa branche
// s'il écrit, en tête détachée s'il ne fait que lire. Base par défaut : la branche d'intégration de l'équipe.
// Un lancement à la fois par équipe : les contrôles (six équipiers au plus, un seul qui écrit sans git) portent sur un
// état que le lancement précédent a fini d'écrire. Sans cela, plusieurs demandes simultanées passaient toutes.
const lancements = new Map()
function addMember(chief, body) {
  const suite = (lancements.get(chief.team) || Promise.resolve()).catch(() => {}).then(() => lancer(chief, body))
  lancements.set(chief.team, suite)
  return suite
}
async function lancer(chief, body) {
  const team = findTeam(chief.team)
  if (!team || arrets.has(team.id)) throw refus('équipe arrêtée', 409)
  if ((team.lances || 0) >= equipage.MAX_LAUNCHES)
    throw refus(`${equipage.MAX_LAUNCHES} lancements au plus par équipe : rends compte à Orkun (statut needs-decision) au lieu de relancer`, 409)
  const role = equipage.loadRoles(ROLES_DIR)[String(body.role)]
  if (!role || role.nom === 'capitaine') throw refus(`rôle inconnu : ${equipage.ligne(body.role, 40)} (voir « meydan roles »)`)
  const nom = cleanName(typeof body.nom === 'string' ? equipage.ligne(body.nom, 48) : '') // choisi par un agent : sans invisible (n°2), il revient dans chaque réveil
  if (!nom) throw refus('nom manquant')
  const tache = String(body.tache ?? '').replace(/\r/g, '').trim()
  if (!tache) throw refus('tâche vide')
  if (tache.length > equipage.MAX_TASK) throw refus(`tâche trop longue (${equipage.MAX_TASK} caractères au plus)`)
  const crew = membersOf(team.id).filter((c) => !c.chief)
  if (crew.length >= equipage.MAX_CREW) throw refus(`${equipage.MAX_CREW} équipiers au plus par équipe : clos-en un d'abord`, 409)
  // Projet sans git : un équipier peut travailler dans un sous-dossier du projet (`dossier`, par ex. `api` pour une
  // équipe posée sur ~). Deux équipiers qui écrivent ne se gênent que si leurs dossiers se chevauchent : la
  // règle « un seul qui écrit à la fois » vaut PAR DOSSIER. (Orkun, 11/11 : « Mais lance plusieurs agents c'est quoi ton
  // probleme ? » — le refus portait sur toute l'équipe, alors que ses tâches visaient deux projets différents.)
  let cwd = team.projet
  let identDossier = null // Q10 : dev:ino du sous-dossier demandé, lu une seule fois, ici
  if (!team.git && body.dossier !== undefined && body.dossier !== '') {
    const racine = fs.realpathSync(team.projet)
    let d = ''
    try {
      d = fs.realpathSync(path.resolve(racine, String(body.dossier))) // liens suivis : un lien ne fait pas sortir du projet
    } catch {
      throw refus(`dossier introuvable : ${equipage.ligne(body.dossier, 120)}`)
    }
    if (d !== racine && !d.startsWith(racine + path.sep)) throw refus(`dossier hors du projet de l’équipe (${team.projet})`)
    const st = fs.statSync(d, { bigint: true })
    if (!st.isDirectory()) throw refus(`pas un dossier : ${d}`)
    identDossier = `${st.dev}:${st.ino}`
    // Volet quota : un lancement validé par Orkun porte l'identité (dev:ino) du dossier qu'il a lu ; si le dossier a changé
    // pendant que ce lancement attendait son tour dans la file de l'équipe, rien ne part (relecture du 17/11).
    if (body.dossierIdent !== undefined && identDossier !== String(body.dossierIdent)) throw refus('le dossier a changé depuis la validation d’Orkun : rien n’a été lancé', 409)
    cwd = d
  }
  const reel = (p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p // dossier disparu : comparé tel quel
    }
  }
  const chevauche = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
  const occupe = !team.git && role.ecrit && crew.find((c) => c.ecrit && !['done', 'failed'].includes(c.etat?.verbe) && chevauche(reel(c.cwd), reel(cwd)))
  if (occupe) throw refus(`projet sans git, un seul équipier qui écrit à la fois PAR DOSSIER : ${occupe.nom} écrit déjà dans ${occupe.cwd} ; donne à celui-ci un autre sous-dossier (meydan lancer … --dossier <sous-dossier>)`, 409)
  // Sans git, le dossier de travail d'un équipier est sa zone d'écriture (bac à sable `workspace-write` de Codex, outils de
  // fichiers de Claude sous `--restricted`). Posé sur ~, un équipier Codex pouvait écrire partout, jusque dans
  // les données de Meydan, et y poser un « fait validé » lu par toutes les futures consoles du projet (relecture du volet
  // memoire). Orkun le 13/11 : « M4 oui » → jamais ~ entier, jamais un dossier qui contient les données de Meydan.
  // Q10 : l'équipier part dans CE dossier (le sous-dossier demandé, déjà résolu et contrôlé ci-dessus, n'est pas résolu une
  // seconde fois), revérifié dans son propre terminal avant la commande de l'agent (createConsole, terminalDans).
  let attendu = null
  if (!team.git) {
    const zone = identDossier ? cwd : reel(cwd)
    if (zone === reel(HOME) || chevauche(zone, reel(DATA)))
      throw refus(`dossier trop large pour un équipier (${zone}) : il pourrait écrire dans tout ton dossier personnel ou dans les données de Meydan ; donne-lui le sous-dossier de son projet (meydan lancer … --dossier <sous-dossier>)`, 409)
    attendu = { reel: zone, ident: identDossier }
  }
  plafond.verifie() // décision d'Orkun du 17/11, raccourcis-3 : « refuser sous 4 Go de mémoire disponible » : le capitaine le reçoit par sa commande (lib/plafond.mjs)
  const id = newId()
  let branch = '', base = '', baseRef = ''
  if (team.git) {
    baseRef = body.base === undefined || body.base === '' ? team.integration : String(body.base)
    if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(baseRef) || baseRef.startsWith('-')) throw refus('base refusée')
    base = await equipage.tete(team.projet, baseRef).catch(() => '')
    if (!base) throw refus(`base introuvable : ${baseRef}`)
    cwd = path.join(TEAMS_DIR, slug(path.basename(team.projet)), team.id, id)
    branch = role.ecrit ? `meydan/${team.id}/${role.nom}-${id}` : ''
    await equipage.addWorktree(team.projet, cwd, { branche: branch, base, prive: TEAMS_LOG })
  }
  try {
    const c = await openMember(team, role, { id, nom, cwd, branch, base, baseRef, tache, attendu })
    team.lances = (team.lances || 0) + 1
    save()
    return c
  } catch (e) {
    // Comme pour createTeam (17/11, chasse n°10) : worktree, branche restée à sa base, dossiers de l'équipier.
    if (team.git) {
      await equipage.dropWorktree(team.projet, cwd, true).catch(() => {}) // créé à l'instant, vide de tout travail
      if (branch) await equipage.supprimeBrancheNeuve(team.projet, branch, base)
    }
    for (const x of [path.join(TEAMS_DATA, team.id, id), path.join(TEAMS_LOG, team.id, id)]) fs.rmSync(x, { recursive: true, force: true })
    throw e
  }
}
function memberOf(chief, id) {
  const m = find(String(id ?? ''))
  if (!m || m.team !== chief.team || m.chief) throw refus('équipier inconnu dans ton équipe', 404)
  return m
}

// Statuts du capitaine qui appellent Orkun (déclare, plus bas) et le titre de leur notification.
const APPELS = new Map([['needs-decision', 'décision à prendre'], ['blocked', 'capitaine bloqué'], ['failed', 'échec du capitaine']])
// Statut déclaré par un membre. Un « done » se prouve : pour qui écrit, Meydan commite sur sa branche ce qui reste dans
// son dossier de travail (un agent en bac à sable ne peut pas le faire lui-même), puis exige un dossier propre et au
// moins un commit ; pour qui lit, un rapport. Le statut décisif d'un équipier réveille le capitaine ; celui du
// capitaine met l'équipe « prête ».
async function declare(c, verbe, texte) {
  if (!equipage.VERBS.has(verbe)) throw refus(`verbe inconnu : ${equipage.ligne(verbe, 30)} (${[...equipage.VERBS].join(', ')})`)
  texte = equipage.ligne(texte, 600)
  const team = findTeam(c.team)
  let head = ''
  if (verbe === 'done') {
    if (team.git) {
      if (c.branch && !c.chief && !(await equipage.propre(c.cwd)))
        await equipage.commiter(c.cwd, c.branch, team.projet, `${texte || `travail de ${c.nom}`}\n\nÉquipier Meydan : ${who(c)}`)
      // Propre : pour qui a une branche (capitaine, équipier qui écrit). Un lecteur travaille dans une copie jetable en tête
      // détachée (son brief : « rien de ce que tu y écris ne sera gardé ») : ses sorties d'essai, un `npm ci`, ses journaux
      // y restent sans gêner ; seul son rapport compte (17/11, chasse n°12 : il devait effacer ses traces pour finir).
      if (c.branch && !(await equipage.propre(c.cwd))) throw refus('« done » refusé : ton dossier de travail n’est pas propre (git status). Commite ton travail, retire ce qui traîne.', 409)
      head = await equipage.tete(c.cwd)
      if (c.branch && !c.chief && (await equipage.avance(c.cwd, c.base)) < 1) throw refus('« done » refusé : aucun changement sur ta branche depuis ton départ.', 409)
    }
    if (!c.chief && !c.ecrit && !nonEmpty(path.join(memberDir(c), 'rapport.md'))) throw refus(`« done » refusé : pas de rapport dans ${path.join(memberDir(c), 'rapport.md')}`, 409)
  }
  c.etat = { verbe, texte, at: Date.now(), ...(head ? { head } : {}) }
  c.tour = verbe
  // Un agent qui déclare un statut tourne : s'il était encore noté « question au démarrage » (aucun hook reçu), on corrige.
  if (c.status === 'starting' || (c.status === 'needs' && c.note === 'Question au démarrage')) setStatus(c, 'working')
  fs.appendFileSync(path.join(serverDir(c), 'statut'), `${verbe} [at=${Math.floor(Date.now() / 1000)}]: ${texte}\n`, { mode: 0o600 })
  // Ce que le travail change : montré à Orkun avant la livraison (capitaine : du projet à la tête prête), signalé au
  // capitaine avant de rassembler (équipier : depuis son départ). Un échec de ce calcul n'empêche pas de déclarer.
  let contenu = null
  if (verbe === 'done' && team.git && head) {
    const de = c.chief ? await equipage.tete(team.projet).catch(() => '') : c.branch ? c.base : ''
    if (de) contenu = await equipage.contenu(team.projet, de, head).catch(() => null)
  }
  if (c.chief) {
    team.pret = verbe === 'done' ? { at: Date.now(), texte, head, ...(contenu ? { contenu } : {}) } : null
    // 17/11 (chasse, n°5) : la question du capitaine à Orkun (son brief : « transmets-la-lui (`statut needs-decision`) »),
    // son blocage ou son échec ne prévenaient personne : sa console passait seulement FINI à la fin de son tour. L'équipe
    // « t'appelle » (`team.appel`, à côté de `pret` qui, lui, porte la livraison) : notification du téléphone et compte
    // dans « T'ATTEND » jusqu'à ce qu'Orkun réponde au capitaine (orkunRepond) ou que le capitaine déclare autre chose.
    // Le verdict d'une vérification (n°4) reste tant qu'Orkun ne l'a pas lu, sauf si le capitaine redéclare « done » (une
    // nouvelle vérification part) : un « working » du capitaine ne l'éteint pas (relecture du volet).
    const verdict = team.appel?.de === 'verification' && verbe !== 'done' ? team.appel : null
    team.appel = APPELS.has(verbe) ? { at: Date.now(), de: 'capitaine', verbe, texte } : verdict
    broadcast({ type: 'team', team })
    if (team.pret) alerte({ title: `Équipe prête : ${team.nom}`, body: texte || 'Le capitaine a déclaré le travail prêt.', tag: team.id, ouvre: c.id })
    else if (team.appel) alerte({ title: `${team.nom} : ${APPELS.get(verbe)}`, body: texte || 'Le capitaine t’attend.', tag: team.id, ouvre: c.id })
  } else if (equipage.WAKES.has(verbe)) {
    const suite = verbe !== 'done' ? '' : c.branch ? ` · branche ${c.branch}` : c.ecrit ? '' : ` · rapport ${path.join(memberDir(c), 'rapport.md')}`
    const regard = contenu?.sensibles.length ? ` · à regarder avant de rassembler : ${contenu.sensibles.join(', ')}` : ''
    // Le texte de l'équipier est cité : c'est son compte rendu, pas une consigne de Meydan.
    wake(team.id, `${who(c)} : ${verbe} — il écrit : « ${texte || 'sans détail'} »${suite}${regard}`)
  }
  save()
  broadcast({ type: 'console', console: c })
}

// Orkun répond au capitaine d'une équipe « prête » (Entrée dans son terminal, ou message de la barre d'envoi) : il l'a
// vue, l'équipe ne compte plus dans « T'ATTEND » (11/11 : « je réponds a la question de la console ou le relance sur
// autre chose et le 1 t'attend reste toujours »). Le compte rendu reste affiché, et « Livrer » pour une équipe git ; un
// nouveau « done » du capitaine la rallume. Les messages d'équipe (`wake`) passent par tmux, jamais par ici.
// Vaut aussi pour l'appel de l'équipe (question, blocage ou échec du capitaine, verdict d'une vérification à lire).
function orkunRepond(c) {
  vuParOrkun(c) // lui écrire, c'est l'avoir vue
  const team = c.chief && findTeam(c.team)
  const a = [team?.pret, team?.appel].filter((x) => x && !x.vu)
  if (!a.length) return
  for (const x of a) x.vu = Date.now()
  save()
  broadcast({ type: 'team', team })
}
// Une console FINIE (son agent est passé du travail au repos) que Orkun regarde ou à qui il écrit : elle passe au repos.
function vuParOrkun(c) {
  if (!c.fini) return
  delete c.fini
  save()
  broadcast({ type: 'console', console: c })
}

// Ferme un membre. `strict` (demande du capitaine) : refus si un équipier qui écrit laisse un travail non commité.
// Jamais de suppression forcée d'un worktree d'écriture ni d'une branche non rassemblée : le travail reste dans git.
async function closeMember(c, strict = true) {
  const team = findTeam(c.team)
  const wt = team?.git && c.cwd !== team.projet && fs.existsSync(c.cwd) ? c.cwd : ''
  if (wt && c.branch && strict && !(await equipage.propre(wt))) throw refus('son dossier de travail porte un travail non commité : fais-le commiter, ou demande à Orkun de fermer cet équipier', 409)
  c.fermeture = true
  await tmux('kill-session', '-t', c.id).catch(() => {}) // déjà morte : rien à tuer
  navs.ferme(c.id) // son navigateur part avec elle (volet copies)
  let garde = ''
  if (wt) await equipage.dropWorktree(team.projet, wt, !c.branch).catch(() => (garde = wt)) // sans branche = copie jetable d'un lecteur
  let branche = ''
  if (c.branch && !c.chief && !garde) {
    // `git branch -d` ne supprime qu'une branche déjà contenue dans la tête du dossier où il tourne : ici l'intégration.
    const chief = chiefOf(team.id)
    branche = await equipage.git(chief && fs.existsSync(chief.cwd) ? chief.cwd : team.projet, 'branch', '-d', c.branch).then(() => 'supprimée (déjà rassemblée)', () => 'gardée (pas rassemblée)')
  }
  await envois.forget(DATA, c.id)
  // `garde` : son dossier de travail laissé sur le disque (travail non commité) ; l'arrêt de l'équipe le redit (17/11, n°9).
  if (team) (team.membresClos ||= []).push({ id: c.id, name: c.name, kind: c.kind, agent: c.agent, cwd: c.cwd, team: c.team, etat: c.etat, ferme: true, ...(garde && { garde }) })
  consoles = consoles.filter((x) => x.id !== c.id)
  lacheFil(c.id)
  save()
  beat()
  broadcast({ type: 'removed', id: c.id })
  return { garde, branche }
}

// Arrêt de l'équipe par Orkun : équipiers puis capitaine. Les dossiers au travail non commité restent sur le disque
// (rendus dans `gardes`) ; la branche d'intégration n'est supprimée que si elle est déjà dans le projet.
// 17/11 (chasse, n°3) : un lancement en cours (`meydan lancer` du capitaine) pendant « Arrêter » créait sa console APRÈS
// la fermeture des membres : console orpheline vivante, avec son worktree, rattachée à une équipe disparue. L'équipe est
// d'abord marquée « en arrêt » (un lancement suivant est refusé), l'arrêt attend la file des lancements, puis ferme tout
// ce qui est là. Marque en mémoire seulement : un redémarrage pendant l'arrêt ne laisse pas l'équipe bloquée. Un second
// « Arrêter » pendant l'arrêt (deux clics) attend le même arrêt au lieu d'en lancer un autre.
const arrets = new Map() // équipe → promesse de son arrêt
function stopTeam(team) {
  if (!arrets.has(team.id)) arrets.set(team.id, arreteEquipe(team).finally(() => arrets.delete(team.id)))
  return arrets.get(team.id)
}
async function arreteEquipe(team) {
  await (lancements.get(team.id) || Promise.resolve()).catch(() => {}) // le lancement en cours finit, sa console sera fermée avec les autres
  if (team.verification?.etat === 'active') finVerification(team, 'refusee', 'Équipe arrêtée par Orkun : la vérification est terminée sans validation.')
  const gardes = []
  for (const c of membersOf(team.id).sort((a, b) => Number(!!a.chief) - Number(!!b.chief))) {
    // Capitaine promu (une console d'Orkun devenue capitaine sur son ordre) : il perd son rôle, sa console reste ouverte.
    if (c.chief && team.promu) {
      for (const k of ['team', 'chief', 'role', 'nom', 'ecrit', 'branch', 'base', 'etat', 'tour']) delete c[k] // modèle et effort : les siens, gardés
      broadcast({ type: 'console', console: c })
      continue
    }
    const r = await closeMember(c, false)
    if (r.garde) gardes.push(r.garde)
  }
  // 17/11 (chasse, n°9) : un équipier fermé plus tôt (×, ordre « ferme ») avec un travail non commité gardait son
  // worktree, et l'arrêt répondait `gardes: []` : ce travail n'était signalé nulle part. Les dossiers encore sur le disque.
  for (const m of team.membresClos || []) if (m.garde && !gardes.includes(m.garde) && fs.existsSync(m.garde)) gardes.push(m.garde)
  if (team.git) await equipage.git(team.projet, 'branch', '-d', team.integration).catch(() => {})
  // Dossiers des worktrees de l'équipe : enlevés s'ils sont vides (rmdir refuse tout dossier qui porte encore un travail).
  const racine = path.join(TEAMS_DIR, slug(path.basename(team.projet)))
  for (const d of [path.join(racine, team.id), racine]) await fs.promises.rmdir(d).catch(() => {})
  lancements.delete(team.id)
  teams = teams.filter((t) => t.id !== team.id)
  save()
  broadcast({ type: 'team-removed', id: team.id })
  return { gardes }
}

// Livraison, sur le go d'Orkun seulement : le projet avance jusqu'à la tête que le capitaine a déclarée prête.
async function deliver(team) {
  if (!team.git) throw refus('projet sans git : rien à livrer', 409)
  if (!team.branche) throw Object.assign(refus('le projet était en tête détachée au départ de l’équipe : livraison impossible', 409), { cote: 'projet' })
  if (!team.pret) throw refus('le capitaine n’a pas déclaré le travail prêt', 409)
  if ((await equipage.tete(team.projet, `refs/heads/${team.integration}`)) !== team.pret.head)
    throw refus('la branche d’intégration a bougé depuis le « prêt » du capitaine : il doit le redéclarer', 409)
  const r = await equipage.livrer(team.projet, team.branche, team.pret.head)
  team.livre = { at: Date.now(), ...r }
  team.pret = null
  save()
  broadcast({ type: 'team', team })
  return team
}

function teamView(me) {
  const t = findTeam(me.team)
  return {
    equipe: { id: t.id, nom: t.nom, projet: t.projet, git: t.git, branche: t.branche, integration: t.integration, pret: t.pret, livre: t.livre },
    membres: (me.chief ? membersOf(t.id) : [me]).map((c) => ({ id: c.id, role: c.role, nom: c.nom, chief: !!c.chief, statut: c.status, etat: c.etat || null, branche: c.branch || '', dossier: c.cwd, attente: c.attente?.length || 0 })),
  }
}

// Vérificateur opt-in : verrou avant lancement, état et compteurs persistants.
const verificationsEnCours = new Set()
function preuvesEquipe(team) {
  return [...membersOf(team.id), ...(team.membresClos || [])].map((c) => {
    const journal = c.kind === 'claude' ? fil.journalClaude(CLAUDE_PROJECTS, c.agent) : c.kind === 'codex' ? fil.journalCodex(CODEX_SESSIONS, c.agent) : null
    const lu = journal ? fil.lireFil(c.kind, journal) : []
    return { id: c.id, nom: c.name, dossier: c.cwd, statut: c.ferme ? 'closed' : c.status, affirmation: c.etat, rapport: path.join(memberDir(c), 'rapport.md'), derniereReponse: relais.derniereReponse(lu).slice(-16000) }
  })
}
async function verifieFin(team) {
  if (!verificationsEnCours.has(team.id) && team.verification?.etat === 'active') {
    const v = team.verification, c = find(v.console)
    const ids = membersOf(team.id).map((m) => m.id)
    if (!c || ['closed', 'shell', 'error'].includes(c.status) || ids.length !== v.membres.length || ids.some((id) => !v.membres.includes(id))) {
      finVerification(team, 'refusee', 'Vérificateur interrompu ou composition de l’équipe modifiée. Les preuves doivent être relues par Orkun.')
      return
    }
  }
  if (verificationsEnCours.has(team.id) || !verification.doitVerifier(team, membersOf(team.id))) return
  verificationsEnCours.add(team.id)
  const id = newId()
  team.verification = verification.nouvelleVerification(membersOf(team.id), id)
  save() // une interruption ne doit pas lancer deux vérificateurs pour la même fin
  try {
    const dir = path.join(DATA, 'verifications', id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'brief.md'), verification.briefVerification(team, preuvesEquipe(team), CLI), { mode: 0o600 })
    await createConsole({ kind: 'codex', cwd: chiefOf(team.id)?.cwd || team.projet, name: `Vérification · ${team.nom}`, plus: { id, verificationTeam: team.id } })
  } catch {
    Object.assign(team.verification, { etat: 'refusee', verdict: 'Le vérificateur n’a pas pu démarrer. Relis les preuves de l’équipe avant toute livraison.', fin: Date.now() })
  } finally {
    verificationsEnCours.delete(team.id)
    save(); broadcast({ type: 'team', team })
  }
}
// Le verdict se lit dans la console du vérificateur (« T'ATTEND »). 17/11 (chasse, n°4) : console fermée par Orkun (×,
// ou retirée), le verdict passait sur la console du CAPITAINE, mise « needs » sans aucune question : « T'ATTEND » à
// tort, sa barre d'envoi refusée (« l'agent attend une réponse dans le terminal »), et ses réveils gardés en file tant
// qu'aucun hook ne le reposait. Le verdict reste à l'équipe (`team.verification`, affiché avec elle) et l'équipe appelle
// Orkun (`team.appel`, comme une question du capitaine) ; la console du capitaine n'est pas touchée. Rien pendant un
// arrêt de l'équipe (c'est Orkun qui l'arrête).
function finVerification(team, verdict, texte) {
  verification.conclureVerification(team.verification, membersOf(team.id), verdict, texte)
  const c = find(team.verification.console)
  if (c && c.status !== 'closed') { c.attente = []; c.verificationVerdict = { etat: verdict, verdict: texte }; setStatus(c, 'needs', texte) }
  else if (!arrets.has(team.id)) {
    team.appel = { at: Date.now(), de: 'verification', verbe: verdict, texte }
    const chef = chiefOf(team.id)
    alerte({ title: `Vérification : ${team.nom}`, body: texte, tag: team.id, ...(chef && { ouvre: chef.id }) })
  }
  save(); broadcast({ type: 'team', team })
}
async function verifierApi(req, res, url, c) {
  const team = findTeam(c.verificationTeam)
  const v = team?.verification
  if (!v || v.console !== c.id) throw refus('vérification inconnue', 403)
  if (req.method === 'GET' && url.pathname === '/agent/verification') return send(res, 200, { mission: team.mission, verification: v, membres: preuvesEquipe(team) })
  if (req.method !== 'POST' || url.pathname !== '/agent/verification' || v.etat !== 'active') throw refus('action hors mandat ou vérification terminée', 403)
  const b = await readJson(req)
  if (b.action === 'conclure') finVerification(team, b.verdict, b.texte)
  else if (b.action === 'relancer') {
    const m = membersOf(team.id).find((x) => x.id === b.id && v.membres.includes(x.id))
    if (!m) throw refus('membre hors de cette équipe', 403)
    if (v.attend[m.id]) throw refus('attends le retour du membre avant un autre relais', 409)
    if ((v.relances[m.id] || 0) >= 2) {
      finVerification(team, 'refusee', `Deux relances épuisées pour ${m.name}. Dernier défaut signalé : ${equipage.ligne(b.texte, 1500)}`)
      throw refus('deux relances épuisées : verdict transmis à Orkun', 409)
    }
    // Le texte du vérificateur part dans la console d'un équipier : sans invisible (n°2, relecture du volet).
    const message = verification.relancerMembre(v, m, typeof b.texte === 'string' ? equipage.ligne(b.texte, 2000) : b.texte)
    m.etat = { verbe: 'working', texte: 'Correction demandée par le vérificateur', at: Date.now() }
    team.pret = null
    enqueue(m, message)
    broadcast({ type: 'console', console: m })
    broadcast({ type: 'team', team })
  } else throw refus('action inconnue')
  save()
  return send(res, 200, { verification: v })
}

// Routes /agent/ : `me` est la console qui appelle, prouvée par son jeton. Un équipier ne peut que déclarer son statut
// et lire son état ; le reste est réservé au capitaine, et ne porte que sur les équipiers de son équipe.
async function agentApi(req, res, url, me) {
  const action = url.pathname.split('/')[2]
  const m = req.method
  const chef = () => {
    if (!me.chief) throw refus('réservé au capitaine', 403)
  }
  if (action === 'etat' && m === 'GET') return send(res, 200, teamView(me))
  if (action === 'roles' && m === 'GET') {
    chef()
    return send(res, 200, { roles: Object.values(equipage.loadRoles(ROLES_DIR)).filter((r) => r.nom !== 'capitaine').map(({ texte, ...r }) => r) })
  }
  if (action === 'voir' && m === 'GET') {
    chef()
    const x = memberOf(me, url.searchParams.get('id'))
    const out = await tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', x.id).catch(() => '')
    return send(res, 200, { ecran: out.replace(/[ \t]+$/gm, '').split('\n').filter(Boolean).slice(-60).join('\n') || '(console fermée ou vide)' })
  }
  if (m !== 'POST') return send(res, 404, { error: 'route inconnue' })
  const body = await readJson(req)
  if (action === 'statut') {
    await declare(me, String(body.verbe ?? ''), body.texte)
    return send(res, 200, { ok: true })
  }
  chef()
  if (action === 'lancer') {
    if (budget.aValider(me.team)) return send(res, 202, budget.demandeLancement(me, body)) // volet quota : Orkun valide d'abord
    const c = await addMember(me, body)
    return send(res, 201, { id: c.id, nom: c.name, dossier: c.cwd, branche: c.branch })
  }
  if (action === 'dire') {
    const x = memberOf(me, body.id)
    if (x.status === 'closed' || x.status === 'shell') throw refus('cet équipier ne tourne plus : clos-le, ou relance sa tâche', 409)
    const texte = equipage.ligne(body.texte)
    if (!texte) throw refus('message vide')
    enqueue(x, `[Meydan] Message du capitaine : ${texte}`)
    return send(res, 200, { ok: true })
  }
  if (action === 'clore') return send(res, 200, await closeMember(memberOf(me, body.id)))
  return send(res, 404, { error: 'route inconnue' })
}

// Corps d'un hook → une ligne lisible. Un corps trop gros (fichier entier dans un Write) est lu jusqu'au bout mais ignoré.
function readText(req, max = 1 << 20) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size <= max) chunks.push(c)
    })
    req.on('end', () => resolve(size <= max ? Buffer.concat(chunks).toString('utf8') : ''))
    req.on('error', () => resolve(''))
  })
}
// Identifiant de la conversation de l'agent, lu dans le corps d'un hook (Claude Code et Codex le donnent sous le même nom).
export function hookSession(raw) {
  try {
    const id = JSON.parse(raw)?.session_id
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(id) ? id : ''
  } catch {
    return ''
  }
}
// La raison d'un hook de début ou de fin de session : `source` de SessionStart (startup, resume, clear, compact, fork),
// `reason` de SessionEnd (clear, resume, logout, prompt_input_exit, other) ; '' pour tout autre corps.
export function hookRaison(raw) {
  try {
    const j = JSON.parse(raw)
    const v = j?.hook_event_name === 'SessionStart' ? j.source : j?.hook_event_name === 'SessionEnd' ? j.reason : ''
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}
export function hookNote(raw) {
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return ''
  }
  const t = (j && j.tool_input) || {}
  const what = [t.command, t.file_path, t.url, t.questions?.[0]?.question, t.description, t.pattern].find((v) => typeof v === 'string' && v)
  const asked = t.questions?.[0]?.question // une question posée se lit seule, sans le nom de l'outil
  const line = typeof asked === 'string' && asked ? asked : j?.tool_name ? `${j.tool_name}${what ? ` · ${what}` : ''}` : [j?.message, j?.error].find((v) => typeof v === 'string') || ''
  return String(line).replace(/\s+/g, ' ').trim().slice(0, 160)
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2))
function same(a, b) {
  if (typeof a !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
// Deux portes, jamais mélangées : le nom public (nginx) exige la session publique ; la boucle locale, le cookie du lien à clé.
const isPublic = (req) => !!PUBLIC_HOST && req.headers.host === PUBLIC_HOST
const authed = (req) => (isPublic(req) ? publicSession(cookies(req)[PCOOKIE]) : same(cookies(req)[COOKIE], SESSION))
// Anti-rebinding DNS : l'hôte demandé doit être une adresse de boucle locale, quel que soit le port (tunnel ssh -L).
const hostOk = (req) => isPublic(req) || /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(req.headers.host || '')
// Sous le nom public, l'origine est exigée et doit être le site lui-même (https).
const originOk = (req) => (isPublic(req) ? req.headers.origin === `https://${PUBLIC_HOST}` : !req.headers.origin || req.headers.origin === `http://${req.headers.host}`)

function send(res, code, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body)
  const data = isJson ? JSON.stringify(body) : body
  // Réponse rendue alors que le corps de la demande arrive encore (envoi refusé tôt : sans session, trop gros, agent
  // qui attend un choix). Fermer tout de suite couperait l'écriture en cours de nginx, qui rend alors 502 à la place
  // de notre réponse (« Broken pipe while sending request to upstream » : 78 fois sur 80 mesurées le 10/11). Dans ce
  // cas la réponse part entière avec sa longueur, le reste du corps s'écoule sans être gardé, et on ne ferme qu'à sa
  // fin, quand le proxy raccroche, ou après 5 s.
  const req = res.req
  const enVol = Boolean(req) && !req.complete && !req.destroyed && (Number(req.headers['content-length']) > 0 || 'transfer-encoding' in req.headers)
  res.writeHead(code, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...(enVol ? { 'content-length': Buffer.byteLength(data) } : {}),
    ...headers,
  })
  if (!enVol) return res.end(data)
  res.flushHeaders()
  if (data.length) res.write(data)
  req.resume()
  const fin = () => {
    clearTimeout(delai)
    if (!res.writableEnded) res.end()
  }
  const delai = setTimeout(fin, 5000)
  req.once('end', fin)
  req.once('close', fin)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 65536) {
        reject(new Error('corps trop gros'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('JSON invalide'))
      }
    })
    req.on('error', reject)
  })
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' }

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = path.resolve(DIST, rel)
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return send(res, 404, 'introuvable')
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'introuvable')
    send(res, 200, buf, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': rel.startsWith('assets/') ? 'private, max-age=31536000, immutable' : 'no-store',
      'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*${PUBLIC_HOST ? ` wss://${PUBLIC_HOST}` : ''}; img-src 'self' data: blob: https://*.sndcdn.com; font-src 'self'; frame-src 'self' https://w.soundcloud.com; frame-ancestors 'none'`, // SoundCloud (11/11) : son lecteur officiel en cadre et les pochettes, rien d'autre ; aucun script d'ailleurs. 'self' : l'aperçu web d'une carte (/relais/, isolé par sa propre CSP « sandbox »)
    })
  })
}

const num = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined)

// Statuts où l'agent attend une réponse dans un menu (permission, question, confiance du dossier au démarrage) : la touche
// Entrée y validerait le choix par défaut, souvent « oui ». Aucun message de la barre d'envoi n'y est envoyé.
const AWAITS = new Set(['needs', 'starting'])

// Les traces d'un texte dans une console, sur tout son historique : son début, sa fin (sans les blancs), les marques de
// collage replié. Comparées avant et après un collage (pasteMessage, ci-dessous, qui dit pourquoi ces trois-là), puis au
// repos suivant pour un message collé sans Entrée (acheve).
const sansBlancs = (s) => s.replace(/\s+/g, '')
async function tracesDe(id, text) {
  const debut = text.trim().split('\n')[0].slice(0, 12)
  const fin = sansBlancs(text).slice(-16)
  const ecran = await tmux('capture-pane', '-p', '-J', '-S', '-', '-t', id).catch(() => '')
  return [debut ? ecran.split(debut).length - 1 : 0, fin ? sansBlancs(ecran).split(fin).length - 1 : 0, (ecran.match(/\[Pasted (text|content)/gi) || []).length]
}

// Le champ d'une console où Orkun a écrit sans valider (17/11, chasse n°15, lib/champ.mjs) : console → { at, alerte }.
// Posé par ses touches dans le terminal de Meydan (pas pendant une question ou un démarrage : y taper « 1 » choisit, rien
// n'entre dans le champ) ; levé par Entrée, Ctrl+C, un envoi de sa barre (le champ part avec), ou un champ VISIBLEMENT
// vide à l'écran (il a tout effacé). Tant qu'il est posé, les messages de Meydan (file d'une équipe, ordres, boucles)
// attendent : jamais perdus, jamais collés par-dessus. Au bout de 2 min d'attente, le téléphone le dit, une fois.
// Une frappe venue d'ailleurs que de Meydan (un `tmux attach` à la main) n'est pas vue : limite écrite au volet.
// (`saisies` est déclarée avec setStatus, qui l'oublie quand la console se ferme.)
const SAISIE_DIT = 2 * 60000
const dernieres = new Map() // console → dernier caractère reçu de son terminal (« \ » puis Entrée : retour à la ligne)
function noteFrappe(c, s) {
  const f = champ.frappe(s, dernieres.get(c.id) || '')
  if (s) dernieres.set(c.id, s.at(-1))
  if (f === 'vide') {
    if (saisies.delete(c.id)) retard.delete(c.id) // sa garde levée : ses messages repartent au repos suivant, sans le délai d'un refus
  } else if (f === 'tape' && !AWAITS.has(c.status) && c.kind !== 'shell') saisies.set(c.id, { at: Date.now(), alerte: false })
}
async function gardeSaisie(id) {
  const s = saisies.get(id)
  if (!s) return
  if (champ.champVide(await tmux('capture-pane', '-p', '-J', '-t', id).catch(() => ''))) return void saisies.delete(id)
  const c = find(id)
  if (c && !s.alerte && Date.now() - s.at > SAISIE_DIT) {
    s.alerte = true
    alerte({ title: `${c.name} : message en attente`, body: 'Un texte que tu n’as pas envoyé est dans son champ : Meydan lui remettra ses messages quand tu l’auras envoyé ou effacé (Entrée, Ctrl+C).', tag: `saisie-${id}`, ouvre: id })
  }
  throw Object.assign(new Error('Orkun écrit dans cette console : message gardé jusqu’à ce que son texte soit envoyé ou effacé'), { code: 409 })
}

// Dépose un texte dans la console comme un collage (encadré si le programme le demande : les retours à la ligne ne
// valident rien), puis appuie sur Entrée. Prouvé le 10/11 dans Claude Code, Codex et bash.
// Une erreur levée APRÈS le collage porte `colle` ({ avant, depuis, vu }) : le texte est dans la console, l'appelant ne
// doit jamais le recoller (13/11, voir flush).
async function pasteMessage(id, text, { vuAvantEntree = false } = {}) {
  if (vuAvantEntree) await gardeSaisie(id) // un message de Meydan ne part jamais par-dessus un texte d'Orkun (lève avant le collage)
  const dir = envois.dirOf(DATA, id)
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const tag = crypto.randomBytes(6).toString('hex')
  const file = path.join(dir, `.message-${tag}`)
  const buffer = `meydan-${id}-${tag}` // propre à ce message : deux envois simultanés ne se mélangent pas
  await fs.promises.writeFile(file, text, { mode: 0o600 })
  // Console en mode copie (molette de la souris) : on en sort, sinon le collage et Entrée iraient à ce mode.
  await tmux('send-keys', '-t', id, '-X', 'cancel').catch(() => {})
  // Entrée ne part que si le collage SE VOIT dans la console. Tour réel du 10/11 : un réveil collé n'est pas arrivé dans
  // le champ d'un agent, et Entrée y a validé ce qui s'y trouvait (« /auto-mode-setup », une boîte de réglages). On
  // compte donc, avant et après, le début du message à l'écran, sa fin, ou la marque d'un collage replié par l'agent.
  // Compté sur tout l'historique de la console, pas sur l'écran visible : un message long (une boucle qui joint un
  // extrait) fait monter son propre début, et les messages d'avant, au-dessus de l'écran — le compte visible ne montait
  // pas, Entrée ne partait jamais et le message était recollé toutes les 15 s (vu le 11/11 dans les essais).
  // La fin aussi (13/11) : le champ de Claude Code ne montre que ses dernières lignes, curseur au bout (au plus
  // ⌊(hauteur − 12) / 2⌋ : 5 dans une console de 22 lignes, mesuré sur la 2.1.323) ; le début d'un message plus haut n'y
  // est jamais dessiné, pas même dans l'historique. 11/11 : trois consignes de 470 caractères jamais validées, recollées
  // toutes les ~20 s, parties en 5 exemplaires à l'Entrée donnée à la main (test/correctif-consigne/). Fin comptée sans
  // les blancs, des deux côtés : le champ coupe le texte à sa largeur et indente la suite. Le début reste compté tel
  // quel : dans un terminal simple, c'est la fin de l'écho qui peut manquer (faux agent `cat` du smoke, 13/11 : la fin
  // de l'écho d'une boucle remplacée à l'écran par la sortie du programme).
  const compte = () => tracesDe(id, text)
  const avant = await compte()
  const depuis = Date.now() // avant le collage : ce que la conversation de l'agent reçoit ensuite porte une heure plus tardive
  try {
    await tmux('load-buffer', '-b', buffer, file)
    await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', id)
  } finally {
    await fs.promises.rm(file, { force: true })
  }
  // Seulement pour les messages que Meydan envoie de lui-même (réveils d'équipe, personne devant l'écran). La barre
  // d'envoi d'Orkun garde l'ancien geste : il voit sa console, et un collage dans une invite masquée (mot de passe,
  // jeton) ne s'affiche jamais.
  let vu = !vuAvantEntree
  if (vu) await sleep(100)
  for (let i = 0; i < 30 && !vu; i++) {
    await sleep(100) // le programme lit le collage avant la touche Entrée
    const apres = await compte()
    vu = apres.some((n, k) => n > avant[k])
  }
  const pasEnvoye = (message) => Object.assign(new Error(message), { code: 409, colle: { avant, depuis, vu } })
  if (!vu) throw pasEnvoye('message collé mais pas envoyé : il n’apparaît pas dans le champ de la console (une boîte de dialogue y est peut-être ouverte)')
  await sleep(150)
  // Une question de l'agent a pu surgir entre-temps : Entrée y validerait le choix par défaut. On ne l'envoie pas.
  if (AWAITS.has(find(id)?.status)) throw pasEnvoye('message collé mais pas envoyé : l’agent vient de poser une question')
  // Orkun s'est mis à écrire pendant le collage (relecture du volet, n°15) : Entrée enverrait son texte avec. Le message
  // reste dans le champ, hors de la file (suspens) ; son Entrée à lui l'enverra, ou acheve quand il aura fini.
  if (vuAvantEntree && saisies.has(id)) throw pasEnvoye('message collé mais pas envoyé : Orkun écrit dans cette console')
  await tmux('send-keys', '-t', id, 'Enter').catch((e) => {
    throw pasEnvoye(e.message)
  })
}

// Ce qu'une console fait à l'instant, pour sa tuile de la vue d'ensemble. Un agent : son dernier message ou son dernier
// outil (lus dans son journal), son indicateur s'il travaille, le titre de sa question s'il attend. Un shell : les
// dernières lignes de son écran.
async function apercuDe(c) {
  if (c.status === 'closed') return null
  const agent = c.kind === 'claude' || c.kind === 'codex'
  const occupe = c.status === 'working' || c.status === 'running'
  const voir = !agent || occupe || c.status === 'needs' || c.status === 'starting'
  const ecran = voir ? await tmux('capture-pane', '-p', '-J', ...(agent && occupe ? ['-S', '-300'] : []), '-t', c.id).catch(() => '') : ''
  if (!agent) {
    const lignes = ecran.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-3).map((l) => l.slice(0, 96))
    return { lignes }
  }
  const journal = journalDe(c)
  const lu = journal ? fil.lireFil(c.kind, journal) : []
  const d = lu.at(-1)
  const outil = d?.r === 'outils' ? d.outils.at(-1) : null
  const dernier = !d ? null : outil ? { r: 'outils', t: `${outil.nom}${outil.quoi ? ` ${outil.quoi}` : ''}`.slice(0, 120) } : { r: d.r, t: equipage.ligne(d.t, 280) }
  const direct = occupe ? fil.direct(c.kind, ecran, lu) : null
  const q = !occupe && voir ? question.lireQuestion(ecran) : null
  // La question de confiance du dossier n'a pas de titre lisible à l'écran : dite en clair, comme dans la discussion.
  const confiance = q && /Accessing workspace/i.test(q.contexte) && q.options.some((o) => /trust this folder/i.test(o.texte))
  return { dernier, direct: direct ? { verbe: direct.verbe, duree: direct.duree } : null, question: confiance ? 'Faire confiance à ce dossier ?' : q ? q.titre : '' }
}

// ── Plateau étendu (volet du 11/11) : notes, aperçus web, panneau Git, en cartes sur le plateau (lib/cartes.mjs) ──
// Le relais de l'aperçu web authentifie par un jeton dérivé de la clé de la porte de la demande. Sous le nom public : la
// clé publique de Meydan (remplacée à chaque déconnexion) ET le secret commun des identifiants (changé à leur rotation) ;
// identifiants absents (accès public fermé) = aucune clé, aucun jeton ne vaut. En local : la clé d'accès.
const relaisWeb = ouvreRelais({
  cle: (req) => {
    if (!isPublic(req)) return ACCESS_KEY
    const c = credentials()
    return c ? `${c.sessionSecret}.${PUBLIC_KEY}` : ''
  },
  finSession: (req) => (isPublic(req) ? publicExp(cookies(req)[PCOOKIE]) : Infinity),
  trouve: (id) => cartes.trouve(id),
  proprePort: PORT,
  send, // réponses du relais (sait répondre pendant qu'un corps arrive encore)
})
// `copiesDir` et `consoles` : la liste des copies d'un dépôt et la console liée à chacune (volet copies).
const cartes = ouvreCartes({ DATA, HOME, safeDir, fichierPermis, broadcast, send, readJson, relais: relaisWeb, git: ouvreGit({ send, readJson, copiesDir: COPIES_DIR, consoles: () => consoles }) })
// Volet copies (13/11) : copies de travail d'une console (lib/copies.mjs) et navigateur de l'agent (lib/navigateur.mjs).
// Le navigateur garde l'ancienne règle de ports (décision d'Orkun du 17/11, copies-7 : « Garder la liste blanche par navigateur ») ;
// l'aperçu web passe à la liste permise (plateau-etendu-1, lib/relais-web.mjs).
const copies = ouvreCopies({ DATA, COPIES_DIR, safeDir, send, broadcast, find: (id) => find(id), save, CHILD_ENV, lance: (c, o) => demarreAgent(c, o) })
const navs = ouvreNavigateurs({ DATA, send, readJson, broadcast, find: (id) => find(id), portPermis: relaisWeb.portNavigateur, dossierCaptures: (id) => envois.dirOf(DATA, id), cartes, originOk })
// Ateliers : lecture sous garde, suivi des fichiers (empreinte poussée sur /ws/events tant qu'un client est relié), PDF.
const ateliers = ouvreAteliers({ HOME, safeDir, fichierPermis, send, broadcast, cartes: () => cartes, actif: () => watchers.size > 0 })
// Barre d'ordres (volet ordres, 13/11) : fil des ordres, questions, planificateur, réponses rendues (lib/ordres-serveur.mjs).
const ordresWeb = ouvreOrdres({ DATA, HOME, send, readJson, broadcast, consoles: () => consoles, teams: () => teams, find, save, journalDe, planOrdre, executeOrdre, safeDir, kinds: () => Object.fromEntries(Object.entries(KINDS).map(([id, k]) => [id, { label: k.label }])), enRemise: (id) => delivering.has(id) })
// Décisions d'Orkun du 17/11 (volet decisions-1711, lot « serveur ») : noms des comptes (lib/comptes-noms.mjs), espaces de
// travail partagés (lib/espaces.mjs).
const nomsComptes = ouvreNomsComptes({ DATA, send, readJson })
const espacesWeb = ouvreEspaces({ DATA, send, readJson })
// Volet quota (17/11, Orkun : « Go pour tout ») : usage de chaque console lu dans ses journaux, budgets (80 % : une
// notification ; 100 % : une demande dans T'ATTEND, JAMAIS d'arrêt), validation des lancements d'une équipe. Minuterie à
// part (5 s), hors de reconcile ; rien n'est écrit dans l'objet console. docs/volets/quota.md, lib/budget.mjs.
const budget = ouvreBudget({
  data: DATA,
  consoles: () => consoles,
  equipes: () => teams,
  journaux: (kind, compte) => comptes.journaux(kind, compte),
  alerte,
  broadcast,
  lancer: (chefId, corps, equipe) => {
    const chef = find(chefId)
    if (!chef?.chief || chef.team !== equipe || !findTeam(chef.team)) throw refus('capitaine introuvable : équipe arrêtée ?', 409)
    return addMember(chef, corps) // la file des lancements de l'équipe et tous les contrôles de lancer()
  },
  previent: (equipe, texte) => wake(equipe, texte),
  roles: () => equipage.loadRoles(ROLES_DIR),
  send,
  readJson,
  refus,
  demarre: process.argv[1] === fileURLToPath(import.meta.url),
})

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const m = req.method
  // Décision d'Orkun du 17/11, ateliers-5 : « L'étendre à toute l'API à l'intégration ». Une demande faite par un AUTRE site
  // (Sec-Fetch-Site: cross-site ; ex. une navigation de premier niveau, que le cookie Lax du nom public suit) est refusée
  // sur toute l'API, et journalisée (méthode, chemin sans la requête, mode et destination ; jamais de cookie). En-tête
  // absent (bin/meydan passe par /agent/, essais en Node, navigateurs sans Fetch Metadata), « none », « same-origin » et
  // « same-site » passent. Ici seulement, jamais pour tout le serveur : /relais/ est « cross-site » par nature.
  // Sans tenir compte de la casse ni d'un en-tête répété (« Cross-Site », « cross-site, cross-site » : relecture du 17/11).
  if (/cross-site/i.test(req.headers['sec-fetch-site'] ?? '')) {
    const f = (v) => String(v ?? '-').replace(/[^\w-]/g, '').slice(0, 20)
    console.error(`[autre-site] ${f(m)} ${url.pathname.slice(0, 200)} refusé (mode ${f(req.headers['sec-fetch-mode'])}, dest ${f(req.headers['sec-fetch-dest'])})`)
    return send(res, 403, { error: 'origine refusée' })
  }
  if (m !== 'GET' && !originOk(req)) return send(res, 403, { error: 'origine refusée' })

  if (parts[1] === 'consoles' && parts.length === 2) {
    if (m === 'GET') return send(res, 200, { consoles })
    if (m === 'POST') {
      const body = await readJson(req)
      const count = num(Number(body.count ?? 1), 1, 12) // 12 d'un coup (volet « raccourcis », 13/11 ; mémoire d'une console au repos : voir test/volets/raccourcis/mesure-memoire.md). Au-delà : rogné à 12 ; 0 ou moins : 1
      if (count === undefined) return send(res, 400, { error: 'nombre de consoles invalide' }) // non numérique : un 201 vide trompait (relecture du 13/11)
      // Consigne de départ (agents seulement) : le premier message, remis à chaque console dès que son agent est au repos
      // (après une éventuelle question de démarrage), par la même file que les messages d'équipe.
      const consigne = body.kind === 'shell' ? '' : envois.messageText(body.consigne)
      // Modèle imposé à une console Claude, au lancement (`--model`) : jamais par « /model », qui changerait le modèle par
      // défaut de toutes les sessions d'Orkun. Liste fermée (11/11 : « Tu peux tout mettre en Opus 5.5 »).
      const modele = body.kind === 'claude' && MODELES.has(body.modele) ? body.modele : ''
      // Mode de permissions « auto » (le classifieur de Claude Code, comme les équipiers ; jamais « sans permissions ») : pour
      // les consoles qui travaillent seules (volets lancés sur l'ordre d'Orkun, 11/11). Seule valeur acceptée.
      const permission = body.kind === 'claude' && body.permission === 'auto' ? 'auto' : ''
      // Compte de l'agent (« Plusieurs comptes Claude / Codex ») : '1' d'office, ou '2' ; Claude et Codex seulement (ignoré
      // pour un shell ou un autre agent). Toute autre valeur est refusée. Le compte 1 n'écrit rien dans la console.
      const compte = body.kind === 'claude' || body.kind === 'codex' ? compteValide(body.compte) : '1'
      if (compte === null) return send(res, 400, { error: 'compte inconnu' })
      plafond.verifie() // décision d'Orkun du 17/11, raccourcis-3 : « refuser sous 4 Go de mémoire disponible » : une fois, avant tout le lot (lib/plafond.mjs)
      // « Dans une copie » (volet copies) : { copie: { motifs, fichiers, installation } }, Claude et Codex seulement ;
      // chaque console a SA copie (lib/copies.mjs).
      const copie = body.copie == null ? null : copies.demande(body.copie, body.kind)
      const made = []
      for (let i = 0; i < count; i++) {
        // Des agents qui démarrent ensemble chargent la machine (comme à la reprise après un redémarrage, reviveAfterBoot) :
        // une demi-seconde entre deux agents d'un même lancement (12 Claude : ~6 s) ; les shells partent d'affilée.
        if (i && body.kind !== 'shell') await sleep(500)
        const name = cleanName(body.name)
        const def = { kind: body.kind, cwd: body.cwd, name: name && count > 1 ? `${name} ${i + 1}` : name, plus: { ...(consigne ? { attente: [consigne] } : {}), ...(modele ? { modele } : {}), ...(permission ? { permission } : {}), ...(compte === '2' ? { compte } : {}) } }
        made.push(await (copie ? creeEnCopie({ ...def, copie }) : createConsole(def)))
      }
      return send(res, 201, { consoles: made })
    }
  }
  if (parts[1] === 'consoles' && parts.length >= 3) {
    const c = find(parts[2])
    if (!c) return send(res, 404, { error: 'console inconnue' })
    if (parts.length === 4 && parts[3] === 'silence' && m === 'POST') {
      if (!reporteSilence(c)) throw refus('pas d’alerte de silence à reporter', 409)
      save(); broadcast({ type: 'console', console: c })
      return send(res, 200, { console: c })
    }
    if (parts.length === 3 && m === 'PATCH') {
      const body = await readJson(req)
      for (const [k, min, max] of [['x', -50000, 50000], ['y', -50000, 50000], ['w', 320, 2400], ['h', 200, 1600]]) {
        const v = num(Number(body[k]), min, max)
        if (body[k] !== undefined && v !== undefined) c[k] = v
      }
      if (body.name !== undefined && cleanName(body.name)) c.name = cleanName(body.name)
      save()
      broadcast({ type: 'console', console: c })
      return send(res, 200, { console: c })
    }
    // Fil de la conversation de l'agent, lu dans son journal : la vue « discussion » du téléphone (Claude et Codex).
    if (parts.length === 4 && parts[3] === 'fil' && m === 'GET') {
      if (c.kind !== 'claude' && c.kind !== 'codex') return send(res, 404, { error: 'pas de conversation lisible pour cette console' })
      // Conversation pas encore connue (console neuve, rien d'envoyé) : un fil vide, pas une erreur. Une erreur à chaque
      // lecture remplissait la console du navigateur.
      const { lu, cle } = filDe(c)
      // Pendant qu'il travaille : ce que montre son écran à l'instant (indicateur, temps, texte en cours d'écriture).
      const actif = c.status === 'working' || c.status === 'running'
      // Avec 300 lignes d'historique : une réponse plus haute que l'écran garde son début lisible (sinon le texte en cours
      // disparaissait de la discussion jusqu'à la fin de la réponse — vu en production le 10/11 sur trente phrases).
      const ecran = actif ? await tmux('capture-pane', '-p', '-J', '-S', '-300', '-t', c.id).catch(() => '') : ''
      // Le menu que l'agent affiche s'il attend un choix (lib/question.mjs) : la discussion en fait des boutons. Lu sur
      // l'écran, quel que soit le statut : certains menus (« /model », « /effort ») s'ouvrent sans qu'aucun hook le dise.
      const vue = actif ? ecran : await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => '')
      // `menu` : une boîte est ouverte même si on ne sait pas en faire des boutons (la discussion renvoie alors au terminal).
      // `cle` : l'empreinte du fil (filDe). L'écran la renvoie (`?cle=`) ; si le fil n'a pas changé, il n'est pas renvoyé.
      // Mesuré le 11/11 sur ses consoles : 60 à 73 Ko par lecture (16 Ko compressés), relus toutes les 0,7 s pendant qu'un
      // agent travaille, soit ~80 Mo par heure sur l'iPhone pour redire la même conversation.
      const meme = url.searchParams.get('cle') === cle
      return send(res, 200, { cle, ...(meme ? {} : { fil: lu }), direct: actif ? fil.direct(c.kind, ecran, lu) : null, question: question.lireQuestion(vue), menu: question.menuOuvert(vue) })
    }
    // Un fichier que l'agent cite dans SA conversation (lien Markdown vers un chemin du VPS, comme Codex le fait, ou chemin
    // en `code`) : Orkun le récupère depuis la discussion, comme dans l'appli native (11/11 : « fait en sorte que je
    // puisse le telecharger comme quand je suis en remote via l'application natif de Codex »). Seulement un fichier
    // ordinaire, cité par cet agent, sous le dossier personnel, hors dossiers et fichiers cachés (`.env`, `.ssh`…) et
    // hors des données de Meydan ; 100 Mo au plus.
    if (parts.length === 4 && parts[3] === 'fichier' && m === 'GET') {
      if (c.kind !== 'claude' && c.kind !== 'codex') return send(res, 404, { error: 'pas de conversation lisible pour cette console' })
      const demande = url.searchParams.get('chemin') || ''
      if (!path.isAbsolute(demande) || demande.length > 1000) return send(res, 400, { error: 'chemin absolu attendu' })
      const journal = journalDe(c)
      const lu = journal ? fil.lireFil(c.kind, journal) : []
      if (!lu.some((x) => typeof x.t === 'string' && x.t.includes(demande))) return send(res, 404, { error: 'ce fichier n’est pas cité dans la conversation de cette console' })
      // Une seule ouverture, contrôlée sur le descripteur (lib/cartes-fichier.mjs, ouvreSur : realpath, fichierPermis,
      // O_NOFOLLOW, /proc/self/fd, fichier ordinaire, 100 Mo) AVANT les en-têtes. Avant le 13/11, le fichier était rouvert
      // par son nom après le contrôle : une bascule du dossier parent faisait servir un fichier caché (relecture, prouvé :
      // 48 sur 3 000), et une erreur d'ouverture après les en-têtes faisait tomber le serveur.
      let o
      try {
        o = ouvreSur(demande, fichierPermis)
      } catch (e) {
        return send(res, Number.isInteger(e.code) ? e.code : 404, { error: e.code === 403 ? 'fichier hors des dossiers permis' : e.message })
      }
      const { fd, reel, st } = o
      const montrable = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(reel).toLowerCase()]
      try {
        res.writeHead(200, {
          'content-type': montrable || 'application/octet-stream', // rien d'autre ne s'exécute ni ne s'affiche sous l'adresse de Meydan
          'content-length': st.size,
          'content-disposition': `${montrable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(reel))}`,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        })
      } catch (e) {
        fs.closeSync(fd)
        throw e
      }
      return await envoieFd(res, fd, st.size) // lu sur le descripteur vérifié, fermé dans tous les cas
    }
    // Réponse à la question affichée, donnée par un bouton de la discussion : { choix: rang, texte: libellé touché }.
    // Rien ne part si le menu n'est plus celui qui a été affiché, ni si le curseur n'arrive pas sur ce choix.
    // Orkun a vu cette console (ouverte, choisie dans la liste, touchée sur le plateau, agrandie) : FINI devient PRÊT.
    if (parts.length === 4 && parts[3] === 'vu' && m === 'POST') {
      vuParOrkun(c)
      return send(res, 200, { ok: true })
    }
    if (parts.length === 4 && parts[3] === 'reponse' && m === 'POST') {
      if (c.status === 'closed') return send(res, 409, { error: 'console terminée' })
      const body = await readJson(req)
      const fait = await question.repondre(
        { ecran: () => tmux('capture-pane', '-p', '-J', '-t', c.id), touche: (t) => tmux('send-keys', '-t', c.id, t) },
        Number(body.choix),
        typeof body.texte === 'string' ? body.texte : '',
      )
      orkunRepond(c)
      return send(res, 200, fait)
    }
    // Boucle : renvoyer un message à cet agent jusqu'à une fin (POST la pose, DELETE l'arrête). Voir lib/boucle.mjs.
    if (parts.length === 4 && parts[3] === 'boucle' && (m === 'POST' || m === 'DELETE')) {
      if (m === 'DELETE') {
        if (c.boucle?.etat === 'active') Object.assign(c.boucle, { etat: 'finie', raison: 'arrêtée à la main', attend: '' })
      } else {
        if ((c.kind !== 'claude' && c.kind !== 'codex') || c.team) return send(res, 409, { error: 'une boucle se pose sur une console Claude ou Codex, hors équipe' })
        if (c.status === 'closed') return send(res, 409, { error: 'console terminée' })
        const def = await readJson(req)
        const nb = boucle.nouvelle(def)
        if (nb.quand === 'sortie') {
          // La console guettée : une AUTRE console qui tourne (dans la sienne, le message collé par Meydan, qui cite le
          // texte guetté, relancerait la boucle à chaque tour). Ce qu'elle affiche déjà ne déclenche rien.
          const src = def.source ? find(String(def.source)) : null
          if (!src || src.id === c.id || src.status === 'closed') return send(res, 400, { error: 'console à guetter : une autre console, qui tourne' })
          Object.assign(nb, { source: src.id, sourceNom: src.name, compte: boucle.compteDans(await tmux('capture-pane', '-p', '-J', '-S', '-', '-t', src.id).catch(() => ''), nb.guet) })
        }
        c.boucle = nb
      }
      save()
      broadcast({ type: 'console', console: c })
      return send(res, 200, { console: c })
    }
    // Relais : passer la conversation de cette console à un NOUVEL agent ({ vers: 'claude' | 'codex' … }, même dossier), ou
    // envoyer sa dernière réponse à une console qui existe ({ vers: <identifiant> }).
    if (parts.length === 4 && parts[3] === 'relais' && m === 'POST') {
      if ((c.kind !== 'claude' && c.kind !== 'codex') || c.team) return send(res, 409, { error: 'le relais part d’une console Claude ou Codex, hors équipe' })
      const journal = journalDe(c)
      const lu = journal ? fil.lireFil(c.kind, journal) : []
      if (!lu.length) return send(res, 409, { error: 'pas encore de conversation à transmettre' })
      const body = await readJson(req)
      const vers = String(body.vers ?? '')
      const cible = find(vers)
      if (cible) {
        // Transmettre la dernière réponse : collée comme un message, validée seulement si la console est au repos.
        if (cible.id === c.id || cible.status !== 'ready') return send(res, 409, { error: 'cette console n’est pas au repos : la réponse n’a pas été transmise' })
        const texte = relais.derniereReponse(lu)
        if (!texte) return send(res, 409, { error: 'aucune réponse à transmettre' })
        await pasteMessage(cible.id, envois.messageText(`[Relais de « ${c.name} »] Voici sa dernière réponse :\n\n${texte.slice(0, 8000)}`))
        return send(res, 200, { console: cible })
      }
      if (!Object.hasOwn(KINDS, vers) || vers === 'shell') return send(res, 400, { error: 'destination inconnue' })
      // { vers, compte } (« Plusieurs comptes Claude / Codex ») : le compte de la nouvelle console, Claude et Codex seulement.
      // Vers le même type d'agent (relancer sur l'autre compte quand la limite d'usage est atteinte), elle garde aussi le
      // modèle et le mode de permissions de celle-ci.
      const compte = vers === 'claude' || vers === 'codex' ? compteValide(body.compte) : '1'
      if (compte === null) return send(res, 400, { error: 'compte inconnu' })
      // Seulement pour une relance sur l'AUTRE compte (relecture du 11/11) : un relais ordinaire reste comme avant.
      const garde = vers === c.kind && compte !== compteDe(c) ? { ...(c.modele ? { modele: c.modele } : {}), ...(c.permission ? { permission: c.permission } : {}) } : {}
      plafond.verifie() // décision d'Orkun du 17/11, raccourcis-3 : « refuser sous 4 Go de mémoire disponible » (lib/plafond.mjs)
      // La conversation est écrite dans le dossier des pièces de la NOUVELLE console : Claude y a déjà accès (--add-dir),
      // et ce dossier est vidé de ce qui a plus de 30 jours comme les autres pièces.
      const id = newId()
      const dossier = envois.dirOf(DATA, id)
      fs.mkdirSync(dossier, { recursive: true, mode: 0o700 })
      const fichier = path.join(dossier, `relais-${c.id}.md`)
      fs.writeFileSync(fichier, relais.passation(c, lu), { mode: 0o600 })
      const nom = `${KINDS[vers].label}${compte === '2' ? ' · compte 2' : ''} · relais de ${c.name}`
      const neuve = await createConsole({ kind: vers, cwd: c.cwd, name: nom, plus: { id, relais: { de: c.id, fichier }, ...garde, ...(compte === '2' ? { compte } : {}) } }).catch((e) => {
        fs.rmSync(dossier, { recursive: true, force: true })
        throw e
      })
      return send(res, 201, { console: neuve })
    }
    // « Continuer dans une copie » (volet copies) : une console neuve du même type (même modèle, même mode de
    // permissions, même compte) dans une copie neuve du dépôt de celle-ci, qui reçoit sa conversation par le relais s'il
    // y en a une. La copie part de la tête de la branche : les changements non commités restent dans le dossier d'origine
    // (le menu le dit, le relais aussi). L'ancienne console reste ouverte. Corps : { motifs, fichiers, installation }.
    if (parts.length === 4 && parts[3] === 'copie' && m === 'POST') {
      if ((c.kind !== 'claude' && c.kind !== 'codex') || c.team) return send(res, 409, { error: 'une copie se fait pour une console Claude ou Codex, hors équipe' })
      plafond.verifie() // décision d'Orkun du 17/11, raccourcis-3 : « refuser sous 4 Go de mémoire disponible » : avant la copie (lib/plafond.mjs)
      const copie = copies.demande(await readJson(req), c.kind)
      const journal = journalDe(c)
      const lu = journal ? fil.lireFil(c.kind, journal) : []
      const id = newId()
      const nom = `${c.name.replace(/ · copie$/, '').slice(0, 40).trimEnd()} · copie`
      const garde = { ...(c.modele ? { modele: c.modele } : {}), ...(c.permission ? { permission: c.permission } : {}), ...(compteDe(c) === '2' ? { compte: '2' } : {}) }
      const { cwdAgent, champ } = await copies.cree({ dossier: safeDir(c.cwd), nom, ...copie })
      const dossier = envois.dirOf(DATA, id)
      try {
        let relaisChamp = {}
        if (lu.length) {
          fs.mkdirSync(dossier, { recursive: true, mode: 0o700 })
          const fichier = path.join(dossier, `relais-${c.id}.md`)
          const texte = relais.passation(c, lu).replace(/^Dossier de travail : .*$/m, (l) => `${l} (dossier d'origine)\n${copies.noteRelais(champ)}`)
          fs.writeFileSync(fichier, texte, { mode: 0o600 })
          relaisChamp = { relais: { de: c.id, fichier } }
        }
        const neuve = await createConsole({ kind: c.kind, cwd: cwdAgent, name: nom, plus: { id, ...relaisChamp, ...garde, copie: champ } })
        return send(res, 201, { console: neuve })
      } catch (e) {
        fs.rmSync(dossier, { recursive: true, force: true })
        await copies.retire(champ)
        throw e
      }
    }
    // Interrompre ce qui tourne : Échap pour un agent qui travaille, Ctrl C pour un programme lancé dans un shell.
    // Jamais quand une question est affichée : Échap y répondrait « non » à la place d'Orkun.
    if (parts.length === 4 && parts[3] === 'interrompre' && m === 'POST') {
      if (!['working', 'running'].includes(c.status)) return send(res, 409, { error: 'rien à interrompre : cette console ne travaille pas' })
      if (question.menuOuvert(await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => ''))) return send(res, 409, { error: 'une question est affichée : réponds-y plutôt' })
      await tmux('send-keys', '-t', c.id, c.kind === 'shell' ? 'C-c' : 'Escape')
      return send(res, 200, { ok: true })
    }
    if (parts.length === 4 && parts[3] === 'relance' && m === 'POST') {
      if (c.status !== 'closed') return send(res, 409, { error: 'cette console tourne déjà' })
      return send(res, 200, { console: await revive(c) })
    }
    if (parts.length === 3 && m === 'DELETE' && c.team) {
      // Membre d'une équipe : son dossier de travail part avec lui s'il est propre ; le capitaine ne se ferme qu'avec l'équipe.
      if (c.chief) return send(res, 409, { error: 'c’est le capitaine : arrête l’équipe entière' })
      const r = await closeMember(c, false)
      wake(c.team, `Orkun a fermé ${who(c)}.`)
      return send(res, 200, { ok: true, ...r })
    }
    if (parts.length === 3 && m === 'DELETE') {
      await fermeSeule(c)
      return send(res, 200, { ok: true })
    }
    // Fermer en gardant dans l'historique (le ×, « Fermer », la barre de sélection, une console seule hors équipe).
    if (parts.length === 4 && parts[3] === 'fermer' && m === 'POST') {
      if (c.team) return send(res, 409, { error: 'console d’équipe : elle se ferme avec son équipe ou par DELETE' })
      await fermeEnHistorique(c)
      return send(res, 200, { console: c })
    }
  }
  // Ce que la page vit sur l'appareil d'Orkun (11/11 : iPhone couché, « la page crash et n'affiche plus rien », sans
  // Safari ici pour le voir) : une erreur JavaScript, ou un repère de vie. Écrit au journal d'erreurs du moteur, borné et
  // sans caractères de contrôle ; rien n'est gardé ailleurs.
  if (parts[1] === 'journal-client' && parts.length === 2 && m === 'POST') {
    const body = await readJson(req).catch(() => ({}))
    const net = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, n)
    console.error(`[client] ${net(body.quoi, 20)} · ${net(body.message, 400)} · ${net(body.ou, 600)} · ${net(body.ecran, 60)} · ${net(req.headers['user-agent'], 140)}`)
    return send(res, 200, { ok: true })
  }
  // Ateliers : l'export PDF arrive ici et non sous /api/ateliers, parce que nginx n'accepte un corps de plus de 64 Ko que
  // sous /api/envois/ (le HTML rendu d'un long document) ; « ateliers » n'est jamais un identifiant de console.
  if (parts[1] === 'envois' && parts[2] === 'ateliers') return await ateliers.envoi(req, res, url, parts) // export PDF (corps > 64 Ko)
  // Plateau créatif (13/11) : l'image d'une carte arrive ici et non sous /api/cartes, parce que nginx n'accepte un corps de
  // plus de 64 Ko que sous /api/envois/ (26 Mo, deploy/nginx-meydan.example.conf). Seule la réception d'une image passe par ce
  // chemin ; tout le reste de la carte reste sous /api/cartes (lib/cartes-image.mjs).
  if (parts[1] === 'envois' && parts[2] === 'cartes') {
    if (parts.length !== 5 || !/^k[0-9a-f]{8}$/.test(parts[3]) || parts[4] !== 'image' || m !== 'POST') return send(res, 404, { error: 'route inconnue' })
    return await cartes.api(req, res, url, ['api', 'cartes', parts[3], 'image'])
  }
  // Barre d'envoi : pièces jointes, note vocale, message (lib/envois.mjs).
  if (parts[1] === 'envois' && parts.length >= 4) {
    const c = find(parts[2])
    if (!c || c.status === 'closed') return send(res, 404, { error: 'console inconnue' })
    if (parts[3] === 'fichier' && parts.length === 4 && m === 'POST') {
      const f = await envois.receive(req, DATA, c.id, url.searchParams.get('nom'))
      return send(res, 201, { fichier: { nom: f.nom, taille: f.taille, chemin: f.chemin } })
    }
    // Une pièce déjà reçue, pour la discussion : une image s'affiche, tout autre fichier se télécharge.
    if (parts[3] === 'fichier' && parts.length === 5 && m === 'GET') {
      const file = envois.fileOf(DATA, c.id, parts[4])
      if (!file) return send(res, 404, { error: 'pièce inconnue' })
      const type = envois.TYPE_IMAGE[path.extname(file).toLowerCase()]
      res.writeHead(200, {
        'content-type': type || 'application/octet-stream',
        'content-length': fs.statSync(file).size,
        'content-disposition': `${type ? 'inline' : 'attachment'}; filename="${path.basename(file)}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=3600',
      })
      return void fs.createReadStream(file).pipe(res)
    }
    if (parts[3] === 'fichier' && parts.length === 5 && m === 'DELETE') {
      const file = envois.fileOf(DATA, c.id, parts[4])
      if (!file) return send(res, 404, { error: 'pièce inconnue' })
      await fs.promises.rm(file, { force: true })
      return send(res, 200, { ok: true })
    }
    if (parts[3] === 'voix' && parts.length === 4 && m === 'POST') return send(res, 200, await envois.transcribe(req, DATA, c.id))
    if (parts[3] === 'message' && parts.length === 4 && m === 'POST') {
      if (AWAITS.has(c.status)) return send(res, 409, { error: 'l’agent attend une réponse dans le terminal : réponds-lui d’abord' })
      // Un menu ouvert à l'écran sans qu'aucun hook l'ait dit (« /model », « /effort »…) : le message y serait collé et son
      // Entrée validerait le choix surligné (arrivé le 10/11 à 20:06 sur la console d'Orkun). On refuse.
      if (question.menuOuvert(await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => ''))) return send(res, 409, { error: 'l’agent affiche un menu : réponds-y d’abord (boutons de la discussion, ou terminal)' })
      const body = await readJson(req)
      const names = Array.isArray(body.fichiers) ? body.fichiers : []
      if (names.length > envois.MAX_FILES) return send(res, 400, { error: `${envois.MAX_FILES} pièces au plus par message` })
      const paths = names.map((n) => envois.fileOf(DATA, c.id, n))
      if (paths.some((p) => !p)) return send(res, 400, { error: 'pièce inconnue' })
      // À l'invite d'un shell, les chemins vont au bout de la ligne ; devant un agent, en liste sous le texte.
      const text = envois.messageText(body.texte, paths, c.status === 'shell')
      if (!text) return send(res, 400, { error: 'message vide' })
      // Texte risqué (rm -rf, sudo, .env…, vu sur le texte nettoyé) : deux appuis, empreinte liée à cette console et au texte
      // qui part (lib/garde-envoi.mjs ;
      // décision d'Orkun du 17/11, ordres-4 : « Oui, avec le même risques(), dans un lot à part »).
      const risque = gardeEnvoi(c.id, text, body.confirme)
      if (risque) return send(res, 409, risque)
      await pasteMessage(c.id, text)
      saisies.delete(c.id) // ce qu'il avait tapé dans le terminal est parti avec son message
      orkunRepond(c)
      return send(res, 200, { ok: true })
    }
  }
  // Équipes : créer (une mission → un capitaine), livrer (avance rapide du projet, sur le go d'Orkun), arrêter.
  if (parts[1] === 'equipes') {
    if (parts.length === 2 && m === 'GET') return send(res, 200, { teams, roles: Object.values(equipage.loadRoles(ROLES_DIR)).map(({ texte, ...r }) => r) })
    if (parts.length === 2 && m === 'POST') {
      // Volet quota : « Valider les lancements » posé à la création (le capitaine lance dans la première minute).
      const corps = await readJson(req)
      const valider = corps?.validerLancements
      if (valider !== undefined && typeof valider !== 'boolean') throw refus('réglage Valider les lancements invalide')
      const team = await createTeam(corps)
      if (valider) budget.regleEquipe(team.id, { valider: true })
      return send(res, 201, { team })
    }
    const team = findTeam(parts[2])
    if (!team) return send(res, 404, { error: 'équipe inconnue' })
    if (parts.length === 4 && parts[3] === 'verification' && m === 'PATCH') {
      const b = await readJson(req)
      if (typeof b.active !== 'boolean') throw refus('réglage invalide')
      team.verifierFin = b.active
      if (!b.active && team.verification?.etat === 'active') finVerification(team, 'refusee', 'Vérification désactivée par Orkun : aucun autre relais automatique.')
      save(); broadcast({ type: 'team', team })
      return send(res, 200, { team })
    }
    if (parts.length === 4 && parts[3] === 'livrer' && m === 'POST') {
      // Orkun livre ce qu'il a lu : l'écran renvoie le commit prêt qu'il affichait au moment de l'appui. Si le capitaine
      // a redéclaré autre chose entre-temps, rien ne part (et ce n'est pas au capitaine d'agir : il n'est pas réveillé).
      const { head } = await readJson(req)
      if (team.pret && String(head ?? '') !== team.pret.head)
        return send(res, 409, { error: 'le travail prêt a changé depuis ce que tu as lu : relis le compte rendu du capitaine, puis confirme de nouveau' })
      try {
        return send(res, 200, { team: await deliver(team) })
      } catch (e) {
        // Le capitaine doit agir (fusionner la branche du projet, redéclarer). Pas pour un refus qui vient du dossier du
        // projet (`cote: 'projet'` : fichiers non commités d'Orkun, autre branche, tête détachée) : il ne peut rien y
        // faire, Orkun le lit à l'écran (17/11, chasse n°11).
        if (team.pret && e.cote !== 'projet') wake(team.id, `Livraison refusée : ${e.message}`)
        throw e
      }
    }
    if (parts.length === 3 && m === 'DELETE') return send(res, 200, { ok: true, ...(await stopTeam(team)) })
  }
  // Notifications du téléphone : la clé publique du serveur (GET), abonner cet appareil (POST, gardé seulement si la
  // notification d'essai est acceptée), le retirer (DELETE).
  if (parts[1] === 'suggestions') {
    const entrees = listeSuggestions(dossierSuggestions(), veille.classes)
    if (parts.length === 2 && m === 'GET') return send(res, 200, { suggestions: entrees, projets: [...new Set(entrees.map((x) => x.projet))] })
    const x = entrees.find((x) => x.id === parts[2])
    if (!x) throw refus('entrée inconnue', 404)
    if (parts.length === 4 && parts[3] === 'lecon' && m === 'GET') return send(res, 200, { texte: leconDe(x) })
    if (parts.length === 4 && parts[3] === 'classer' && m === 'POST') {
      if (!veille.classes.includes(x.id)) veille.classes.push(x.id)
      gardeVeille()
      return send(res, 200, { ok: true })
    }
  }
  if (parts[1] === 'revues' && parts.length === 2 && m === 'GET') return send(res, 200, { revues: veille.revues, fiable: veille.fiable, derniereLecture: veille.derniereLecture })
  // L'appareil demande si le serveur l'a encore (adresse dans le corps : jamais dans l'URL, ni donc dans les journaux).
  if (parts[1] === 'alertes' && parts[2] === 'connu' && parts.length === 3 && m === 'POST') {
    const body = await readJson(req)
    return send(res, 200, { connu: !!alertes?.connu(String(body.endpoint ?? '')) })
  }
  if (parts[1] === 'alertes' && parts.length === 2) {
    if (m === 'GET') return send(res, 200, { cle: alertes?.cle ?? null, appareils: alertes?.nombre() ?? 0 })
    if (!alertes) return send(res, 409, { error: 'notifications indisponibles hors du nom public' })
    const body = await readJson(req)
    if (m === 'POST') {
      await alertes.abonne(body.abonnement)
      return send(res, 201, { appareils: alertes.nombre() })
    }
    if (m === 'DELETE') return send(res, 200, { retires: alertes.retire(String(body.endpoint ?? '')), appareils: alertes.nombre() })
  }
  // Vue d'ensemble (téléphone couché) : ce que chaque console est en train de faire, en quelques lignes.
  if (parts[1] === 'apercus' && parts.length === 2 && m === 'GET') {
    const paires = await Promise.all(consoles.map(async (c) => [c.id, await apercuDe(c).catch(() => null)]))
    return send(res, 200, { apercus: Object.fromEntries(paires.filter(([, a]) => a)) })
  }
  if (parts[1] === 'cartes') return await cartes.api(req, res, url, parts)
  if (parts[1] === 'copies') return await copies.api(req, res, url, parts) // volet copies : lib/copies.mjs
  if (parts[1] === 'nav') return await navs.api(req, res, url, parts) // volet copies : lib/navigateur.mjs
  if (parts[1] === 'ateliers') return await ateliers.api(req, res, url, parts) // ateliers : lecture seule
  if (parts[1] === 'comptes' && parts[2] === 'noms') return await nomsComptes.api(req, res, parts, m) // décision d'Orkun du 17/11, comptes-3 : « Donner des noms » (lib/comptes-noms.mjs)
  if (parts[1] === 'espaces') return await espacesWeb.api(req, res, parts, m) // décision d'Orkun du 17/11, plateau-pc-2 : « Sur le serveur (partagés) » (lib/espaces.mjs)
  if (parts[1] === 'budget') return await budget.api(req, res, url, parts) // volet quota : lib/budget.mjs
  // Comptes Claude / Codex (« Plusieurs comptes Claude / Codex ») : la liste, immédiate (« connecté » = le fichier
  // d'identification existe, jamais ouvert) ; l'usage par compte (jetons et coût du jour et des 7 jours, limites écrites
  // par Codex), calculé par lib/comptes.mjs et gardé 60 s (quelques secondes la première fois).
  if (parts[1] === 'comptes' && m === 'GET') {
    if (parts.length === 2) return send(res, 200, { comptes: comptes.liste() })
    if (parts.length === 3 && parts[2] === 'usage') return send(res, 200, await comptes.usage())
  }
  if (parts[1] === 'projects' && m === 'GET') return send(res, 200, { projects: projects(), kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label })) })
  // Mémoire du projet : les faits de chaque projet, qu'Orkun voit, écrit, valide et supprime (voir memoireApi).
  if (parts[1] === 'memoire' && parts.length >= 2 && parts.length <= 4) return await memoireApi(req, res, parts, m)
  // Barre de commande : { texte } rend le plan sans rien toucher ; { texte, executer: true } l'exécute (un plan « à
  // confirmer » demande l'empreinte de ce qui a été montré) ; fil, questions, planificateur : lib/ordres-serveur.mjs.
  // Dicté : /api/ordre/voix rend le texte.
  if (parts[1] === 'ordre' && parts.length === 3 && parts[2] === 'voix' && m === 'POST') return send(res, 200, await envois.transcrireDans(req, path.join(DATA, 'envois', '_ordres')))
  if (parts[1] === 'ordre') return await ordresWeb.api(req, res, parts, m)
  return send(res, 404, { error: 'route inconnue' })
}

// ── Barre de commande ─────────────────────────────────────────────────────────────────────────────────────────────
// Le plan d'un ordre (lib/ordres.mjs), avec le dossier vérifié d'avance pour « lance » (« ~/site » et « site » = le
// dossier site du répertoire personnel).
function planOrdre(texte) {
  const plan = ordres.comprendre(texte, { consoles, kinds: Object.fromEntries(Object.entries(KINDS).map(([id, k]) => [id, { label: k.label }])) })
  if (plan.ordre === 'lancer') {
    const rel = plan.dossier === '~' ? HOME : plan.dossier.replace(/^~\//, '')
    try {
      plan.cwd = safeDir(rel)
    } catch (e) {
      return { ...plan, erreur: `Dossier « ${plan.dossier} » : ${e.code === 'ENOENT' ? 'introuvable' : e.message}.` }
    }
  }
  return plan
}
// Fermer une console seule la RANGE dans l'historique (16/11, Orkun : « je viens de fermer une console et je ne la vois
// pas dans historique ») : sa session tmux s'arrête (ce qui tourne dedans aussi), son navigateur et son installation
// aussi ; elle reste dans la liste, « closed », relançable sur sa conversation (onglet « Historique »). Ses pièces jointes
// et son fichier de lancement restent jusqu'au retrait (fermeSeule : DELETE, « Retirer de l'historique » / « Vider »).
async function fermeEnHistorique(c) {
  await tmux('kill-session', '-t', c.id).catch(() => {}) // déjà morte : rien à tuer
  navs.ferme(c.id)
  copies.oublie(c.id)
  if (c.status !== 'closed') setStatus(c, 'closed')
}
// Une console seule retirée : session tuée, pièces jointes supprimées, retirée de la liste (et de l'historique).
async function fermeSeule(c) {
  await tmux('kill-session', '-t', c.id).catch(() => {}) // déjà morte : rien à tuer
  navs.ferme(c.id) // son navigateur part avec elle (volet copies)
  copies.oublie(c.id) // et son installation en cours, et son journal d'installation (volet copies)
  await envois.forget(DATA, c.id) // ses pièces jointes partent avec elle
  memoire.oublieLancement(DATA, c.id) // et son fichier de lancement (mémoire du projet)
  consoles = consoles.filter((x) => x.id !== c.id)
  lacheFil(c.id)
  save()
  beat()
  broadcast({ type: 'removed', id: c.id })
}
// Exécute un plan : rend { fait: [lignes], creees: [ids] }. Chaque console est traitée à part : un refus n'arrête pas
// les autres, il est dit dans le compte rendu.
async function executeOrdre(plan) {
  const fait = []
  const creees = []
  const de = (id) => find(id)
  if (plan.ordre === 'lancer') {
    const consigne = plan.consigne ? envois.messageText(plan.consigne) : ''
    for (let i = 0; i < plan.n; i++) {
      const c = await createConsole({ kind: plan.kind, cwd: plan.cwd, name: '', plus: consigne ? { attente: [consigne] } : {} })
      creees.push(c.id)
      fait.push(`${c.name} lancée`)
    }
    return { fait, creees }
  }
  for (const id of plan.cibles) {
    const c = de(id)
    if (!c) continue
    try {
      if (plan.ordre === 'envoyer') {
        enqueue(c, envois.messageText(plan.message))
        fait.push(`${c.name} : ${c.status === 'ready' ? 'remis' : 'remis dès qu’il sera au repos'}`)
      } else if (plan.ordre === 'interrompre') {
        if (!['working', 'running'].includes(c.status)) fait.push(`${c.name} : ne travaille plus`)
        else if (question.menuOuvert(await tmux('capture-pane', '-p', '-J', '-t', c.id).catch(() => ''))) fait.push(`${c.name} : une question est affichée, rien envoyé`)
        else {
          await tmux('send-keys', '-t', c.id, c.kind === 'shell' ? 'C-c' : 'Escape')
          fait.push(`${c.name} : interrompue`)
        }
      } else if (plan.ordre === 'relancer') {
        if (c.status !== 'closed') fait.push(`${c.name} : tourne déjà`)
        else {
          await revive(c)
          fait.push(`${c.name} : relancée`)
        }
      } else if (plan.ordre === 'fermer') {
        if (c.chief) fait.push(`${c.name} : capitaine, laissé`)
        else if (c.team) {
          const { garde } = await closeMember(c, false)
          wake(c.team, `Orkun a fermé ${who(c)}.`)
          fait.push(`${c.name} : fermée${garde ? ` — travail non commité, dossier gardé : ${garde}` : ''}`)
        } else {
          await fermeEnHistorique(c) // dans l'historique, comme le × (16/11)
          fait.push(`${c.name} : fermée`)
        }
      }
    } catch (e) {
      fait.push(`${c.name} : ${e.message}`)
    }
  }
  return { fait, creees }
}

// ── Connexion publique ──────────────────────────────────────────────────────
// Page sans script ni fichier externe : rien d'autre n'est servi sans session. Les messages d'erreur sont des textes fixes.
const LOGIN_CSS =
  '*{box-sizing:border-box}html{color-scheme:dark;-webkit-text-size-adjust:100%}' +
  'body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:radial-gradient(120% 60% at 30% 0%,#121a38,rgba(8,11,24,0) 70%),#080b18;color:#e6e8f0;font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
  'form{width:100%;max-width:340px;display:grid;gap:18px}' +
  'h1{display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:22px;font-weight:600;letter-spacing:-.02em}' +
  'h1 i{width:18px;height:18px;border:2px solid #e6e8f0;border-radius:4px;display:grid;place-items:center}h1 i::after{content:"";width:6px;height:6px;background:#f2e94e}' +
  'label{display:grid;gap:7px;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;color:#9aa2ba}' +
  'input{width:100%;height:48px;padding:0 14px;background:#0a0c12;border:1px solid rgba(190,205,255,.18);border-radius:2px;color:#e6e8f0;font:16px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;outline:0}' +
  'input:focus{border-color:#6e9bff;box-shadow:0 0 0 1px #6e9bff}input[name=code]{font:600 20px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.3em}' +
  'button{height:50px;margin-top:4px;background:#f2e94e;color:#0b0e18;border:0;border-radius:2px;font:600 16px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer}button:focus-visible{outline:2px solid #6e9bff;outline-offset:2px}' +
  '.err{margin:0;padding:11px 14px;background:rgba(255,93,108,.12);border-left:3px solid #ff5d6c;color:#ffb3ba;font-size:14px}'
function loginPage(res, code = 200, error = '') {
  const html =
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#080b18"><meta name="robots" content="noindex"><title>Meydan · connexion</title><style>${LOGIN_CSS}</style></head>` +
    `<body><form method="post" action="/login"><h1><i></i>meydan</h1>${error ? `<p class="err" role="alert">${error}</p>` : ''}` +
    '<label>Identifiant<input name="user" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus></label>' +
    '<label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<label>Code à 6 chiffres<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></label>' +
    '<button type="submit">Entrer</button></form></body></html>'
  send(res, code, html, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  })
}

let lastTotpStep = -1 // dernier pas du code à 6 chiffres consommé : un code ne sert qu'une fois (mémoire du process)
const loginTries = [] // horodatages des essais de la dernière minute, tous visiteurs confondus
// Verrou : 5 échecs avec le bon identifiant en un quart d'heure ferment la connexion à tout le monde jusqu'à ce qu'ils
// vieillissent. Qui connaîtrait le mot de passe n'a ainsi que 5 essais par quart d'heure pour deviner le code à 6 chiffres.
// Contrepartie assumée : quelqu'un qui connaît l'identifiant peut bloquer les NOUVELLES connexions (les sessions ouvertes
// et le tunnel SSH ne sont pas touchés). Pour une porte qui donne un shell, on préfère être bloqué qu'ouvert.
const LOCK_FAILS = 5
const LOCK_MS = 15 * 60000
const userFails = []
async function login(req, res) {
  // Pas de contrôle d'origine ici : il n'y a pas encore de session à détourner, et un navigateur envoie « Origin: null »
  // pour un formulaire quand la page interdit le referrer (constaté dans Chromium le 10/11 : la connexion était refusée).
  const ip = String(req.headers['x-real-ip'] || 'local').slice(0, 64)
  const now = Date.now()
  while (loginTries.length && loginTries[0] <= now - 60000) loginTries.shift()
  // nginx limite déjà chaque adresse (10 essais par minute) ; ce plafond-ci vaut pour tout le monde à la fois.
  if (loginTries.length >= 30) {
    console.warn(`[auth] trop d'essais, refus depuis ${ip}`)
    return loginPage(res, 429, 'Trop d’essais. Réessaie dans une minute.')
  }
  loginTries.push(now)
  while (userFails.length && userFails[0] <= now - LOCK_MS) userFails.shift()
  if (userFails.length >= LOCK_FAILS) {
    console.warn(`[auth] verrou actif, refus depuis ${ip}`)
    return loginPage(res, 429, 'Trop d’échecs. Réessaie dans un quart d’heure.')
  }
  const c = credentials()
  if (!c) return loginPage(res, 503, 'Accès non initialisé.')
  const form = new URLSearchParams(await readText(req, 4096))
  const user = Buffer.from(String(form.get('user') ?? '').trim().toLowerCase())
  const expected = Buffer.from(String(c.user).toLowerCase())
  const userOk = user.length === expected.length && crypto.timingSafeEqual(user, expected)
  // Le code d'abord (peu coûteux), consommé avant tout await : deux demandes simultanées ne réutilisent pas le même.
  // Le mot de passe (scrypt, coûteux) n'est vérifié que si le code est bon. Jamais de connexion sans code.
  let ok = false
  if (userOk) {
    const step = verifyTotp(c.totpSecret, String(form.get('code') ?? '').replace(/\s/g, ''), { afterStep: lastTotpStep })
    if (step !== null) {
      lastTotpStep = step
      ok = await verifyPassword(String(form.get('password') ?? ''), c.passwordHash)
    }
  }
  if (!ok) {
    if (userOk && userFails.push(Date.now()) >= LOCK_FAILS) console.error(`[auth] VERROU : ${LOCK_FAILS} échecs avec le bon identifiant, connexion fermée un quart d'heure (dernier essai depuis ${ip})`)
    console.warn(`[auth] connexion refusée depuis ${ip}`)
    return loginPage(res, 401, 'Accès refusé.')
  }
  userFails.length = 0
  console.log(`[auth] session ouverte depuis ${ip}`)
  return send(res, 303, '', { location: '/', 'set-cookie': `${PCOOKIE}=${signPublic(c)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${PUBLIC_TTL_S}` })
}
const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 421, 'hôte refusé')
    const url = new URL(req.url, `http://${req.headers.host}`)
    // Chemin écrit autrement que sa forme normale (« /x\..\login », « //x/login ») : refusé. Sinon nginx et Node ne liraient pas
    // la même adresse, et la limite d'essais que nginx pose sur /login serait contournable.
    if (url.pathname !== req.url.split('?')[0]) return send(res, 400, 'adresse refusée')

    // Hooks des agents : clé dédiée, pas de cookie. Boucle locale seulement, jamais sous le nom public.
    if (url.pathname.startsWith('/hook/')) {
      if (isPublic(req)) return send(res, 404, 'introuvable')
      const [, , id, state] = url.pathname.split('/')
      if (req.method !== 'POST' || !same(req.headers['x-meydan-hook'], HOOK_KEY)) return send(res, 403, 'refusé')
      const c = find(id)
      if (!c || !STATES.has(state)) return send(res, 404, 'inconnu')
      const raw = await readText(req)
      // Console fermée : le dernier hook d'un agent qui s'éteint (Stop, SessionEnd) ne la ressort pas de l'Historique
      // (chasse du 17/11 : « working » puis de nouveau « closed » 3 s plus tard). « Relancer » la repasse « starting »
      // avant que l'agent relancé n'envoie le sien.
      if (c.status === 'closed') return send(res, 204, '')
      const agent = hookSession(raw)
      if (agent && agent !== c.agent) {
        c.agent = agent // la conversation à reprendre si la console doit être rouverte
        if (c.sujet) {
          c.sujet = '' // autre conversation : son sujet reviendra quand l'agent l'aura nommée
          broadcast({ type: 'console', console: c })
        }
        save()
      }
      // 17/11 (chasse, n°7) : Claude Code relance ses hooks SessionStart après une compaction, automatique (en plein tour,
      // contexte plein) comme manuelle, avec `source: "compact"` (lu dans le binaire 2.1.326 : la compaction appelle les
      // hooks de démarrage avec « compact » ; valeurs du schéma : startup, resume, clear, compact, fork) ; la compaction
      // d'un sous-agent les relance aussi. Pris pour un retour au repos, ce hook faisait croire que l'équipier avait fini
      // son tour (réveil du capitaine « sans statut décisif »), lui remettait sa file en plein travail, et marquait FINI
      // une console seule qui travaillait. Le statut ne change pas ; la conversation à reprendre, si, plus haut.
      // Source absente ou autre (Codex, corps vide) : comme avant.
      // De même, SessionEnd n'arrête pas l'agent quand sa raison est « clear » (/clear) ou « resume » (/resume) : la session
      // suivante démarre aussitôt dans le même programme ; sans cela, l'équipier passait « shell » et le capitaine était
      // réveillé « son agent s'est arrêté » pour un agent vivant (n°6 ; relecture du volet).
      const raison = hookRaison(raw)
      if ((state === 'ready' && raison === 'compact') || (state === 'shell' && (raison === 'clear' || raison === 'resume'))) return send(res, 204, '')
      const avant = c.status
      setStatus(c, state, state === 'needs' || state === 'error' ? hookNote(raw) : '')
      if (c.team) afterHook(c, avant, state, raw)
      return send(res, 204, '')
    }

    // Commande des agents d'une équipe (bin/meydan) : jeton de la console, boucle locale seulement.
    if (url.pathname.startsWith('/agent/')) {
      if (isPublic(req)) return send(res, 404, 'introuvable')
      const me = find(String(req.headers['x-meydan-id'] || ''))
      if (!me || !same(req.headers['x-meydan-token'], tokenOf(me.id))) return send(res, 403, { error: 'refusé' })
      if (me.verificationTeam) return await verifierApi(req, res, url, me)
      if (url.pathname === '/agent/capitaine' && req.method === 'POST') {
        const team = await promouvoir(me, (await readJson(req)).mission)
        return send(res, 201, { equipe: { id: team.id, nom: team.nom, projet: team.projet }, brief: path.join(memberDir(me), 'brief.md') })
      }
      // Mémoire du projet : toute console Meydan propose un fait et lit ceux de son projet, équipe ou pas.
      if (url.pathname === '/agent/fait' && req.method === 'POST') return await agentFait(req, res, me)
      if (url.pathname === '/agent/faits' && req.method === 'GET') return agentFaits(res, me)
      // Navigateur de l'agent (volet copies) : toute console Meydan, équipe ou pas (lib/navigateur.mjs).
      if (url.pathname === '/agent/nav' || url.pathname.startsWith('/agent/nav/')) return await navs.agent(req, res, url, me)
      if (!me.team || !findTeam(me.team)) return send(res, 403, { error: 'cette console n’est capitaine d’aucune équipe. Sur l’ordre d’Orkun, elle le devient avec : meydan capitaine "<la mission en une ligne>"' })
      return await agentApi(req, res, url, me)
    }

    // Relais de l'aperçu web d'une carte : son jeton (dans l'adresse) tient lieu de session, il n'est donné qu'à une
    // session ouverte et ne vaut que pour cette carte et son port (lib/relais-web.mjs). Les deux portes, comme le reste.
    if (url.pathname.startsWith('/relais/')) return await relaisWeb.sert(req, res, url)

    if (isPublic(req)) {
      // Nom public : mot de passe + code. Le lien à clé n'y existe pas (une clé dans une adresse finit dans les journaux).
      if (url.pathname === '/login') {
        if (req.method === 'POST') return await login(req, res)
        if (req.method !== 'GET') return send(res, 405, 'méthode refusée')
        return authed(req) ? send(res, 303, '', { location: '/' }) : loginPage(res)
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        if (!originOk(req)) return send(res, 403, 'origine refusée')
        if (authed(req)) closePublicSessions()
        return send(res, 303, '', { location: '/login', 'set-cookie': `${PCOOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` })
      }
      if (!authed(req)) {
        // Une page demandée sans session va à la connexion ; l'API et les fichiers reçoivent 401.
        const page = req.method === 'GET' && !url.pathname.startsWith('/api/') && !path.extname(url.pathname)
        return page ? send(res, 303, '', { location: '/login' }) : send(res, 401, 'connexion requise')
      }
    } else {
      if (url.pathname === '/' && url.searchParams.has('k')) {
        if (!same(url.searchParams.get('k'), ACCESS_KEY)) return send(res, 403, 'clé refusée')
        // Page relais plutôt qu'un 302 : un lien ouvert depuis une autre appli (Telegram, mail) est une navigation
        // « d'un autre site », et un cookie Strict ne suit pas sa chaîne de redirections → 401 au premier essai.
        return send(res, 200, '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Meydan</title>', {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `${COOKIE}=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        })
      }
      if (!authed(req)) return send(res, 401, 'Meydan : ouvre le lien à clé (data/access.key).')
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (req.method !== 'GET') return send(res, 405, 'méthode refusée')
    return serveStatic(req, res, url.pathname)
  } catch (err) {
    // lib/envois.mjs lève des erreurs dont le code est le statut à rendre (413, 422, 500…) ; tout le reste vaut 400.
    const code = Number.isInteger(err.code) && err.code >= 400 && err.code < 600 ? err.code : 400
    if (!res.headersSent) send(res, code, { error: String(err.message || err) })
  }
})

// Un envoi de 25 Mo sur un réseau mobile lent peut dépasser les 5 minutes que Node accorde par défaut à une demande.
server.requestTimeout = 15 * 60 * 1000

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
const watchers = new Set()
function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of watchers) if (ws.readyState === 1) ws.send(data)
}

server.on('upgrade', (req, socket, head) => {
  let url = null
  try {
    if (hostOk(req) && req.headers.origin && originOk(req) && authed(req)) url = new URL(req.url, `http://${req.headers.host}`)
  } catch {
    url = null
  }
  if (!url) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Trame refusée par `ws` (plus de 1 Mio, texte qui n'est pas de l'UTF-8) : `ws` émet « error » puis ferme la liaison.
    // Sans écouteur, l'erreur était relancée et faisait tomber tout le moteur (chasse du 17/11 : un collage de plus de
    // 1 Mo dans un terminal suffisait). La fermeture nettoie le reste comme pour toute liaison (« close »).
    ws.on('error', (e) => console.error(`[ws] ${url.pathname} : ${e.message}`))
    // Liaison vivante : remise à vrai à chaque pong (voir le ping de 30 s plus bas).
    ws.vivante = true
    ws.on('pong', () => (ws.vivante = true))
    ws.publicExp = isPublic(req) ? publicExp(cookies(req)[PCOOKIE]) : 0
    if (url.pathname === '/ws/events') {
      watchers.add(ws)
      // `memoire` : le compte des faits de chaque projet qui a un fichier (validés, propositions en attente).
      // `version` : le script de l'interface en ligne (17/11) — une page restée ouverte pendant une mise à jour se recharge
      // (ou le propose), au lieu de garder l'ancien comportement (fermer effaçait encore chez Orkun après la mise en ligne).
      ws.send(JSON.stringify({ type: 'snapshot', consoles, teams, memoire: memoire.projets(DATA).map((p) => memoire.resume(DATA, p)), version: versionInterface() }))
      ws.on('close', () => watchers.delete(ws))
      // « vu » : la page est à l'écran (voir `regarde`). Rien d'autre n'est lu sur ce flux.
      ws.on('message', (raw) => {
        if (raw.length <= 8 && String(raw) === 'vu') ws.vuLe = Date.now()
      })
      return
    }
    // Ce que voit le navigateur d'un agent (volet copies, lib/navigateur.mjs) : en lecture seule.
    const nav = url.pathname.match(/^\/ws\/nav\/(c[0-9a-f]{8})$/)
    if (nav) return navs.ws(ws, nav[1])
    const m = url.pathname.match(/^\/ws\/term\/(c[0-9a-f]{8})$/)
    const c = m && find(m[1])
    if (!c || c.status === 'closed') return ws.close(4404, 'console inconnue')
    const cols = num(Number(url.searchParams.get('cols')), 10, 500) || 110
    const rows = num(Number(url.searchParams.get('rows')), 3, 200) || 30
    const term = pty.spawn('tmux', [...TMUX, 'attach-session', '-t', c.id], { name: 'xterm-256color', cols, rows, cwd: HOME, env: CHILD_ENV })
    let parti = false // client tmux sorti : son numéro de processus ne désigne plus rien
    term.onData((d) => ws.readyState === 1 && ws.send(d))
    term.onExit(() => ((parti = true), ws.close(4410, 'session terminée')))
    // node-pty ferme le terminal dès l'EIO de sa lecture et n'émet « exit » qu'après : « close » dit qu'il est déjà fermé.
    // Son descripteur peut alors servir à un autre fichier : plus aucun redimensionnement ne doit partir vers lui.
    term.on('close', () => (parti = true))
    ws.on('message', (raw) => {
      const s = raw.toString('utf8')
      if (s[0] === 'i') {
        term.write(s.slice(1))
        noteFrappe(c, s.slice(1)) // son champ : texte en cours ou envoyé (garde des messages de Meydan, n°15)
        if (s.includes('\r')) orkunRepond(c) // Entrée tapée par Orkun dans ce terminal
      } else if (s[0] === 'r') {
        const [cc, rr] = s.slice(1).split(',').map(Number)
        const nc = num(cc, 10, 500), nr = num(rr, 3, 200)
        // 17/11 : 3 plantages du moteur en production (« ioctl(2) failed, EBADF ») : quand le client tmux sort (console
        // fermée), node-pty ferme le terminal dès l'EIO de la lecture, AVANT son « exit » ; un redimensionnement reçu entre
        // les deux levait une exception que rien n'attrapait. `parti` suit désormais « close » ; le try/catch couvre ce qui
        // reste (comme SIGWINCH plus bas). La frappe n'a pas ce défaut : node-pty remplace `write` par un vide à la fermeture.
        if (nc && nr && !parti) {
          try {
            term.resize(nc, nr)
          } catch {} // terminal déjà fermé : le client tmux sort, la liaison va se fermer (4410)
        }
      } else if (s === 'a' && !parti) {
        // « la taille suit l'écran ACTIF » (validé par Orkun) : une fenêtre tmux n'a qu'une taille, celle du dernier client
        // actif (`window-size latest` : attache, touche, clic, molette, focus, vraie nouvelle taille). Une page qui redevient
        // visible (iPhone sorti de veille, onglet repris) ne produit rien de tout ça : son client tmux redit sa taille
        // (SIGWINCH, taille inchangée), tmux en fait le dernier actif. Rien n'est écrit à l'agent (prouvé : sonde-tmux.mjs).
        try {
          process.kill(term.pid, 'SIGWINCH')
        } catch {} // client déjà parti
      }
    })
    ws.on('close', () => {
      try {
        term.kill() // détache le client tmux ; la session continue
      } catch {}
    })
  })
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  revientDePlantage() // avant l'écoute : aucune page n'est encore là pour taire la notification
  await reviveAfterBoot() // premier lancement depuis un redémarrage du VPS : les consoles qui vivaient sont rouvertes
  await reconcile()
  // Consoles ouvertes avant le jeton pour tous (11/11) : le fichier est écrit et sa place posée dans la session tmux, où
  // `meydan` la lit (l'agent déjà lancé ne voit pas une variable ajoutée après lui).
  for (const c of consoles.filter((x) => x.status !== 'closed' && !x.team)) {
    await tmux('set-environment', '-t', c.id, 'MEYDAN_TOKEN_FILE', fichierJeton(c)).catch(() => {})
  }
  beat()
  surveilleRevues()
  setInterval(surveilleRevues, 120000)
  setInterval(beat, 15000)
  setInterval(() => reconcile().catch(() => {}), 3000)
  // Pièces jointes de plus de 30 jours : supprimées au démarrage, puis une fois par jour.
  const balaie = () => envois.sweep(DATA).then((n) => n && console.log(`[envois] ${n} fichier(s) de plus de 30 jours supprimé(s)`), (e) => console.error(`[envois] balayage : ${e.message}`))
  balaie()
  setInterval(balaie, 24 * 3600 * 1000)
  // Un proxy ou un réseau mobile coupe une liaison muette : un ping toutes les 30 s la garde ouverte. Une liaison qui n'a
  // pas répondu au ping précédent est morte (téléphone sorti du réseau sans fermer) : coupée, son client tmux détaché
  // (chasse du 17/11 : il restait attaché jusqu'au délai TCP du noyau et pesait sur la taille de la console).
  setInterval(() => {
    for (const ws of wss.clients) {
      // Une liaison ouverte sous le nom public ne survit pas à la fin de sa session.
      if (ws.publicExp && ws.publicExp <= Date.now()) ws.close(4401, 'session finie')
      else if (ws.readyState === 1) {
        if (ws.vivante === false) {
          ws.terminate()
          continue
        }
        ws.vivante = false
        ws.ping()
      }
    }
  }, 30000)
  server.listen(PORT, HOST, () => {
    console.log(`meydan : http://${HOST}:${PORT}  (socket tmux « ${SOCKET} », ${consoles.length} console(s))`)
  })
}
