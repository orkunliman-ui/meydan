// Ateliers : la lecture d'un diagramme (sa source : texte de la carte ou fichier suivi ; son dessin et ses erreurs), sans
// rien du plateau : chargée à la demande par la liste du téléphone (image fixe) et par la carte Diagramme.
import { useEffect, useRef } from 'react'
import { Dessin, useDiagramme } from './DiagrammeSvg.jsx'
import { ditRefus, useContenu } from './api.js'

export const ACCEPTE_DIAGRAMME = (nom) => /\.(mmd|mermaid|md|markdown|txt)$/i.test(nom)
// Le texte du diagramme dans un fichier : un .md donne son premier bloc ```mermaid, le reste est pris entier.
export function sourceDuFichier(chemin, texte) {
  if (!/\.(md|markdown)$/i.test(chemin)) return texte
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n {0,3}\1/m.exec(texte)
  return m ? m[2] : ''
}

// Le dessin seul (lecture : carte, lecteur, téléphone) avec ses erreurs ; `svg` reçoit l'élément (exports).
export function VueDiagramme({ source, svg, id }) {
  const { a, d } = useDiagramme(source)
  const boite = useRef(null)
  useEffect(() => {
    if (svg) svg.current = boite.current?.querySelector('svg') || null
  })
  return (
    <div className="at-dg-vue" ref={boite}>
      {d ? <Dessin d={d} id={id} /> : <p className="at-dim at-centre">Rien à dessiner.</p>}
      {a.erreurs.length > 0 && (
        <ul className="at-dg-erreurs">
          {a.erreurs.slice(0, 8).map((e, i) => (
            <li key={i}>{e.ligne ? `ligne ${e.ligne} : ${e.message}` : e.message}</li>
          ))}
          {a.erreurs.length > 8 && <li>… {a.erreurs.length - 8} de plus</li>}
        </ul>
      )}
    </div>
  )
}

// La source d'une carte : son texte, ou le fichier suivi.
export function useSourceDiagramme(id, k, actif) {
  const fichier = k.source === 'fichier'
  const { contenu, erreur } = useContenu({ id, projet: k.projet, chemin: k.chemin, actif: actif && fichier })
  if (!fichier) return { source: k.texte || '' }
  if (erreur) return { source: '', message: erreur }
  if (contenu?.refus) return { source: '', message: ditRefus(contenu) }
  return { source: contenu ? sourceDuFichier(k.chemin, contenu.texte || '') : '' }
}
