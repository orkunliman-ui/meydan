// Maj+clic dans le terminal d'une console du plateau (ordinateur). Décision d'Orkun du 17/11, plateau-pc-5 (« Maj+clic
// dans un terminal ») : « Choisit la console ».
// Un clic avec Maj SANS déplacement (IMMOBILE points au plus entre l'appui et le relâcher) dans le terminal laisse le clic
// monter jusqu'à React Flow, qui ajoute la console à la sélection ou l'en retire (le même chemin que Maj+clic sur sa barre).
// Un Maj+GLISSER reste à xterm : il y sélectionne le texte pour le copier (Term.jsx, leçon 94). Le navigateur envoie
// aussi un `click` à la fin de ce glisser : il est arrêté ici, la sélection des consoles ne change pas.
// La discussion (vue Chat) n'est pas concernée : Maj+clic y étend la sélection de texte de la page, il ne choisit rien.
import { useMemo, useRef } from 'react'

export const IMMOBILE = 4 // points d'écran ; à 0,5 de zoom, une case du terminal en fait à peu près autant

// Les gestionnaires à poser sur le corps d'une dalle (à la place de l'ancien « Maj+clic arrêté »).
export function useMajClic() {
  const appui = useRef(null)
  return useMemo(
    () => ({
      onPointerDownCapture: (e) => {
        appui.current = { x: e.clientX, y: e.clientY }
      },
      onClick: (e) => {
        if (!e.shiftKey) return
        const a = appui.current
        const immobile = !!a && Math.hypot(e.clientX - a.x, e.clientY - a.y) <= IMMOBILE
        // `.term-box` : le terminal (Term.jsx), xterm compris ; une console qui n'a pas la main est une « vitre » (styles.css :
        // le clic tombe sur la boîte, pas dans xterm).
        if (immobile && e.target.closest?.('.term-box')) return // React Flow choisit (ou retire) la console
        e.stopPropagation()
      },
    }),
    [],
  )
}
