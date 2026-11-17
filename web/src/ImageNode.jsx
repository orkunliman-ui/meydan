// Plateau créatif (volet du 13/11) — la carte « image ». Demande (brief du volet, mot pour mot) : « Images insérées et
// annotées : coller / glisser une image sur le plateau → carte image (fichier gardé dans DATA, taille bornée, types image
// seulement, servie derrière la porte de session) ; annoter par-dessus au stylo ; « Envoyer à une console » réutilise la
// barre d'envoi existante (pièce jointe). » Et au téléphone : « chaque carte est une tuile fixe en lecture ».
//
//   ImageNode    la dalle : l'image (object-fit: contain) et ses traits par-dessus (SurfaceTraits, Encre.jsx : même
//                cadrage, repère = taille naturelle de l'image) ; outils « Annoter » (couleurs, Gomme, « Fini ») et
//                « Envoyer à… » (panneau à côté de la carte : les consoles ouvertes, puis la VRAIE barre d'envoi, Envoi.jsx,
//                avec l'image composée — image + traits — en pièce jointe ; rien ne part sans « Envoyer »).
//   poseImage    crée la carte aux proportions de l'image, puis envoie le fichier (POST /api/envois/cartes/<id>/image,
//                lib/cartes-image.mjs) ; un envoi refusé retire la carte et lève une erreur lisible.
//   DepotImages  ordinateur : Ctrl+V d'une image hors d'un terminal, d'un champ ou d'une console → carte au milieu de
//                l'écran ; image glissée du bureau sur le plateau (pas sur une console, qui garde son propre dépôt) →
//                carte au point de dépôt.
// Téléphone couché (`tel`) : tuile fixe, l'image et ses traits peints, aucun bouton, rien ne bouge au doigt.
// Vue de loin sur l'ordinateur (`far`) : le titre en grand, corps vide (comme les autres cartes).
import { memo, useContext, useEffect, useRef, useState } from 'react'
import { NodeToolbar, Panel, Position, useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { COULEURS, NOM_COULEUR, TYPES_CARTES } from './cartes-types.js'
import { SurfaceTraits } from './Encre.jsx'
import { lisTraits, peinsTraits } from './traits.js'
import { Envoi } from './Envoi.jsx'
import { shrinkImage } from './envoi.js'
import { api, cls, KIND_TAG, statusOf } from './lib.js'
import './carte-image.css'

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] // = lib/cartes-image.mjs (reconnus là par le contenu)
const IMAGE_MAX = 10 * 1024 * 1024 // = lib/cartes-image.mjs
const BARRE = 34 // hauteur de la barre du cadre (cartes.css)
const BOITE = { w: 640, h: 480 } // une image neuve tient dans cette boîte, jamais agrandie
const LARGEUR_NEUVE = 300 // assez pour la barre et ses deux outils
const TEL_PIXELS_MAX = 2560 * 2560 // au téléphone, au-delà : pas d'image décodée sur la tuile (voir ImageNode)
const adresse = (k) => `/api/cartes/${k.id}/image?v=${encodeURIComponent(k.fichier)}`
// Le nom du fichier sans son extension devient le titre ; « image.png » (un collage) n'en donne pas.
const titreDe = (nom) => {
  const t = String(nom || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim()
  return /^(image|blob|clipboard|)$/i.test(t) ? '' : t.slice(0, 80)
}

// La carte neuve devient la carte choisie (même appel que le clic de React Flow), une fois son nœud arrivé.
async function choisisCarte(store, id) {
  for (let i = 0; i < 30 && !store.getState().nodeLookup.has(id); i++) await new Promise(requestAnimationFrame)
  const s = store.getState()
  if (s.nodeLookup.has(id) && s.elementsSelectable) s.addSelectedNodes([id])
}

async function envoieImage(id, f) {
  const r = await fetch(`/api/envois/cartes/${id}/image`, { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f }).catch(() => {
    throw new Error('Liaison coupée pendant l’envoi de l’image : rien n’est posé.')
  })
  if (r.status === 401) location.reload() // session finie
  const j = await r.json().catch(() => ({})) // un refus de nginx (413) n'est pas du JSON
  if (!r.ok || !j.carte) throw new Error(`Image refusée : ${j.error || (r.status === 413 ? 'trop lourde' : `erreur ${r.status}`)}.`)
  return j.carte
}

// Pose une image (un File du navigateur) sur le plateau, en (x, y) du plan : coin haut gauche, ou milieu si `centre`.
// Rend la carte (avec son image). Appelée par la barre « Ajouter » (Cartes.jsx, « Image… ») et par DepotImages.
export async function poseImage({ actions, fichier, x, y, centre = false }) {
  if (!fichier || !String(fichier.type).startsWith('image/')) throw new Error('Ce fichier n’est pas une image : rien n’est posé.')
  const f = await shrinkImage(fichier) // photos réduites à 2 560 px (barre d'envoi) ; HEIC lisible → JPEG
  if (!TYPES.includes(f.type)) throw new Error(`Format d’image non pris (${f.type || 'inconnu'}) : PNG, JPEG, GIF ou WEBP.`)
  if (f.size > IMAGE_MAX) throw new Error('Image trop lourde : 10 Mo au plus.')
  let nat
  try {
    const bmp = await createImageBitmap(f)
    nat = { l: bmp.width, h: bmp.height }
    bmp.close()
  } catch {
    throw new Error('Image illisible : rien n’est posé.')
  }
  // La carte prend les proportions de l'image (le corps sous la barre), dans les bornes du type.
  const t = TYPES_CARTES.image
  const s = Math.min(1, BOITE.w / nat.l, BOITE.h / nat.h)
  const w = Math.min(2400, Math.max(LARGEUR_NEUVE, Math.round(nat.l * s)))
  const h = Math.min(1600, Math.max(t.min.h, Math.round(nat.h * s) + BARRE))
  const coin = centre ? { x: x - w / 2, y: y - h / 2 } : { x, y }
  const titre = titreDe(fichier.name)
  const k = await actions.cree('image', { x: Math.round(coin.x), y: Math.round(coin.y), w, h, ...(titre ? { titre } : {}) })
  try {
    return await envoieImage(k.id, f)
  } catch (e) {
    await actions.retire(k.id).catch(() => {})
    throw e
  }
}

// L'image telle qu'on la voit : l'image à sa taille naturelle (largeur × hauteur de la carte, le repère des traits), les
// traits peints dessus comme à l'écran (peinsTraits de traits.js : même chemin lissé que SurfaceTraits, couleurs du thème
// en cours), en PNG. Les traits sont ceux du magasin, tenu à jour par la SurfaceTraits montée dans la carte.
async function compose(k) {
  const r = await fetch(adresse(k)).catch(() => null) // déjà en cache : c'est l'image affichée
  if (r?.status === 401) location.reload()
  if (!r?.ok) throw new Error('image introuvable')
  const bmp = await createImageBitmap(await r.blob())
  const toile = document.createElement('canvas')
  toile.width = k.largeur || bmp.width
  toile.height = k.hauteur || bmp.height
  const g = toile.getContext('2d')
  g.drawImage(bmp, 0, 0, toile.width, toile.height)
  bmp.close()
  peinsTraits(g, lisTraits(k.id))
  const blob = await new Promise((res) => toile.toBlob(res, 'image/png'))
  if (!blob) throw new Error('image impossible à composer')
  return new File([blob], `${titreDe(k.titre) || 'image'}.png`, { type: 'image/png' })
}

// Les consoles ouvertes, tenues à jour par le flux d'état (relayé par lib.js : « meydan:flux ») : le statut sert aux
// gardes de la barre d'envoi (agent qui attend un choix). Tolère une réponse `{}`.
function useConsoles() {
  const [cs, setCs] = useState([])
  useEffect(() => {
    let vivant = true
    api('GET', '/api/consoles').then((j) => vivant && setCs(Array.isArray(j?.consoles) ? j.consoles : []), () => {})
    const recu = (e) => {
      const m = e.detail
      if (m?.type === 'snapshot' && Array.isArray(m.consoles)) setCs(m.consoles)
      else if (m?.type === 'console' && m.console?.id) setCs((l) => (l.some((c) => c.id === m.console.id) ? l.map((c) => (c.id === m.console.id ? m.console : c)) : [...l, m.console]))
      else if (m?.type === 'removed') setCs((l) => l.filter((c) => c.id !== m.id))
    }
    window.addEventListener('meydan:flux', recu)
    return () => {
      vivant = false
      window.removeEventListener('meydan:flux', recu)
    }
  }, [])
  return cs.filter((c) => c?.id && c.status !== 'closed')
}

// Le panneau « Envoyer à… » : la liste des consoles, puis la barre d'envoi de la console choisie, l'image jointe.
function PanneauEnvoi({ k, onFerme }) {
  const consoles = useConsoles()
  const [cible, setCible] = useState(null)
  const [etat, setEtat] = useState('') // '' | 'compose' | 'parti' | 'erreur : …'
  const joint = useRef(null) // la fonction de la barre d'envoi qui ajoute des pièces jointes
  const c = consoles.find((x) => x.id === cible)
  useEffect(() => {
    if (!cible) return
    let fini = false
    setEtat('compose')
    compose(k).then(
      (f) => {
        if (fini) return
        joint.current?.([f])
        setEtat('')
      },
      (e) => !fini && setEtat(`erreur : ${e.message}`),
    )
    return () => {
      fini = true
    }
  }, [cible]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (etat !== 'parti') return
    const t = setTimeout(onFerme, 1400)
    return () => clearTimeout(t)
  }, [etat, onFerme])
  return (
    <>
      <div className="cr-im-tete">
        {c && (
          <button type="button" className="cr-im-bouton" onClick={() => (setCible(null), setEtat(''))} title="Choisir une autre console">
            ‹
          </button>
        )}
        <b>{c ? `Envoyer à « ${c.name} »` : 'Envoyer l’image à…'}</b>
        <button type="button" className="cr-im-bouton" onClick={onFerme} aria-label="Fermer" title="Fermer (Échap)">
          ×
        </button>
      </div>
      {etat === 'parti' ? (
        <p className="cr-im-dit" role="status">
          Parti.
        </p>
      ) : c ? (
        <>
          {etat && (
            <p className={cls('cr-im-dit', etat.startsWith('erreur') && 'est-echec')} role={etat.startsWith('erreur') ? 'alert' : 'status'}>
              {etat === 'compose' ? 'Image en préparation…' : etat}
            </p>
          )}
          <Envoi key={c.id} console={c} forme="fil" clavier focus jointRef={joint} onEnvoye={() => setEtat('parti')} />
        </>
      ) : cible ? (
        <p className="cr-im-dit est-echec">Cette console est fermée.</p>
      ) : consoles.length ? (
        <ul className="cr-im-liste" aria-label="Consoles ouvertes">
          {consoles.map((x) => (
            <li key={x.id}>
              <button type="button" className="cr-im-console" onClick={() => setCible(x.id)}>
                <span>{x.name || x.id}</span>
                <small>
                  {KIND_TAG[x.kind] || ''} · {statusOf(x.status).label}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cr-im-dit">Aucune console ouverte.</p>
      )}
    </>
  )
}

export const ImageNode = memo(function ImageNode({ id, data: k, width, height, selected }) {
  const { far, tel } = useContext(CartesCtx)
  const store = useStoreApi()
  const [mode, setMode] = useState(null) // annotation : null | 'stylo' | 'gomme'
  const [couleur, setCouleur] = useState('rouge')
  const [panneau, setPanneau] = useState(null) // null | 'droite' | 'gauche' (côté de la carte où il s'ouvre)
  const [casse, setCasse] = useState(false) // l'image n'a pas pu s'afficher
  const ferme = useRef(() => setPanneau(null)).current
  const image = !!k.fichier

  useEffect(() => setCasse(false), [k.fichier])
  // De loin ou au téléphone : ni annotation ni panneau.
  useEffect(() => {
    if (far || tel) {
      setMode(null)
      setPanneau(null)
    }
  }, [far, tel])
  // Échap finit l'annotation (pas quand le clavier est dans un champ ou un terminal).
  useEffect(() => {
    if (!mode) return
    const touche = (e) => {
      if (e.key !== 'Escape' || e.target?.closest?.('.xterm, input, textarea, select, [contenteditable]')) return
      setMode(null)
    }
    window.addEventListener('keydown', touche)
    return () => window.removeEventListener('keydown', touche)
  }, [mode])

  const choisis = () => {
    const s = store.getState()
    if (s.elementsSelectable && !s.nodeLookup.get(id)?.selected) s.addSelectedNodes([id])
  }
  const annote = () => {
    choisis()
    setPanneau(null)
    setMode('stylo')
  }
  // Le panneau s'ouvre à droite de la carte, à gauche s'il n'y a pas la place.
  const ouvre = () => {
    if (panneau) return setPanneau(null)
    choisis()
    setMode(null)
    const r = store.getState().domNode?.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect()
    setPanneau(r && r.right + 420 > window.innerWidth && r.left > 420 ? 'gauche' : 'droite')
  }

  const outils = image && (
    <>
      {mode ? (
        <button type="button" className="cr-im-bouton nodrag est-pris" onClick={() => setMode(null)} aria-label="Finir l’annotation" title="Finir l’annotation (Échap)">
          <span className="cr-im-long">Fini</span>
          <span className="cr-im-court" aria-hidden="true">✓</span>
        </button>
      ) : (
        <button type="button" className="cr-im-bouton nodrag" onClick={annote} aria-label="Annoter" title="Annoter au stylo">
          <span className="cr-im-long">Annoter</span>
          <span className="cr-im-court" aria-hidden="true">✎</span>
        </button>
      )}
      <button type="button" className={cls('cr-im-bouton nodrag', panneau && 'est-pris')} aria-expanded={!!panneau} onClick={ouvre} aria-label="Envoyer à une console" title="Envoyer l’image, annotations comprises, à une console">
        <span className="cr-im-long">Envoyer à…</span>
        <span className="cr-im-court" aria-hidden="true">↗</span>
      </button>
    </>
  )

  let corps = null
  if (tel || !far) {
    if (!image)
      corps = <p className="cr-im-vide">{Math.abs(Date.now() - k.creeLe) < 120000 ? 'Image en route…' : 'Pas d’image : l’envoi n’a pas abouti.'}</p>
    // Téléphone : une image plus grande que ce que l'interface envoie (2 560 px de côté ; un GIF ou un envoi par l'API
    // peut aller jusqu'à 40 Mpx, 160 Mo une fois décodée) n'est pas décodée sur la tuile : ses dimensions seulement.
    else if (tel && k.largeur * k.hauteur > TEL_PIXELS_MAX)
      corps = (
        <p className="cr-im-vide">
          Image de {k.largeur} × {k.hauteur} : à voir sur l’ordinateur.
        </p>
      )
    else
      corps = (
        <div className={cls('cr-im-cadre', mode && 'est-annote')}>
          {casse ? (
            <p className="cr-im-vide">Image illisible.</p>
          ) : (
            <img className="cr-im-img" src={adresse(k)} alt={k.titre || 'Image'} draggable={false} decoding="async" loading="lazy" onError={() => setCasse(true)} />
          )}
          <div className="cr-im-traits">
            <SurfaceTraits support={id} largeur={k.largeur} hauteur={k.hauteur} mode={tel ? null : mode} couleur={couleur} />
          </div>
          {mode && !tel && (
            <div className="cr-im-annote nodrag" role="toolbar" aria-label="Annoter l’image">
              {COULEURS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cls('cr-im-pastille', `cr-coul-${c}`, mode === 'stylo' && couleur === c && 'est-prise')}
                  aria-pressed={mode === 'stylo' && couleur === c}
                  aria-label={`Stylo ${NOM_COULEUR[c]}`}
                  title={`Stylo ${NOM_COULEUR[c]}`}
                  onClick={() => (setCouleur(c), setMode('stylo'))}
                />
              ))}
              <button type="button" className={cls('cr-im-bouton', mode === 'gomme' && 'est-pris')} aria-pressed={mode === 'gomme'} title="Gomme : toucher un trait l’efface" onClick={() => setMode('gomme')}>
                Gomme
              </button>
            </div>
          )}
        </div>
      )
  }

  return (
    <>
      <Carte id={id} k={k} width={width} height={height} selected={selected} titre="Image" outils={outils}>
        {corps}
      </Carte>
      <NodeToolbar
        isVisible={!!panneau && image && !far && !tel}
        position={panneau === 'gauche' ? Position.Left : Position.Right}
        align="start"
        offset={12}
        className="cr-im-panneau nodrag nowheel nopan"
        role="dialog"
        aria-label="Envoyer l’image à une console"
        // Le clavier s'arrête au panneau (aucun raccourci du plateau ni de l'application) ; Échap le ferme.
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') ferme()
        }}
      >
        <PanneauEnvoi k={k} onFerme={ferme} />
      </NodeToolbar>
    </>
  )
})

// Ce qui garde le clavier pour lui : un terminal, un champ, une console, un panneau ou une fenêtre de dialogue.
const AILLEURS = '.xterm, input, textarea, select, [contenteditable], .react-flow__node-console, .plein, .discussion, .envoi, .cr-im-panneau, [role=dialog], dialog'
const ailleurs = (t) => t instanceof Element && (t.isContentEditable || !!t.closest(AILLEURS))

// Coller (Ctrl+V hors d'un terminal, d'un champ ou d'une console) ou glisser une image sur le plateau de l'ordinateur →
// carte image. Monté dans <ReactFlow> par PlateauCreatif.jsx (ordinateur seulement). `plein` : une console est agrandie
// (rien alors). Un fichier qui n'est pas une image : refus dit en haut du plateau, rien de créé.
export function DepotImages({ plein }) {
  const rf = useReactFlow()
  const dom = useStore((s) => s.domNode)
  const store = useStoreApi()
  const { actions } = useContext(CartesCtx)
  const [avis, setAvis] = useState(null) // { texte, echec }
  const n = useRef(0) // deux collages de suite ne tombent pas exactement l'un sur l'autre

  useEffect(() => {
    if (!avis || avis.enCours) return
    const t = setTimeout(() => setAvis(null), avis.echec ? 5000 : 2500)
    return () => clearTimeout(t)
  }, [avis])

  useEffect(() => {
    if (plein || !dom || !actions) return
    const pose = async (fichiers, point) => {
      const images = fichiers.filter((f) => String(f.type).startsWith('image/')).slice(0, 10)
      if (!images.length) return setAvis({ texte: fichiers.length > 1 ? 'Ce ne sont pas des images : rien n’est posé.' : 'Ce n’est pas une image : rien n’est posé.', echec: true })
      setAvis({ texte: images.length > 1 ? `${images.length} images en route…` : 'Image en route…', enCours: true })
      let derniere = null
      for (const [i, f] of images.entries()) {
        try {
          derniere = await poseImage({ actions, fichier: f, x: point.x + i * 28, y: point.y + i * 28, centre: true })
        } catch (e) {
          return setAvis({ texte: e.message, echec: true })
        }
      }
      setAvis(null)
      if (derniere) choisisCarte(store, derniere.id)
    }
    // Ctrl+V : écouté sur la fenêtre, après tout le monde (une console qui prend le collage l'a déjà marqué).
    const colle = (e) => {
      const fichiers = [...(e.clipboardData?.files || [])]
      if (e.defaultPrevented || !fichiers.length || ailleurs(document.activeElement) || ailleurs(e.target)) return
      e.preventDefault()
      const r = dom.getBoundingClientRect()
      const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      const d = (n.current++ % 5) * 28
      pose(fichiers, { x: p.x + d, y: p.y + d })
    }
    // Glisser depuis le bureau : sur le plateau (fond ou carte), jamais sur une console ni sur un panneau.
    const surLePlateau = (e) => e.target instanceof Element && dom.contains(e.target) && !!e.target.closest('.react-flow__pane') && !e.target.closest('.react-flow__node-console, .react-flow__panel')
    const avecFichiers = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
    const survol = (e) => {
      if (e.defaultPrevented || !avecFichiers(e) || !surLePlateau(e)) return
      e.preventDefault() // sinon le navigateur ouvrirait le fichier à la place de Meydan
      e.dataTransfer.dropEffect = 'copy'
    }
    const depot = (e) => {
      if (e.defaultPrevented || !avecFichiers(e) || !surLePlateau(e)) return
      e.preventDefault()
      pose([...(e.dataTransfer.files || [])], rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    }
    window.addEventListener('paste', colle)
    window.addEventListener('dragover', survol)
    window.addEventListener('drop', depot)
    return () => {
      window.removeEventListener('paste', colle)
      window.removeEventListener('dragover', survol)
      window.removeEventListener('drop', depot)
    }
  }, [plein, dom, rf, actions, store])

  if (!avis) return null
  return (
    <Panel position="top-center" className="cr-im-avis">
      <p className={cls(avis.echec && 'est-echec')} role={avis.echec ? 'alert' : 'status'}>
        {avis.texte}
      </p>
    </Panel>
  )
}
