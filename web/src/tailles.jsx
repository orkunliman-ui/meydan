import { useSyncExternalStore } from 'react'
// Les bornes vivent dans terminal.js (volet a-vitesse) : importées de Term.jsx, elles tireraient xterm dans le morceau du
// plateau, chargé aussi par le téléphone couché, qui ne monte aucun terminal.
import { TAILLE_MAX, TAILLE_MIN } from './terminal.js'

// Taille du texte par console, sur l'ordinateur (Orkun, 11/11 : « Taille du texte par console (A− / A+ dans la barre de
// la dalle, retenue par console). »). La dalle du plateau et la console agrandie lisent la même valeur : un A+ dans
// l'une se voit aussitôt dans l'autre. Le téléphone garde son pincement et sa clé à lui (`meydan.taille`).
// Changer la taille change la grille du terminal, donc le nombre de colonnes de la session tmux : pour tous les écrans
// qui la regardent (tmux n'a qu'une taille par session).
const CLE = 'meydan.tailles' // { <console>: px }, seulement les tailles qui diffèrent du défaut
const DEFAUT = 13 // la taille d'avant
const abonnes = new Set()
const borne = (px) => Math.max(TAILLE_MIN, Math.min(TAILLE_MAX, Math.round(px)))
function lire() {
  try {
    const v = JSON.parse(localStorage.getItem(CLE) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {} // navigation privée ou valeur illisible : le défaut, pour cette visite
  }
}
let tailles = lire()
const previens = () => abonnes.forEach((f) => f())
// Un autre onglet a changé une taille : la reprendre (sinon cet onglet l'effacerait à sa prochaine écriture).
addEventListener('storage', (e) => {
  if (e.key !== CLE) return
  tailles = lire()
  previens()
})
const abonne = (f) => (abonnes.add(f), () => abonnes.delete(f))

// La discussion d'une console (Chat, ordinateur) suit la même taille, à l'échelle : 13 px = 1 (décision d'Orkun du 17/11,
// plateau-pc-7 « A− / A+ en Chat » : « Oui »). Discussion.jsx la pose en `--fil-zoom`.
export const echelleDe = (px) => px / DEFAUT
export function tailleDe(id) {
  const px = Number(tailles[id])
  return Number.isFinite(px) ? borne(px) : DEFAUT
}
export function poseTaille(id, px) {
  const { [id]: _, ...autres } = tailles
  tailles = borne(px) === DEFAUT ? autres : { ...autres, [id]: borne(px) }
  try {
    localStorage.setItem(CLE, JSON.stringify(tailles))
  } catch {} // navigation privée : la taille vaut pour cette visite
  previens()
}
export const useTaille = (id) => useSyncExternalStore(abonne, () => tailleDe(id))

// A− / A+ dans la barre d'une console (ordinateur : dalle du plateau et console agrandie). Un cran = 1 px, de 9 à 22.
// Le clic ne prend pas le clavier au terminal : on change la taille sans cesser d'écrire.
export function BoutonsTaille({ id }) {
  const px = useTaille(id)
  const garde = (e) => e.preventDefault()
  return (
    <span className="bar-taille nodrag" role="group" aria-label={`Taille du texte : ${px} px`}>
      <button type="button" aria-label="Texte plus petit" title={`Texte plus petit (taille actuelle : ${px} px)`} disabled={px <= TAILLE_MIN} onMouseDown={garde} onClick={() => poseTaille(id, px - 1)}>
        A−
      </button>
      <button type="button" aria-label="Texte plus grand" title={`Texte plus grand (taille actuelle : ${px} px)`} disabled={px >= TAILLE_MAX} onMouseDown={garde} onClick={() => poseTaille(id, px + 1)}>
        A+
      </button>
    </span>
  )
}
