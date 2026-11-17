import { since, statusOf, useNow } from './lib.js'

// Thème « Réverbère » : une forme par état, pour que l'état se lise sans la couleur.
export function Signe({ status }) {
  return (
    <i className={`signe s-${status}`} aria-hidden="true">
      {status === 'working' && (
        <>
          <i />
          <i />
          <i />
        </>
      )}
    </i>
  )
}

export function Age({ since: ts }) {
  const now = useNow()
  return <span className="age">{since(ts, now)}</span>
}

// Thème « Tapis » : le tampon d'état (barre des dalles, console du téléphone). Ici et pas dans Board.jsx : la console du
// téléphone s'en sert sans charger le plateau.
export function Stamp({ status, since: ts }) {
  const now = useNow()
  return (
    <span className={`stamp is-${status}`}>
      <i />
      {statusOf(status).label}
      <small>{since(ts, now)}</small>
    </span>
  )
}
