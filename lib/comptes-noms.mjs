// Noms des comptes Claude / Codex. Décision d'Orkun du 17/11, comptes-3 (« Nom des comptes ») : « Donner des noms »
// (docs/volets/comptes.md:101). Il n'a pas donné les noms : il les donne lui-même, dans le panneau d'usage des comptes
// (web/src/Comptes.jsx) ; « Compte 1 » / « Compte 2 » d'office. Gardés côté serveur : les mêmes sur tous ses écrans.
//
// Contrat (le serveur branche `api` dans `api()` de server.mjs, sous la porte de session et `originOk`) :
//   GET  /api/comptes/noms                → 200 { noms: { claude: { '1'?: nom, '2'?: nom }, codex: { … } } }
//                                           (seulement les noms donnés ; absent = « Compte N » à l'écran)
//   PUT  /api/comptes/noms/<type>/<n>     { nom } → 200 { noms } ; nom vide (après nettoyage) = retour au défaut.
//   Refus 400 : type autre que claude / codex, compte autre que 1 / 2, nom qui n'est pas une chaîne, nom de plus de
//   24 caractères (comptés en points de code, après nettoyage ; jamais coupé en silence).
// Nettoyage : celui des faits de la mémoire (`nettoie` de lib/memoire.mjs, par CATÉGORIES Unicode, leçon 168) : blancs
// ramenés à une espace, contrôles / format / usage privé / non attribués / moitiés de caractère / sélecteurs de variante
// / remplissages invisibles RETIRÉS, espaces de bord retirées ; ce qu'Orkun voit est exactement ce qui est gardé. Un nom
// sans caractère visible vaut un nom vide (lib/nom-libre.mjs).
// Fichier : DATA/comptes-noms.json (0600), écrit par fichier temporaire puis renommage (lib/fichier-etat.mjs). Absent =
// aucun nom ; illisible, autre chose qu'un fichier ordinaire (lien, FIFO), trop gros ou de forme inattendue = mis de
// côté sous un autre nom AVANT toute écriture, et dit au journal (leçon 248).
import path from 'node:path'
import { ecritAtomique, lisJson, deCote } from './fichier-etat.mjs'
import { longueur, nomLibre } from './nom-libre.mjs'

export const NOM_MAX = 24
const TYPES = ['claude', 'codex']
const COMPTES = ['1', '2']
const refus = (message, code = 400) => Object.assign(new Error(message), { code })

// Un nom lu ou reçu → le nom gardé ('' = le défaut), ou null s'il est refusé.
export function nomPropre(v) {
  const t = nomLibre(v)
  return t === null || longueur(t) > NOM_MAX ? null : t
}
// La forme gardée : { claude: { '1': 'x' }, codex: {} }, seulement des noms propres non vides.
const vide = () => Object.fromEntries(TYPES.map((k) => [k, {}]))
function bienForme(brut) {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return null
  const noms = vide()
  for (const [k, v] of Object.entries(brut)) {
    if (!TYPES.includes(k) || !v || typeof v !== 'object' || Array.isArray(v)) return null
    for (const [n, nom] of Object.entries(v)) {
      if (!COMPTES.includes(n) || nomPropre(nom) !== nom || !nom) return null
      noms[k][n] = nom
    }
  }
  return noms
}

export function ouvreNomsComptes({ DATA, send, readJson }) {
  const FICHIER = path.join(DATA, 'comptes-noms.json')
  let noms = vide()
  // Absent (premier lancement) : aucun nom. Illisible : déjà mis de côté par lisJson. Lisible mais de forme inattendue :
  // mis de côté aussi, jamais écrasé par une liste vide.
  const lu = lisJson(FICHIER, { etiquette: 'comptes-noms' })
  if (lu !== undefined && lu !== null) {
    const bons = bienForme(lu?.noms)
    if (bons) noms = bons
    else deCote(FICHIER, 'de forme inattendue (noms d’office)', { etiquette: 'comptes-noms' })
  }
  // La liste d'APRÈS est écrite d'abord, puis seulement posée en mémoire (un disque plein laisse les deux d'accord).
  function ecrit(apres) {
    ecritAtomique(FICHIER, JSON.stringify({ noms: apres }, null, 2) + '\n', { etiquette: 'comptes-noms' })
    noms = apres
  }
  async function api(req, res, parts, m) {
    if (parts.length === 3 && m === 'GET') return send(res, 200, { noms })
    if (parts.length === 5 && m === 'PUT') {
      const [, , , kind, n] = parts
      if (!TYPES.includes(kind)) throw refus('type de compte inconnu (claude ou codex)')
      if (!COMPTES.includes(n)) throw refus('compte inconnu (1 ou 2)')
      const corps = await readJson(req)
      const nom = nomPropre(corps?.nom)
      if (nom === null) throw refus(typeof corps?.nom === 'string' ? `nom trop long (${NOM_MAX} caractères au plus)` : 'nom manquant')
      const apres = { ...noms, [kind]: { ...noms[kind] } }
      if (nom) apres[kind][n] = nom
      else delete apres[kind][n] // vide : retour à « Compte N »
      ecrit(apres)
      return send(res, 200, { noms })
    }
    return send(res, 404, { error: 'route inconnue' })
  }
  return { api, noms: () => noms }
}
