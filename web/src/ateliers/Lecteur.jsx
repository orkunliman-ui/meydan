// Ateliers : la lecture en grand d'un atelier. Téléphone : tout l'écran, barre « ‹ Meydan » en toutes lettres sous la
// zone sûre, et une étape d'historique (le geste « retour » y ramène). Ordinateur : la place d'une console agrandie (toute
// la largeur à droite de la colonne), « Réduire » ; Échap ferme aussi. Le corps est fourni par l'appelant. Rien d'animé.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cls } from '../lib.js'

let jetons = 0

export function Lecteur({ titre, type, sousTitre, outils, telephone = false, onFerme, children }) {
  const jeton = useRef(0)
  const ferme = useRef(onFerme)
  ferme.current = onFerme
  const [gauche, setGauche] = useState(0)
  // Une étape d'historique à soi ; `console` (App.jsx) y est gardée, pour que le retour rende l'écran d'avant tel quel.
  useEffect(() => {
    jeton.current = ++jetons
    history.pushState({ ...(history.state || {}), atelier: jeton.current }, '')
    const retour = () => {
      if (history.state?.atelier !== jeton.current) ferme.current?.()
    }
    addEventListener('popstate', retour)
    return () => {
      removeEventListener('popstate', retour)
      // Fermé par l'appelant (carte retirée…) : l'étape d'historique part avec lui.
      if (history.state?.atelier === jeton.current) history.back()
    }
  }, [])
  const quitte = () => {
    if (history.state?.atelier === jeton.current) history.back() // « popstate » ferme
    else ferme.current?.()
  }
  useEffect(() => {
    if (telephone) return
    const echap = (e) => e.key === 'Escape' && quitte()
    addEventListener('keydown', echap)
    return () => removeEventListener('keydown', echap)
  }, [telephone])
  // Ordinateur : commencer au bord droit de la colonne (la liste reste visible et utilisable, comme pour une console agrandie).
  useLayoutEffect(() => {
    if (telephone) return
    const mesure = () => setGauche(Math.max(0, Math.round(document.querySelector('.rail')?.getBoundingClientRect().right || 0)))
    mesure()
    addEventListener('resize', mesure)
    return () => removeEventListener('resize', mesure)
  }, [telephone])
  return createPortal(
    <section className={cls('at-lecteur', telephone ? 'est-tel' : 'est-pc')} style={telephone ? undefined : { left: gauche }} role="dialog" aria-label={titre}>
      <header className="at-lecteur-barre">
        <button type="button" className="at-lecteur-sortie" onClick={quitte}>
          {telephone ? '‹ Meydan' : 'Réduire'}
        </button>
        <span className="at-lecteur-type">{type}</span>
        <span className="at-lecteur-titre">
          <b>{titre}</b>
          {sousTitre && <small>{sousTitre}</small>}
        </span>
        {outils && <span className="at-lecteur-outils">{outils}</span>}
      </header>
      <div className="at-lecteur-corps">{children}</div>
    </section>,
    document.body,
  )
}
