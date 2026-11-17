import { useLayoutEffect, useRef, useState } from 'react'
import { Envoi } from './Envoi.jsx'
import { Fil } from './Fil.jsx'
// A− / A+ de la barre grossissent aussi la discussion (décision d'Orkun du 17/11, plateau-pc-7 : « Oui »).
import { echelleDe, useTaille } from './tailles.jsx'
import './discussion-taille.css'

// Une console dont Meydan sait lire la conversation : un agent Claude ou Codex.
export const aUnFil = (c) => c.kind === 'claude' || c.kind === 'codex'

// La discussion d'un agent sur l'ordinateur, dans sa dalle ou agrandie (Orkun, 11/11 : « le switch en conversation
// chatbox. Tres important sur PC aussi. Afin de pouvoir envoyer les documents/fichiers/photos/screenshots aussi ») :
// la conversation comme dans une messagerie, et dessous la barre d'envoi du téléphone (texte, pièces jointes, note
// vocale). Sur l'ordinateur, Entrée envoie (Maj+Entrée va à la ligne), et une image collée (Ctrl+V) ou un fichier glissé
// n'importe où dans la discussion devient une pièce jointe, pas seulement dans le champ.
// `focus` : le champ prend le clavier à l'ouverture (console agrandie).
export function Discussion({ c, actions, focus = false }) {
  const [envoyes, setEnvoyes] = useState([]) // montrés aussitôt, en attendant que l'agent les écrive dans son journal
  const joint = useRef(null) // la fonction de la barre d'envoi qui ajoute des pièces jointes
  const taille = useTaille(c.id)
  // Une discussion lue en bas y reste quand A− / A+ changent la hauteur des messages (la boîte ne reçoit pas d'événement
  // « scroll » : sa position ne bouge pas, c'est le contenu qui grandit). Suivi en capture : « scroll » ne remonte pas.
  const boite = useRef(null)
  const enBas = useRef(true)
  useLayoutEffect(() => {
    const fil = boite.current?.querySelector('.fil')
    if (fil && enBas.current) fil.scrollTop = fil.scrollHeight
  }, [taille])
  const prend = (e, liste) => {
    const f = [...(liste || [])]
    if (!f.length || !joint.current) return
    e.preventDefault()
    e.stopPropagation() // le champ ne la reprend pas une seconde fois
    joint.current(f)
  }
  return (
    // tabIndex : un clic dans la conversation lui donne le focus, sans quoi le navigateur n'y enverrait pas le collage.
    <div
      className="discussion"
      ref={boite}
      style={{ '--fil-zoom': echelleDe(taille) }}
      onScrollCapture={(e) => e.target.classList?.contains('fil') && (enBas.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 80)}
      tabIndex={-1}
      onPasteCapture={(e) => prend(e, e.clipboardData?.files)}
      onDragOver={(e) => [...(e.dataTransfer?.types || [])].includes('Files') && e.preventDefault()}
      onDrop={(e) => prend(e, e.dataTransfer?.files)}
    >
      <Fil console={c} envoyes={envoyes} onTerminal={() => actions.vue(c.id, 'terminal', true)} />
      {c.status !== 'closed' && <Envoi key={c.id} brouillon console={c} forme="fil" clavier focus={focus} jointRef={joint} onEnvoye={(t, pieces) => (t || pieces.length > 0) && setEnvoyes((l) => [...l.slice(-4), { t, at: Date.now(), pieces }])} />}
    </div>
  )
}
