import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { record, transcribe } from './envoi.js'
import { cls } from './lib.js'
import './ordres.css'

// Maintenir pour parler (volet « ordres », 13/11). Orkun : « On est encore loin de toutes les fonctionnalitēs de
// Symvibe » ; Symvibe : maintenir Espace pour dicter un ordre. Ordinateur seulement : Espace maintenu quand le clavier
// n'est ni dans un terminal, ni dans un champ, ni sur un bouton ou un lien (Espace y a son rôle). Au relâchement, la
// note part à la transcription locale (Parakeet, `/api/ordre/voix`, la même que le micro de la barre) et le texte ouvre
// la barre d'ordres : le plan est montré, RIEN n'est exécuté sans Entrée ou « Exécuter ».
//
// L'écoute est pilotée par un événement de fenêtre, `meydan:parle` (`parle('debut' | 'fin' | 'annule')`) : la touche
// Espace d'ici n'est qu'un déclencheur parmi d'autres, et le volet « raccourcis » peut poser sa propre touche sans
// toucher à ce fichier (`parle('debut', 'F2')` montre « relâche F2 »).
export const PARLE = 'meydan:parle'
// `tot` (avec 'debut') : l'enregistrement commence tout de suite mais le repère n'apparaît qu'après le seuil ; un appui
// plus bref se termine par 'annule' (rien ne s'affiche, rien n'est transcrit).
export function parle(etat, touche, { tot = false } = {}) {
  window.dispatchEvent(new CustomEvent(PARLE, { detail: { etat, touche, tot } }))
}

const SEUIL_MS = 300 // appui plus bref : rien (ni repère, ni texte, ni demande de permission)
const CHAMP = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
const ACTIF = 'button, a[href], summary, label, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="menuitem"], [role="option"], [role="tab"], [role="slider"]'

// Espace est-il libre pour parler quand le clavier est sur `el` ?
export function espaceLibre(el) {
  if (!(el instanceof Element) || el === document.body || el === document.documentElement) return true
  if (el.closest('.xterm')) return false // un terminal : Espace part à l'agent
  if (el.isContentEditable || el.closest(CHAMP)) return false
  return !el.closest(ACTIF)
}

export function Parler({ onTexte }) {
  const [etat, setEtat] = useState(null) // null | { ecoute, touche } | { transcription } | { erreur }
  const rappel = useRef(onTexte)
  rappel.current = onTexte

  // L'écoute, quel que soit le déclencheur.
  useEffect(() => {
    let prise = null // { pret: promesse de l'enregistreur }
    let tour = 0 // une transcription finie après une nouvelle écoute ne touche plus au repère
    let efface = null
    let differe = null // repère d'une écoute commencée « tôt », montré au seuil
    const montre = (x) => {
      clearTimeout(efface)
      clearTimeout(differe)
      setEtat(x)
      if (x?.erreur) efface = setTimeout(() => setEtat(null), 5000)
    }
    const debut = (touche, tot) => {
      if (prise) return
      const s = { pret: record() }
      prise = s
      const t = ++tour
      const repere = { ecoute: true, touche: touche || 'Espace' }
      if (tot) {
        clearTimeout(differe)
        differe = setTimeout(() => t === tour && prise === s && montre(repere), SEUIL_MS)
      } else montre(repere)
      // Micro refusé ou absent : dit tout de suite, et la fin à venir ne trouvera plus rien.
      s.pret.catch((e) => {
        if (prise !== s) return
        prise = null
        if (t === tour) montre({ erreur: e.message })
      })
    }
    // Relâchement perdu (fenêtre quittée, onglet caché), Échap : l'enregistrement est jeté, rien n'est transcrit. Un
    // enregistreur encore en train de s'ouvrir est fermé dès qu'il arrive.
    const annule = () => {
      const s = prise
      if (!s) return
      prise = null
      tour++
      s.pret.then((r) => r.cancel(), () => {})
      montre(null)
    }
    const fin = async () => {
      const s = prise
      if (!s) return
      prise = null
      const t = ++tour
      montre({ transcription: true })
      try {
        const r = await s.pret
        const { texte } = await transcribe(null, await r.stop())
        if (t === tour) montre(null)
        const dit = String(texte || '').trim().replace(/[.!]$/, '')
        if (dit) rappel.current?.(dit)
      } catch (e) {
        if (t === tour) montre({ erreur: e.message })
      }
    }
    const recu = (e) => {
      const d = e.detail
      const x = typeof d === 'string' ? d : d?.etat
      if (x === 'debut') debut(typeof d === 'object' ? d?.touche : '', typeof d === 'object' && !!d?.tot)
      else if (x === 'fin') fin()
      else if (x === 'annule') annule()
    }
    window.addEventListener(PARLE, recu)
    return () => {
      window.removeEventListener(PARLE, recu)
      clearTimeout(efface)
      clearTimeout(differe)
      annule()
    }
  }, [])

  // Espace maintenu. Pris en capture (avant le plateau et le reste) et avalé en entier quand il est libre : un appui
  // bref ne fait rien du tout, ni défilement ni choix d'une dalle.
  useEffect(() => {
    let tenue = false // Espace enfoncé, pris par nous
    let ecoute = false // l'enregistrement a commencé (au seuil, ou dès l'appui si le micro est déjà autorisé)
    let seuil = false // l'appui a dépassé le seuil : relâcher transcrit
    let minuterie = null
    // Micro déjà autorisé pour ce site : l'enregistrement part dès l'appui (le début de la phrase n'est plus perdu) et un
    // appui bref le jette. Sinon le seuil d'abord : un appui bref ne fait jamais surgir la demande du navigateur.
    let autorise = false
    Promise.resolve()
      .then(() => navigator.permissions?.query({ name: 'microphone' }))
      .then((st) => {
        if (!st) return
        autorise = st.state === 'granted'
        st.onchange = () => (autorise = st.state === 'granted')
      })
      .catch(() => {}) // navigateur qui ne connaît pas ce nom : le seuil d'abord
    const relache = (annuler) => {
      clearTimeout(minuterie)
      minuterie = null
      if (ecoute) parle(annuler || !seuil ? 'annule' : 'fin')
      tenue = false
      ecoute = false
      seuil = false
    }
    const espace = (e) => e.code === 'Space' || e.key === ' '
    const bas = (e) => {
      if (!espace(e)) {
        if (tenue && e.key === 'Escape') relache(true)
        return
      }
      if (tenue) {
        e.preventDefault() // touche répétée pendant l'appui
        e.stopPropagation()
        return
      }
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return
      if (!espaceLibre(e.target) || !espaceLibre(document.activeElement)) return
      e.preventDefault()
      e.stopPropagation()
      tenue = true
      if (autorise) {
        ecoute = true
        parle('debut', 'Espace', { tot: true })
      }
      minuterie = setTimeout(() => {
        minuterie = null
        seuil = true
        if (ecoute) return
        ecoute = true
        parle('debut', 'Espace')
      }, SEUIL_MS)
    }
    const haut = (e) => {
      if (!tenue || !espace(e)) return
      e.preventDefault()
      e.stopPropagation()
      relache(false)
    }
    const perdu = () => tenue && relache(true)
    const cache = () => document.visibilityState === 'hidden' && perdu()
    window.addEventListener('keydown', bas, true)
    window.addEventListener('keyup', haut, true)
    window.addEventListener('blur', perdu)
    document.addEventListener('visibilitychange', cache)
    return () => {
      window.removeEventListener('keydown', bas, true)
      window.removeEventListener('keyup', haut, true)
      window.removeEventListener('blur', perdu)
      document.removeEventListener('visibilitychange', cache)
      relache(true)
    }
  }, [])

  if (!etat) return null
  // Repère fixe, sans animation : un point, et ce qu'il faut faire.
  return createPortal(
    <div className={cls('parler', etat.ecoute && 'est-ecoute', etat.erreur && 'est-erreur')} role="status" aria-live="polite">
      {etat.ecoute ? (
        <>
          <i aria-hidden="true" />
          J’écoute — relâche {etat.touche}
        </>
      ) : etat.transcription ? (
        'Transcription…'
      ) : (
        etat.erreur
      )}
    </div>,
    document.body,
  )
}
