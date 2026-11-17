// Vue « carte de mission » — décision d'Orkun du 17/11, raccourcis-4 : « Vue carte de mission » (la question était :
// X = filtre suivant de la liste, ou « une vue « carte de mission » à part, comme l'écran de Symvibe ? »). Symvibe a un
// écran de mission à part (docs/specs/2026-11-10-ecart-symvibe.md : « carte de mission (trois colonnes, filtres…) »,
// « qui travaille, qui attend ») : X l'ouvre ici, par-dessus le plateau de l'ordinateur. Toutes les consoles et les
// équipes en cartes lisibles d'un coup d'œil : leur état et depuis quand, ce qu'elles font, et ce qui t'attend. X ou
// Échap pour revenir ; un clic sur une carte cadre sa console sur le plateau (la même action que la liste) et referme.
//
// Ce fichier (morceau principal) ne porte que la coquille : la touche, le dialogue, son en-tête, Échap, Tab, et le
// clavier rendu à la fermeture. Les cartes (MissionCorps.jsx) arrivent à la demande (differe.js) : rien de plus à
// charger pour qui n'ouvre pas la vue. Ordinateur seulement : App.jsx ne la monte pas au téléphone (pas de touche
// seule, rien n'écoute, rien ne s'affiche).
import { useEffect, useRef, useState } from 'react'
import { equipeAttend, useEchap } from './lib.js'
import { toucheDe, useBranche } from './raccourcis.js'
import { CorpsMission, prechargeMission } from './differe.js'
import './mission.css'

export function Mission({ consoles, teams, onPick }) {
  const [ouverte, setOuverte] = useState(false)
  const avant = useRef(null) // ce qui avait le clavier à l'ouverture : il le retrouve quand on revient par X ou Échap
  const ouverteRef = useRef(false)
  ouverteRef.current = ouverte
  const ferme = (rendre) => {
    const el = avant.current
    avant.current = null
    setOuverte(false)
    if (rendre && el?.isConnected && el !== document.body) el.focus?.()
  }
  // X ouvre, X referme (la vue est le `panneau` de l'action dans raccourcis.js : ouverte, elle n'empêche pas sa touche).
  useBranche('mission', () => {
    if (ouverteRef.current) return ferme(true)
    avant.current = document.activeElement
    setOuverte(true)
  })
  // Les cartes chargées d'avance, une fois la page posée : la première X les montre aussitôt.
  useEffect(() => {
    const t = setTimeout(prechargeMission, 4000)
    return () => clearTimeout(t)
  }, [])
  if (!ouverte) return null
  return (
    <Vue
      consoles={consoles}
      teams={teams}
      // Un clic sur une carte : la console est choisie et cadrée comme depuis la liste ; son terminal prend le clavier
      // (Term.jsx) : on ne le lui reprend pas.
      onPick={(id) => {
        ferme(false)
        onPick(id)
      }}
      onClose={() => ferme(true)}
      onQuitte={() => ferme(false)}
    />
  )
}

function Vue({ consoles, teams, onPick, onClose, onQuitte }) {
  const boite = useRef(null)
  const quitte = useRef(onQuitte)
  quitte.current = onQuitte
  useEchap(onClose)
  // Le clavier dans la vue : sur la première carte (posé par MissionCorps.jsx, dont l'effet passe avant celui-ci), sinon
  // sur « Revenir » le temps que les cartes arrivent. Jamais sur la vue elle-même : Espace y lancerait la dictée.
  useEffect(() => {
    if (!boite.current?.contains(document.activeElement)) boite.current?.querySelector('.mi-revenir')?.focus()
  }, [])
  useEffect(() => {
    const touche = (e) => {
      // Alt+1…9, Alt+0, Alt+↑ / Alt+↓ (App.jsx) choisissent une console : la vue s'efface pour la montrer.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (/^Digit[0-9]$/.test(e.code) || e.key === 'ArrowUp' || e.key === 'ArrowDown')) return quitte.current()
      // Tab reste dans la vue (elle couvre tout l'écran), comme l'aide des touches.
      if (e.key !== 'Tab' || !boite.current) return
      const ici = [...boite.current.querySelectorAll('button:not(:disabled)')]
      if (!ici.length) return
      const i = ici.indexOf(document.activeElement)
      if (e.shiftKey && i <= 0) {
        e.preventDefault()
        ici.at(-1).focus()
      } else if (!e.shiftKey && (i < 0 || i === ici.length - 1)) {
        e.preventDefault()
        ici[0].focus()
      }
    }
    window.addEventListener('keydown', touche, true)
    return () => window.removeEventListener('keydown', touche, true)
  }, [])
  const ouvertes = consoles.filter((c) => c.status !== 'closed')
  const fermees = consoles.length - ouvertes.length
  // Ce qui t'attend, compté comme la liste (Rail.jsx) : les questions posées et les équipes prêtes à livrer.
  const n = ouvertes.filter((c) => c.status === 'needs').length + teams.filter(equipeAttend).length
  const equipes = teams.filter((t) => ouvertes.some((c) => c.team === t.id) || equipeAttend(t)).length
  const pluriel = (k, un, plus) => `${k} ${k > 1 ? plus : un}`
  const touche = toucheDe('mission')
  return (
    <div className="mi" role="dialog" aria-modal="true" aria-label="Carte de mission" aria-describedby="mi-titre" ref={boite}>
      <header className="mi-tete">
        <div className="mi-titres">
          <p className="mi-sur">Carte de mission</p>
          <h1 id="mi-titre" className={n ? 'est-plein' : undefined}>
            {n ? (n > 1 ? `${n} t’attendent` : '1 t’attend') : 'Rien ne t’attend'}
          </h1>
          <p className="mi-bilan">
            {pluriel(ouvertes.length, 'console ouverte', 'consoles ouvertes')}
            {equipes > 0 && ` · ${pluriel(equipes, 'équipe', 'équipes')}`}
            {fermees > 0 && ` · ${pluriel(fermees, 'fermée', 'fermées')}, dans l’Historique de la liste`}
          </p>
        </div>
        <p className="mi-aide">Un clic sur une carte la cadre sur le plateau.</p>
        <button type="button" className="mi-revenir" onClick={onClose}>
          Revenir au plateau
          {/* La touche du moment (elle se règle : raccourcis.js), et Échap. */}
          {touche && <kbd>{touche.toUpperCase()}</kbd>}
          <kbd>Échap</kbd>
        </button>
      </header>
      <CorpsMission consoles={ouvertes} teams={teams} onPick={onPick} />
    </div>
  )
}
