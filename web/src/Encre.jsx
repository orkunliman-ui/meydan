// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — le stylo et
// la gomme. Demande du volet, mot pour mot : « Stylo et gomme : un calque de dessin à main levée sur le plateau (traits
// enregistrés en coordonnées du plateau, suivent le zoom), gomme par trait ; activé par un outil, jamais par défaut (le
// glisser du plateau reste intact). » et, pour les images, « annoter par-dessus au stylo ».
//   <CalqueDessin plein /> : monté DANS <ReactFlow> par PlateauCreatif.jsx (ordinateur et téléphone couché). Peint les
//     traits du support « plateau » au-dessus des dalles (un SVG du conteneur, transformé par la vue). Quand l'outil
//     (outil.js) est « stylo » ou « gomme », sur l'ordinateur et sans console agrandie, une surface au-dessus du plateau
//     prend le pointeur (souris, stylet, doigt) pour tracer ou gommer ; sinon RIEN ne change (glisser du plateau et des
//     dalles intact). Téléphone (`tel`) : traits peints, fixes, rien ne prend le doigt.
//   <SurfaceTraits support largeur hauteur mode couleur /> : posée par la carte image par-dessus son image ; peint les
//     traits de `support` dans le repère de l'image (0..largeur × 0..hauteur, taille naturelle), cadrés comme une image en
//     `object-fit: contain` ; `mode` « stylo » / « gomme » : prend le pointeur et ajoute / gomme dans ce repère.
// Données : web/src/traits.js (magasin) ; serveur : lib/traits.mjs.
import { memo, useContext, useEffect, useRef, useState } from 'react'
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { CartesCtx } from './cartes.js'
import { useOutil } from './outil.js'
import { ajouteTrait, cheminTrait, COORD_MAX, EPAISSEUR, POINTS_MAX, retireTrait, useTraits } from './traits.js'
import { cls } from './lib.js'
import './carte-encre.css'

// Réglages du geste, en points d'ÉCRAN : divisés par l'échelle du support (zoom du plateau, ou taille affichée de
// l'image) au moment du geste. Un trait neuf a donc la même épaisseur à l'écran quel que soit le zoom où il est tracé,
// puis il suit le zoom comme le reste du plan.
const TRAIT = 3 // épaisseur d'un trait neuf
const MARGE = 6 // la gomme prend un trait passé à moins de sa demi-épaisseur + 6 points
const PAS = 1 // un point du tracé brut tous les 1 point au moins
const TOLERANCE = 0.6 // simplification avant l'envoi (Ramer-Douglas-Peucker) : écart toléré au tracé brut
const BRUT_MAX = 20000 // au-delà, le tracé brut est simplifié en cours de route (la mémoire reste bornée)

const borne = (v, a, b) => Math.min(b, Math.max(a, v))
const dixieme = (v) => Math.round(v * 10) / 10 || 0
const epaisseurPour = (k) => borne(dixieme(TRAIT / k), EPAISSEUR.min, EPAISSEUR.max)

// ── Géométrie (unités du support) ──
// Distance du point p au segment [a, b].
function distPS(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const u = l2 ? borne(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1) : 0
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy)
}
// Distance entre les segments [a, b] et [c, d] (0 s'ils se croisent).
function distSS(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  if (o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)) return 0
  return Math.min(distPS(a, c, d), distPS(b, c, d), distPS(c, a, b), distPS(d, a, b))
}
// Ramer-Douglas-Peucker, sans récursion : les points qui s'écartent de plus de `eps` de la corde sont gardés.
function rdp(pts, eps) {
  const n = pts.length
  if (n < 3) return pts.slice()
  const garde = new Uint8Array(n)
  garde[0] = garde[n - 1] = 1
  const pile = [[0, n - 1]]
  while (pile.length) {
    const [a, b] = pile.pop()
    let dmax = 0
    let imax = -1
    for (let i = a + 1; i < b; i++) {
      const d = distPS(pts[i], pts[a], pts[b])
      if (d > dmax) [dmax, imax] = [d, i]
    }
    if (imax > 0 && dmax > eps) {
      garde[imax] = 1
      pile.push([a, imax], [imax, b])
    }
  }
  return pts.filter((_, i) => garde[i])
}
// Le tracé brut → les points envoyés : simplifié, POINTS_MAX au plus (la tolérance grandit sinon), arrondi au dixième et
// borné comme au serveur. Un corps de 31 Ko au pire : loin des 64 Ko d'une demande.
function prepare(pts, eps) {
  let r = rdp(pts, eps)
  while (r.length > POINTS_MAX) r = rdp(pts, (eps *= 1.5))
  return r.map(([x, y]) => [dixieme(borne(x, -COORD_MAX, COORD_MAX)), dixieme(borne(y, -COORD_MAX, COORD_MAX))])
}
const boites = new WeakMap()
function boite(t) {
  let r = boites.get(t)
  if (!r) {
    r = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of t.points) r = [Math.min(r[0], x), Math.min(r[1], y), Math.max(r[2], x), Math.max(r[3], y)]
    boites.set(t, r)
  }
  return r
}
// Le geste de la gomme, du point a au point b, touche-t-il le trait t ? (distance aux SEGMENTS du trait : un geste rapide
// qui le traverse entre deux événements le prend aussi.)
function touche(t, a, b, marge) {
  const r = t.epaisseur / 2 + marge
  const [x0, y0, x1, y1] = boite(t)
  if (Math.max(a[0], b[0]) < x0 - r || Math.min(a[0], b[0]) > x1 + r || Math.max(a[1], b[1]) < y0 - r || Math.min(a[1], b[1]) > y1 + r) return false
  const p = t.points
  if (p.length === 1) return distPS(p[0], a, b) <= r
  for (let i = 0; i < p.length - 1; i++) if (distSS(a, b, p[i], p[i + 1]) <= r) return true
  return false
}
const polyligne = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') + (pts.length === 1 ? 'l0 0' : '')

// ── Peinture ──
const Trait = memo(function Trait({ t }) {
  return <path className={`cr-en-trait cr-coul-${t.couleur}`} d={cheminTrait(t)} strokeWidth={t.epaisseur} data-id={t.id} />
})
// Chaque trait est mémorisé : un déplacement de la vue ne change que la transformation du groupe qui les porte.
const Traits = memo(function Traits({ traits }) {
  return traits.map((t) => <Trait key={t.id} t={t} />)
})

// ── Le geste (commun au plateau et aux images) ──
// `versSupport(ev, commence)` → [x, y] dans l'unité du support, ou null hors de la zone utile (seulement pour le premier
// appui : un geste commencé reste borné à la zone) ; `echelle()` → points d'écran par unité du support. `vif` : le
// <path> du tracé en direct (écrit sans passer par React).
function useTrace({ mode, support, couleur, versSupport, echelle, traits, onErreur }) {
  const geste = useRef(null)
  const vif = useRef(null)
  const lus = useRef(traits)
  lus.current = traits
  // L'outil change (Échap, autre outil, console agrandie) ou la surface part en plein geste : rien n'est envoyé.
  useEffect(() => {
    geste.current = null
    vif.current?.setAttribute('d', '')
  }, [mode, support])
  const gomme = (g, a, b) => {
    const marge = MARGE / g.k
    for (const t of lus.current)
      if (!t.attente && !g.pris.has(t.id) && touche(t, a, b, marge)) {
        g.pris.add(t.id)
        retireTrait(t.id).catch((e) => onErreur(e.message))
      }
  }
  const onPointerDown = (e) => {
    if (geste.current || !e.isPrimary || e.button !== 0) return
    const p = versSupport(e, false)
    if (!p) return
    e.preventDefault() // ni sélection de texte, ni événements de souris tirés de l'appui (glisser d'une dalle, du plateau)
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId) // le tracé continue même hors de la surface
    } catch {}
    const k = echelle() || 1
    const g = (geste.current = { id: e.pointerId, k, pts: [p], pris: new Set(), dernier: p, epaisseur: epaisseurPour(k) })
    if (mode === 'gomme') return gomme(g, p, p)
    g.d = polyligne(g.pts)
    vif.current?.setAttribute('stroke-width', g.epaisseur)
    vif.current?.setAttribute('d', g.d)
  }
  const onPointerMove = (e) => {
    const g = geste.current
    if (!g || e.pointerId !== g.id) return
    const evs = e.nativeEvent.getCoalescedEvents?.() // tous les points du mouvement, pas un seul par image
    for (const ev of evs?.length ? evs : [e.nativeEvent]) {
      const p = versSupport(ev, true)
      if (!p) continue
      if (mode === 'gomme') {
        gomme(g, g.dernier, p)
        g.dernier = p
        continue
      }
      const z = g.pts[g.pts.length - 1]
      if (Math.hypot(p[0] - z[0], p[1] - z[1]) * g.k < PAS) continue
      g.pts.push(p)
      g.d += `L${p[0]} ${p[1]}`
      if (g.pts.length >= BRUT_MAX) g.d = polyligne((g.pts = rdp(g.pts, TOLERANCE / g.k)))
    }
    if (mode === 'stylo') vif.current?.setAttribute('d', g.d)
  }
  const finit = (e, garde) => {
    const g = geste.current
    if (!g || e.pointerId !== g.id) return
    geste.current = null
    // Le trait passe dans le magasin (à l'écran tout de suite) avant que le tracé en direct s'efface : aucun battement.
    if (mode === 'stylo' && garde) ajouteTrait({ support, couleur, epaisseur: g.epaisseur, points: prepare(g.pts, TOLERANCE / g.k) }).catch((err) => onErreur(err.message))
    vif.current?.setAttribute('d', '')
  }
  return {
    vif,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e) => finit(e, true),
      onPointerCancel: (e) => finit(e, false), // geste repris par le système : rien n'est envoyé
      onLostPointerCapture: (e) => finit(e, false), // après un relâcher, le geste est déjà fini : sans effet
    },
  }
}

// Un message de refus qui s'efface tout seul.
function useErreur() {
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    if (!erreur) return
    const t = setTimeout(() => setErreur(''), 5000)
    return () => clearTimeout(t)
  }, [erreur])
  return [erreur, setErreur]
}

// ── Le calque du plateau ──
export function CalqueDessin({ plein }) {
  const { tel } = useContext(CartesCtx)
  const { outil, couleur } = useOutil()
  const traits = useTraits('plateau')
  const [erreur, setErreur] = useErreur()
  // L'outil ne prend la main que sur l'ordinateur, plateau visible ; sinon rien ne change. PlateauCreatif.jsx désarme
  // aussi l'outil dans ces deux cas.
  const mode = !tel && !plein && (outil === 'stylo' || outil === 'gomme') ? outil : null
  // Rien à peindre ni à saisir : aucun élément, aucune surface peinte de plus (téléphone compris).
  if (!traits.length && !mode && !erreur) return null
  return <Calque traits={traits} mode={mode} couleur={couleur} erreur={erreur} onErreur={setErreur} />
}

function Calque({ traits, mode, couleur, erreur, onErreur }) {
  const rf = useReactFlow()
  const store = useStoreApi()
  const [x, y, k] = useStore((s) => s.transform)
  const surface = useRef(null)
  const versSupport = (ev) => {
    const p = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
    return [borne(p.x, -COORD_MAX, COORD_MAX), borne(p.y, -COORD_MAX, COORD_MAX)]
  }
  const { vif, handlers } = useTrace({ mode, support: 'plateau', couleur, versSupport, echelle: () => store.getState().transform[2], traits, onErreur })
  // La molette zoome encore pendant que l'outil est pris : la surface est posée À CÔTÉ du plateau de React Flow (pas
  // dedans), la molette n'y arriverait jamais ; elle est rejouée sur l'élément qui zoome (.react-flow__renderer, où
  // d3-zoom écoute), au même point de l'écran : même zoom, même vitesse, pincement du pavé tactile compris (ctrlKey).
  useEffect(() => {
    const el = surface.current
    if (!el) return
    const molette = (e) => {
      e.preventDefault() // ni défilement ni zoom de la page
      const zone = store.getState().domNode?.querySelector('.react-flow__renderer')
      zone?.dispatchEvent(new WheelEvent('wheel', { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, cancelable: true }))
    }
    el.addEventListener('wheel', molette, { passive: false })
    return () => el.removeEventListener('wheel', molette)
  }, [mode, store])
  return (
    <>
      <svg className="cr-en-calque" aria-hidden="true">
        <g transform={`translate(${x} ${y}) scale(${k})`}>
          <Traits traits={traits} />
          {mode === 'stylo' && (
            <g className={`cr-coul-${couleur}`}>
              <path ref={vif} className="cr-en-trait est-vif" />
            </g>
          )}
        </g>
      </svg>
      {mode && <div ref={surface} className={cls('cr-en-saisie', mode === 'gomme' && 'est-gomme')} {...handlers} />}
      {erreur && (
        <div className="cr-en-erreur" role="alert">
          {erreur}
        </div>
      )}
    </>
  )
}

// ── La surface d'annotation d'une image ──
// Remplit son parent (qui doit être positionné : position relative ou absolue), cadrée comme une image `object-fit:
// contain` de taille naturelle largeur × hauteur. `mode` null : peinture seule, le pointeur passe au travers ; « stylo »
// / « gomme » : prend le pointeur (classes nodrag nopan : la dalle ne bouge pas, le plateau non plus) et ajoute / gomme
// les traits de `support` dans le repère de l'image, à la couleur `couleur` (un nom de COULEURS).
export function SurfaceTraits({ support, largeur, hauteur, mode = null, couleur = 'papier' }) {
  const traits = useTraits(support)
  const svg = useRef(null)
  const [erreur, setErreur] = useErreur()
  const actif = mode === 'stylo' || mode === 'gomme' ? mode : null
  // Le repère de l'image depuis l'écran : le rectangle de la surface À L'ÉCRAN (getBoundingClientRect : taille de la carte
  // et zoom du plateau compris) puis le cadrage `meet` (échelle min, image centrée). Plutôt que getScreenCTM : même
  // résultat pour un plateau qui ne fait que déplacer et agrandir, sans dépendre de la façon dont chaque navigateur y
  // compte les transformations CSS des parents. Hors de l'image (bandes du cadrage), un appui ne commence rien ; un
  // tracé commencé y est borné.
  const cadre = () => {
    const r = svg.current?.getBoundingClientRect()
    if (!r?.width || !r.height) return null
    const s = Math.min(r.width / largeur, r.height / hauteur)
    return { s, x: r.left + (r.width - largeur * s) / 2, y: r.top + (r.height - hauteur * s) / 2 }
  }
  const versSupport = (ev, commence) => {
    const c = cadre()
    if (!c) return null
    const x = (ev.clientX - c.x) / c.s
    const y = (ev.clientY - c.y) / c.s
    if (!commence && (x < 0 || y < 0 || x > largeur || y > hauteur)) return null
    return [borne(x, 0, largeur), borne(y, 0, hauteur)]
  }
  const echelle = () => cadre()?.s || 1
  const { vif, handlers } = useTrace({ mode: actif, support, couleur, versSupport, echelle, traits, onErreur: setErreur })
  if (!(largeur > 0 && hauteur > 0)) return null
  return (
    <>
      <svg
        ref={svg}
        className={cls('cr-en-surface', actif && 'nodrag nopan est-active', actif === 'gomme' && 'est-gomme')}
        viewBox={`0 0 ${largeur} ${hauteur}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        {...(actif ? handlers : {})}
      >
        <Traits traits={traits} />
        {actif === 'stylo' && (
          <g className={`cr-coul-${couleur}`}>
            <path ref={vif} className="cr-en-trait est-vif" />
          </g>
        )}
      </svg>
      {erreur && (
        <span className="cr-en-erreur-surface" role="alert">
          {erreur}
        </span>
      )}
    </>
  )
}
