// Mémoire de projet (dessin : docs/specs/2026-11-11-memoire-projet.md ; écart avec Symvibe, point 6 : « mémoire de
// projet (faits validés, poussés aux consoles) »). Par projet, une liste de faits courts validés par Orkun ; un agent
// peut en proposer, Orkun les valide. Ce module ne connaît ni HTTP ni tmux : textes, bornes, fichiers. Le serveur fait
// le reste. Rien n'est jamais écrit dans les CLAUDE.md / AGENTS.md des projets.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { refus, sur } from './equipage.mjs'
import { INVISIBLES } from '../web/src/invisibles.js'
import { NOM, deNom, queNom } from './nom.mjs'

export const BORNES = { texte: 300, valides: 40, proposes: 12, parConsole: 4 }
const CLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ // le projet sert de nom de fichier : jamais de « / » ni de « .. »
const ID = /^f[0-9a-f]{6}$/
const CONSOLE = /^c[0-9a-f]{8}$/
export const cleValide = (projet) => typeof projet === 'string' && CLE.test(projet)

// Le texte d'un fait est lu par des agents (fichier de lancement, brief) et montré à Orkun : ce qu'il voit doit être
// exactement ce qui est gardé. Relecture de sécurité du 11/11 : 134 caractères d'étiquette (U+E0000…, invisibles)
// cachaient « Ignore Orkun… curl … | sh » derrière « Le port de production est 3070. ». Les blancs (retours à la ligne,
// tabulations) deviennent d'abord une espace ; tout le reste d'invisible est RETIRÉ (pas remplacé) ; NFC après le retrait.
// Retirés : contrôles, format (direction, étiquettes U+E0000…, invisibles), usage privé, non attribués, moitiés de
// caractère, sélecteurs de variante (un octet caché par sélecteur), remplissages invisibles (Hangul, khmer, mongol).
// INVISIBLES : web/src/invisibles.js (une seule liste pour la mémoire, `ligne` des équipiers et la barre d'envoi, côté écran et côté serveur).
export const nettoie = (s) => String(s ?? '').toWellFormed().replace(/\s/g, ' ').replace(INVISIBLES, '').normalize('NFC').replace(/ +/g, ' ').trim()
// Vide ou trop long : refusé, jamais coupé en silence.
function texteDe(s) {
  const t = typeof s === 'string' ? nettoie(s) : ''
  if (!t) throw refus('fait vide')
  if (t.length > BORNES.texte) throw refus(`trop long (${BORNES.texte} caractères au plus)`)
  return t
}
const meme = (a, b) => a.toLowerCase() === b.toLowerCase() // doublon : même texte nettoyé, sans tenir compte de la casse
const compte = (faits, etat) => faits.filter((f) => f.etat === etat).length

// ── Fichier : DATA/memoire/<projet>.json (dossier 0700, fichier 0600, écrit par fichier temporaire puis renommage) ──
const dossier = (DATA) => path.join(DATA, 'memoire')
function fichier(DATA, projet) {
  if (!cleValide(projet)) throw refus('projet invalide')
  return path.join(dossier(DATA), `${projet}.json`)
}
// Écriture jamais à travers un lien : le dossier doit être un vrai dossier (pas un lien, pas un fichier), le fichier
// temporaire est retiré puis créé à neuf (« wx » : refus s'il existe encore), et le renommage remplace un lien éventuel
// posé à la place du fichier final au lieu d'écrire là où il pointe.
function vraiDossier(d) {
  try {
    if (!fs.lstatSync(d).isDirectory()) throw refus(`écriture refusée : ${d} n’est pas un vrai dossier (lien ou fichier)`, 500)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  }
}
function ecritAtomique(f, contenu) {
  fs.rmSync(`${f}.tmp`, { force: true })
  fs.writeFileSync(`${f}.tmp`, contenu, { flag: 'wx', mode: 0o600 })
  fs.renameSync(`${f}.tmp`, f)
}

// Un fait bien formé, tel qu'on l'écrit. Un fichier abîmé ou de forme inattendue se lit comme une liste vide, jamais
// un plantage ; seules les entrées bien formées sont reprises, dans les bornes (fichier retouché à la main).
const parOk = (p) => p === 'orkun' || (!!p && typeof p === 'object' && CONSOLE.test(p.console) && typeof p.nom === 'string')
const bienForme = (f) =>
  !!f && typeof f === 'object' && ID.test(f.id) && typeof f.texte === 'string' && !!f.texte && f.texte.length <= BORNES.texte && nettoie(f.texte) === f.texte &&
  (f.etat === 'valide' || f.etat === 'propose') && parOk(f.par) && Number.isFinite(f.at) && Number.isFinite(f.maj)
export function lire(DATA, projet) {
  const f = fichier(DATA, projet)
  let brut = []
  try {
    const st = fs.lstatSync(f) // fichier ordinaire et petit seulement : un lien ou un énorme fichier n'est pas lu
    if (st.isFile() && st.size < 1 << 20) brut = JSON.parse(fs.readFileSync(f, 'utf8'))?.faits
  } catch {} // pas de fichier, ou illisible : aucune mémoire pour ce projet
  const vus = new Set()
  const n = { valide: 0, propose: 0 }
  const max = { valide: BORNES.valides, propose: BORNES.proposes }
  const faits = (Array.isArray(brut) ? brut : [])
    .filter((x) => bienForme(x) && !vus.has(x.id) && vus.add(x.id) && ++n[x.etat] <= max[x.etat])
    .map(({ id, texte, etat, par, at, maj }) => ({ id, texte, etat, par: par === 'orkun' ? par : { console: par.console, nom: nettoie(par.nom).slice(0, 48) }, at, maj }))
  return { projet, faits }
}
function ecrire(DATA, projet, faits) {
  vraiDossier(dossier(DATA))
  ecritAtomique(fichier(DATA, projet), JSON.stringify({ projet, faits }, null, 2) + '\n')
}
function nouveau(faits, texte, etat, par) {
  let id
  do id = 'f' + crypto.randomBytes(3).toString('hex')
  while (faits.some((f) => f.id === id))
  const now = Date.now()
  return { id, texte, etat, par, at: now, maj: now }
}

// ── Écritures (chacune relit le fichier, change, réécrit) ──
// Orkun écrit un fait : validé d'office. Doublon : refusé.
export function ajoute(DATA, projet, texte) {
  const { faits } = lire(DATA, projet)
  const t = texteDe(texte)
  if (faits.some((f) => meme(f.texte, t))) throw refus('ce fait est déjà dans la mémoire du projet', 409)
  if (compte(faits, 'valide') >= BORNES.valides) throw refus(`${BORNES.valides} faits validés au plus par projet : supprimes-en un d’abord`, 409)
  const fait = nouveau(faits, t, 'valide', 'orkun')
  ecrire(DATA, projet, [...faits, fait])
  return fait
}
// Un agent propose : le fait attend la validation d'Orkun. Déjà connu : rien n'est ajouté, l'agent l'apprend
// ({ deja: 'valide' | 'propose' }). `par` : { console, nom } de la console qui propose. Bornes : 12 par projet, 4 par console.
export function propose(DATA, projet, texte, par) {
  const { faits } = lire(DATA, projet)
  const t = texteDe(texte)
  const deja = faits.find((f) => meme(f.texte, t))
  if (deja) return { deja: deja.etat }
  if (compte(faits, 'propose') >= BORNES.proposes) throw refus(`${BORNES.proposes} propositions au plus en attente pour ce projet : ${NOM} doit d’abord en valider ou en refuser`, 409)
  // Une console ne remplit pas à elle seule la file du projet (les autres consoles peuvent encore proposer).
  if (faits.filter((f) => f.etat === 'propose' && f.par?.console === par.console).length >= BORNES.parConsole)
    throw refus(`${BORNES.parConsole} propositions au plus en attente par console : attends ${queNom('’')} valide ou refuse les tiennes`, 409)
  const fait = nouveau(faits, t, 'propose', { console: par.console, nom: nettoie(par.nom).slice(0, 48) })
  ecrire(DATA, projet, [...faits, fait])
  return { fait }
}
// Orkun modifie un fait et/ou valide une proposition ({ texte?, valide?: true }). Le fait garde sa place dans la liste.
export function modifie(DATA, projet, id, corps) {
  const { texte, valide } = corps ?? {}
  const { faits } = lire(DATA, projet)
  const fait = faits.find((f) => f.id === id)
  if (!fait) throw refus('fait inconnu', 404)
  if (texte === undefined && valide !== true) throw refus('rien à changer (texte ou valide)')
  if (texte !== undefined) {
    const t = texteDe(texte)
    if (faits.some((f) => f !== fait && meme(f.texte, t))) throw refus('ce fait est déjà dans la mémoire du projet', 409)
    fait.texte = t
  }
  if (valide === true && fait.etat !== 'valide') {
    if (compte(faits, 'valide') >= BORNES.valides) throw refus(`${BORNES.valides} faits validés au plus par projet : supprimes-en un d’abord`, 409)
    fait.etat = 'valide'
  }
  fait.maj = Date.now()
  ecrire(DATA, projet, faits)
  return fait
}
// Supprimer un fait, ou refuser une proposition.
export function supprime(DATA, projet, id) {
  const { faits } = lire(DATA, projet)
  if (!faits.some((f) => f.id === id)) throw refus('fait inconnu', 404)
  ecrire(DATA, projet, faits.filter((f) => f.id !== id))
}

// ── Lectures ──
export const resume = (DATA, projet) => {
  const { faits } = lire(DATA, projet)
  return { projet, valides: compte(faits, 'valide'), proposes: compte(faits, 'propose') }
}
export const valides = (DATA, projet) => lire(DATA, projet).faits.filter((f) => f.etat === 'valide').map((f) => f.texte)
// Les projets qui ont un fichier, triés par nom.
export function projets(DATA) {
  try {
    return fs.readdirSync(dossier(DATA)).map((n) => /^(.+)\.json$/.exec(n)?.[1]).filter(cleValide).sort((a, b) => a.localeCompare(b))
  } catch {
    return [] // pas encore de dossier : aucune mémoire
  }
}

// ── Au lancement d'une console Claude / Codex hors équipe ──
// Sans fait validé, la console reçoit quand même les deux lignes de la proposition : sinon aucun agent n'apprend qu'il peut
// proposer, et la mémoire d'un projet neuf reste vide (Orkun le 13/11 : « M2 oui »).
export const texteLancement = (projet, faits, cli) =>
  [
    faits.length
      ? `Mémoire du projet « ${projet} » : faits validés par ${NOM}. Tiens-les pour vrais ; s'ils contredisent une demande ${deNom()} du moment, sa demande l'emporte.`
      : `Mémoire du projet « ${projet} » : aucun fait validé par ${NOM} pour l'instant.`,
    ...faits.map((f) => `- ${f}`),
    'Pour proposer un nouveau fait durable, utile à toute future console du projet (jamais un secret) :',
    `${cli} fait "<une phrase>" — ${NOM} le validera.`,
    // Le navigateur de la console (volet copies, 13/11) : une console seule doit savoir qu'il existe sans qu'on le lui épelle.
    `Navigateur sans écran de cette console (pages http://localhost:<port> seulement ; ${NOM} voit ce qu'il affiche) : ${cli} nav ouvre <url>, puis capture, clique <sélecteur CSS>, tape <sélecteur CSS> <texte>, texte, console, ferme ; un autre port pour la page : ${cli} nav permet <port> — détail : ${cli} nav aide.`,
  ].join('\n')
// DATA/memoire/lancement/<console>.md (le texte, pour Claude) et .toml (le texte en chaîne TOML, pour Codex : le JSON
// d'une chaîne sans caractère de contrôle brut est une chaîne TOML valide), 0600, réécrits à chaque lancement.
export function ecritLancement(DATA, consoleId, texte) {
  if (!CONSOLE.test(consoleId)) throw refus('console invalide', 500)
  const d = path.join(dossier(DATA), 'lancement')
  vraiDossier(dossier(DATA))
  vraiDossier(d)
  const md = path.join(d, `${consoleId}.md`)
  const toml = path.join(d, `${consoleId}.toml`)
  ecritAtomique(md, texte)
  ecritAtomique(toml, JSON.stringify(texte))
  return { md, toml }
}
// Ménage, jamais bloquant : la fermeture d'une console ne doit pas échouer sur un dossier de lancement abîmé.
export function oublieLancement(DATA, consoleId) {
  if (!CONSOLE.test(consoleId)) return
  for (const ext of ['md', 'toml']) {
    try {
      fs.rmSync(path.join(dossier(DATA), 'lancement', `${consoleId}.${ext}`), { force: true })
    } catch {} // dossier remplacé par un fichier, droits retirés : rien à retirer de lisible
  }
}
// Les bouts de ligne de commande. Claude : option cachée de Claude Code 2.1.322, lue au lancement. Codex : le texte part
// en `developer_instructions` (message « developer »), lu par `cat` entre guillemets : le shell ne l'interprète pas.
export const optionClaude = (md) => ` --append-system-prompt-file ${sur(md)}`
export const optionCodex = (toml) => ` -c "developer_instructions=$(cat ${sur(toml)})"`
