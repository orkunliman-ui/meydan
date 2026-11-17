// Ateliers : la carte Markdown (studio Markdown de Symvibe : « coffre façon Obsidian, graphe des liens »). Un dossier de
// notes .md d'un projet : liste et recherche, note rendue (notes-md.jsx) dont les liens [[Nom]] et relatifs mènent à la
// note visée (même résolution que le serveur : liens.js), « ← » pour revenir, et le graphe des liens en SVG statique.
import { memo, useCallback, useContext, useMemo, useState } from 'react'
import { CartesCtx } from '../cartes.js'
import { Carte } from '../Carte.jsx'
import { cls } from '../lib.js'
import { Choix } from './Choix.jsx'
import { Lecteur } from './Lecteur.jsx'
import { Tuile } from './Tuile.jsx'
import { Graphe, LectureNote, useCoffre } from './Coffre.jsx'
import { dossierCourt, nomDe } from './api.js'
import { NOMS_ATELIERS } from './types.js'
import './ateliers.css'

export const CoffreNode = memo(function CoffreNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const [choix, setChoix] = useState(false)
  const [grand, setGrand] = useState(false)
  const [onglet, setOnglet] = useState('note')
  const [texte, setTexte] = useState('')
  const [pile, setPile] = useState([])
  const actif = !far && !tel && !!k.projet && !choix
  const { c, index, erreur, relit } = useCoffre(k.projet, k.dossier, actif)
  const va = useCallback(
    (chemin) => {
      if (chemin === k.note) return setOnglet('note')
      setPile((p) => (k.note ? [...p.slice(-30), k.note] : p))
      setOnglet('note')
      actions.patch(id, { note: chemin }).catch(() => {})
    },
    [id, k.note, actions],
  )
  const retour = () => {
    const p = pile[pile.length - 1]
    if (!p) return
    setPile((x) => x.slice(0, -1))
    actions.patch(id, { note: p }).catch(() => {})
  }
  const liste = useMemo(() => {
    if (!c) return []
    const t = texte.trim().toLowerCase()
    return t ? c.notes.filter((n) => n.chemin.toLowerCase().includes(t)) : c.notes
  }, [c, texte])
  const outils =
    actif && c ? (
      <>
        <button type="button" className="at-outil nodrag" title="Revenir à la note précédente" disabled={!pile.length} onClick={retour}>
          ←
        </button>
        <button type="button" className={cls('at-outil nodrag', onglet === 'graphe' && 'est-actif')} title="Le graphe des liens entre notes" onClick={() => (setOnglet(onglet === 'graphe' ? 'note' : 'graphe'), relit())}>
          Graphe
        </button>
        <button type="button" className="at-outil nodrag" title="Lire en grand" disabled={!k.note} onClick={() => setGrand(true)}>
          Agrandir
        </button>
        <button type="button" className="at-outil nodrag" title="Choisir un autre dossier" onClick={() => setChoix(true)}>
          Dossier
        </button>
      </>
    ) : null
  let corps
  if (tel) corps = <Tuile k={k} />
  else if (far) corps = null
  else if (!k.projet || choix)
    corps = (
      <Choix
        projet={k.projet}
        mode="dossier"
        aide="Le dossier des notes .md (le coffre)"
        onChoisi={({ projet, chemin }) => {
          setChoix(false)
          setPile([])
          actions.patch(id, { projet, dossier: chemin, note: '' }).catch(() => {})
        }}
        onAnnule={k.projet ? () => setChoix(false) : null}
      />
    )
  else
    corps = (
      <div className="at-code-carte">
        <nav className="at-code-gauche nowheel">
          <input className="at-champ nodrag" type="search" placeholder="Chercher une note…" value={texte} onChange={(e) => setTexte(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Chercher une note" />
          {erreur && <p className="at-erreur">{erreur}</p>}
          {!c && !erreur && <p className="at-dim">…</p>}
          <ul className="at-arbre">
            {liste.slice(0, 1000).map((n) => (
              <li key={n.chemin}>
                <button type="button" className={cls('nodrag est-fichier', k.note === n.chemin && 'est-ouvert')} onClick={() => va(n.chemin)} title={n.chemin}>
                  {n.nom} {n.chemin.includes('/') && <small>{n.chemin.slice(0, n.chemin.lastIndexOf('/'))}</small>}
                </button>
              </li>
            ))}
          </ul>
          {c && (
            <p className="at-dim at-petit">
              {c.notes.length} notes · {c.liens.length} liens{c.casses.length ? ` · ${c.casses.length} cassés` : ''}
              {c.tronque ? ' · coffre tronqué' : ''}
            </p>
          )}
        </nav>
        <div className="at-code-droite nowheel">
          {onglet === 'graphe' && c ? (
            <Graphe c={c} ouverte={k.note} onVa={va} />
          ) : grand ? (
            <p className="at-dim at-centre">Lu en grand à droite.</p>
          ) : (
            <LectureNote id={id} projet={k.projet} dossier={k.dossier} note={k.note} index={index} onVa={va} actif={actif} />
          )}
        </div>
      </div>
    )
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={k.projet ? `${nomDe(k.projet)}${k.dossier ? `/${k.dossier}` : ''}` : NOMS_ATELIERS.coffre} outils={outils} className="at-carte">
      {corps}
      {grand && k.note && (
        <Lecteur type={NOMS_ATELIERS.coffre} titre={nomDe(k.note).replace(/\.md$/i, '')} sousTitre={`${dossierCourt(k.projet)}/${k.dossier ? `${k.dossier}/` : ''}${k.note}`} onFerme={() => setGrand(false)}>
          <div className="at-doc-boite">
            <LectureNote id={id} projet={k.projet} dossier={k.dossier} note={k.note} index={index} onVa={va} />
          </div>
        </Lecteur>
      )}
    </Carte>
  )
})
