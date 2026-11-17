// Plateau créatif (volet du 13/11) — les flèches du plateau et l'outil « Flèche ». Demande d'Orkun (brief du volet) :
// « flèche (qui peut relier deux éléments du plateau) ».
// Une flèche est une carte `fleche` sans boîte (lib/cartes-formes.mjs) : { de, vers, couleur }, chaque bout un point du
// plan { x, y } ou un élément du plateau { id, x, y } (console ou carte).
//   Dessin : un calque SVG dans le repère du plan (ViewportPortal), sous les dalles comme LiensVivants.jsx. Un bout accroché
//   suit son élément (boîte lue dans le magasin de React Flow) et part du BORD de sa boîte (rectangle, ou ellipse pour une
//   forme ellipse) vers l'autre bout ; la pointe est côté `vers`. Un élément disparu ne fait jamais planter : le bout reste
//   à sa dernière position connue (x, y du bout, tenus à jour par l'ordinateur un instant après chaque déplacement).
//   Choisir une flèche (ordinateur) : clic sur son tracé (zone de prise large et invisible) ; une petite barre au milieu :
//   couleur, inverser, « × » en deux temps. Échap ou un clic ailleurs : plus rien de choisi.
//   Outil « Flèche » (ordinateur, outil.js) : tant qu'il est armé, une surface posée dans le cadre du plateau (au-dessus des
//   dalles, sous les panneaux) prend le pointeur ; appui sur un élément ou un point vide, glisser (aperçu), relâcher sur un
//   autre élément ou un point : la flèche est créée. L'outil reste armé pour en tracer d'autres (Échap ou second clic sur
//   « Flèche » pour finir, PlateauCreatif.jsx). La molette zoome toujours : la surface est DANS le cadre du plateau, son
//   événement remonte au zoom de React Flow (la classe `nopan` n'y écarte que le glisser).
//   Téléphone couché (`tel`) : flèches peintes, fixes ; ni zone de prise, ni barre, ni outil.
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow, useStore, useStoreApi, ViewportPortal } from '@xyflow/react'
import { CartesCtx, useFleches } from './cartes.js'
import { COULEURS, NOM_COULEUR } from './cartes-types.js'
import { useOutil } from './outil.js'
import { cls } from './lib.js'
import './carte-formes.css'

const ECART = 6 // un bout accroché s'arrête à 6 points du bord de son élément
const MIN_LIBRE = 12 // points d'écran : en deçà, un appui-relâcher sur le vide n'est pas une flèche
const couleurDe = (c) => (COULEURS.includes(c) ? c : 'papier')
const r1 = (v) => Math.round(v * 10) / 10
const bout = (b) => (b && typeof b === 'object' && Number.isFinite(b.x) && Number.isFinite(b.y) ? b : { x: 0, y: 0 })

// La boîte d'un nœud du plateau (points du plan), ou null s'il n'est pas (ou plus) là.
function boiteDe(n) {
  if (!n) return null
  const p = n.internals?.positionAbsolute ?? n.position
  const w = n.measured?.width ?? n.width ?? n.data?.w
  const h = n.measured?.height ?? n.height ?? n.data?.h
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !(w > 0) || !(h > 0)) return null
  return { x: p.x, y: p.y, w, h, ellipse: n.type === 'carte-forme' && n.data?.forme === 'ellipse' }
}
const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
// Le point où la ligne qui part du centre de la boîte vers `p` sort de la boîte (rectangle ou ellipse), écarté de ECART.
// `p` dans la boîte (deux éléments qui se chevauchent) : le bout est `p` lui-même.
function bord(b, p) {
  const c = centre(b)
  const [dx, dy] = [p.x - c.x, p.y - c.y]
  const L = Math.hypot(dx, dy)
  if (L < 1) return c
  const t = b.ellipse ? 1 / Math.sqrt((dx * dx) / (b.w / 2) ** 2 + (dy * dy) / (b.h / 2) ** 2) : Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  const s = Math.min(1, t + ECART / L)
  return { x: c.x + dx * s, y: c.y + dy * s }
}
// Les deux extrémités dessinées : un bout sur un élément présent part du bord de sa boîte, dans la direction de l'autre
// bout (le centre de son élément, ou son point) ; sinon le point enregistré (dernière position connue).
function extremites(de, vers, boiteDu) {
  const [bd, bv] = [de.id ? boiteDu(de.id) : null, vers.id ? boiteDu(vers.id) : null]
  const [vd, vv] = [bd ? centre(bd) : de, bv ? centre(bv) : vers]
  return [bd ? bord(bd, vv) : { x: de.x, y: de.y }, bv ? bord(bv, vd) : { x: vers.x, y: vers.y }]
}
const ecartes = (p, q) => Math.abs(p.x - q.x) > 1 || Math.abs(p.y - q.y) > 1
// Un bout tel qu'il est envoyé : entier, dans les bornes du plan (= lib/cartes-formes.mjs) — un élément posé tout au bord
// du plan pourrait sinon donner un bout refusé par le serveur.
const BORNE = 50000
const borne = (v) => Math.max(-BORNE, Math.min(BORNE, Math.round(v)))
const fixe = (o, q) => ({ ...(o.id ? { id: o.id } : {}), x: borne(q.x), y: borne(q.y) })

// Une flèche dessinée. `prise` (ordinateur) : la zone de prise, large et invisible, qui la fait choisir au clic.
const Fleche = memo(function Fleche({ id, couleur, a, b, choisie, prise, apercu, onChoisis }) {
  const d = `M ${r1(a.x)} ${r1(a.y)} L ${r1(b.x)} ${r1(b.y)}`
  const deg = r1((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI)
  return (
    <g className={cls('cr-fo-fleche', `cr-coul-${couleur}`, choisie && 'est-choisie', apercu && 'est-apercu')} data-id={id}>
      {choisie && <path className="cr-fo-halo" d={d} />}
      <path className="cr-fo-trait" d={d} />
      <g transform={`translate(${r1(b.x)} ${r1(b.y)}) rotate(${deg})`}>
        <path className="cr-fo-pointe" d="M 0 0 L -15 -7 L -11 0 L -15 7 Z" />
      </g>
      {prise && <path className="cr-fo-prise nopan" d={d} onClick={() => onChoisis(id)} />}
    </g>
  )
})

// L'élément du plateau sous un point de l'écran (identifiant de son nœud), en ignorant la surface de l'outil.
function elementSous(x, y, surface) {
  for (const e of document.elementsFromPoint(x, y)) {
    if (surface?.contains(e)) continue
    const n = e.closest?.('.react-flow__node[data-id]')
    if (n) return n.dataset.id
  }
  return null
}

// La surface de l'outil « Flèche », posée dans le cadre du plateau (comme les barres de React Flow) : au-dessus des dalles,
// sous les panneaux (mini-carte, barre « Ajouter » : ils restent cliquables, « Flèche » s'y désarme).
function Surface({ couleur, actions, setTrace, boiteDu }) {
  const rf = useReactFlow()
  const cadre = useStore((s) => s.domNode?.querySelector('.react-flow__renderer'))
  const ici = useRef(null)
  const geste = useRef(null)
  const [erreur, setErreur] = useState('')
  const point = (e) => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const id = elementSous(e.clientX, e.clientY, ici.current)
    return { p, id }
  }
  const fini = () => {
    geste.current = null
    setTrace(null)
  }
  const appui = (e) => {
    if (e.button !== 0) return
    e.preventDefault() // ni sélection de texte, ni glisser du plateau
    const { p, id } = point(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    geste.current = { pid: e.pointerId, de: id ? { id, x: p.x, y: p.y } : { x: p.x, y: p.y }, x0: e.clientX, y0: e.clientY }
    setErreur('')
    setTrace({ de: geste.current.de, vers: { x: p.x, y: p.y } })
  }
  const bouge = (e) => {
    const g = geste.current
    if (!g || e.pointerId !== g.pid) return
    const { p, id } = point(e)
    setTrace({ de: g.de, vers: id && id !== g.de.id ? { id, x: p.x, y: p.y } : { x: p.x, y: p.y } })
  }
  const relache = (e) => {
    const g = geste.current
    if (!g || e.pointerId !== g.pid) return
    fini()
    const { p, id } = point(e)
    if (id && id === g.de.id) return // relâché sur l'élément de départ : rien
    if (!id && !g.de.id && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < MIN_LIBRE) return // un simple clic sur le vide
    const vers = id ? { id, x: p.x, y: p.y } : { x: p.x, y: p.y }
    // Les bouts accrochés sont enregistrés à leur place dessinée (le bord de l'élément) : c'est là que la flèche restera
    // si l'élément disparaît.
    const [a, b] = extremites(g.de, vers, boiteDu)
    actions.cree('fleche', { de: fixe(g.de, a), vers: fixe(vers, b), couleur }).catch((err) => setErreur(err.message))
  }
  if (!cadre) return null
  return createPortal(
    <div ref={ici} className="cr-fo-surface nopan nodrag" onPointerDown={appui} onPointerMove={bouge} onPointerUp={relache} onPointerCancel={fini} onLostPointerCapture={(e) => e.pointerId === geste.current?.pid && fini()}>
      <p className={cls('cr-fo-consigne', erreur && 'est-erreur')} role={erreur ? 'alert' : 'status'}>
        {erreur || 'Flèche : glisser d’un élément (ou d’un point) à un autre · Échap : finir'}
      </p>
    </div>,
    cadre,
  )
}

// La barre d'une flèche choisie, au milieu de son tracé, en points d'écran (elle ne suit pas le zoom).
function BarreFleche({ f, a, b, actions, onFin }) {
  const [x, y, z] = useStore((s) => s.transform)
  const cadre = useStore((s) => s.domNode?.querySelector('.react-flow__renderer'))
  const [retire, setRetire] = useState(false)
  const [erreur, setErreur] = useState('')
  const envoie = (champs) => {
    setErreur('')
    actions.patch(f.id, champs).catch((e) => setErreur(e.message))
  }
  if (!cadre) return null
  const couleur = couleurDe(f.couleur)
  const [mx, my] = [((a.x + b.x) / 2) * z + x, ((a.y + b.y) / 2) * z + y]
  return createPortal(
    <div className="cr-fo-barre cr-fo-barre-fleche nopan nodrag nowheel" style={{ transform: `translate(${Math.round(mx)}px, ${Math.round(my)}px) translate(-50%, calc(-100% - 14px))` }}>
      <span className="cr-fo-couleurs" role="group" aria-label="Couleur de la flèche">
        {COULEURS.map((c) => (
          <button key={c} type="button" className={cls('cr-fo-pastille', `cr-coul-${c}`, couleur === c && 'est-prise')} aria-pressed={couleur === c} aria-label={NOM_COULEUR[c]} title={NOM_COULEUR[c]} onClick={() => envoie({ couleur: c })} />
        ))}
      </span>
      <button type="button" className="cr-fo-bouton" title="Inverser le sens de la flèche" onClick={() => envoie({ de: f.vers, vers: f.de })}>
        Inverser
      </button>
      <button
        type="button"
        className={cls('cr-fo-retire', retire && 'est-armee')}
        aria-label={retire ? 'Confirmer : retirer la flèche' : 'Retirer la flèche'}
        title={retire ? 'Cliquer encore pour retirer la flèche' : 'Retirer la flèche'}
        onClick={() => (retire ? actions.retire(f.id).then(onFin, (e) => (setRetire(false), setErreur(e.message))) : setRetire(true))}
        onBlur={() => setRetire(false)}
      >
        {retire ? 'Retirer ?' : '×'}
      </button>
      {erreur && (
        <span className="cr-fo-barre-erreur" role="alert">
          {erreur}
        </span>
      )}
    </div>,
    cadre,
  )
}

export function Fleches() {
  const { tel, actions } = useContext(CartesCtx)
  const store = useStoreApi()
  const fleches = useFleches()
  const { outil, couleur } = useOutil()
  const arme = !tel && outil === 'fleche'
  const [choisie, setChoisie] = useState(null)
  const [trace, setTrace] = useState(null) // l'aperçu pendant le tracé : { de, vers }

  // Les boîtes des éléments auxquels des flèches sont accrochées, lues dans le magasin de React Flow. Le sélecteur rend
  // une chaîne : la flèche ne se redessine que quand l'une de ces boîtes change (un déplacement, une taille, un départ).
  const idsCle = useMemo(() => [...new Set(fleches.flatMap((f) => [f.de?.id, f.vers?.id]).filter((i) => typeof i === 'string'))].sort().join(' '), [fleches])
  const cle = useStore(
    useCallback(
      (s) =>
        idsCle
          ? idsCle
              .split(' ')
              .map((i) => {
                const b = boiteDe(s.nodeLookup.get(i))
                return b ? `${i},${b.x},${b.y},${b.w},${b.h},${b.ellipse ? 1 : 0}` : i
              })
              .join(';')
          : '',
      [idsCle],
    ),
  )
  const boites = useMemo(
    () =>
      new Map(
        cle
          ? cle.split(';').map((t) => {
              const [i, x, y, w, h, e] = t.split(',')
              return [i, x === undefined ? null : { x: +x, y: +y, w: +w, h: +h, ellipse: e === '1' }]
            })
          : [],
      ),
    [cle],
  )
  const boiteDu = useCallback((i) => boites.get(i) ?? null, [boites])
  // Pendant un tracé, les éléments visés peuvent ne porter encore aucune flèche : lus directement.
  const boiteDuMagasin = useCallback((i) => boiteDe(store.getState().nodeLookup.get(i)), [store])

  const dessin = useMemo(
    () =>
      fleches.map((f) => {
        const [de, vers] = [bout(f.de), bout(f.vers)]
        const [a, b] = extremites(de, vers, boiteDu)
        return { f, de, vers, a, b }
      }),
    [fleches, boiteDu],
  )

  // Ordinateur : un bout accroché dont l'élément a bougé garde sa place dessinée au serveur, un instant après le dernier
  // mouvement (une fois par flèche). C'est sa « dernière position connue » si l'élément disparaît, ici ou sur un autre
  // appareil. Le téléphone ne demande rien. Une même mise à jour, depuis le même état du serveur, ne part qu'une fois :
  // refusée (liaison coupée…), elle ne repart pas en boucle ; deux ordinateurs ne se renvoient pas la balle sans fin.
  const envoyes = useRef(new Map())
  useEffect(() => {
    if (tel) return
    const t = setTimeout(() => {
      for (const { f, de, vers, a, b } of dessin) {
        const maj = {}
        if (de.id && boiteDu(de.id) && ecartes(a, de)) maj.de = fixe(de, a)
        if (vers.id && boiteDu(vers.id) && ecartes(b, vers)) maj.vers = fixe(vers, b)
        if (!maj.de && !maj.vers) continue
        const cle = JSON.stringify([maj, f.de, f.vers])
        if (envoyes.current.get(f.id) === cle) continue
        envoyes.current.set(f.id, cle)
        actions.patch(f.id, maj).catch(() => {})
      }
    }, 1200)
    return () => clearTimeout(t)
  }, [tel, dessin, boiteDu, actions])

  // La flèche choisie : partie (retirée ici ou ailleurs), l'outil armé, le téléphone → plus rien de choisi.
  const choix = choisie ? dessin.find((x) => x.f.id === choisie) : null
  useEffect(() => {
    if (choisie && (!choix || arme || tel)) setChoisie(null)
  }, [choisie, choix, arme, tel])
  // Un appui ailleurs que sur la flèche ou sa barre, ou Échap : plus rien de choisi.
  useEffect(() => {
    if (!choisie) return
    const ailleurs = (e) => !e.target.closest?.(`.cr-fo-barre-fleche, .cr-fo-fleche[data-id="${choisie}"] .cr-fo-prise`) && setChoisie(null)
    const echap = (e) => e.key === 'Escape' && setChoisie(null)
    document.addEventListener('pointerdown', ailleurs, true)
    window.addEventListener('keydown', echap)
    return () => {
      document.removeEventListener('pointerdown', ailleurs, true)
      window.removeEventListener('keydown', echap)
    }
  }, [choisie])
  useEffect(() => {
    if (!arme) setTrace(null)
  }, [arme])
  const choisis = useCallback(
    (id) => {
      store.getState().resetSelectedElements() // une flèche choisie : plus de dalle choisie (une seule barre à la fois)
      setChoisie(id)
    },
    [store],
  )

  let apercu = null
  if (trace) {
    const [a, b] = extremites(trace.de, trace.vers, boiteDuMagasin)
    const cible = trace.vers.id ? boiteDuMagasin(trace.vers.id) : null
    apercu = { a, b, cible }
  }
  return (
    <>
      <ViewportPortal>
        {(dessin.length > 0 || apercu) && (
          <svg className="cr-fo-calque" aria-hidden="true">
            {dessin.map(({ f, a, b }) => (
              <Fleche key={f.id} id={f.id} couleur={couleurDe(f.couleur)} a={a} b={b} choisie={f.id === choisie} prise={!tel && !arme} onChoisis={choisis} />
            ))}
            {apercu?.cible && <rect className={cls('cr-fo-cible', `cr-coul-${couleurDe(couleur)}`)} x={apercu.cible.x - 6} y={apercu.cible.y - 6} width={apercu.cible.w + 12} height={apercu.cible.h + 12} rx="8" />}
            {apercu && Math.hypot(apercu.b.x - apercu.a.x, apercu.b.y - apercu.a.y) > 2 && <Fleche id="apercu" couleur={couleurDe(couleur)} a={apercu.a} b={apercu.b} apercu />}
          </svg>
        )}
      </ViewportPortal>
      {arme && <Surface couleur={couleurDe(couleur)} actions={actions} setTrace={setTrace} boiteDu={boiteDuMagasin} />}
      {choix && !tel && !arme && <BarreFleche f={choix.f} a={choix.a} b={choix.b} actions={actions} onFin={() => setChoisie(null)} />}
    </>
  )
}
