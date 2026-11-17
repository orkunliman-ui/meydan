// Plateau étendu (volet du 11/11) : les cartes posées sur le plateau à côté des consoles — notes, aperçus web, panneau
// Git (serveur : lib/cartes.mjs). Elles suivent le flux d'état du serveur (/ws/events), relayé par lib.js en événement
// « meydan:flux » : pas de seconde liaison.
// Plateau créatif (volet du 13/11) : un seul magasin pour toute la page (plusieurs composants le lisent : le plateau, le
// calque des flèches…), une seule lecture et une seule écoute du flux, quel que soit le nombre de lecteurs.
import { createContext, useMemo, useSyncExternalStore } from 'react'
import { api } from './lib.js'
import { TYPES_CARTES } from './cartes-types.js'

// Ce que le plateau dit à ses cartes : vue de loin (`far`), plateau du téléphone (`tel` : tuile fixe, rien de vivant,
// aucun défilement interne, aucun cadre web), thème Réverbère (`rev`), et les actions sur les cartes.
export const CartesCtx = createContext({ far: false, tel: false, rev: true, actions: null })

// Les types de dalle du plateau : `carte-<type>` (les consoles restent `console`).
export const typeDeNoeud = (k) => `carte-${k.type}`
export const estCarte = (n) => typeof n.type === 'string' && n.type.startsWith('carte-')
// Une flèche (sansBoite) n'est pas une dalle : elle est dessinée entre ses deux bouts (Fleches.jsx).
export const estDalle = (k) => !TYPES_CARTES[k.type]?.sansBoite

// Une carte du serveur → un nœud du plateau. Un nœud porté (déplacé ou redimensionné) garde sa place locale.
export function noeudDeCarte(k, old) {
  if (old && old.data === k) return old
  const busy = old && (old.dragging || old.resizing)
  return {
    ...old,
    id: k.id,
    type: typeDeNoeud(k),
    // Une forme se prend par toute sa surface ; les autres cartes par la barre de leur cadre (Carte.jsx).
    dragHandle: TYPES_CARTES[k.type]?.sansCadre ? undefined : '.et-barre',
    data: k,
    position: busy ? old.position : { x: k.x, y: k.y },
    width: busy ? old.width : k.w,
    height: busy ? old.height : k.h,
  }
}

// ── Le magasin ──
let toutes = []
const ecoutes = new Set()
const pose = (f) => {
  toutes = f(toutes)
  ecoutes.forEach((e) => e())
}
let vivant = false
const charge = () => api('GET', '/api/cartes').then((j) => vivant && pose(() => (Array.isArray(j?.cartes) ? j.cartes : [])), () => {})
const recu = (e) => {
  const m = e.detail
  if (m?.type === 'snapshot') charge() // liaison (re)faite : on relit tout
  else if (m?.type === 'carte' && m.carte?.id) pose((ks) => (ks.some((k) => k.id === m.carte.id) ? ks.map((k) => (k.id === m.carte.id ? m.carte : k)) : [...ks, m.carte]))
  else if (m?.type === 'carte-retiree') pose((ks) => ks.filter((k) => k.id !== m.id))
}
// Le premier lecteur ouvre l'écoute et lit le serveur ; le dernier qui part la ferme.
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
const lis = () => toutes

export const actionsCartes = {
  // Rend la carte créée (l'erreur revient à l'appelant).
  cree: async (type, champs = {}) => {
    const { carte } = await api('POST', '/api/cartes', { type, ...champs })
    pose((ks) => (ks.some((k) => k.id === carte.id) ? ks : [...ks, carte]))
    return carte
  },
  // Tout de suite à l'écran, puis confirmé par le serveur (qui renvoie la carte par le flux). Rend la promesse.
  // Refusé (port refusé, note trop longue, liaison coupée) : l'écran reprend ce que le serveur a vraiment.
  patch: (id, champs) => {
    let avant
    pose((ks) => ks.map((k) => (k.id === id ? ((avant = k), { ...k, ...champs }) : k)))
    return api('PATCH', `/api/cartes/${id}`, champs).catch((e) => {
      // Les champs envoyés reprennent tout de suite leur valeur d'avant (sinon, le temps de la relecture, une carte
      // web demanderait l'aperçu d'un port refusé), puis la relecture remet ce que le serveur a vraiment.
      if (avant) pose((ks) => ks.map((k) => (k.id === id ? { ...k, ...Object.fromEntries(Object.keys(champs).map((c) => [c, avant[c]])) } : k)))
      charge()
      throw e
    })
  },
  retire: (id) => api('DELETE', `/api/cartes/${id}`),
  // Carte web : l'adresse de son aperçu (relais à jeton) → { adresse, fin }.
  apercu: (id) => api('POST', `/api/cartes/${id}/apercu`),
  // Carte git : `chemin` après /git (« », « /diff?… », « /commit »…).
  git: (id, chemin = '', methode = 'GET', corps) => api(methode, `/api/cartes/${id}/git${chemin}`, corps),
}

// Toutes les cartes du serveur, flèches comprises.
export function useToutesCartes() {
  return useSyncExternalStore(abonne, lis)
}
// Les dalles (pour le plateau : les flèches n'en sont pas) et les actions.
export function useCartes() {
  const ks = useToutesCartes()
  const cartes = useMemo(() => ks.filter(estDalle), [ks])
  return { cartes, actions: actionsCartes }
}
// Les flèches seulement (Fleches.jsx).
export function useFleches() {
  const ks = useToutesCartes()
  return useMemo(() => ks.filter((k) => !estDalle(k)), [ks])
}
