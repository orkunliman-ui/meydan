// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — la carte
// « kanban » : « colonnes nommées (À faire / En cours / Fait par défaut, renommables, réordonnables), cartes glissées d'une
// colonne à l'autre (souris et doigt), « Déplacer au début / à la fin ». »
//
// Ordinateur : des colonnes côte à côte (défilement en largeur quand elles sont nombreuses), une liste de fiches par
// colonne (défilement en hauteur), un champ en bas de chaque colonne (Entrée : une fiche de plus).
//   · colonne : double-clic sur le nom pour renommer ; glisser l'en-tête pour la déplacer ; « ⋯ » : ◀ ▶, Renommer,
//     Retirer (en deux temps, et le second dit combien de fiches partent avec elle) ; « + Colonne » dans la barre.
//   · fiche : double-clic pour modifier ; glisser (souris ou doigt) dans la colonne ou vers une autre, un repère montre où
//     elle tombera ; « ⋯ » : Déplacer au début / à la fin, Vers « <autre colonne> », Modifier, Retirer.
// Le glisser passe par les événements de pointeur (le glisser-déposer HTML5 n'existe pas au toucher) et ne fait aucun
// calcul de décalage dans le plan mis à l'échelle : la colonne visée vient de `document.elementsFromPoint` (coordonnées
// d'écran), la place des milieux des fiches mesurés à l'écran. Il ne part qu'au-delà d'un seuil franc (8 points à la
// souris, 14 au doigt : un doigt qui tremble ne déplace rien). Le corps porte `nodrag nopan nowheel` (Carte.jsx) : une
// fiche tenue ne déplace ni la dalle ni le plateau.
// Chaque changement envoie les colonnes ENTIÈRES (un PATCH), une demande à la fois, et l'écran montre tout de suite le
// dernier état écrit ici (même règle que NoteNode.jsx) ; entre deux appareils, le dernier qui écrit l'emporte.
// Téléphone couché (`tel`) : tuile fixe en lecture — noms des colonnes et leur compte, premières fiches ; aucun champ,
// aucun bouton, aucun défilement, aucune animation, rien ne bouge au doigt. Vue de loin (`far`) : le titre en grand.
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStoreApi } from '@xyflow/react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { cls } from './lib.js'
import './carte-kanban.css'

// = lib/cartes-kanban.mjs (KANBAN, net) : mêmes bornes, même nettoyage des textes.
const MAX = { colonnes: 12, fiches: 150, nom: 40, fiche: 200, texte: 16000 }
// Le corps d'une demande est coupé à 64 Ko (readJson de server.mjs, nginx) : au-delà, le serveur couperait la liaison au
// lieu de répondre 413. Les bornes ci-dessus tiennent sous 60 000 octets au pire cas ; la mesure est la ceinture en plus.
const OCTETS_MAX = 60000
const REMPLACE = String.fromCharCode(0xfffd)
const net = (v) =>
  String(v ?? '')
    .replace(/\p{Cs}/gu, REMPLACE)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const SEUIL = { mouse: 8, pen: 10, touch: 14 } // points d'écran avant qu'un appui devienne un glisser
const TEL_FICHES = 5 // fiches montrées par colonne sur la tuile du téléphone
const nombre = (n) => n.toLocaleString('fr-FR')

// Les colonnes d'une carte telles qu'elles arrivent : un serveur factice peut rendre `{}`, jamais `.length` sans repli.
function colonnesDe(k) {
  return (Array.isArray(k?.colonnes) ? k.colonnes : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ id: String(c.id), nom: String(c.nom ?? ''), fiches: (Array.isArray(c.fiches) ? c.fiches : []).filter((f) => f && typeof f === 'object').map((f) => ({ id: String(f.id), t: String(f.t ?? '') })) }))
}
// Ce qui empêche d'enregistrer ces colonnes (les bornes du serveur, puis le poids de l'envoi) ; '' si rien.
function refusDe(cs) {
  if (cs.length > MAX.colonnes) return `${MAX.colonnes} colonnes au plus`
  let n = 0
  let t = 0
  for (const c of cs) {
    if (c.nom.length > MAX.nom) return `Nom de colonne trop long : ${MAX.nom} caractères au plus`
    n += c.fiches.length
    for (const f of c.fiches) {
      if (f.t.length > MAX.fiche) return `Fiche trop longue : ${MAX.fiche} caractères au plus`
      t += f.t.length
    }
  }
  if (n > MAX.fiches) return `${MAX.fiches} fiches au plus dans un kanban`
  if (t > MAX.texte) return `Kanban plein : ${nombre(MAX.texte)} caractères au plus pour toutes les fiches`
  const octets = new TextEncoder().encode(JSON.stringify({ colonnes: cs })).length
  if (octets > OCTETS_MAX) return `Trop lourd pour un envoi (${nombre(octets)} octets) : rien n’est enregistré`
  return ''
}
// Un identifiant neuf, unique dans la carte (colonnes et fiches ensemble), de la forme permise par le serveur.
function nouvelId(cs) {
  const pris = new Set(cs.flatMap((c) => [c.id, ...c.fiches.map((f) => f.id)]))
  for (;;) {
    const [a, b] = crypto.getRandomValues(new Uint32Array(2))
    const id = (a.toString(36) + b.toString(36)).slice(0, 12)
    if (id && !pris.has(id)) return id
  }
}
const empreinte = (cs) => cs.map((c) => `${c.id}:${c.fiches.map((f) => f.id).join(',')}`).join('|')
// La fiche `fid` posée dans la colonne `cid`, à la place `index` comptée SANS elle. Rend `cs` si rien ne change.
function poseFiche(cs, fid, cid, index) {
  let f = null
  const sans = cs.map((c) => {
    const i = c.fiches.findIndex((x) => x.id === fid)
    if (i < 0) return c
    f = c.fiches[i]
    return { ...c, fiches: c.fiches.filter((x) => x.id !== fid) }
  })
  if (!f || !sans.some((c) => c.id === cid)) return cs
  const res = sans.map((c) => {
    if (c.id !== cid) return c
    const j = Math.max(0, Math.min(index, c.fiches.length))
    return { ...c, fiches: [...c.fiches.slice(0, j), f, ...c.fiches.slice(j)] }
  })
  return empreinte(res) === empreinte(cs) ? cs : res
}
// La colonne `cid` posée à la place `index` comptée SANS elle. Rend `cs` si rien ne change.
function poseColonne(cs, cid, index) {
  const c = cs.find((x) => x.id === cid)
  if (!c) return cs
  const sans = cs.filter((x) => x.id !== cid)
  const j = Math.max(0, Math.min(index, sans.length))
  const res = [...sans.slice(0, j), c, ...sans.slice(j)]
  return empreinte(res) === empreinte(cs) ? cs : res
}
// Le clic que le navigateur tire d'un glisser terminé ne doit rien déclencher (bouton, double-clic) : avalé une fois.
function avaleClic() {
  const stop = (e) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', stop, true)
  setTimeout(() => window.removeEventListener('click', stop, true), 0)
}

// Un champ d'une ligne (nom de colonne) ou de quelques lignes (fiche) : focus à l'ouverture sans faire défiler le
// plateau, Entrée enregistre, Échap renonce, la perte du focus enregistre. Une seule fin.
function Champ({ valeur, max, multi, label, tout, onFin }) {
  const ref = useRef(null)
  const fini = useRef(false)
  const fin = (v) => {
    if (fini.current) return
    fini.current = true
    onFin(v)
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (tout) el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
  }, [tout])
  const props = {
    ref,
    className: cls('cr-kb-champ', multi && 'est-multi'),
    defaultValue: valeur,
    maxLength: max,
    'aria-label': label,
    spellCheck: true,
    onKeyDown: (e) => {
      e.stopPropagation() // le clavier est au champ (aucun raccourci du plateau ni de l'application)
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        fin(e.currentTarget.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        fin(undefined)
      }
    },
    onBlur: (e) => fin(e.currentTarget.value),
  }
  return multi ? <textarea rows={3} {...props} /> : <input type="text" {...props} />
}

// La tuile du téléphone couché : rien qui se touche, rien qui défile, rien qui bouge.
function TuileTel({ colonnes }) {
  if (!colonnes.length) return <p className="cr-kb-tel-vide">Aucune colonne</p>
  return (
    <div className="cr-kb-tel">
      {colonnes.map((c) => (
        <section key={c.id} className="cr-kb-tel-col">
          <p className="cr-kb-tel-tete">
            <span className="cr-kb-tel-nom">{c.nom}</span>
            <span className="cr-kb-tel-compte">{c.fiches.length}</span>
          </p>
          <ul className="cr-kb-tel-liste">
            {c.fiches.slice(0, TEL_FICHES).map((f) => (
              <li key={f.id} className="cr-kb-tel-fiche">
                {f.t}
              </li>
            ))}
          </ul>
          {c.fiches.length > TEL_FICHES && <p className="cr-kb-tel-suite">+ {c.fiches.length - TEL_FICHES}</p>}
        </section>
      ))}
    </div>
  )
}

export const KanbanNode = memo(function KanbanNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const store = useStoreApi()
  const recues = useMemo(() => colonnesDe(k), [k.colonnes])
  // Le dernier état écrit ICI, et `t` la date que le serveur lui a donnée (Infinity tant qu'il ne l'a pas rendu). Il
  // l'emporte sur la carte tant qu'elle n'a pas été modifiée après lui : l'écho d'un envoi plus ancien qui revient par le
  // flux ne le remplace pas, un autre appareil qui écrit ensuite, si.
  const [local, setLocal] = useState(null)
  const colonnes = local && local.t >= (k.modifieLe || 0) ? local.colonnes : recues
  const derniere = useRef(colonnes) // ce sur quoi le prochain changement se calcule (deux changements de suite se composent)
  derniere.current = colonnes
  const [erreur, setErreur] = useState('')
  const [renomme, setRenomme] = useState(null) // la colonne dont le nom s'écrit
  const [edite, setEdite] = useState(null) // la fiche qui s'écrit
  const [menu, setMenu] = useState(null) // « ⋯ » ouvert : { quoi: 'col' | 'fiche', id }
  const [arme, setArme] = useState(null) // la colonne dont « Retirer » attend sa confirmation
  const [glisse, setGlisse] = useState(null) // { quoi, id, w, z, x, y, cible: { col, index } | null }
  const racine = useRef(null) // le tableau (il défile en largeur)
  const fantome = useRef(null)
  const tenu = useRef(null) // l'appui en cours (souris ou doigt), avant et pendant le glisser
  const file = useRef(Promise.resolve())
  const numero = useRef(0)

  // ── Écrire : les colonnes entières, une demande à la fois ──
  const change = useCallback(
    (f) => {
      const avant = derniere.current
      const apres = f(avant)
      if (apres === avant) return false
      const refus = refusDe(apres)
      if (refus) {
        setErreur(refus)
        return false
      }
      setErreur('')
      derniere.current = apres
      const n = ++numero.current
      setLocal({ colonnes: apres, t: Infinity })
      file.current = file.current
        .then(() => actions.patch(id, { colonnes: apres }))
        .then(
          ({ carte }) => n === numero.current && setLocal({ colonnes: colonnesDe(carte), t: carte?.modifieLe ?? 0 }),
          (e) => {
            setErreur(e?.message || 'refusé par le serveur')
            if (n === numero.current) setLocal(null) // l'écran reprend ce que le serveur a vraiment (cartes.js relit)
          },
        )
      return true
    },
    [actions, id],
  )
  // Un refus s'efface après un moment, au changement suivant, ou par son « × » (il couvre le bas des colonnes).
  useEffect(() => {
    if (!erreur) return
    const t = setTimeout(() => setErreur(''), 8000)
    return () => clearTimeout(t)
  }, [erreur])

  const ajouteColonne = () => {
    const nid = nouvelId(derniere.current)
    if (!change((cs) => [...cs, { id: nid, nom: 'Nouvelle colonne', fiches: [] }])) return
    setRenomme(nid)
    requestAnimationFrame(() => racine.current && (racine.current.scrollLeft = racine.current.scrollWidth))
  }
  const renommeColonne = (cid, v) => {
    setRenomme(null)
    const nom = net(v)
    if (v === undefined || !nom) return // Échap, ou un nom vide : rien ne change
    change((cs) => (cs.some((c) => c.id === cid && c.nom !== nom) ? cs.map((c) => (c.id === cid ? { ...c, nom } : c)) : cs))
  }
  const retireColonne = (cid) => change((cs) => cs.filter((c) => c.id !== cid))
  const deplaceColonne = (cid, index) => change((cs) => poseColonne(cs, cid, index))
  const ajouteFiche = (cid, v) => {
    const t = net(v)
    if (!t) return false
    const nid = nouvelId(derniere.current)
    return change((cs) => cs.map((c) => (c.id === cid ? { ...c, fiches: [...c.fiches, { id: nid, t }] } : c)))
  }
  const modifieFiche = (fid, v) => {
    setEdite(null)
    const t = net(v)
    if (v === undefined || !t) return
    change((cs) => (cs.some((c) => c.fiches.some((f) => f.id === fid && f.t !== t)) ? cs.map((c) => ({ ...c, fiches: c.fiches.map((f) => (f.id === fid ? { ...f, t } : f)) })) : cs))
  }
  const retireFiche = (fid) => change((cs) => cs.map((c) => (c.fiches.some((f) => f.id === fid) ? { ...c, fiches: c.fiches.filter((f) => f.id !== fid) } : c)))
  const deplaceFiche = (fid, cid, index) => change((cs) => poseFiche(cs, fid, cid, index))

  // Le champ où l'on écrit rend la carte choisie, comme un clic (même appel que React Flow) : elle passe devant ses voisines.
  const choisis = () => {
    const s = store.getState()
    if (s.elementsSelectable && !s.nodeLookup.get(id)?.selected) s.addSelectedNodes([id])
  }

  // « ⋯ » se referme à un appui ailleurs et à Échap.
  useEffect(() => {
    if (!menu) return
    const ferme = () => {
      setMenu(null)
      setArme(null)
    }
    const ailleurs = (e) => (!racine.current?.contains(e.target) || !e.target.closest?.('.cr-kb-tiroir, .cr-kb-plus')) && ferme()
    const echap = (e) => e.key === 'Escape' && ferme()
    document.addEventListener('pointerdown', ailleurs, true)
    window.addEventListener('keydown', echap)
    return () => {
      document.removeEventListener('pointerdown', ailleurs, true)
      window.removeEventListener('keydown', echap)
    }
  }, [menu])

  // ── Glisser (souris, doigt, stylet) ──
  // La cible sous le pointeur, en coordonnées d'écran. La première dalle du plateau sous le pointeur doit être CE kanban :
  // une carte posée par-dessus n'est jamais une cible.
  function sousPointeur(x, y) {
    const ici = racine.current
    if (!ici) return null
    const pile = document.elementsFromPoint(x, y)
    const dalle = pile.find((n) => n.classList?.contains('react-flow__node'))
    if (!dalle || !dalle.contains(ici)) return null
    return pile.filter((n) => ici.contains(n))
  }
  function cibleFiche(x, y, fid) {
    const pile = sousPointeur(x, y)
    const col = pile?.find((n) => n.matches?.('[data-kb-col]'))
    if (!col) return null
    const fiches = [...col.querySelectorAll('[data-kb-fiche]')].filter((n) => n.dataset.kbFiche !== fid)
    let index = fiches.length
    for (let i = 0; i < fiches.length; i++) {
      const r = fiches[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) {
        index = i
        break
      }
    }
    return { col: col.dataset.kbCol, index }
  }
  function cibleColonne(x, y, cid) {
    const pile = sousPointeur(x, y)
    if (!pile?.length) return null
    const cols = [...racine.current.querySelectorAll('[data-kb-col]')].filter((n) => n.dataset.kbCol !== cid)
    let index = cols.length
    for (let i = 0; i < cols.length; i++) {
      const r = cols[i].getBoundingClientRect()
      if (x < r.left + r.width / 2) {
        index = i
        break
      }
    }
    return { col: '', index }
  }
  // Près d'un bord, le tableau (en largeur) et la liste visée (en hauteur) défilent un peu à chaque mouvement.
  function defile(x, y, t) {
    const ici = racine.current
    if (!ici) return
    const m = 24 * t.z
    const rb = ici.getBoundingClientRect()
    if (y >= rb.top && y <= rb.bottom && ici.scrollWidth > ici.clientWidth) {
      if (x < rb.left + m) ici.scrollLeft -= 14
      else if (x > rb.right - m) ici.scrollLeft += 14
    }
    if (t.quoi !== 'fiche') return
    const liste = sousPointeur(x, y)?.find((n) => n.classList?.contains('cr-kb-liste'))
    if (!liste || liste.scrollHeight <= liste.clientHeight) return
    const rl = liste.getBoundingClientRect()
    if (y < rl.top + m) liste.scrollTop -= 10
    else if (y > rl.bottom - m) liste.scrollTop += 10
  }
  // Les écoutes de window appellent les gestionnaires de ce rendu-ci (ils lisent l'état courant).
  const h = useRef({})
  const relais = useRef(null)
  if (!relais.current)
    relais.current = {
      bouge: (e) => h.current.bouge(e),
      lache: (e) => h.current.lache(e),
      annule: (e) => h.current.annule(e),
      touche: (e) => h.current.touche(e),
    }
  const ecoute = (oui) => {
    const f = (oui ? window.addEventListener : window.removeEventListener).bind(window)
    f('pointermove', relais.current.bouge)
    f('pointerup', relais.current.lache)
    f('pointercancel', relais.current.annule)
    f('keydown', relais.current.touche, true)
  }
  useEffect(() => () => ecoute(false), []) // la dalle démontée en plein geste : plus aucune écoute
  const finGlisser = () => {
    tenu.current = null
    ecoute(false)
    setGlisse(null)
  }
  h.current.bouge = (e) => {
    const t = tenu.current
    if (!t || e.pointerId !== t.pid) return
    // Plus aucun bouton enfoncé : le lâcher n'est jamais arrivé jusqu'ici (relâché au-dessus d'un aperçu web, hors de la
    // fenêtre…). Le glisser s'arrête sans rien déplacer, au lieu de rester pris jusqu'au rechargement.
    if (e.pointerType !== 'touch' && e.buttons === 0) return finGlisser()
    if (!t.actif) {
      if (Math.hypot(e.clientX - t.x0, e.clientY - t.y0) < t.seuil) return // un doigt qui tremble ne glisse rien
      const r = t.el.getBoundingClientRect()
      t.z = r.width / (t.el.offsetWidth || r.width || 1) || 1 // l'échelle du plan, lue à l'écran
      t.ox = t.x0 - r.left
      t.oy = t.y0 - r.top
      t.actif = true
      setMenu(null)
      setArme(null)
      setGlisse({ quoi: t.quoi, id: t.id, w: t.el.offsetWidth, z: t.z, x: e.clientX - t.ox, y: e.clientY - t.oy, cible: null })
    }
    if (fantome.current) fantome.current.style.transform = `translate(${e.clientX - t.ox}px, ${e.clientY - t.oy}px) scale(${t.z})`
    defile(e.clientX, e.clientY, t)
    const cible = t.quoi === 'fiche' ? cibleFiche(e.clientX, e.clientY, t.id) : cibleColonne(e.clientX, e.clientY, t.id)
    if (cible?.col !== t.cible?.col || cible?.index !== t.cible?.index) {
      t.cible = cible
      setGlisse((g) => g && { ...g, cible, x: e.clientX - t.ox, y: e.clientY - t.oy })
    }
  }
  h.current.lache = (e) => {
    const t = tenu.current
    if (!t || e.pointerId !== t.pid) return
    finGlisser()
    if (!t.actif) return // un appui sans glisser : clic et double-clic suivent leur cours
    avaleClic()
    const cible = t.quoi === 'fiche' ? cibleFiche(e.clientX, e.clientY, t.id) : cibleColonne(e.clientX, e.clientY, t.id)
    if (!cible) return // lâchée hors du kanban : rien ne change
    if (t.quoi === 'fiche') deplaceFiche(t.id, cible.col, cible.index)
    else deplaceColonne(t.id, cible.index)
  }
  h.current.annule = (e) => {
    const t = tenu.current
    if (t && e.pointerId === t.pid) finGlisser() // le navigateur a repris le geste : rien ne change
  }
  h.current.touche = (e) => {
    if (e.key !== 'Escape' || !tenu.current?.actif) return
    e.stopPropagation()
    e.preventDefault()
    finGlisser()
  }
  const appui = (e, quoi, cid) => {
    if (tel || far || !e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target.closest('button, input, textarea, a, .cr-kb-tiroir')) return
    if (tenu.current) finGlisser() // un appui précédent dont le lâcher s'est perdu : il ne bloque pas celui-ci
    tenu.current = { quoi, id: cid, el: e.currentTarget, pid: e.pointerId, x0: e.clientX, y0: e.clientY, seuil: SEUIL[e.pointerType] ?? 10, actif: false, cible: null, z: 1 }
    ecoute(true)
  }

  // La molette sur le tableau (hors d'une liste qui défile) le fait défiler en largeur.
  const roule = (e) => {
    const ici = racine.current
    if (!ici || e.deltaX || ici.scrollWidth <= ici.clientWidth) return
    const liste = e.target.closest('.cr-kb-liste')
    if (liste && liste.scrollHeight > liste.clientHeight) return
    ici.scrollLeft += e.deltaY
  }

  // ── Rendu ──
  const nbCol = colonnes.length
  const outils = (
    <button type="button" className="cr-kb-outil nodrag" onClick={ajouteColonne} disabled={nbCol >= MAX.colonnes} title={nbCol >= MAX.colonnes ? `${MAX.colonnes} colonnes au plus` : 'Ajouter une colonne'}>
      + Colonne
    </button>
  )
  const g = glisse
  const texteGlisse = g && (g.quoi === 'col' ? colonnes.find((c) => c.id === g.id)?.nom : colonnes.flatMap((c) => c.fiches).find((f) => f.id === g.id)?.t)
  // Le repère des colonnes : avant la colonne visée, ou après la dernière.
  const autresCols = g?.quoi === 'col' ? colonnes.filter((c) => c.id !== g.id) : colonnes
  const icol = g?.quoi === 'col' && g.cible ? g.cible.index : -1
  const colAvant = icol >= 0 && icol < autresCols.length ? autresCols[icol].id : null
  const colApres = icol >= 0 && icol >= autresCols.length && autresCols.length ? autresCols[autresCols.length - 1].id : null

  const colonne = (c, i) => {
    const autres = g?.quoi === 'fiche' ? c.fiches.filter((f) => f.id !== g.id) : c.fiches
    const ici = g?.quoi === 'fiche' && g.cible?.col === c.id ? g.cible.index : -1
    const avant = ici >= 0 && ici < autres.length ? autres[ici].id : null
    const apres = ici >= 0 && ici >= autres.length && autres.length ? autres[autres.length - 1].id : null
    const vide = ici >= 0 && !autres.length
    const menuCol = menu?.quoi === 'col' && menu.id === c.id
    const n = c.fiches.length
    return (
      <section key={c.id} data-kb-col={c.id} className={cls('cr-kb-col', g?.quoi === 'col' && g.id === c.id && 'est-tenue', colAvant === c.id && 'repere-avant', colApres === c.id && 'repere-apres')} aria-label={`Colonne ${c.nom}`}>
        <header className="cr-kb-tete" onPointerDown={(e) => appui(e, 'col', c.id)} title="Glisser l’en-tête : déplacer la colonne · double-clic sur le nom : renommer">
          {renomme === c.id ? (
            <Champ valeur={c.nom} max={MAX.nom} label="Nom de la colonne" tout onFin={(v) => renommeColonne(c.id, v)} />
          ) : (
            <span className="cr-kb-nom" onDoubleClick={() => setRenomme(c.id)}>
              {c.nom}
            </span>
          )}
          <span className="cr-kb-compte" aria-label={`${n} fiche${n > 1 ? 's' : ''}`}>
            {n}
          </span>
          <button type="button" className="cr-kb-plus" aria-label={`Actions de la colonne « ${c.nom} »`} aria-expanded={menuCol} title="Déplacer, renommer, retirer la colonne" onClick={() => (setArme(null), setMenu(menuCol ? null : { quoi: 'col', id: c.id }))}>
            ⋯
          </button>
        </header>
        {menuCol && (
          <div className="cr-kb-tiroir est-colonne" role="group" aria-label={`Actions de la colonne « ${c.nom} »`}>
            <button type="button" disabled={i === 0} onClick={() => deplaceColonne(c.id, i - 1)}>
              ◀ Vers la gauche
            </button>
            <button type="button" disabled={i === nbCol - 1} onClick={() => deplaceColonne(c.id, i + 1)}>
              Vers la droite ▶
            </button>
            <button type="button" onClick={() => (setMenu(null), setRenomme(c.id))}>
              Renommer
            </button>
            <button
              type="button"
              className={cls('cr-kb-retire', arme === c.id && 'est-armee')}
              onClick={() => {
                if (arme !== c.id) return setArme(c.id)
                setArme(null)
                setMenu(null)
                retireColonne(c.id)
              }}
            >
              {arme !== c.id ? 'Retirer la colonne' : n ? `Retirer « ${c.nom} » et ${n > 1 ? `ses ${n} fiches` : 'sa fiche'} ?` : `Retirer « ${c.nom} » ?`}
            </button>
          </div>
        )}
        <ol className={cls('cr-kb-liste', vide && 'repere-vide')}>
          {c.fiches.map((f, j) => {
            const menuFiche = menu?.quoi === 'fiche' && menu.id === f.id
            return (
              <li
                key={f.id}
                data-kb-fiche={f.id}
                className={cls('cr-kb-fiche', g?.id === f.id && 'est-tenue', avant === f.id && 'repere-avant', apres === f.id && 'repere-apres')}
                onPointerDown={(e) => edite !== f.id && appui(e, 'fiche', f.id)}
                onDoubleClick={(e) => !e.target.closest('button, textarea, .cr-kb-tiroir') && (setMenu(null), setEdite(f.id))}
              >
                {edite === f.id ? (
                  <Champ valeur={f.t} max={MAX.fiche} multi label="Texte de la fiche" onFin={(v) => modifieFiche(f.id, v)} />
                ) : (
                  <p className="cr-kb-texte">{f.t}</p>
                )}
                {edite !== f.id && (
                  <button type="button" className="cr-kb-plus" aria-label="Actions de la fiche" aria-expanded={menuFiche} title="Déplacer, modifier, retirer la fiche" onClick={() => setMenu(menuFiche ? null : { quoi: 'fiche', id: f.id })}>
                    ⋯
                  </button>
                )}
                {menuFiche && (
                  <div className="cr-kb-tiroir" role="group" aria-label="Actions de la fiche">
                    <button type="button" disabled={j === 0} onClick={() => (setMenu(null), deplaceFiche(f.id, c.id, 0))}>
                      Déplacer au début
                    </button>
                    <button type="button" disabled={j === n - 1} onClick={() => (setMenu(null), deplaceFiche(f.id, c.id, Infinity))}>
                      Déplacer à la fin
                    </button>
                    {colonnes
                      .filter((x) => x.id !== c.id)
                      .map((x) => (
                        <button key={x.id} type="button" className="cr-kb-vers" title={`Vers « ${x.nom} » (à la fin)`} onClick={() => (setMenu(null), deplaceFiche(f.id, x.id, Infinity))}>
                          Vers « {x.nom} »
                        </button>
                      ))}
                    <button type="button" onClick={() => (setMenu(null), setEdite(f.id))}>
                      Modifier
                    </button>
                    <button type="button" className="cr-kb-retire" onClick={() => (setMenu(null), retireFiche(f.id))}>
                      Retirer
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <input
          type="text"
          className="cr-kb-ajout"
          placeholder="+ Fiche (Entrée)"
          maxLength={MAX.fiche}
          enterKeyHint="enter"
          aria-label={`Ajouter une fiche à « ${c.nom} »`}
          onKeyDown={(e) => {
            e.stopPropagation()
            const champ = e.currentTarget
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!ajouteFiche(c.id, champ.value)) return
              champ.value = ''
              const liste = champ.closest('[data-kb-col]')?.querySelector('.cr-kb-liste')
              requestAnimationFrame(() => liste && (liste.scrollTop = liste.scrollHeight))
            } else if (e.key === 'Escape') {
              champ.value = ''
              champ.blur()
            }
          }}
        />
      </section>
    )
  }

  let corps = null
  if (tel) corps = <TuileTel colonnes={colonnes} />
  else if (!far)
    corps = (
      <>
        <div ref={racine} className={cls('cr-kb', g && 'est-glisse')} onFocus={choisis} onWheel={roule}>
          {nbCol ? colonnes.map(colonne) : <p className="cr-kb-vide">Aucune colonne. « + Colonne » dans la barre pour en ajouter une.</p>}
        </div>
        {erreur && (
          <p className="cr-kb-erreur" role="alert">
            <span>{erreur}</span>
            <button type="button" className="cr-kb-erreur-ferme" aria-label="Fermer le message" title="Fermer" onClick={() => setErreur('')}>
              ×
            </button>
          </p>
        )}
        {g &&
          createPortal(
            <div ref={fantome} className={cls('cr-kb-fantome', g.quoi === 'col' && 'est-colonne')} style={{ width: g.w, transform: `translate(${g.x}px, ${g.y}px) scale(${g.z})` }} aria-hidden="true">
              {texteGlisse}
            </div>,
            document.body,
          )}
      </>
    )

  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre="Kanban" outils={outils}>
      {corps}
    </Carte>
  )
})
