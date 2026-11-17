// Ateliers : « Ouvrir » à côté d'un fichier que l'agent cite dans le Chat (spec US6, FR-060) — un document (.md, .html)
// ou un texte s'ouvre dans la lecture en grand (plein écran au téléphone) au lieu d'être téléchargé. Le projet est le
// dossier du fichier ; le serveur applique la même garde qu'aux ateliers (caché, secrets, données de Meydan… refusés).
// Sans carte, la lecture se relit toutes les 2 s tant qu'elle est ouverte. Léger (le Chat est dans le morceau principal) :
// le corps de la lecture arrive à la demande (lecture.jsx par differe.js).
import { useState } from 'react'
import { CorpsLecture } from '../differe.js'
import { Lecteur } from './Lecteur.jsx'
import { dossierCourt } from './api.js'
import { NOMS_ATELIERS, tactile } from './types.js'
import './ateliers.css'

const DOC = /\.(md|markdown|html?)$/i
const TEXTE = /\.(txt|json|csv|tsv|ics|vcf|svg|log|ya?ml|toml|m?js|cjs|jsx|tsx?|py|sh|css|sql|go|rs|java|rb|c|h)$/i
export const ouvrable = (chemin) => typeof chemin === 'string' && chemin.startsWith('/') && (DOC.test(chemin) || TEXTE.test(chemin))

export function OuvrirFichier({ chemin }) {
  const [ouvert, setOuvert] = useState(false)
  if (!ouvrable(chemin)) return null
  const i = chemin.lastIndexOf('/')
  const nom = chemin.slice(i + 1)
  const tel = tactile()
  return (
    <>
      <button type="button" className="at-ouvrir" title={`Ouvrir ${nom} ici, sans le télécharger`} onClick={() => setOuvert(true)}>
        Ouvrir
      </button>
      {ouvert && (
        <Lecteur telephone={tel} type={DOC.test(nom) ? NOMS_ATELIERS.doc : NOMS_ATELIERS.code} titre={nom} sousTitre={dossierCourt(chemin.slice(0, i))} onFerme={() => setOuvert(false)}>
          <CorpsLecture fichier={chemin} telephone={tel} />
        </Lecteur>
      )}
    </>
  )
}
