// Faux agent pour les essais : le champ de saisie de Claude Code tel que mesuré le 13/11 sur la version 2.1.323
// (test/correctif-consigne/sonde-*.mjs). Collage encadré (il le demande, comme Claude : tmux `paste-buffer -p` l'encadre
// alors), replié en « [Pasted text #N +M lines] » au-delà de 800 caractères ou de 2 retours à la ligne, sinon recopié
// dans le champ ; le champ est coupé à la largeur de la console et n'en montre que les DERNIÈRES lignes — au plus
// max(3, ⌊(hauteur − 12) / 2⌋), le curseur au bout : le début d'un message plus haut que ça n'est jamais dessiné.
// Entrée hors d'un collage = envoi : le texte envoyé (collages repliés remis en entier) est ajouté, en une ligne JSON,
// au fichier donné en argument, et le champ se vide. Ctrl+C quitte.
// Usage : node champ-borne.mjs <fichier des envois>[\n<journal>[\n<fichier d'en-tête du hook>]]
// (un seul argument, lignes séparées : le faux `claude` du smoke passe le contenu de `.champ-borne`, 13/11.)
//  - <journal> : chaque envoi y est aussi écrit comme Claude Code l'écrit (ligne `user`, heure de l'envoi), pour les
//    essais qui demandent à Meydan si l'agent a déjà reçu un message (flush) ;
//  - <fichier d'en-tête du hook> : au PREMIER collage reçu, une question surgit (hook « needs » de la console, avant que
//    le collage ne soit dessiné), comme une demande de l'agent entre le collage et l'Entrée de Meydan.
import fs from 'node:fs'

const [sortie, journal, enTete] = String(process.argv[2] || '').split('\n')
let question = !!enTete
const DEBUT = '\x1b[200~'
const FIN = '\x1b[201~'
let champ = ''
let envois = 0
const replies = [] // contenu des collages repliés, dans l'ordre de leurs marques
let collage = null // collage en cours de réception
let tampon = ''

function dessine() {
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  const largeur = Math.max(10, cols - 4)
  const lignes = []
  for (const par of champ.split('\n')) {
    if (!par) lignes.push('')
    for (let i = 0; i < par.length; i += largeur) lignes.push(par.slice(i, i + largeur))
  }
  const vues = lignes.slice(-Math.max(3, Math.floor((rows - 12) / 2))).map((l, i) => (i ? '  ' : '❯ ') + l)
  const trait = '─'.repeat(Math.min(cols, 60))
  // Redessiné en place (curseur en haut, lignes effacées au bout) : rien ne part dans l'historique de tmux, comme le champ
  // de Claude, qui ne fait jamais défiler l'écran pour lui.
  process.stdout.write('\x1b[H' + ['  (faux Claude : champ borné)', `  envois : ${envois}`, trait, ...vues, trait].map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J')
}
function envoie() {
  const texte = champ.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, k) => replies[k - 1] ?? m)
  envois++
  if (sortie) fs.appendFileSync(sortie, JSON.stringify(texte) + '\n')
  if (journal) fs.appendFileSync(journal, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: texte } }) + '\n')
  champ = ''
}
// La question qui surgit : le hook part et sa réponse arrive avant que le collage ne se dessine.
async function questionSurgit() {
  question = false
  const [nom, valeur] = fs.readFileSync(enTete, 'utf8').trim().split(/:\s*/)
  await fetch(`http://127.0.0.1:${process.env.MEYDAN_PORT}/hook/${process.env.MEYDAN_ID}/needs`, { method: 'POST', headers: { [nom]: valeur }, body: JSON.stringify({ message: 'Question du faux agent' }) }).catch(() => {})
}

process.stdin.setRawMode(true)
process.stdout.write('\x1b[?2004h\x1b[2J')
process.stdout.on('resize', dessine)
process.stdin.on('data', async (d) => {
  tampon += d.toString('utf8')
  let colle = false
  for (;;) {
    if (collage !== null) {
      const f = tampon.indexOf(FIN)
      if (f < 0) {
        const garde = Math.max(0, tampon.length - FIN.length + 1) // une fin de collage coupée entre deux lectures
        collage += tampon.slice(0, garde)
        tampon = tampon.slice(garde)
        break
      }
      collage = (collage + tampon.slice(0, f)).replace(/\r\n?/g, '\n') // tmux remplace les retours à la ligne par \r
      tampon = tampon.slice(f + FIN.length)
      const n = (collage.match(/\n/g) || []).length
      if (collage.length > 800 || n > 2) {
        replies.push(collage)
        champ += `[Pasted text #${replies.length}${n ? ` +${n} lines` : ''}]`
      } else champ += collage
      collage = null
      colle = true
      continue
    }
    const d0 = tampon.indexOf(DEBUT)
    const e = tampon.lastIndexOf('\x1b')
    const coupe = d0 >= 0 ? d0 : e >= 0 && tampon.length - e < DEBUT.length ? e : tampon.length // début de collage coupé
    for (const ch of tampon.slice(0, coupe)) {
      if (ch === '\r') envoie()
      else if (ch === '\x03') process.exit(0)
      else if (ch >= ' ') champ += ch
    }
    if (d0 < 0) {
      tampon = tampon.slice(coupe)
      break
    }
    tampon = tampon.slice(d0 + DEBUT.length)
    collage = ''
  }
  if (colle && question) await questionSurgit()
  dessine()
})
dessine()
