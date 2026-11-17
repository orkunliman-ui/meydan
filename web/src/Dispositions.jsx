// Dispositions prêtes, sur l'ordinateur (volet « raccourcis », lot B, 13/11). Orkun, 13/11 : « On est encore loin de
// toutes les fonctionnalitēs de Symvibe ». Le choix : UN bouton « Disposer » dans le bandeau du haut à gauche du plateau
// (Board.jsx, à côté des espaces ; pas de panneau à lui : un coin = un panneau), qui ouvre une petite grille de vignettes
// dessinées en CSS (chaque vignette montre ses places, la première — celle de la console active — plus marquée).
// Le calcul et ses règles (quelles consoles, quel ordre, l'origine qui ne bouge pas, les bornes) : dispositions.js.
// Les consoles visées : la sélection (dès deux choisies), sinon celles à l'écran ; le bouton et l'en-tête le disent.
// Une disposition appliquée est un pas de l'historique (Board : `onDisposer`, Ctrl+Z l'annule et la vue d'avant revient) ;
// déjà en place : rien ne bouge, aucun pas, le bouton dit « Déjà en place » 2,5 s.
// Échap ou un clic ailleurs referment la grille. Rien sur le téléphone (le bandeau n'y est pas rendu).
// Props : `choisies` (consoles de la sélection), `consoles`, `activeId`, `cadre` (ref du conteneur du plateau),
// `onDisposer(libelle, places, cadrage)` (rend false si rien n'a bougé).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import { DISPOSITIONS, aireDe, aLEcran, cases, disposition, vuePour } from './dispositions.js'

const reduit = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const pl = (k, mot) => `${k} ${mot}${k > 1 ? 's' : ''}`
const DESSIN = aireDe(1616, 1080) // les vignettes : les proportions du plateau d'un écran 1920 × 1080

// Ce que dit une vignette au survol : combien elle prend, lesquelles, et ce que deviennent les autres.
function titreDe(d, n, parSelection) {
  const ou = parSelection ? 'choisies' : 'à l’écran'
  if (n < d.min) return `${d.nom} : il faut au moins ${pl(d.min, 'console')} (${n} ${ou}).`
  const prend = d.places || n
  const reste = n - prend
  return [
    `${d.nom} : ${pl(prend, 'console')} ${d.places ? `sur ${n} ${ou}` : `(toutes celles ${ou})`}, qui remplissent l’écran au zoom 1 à partir de leur coin haut gauche.`,
    d.places ? 'La console active d’abord (à la première place, la plus marquée), puis dans l’ordre de lecture.' : 'La console active à la première place, les autres dans l’ordre de lecture.',
    reste > 0 ? `${pl(reste, 'autre')} ${reste > 1 ? 'restent' : 'reste'} où ${reste > 1 ? 'elles sont' : 'elle est'}.` : '',
    'Ctrl+Z annule.',
  ]
    .filter(Boolean)
    .join('\n')
}

// Les places dessinées dans la vignette, en pourcentages de leur ensemble.
function Dessin({ id, n }) {
  const r = cases(id, n, DESSIN)
  const [L, H] = [Math.max(...r.map((p) => p.x + p.w)), Math.max(...r.map((p) => p.y + p.h))]
  const pc = (v, t) => `${((v / t) * 100).toFixed(2)}%`
  return (
    <span className="dp-dessin" aria-hidden="true">
      {r.map((p, i) => (
        <i key={i} className={i === 0 ? 'dp-premiere' : undefined} style={{ left: pc(p.x, L), top: pc(p.y, H), width: pc(p.w, L), height: pc(p.h, H) }} />
      ))}
    </span>
  )
}

export function Dispositions({ choisies, consoles, activeId, cadre, onDisposer }) {
  const rf = useReactFlow()
  const [ouvert, setOuvert] = useState(false)
  const [dit, setDit] = useState('') // « Déjà en place », 2,5 s
  const racine = useRef(null)
  const bouton = useRef(null)
  const grille = useRef(null)
  // Les consoles à l'écran (centre de la dalle dans la vue), en une clé : ce bouton ne se redessine que quand elle change,
  // pas à chaque image d'un glissement du plateau.
  const cleVisibles = useStore(
    useCallback(
      (s) => {
        const [x, y, zoom] = s.transform
        return s.width ? aLEcran(consoles, { x, y, zoom }, s.width, s.height).map((c) => c.id).join(' ') : ''
      },
      [consoles],
    ),
  )
  const parSelection = choisies.length > 1
  const ids = parSelection ? choisies.map((c) => c.id) : cleVisibles ? cleVisibles.split(' ') : []
  const visees = ids.map((id) => consoles.find((c) => c.id === id)).filter(Boolean) // les places du serveur, à jour
  const n = visees.length
  const qui = parSelection ? `${n} choisies` : `${n} à l’écran`

  useEffect(() => {
    if (!dit) return
    const t = setTimeout(() => setDit(''), 2500)
    return () => clearTimeout(t)
  }, [dit])

  const fermer = useCallback((rendreClavier) => {
    setOuvert(false)
    if (rendreClavier) requestAnimationFrame(() => bouton.current?.focus())
  }, [])
  // Ouverte : Échap la referme (pris avant le plateau, qui désélectionnerait : on dispose justement la sélection), un
  // appui ailleurs aussi. Le clavier va à la première vignette qu'on peut choisir.
  useEffect(() => {
    if (!ouvert) return
    const touche = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      fermer(true)
    }
    const appui = (e) => {
      if (!racine.current?.contains(e.target)) fermer(false)
    }
    window.addEventListener('keydown', touche, true)
    document.addEventListener('pointerdown', appui, true)
    requestAnimationFrame(() => grille.current?.querySelector('button:not(:disabled)')?.focus())
    return () => {
      window.removeEventListener('keydown', touche, true)
      document.removeEventListener('pointerdown', appui, true)
    }
  }, [ouvert, fermer])
  // La grille reste dans le plateau : décalée vers la gauche si le bouton est loin à droite (barre sur deux rangées).
  useLayoutEffect(() => {
    const g = grille.current
    const c = cadre.current?.getBoundingClientRect()
    if (!ouvert || !g || !c) return
    g.style.translate = ''
    const r = g.getBoundingClientRect()
    const trop = r.right - (c.right - 12)
    if (trop > 0) g.style.translate = `${-Math.min(trop, r.left - c.left - 12)}px 0`
  }, [ouvert, cadre])

  const choisir = (d) => {
    const r = cadre.current?.getBoundingClientRect()
    if (!r?.width) return
    const res = disposition(d.id, visees, { activeId, aire: aireDe(r.width, r.height) })
    if (!res) return
    fermer(true)
    if (res.deja) return setDit('Déjà en place')
    const vue = vuePour(res.places, r.width, r.height)
    const cadrage = () => rf.setViewport(vue, { duration: reduit() ? 0 : 700 })
    if (!onDisposer(`Disposer « ${d.nom} » (${pl(res.prises.length, 'console')})`, res.places, cadrage)) setDit('Déjà en place')
    else setDit('')
  }

  return (
    <div className="dp" ref={racine}>
      <button
        ref={bouton}
        type="button"
        className="dp-ouvre"
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        title={`Dispositions prêtes (2 côte à côte, 2 × 2, 1 grande + 3, Grille…) : pour les ${parSelection ? `${n} consoles choisies` : `${n} consoles à l’écran (choisis-en plusieurs avec Maj+clic pour n’agir que sur elles)`}. Ctrl+Z annule.`}
        onClick={() => (ouvert ? fermer(false) : setOuvert(true))}
      >
        <i className="dp-icone" aria-hidden="true" />
        <span className="dp-nom" aria-live="polite">
          {dit || 'Disposer'}
        </span>
        <span className="dp-qui">{qui}</span>
      </button>
      {ouvert && (
        <div ref={grille} className="dp-grille nowheel nopan nodrag" role="dialog" aria-label={`Dispositions pour ${parSelection ? `les ${n} consoles choisies` : `les ${n} consoles à l’écran`}`}>
          <p className="dp-tete">
            {parSelection ? `Pour les ${n} consoles choisies` : `Pour les ${n} consoles à l’écran`}
            <span>{parSelection ? 'la sélection' : 'choisis-en avec Maj+clic pour n’agir que sur elles'}</span>
          </p>
          <div className="dp-vignettes">
            {DISPOSITIONS.map((d) => {
              const grise = n < d.min
              const prend = d.places || Math.max(n, d.min)
              return (
                <button key={d.id} type="button" className="dp-vignette" data-disposition={d.id} disabled={grise} title={titreDe(d, n, parSelection)} onClick={() => choisir(d)}>
                  <Dessin id={d.id} n={d.places ? d.places : Math.max(n, d.id === 'grille' ? 4 : 3)} />
                  <span className="dp-legende">{d.nom}</span>
                  <span className="dp-combien">{grise ? `${d.min} au moins` : d.places ? pl(prend, 'console') : `toutes (${n})`}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
