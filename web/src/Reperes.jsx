// Repères d'alignement pendant le déplacement d'une dalle, sur le plateau de l'ordinateur (volet « raccourcis », lot B,
// 13/11). Orkun, 13/11 : « On est encore loin de toutes les fonctionnalitēs de Symvibe ». Comme Symvibe : quand un bord
// (gauche, droite, haut, bas) ou le centre (horizontal, vertical) de la dalle tenue arrive à quelques points d'ÉCRAN
// (SEUIL, divisé par le zoom) d'un bord ou du centre d'une voisine, une ligne fine va de l'une à l'autre. Plusieurs à la
// fois. Bord avec bord (gauche ou droite avec gauche ou droite, haut ou bas avec haut ou bas : deux dalles bord à bord
// comptent), centre avec centre.
// AUCUNE aimantation : la dalle reste sous la souris, sa place est celle que le serveur reçoit au lâcher.
// Les voisines : les consoles et les cartes du plateau étendu visibles à l'écran, sauf celles qui bougent avec la dalle
// tenue (sélection multiple : la dalle tenue montre ses repères avec les dalles qui ne bougent pas ; les autres choisies
// suivent sans repères à elles).
// Lignes de 1 point à l'écran quel que soit le zoom (largeur 1px / --zoom, posée par ZoomWatch), au-dessus des dalles,
// effacées au lâcher. Rien sur le téléphone (`actif` faux : plateau sans glissement à la souris).
//
// `useReperes(actif)` rend un objet STABLE { surGlisse, finGlisse, calque } (il est dans les dépendances de
// onNodeDragStop, Board.jsx) : `surGlisse` va à `onNodeDrag` de React Flow, `finGlisse()` est appelé au début de
// `onNodeDragStop`, `calque` est rendu à l'intérieur de <ReactFlow>. Aucun état React dans Board : les repères vivent dans
// un petit magasin, et seul le calque se redessine, seulement quand l'ensemble des lignes change.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStoreApi, ViewportPortal } from '@xyflow/react'

export const SEUIL = 6 // points d'écran

// Bords et centre d'un rectangle { x, y, w, h } : [début, centre, fin] sur chaque axe.
const reperes = (r) => ({ x: [r.x, r.x + r.w / 2, r.x + r.w], y: [r.y, r.y + r.h / 2, r.y + r.h] })
const PAIRES = [
  [0, 0],
  [0, 2],
  [2, 0],
  [2, 2],
  [1, 1],
]

// Les lignes pour la dalle `tenue` parmi `voisines` ({ x, y, w, h }, dans le plan), à `seuil` près (dans le plan).
// Une ligne : { axe: 'x' (verticale, à x = pos) | 'y' (horizontale, à y = pos), pos, de, a, centre } ; elle est posée sur le
// repère de la voisine (la dalle tenue n'y est pas tirée) et va de la dalle tenue à la voisine (ou aux voisines : deux
// voisines alignées au même endroit font une seule ligne, qui les joint toutes).
export function lignesDe(tenue, voisines, seuil) {
  const t = reperes(tenue)
  const lignes = new Map()
  for (const v of voisines) {
    const r = reperes(v)
    for (const [axe, [o, l]] of [
      ['x', ['y', 'h']],
      ['y', ['x', 'w']],
    ]) {
      for (const [i, j] of PAIRES) {
        if (Math.abs(t[axe][i] - r[axe][j]) > seuil) continue
        const pos = r[axe][j]
        const de = Math.min(tenue[o], v[o])
        const a = Math.max(tenue[o] + tenue[l], v[o] + v[l])
        const k = `${axe}${pos}`
        const deja = lignes.get(k)
        if (deja) {
          deja.de = Math.min(deja.de, de)
          deja.a = Math.max(deja.a, a)
        } else lignes.set(k, { axe, pos, de, a, centre: i === 1 })
      }
    }
  }
  return [...lignes.values()]
}

const rectDe = (n) => {
  const w = n?.measured?.width ?? n?.width
  const h = n?.measured?.height ?? n?.height
  return n && w && h ? { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w, h } : null
}
const croise = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

// Le petit magasin des lignes : ne prévient le calque que quand l'ensemble change (au point du plan près).
function magasin() {
  let lignes = []
  let cle = ''
  const ecoutes = new Set()
  return {
    abonne: (f) => (ecoutes.add(f), () => ecoutes.delete(f)),
    lit: () => lignes,
    pose(l) {
      const k = l.map((x) => `${x.axe}${x.pos}:${Math.round(x.de)}:${Math.round(x.a)}`).join('|')
      if (k === cle) return
      cle = k
      lignes = l
      for (const f of ecoutes) f()
    },
  }
}

const INACTIF = { surGlisse: undefined, finGlisse: () => {}, calque: null }

export function useReperes(actif) {
  const store = useStoreApi()
  const [etat] = useState(magasin)
  return useMemo(() => {
    if (!actif) return INACTIF
    // onNodeDrag(événement, dalle tenue, toutes les dalles qui bougent). La place de la dalle tenue est celle de
    // l'argument `node` : celle du magasin de React Flow (nodeLookup) a un mouvement de souris de retard (elle n'y arrive
    // qu'après le rendu de Board ; vu au banc : la ligne manquait d'un pas de souris). Aucune dalle n'a de parent sur ce
    // plateau : sa place est sa place absolue. Les voisines, immobiles, sont lues dans le magasin.
    const surGlisse = (_, node, nodes) => {
      const { nodeLookup, transform, width, height } = store.getState()
      const [tx, ty, z] = transform
      const taille = rectDe(nodeLookup.get(node.id))
      if (!taille || !z || !node.position) return
      const tenue = { ...taille, x: node.position.x, y: node.position.y }
      const bougent = new Set((nodes?.length ? nodes : [node]).map((n) => n.id))
      const vue = { x: -tx / z, y: -ty / z, w: width / z, h: height / z }
      const voisines = []
      for (const n of nodeLookup.values()) {
        if (bougent.has(n.id) || n.hidden) continue
        const r = rectDe(n)
        if (r && croise(r, vue)) voisines.push(r)
      }
      etat.pose(lignesDe(tenue, voisines, SEUIL / z))
    }
    return { surGlisse, finGlisse: () => etat.pose([]), calque: <Calque etat={etat} /> }
  }, [actif, store, etat])
}

function Calque({ etat }) {
  const lignes = useSyncExternalStore(etat.abonne, etat.lit)
  const rendus = useRef(0) // combien de fois le calque s'est redessiné avec des lignes (lu par l'essai : data-rendus)
  const vides = lignes.length === 0
  // Filet de sécurité : un glissement interrompu sans « fin » (dalle fermée pendant qu'on la tient) n'en laisse pas.
  useEffect(() => {
    if (vides) return
    const efface = () => etat.pose([])
    window.addEventListener('pointerup', efface)
    window.addEventListener('blur', efface)
    return () => {
      window.removeEventListener('pointerup', efface)
      window.removeEventListener('blur', efface)
    }
  }, [vides, etat])
  if (vides) return null
  rendus.current++
  return (
    <ViewportPortal>
      <div className="rp-calque" aria-hidden="true" data-rendus={rendus.current}>
        {lignes.map((l) =>
          l.axe === 'x' ? (
            <i key={`x${l.pos}`} className={`rp-ligne rp-v${l.centre ? ' rp-centre' : ''}`} data-pos={l.pos} style={{ left: l.pos, top: l.de, height: l.a - l.de }} />
          ) : (
            <i key={`y${l.pos}`} className={`rp-ligne rp-h${l.centre ? ' rp-centre' : ''}`} data-pos={l.pos} style={{ top: l.pos, left: l.de, width: l.a - l.de }} />
          ),
        )}
      </div>
    </ViewportPortal>
  )
}
