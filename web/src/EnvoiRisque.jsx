// Garde du texte risqué dans la barre d'envoi (Envoi.jsx), côté écran. Décision d'Orkun du 17/11, ordres-4 : « Oui, avec
// le même risques(), dans un lot à part ». La garde elle-même est au serveur (lib/garde-envoi.mjs) : un texte risqué
// (rm -rf, sudo, .env, curl | sh…) reçoit 409 avec les passages cités et une empreinte ; l'écran les montre, le bouton
// d'envoi devient « Confirmer : <motif> », et le second appui (bouton, ou Entrée sur l'ordinateur) renvoie l'empreinte.
// Toute modification du texte (ou des pièces jointes) annule la confirmation : il faut de nouveau deux appuis.
// Relecture du 17/11 : le second appui ne compte qu'au moins DELAI_MS après l'arrivée du refus (un double-clic ou une
// Entrée maintenue ne confirment pas), et un refus revenu après une modification du texte n'arme rien.
import { useEffect, useRef, useState } from 'react'
import './envoi-risque.css'

const MONTRES = 3 // passages montrés ; au-delà, « et N autres » (la barre du téléphone reste basse)
const DELAI_MS = 600

// `texte`, `pieces` (noms reçus) : ce que la barre enverrait maintenant. Rend :
//   arme         : le refus « texte risqué » de CE texte et CES pièces, ou null ;
//   confirmation : l'empreinte à renvoyer au second appui (undefined sinon) ;
//   libelle      : « Confirmer : <motif> » quand armé ;
//   tropTot()    : vrai si la confirmation est armée depuis moins de DELAI_MS (l'appui est alors ignoré) ;
//   retient(e, texte, pieces) : au retour d'un envoi refusé, arme la confirmation si c'est un 409 « texte risqué » (vrai),
//                  sinon rend faux (l'appelant affiche l'erreur comme avant). Un 409 pour un texte qui n'est plus celui du
//                  champ (modifié pendant la demande) est avalé sans rien armer.
export function useRisque(texte, pieces) {
  const [refus, setRefus] = useState(null)
  const cle = JSON.stringify([texte, pieces])
  const actuelle = useRef(cle)
  actuelle.current = cle
  const arme = refus && refus.cle === cle ? refus : null
  useEffect(() => {
    if (refus && refus.cle !== cle) setRefus(null) // texte modifié : revenir au même texte ne réarme pas
  }, [cle]) // eslint-disable-line react-hooks/exhaustive-deps
  const retient = (e, dit, parties) => {
    const c = e?.corps
    if (!(c && typeof c.confirmation === 'string' && Array.isArray(c.risques) && c.risques.length)) return false
    const sa = JSON.stringify([dit, parties])
    if (sa !== actuelle.current) return true // texte modifié pendant la demande : ce refus ne vaut plus rien
    setRefus({ cle: sa, risques: c.risques.filter((r) => r && typeof r.motif === 'string' && typeof r.passage === 'string'), confirmation: c.confirmation, quand: Date.now() })
    return true
  }
  const tropTot = () => !!arme && Date.now() - arme.quand < DELAI_MS
  return { arme, confirmation: arme?.confirmation, libelle: arme ? `Confirmer : ${arme.risques[0]?.motif || 'envoyer'}` : '', retient, tropTot }
}

// Les passages cités, au-dessus de la barre.
export function EnvoiRisque({ risques }) {
  const vus = risques.slice(0, MONTRES)
  const reste = risques.length - vus.length
  return (
    <div className="envoi-risque" role="alert">
      <p className="envoi-risque-titre">Texte risqué : relis, puis appuie encore pour l’envoyer tel quel.</p>
      <ul className="envoi-risque-liste" aria-label="Passages risqués">
        {vus.map((r, i) => (
          <li key={i}>
            <b>{r.motif}</b>
            <q>{r.passage}</q>
          </li>
        ))}
      </ul>
      {reste > 0 && <p className="envoi-risque-reste">et {reste} autre{reste > 1 ? 's' : ''} passage{reste > 1 ? 's' : ''}</p>}
    </div>
  )
}
