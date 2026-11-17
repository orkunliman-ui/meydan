import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { api } from './lib.js'
import { nomLisible, pourLire } from './voix-texte.js'

// Réponses parlées (Orkun, 11/11 : « ordres à la voix, réponses parlées » ; la dictée existait déjà). La synthèse vocale
// DE L'APPAREIL lit la dernière réponse d'un agent (« Écouter » dans le Chat) et, si l'option est prise, ce que dit une
// console qui passe FINI. Rien ne sort de l'appareil : seules les voix françaises installées sur l'appareil sont dites,
// jamais une voix réseau (« Google français », les voix « Online (Natural) » d'Edge), même pour un énoncé muet.
// Un seul moteur pour toute la page (ce module) : chaque bouton et la pastille lisent son état.

const SYNTH = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null
// iPhone, iPad, Safari : toutes les voix sont locales ; dans l'appli de l'écran d'accueil, la liste reste parfois vide.
const APPLE = typeof navigator !== 'undefined' && String(navigator.vendor || '').startsWith('Apple')
const CLE_AUTO = 'meydan.voix.fini' // '1' : lire les FINI (retenu sur l'appareil) ; absente ou autre : non (défaut)
const AUCUNE = 'Aucune voix française sur cet appareil'
const GARDE_FOU = 2500 // sans « start » après ce délai, la lecture n'a pas eu lieu (iOS ignore en silence un speak sans geste)
const FILE_MAX = 3

// ── État partagé ──────────────────────────────────────────────────────────────────────────────────────────────────
// lecture : { cle, id, source } pendant une lecture (dès l'appel à speak) ; attente : une lecture FINI qui attend un
// geste ; note : { texte, cle } (cle null : pour tous les boutons) ; auto : l'option « Lire les FINI ».
function lisAuto() {
  try {
    return localStorage.getItem(CLE_AUTO) === '1'
  } catch {
    return false // stockage interdit : option désactivée
  }
}
let etat = { lecture: null, attente: null, note: null, auto: lisAuto() }
const abonnes = new Set()
function pose(p) {
  etat = { ...etat, ...p }
  for (const f of abonnes) f()
}
const abonne = (f) => {
  abonnes.add(f)
  return () => abonnes.delete(f)
}
const instant = () => etat
const useEtat = () => useSyncExternalStore(abonne, instant, instant)

let noteFin = 0
function dit(texte, cle = null, reste = false) {
  clearTimeout(noteFin)
  pose({ note: texte ? { texte, cle } : null })
  if (texte && !reste) noteFin = setTimeout(() => pose({ note: null }), 7000)
}

// ── Voix ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function lisVoix() {
  try {
    return SYNTH.getVoices() || []
  } catch {
    return []
  }
}
// Seulement une voix de l'appareil (localService) en français. D'abord fr-FR / fr-BE, puis les autres français ; à
// langue égale, une voix soignée (Enhanced, Premium, amélioré, Natural), puis celle que l'appareil donne par défaut.
const SOIGNEE = /enhanced|premium|amélioré|natural/i
const langue = (v) => String(v.lang || '').replace('_', '-').toLowerCase()
function choisit(liste) {
  const rang = (v) => (/^fr-(fr|be)/.test(langue(v)) ? 0 : 4) + (SOIGNEE.test(v.name || '') ? 0 : 2) + (v.default ? 0 : 1)
  return liste.filter((v) => v.localService === true && langue(v).startsWith('fr')).sort((a, b) => rang(a) - rang(b))[0] || null
}
// { voix } (une voix locale ; null sur Apple quand la liste est vide : l'énoncé part en fr-FR sans voix posée),
// { aucune: true }, ou null : la liste n'est pas encore arrivée (Chrome la charge à part, « voiceschanged »).
function voixLocale() {
  const liste = lisVoix()
  if (liste.length) {
    const voix = choisit(liste)
    return voix ? { voix } : { aucune: true }
  }
  return APPLE ? { voix: null } : null
}
const attentes = new Set()
function voixArrivent() {
  const fs = [...attentes]
  attentes.clear()
  fs.forEach((f) => f())
  if (etat.note?.texte === AUCUNE && choisit(lisVoix())) dit('')
}
function attendsVoix(ms) {
  return new Promise((ok) => {
    const f = () => {
      clearTimeout(t)
      attentes.delete(f)
      ok()
    }
    const t = setTimeout(f, ms)
    attentes.add(f)
  })
}

// ── Lecture ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Une lecture `l` : { cle, id, nom?, phrases, source: 'bouton' | 'reglage' | 'fini', geste } (geste : appelée dans le
// toucher même). Un énoncé par phrase. Chaque lecture a son numéro (`tour`) : les événements d'une lecture finie ou
// coupée (le « interrupted » / « canceled » qui suit un cancel) arrivent plus tard et sont ignorés.
let tour = 0
let enonces = [] // gardés jusqu'à la fin : Chrome perd les événements d'un énoncé ramassé en route
let parti = false // un « start » est arrivé pour la lecture en cours
let gardeFou = 0
let deverrouille = false // la synthèse a déjà été lancée dans un geste depuis le chargement (exigé par iOS)
let file = [] // lectures FINI en attente de la fin de la lecture en cours (au plus 3, une par console)
let muet = null // l'énoncé muet du déverrouillage, gardé jusqu'à sa fin
let finiGen = 0 // désactiver l'option oublie les FINI en route

function coupe() {
  tour++
  clearTimeout(gardeFou)
  enonces = []
  parti = false
  // Rien en cours : pas de cancel. Safari peut perdre l'énoncé dit juste après un cancel (le cas courant : un toucher sur
  // « Écouter » quand rien ne parle).
  if (SYNTH.speaking || SYNTH.pending) SYNTH.cancel()
}
const ou = (l) => (l.source === 'bouton' ? l.cle : null) // le bouton qui montre la note (null : tous)

function lit(l) {
  const d = voixLocale()
  if (d) return part(d, l)
  // Liste pas encore arrivée (hors Apple) : on l'attend un peu ; la lecture se voit déjà, « Arrêter » l'annule.
  coupe()
  const t = tour
  pose({ lecture: { cle: l.cle, id: l.id, source: l.source } })
  attendsVoix(1200).then(() => {
    if (t === tour) part(voixLocale() || { aucune: true }, l)
  })
}

function part(d, l) {
  coupe()
  if (d.aucune) {
    file = []
    pose({ lecture: null })
    return dit(AUCUNE, null, true)
  }
  const t = tour
  const der = l.phrases.length - 1
  enonces = l.phrases.map((p, i) => {
    const u = new SpeechSynthesisUtterance(p)
    u.lang = d.voix ? d.voix.lang : 'fr-FR'
    if (d.voix) u.voice = d.voix
    u.onstart = () => {
      if (t !== tour || parti) return
      parti = true
      deverrouille = true
      clearTimeout(gardeFou)
    }
    u.onend = () => t === tour && i === der && fin()
    u.onerror = (e) => t === tour && rate(l, e?.error)
    return u
  })
  if (l.geste) deverrouille = true
  clearTimeout(noteFin)
  pose({ lecture: { cle: l.cle, id: l.id, source: l.source }, note: null })
  gardeFou = setTimeout(() => t === tour && !parti && pasParti(l), GARDE_FOU)
  // Synthèse restée en pause (application passée en arrière-plan au milieu d'une lecture) : rien ne partirait.
  if (SYNTH.paused && typeof SYNTH.resume === 'function') SYNTH.resume()
  for (const u of enonces) SYNTH.speak(u)
}

function fin() {
  tour++
  clearTimeout(gardeFou)
  enonces = []
  parti = false
  pose({ lecture: null })
  suivante()
}

// Une lecture FINI qui n'a pas pu partir attend un geste (pastille « Écouter ») ; un bouton le dit sous la réponse.
function pasParti(l) {
  coupe()
  deverrouille = false
  if (l.source === 'fini') return pose({ lecture: null, attente: { ...l, geste: false } })
  pose({ lecture: null })
  dit('La lecture n’a pas démarré : touche encore.', ou(l))
}

function rate(l, code) {
  coupe()
  // « interrupted » / « canceled » de la lecture en cours : coupée par l'appareil (appel, autre son), pas une erreur.
  if (code === 'interrupted' || code === 'canceled') {
    file = []
    return pose({ lecture: null })
  }
  if (code === 'not-allowed') {
    deverrouille = false
    if (l.source === 'fini') return pose({ lecture: null, attente: { ...l, geste: false } })
  }
  pose({ lecture: null })
  dit(code === 'not-allowed' ? 'Le navigateur a refusé la lecture : touche encore.' : `La lecture s’est arrêtée (${code || 'erreur'}).`, ou(l))
}

// Arrêt d'un toucher (pastille, « Arrêter ») : la lecture, la file et l'attente.
function arreter() {
  coupe()
  file = []
  pose({ lecture: null, attente: null })
}

function suivante() {
  if (etat.lecture || etat.attente || !file.length) return
  if (!etat.auto || document.visibilityState !== 'visible') {
    file = []
    return
  }
  const l = file.shift()
  if (deverrouille) lit(l)
  else pose({ attente: l })
}

// Une lecture en cours n'est jamais coupée par un FINI : il attend son tour.
function demandeFini(l) {
  if (!etat.auto || document.visibilityState !== 'visible') return
  if (etat.attente?.id === l.id) return pose({ attente: l })
  if (etat.lecture || etat.attente) {
    const i = file.findIndex((x) => x.id === l.id)
    if (i >= 0) file[i] = l
    else if (file.length < FILE_MAX) file.push(l)
    return
  }
  if (deverrouille) lit(l)
  else pose({ attente: l })
}

function lisAttente() {
  const l = etat.attente
  if (!l) return
  pose({ attente: null })
  lit({ ...l, geste: true }) // dans le toucher : iOS l'accepte
}

function oublie() {
  file = []
  pose({ attente: null })
}

// Empreinte courte d'un texte : la clé d'une lecture est « console : empreinte », le bouton de CE texte dit « Arrêter ».
function empreinte(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${s.length.toString(36)}.${(h >>> 0).toString(36)}`
}
const cleDe = (id, texte) => `${id}:${empreinte(texte)}`

// « Écouter » : speak est appelé dans le clic même, sans attente (iOS exige le geste).
function ecoute(id, cle, texte) {
  const { phrases } = pourLire(texte)
  if (!phrases.length) return dit('Rien à lire dans cette réponse.', cle)
  lit({ cle, id, phrases, source: 'bouton', geste: true })
}

function basculeAuto() {
  const on = !etat.auto
  try {
    if (on) localStorage.setItem(CLE_AUTO, '1')
    else localStorage.removeItem(CLE_AUTO)
  } catch {} // navigation privée : le choix vaut pour cette visite
  pose({ auto: on })
  // Activée d'un toucher : la phrase confirme le son ET déverrouille la synthèse pour les FINI qui suivront.
  if (on) return lit({ cle: null, id: null, phrases: ['Lecture des FINI activée.'], source: 'reglage', geste: true })
  // Désactivée : les FINI en route sont oubliés, une lecture FINI s'arrête (une lecture demandée au bouton continue).
  finiGen++
  file = []
  if (etat.lecture?.source === 'fini') {
    coupe()
    pose({ lecture: null })
  }
  pose({ attente: null })
}

// ── FINI ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms))
// La dernière réponse arrive dans le journal de l'agent un peu après le passage à FINI : relue à 0,6 s, puis 1,5 s et
// 3 s plus tard ; sans elle, l'annonce seule.
async function passeFini(c) {
  if (!etat.auto || document.visibilityState !== 'visible') return
  const g = finiGen
  let t = ''
  for (const ms of [600, 1500, 3000]) {
    await pause(ms)
    if (g !== finiGen) return
    try {
      const { fil } = await api('GET', `/api/consoles/${c.id}/fil`)
      const der = Array.isArray(fil) ? fil[fil.length - 1] : null
      if (der?.r === 'agent' && typeof der.t === 'string' && der.t) {
        t = der.t
        break
      }
    } catch {} // liaison coupée : nouvel essai, puis l'annonce seule
    if (g !== finiGen) return
  }
  const nom = c.name || 'Une console'
  const phrases = [`${nomLisible(nom)} a fini.`, ...(t ? pourLire(t).phrases : [])]
  demandeFini({ cle: t ? cleDe(c.id, t) : `${c.id}:fini`, id: c.id, nom, phrases, source: 'fini', geste: false })
}

// ── Branchements de la page ───────────────────────────────────────────────────────────────────────────────────────
// Option prise : au premier toucher (ou clic, ou touche) après le chargement, un énoncé muet dit DANS ce geste
// déverrouille la synthèse (iOS) ; ensuite une lecture FINI peut partir sans geste. Aucun énoncé sans voix locale.
const GESTES = ['touchend', 'click', 'keydown']
function premierGeste(e) {
  // Un clic lancé par du code (`el.click()`, téléchargement d'un fichier du Chat) n'est pas un geste : iOS refuserait
  // l'énoncé et le déverrouillage serait perdu pour le vrai toucher qui suit (trouvé au banc, cas r).
  if (!e?.isTrusted) return
  for (const g of GESTES) window.removeEventListener(g, premierGeste, true)
  if (!etat.auto) return
  deverrouille = true
  // Une lecture tourne déjà, ou le geste vise « Écouter » / l'interrupteur / la pastille, qui parlent eux-mêmes dans ce
  // geste : pas d'énoncé muet devant (il serait aussitôt coupé par un cancel).
  if (etat.lecture || e?.target?.closest?.('.voix, .voix-lecture')) return
  const d = voixLocale()
  if (!d || d.aucune) return
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  u.lang = d.voix ? d.voix.lang : 'fr-FR'
  if (d.voix) u.voice = d.voix
  u.onend = u.onerror = () => {
    if (muet === u) muet = null
  }
  muet = u
  SYNTH.speak(u)
}
if (SYNTH) {
  lisVoix() // Chrome commence à charger la liste au premier appel
  if (typeof SYNTH.addEventListener === 'function') SYNTH.addEventListener('voiceschanged', voixArrivent)
  else SYNTH.onvoiceschanged = voixArrivent
  if (etat.auto) for (const g of GESTES) window.addEventListener(g, premierGeste, { capture: true, passive: true })
  // Retour au premier plan : une fin de lecture a pu se perdre pendant que la page dormait.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && etat.lecture && parti && !SYNTH.speaking && !SYNTH.pending) fin()
  })
}

// ── Dessins au trait ──────────────────────────────────────────────────────────────────────────────────────────────
const Trait = ({ children }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const HautParleur = () => (
  <Trait>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z M15.5 9.2a4 4 0 0 1 0 5.6 M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
  </Trait>
)

// Sous la dernière réponse d'un agent, dans le Chat : « Écouter » (« Arrêter » pendant la lecture de CE texte) et
// l'interrupteur « Lire les FINI ».
export function Ecouter({ console: c, texte }) {
  const s = useEtat()
  const t = String(texte || '')
  const cle = useMemo(() => cleDe(c.id, t), [c.id, t])
  if (!SYNTH) return null
  const lu = s.lecture?.cle === cle
  return (
    <div className="voix">
      <button type="button" className="voix-ecouter" aria-pressed={lu ? 'true' : 'false'} onClick={() => (lu ? arreter() : ecoute(c.id, cle, t))}>
        {lu ? (
          <Trait>
            <rect x="7" y="7" width="10" height="10" rx="1.6" />
          </Trait>
        ) : (
          <HautParleur />
        )}
        <span>{lu ? 'Arrêter' : 'Écouter'}</span>
      </button>
      <button
        type="button"
        className="voix-auto"
        role="switch"
        aria-checked={s.auto ? 'true' : 'false'}
        aria-label="Lire à voix haute quand une console passe FINI"
        title="Lire à voix haute quand une console passe FINI"
        onClick={basculeAuto}
      >
        <i aria-hidden="true" />
        <span>Lire les FINI</span>
      </button>
      {s.note && (!s.note.cle || s.note.cle === cle) && (
        <span className="voix-note" role="status">
          {s.note.texte}
        </span>
      )}
    </div>
  )
}

// Monté une fois (App.jsx) : suit les passages à FINI et pose la pastille du haut, sur le corps de la page (au-dessus de
// tout), seulement quand il y a quelque chose : pendant une lecture, l'arrêt ; une lecture FINI qui attend un geste,
// « Écouter » et « Ignorer ».
export function Voix({ consoles }) {
  const s = useEtat()
  const avant = useRef(new Map()) // le dernier statut connu de chaque console ; le premier instantané ne déclenche rien
  useEffect(() => {
    if (!SYNTH) return
    const prec = avant.current
    avant.current = new Map(consoles.map((c) => [c.id, c.status]))
    for (const c of consoles) {
      const p = prec.get(c.id)
      if (p !== undefined && p !== 'fini' && c.status === 'fini') passeFini(c)
    }
  }, [consoles])
  // Console ouverte sur le téléphone : la pastille se pose sous sa barre du haut (retour, nom, Chat, ⋯), qu'elle ne
  // cache jamais ; ailleurs, en haut au centre (voix.css). Relu à chaque rendu (console ouverte, tournée, clavier).
  const boite = useRef(null)
  useLayoutEffect(() => {
    const el = boite.current
    if (!el) return
    const b = document.querySelector('.app.is-mobile .sheet-bar')?.getBoundingClientRect()
    const sous = b && b.height > 0 && b.bottom > 0 && b.bottom < 240
    el.style.top = sous ? `${Math.round(b.bottom + 8)}px` : ''
    el.style.maxWidth = sous ? 'calc(100vw - 32px)' : ''
  })
  if (!SYNTH || (!s.lecture && !s.attente)) return null
  return createPortal(
    <div className="voix-lecture" ref={boite}>
      {s.lecture ? (
        <button type="button" className="voix-arret" title="Arrêter la lecture à voix haute" onClick={arreter}>
          <HautParleur />
          <span>Arrêter</span>
        </button>
      ) : (
        <>
          <button type="button" className="voix-attente" onClick={lisAttente}>
            <HautParleur />
            <span>Écouter « {s.attente.nom} »</span>
          </button>
          <button type="button" className="voix-oublie" aria-label="Ignorer" title="Ignorer" onClick={oublie}>
            <Trait>
              <path d="M7 7l10 10M17 7L7 17" />
            </Trait>
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
