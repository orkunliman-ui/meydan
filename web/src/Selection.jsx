import { useEffect, useState } from 'react'
import { Panel } from '@xyflow/react'

// Sélection multiple, sur l'ordinateur. Orkun, 11/11 : « Sélection multiple (Maj+clic et/ou lasso) pour déplacer, ranger
// ou fermer (fermeture confirmée) plusieurs consoles ensemble. »
// Choisir : Maj+clic sur la barre (ou la tuile) d'une console l'ajoute ou la retire, Maj+clic immobile dans son terminal
// aussi (décision d'Orkun du 17/11, plateau-pc-5, maj-clic.js) ; Maj+glisser sur le fond du plateau trace un lasso (une
// console touchée est prise). Dans un terminal, Maj+glisser reste la sélection de texte de xterm. Déplacer : glisser la
// barre d'une des consoles choisies, toutes suivent.
// Cette barre apparaît dès deux consoles, en bas au milieu du plateau (le haut gauche porte les espaces, la mini-carte est
// en bas à droite) : combien, Ranger, Fermer…, Désélectionner (ou Échap hors terminal).
// Fermer passe par une confirmation qui NOMME les consoles qui vont s'arrêter et dit qu'une fermeture ne s'annule pas.
// Un capitaine d'équipe ne se ferme pas par là (comme dans le menu d'une console) : il est écarté, et on le dit.
export function BarreSelection({ choisies, onRanger, onFermer, onVide }) {
  const [confirme, setConfirme] = useState(false)
  const [dit, setDit] = useState('') // « Déjà rangées », 2,5 s
  const cle = choisies.map((c) => c.id).join(' ')
  useEffect(() => {
    setConfirme(false) // la sélection a changé : la confirmation portait sur d'autres consoles
    setDit('')
  }, [cle])
  useEffect(() => {
    if (!dit) return
    const t = setTimeout(() => setDit(''), 2500)
    return () => clearTimeout(t)
  }, [dit])
  const capitaines = choisies.filter((c) => c.chief)
  const aFermer = choisies.filter((c) => !c.chief)
  const n = choisies.length
  const s = (k) => (k > 1 ? 's' : '')
  return (
    <Panel position="top-center" className="pc-selection">
      {confirme ? (
        <div className="pc-sel-confirme" role="alertdialog" aria-label="Confirmer la fermeture">
          <p className="pc-sel-titre">{aFermer.length ? `Fermer ${aFermer.length} console${s(aFermer.length)} ? Ce qui tourne dedans s’arrête :` : 'Aucune de ces consoles ne se ferme d’ici.'}</p>
          {aFermer.length > 0 && (
            <ul className="pc-sel-noms">
              {aFermer.map((c) => (
                <li key={c.id} title={c.name}>
                  {c.name}
                </li>
              ))}
            </ul>
          )}
          {capitaines.length > 0 && (
            <p className="pc-sel-note">
              {capitaines.length > 1 ? 'Restent ouvertes' : 'Reste ouverte'} : {capitaines.map((c) => c.name).join(', ')} — un capitaine d’équipe se ferme en arrêtant son équipe, depuis la colonne.
            </p>
          )}
          <p className="pc-sel-note">Une fermeture ne s’annule pas (ni Ctrl+Z, ni ↶) ; les consoles fermées vont dans l’Historique, d’où tu peux les relancer.</p>
          <div className="pc-sel-actions">
            {aFermer.length > 0 && (
              <button type="button" className="pc-sel-danger" onClick={() => onFermer(aFermer.map((c) => c.id))}>
                {aFermer.length > 1 ? `Fermer les ${aFermer.length}` : 'Fermer'}
              </button>
            )}
            <button type="button" onClick={() => setConfirme(false)} autoFocus>
              Garder
            </button>
          </div>
        </div>
      ) : (
        <div className="pc-sel-barre" role="toolbar" aria-label="Consoles choisies">
          <span className="pc-sel-compte" title="Maj+clic sur une barre (ou dans un terminal, sans bouger) : ajouter ou retirer une console. Glisser la barre d’une console choisie : toutes suivent.">
            {n} console{s(n)}
          </span>
          <button type="button" title="Ranger les consoles choisies en rangées, chacune garde sa taille ; au plus près de leur coin haut gauche, sans toucher les autres consoles ni les cartes (Ctrl+Z annule)" onClick={() => onRanger() || setDit('Déjà rangées')}>
            {dit || 'Ranger'}
          </button>
          <button type="button" title="Fermer les consoles choisies (confirmation ; une fermeture ne s’annule pas)" onClick={() => setConfirme(true)}>
            Fermer…
          </button>
          <button type="button" title="Désélectionner (Échap)" onClick={onVide}>
            Désélectionner
          </button>
        </div>
      )}
    </Panel>
  )
}
