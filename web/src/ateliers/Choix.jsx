// Ateliers : choisir un projet (la liste que Meydan propose pour créer une console, `~` compris), puis un fichier ou un
// dossier en descendant l'arborescence un niveau à la fois (GET /api/ateliers/arbre). Rien n'est écrit.
import { useEffect, useState } from 'react'
import { arbre, dossierCourt, projets } from './api.js'
import { cls } from '../lib.js'

// `mode` : 'fichier' (un fichier accepté par `accepte(nom)`) ou 'dossier'. `onChoisi({ projet, chemin })`.
export function Choix({ projet: projetDepart = '', depart = '', mode = 'fichier', accepte = () => true, aide, onChoisi, onAnnule }) {
  const [liste, setListe] = useState(null)
  const [projet, setProjet] = useState(projetDepart)
  const [chemin, setChemin] = useState(depart)
  const [niveau, setNiveau] = useState(null)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    if (projet) return
    projets().then(setListe, (e) => setErreur(e.message))
  }, [projet])
  useEffect(() => {
    if (!projet) return
    let vivant = true
    setNiveau(null)
    setErreur('')
    arbre(projet, chemin).then(
      (r) => vivant && setNiveau(r),
      (e) => vivant && setErreur(e.message),
    )
    return () => {
      vivant = false
    }
  }, [projet, chemin])
  const monte = () => setChemin(chemin.includes('/') ? chemin.slice(0, chemin.lastIndexOf('/')) : '')
  const dans = (nom) => (chemin ? `${chemin}/${nom}` : nom)
  if (!projet)
    return (
      <div className="at-choix">
        <p className="at-choix-titre">{aide || 'Projet'}</p>
        {erreur && <p className="at-erreur">{erreur}</p>}
        {!liste && !erreur && <p className="at-dim">Chargement…</p>}
        <ul className="at-choix-liste">
          {liste?.map((p) => (
            <li key={p.path}>
              <button type="button" className="nodrag" onClick={() => setProjet(p.path)}>
                <b>{p.name}</b>
                <span>{dossierCourt(p.path)}</span>
              </button>
            </li>
          ))}
        </ul>
        {onAnnule && (
          <button type="button" className="at-bouton nodrag" onClick={onAnnule}>
            Annuler
          </button>
        )}
      </div>
    )
  return (
    <div className="at-choix">
      <p className="at-choix-titre">
        <button type="button" className="at-lien nodrag" onClick={() => (setProjet(''), setChemin(''))} title="Changer de projet">
          {dossierCourt(projet)}
        </button>
        {chemin &&
          chemin.split('/').map((s, k, t) => (
            <span key={k}>
              {' / '}
              <button type="button" className="at-lien nodrag" onClick={() => setChemin(t.slice(0, k + 1).join('/'))}>
                {s}
              </button>
            </span>
          ))}
      </p>
      {aide && <p className="at-dim">{aide}</p>}
      {erreur && <p className="at-erreur">{erreur}</p>}
      {!niveau && !erreur && <p className="at-dim">Chargement…</p>}
      <ul className="at-choix-liste">
        {chemin && (
          <li>
            <button type="button" className="nodrag" onClick={monte}>
              <b>..</b>
            </button>
          </li>
        )}
        {niveau?.entrees.map((e) => {
          const ok = e.dossier || (mode === 'fichier' && accepte(e.nom))
          return (
            <li key={e.nom}>
              <button
                type="button"
                className={cls('nodrag', e.dossier && 'est-dossier', !ok && 'est-grise')}
                disabled={!ok}
                onClick={() => (e.dossier ? setChemin(dans(e.nom)) : onChoisi({ projet, chemin: dans(e.nom) }))}
              >
                <b>{e.dossier ? `${e.nom}/` : e.nom}</b>
                {e.lourd && <span>non parcouru</span>}
              </button>
            </li>
          )
        })}
        {niveau?.tronque && <li className="at-dim">… liste coupée à 1 000 entrées</li>}
      </ul>
      <div className="at-choix-pied">
        {mode === 'dossier' && (
          <button type="button" className="at-bouton est-principal nodrag" onClick={() => onChoisi({ projet, chemin })}>
            Choisir {chemin ? `« ${chemin.split('/').pop()} »` : 'la racine du projet'}
          </button>
        )}
        {onAnnule && (
          <button type="button" className="at-bouton nodrag" onClick={onAnnule}>
            Annuler
          </button>
        )}
      </div>
    </div>
  )
}
