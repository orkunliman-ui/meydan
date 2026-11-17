// Plateau étendu : le registre des dalles de cartes (pour `nodeTypes` de Board.jsx) et la barre du pied du plateau de
// l'ordinateur — « Ajouter » (une carte posée au milieu de l'écran) et, depuis le volet plateau-creatif du 13/11, les
// outils du plateau : Flèche, Stylo, Gomme (outil.js), avec la couleur de l'encre quand l'un d'eux est pris.
import { useContext, useEffect, useRef, useState } from 'react'
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { CartesCtx } from './cartes.js'
import { TYPES_CARTES, COULEURS, NOM_COULEUR } from './cartes-types.js'
import { choisitCouleur, choisitOutil, useOutil } from './outil.js'
import { cls } from './lib.js'
import { NoteNode } from './NoteNode.jsx'
import { WebNode } from './WebNode.jsx'
import { GitPanneau } from './GitPanneau.jsx'
import { ChecklistNode } from './ChecklistNode.jsx'
import { KanbanNode } from './KanbanNode.jsx'
import { CalendrierNode } from './CalendrierNode.jsx'
import { FormeNode } from './FormeNode.jsx'
import { ImageNode, poseImage } from './ImageNode.jsx'
import { FichierNode } from './FichierNode.jsx'
import { NavNode } from './NavNode.jsx'
// Ateliers (volet du 13/11) : Document, Code, Markdown, Diagramme (web/src/ateliers/registre.jsx).
import { nodeTypesAteliers } from './ateliers/registre.jsx'

export const nodeTypesCartes = {
  'carte-note': NoteNode,
  'carte-web': WebNode,
  'carte-git': GitPanneau,
  'carte-checklist': ChecklistNode,
  'carte-kanban': KanbanNode,
  'carte-calendrier': CalendrierNode,
  'carte-forme': FormeNode,
  'carte-image': ImageNode,
  'carte-fichier': FichierNode,
  // Volet copies : la carte « Navigateur · <console> », posée par le serveur au premier `meydan nav ouvre` d'une console,
  // jamais par « Ajouter » (une carte Navigateur sans console n'a pas de sens, et le serveur refuse qu'une page la crée).
  'carte-nav': NavNode,
  ...nodeTypesAteliers,
}

// Le menu « Ajouter » : [libellé, type, champs posés à la création, taille (sinon celle du type)] ; `null` : un séparateur ;
// un texte seul : le titre d'une section (les ateliers).
const AJOUTS = [
  ['Note', 'note'],
  ['Checklist', 'checklist'],
  ['Kanban', 'kanban'],
  ['Calendrier', 'calendrier'],
  ['Image…', 'image'],
  ['Fichier', 'fichier'],
  ['Aperçu web', 'web'],
  ['Git', 'git'],
  null, // les ateliers (volet du 13/11) : lire ce que les agents écrivent
  'Ateliers',
  ['Document', 'doc'],
  ['Code', 'code'],
  ['Markdown', 'coffre'],
  ['Diagramme', 'diagramme'],
  null, // séparateur : les formes
  ['Rectangle', 'forme', { forme: 'rect' }],
  ['Ellipse', 'forme', { forme: 'ellipse' }],
  ['Texte', 'forme', { forme: 'texte' }, { w: 280, h: 64 }],
]
const OUTILS_BARRE = [
  ['fleche', 'Flèche', 'Flèche : glisser d’un élément à un autre (ou d’un point à un autre) pour les relier · Échap : finir'],
  ['stylo', 'Stylo', 'Stylo : dessiner à main levée sur le plateau · Échap : finir'],
  ['gomme', 'Gomme', 'Gomme : toucher un trait l’efface · Échap : finir'],
]

export function OutilsCartes() {
  const rf = useReactFlow()
  const dom = useStore((s) => s.domNode)
  const store = useStoreApi()
  const { actions } = useContext(CartesCtx)
  const { outil, couleur } = useOutil()
  const [erreur, setErreur] = useState('')
  const [menu, setMenu] = useState(false)
  const boite = useRef(null)
  const fichierImage = useRef(null)
  const n = useRef(0) // deux cartes ajoutées de suite ne tombent pas exactement l'une sur l'autre
  // Le milieu de l'écran, en coordonnées du plan, décalé pour la n-ième carte de suite.
  const milieu = (t) => {
    const r = dom?.getBoundingClientRect()
    const centre = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 }
    const decale = (n.current++ % 5) * 28
    return { x: Math.round(centre.x - t.w / 2 + decale), y: Math.round(centre.y - t.h / 2 + decale) }
  }
  // La carte neuve devient la carte choisie (même appel que le clic de React Flow) : posée sur une carte choisie, elle
  // restait dessous (la dalle choisie est élevée). Son nœud arrive au rendu suivant : on l'attend quelques images.
  const choisis = async (carte) => {
    for (let i = 0; i < 30 && !store.getState().nodeLookup.has(carte.id); i++) await new Promise(requestAnimationFrame)
    const s = store.getState()
    if (s.nodeLookup.has(carte.id) && s.elementsSelectable) s.addSelectedNodes([carte.id])
  }
  const ajoute = async (type, champs = {}, taille) => {
    setErreur('')
    setMenu(false)
    if (type === 'image') return fichierImage.current?.click() // le choix du fichier, puis poseImage
    const t = taille || TYPES_CARTES[type]
    try {
      choisis(await actions.cree(type, { ...champs, ...(taille || {}), ...milieu(t) }))
    } catch (e) {
      setErreur(e.message)
    }
  }
  const imageChoisie = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = '' // le même fichier peut être choisi deux fois de suite
    if (!f) return
    try {
      choisis(await poseImage({ actions, fichier: f, ...milieu(TYPES_CARTES.image) }))
    } catch (err) {
      setErreur(err.message)
    }
  }
  // Le menu se ferme au clic ailleurs (souris : le plateau de l'ordinateur seulement) et à Échap.
  useEffect(() => {
    if (!menu) return
    const ailleurs = (e) => !boite.current?.contains(e.target) && setMenu(false)
    const echap = (e) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('click', ailleurs, true)
    window.addEventListener('keydown', echap)
    return () => {
      document.removeEventListener('click', ailleurs, true)
      window.removeEventListener('keydown', echap)
    }
  }, [menu])
  const encre = outil === 'stylo' || outil === 'fleche'
  return (
    // Posée par Board.jsx dans le pied du plateau (en bas à gauche, à droite de l'usage des comptes).
    <div className="et-outils cr-outils" ref={boite}>
      <div className="cr-ajouter">
        <button type="button" aria-haspopup="menu" aria-expanded={menu} className={cls(menu && 'est-ouvert')} onClick={() => setMenu((v) => !v)}>
          Ajouter <span aria-hidden="true">▴</span>
        </button>
        {menu && (
          <div className="cr-menu" role="menu" aria-label="Ajouter au plateau">
            {AJOUTS.map((a, i) =>
              typeof a === 'string' ? (
                <p key={`t${i}`} className="cr-menu-titre" role="presentation">
                  {a}
                </p>
              ) : a ? (
                <button key={a[0]} type="button" role="menuitem" onClick={() => ajoute(a[1], a[2], a[3])}>
                  {a[0]}
                </button>
              ) : (
                <hr key={`s${i}`} />
              ),
            )}
          </div>
        )}
      </div>
      <input ref={fichierImage} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={imageChoisie} />
      <span className="cr-sep" aria-hidden="true" />
      {OUTILS_BARRE.map(([o, nom, aide]) => (
        <button key={o} type="button" className={cls('cr-outil', outil === o && 'est-pris')} aria-pressed={outil === o} title={aide} onClick={() => choisitOutil(o)}>
          {nom}
        </button>
      ))}
      {encre && (
        <span className="cr-couleurs" role="group" aria-label="Couleur">
          {COULEURS.map((c) => (
            <button key={c} type="button" className={cls('cr-pastille', `cr-coul-${c}`, couleur === c && 'est-prise')} aria-pressed={couleur === c} aria-label={NOM_COULEUR[c]} title={NOM_COULEUR[c]} onClick={() => choisitCouleur(c)} />
          ))}
        </span>
      )}
      {erreur && (
        <span className="et-outils-erreur" role="alert">
          {erreur}
        </span>
      )}
    </div>
  )
}
