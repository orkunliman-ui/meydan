// Ce qu'on tape dans un terminal pendant que sa liaison est coupée (chasse du 17/11, gravité 2 : « Texte tapé dans un
// terminal perdu en silence pendant que sa liaison est coupée ». Le Mac qui sort de veille, le Wi-Fi qui saute, Meydan
// relancé : jusqu'à 8 s sans liaison, et tout ce qui était tapé ou collé partait dans le vide, le terminal ayant toujours
// l'air vivant). Les entrées attendent ici et partent, dans l'ordre et une seule fois, dès que la liaison revient (au
// premier dessin de tmux). La dalle dit « Liaison coupée » et combien attend ; « Jeter » vide la file.
// Ne part pas seule, mais attend « Envoyer » ou « Jeter » sur la dalle : une frappe plus vieille que AGE_REJEU, une
// frappe faite alors que le terminal n'avait rien reçu depuis plus de AGE_REJEU (Mac sorti d'une longue veille, console
// relancée pendant la coupure : l'écran qu'Orkun voyait n'était plus le vrai, une Entrée tapée validerait un choix apparu
// entre-temps — relecture de sécurité du 17/11), et toute file où une entrée a été refusée. Sous ce seuil (le plus long
// délai entre deux essais de reconnexion est 8 s), c'est une frappe en avance comme sur une liaison lente, elle part.
// Module sans React ni xterm : Term.jsx s'en sert à deux endroits (envoi, ouverture de la liaison) et les essais aussi.

// Borne de la file, en caractères. Au-delà, l'entrée entière est refusée (jamais coupée en deux : un collage tronqué
// pourrait valider une commande partielle), et TOUT ce qui suit aussi jusqu'à « Jeter » ou l'envoi (sinon l'Entrée
// tapée après le collage refusé validerait le début de la commande) ; la dalle le dit.
export const BORNE_ENTREES = 64 * 1024

// Les gestes de la souris (rapports SGR « ESC[<b;x;yM », anciens rapports « ESC[M » + 3 octets) et du focus (ESC[I,
// ESC[O) visent l'écran d'avant la coupure, qui ne sera plus le même : ils ne sont pas rejoués.
const GESTE = /^\x1b\[(?:<\d+;\d+;\d+[Mm]|M[\s\S]{3}|[IO])$/

export const AGE_REJEU = 10000 // ms

export function fileEntrees(borne = BORNE_ENTREES) {
  let file = []
  let poids = 0
  let refuse = 0
  let depuis = 0 // quand la plus ancienne entrée a été gardée
  let aConfirmer = false // retenue une fois : le reste jusqu'à « Envoyer » ou « Jeter », même après une autre coupure
  return {
    // Garde une entrée (sans son préfixe de message). Rend vrai si elle attend, faux si elle est écartée.
    garde(d) {
      if (GESTE.test(d)) return false
      if (refuse || poids + d.length > borne) {
        refuse += d.length
        return false
      }
      if (!file.length) depuis = Date.now()
      file.push(d)
      poids += d.length
      return true
    },
    // Envoie tout ce qui attend, dans l'ordre, puis oublie. Rend le nombre de caractères partis.
    vide(envoie) {
      const parties = file
      const n = poids
      file = []
      poids = 0
      refuse = 0
      aConfirmer = false
      for (const d of parties) envoie(d)
      return n
    },
    jette() {
      file = []
      poids = 0
      refuse = 0
      aConfirmer = false
    },
    // La file attend la personne (« Envoyer » / « Jeter ») : vrai jusqu'à `vide` ou `jette`.
    retiens() {
      aConfirmer = true
    },
    get aConfirmer() {
      return aConfirmer
    },
    // Combien d'Entrées attendent (dit sur la dalle : le texte, lui, n'est jamais montré, ce peut être un secret).
    get entrees() {
      return file.reduce((n, d) => n + (d.match(/\r/g)?.length ?? 0), 0)
    },
    get poids() {
      return poids
    },
    get refuse() {
      return refuse
    },
    get age() {
      return file.length ? Date.now() - depuis : 0
    },
  }
}

// Ce que la dalle en dit (`null` : rien à dire, la liaison est là). `retenue` : revenue, la frappe attend « Envoyer ».
export function texteLiaison({ coupee, retenue = false, poids, refuse, entrees = 0 }) {
  const n = `${poids} caractère${poids > 1 ? 's' : ''}${entrees ? ` dont ${entrees} Entrée${entrees > 1 ? 's' : ''}` : ''}`
  const trop = refuse ? ` · ${refuse} de trop, non gardé${refuse > 1 ? 's' : ''}` : ''
  if (retenue) return `Liaison revenue. Tapé pendant la coupure : ${n}, pas envoyé${poids > 1 ? 's' : ''} (l’écran a pu changer)${trop}`
  if (!coupee) return null
  return `Liaison coupée, reconnexion…${poids ? ` · ${n} en attente` : ''}${trop}`
}
