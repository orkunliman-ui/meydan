// Ateliers : le corps de la lecture en grand, selon ce qui est lu — une carte d'atelier (`k` : document, fichier de code,
// note du coffre, diagramme en image fixe) ou un fichier cité dans le Chat (`fichier` : chemin absolu). Chargé À LA
// DEMANDE (differe.js, comme le plateau et le terminal) : la liste du téléphone et le Chat sont dans le morceau
// principal, qui ne doit porter ni le rendu Markdown, ni la coloration, ni le dessin des diagrammes.
import { useCallback, useState } from 'react'
import { LectureDoc } from './Document.jsx'
import { LectureCode } from './Code.jsx'
import { LectureNote, useCoffre } from './Coffre.jsx'
import { useSourceDiagramme, VueDiagramme } from './Diagramme.jsx'
import './ateliers.css'

function NoteLue({ k, telephone }) {
  const [note, setNote] = useState(k.note)
  const { index } = useCoffre(k.projet, k.dossier, true)
  const va = useCallback((c) => setNote(c), [])
  return <LectureNote id={note === k.note ? k.id : undefined} projet={k.projet} dossier={k.dossier} note={note} index={index} onVa={va} telephone={telephone} />
}
function DiagrammeLu({ k }) {
  const { source, message } = useSourceDiagramme(k.id, k, true)
  return (
    <div className="at-dg-grand">
      <VueDiagramme source={source} id={`dgt-${k.id}`} />
      {message && <p className="at-etat">{message}</p>}
    </div>
  )
}

export function CorpsLecture({ k, fichier, telephone = true }) {
  if (fichier) {
    const i = fichier.lastIndexOf('/')
    const projet = fichier.slice(0, i) || '/'
    const nom = fichier.slice(i + 1)
    return /\.(md|markdown|html?)$/i.test(nom) ? (
      <LectureDoc projet={projet} chemin={nom} telephone={telephone} />
    ) : (
      <div className="at-code-grand">
        <LectureCode projet={projet} fichier={nom} />
      </div>
    )
  }
  if (k.type === 'doc') return <LectureDoc id={k.id} projet={k.projet} chemin={k.chemin} telephone={telephone} />
  if (k.type === 'code')
    return (
      <div className="at-code-grand">
        <LectureCode id={k.id} projet={k.projet} fichier={k.fichier} />
      </div>
    )
  if (k.type === 'coffre')
    return (
      <div className="at-doc-boite">
        <NoteLue k={k} telephone={telephone} />
      </div>
    )
  return <DiagrammeLu k={k} />
}
export default CorpsLecture
