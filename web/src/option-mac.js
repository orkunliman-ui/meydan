// Option sur Mac (chasse du 17/11, gravité 2 : « Alt/Option + chiffre avalé partout, même dans un champ de texte »).
// Sur Mac, Option compose les caractères : sur le clavier belge d'Orkun (17/11, mot pour mot : « belge »), Option+( = {,
// Option+Maj+( = [, Option+) = }, Option+L = |, Option+Maj+: = \ … Le raccourci Alt+1…9 / Alt+0 / Alt+↑↓ d'App.jsx
// (changer de console) les prenait AVANT tout le monde : « { » ne s'écrivait plus nulle part, ni dans un champ ni dans le
// terminal. Windows et Linux ne sont pas concernés : Alt seul n'y compose rien (AltGr = Ctrl+Alt, déjà écarté).

export const MAC = typeof navigator !== 'undefined' && /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform || '')

const SAISIE = 'input, textarea, [contenteditable]:not([contenteditable="false"])'

// Vrai quand Option + cette touche revient à la saisie qui a le clavier, et pas aux raccourcis de Meydan :
// - dans un champ de saisie, toute touche Option (elle compose, et Option+flèches y déplacent le curseur) ;
// - dans le terminal (xterm, `macOptionIsMeta: false` dans Term.jsx), une touche qui compose un caractère ; Option+flèches
//   restent au raccourci (changer de console), comme avant.
// Ailleurs (le fond du plateau, un bouton), le raccourci garde la main, Mac compris.
export function optionEcrit(e, mac = MAC) {
  if (!mac || !e.altKey) return false
  const t = e.target
  if (!t?.closest?.(SAISIE)) return false
  if (!t.closest('.xterm')) return true
  return e.key?.length === 1 || e.key === 'Dead'
}
