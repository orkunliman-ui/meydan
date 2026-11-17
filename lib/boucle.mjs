// Boucles : un message que Meydan renvoie tout seul à un agent, jusqu'à une fin. (Écart avec Symvibe, lot 4 :
// « boucles : planifiée, agent au repos ; fin par nombre, durée ou objectif ». Orkun, 10/11 : « tu continues la suite
// du chantier pour qu’on termine ce produit completement ».)
//
// Une boucle dépense le quota d'Orkun sans lui : elle a TOUJOURS trois fins (un nombre de tours, une durée, et la
// marque que l'agent écrit quand l'objectif est atteint), des plafonds que l'écran ne peut pas dépasser, et elle
// n'envoie rien tant que l'agent n'est pas au repos (une question posée par l'agent la met en attente).

export const LIMITES = { tours: 50, heures: 12, minutes: [5, 720], texte: 4000 }
export const MARQUE = 'OBJECTIF ATTEINT'
export const REPOS_MS = 4000 // un agent est « au repos » quand il l'est depuis ce temps-là (son écran est stable, son journal écrit)
const refus = (message) => Object.assign(new Error(message), { code: 400 })
const entier = (v, min, max, defaut) => {
  if (v === undefined || v === null || v === '') return defaut
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < min || n > max) throw refus(`valeur hors limites (${min} à ${max})`)
  return n
}
const propre = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim().slice(0, max)

// Une boucle neuve, à partir de ce que l'écran envoie. `quand` : 'repos' (dès que l'agent a fini son tour), 'horaire',
// ou 'sortie' : quand un texte (`guet`) s'affiche de nouveau dans une AUTRE console (`source` : un shell qui fait
// tourner les essais, par exemple ; jamais la sienne, où le message collé citerait le texte guetté). Le serveur complète `source`, `sourceNom` et `compte` (le nombre de
// lignes qui portent déjà ce texte : elles ne déclenchent rien).
export function nouvelle(def, maintenant = Date.now()) {
  const texte = propre(def?.texte, LIMITES.texte)
  if (!texte) throw refus('message de la boucle vide')
  const quand = ['horaire', 'sortie'].includes(def?.quand) ? def.quand : 'repos'
  const minutes = quand === 'horaire' ? entier(def.minutes, LIMITES.minutes[0], LIMITES.minutes[1], 30) : 0
  const guet = quand === 'sortie' ? propre(def?.guet, 120).replace(/\n/g, ' ') : ''
  if (quand === 'sortie' && !guet) throw refus('texte à guetter vide')
  const tours = entier(def?.tours, 1, LIMITES.tours, 10)
  const heures = entier(def?.heures, 1, LIMITES.heures, 2)
  const marque = propre(def?.marque ?? MARQUE, 60).replace(/\n/g, ' ')
  return { texte, quand, minutes, guet, tours, heures, marque, n: 0, cree: maintenant, fin: maintenant + heures * 3600000, dernier: 0, prochain: maintenant, etat: 'active', raison: '' }
}

// Le message d'un tour : il dit à l'agent que c'est une boucle, où elle en est, et comment la finir.
export function message(b) {
  const fin = b.marque ? `\n\n(Message renvoyé automatiquement par Meydan. Quand tout est fait et vérifié, écris « ${b.marque} » dans ta réponse : la boucle s’arrêtera.)` : '\n\n(Message renvoyé automatiquement par Meydan.)'
  const vu = b.quand === 'sortie' && b.extrait ? `\n\nLa console « ${b.sourceNom} » vient d’afficher « ${b.guet} » :\n${b.extrait}` : ''
  return `[Meydan] Boucle, tour ${b.n + 1} sur ${b.tours} : ${b.texte}${vu}${fin}`
}

// Guet d'une sortie : le nombre de lignes de l'écran (historique compris) qui portent le texte guetté, et l'extrait à
// joindre au message (douze lignes au plus, jusqu'à la dernière qui le porte).
export const compteDans = (ecran, guet) => (guet ? String(ecran ?? '').split('\n').filter((l) => l.includes(guet)).length : 0)
// `deja` : les premières lignes qui portent le texte ont déjà été envoyées ; l'extrait commence après la dernière
// d'entre elles (vu sur un vrai agent le 11/11 : avec l'ancien échec dans l'extrait, il a répondu sur l'ancien).
export function extrait(ecran, guet, deja = 0) {
  const lignes = String(ecran ?? '').split('\n')
  const k = lignes.findLastIndex((l) => l.includes(guet))
  if (k < 0) return ''
  let debut = 0
  for (let i = 0, vues = 0; deja > 0 && i < k; i++) {
    if (lignes[i].includes(guet) && ++vues === deja) {
      debut = i + 1
      break
    }
  }
  return lignes.slice(Math.max(debut, k - 11), k + 1).map((l) => l.trimEnd()).join('\n').slice(-1500)
}
// Ce que le guet a vu : un texte nouveau déclenche le prochain tour ; un écran vidé (moins de lignes) ne déclenche rien.
// `base` : le compte au dernier message envoyé (ou à la pose de la boucle) ; l'extrait ne montre que ce qui est venu après.
export function guette(b, ecran) {
  const n = compteDans(ecran, b.guet)
  b.base = Math.min(b.base ?? b.compte, n) // écran vidé : ce qui reste a déjà été vu
  if (n > b.compte) b.declenche = true
  if (b.declenche) b.extrait = extrait(ecran, b.guet, b.base)
  const change = n !== b.compte
  b.compte = n
  return change
}

// Que faire maintenant ? `console` : { status, since } ; `reponse` : la dernière réponse de l'agent si elle vient d'être
// lue (sinon ''). Rend { action: 'rien' | 'envoie' | 'finit', raison }.
export function decide(b, console, maintenant = Date.now(), reponse = '') {
  if (!b || b.etat !== 'active') return { action: 'rien', raison: '' }
  if (console.status === 'closed') return { action: 'finit', raison: 'console terminée' }
  if (maintenant > b.fin) return { action: 'finit', raison: `durée atteinte (${b.heures} h)` }
  if (console.status !== 'ready' || maintenant - console.since < REPOS_MS) return { action: 'rien', raison: 'attend que l’agent soit au repos' }
  const revenu = console.since > b.dernier // l'agent a travaillé puis s'est reposé depuis notre dernier envoi
  if (b.n > 0 && b.marque && revenu && reponse.includes(b.marque)) return { action: 'finit', raison: 'objectif atteint' }
  if (b.n >= b.tours) return revenu ? { action: 'finit', raison: `${b.tours} tours faits` } : { action: 'rien', raison: 'dernier tour en cours' }
  if (b.quand === 'repos') return b.n === 0 || revenu ? { action: 'envoie', raison: '' } : { action: 'rien', raison: 'attend que l’agent reprenne' }
  if (b.quand === 'sortie') {
    if (!b.declenche) return { action: 'rien', raison: `guette « ${b.guet} » dans ${b.sourceNom || 'la console'}` }
    return b.n === 0 || revenu ? { action: 'envoie', raison: '' } : { action: 'rien', raison: 'attend que l’agent reprenne' } // un message à la fois
  }
  return maintenant >= b.prochain ? { action: 'envoie', raison: '' } : { action: 'rien', raison: 'attend l’heure du prochain tour' }
}

// Après un envoi réussi.
export function envoye(b, maintenant = Date.now()) {
  b.n += 1
  b.dernier = maintenant
  if (b.quand === 'horaire') b.prochain = maintenant + b.minutes * 60000
  b.declenche = false
  b.extrait = ''
  if (b.quand === 'sortie') b.base = b.compte // ce qui est déjà parti ne revient pas dans le prochain extrait
}
