// Étapes d'historique du téléphone (chasse du 17/11, défaut 11). Le geste « retour » de Safari (glisser depuis le bord
// gauche) remonte l'historique du navigateur : depuis le 10/11, ouvrir une console y ajoute une étape et « retour »
// ramène à la liste. Les panneaux plein écran (Suggestions, Agents bloqués, Nouvelle console, Mémoire, Ordre, Boucle)
// n'en prenaient pas : « retour » depuis l'un d'eux quittait Meydan. Ici, la même mécanique pour les deux.
//
// L'étape du haut décrit ce qui est ouvert : `{ console }`, `{ panneau }` ou `{ console, panneau }` (un panneau ouvert
// par-dessus une console). Il n'y en a jamais plus d'une par sorte au-dessus de la liste :
//   - ouvrir une console remplace l'étape d'une autre console ou d'un panneau (une console ouverte depuis l'ordre : le
//     panneau s'efface, « retour » ramène à la liste et non à un panneau fantôme) ;
//   - ouvrir un panneau remplace celle d'un autre panneau (passer de l'un à l'autre n'empile rien) ;
//   - « retour » ferme ce qui n'est plus dans l'étape du haut ; fermer par son bouton revient d'une étape
//     (`history.back()`), pour ne pas laisser d'étape orpheline ;
//   - un rechargement repart de la liste (App.jsx remet l'étape à rien, comme pour les consoles).
// Ordinateur : rien de tout cela (aucune étape, aucun écouteur).
import { useEffect, useRef } from 'react'

// Le téléphone, debout ou couché : la même règle que `mobile` dans App.jsx.
export const TELEPHONE = '(max-width: 760px), (max-height: 520px) and (pointer: coarse)'
// `pushState` et `replaceState` ne préviennent personne : cet événement dit aux panneaux ouverts que l'étape du haut a changé.
const CHANGE = 'meydan:etape'
let numero = 0
const haut = () => history.state || {}

// Une console ouverte au téléphone (App.jsx, `ouvrir`).
export function etapeConsole(id) {
  const h = haut()
  if (h.console || h.panneau) history.replaceState({ console: id }, '')
  else history.pushState({ console: id }, '')
  dispatchEvent(new Event(CHANGE))
}

// Un panneau plein écran : une étape tant que `ouvert` ; `fermer` est appelé quand « retour » l'a retirée (ou qu'une
// console ou un autre panneau a pris sa place).
export function useEtape(ouvert, fermer) {
  const ferme = useRef(fermer)
  ferme.current = fermer
  useEffect(() => {
    if (!ouvert || !matchMedia(TELEPHONE).matches) return
    const jeton = `p${++numero}` // à lui seul : l'étape de CETTE ouverture
    const h = haut()
    const etape = { ...(h.console ? { console: h.console } : {}), panneau: jeton }
    if (h.panneau) history.replaceState(etape, '')
    else history.pushState(etape, '')
    dispatchEvent(new Event(CHANGE))
    const voit = () => haut().panneau !== jeton && ferme.current()
    addEventListener('popstate', voit)
    addEventListener(CHANGE, voit)
    return () => {
      removeEventListener('popstate', voit)
      removeEventListener(CHANGE, voit)
      // Fermé par son bouton (ou démonté) : on revient de son étape si elle est encore en haut. Décidé après le rendu :
      // une console ou un panneau ouvert dans le même geste (l'ordre qui ouvre la console qu'il lance, un panneau
      // remonté) a pu la remplacer entre-temps, et revenir en arrière fermerait alors ce qu'il vient d'ouvrir.
      queueMicrotask(() => haut().panneau === jeton && history.back())
    }
  }, [ouvert])
}
