// « Ranger » de l'ordinateur, version par groupes (Orkun, 11/11 : « Mettre la console au milieu des sous consoles […]
// regrouper les projets entre eux. Le meydan est énorme, c'est con de les regrouper ensemble »).
// Calcul pur, sans React ni navigateur : il rend où poser chaque dalle et quelles zones dessiner derrière.
//
//   - une équipe = un groupe, son capitaine au centre ; une console seule va dans le groupe de son projet (le premier
//     dossier sous le dossier personnel) ; sans capitaine, la plus ancienne console est au centre ;
//   - dans un groupe : « orbite » (anneau autour du centre) ou « colonnes » (empilées à gauche et à droite) ;
//   - les groupes sont posés en grille sur le grand plateau, avec de larges écarts : le plateau est immense, il n'y a
//     aucune raison de les serrer (une mosaïque écrasée était justement ce qu'Orkun ne voulait plus).

// Rangée, chaque console prend la même grande taille (Orkun : « que les fenetres soient suffisament grandes pcq quand
// on range elle devienne petites alors qu'il y a full de place dans le meydan ») : un terminal d'environ 150 colonnes.
export const TAILLE_RANGEE = { w: 1120, h: 720 }
export const JOINT = 72 // entre deux dalles d'un groupe
// Plus de cadre dessiné autour d'un groupe (« les liens seront suffisant ») : aucune marge ; c'est l'écart, bien plus
// grand que le joint, qui sépare les projets (« que les differents projets soient espacés »).
export const MARGE_ZONE = { haut: 0, cote: 0, bas: 0 }
export const ECART_ZONES = 720

const age = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id))

// Le projet d'une console : le premier dossier sous le dossier personnel (~/api/x → « api ») ;
// le dossier personnel lui-même donne le nom de l'utilisateur. Hors du dossier personnel : le dernier dossier du chemin.
export function projetDe(cwd = '') {
  const m = /^\/home\/([^/]+)(?:\/([^/]+))?/.exec(cwd)
  if (m) return m[2] || m[1]
  return cwd.split('/').filter(Boolean).pop() || 'divers'
}
// Une console ouverte dans le dossier personnel lui-même ne dit pas son projet par son dossier : son nom le dit
// (« Claude · Quant », qui pilote les consoles « Quant · … » ouvertes dans ~/quant ; 11/11 : « il est meme pas dans leur
// catégorie »). Le premier morceau du nom qui n'est ni le type d'agent ni l'utilisateur devient son projet.
const TYPES = new Set(['claude', 'codex', 'grok', 'shell', 'capitaine'])
export function projetDeConsole(c) {
  // Console dans une copie de travail (volet copies, 13/11) : son dossier est sous ~/meydan-copies, son projet reste
  // celui du dépôt d'origine (même groupe au rangement, même mémoire de projet).
  if (c.copie?.depot) return projetDeConsole({ name: c.name, cwd: c.copie.sousDossier ? `${c.copie.depot}/${c.copie.sousDossier}` : c.copie.depot })
  const p = projetDe(c.cwd)
  if (!/^\/home\/[^/]+\/?$/.test(c.cwd || '')) return p
  const indice = String(c.name || '')
    .split('·')
    .map((s) => s.trim().toLowerCase())
    .find((s) => /^[a-z0-9][a-z0-9._-]*$/.test(s) && !TYPES.has(s) && s !== p)
  return indice || p
}

// Le nom d'une équipe, tel que la console du capitaine le porte (« Capitaine · Trouver un projet »).
const nomEquipe = (membres) => {
  const chef = membres.find((c) => c.chief)
  const m = chef && /^[^·]+·\s*(.+)$/.exec(chef.name || '')
  return m ? m[1] : 'Équipe'
}

// Les groupes, dans l'ordre où on les pose : équipes d'abord, puis projets, chacun selon sa plus ancienne console ;
// un groupe fait seulement de consoles terminées passe en dernier. Chaque groupe : { id, genre, nom, centre, autres }.
export function groupes(consoles) {
  const parClef = new Map()
  for (const c of consoles) {
    const clef = c.team ? `equipe:${c.team}` : `projet:${projetDeConsole(c)}`
    if (!parClef.has(clef)) parClef.set(clef, [])
    parClef.get(clef).push(c)
  }
  const liste = [...parClef].map(([id, membres]) => {
    membres.sort(age)
    const vivantes = membres.filter((c) => c.status !== 'closed')
    // Le centre : le capitaine d'une équipe, sinon la plus ancienne console encore en vie.
    const centre = membres.find((c) => c.chief && c.team) || vivantes[0] || membres[0]
    const equipe = id.startsWith('equipe:')
    return { id, genre: equipe ? 'equipe' : 'projet', nom: equipe ? nomEquipe(membres) : projetDeConsole(membres[0]), centre, autres: membres.filter((c) => c !== centre), mortes: !vivantes.length, naissance: membres[0].createdAt ?? 0 }
  })
  const rang = (g) => (g.mortes ? 2 : g.genre === 'equipe' ? 0 : 1)
  return liste.sort((a, b) => rang(a) - rang(b) || a.naissance - b.naissance || a.id.localeCompare(b.id))
}

// Les cases autour du centre, rang après rang : l'anneau r compte 8r cases, parcourues dans le sens des aiguilles d'une
// montre depuis le coin haut gauche. Rend [[colonne, ligne], …].
function anneau(r) {
  const cases = []
  for (let x = -r; x <= r; x++) cases.push([x, -r])
  for (let y = -r + 1; y <= r; y++) cases.push([r, y])
  for (let x = r - 1; x >= -r; x--) cases.push([x, r])
  for (let y = r - 1; y > -r; y--) cases.push([-r, y])
  return cases
}
// Quelles cases du premier anneau pour k voisines : toujours un dessin symétrique de gauche à droite, et dès deux voisines
// le centre est au milieu de l'ensemble (un triangle N-SE-SO pour trois, pas un T dont le centre serait au bas) — c'est
// ce qu'Orkun demande : « la console au milieu des sous-consoles ». (0 NO, 1 N, 2 NE, 3 E, 4 SE, 5 S, 6 SO, 7 O). Au-delà de 8, les suivantes vont sur l'anneau d'après, réparties régulièrement.
const PREMIER_ANNEAU = { 1: [3], 2: [3, 7], 3: [1, 4, 6], 4: [1, 3, 5, 7], 5: [0, 2, 4, 5, 6], 6: [0, 2, 3, 4, 6, 7], 7: [0, 1, 2, 3, 4, 6, 7], 8: [0, 1, 2, 3, 4, 5, 6, 7] }
function casesOrbite(k) {
  const cases = []
  let reste = k
  for (let r = 1; reste > 0; r++) {
    const toutes = anneau(r)
    const n = Math.min(reste, toutes.length)
    const idx = r === 1 ? PREMIER_ANNEAU[n] : Array.from({ length: n }, (_, i) => Math.floor((i * toutes.length) / n))
    for (const i of idx) cases.push(toutes[i])
    reste -= n
  }
  return cases
}

// Pose un groupe dans son propre repère : { places: { id: { x, y, w, h } }, w, h } avec la zone entière (marges
// comprises) à partir de (0, 0). `taille(c)` : la taille voulue pour la dalle de c.
export function disposeGroupe(g, variante, taille) {
  const t = new Map([g.centre, ...g.autres].map((c) => [c.id, taille(c)]))
  const dalles = [] // { id, cx, cy } : la case de chaque dalle (orbite) ou sa place directe (colonnes)
  let places = {}
  if (variante === 'colonnes') {
    // Le centre au milieu ; les autres, du plus ancien au plus récent, à droite puis à gauche, de haut en bas.
    const droite = g.autres.filter((_, i) => i % 2 === 0)
    const gauche = g.autres.filter((_, i) => i % 2 === 1)
    const pile = (liste) => liste.reduce((h, c) => h + t.get(c.id).h, 0) + Math.max(0, liste.length - 1) * JOINT
    const centreT = t.get(g.centre.id)
    const colG = Math.max(0, ...gauche.map((c) => t.get(c.id).w))
    const colD = Math.max(0, ...droite.map((c) => t.get(c.id).w))
    const hauteur = Math.max(pile(gauche), pile(droite), centreT.h)
    const xCentre = colG ? colG + JOINT : 0
    const xDroite = xCentre + centreT.w + JOINT
    places[g.centre.id] = { x: xCentre, y: (hauteur - centreT.h) / 2, ...centreT }
    for (const [liste, x0, large] of [[gauche, 0, colG], [droite, xDroite, colD]]) {
      let y = (hauteur - pile(liste)) / 2
      for (const c of liste) {
        const { w, h } = t.get(c.id)
        // Collées au centre : les dalles étroites d'une colonne se rangent du côté du centre.
        places[c.id] = { x: liste === gauche ? x0 + large - w : x0, y, w, h }
        y += h + JOINT
      }
    }
  } else {
    dalles.push({ id: g.centre.id, cx: 0, cy: 0 })
    const cases = casesOrbite(g.autres.length)
    // Dans le sens des aiguilles d'une montre, du plus ancien au plus récent : l'ordre se lit autour du centre.
    const ordre = cases.map((c, i) => ({ c, i })).sort((a, b) => {
      const ra = Math.max(Math.abs(a.c[0]), Math.abs(a.c[1])), rb = Math.max(Math.abs(b.c[0]), Math.abs(b.c[1]))
      return ra - rb || anneau(ra).findIndex((k) => k[0] === a.c[0] && k[1] === a.c[1]) - anneau(rb).findIndex((k) => k[0] === b.c[0] && k[1] === b.c[1])
    })
    g.autres.forEach((c, i) => dalles.push({ id: c.id, cx: ordre[i].c[0], cy: ordre[i].c[1] }))
    // Colonnes et lignes de la grille : chacune a la taille de sa plus grande dalle, donc rien ne se chevauche.
    const cols = [...new Set(dalles.map((d) => d.cx))].sort((a, b) => a - b)
    const lignes = [...new Set(dalles.map((d) => d.cy))].sort((a, b) => a - b)
    const largeur = (cx) => Math.max(...dalles.filter((d) => d.cx === cx).map((d) => t.get(d.id).w))
    const hauteurL = (cy) => Math.max(...dalles.filter((d) => d.cy === cy).map((d) => t.get(d.id).h))
    const xDe = new Map()
    const yDe = new Map()
    let x = 0
    for (const cx of cols) (xDe.set(cx, x), (x += largeur(cx) + JOINT))
    let y = 0
    for (const cy of lignes) (yDe.set(cy, y), (y += hauteurL(cy) + JOINT))
    for (const d of dalles) {
      const { w, h } = t.get(d.id)
      places[d.id] = { x: xDe.get(d.cx) + (largeur(d.cx) - w) / 2, y: yDe.get(d.cy) + (hauteurL(d.cy) - h) / 2, w, h }
    }
  }
  const tout = Object.values(places)
  const [x1, y1] = [Math.min(...tout.map((p) => p.x)), Math.min(...tout.map((p) => p.y))]
  const [x2, y2] = [Math.max(...tout.map((p) => p.x + p.w)), Math.max(...tout.map((p) => p.y + p.h))]
  // Dans le repère de la zone : les dalles décalées de la marge, le nom de la zone dans la marge du haut.
  places = Object.fromEntries(Object.entries(places).map(([id, p]) => [id, { x: p.x - x1 + MARGE_ZONE.cote, y: p.y - y1 + MARGE_ZONE.haut, w: p.w, h: p.h }]))
  return { places, w: x2 - x1 + 2 * MARGE_ZONE.cote, h: y2 - y1 + MARGE_ZONE.haut + MARGE_ZONE.bas }
}

// Le rangement complet. `opts` : { variante: 'orbite' | 'colonnes', tailles: { id: { w, h } }, origine: { x, y }, forme }.
// `forme` : largeur / hauteur de l'écran — les groupes se rangent en rangées dont l'ensemble a cette forme, pour que le
// cadrage final montre tout au plus grand. Rend { places: { id: { x, y, w, h } }, zones: [{ id, genre, nom, n, ids, x, y, w, h }], bornes }.
export function rangerParGroupes(consoles, { variante = 'orbite', tailles = {}, origine = { x: 0, y: 0 }, forme = 16 / 9 } = {}) {
  if (!consoles.length) return { places: {}, zones: [], bornes: null }
  const taille = () => ({ ...TAILLE_RANGEE })
  const lot = groupes(consoles).map((g) => ({ g, ...disposeGroupe(g, variante, taille) }))
  // Les rangées de groupes : on essaie chaque largeur possible (une fin de zone sur une seule rangée) et on garde la
  // plus proche de la forme de l'écran.
  const poser = (limite) => {
    const pos = new Map()
    let [x, y, haut, large] = [0, 0, 0, 0]
    let rangee = []
    const fermer = () => {
      for (const { z } of rangee) pos.get(z).y += (haut - z.h) / 2 // chaque zone centrée sur le milieu de sa rangée
      rangee = []
    }
    for (const z of lot) {
      if (x > 0 && x + z.w > limite) {
        fermer()
        ;[x, y, haut] = [0, y + haut + ECART_ZONES, 0]
      }
      pos.set(z, { x, y })
      rangee.push({ z })
      haut = Math.max(haut, z.h)
      x += z.w + ECART_ZONES
      large = Math.max(large, x - ECART_ZONES)
    }
    fermer()
    return { pos, large, haut: y + haut }
  }
  let somme = 0
  let mieux = null
  for (const z of lot) {
    somme += z.w + (somme ? ECART_ZONES : 0)
    const essai = poser(somme)
    const ecart = Math.abs(Math.log(essai.large / essai.haut / forme))
    if (!mieux || ecart < mieux.ecart - 1e-9) mieux = { ...essai, ecart }
  }
  const places = {}
  const zones = []
  for (const z of lot) {
    const o = mieux.pos.get(z)
    const [zx, zy] = [Math.round(origine.x + o.x), Math.round(origine.y + o.y)]
    for (const [id, p] of Object.entries(z.places)) places[id] = { x: zx + Math.round(p.x), y: zy + Math.round(p.y), w: p.w, h: p.h }
    zones.push({ id: z.g.id, genre: z.g.genre, nom: z.g.nom, n: 1 + z.g.autres.length, ids: [z.g.centre, ...z.g.autres].map((c) => c.id), centre: z.g.centre.id, x: zx, y: zy, w: Math.round(z.w), h: Math.round(z.h) })
  }
  return { places, zones, bornes: { x: Math.round(origine.x), y: Math.round(origine.y), w: Math.round(mieux.large), h: Math.round(mieux.haut) } }
}
