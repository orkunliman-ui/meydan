// Touches seules, sur l'ordinateur (volet « raccourcis », lot A) : l'aide (`?`), l'écran de réglage des touches et le
// bouton qui l'ouvre dans les réglages (Apparence). Les actions qui vivent sur le plateau (F, G) sont dans
// ClavierPlateau.jsx : ce fichier-ci est chargé avec l'application (App.jsx), React Flow ne doit pas y venir avec lui
// (il part avec le plateau, differe.js ; mesuré : 370 → 566 Ko pour le morceau de départ quand F et G étaient ici).
// Orkun, 13/11 : « On est encore loin de toutes les fonctionnalitēs de Symvibe ». Symvibe (/docs/shortcuts) : des touches
// seules réglables (N = la console qui t'attend, X = carte de mission, T = nouvel agent, M = mémoire, G = Git…).
// Le registre des touches, leur réglage retenu sur l'appareil et l'écoute du clavier sont dans raccourcis.js.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useMedia } from './lib.js'
import { apresAction, defauts, estBranchee, regler, retirer, saisirTouche, useBranche, useTouches } from './raccourcis.js'

const cls = (...xs) => xs.filter(Boolean).join(' ')
// Une touche telle qu'on la lit sur le clavier : lettre en capitale.
const lisible = (t) => (t == null ? '' : t.toUpperCase())
// Les touches qui ne se règlent pas, rappelées dans l'aide (App.jsx, Board.jsx, Selection.jsx ; Espace : volet « ordres »).
const FIXES = [
  { combos: [['Alt', '1…9']], quoi: 'La console de ce rang dans la liste, même depuis un terminal' },
  { combos: [['Alt', '0']], quoi: 'Celle qui t’attend depuis le plus longtemps' },
  { combos: [['Alt', '↑'], ['Alt', '↓']], quoi: 'La console précédente, la suivante' },
  { combos: [['Ctrl', 'Z'], ['Ctrl', 'Maj', 'Z']], quoi: 'Annuler, rétablir la disposition du plateau (hors terminal)' },
  { combos: [['Maj', 'clic']], quoi: 'Ajouter une console à la sélection (sur sa barre, ou dans son terminal sans bouger)' },
  { combos: [['Maj', 'glisser']], quoi: 'Choisir au lasso (sur le fond du plateau)' },
  { combos: [['Échap']], quoi: 'Fermer un panneau, désélectionner' },
  { combos: [['Espace']], quoi: 'Réservée : maintenir pour parler' },
]
// Pourquoi une action n'a rien sur cet écran (pas de touche morte silencieuse : l'aide le dit).
// La carte de mission est une vue à part dans les deux thèmes depuis le 17/11 (décision d'Orkun, raccourcis-4 : « Vue carte
// de mission ») : elle n'a plus de cas à elle ici.
function indisponible() {
  return 'Pas sur cet écran'
}

// L'aide montée une fois (App.jsx) ; le bouton des réglages l'ouvre sur l'écran de réglage. `canal.ouvre` n'existe que
// quand l'aide est montée (ordinateur) : sans elle, le bouton ne s'affiche pas (jamais de bouton mort).
const canal = { ouvre: null, ecoutes: new Set() }
function poseCanal(f) {
  canal.ouvre = f
  for (const g of canal.ecoutes) g()
}
const useCanal = () =>
  useSyncExternalStore(
    (f) => (canal.ecoutes.add(f), () => canal.ecoutes.delete(f)),
    () => canal.ouvre,
  )

// L'aide des touches (`?`) et l'écran « Raccourcis » (montés une fois, App.jsx ; rien sur le téléphone).
// `?` ou Échap la referme ; une autre touche réglée la referme et agit.
export function AideRaccourcis() {
  const [mode, setMode] = useState(null) // null | 'aide' | 'regler'
  const avant = useRef(null) // ce qui avait le clavier à l'ouverture : il le retrouve quand on referme
  const ouvre = (m) => {
    if (!avant.current) avant.current = document.activeElement
    setMode(m)
  }
  const ferme = (rendre) => {
    const el = avant.current
    avant.current = null
    setMode(null)
    if (rendre && el?.isConnected && el !== document.body) el.focus?.()
  }
  const modeRef = useRef(mode)
  modeRef.current = mode
  useBranche('aide', () => (modeRef.current ? ferme(true) : ouvre('aide')))
  useEffect(() => {
    poseCanal(ouvre)
    return () => canal.ouvre === ouvre && poseCanal(null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Une autre action a agi pendant que l'aide est ouverte : l'aide s'efface (le clavier reste où l'action l'a mis).
  useEffect(
    () =>
      apresAction((id) => {
        if (id === 'aide' || !modeRef.current) return
        avant.current = null
        setMode(null)
      }),
    [],
  )
  if (!mode) return null
  return <Fenetre mode={mode} setMode={setMode} ferme={ferme} />
}

function Fenetre({ mode, setMode, ferme }) {
  const touches = useTouches()
  const [attend, setAttend] = useState(null) // l'action dont l'écran de réglage attend la touche
  const [avis, setAvis] = useState(null) // { id, ok, texte } : ce que le dernier réglage a donné, sous sa ligne
  const boite = useRef(null)
  const etat = useRef({})
  etat.current = { attend, touches, ferme }

  useEffect(() => {
    boite.current?.focus()
  }, [])
  // Tant qu'une touche est attendue, aucune action ne part (raccourcis.js, et Alt+1…9 d'App.jsx).
  useEffect(() => {
    saisirTouche(!!attend)
    return () => saisirTouche(false)
  }, [attend])

  // Une seule écoute, en capture : elle passe avant le plateau (Ctrl+Z, Échap qui désélectionne) et les touches seules.
  useEffect(() => {
    const touche = (e) => {
      const { attend: a, touches: ts, ferme: f } = etat.current
      if (e.isComposing) return
      if (a) {
        // Maj, Ctrl… seuls : on attend la touche qui suit.
        if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'OS'].includes(e.key)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (e.repeat) return
        if (e.key === 'Escape') {
          setAttend(null)
          setAvis(null)
          return
        }
        const r = e.ctrlKey || e.altKey || e.metaKey ? { ok: false, raison: 'Une seule touche, sans Ctrl, Alt ni Méta' } : regler(a, e.key)
        const nom = ts.find((x) => x.id === a)?.nom
        if (r.ok) {
          setAttend(null)
          setAvis({ id: a, ok: true, texte: `« ${lisible(e.key)} » : ${nom}` })
        } else setAvis({ id: a, ok: false, texte: `Refusé : ${r.raison}` })
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        f(true)
        return
      }
      // Tab reste dans la fenêtre (elle couvre tout l'écran).
      if (e.key === 'Tab' && boite.current) {
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
    }
    window.addEventListener('keydown', touche, true)
    return () => window.removeEventListener('keydown', touche, true)
  }, [])

  const fond = useRef(false)
  const onglet = (m, nom) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => {
        setAttend(null)
        setAvis(null)
        setMode(m)
      }}
    >
      {nom}
    </button>
  )
  return (
    <div
      className="rc-fond"
      onPointerDown={(e) => (fond.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (fond.current && e.target === e.currentTarget) ferme(true)
        fond.current = false
      }}
    >
      <section className="rc-fenetre" role="dialog" aria-modal="true" aria-labelledby="rc-titre" tabIndex={-1} ref={boite} data-mode={mode}>
        <header className="rc-tete">
          <b id="rc-titre">Raccourcis clavier</b>
          <nav className="rc-onglets" role="tablist" aria-label="Aide ou réglage">
            {onglet('aide', 'Aide')}
            {onglet('regler', 'Régler')}
          </nav>
          <button type="button" className="rc-x" aria-label="Fermer (Échap)" title="Fermer (Échap)" onClick={() => ferme(true)}>
            ×
          </button>
        </header>
        {mode === 'aide' ? (
          <div className="rc-corps" role="tabpanel" aria-label="Aide">
            <p className="rc-intro">Une touche seule agit quand le clavier n’est ni dans un terminal ni dans un champ : clique sur le fond du plateau pour sortir d’un terminal.</p>
            <ul className="rc-liste">
              {touches.map((a) => {
                const ici = estBranchee(a.id)
                return (
                  <li key={a.id} className={cls(!ici && 'est-absente')} data-action={a.id}>
                    {a.touche != null ? <kbd className="rc-touche">{lisible(a.touche)}</kbd> : <span className="rc-touche est-vide" title="Aucune touche">—</span>}
                    <span className="rc-quoi">
                      <b>{a.nom}</b>
                      <small>{ici ? a.detail : indisponible(a.id)}</small>
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="rc-sous">Toujours là</p>
            <ul className="rc-liste rc-fixes">
              {FIXES.map((x) => (
                <li key={x.quoi}>
                  <span className="rc-combos">
                    {x.combos.map((c, i) => (
                      <span key={i} className="rc-combo">
                        {c.map((k) => (
                          <kbd key={k} className="rc-touche est-mot">
                            {k}
                          </kbd>
                        ))}
                      </span>
                    ))}
                  </span>
                  <span className="rc-quoi">
                    <small>{x.quoi}</small>
                  </span>
                </li>
              ))}
            </ul>
            <p className="rc-pied">
              <span>
                <kbd className="rc-touche est-mot">?</kbd> ou <kbd className="rc-touche est-mot">Échap</kbd> referme
              </span>
              <button type="button" className="rc-lien" onClick={() => setMode('regler')}>
                Régler les touches…
              </button>
            </p>
          </div>
        ) : (
          <div className="rc-corps" role="tabpanel" aria-label="Régler">
            <p className="rc-intro">Une seule touche par action, sans Ctrl, Alt ni Méta ; Espace et les chiffres sont pris. Retenu sur cet appareil.</p>
            <ul className="rc-liste rc-reglage">
              {touches.map((a) => (
                <li key={a.id} className={cls(attend === a.id && 'est-attente')} data-action={a.id}>
                  {a.touche != null ? <kbd className="rc-touche">{lisible(a.touche)}</kbd> : <span className="rc-touche est-vide">aucune</span>}
                  <span className="rc-quoi">
                    <b>{a.nom}</b>
                    {avis?.id === a.id && (
                      <small className={cls('rc-avis', !avis.ok && 'est-refus')} role={avis.ok ? 'status' : 'alert'}>
                        {avis.texte}
                      </small>
                    )}
                  </span>
                  <span className="rc-boutons">
                    <button
                      type="button"
                      className={cls('rc-changer', attend === a.id && 'est-attente')}
                      aria-pressed={attend === a.id}
                      onClick={() => {
                        setAvis(null)
                        setAttend((x) => (x === a.id ? null : a.id))
                      }}
                    >
                      {attend === a.id ? 'Appuie sur une touche… (Échap annule)' : 'Changer'}
                    </button>
                    {attend !== a.id && (
                      <button
                        type="button"
                        className="rc-aucune"
                        disabled={a.touche == null}
                        onClick={() => {
                          retirer(a.id)
                          setAttend(null)
                          setAvis({ id: a.id, ok: true, texte: 'Plus de touche pour cette action' })
                        }}
                      >
                        Aucune
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="rc-pied">
              <button
                type="button"
                className="rc-defaut"
                onClick={() => {
                  defauts()
                  setAttend(null)
                  setAvis(null)
                }}
              >
                Touches par défaut
              </button>
              <span>
                <kbd className="rc-touche est-mot">Échap</kbd> referme
              </span>
            </p>
          </div>
        )}
      </section>
    </div>
  )
}

// Dans les réglages (Apparence, Rail.jsx) : ouvre l'écran « Raccourcis ». Rien au téléphone (même règle que `mobile`
// dans App.jsx), ni sur un appareil qu'on ne mène qu'au doigt (pointeur principal grossier et aucune souris).
export function BoutonRaccourcis() {
  const ouvre = useCanal()
  const tel = useMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)')
  const doigt = useMedia('(pointer: coarse)')
  const souris = useMedia('(any-pointer: fine)')
  if (!ouvre || tel || (doigt && !souris)) return null
  return (
    <button type="button" className="rc-ouvre" onClick={() => ouvre('regler')} title="Les touches seules (N, X, T, M, G, F, ?) et leur réglage">
      Raccourcis clavier…
    </button>
  )
}
