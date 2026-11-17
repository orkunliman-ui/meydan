// Copies de travail d'une console (volet « copies », 13/11, rattrapage de Symvibe 1.1.0 : « New worktree » par agent).
// Orkun, 13/11 : « On est encore loin de toutes les fonctionnalitēs de Symvibe », puis « Go » ; décision du même jour :
// ni push ni PR, tout reste local.
//
// Une console Claude ou Codex peut naître dans une COPIE du dépôt de son dossier : un worktree git hors du dépôt, sous
// COPIES_DIR/<projet>/<nom-court>, sur une branche neuve `meydan/<nom-court>` partie de la tête de la branche courante.
// La copie peut recevoir des fichiers ignorés par git (`.env`…) choisis par Orkun, et une commande d'installation
// (`npm ci`…) que le serveur exécute avant de lancer l'agent.
//
// Contrat (server.mjs) : ouvreCopies({ DATA, COPIES_DIR, safeDir, send, broadcast, find, save, CHILD_ENV, lance })
//   api(req, res, url, parts)  GET /api/copies/proposition?dossier=<chemin>&motifs=<m1,m2>
//                                 → { git: true, depot, racine, branche, sousDossier, fichiers: [noms], ecartes, refus? }
//                                 | { git: false, raison }
//                              GET /api/copies/installation/<console> → { …c.copie.installation, lignes: [fin du journal] }
//   demande(corps, kind)       valide { motifs, fichiers, installation } (400 sinon) → { motifs, fichiers, argv }
//   cree({ dossier, nom, motifs, fichiers, argv }) → { cwdAgent, champ } : la copie, et le champ `c.copie` de la console
//   retire(champ)              la copie et sa branche, quand la console n'a pas pu être créée
//   affichage(c)               la commande du terminal de la console pendant l'installation (le journal qui défile)
//   installe(c)                lance l'installation de c.copie.installation ; à la fin, `lance(c)` lance l'agent
//   enInstallation(c)          vrai tant que l'installation de c tourne (reconcile() ne juge pas la console pendant ce temps)
//   noteRelais(champ)          les lignes ajoutées au relais de « Continuer dans une copie »
//
// Champ `c.copie` d'une console : { depot, dossier, branche, base, depuis, sousDossier?, fichiers: [noms copiés],
//   ecartes?: [{ nom, raison }], filtres?: [noms], installation?: { commande: [arguments], etat, debut, fin?, code?,
//   signal?, raison?, extrait? } } — `etat` : « en cours », « réussie », « échouée », « arrêtée », « interrompue ».
//
// Sûreté (leçons du 10/11, méthode de lib/git-panneau.mjs) :
//   - git par lib/equipage.mjs (hooks et fsmonitor coupés), sans shell, réglages imposés par l'environnement : pas de
//     descente dans les sous-modules, pas de maintenance, aucun transport (protocol.<p>.allow=never pour chaque
//     protocole : un `protocol.allow=never` seul cède devant le `protocol.ext.allow=always` d'un dépôt, prouvé ; et
//     GIT_NO_LAZY_FETCH) ; un dépôt partiel est refusé, avant toute lecture d'objet (rapatrier un objet manquant lance
//     l'adresse du dépôt promis, une commande pour ext::) ;
//   - le checkout d'une copie ne lit AUCUNE configuration du dépôt (relecture du 13/11 : entre la lecture de la
//     configuration et le checkout, un agent qui réécrit `.git/config` en boucle faisait lancer son filtre smudge, 10 fois
//     sur 30). `worktree add --no-checkout`, puis `read-tree -u --reset` par un git dont le dossier commun est un dossier
//     privé (config minimale, refs vides) : objets et index du dépôt, aucune configuration système, globale ni du dépôt.
//     Conséquence : les réglages `core.*` du dépôt (autocrlf, eol, sparseCheckout…) et ses filtres (LFS, git-crypt) ne
//     s'appliquent pas au checkout : les fichiers arrivent tels qu'ils sont dans le commit, et la copie le dit (`filtres`).
//     La configuration lue dans la copie ne sert plus qu'à ce constat et au refus d'un dépôt partiel ;
//   - fichiers ignorés : le serveur RECALCULE la liste à la création et ne copie que l'intersection avec la demande ;
//     fichiers ordinaires seulement (lstat, O_NOFOLLOW, puis le descripteur ouvert doit désigner le chemin attendu et
//     n'avoir qu'un nom : ni dossier intermédiaire changé en lien entre le contrôle et l'ouverture, ni lien dur vers un
//     fichier d'ailleurs), noms sans caractère de contrôle, invisible ni de direction, taille et nombre bornés, aucun lien
//     sur le chemin de la destination (un lien versionné dans la copie peut viser hors d'elle), destination créée en
//     0600 (O_EXCL) ;
//   - installation : liste d'arguments (aucun shell), environnement en liste blanche (celui des consoles), délai de
//     15 min, journal 0600 borné, groupe de processus tué par son numéro si la console part ; après un redémarrage de
//     Meydan, seulement si le démarrage de la machine et l'heure de départ du processus sont ceux notés au lancement.
//     Elle s'exécute avec les droits d'Orkun, scripts du dépôt compris (`npm ci` lance ceux des paquets), même pour une
//     console Codex dont l'agent est en bac à sable : le formulaire le dit.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { gitAvec, ligne, refus, remplitSansConfig, sur } from './equipage.mjs'

export const MOTIFS_DEFAUT = ['.env', '.env.*']
const MOTIFS_MAX = 8
const FICHIERS_MAX = 50 // fichiers proposés, et copiés, au plus
const FICHIER_MAX = 1 << 20 // octets d'un fichier copié
const TOTAL_MAX = 8 << 20 // octets copiés en tout
// Jamais parcourus ni proposés : dépendances, constructions, caches (une copie neuve les refait, `npm ci`…).
const LOURDS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache', 'vendor', 'target', '__pycache__', '.venv', 'venv', 'coverage'])
const INSTALL_MS = Number(process.env.MEYDAN_COPIES_INSTALL_MS) || 15 * 60 * 1000 // les essais raccourcissent le délai
const JOURNAL_MAX = 1 << 20 // octets de sortie écrits au fil de l'eau ; au-delà, la fin est gardée à part
const QUEUE_MAX = 64 << 10 // la fin de la sortie (là où est l'erreur), ajoutée au journal à la fin
const COMMANDE_MAX = 300
const ARGS_MAX = 32
const LIGNES_ROUTE = 80

// Réglages imposés à tout git de ce module (en plus des hooks et du fsmonitor coupés par equipage.git).
// Chaque protocole est fermé par son propre réglage : `protocol.<p>.allow` d'un dépôt l'emporte sur `protocol.allow`.
export const SURETE = [
  ['submodule.recurse', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['safe.bareRepository', 'explicit'],
  ['protocol.allow', 'never'],
  ...['ext', 'file', 'ssh', 'git', 'http', 'https'].map((p) => [`protocol.${p}.allow`, 'never']),
  ['core.quotePath', 'false'],
]
// Un nom de fichier qu'on n'affiche pas : contrôles (C0, C1), format (direction, jointures invisibles), privés, non
// attribués, demi-codets, séparateurs de ligne, sélecteurs de variante, remplissages invisibles (leçon du 11/11).
export const NOM_ILLISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u2028\u2029\uFE00-\uFE0F\u115F\u1160\u3164\uFFA0]|\uDB40[\uDD00-\uDDEF]/u
const ENV_GIT = { GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat' }
const g = (dir, args, o = {}) => gitAvec(dir, args, { ...o, neutres: [...SURETE, ...(o.neutres || [])], env: { ...ENV_GIT, ...(o.env || {}) } })
const lecture = (dir, args, o = {}) => g(dir, args, { ...o, env: { GIT_OPTIONAL_LOCKS: '0', ...(o.env || {}) } })

// ── Noms ──
// Slug ASCII minuscule : accents retirés, tout le reste devient « - », coupé à `max` sans tiret au bord.
export function slugAscii(s, max) {
  const base = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.slice(0, max).replace(/-+$/, '')
}
// `nom-court` d'une copie : slug du nom de la console (24 au plus) + « - » + 4 hexadécimaux. Jamais de la forme « e » +
// 6 hexadécimaux, l'espace de noms des équipes (meydan/<équipe>/…) : impossible avec le suffixe, vérifié quand même.
export function nomCourt(nom) {
  for (;;) {
    const court = `${slugAscii(nom, 24) || 'copie'}-${crypto.randomBytes(2).toString('hex')}`
    if (!/^e[0-9a-f]{6}$/.test(court)) return court
  }
}

// ── Motifs des fichiers ignorés proposés ──
// Un motif d'Orkun : `*` et `?` seulement, sans `/` en tête ni « .. ». Sans `/`, il porte sur le nom du fichier ;
// avec, sur son chemin dans le dépôt. Jamais passé à git, ni à RegExp sans échappement.
function motifRegle(m) {
  if (typeof m !== 'string') throw refus('motif : texte attendu')
  const t = m.trim()
  if (!t || t.length > 64) throw refus('motif : 1 à 64 caractères')
  if (!/^[A-Za-z0-9._*?\/+@=-]+$/.test(t)) throw refus(`motif refusé : ${ligne(t, 64)} (lettres, chiffres, . _ - + @ = / * ? seulement)`)
  if (t.startsWith('/') || t.split('/').includes('..')) throw refus(`motif refusé : ${ligne(t, 64)}`)
  const re = new RegExp(`^${t.replace(/[.+]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  return { texte: t, plein: t.includes('/'), re }
}
export function lisMotifs(v) {
  const liste = v === undefined || v === null ? MOTIFS_DEFAUT : Array.isArray(v) ? v : String(v).split(/[\s,]+/).filter(Boolean)
  if (liste.length > MOTIFS_MAX) throw refus(`${MOTIFS_MAX} motifs au plus`)
  return [...new Set(liste.map((m) => motifRegle(m).texte))]
}

// ── Commande d'installation ──
// Tapée par Orkun (`npm ci`, `pnpm install --frozen-lockfile`, `pip install -r "requirements dev.txt"`) : découpée en
// arguments aux espaces, guillemets simples ou doubles acceptés (sans échappement), caractères de contrôle refusés,
// longueur et nombre d'arguments bornés. Rien n'est interprété : `&&`, `|`, `$(…)` restent des arguments.
export function decoupe(texte) {
  if (typeof texte !== 'string') throw refus('installation : texte attendu')
  const t = texte.trim()
  if (!t) return null
  if (t.length > COMMANDE_MAX) throw refus(`installation : ${COMMANDE_MAX} caractères au plus`)
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) throw refus('installation : caractère de contrôle refusé')
  const args = []
  let cur = null
  let quote = ''
  for (const ch of t) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur ??= ''
    } else if (ch === ' ') {
      if (cur !== null) args.push(cur)
      cur = null
    } else cur = (cur ?? '') + ch
  }
  if (quote) throw refus('installation : guillemet non fermé')
  if (cur !== null) args.push(cur)
  if (!args.length || !args[0]) throw refus('installation : commande vide')
  if (args.length > ARGS_MAX) throw refus(`installation : ${ARGS_MAX} arguments au plus`)
  return args
}

// Texte d'un journal pour l'écran : séquences d'échappement (couleurs, titres, curseur) et caractères de contrôle
// retirés ; une ligne réécrite par « \r » (barres de progression) garde son dernier état.
// Une chaîne de commande (OSC, DCS, SOS, PM, APC) sans fin s'arrête au saut de ligne : elle n'avale plus la suite du
// journal (relecture du 13/11 : la ligne d'erreur disparaissait derrière un titre de fenêtre jamais fermé).
export function nettoie(texte) {
  return String(texte)
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c\n]*(?:\u0007|\u001b\\|\u009c)?/g, '')
    .replace(/(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[^\u001b\u009c\n]*(?:\u001b\\|\u009c)?/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .split('\n')
    .map((l) => l.split('\r').filter((x) => x !== '').at(-1) ?? '')
    .map((l) => l.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f-\u009f]/g, ''))
    .join('\n')
}

// Fichier ordinaire, sous `racine`, par un chemin sans lien symbolique : sinon la raison du refus.
function controleSource(racine, nom) {
  const plein = path.join(racine, nom)
  const parent = path.dirname(plein)
  let reel = ''
  try {
    reel = fs.realpathSync(parent)
  } catch {
    return { raison: 'introuvable' }
  }
  if (reel !== parent || (reel !== racine && !reel.startsWith(racine + path.sep))) return { raison: 'chemin qui passe par un lien symbolique' }
  const st = fs.lstatSync(plein, { throwIfNoEntry: false })
  if (!st) return { raison: 'introuvable' }
  if (st.isSymbolicLink()) return { raison: 'lien symbolique' }
  if (!st.isFile()) return { raison: 'pas un fichier ordinaire' }
  if (st.nlink !== 1) return { raison: 'lien dur (le même fichier a un autre nom, peut-être hors du dépôt)' }
  if (st.size > FICHIER_MAX) return { raison: 'plus de 1 Mo' }
  return { plein, taille: st.size }
}

export function ouvreCopies({ DATA, COPIES_DIR, safeDir, send, broadcast, find, save, CHILD_ENV, lance }) {
  const JOURNAUX = path.join(DATA, 'copies')
  fs.mkdirSync(JOURNAUX, { recursive: true, mode: 0o700 })
  // Le dossier des copies, créé à la première copie seulement (rien de neuf dans ~ tant que la fonction ne sert pas) :
  // copiesReel() le crée (cree), ouEstCopies() ne fait que le situer (proposition : une simple lecture ne crée rien).
  let reelCopies = ''
  const copiesReel = () => {
    if (!reelCopies) {
      fs.mkdirSync(COPIES_DIR, { recursive: true, mode: 0o700 })
      reelCopies = fs.realpathSync(COPIES_DIR)
    }
    return reelCopies
  }
  const ouEstCopies = () => {
    if (reelCopies) return reelCopies
    try {
      return fs.realpathSync(COPIES_DIR)
    } catch {
      return path.resolve(COPIES_DIR) // pas encore créé
    }
  }
  const journal = (id) => path.join(JOURNAUX, `${id}.log`)
  const enCours = new Map() // console → { arrete(raison) } : les installations que CE processus tient (et leur lancement)
  const reprises = new Set() // consoles dont l'installation a été coupée par un redémarrage, déjà traitées

  // La configuration effective (fichiers inclus, lue dans `dir`) : les filtres déclarés, à vider, et le refus d'un dépôt
  // partiel. Lire la configuration ne lance rien.
  async function lireConfig(dir) {
    const filtres = new Set()
    let partiel = false
    for (const e of (await lecture(dir, ['config', '-z', '--list'], { brut: true })).split('\0')) {
      const cle = e.split('\n', 1)[0]
      const m = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(cle)
      if (m) filtres.add(m[1])
      if (cle === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(cle)) partiel = true
    }
    const neutres = [...filtres].flatMap((n) => [[`filter.${n}.clean`, ''], [`filter.${n}.smudge`, ''], [`filter.${n}.process`, ''], [`filter.${n}.required`, 'false']])
    return { filtres, partiel, neutres }
  }

  // Le dépôt d'un dossier (déjà passé par safeDir) : sa racine, le dépôt principal (pour une copie de copie, celui
  // d'origine), la branche, la tête, le sous-dossier. `refus` : un dépôt git dont on ne fait pas de copie (et pourquoi).
  async function lire(dossier) {
    const top = await lecture(dossier, ['rev-parse', '--show-toplevel']).catch(() => '')
    if (!top) return { git: false, raison: 'ce dossier n’est pas dans un dépôt git' }
    const prefixe = (await lecture(dossier, ['rev-parse', '--show-prefix']).catch(() => '')).replace(/\/$/, '')
    const gitDir = await lecture(dossier, ['rev-parse', '--path-format=absolute', '--git-dir']).catch(() => '')
    const commun = await lecture(dossier, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
    const branche = await lecture(top, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')
    const base = { git: true, racine: top, depot: '', branche, sousDossier: prefixe, head: '' }
    if (path.basename(commun) !== '.git') return { ...base, refus: 'dépôt nu ou à la structure inhabituelle : pas de copie' }
    const depot = path.dirname(commun)
    // Dépôt principal : sa racine est celle du dossier .git (un core.worktree qui l'envoie ailleurs est refusé).
    if (gitDir === commun && depot !== top) return { ...base, refus: 'racine du dépôt déplacée par sa configuration (core.worktree) : pas de copie' }
    try {
      if (safeDir(depot) !== depot) throw new Error('lien')
    } catch {
      return { ...base, refus: 'dépôt hors du dossier personnel : pas de copie' }
    }
    const ici = ouEstCopies()
    if (ici === depot || ici.startsWith(depot + path.sep)) return { ...base, depot, refus: 'le dossier des copies est dans ce dépôt : pas de copie' }
    // Dépôt partiel refusé AVANT de lire un objet (la tête elle-même peut manquer et se rapatrier).
    const cfg = await lireConfig(top)
    if (cfg.partiel) return { ...base, depot, refus: 'dépôt partiel (objets à rapatrier d’un autre dépôt) : pas de copie' }
    const head = await lecture(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')
    if (!head) return { ...base, depot, refus: 'dépôt sans commit : rien à copier' }
    return { ...base, depot, head }
  }

  // Les fichiers ignorés par git du dépôt qui répondent aux motifs (noms relatifs à sa racine). Les dossiers lourds
  // (node_modules…) sont écartés par git lui-même (pathspecs d'exclusion : ni parcourus ni listés, 24 ms mesurées sur
  // 30 000 fichiers), puis encore ici. Pas de `--directory` : il replie un dossier non suivi qui ne contient que des
  // fichiers ignorés (`config/.env` devenait `config/`, jamais proposé).
  async function ignores(top, motifs) {
    const regles = motifs.map(motifRegle)
    let brut = ''
    try {
      // Les motifs pré-filtrent côté git (40 ms au lieu de 220 sur ~/meydan, mesuré le 13/11) : ils ne contiennent que
      // [A-Za-z0-9._*?/+@=-] (motifRegle), ni « : » ni « [ » — aucune magie de pathspec possible. Le filtre JS reste.
      const inclus = regles.map((r) => (r.plein ? `:(glob)${r.texte}` : `:(glob)**/${r.texte}`))
      brut = await lecture(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...inclus, ...[...LOURDS].map((n) => `:(exclude,glob)**/${n}/**`)], { brut: true })
    } catch {
      return { fichiers: [], ecartes: [{ nom: '(liste)', raison: 'trop de fichiers ignorés pour les lister' }] }
    }
    const fichiers = []
    const ecartes = []
    let trop = 0
    for (const nom of brut.split('\0')) {
      if (!nom || nom.endsWith('/') || NOM_ILLISIBLE.test(nom)) continue
      const morceaux = nom.split('/')
      if (morceaux.some((m) => LOURDS.has(m))) continue
      if (!regles.some((r) => r.re.test(r.plein ? nom : morceaux.at(-1)))) continue
      // Au-delà de la borne, on compte sans rien lire sur le disque (un motif « * » sur des milliers de fichiers).
      if (fichiers.length >= FICHIERS_MAX) {
        trop++
        continue
      }
      const s = controleSource(top, nom)
      if (!s.raison) fichiers.push(nom)
      else if (ecartes.length < FICHIERS_MAX) ecartes.push({ nom, raison: s.raison })
    }
    if (trop) ecartes.push({ nom: `(${trop} autre${trop > 1 ? 's' : ''})`, raison: `plus de ${FICHIERS_MAX} fichiers` })
    fichiers.sort((a, b) => a.localeCompare(b))
    return { fichiers, ecartes }
  }

  async function proposition(dossier, motifs) {
    const d = await lire(dossier)
    if (!d.git) return d
    const vue = { git: true, depot: d.depot, racine: d.racine, branche: d.branche, sousDossier: d.sousDossier }
    if (d.refus) return { ...vue, refus: d.refus, fichiers: [], ecartes: [] }
    return { ...vue, ...(await ignores(d.racine, motifs)) }
  }

  // Le corps d'une demande de copie : { motifs, fichiers: [noms], installation: "npm ci" }.
  function demande(corps, kind) {
    if (kind !== 'claude' && kind !== 'codex') throw refus('une copie se fait pour une console Claude ou Codex')
    if (!corps || typeof corps !== 'object' || Array.isArray(corps)) throw refus('copie : objet attendu')
    const motifs = lisMotifs(corps.motifs)
    const f = corps.fichiers ?? []
    if (!Array.isArray(f) || f.length > FICHIERS_MAX) throw refus(`copie : ${FICHIERS_MAX} fichiers au plus`)
    if (!f.every((x) => typeof x === 'string' && x.length <= 4096)) throw refus('copie : noms de fichiers attendus')
    const argv = corps.installation ? decoupe(corps.installation) : null
    return { motifs, fichiers: [...new Set(f)], argv }
  }

  // Copie des fichiers demandés ET proposés (liste recalculée ici). Destination : chaque dossier du chemin est un vrai
  // dossier de la copie (créé un par un s'il manque, jamais à travers un lien), le fichier est créé (O_EXCL, O_NOFOLLOW)
  // en 0600.
  async function copieFichiers(top, dossier, motifs, demandes) {
    const { fichiers: proposes } = await ignores(top, motifs)
    const permis = new Set(proposes)
    const copies = []
    const ecartes = []
    let total = 0
    for (const nom of demandes) {
      if (!permis.has(nom) || path.isAbsolute(nom) || nom.split('/').some((m) => m === '..' || m === '.' || m === '')) {
        ecartes.push({ nom: ligne(nom, 200), raison: 'hors de la liste proposée' })
        continue
      }
      const s = controleSource(top, nom)
      if (s.raison) {
        ecartes.push({ nom, raison: s.raison })
        continue
      }
      let contenu = null
      const fd = fs.openSync(s.plein, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try {
        const st = fs.fstatSync(fd)
        // Le fichier ouvert est bien celui du chemin contrôlé (un dossier du chemin changé en lien entre le contrôle et
        // l'ouverture mène ailleurs : le noyau le dit), et n'a qu'un nom (un lien dur peut venir de hors du dépôt).
        let vrai = ''
        try {
          vrai = fs.readlinkSync(`/proc/self/fd/${fd}`)
        } catch {}
        if (vrai !== s.plein || st.nlink !== 1) {
          ecartes.push({ nom, raison: vrai !== s.plein ? 'chemin changé pendant la copie (lien symbolique)' : 'lien dur (le même fichier a un autre nom, peut-être hors du dépôt)' })
          continue
        }
        if (st.isFile() && st.size <= FICHIER_MAX) {
          const buf = Buffer.alloc(st.size)
          let lu = 0
          for (let n = 1; lu < st.size && n; lu += n) n = fs.readSync(fd, buf, lu, st.size - lu, lu)
          contenu = buf.subarray(0, lu)
        }
      } finally {
        fs.closeSync(fd)
      }
      if (!contenu) {
        ecartes.push({ nom, raison: 'pas un fichier ordinaire de 1 Mo au plus' })
        continue
      }
      if (total + contenu.length > TOTAL_MAX) {
        ecartes.push({ nom, raison: 'plus de 8 Mo copiés en tout' })
        continue
      }
      const morceaux = nom.split('/')
      let d = dossier
      let refuse = ''
      for (const m of morceaux.slice(0, -1)) {
        d = path.join(d, m)
        const st = fs.lstatSync(d, { throwIfNoEntry: false })
        if (!st) fs.mkdirSync(d, { mode: 0o700 })
        else if (st.isSymbolicLink()) refuse = 'la copie a un lien symbolique sur son chemin'
        else if (!st.isDirectory()) refuse = 'la copie a un fichier à la place d’un dossier du chemin'
        if (refuse) break
      }
      if (!refuse && fs.realpathSync(d) !== d) refuse = 'la copie a un lien symbolique sur son chemin'
      if (refuse) {
        ecartes.push({ nom, raison: refuse })
        continue
      }
      let out
      try {
        out = fs.openSync(path.join(d, morceaux.at(-1)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      } catch (e) {
        ecartes.push({ nom, raison: e.code === 'EEXIST' ? 'existe déjà dans la copie (fichier suivi ou lien)' : 'écriture impossible' })
        continue
      }
      try {
        fs.fchmodSync(out, 0o600)
        fs.writeSync(out, contenu)
      } finally {
        fs.closeSync(out)
      }
      total += contenu.length
      copies.push(nom)
    }
    return { copies, ecartes }
  }

  // Le checkout d'une copie par un git qui ne lit AUCUNE configuration (ni système, ni globale, ni celle du dépôt, que
  // son dossier commun porte) : le dossier commun est remplacé par un dossier privé (config minimale, refs vides) ; les
  // objets (et leurs « alternates ») et l'index de la copie restent ceux du dépôt. Un filtre déclaré n'a donc aucun pilote :
  // rien ne s'exécute, quoi que la configuration du dépôt dise à cet instant. Puis contrôle : l'index est le commit,
  // les fichiers de la copie sont l'index.
  // (17/11 : le corps vit dans lib/equipage.mjs, remplitSansConfig, partagé avec les worktrees des équipes.)
  const remplit = (dest, head, commun, format) => remplitSansConfig(dest, head, commun, format, JOURNAUX)

  // La copie : worktree sans checkout, puis checkout sans configuration (remplit) ; la configuration de la copie n'est lue
  // que pour refuser un dépôt partiel et dire quels filtres n'ont pas été appliqués ; puis les fichiers demandés. `nom` :
  // le nom de la console (il donne le nom-court). Tout échec retire ce qui a été créé.
  async function cree({ dossier, nom, motifs = MOTIFS_DEFAUT, fichiers = [], argv = null }) {
    const d = await lire(dossier)
    if (!d.git) throw refus(d.raison, 409)
    if (d.refus) throw refus(d.refus, 409)
    const parent = path.join(copiesReel(), slugAscii(path.basename(d.depot), 40) || 'projet')
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (fs.realpathSync(parent) !== parent) throw refus('dossier des copies inattendu (lien symbolique) : copie refusée', 409)
    let court = ''
    for (let i = 0; i < 8 && !court; i++) {
      const essai = nomCourt(nom)
      if (fs.lstatSync(path.join(parent, essai), { throwIfNoEntry: false })) continue
      await lecture(d.racine, ['check-ref-format', '--branch', `meydan/${essai}`]) // lève si ce n'est pas un nom de branche valide
      const prise = await lecture(d.racine, ['show-ref', '--verify', '--quiet', `refs/heads/meydan/${essai}`]).then(() => true, () => false)
      if (!prise) court = essai
    }
    if (!court) throw refus('aucun nom de copie libre (réessaie)', 409)
    const dest = path.join(parent, court)
    const branche = `meydan/${court}`
    const champ = { depot: d.depot, dossier: dest, branche, base: d.head, depuis: d.branche, ...(d.sousDossier ? { sousDossier: d.sousDossier } : {}), fichiers: [] }
    const format = await lecture(d.racine, ['rev-parse', '--show-object-format']).catch(() => 'sha1')
    await g(d.racine, ['worktree', 'add', '-q', '--no-checkout', '-b', branche, dest, d.head])
    try {
      const cfg = await lireConfig(dest) // dans le contexte de la copie (includeIf onbranch / gitdir compris) : constat seulement
      if (cfg.partiel) throw refus('dépôt partiel : pas de copie', 409)
      await remplit(dest, d.head, path.join(d.depot, '.git'), format)
      // Fichiers suivis qu'un filtre déclaré aurait transformés : arrivés bruts (pointeurs LFS, fichiers chiffrés).
      const filtres = []
      for (const f of cfg.filtres) {
        if (!/^[A-Za-z0-9._-]+$/.test(f)) {
          filtres.push(ligne(f, 40))
          continue
        }
        const touches = await lecture(dest, ['ls-files', '-z', '--', `:(attr:filter=${f})`], { brut: true, neutres: cfg.neutres }).catch(() => 'x')
        if (touches) filtres.push(f)
      }
      if (filtres.length) champ.filtres = filtres
      // Le dossier de l'agent : le sous-dossier correspondant, s'il existe dans la copie (versionné) et sans lien.
      let cwdAgent = dest
      if (d.sousDossier) {
        const sous = path.join(dest, d.sousDossier)
        let reel = ''
        try {
          reel = fs.realpathSync(sous)
        } catch {} // pas versionné : l'agent part de la racine de la copie
        if (reel === sous && fs.statSync(sous).isDirectory()) cwdAgent = sous
        else delete champ.sousDossier
      }
      const { copies, ecartes } = await copieFichiers(d.racine, dest, motifs, fichiers)
      champ.fichiers = copies
      if (ecartes.length) champ.ecartes = ecartes
      if (argv) champ.installation = { commande: argv, etat: 'en cours', debut: Date.now() }
      return { cwdAgent, champ }
    } catch (e) {
      await retire(champ)
      throw e
    }
  }

  // Retire une copie créée à l'instant (sans travail) et sa branche. Rien d'autre : une copie qui a vécu se retire par le
  // panneau Git, après contrôle.
  async function retire(champ) {
    if (!champ?.dossier || !champ.dossier.startsWith(copiesReel() + path.sep)) return
    await g(champ.depot, ['worktree', 'remove', '--force', champ.dossier]).catch(() => fs.rmSync(champ.dossier, { recursive: true, force: true }))
    await g(champ.depot, ['worktree', 'prune']).catch(() => {})
    await g(champ.depot, ['branch', '-D', champ.branche]).catch(() => {})
  }

  // ── Installation ──
  // Le terminal de la console montre le journal pendant l'installation ; Ctrl-C n'y arrête rien (c'est le serveur qui
  // tient l'installation ; fermer la console l'arrête). Le journal (0600, jamais à travers un lien) est créé ici, avec
  // son en-tête, avant que le terminal le lise.
  function affichage(c) {
    const f = journal(c.id)
    const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeSync(fd, `$ ${c.copie.installation.commande.join(' ')}\n(dans ${c.cwd})\n\n`)
    } finally {
      fs.closeSync(fd)
    }
    return `trap '' INT; exec tail -n +1 -F -- ${sur(f)}`
  }

  function tue(pid, signal) {
    try {
      process.kill(-pid, signal) // le groupe : `npm ci` a ses propres enfants
    } catch {} // déjà parti
  }
  // L'identité d'un processus au-delà de son numéro (qui se réutilise) : le démarrage de la machine (boot_id) et l'heure
  // de départ du processus (champ 22 de /proc/<pid>/stat, après le nom entre parenthèses, qui peut contenir de tout).
  const demarrageMachine = () => {
    try {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    } catch {
      return ''
    }
  }
  const departDe = (pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
    } catch {
      return '' // déjà parti
    }
  }

  function installe(c) {
    const inst = c.copie?.installation
    if (!inst || inst.etat !== 'en cours' || enCours.has(c.id)) return
    const argv = inst.commande
    // À la suite de l'en-tête écrit par affichage(c).
    const out = fs.openSync(journal(c.id), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
    fs.fchmodSync(out, 0o600)
    let ecrits = 0
    let queue = Buffer.alloc(0)
    let coupe = false
    let raisonArret = ''
    let fini = false
    // Environnement des consoles (liste blanche), rien de plus : aucune variable du serveur ne fuit. Groupe à part
    // (detached) : il se tue d'un coup, enfants compris.
    const enfant = spawn(argv[0], argv.slice(1), { cwd: c.cwd, env: { ...CHILD_ENV }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const recoit = (b) => {
      if (fini) return
      if (ecrits < JOURNAL_MAX) {
        const part = b.subarray(0, JOURNAL_MAX - ecrits)
        fs.writeSync(out, part)
        ecrits += part.length
        if (part.length === b.length) return
        b = b.subarray(part.length)
      }
      coupe = true
      queue = Buffer.concat([queue, b]).subarray(-QUEUE_MAX) // lu jusqu'au bout : un tube plein bloquerait l'installation
    }
    enfant.stdout.on('data', recoit)
    enfant.stderr.on('data', recoit)
    // Son numéro, gardé dans l'état : si Meydan redémarre pendant l'installation, le groupe resté orphelin est arrêté
    // (enInstallation) au lieu de tourner à côté de l'agent.
    if (enfant.pid) {
      Object.assign(inst, { pid: enfant.pid, machine: demarrageMachine(), depart: departDe(enfant.pid) })
      save()
    }
    const arrete = (raison) => {
      if (raisonArret || fini) return
      raisonArret = raison
      if (enfant.pid) {
        tue(enfant.pid, 'SIGTERM')
        setTimeout(() => tue(enfant.pid, 'SIGKILL'), 3000).unref()
      }
    }
    const delai = setTimeout(() => arrete(`délai de ${INSTALL_MS >= 60000 ? `${Math.round(INSTALL_MS / 60000)} min` : `${Math.round(INSTALL_MS / 1000)} s`} dépassé`), INSTALL_MS)
    // La console fermée (ou retirée) pendant l'installation : l'installation s'arrête avec elle.
    const veille = setInterval(() => {
      const x = find(c.id)
      if (!x || x.status === 'closed') arrete('console fermée pendant l’installation')
    }, 1000)
    enCours.set(c.id, { arrete })
    const termine = (code, signal, erreur) => {
      if (fini) return
      fini = true
      clearTimeout(delai)
      clearInterval(veille)
      delete inst.pid
      delete inst.machine
      delete inst.depart
      if (coupe) fs.writeSync(out, Buffer.concat([Buffer.from('\n[… sortie coupée : seules la tête et la fin sont gardées …]\n'), queue]))
      const fermee = raisonArret.startsWith('console fermée')
      Object.assign(inst, {
        etat: fermee ? 'arrêtée' : !erreur && !raisonArret && code === 0 ? 'réussie' : 'échouée',
        fin: Date.now(),
        ...(Number.isInteger(code) ? { code } : {}),
        ...(signal ? { signal } : {}),
        ...(erreur || raisonArret ? { raison: erreur || raisonArret } : {}),
      })
      fs.writeSync(out, `\n[Meydan] installation ${inst.etat}${inst.code !== undefined ? ` (code ${inst.code})` : ''}${inst.signal ? ` (${inst.signal})` : ''}${inst.raison ? ` : ${inst.raison}` : ''}${fermee ? '' : ' — l’agent démarre.'}\n`)
      fs.closeSync(out)
      if (inst.etat !== 'réussie') inst.extrait = extrait(c)
      if (find(c.id) !== c || fermee || c.status === 'closed') {
        enCours.delete(c.id)
        if (find(c.id) === c) (save(), broadcast({ type: 'console', console: c }))
        return
      }
      save()
      broadcast({ type: 'console', console: c })
      // L'agent est lancé après l'installation, réussie ou non : la copie existe, l'agent (ou Orkun) peut reprendre une
      // installation ratée, et l'échec reste dit sur la dalle et la ligne (repère de la copie). La console reste à l'abri
      // de reconcile() jusqu'à ce que le lancement l'ait remise « démarre » à l'heure du lancement.
      Promise.resolve()
        .then(() => lance(c))
        .catch((e) => console.error(`[copies] ${c.name} : agent non lancé après l’installation : ${e.message}`))
        .finally(() => enCours.delete(c.id))
    }
    enfant.on('error', (e) => termine(null, null, e.code === 'ENOENT' ? `commande introuvable : ${ligne(argv[0], 80)}` : ligne(e.message, 200)))
    enfant.on('close', (code, signal) => termine(code, signal, ''))
  }

  // Vrai pendant l'installation de cette console (dans ce processus). Une installation marquée « en cours » qu'aucun
  // processus ne tient (Meydan a redémarré pendant qu'elle tournait) devient « interrompue », et l'agent est lancé si
  // le terminal montre encore le journal (server.mjs, demarreAgent).
  function enInstallation(c) {
    if (enCours.has(c.id)) return true
    const inst = c.copie?.installation
    if (inst?.etat !== 'en cours' || reprises.has(c.id)) return false
    reprises.add(c.id)
    // Le groupe de l'installation a pu survivre au serveur (arrêt du seul processus de Meydan) : arrêté s'il tourne encore,
    // et seulement si c'est bien lui : même démarrage de la machine, même heure de départ du processus, même dossier (un
    // numéro réutilisé par un autre programme n'est pas touché).
    if (Number.isInteger(inst.pid) && inst.pid > 1 && inst.machine && inst.depart) {
      let dossier = ''
      try {
        dossier = fs.readlinkSync(`/proc/${inst.pid}/cwd`)
      } catch {} // déjà parti
      if (inst.machine === demarrageMachine() && inst.depart === departDe(inst.pid) && dossier === c.cwd) tue(inst.pid, 'SIGKILL')
    }
    delete inst.pid
    delete inst.machine
    delete inst.depart
    Object.assign(inst, { etat: 'interrompue', fin: Date.now(), raison: 'Meydan a redémarré pendant l’installation' })
    save()
    broadcast({ type: 'console', console: c })
    Promise.resolve()
      .then(() => lance(c, { apresRedemarrage: true }))
      .catch((e) => console.error(`[copies] ${c.name} : ${e.message}`))
    return true
  }

  // Les dernières lignes du journal d'une console, nettoyées (lecture bornée, sans suivre de lien).
  function finJournal(id, n = LIGNES_ROUTE) {
    let fd
    try {
      fd = fs.openSync(journal(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    } catch {
      return []
    }
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile()) return []
      const taille = Math.min(st.size, 64 << 10)
      const buf = Buffer.alloc(taille)
      const lu = fs.readSync(fd, buf, 0, taille, st.size - taille)
      const lignes = nettoie(buf.subarray(0, lu).toString('utf8')).split('\n')
      if (st.size > taille) lignes.shift() // la première est sans doute coupée
      while (lignes.length && !lignes.at(-1).trim()) lignes.pop()
      return lignes.slice(-n).map((l) => l.slice(0, 400))
    } finally {
      fs.closeSync(fd)
    }
  }
  // Les deux dernières lignes de la SORTIE (sans l'en-tête ni la ligne de fin écrits par Meydan), pour dire un échec sur
  // la dalle et dans la ligne de la liste.
  function extrait(c) {
    const entete = new Set([`$ ${c.copie.installation.commande.join(' ')}`, `(dans ${c.cwd})`].map((l) => nettoie(l)))
    return ligne(finJournal(c.id, 12).filter((l) => l.trim() && !l.startsWith('[Meydan]') && !entete.has(l)).slice(-2).join(' · '), 300)
  }

  // Une console ouverte dans une copie qui existe déjà (Dupliquer, Passer le relais, un ordre…) en garde le repère : même
  // groupe et même mémoire de projet (rangement.js), même « copie · <branche> ». Sans l'installation, qui ne se refait pas.
  function herite(dir, consoles) {
    for (const x of consoles) {
      const k = x.copie
      if (!k?.dossier || (dir !== k.dossier && !dir.startsWith(k.dossier + path.sep))) continue
      const { installation, sousDossier, ...reste } = k
      const sous = path.relative(k.dossier, dir)
      return { ...reste, ...(sous ? { sousDossier: sous } : {}) }
    }
    return null
  }

  function noteRelais(champ) {
    return [
      `Tu travailles maintenant dans une COPIE de ce dépôt (git worktree) : ${champ.dossier}${champ.sousDossier ? ` (ton dossier : ${path.join(champ.dossier, champ.sousDossier)})` : ''}, sur la branche ${champ.branche}, partie du commit ${champ.base.slice(0, 7)}${champ.depuis ? ` de ${champ.depuis}` : ''}.`,
      `Les changements NON commités du dossier d'origine (${champ.depot}) ne sont pas dans la copie : ils y sont restés. Travaille et commite dans la copie, jamais dans le dossier d'origine.`,
    ].join('\n')
  }

  // La console part (fermeSeule) : son installation s'arrête tout de suite (sans attendre la prochaine relecture) et son
  // journal est effacé (DATA/copies/<id>.log ne garderait sinon que des sorties d'installations de consoles disparues).
  function oublie(id) {
    enCours.get(id)?.arrete('console fermée pendant l’installation')
    fs.rm(journal(id), { force: true }, () => {})
  }

  return {
    demande,
    cree,
    oublie,
    retire,
    affichage,
    installe,
    enInstallation,
    noteRelais,
    herite,
    async api(req, res, url, parts) {
      if (req.method !== 'GET') return send(res, 405, { error: 'méthode refusée' })
      if (parts.length === 3 && parts[2] === 'proposition') {
        let dossier
        try {
          dossier = safeDir(url.searchParams.get('dossier') || '')
        } catch (e) {
          // Un dossier qui n'existe plus (console posée dans un dossier effacé depuis) n'est pas une demande fautive : pas de
          // copie possible, dit en 200. Sinon la liste, qui prépare cette réponse pour chaque console (Copies.jsx), ferait
          // écrire une erreur réseau à la page à chaque chargement. Un dossier hors de ~ ou absent de la demande : 400.
          if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return send(res, 200, { git: false, raison: 'dossier introuvable' })
          return send(res, 400, { error: e.message })
        }
        const motifs = lisMotifs(url.searchParams.has('motifs') ? url.searchParams.get('motifs') : undefined)
        return send(res, 200, await proposition(dossier, motifs))
      }
      if (parts.length === 4 && parts[2] === 'installation') {
        const c = find(parts[3])
        const inst = c?.copie?.installation
        if (!inst) return send(res, 404, { error: 'aucune installation pour cette console' })
        return send(res, 200, { ...inst, lignes: finJournal(c.id) })
      }
      return send(res, 404, { error: 'route inconnue' })
    },
  }
}
