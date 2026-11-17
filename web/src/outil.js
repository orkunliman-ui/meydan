// L'outil du plateau de l'ordinateur (volet plateau-creatif, 13/11) : aucun par défaut (le plateau se glisse, les dalles
// se déplacent comme avant) ; « stylo », « gomme » ou « fleche » quand Orkun en choisit un dans la barre du pied du
// plateau (Cartes.jsx). Un seul magasin pour la barre, le calque de dessin (Encre.jsx) et les flèches (Fleches.jsx).
// Échap ou un second clic sur l'outil revient à aucun. Jamais retenu d'une page à l'autre : au rechargement, aucun outil.
import { useSyncExternalStore } from 'react'

let etat = { outil: null, couleur: 'papier' }
const ecoutes = new Set()
const annonce = () => ecoutes.forEach((f) => f())

export const OUTILS = ['stylo', 'gomme', 'fleche']
export function choisitOutil(outil) {
  const o = OUTILS.includes(outil) && etat.outil !== outil ? outil : null
  if (o === etat.outil) return
  etat = { ...etat, outil: o }
  annonce()
}
export function choisitCouleur(couleur) {
  if (couleur === etat.couleur) return
  etat = { ...etat, couleur }
  annonce()
}
export const lisOutil = () => etat
export function useOutil() {
  return useSyncExternalStore(
    (f) => (ecoutes.add(f), () => ecoutes.delete(f)),
    () => etat,
  )
}
