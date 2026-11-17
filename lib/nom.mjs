// Le nom de la personne pour qui travaillent les agents, tel que le disent leurs consignes, briefs et messages
// (« Orkun te confie une mission », « validé par Orkun »…). Réglable par MEYDAN_NOM (dépôt public, 17/11) ; défaut :
// « Orkun », et avec ce nom tout ce qui est produit reste identique à l'octet près (test/volets/nom-reglable).
//
// Le nom part dans des terminaux et des invites d'agents : une ligne, 40 caractères au plus, sans caractère de contrôle
// ni invisible, sans autre blanc que l'espace ordinaire entre deux mots. Sinon le module refuse de se charger, donc le
// serveur de démarrer, avec la raison.
// Module sans dépendance de Node hors `process.env` : la liste des invisibles est celle de web/src/invisibles.js.
import { userInfo } from 'node:os'
import { INVISIBLES } from '../web/src/invisibles.js'

export const NOM_DEFAUT = (() => {
  try {
    const u = userInfo().username.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 40)
    return u ? u[0].toUpperCase() + u.slice(1) : 'Moi'
  } catch {
    return 'Moi'
  }
})()
export const NOM_MAX = 40
const INVISIBLE = new RegExp(INVISIBLES.source, 'u') // sans « g » : test() ne garde pas d'état d'un appel à l'autre

// Rend le nom s'il est valable, sinon lève une erreur qui dit pourquoi.
export function valideNom(valeur) {
  const s = String(valeur)
  const pourquoi = !s
    ? 'vide'
    : [...s].length > NOM_MAX
      ? `plus de ${NOM_MAX} caractères`
      : /[^\S ]/u.test(s)
        ? 'retour à la ligne, tabulation ou blanc spécial : une seule ligne, espaces ordinaires seulement'
        : INVISIBLE.test(s)
          ? 'caractère de contrôle ou invisible'
          : s !== s.trim() || s.includes('  ')
            ? 'espace en bord de nom ou espaces doublées'
            : ''
  if (pourquoi) throw new Error(`MEYDAN_NOM invalide (${pourquoi}) : « ${apercu(s)} »`)
  return s
}
// La valeur refusée, lisible dans un journal : blancs spéciaux et invisibles écrits <U+XXXX>, 60 caractères au plus.
const apercu = (s) =>
  [...s.slice(0, 60)].map((c) => (/[^\S ]/u.test(c) || INVISIBLE.test(c) ? `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>` : c)).join('') + (s.length > 60 ? '…' : '')

export const NOM = process.env.MEYDAN_NOM === undefined ? NOM_DEFAUT : valideNom(process.env.MEYDAN_NOM)

// Élision devant une voyelle (accentuée ou non) ou un h (pris pour muet : d'Hugo, d'Hélène), et devant un y suivi d'une
// consonne (d'Yves ; mais de Yann). Le reste (consonne, chiffre, autre écriture) : « de », « que ».
const V = 'aeiouàâäéèêëîïôöùûüæœ'
const ELISION = new RegExp(`^(?:[${V}h]|y[^${V}y])`, 'iu')
export const elide = (nom) => ELISION.test(nom)

// « d'Orkun » / « de Bob », « qu'Orkun » / « que Bob ». `apostrophe` : celle de la phrase d'origine, droite (') ou
// typographique (’). « à Orkun » ne change jamais de forme : `à ${NOM}`.
export const deNom = (apostrophe = "'") => (elide(NOM) ? `d${apostrophe}${NOM}` : `de ${NOM}`)
export const queNom = (apostrophe = "'") => (elide(NOM) ? `qu${apostrophe}${NOM}` : `que ${NOM}`)

// Gabarits des rôles (agents/*.md, equipage.loadRoles) : {{nom}}, {{de_nom}}, {{que_nom}}, apostrophe droite.
// Remplacement par fonction : un « $& » dans un nom reste du texte.
const GABARITS = { nom: () => NOM, de_nom: () => deNom(), que_nom: () => queNom() }
export const remplaceNom = (texte) => texte.replace(/\{\{(nom|de_nom|que_nom)\}\}/g, (_, k) => GABARITS[k]())
