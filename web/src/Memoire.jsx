import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, cls, since, useEchap, useNow } from './lib.js'
import { projetDe, projetDeConsole } from './rangement.js'
import { useEtape } from './retour.js'

// Mémoire de projet (volet du 11/11, docs/specs/2026-11-11-memoire-projet.md ; écart Symvibe, point 6 : « mémoire de
// projet (faits validés, poussés aux consoles) »). Par projet, des faits courts validés par Orkun, donnés à chaque
// nouvelle console Claude / Codex du projet à son lancement. Un agent peut en proposer un (`meydan fait "…"`) : la
// proposition attend ici, en signal discret — jamais le jaune, réservé à « à toi de toucher » (questions, Répondre).

// Bornes du serveur, reprises de GET /api/memoire dès qu'il répond.
const BORNES = { texte: 300, valides: 40, proposes: 12 }
// Clé de projet acceptée par le serveur ; une console d'un autre dossier n'a pas de mémoire (rien à ouvrir).
const CLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// Le projet dont une console reçoit la mémoire, calculé comme le serveur : celui de son équipe (son dossier de travail,
// un worktree sous ~/meydan-equipes, ne le dit pas), sinon celui de son dossier. `null` : pas de mémoire.
export function projetMemoire(c, teams = []) {
  if (!c) return null
  const team = c.team && teams.find((t) => t.id === c.team)
  if (c.team && !team) return null
  const p = team ? projetDe(team.projet) : projetDeConsole(c)
  return CLE.test(p) ? p : null
}

// Le texte tel que le serveur le gardera (lib/memoire.mjs) : sa longueur est celle qui compte pour la borne ; le serveur
// reste juge : il refuse, il ne coupe jamais. Comme lui : blancs → une espace ; retirés : contrôles, format (direction,
// étiquettes U+E0000…), usage privé, non attribués, moitiés de caractère, sélecteurs de variante, remplissages invisibles.
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu
const bienForme = (s) => (typeof s.toWellFormed === 'function' ? s.toWellFormed() : s) // Safari iOS ≥ 16.4 ; sinon \p{Cs} retire les moitiés
export const nettoie = (s = '') => bienForme(String(s)).replace(/\s/g, ' ').replace(INVISIBLES, '').normalize('NFC').replace(/ +/g, ' ').trim()
const url = (projet, id) => `/api/memoire/${encodeURIComponent(projet)}${id ? `/${encodeURIComponent(id)}` : ''}`
const depuis = (at, now) => (now - at >= 48 * 3600e3 ? `${Math.floor((now - at) / 86400e3)} j` : since(at, now))
const quiPropose = (par) => (par && typeof par === 'object' ? par.nom || par.console : par) || 'un agent'
// Assez de lignes pour lire le fait sans défiler dans le champ (6 au plus).
const rangs = (t) => Math.min(6, Math.max(2, Math.ceil(t.length / 40)))
// Entrée valide, Maj+Entrée va à la ligne (le serveur en refera une espace).
const surEntree = (f) => (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault()
    f()
  }
}

function Reste({ texte, max }) {
  const reste = max - nettoie(texte).length
  return <span className={cls('mp-reste', reste < 0 && 'est-trop')}>{reste >= 0 ? `${reste} caractère${reste > 1 ? 's' : ''} restant${reste > 1 ? 's' : ''}` : `${-reste} de trop (${max} au plus)`}</span>
}

// Un fait validé : toucher le texte pour le modifier sur place ; « Supprimer » se confirme d'un second appui (5 s).
function Fait({ f, projet, edite, ouvre, ferme, bornes, relis }) {
  const [texte, setTexte] = useState(f.texte)
  const [arme, setArme] = useState(false)
  const [part, setPart] = useState(false)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    if (!arme) return
    const t = setTimeout(() => setArme(false), 5000)
    return () => clearTimeout(t)
  }, [arme])
  if (!edite)
    return (
      <li className="mp-fait">
        <button
          type="button"
          className="mp-fait-texte"
          title="Modifier ce fait"
          onClick={() => {
            setTexte(f.texte)
            setErreur('')
            setArme(false)
            ouvre(f.id)
          }}
        >
          {f.texte}
        </button>
      </li>
    )
  const agit = async (quoi) => {
    if (part) return
    if (quoi === 'supprime' && !arme) return setArme(true)
    if (quoi === 'enregistre' && nettoie(texte) === f.texte) return ferme()
    setPart(true)
    setErreur('')
    try {
      await (quoi === 'supprime' ? api('DELETE', url(projet, f.id)) : api('PATCH', url(projet, f.id), { texte }))
      ferme()
      relis()
    } catch (e) {
      setErreur(e.message)
    }
    setArme(false)
    setPart(false)
  }
  return (
    <li className="mp-fait est-edite">
      <textarea
        className="mp-champ"
        autoFocus
        rows={rangs(texte)}
        value={texte}
        aria-label="Modifier le fait"
        enterKeyHint="done"
        onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
        onChange={(e) => setTexte(e.target.value)}
        onKeyDown={surEntree(() => agit('enregistre'))}
      />
      <Reste texte={texte} max={bornes.texte} />
      <div className="mp-actions">
        <button type="button" className="mp-ok" disabled={part || !nettoie(texte)} onClick={() => agit('enregistre')}>
          Enregistrer
        </button>
        <button type="button" className="mp-non" disabled={part} onClick={ferme}>
          Annuler
        </button>
        <button type="button" className={cls('mp-suppr', arme && 'est-arme')} disabled={part} onClick={() => agit('supprime')}>
          {arme ? 'Confirmer la suppression' : 'Supprimer'}
        </button>
      </div>
      {erreur && (
        <p className="mp-erreur" role="alert">
          {erreur}
        </p>
      )}
    </li>
  )
}

// Une proposition d'agent : qui et depuis quand, son texte modifiable avant de la valider, « Valider » ou « Refuser ».
function Proposition({ f, projet, now, bornes, relis }) {
  const [texte, setTexte] = useState(f.texte)
  // Le texte change ailleurs (autre appareil) : on le suit, sauf si Orkun l'a déjà retouché ici.
  const base = useRef(f.texte)
  useEffect(() => {
    setTexte((t) => (t === base.current ? f.texte : t))
    base.current = f.texte
  }, [f.texte])
  const [part, setPart] = useState(false)
  const [erreur, setErreur] = useState('')
  const agit = async (quoi) => {
    if (part) return
    setPart(true)
    setErreur('')
    try {
      if (quoi === 'refuse') await api('DELETE', url(projet, f.id))
      else await api('PATCH', url(projet, f.id), nettoie(texte) === f.texte ? { valide: true } : { texte, valide: true })
      relis()
    } catch (e) {
      setErreur(e.message)
    }
    setPart(false)
  }
  return (
    <li className="mp-prop">
      <p className="mp-prop-qui">
        <span>
          proposé par <b>{quiPropose(f.par)}</b>
        </span>
        <span>depuis {depuis(f.at, now)}</span>
      </p>
      <textarea
        className="mp-champ"
        rows={rangs(texte)}
        value={texte}
        aria-label={`Proposition de ${quiPropose(f.par)}`}
        enterKeyHint="done"
        onChange={(e) => setTexte(e.target.value)}
        onKeyDown={surEntree(() => agit('valide'))}
      />
      {texte !== f.texte && <Reste texte={texte} max={bornes.texte} />}
      <div className="mp-actions">
        <button type="button" className="mp-ok" disabled={part || !nettoie(texte)} onClick={() => agit('valide')}>
          Valider
        </button>
        <button type="button" className="mp-non" disabled={part} onClick={() => agit('refuse')}>
          Refuser
        </button>
      </div>
      {erreur && (
        <p className="mp-erreur" role="alert">
          {erreur}
        </p>
      )}
    </li>
  )
}

// Le panneau. `projet` : celui demandé à l'ouverture (menu d'une console), sinon le premier qui a des propositions.
// `resume` : [{ projet, valides, proposes, tic }] tenu par useEvents ; un nouveau `tic` pour le projet affiché = relire.
export function Memoire({ projet: demande, resume = [], onClose }) {
  const now = useNow(30000)
  const [liste, setListe] = useState(null) // projets de GET /api/memoire
  const [bornes, setBornes] = useState(BORNES)
  const [choisi, setChoisi] = useState(demande || null)
  const [faits, setFaits] = useState(null) // null : lecture en cours
  const [lecture, setLecture] = useState('') // erreur de lecture
  const [edite, setEdite] = useState(null) // le fait validé en cours de modification
  const [texte, setTexte] = useState('')
  const [part, setPart] = useState(false)
  const [erreur, setErreur] = useState('')
  const [relu, setRelu] = useState(0)
  const relis = () => setRelu((n) => n + 1) // après une écriture d'ici, sans attendre le message du serveur
  const fond = useRef(false)
  useEchap(onClose)
  useEtape(true, onClose) // téléphone : une étape d'historique, « retour » ferme le panneau (retour.js)

  useEffect(() => {
    let mort = false
    api('GET', '/api/memoire').then(
      (j) => {
        if (mort) return
        const ps = Array.isArray(j.projets) ? j.projets : []
        setListe(ps)
        if (j.bornes) setBornes({ ...BORNES, ...j.bornes })
        setChoisi((p) => p || (ps.find((x) => x.proposes > 0) || ps[0])?.projet || null)
      },
      (e) => !mort && setLecture(e.message),
    )
    return () => {
      mort = true
    }
  }, [])

  const tic = resume.find((r) => r.projet === choisi)?.tic
  useEffect(() => {
    if (!choisi) return
    let mort = false
    api('GET', url(choisi)).then(
      (j) => {
        if (mort) return
        setFaits(Array.isArray(j.faits) ? j.faits : [])
        setLecture('')
      },
      (e) => !mort && setLecture(e.message),
    )
    return () => {
      mort = true
    }
  }, [choisi, tic, relu])

  // Les projets : celui demandé en premier, puis les autres par nom ; les nombres suivent le serveur en direct.
  const projets = useMemo(() => {
    const m = new Map()
    for (const p of liste || []) m.set(p.projet, p)
    for (const p of resume) m.set(p.projet, { ...m.get(p.projet), ...p })
    if (demande && !m.has(demande)) m.set(demande, { projet: demande, valides: 0, proposes: 0 })
    const tous = [...m.values()].sort((a, b) => a.projet.localeCompare(b.projet))
    return demande ? [m.get(demande), ...tous.filter((p) => p.projet !== demande)] : tous
  }, [liste, resume, demande])

  const choisit = (p) => {
    if (p === choisi) return
    setChoisi(p)
    setFaits(null)
    setEdite(null)
    setErreur('')
    setLecture('')
  }
  const valides = (faits || []).filter((f) => f.etat === 'valide')
  const proposes = (faits || []).filter((f) => f.etat === 'propose')
  const plein = valides.length >= bornes.valides

  const ajoute = async () => {
    const envoye = texte
    if (part || !nettoie(envoye) || !choisi) return
    setPart(true)
    setErreur('')
    try {
      await api('POST', url(choisi), { texte: envoye })
      setTexte((t) => (t === envoye ? '' : t)) // ce qui a été tapé pendant l'envoi reste
      relis()
    } catch (e) {
      setErreur(e.message)
    }
    setPart(false)
  }

  return createPortal(
    // Le fond ferme au CLIC, et seulement pour un toucher commencé sur lui (une sélection de texte glissée hors du
    // panneau ne le ferme pas).
    <div
      className="mp-fond"
      onPointerDown={(e) => (fond.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (fond.current && e.target === e.currentTarget) onClose()
        fond.current = false
      }}
    >
      <section className="mp" role="dialog" aria-modal="true" aria-label="Mémoire du projet">
        <header className="mp-tete">
          <b>Mémoire du projet</b>
          <button type="button" className="mp-x" aria-label="Fermer la mémoire" onClick={onClose}>
            ×
          </button>
        </header>
        {projets.length > 0 && (
          <nav className="mp-projets" aria-label="Projet">
            {projets.map((p) => (
              <button
                key={p.projet}
                type="button"
                aria-pressed={p.projet === choisi}
                title={`${p.valides ?? 0} fait${(p.valides ?? 0) > 1 ? 's' : ''} validé${(p.valides ?? 0) > 1 ? 's' : ''}${p.proposes ? ` · ${p.proposes} à valider` : ''}`}
                onClick={() => choisit(p.projet)}
              >
                <span>{p.projet}</span>
                {p.proposes > 0 && (
                  <i className="mp-n" aria-label={`${p.proposes} à valider`}>
                    {p.proposes}
                  </i>
                )}
              </button>
            ))}
          </nav>
        )}
        <div className="mp-corps">
          {lecture && (
            <p className="mp-erreur" role="alert">
              {lecture}
            </p>
          )}
          {!choisi && liste && !liste.length && <p className="mp-vide">Aucun projet pour l’instant : la mémoire suit les dossiers de tes consoles.</p>}
          {choisi && <p className="mp-aide">Donnés à chaque nouvelle console Claude ou Codex de « {choisi} », à son lancement. Jamais écrits dans ses fichiers.</p>}
          {choisi && faits === null && !lecture && <p className="mp-vide">Lecture…</p>}
          {proposes.length > 0 && (
            <section className="mp-bloc mp-a-valider" aria-label="Propositions des agents">
              <h3>
                <span>Proposés par les agents</span>
                <span className="mp-compte">
                  {proposes.length} / {bornes.proposes}
                </span>
              </h3>
              <ul>
                {proposes.map((f) => (
                  <Proposition key={f.id} f={f} projet={choisi} now={now} bornes={bornes} relis={relis} />
                ))}
              </ul>
            </section>
          )}
          {faits && (
            <section className="mp-bloc" aria-label="Faits validés">
              <h3>
                <span>Faits validés</span>
                <span className="mp-compte">
                  {valides.length} / {bornes.valides}
                </span>
              </h3>
              {valides.length ? (
                <ul>
                  {valides.map((f) => (
                    <Fait key={f.id} f={f} projet={choisi} edite={edite === f.id} ouvre={setEdite} ferme={() => setEdite(null)} bornes={bornes} relis={relis} />
                  ))}
                </ul>
              ) : (
                <p className="mp-vide">Aucun fait validé pour l’instant.</p>
              )}
            </section>
          )}
        </div>
        {choisi && (
          <form
            className="mp-ajout"
            onSubmit={(e) => {
              e.preventDefault()
              ajoute()
            }}
          >
            <textarea
              className="mp-champ"
              rows={2}
              value={texte}
              autoFocus={!matchMedia('(pointer: coarse)').matches}
              disabled={plein}
              placeholder={plein ? `${bornes.valides} faits au plus : supprimes-en un pour en ajouter un autre.` : 'Un fait court et durable (jamais un secret)'}
              aria-label={`Nouveau fait pour ${choisi}`}
              enterKeyHint="done"
              onChange={(e) => setTexte(e.target.value)}
              onKeyDown={surEntree(ajoute)}
            />
            {/* Le bouton ne prend pas le focus : le champ le garde, le clavier du téléphone reste ouvert (sans quoi la zone
                visible change sous le doigt entre l'appui et le clic) et on enchaîne un autre fait. */}
            <button type="submit" className="mp-ok" disabled={part || plein || !nettoie(texte)} onPointerDown={(e) => e.preventDefault()}>
              Ajouter
            </button>
            <Reste texte={texte} max={bornes.texte} />
            {erreur && (
              <p className="mp-erreur" role="alert">
                {erreur}
              </p>
            )}
          </form>
        )}
      </section>
    </div>,
    document.body,
  )
}

// Le bouton de l'en-tête de la colonne, à côté de « Ordre ». `n` : propositions en attente, tous projets confondus, en
// signal discret (pastille d'encre claire, jamais le jaune, aucune animation). `court` : l'icône et le nombre seuls,
// le nom au survol et pour les lecteurs d'écran (mesuré au banc : le mot ne tient pas dans l'en-tête, voir Rail.jsx). Le nombre est un <span> : `.marque b` (le nom
// « meydan ») prendrait un <b>.
export function BoutonMemoire({ actions, n = 0, court = false }) {
  if (!actions?.ouvreMemoire) return null
  const dit = n ? `${n} proposition${n > 1 ? 's' : ''} d’agent à valider` : 'faits validés de tes projets'
  return (
    <button type="button" className={cls('mp-ouvre', court && 'est-court')} onClick={() => actions.ouvreMemoire()} aria-label={`Mémoire du projet : ${dit}`} title={`Mémoire du projet : ${dit}`}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <rect x="3" y="1.75" width="10" height="12.5" rx="1.5" />
        <path d="M6 5.5h4M6 8h4M6 10.5h2.5" />
      </svg>
      {!court && <span>Mémoire</span>}
      {n > 0 && <span className="mp-ouvre-n">{n}</span>}
    </button>
  )
}
