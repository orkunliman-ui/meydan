import { LiensVivants } from './LiensVivants.jsx'
// Plateau étendu (volet du 11/11) : notes, aperçus web et panneau Git en cartes, à côté des consoles.
import { CartesCtx, estCarte, noeudDeCarte, useCartes } from './cartes.js'
import { nodeTypesCartes, OutilsCartes } from './Cartes.jsx'
// Plateau créatif (volet du 13/11) : flèches, calque du stylo, images collées ou glissées (un seul élément, plus bas).
import { PlateauCreatif } from './PlateauCreatif.jsx'
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  getViewportForBounds,
  MiniMap,
  NodeResizer,
  Panel,
  ReactFlow,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  useStore,
  useStoreApi,
  ViewportPortal,
} from '@xyflow/react'
import { Term } from './differe.js' // xterm à part : le plateau du téléphone n'en monte aucun
import { BadgeSilence, Veille } from './Veille.jsx'
import { Age, Signe, Stamp } from './Signe.jsx'
import { clamp, cls, KIND_TAG, shortDir, statusOf } from './lib.js'
import { useDepot } from './envoi.js'
import { MenuLigne } from './Rail.jsx'
import { aUnFil, Discussion } from './Discussion.jsx'
import { groupes, MARGE_ZONE, rangerParGroupes } from './rangement.js'
// Volet plateau-pc (11/11) : veille des terminaux qu'on ne voit pas, taille du texte par console.
import { useVeille } from './veille.js'
import { BoutonsTaille, useTaille } from './tailles.jsx'
// Volet plateau-pc (11/11) : sélection multiple, annuler / rétablir la disposition, espaces de travail (ordinateur seulement).
import { entree, historique } from './historique.js'
import { BarreSelection } from './Selection.jsx'
import { horsDesAutres } from './selection-place.js' // décisions d'Orkun du 17/11 (lot plateau)
import { useMajClic } from './maj-clic.js'
import { useZoomMin } from './zoom-tel.js'
import { Espaces } from './Espaces.jsx'
// Volet « raccourcis » (13/11) : F et G au clavier, repères d'alignement, dispositions prêtes (ordinateur seulement).
import { ClavierPlateau } from './ClavierPlateau.jsx' // à part de Raccourcis.jsx : React Flow reste dans le morceau du plateau
import { useReperes } from './Reperes.jsx'
import { Dispositions } from './Dispositions.jsx'
import { CompteBadge, Comptes, QuotaRelais } from './Comptes.jsx'
import { RepereCopie } from './Copies.jsx' // volet copies : « copie · <branche> » dans la barre de la dalle
import { lignesEntieres } from './lignes.js' // question de la tuile : lignes entières et « … » (chasse du 17/11)
// Volet quota (17/11) : la pastille d'usage dans la barre (ordinateur : dalle et console agrandie, jamais le plateau du
// téléphone), le bandeau « Budget atteint — continuer ? » sur la dalle vue de près.
import { BandeauBudget, UsageConsole } from './Budget.jsx'

const BAR = 40 // hauteur de la barre d'une console, dans le plan (la même dans les deux thèmes : la grille du terminal en dépend)
const PAD_X = 12, PAD_Y = 8
const FAR = 0.45 // sous ce zoom, on lit l'étiquette, plus le terminal
const VIEW_KEY = 'meydan.viewport'
// Cadrage du plateau sur le téléphone : une bande en haut pour la barre « Ranger » (aucune dalle dessous), un liseré ailleurs.
const CADRE_TEL = { top: '64px', right: '12px', bottom: '12px', left: '12px' }

const Ctx = createContext(null)

const GLISSE_MS = 650 // la durée du glissement des dalles au rangement (lot4-rangement.css : la même)
const reduit = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function tilt(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0
  return (((h >>> 0) % 300) / 100 - 1.5).toFixed(2) // −1,5° … +1,5°, stable par console
}

// Le voile d'une dalle sur le plateau du téléphone, au doigt, comme les icônes d'un iPhone (Orkun, 10/11 : « En plateau
// faut pouvoir deplacer les fenetre apres un appuie prolongé ou un meilleur systeme ») :
//   toucher                      → la console s'ouvre en plein écran ;
//   glisser tout de suite        → le plateau se déplace (pincer : il zoome) ;
//   tenir 0,4 s                  → la dalle se soulève ET son menu s'ouvre (renommer, redimensionner, interrompre, relais,
//                                  boucle, fermer) ; puis, sans lever le doigt :
//       glisser franchement      → le menu se ferme, la dalle suit le doigt, le plateau défile seul près des bords,
//                                  posée au relâcher (sa place est gardée par le serveur : la même sur l'ordinateur) ;
//       relâcher                 → le menu reste ouvert, on y choisit.
// Sur l'iPhone, le menu n'apparaissait qu'au relâcher « sans bouger » : le doigt tremble toujours un peu, la dalle se
// déplaçait de quelques points et le menu ne venait jamais (Orkun, 11/11 : « je n'ai plus les autres options pour
// renommer etc. »). Il s'ouvre maintenant dès que la dalle se soulève, et seul un vrai glissement (14 px) le referme.
const LEVER_MS = 400
const GLISSE_PX = 14 // en deçà, le doigt tremble ; au-delà, il porte la dalle
const BORD = 44 // près du bord du plateau, à moins de 44 px, le plateau défile sous la dalle portée
// Les doigts posés sur l'écran, où qu'ils soient : le second doigt d'un pincement peut tomber sur une autre dalle ou sur
// le sol, et la dalle du premier doigt doit le savoir (deux doigts = un pincement, jamais une dalle soulevée).
const doigtsPoses = new Set()
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch') return
      if (e.isPrimary) doigtsPoses.clear() // premier doigt d'un geste : aucun reste d'un geste précédent
      doigtsPoses.add(e.pointerId)
    },
    true,
  )
  for (const fin of ['pointerup', 'pointercancel']) window.addEventListener(fin, (e) => doigtsPoses.delete(e.pointerId), true)
}
function Voile({ c }) {
  const { actions, onOuvre, toutes, deplace, regle, setRegle } = useContext(Ctx)
  const rf = useReactFlow()
  const ref = useRef(null)
  const [menu, setMenu] = useState(null)
  const id = c.id
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const doigts = new Set()
    let timer = 0
    let raf = 0
    let depart = null // où le doigt s'est posé (écran)
    let dernier = null // où il est (écran)
    let leve = false // la dalle est soulevée
    let bouge = false // et elle a été portée
    let decal = null // du doigt au coin de la dalle, dans le plan
    let avale = false // le clic qui suit un appui prolongé n'ouvre pas la console
    const ici = () => {
      const p = rf.screenToFlowPosition(dernier)
      return { x: p.x - decal.x, y: p.y - decal.y }
    }
    const lache = () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      depart = dernier = null
      leve = bouge = false
    }
    const lever = () => {
      const n = rf.getNode(id)
      if (!depart || !n) return
      if (doigtsPoses.size > 1) return lache() // un pincement en cours
      leve = avale = true
      dernier = depart
      const p = rf.screenToFlowPosition(depart)
      decal = { x: p.x - n.position.x, y: p.y - n.position.y }
      deplace(id, n.position, 'leve') // pas de vibration : l'iPhone ne la permet pas, et Chrome la refuse avant un premier toucher
      setMenu({ ...depart })
    }
    // Une image : la dalle sous le doigt ; près d'un bord, le plateau défile et on recommence à l'image suivante.
    const image = () => {
      raf = 0
      if (!leve || !dernier) return
      const cadre = el.closest('.react-flow')?.getBoundingClientRect()
      let vx = 0
      let vy = 0
      if (cadre) {
        const pousse = (d) => (d < BORD ? Math.round(((BORD - d) / BORD) * 14) : 0)
        vx = pousse(dernier.x - cadre.left) - pousse(cadre.right - dernier.x)
        vy = pousse(dernier.y - cadre.top) - pousse(cadre.bottom - dernier.y)
      }
      if (vx || vy) {
        const v = rf.getViewport()
        rf.setViewport({ x: v.x + vx, y: v.y + vy, zoom: v.zoom })
      }
      deplace(id, ici(), 'bouge')
      if (vx || vy) raf = requestAnimationFrame(image)
    }
    // Un second doigt, où qu'il soit : c'est un pincement. Une dalle portée est posée là où elle est.
    const pincement = () => {
      if (leve && bouge) deplace(id, ici(), 'fin')
      else if (leve) deplace(id, rf.getNode(id)?.position, 'pose')
      lache()
    }
    const pose = (e) => {
      if (e.pointerType === 'mouse') return
      doigts.add(e.pointerId)
      if (doigts.size > 1 || doigtsPoses.size > 1) return pincement()
      lache()
      avale = false
      depart = dernier = { x: e.clientX, y: e.clientY }
      // Le doigt reste à cette dalle même quand le menu s'ouvre par-dessus (sinon ses mouvements iraient au fond du menu).
      try {
        el.setPointerCapture(e.pointerId)
      } catch {} // pointeur déjà relâché
      timer = setTimeout(lever, LEVER_MS)
    }
    const glisse = (e) => {
      if (!depart || !doigts.has(e.pointerId)) return
      if (doigtsPoses.size > 1) return pincement()
      dernier = { x: e.clientX, y: e.clientY }
      if (!leve) {
        if (Math.hypot(dernier.x - depart.x, dernier.y - depart.y) > 10) lache() // un glissement : c'est le plateau qui bouge
        return
      }
      if (!bouge && Math.hypot(dernier.x - depart.x, dernier.y - depart.y) > GLISSE_PX) {
        bouge = true
        setMenu(null) // il porte la dalle : le menu s'efface
      }
      if (bouge && !raf) raf = requestAnimationFrame(image)
    }
    const releve = (e) => {
      doigts.delete(e.pointerId)
      if (!depart) return
      if (leve && bouge) deplace(id, ici(), 'fin')
      else if (leve) deplace(id, rf.getNode(id)?.position, 'pose') // relâchée sur place : le menu ouvert reste
      lache()
    }
    // Dalle soulevée : le plateau ne doit plus rien recevoir du doigt (il se déplacerait avec la dalle).
    const garde = (e) => {
      if (!leve) return
      e.preventDefault()
      e.stopPropagation()
    }
    const clic = (e) => {
      if (!avale) return
      avale = false
      e.preventDefault()
      e.stopPropagation()
    }
    const natif = (e) => e.preventDefault() // pas de menu du système par-dessus le nôtre
    el.addEventListener('pointerdown', pose)
    el.addEventListener('pointermove', glisse)
    el.addEventListener('pointerup', releve)
    el.addEventListener('pointercancel', releve)
    el.addEventListener('touchmove', garde, { passive: false })
    el.addEventListener('click', clic, true)
    el.addEventListener('contextmenu', natif)
    return () => {
      lache()
      el.removeEventListener('pointerdown', pose)
      el.removeEventListener('pointermove', glisse)
      el.removeEventListener('pointerup', releve)
      el.removeEventListener('pointercancel', releve)
      el.removeEventListener('touchmove', garde)
      el.removeEventListener('click', clic, true)
      el.removeEventListener('contextmenu', natif)
    }
  }, [id, rf, deplace])
  // En réglage de taille, toucher la dalle termine le réglage (elle ne s'ouvre pas).
  const touche = () => (regle === c.id ? setRegle(null) : onOuvre(c.id))
  return (
    <>
      <button ref={ref} type="button" className="slab-ouvre" aria-label={`Ouvrir ${c.name}`} onClick={touche} />
      {menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={onOuvre} voisines={toutes.current} extra={[{ texte: 'Redimensionner', action: () => setRegle(c.id) }]} />}
    </>
  )
}

// La poignée de taille d'une dalle en réglage (plateau du téléphone) : un carré d'appel dans le coin bas droit, de 52 px à
// l'écran quel que soit le zoom ; glissée, elle agrandit ou réduit la dalle (mêmes bornes que sur l'ordinateur).
const TAILLE_MIN = { w: 420, h: 260 }
const TAILLE_MAX = { w: 2400, h: 1600 }
function Poignee({ id, w, h }) {
  const { redimensionne } = useContext(Ctx)
  const zoom = useStore((s) => s.transform[2])
  const depart = useRef(null)
  const cote = 52 / zoom
  const taille = (e) => {
    const d = depart.current
    return { w: clamp(d.w + (e.clientX - d.x) / d.zoom, TAILLE_MIN.w, TAILLE_MAX.w), h: clamp(d.h + (e.clientY - d.y) / d.zoom, TAILLE_MIN.h, TAILLE_MAX.h) }
  }
  return (
    <div
      className="poignee nopan nodrag"
      role="slider"
      aria-label="Taille de la console : glisser pour agrandir ou réduire"
      style={{ width: cote, height: cote }}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        depart.current = { x: e.clientX, y: e.clientY, w, h, zoom }
      }}
      onPointerMove={(e) => depart.current && redimensionne(id, taille(e), 'bouge')}
      onPointerUp={(e) => {
        if (!depart.current) return
        redimensionne(id, taille(e), 'fin')
        depart.current = null
      }}
      onPointerCancel={(e) => {
        if (!depart.current) return
        redimensionne(id, taille(e), 'fin')
        depart.current = null
      }}
    >
      <i />
    </div>
  )
}

// Une console terminée : la relancer, ou la fermer pour libérer la place.
export function Terminee({ c, actions }) {
  return (
    <div className="slab-gone">
      <p>Session terminée.</p>
      <button type="button" className="relance nodrag" onClick={() => actions.revive(c.id)}>
        Relancer
      </button>
      <small>{c.kind === 'shell' ? 'Rouvre un shell dans le même dossier.' : 'Rouvre l’agent dans le même dossier, sur sa conversation. Ou ferme la console pour libérer la place.'}</small>
    </div>
  )
}

// La barre d'une console : la même sur la dalle du plateau et sur la console agrandie (Plein.jsx).
// `plein` : false = bouton « Agrandir », true = bouton « Réduire », absent = ni l'un ni l'autre (plateau du téléphone,
// où toucher la dalle l'ouvre déjà en grand). `vue` : 'fil' ou 'terminal' pour un agent (la bascule entre discussion et
// terminal), absent pour un shell.
// `onMenu({ x, y })` (ordinateur) : clic droit sur la barre = le menu de la console (Orkun, 11/11 : « je n'arrive pas a
// clique droit et renommer les fenetre dans la version PC »).
export function Barre({ c, active, actions, rev, plein, vue, onMenu }) {
  const id = c.id
  const droit = onMenu
    ? (e) => {
        if (e.target.closest('input')) return // le champ de renommage garde son menu (coller…)
        e.preventDefault()
        onMenu({ x: e.clientX, y: e.clientY })
      }
    : undefined
  const [editing, setEditing] = useState(false)
  const [arming, setArming] = useState(false)
  const label = statusOf(c.status).label
  const attend = c.status === 'needs'
  const question = c.note || "Une question t'attend"
  // Réverbère : la question vit sur la plaque tant que la console n'a pas le clavier, dans la barre ensuite. En
  // discussion, la carte de la question est dans la conversation : la barre la dit aussi.
  const note = c.status === 'error' ? c.note : attend && (active || vue === 'fil') ? question : null

  useEffect(() => {
    if (!arming) return
    const t = setTimeout(() => setArming(false), 3000)
    return () => clearTimeout(t)
  }, [arming])

  const rename = (e) => {
    const name = e.target.value.trim()
    setEditing(false)
    if (name && name !== c.name) actions.patch(id, { name })
  }

  const nameInput = (className) => (
    <input
      name="nom"
      className={className}
      defaultValue={c.name}
      autoFocus
      maxLength={48}
      onBlur={rename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
  const close = (
    <button
      type="button"
      className={cls('slab-close nodrag', arming && 'is-armed')}
      onClick={() => (arming ? actions.remove(id) : setArming(true))}
      // Volet plateau-pc : l'historique de la disposition n'y peut rien, on le dit (Orkun : « une fermeture n'est pas
      // annulable (dis-le) »).
      title={
        c.chief && c.team
          ? arming
            ? 'Confirmer : toute l’équipe s’arrête (le travail des équipiers est gardé) ; ne s’annule pas'
            : 'Arrêter l’équipe (un capitaine ne se ferme pas seul)'
          : arming
          ? 'Confirmer : la console s’arrête, ce qui tourne dedans aussi ; une fermeture ne s’annule pas (elle va dans l’Historique, d’où tu peux la relancer)'
          : 'Fermer la console (arrête ce qui tourne dedans ; une fermeture ne s’annule pas, la console va dans l’Historique)'
      }
    >
      {arming ? (c.chief && c.team ? 'Arrêter l’équipe ?' : 'Arrêter ?') : '×'}
    </button>
  )

  // Discussion ou terminal (agent seulement) : deux boutons, celui de l'affichage en cours est enfoncé.
  const bascule = vue && (
    <span className="bar-vue nodrag" role="group" aria-label="Affichage de la console">
      <button type="button" aria-pressed={vue === 'fil'} title="Discussion : la conversation, avec la barre d’envoi (photos, fichiers, note vocale)" onClick={() => actions.vue(id, 'fil')}>
        Chat
      </button>
      <button type="button" aria-pressed={vue === 'terminal'} title="Terminal" onClick={() => actions.vue(id, 'terminal')}>
        &gt;_
      </button>
    </span>
  )
  const taille = plein !== undefined && (
    <button
      type="button"
      className={cls('bar-plein nodrag', plein && 'est-plein')}
      aria-label={plein ? 'Réduire' : 'Agrandir'}
      title={plein ? 'Réduire : revenir au plateau' : 'Agrandir : la console prend toute la place à droite de la colonne'}
      onClick={() => actions.agrandit(plein ? null : id)}
    >
      <i aria-hidden="true" />
    </button>
  )

  return rev ? (
    <header className="slab-bar" onContextMenu={droit}>
      {/* .bar-in est contre-mise à l'échelle : la barre garde sa hauteur dans le plan, son texte reste lisible à l'écran */}
      <div className="bar-in">
        <Signe status={c.status} />
        {editing ? (
          nameInput('bar-input nodrag')
        ) : (
          <b className="bar-nom" onDoubleClick={() => setEditing(true)} title="Double-clic pour renommer">
            {c.name}
          </b>
        )}
        {/* « Plusieurs comptes Claude / Codex » : « C2 » après le nom d'une console du compte 2 (rien pour le 1). */}
        <CompteBadge c={c} />
        <RepereCopie c={c} />
        {note ? (
          <span className="bar-note">{note}</span>
        ) : (
          <>
            {!attend && <span className="genre">{c.kind.toUpperCase()}</span>}
            {/* Le sujet que l'agent a donné à sa session, dès qu'il existe ; sinon le dossier. */}
            <span className="bar-cwd" title={c.sujet ? shortDir(c.cwd) : undefined}>
              {(typeof c.sujet === 'string' && c.sujet) || shortDir(c.cwd)}
            </span>
          </>
        )}
        {plein !== undefined && <UsageConsole c={c} ou={plein ? 'plein' : 'dalle'} />}
        <span className="etat">{label}</span>
        <Age since={c.since} />
        {/* Boucle : ouvre son panneau ; allumé avec le tour en cours quand elle tourne. */}
        {(c.kind === 'claude' || c.kind === 'codex') && !c.team && c.status !== 'closed' && (
          <button
            type="button"
            className={cls('bar-boucle nodrag', c.boucle?.etat === 'active' && 'est-active')}
            title={c.boucle?.etat === 'active' ? 'Boucle en cours : voir ou arrêter' : 'Boucle : renvoyer un message à l’agent jusqu’à un objectif'}
            onClick={() => actions.ouvreBoucle(id)}
          >
            ↻{c.boucle?.etat === 'active' ? ` ${c.boucle.n}/${c.boucle.tours}` : ''}
          </button>
        )}
        {/* A− / A+ : ordinateur seulement (plateau et console agrandie) ; le téléphone a son pincement. */}
        {plein !== undefined && <BoutonsTaille id={id} />}
        {bascule}
        {taille}
        {close}
      </div>
    </header>
  ) : (
    <header className="slab-bar" onContextMenu={droit}>
      <div className="tape-wrap">
        <div className="tape" onDoubleClick={() => setEditing(true)} title="Double-clic pour renommer">
          <span className="tape-kind">{KIND_TAG[c.kind] || c.kind}</span>
          {editing ? nameInput('tape-input nodrag') : <span className="tape-name">{c.name}</span>}
          <CompteBadge c={c} />
          <RepereCopie c={c} />
        </div>
      </div>
      <span className="slab-cwd">{shortDir(c.cwd)}</span>
      {plein !== undefined && <UsageConsole c={c} ou={plein ? 'plein' : 'dalle'} />}
      <Stamp status={c.status} since={c.since} />
      {plein !== undefined && <BoutonsTaille id={id} />}
      {bascule}
      {taille}
      {close}
    </header>
  )
}

const ConsoleNode = memo(function ConsoleNode({ id, data: c, width, height, selected }) {
  const { zs, far, activeId, setActiveId, actions, rev, termLook, onOuvre, regle, plein, vues, toutes, vivantes, multi, debutGeste, finGeste, r3 } = useContext(Ctx)
  const active = activeId === id
  // Volet plateau-pc : `veille` = ce terminal n'est pas vu (hors de l'écran, sous les tuiles, derrière la console agrandie) ;
  // `base` = la taille de son texte, retenue par console.
  const veille = useVeille(id, { far, cache: !!plein, active, n: vivantes })
  const base = useTaille(id)
  const [menuPc, setMenuPc] = useState(null) // ordinateur : le menu ouvert par un clic droit sur la barre ou la tuile
  const ouvreMenu = onOuvre ? undefined : setMenuPc
  // La console que ce menu désigne (« Dupliquer », relais) prend la main ; une fois arrivée par le flux d'état, si elle
  // n'est pas entièrement à l'écran, le plateau glisse jusqu'à elle SANS changer le zoom (posée hors de l'écran, la copie
  // devenait active sans qu'on la voie ; un cadrage au zoom 1 faisait perdre la vue d'ensemble).
  const rf = useReactFlow()
  const store = useStoreApi()
  const vaVers = useCallback(
    (cible) => {
      setActiveId(cible)
      setTimeout(() => {
        const n = rf.getInternalNode(cible)
        if (!n) return
        const { width: W, height: H, transform: [tx, ty, z] } = store.getState()
        const p = n.internals.positionAbsolute
        const [w, h] = [n.measured?.width ?? n.width ?? 0, n.measured?.height ?? n.height ?? 0]
        const [x, y] = [p.x * z + tx, p.y * z + ty]
        if (x >= 0 && y >= 0 && x + w * z <= W && y + h * z <= H) return // déjà vue : on ne bouge rien
        rf.setCenter(p.x + w / 2, p.y + h / 2, { zoom: z, duration: reduit() ? 0 : 320 })
      }, 250)
    },
    [rf, store, setActiveId],
  )
  const droitTuile = ouvreMenu
    ? (e) => {
        e.preventDefault()
        ouvreMenu({ x: e.clientX, y: e.clientY })
      }
    : undefined
  const enReglage = !!onOuvre && regle === id
  // Coller (Ctrl+V) ou glisser un fichier sur la console : il part au VPS et son chemin s'écrit dans la console.
  const termApi = useRef(null)
  const depot = useDepot(id, termApi)
  const majClic = useMajClic()
  const w = width ?? c.w, h = height ?? c.h
  const label = statusOf(c.status).label
  const attend = c.status === 'needs'
  const question = c.note || "Une question t'attend"
  // Discussion ou terminal : un choix par console (ordinateur seulement ; le plateau du téléphone ouvre la console).
  const vue = !onOuvre && aUnFil(c) && c.status !== 'closed' ? (vues?.[id] ?? 'terminal') : undefined // terminée : rien à basculer
  const enFil = vue === 'fil' && c.status !== 'closed'
  const ailleurs = plein === id // agrandie : sa dalle se retire (deux affichages se disputeraient la taille de la console)

  return (
    // `nokey` (ordinateur) : Maj+glisser sur une console ne trace pas de lasso (React Flow le démarrerait par-dessus tout,
    // même dans un terminal) ; le lasso part du fond du plateau.
    <div className={cls('slab', `is-${c.status}`, active && 'is-active', far && 'is-far', enReglage && 'est-reglee', enFil && 'en-fil', !onOuvre && 'nokey')} style={{ width: w, height: h, '--tilt': `${tilt(id)}deg` }}>
      <NodeResizer
        // Plusieurs consoles choisies : pas de poignées sur chacune (on les déplace ensemble ; la taille se règle une à une).
        isVisible={!onOuvre && (active || (selected && !multi))}
        minWidth={420}
        minHeight={260}
        color={rev ? undefined : '#ECE4A0'} // « Réverbère » : couleurs dans reverbere.css (la prop écrit un style en ligne qui passe devant)
        // L'historique prend la place d'AVANT au début du geste (à la fin, `consoles` porte déjà la nouvelle).
        onResizeStart={() => debutGeste([id])}
        onResizeEnd={(_, p) => {
          const place = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }
          actions.patch(id, place)
          finGeste(`Taille de « ${c.name} »`, { [id]: place })
        }}
      />
      <Barre c={c} active={active} actions={actions} rev={rev} plein={onOuvre ? undefined : false} vue={vue} onMenu={ouvreMenu} />
      {menuPc && <MenuLigne c={c} x={menuPc.x} y={menuPc.y} actions={actions} onClose={() => setMenuPc(null)} onPick={vaVers} voisines={toutes.current} />}
      <div
        className={cls('slab-body nodrag nopan', active && 'nowheel')}
        onPointerDown={() => setActiveId(id)}
        // Ordinateur : Maj+clic immobile DANS le terminal choisit la console, comme sur sa barre (décision d'Orkun du 17/11,
        // plateau-pc-5) ; Maj+glisser y reste la sélection de texte de xterm (copie) et ne change rien (maj-clic.js).
        {...(onOuvre || far ? {} : majClic)}
        {...(enFil ? {} : { onPasteCapture: depot.onPasteCapture, onDragOver: depot.onDragOver, onDrop: depot.onDrop })}
      >
        {c.status === 'closed' ? (
          <Terminee c={c} actions={actions} />
        ) : ailleurs ? (
          <p className="slab-ailleurs">
            Agrandie.
            <button type="button" className="nodrag" onClick={() => actions.agrandit(null)}>
              Réduire
            </button>
          </p>
        ) : enFil ? (
          <Discussion c={c} actions={actions} />
        ) : onOuvre && far ? null : (
          // Téléphone, vu de loin : la tuile dit tout et un toucher ouvre la console ; aucun terminal en direct derrière
          // (11/11, iPhone couché : 8 à 14 terminaux et leurs connexions ouverts d'un coup, la page mourait en 2 s).
          <Term id={id} zs={zs} width={w - 2 - PAD_X * 2} height={h - BAR - 2 - PAD_Y * 2} active={active} look={termLook} apiRef={termApi} base={base} veille={veille} gl />
        )}
        {depot.etat && <p className={cls('depot', depot.etat.echec && 'est-echec')}>{depot.etat.texte}</p>}
      </div>
      {/* Plateau sur téléphone : la dalle se lit, elle ne se tape pas (pas de touches ici, et le clavier du téléphone
          couvrirait la moitié de l'écran). Un toucher ouvre la console en plein écran, avec ses touches. */}
      {onOuvre && <Voile c={c} />}
      {enReglage && <Poignee id={id} w={w} h={h} />}
      {!far && <BadgeSilence c={c} />}
      {/* La plaque se pose PAR-DESSUS le haut du terminal : elle ne lui prend aucune ligne. */}
      {rev && attend && !active && !far && !enFil && !ailleurs && (
        <div className="plaque">
          <b>{question}</b>
        </div>
      )}
      {/* « Plusieurs comptes Claude / Codex » : limite d'usage atteinte → relancer sur l'autre compte. Vue de près
          seulement (rien dans les tuiles, rien sur le plateau du téléphone) ; rien sans `c.quota`. */}
      {!far && !ailleurs && <QuotaRelais c={c} actions={actions} onPick={setActiveId} />}
      {!far && !ailleurs && <BandeauBudget c={c} />}
      {/* Vue lointaine (ordinateur) : la barre est trop petite pour viser « Agrandir » ; un double-clic sur la tuile le fait. */}
      {far &&
        (rev ? (
          <div className="slab-far tuile" title={onOuvre ? undefined : 'Double-clic : agrandir'} onDoubleClick={onOuvre ? undefined : () => actions.agrandit(id)} onContextMenu={droitTuile}>
            <b>
              {attend && <Signe status="needs" />}
              <span className="tuile-nom">{c.name}</span>
            </b>
            <BadgeSilence c={c} />
            {attend && <p ref={lignesEntieres}>{question}</p>}
            <span className="pied">
              {!attend && <Signe status={c.status} />}
              <span className="etat">{label}</span>
              <Age since={c.since} />
            </span>
          </div>
        ) : (
          <div className="slab-far" title={onOuvre ? undefined : 'Double-clic : agrandir'} onDoubleClick={onOuvre ? undefined : () => actions.agrandit(id)} onContextMenu={droitTuile}>
            <b>{c.name}</b>
            <span>{label}</span>
            <BadgeSilence c={c} />
          </div>
        ))}
      {/* ?reel3=oui, plan du dessus : « Répondre », à cheval sur le bord bas de la dalle. Agrandit la console, qui prend le
          clavier : on y lit la question entière et on répond soi-même (jamais une touche envoyée à l'agent). */}
      {r3 && attend && !ailleurs && (
        <button
          type="button"
          className="r3-repondre nodrag nopan"
          onClick={(e) => {
            e.stopPropagation() // ni sélection de la dalle, ni clic du plateau
            actions.agrandit(id)
          }}
        >
          Répondre
          <i aria-hidden="true">›</i>
        </button>
      )}
    </div>
  )
})

const nodeTypes = { console: ConsoleNode, ...nodeTypesCartes }

// Le zoom ne compte qu'une fois stabilisé : les terminaux ne se redessinent pas à chaque cran de molette.
// La contre-échelle des barres (--zb), elle, suit le zoom en direct, sans rendu React.
function ZoomWatch({ onSettle, onFar }) {
  const zoom = useStore((s) => s.transform[2])
  const dom = useStore((s) => s.domNode)
  const far = zoom < FAR
  useEffect(() => onFar(far), [far, onFar])
  useEffect(() => {
    const t = setTimeout(() => onSettle(Math.round(clamp(zoom, 0.5, 3) * 100) / 100), 140)
    return () => clearTimeout(t)
  }, [zoom, onSettle])
  useLayoutEffect(() => {
    if (!dom) return
    dom.style.setProperty('--zb', clamp(zoom, FAR, 1))
    dom.style.setProperty('--zoom', zoom)
    dom.toggleAttribute('data-petit', zoom < 0.7)
  }, [dom, zoom])
  return null
}

// Réverbère : le dallage de la place, tracé en coordonnées d'écran (traits nets à tous les zooms), et la nuit sur les bords.
function Dallage() {
  const x = useStore((s) => s.transform[0])
  const y = useStore((s) => s.transform[1])
  const z = useStore((s) => s.transform[2])
  const s = 176 * z, m = s / 2
  return (
    <svg className="dallage" aria-hidden="true">
      <defs>
        <pattern id="dallage" x={x % s} y={y % s} width={s} height={s} patternUnits="userSpaceOnUse">
          <path d={`M0 .5H${s}M0 ${m + 0.5}H${s}M.5 0V${m}M${m + 0.5} ${m}V${s}`} fill="none" stroke="#a9bbff" strokeOpacity=".085" />
        </pattern>
        <radialGradient id="dallage-ombre" cx=".5" cy=".46" r="1" gradientTransform="translate(.5 .46) scale(.78 .70) translate(-.5 -.46)">
          <stop offset=".42" stopColor="#050710" stopOpacity="0" />
          <stop offset="1" stopColor="#050710" stopOpacity=".82" />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#dallage)" />
      <rect width="100%" height="100%" fill="url(#dallage-ombre)" />
    </svg>
  )
}

// Mini-carte. Réverbère : seul ce qui t'attend est plein, le reste est au trait.
const MAP = {
  tapis: { bgColor: '#12241F', maskColor: 'rgba(8,16,14,.62)', nodeColor: (n) => statusOf(n.data.status).color, nodeStrokeWidth: 0 },
  reverbere: {
    bgColor: '#080b18',
    maskColor: 'rgba(5,7,16,.6)',
    nodeColor: (n) => (n.data.status === 'needs' ? 'var(--appel)' : 'transparent'),
    // `var(--working)` (#3fd9c4 du thème) : sous ?reel3=oui, lot-design/plateau.css le passe à l'encre.
    nodeStrokeColor: (n) => ({ needs: 'transparent', error: '#ff5d6c', working: 'var(--working)' })[n.data.status] || 'rgba(190,205,255,.34)',
    nodeStrokeWidth: 6,
  },
}

function savedViewport() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY))
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) ? v : null
  } catch {
    return null
  }
}

// Volet design-3-plans (?reel3=oui, ordinateur), règles 1 et 3 — le plan du fond, la seule chose énorme : comme la scène
// du téléphone debout, le nom du groupe (équipe ou projet, les groupes de « Ranger », rangement.js) de la plus ancienne
// attente, peint en très grand sur le sol du plateau juste au-dessus du groupe, le bas des lettres caché sous le haut de
// ses dalles ; « Répondre » est par-dessus la dalle. Seulement sur du sol libre : jamais derrière une autre dalle ni
// derrière un terminal (Orkun, 11/11 : un nom derrière un terminal se lisait comme un défaut d'affichage) ; sans place,
// l'attente suivante qui en a. Rien n'attend : pas de nom. En px du plan.
const MOT = { min: 120, max: 300, plancher: 72, cache: 0.3, ligne: 0.8, marge: 24 }
const largeurs = new Map() // largeur d'un mot à 1 px, par police : vidée quand les polices arrivent
let toile = null
function largeurMot(t, police) {
  const k = `${police}|${t}`
  if (!largeurs.has(k)) {
    toile ??= document.createElement('canvas').getContext('2d')
    toile.font = `800 100px ${police}`
    largeurs.set(k, (toile.measureText(t).width - 5 * t.length) / 100) // approche de −0,05 em (plateau.css)
  }
  return largeurs.get(k)
}
function motsDuFond(nodes) {
  const police = getComputedStyle(document.documentElement).getPropertyValue('--ui') || 'sans-serif'
  const large = (t) => largeurMot(t, police)
  const boites = new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y, w: n.width ?? n.data.w, h: n.height ?? n.data.h }]))
  const coupe = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const tous = groupes(nodes.map((n) => n.data))
  const attentes = nodes.filter((n) => n.data.status === 'needs').sort((a, b) => (a.data.since ?? 0) - (b.data.since ?? 0))
  const vus = new Set()
  for (const n of attentes) {
    const g = tous.find((g) => g.centre.id === n.id || g.autres.some((c) => c.id === n.id))
    if (!g || vus.has(g.id)) continue
    vus.add(g.id)
    const ids = new Set([g.centre, ...g.autres].map((c) => c.id))
    const bs = [...ids].map((id) => boites.get(id))
    const [x, y] = [Math.min(...bs.map((b) => b.x)), Math.min(...bs.map((b) => b.y))]
    let b = { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }
    // Groupe éparpillé (une autre console dans son cadre) : le nom va au-dessus de la console qui attend.
    if ([...boites].some(([id, o]) => !ids.has(id) && coupe(o, b))) b = boites.get(n.id)
    // Ajusté à la largeur du groupe ; trop long, en deux lignes à un séparateur (comme GrandMot.jsx sur le téléphone).
    const mot = String(g.nom || '').toUpperCase()
    if (!mot) continue
    const fit = (t) => (b.w * 0.985) / large(t)
    let lignes = [mot]
    let f = fit(mot)
    if (f < MOT.min)
      for (const m of mot.matchAll(/[-_. ]/g)) {
        const [a, z] = [mot.slice(0, m.index + (m[0] === ' ' ? 0 : 1)), mot.slice(m.index + 1)]
        if (a.trim() && z.trim() && Math.min(fit(a), fit(z)) > f) [lignes, f] = [[a, z], Math.min(fit(a), fit(z))]
      }
    f = Math.min(f, MOT.max)
    // Le sol libre au-dessus du groupe, sur la largeur du mot : le mot rapetisse pour y tenir, ou ne se pose pas.
    const w = f * Math.max(...lignes.map(large))
    let libre = Infinity
    for (const o of boites.values()) if (o.y < b.y && o.x < b.x + w && b.x < o.x + o.w) libre = Math.min(libre, b.y - (o.y + o.h) - MOT.marge)
    f = Math.min(f, libre / (MOT.ligne * lignes.length - MOT.cache))
    if (!(f >= MOT.plancher)) continue
    const h = MOT.ligne * f * lignes.length
    return [{ id: g.id, x: b.x, y: b.y + MOT.cache * f - h, w: f * Math.max(...lignes.map(large)), h, f, lignes }]
  }
  return []
}

// Les liens d'une équipe sur le plateau : une courbe du capitaine à chacun de ses équipiers, qui dit ce qui passe entre
// eux (Orkun, 10/11 : « un lien stylé qui connecte les agents qui travaillent ensemble […] comme le projet qu’on
// fork »). Tracés dans le repère du plateau, sous les dalles ; ils suivent une dalle qu'on déplace.
const tonDuLien = (c) =>
  c.status === 'needs' ? 'appel' : c.status === 'working' ? 'travail' : ['blocked', 'needs-decision', 'failed'].includes(c.etat?.verbe) ? 'retour' : c.etat?.verbe === 'done' ? 'fait' : 'calme'
function Liens({ nodes }) {
  const boite = (n) => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.data.w, h: n.height ?? n.data.h })
  const traits = []
  for (const chef of nodes.filter((n) => n.data.chief && n.data.team && n.data.status !== 'closed')) {
    const a = boite(chef)
    for (const m of nodes.filter((n) => n.data.team === chef.data.team && !n.data.chief && n.data.status !== 'closed')) {
      const b = boite(m)
      const [dx, dy] = [b.x + b.w / 2 - (a.x + a.w / 2), b.y + b.h / 2 - (a.y + a.h / 2)]
      // Côte à côte : de flanc à flanc. L'un au-dessus de l'autre : de bord bas à bord haut.
      const cote = Math.abs(dx) >= Math.abs(dy)
      const [x1, y1] = cote ? [dx > 0 ? a.x + a.w : a.x, a.y + a.h / 2] : [a.x + a.w / 2, dy > 0 ? a.y + a.h : a.y]
      const [x2, y2] = cote ? [dx > 0 ? b.x : b.x + b.w, b.y + b.h / 2] : [b.x + b.w / 2, dy > 0 ? b.y : b.y + b.h]
      const k = Math.max(40, (cote ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) * 0.5)
      const [c1, c2] = cote ? [[x1 + Math.sign(dx || 1) * k, y1], [x2 - Math.sign(dx || 1) * k, y2]] : [[x1, y1 + Math.sign(dy || 1) * k], [x2, y2 - Math.sign(dy || 1) * k]]
      traits.push({ id: m.id, ton: tonDuLien(m.data), d: `M ${x1} ${y1} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${x2} ${y2}`, x1, y1, x2, y2 })
    }
  }
  if (!traits.length) return null
  return (
    <svg className="liens-plateau" aria-hidden="true">
      {traits.map((t) => (
        <g key={t.id} className={`ve-lien est-${t.ton}`}>
          <path className="ve-lien-fond" d={t.d} />
          <path className="ve-lien-flux" d={t.d} />
          <circle className="ve-port" cx={t.x1} cy={t.y1} r="7" />
          <circle cx={t.x2} cy={t.y2} r="7" />
        </g>
      ))}
    </svg>
  )
}

// Un Mac sans écran tactile (pavé tactile, souris Apple) : le plateau se déplace à deux doigts (voir `panOnScroll` plus
// bas). Un iPad (qui se dit aussi « Mac ») a un pointeur grossier : il garde le doigt.
const PAVE_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || '') && typeof matchMedia === 'function' && !matchMedia('(pointer: coarse)').matches

// « Ranger » : les dalles alignées en rangées, chacune gardant sa taille, dans l'ordre où elles sont nées ; une équipe
// reste groupée (son capitaine, puis ses équipiers) ; les consoles terminées en dernier. La largeur des rangées est
// choisie pour que l'ensemble ait à peu près la forme de l'écran (le plateau entier se lit alors au plus grand). Le
// coin haut gauche de l'ensemble ne bouge pas. Rend { id: { x, y } }.
const ECART = 48
function ordreRangement(consoles) {
  const parAge = [...consoles].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const vues = new Set()
  const ordre = []
  for (const c of [...parAge.filter((c) => c.status !== 'closed'), ...parAge.filter((c) => c.status === 'closed')]) {
    if (vues.has(c.id)) continue
    const groupe = c.team ? parAge.filter((m) => m.team === c.team).sort((a, b) => Number(!!b.chief) - Number(!!a.chief)) : [c]
    for (const m of groupe) {
      if (vues.has(m.id)) continue
      vues.add(m.id)
      ordre.push(m)
    }
  }
  return ordre
}
export function rangement(consoles, tailles, forme) {
  if (!consoles.length) return {}
  const ordre = ordreRangement(consoles)
  const t = (c) => tailles[c.id] ?? { w: c.w, h: c.h }
  const place = (limite) => {
    const pos = {}
    let [x, y, haut, large] = [0, 0, 0, 0]
    for (const c of ordre) {
      const { w, h } = t(c)
      if (x > 0 && x + w > limite) [x, y, haut] = [0, y + haut + ECART, 0]
      pos[c.id] = { x, y }
      x += w + ECART
      haut = Math.max(haut, h)
      large = Math.max(large, x - ECART)
    }
    return { pos, large, haut: y + haut }
  }
  // Les largeurs possibles : chaque fin de dalle sur une seule rangée. On garde celle dont la forme colle le mieux à l'écran.
  let somme = 0
  let mieux = null
  for (const c of ordre) {
    somme += t(c).w + (somme ? ECART : 0)
    const essai = place(somme)
    const ecart = Math.abs(Math.log(essai.large / essai.haut / forme))
    if (!mieux || ecart < mieux.ecart - 1e-9) mieux = { ...essai, ecart }
  }
  const [x0, y0] = [Math.min(...consoles.map((c) => c.x)), Math.min(...consoles.map((c) => c.y))]
  return Object.fromEntries(Object.entries(mieux.pos).map(([id, p]) => [id, { x: Math.round(x0 + p.x), y: Math.round(y0 + p.y) }]))
}

// « Ranger » de l'ordinateur (Orkun, 11/11 : « Un bouton pour tous les organiser facilement ») : les consoles en
// mosaïque, à la taille de l'écran, lisibles sans zoomer — même ordre que le rangement du téléphone. On essaie chaque
// nombre de colonnes et on garde la grille dont les cases ont la forme la plus proche de celle d'une console neuve
// (720 × 460) ; le dernier rang, s'il est incomplet, s'étire sur toute la largeur. Si même la plus petite taille permise
// (420 × 260) ne tient pas, les cases prennent cette taille et le plateau se recule juste assez pour tout montrer.
// `W`, `H` : la place à remplir, en points d'écran (= dans le plan, au zoom 1). Rend { places: { id: { x, y, w, h } }, tient }.
const JOINT = 16 // entre deux consoles de la mosaïque
const MARGE = 16 // autour de la mosaïque
export function mosaique(consoles, W, H) {
  const ordre = ordreRangement(consoles)
  const n = ordre.length
  if (!n) return { places: {}, tient: true }
  let mieux = null
  for (let cols = 1; cols <= n; cols++) {
    const rangs = Math.ceil(n / cols)
    if ((rangs - 1) * cols >= n) continue // un rang resterait vide
    const tient = (W - (cols - 1) * JOINT) / cols >= TAILLE_MIN.w && (H - (rangs - 1) * JOINT) / rangs >= TAILLE_MIN.h
    const w = Math.max((W - (cols - 1) * JOINT) / cols, TAILLE_MIN.w)
    const h = Math.max((H - (rangs - 1) * JOINT) / rangs, TAILLE_MIN.h)
    const zoom = Math.min(1, W / (cols * w + (cols - 1) * JOINT), H / (rangs * h + (rangs - 1) * JOINT))
    const essai = { cols, rangs, w, h, tient, zoom, ecart: Math.abs(Math.log(w / h / (720 / 460))) }
    const meilleur = !mieux || (essai.tient !== mieux.tient ? essai.tient : essai.tient ? essai.ecart < mieux.ecart - 1e-9 : essai.zoom > mieux.zoom + 1e-9)
    if (meilleur) mieux = essai
  }
  const { cols, rangs, w, h, tient } = mieux
  const [x0, y0] = [Math.min(...consoles.map((c) => c.x)), Math.min(...consoles.map((c) => c.y))]
  const places = {}
  ordre.forEach((c, i) => {
    const [rang, col] = [Math.floor(i / cols), i % cols]
    const dernier = rang === rangs - 1
    const k = dernier ? n - rang * cols : cols // consoles sur ce rang
    const large = dernier && tient && k < cols ? (W - (k - 1) * JOINT) / k : w
    places[c.id] = { x: Math.round(x0 + col * (large + JOINT)), y: Math.round(y0 + rang * (h + JOINT)), w: Math.floor(large), h: Math.floor(h) }
  })
  return { places, tient }
}

// Une console sort-elle de l'écran ? La mini-carte ne sert qu'à retrouver ce qui n'est pas visible : quand tout est
// à l'écran (après « Ranger », par exemple), elle se retire au lieu de couvrir le coin de la dernière console.
function horsChamp(s) {
  const [tx, ty, z] = s.transform
  for (const n of s.nodeLookup.values()) {
    const p = n.internals.positionAbsolute
    const [w, h] = [n.measured?.width ?? n.width ?? 0, n.measured?.height ?? n.height ?? 0]
    const [x, y] = [p.x * z + tx, p.y * z + ty]
    if (x < -1 || y < -1 || x + w * z > s.width + 1 || y + h * z > s.height + 1) return true
  }
  return false
}

// ↶ ↷ : annuler / rétablir la disposition (ordinateur), grisés quand il n'y a rien à faire ; le titre dit le pas visé.
const SANS_FERMETURE = 'Une fermeture de console ne s’annule pas.'
const HORS_TERMINAL = 'quand le clavier n’est pas dans un terminal'
function Fleche({ retour }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style={retour ? undefined : { transform: 'scaleX(-1)' }}>
      <path d="M5.5 3.5 2.5 6.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 6.5h6.2a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
function BoutonsHistorique({ etat, onAnnuler, onRetablir }) {
  return (
    <span className="pc-histo" role="group" aria-label="Annuler ou rétablir la disposition">
      <button type="button" disabled={!etat.annuler} aria-label={etat.annuler ? `Annuler : ${etat.annuler}` : 'Rien à annuler'} title={`${etat.annuler ? `Annuler : ${etat.annuler} (Ctrl+Z, ${HORS_TERMINAL})` : 'Rien à annuler (déplacements, tailles, Ranger, espaces, dispositions)'}\n${SANS_FERMETURE}`} onClick={onAnnuler}>
        <Fleche retour />
      </button>
      <button type="button" disabled={!etat.retablir} aria-label={etat.retablir ? `Rétablir : ${etat.retablir}` : 'Rien à rétablir'} title={`${etat.retablir ? `Rétablir : ${etat.retablir} (Ctrl+Maj+Z ou Ctrl+Y, ${HORS_TERMINAL})` : 'Rien à rétablir'}\n${SANS_FERMETURE}`} onClick={onRetablir}>
        <Fleche />
      </button>
    </span>
  )
}

// `onOuvre` (plateau sur un téléphone couché) : les dalles ne se déplacent pas au doigt et ne prennent pas le clavier ;
// un toucher sur une dalle appelle onOuvre(id), qui ouvre la console en plein écran.
// `plein` (ordinateur) : la console agrandie par-dessus le plateau ; `vues` : discussion ou terminal, par console ;
// `rangerRef` : Board y pose { ranger, defait } pour le bouton « Ranger » de la colonne (App.jsx).
export function Board({ consoles, activeId, setActiveId, actions, look, onOuvre, plein, vues, rangerRef }) {
  const rf = useReactFlow()
  const [nodes, setNodes] = useState([])
  const [zs, setZs] = useState(1)
  // Téléphone : toujours la vue de loin (tuiles), quel que soit le zoom. Mesuré sur l'iPhone d'Orkun le 11/11 : à la
  // rotation, le plateau passait 1 à 5 s au zoom de près et y montait 22 terminaux d'un coup (gels de 1,5 à 2 s) ; toucher
  // une console l'ouvre en grand, le terminal vit là.
  const [farZoom, setFar] = useState(false)
  const far = onOuvre || farZoom
  // Sur téléphone (onOuvre), pas de cadrage retenu : le plateau s'ouvre toujours sur l'ensemble des dalles.
  const initial = useRef(onOuvre ? null : savedViewport())
  const cadre = useRef(null)
  const ready = useNodesInitialized()
  const fitted = useRef(!!initial.current)
  const rev = look.theme === 'reverbere'
  const termLook = rev ? `reverbere-${look.appel}` : 'tapis'
  const { cartes, actions: actionsCartes } = useCartes() // plateau étendu
  const ctxCartes = useMemo(() => ({ far, tel: !!onOuvre, rev, actions: actionsCartes }), [far, onOuvre, rev, actionsCartes])
  // ?reel3=oui (volet design-3-plans, ordinateur seulement) : le grand nom du fond et « Répondre » (lot-design/plateau.css).
  const r3 = rev && look.reel3 === 'oui' && !onOuvre
  // Le nom n'est peint sur le plateau que sous `?grand=plateau` ; par défaut il est dans la colonne (une seule chose énorme).
  const fond = r3 && look.grand === 'plateau'
  const [polices, setPolices] = useState(0)
  useEffect(() => {
    if (fond)
      document.fonts?.ready.then(() => {
        largeurs.clear() // mesurées avant l'arrivée de la police : à refaire
        setPolices((n) => n + 1)
      })
  }, [fond])
  const mots = useMemo(() => (fond && nodes.length ? motsDuFond(nodes) : []), [fond, nodes, polices]) // eslint-disable-line react-hooks/exhaustive-deps

  // Les consoles du serveur deviennent des nœuds ; un nœud en cours de déplacement garde sa position locale.
  // Les cartes du plateau étendu (cartes.js) suivent, avec la même règle.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))
      const dalles = consoles.map((c) => {
        const old = byId.get(c.id)
        if (old && old.data === c) return old
        const busy = old && (old.dragging || old.resizing)
        return {
          ...old,
          id: c.id,
          type: 'console',
          dragHandle: '.slab-bar, .tuile', // .tuile : la vue lointaine de Réverbère se déplace par toute sa surface
          data: c,
          position: busy ? old.position : { x: c.x, y: c.y },
          width: busy ? old.width : c.w,
          height: busy ? old.height : c.h,
        }
      })
      // Téléphone : les cartes passent SOUS les consoles (une carte posée sur une console après « Ranger » cachait sa tuile,
      // banc du 11/11) ; ordinateur : au-dessus, là où Orkun les a posées.
      const posees = cartes.map((k) => noeudDeCarte(k, byId.get(k.id)))
      return onOuvre ? [...posees, ...dalles] : [...dalles, ...posees]
    })
  }, [consoles, cartes, onOuvre])

  useEffect(() => {
    if (ready && !fitted.current && nodes.length) {
      fitted.current = true
      const r = cadre.current?.getBoundingClientRect()
      if (mots.length && r?.width) {
        // ?reel3=oui : le cadrage compte aussi le grand nom du fond (sinon, au-dessus du rang du haut, il sortirait de l’écran).
        const bs = [...nodes.map((n) => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.data.w, h: n.height ?? n.data.h })), ...mots]
        const [x, y] = [Math.min(...bs.map((b) => b.x)), Math.min(...bs.map((b) => b.y))]
        const bornes = { x, y, width: Math.max(...bs.map((b) => b.x + b.w)) - x, height: Math.max(...bs.map((b) => b.y + b.h)) - y }
        rf.setViewport(getViewportForBounds(bornes, r.width, r.height, 0.15, 1, 0.08))
      } else rf.fitView({ padding: onOuvre ? CADRE_TEL : 0.08, maxZoom: 1 })
    }
  }, [ready, nodes.length, rf, onOuvre])
  // Téléphone : tout recadrer quand la place du plateau change (ouverture, rotation) ou qu'une console arrive ou part.
  // Mesuré sur le cadre lui-même : au premier rendu sa hauteur n'est pas encore la bonne.
  useEffect(() => {
    const el = cadre.current
    if (!onOuvre || !el || !ready || !nodes.length || !window.ResizeObserver) return
    let t = 0
    const recadre = () => {
      clearTimeout(t)
      t = setTimeout(() => rf.fitView({ padding: CADRE_TEL, maxZoom: 1 }), 120)
    }
    const ro = new ResizeObserver(recadre)
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [onOuvre, ready, nodes.length, rf])

  const onNodesChange = useCallback((changes) => setNodes((ns) => applyNodeChanges(changes, ns)), [])

  // ── Historique de la disposition (ordinateur). Orkun, 11/11 : « Annuler / rétablir sur plusieurs pas la disposition
  // (déplacements, tailles, Ranger) : Ctrl+Z / Ctrl+Maj+Z hors terminal, et boutons ; une fermeture n'est pas annulable
  // (dis-le). » Une pile par page (historique.js), oubliée au rechargement ; le téléphone n'en a pas.
  // `toutes` : les consoles du moment, lues à l'ouverture d'un menu ou au début d'un geste (une référence : les dalles ne
  // se redessinent pas à chaque changement d'état d'une voisine).
  const toutes = useRef(consoles)
  toutes.current = consoles
  const [hist] = useState(historique)
  useSyncExternalStore(hist.ecoute, hist.version) // les boutons ↶ ↷ suivent la pile
  const idsCle = consoles.map((c) => c.id).join(' ')
  useEffect(() => hist.elague(new Set(idsCle.split(' '))), [hist, idsCle]) // une console fermée sort de l'historique
  const placesDe = useCallback(
    (ids) =>
      Object.fromEntries(
        ids.flatMap((id) => {
          const c = toutes.current.find((x) => x.id === id)
          return c ? [[id, { x: c.x, y: c.y, w: c.w, h: c.h }]] : []
        }),
      ),
    [],
  )
  // Un geste à la souris : la place d'AVANT se prend au début (déplacement, redimensionnement) ; à la fin, `patchLocal`
  // a déjà mis la nouvelle dans `consoles`. `apres` : ce qui a changé ({ x, y } pour un déplacement), le reste est repris.
  const avantGeste = useRef(null)
  const debutGeste = useCallback((ids) => (avantGeste.current = placesDe(ids)), [placesDe])
  const finGeste = useCallback(
    (libelle, apres) => {
      const avant = avantGeste.current
      avantGeste.current = null
      if (onOuvre || !avant) return
      hist.note(entree(libelle, avant, Object.fromEntries(Object.entries(apres).map(([id, p]) => [id, { ...avant[id], ...p }]))))
    },
    [onOuvre, hist],
  )
  const onNodeDragStart = useCallback((_, n, ns) => debutGeste((ns?.length ? ns : [n]).map((m) => m.id)), [debutGeste])
  // Repères d'alignement pendant un déplacement (Reperes.jsx) : ordinateur seulement, sans aimantation.
  const reperes = useReperes(!onOuvre)
  // Toutes les dalles déplacées ensemble (sélection multiple) vont au serveur, pas seulement celle qu'on tenait.
  const onNodeDragStop = useCallback(
    (_, n, ns) => {
      reperes.finGlisse()
      const liste = ns?.length ? ns : [n]
      // Plateau étendu : une carte (note, web, git) part à l'API des cartes ; l'historique ne garde que les consoles.
      for (const k of liste.filter(estCarte)) actionsCartes.patch(k.id, { x: Math.round(k.position.x), y: Math.round(k.position.y) }).catch(() => {})
      const dalles = liste.filter((m) => !estCarte(m))
      if (!dalles.length) return void (avantGeste.current = null)
      const apres = {}
      for (const m of dalles) {
        apres[m.id] = { x: Math.round(m.position.x), y: Math.round(m.position.y) }
        actions.patch(m.id, apres[m.id])
      }
      finGeste(dalles.length > 1 ? `Déplacer ${dalles.length} consoles` : `Déplacer « ${dalles[0].data.name} »`, apres)
    },
    [actions, actionsCartes, finGeste, reperes],
  )
  // Une dalle portée au doigt sur le téléphone (voir Voile) : 'leve' la soulève (au-dessus des autres, sa place n'est plus
  // celle du serveur), 'bouge' la déplace, 'fin' la pose et envoie sa place au serveur, 'pose' la repose sans bouger.
  // La dernière dalle posée reste au-dessus de ses voisines (posée sur une autre, elle passait dessous).
  const deplace = useCallback(
    (id, position, etape) => {
      const portee = etape === 'leve' || etape === 'bouge'
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return etape === 'fin' && n.zIndex === 1 ? { ...n, zIndex: undefined } : n
          const zAvant = etape === 'leve' ? n.zIndex : n.zAvant
          const zIndex = portee ? 1000 : etape === 'fin' ? 1 : zAvant
          return { ...n, position: position ?? n.position, dragging: portee, zIndex, zAvant, className: portee ? 'est-levee' : undefined }
        }),
      )
      if (etape === 'fin' && position) actions.patch(id, { x: Math.round(position.x), y: Math.round(position.y) })
    },
    [actions],
  )
  // Réglage de la taille d'une dalle au doigt (téléphone) : `regle` = la dalle dont la poignée est montrée.
  const [regle, setRegle] = useState(null)
  const redimensionne = useCallback(
    (id, taille, etape) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, width: taille.w, height: taille.h, resizing: etape !== 'fin' } : n)))
      if (etape === 'fin') actions.patch(id, { w: Math.round(taille.w), h: Math.round(taille.h) })
    },
    [actions],
  )
  useEffect(() => {
    if (regle && !consoles.some((c) => c.id === regle)) setRegle(null) // la console est partie
  }, [regle, consoles])
  // En réglage, la dalle vient au milieu de l'écran, à la moitié de sa hauteur : sa poignée n'est ni sous le bandeau ni
  // hors de l'écran, et il reste de la place pour l'agrandir.
  useEffect(() => {
    if (regle) rf.fitView({ nodes: [{ id: regle }], padding: { top: '76px', right: '18%', bottom: '18%', left: '18%' }, maxZoom: 1, duration: 260 })
  }, [regle, rf])
  // Ranger le plateau (téléphone) ; « Annuler » remet chaque dalle où elle était, pendant dix secondes.
  const [annule, setAnnule] = useState(null)
  const poseTout = useCallback(
    (places, cadrage) => {
      const pose = (n, p) => ({ ...n, position: { x: p.x, y: p.y }, ...(p.w ? { width: p.w, height: p.h } : {}) })
      setNodes((ns) => ns.map((n) => (places[n.id] ? pose(n, places[n.id]) : n)))
      for (const [id, p] of Object.entries(places)) actions.patch(id, p)
      setTimeout(cadrage || (() => rf.fitView({ padding: CADRE_TEL, maxZoom: 1, duration: 260 })), 60)
    },
    [actions, rf],
  )
  const ranger = useCallback(() => {
    const r = cadre.current?.getBoundingClientRect()
    const tailles = Object.fromEntries(nodes.map((n) => [n.id, { w: n.width ?? n.data.w, h: n.height ?? n.data.h }]))
    const places = rangement(consoles, tailles, r && r.height ? r.width / r.height : 16 / 9)
    const avant = Object.fromEntries(consoles.map((c) => [c.id, { x: c.x, y: c.y }]))
    const bougees = Object.fromEntries(Object.entries(places).filter(([id, p]) => p.x !== avant[id].x || p.y !== avant[id].y))
    setRegle(null)
    if (!Object.keys(bougees).length) return setAnnule({ rien: true, t: Date.now() })
    poseTout(bougees)
    setAnnule({ avant: Object.fromEntries(Object.keys(bougees).map((id) => [id, avant[id]])), t: Date.now() })
  }, [consoles, nodes, poseTout])
  useEffect(() => {
    if (!annule) return
    const t = setTimeout(() => setAnnule(null), annule.rien ? 2500 : 10000)
    return () => clearTimeout(t)
  }, [annule])
  // Ordinateur : le rangement par groupes (rangement.js). `?rangement=orbite` (défaut) ou `?rangement=colonnes` choisit
  // la disposition dans un groupe : les deux variantes sont montrées à Orkun, qui choisira.
  const variante = useMemo(() => (new URLSearchParams(window.location.search).get('rangement') === 'colonnes' ? 'colonnes' : 'orbite'), [])
  const [glisse, setGlisse] = useState(false) // pendant le rangement seulement : les dalles glissent vers leur place
  const finGlisse = useRef(0)
  useEffect(() => () => clearTimeout(finGlisse.current), [])
  // Les dalles glissent ~600 ms (courbe douce, voir lot4-rangement.css) avec un léger décalage d'un groupe à l'autre.
  // La transition n'existe que pendant ce temps : permanente, elle ferait traîner une dalle qu'on glisse à la souris.
  // `delais` : { id: ms }. Sous « réduire les animations », rien ne glisse.
  const glisser = useCallback((delais) => {
    if (reduit()) return
    setNodes((ns) => ns.map((n) => (n.id in delais ? { ...n, style: { ...n.style, '--dec': `${delais[n.id]}ms` } } : n)))
    setGlisse(true)
    clearTimeout(finGlisse.current)
    finGlisse.current = setTimeout(() => {
      setGlisse(false)
      setNodes((ns) => ns.map((n) => (n.style?.['--dec'] ? { ...n, style: undefined } : n)))
    }, Math.max(0, ...Object.values(delais)) + GLISSE_MS + 150)
  }, [])
  // Rend ce qu'il faut pour annuler (places et tailles d'avant, cadrage d'avant), ou { rien: true } quand tout est déjà
  // en place (le cadrage est alors seulement remis sur l'ensemble).
  const enGroupes = useCallback(() => {
    const r = cadre.current?.getBoundingClientRect()
    if (!r?.width || !consoles.length) return null
    const tailles = Object.fromEntries(nodes.map((n) => [n.id, { w: n.width ?? n.data.w, h: n.height ?? n.data.h }]))
    // Le coin haut gauche de l'ensemble ne bouge pas : on reste dans la région du plateau où Orkun travaille.
    // C’est le coin des CADRES qui reste fixe (les dalles sont posées à MARGE_ZONE de ce coin) : pris sur les dalles, chaque
    // nouveau rangement glissait tout de 64 × 170 et « Ranger » deux fois ne disait jamais « Rangé ».
    const origine = { x: Math.min(...consoles.map((c) => c.x)) - MARGE_ZONE.cote, y: Math.min(...consoles.map((c) => c.y)) - MARGE_ZONE.haut }
    const { places, zones: nouvelles, bornes } = rangerParGroupes(consoles, { variante, tailles, origine, forme: r.width / r.height })
    // Le cadrage : tout le plateau s'il tient au zoom où les fenêtres restent des terminaux (≥ 0,5 ; dessous, ce sont
    // des vignettes) ; sinon le groupe de la console active (à défaut le premier : les équipes passent devant), centré
    // sur son milieu — son capitaine — et jamais sous 0,5, quitte à laisser déborder les bords d'un grand groupe.
    // Orkun : « quand on range elle devienne petites alors qu'il y a full de place dans le meydan ».
    const ajuste = (z) => Math.min(r.width / (z.w * 1.1), r.height / (z.h * 1.1))
    const vise = nouvelles.find((z) => z.ids.includes(activeId)) || nouvelles[0]
    const zone = ajuste(bornes) >= 0.5 ? bornes : vise
    const cadrage = () => rf.setCenter(zone.x + zone.w / 2, zone.y + zone.h / 2, { zoom: clamp(ajuste(zone), 0.5, 1), duration: reduit() ? 0 : 800 })
    const avant = Object.fromEntries(consoles.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h }]))
    const bougees = Object.fromEntries(Object.entries(places).filter(([id, p]) => ['x', 'y', 'w', 'h'].some((k) => p[k] !== avant[id][k])))
    if (!Object.keys(bougees).length) {
      cadrage()
      return { rien: true }
    }
    const vue = rf.getViewport()
    const delais = {}
    nouvelles.forEach((z, i) => z.ids.forEach((id) => (delais[id] = Math.min(i * 70, 420))))
    glisser(delais)
    poseTout(bougees, cadrage)
    // Un pas de l'historique (« Ranger ») ; son objet `avant` est aussi ce que garde le bouton « Annuler » de la colonne.
    const pas = hist.note(entree('Ranger', avant, bougees, vue))
    return { avant: pas?.avant ?? Object.fromEntries(Object.keys(bougees).map((id) => [id, avant[id]])), vue }
  }, [consoles, nodes, activeId, variante, rf, poseTout, glisser, hist])

  // Poser des places venues de l'historique ou d'un espace : les dalles glissent (sauf « réduire les animations »), le
  // serveur les reçoit ; `cadrage` (ou rien) recadre le plateau ensuite.
  const versVue = useCallback((v) => () => rf.setViewport(v, { duration: reduit() ? 0 : 700 }), [rf])
  const applique = useCallback(
    (places, cadrage) => {
      if (!Object.keys(places).length) return cadrage?.()
      glisser(Object.fromEntries(Object.keys(places).map((id) => [id, 0])))
      poseTout(places, cadrage || (() => {}))
    },
    [glisser, poseTout],
  )
  // Annuler : la place d'avant de chaque console du pas (les consoles fermées depuis en sont déjà sorties), et la vue
  // d'avant pour un pas qui recadrait. `jusqua` : annuler aussi tout ce qui a suivi ce pas (voir `defait`).
  const defaire = useCallback(
    (jusqua) => {
      const ici = rf.getViewport()
      const places = {}
      let vue = null
      let e
      do {
        e = hist.annule()
        if (!e) break
        Object.assign(places, e.avant) // du plus récent au plus ancien : la place la plus ancienne l'emporte
        if (e.vue) {
          e.vueApres = ici // rétablir remettra la vue d'avant l'annulation
          vue = e.vue
        }
      } while (jusqua && e !== jusqua)
      applique(places, vue && versVue(vue))
    },
    [hist, rf, applique, versVue],
  )
  const refaire = useCallback(() => {
    const e = hist.retablit()
    if (!e) return
    let cadrage = null
    if (e.vue) {
      cadrage = e.vueApres ? versVue(e.vueApres) : null
      e.vue = rf.getViewport() // annuler de nouveau ramène la vue d'avant ce rétablissement
    }
    applique(e.apres, cadrage)
  }, [hist, rf, applique, versVue])
  // Le bouton « Annuler » de la colonne, 10 s après « Ranger » (Rail.jsx → actions.annuleRange) : c'est le pas « Ranger »
  // de l'historique qu'il annule, avec ce qui a été fait après lui (on revient comme avant le rangement). Déjà annulé par
  // Ctrl+Z ou ↶ : rien — un même pas ne s'annule pas deux fois.
  const defait = useCallback(
    (avant) => {
      const pas = hist.trouve((e) => e.avant === avant)
      if (pas) defaire(pas)
    },
    [hist, defaire],
  )
  if (rangerRef) rangerRef.current = { ranger: enGroupes, defait }

  // Dispositions prêtes (Dispositions.jsx) : `places` = { id: { x, y, w, h } } ; un pas de l'historique (Ctrl+Z l'annule,
  // la vue d'avant revient avec lui). Rend false quand rien n'a bougé.
  const disposer = useCallback(
    (libelle, places, cadrage) => {
      const pas = hist.note(entree(libelle, placesDe(Object.keys(places)), places, rf.getViewport()))
      if (!pas) return false
      applique(pas.apres, cadrage)
      return true
    },
    [hist, placesDe, rf, applique],
  )

  // ── Sélection multiple (ordinateur, Selection.jsx) ──
  // Les consoles seulement : une carte du plateau étendu choisie avec elles se déplace avec le groupe (fin du glisser),
  // mais n'est ni rangée, ni fermée, ni comptée par la barre de sélection (ses routes ne sont pas celles des consoles).
  const choisies = useMemo(() => (onOuvre ? [] : nodes.filter((n) => n.selected && !estCarte(n)).map((n) => n.data)), [nodes, onOuvre])
  const multi = choisies.length > 1
  const deselectionne = useCallback(() => setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => (n.selected ? { ...n, selected: false } : n)) : ns)), [])
  // Ranger la sélection : en rangées, chacune garde sa taille, depuis le coin haut gauche de la sélection (le rangement
  // du téléphone, `rangement`), puis à la place libre la plus proche qui ne touche aucune autre dalle (décision d'Orkun
  // du 17/11, plateau-pc-3, selection-place.js) ; puis le plateau se cadre sur elle. Rend false quand tout était déjà en place.
  const rangeSelection = useCallback(() => {
    const r = cadre.current?.getBoundingClientRect()
    const ids = choisies.map((c) => c.id)
    const places = horsDesAutres(rangement(choisies, {}, r?.height ? r.width / r.height : 16 / 9), choisies, nodes, ECART)
    const avant = placesDe(ids)
    const pas = hist.note(entree(`Ranger ${ids.length} consoles`, avant, Object.fromEntries(ids.map((id) => [id, { ...avant[id], ...places[id] }])), rf.getViewport()))
    if (!pas) return false
    applique(pas.apres, () => rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.1, maxZoom: 1, duration: reduit() ? 0 : 700 }))
    return true
  }, [choisies, nodes, placesDe, hist, rf, applique])
  // Fermer la sélection (déjà confirmé dans la barre, capitaines écartés) : pas d'historique, la console est arrêtée.
  const fermeSelection = useCallback(
    (ids) => {
      for (const id of ids) actions.remove(id)
      deselectionne()
    },
    [actions, deselectionne],
  )

  // ── Espaces de travail (Espaces.jsx) : y revenir est un pas de l'historique ──
  const revenir = useCallback(
    (espace) => {
      const ici = new Set(toutes.current.map((c) => c.id))
      const apres = Object.fromEntries(Object.entries(espace.places).filter(([id]) => ici.has(id))) // les fermées depuis : sautées
      const pas = hist.note(entree(`Espace « ${espace.nom} »`, placesDe(Object.keys(apres)), apres, rf.getViewport()))
      applique(pas ? pas.apres : {}, espace.vue && versVue(espace.vue)) // rien n'a bougé : seule la vue revient
    },
    [hist, placesDe, rf, applique, versVue],
  )

  // Clavier (ordinateur) : Ctrl+Z annule, Ctrl+Maj+Z ou Ctrl+Y rétablit, Échap désélectionne — seulement quand le clavier
  // n'est ni dans un terminal (il garde Ctrl+Z, Échap…), ni dans un champ. Rien quand une console est agrandie (le plateau
  // est caché dessous). Sur un clavier belge, Z est une lettre (e.key), pas une position.
  const pleinRef = useRef(plein)
  pleinRef.current = plein
  const multiRef = useRef(0)
  multiRef.current = choisies.length
  useEffect(() => {
    if (onOuvre) return
    const touche = (e) => {
      const t = e.target
      if (pleinRef.current || e.defaultPrevented || t?.isContentEditable || t?.closest?.('.xterm, input, textarea, select, [contenteditable]')) return
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey
      const k = e.key?.toLowerCase()
      if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) refaire()
        else defaire()
      } else if (mod && k === 'y' && !e.shiftKey) {
        e.preventDefault()
        refaire()
      } else if (e.key === 'Escape' && !mod && multiRef.current) deselectionne()
    }
    window.addEventListener('keydown', touche)
    return () => window.removeEventListener('keydown', touche)
  }, [onOuvre, defaire, refaire, deselectionne])
  const etatHist = hist.etat()
  const voirCarte = useStore(horsChamp)
  const zMin = useZoomMin(!!onOuvre, nodes, CADRE_TEL) // téléphone : 0,1 quand le plateau ne tient pas à 0,15 (zoom-tel.js)
  const count = useRef(0)
  count.current = nodes.length
  const onMoveEnd = useCallback((_, v) => {
    if (onOuvre) return // téléphone : rien n'est retenu, le plateau se recadre tout seul
    if (!count.current) return // un cadrage mémorisé sur tapis vide empêcherait le cadrage automatique des premières consoles
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(v))
    } catch {}
  }, [onOuvre])
  const onPaneClick = useCallback(() => {
    setActiveId(null)
    document.activeElement?.blur()
  }, [setActiveId])

  const vivantes = consoles.filter((c) => c.status !== 'closed').length // la veille ne joue qu'à partir de 15 (veille.js)
  const ctx = useMemo(
    () => ({ zs, far, activeId, setActiveId, actions, rev, termLook, onOuvre, toutes, deplace, regle, setRegle, redimensionne, plein, vues, vivantes, multi, debutGeste, finGeste, r3 }),
    [zs, far, activeId, setActiveId, actions, rev, termLook, onOuvre, deplace, regle, redimensionne, plein, vues, vivantes, multi, debutGeste, finGeste, r3],
  )

  return (
    <Ctx.Provider value={ctx}>
      <CartesCtx.Provider value={ctxCartes}>
      <ReactFlow
        ref={cadre}
        className={cls(glisse && 'est-range', multi && 'est-multi')}
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeDrag={reperes.surGlisse}
        onMoveEnd={onMoveEnd}
        onPaneClick={onPaneClick}
        // Maj+appui sur le fond, une barre ou une tuile : le navigateur étendrait la sélection de TEXTE de la page jusque-là
        // (vu au banc : toute la colonne surlignée sous le lasso). Le corps d'une console (terminal, discussion) garde le
        // sien ; les bandeaux du plateau (champ de nom d'un espace) ne sont pas dans le fond.
        onMouseDownCapture={onOuvre ? undefined : (e) => e.shiftKey && e.target.closest?.('.react-flow__pane') && !e.target.closest('.slab-body') && e.preventDefault()}
        defaultViewport={initial.current || undefined}
        minZoom={zMin}
        maxZoom={3}
        // Le clavier appartient aux terminaux : aucun raccourci du canevas, sauf Maj sur l'ordinateur (sélection multiple,
        // Selection.jsx) : Maj+glisser sur le fond = lasso (une console touchée est prise), Maj+clic sur une barre ou une
        // tuile, ou Maj+clic immobile dans un terminal = l'ajouter / la retirer. Écrire des majuscules dans un terminal n'en
        // souffre pas (essai-selection.mjs).
        deleteKeyCode={null}
        selectionKeyCode={onOuvre ? null : 'Shift'}
        multiSelectionKeyCode={onOuvre ? null : 'Shift'}
        selectionMode={SelectionMode.Partial}
        panActivationKeyCode={null}
        // Mac au pavé tactile (16/11, Orkun sur son MacBook : « je dois faire un appuie prolongé afin de me déplacer dans le
        // plateau ce qui n'est pas pratique ») : deux doigts = se déplacer dans tous les sens, pincer = zoom, ⌘ + deux
        // doigts = zoom (le geste d'avant, gardé sous ⌘). Ailleurs (souris de ses PC Windows) : la molette zoome, comme avant.
        panOnScroll={!onOuvre && PAVE_MAC}
        zoomActivationKeyCode={!onOuvre && PAVE_MAC ? 'Meta' : null}
        disableKeyboardA11y
        nodesFocusable={false}
        nodesDraggable={!onOuvre}
        nodesConnectable={false}
        selectNodesOnDrag={false}
        zoomOnDoubleClick={false}
      >
        {rev ? (
          <>
            {/* Téléphone : fond fixe (lot5-memoire.css) ; le dallage, rendu à chaque image du glissement, saccadait. */}
            {!onOuvre && <Dallage />}
            {/* ?reel3=oui : le grand nom, peint sur le sol, sous tout le reste (halos, liens, dalles). */}
            {mots.length > 0 && (
              <ViewportPortal>
                <div className="r3-fond" aria-hidden="true">
                  {mots.map((m) => (
                    <b key={m.id} style={{ left: m.x, top: m.y, fontSize: m.f }}>
                      {m.lignes.map((l, i) => (
                        <span key={i}>{l}</span>
                      ))}
                    </b>
                  ))}
                </div>
              </ViewportPortal>
            )}
            {/* Le halo des consoles qui attendent : une seule couche, sous toutes les dalles. */}
            <ViewportPortal>
              <LiensVivants nodes={nodes} immobile={!!onOuvre} />
            </ViewportPortal>
            <ViewportPortal>
              <div className="halos">
                {nodes
                  .filter((n) => n.data.status === 'needs')
                  .map((n) => (
                    <i key={n.id} style={{ left: n.position.x - 130, top: n.position.y - 120, width: (n.width ?? n.data.w) + 260, height: (n.height ?? n.data.h) + 230 }} />
                  ))}
              </div>
            </ViewportPortal>
          </>
        ) : (
          <>
            <Background id="fin" variant={BackgroundVariant.Lines} gap={24} lineWidth={1} color="rgba(236,228,160,.055)" />
            <Background id="fort" variant={BackgroundVariant.Lines} gap={120} lineWidth={1} color="rgba(236,228,160,.13)" />
          </>
        )}
        {(onOuvre || voirCarte) && <MiniMap pannable zoomable nodeBorderRadius={2} {...MAP[rev ? 'reverbere' : 'tapis']} />}
        {/* Pied du plateau de l'ordinateur, en bas à gauche (la mini-carte est à droite) : l'usage des comptes (« Plusieurs
            comptes Claude / Codex » ; replié sur une ligne, déplié vers le haut ; hors de la colonne depuis l'intégration du
            11/11, la liste sert de « switch » à la console agrandie), puis la barre « Ajouter » du plateau étendu. UN seul
            panneau : posés chacun en bas à gauche, ils se recouvraient (intégration du 12/11 : toucher l'usage créait un
            aperçu web). Téléphone : l'usage est dans le pli, pas de barre « Ajouter ». */}
        {!onOuvre && (
          <Panel position="bottom-left" className="pied-plateau">
            <div className="cpt-panneau nowheel nopan nodrag">
              <Comptes />
            </div>
            <OutilsCartes />
            {/* Une seule barre d'outils, en bas (Orkun, 16/11, sur la capture : « niquel ») : annuler / rétablir, Espaces et
                Disposer y rejoignent « Ajouter » ; le haut du plateau est libre. */}
            {consoles.length > 0 && (
              <div className="pc-dispo pc-dispo-bas">
                <BoutonsHistorique etat={etatHist} onAnnuler={() => defaire()} onRetablir={refaire} />
                <Espaces consoles={consoles} onRevenir={revenir} />
                <Dispositions choisies={choisies} consoles={consoles} activeId={activeId} cadre={cadre} onDisposer={disposer} />
              </div>
            )}
          </Panel>
        )}
        <ZoomWatch onSettle={setZs} onFar={setFar} />
        <PlateauCreatif plein={plein} />
        {reperes.calque}
        {!onOuvre && <ClavierPlateau plein={plein} actions={actions} />}
        {/* Téléphone : une seule barre en haut à droite (le cadrage lui laisse sa bande, aucune dalle n'est dessous) :
            ce qui se passe (réglage de taille, plateau rangé), puis « Ranger ». */}
        {onOuvre && (
          <Panel position="top-right" className="ve-outils">
            <div className="veille-plateau" hidden={!!regle || !!annule}><Veille consoles={consoles} /></div>
            {(regle || annule) && (
              <div className="ve-bandeau" role="status">
                {regle ? (
                  <>
                    <span>Glisse le coin jaune pour agrandir ou réduire</span>
                    <button type="button" onClick={() => setRegle(null)}>
                      Terminé
                    </button>
                  </>
                ) : annule.rien ? (
                  <span>Le plateau est déjà rangé</span>
                ) : (
                  <>
                    <span>Plateau rangé</span>
                    <button
                      type="button"
                      onClick={() => {
                        poseTout(annule.avant)
                        setAnnule(null)
                      }}
                    >
                      Annuler
                    </button>
                  </>
                )}
              </div>
            )}
            {consoles.length > 1 && !regle && (
              <button type="button" className="ve-ranger" onClick={ranger}>
                <i aria-hidden="true" />
                Ranger
              </button>
            )}
          </Panel>
        )}
        {/* Ordinateur : en bas au milieu, la barre de la sélection (dès deux consoles). Rien sur le téléphone. */}
        {multi && <BarreSelection choisies={choisies} onRanger={rangeSelection} onFermer={fermeSelection} onVide={deselectionne} />}
      </ReactFlow>
      </CartesCtx.Provider>
      {consoles.length === 0 && cartes.length === 0 && (
        <div className="mat-empty">
          <b>{rev ? 'La place est vide.' : 'Le tapis est vide.'}</b>
          <span>{rev ? 'Fais entrer une première console depuis la colonne de gauche.' : 'Pose une première console depuis la colonne de gauche.'}</span>
        </div>
      )}
    </Ctx.Provider>
  )
}
