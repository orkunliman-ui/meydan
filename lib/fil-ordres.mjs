// Fil des ordres (volet « ordres », 13/11 ; contrat docs/specs/2026-11-13-ordres-contrat.md, §3) : chaque ordre donné à
// Meydan (tapé, dicté, planifié) et ses réponses (fait, réponse à une question, suivi de chaque « dis à »), gardés sur
// disque pour être relus après un redémarrage. Ce module ne connaît ni HTTP ni tmux : formes, bornes, fichier.
//
//   { id: 'm' + 10 hex, at, maj, r: 'ordre', texte, source: 'tape'|'voix'|'planificateur' }   (maj : dernière modification)
//   { id, at, r: 'reponse', de, genre: 'fait'|'question'|'agent'|'erreur', lignes: [≤ 12 × 400 car.], liens: [≤ 20 { id, nom }],
//     genre 'agent' : console, nom, etat, texteRemis, depuis, retenuDepuis?, remisA?, finA?, lancement? }
//
// Liste blanche : tout autre champ est écarté (à l'ajout, à la modification, à la relecture). `lancement` (consigne de
// lancement, qui n'expire pas) s'ajoute au contrat : lib/ordres-serveur.mjs s'en sert.
// Les messages rendus sont gelés : on les change par `modifie`, qui écrit et prévient (`quand`), jamais en place.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { nettoie } from './memoire.mjs'

// `typeof` d'abord : `RegExp.test` convertit en chaîne (`undefined` passerait REF, ['m…'] passerait ID).
const estId = (v) => typeof v === 'string' && /^m[0-9a-f]{10}$/.test(v)
const estRef = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v) // id de console dans un lien ou un suivi
const SOURCES = ['tape', 'voix', 'planificateur']
const GENRES = ['fait', 'question', 'agent', 'erreur']
const ETATS = ['attend', 'retenu', 'remis', 'repondu', 'expire', 'perdu', 'sans-reponse']
const B = { texte: 4000, lignes: 12, ligne: 400, liens: 20, nom: 120, remis: 24000, fichier: 64 << 20 } // fichier : au-dessus du pire cas (500 messages pleins)

// Texte montré : invisibles et contrôles retirés (leçon 168), borné en caractères (jamais une moitié de caractère).
const coupe = (s, n) => [...nettoie(s)].slice(0, n).join('')
const temps = (v) => Number.isFinite(v) && v >= 0
const lignesDe = (l) => (Array.isArray(l) ? l.filter((s) => typeof s === 'string').map((s) => coupe(s, B.ligne)).filter(Boolean).slice(0, B.lignes) : [])
const liensDe = (l) => (Array.isArray(l) ? l.filter((x) => x && typeof x === 'object' && estRef(x.id)).slice(0, B.liens).map((x) => ({ id: x.id, nom: coupe(typeof x.nom === 'string' ? x.nom : '', B.nom) })) : [])
const gele = (m) => {
  if (m.lignes) Object.freeze(m.lignes)
  if (m.liens) {
    for (const l of m.liens) Object.freeze(l)
    Object.freeze(m.liens)
  }
  return Object.freeze(m)
}

// Le message sous sa forme gardée, ou null s'il n'a pas la forme attendue.
function forme(m) {
  if (!m || typeof m !== 'object' || !estId(m.id) || !temps(m.at)) return null
  if (m.r === 'ordre') {
    if (typeof m.texte !== 'string') return null
    return gele({ id: m.id, at: m.at, maj: temps(m.maj) ? m.maj : m.at, r: 'ordre', texte: coupe(m.texte, B.texte), source: SOURCES.includes(m.source) ? m.source : 'tape' })
  }
  if (m.r !== 'reponse' || !estId(m.de) || !GENRES.includes(m.genre)) return null
  const x = { id: m.id, at: m.at, maj: temps(m.maj) ? m.maj : m.at, r: 'reponse', de: m.de, genre: m.genre, lignes: lignesDe(m.lignes), liens: liensDe(m.liens) }
  if (m.genre === 'agent') {
    if (!estRef(m.console) || !ETATS.includes(m.etat)) return null
    // Le texte remis reste exact (le serveur le retrouve tel quel dans la file de la console) ; il ne part pas à l'écran.
    Object.assign(x, { console: m.console, nom: coupe(typeof m.nom === 'string' ? m.nom : '', B.nom), etat: m.etat, texteRemis: typeof m.texteRemis === 'string' ? m.texteRemis.slice(0, B.remis) : '', depuis: temps(m.depuis) ? m.depuis : m.at })
    for (const k of ['retenuDepuis', 'remisA', 'finA']) if (temps(m[k])) x[k] = m[k]
    if (m.lancement === true) x.lancement = true
  }
  return gele(x)
}

export function ouvreFilOrdres(DATA, { max = 500, quand = () => {} } = {}) {
  const FICHIER = path.join(DATA, 'ordres-fil.json')
  const MAX = Math.max(1, Math.floor(max) || 500)
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })

  // Relecture tolérante : fichier absent, trop gros ou illisible = fil vide ; entrée de forme inattendue = écartée.
  function lit() {
    try {
      const st = fs.statSync(FICHIER)
      if (!st.isFile() || st.size > B.fichier) throw new Error(`fichier inattendu (${st.size} octets)`)
      const j = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
      const vus = new Set()
      return (Array.isArray(j?.messages) ? j.messages : []).map((m) => forme(m)).filter((m) => m && !vus.has(m.id) && vus.add(m.id)).slice(-MAX)
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[ordres] fil des ordres illisible, repris vide : ${e.message}`)
      return []
    }
  }
  let messages = lit()

  // Écriture atomique : un fichier temporaire (0600, nom unique) dans le même dossier, puis `rename`. Échec : le
  // temporaire est effacé, le fil reste en mémoire, l'erreur va au journal du serveur.
  function ecrit() {
    const tmp = path.join(DATA, `.ordres-fil.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(tmp, JSON.stringify({ messages }), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, FICHIER)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      console.error(`[ordres] fil des ordres non écrit : ${e.message}`)
    }
  }
  const signale = (m) => {
    try {
      quand(m)
    } catch (e) {
      console.error(`[ordres] diffusion du fil : ${e.message}`)
    }
  }
  const nouvelId = () => {
    for (;;) {
      const id = `m${crypto.randomBytes(5).toString('hex')}`
      if (!messages.some((m) => m.id === id)) return id
    }
  }

  return {
    liste: () => messages.slice(), // du plus ancien au plus récent
    trouve: (id) => messages.find((m) => m.id === id) ?? null,
    // `id` et `at` sont fabriqués ici. Forme invalide : TypeError (erreur de programme, rien n'est écrit).
    ajoute(msg) {
      const m = forme({ ...msg, id: nouvelId(), at: Date.now() })
      if (!m) throw new TypeError('fil des ordres : message de forme invalide')
      messages.push(m)
      if (messages.length > MAX) messages = messages.slice(-MAX) // les plus anciens partent
      ecrit()
      signale(m)
      return m
    },
    // `id`, `r`, `at` et `de` ne changent jamais ; le résultat repasse par la même forme. Id inconnu : null.
    modifie(id, patch = {}) {
      const i = messages.findIndex((m) => m.id === id)
      if (i < 0) return null
      const avant = messages[i]
      // `maj` croît à chaque modification : l'écran garde la version la plus récente d'un message, quel que soit l'ordre
      // d'arrivée (flux, relecture du fil, réponse d'une exécution).
      const m = forme({ ...avant, ...patch, id: avant.id, r: avant.r, at: avant.at, de: avant.de, maj: Math.max(Date.now(), avant.maj + 1) })
      if (!m) throw new TypeError('fil des ordres : modification de forme invalide')
      messages[i] = m
      ecrit()
      signale(m)
      return m
    },
  }
}
