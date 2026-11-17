// « Ranger » une sélection de consoles (ordinateur, barre de la sélection) : où poser le bloc rangé.
// Décision d'Orkun du 17/11, plateau-pc-3 (« Ranger une sélection ») : « Éviter les autres consoles ».
// Le bloc est d'abord rangé en rangées depuis le coin haut gauche de la sélection (`rangement`, Board.jsx) ; s'il touche
// une autre dalle du plateau, il va à la place libre la plus proche de ce coin. « Toucher » = entrer dans l'écart du
// rangement (48 points) autour d'une console non choisie OU d'une carte du plateau étendu (note, web, forme…) : une note
// recouverte gêne autant qu'une console. Une carte choisie avec les consoles n'est pas rangée : elle reste, donc elle gêne.
// Le bloc se déplace d'un seul tenant (la mise en page des rangées ne change pas).
// Calcul pur, sans React ni navigateur (essai : test/volets/decisions-1711/plateau/selection-place.test.mjs).
//
// Leçon 109 : deux appuis de suite, le second ne bouge rien. Au second appui, le coin d'origine est celui du bloc déjà
// posé, qui ne touche rien : le décalage nul est essayé en premier, avec le même critère et le même écart.

// La boîte d'un nœud de React Flow (console ou carte), dans le plan.
export function boite(n) {
  return { x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? n.data?.w ?? 0, h: n.height ?? n.measured?.height ?? n.data?.h ?? 0 }
}

// Le décalage entier { dx, dy } qui porte `bloc` ({ x, y, w, h }) à la place libre la plus proche (distance du coin), en
// gardant `ecart` entre lui et chacune des `autres` boîtes. { 0, 0 } quand il ne touche déjà rien.
// Les places candidates : le coin d'origine et, sur chaque axe, les bords des autres boîtes écartés de `ecart` (la place
// libre la plus proche d'un point est toujours sur ces lignes quand les obstacles sont des rectangles alignés).
// À distance égale : la plus haute, puis la plus à gauche (même entrée, même sortie).
export function decalageLibre(bloc, autres, ecart) {
  const gene = (x, y) => autres.some((o) => x < o.x + o.w + ecart && o.x - ecart < x + bloc.w && y < o.y + o.h + ecart && o.y - ecart < y + bloc.h)
  if (!gene(bloc.x, bloc.y)) return { dx: 0, dy: 0 }
  // Arrondis vers l'extérieur : un bord candidat reste hors de l'écart (le bloc vient de `rangement`, en points entiers).
  const xs = [bloc.x, ...autres.flatMap((o) => [Math.ceil(o.x + o.w + ecart), Math.floor(o.x - ecart - bloc.w)])]
  const ys = [bloc.y, ...autres.flatMap((o) => [Math.ceil(o.y + o.h + ecart), Math.floor(o.y - ecart - bloc.h)])]
  let mieux = null
  for (const x of xs) {
    for (const y of ys) {
      const d = (x - bloc.x) ** 2 + (y - bloc.y) ** 2
      if (mieux && (d > mieux.d || (d === mieux.d && (y > mieux.y || (y === mieux.y && x >= mieux.x))))) continue
      if (!gene(x, y)) mieux = { x, y, d }
    }
  }
  // Toujours trouvée : à droite de la boîte la plus à droite, à la hauteur d'origine, rien ne gêne.
  return { dx: mieux.x - bloc.x, dy: mieux.y - bloc.y }
}

// `places` : { id: { x, y } } rendues par `rangement` pour les consoles `choisies` ; `noeuds` : tous les nœuds du plateau.
// Rend les places décalées d'un seul tenant hors des autres dalles (les mêmes places quand rien ne gêne).
export function horsDesAutres(places, choisies, noeuds, ecart) {
  const ids = Object.keys(places)
  if (!ids.length) return places
  const taille = Object.fromEntries(choisies.map((c) => [c.id, { w: c.w, h: c.h }]))
  const bs = ids.map((id) => ({ x: places[id].x, y: places[id].y, ...taille[id] }))
  const [x, y] = [Math.min(...bs.map((b) => b.x)), Math.min(...bs.map((b) => b.y))]
  const bloc = { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }
  const dedans = new Set(ids)
  const { dx, dy } = decalageLibre(bloc, noeuds.filter((n) => !dedans.has(n.id)).map(boite), ecart)
  if (!dx && !dy) return places
  return Object.fromEntries(ids.map((id) => [id, { x: places[id].x + dx, y: places[id].y + dy }]))
}
