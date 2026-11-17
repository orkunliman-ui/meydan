// Plafond de mémoire pour l'ouverture de consoles. Décision d'Orkun du 17/11, raccourcis-3 (« Plafond global de
// consoles ») : « refuser sous 4 Go de mémoire disponible » (recommandation acceptée ; docs/volets/raccourcis.md:339,
// mesures : test/volets/raccourcis/mesure-memoire.md).
//
// Contrat (le serveur fait le reste) :
//   disponibleMo(texte?) → Mo disponibles lus dans /proc/meminfo (ligne `MemAvailable`, PAS `MemFree` : la machine a
//     ~1,4 Go « libres » et ~18 Go « disponibles », le cache se rend à la demande), ou null si illisible.
//   seuilMo(env?) → le seuil en Mo : `MEYDAN_PLAFOND_MO` (défaut 4096 ; 0 = pas de plafond). Valeur absente ou vide =
//     défaut ; autre chose qu'un entier en chiffres = défaut aussi (dit au journal), jamais « pas de plafond ».
//   verifie({ env?, lire? }) → rien si l'ouverture passe ; lève une erreur { code: 503, message } sinon. Message en
//     français, chiffré, dit à l'écran tel quel par chaque entrée de l'interface et par `bin/meydan` (capitaine).
//   message(dispoMo, seuil) → la phrase de refus.
//   `MEYDAN_PLAFOND_MEMINFO` (essais seulement) : un autre fichier à lire à la place de /proc/meminfo, pour montrer la
//     vraie phrase (« 3,2 Go disponibles, il en faut 4 ») sans charger la machine.
//
// 503 (service indisponible) plutôt que 409 : le refus ne tient pas à la demande ni à l'état d'une console (conflit),
// mais à une ressource de la machine, passagère (« ferme des consoles, puis réessaie »). Aucun écran ne traite un 5xx à
// part (vérifié dans web/src le 17/11) ; nginx ne l'intercepte pas (deploy/nginx-meydan.example.conf).
//
// Mémoire illisible (/proc absent, format inattendu) : l'ouverture PASSE et c'est dit au journal. Un plafond qui ne sait
// pas lire ne doit pas tout bloquer ; « illisible » n'est pas « 0 Go » (leçon du 17/11, 248).
import fs from 'node:fs'

export const DEFAUT_MO = 4096
const FICHIER = '/proc/meminfo'

// « MemAvailable:   18734520 kB » → 18295 (Mo, arrondi vers le bas).
export function disponibleMo(texte) {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(String(texte ?? ''))
  return m ? Math.floor(Number(m[1]) / 1024) : null
}

// Seulement un entier écrit en chiffres (0, ou 1 et plus) ; « 4096.7 », « 1e3 », « -5 », « 4 Go » : le défaut, et une
// ligne au journal (relecture du 17/11 : une valeur à virgule passait, arrondie en silence).
let ditSeuil = ''
export function seuilMo(env = process.env) {
  const brut = env.MEYDAN_PLAFOND_MO
  if (brut === undefined || String(brut).trim() === '') return DEFAUT_MO
  const t = String(brut).trim()
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) {
    if (ditSeuil !== t) console.error(`[plafond] MEYDAN_PLAFOND_MO n’est pas un nombre entier de Mo (« ${t.slice(0, 40)} ») : seuil par défaut, ${DEFAUT_MO} Mo`)
    ditSeuil = t
    return DEFAUT_MO
  }
  return Number(t)
}

// En Go, une décimale au plus, virgule française : 3277 → « 3,2 » ; 4096 → « 4 ».
const go = (mo) => (Math.floor((mo / 1024) * 10) / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 })
export const message = (dispoMo, seuil) =>
  `Mémoire du VPS trop basse : ${go(dispoMo)} Go disponibles, il en faut ${go(seuil)} pour ouvrir une console. Ferme des consoles, puis réessaie.`

// Le fichier lu : MEYDAN_PLAFOND_MEMINFO (essais), sinon /proc/meminfo. Réglé, c'est dit au démarrage.
const chemin = (env) => env.MEYDAN_PLAFOND_MEMINFO || FICHIER
if (process.env.MEYDAN_PLAFOND_MEMINFO) console.error(`[plafond] mémoire lue dans ${process.env.MEYDAN_PLAFOND_MEMINFO} (MEYDAN_PLAFOND_MEMINFO), pas dans ${FICHIER}`)

let ditIllisible = ''
export function verifie({ env = process.env, lire = () => fs.readFileSync(chemin(env), 'utf8') } = {}) {
  const seuil = seuilMo(env)
  if (seuil === 0) return
  let dispo = null
  let raison = 'pas de ligne MemAvailable'
  try {
    dispo = disponibleMo(lire())
  } catch (e) {
    raison = e.message
  }
  if (dispo === null) {
    // Dit une fois par cause (le vrai chemin lu et l'erreur), pas à chaque ouverture.
    const ligne = `[plafond] ${chemin(env)} illisible (${raison}) : les consoles s'ouvrent sans contrôle de mémoire`
    if (ditIllisible !== ligne) console.error(ligne)
    ditIllisible = ligne
    return
  }
  if (dispo < seuil) {
    console.error(`[plafond] ouverture refusée : ${dispo} Mo disponibles, seuil ${seuil} Mo`)
    throw Object.assign(new Error(message(dispo, seuil)), { code: 503 })
  }
}
