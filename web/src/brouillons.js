// Brouillons de la barre d'envoi, par console (chasse du 17/11, gravité 2 : « Le texte tapé dans la barre d'envoi est
// perdu dès qu'on quitte la console » : passer à une autre console par le titre, revenir à la liste, ou la console qui
// se ferme démontait la barre, et son texte avec). Le texte vit ici, hors du composant : en mémoire de la page, et dans
// sessionStorage pour survivre au rechargement de l'onglet (l'iPhone recharge une page restée en arrière-plan ; Meydan
// se recharge seul après une mise à jour). Il reste sur l'appareil. Les pièces jointes n'y sont pas (hors du défaut :
// leurs aperçus sont des adresses blob: de la barre qui part).
// Seules les barres qui le demandent s'en servent (`brouillon` d'Envoi.jsx : téléphone et discussion du PC ; pas la
// barre d'une image annotée, qui a son propre message).

const textes = new Map() // id de console → texte
const enVol = new Map() // id de console → texte en cours d'envoi : une barre (re)montée pendant l'envoi ne le reprend pas
const cle = (id) => `meydan.brouillon.${id}`

export function lisBrouillon(id) {
  let t = textes.get(id)
  if (t === undefined) {
    try {
      t = sessionStorage.getItem(cle(id)) || ''
    } catch {
      t = '' // stockage refusé : rien d'un chargement précédent
    }
  }
  const v = enVol.get(id)
  return v && t.startsWith(v) ? t.slice(v.length).trimStart() : t
}

// L'envoi de `texte` commence (`envole`) / finit (`atterrit`, `ok` : parti ; sinon il revient en tête du brouillon).
export function envole(id, texte) {
  enVol.set(id, texte)
}
export function atterrit(id, texte, ok) {
  enVol.delete(id)
  const t = lisBrouillon(id)
  if (ok) gardeBrouillon(id, t.startsWith(texte) ? t.slice(texte.length).trimStart() : t)
  else if (!t.startsWith(texte)) gardeBrouillon(id, [texte, t].filter(Boolean).join(' '))
}

export function gardeBrouillon(id, texte) {
  if (texte) textes.set(id, texte)
  else textes.delete(id)
  try {
    if (texte) sessionStorage.setItem(cle(id), texte)
    else sessionStorage.removeItem(cle(id))
  } catch {} // stockage refusé (navigation privée stricte) : le brouillon vit le temps de la page
}
