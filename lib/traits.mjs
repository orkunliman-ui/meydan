// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — les traits
// du stylo. Demande du volet, mot pour mot : « Stylo et gomme : un calque de dessin à main levée sur le plateau (traits
// enregistrés en coordonnées du plateau, suivent le zoom), gomme par trait ; activé par un outil, jamais par défaut (le
// glisser du plateau reste intact). » et « Images insérées et annotées : […] annoter par-dessus au stylo ».
//
// Un trait : { id: 't' + 8 hexa, support: 'plateau' | <id d'une carte image>, couleur ∈ COULEURS, epaisseur, points: [[x, y], …] }
//   — sur le plateau, x et y sont des points du plan (comme la place d'une carte) ; sur une image, des pixels de l'image
//   (sa taille naturelle). L'épaisseur est dans la même unité. Nombres arrondis au dixième.
// Fichier à part, DATA/traits.json (0600, écriture atomique, JSON compact) : rien de cartes.json ni de state.json ne bouge.
// Routes (sous /api/ : porte de session et originOk de server.mjs, routées par lib/cartes.mjs) :
//   GET    /api/cartes/traits[?support=plateau|k…]  → 200 { traits }
//   POST   /api/cartes/traits   { support, couleur, epaisseur, points, id? } — UN trait par demande
//                               → 201 { trait } ; flux { type: 'trait', trait }
//   DELETE /api/cartes/traits/<id>  → 200 { ok: true } ; flux { type: 'trait-retire', id }
//   retireSupport(id) (lib/cartes.mjs, une carte retirée) → flux { type: 'trait-retire', support: id } s'il y en avait.
// L'identifiant peut venir du client (forme fermée, refusé s'il est déjà pris) : le trait s'affiche tout de suite sous son
// vrai nom, et le message du flux qui revient le remplace au lieu de le doubler (web/src/traits.js).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const EPAISSEUR_MIN = 1
// 24 : 3 points d'écran tracés au zoom 0,15 (le plus lointain du plateau) font 20 points du plan.
export const EPAISSEUR_MAX = 24
// Un trait : 1500 points au plus. Au pire « [-49999.9,-49999.9], » = 20 octets par point, soit 30 Ko : la demande tient
// sous les 64 Ko d'un corps (readJson et nginx). Le client simplifie le tracé avant l'envoi (web/src/Encre.jsx).
export const POINTS_MAX = 1500
export const COORD_MAX = 50000 // comme la place d'une carte (lib/cartes.mjs)
// Plafonds de l'ensemble : le fichier est réécrit à chaque trait ; 100 000 points font ~2,2 Mo au pire (mesuré par la
// relecture de sécurité : ~18 ms par écriture), aussi le poids de la lecture de tous les traits au chargement de la page.
export const TRAITS_MAX = 2000
export const POINTS_TOTAL_MAX = 100000
const ID = /^t[0-9a-f]{8}$/
const ID_CARTE = /^k[0-9a-f]{8}$/
const nombre = (v) => typeof v === 'number' && Number.isFinite(v) // JSON.parse('1e999') donne Infinity : refusé
const dixieme = (v) => Math.round(v * 10) / 10 || 0 // `|| 0` : jamais de -0
const totalPoints = (liste) => liste.reduce((s, t) => s + t.points.length, 0)

// ctx : celui de lib/cartes.mjs (DATA, send, readJson, refus, broadcast, COULEURS…) + `trouveCarte(id)`.
export function ouvreTraits({ DATA, send, readJson, refus, broadcast, COULEURS, trouveCarte }) {
  const FICHIER = path.join(DATA, 'traits.json')

  // Le support d'un trait : le plateau, ou une carte image qui existe (`verifie` faux : la forme seule, au chargement).
  function supportDe(v, verifie) {
    if (v === 'plateau') return v
    if (typeof v === 'string' && ID_CARTE.test(v)) {
      if (!verifie) return v
      const k = trouveCarte(v)
      if (!k) throw refus('support : carte inconnue')
      if (k.type !== 'image') throw refus('support : seule une carte image s’annote')
      return v
    }
    throw refus('support : « plateau » ou l’identifiant d’une carte image')
  }
  // Un trait reçu (demande ou fichier) → sa forme exacte, sans identifiant ; sinon `refus`. Champs inconnus ignorés.
  function forme(brut, verifie = true) {
    if (!brut || typeof brut !== 'object' || Array.isArray(brut)) throw refus('un objet JSON est attendu')
    const support = supportDe(brut.support, verifie)
    if (!COULEURS.includes(brut.couleur)) throw refus(`couleur : ${COULEURS.join(', ')}`)
    const e = brut.epaisseur
    if (!nombre(e) || e < EPAISSEUR_MIN || e > EPAISSEUR_MAX) throw refus(`épaisseur : un nombre de ${EPAISSEUR_MIN} à ${EPAISSEUR_MAX}`)
    const ps = brut.points
    if (!Array.isArray(ps) || !ps.length) throw refus('points : une liste de [x, y], un point au moins')
    if (ps.length > POINTS_MAX) throw refus(`trait trop long : ${POINTS_MAX} points au plus`, 413)
    const points = ps.map((p) => {
      if (!Array.isArray(p) || p.length !== 2 || !nombre(p[0]) || !nombre(p[1]) || Math.abs(p[0]) > COORD_MAX || Math.abs(p[1]) > COORD_MAX)
        throw refus(`points : chaque point est [x, y], deux nombres de -${COORD_MAX} à ${COORD_MAX}`)
      return [dixieme(p[0]), dixieme(p[1])]
    })
    return { support, couleur: brut.couleur, epaisseur: dixieme(e), points }
  }

  // Chargement : seules les entrées de la forme attendue sont reprises (un fichier abîmé ne fait pas planter le
  // démarrage) ; plafonds appliqués. Les annotations d'une carte introuvable au démarrage (cartes.json illisible ce
  // jour-là, par exemple) ne sont ni servies ni comptées, mais restent sur le disque (`dormants`) : la première
  // écriture ne les efface pas. Un fichier illisible est mis de côté (traits.json.abime-<date>), jamais écrasé.
  let traits = []
  let dormants = []
  let texte = null
  try {
    texte = fs.readFileSync(FICHIER, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[traits] traits.json illisible (${e.code}) : la liste repart vide`)
  }
  if (texte !== null) {
    let lu = null
    try {
      lu = JSON.parse(texte)
    } catch {}
    if (!Array.isArray(lu?.traits)) {
      const copie = `${FICHIER}.abime-${Date.now()}`
      try {
        fs.renameSync(FICHIER, copie)
      } catch {}
      console.error(`[traits] traits.json illisible : mis de côté (${path.basename(copie)}), la liste repart vide`)
    }
    const vus = new Set()
    let total = 0
    for (const brut of Array.isArray(lu?.traits) ? lu.traits : []) {
      try {
        if (typeof brut?.id !== 'string' || !ID.test(brut.id) || vus.has(brut.id)) continue
        const t = { id: brut.id, ...forme(brut, false) }
        const k = t.support === 'plateau' ? null : trouveCarte(t.support)
        if (t.support !== 'plateau' && !k) {
          vus.add(t.id)
          dormants.push(t)
          continue
        }
        if (k && k.type !== 'image') continue
        if (traits.length >= TRAITS_MAX || total + t.points.length > POINTS_TOTAL_MAX) break
        vus.add(t.id)
        total += t.points.length
        traits.push(t)
      } catch {} // entrée abîmée : écartée
    }
  }

  // Écrit d'abord à côté puis renomme : jamais de fichier à moitié écrit. Appelé AVANT de changer la liste en mémoire :
  // un échec d'écriture ne laisse rien de changé et rend 500 (sans chemin du disque dans le message). Un reste du fichier
  // d'à côté (autre mode, lien) est retiré, jamais réutilisé.
  function sauve(liste) {
    const tmp = FICHIER + '.tmp'
    try {
      fs.rmSync(tmp, { force: true })
      fs.writeFileSync(tmp, JSON.stringify({ traits: [...liste, ...dormants] }), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, FICHIER)
    } catch (e) {
      console.error(`[traits] enregistrement impossible : ${e.message}`)
      throw refus('enregistrement des traits impossible', 500)
    }
  }

  async function api(req, res, url, reste) {
    const m = req.method
    if (reste.length === 0) {
      if (m === 'GET') {
        const s = url.searchParams.get('support')
        if (s === null) return send(res, 200, { traits })
        if (s !== 'plateau' && !ID_CARTE.test(s)) throw refus('support : « plateau » ou l’identifiant d’une carte')
        return send(res, 200, { traits: traits.filter((t) => t.support === s) })
      }
      if (m === 'POST') {
        const corps = await readJson(req)
        const t = forme(corps)
        let id = corps.id
        if (id === undefined) {
          do id = `t${crypto.randomBytes(4).toString('hex')}`
          while (traits.some((x) => x.id === id))
        } else if (typeof id !== 'string' || !ID.test(id)) throw refus('identifiant : « t » suivi de 8 chiffres hexadécimaux')
        else if (traits.some((x) => x.id === id)) throw refus('identifiant de trait déjà pris', 409)
        if (traits.length >= TRAITS_MAX) throw refus(`${TRAITS_MAX} traits au plus : gomme d’abord des traits`, 409)
        if (totalPoints(traits) + t.points.length > POINTS_TOTAL_MAX) throw refus(`${POINTS_TOTAL_MAX} points au plus pour tous les traits : gomme d’abord des traits`, 409)
        const trait = { id, ...t }
        const suivants = [...traits, trait]
        sauve(suivants)
        traits = suivants
        broadcast({ type: 'trait', trait })
        return send(res, 201, { trait })
      }
      return send(res, 405, { error: 'méthode refusée' })
    }
    if (reste.length === 1) {
      if (m !== 'DELETE') return send(res, 405, { error: 'méthode refusée' })
      const id = reste[0]
      if (!ID.test(id)) throw refus('identifiant de trait mal formé')
      if (!traits.some((t) => t.id === id)) return send(res, 404, { error: 'trait inconnu' })
      const suivants = traits.filter((t) => t.id !== id)
      sauve(suivants)
      traits = suivants
      broadcast({ type: 'trait-retire', id })
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'route inconnue' })
  }

  // La carte `id` est partie (lib/cartes.mjs, après son retrait) : ses annotations partent avec elle. Ne lève jamais (la
  // carte est déjà retirée) ; rien n'est écrit ni annoncé quand elle n'en avait pas. Écriture impossible : la mémoire et
  // les écrans suivent quand même (aucun trait orphelin servi ni compté) ; sur le disque, ils restent jusqu'à la
  // prochaine écriture réussie, et un démarrage entre-temps les tient pour dormants (carte introuvable).
  function retireSupport(id) {
    const avait = traits.some((t) => t.support === id)
    if (!avait && !dormants.some((t) => t.support === id)) return
    traits = traits.filter((t) => t.support !== id)
    dormants = dormants.filter((t) => t.support !== id)
    try {
      sauve(traits)
    } catch {} // déjà journalisé par sauve
    if (avait) broadcast({ type: 'trait-retire', support: id })
  }

  return { api, retireSupport }
}
