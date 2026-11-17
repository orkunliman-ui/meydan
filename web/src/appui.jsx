import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// Appui prolongé au doigt (jamais à la souris, qui a son clic droit et sa sélection) sur l'élément de `ref` :
// `onLong({ x, y })` après une demi-seconde sans glisser. `actif()` est lu au moment où le doigt se pose.
// Deux doigts posés = un pincement, pas un appui. Le clic qui suit un appui prolongé est avalé : sur une ligne de la
// liste, relâcher le doigt n'ouvre pas la console.
export function useAppuiLong(ref, onLong, actif = () => true) {
  const fn = useRef(onLong)
  fn.current = onLong
  const ok = useRef(actif)
  ok.current = actif
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const doigts = new Set()
    let timer = 0
    let depart = null
    let long = false
    const annule = () => {
      clearTimeout(timer)
      depart = null
    }
    const pose = (e) => {
      if (e.pointerType === 'mouse') return
      doigts.add(e.pointerId)
      annule()
      long = false
      if (doigts.size > 1 || !ok.current()) return
      depart = { x: e.clientX, y: e.clientY }
      timer = setTimeout(() => {
        if (!depart) return
        long = true
        fn.current(depart)
        depart = null
      }, 500)
    }
    const bouge = (e) => depart && Math.hypot(e.clientX - depart.x, e.clientY - depart.y) > 10 && annule() // un glissement fait défiler
    const leve = (e) => {
      doigts.delete(e.pointerId)
      annule()
    }
    const clic = (e) => {
      if (!long) return
      long = false
      e.preventDefault()
      e.stopPropagation()
    }
    const natif = (e) => e.pointerType !== 'mouse' && e.preventDefault() // pas de menu du système par-dessus le nôtre
    const fins = ['pointerup', 'pointercancel', 'pointerleave']
    el.addEventListener('pointerdown', pose, true)
    el.addEventListener('pointermove', bouge, true)
    for (const f of fins) el.addEventListener(f, leve, true)
    el.addEventListener('click', clic, true)
    el.addEventListener('contextmenu', natif)
    return () => {
      annule()
      el.removeEventListener('pointerdown', pose, true)
      el.removeEventListener('pointermove', bouge, true)
      for (const f of fins) el.removeEventListener(f, leve, true)
      el.removeEventListener('click', clic, true)
      el.removeEventListener('contextmenu', natif)
    }
  }, [ref])
}

// Dans le menu : ne pas retirer le focus de ce qui l'avait (le terminal garde le clavier du téléphone ouvert).
export const garde = (e) => {
  e.preventDefault()
  e.stopPropagation()
}

// Le menu de l'appui prolongé. Posé sur le corps de la page (hors du plateau, dont le zoom déformerait sa position),
// au-dessus du doigt, ou dessous quand le doigt est près du haut de l'écran. Toucher ailleurs le referme, et ne fait
// QUE cela : le menu se ferme au clic, reçu par son fond. Fermé dès l'appui, le fond disparaissait avant le clic, qui
// tombait alors sur ce qu'il y avait dessous (une console s'ouvrait, « Coller » collait).
// Seul un toucher COMMENCÉ sur le fond le ferme : le doigt qui vient d'ouvrir le menu est encore posé, et le clic de son
// relâchement peut arriver sur le fond.
// Le menu ne passe JAMAIS sous le doigt qui l'ouvre (son relâchement choisirait une ligne). Sur un écran bas (téléphone
// couché), un menu en colonne ne tient ni au-dessus ni au-dessous du doigt : il se range alors à côté, ramené dans la
// hauteur de l'écran ; et si la largeur manque aussi, il garde sa place et défile dans la hauteur qui reste.
export function MenuDoigt({ x, y, onClose, colonne = false, children }) {
  const dessous = y < (colonne ? 260 : 90) // un menu en colonne est haut : il passe sous le doigt plus tôt
  const gauche = Math.max(150, Math.min(innerWidth - 150, x))
  const pose = useRef(false)
  const boite = useRef(null)
  useLayoutEffect(() => {
    const el = boite.current
    if (!el) return
    Object.assign(el.style, { left: `${gauche}px`, marginTop: '', maxHeight: '', overflowY: '' })
    const r = el.getBoundingClientRect()
    const haut = window.visualViewport?.height ?? innerHeight
    if (r.top >= 8 && r.bottom <= haut - 8) return // il tient à sa place
    const cote = x + 26 + r.width <= innerWidth - 8 ? x + 26 + r.width / 2 : x - 26 - r.width >= 8 ? x - 26 - r.width / 2 : null
    if (cote !== null) {
      el.style.left = `${Math.round(cote)}px`
      el.style.marginTop = `${Math.round(r.bottom > haut - 8 ? Math.max(8 - r.top, haut - 8 - r.bottom) : 8 - r.top)}px`
    } else {
      el.style.maxHeight = `${Math.max(92, Math.round(dessous ? haut - 8 - r.top : r.bottom - 8))}px`
      el.style.overflowY = 'auto'
    }
  })
  return createPortal(
    <div
      className="tmenu-fond"
      onPointerDown={(e) => {
        e.preventDefault() // ne retire pas le focus du terminal (le clavier du téléphone resterait ouvert)
        pose.current = true
      }}
      onClick={() => {
        if (pose.current) onClose()
        pose.current = false
      }}
    >
      <div
        ref={boite}
        className={['tmenu', dessous && 'dessous', colonne && 'colonne'].filter(Boolean).join(' ')}
        style={{ left: gauche, top: dessous ? y + 26 : y - 16 }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
