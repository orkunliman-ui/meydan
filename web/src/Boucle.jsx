import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEchap } from './lib.js'
import { useEtape } from './retour.js'

// Le panneau d'une boucle : un message que Meydan renvoie tout seul à un agent, jusqu'à une fin. Trois fins, toujours :
// un nombre de tours, une durée, et la marque que l'agent écrit quand l'objectif est atteint. Les plafonds (50 tours,
// 12 heures) sont ceux du serveur (lib/boucle.mjs) : une boucle dépense le quota d'Orkun sans lui.
const depuis = (ms) => {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000))
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

// Ce qu'une boucle dit d'elle en une ligne (liste, barre d'une console).
export function resumeBoucle(b) {
  if (!b) return ''
  return b.etat === 'active' ? `boucle ${b.n}/${b.tours}` : `boucle finie · ${b.n} tour${b.n > 1 ? 's' : ''}`
}

function Pas({ nom, valeur, min, max, pas = 1, unite, onChange }) {
  return (
    <label className="boucle-pas">
      <span>{nom}</span>
      <span className="boucle-compte">
        <button type="button" aria-label={`${nom} : moins`} onClick={() => onChange(Math.max(min, valeur - pas))}>
          −
        </button>
        <output>
          {valeur}
          {unite}
        </output>
        <button type="button" aria-label={`${nom} : plus`} onClick={() => onChange(Math.min(max, valeur + pas))}>
          +
        </button>
      </span>
    </label>
  )
}

// `consoles` : celles qu'on peut guetter (boucle « quand un texte s'affiche »).
export function PanneauBoucle({ console: c, actions, onClose, consoles = [] }) {
  const b = c.boucle
  const active = b?.etat === 'active'
  const [texte, setTexte] = useState(b?.texte || '')
  const [quand, setQuand] = useState(b?.quand || 'repos')
  const [minutes, setMinutes] = useState(b?.minutes || 30)
  const [tours, setTours] = useState(b?.tours || 10)
  const [heures, setHeures] = useState(b?.heures || 2)
  const [marque, setMarque] = useState(b?.marque ?? 'OBJECTIF ATTEINT')
  const [guet, setGuet] = useState(b?.guet || '')
  // La console guettée est toujours une AUTRE console (un shell qui fait tourner les essais, un serveur) : dans la sienne,
  // le message collé par Meydan, qui cite le texte guetté, relancerait la boucle tour après tour. Un shell d'abord.
  const guettables = consoles.filter((x) => x.id !== c.id && x.status !== 'closed').sort((x, y) => Number(y.kind === 'shell') - Number(x.kind === 'shell'))
  const [choisie, setSource] = useState(b?.source || '')
  const source = guettables.some((x) => x.id === choisie) ? choisie : (guettables[0]?.id ?? '')
  const [erreur, setErreur] = useState('')
  const [busy, setBusy] = useState(false)
  useEchap(onClose)
  useEtape(true, onClose) // téléphone : une étape d'historique, « retour » ferme le panneau (retour.js)
  const fais = (p) => {
    setBusy(true)
    setErreur('')
    p.then(
      () => setBusy(false),
      (e) => {
        setErreur(e.message)
        setBusy(false)
      },
    )
  }
  return createPortal(
    <div className="boucle-fond" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="boucle" role="dialog" aria-label={`Boucle de ${c.name}`}>
        <header>
          <b>Boucle</b>
          <span>{c.name}</span>
          <button type="button" className="boucle-x" aria-label="Fermer" onClick={onClose}>
            ×
          </button>
        </header>
        {active ? (
          <>
            <p className="boucle-etat">
              <b>
                Tour {b.n} sur {b.tours}
              </b>
              <span>
                lancée il y a {depuis(b.cree)} · fin au plus tard dans {depuis(2 * Date.now() - b.fin)}
              </span>
              {b.attend && <em>{b.attend}</em>}
            </p>
            <p className="boucle-texte">{b.texte}</p>
            <p className="boucle-note">
              {b.quand === 'repos'
                ? 'Renvoyé dès que l’agent a fini son tour.'
                : b.quand === 'sortie'
                  ? `Renvoyé quand « ${b.guet} » s’affiche dans ${b.sourceNom}, avec l’extrait.`
                  : `Renvoyé toutes les ${b.minutes} min, si l’agent est au repos.`}
              {b.marque && ` S’arrête quand l’agent écrit « ${b.marque} ».`}
            </p>
            <button type="button" className="boucle-stop" disabled={busy} onClick={() => fais(actions.arreteBoucle(c.id))}>
              Arrêter la boucle
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              fais(actions.boucle(c.id, { texte, quand, minutes, tours, heures, marque, guet, source }))
            }}
          >
            {b && (
              <p className="boucle-note">
                Dernière boucle : {b.n} tour{b.n > 1 ? 's' : ''}, {b.raison || 'finie'}.
              </p>
            )}
            <label className="boucle-champ">
              <span>Message renvoyé à l’agent</span>
              <textarea rows={3} maxLength={4000} value={texte} placeholder="Continue. Quand tout est fait et vérifié, dis-le." onChange={(e) => setTexte(e.target.value)} />
            </label>
            <div className="boucle-quand" role="radiogroup" aria-label="Quand renvoyer le message">
              <button type="button" role="radio" aria-checked={quand === 'repos'} onClick={() => setQuand('repos')}>
                Dès qu’il a fini
              </button>
              <button type="button" role="radio" aria-checked={quand === 'horaire'} onClick={() => setQuand('horaire')}>
                À heure fixe
              </button>
              <button type="button" role="radio" aria-checked={quand === 'sortie'} onClick={() => setQuand('sortie')}>
                Quand un texte s’affiche
              </button>
            </div>
            {quand === 'horaire' && <Pas nom="Toutes les" valeur={minutes} min={5} max={720} pas={minutes >= 60 ? 30 : 5} unite=" min" onChange={setMinutes} />}
            {quand === 'sortie' && (
              <>
                <label className="boucle-champ">
                  <span>Texte à guetter</span>
                  <input value={guet} maxLength={120} placeholder="FAIL" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setGuet(e.target.value)} />
                </label>
                {guettables.length ? (
                  <label className="boucle-champ">
                    <span>Dans la console</span>
                    <select value={source} onChange={(e) => setSource(e.target.value)}>
                      {guettables.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="boucle-erreur">Aucune autre console à guetter : ouvre d’abord un shell (celui qui fait tourner les essais, par exemple).</p>
                )}
                <p className="boucle-note">Chaque fois que ce texte s’affiche de nouveau dans cette console, le message part à l’agent dès qu’il est au repos, avec les lignes qui l’entourent. Ce qui est déjà à l’écran ne compte pas.</p>
              </>
            )}
            <Pas nom="Arrêt après" valeur={tours} min={1} max={50} unite={tours > 1 ? ' tours' : ' tour'} onChange={setTours} />
            <Pas nom="Ou après" valeur={heures} min={1} max={12} unite=" h" onChange={setHeures} />
            <label className="boucle-champ">
              <span>Ou quand l’agent écrit</span>
              <input value={marque} maxLength={60} onChange={(e) => setMarque(e.target.value)} />
            </label>
            <button type="submit" className="boucle-go" disabled={busy || !texte.trim() || (quand === 'sortie' && (!guet.trim() || !source))}>
              Lancer la boucle
            </button>
          </form>
        )}
        {erreur && (
          <p className="boucle-erreur" role="alert">
            {erreur}
          </p>
        )}
      </section>
    </div>,
    document.body,
  )
}
