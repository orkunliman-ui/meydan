// Ateliers (volet du 13/11) : le graphe d'un coffre Markdown — module PUR (ni DOM, ni réseau, aucune dépendance).
// Disposition par forces (répulsion entre notes proches, ressorts sur les liens, gravité vers le centre), graine fixe :
// deux appels avec les mêmes données donnent les mêmes positions ; 300 itérations au plus, rien d'animé.
// La répulsion ne regarde que les voisines (grille de cases de 2 k) : chaque itération reste linéaire en pratique.
// Puis écartement final : aucune note à moins de 14 px d'une autre, tout dans le cadre (marge 20 px). Si le cadre est
// trop petit pour tenir toutes les notes à cette distance (plus de ~1 500 notes dans 800 × 600), le cadre l'emporte :
// les dernières notes qui ne trouvent pas de place restent où elles sont.
// disposeGraphe(n, liens = [[i, j]…], { largeur, hauteur, iterations }) → [{ x, y }] (une position par note).

const MARGE = 20
const ECART = 16 // distance visée par l'écartement final (14 px exigés, marge pour les arrondis)
const PASSES = 30 // passes d'écartement doux avant le placement garanti
const ESSAIS_MAX = 2000000 // places essayées au plus par le placement garanti

// Pseudo-hasard déterministe (mulberry32).
function hasard(graine) {
  let a = graine >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Grille de cases carrées : pour chaque case, la liste chaînée des points qu'elle contient.
function grille(X, Y, x0, y0, cote, nx, ny) {
  const tete = new Int32Array(nx * ny).fill(-1)
  const suivant = new Int32Array(X.length)
  const caseDe = (x, y) => {
    const gx = Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / cote)))
    const gy = Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / cote)))
    return [gx, gy]
  }
  for (let i = 0; i < X.length; i++) {
    const [gx, gy] = caseDe(X[i], Y[i])
    suivant[i] = tete[gy * nx + gx]
    tete[gy * nx + gx] = i
  }
  // Appelle f(j) pour chaque point des 9 cases autour de (x, y).
  const voisins = (x, y, f) => {
    const [gx, gy] = caseDe(x, y)
    for (let cy = Math.max(0, gy - 1); cy <= Math.min(ny - 1, gy + 1); cy++)
      for (let cx = Math.max(0, gx - 1); cx <= Math.min(nx - 1, gx + 1); cx++)
        for (let j = tete[cy * nx + cx]; j >= 0; j = suivant[j]) f(j)
  }
  return { voisins }
}

export function disposeGraphe(n, liens, { largeur = 800, hauteur = 600, iterations = 300 } = {}) {
  n = Math.max(0, Math.floor(Number(n) || 0))
  if (!n) return []
  const x0 = MARGE
  const y0 = MARGE
  const x1 = Math.max(x0, (Number(largeur) || 0) - MARGE)
  const y1 = Math.max(y0, (Number(hauteur) || 0) - MARGE)
  const lw = x1 - x0
  const lh = y1 - y0
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const borne = (v, a, b) => (v < a ? a : v > b ? b : v)
  if (n === 1) return [{ x: cx, y: cy }]

  // Liens valides seulement (indices entiers dans [0, n), pas de lien d'une note vers elle-même).
  const A = []
  for (const l of liens || []) {
    const i = l?.[0]
    const j = l?.[1]
    if (Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < n && j < n && i !== j) A.push(i, j)
  }

  const X = new Float64Array(n)
  const Y = new Float64Array(n)
  const alea = hasard(20261113)
  for (let i = 0; i < n; i++) {
    X[i] = cx + (alea() - 0.5) * lw * 0.8
    Y[i] = cy + (alea() - 0.5) * lh * 0.8
  }

  // Forces (Fruchterman-Reingold) : k = distance idéale, la température borne chaque pas et décroît jusqu'à 0.
  const k = Math.max(ECART, 0.8 * Math.sqrt(Math.max(1, lw * lh) / n))
  const cote = 2 * k
  const nx = Math.max(1, Math.ceil(lw / cote))
  const ny = Math.max(1, Math.ceil(lh / cote))
  const DX = new Float64Array(n)
  const DY = new Float64Array(n)
  const tours = Math.min(300, Math.max(0, Math.floor(Number(iterations) || 0)))
  const t0 = Math.max(lw, lh) / 10
  for (let it = 0; it < tours; it++) {
    DX.fill(0)
    DY.fill(0)
    const g = grille(X, Y, x0, y0, cote, nx, ny)
    for (let i = 0; i < n; i++) {
      g.voisins(X[i], Y[i], (j) => {
        if (j <= i) return
        let dx = X[i] - X[j]
        let dy = Y[i] - Y[j]
        let d2 = dx * dx + dy * dy
        if (d2 < 1e-4) {
          // points confondus : une direction tirée des indices (déterministe)
          dx = ((i * 7 + j * 3) % 5) - 2 || 1
          dy = ((i * 3 + j * 7) % 5) - 2 || 1
          d2 = dx * dx + dy * dy
        }
        if (d2 >= cote * cote) return
        const f = (k * k) / d2 // répulsion k²/d, appliquée au vecteur (dx, dy) : k²/d² × d
        DX[i] += dx * f
        DY[i] += dy * f
        DX[j] -= dx * f
        DY[j] -= dy * f
      })
    }
    for (let a = 0; a < A.length; a += 2) {
      const i = A[a]
      const j = A[a + 1]
      const dx = X[i] - X[j]
      const dy = Y[i] - Y[j]
      const f = Math.sqrt(dx * dx + dy * dy) / k // attraction d²/k, appliquée au vecteur : d/k × d
      DX[i] -= dx * f
      DY[i] -= dy * f
      DX[j] += dx * f
      DY[j] += dy * f
    }
    const t = t0 * (1 - it / tours)
    for (let i = 0; i < n; i++) {
      const dx = DX[i] + (cx - X[i]) * 0.05 // gravité
      const dy = DY[i] + (cy - Y[i]) * 0.05
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > 0) {
        const pas = Math.min(d, t) / d
        X[i] = borne(X[i] + dx * pas, x0, x1)
        Y[i] = borne(Y[i] + dy * pas, y0, y1)
      }
    }
  }

  // Écartement doux : deux notes trop proches s'écartent chacune de la moitié du manque (passes bornées).
  const gx = Math.max(1, Math.ceil(lw / ECART))
  const gy = Math.max(1, Math.ceil(lh / ECART))
  for (let passe = 0; passe < PASSES; passe++) {
    const g = grille(X, Y, x0, y0, ECART, gx, gy)
    let serres = 0
    for (let i = 0; i < n; i++) {
      g.voisins(X[i], Y[i], (j) => {
        if (j <= i) return
        let dx = X[i] - X[j]
        let dy = Y[i] - Y[j]
        let d = Math.sqrt(dx * dx + dy * dy)
        if (d >= ECART) return
        serres++
        if (d < 1e-6) {
          dx = ((i * 7 + j * 3) % 5) - 2 || 1
          dy = ((i * 3 + j * 7) % 5) - 2 || 1
          d = Math.sqrt(dx * dx + dy * dy)
          const e = ECART / 2 / d
          X[i] = borne(X[i] + dx * e, x0, x1)
          Y[i] = borne(Y[i] + dy * e, y0, y1)
          X[j] = borne(X[j] - dx * e, x0, x1)
          Y[j] = borne(Y[j] - dy * e, y0, y1)
          return
        }
        const e = (ECART - d) / 2 / d
        X[i] = borne(X[i] + dx * e, x0, x1)
        Y[i] = borne(Y[i] + dy * e, y0, y1)
        X[j] = borne(X[j] - dx * e, x0, x1)
        Y[j] = borne(Y[j] - dy * e, y0, y1)
      })
    }
    if (!serres) break
  }

  // Placement garanti : les notes sont reprises une à une ; une note trop près d'une note déjà placée prend la place
  // libre la plus proche (cercles de plus en plus grands autour d'elle), dans le cadre.
  const nxP = Math.max(1, Math.ceil(lw / ECART) + 1)
  const nyP = Math.max(1, Math.ceil(lh / ECART) + 1)
  const tete = new Int32Array(nxP * nyP).fill(-1)
  const suivant = new Int32Array(n)
  const caseDe = (x, y) => Math.min(nyP - 1, Math.floor((y - y0) / ECART)) * nxP + Math.min(nxP - 1, Math.floor((x - x0) / ECART))
  const libre = (x, y) => {
    const gxi = Math.min(nxP - 1, Math.floor((x - x0) / ECART))
    const gyi = Math.min(nyP - 1, Math.floor((y - y0) / ECART))
    for (let b = Math.max(0, gyi - 1); b <= Math.min(nyP - 1, gyi + 1); b++)
      for (let a = Math.max(0, gxi - 1); a <= Math.min(nxP - 1, gxi + 1); a++)
        for (let j = tete[b * nxP + a]; j >= 0; j = suivant[j]) {
          const dx = X[j] - x
          const dy = Y[j] - y
          if (dx * dx + dy * dy < ECART * ECART) return false
        }
    return true
  }
  const rayonMax = Math.hypot(lw, lh)
  let essais = ESSAIS_MAX // borne le travail quand le cadre est plein (aucune boucle sans fin)
  for (let i = 0; i < n; i++) {
    if (!libre(X[i], Y[i])) {
      cherche: for (let r = ECART / 2; r <= rayonMax && essais > 0; r += ECART / 2) {
        const pas = Math.max(8, Math.ceil((2 * Math.PI * r) / (ECART / 2)))
        for (let q = 0; q < pas; q++) {
          if (--essais < 0) break cherche
          const a = (2 * Math.PI * q) / pas
          const x = X[i] + r * Math.cos(a)
          const y = Y[i] + r * Math.sin(a)
          if (x < x0 || x > x1 || y < y0 || y > y1 || !libre(x, y)) continue
          X[i] = x
          Y[i] = y
          break cherche
        }
      }
    }
    const c = caseDe(X[i], Y[i])
    suivant[i] = tete[c]
    tete[c] = i
  }

  const arrondi = (v) => Math.round(v * 10) / 10
  return Array.from({ length: n }, (_, i) => ({ x: borne(arrondi(X[i]), x0, x1), y: borne(arrondi(Y[i]), y0, y1) }))
}
