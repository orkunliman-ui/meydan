// Zoom minimal du plateau. Décision d'Orkun du 17/11, plateau-creatif-11 (« Zoom minimal du plateau du téléphone ») :
// « 0,1 quand le plateau est plein de cartes ».
// « Plein » = le contenu (consoles et cartes) ne tient pas à l'écran au zoom de 0,15, avec les marges du cadrage du
// téléphone : le zoom minimal descend alors à 0,1, et le cadrage automatique (fitView, qui ne descend jamais sous le zoom
// minimal) peut tout montrer. Sinon 0,15 comme avant. L'ordinateur garde toujours 0,15.
// La valeur dépend du contenu et de la place du plateau, jamais du zoom du moment : pas de boucle avec le cadrage.
// Le calcul (`zoomMinTel`) est pur ; essai : test/volets/decisions-1711/plateau/zoom-tel.test.mjs.
import { useMemo } from 'react'
import { getViewportForBounds, useStore } from '@xyflow/react'
import { boite } from './selection-place.js'

export const ZOOM_MIN = 0.15
export const ZOOM_MIN_PLEIN = 0.1

// `boites` : [{ x, y, w, h }] dans le plan ; `largeur`, `hauteur` : la place du plateau à l'écran ; `marges` : celles du
// cadrage du téléphone (CADRE_TEL de Board.jsx). Le zoom qui tient tout est celui que fitView calculerait sans borne basse.
export function zoomMinTel(boites, largeur, hauteur, marges) {
  if (!boites.length || !(largeur > 0) || !(hauteur > 0)) return ZOOM_MIN // place pas encore mesurée : comme avant
  const [x, y] = [Math.min(...boites.map((b) => b.x)), Math.min(...boites.map((b) => b.y))]
  const bornes = { x, y, width: Math.max(...boites.map((b) => b.x + b.w)) - x, height: Math.max(...boites.map((b) => b.y + b.h)) - y }
  if (!(bornes.width > 0) || !(bornes.height > 0)) return ZOOM_MIN
  return getViewportForBounds(bornes, largeur, hauteur, 0, 1, marges).zoom < ZOOM_MIN ? ZOOM_MIN_PLEIN : ZOOM_MIN
}

// Le zoom minimal à donner à React Flow : `tel` = plateau du téléphone (onOuvre) ; `nodes` : consoles et cartes posées.
export function useZoomMin(tel, nodes, marges) {
  const largeur = useStore((s) => s.width)
  const hauteur = useStore((s) => s.height)
  return useMemo(() => (tel ? zoomMinTel(nodes.map(boite), largeur, hauteur, marges) : ZOOM_MIN), [tel, nodes, largeur, hauteur, marges])
}
