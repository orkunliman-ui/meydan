// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») : ce que le
// volet ajoute DANS le plateau, en un seul élément pour Board.jsx — les flèches (Fleches.jsx), le calque de dessin du
// stylo (Encre.jsx) et le collage / dépôt d'images (ImageNode.jsx). Les dalles des nouveaux types passent par le registre
// de Cartes.jsx, la barre d'outils par OutilsCartes (Cartes.jsx).
// `plein` : une console est agrandie par-dessus le plateau (ordinateur) ; `tel` (CartesCtx) : plateau du téléphone.
import { useContext, useEffect } from 'react'
import { CartesCtx } from './cartes.js'
import { choisitOutil, lisOutil } from './outil.js'
import { toucheEnSaisie } from './raccourcis.js'
import { Fleches } from './Fleches.jsx'
import { CalqueDessin } from './Encre.jsx'
import { DepotImages } from './ImageNode.jsx'

export function PlateauCreatif({ plein }) {
  const { tel } = useContext(CartesCtx)
  // Échap rend le plateau à son usage ordinaire (aucun outil), sauf quand le clavier est dans un terminal ou un champ.
  useEffect(() => {
    if (tel) return
    const touche = (e) => {
      // Échap est réservée pour fermer (registre des touches, raccourcis.js) ; pendant que l'écran de réglage attend une
      // touche, elle n'est pour personne d'autre.
      if (e.key !== 'Escape' || !lisOutil().outil || toucheEnSaisie()) return
      const t = e.target
      if (t?.isContentEditable || t?.closest?.('.xterm, input, textarea, select, [contenteditable]')) return
      choisitOutil(null)
    }
    window.addEventListener('keydown', touche)
    return () => window.removeEventListener('keydown', touche)
  }, [tel])
  // Une console agrandie, ou le téléphone : aucun outil ne reste armé.
  useEffect(() => {
    if (plein || tel) choisitOutil(null)
  }, [plein, tel])
  return (
    <>
      <Fleches />
      <CalqueDessin plein={plein} />
      {!tel && <DepotImages plein={plein} />}
    </>
  )
}
