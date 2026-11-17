// Garde du texte risqué dans la barre d'envoi (le message tapé pour une console : POST /api/envois/<console>/message).
// Décision d'Orkun du 17/11, ordres-4 : « Oui, avec le même risques(), dans un lot à part » (docs/volets/ordres.md:157).
//
// Même règle que la barre d'ordres (lib/ordres.mjs : risques(), confirmation par empreinte), tenue par le SERVEUR (leçon
// 42 : un avertissement à l'écran n'est pas une protection) :
//   - un texte où `risques()` voit rm -rf, sudo, curl | sh, .env, un fichier de secrets, --dangerously…, git push --force…
//     ne part pas au premier appui : 409 avec les passages cités et une empreinte ;
//   - le second appui renvoie l'empreinte : elle ne vaut que pour CETTE console et CE texte exact (pièces jointes
//     comprises), et n'est calculable que par ce serveur (clé propre au processus) ; tout autre texte → 409 de nouveau.
// La DÉTECTION se fait sur le texte nettoyé : sans invisibles (mêmes catégories que la mémoire et les ordres : un « sudo »
// coupé par une espace de largeur nulle est vu), puis NFKC (« ｓｕｄｏ » en pleine chasse est vu) ; les passages montrés sont
// ceux du texte nettoyé. Le texte ENVOYÉ reste celui d'Orkun (le seul nettoyage de `messageText`) : choix de
// l'orchestrateur du 17/11 (les emoji composés, le ZWNJ persan et les drapeaux partent intacts). L'empreinte est liée au
// texte qui part.
import crypto from 'node:crypto'
import { risques } from './ordres.mjs'
import { visible } from '../web/src/invisibles.js'

const CLE = crypto.randomBytes(32)

const empreinte = (consoleId, texte) => crypto.createHmac('sha256', CLE).update(`${consoleId}\n${texte}`).digest('base64url').slice(0, 24)

// null : le message peut partir. Sinon le corps du 409 : { error, risques: [{ motif, passage }], confirmation }.
// `texte` : le message EXACT qui sera collé.
export function gardeEnvoi(consoleId, texte, confirme) {
  const r = risques(visible(texte).normalize('NFKC'))
  if (!r.length) return null
  const e = empreinte(consoleId, texte)
  const a = Buffer.from(typeof confirme === 'string' ? confirme : '')
  const b = Buffer.from(e)
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return null
  const motifs = [...new Set(r.map((x) => x.motif))].join(', ')
  return { error: `Texte risqué (${motifs}) : il part au second appui. Si la barre ne propose pas « Confirmer », recharge la page.`, risques: r, confirmation: e }
}
