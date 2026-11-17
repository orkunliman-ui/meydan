// Touches seules sur le plateau de l'ordinateur (volet « raccourcis », lot A) : F (tout cadrer) et G (carte Git). Monté
// par Board.jsx à l'intérieur de React Flow ; à part de Raccourcis.jsx, qui part avec l'application : React Flow reste
// dans le morceau du plateau (differe.js).
import { useContext, useEffect, useRef, useState } from 'react'
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { CartesCtx } from './cartes.js'
import { useBranche } from './raccourcis.js'

// Taille d'une carte Git neuve (= OutilsCartes de Cartes.jsx et lib/cartes.mjs, TAILLES.git).
const GIT = { w: 660, h: 640 }

// Dans le plateau de l'ordinateur (Board.jsx, à l'intérieur de React Flow) : F (tout cadrer) et G (carte Git).
// `plein` : la console agrandie (null : aucune) ; `actions` : celles d'App.jsx (agrandit…).
export function ClavierPlateau({ plein, actions }) {
  const rf = useReactFlow()
  const store = useStoreApi()
  const dom = useStore((s) => s.domNode)
  const { actions: cartes } = useContext(CartesCtx)
  const [erreur, setErreur] = useState('')
  const pose = useRef(null) // une carte Git en route vers le serveur : un second G ne la crée pas deux fois
  useEffect(() => {
    if (!erreur) return
    const t = setTimeout(() => setErreur(''), 6000)
    return () => clearTimeout(t)
  }, [erreur])

  // Une console agrandie cache le plateau : on revient d'abord au plateau.
  const reduit = () => {
    if (!plein) return false
    actions.agrandit(null)
    return true
  }
  const choisit = (id) => {
    const s = store.getState()
    if (s.nodeLookup.has(id) && s.elementsSelectable) s.addSelectedNodes([id]) // le même appel que le clic de React Flow
  }

  // F : tout le plateau à l'écran, cartes comprises.
  useBranche('cadrer', () => {
    if (!store.getState().nodeLookup.size) return false
    const cadre = () => rf.fitView({ padding: 0.08, maxZoom: 1, duration: 320 })
    if (reduit()) requestAnimationFrame(cadre)
    else cadre()
  })

  // G : la carte Git du plateau, cadrée et choisie (plusieurs : la suivante de celle qui est choisie) ; sinon une carte
  // neuve au milieu de l'écran, comme le bouton « Git » de la barre « Ajouter » (OutilsCartes, Cartes.jsx).
  useBranche('git', () => {
    if (pose.current) return // déjà en route : la touche est prise, rien de plus
    const gits = store.getState().nodes.filter((n) => n.type === 'carte-git')
    if (gits.length) {
      const n = gits[(gits.findIndex((x) => x.selected) + 1) % gits.length]
      reduit()
      rf.fitView({ nodes: [{ id: n.id }], padding: 0.12, maxZoom: 1, duration: 320 })
      choisit(n.id)
      return
    }
    if (!cartes) return false
    reduit()
    pose.current = (async () => {
      setErreur('')
      const r = dom?.getBoundingClientRect()
      const centre = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 }
      try {
        const carte = await cartes.cree('git', { x: Math.round(centre.x - GIT.w / 2), y: Math.round(centre.y - GIT.h / 2) })
        // Son nœud arrive au rendu suivant : on l'attend quelques images, puis elle devient la carte choisie.
        for (let i = 0; i < 30 && !store.getState().nodeLookup.has(carte.id); i++) await new Promise(requestAnimationFrame)
        choisit(carte.id)
      } catch (e) {
        setErreur(e.message)
      } finally {
        pose.current = null
      }
    })()
  })

  return erreur ? (
    <p className="rc-note" role="alert">
      Carte Git : {erreur}
    </p>
  ) : null
}
