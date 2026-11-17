// Ateliers (volet du 13/11) : le diagramme — module PUR (ni DOM, ni réseau, aucune dépendance). Il lit un sous-ensemble de
// Mermaid « flowchart » (contrat : specs/001-ateliers/contracts/diagramme.md) puis le dispose en couches ; le dessin SVG
// est fait ailleurs (DiagrammeSvg.jsx), le même module sert aux blocs ```mermaid des documents.
// Règles : pas de « lookbehind » dans les expressions (anciens Safari) ; tout est borné : 300 nœuds et 600 liens au plus,
// une instruction est abandonnée à sa première erreur (le texte est lu une fois, sans retour arrière coûteux).
//
// analyse(texte) → { sens, noeuds: [{ id, texte, forme }], aretes: [{ de, vers, texte, trait, fleche }], erreurs: [{ ligne, message }] }
// dispose(a, { mesure }) → { largeur, hauteur, noeuds: [{ id, x, y, w, h, forme, texte }], aretes: [{ points, texte, x, y, trait, fleche }] }
//   - nœud : (x, y) = coin HAUT-GAUCHE de sa boîte, (w, h) = sa taille (pour un cercle w = h = diamètre) ;
//   - arête : `points` = [[x, y]…] du bord de la boîte source au bord de la cible (la pointe, s'il y en a une, est au
//     dernier point) ; (x, y) = CENTRE de l'étiquette (milieu du trait s'il n'y a pas de texte).

export const MAX_NOEUDS = 300
export const MAX_ARETES = 600
const TROP_GRAND = `diagramme trop grand (plus de ${MAX_NOEUDS} nœuds ou ${MAX_ARETES} liens) : rien n'est dessiné`

export const EXEMPLE = `flowchart TD
  A([Demande reçue]) --> B{Dossier complet ?}
  B -->|oui| C[Traiter la demande]
  B -->|non| D[Demander les pièces]
  D --> A
  C --> E((Fin))
`

// ── Analyse ──

const ENTETE = /^(flowchart|graph)(?:\s+(\S+))?$/i
const SENS = ['TD', 'TB', 'BT', 'LR', 'RL']
// Instructions de style ou de regroupement : sans effet sur le dessin (le contenu d'un sous-graphe est dessiné à plat).
const IGNOREE = /^(classDef|class|style|linkStyle|click|subgraph)(\s|$)/
const DIRECTION = /^direction\s+(TD|TB|BT|LR|RL)$/i // sens d'un sous-graphe : sans objet à plat
// Les traits, essayés à la position courante (les formes longues de Mermaid, « ---> », « -..-> », sont admises).
const TRAITS = [
  [/-{2,}>/y, 'plein', true],
  [/-{3,}/y, 'plein', false],
  [/-\.+->/y, 'pointille', true],
  [/-\.+-/y, 'pointille', false],
  [/={2,}>/y, 'epais', true],
  [/={3,}/y, 'epais', false],
]
const LETTRE = /[\p{L}\p{N}]/u

// Un caractère d'identifiant : lettre, chiffre ou « _ » (le « - » est jugé à part : il ne doit pas commencer un trait).
function estId(c) {
  if (c === undefined) return false
  const k = c.charCodeAt(0)
  return (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || (k > 127 && LETTRE.test(c))
}

// Le texte d'une boîte ou d'une étiquette : « <br> » → retour à la ligne, guillemets d'encadrement retirés, blancs rognés.
function nettoie(t) {
  let s = t.trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1)
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()
}

// Une ligne → ses instructions (« ; » sépare, sauf entre guillemets ; « %% » commente la fin de la ligne).
function instructions(ligne) {
  const out = []
  let debut = 0
  let guillemets = false
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i]
    if (c === '"') guillemets = !guillemets
    else if (guillemets) continue
    else if (c === ';') {
      out.push(ligne.slice(debut, i))
      debut = i + 1
    } else if (c === '%' && ligne[i + 1] === '%') {
      out.push(ligne.slice(debut, i))
      debut = -1
      break
    }
  }
  if (debut >= 0) out.push(ligne.slice(debut))
  return out.map((s) => s.trim()).filter(Boolean)
}

// Lecteur d'une instruction : { s, i } ; chaque fonction avance `i` ou rend un message d'erreur (chaîne).
function espaces(L) {
  while (L.i < L.s.length && (L.s[L.i] === ' ' || L.s[L.i] === '\t')) L.i++
}
const extrait = (s, i) => (s.length - i > 16 ? `${s.slice(i, i + 16)}…` : s.slice(i))

// Un nœud : id, puis une forme facultative ([ ], ( ), ([ ]), (( )), { }), puis « :::classe » facultatif (ignoré).
function lisNoeud(L, vus) {
  const { s } = L
  const debut = L.i
  while (L.i < s.length && (estId(s[L.i]) || (s[L.i] === '-' && L.i > debut && estId(s[L.i + 1])))) L.i++
  if (L.i === debut) return L.i < s.length ? `nœud attendu avant « ${extrait(s, L.i)} »` : 'nœud attendu en fin de ligne'
  const n = { id: s.slice(debut, L.i) }
  let fin = ''
  if (s[L.i] === '[') {
    n.forme = 'rect'
    fin = ']'
  } else if (s[L.i] === '(' && s[L.i + 1] === '(') {
    n.forme = 'cercle'
    fin = '))'
  } else if (s[L.i] === '(' && s[L.i + 1] === '[') {
    n.forme = 'stade'
    fin = '])'
  } else if (s[L.i] === '(') {
    n.forme = 'rond'
    fin = ')'
  } else if (s[L.i] === '{') {
    n.forme = 'losange'
    fin = '}'
  }
  if (fin) {
    L.i += fin.length // l'ouverture a la même longueur que la fermeture
    let k = L.i
    while (s[k] === ' ' || s[k] === '\t') k++
    let j
    if (s[k] === '"') {
      // texte entre guillemets : il peut contenir « ] », « ; », « : »…
      const q = s.indexOf('"', k + 1)
      if (q < 0) return `guillemet non fermé pour « ${n.id} »`
      j = q + 1
      while (s[j] === ' ' || s[j] === '\t') j++
      if (!s.startsWith(fin, j)) return `« ${fin} » attendu après le texte de « ${n.id} »`
    } else {
      j = s.indexOf(fin, L.i)
      if (j < 0) return `« ${fin} » attendu pour fermer « ${n.id} »`
    }
    n.texte = nettoie(s.slice(L.i, j))
    L.i = j + fin.length
  }
  if (s.startsWith(':::', L.i)) {
    L.i += 3
    while (L.i < s.length && (estId(s[L.i]) || s[L.i] === '-')) L.i++
  }
  vus.push(n)
  return null
}

// Un groupe : « A » ou « A & B & C » → liste des id.
function lisGroupe(L, vus) {
  const ids = []
  for (;;) {
    espaces(L)
    const err = lisNoeud(L, vus)
    if (err) return err
    ids.push(vus[vus.length - 1].id)
    espaces(L)
    if (L.s[L.i] !== '&') return ids
    L.i++
  }
}

// Le premier « --> » (ou « --- », « ==> »…) qui ferme une étiquette « -- texte -->» ; -1 s'il n'y en a pas.
function fermeture(s, double, depuis) {
  let j = s.indexOf(double, depuis)
  while (j >= 0 && s[j + 2] !== '>' && s[j + 2] !== double[0]) j = s.indexOf(double, j + 1)
  return j
}

// Un lien : trait (avec son étiquette « -- texte --> », « -. texte .-> », « == texte ==> ») puis « |texte| » facultatif.
function lisLien(L) {
  const { s } = L
  const i = L.i
  let texte = ''
  let trait = ''
  let fleche = false
  const c = s[i]
  if ((c === '-' || c === '=') && s[i + 1] === c && s[i + 2] !== c && s[i + 2] !== '>' && s[i + 2] !== undefined) {
    const j = fermeture(s, c + c, i + 2)
    if (j < 0) return `lien non fermé après « ${extrait(s, i)} »`
    texte = s.slice(i + 2, j)
    L.i = j
  } else if (c === '-' && s[i + 1] === '.' && s[i + 2] !== '-' && s[i + 2] !== '.' && s[i + 2] !== undefined) {
    const j = s.indexOf('.-', i + 2)
    if (j < 0) return `lien non fermé après « ${extrait(s, i)} »`
    texte = s.slice(i + 2, j)
    trait = 'pointille'
    fleche = s[j + 2] === '>'
    L.i = j + (fleche ? 3 : 2)
  }
  if (!trait) {
    for (const [re, t, f] of TRAITS) {
      re.lastIndex = L.i
      const m = re.exec(s)
      if (!m) continue
      trait = t
      fleche = f
      L.i += m[0].length
      break
    }
    if (!trait) return L.i < s.length ? `lien attendu avant « ${extrait(s, L.i)} »` : 'lien attendu'
  }
  espaces(L)
  if (s[L.i] === '|') {
    const j = s.indexOf('|', L.i + 1)
    if (j < 0) return 'étiquette non fermée (« | » attendu)'
    texte = s.slice(L.i + 1, j)
    L.i = j + 1
  }
  return { texte: nettoie(texte), trait, fleche }
}

// Une instruction : groupe (lien groupe)* → { vus, aretes } ou { erreur } ; `reste` = liens encore permis (un « & »
// multiplie les liens : on s'arrête dès que la borne est dépassée).
function lisInstruction(s, reste) {
  const L = { s, i: 0 }
  const vus = []
  const aretes = []
  let groupe = lisGroupe(L, vus)
  if (typeof groupe === 'string') return { erreur: groupe }
  for (;;) {
    espaces(L)
    if (L.i >= s.length) return { vus, aretes }
    const lien = lisLien(L)
    if (typeof lien === 'string') return { erreur: lien }
    const suivant = lisGroupe(L, vus)
    if (typeof suivant === 'string') return { erreur: suivant }
    if (aretes.length + groupe.length * suivant.length > reste) return { tropGrand: true }
    for (const de of groupe) for (const vers of suivant) aretes.push({ de, vers, texte: lien.texte, trait: lien.trait, fleche: lien.fleche })
    groupe = suivant
  }
}

export function analyse(texte) {
  let sens = 'TD'
  const noeuds = new Map()
  const aretes = []
  const erreurs = []
  const tropGrand = () => ({ sens, noeuds: [], aretes: [], erreurs: [{ ligne: 0, message: TROP_GRAND }] })
  const lignes = String(texte ?? '').split(/\r\n|\r|\n/)
  let premiere = true
  for (let l = 0; l < lignes.length; l++) {
    for (const instr of instructions(lignes[l])) {
      if (premiere) {
        premiere = false
        const m = ENTETE.exec(instr)
        if (m) {
          const d = (m[2] || 'TD').toUpperCase()
          if (SENS.includes(d)) sens = d
          else erreurs.push({ ligne: l + 1, message: `sens inconnu « ${m[2]} » (TD, TB, BT, LR ou RL)` })
          continue
        }
      }
      if (IGNOREE.test(instr) || instr === 'end' || DIRECTION.test(instr)) continue
      const r = lisInstruction(instr, MAX_ARETES - aretes.length)
      if (r.tropGrand) return tropGrand()
      if (r.erreur) {
        erreurs.push({ ligne: l + 1, message: r.erreur })
        continue
      }
      for (const n of r.vus) {
        const deja = noeuds.get(n.id)
        if (!deja) noeuds.set(n.id, { id: n.id, texte: n.forme ? n.texte : n.id, forme: n.forme || 'rect' })
        else if (n.forme) {
          deja.texte = n.texte
          deja.forme = n.forme
        }
      }
      if (noeuds.size > MAX_NOEUDS) return tropGrand()
      aretes.push(...r.aretes)
    }
  }
  return { sens, noeuds: [...noeuds.values()], aretes, erreurs }
}

// ── Disposition ──

const CAR = 7.2 // largeur moyenne d'un caractère (police 13 px) quand `mesure` n'est pas fourni
const LIGNE = 18 // hauteur d'une ligne de texte
const MARGE = 14 // entre le texte et le bord de sa boîte
const ENTRE_COUCHES = 48
const DANS_COUCHE = 28
const PRES_FANTOME = 14 // écart dans une couche quand un des deux est un point de passage d'arête longue
const FANTOME = 8 // largeur réservée à une arête longue qui traverse une couche
const BOUCLE = 22 // avancée d'une arête d'un nœud vers lui-même
const BORD = 16 // marge du dessin
const MAX_FANTOMES = 20000 // au-delà, les arêtes longues sont tracées droites (dessin borné)

// Taille du texte : largeur de la plus longue ligne, hauteur des lignes.
function texteTaille(texte, mesure) {
  const lignes = String(texte).split('\n')
  let w = 0
  for (const l of lignes) w = Math.max(w, mesure ? Math.max(0, Number(mesure(l)) || 0) : l.length * CAR)
  return { tw: w, th: lignes.length * LIGNE }
}

// Taille d'une boîte d'après son texte et sa forme ; losange et cercle sont plus grands (le texte doit tenir dedans).
function boite(texte, forme, mesure) {
  const { tw, th } = texteTaille(texte, mesure)
  if (forme === 'losange') return { w: 2 * tw + 2 * MARGE, h: 2 * th + 2 * MARGE }
  if (forme === 'cercle') {
    const d = Math.hypot(tw, th) + 2 * MARGE
    return { w: d, h: d }
  }
  const h = th + 2 * MARGE
  return { w: tw + 2 * MARGE + (forme === 'stade' ? h / 2 : 0), h }
}

// Le point du bord de la boîte `b` (centre cx, cy) sur la demi-droite qui va vers (vx, vy).
function bord(b, vx, vy) {
  const dx = vx - b.cx
  const dy = vy - b.cy
  if (!dx && !dy) return [b.cx, b.cy]
  const a = b.w / 2
  const c = b.h / 2
  let t
  if (b.forme === 'losange') t = 1 / (Math.abs(dx) / a + Math.abs(dy) / c)
  else if (b.forme === 'cercle') t = a / Math.hypot(dx, dy)
  else t = Math.min(dx ? a / Math.abs(dx) : Infinity, dy ? c / Math.abs(dy) : Infinity)
  return [b.cx + dx * t, b.cy + dy * t]
}

// Positions dans une couche : au plus près des positions voulues, sans que deux éléments se touchent (écarts minimaux
// imposés). Régression isotone (blocs adjacents fusionnés) : linéaire, et l'écart minimal est garanti par construction.
function tasse(desir, ecarts) {
  const k = desir.length
  const dec = new Float64Array(k)
  for (let i = 1; i < k; i++) dec[i] = dec[i - 1] + ecarts[i]
  const somme = []
  const nombre = []
  const debut = []
  for (let i = 0; i < k; i++) {
    let s = desir[i] - dec[i]
    let n = 1
    let d = i
    while (somme.length && somme[somme.length - 1] / nombre[nombre.length - 1] > s / n) {
      s += somme.pop()
      n += nombre.pop()
      d = debut.pop()
    }
    somme.push(s)
    nombre.push(n)
    debut.push(d)
  }
  const x = new Float64Array(k)
  for (let b = 0; b < somme.length; b++) {
    const fin = b + 1 < debut.length ? debut[b + 1] : k
    for (let i = debut[b]; i < fin; i++) x[i] = somme[b] / nombre[b] + dec[i]
  }
  return x
}

const arrondi = (v) => Math.round(v * 10) / 10

export function dispose(a, { mesure } = {}) {
  const N = a?.noeuds || []
  const sens = SENS.includes(a?.sens) ? a.sens : 'TD'
  const horiz = sens === 'LR' || sens === 'RL'
  const miroir = sens === 'BT' || sens === 'RL'
  const index = new Map(N.map((n, i) => [n.id, i]))
  const liens = []
  for (const e of a?.aretes || []) {
    const u = index.get(e.de)
    const v = index.get(e.vers)
    if (u !== undefined && v !== undefined) liens.push({ u, v, e })
  }
  if (!N.length) return { largeur: 2 * BORD, hauteur: 2 * BORD, noeuds: [], aretes: [] }

  // Éléments : les nœuds, puis les points de passage des arêtes longues (« fantômes »). Dans le repère de travail,
  // « m » = taille le long du sens (hauteur en TD), « c » = taille en travers ; avant / apres = débord en travers.
  const el = N.map((n) => {
    const b = boite(n.texte, n.forme, mesure)
    return { ...b, m: horiz ? b.w : b.h, c: horiz ? b.h : b.w, haut: [], bas: [], noeud: true }
  })
  for (const x of el) x.avant = x.apres = x.c / 2
  const etiquettes = liens.map(({ e }) => {
    if (!e.texte) return null
    const { tw, th } = texteTaille(e.texte, mesure)
    const w = tw + 8
    const h = th + 4
    return { w, h, m: horiz ? w : h, c: horiz ? h : w }
  })

  // 1. Arêtes de retour (parcours en profondeur, en partant des sources) : le reste forme un graphe sans cycle.
  const sorties = N.map(() => [])
  const degre = new Array(N.length).fill(0)
  liens.forEach((l, k) => {
    sorties[l.u].push(k)
    if (l.u !== l.v) degre[l.v]++
  })
  const etat = new Uint8Array(N.length) // 0 jamais vu, 1 en cours, 2 fini
  const retour = new Uint8Array(liens.length)
  const departs = [...N.keys()].sort((x, y) => (degre[x] > 0) - (degre[y] > 0) || x - y)
  for (const r of departs) {
    if (etat[r]) continue
    etat[r] = 1
    const pile = [[r, 0]]
    while (pile.length) {
      const haut = pile[pile.length - 1]
      const u = haut[0]
      if (haut[1] < sorties[u].length) {
        const k = sorties[u][haut[1]++]
        const v = liens[k].v
        if (etat[v] === 1) retour[k] = 1
        else if (etat[v] === 0) {
          etat[v] = 1
          pile.push([v, 0])
        }
      } else {
        etat[u] = 2
        pile.pop()
      }
    }
  }

  // 2. Couches : plus long chemin depuis les sources, en un passage dans l'ordre topologique.
  const rang = new Array(N.length).fill(0)
  const entrants = new Array(N.length).fill(0)
  const suivants = N.map(() => [])
  liens.forEach((l, k) => {
    if (retour[k] || l.u === l.v) return
    suivants[l.u].push(l.v)
    entrants[l.v]++
  })
  const file = []
  for (let i = 0; i < N.length; i++) if (!entrants[i]) file.push(i)
  for (let q = 0; q < file.length; q++) {
    const u = file[q]
    for (const v of suivants[u]) {
      rang[v] = Math.max(rang[v], rang[u] + 1)
      if (--entrants[v] === 0) file.push(v)
    }
  }
  for (let i = 0; i < N.length; i++) el[i].rang = rang[i]
  const nbCouches = Math.max(...rang) + 1

  // 3. Chaîne de chaque arête, du haut vers le bas ; une arête longue reçoit un point de passage par couche traversée
  // (celui du milieu porte l'étiquette et en prend la taille). Une étiquette d'arête courte agrandit l'écart entre ses
  // deux couches.
  let fantomes = 0
  liens.forEach((l) => {
    if (l.u !== l.v) fantomes += Math.abs(rang[l.u] - rang[l.v]) - 1
  })
  const avecFantomes = fantomes <= MAX_FANTOMES
  const ecartCouche = new Array(nbCouches).fill(ENTRE_COUCHES)
  const chaines = liens.map((l, k) => {
    if (l.u === l.v) return null
    const [h, b] = rang[l.u] < rang[l.v] ? [l.u, l.v] : [l.v, l.u]
    const chaine = [h]
    let milieu = -1
    const et = etiquettes[k]
    if (avecFantomes) {
      const centre = Math.floor((rang[h] + rang[b]) / 2)
      for (let r = rang[h] + 1; r < rang[b]; r++) {
        const f = { m: 0, c: FANTOME, haut: [], bas: [], rang: r, noeud: false }
        if (et && r === centre) {
          f.m = et.m
          f.c = et.c
          milieu = el.length
        }
        f.avant = f.apres = f.c / 2
        chaine.push(el.length)
        el.push(f)
      }
    }
    chaine.push(b)
    for (let i = 1; i < chaine.length; i++) {
      el[chaine[i - 1]].bas.push(chaine[i])
      el[chaine[i]].haut.push(chaine[i - 1])
    }
    if (et && chaine.length === 2 && rang[b] - rang[h] === 1) ecartCouche[rang[h]] = Math.max(ecartCouche[rang[h]], et.m + 12)
    return { chaine, inverse: h !== l.u, milieu }
  })
  // Une boucle (nœud vers lui-même) se dessine sur le côté « après » : on lui réserve la place, étiquette comprise.
  liens.forEach((l, k) => {
    if (l.u === l.v) el[l.u].apres = Math.max(el[l.u].apres, el[l.u].c / 2 + BOUCLE + (etiquettes[k] ? etiquettes[k].c + 6 : 0))
  })

  // 4. Ordre dans chaque couche : barycentres des voisins, 4 allers-retours (haut → bas puis bas → haut).
  const couches = Array.from({ length: nbCouches }, () => [])
  el.forEach((x, i) => couches[x.rang].push(i))
  const pos = new Float64Array(el.length)
  const cle = new Float64Array(el.length)
  const numerote = (couche) => couche.forEach((it, i) => (pos[it] = i))
  couches.forEach(numerote)
  const ordonne = (couche, cote) => {
    for (const it of couche) {
      const vs = el[it][cote]
      let s = 0
      for (const v of vs) s += pos[v]
      cle[it] = vs.length ? s / vs.length : pos[it]
    }
    couche.sort((x, y) => cle[x] - cle[y] || pos[x] - pos[y])
    numerote(couche)
  }
  for (let tour = 0; tour < 4; tour++) {
    for (let r = 1; r < nbCouches; r++) ordonne(couches[r], 'haut')
    for (let r = nbCouches - 2; r >= 0; r--) ordonne(couches[r], 'bas')
  }

  // 5. Position en travers : chaque élément vise la moyenne de ses voisins de la couche d'à côté ; `tasse` garantit
  // l'écart minimal (28 px entre deux boîtes) : aucune boîte n'en recouvre une autre dans sa couche.
  const tr = new Float64Array(el.length)
  const ecartsDe = (couche) => {
    const ec = new Float64Array(couche.length)
    for (let i = 1; i < couche.length; i++) {
      const p = el[couche[i - 1]]
      const q = el[couche[i]]
      ec[i] = p.apres + (p.noeud && q.noeud ? DANS_COUCHE : PRES_FANTOME) + q.avant
    }
    return ec
  }
  const ecarts = couches.map(ecartsDe)
  couches.forEach((couche, r) => {
    const x = tasse(new Float64Array(couche.length), ecarts[r]) // tassés autour de 0
    couche.forEach((it, i) => (tr[it] = x[i]))
  })
  const place = (r, cote) => {
    const couche = couches[r]
    const desir = couche.map((it) => {
      const vs = el[it][cote]
      if (!vs.length) return tr[it]
      let s = 0
      for (const v of vs) s += tr[v]
      return s / vs.length
    })
    const x = tasse(desir, ecarts[r])
    couche.forEach((it, i) => (tr[it] = x[i]))
  }
  for (let tour = 0; tour < 4; tour++) {
    for (let r = 1; r < nbCouches; r++) place(r, 'haut')
    for (let r = nbCouches - 2; r >= 0; r--) place(r, 'bas')
  }

  // 6. Position le long du sens : chaque couche est une bande aussi épaisse que son plus grand élément ; les bandes
  // sont séparées de 48 px au moins (plus si une étiquette doit y tenir) : deux couches ne se recouvrent jamais.
  const debutCouche = new Float64Array(nbCouches)
  const epaisseur = new Float64Array(nbCouches)
  for (const x of el) epaisseur[x.rang] = Math.max(epaisseur[x.rang], x.m)
  for (let r = 1; r < nbCouches; r++) debutCouche[r] = debutCouche[r - 1] + epaisseur[r - 1] + ecartCouche[r - 1]
  const lg = (it) => debutCouche[el[it].rang] + epaisseur[el[it].rang] / 2

  // Repère de travail (travers, long) → repère du dessin (x, y) ; BT et RL sont le miroir de TD et LR. Le décalage qui
  // ramène tout en coordonnées positives est appliqué à la fin.
  const versXY = (t, m) => {
    const mm = miroir ? -m : m
    return horiz ? [mm, t] : [t, mm]
  }
  const boites = N.map((n, i) => {
    const [cx, cy] = versXY(tr[i], lg(i))
    return { cx, cy, w: el[i].w, h: el[i].h, forme: n.forme }
  })

  // 7. Arêtes : du bord de la source au bord de la cible, par les points de passage (chacun traverse sa bande en
  // ligne droite) ; étiquette au milieu de l'écart entre deux couches voisines, ou sur le point de passage du milieu.
  const aretes = liens.map((l, k) => {
    const et = etiquettes[k]
    const e = l.e
    let points
    let lx
    let ly
    if (l.u === l.v) {
      const b = boites[l.u]
      if (horiz) {
        const p0 = bord(b, b.cx - b.w * 0.3, b.cy + b.h)
        const p3 = bord(b, b.cx + b.w * 0.3, b.cy + b.h)
        const yb = b.cy + b.h / 2 + BOUCLE
        points = [p0, [p0[0], yb], [p3[0], yb], p3]
        if (et) [lx, ly] = [b.cx, yb + 6 + et.h / 2]
      } else {
        const p0 = bord(b, b.cx + b.w, b.cy - b.h * 0.3)
        const p3 = bord(b, b.cx + b.w, b.cy + b.h * 0.3)
        const xb = b.cx + b.w / 2 + BOUCLE
        points = [p0, [xb, p0[1]], [xb, p3[1]], p3]
        if (et) [lx, ly] = [xb + 6 + et.w / 2, b.cy]
      }
    } else {
      const { chaine, inverse, milieu } = chaines[k]
      const passages = []
      for (let i = 1; i < chaine.length - 1; i++) {
        const it = chaine[i]
        const r = el[it].rang
        passages.push(versXY(tr[it], debutCouche[r]), versXY(tr[it], debutCouche[r] + epaisseur[r]))
        if (it === milieu) [lx, ly] = versXY(tr[it], lg(it))
      }
      const h = boites[chaine[0]]
      const b = boites[chaine[chaine.length - 1]]
      const versH = passages.length ? passages[0] : [b.cx, b.cy]
      const versB = passages.length ? passages[passages.length - 1] : [h.cx, h.cy]
      points = [bord(h, versH[0], versH[1]), ...passages, bord(b, versB[0], versB[1])]
      if (et && lx === undefined) {
        // arête courte : l'étiquette au milieu de l'écart entre les deux couches, sur le trait
        const [p, q] = [points[0], points[points.length - 1]]
        const r = el[chaine[0]].rang
        const cible = versXY(0, debutCouche[r] + epaisseur[r] + ecartCouche[r] / 2)[horiz ? 0 : 1]
        const a0 = horiz ? p[0] : p[1]
        const a1 = horiz ? q[0] : q[1]
        const t = a1 !== a0 && chaine.length === 2 ? Math.min(1, Math.max(0, (cible - a0) / (a1 - a0))) : 0.5
        lx = p[0] + (q[0] - p[0]) * t
        ly = p[1] + (q[1] - p[1]) * t
      }
      if (inverse) points.reverse()
    }
    if (lx === undefined) {
      const m = points.length >> 1
      const p = points[m - 1]
      const q = points[m]
      ;[lx, ly] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    }
    return { points, texte: e.texte || '', x: lx, y: ly, trait: e.trait || 'plein', fleche: e.fleche !== false, et }
  })

  // 7 bis. Liens entre les deux mêmes boîtes (A --> B et B -.-> A, ou deux fois A --> B) : sans écart ils se superposent
  // et se lisent comme un seul trait à double pointe (vu sur la capture du banc, 13/11). Chacun est décalé de 14 px,
  // perpendiculairement à la ligne qui joint les deux boîtes, de part et d'autre du milieu ; son étiquette le suit.
  const paires = new Map()
  liens.forEach((l, k) => {
    if (l.u === l.v) return
    const cle = l.u < l.v ? `${l.u}>${l.v}` : `${l.v}>${l.u}`
    if (!paires.has(cle)) paires.set(cle, [])
    paires.get(cle).push(k)
  })
  for (const ks of paires.values()) {
    if (ks.length < 2) continue
    const l0 = liens[ks[0]]
    const [a0, b0] = l0.u < l0.v ? [boites[l0.u], boites[l0.v]] : [boites[l0.v], boites[l0.u]]
    const lg0 = Math.hypot(b0.cx - a0.cx, b0.cy - a0.cy) || 1
    const [nx, ny] = [-(b0.cy - a0.cy) / lg0, (b0.cx - a0.cx) / lg0]
    ks.forEach((k, i) => {
      const d = (i - (ks.length - 1) / 2) * 14
      const ar = aretes[k]
      ar.points = ar.points.map(([px, py]) => [px + nx * d, py + ny * d])
      // L'étiquette passe du côté extérieur de son trait (son fond blanc couvrirait sinon le trait voisin).
      const sens = Math.sign(d)
      const pousse = ar.et && sens ? (Math.abs(nx) * ar.et.w + Math.abs(ny) * ar.et.h) / 2 + 4 : 0
      ar.x += nx * (d + sens * pousse)
      ar.y += ny * (d + sens * pousse)
    })
  }

  // 8. Cadre : tout est décalé pour commencer à 16 px ; largeur et hauteur englobent boîtes, traits et étiquettes.
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const englobe = (xa, ya, xb, yb) => {
    x0 = Math.min(x0, xa)
    y0 = Math.min(y0, ya)
    x1 = Math.max(x1, xb)
    y1 = Math.max(y1, yb)
  }
  for (const b of boites) englobe(b.cx - b.w / 2, b.cy - b.h / 2, b.cx + b.w / 2, b.cy + b.h / 2)
  for (const ar of aretes) {
    for (const [px, py] of ar.points) englobe(px, py, px, py)
    if (ar.et) englobe(ar.x - ar.et.w / 2, ar.y - ar.et.h / 2, ar.x + ar.et.w / 2, ar.y + ar.et.h / 2)
  }
  const dx = BORD - x0
  const dy = BORD - y0
  return {
    largeur: Math.ceil(x1 - x0 + 2 * BORD),
    hauteur: Math.ceil(y1 - y0 + 2 * BORD),
    noeuds: N.map((n, i) => {
      const b = boites[i]
      return { id: n.id, x: arrondi(b.cx - b.w / 2 + dx), y: arrondi(b.cy - b.h / 2 + dy), w: arrondi(b.w), h: arrondi(b.h), forme: n.forme, texte: n.texte }
    }),
    aretes: aretes.map((ar) => ({
      points: ar.points.map(([px, py]) => [arrondi(px + dx), arrondi(py + dy)]),
      texte: ar.texte,
      x: arrondi(ar.x + dx),
      y: arrondi(ar.y + dy),
      trait: ar.trait,
      fleche: ar.fleche,
    })),
  }
}
