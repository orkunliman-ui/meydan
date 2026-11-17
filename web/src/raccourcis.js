// Touches seules, sur l'ordinateur (volet « raccourcis », 13/11). Orkun, 13/11 : « On est encore loin de toutes les
// fonctionnalitēs de Symvibe ». Symvibe (/docs/shortcuts) : des touches seules, réglables, pour aller vite sur le plateau.
//
// Une touche seule n'agit que quand le clavier n'est ni dans un terminal ni dans un champ (comme Ctrl+Z du plateau,
// Board.jsx), ni dans un panneau ouvert ; jamais avec Ctrl, Alt (Alt+1…9 passe d'une console à l'autre, App.jsx) ou Méta.
// Le téléphone n'en a pas (rien n'est affiché, rien n'écoute).
//
// Pour les autres volets : une fonction exportée par action (`allerAttente()`, `carteMission()`…), `brancher(id, fn)` /
// `useBranche(id, fn)` pour fournir ce que fait une action, `declarer({ id, defaut, nom })` pour en ajouter une,
// `clavierLibre(e, id)` pour savoir si une touche seule peut agir, `estBranchee(id)`, `apresAction(fn)`, et
// `toucheEnSaisie()` (vrai pendant que l'écran de réglage attend une touche : elle n'est pour personne d'autre). Espace est
// réservée au volet « ordres » (maintenir Espace pour parler) : elle n'est jamais attribuée ici.
import { useEffect, useRef, useSyncExternalStore } from 'react'

export const CLE = 'meydan.raccourcis' // localStorage : { [action]: touche } — seulement ce qui diffère du défaut

// Les actions et leur touche par défaut (minuscule pour une lettre). `detail` : ce que fait l'action, dit dans l'aide.
const actions = [
  // `suite` : l'action donne le clavier à un terminal ; la même touche, pressée de nouveau aussitôt, passe à la suivante.
  { id: 'attente', defaut: 'n', nom: 'Console suivante qui t’attend', detail: 'cadrée, le clavier dedans ; la même touche aussitôt : la suivante', suite: true },
  // Décision d'Orkun du 17/11, raccourcis-4 : « Vue carte de mission » (plus le filtre suivant de la liste). Mission.jsx.
  { id: 'mission', defaut: 'x', nom: 'Carte de mission', detail: 'toutes les consoles et les équipes d’un coup d’œil ; la même touche ou Échap pour revenir', panneau: '.mi' },
  { id: 'nouvelle', defaut: 't', nom: 'Nouvelle console', detail: 'ouvre le formulaire' },
  // `panneau` : le panneau que l'action ouvre elle-même ; ouvert, il n'empêche pas la touche (M le referme).
  { id: 'memoire', defaut: 'm', nom: 'Mémoire du projet', detail: 'de la console choisie ; Échap la referme (M aussi, hors de son champ)', panneau: '.mp' },
  { id: 'git', defaut: 'g', nom: 'Carte Git', detail: 'la montre, ou en pose une' },
  { id: 'cadrer', defaut: 'f', nom: 'Tout cadrer', detail: 'tout le plateau à l’écran' },
  { id: 'aide', defaut: '?', nom: 'Aide des touches', detail: 'cette liste' },
]

// Touches qu'on ne peut pas attribuer, et pourquoi (dit dans l'écran de réglage).
const RESERVEES = new Map([
  [' ', 'Espace est réservée : maintenir Espace pour parler (barre d’ordres)'],
  ['escape', 'Échap ferme les panneaux'],
  ['enter', 'Entrée valide'],
  ['tab', 'Tab passe d’un bouton à l’autre'],
])
const CHIFFRE = /^[0-9]$/ // 1…9 et 0 : Alt+1…9 / Alt+0 passent d'une console à l'autre (App.jsx), on les laisse

// Une touche telle qu'on la range : un seul caractère imprimable, lettre en minuscule ; null sinon.
export function norme(k) {
  if (typeof k !== 'string') return null
  if (k.length !== 1) return RESERVEES.has(k.toLowerCase()) ? k.toLowerCase() : null
  return k.toLowerCase()
}
const estLettre = (k) => /^\p{L}$/u.test(k)

// ── Réglages (sur l'appareil) ──
// Ce qu'on relit est vérifié : une valeur trafiquée (« enter », un chiffre, Espace) ne devient jamais une touche.
const valable = (t) => t === null || (typeof t === 'string' && t.length === 1 && t === t.toLowerCase() && !RESERVEES.has(t) && !CHIFFRE.test(t))
function lire() {
  try {
    const v = JSON.parse(localStorage.getItem(CLE))
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([, t]) => valable(t)))
  } catch {} // stockage illisible ou interdit : les touches par défaut
  return {}
}
let reglees = lire()
let version = 0
const ecoutes = new Set()
function change() {
  version++
  for (const f of ecoutes) f()
}
function ecrit() {
  try {
    if (Object.keys(reglees).length) localStorage.setItem(CLE, JSON.stringify(reglees))
    else localStorage.removeItem(CLE)
  } catch {} // navigation privée : le réglage vaut pour cette visite
}

// La touche d'une action (réglée, sinon par défaut) ; null : aucune.
export function toucheDe(id) {
  const a = actions.find((x) => x.id === id)
  if (!a) return null
  return Object.hasOwn(reglees, id) ? reglees[id] : a.defaut ?? null
}
// Toutes les actions avec leur touche du moment : [{ id, nom, detail, defaut, touche }].
export const liste = () => actions.map((a) => ({ ...a, touche: toucheDe(a.id) }))
// L'action qui porte cette touche, ou null.
export const actionDe = (touche) => actions.find((a) => toucheDe(a.id) === touche)?.id ?? null

// Pourquoi une touche ne peut pas aller à cette action (null : elle peut).
export function refus(id, k) {
  const t = norme(k)
  if (t === null) return 'Une seule touche, sans Ctrl, Alt ni Méta'
  if (RESERVEES.has(t)) return RESERVEES.get(t)
  if (CHIFFRE.test(t)) return 'Les chiffres sont pris : Alt+1…9 passe d’une console à l’autre'
  const autre = actions.find((a) => a.id !== id && toucheDe(a.id) === t)
  if (autre) return `« ${t.toUpperCase()} » est déjà la touche de « ${autre.nom} »`
  return null
}
// Change la touche d'une action. Rend { ok: true } ou { ok: false, raison } (conflit refusé, rien ne change).
export function regler(id, k) {
  if (!actions.some((a) => a.id === id)) return { ok: false, raison: 'action inconnue' }
  const r = refus(id, k)
  if (r) return { ok: false, raison: r }
  const t = norme(k)
  const a = actions.find((x) => x.id === id)
  if (t === a.defaut) delete reglees[id]
  else reglees = { ...reglees, [id]: t }
  ecrit()
  change()
  return { ok: true }
}
// Retire la touche d'une action (elle n'en a plus).
export function retirer(id) {
  if (!actions.some((a) => a.id === id)) return
  reglees = { ...reglees, [id]: null }
  ecrit()
  change()
}
// Retour aux touches par défaut.
export function defauts() {
  reglees = {}
  ecrit()
  change()
}
// Pour React : se redessiner quand les touches changent.
export function useTouches() {
  useSyncExternalStore(
    (f) => (ecoutes.add(f), () => ecoutes.delete(f)),
    () => version,
  )
  return liste()
}

// ── Ce que fait chaque action (fourni par les composants qui savent le faire) ──
const branches = new Map()
// `fn` rend false quand l'action n'a rien pu faire (rien n'attend…) : la touche n'est alors pas avalée.
export function brancher(id, fn) {
  branches.set(id, fn)
  return () => branches.get(id) === fn && branches.delete(id)
}
export function useBranche(id, fn) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => brancher(id, (...a) => ref.current?.(...a)), [id])
}
// Une action est-elle branchée sur cet écran ? (sinon l'aide la grise et dit pourquoi)
export const estBranchee = (id) => branches.has(id)
// Après chaque action qui a agi (l'aide se referme quand une autre touche agit). Rend de quoi se désabonner.
const suites = new Set()
export function apresAction(fn) {
  suites.add(fn)
  return () => suites.delete(fn)
}
// Juste après N, le clavier est dans le terminal de la console qui t'attend, souvent devant un menu (Claude, Codex : une
// lettre peut y choisir une réponse). Relecture de sécurité du 13/11 : « N puis N : le second « n » part dans le menu »,
// et N maintenu y tapait « nnn ». Pendant SUITE_MS après une action `suite`, la même touche pressée dans ce terminal passe
// à la suivante au lieu d'y aller, et sa répétition automatique est avalée ; toute autre touche ferme la fenêtre et va au
// terminal comme d'habitude (« au clavier »). La fenêtre ne s'ouvre que pour une TOUCHE : une action lancée par un bouton
// ou par un autre volet (`allerAttente()`) ne fait rien disparaître de ce qu'on tape ensuite.
// Limite : un mot commençant par cette lettre, tapé dans les 2 s (« non », « npm »), perd sa première lettre et la suite
// part dans la console suivante (dit dans docs/volets/raccourcis.md ; la durée est une décision d'Orkun).
// Seconde relecture du 13/11 : la fenêtre n'était liée à aucun terminal ; N, puis un clic dans un shell et « npm test⏎ »
// dans les 2 s, faisait partir « pm test⏎ » dans le menu de la console suivante. Elle ne vaut donc que dans le terminal
// où N a mis le clavier (le premier terminal qui prend le focus après N : `terminal`), et se ferme au premier appui de
// souris ou de doigt, ou quand le focus va ailleurs.
const SUITE_MS = 2000
let relance = null // { id, jusqua, terminal }
const arme = (id) => (relance = actions.find((a) => a.id === id)?.suite ? { id, jusqua: performance.now() + SUITE_MS, terminal: null } : null)
// Lance une action ; rend true si elle a agi.
export function declencher(id) {
  const fn = branches.get(id)
  if (!fn) return false
  const fait = fn() !== false
  if (fait) for (const f of suites) f(id)
  return fait
}

// L'écran de réglage attend une touche (Raccourcis.jsx) : elle est pour lui, aucune action ne part (ni N, ni Alt+1…9).
let saisie = false
export const toucheEnSaisie = () => saisie
export function saisirTouche(oui) {
  saisie = !!oui
}
// Une action ajoutée par un autre volet ({ id, defaut, nom, detail }) ; sa touche par défaut est ignorée si elle est déjà
// prise ou réservée (l'action existe alors sans touche, réglable).
export function declarer({ id, defaut = null, nom, detail = '', panneau = null }) {
  if (!id || actions.some((a) => a.id === id)) return
  const libre = defaut != null && !refus(id, defaut)
  actions.push({ id, defaut: libre ? norme(defaut) : null, nom: nom || id, detail, panneau })
  change()
}

// Une fonction par action (pour les autres volets, et les boutons qui font la même chose qu'une touche).
export const allerAttente = () => declencher('attente')
export const carteMission = () => declencher('mission')
export const nouvelleConsole = () => declencher('nouvelle')
export const memoireProjet = () => declencher('memoire')
export const carteGit = () => declencher('git')
export const toutCadrer = () => declencher('cadrer')
export const aideTouches = () => declencher('aide')

// Le clavier est-il libre pour une touche seule ? Non quand il est dans un terminal, un champ, une liste, un texte
// modifiable, que l'écran de réglage attend une touche, ou qu'un panneau (dialogue) est ouvert — sauf l'aide des touches
// elle-même (`.rc-fenetre`) et le panneau que l'action `id` ouvre (M referme la mémoire). Un panneau caché ne compte pas :
// le lecteur de musique replié reste dans la page (`aria-hidden`, `inert`), il bloquait toutes les touches.
export function clavierLibre(e, id = null) {
  const t = e?.target
  if (t?.isContentEditable || t?.closest?.('.xterm, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false
  if (saisie) return false
  const panneau = (id && actions.find((a) => a.id === id)?.panneau) || null
  const ouverts = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')]
  return ouverts.every((d) => d.closest('[aria-hidden="true"], [inert], [hidden], .rc-fenetre') || (panneau && d.closest(panneau)))
}

// L'écoute du clavier, posée une fois (App.jsx) ; `actif` : faux sur le téléphone.
export function useRaccourcis(actif) {
  useEffect(() => {
    if (!actif) return
    const touche = (e) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      const k = norme(e.key)
      if (!k || (e.shiftKey && estLettre(k))) return // Maj+lettre : pas une touche seule (Maj sert à la sélection)
      const id = actionDe(k)
      if (!id || !clavierLibre(e, id)) return
      if (declencher(id)) {
        e.preventDefault() // la lettre ne va nulle part ailleurs (ni dans un terminal qui prendrait le clavier ensuite)
        e.stopPropagation()
        arme(id)
      }
    }
    // Avant le terminal (phase de capture) : la même touche juste après une action `suite` (voir SUITE_MS).
    const avant = (e) => {
      if (!relance || e.key === 'Shift' || e.key === 'CapsLock') return
      if (performance.now() > relance.jusqua) return void (relance = null)
      const k = norme(e.key)
      const meme = !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !!k && !(e.shiftKey && estLettre(k)) && k === toucheDe(relance.id)
      if (!meme) return void (relance = null)
      const x = e.target?.closest?.('.xterm')
      if (!x) return // hors terminal : l'écoute ordinaire s'en charge
      if (x !== relance.terminal) return void (relance = null) // un autre terminal que celui de N : la lettre est pour lui
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) relance.jusqua = performance.now() + SUITE_MS // touche maintenue : avalée tant qu'elle se répète
      else if (declencher(relance.id)) arme(relance.id)
      else relance = null
    }
    // Le terminal où N a mis le clavier (le premier qui prend le focus) ; le focus qui part ailleurs, ou un appui de
    // souris ou de doigt n'importe où, ferme la fenêtre.
    const focus = (e) => {
      if (!relance) return
      const x = e.target?.closest?.('.xterm')
      if (!relance.terminal && x) relance.terminal = x
      else if (x !== relance.terminal) relance = null
    }
    const appui = () => (relance = null)
    window.addEventListener('focusin', focus, true)
    window.addEventListener('pointerdown', appui, true)
    window.addEventListener('keydown', avant, true)
    window.addEventListener('keydown', touche)
    return () => {
      window.removeEventListener('focusin', focus, true)
      window.removeEventListener('pointerdown', appui, true)
      window.removeEventListener('keydown', avant, true)
      window.removeEventListener('keydown', touche)
    }
  }, [actif])
}
