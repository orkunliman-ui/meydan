// Noms des comptes (décision d'Orkun du 17/11, comptes-3 : « Donner des noms »). Point de branchement posé par
// l'orchestrateur du volet decisions-1711 : « Compte 1 » / « Compte 2 » d'office ; le sous-lot « serveur » y branche la
// lecture et l'écriture côté serveur (GET / PUT /api/comptes/noms, lib/comptes-noms.mjs) : les mêmes noms sur tous ses
// écrans. Lus au premier usage, relus quand la page revient à l'écran (un nom donné sur un autre appareil) ; jamais
// gardés dans le navigateur. Orkun les donne dans le panneau d'usage des comptes (Comptes.jsx).
import { useEffect, useSyncExternalStore } from 'react'
import { api } from './lib.js'

export const NOM_MAX = 24 // comme le serveur (points de code, après nettoyage)
let noms = {} // { claude: { '1': 'Max perso' }, codex: { … } } : seulement les noms donnés ; un NOUVEL objet à chaque changement
const abonnes = new Set()
const abonne = (f) => (abonnes.add(f), () => abonnes.delete(f))
const pose = (n) => {
  if (!n || typeof n !== 'object') return
  noms = n
  for (const f of abonnes) f()
}
export const nomCompte = (kind, n) => noms?.[kind]?.[n] || `Compte ${n}`
// Le nom donné par Orkun, ou '' (le défaut).
export const nomDonne = (kind, n) => noms?.[kind]?.[n] || ''

let lu = 0
let enCours = null
function relis() {
  if (enCours) return enCours
  lu = Date.now()
  enCours = api('GET', '/api/comptes/noms')
    .then((r) => pose(r?.noms), () => {}) // liaison coupée ou serveur d'avant : les noms d'office restent
    .finally(() => (enCours = null))
  return enCours
}
const auRetour = () => document.visibilityState === 'visible' && Date.now() - lu > 400 && relis() // focus et visibilitychange arrivent ensemble : une lecture
let ecoute = false
export function useNomsComptes() {
  useSyncExternalStore(abonne, () => noms)
  useEffect(() => {
    if (ecoute) return
    ecoute = true
    relis()
    document.addEventListener('visibilitychange', auRetour)
    window.addEventListener('focus', auRetour)
  }, [])
  return nomCompte
}
// Renommer : '' = retour au défaut. Rend la promesse de l'appel (le message du serveur en cas de refus).
export async function renommeCompte(kind, n, nom) {
  const r = await api('PUT', `/api/comptes/noms/${kind}/${n}`, { nom })
  pose(r?.noms)
  return r
}
