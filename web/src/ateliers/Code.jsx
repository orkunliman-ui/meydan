// Ateliers : la lecture d'un fichier de code (numéroté, colorié par coloration.js), sans rien du plateau : chargée à la
// demande par la liste du téléphone et le Chat (lecture.jsx), et par la carte Code (CodeNode.jsx).
import { useMemo } from 'react'
import { colore, langageDe } from './coloration.js'
import { ditRefus, useContenu } from './api.js'

const LIGNES_COLOREES = 5000

// Le texte d'un fichier, numéroté et colorié ; au-delà de 5 000 lignes, le reste en texte brut.
export function VueCode({ texte, nom }) {
  const lignes = useMemo(() => {
    const toutes = texte.split('\n')
    const tete = toutes.slice(0, LIGNES_COLOREES).join('\n')
    return { jetons: colore(tete, langageDe(nom)), reste: toutes.slice(LIGNES_COLOREES).join('\n'), total: toutes.length }
  }, [texte, nom])
  const largeur = String(lignes.total).length
  return (
    <pre className="at-code" style={{ '--at-num': `${largeur + 1}ch` }}>
      <code>
        {lignes.jetons.map((l, i) => (
          <span key={i} className="at-ligne">
            <span className="at-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="at-src">
              {l.map((j, k) => (j.t ? <span key={k} className={`at-j-${j.t}`}>{j.v}</span> : j.v))}
              {'\n'}
            </span>
          </span>
        ))}
      </code>
      {lignes.reste && <code className="at-code-brut">{lignes.reste}</code>}
    </pre>
  )
}

// Un fichier du projet, suivi (la carte `id` reçoit les annonces du flux), avec la raison d'un refus.
export function LectureCode({ id, projet, fichier, actif = true }) {
  const { contenu, erreur } = useContenu({ id, projet, chemin: fichier, actif })
  if (!fichier) return <p className="at-dim at-centre">Choisis un fichier dans l’arborescence.</p>
  if (erreur) return <p className="at-erreur">{erreur}</p>
  if (!contenu) return <p className="at-dim">Chargement…</p>
  if (contenu.refus) return <p className="at-refus">{ditRefus(contenu)}</p>
  return <VueCode texte={contenu.texte} nom={fichier} />
}
