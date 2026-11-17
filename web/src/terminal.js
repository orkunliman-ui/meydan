// Le peu que la console du téléphone (MobileConsole.jsx) partage avec le terminal (Term.jsx), sans charger xterm : Term.jsx
// n'arrive qu'à l'affichage d'un terminal (differe.js), la console du téléphone s'ouvre souvent en discussion.

export const TAILLE_MIN = 9
export const TAILLE_MAX = 22

// Dépose dans le terminal ce que le presse-papiers contient, et rend ce qu'il faut en dire à l'écran : la LONGUEUR
// déposée (jamais le contenu : ce peut être un secret, collé dans une saisie masquée), ou que le presse-papiers était vide.
// Orkun, 10/11 : une clé copiée depuis une page web arrivait vide dans un `read -s`, sans que rien ne le dise.
// Les retours à la ligne du début et de la fin sont retirés : coller ne valide jamais rien (une copie depuis une page en
// ajoute souvent ; dans un programme qui lit une ligne, celui du début validait une ligne vide).
export function depose(paste, brut) {
  const texte = String(brut ?? '').replace(/^[\r\n]+|[\r\n]+$/g, '')
  if (!texte) return 'Presse-papiers vide : rien collé'
  paste(texte)
  const lignes = texte.split(/\r?\n/).length
  return `Collé : ${texte.length} caractère${texte.length > 1 ? 's' : ''}${lignes > 1 ? `, ${lignes} lignes` : ''}`
}
