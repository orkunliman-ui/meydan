// Variantes du lot 4, posées en classe sur <html> pour que les feuilles n'aient qu'à suivre.
// Cadre des consoles qui travaillent : « b » (halo qui respire), choisi par Orkun le 11/11 ; ?vie=a|c pour revoir les
// autres. Liens d'équipe : « c » (fibre à particules), choisi par Orkun le 11/11 ; ?liens=a|b|d|e pour revoir les autres.
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
const racine = typeof document === 'undefined' ? null : document.documentElement
const lu = (cle, valides, defaut = '') => (valides.includes(params.get(cle)) ? params.get(cle) : defaut)
export const VIE = lu('vie', ['a', 'b', 'c'], 'b')
export const LIENS = lu('liens', ['a', 'b', 'c', 'd', 'e'], 'c') // c (fibre) choisi par Orkun le 11/11
if (racine) {
  racine.classList.add(`vie-${VIE}`)
  if (LIENS) racine.classList.add(`liens-${LIENS}`)
}
