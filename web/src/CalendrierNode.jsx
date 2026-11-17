// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — la carte
// Calendrier : « carte mois avec des entrées par jour (texte court), aujourd'hui marqué ; rien n'est envoyé ailleurs (pas
// d'Outlook) ». Serveur : lib/cartes-calendrier.mjs (données { mois: 'AAAA-MM' | '', entrees: [{ id, jour, t }] }).
//   La grille du mois, semaine du LUNDI au dimanche (Belgique), noms en français ; « ‹ » « › » changent de mois (retenu
//   sur la carte), « Aujourd'hui » revient au mois en cours (mois '' : la carte suit le mois en cours).
//   Aujourd'hui vient de l'heure LOCALE du navigateur (getFullYear / getMonth / getDate, jamais toISOString) et se remet à
//   jour à minuit ; il est marqué en papier sur encre (aucun jaune).
//   Une case montre ses premières entrées (autant que sa hauteur en porte, 3 au plus), puis « +N ».
//   Clic sur un jour : sa liste, par-dessus la grille dans la carte (rien ne défile hors de la liste elle-même) — ajouter
//   (Entrée), modifier (double-clic), supprimer (« × ») ; Échap ou « ‹ mois » la referme.
// Téléphone couché (`tel`) : tuile fixe en lecture — le mois, la grille, aujourd'hui marqué, un point par jour qui a des
// entrées ; aucun champ, aucun bouton, aucun défilement, aucune animation. Vue de loin (`far`) : le titre en grand.
// Contrat : composant de dalle React Flow `({ id, data: k, width, height, selected })`, comme NoteNode.jsx.
import { memo, useContext, useEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { cls } from './lib.js'
import { ligne, nouvelId, useChampsLocaux } from './ChecklistNode.jsx'
import './carte-calendrier.css'

const ENTREES_MAX = 250 // = lib/cartes-calendrier.mjs
const ENTREE_MAX = 60 // caractères par entrée ; = lib/cartes-calendrier.mjs
const ANNEES = [1900, 2999] // = lib/cartes-calendrier.mjs
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const JOURS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim']
const JOURS_LONGS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
// Hauteurs d'une case (= carte-calendrier.css) : marge, ligne du numéro, ligne d'une entrée.
const CASE = { marge: 4, numero: 17, entree: 15 }
const deux = (n) => String(n).padStart(2, '0')
const cleDe = (d) => `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}` // date LOCALE
const lundiDabord = (d) => (d.getDay() + 6) % 7 // lundi = 0 … dimanche = 6

// Le jour d'aujourd'hui (heure locale), remis à jour à minuit et au retour d'une page cachée (téléphone en veille).
function useAujourdhui() {
  const [auj, setAuj] = useState(() => cleDe(new Date()))
  useEffect(() => {
    const maj = () => setAuj(cleDe(new Date()))
    const n = new Date()
    const t = setTimeout(maj, new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1) - n + 500)
    const vu = () => document.visibilityState === 'visible' && maj()
    document.addEventListener('visibilitychange', vu)
    return () => {
      clearTimeout(t)
      document.removeEventListener('visibilitychange', vu)
    }
  }, [auj])
  return auj
}

// Les semaines du mois m (1 à 12) de l'année a, du lundi au dimanche : 4 à 6 semaines de 7 jours.
function semainesDe(a, m) {
  const decale = lundiDabord(new Date(a, m - 1, 1))
  const n = new Date(a, m, 0).getDate()
  const nb = Math.ceil((decale + n) / 7)
  return Array.from({ length: nb }, (_, s) =>
    Array.from({ length: 7 }, (_, j) => {
      const d = new Date(a, m - 1, 1 - decale + s * 7 + j)
      return { cle: cleDe(d), j: d.getDate(), dedans: d.getMonth() === m - 1, sem: j }
    }),
  )
}
// « jeudi 13 novembre 2026 » d'une clé AAAA-MM-JJ.
function nomDuJour(cle) {
  const [a, m, j] = cle.split('-').map(Number)
  return `${JOURS_LONGS[lundiDabord(new Date(a, m - 1, j))]} ${j} ${MOIS[m - 1]} ${a}`
}

export const CalendrierNode = memo(function CalendrierNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const store = useStoreApi()
  const { vue, vueRef, envoie, erreur, setErreur } = useChampsLocaux(id, k, actions)
  const auj = useAujourdhui()
  const entrees = Array.isArray(vue.entrees) ? vue.entrees : []
  // Le mois affiché : celui retenu sur la carte, sinon (mois '' ou abîmé) le mois en cours.
  const [a, m] = (/^\d{4}-(0[1-9]|1[0-2])$/.test(vue.mois || '') ? vue.mois : auj.slice(0, 7)).split('-').map(Number)
  const semaines = semainesDe(a, m)
  const parJour = new Map()
  for (const e of entrees) {
    if (!parJour.has(e.jour)) parJour.set(e.jour, [])
    parJour.get(e.jour).push(e)
  }
  const [ouvert, setOuvert] = useState(null) // la clé du jour dont la liste est ouverte
  const [nouveau, setNouveau] = useState('')
  const [edite, setEdite] = useState(null)
  const [hRang, setHRang] = useState(0) // hauteur d'une semaine de la grille (points du plan, sans le zoom)
  const grille = useRef(null)
  const champ = useRef(null)
  const listeJour = useRef(null)
  const entreesDe = () => (Array.isArray(vueRef.current.entrees) ? vueRef.current.entrees : [])

  // La hauteur d'une semaine dit combien d'entrées une case peut montrer (mesurée, le zoom n'y entre pas).
  useEffect(() => {
    const g = grille.current
    if (!g || tel || far) return
    const mesure = () => setHRang(g.clientHeight / semaines.length)
    mesure()
    const ro = new ResizeObserver(mesure)
    ro.observe(g)
    return () => ro.disconnect()
  }, [tel, far, semaines.length])
  const place = Math.max(0, Math.min(3, Math.floor((hRang - CASE.marge - CASE.numero) / CASE.entree)))

  // ── Les gestes ──
  const va = (delta) => {
    const d = new Date(a, m - 1 + delta, 1)
    if (d.getFullYear() < ANNEES[0] || d.getFullYear() > ANNEES[1]) return
    setOuvert(null)
    envoie({ mois: `${d.getFullYear()}-${deux(d.getMonth() + 1)}` })
  }
  const ouvre = (cle) => {
    setErreur('')
    setEdite(null)
    setNouveau('')
    setOuvert(cle)
  }
  const retour = useRef(null) // le jour dont la liste vient de se fermer : sa case reprend le focus (clavier)
  const ferme = () => {
    retour.current = ouvert
    setOuvert(null)
    setEdite(null)
  }
  const ajoute = () => {
    const t = ligne(nouveau)
    if (!t || !ouvert) return
    const es = entreesDe()
    if (es.length >= ENTREES_MAX) return setErreur(`${ENTREES_MAX} entrées au plus sur la carte : retire d’anciennes entrées`)
    if (envoie({ entrees: [...es, { id: nouvelId(), jour: ouvert, t }] })) setNouveau('')
  }
  const supprime = (eid) => envoie({ entrees: entreesDe().filter((e) => e.id !== eid) })
  const finEdite = (eid, v) => {
    setEdite(null)
    if (v === undefined) return
    const t = ligne(v)
    const e = entreesDe().find((x) => x.id === eid)
    if (!t || !e || t === e.t) return
    envoie({ entrees: entreesDe().map((x) => (x.id === eid ? { ...x, t } : x)) })
  }
  const choisis = () => {
    const s = store.getState()
    if (s.elementsSelectable && !s.nodeLookup.get(id)?.selected) s.addSelectedNodes([id])
  }
  // La liste d'un jour s'ouvre le curseur dans son champ d'ajout ; une entrée en modification prend le focus. Sans faire
  // défiler le plateau.
  useEffect(() => {
    if (ouvert && !edite) champ.current?.focus({ preventScroll: true })
    if (!ouvert && retour.current) grille.current?.querySelector(`button[data-jour="${retour.current}"]`)?.focus({ preventScroll: true })
    retour.current = null
  }, [ouvert, edite])
  useEffect(() => {
    if (edite) listeJour.current?.querySelector('.cr-cal-champ')?.focus({ preventScroll: true })
  }, [edite])
  // Le jour ouvert sort du mois affiché (« ‹ » « › » ailleurs, autre appareil) : sa liste reste valable, rien à faire.

  const entete = (
    <div className="cr-cal-jours" aria-hidden="true">
      {JOURS.map((j, i) => (
        <span key={j} className={cls(i >= 5 && 'est-weekend')}>
          {j}
        </span>
      ))}
    </div>
  )

  let corps = null
  if (tel)
    corps = (
      <div className="cr-cal cr-cal-tel">
        <div className="cr-cal-nav">
          <b className="cr-cal-mois">
            {MOIS[m - 1]} {a}
          </b>
        </div>
        {entete}
        <div className="cr-cal-grille" style={{ gridTemplateRows: `repeat(${semaines.length}, minmax(0, 1fr))` }}>
          {semaines.flat().map((c) => (
            <div key={c.cle} data-jour={c.cle} className={cls('cr-cal-case', !c.dedans && 'est-hors', c.cle === auj && 'est-auj', c.sem >= 5 && 'est-weekend')}>
              <span className="cr-cal-num">{c.j}</span>
              {c.dedans && parJour.has(c.cle) && <i className="cr-cal-point" />}
            </div>
          ))}
        </div>
      </div>
    )
  else if (!far) {
    const duJour = ouvert ? parJour.get(ouvert) || [] : []
    corps = (
      <div className="cr-cal">
        <div className="cr-cal-nav">
          <button type="button" className="cr-cal-fleche nodrag" aria-label="Mois précédent" title="Mois précédent" onClick={() => va(-1)} disabled={a === ANNEES[0] && m === 1}>
            ‹
          </button>
          <b className="cr-cal-mois">
            {MOIS[m - 1]} {a}
          </b>
          <button type="button" className="cr-cal-fleche nodrag" aria-label="Mois suivant" title="Mois suivant" onClick={() => va(1)} disabled={a === ANNEES[1] && m === 12}>
            ›
          </button>
          <button
            type="button"
            className="cr-cal-auj-bouton nodrag"
            title="Revenir au mois en cours (la carte le suivra)"
            onClick={() => {
              setOuvert(null)
              if (vueRef.current.mois) envoie({ mois: '' })
            }}
          >
            Aujourd’hui
          </button>
        </div>
        {entete}
        <div className="cr-cal-grille" ref={grille} style={{ gridTemplateRows: `repeat(${semaines.length}, minmax(0, 1fr))` }}>
          {semaines.flat().map((c) => {
            if (!c.dedans)
              return (
                <div key={c.cle} data-jour={c.cle} className={cls('cr-cal-case est-hors', c.cle === auj && 'est-auj', c.sem >= 5 && 'est-weekend')}>
                  <span className="cr-cal-num">{c.j}</span>
                </div>
              )
            const es = parJour.get(c.cle) || []
            const vus = es.length <= place ? es.length : Math.max(0, place - 1)
            const reste = es.length - vus
            return (
              <button
                type="button"
                key={c.cle}
                data-jour={c.cle}
                className={cls('cr-cal-case nodrag', c.cle === auj && 'est-auj', c.sem >= 5 && 'est-weekend', ouvert === c.cle && 'est-ouvert')}
                aria-label={`${nomDuJour(c.cle)}${c.cle === auj ? ' (aujourd’hui)' : ''} : ${es.length ? `${es.length} entrée${es.length > 1 ? 's' : ''}` : 'aucune entrée'}`}
                onClick={() => ouvre(c.cle)}
              >
                <span className="cr-cal-num">{c.j}</span>
                {es.slice(0, vus).map((e) => (
                  <span key={e.id} className="cr-cal-e">
                    {e.t}
                  </span>
                ))}
                {reste > 0 && (place > 0 ? <span className="cr-cal-plus">+{reste}</span> : <i className="cr-cal-point" />)}
              </button>
            )
          })}
        </div>
        {ouvert && (
          <div
            className="cr-cal-jour"
            role="dialog"
            aria-label={nomDuJour(ouvert)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              ferme()
            }}
          >
            <div className="cr-cal-jour-tete">
              <button type="button" className="cr-cal-retour nodrag" onClick={ferme} title="Revenir au mois (Échap)">
                ‹ {MOIS[m - 1]}
              </button>
              <b className={cls(ouvert === auj && 'est-auj')}>{nomDuJour(ouvert)}</b>
              <span className="cr-cal-compte">{duJour.length || ''}</span>
            </div>
            <ul className="cr-cal-liste" ref={listeJour}>
              {duJour.map((e) => (
                <li key={e.id} data-entree={e.id}>
                  {edite === e.id ? (
                    <input
                      className="cr-cal-champ nodrag"
                      defaultValue={e.t}
                      maxLength={ENTREE_MAX}
                      aria-label="Texte de l’entrée"
                      onFocus={(ev) => ev.currentTarget.select()}
                      onKeyDown={(ev) => {
                        ev.stopPropagation() // le clavier est à la carte (Échap n'annule que la modification)
                        if (ev.key !== 'Enter' && ev.key !== 'Escape') return
                        ev.currentTarget.dataset.fini = '1' // la perte du focus qui suit (champ retiré) ne refait rien
                        finEdite(e.id, ev.key === 'Enter' ? ev.currentTarget.value : undefined)
                      }}
                      onBlur={(ev) => !ev.currentTarget.dataset.fini && finEdite(e.id, ev.currentTarget.value)}
                    />
                  ) : (
                    <span className="cr-cal-texte" title="Double-clic : modifier" onDoubleClick={() => setEdite(e.id)}>
                      {e.t}
                    </span>
                  )}
                  <button type="button" className="cr-cal-suppr nodrag" aria-label={`Supprimer « ${e.t} »`} title="Supprimer" onClick={() => supprime(e.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {!duJour.length && <p className="cr-cal-vide">Rien ce jour-là.</p>}
            {erreur && (
              <p className="cr-cal-erreur" role="alert">
                {erreur}
              </p>
            )}
            <div className="cr-cal-ajout">
              <input
                ref={champ}
                className="nodrag"
                value={nouveau}
                maxLength={ENTREE_MAX}
                placeholder="Ajouter une entrée… (Entrée)"
                aria-label={`Nouvelle entrée pour le ${nomDuJour(ouvert)}`}
                onChange={(e) => setNouveau(e.target.value)}
                onFocus={choisis}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    ajoute()
                  }
                  if (e.key === 'Escape') ferme()
                }}
              />
            </div>
          </div>
        )}
        {erreur && !ouvert && (
          <p className="cr-cal-erreur est-flottant" role="alert">
            {erreur}
          </p>
        )}
      </div>
    )
  }

  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected}>
      {corps}
    </Carte>
  )
})
