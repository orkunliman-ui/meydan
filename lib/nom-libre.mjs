// Un nom libre donné par Orkun (compte, espace de travail) : nettoyé par catégories Unicode (`nettoie` de
// lib/memoire.mjs, leçon 168), compté en POINTS DE CODE (un émoji = 1, comme l'écran le montre). Un nom sans aucun
// caractère visible (blancs, marques combinantes seules, blanc braille U+2800) vaut un nom vide. Relecture de sécurité
// du 17/11 sur le lot « serveur » des décisions : « \u2800 » seul ou des accents sans lettre passaient pour des noms.
import { nettoie } from './memoire.mjs'

const VISIBLE = /[^\s\p{M}\u2800]/u
export const longueur = (s) => [...s].length
// `v` : ce que la demande porte. Rend le nom gardé ('' = vide), ou null si ce n'est pas une chaîne.
export function nomLibre(v) {
  if (typeof v !== 'string') return null
  const t = nettoie(v)
  return VISIBLE.test(t) ? t : ''
}
