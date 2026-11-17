// Ateliers : la lecture d'un coffre Markdown — le coffre lui-même (notes, liens), une note rendue avec ses liens internes
// navigables, et le graphe des liens — sans rien du plateau (chargée à la demande par la liste du téléphone).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { cls } from '../lib.js'
import { Markdown } from '../notes-md.jsx'
import { blocDessine } from './Document.jsx'
import { disposeGraphe } from './graphe.js'
import { cibleMd, indexNotes, resoutLien } from './liens.js'
import { coffre, ditRefus, useContenu } from './api.js'
import '../carte-note.css'

// Le coffre (notes, liens, cassés), relu à l'ouverture, au retour sur la fenêtre et sur demande.
export function useCoffre(projet, dossier, actif) {
  const [c, setC] = useState(null)
  const [erreur, setErreur] = useState('')
  const [tic, setTic] = useState(0)
  useEffect(() => {
    if (!actif || !projet) return
    let vivant = true
    coffre(projet, dossier).then(
      (r) => vivant && (setC(r), setErreur('')),
      (e) => vivant && setErreur(e.message),
    )
    const focus = () => setTic((t) => t + 1)
    addEventListener('focus', focus)
    return () => {
      vivant = false
      removeEventListener('focus', focus)
    }
  }, [projet, dossier, actif, tic])
  const index = useMemo(() => (c ? indexNotes(c.notes.map((n) => n.chemin)) : null), [c])
  return { c, index, erreur, relit: () => setTic((t) => t + 1) }
}

// Une note du coffre, rendue, avec ses liens internes navigables. `onVa(chemin)` : ouvrir une autre note.
export function LectureNote({ id, projet, dossier, note, index, onVa, telephone = false, actif = true }) {
  const chemin = note ? (dossier ? `${dossier}/${note}` : note) : ''
  const { contenu, erreur } = useContenu({ id, projet, chemin, actif })
  const lien = useCallback(
    (cible, genre, vue) => {
      const r = index ? resoutLien(genre === 'md' ? cibleMd(cible) || cible : cible, genre, note, index) : { i: -1, n: 0 }
      const casse = r.i < 0
      return (
        <button
          type="button"
          className={cls('at-lien-note nodrag', casse && 'est-casse', r.n > 1 && 'est-ambigu')}
          disabled={casse}
          title={casse ? `Note absente : ${cible}` : r.n > 1 ? `${r.n} notes portent ce nom : la plus proche est ouverte` : index.chemins[r.i]}
          onClick={() => !casse && onVa(index.chemins[r.i])}
        >
          {vue}
        </button>
      )
    },
    [index, note, onVa],
  )
  if (!note) return <p className="at-dim at-centre">Choisis une note.</p>
  if (erreur) return <p className="at-erreur">{erreur}</p>
  if (!contenu) return <p className="at-dim">Chargement…</p>
  if (contenu.refus) return <p className="at-refus">{ditRefus(contenu)}</p>
  return (
    <article className="at-doc">
      <Markdown texte={contenu.texte} tableaux bloc={blocDessine} lien={lien} statique={telephone} />
    </article>
  )
}

// Le graphe des liens : points et traits disposés une fois (graphe.js, déterministe), aucune animation.
export function Graphe({ c, ouverte, onVa }) {
  const L = 760
  const H = 560
  const pos = useMemo(() => (c.notes.length ? disposeGraphe(c.notes.length, c.liens, { largeur: L, hauteur: H }) : []), [c])
  const i0 = c.notes.findIndex((n) => n.chemin === ouverte)
  const voisins = new Set(c.liens.flatMap(([a, b]) => (a === i0 ? [b] : b === i0 ? [a] : [])))
  const etiquettes = c.notes.length <= 60
  if (!c.notes.length) return <p className="at-dim at-centre">Aucune note dans ce dossier.</p>
  return (
    <svg className="at-graphe" viewBox={`0 0 ${L} ${H}`} role="img" aria-label={`Graphe de ${c.notes.length} notes et ${c.liens.length} liens`}>
      {c.liens.map(([a, b], k) => (
        <line key={k} x1={pos[a].x} y1={pos[a].y} x2={pos[b].x} y2={pos[b].y} className={cls('at-g-lien', (a === i0 || b === i0) && 'est-proche')} />
      ))}
      {c.notes.map((n, i) => (
        <g key={n.chemin} className={cls('at-g-note', i === i0 && 'est-ouverte', voisins.has(i) && 'est-voisine')} onClick={() => onVa(n.chemin)}>
          <circle cx={pos[i].x} cy={pos[i].y} r={i === i0 ? 8 : 5.5}>
            <title>{n.chemin}</title>
          </circle>
          {(etiquettes || i === i0 || voisins.has(i)) && (
            <text x={pos[i].x} y={pos[i].y - 10} textAnchor="middle">
              {n.nom.length > 24 ? `${n.nom.slice(0, 23)}…` : n.nom}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}
