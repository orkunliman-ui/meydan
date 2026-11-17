// Ateliers : la section « Ateliers » de la liste du téléphone (clarification Q3 du 13/11 : à la fin de la liste des
// consoles, une ligne par atelier, les plus récents d'abord). Un toucher ouvre la lecture plein écran : document, fichier
// de code ou note du coffre rendus ; diagramme en image fixe. Rien ne s'écrit ni ne s'exporte depuis le téléphone (FR-052).
// C'est le dernier élément de la liste (dans son défilement : aucune place prise aux consoles, mesuré au banc) ; dépliée
// d'office, repliable, l'état retenu sur l'appareil. Ce fichier est dans le morceau principal : il reste léger, le corps
// de la lecture arrive à la demande (lecture.jsx par differe.js).
import { useMemo, useState } from 'react'
import { useCartes } from '../cartes.js'
import { cls } from '../lib.js'
import { CorpsLecture } from '../differe.js'
import { Lecteur } from './Lecteur.jsx'
import { dossierCourt, nomDe } from './api.js'
import { NOMS_ATELIERS, estAtelier } from './types.js'
import './ateliers.css'

const CLE = 'meydan.ateliers.liste'
const lit = () => {
  try {
    return localStorage.getItem(CLE) !== 'repliee'
  } catch {
    return false
  }
}
export const titreAtelier = (k) => k.titre || (k.type === 'coffre' ? nomDe(k.note || k.dossier || k.projet).replace(/\.md$/i, '') : nomDe(k.type === 'code' ? k.fichier || k.projet : k.chemin)) || NOMS_ATELIERS[k.type]

export function AteliersListe() {
  const { cartes } = useCartes()
  const [ouverte, setOuverte] = useState(lit)
  const [lue, setLue] = useState(null)
  const ateliers = useMemo(() => cartes.filter((k) => estAtelier(k.type)).sort((a, b) => (b.modifieLe || 0) - (a.modifieLe || 0)), [cartes])
  if (!ateliers.length) return null
  const bascule = () => {
    const v = !ouverte
    setOuverte(v)
    try {
      localStorage.setItem(CLE, v ? 'ouverte' : 'repliee')
    } catch {}
  }
  const k = lue && ateliers.find((x) => x.id === lue)
  return (
    <li className={cls('at-liste', ouverte && 'est-ouverte')} aria-label="Ateliers">
      <button type="button" className="at-liste-tete" aria-expanded={ouverte} onClick={bascule}>
        <span>Ateliers</span>
        <i>{ateliers.length}</i>
        <span aria-hidden="true">{ouverte ? '▾' : '▸'}</span>
      </button>
      {ouverte && (
        <ul>
          {ateliers.map((a) => (
            <li key={a.id}>
              <button type="button" className="at-liste-ligne" onClick={() => setLue(a.id)} disabled={!a.projet && a.type !== 'diagramme'}>
                <span className="at-liste-type">{NOMS_ATELIERS[a.type]}</span>
                <b>{titreAtelier(a)}</b>
                <small>{a.projet ? dossierCourt(a.projet) : a.type === 'diagramme' ? 'écrit dans la carte' : 'pas encore choisi'}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {k && (
        <Lecteur telephone type={NOMS_ATELIERS[k.type]} titre={titreAtelier(k)} sousTitre={k.projet ? dossierCourt(k.projet) : ''} onFerme={() => setLue(null)}>
          <CorpsLecture k={k} />
        </Lecteur>
      )}
    </li>
  )
}
