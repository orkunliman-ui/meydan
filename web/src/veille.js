// Veille des terminaux qu'on ne voit pas (volet plateau-pc, 11/11). Orkun : « Terminaux hors champ en pause : à 15
// consoles et plus, ne plus peindre ni écrire dans xterm les dalles hors de l'écran ou sous le zoom des tuiles (garder la
// connexion et le texte reçu, l'afficher au retour) — ou les démonter / remonter proprement. Mesure le temps du fil
// principal avec 20 consoles qui écrivent, avant / après. »
// Ici on décide QUI dort ; Term.jsx fait dormir (liaison gardée, texte mis de côté, rendu au réveil).
import { useEffect, useState } from 'react'
import { useStore } from '@xyflow/react'

// Consoles vivantes (non terminées) à partir desquelles un terminal non vu s'endort. 15 au départ (Orkun, 11/11) ; 1 depuis
// le 16/11 (« c'est hyper lent », sur son MacBook, avec 8 consoles vivantes) : un terminal caché sous sa tuile ou hors de
// l'écran se redessinait encore à chaque ligne d'un agent qui travaille (banc « MacBook » : rendu de xterm sous les tuiles).
export const SEUIL_VEILLE = 1
const MARGE = 160 // px d'écran autour du plateau : une dalle qui approche du bord se réveille avant d'y entrer
const DELAI = 1000 // ms : on s'endort seulement après une seconde hors de vue (un glissement ou un zoom ne fait pas battre)

// La dalle est-elle entièrement hors de l'écran (marge comprise) ? Rend un booléen : seul un changement re-rend la dalle.
function horsEcran(s, id) {
  const n = s.nodeLookup.get(id)
  if (!n || !s.width || !s.height) return false // pas encore mesurée : éveillée
  const [tx, ty, z] = s.transform
  const p = n.internals.positionAbsolute
  const [w, h] = [n.measured?.width ?? n.width ?? 0, n.measured?.height ?? n.height ?? 0]
  const [x, y] = [p.x * z + tx, p.y * z + ty]
  return x + w * z < -MARGE || y + h * z < -MARGE || x > s.width + MARGE || y > s.height + MARGE
}

// `far` : sous le zoom des tuiles ; `cache` : une console est agrandie par-dessus le plateau ; `active` : elle a le
// clavier (ne dort jamais) ; `n` : consoles vivantes. Réveil immédiat, endormissement après DELAI.
export function useVeille(id, { far, cache, active, n }) {
  const compte = n >= SEUIL_VEILLE
  const loin = useStore((s) => compte && horsEcran(s, id)) // sous le seuil, rien à calculer à chaque image
  const endormable = compte && !active && (far || cache || loin)
  const [dort, setDort] = useState(false)
  useEffect(() => {
    if (!endormable) return setDort(false)
    const t = setTimeout(() => setDort(true), DELAI)
    return () => clearTimeout(t)
  }, [endormable])
  return endormable && dort // le réveil ne passe pas par l'effet : il vaut dès ce rendu
}
