// Espaces de travail du plateau, gardés sur le serveur. Décision d'Orkun du 17/11, plateau-pc-2 (« Espaces de travail :
// appareil ou serveur ») : « Sur le serveur (partagés) » (docs/volets/plateau-pc.md:158). Les mêmes espaces sur tous ses
// navigateurs (Mac, PC) ; au premier chargement de la nouvelle interface, chaque appareil verse ce qu'il gardait dans
// `localStorage['meydan.espaces']` (web/src/Espaces.jsx), sans rien perdre.
//
// Un espace : { id, nom, places: { <console>: { x, y, w, h } }, vue: { x, y, zoom }, t } (forme de l'appareil, gardée).
//
// Contrat des routes (branchées dans `api()` de server.mjs : porte de session et `originOk` comme toute l'API). Toujours
// UN espace par demande, jamais la liste entière : nginx borne les corps à 64 Ko (absent du banc).
//   GET    /api/espaces           → 200 { espaces }
//   POST   /api/espaces           { id?, nom, places, vue, t? } → 201 { espace } créé ;
//                                  200 { espace, deja: true } si cet id existe déjà (rien ne change : un versement refait
//                                  ne double rien et ne remplace rien) ; 410 { supprime: true } si cet id a été supprimé
//                                  (sur cet écran ou un autre) : il ne revient pas ; 409 au-delà de BORNES.espaces.
//   PATCH  /api/espaces/<id>      { nom } → 200 { espace } (renommer)
//   PUT    /api/espaces/<id>      { places, vue } → 200 { espace } (remplacer par la disposition actuelle ; t = maintenant)
//   DELETE /api/espaces/<id>      → 200 { ok: true }, l'id est gardé parmi les supprimés ; id inconnu : 200 { deja: true },
//                                  rien d'écrit (seul un espace qui a existé laisse une trace).
//   PATCH / PUT d'un id inconnu : 404 ; d'un id supprimé : 410.
//   Refus 400 : id mal formé, nom vide (ou sans caractère visible) ou de plus de 40 caractères (points de code, après
//   nettoyage), plus de BORNES.places places, clé de
//   place qui n'est pas un identifiant de console, nombre non fini ou hors bornes (celles du PATCH des consoles :
//   x / y ±50 000, w 320…2 400, h 200…1 600 ; vue : x / y ±1 000 000 — une translation d'écran, zoom compris —, zoom
//   0,05…4 ; le plateau va de 0,15 à 3). Aucun nombre n'est rogné en silence ; les places sont arrondies au point.
//
// Supprimé sur un écran, jamais ressuscité par un autre : le serveur garde les BORNES.supprimes derniers ids d'espaces
// qu'il a eus puis supprimés. Un appareil qui n'a pas encore versé un espace est le seul à le connaître : aucun autre
// écran ne peut le supprimer ; il arrive au serveur au prochain chargement de cet appareil.
//
// Fichier : DATA/espaces.json (0600), écrit par fichier temporaire puis renommage (lib/fichier-etat.mjs) ; la liste
// d'APRÈS est écrite avant d'être posée en mémoire (disque plein : mémoire et fichier restent d'accord ; échec = 500 à la
// phrase simple, détail au journal). Absent = aucun espace ; illisible, lien, FIFO, dossier, trop gros ou de forme
// inattendue = mis de côté sous un autre nom AVANT toute écriture (départ sans espace) ; une entrée écartée = l'original
// copié à côté, la liste nettoyée réécrite aussitôt, les entrées lisibles restent ; toujours dit au journal avec la
// cause (leçon 248 : un fichier illisible n'est pas un fichier vide).
import path from 'node:path'
import crypto from 'node:crypto'
import { deCote, ecritAtomique, lisJson } from './fichier-etat.mjs'
import { longueur, nomLibre } from './nom-libre.mjs'

export const BORNES = { espaces: 50, places: 300, nom: 40, supprimes: 500 }
const ID = /^e[0-9a-z]{1,40}$/ // « e » + base 36 (Espaces.jsx : date puis hasard ; longueur variable)
const CONSOLE = /^c[0-9a-f]{8}$/
const refus = (message, code = 400) => Object.assign(new Error(message), { code })
const nombre = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

export const idValide = (id) => typeof id === 'string' && ID.test(id)
// Nom : nettoyé par catégories, compté en points de code, vide s'il n'a aucun caractère visible (lib/nom-libre.mjs).
export function nomDe(v) {
  const nom = nomLibre(v)
  if (nom === null) throw refus('nom manquant')
  if (!nom) throw refus('nom vide')
  if (longueur(nom) > BORNES.nom) throw refus(`nom trop long (${BORNES.nom} caractères au plus)`)
  return nom
}
export function placesDe(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw refus('places manquantes')
  const entrees = Object.entries(v)
  if (entrees.length > BORNES.places) throw refus(`trop de consoles dans l’espace (${BORNES.places} au plus)`)
  const places = {}
  for (const [id, p] of entrees) {
    if (!CONSOLE.test(id)) throw refus('place d’une console inconnue')
    if (!p || typeof p !== 'object') throw refus('place illisible')
    if (!nombre(p.x, -50000, 50000) || !nombre(p.y, -50000, 50000) || !nombre(p.w, 320, 2400) || !nombre(p.h, 200, 1600)) throw refus('place hors bornes')
    places[id] = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) } // cet ordre : celui de l'appareil
  }
  return places
}
export function vueDe(v) {
  if (!v || typeof v !== 'object' || !nombre(v.x, -1e6, 1e6) || !nombre(v.y, -1e6, 1e6) || !nombre(v.zoom, 0.05, 4)) throw refus('vue hors bornes')
  return { x: v.x, y: v.y, zoom: v.zoom }
}
const tDe = (t) => (nombre(t, 0, Date.now() + 864e5) ? t : Date.now())
// Un espace bien formé tel qu'on le garde (lecture du fichier) : la même règle que pour une demande.
function relu(e) {
  try {
    if (!e || typeof e !== 'object' || !idValide(e.id)) return null
    return { id: e.id, nom: nomDe(e.nom), places: placesDe(e.places), vue: vueDe(e.vue), t: tDe(e.t) }
  } catch {
    return null
  }
}

export function ouvreEspaces({ DATA, send, readJson }) {
  const FICHIER = path.join(DATA, 'espaces.json')
  let espaces = []
  let supprimes = []
  // Absent : aucun espace. Illisible, autre chose qu'un fichier ordinaire (lien, FIFO, dossier) ou trop gros : déjà mis
  // de côté par lisJson, départ sans espace. Lisible mais de forme inattendue : mis de côté aussi.
  const lu = lisJson(FICHIER, { etiquette: 'espaces' })
  if (lu !== undefined && lu !== null) {
    if (!lu || typeof lu !== 'object' || !Array.isArray(lu.espaces) || !Array.isArray(lu.supprimes)) deCote(FICHIER, 'de forme inattendue (départ sans espace)', { etiquette: 'espaces' })
    else {
      const ids = new Set()
      const lisibles = lu.espaces.map(relu).filter(Boolean)
      const uniques = lisibles.filter((e) => !ids.has(e.id) && ids.add(e.id))
      const bons = uniques.slice(0, BORNES.espaces)
      const sups = lu.supprimes.filter(idValide)
      const gardes = sups.slice(-BORNES.supprimes)
      const causes = [
        [lu.espaces.length - lisibles.length, 'espace(s) illisible(s)'],
        [lisibles.length - uniques.length, 'doublon(s)'],
        [uniques.length - bons.length, `espace(s) au-delà de ${BORNES.espaces}`],
        [lu.supprimes.length - sups.length, 'id(s) supprimé(s) illisible(s)'],
        [sups.length - gardes.length, `id(s) supprimé(s) au-delà de ${BORNES.supprimes}`],
      ].filter(([n]) => n > 0)
      espaces = bons
      supprimes = gardes
      // Quelque chose a été écarté : l'original copié à côté (rien de perdu), puis la liste nettoyée réécrite tout de
      // suite (sinon une copie de plus à chaque démarrage).
      if (causes.length) {
        deCote(FICHIER, `abîmé : ${causes.map(([n, quoi]) => `${n} ${quoi}`).join(', ')} écarté(s), les entrées lisibles restent`, { etiquette: 'espaces', copie: true })
        try {
          ecrit(espaces, supprimes)
        } catch {} // déjà dit au journal par ecritAtomique ; la liste nettoyée reste en mémoire
      }
    }
  }
  function ecrit(apresEspaces, apresSupprimes = supprimes) {
    ecritAtomique(FICHIER, JSON.stringify({ espaces: apresEspaces, supprimes: apresSupprimes }) + '\n', { etiquette: 'espaces' })
    espaces = apresEspaces
    supprimes = apresSupprimes
  }
  const trouve = (id) => espaces.find((e) => e.id === id)
  const nouvelId = () => `e${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`

  async function api(req, res, parts, m) {
    if (parts.length === 2 && m === 'GET') return send(res, 200, { espaces })
    if (parts.length === 2 && m === 'POST') {
      const b = (await readJson(req)) || {} // corps « null » : comme un corps vide (refus 400 clair)
      if (b.id !== undefined && !idValide(b.id)) throw refus('identifiant d’espace invalide')
      const e = { id: b.id ?? nouvelId(), nom: nomDe(b.nom), places: placesDe(b.places), vue: vueDe(b.vue), t: tDe(b.t) }
      // Tout est vérifié AVANT de regarder l'existant : un versement refait rend la même réponse qu'au premier passage.
      const deja = trouve(e.id)
      if (deja) return send(res, 200, { espace: deja, deja: true })
      if (supprimes.includes(e.id)) return send(res, 410, { error: 'cet espace a été supprimé (sur cet écran ou un autre)', supprime: true })
      if (espaces.length >= BORNES.espaces) throw refus(`${BORNES.espaces} espaces au plus : supprimes-en un d’abord`, 409)
      ecrit([...espaces, e])
      return send(res, 201, { espace: e })
    }
    if (parts.length === 3) {
      const id = parts[2]
      if (!idValide(id)) throw refus('identifiant d’espace invalide')
      if (m === 'DELETE') {
        // Seul un espace qui existait laisse son id parmi les supprimés (relecture du 17/11 : 500 DELETE d'ids inventés
        // chassaient les vrais supprimés de la liste bornée, et un ancien espace revenait). Inconnu : rien n'est écrit.
        if (!trouve(id)) return send(res, 200, { ok: true, deja: true })
        ecrit(espaces.filter((e) => e.id !== id), [...supprimes.filter((x) => x !== id), id].slice(-BORNES.supprimes))
        return send(res, 200, { ok: true })
      }
      if (m !== 'PATCH' && m !== 'PUT') return send(res, 404, { error: 'route inconnue' })
      const b = (await readJson(req)) || {} // corps « null » : comme un corps vide (refus 400 clair)
      const e = trouve(id)
      if (!e) return send(res, supprimes.includes(id) ? 410 : 404, supprimes.includes(id) ? { error: 'cet espace a été supprimé (sur cet écran ou un autre)', supprime: true } : { error: 'espace inconnu' })
      const neuf = m === 'PATCH' ? { ...e, nom: nomDe(b.nom) } : { ...e, places: placesDe(b.places), vue: vueDe(b.vue), t: Date.now() }
      ecrit(espaces.map((x) => (x.id === id ? neuf : x)))
      return send(res, 200, { espace: neuf })
    }
    return send(res, 404, { error: 'route inconnue' })
  }
  return { api, liste: () => espaces }
}
