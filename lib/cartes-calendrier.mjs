// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — Calendrier :
// « carte mois avec des entrées par jour (texte court), aujourd'hui marqué ; rien n'est envoyé ailleurs (pas d'Outlook) ».
// Données de la carte : { mois: 'AAAA-MM' | '', entrees: [{ id, jour: 'AAAA-MM-JJ', t }] }.
//   mois : le mois affiché, retenu quand Orkun navigue (« ‹ » « › ») ; '' = le mois en cours, pris à l'heure LOCALE du
//          navigateur (le serveur ne connaît pas le fuseau de l'appareil) : une carte neuve, et « Aujourd'hui », suivent le
//          mois en cours.
//   entrees : liste entière envoyée à chaque changement, validée en entier ; une demande refusée ne change rien
//          (lib/cartes.mjs applique sur une copie). Ce module n'appelle rien au dehors : aucune route, aucun envoi.
// Bornes : la carte ENTIÈRE tient en 60 Ko dans le pire cas UTF-8 (3 octets par unité de chaîne JS, identifiants de 16,
// titre de 80, coordonnées extrêmes) : 250 entrées de 60 caractères = 58 657 octets (mesuré par calendrier-api.mjs).
// Contrat (lib/cartes.mjs, registre CREATIFS) : `typesCalendrier(ctx)` rend { calendrier: { taille, defaut, applique } }.
import { ligneDe } from './cartes-checklist.mjs'

export const ENTREES_MAX = 250 // = web/src/CalendrierNode.jsx
export const ENTREE_MAX = 60 // caractères par entrée, après nettoyage ; = web/src/CalendrierNode.jsx
const ID = /^[a-z0-9]{1,16}$/
const ANNEES = [1900, 2999]
const MOIS = /^(\d{4})-(\d{2})$/
const JOUR = /^(\d{4})-(\d{2})-(\d{2})$/
const anneeOk = (a) => a >= ANNEES[0] && a <= ANNEES[1]
// Nombre de jours du mois m (1 à 12) de l'année a : le jour 0 du mois suivant (années bissextiles comprises).
const joursDuMois = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate()

export function typesCalendrier(ctx) {
  const { refus } = ctx
  const moisDe = (v) => {
    if (v === '') return ''
    const m = typeof v === 'string' ? MOIS.exec(v) : null
    if (!m || !anneeOk(+m[1]) || +m[2] < 1 || +m[2] > 12) throw refus(`mois : « AAAA-MM » attendu (années ${ANNEES[0]} à ${ANNEES[1]}), ou « » pour le mois en cours`)
    return v
  }
  // Une vraie date du calendrier : « 2026-02-30 » ou « 2026-13-01 » sont refusés.
  const jourDe = (v, n) => {
    const m = typeof v === 'string' ? JOUR.exec(v) : null
    if (!m || !anneeOk(+m[1]) || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > joursDuMois(+m[1], +m[2])) throw refus(`${n} : jour invalide (« AAAA-MM-JJ », une date qui existe)`)
    return v
  }
  return {
    calendrier: {
      taille: { w: 560, h: 520, min: { w: 360, h: 340 } },
      defaut: () => ({ mois: '', entrees: [] }),
      applique(k, corps) {
        if (corps.mois !== undefined) k.mois = moisDe(corps.mois)
        if (corps.entrees === undefined) return
        if (!Array.isArray(corps.entrees)) throw refus('entrees : une liste attendue')
        if (corps.entrees.length > ENTREES_MAX) throw refus(`${ENTREES_MAX} entrées au plus (retire d'anciennes entrées)`, 413)
        const vus = new Set()
        // Seuls id, jour et t sont gardés : les autres champs d'une entrée sont ignorés.
        k.entrees = corps.entrees.map((x, i) => {
          const n = `entrée ${i + 1}`
          if (!x || typeof x !== 'object' || Array.isArray(x)) throw refus(`${n} : un objet { id, jour, t } attendu`)
          if (typeof x.id !== 'string' || !ID.test(x.id)) throw refus(`${n} : identifiant mal formé (1 à 16 caractères a-z 0-9)`)
          if (vus.has(x.id)) throw refus(`${n} : identifiant en double`)
          vus.add(x.id)
          const jour = jourDe(x.jour, n)
          if (typeof x.t !== 'string') throw refus(`${n} : texte attendu`)
          const t = ligneDe(x.t)
          if (!t) throw refus(`${n} : texte vide`)
          if (t.length > ENTREE_MAX) throw refus(`${n} trop longue : ${ENTREE_MAX} caractères au plus`, 413)
          return { id: x.id, jour, t }
        })
      },
    },
  }
}
