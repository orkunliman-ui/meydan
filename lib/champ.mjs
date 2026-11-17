// Le champ de saisie d'un agent, vu par Meydan (17/11, chasse « équipes » n°15) : Orkun a-t-il commencé à y écrire
// sans valider ? Un réveil d'équipe (ou un message d'ordre, un tour de boucle) collé par-dessus partait avec son Entrée
// et validait les deux — la leçon du 10/11 (« un essai manuel … a réveillé le capitaine et validé un texte que j'avais
// laissé dans son champ ») n'avait qu'une règle de conduite, aucune garde dans le code.
// Le signal vient de ce que Meydan sait sûrement : les touches qu'Orkun envoie par son terminal (`/ws/term`). Lire le
// champ à l'écran ne suffit pas comme premier signal : un champ vide de Claude Code affiche une suggestion
// (« ❯ Try "fix lint errors" », relevé sur un vrai Claude le 13/11, test/correctif-consigne/resultats/), qu'une capture
// sans couleurs ne distingue pas d'un texte tapé. L'écran sert seulement à RELÂCHER la garde (champVide), jamais à la
// poser : une erreur de lecture retarde un message, elle n'en valide jamais un.
// Ce module ne connaît ni tmux ni HTTP.

const ESC = '\x1b'
const DEBUT_COLLAGE = '\x1b[200~'
const FIN_COLLAGE = '\x1b[201~'

// Longueur d'une séquence d'échappement qui commence à `i` (touches fléchées, souris, focus, Alt+touche, et les RÉPONSES
// qu'xterm.js renvoie seul aux questions de tmux à l'attache : DA, position du curseur, XTVERSION en DCS…) : aucune
// n'écrit de texte dans le champ. CSI : ESC [ paramètres intermédiaires final ; SS3 : ESC O x ; OSC : ESC ] … BEL ou ST ;
// DCS, SOS, PM, APC : ESC P / X / ^ / _ … ST (relecture du volet : sautées à deux caractères, leur contenu comptait
// comme une frappe et retenait les réveils d'une console qu'Orkun venait seulement d'ouvrir).
function sequence(s, i) {
  const c = s[i + 1]
  if (c === '[') {
    let j = i + 2
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
    return Math.min(s.length, j + 1) - i
  }
  if (c === 'O') return Math.min(3, s.length - i)
  if (c === ']' || c === 'P' || c === 'X' || c === '^' || c === '_') {
    const bel = c === ']' ? s.indexOf('\x07', i) : -1
    const st = s.indexOf('\x1b\\', i + 2)
    const fin = [bel < 0 ? Infinity : bel + 1, st < 0 ? Infinity : st + 2].reduce((a, b) => Math.min(a, b))
    return (fin === Infinity ? s.length : fin) - i
  }
  return Math.min(2, s.length - i) // Échap seule, ou Alt+touche
}

// Ce qu'une frappe d'Orkun fait au champ : 'tape' (du texte y entre : caractère, collage), 'vide' (Entrée hors d'un
// collage : envoyé ; Ctrl+C : effacé), ou null (rien de sûr : flèches, souris, Retour arrière, Tab…). La dernière action
// du morceau l'emporte (« abc⏎ » = vide, « ⏎abc » = tape). Entrée juste après « \ » n'envoie pas : Claude Code y passe à la
// ligne dans le champ (relecture de sécurité du volet : la garde se levait et le réveil partait avec le texte) ;
// `precedent` : le dernier caractère du morceau d'avant (une touche par message, le plus souvent).
export function frappe(s, precedent = '') {
  let etat = null
  let avant = precedent
  for (let i = 0; i < s.length; ) {
    if (s.startsWith(DEBUT_COLLAGE, i)) {
      const j = s.indexOf(FIN_COLLAGE, i + DEBUT_COLLAGE.length)
      if ((j < 0 ? s.slice(i + DEBUT_COLLAGE.length) : s.slice(i + DEBUT_COLLAGE.length, j)).length) etat = 'tape'
      i = j < 0 ? s.length : j + FIN_COLLAGE.length
      continue
    }
    if (s[i] === ESC) {
      i += sequence(s, i)
      continue
    }
    const k = s.charCodeAt(i)
    if (s[i] === '\r') etat = avant === '\\' ? 'tape' : 'vide'
    else if (k === 3) etat = 'vide'
    else if (k >= 0x20 && k !== 0x7f) etat = 'tape'
    avant = s[i]
    i++
  }
  return etat
}

// Le champ est-il VISIBLEMENT vide sur cet écran (capture sans couleurs) ? La dernière invite d'agent (« ❯ » de Claude,
// « › » de Codex) n'est suivie de rien, ni sur sa ligne ni sur les suivantes jusqu'au trait du bas du champ. Faux dans le
// doute (pas d'invite, suggestion affichée, menu ouvert) : la garde reste.
export function champVide(ecran) {
  const lignes = String(ecran ?? '').split('\n')
  let k = -1
  for (let i = lignes.length - 1; i >= 0 && k < 0; i--) if (/^\s*[❯›](?:\s|$)/.test(lignes[i])) k = i
  if (k < 0) return false
  if (lignes[k].replace(/^\s*[❯›]/, '').trim()) return false
  for (let i = k + 1; i < lignes.length && !/^\s*─/.test(lignes[i]); i++) if (lignes[i].trim()) return false
  return true
}
