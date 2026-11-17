import { useLayoutEffect, useRef, useState } from 'react'

// Essai du 11/11 (reel « 3 règles », règle 1 : « big type in the back ») : le nom du projet en très grand, au fond.
// Ajusté à la largeur de son cadre, entre `min` et `max` px. Trop long pour une ligne à `min` : en deux lignes à un
// séparateur (- _ . espace) si `lignes` le permet ; sinon une ligne plus petite, jamais coupée au bord.
// Décor seulement (aria-hidden) : le nom est toujours écrit en clair à côté.
export function GrandMot({ texte, min = 56, max = 150, lignes = 2, className = '' }) {
  const boite = useRef(null)
  const [r, setR] = useState(null) // { taille, parts }
  const mot = String(texte || '').toUpperCase()
  useLayoutEffect(() => {
    const el = boite.current
    if (!el || !mot) return
    let mort = false
    const mesure = () => {
      const W = el.clientWidth
      if (!W || mort) return
      // Sonde à 100 px, même police, même graisse, même approche que le mot affiché (classe .grand-mot-sonde).
      const sonde = document.createElement('i') // pas un <span> : la règle des lignes du mot (taille --gm) la viserait
      sonde.className = 'grand-mot-sonde'
      el.appendChild(sonde)
      const largeur = (t) => {
        sonde.textContent = t
        return sonde.getBoundingClientRect().width || 1
      }
      const fit = (t) => Math.min(max, (W / largeur(t)) * 100 * 0.985)
      let best = { taille: fit(mot), parts: [mot] }
      if (best.taille < min && lignes > 1) {
        for (const m of mot.matchAll(/[-_. ]/g)) {
          const a = mot.slice(0, m.index + (m[0] === ' ' ? 0 : 1)), b = mot.slice(m.index + 1)
          if (!a.trim() || !b.trim()) continue
          const t = Math.min(fit(a), fit(b))
          if (t > best.taille) best = { taille: t, parts: [a, b] }
        }
      }
      sonde.remove()
      setR((v) => (v && Math.abs(v.taille - best.taille) < 0.5 && v.parts.join('|') === best.parts.join('|') ? v : best))
    }
    document.fonts.ready.then(mesure)
    const ro = new ResizeObserver(mesure)
    ro.observe(el)
    return () => {
      mort = true
      ro.disconnect()
    }
  }, [mot, min, max, lignes])
  return (
    <div ref={boite} className={`grand-mot ${className}`.trim()} aria-hidden="true" style={r ? { '--gm': `${r.taille.toFixed(1)}px` } : { visibility: 'hidden' }}>
      {(r?.parts || [mot]).map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </div>
  )
}
