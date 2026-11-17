// Ateliers (volet du 13/11) : les quatre types d'atelier, lus dans le registre commun des cartes (TYPES_CARTES,
// cartes-types.js, volet plateau-creatif) — un seul endroit pour les noms et les tailles. Module sans composant.
import { TYPES_CARTES } from '../cartes-types.js'

const ATELIERS = ['doc', 'code', 'coffre', 'diagramme']
// Le type `coffre` s'appelle « Markdown » à l'écran (le studio Markdown de Symvibe) ; `coffre` dans le code et les données.
export const NOMS_ATELIERS = Object.fromEntries(ATELIERS.map((t) => [t, TYPES_CARTES[t].nom]))
export const estAtelier = (type) => ATELIERS.includes(type)

// Un écran tactile (téléphone) : même règle que le Chat (Fil.jsx).
export const tactile = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
