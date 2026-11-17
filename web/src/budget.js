// Volet « quota » (17/11/2026). Demande d'Orkun, mot pour mot : « Go pour tout », sur « Le quota par console et le coût
// par agent, si tu les veux » (idées reprises de Paperclip : « quota par console avec une alerte à 80 % » et « coût par
// agent avec une validation avant d'exécuter »). Contrat : docs/volets/quota.md, § 2.
//
// Le magasin de l'interface, un seul pour la page (même forme que traits.js) : `GET /api/budget` au premier lecteur et à
// chaque `snapshot` du flux (liaison refaite), puis les événements `{ type: 'budget', usages?, equipes?, retires?, budgets,
// reglages, demandes }` relayés par lib.js (« meydan:flux ») : usages et équipes fusionnés, le reste remplacé.
// Une réponse `{}` ou une erreur (404 des serveurs factices des autres essais, leçon 182) laisse l'état vide, sans bruit.
import { useSyncExternalStore } from 'react'
import { api } from './lib.js'

const VIDE = Object.freeze({ pret: false, usages: Object.freeze({}), equipes: Object.freeze({}), budgets: Object.freeze({}), reglages: Object.freeze({}), demandes: Object.freeze([]) })
let etat = VIDE
const ecoutes = new Set()
let vivant = false

const objet = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null)
const estDemande = (d) => !!d && typeof d.id === 'string' && (d.type === 'budget' || d.type === 'lancement')
const demandesDe = (x) => (Array.isArray(x) ? x.filter(estDemande) : null)

const pose = (f) => {
  const neuf = f(etat)
  if (neuf === etat) return
  etat = neuf
  ecoutes.forEach((e) => e())
}

// Ce qu'un message du serveur change (réponse de GET, événement du flux ou réponse d'un POST) : chaque champ absent ou mal
// formé garde l'état d'avant.
function applique(m) {
  return (s) => {
    const usages = objet(m.usages), equipes = objet(m.equipes), budgets = objet(m.budgets), reglages = objet(m.reglages), demandes = demandesDe(m.demandes)
    const retires = Array.isArray(m.retires) ? m.retires : []
    if (!usages && !equipes && !budgets && !reglages && !demandes && !retires.length) return s
    const u = usages || retires.length ? { ...s.usages, ...usages } : s.usages
    for (const id of retires) delete u[id]
    return {
      ...s,
      usages: u,
      equipes: equipes ? { ...s.equipes, ...equipes } : s.equipes,
      budgets: budgets ?? s.budgets,
      reglages: reglages ?? s.reglages,
      // Même liste qu'avant : même référence (les compteurs T'ATTEND d'App et de Rail ne se redessinent pas pour rien).
      demandes: demandes && JSON.stringify(demandes) !== JSON.stringify(s.demandes) ? demandes : s.demandes,
    }
  }
}

// Pendant une lecture, les événements reçus entre-temps sont notés et rejoués sur sa réponse : la réponse peut avoir été
// prise au serveur AVANT eux (une demande déjà répondue ne revient pas).
let lecture = null
function charge() {
  const notes = (lecture = [])
  api('GET', '/api/budget').then(
    (j) => {
      if (lecture !== notes) return // une relecture plus récente est partie : c'est elle qui compte
      lecture = null
      if (!vivant) return
      const r = objet(j)
      // `{}` (serveur factice) : rien n'est prêt, l'interface du volet reste absente.
      if (!r || !('budgets' in r || 'usages' in r || 'demandes' in r)) return
      pose(() => notes.reduce((s, f) => f(s), { ...VIDE, pret: true, usages: objet(r.usages) ?? {}, equipes: objet(r.equipes) ?? {}, budgets: objet(r.budgets) ?? {}, reglages: objet(r.reglages) ?? {}, demandes: demandesDe(r.demandes) ?? [] }))
    },
    () => lecture === notes && (lecture = null), // 404, liaison coupée : l'état d'avant reste
  )
}
const change = (f) => {
  lecture?.push(f)
  pose(f)
}
const recu = (e) => {
  const m = e.detail
  if (m?.type === 'snapshot') charge()
  else if (m?.type === 'budget') change((s) => ({ ...applique(m)(s), pret: true }))
}
function abonne(f) {
  ecoutes.add(f)
  if (!vivant) {
    vivant = true
    window.addEventListener('meydan:flux', recu)
    charge()
  }
  return () => {
    ecoutes.delete(f)
    if (!ecoutes.size) {
      vivant = false
      window.removeEventListener('meydan:flux', recu)
    }
  }
}
const lis = () => etat

export function useBudget() {
  return useSyncExternalStore(abonne, lis)
}
// Ce qui t'attend du volet (budget atteint, lancement à valider) : pour les compteurs T'ATTEND. Lu seul : un usage qui
// change (un événement toutes les 5 s au plus) ne redessine pas App ni la colonne.
const lisDemandes = () => etat.demandes
export function useDemandes() {
  return useSyncExternalStore(abonne, lisDemandes)
}

// ── Les gestes (les erreurs reviennent à l'appelant, dites en clair) ──
// Poser (montant > 0) ou retirer (montant null) le budget d'une console (`c:<id>`) ou d'une équipe (`e:<id>`).
export async function regleBudget(cible, montant, unite) {
  const r = await api('POST', '/api/budget/budget', { cible, montant, unite })
  change(applique({ budgets: r?.budgets }))
  return r
}
// « Valider les lancements » d'une équipe.
export async function regleEquipe(id, valider) {
  const r = await api('POST', `/api/budget/equipes/${encodeURIComponent(id)}`, { valider })
  change(applique({ reglages: r?.reglages }))
  return r
}
// Répondre à une demande : « continuer » (budget atteint), « accepter » / « refuser » (lancement). La demande part de
// l'écran dès la réponse du serveur ; le flux confirme.
export async function repondDemande(id, choix) {
  const r = await api('POST', `/api/budget/demandes/${encodeURIComponent(id)}`, { choix })
  change((s) => ({ ...s, demandes: s.demandes.filter((d) => d.id !== id) }))
  return r
}
// Le texte ENTIER d'une demande de lancement (la carte n'en montre que 300 caractères) : exactement celui qui partira.
export async function lisDemande(id) {
  return await api('GET', `/api/budget/demandes/${encodeURIComponent(id)}`)
}
