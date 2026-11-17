// Ateliers : la tuile fixe d'un atelier sur le plateau du téléphone (couché) — type, titre, projet et fichier ; rien de lu,
// rien d'animé, aucun défilement (règles du plateau du téléphone, lot5-memoire.css). La lecture se fait depuis la liste.
import { dossierCourt } from './api.js'

export function Tuile({ k }) {
  const vise = k.type === 'coffre' ? k.dossier || 'racine du projet' : k.type === 'code' ? k.fichier : k.type === 'diagramme' && k.source === 'texte' ? 'écrit dans la carte' : k.chemin
  return (
    <div className="at-tuile">
      <b>{k.projet ? dossierCourt(k.projet) : 'pas encore choisi'}</b>
      {vise && <span>{vise}</span>}
    </div>
  )
}
