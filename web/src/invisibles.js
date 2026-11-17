// Caractères invisibles, par CATÉGORIES Unicode (leçon 168) : la liste de la mémoire (lib/memoire.mjs) et de la garde du
// texte risqué de la barre d'envoi (lib/garde-envoi.mjs, qui cherche les motifs sur le texte nettoyé). Module sans
// dépendance de Node : chargeable aussi par l'écran.
// Retirés : contrôles, format (direction, étiquettes U+E0000…, invisibles), usage privé, non attribués, moitiés de
// caractère, sélecteurs de variante (un octet caché par sélecteur), remplissages invisibles (Hangul, khmer, mongol).
export const INVISIBLES = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu

// Un texte sans invisibles, ligne par ligne (retours à la ligne, espaces et indentation gardés), bords nettoyés : ce que
// la garde de la barre d'envoi examine (le texte envoyé, lui, reste celui d'Orkun).
export const visible = (texte) => {
  const s = String(texte ?? '')
  return (typeof s.toWellFormed === 'function' ? s.toWellFormed() : s)
    .split('\n')
    .map((l) => l.replace(INVISIBLES, ''))
    .join('\n')
    .trim()
}
