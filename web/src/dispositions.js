// Dispositions prêtes, sur l'ordinateur (volet « raccourcis », lot B, 13/11). Orkun, 13/11 : « On est encore loin de
// toutes les fonctionnalitēs de Symvibe ». Symvibe (/docs/board) : des dispositions prêtes (« presets ») qui posent les
// consoles en un clic. Calcul pur, sans React ni navigateur : Dispositions.jsx choisit, Board.jsx applique (un pas de
// l'historique, Ctrl+Z l'annule).
//
// Les règles, dites aussi dans le titre de chaque vignette :
// - Les consoles visées : la sélection (dès deux consoles choisies), sinon celles qui sont à l'écran (centre de la dalle
//   dans la vue). Une disposition à N places prend les N premières dans l'ordre de lecture (rangée par rangée, de gauche
//   à droite), la console active d'abord (à la première place : la « grande » quand il y en a une) ; les autres restent
//   où elles sont. « Rangée » et « Grille » les prennent toutes.
// - Grisée quand il y a moins de consoles que de places (Rangée et Grille : moins de deux).
// - Les places remplissent ce que l'écran du plateau montre au zoom 1 (sa taille moins des marges, la barre de sélection
//   du haut et la barre d'outils du bas), en partant du coin haut gauche de l'ensemble des consoles prises : ce coin ne bouge
//   pas (leçon du 11/11 : « l'origine d'une mise en page = le repère que la mise en page elle-même produit »). Appliquer
//   deux fois la même disposition ne bouge donc rien (« Déjà en place », aucun pas dans l'historique).
// - Les tailles respectent les bornes du serveur (PATCH /api/consoles/:id rogne w à 320–2400 et h à 200–1600, et arrondit) :
//   rognées et arrondies ICI, sinon le serveur en garderait d'autres que celles de l'historique. Quand les bornes ne
//   tiennent pas dans l'écran (beaucoup de consoles), la disposition déborde et le plateau se cadre en dessous du zoom 1.

export const ECART = 24 // entre deux dalles, dans le plan : « Répondre » (34 px à cheval sur le bord bas) n'atteint pas la barre de dessous
export const MARGES = { cote: 16, haut: 60, bas: 64 } // haut : la barre de sélection (16 + 38) ; bas : la barre d'outils (14 + 44), depuis le réagencement du 16/11
export const BORNES = { w: [320, 2400], h: [200, 1600], xy: [-50000, 50000] } // celles de server.mjs (PATCH /api/consoles/:id)
export const PART_GRANDE = 0.6 // la largeur de la « grande », le reste va à la colonne des petites

// `places` : combien de consoles la disposition prend (0 : toutes). `min` : en dessous, elle est grisée.
export const DISPOSITIONS = [
  { id: 'cote', nom: '2 côte à côte', places: 2 },
  { id: 'pile', nom: '2 l’une sur l’autre', places: 2 },
  { id: 'colonnes', nom: '3 colonnes', places: 3 },
  { id: 'carre', nom: '2 × 2', places: 4 },
  { id: 'grande2', nom: '1 grande + 2', places: 3 },
  { id: 'grande3', nom: '1 grande + 3', places: 4 },
  { id: 'rangee', nom: 'Rangée', places: 0 },
  { id: 'grille', nom: 'Grille', places: 0 },
].map((d) => ({ ...d, min: d.places || 2 }))

const parId = (id) => DISPOSITIONS.find((d) => d.id === id)
const borne = (v, [a, b]) => Math.min(b, Math.max(a, Math.floor(v)))

// La place que les dispositions remplissent, pour un plateau de `largeur` × `hauteur` points à l'écran (zoom 1).
export function aireDe(largeur, hauteur) {
  return { w: Math.max(1, Math.floor(largeur - 2 * MARGES.cote)), h: Math.max(1, Math.floor(hauteur - MARGES.haut - MARGES.bas)) }
}

// `n` places en `colonnes`, rangée par rangée, toutes de la même taille.
function grille(colonnes, n, aire, e) {
  const rangees = Math.ceil(n / colonnes)
  const w = borne((aire.w - (colonnes - 1) * e) / colonnes, BORNES.w)
  const h = borne((aire.h - (rangees - 1) * e) / rangees, BORNES.h)
  return Array.from({ length: n }, (_, i) => ({ x: (i % colonnes) * (w + e), y: Math.floor(i / colonnes) * (h + e), w, h }))
}
// La grande à gauche (la première place), `k` petites l'une sur l'autre à droite ; la grande a la hauteur de leur pile.
function grandePlus(k, aire, e) {
  const h = borne((aire.h - (k - 1) * e) / k, BORNES.h)
  const gw = borne((aire.w - e) * PART_GRANDE, BORNES.w)
  const w = borne(aire.w - e - gw, BORNES.w)
  const grande = { x: 0, y: 0, w: gw, h: borne(k * h + (k - 1) * e, BORNES.h) }
  return [grande, ...Array.from({ length: k }, (_, i) => ({ x: gw + e, y: i * (h + e), w, h }))]
}

// Les places d'une disposition pour `n` consoles, à partir de (0, 0) (le coin haut gauche, toujours la première place),
// entières et dans les bornes du serveur. `n` ne compte que pour Rangée et Grille.
export function cases(id, n, aire, e = ECART) {
  const d = parId(id)
  if (!d) return []
  const k = d.places || n
  switch (id) {
    case 'cote':
      return grille(2, 2, aire, e)
    case 'pile':
      return grille(1, 2, aire, e)
    case 'colonnes':
      return grille(3, 3, aire, e)
    case 'carre':
      return grille(2, 4, aire, e)
    case 'grande2':
      return grandePlus(2, aire, e)
    case 'grande3':
      return grandePlus(3, aire, e)
    case 'rangee':
      return grille(k, k, aire, e)
    case 'grille':
      return grille(Math.ceil(Math.sqrt(k)), k, aire, e)
  }
  return []
}

// L'ordre de lecture du plateau : rangée par rangée (une console est dans la rangée d'une autre quand son haut est à moins
// de la moitié de la plus basse des deux sous le haut de la rangée), de gauche à droite dans une rangée.
export function ordreDeLecture(consoles) {
  const tri = [...consoles].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1))
  const rangees = []
  for (const c of tri) {
    const r = rangees.at(-1)
    if (r && c.y < r.haut + Math.min(r.h, c.h) / 2) {
      r.membres.push(c)
      r.h = Math.min(r.h, c.h)
    } else rangees.push({ haut: c.y, h: c.h, membres: [c] })
  }
  return rangees.flatMap((r) => r.membres.sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1)))
}
// La console active d'abord (si elle est parmi les visées), puis l'ordre de lecture.
export function ordre(consoles, activeId) {
  const actif = consoles.find((c) => c.id === activeId)
  return actif ? [actif, ...ordreDeLecture(consoles.filter((c) => c !== actif))] : ordreDeLecture(consoles)
}

const cle = (p) => `${p.x},${p.y},${p.w},${p.h}`
// La disposition est-elle déjà là, sur une partie des consoles visées ? On essaie chaque console (la seule active, si elle
// est parmi les visées) comme occupante de la première place : les places se calculent depuis son coin, et il faut une
// console visée exactement sur chacune. Sans cela, un second clic reprendrait « les N premières dans l'ordre de lecture »
// après que le premier les a déplacées : une console laissée où elle était pourrait s'intercaler et tout bouger.
function enPlace(rel, consoles, activeId) {
  const ici = new Map()
  for (const c of consoles) if (!ici.has(cle(c))) ici.set(cle(c), c)
  const actif = consoles.find((c) => c.id === activeId)
  for (const a of actif ? [actif] : consoles) {
    if (a.w !== rel[0].w || a.h !== rel[0].h) continue
    const occupantes = rel.map((r) => ici.get(cle({ x: a.x + r.x, y: a.y + r.y, w: r.w, h: r.h })))
    if (occupantes[0] === a && occupantes.every(Boolean) && new Set(occupantes).size === rel.length) return occupantes
  }
  return null
}

const place = (p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })

// Appliquer la disposition `id` aux consoles visées (`consoles` : { id, x, y, w, h }), pour une aire `aire` (aireDe).
// Rend null quand elle est grisée (trop peu de consoles) ; sinon { prises: [id…], places: { id: { x, y, w, h } }, deja }.
// `deja` : la disposition est déjà en place (`places` = celles du moment) ; rien ne doit bouger.
export function disposition(id, consoles, { activeId = null, aire, ecart = ECART } = {}) {
  const d = parId(id)
  if (!d || !aire || consoles.length < d.min) return null
  const n = d.places || consoles.length
  const rel = cases(id, n, aire, ecart)
  const vues = enPlace(rel, consoles, activeId)
  if (vues) return { deja: true, prises: vues.map((c) => c.id), places: Object.fromEntries(vues.map((c) => [c.id, place(c)])) }
  const prises = ordre(consoles, activeId).slice(0, n)
  // L'origine : le coin haut gauche des consoles prises, qui reste celui de la disposition (gardée dans les bornes du serveur).
  const large = Math.max(...rel.map((r) => r.x + r.w))
  const haut = Math.max(...rel.map((r) => r.y + r.h))
  const o = {
    x: Math.max(BORNES.xy[0], Math.min(BORNES.xy[1] - large, Math.min(...prises.map((c) => c.x)))),
    y: Math.max(BORNES.xy[0], Math.min(BORNES.xy[1] - haut, Math.min(...prises.map((c) => c.y)))),
  }
  const places = Object.fromEntries(prises.map((c, i) => [c.id, { x: o.x + rel[i].x, y: o.y + rel[i].y, w: rel[i].w, h: rel[i].h }]))
  const deja = prises.every((c) => cle(c) === cle(places[c.id]))
  return { deja, prises: prises.map((c) => c.id), places }
}

// La vue qui montre `places` ({ id: { x, y, w, h } }) dans un plateau de `largeur` × `hauteur` : au zoom 1, ou moins si
// elles ne tiennent pas (jamais sous le zoom le plus petit du plateau), centrées dans l'aire des dispositions.
export function vuePour(places, largeur, hauteur, zoomMin = 0.15) {
  const ps = Object.values(places)
  if (!ps.length) return null
  const a = aireDe(largeur, hauteur)
  const x0 = Math.min(...ps.map((p) => p.x))
  const y0 = Math.min(...ps.map((p) => p.y))
  const bw = Math.max(...ps.map((p) => p.x + p.w)) - x0
  const bh = Math.max(...ps.map((p) => p.y + p.h)) - y0
  const zoom = Math.max(zoomMin, Math.min(1, a.w / bw, a.h / bh))
  return { x: MARGES.cote + (a.w - bw * zoom) / 2 - x0 * zoom, y: MARGES.haut + (a.h - bh * zoom) / 2 - y0 * zoom, zoom }
}

// Les consoles dont le centre est dans la vue (`vue` : { x, y, zoom } de React Flow ; plateau de `largeur` × `hauteur`).
export function aLEcran(consoles, vue, largeur, hauteur) {
  const [x0, y0] = [-vue.x / vue.zoom, -vue.y / vue.zoom]
  const [x1, y1] = [x0 + largeur / vue.zoom, y0 + hauteur / vue.zoom]
  return consoles.filter((c) => {
    const [cx, cy] = [c.x + c.w / 2, c.y + c.h / 2]
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
  })
}
