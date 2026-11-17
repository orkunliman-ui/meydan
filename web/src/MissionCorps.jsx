// Carte de mission, les cartes (Mission.jsx porte la coquille ; ce fichier arrive à la demande, differe.js). Décision
// d'Orkun du 17/11, raccourcis-4 : « Vue carte de mission ».
//
// Une colonne par groupe de la carte de mission de la liste (Rail.jsx, `GROUPES` : T'attend, Fini, Travaille, Au repos,
// En erreur — mêmes états, mêmes mots, recopiés ici pour ne pas toucher à Rail.jsx, que d'autres volets modifient), dans
// l'ordre d'urgence de la liste : ce qui t'attend, puis l'erreur, puis ce qui est fini, puis ce qui travaille, puis le
// repos. « T'attend » est toujours là (vide, elle le dit) ; les autres seulement si elles ont quelque chose.
// Dans « T'attend », le plus ancien en tête (questions et équipes prêtes mêlées, comme la liste) ; ailleurs, les équipes
// d'abord, puis les consoles par état et par ancienneté. Une équipe est UNE carte (sa mission, son capitaine et ses
// équipiers avec leurs états), posée dans la colonne de ce qu'elle a de plus urgent.
// Le jaune ne dit que « à toi de toucher » (le repère de ce qui t'attend, « Répondre », « Voir le capitaine ») ; les
// états à l'encre et au papier, sauf ERREUR (rouge) et FINI (vert) : mission.css.
// Ce que montre une carte vient de ce que le serveur diffuse déjà (aucune route nouvelle) : nom, projet, type d'agent,
// modèle quand il a été choisi (`modele` : à la création, ou par le rôle d'un équipier), état et depuis quand (`since`,
// le seul repère de temps diffusé), sujet de la session, statut déclaré d'un équipier, boucle, message en attente,
// question posée (`note`), alerte de silence, limite d'usage.
import { useEffect, useRef, useState } from 'react'
import { cls, KIND_TAG, pretAVoir, since, statusOf, useNow, VERBE } from './lib.js'
import { Signe } from './Signe.jsx'
import { BadgeSilence } from './Veille.jsx'
import { resumeBoucle } from './Boucle.jsx'
import { projetDe, projetDeConsole } from './rangement.js'

const COLONNES = [
  { id: 'attend', nom: 'T’attend', etats: ['needs'] },
  { id: 'erreur', nom: 'En erreur', etats: ['error'] },
  { id: 'fini', nom: 'Fini', etats: ['fini'] },
  { id: 'travaille', nom: 'Travaille', etats: ['working', 'running', 'starting'] },
  { id: 'repos', nom: 'Au repos', etats: ['ready', 'shell'] },
]
const colonneDe = (status) => COLONNES.find((k) => k.etats.includes(status))?.id ?? 'repos'
const rangCol = (id) => COLONNES.findIndex((k) => k.id === id)

// Le modèle, quand on le sait (posé à la création ou par le rôle) : « Opus 5.5 » plutôt que l'identifiant.
const MODELES = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-2': 'Fable 5.2' }
const modeleDe = (c) => (typeof c.modele === 'string' && c.modele ? MODELES[c.modele] || c.modele : '')
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']) // ceux du serveur : un shell à son invite ne « fait » rien
const declare = (etat) => (etat ? `${VERBE[etat.verbe] || etat.verbe}${etat.texte ? ` — ${etat.texte}` : ''}` : '')

// Ce que fait une console, en une ligne : la boucle qui tourne, le message qui attend d'être remis, puis le sujet de la
// session (statut déclaré pour un équipier ; commande en cours pour un shell).
function fait(c) {
  const morceaux = []
  if (c.boucle?.etat === 'active') morceaux.push(`↻ ${resumeBoucle(c.boucle)}`)
  if (c.attente?.length) morceaux.push('message en attente')
  if (c.team) morceaux.push(declare(c.etat) || 'pas encore de statut')
  else if (typeof c.sujet === 'string' && c.sujet) morceaux.push(c.sujet)
  else if (c.kind === 'shell' && c.cmd && !SHELLS.has(c.cmd)) morceaux.push(`lance ${c.cmd}`)
  return morceaux.filter(Boolean).join(' · ')
}

// Ce qui t'attend, tel que le hook l'a noté (server.mjs, hookNote) : une question posée, telle quelle ; une permission,
// « <outil> · <commande ou fichier> » : la commande en police de terminal (lue au caractère près : « -- », chemins).
function Question({ texte }) {
  const m = /^(\S+) · ([\s\S]+)$/.exec(texte)
  if (!m || /\?\s*$/.test(texte)) return texte // une question (« Claude · Quant ou Codex · Quant ? ») reste du texte
  return (
    <>
      {m[1]} · <code>{m[2]}</code>
    </>
  )
}

// Les alertes d'une console : silence (Veille.jsx, le même badge que la liste) et limite d'usage atteinte.
function Alertes({ c }) {
  const silence = ['suspecte', 'muette', 'reportee'].includes(c.silence?.etat)
  if (!silence && !c.quota) return null
  return (
    <span className="mi-alertes">
      {silence && <BadgeSilence c={c} />}
      {c.quota && <span className="mi-quota">Limite d’usage{c.quota.texte ? ` : ${c.quota.texte}` : ''}</span>}
    </span>
  )
}

function Carte({ c, now, onPick }) {
  const attend = c.status === 'needs'
  const quoi = fait(c)
  return (
    <button type="button" className={cls('mi-carte', `is-${c.status}`)} data-id={c.id} onClick={() => onPick(c.id)}>
      <span className="mi-l1">
        <Signe status={c.status} />
        <b className="mi-nom">{c.name}</b>
        <span className="mi-age">{since(c.since, now)}</span>
      </span>
      <span className="mi-l2">
        <span className="mi-ou">
          {projetDeConsole(c)} · {KIND_TAG[c.kind] || c.kind}
          {modeleDe(c) && ` · ${modeleDe(c)}`}
        </span>
        {!attend && <em className="mi-etat">{statusOf(c.status).label}</em>}
      </span>
      {c.status === 'error' && c.note && <span className="mi-q">{c.note}</span>}
      {quoi && <span className="mi-fait">{quoi}</span>}
      <Alertes c={c} />
      {/* La question et « Répondre » sur la même rangée : une question courte ne prend qu'une ligne de la colonne. */}
      {attend && (
        <span className="mi-repondre">
          <span className="mi-q">{c.note ? <Question texte={c.note} /> : 'Une question t’attend'}</span>
          <span className="mi-go">
            Répondre<i aria-hidden="true">›</i>
          </span>
        </span>
      )}
    </button>
  )
}

// Une équipe : son en-tête (mission, projet, équipiers ; prête à livrer, ce que le capitaine en dit) mène au capitaine,
// ou à l'équipier qui pose une question ; chaque équipier est une ligne qui mène à sa console.
function CarteEquipe({ team, membres, now, onPick }) {
  const prete = pretAVoir(team)
  const demande = membres.find((c) => c.status === 'needs')
  const vers = demande || membres.find((c) => c.chief) || membres[0]
  const crew = membres.filter((c) => !c.chief).length
  const tete = (
    <>
      <span className="mi-l1">
        <i className="mi-tag">{prete ? 'Équipe prête' : 'Équipe'}</i>
        <b className="mi-nom">{team.nom}</b>
        {prete && <span className="mi-age">{since(team.pret.at, now)}</span>}
      </span>
      {team.mission && team.mission !== team.nom && <span className="mi-fait">{team.mission}</span>}
      <span className="mi-l2">
        <span className="mi-ou">
          {projetDe(team.projet)} · {crew} équipier{crew > 1 ? 's' : ''}
          {team.git && team.branche ? ` · ${team.branche}` : ''}
        </span>
      </span>
      {(prete || demande) && (
        <span className="mi-repondre">
          {prete && <span className="mi-q">{team.pret.texte || 'Le capitaine a déclaré le travail prêt.'}</span>}
          {/* Le bouton seulement s'il mène à une console : une équipe prête dont tout l'équipage est fermé n'a que son texte. */}
          {vers && (
            <span className="mi-go">
              {demande ? 'Répondre' : 'Voir le capitaine'}
              <i aria-hidden="true">›</i>
            </span>
          )}
        </span>
      )}
    </>
  )
  return (
    <section className={cls('mi-equipe', (prete || demande) && 'is-attend')} aria-label={`Équipe ${team.nom}`}>
      {vers ? (
        <button type="button" className="mi-equipe-tete" data-id={vers.id} onClick={() => onPick(vers.id)}>
          {tete}
        </button>
      ) : (
        <div className="mi-equipe-tete">{tete}</div>
      )}
      {membres.length > 0 && (
        <ul className="mi-membres">
          {membres.map((c) => (
            <li key={c.id}>
              <button type="button" className={cls('mi-membre', `is-${c.status}`)} data-id={c.id} onClick={() => onPick(c.id)}>
                <Signe status={c.status} />
                <b>{c.chief ? 'Capitaine' : c.name}</b>
                <em className="mi-etat">{statusOf(c.status).label}</em>
                <span className="mi-age">{since(c.since, now)}</span>
                <small>
                  {KIND_TAG[c.kind] || c.kind}
                  {modeleDe(c) && ` · ${modeleDe(c)}`} · {c.status === 'needs' && c.note ? c.note : fait(c)}
                </small>
                <Alertes c={c} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Une colonne. Trop de cartes pour sa hauteur : elle défile seule (jamais la page), et dit en bas ce qui reste caché,
// comme la liste (« + N plus bas », choisi par Orkun le 10/11).
function Colonne({ k, children }) {
  const ref = useRef(null)
  const [plus, setPlus] = useState(0)
  const mesure = useRef(null)
  mesure.current = () => {
    const el = ref.current
    if (!el) return
    const bas = el.getBoundingClientRect().bottom + 1
    const n = [...el.children].filter((li) => li.getBoundingClientRect().bottom > bas).length
    setPlus((p) => (p === n ? p : n))
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const m = () => mesure.current()
    el.addEventListener('scroll', m, { passive: true })
    const ro = new ResizeObserver(m)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', m)
      ro.disconnect()
    }
  }, [])
  useEffect(() => mesure.current()) // les cartes changent (un état, une question) : on recompte
  return (
    <section className={cls('mi-col', `mi-col-${k.id}`, k.items.length && 'est-plein')} aria-labelledby={`mi-col-${k.id}`}>
      <h2 id={`mi-col-${k.id}`}>
        {k.nom}
        <span className="mi-n">{k.items.length}</span>
      </h2>
      {!k.items.length && <p className="mi-vide">Rien ne t’attend. Une question posée, une équipe prête à livrer viennent ici, la plus ancienne en tête.</p>}
      {/* Toujours là (même vide) : la mesure de « + N plus bas » s'y accroche une fois pour toutes. */}
      <ul className="mi-liste" ref={ref}>
        {children}
      </ul>
      {plus > 0 && <p className="mi-suite">+ {plus} plus bas</p>}
    </section>
  )
}

// `consoles` : les consoles ouvertes (les fermées sont dans l'Historique de la liste ; l'en-tête en dit le nombre).
export function CorpsMission({ consoles, teams, onPick }) {
  const now = useNow()
  const ref = useRef(null)
  // Le clavier sur la première carte (la plus ancienne attente, s'il y en a) : Entrée y répond tout de suite.
  useEffect(() => {
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.querySelector('button')?.focus()
  }, [])
  // Les équipes d'abord : chacune prend ses membres ouverts ; une équipe dont tout l'équipage est fermé mais qui est prête
  // à livrer reste (comme dans la liste).
  const blocs = teams
    .map((team) => {
      const membres = consoles.filter((c) => c.team === team.id).sort((a, b) => Number(!!b.chief) - Number(!!a.chief) || a.createdAt - b.createdAt)
      const col = pretAVoir(team) ? 'attend' : COLONNES[Math.min(...membres.map((c) => rangCol(colonneDe(c.status))), rangCol('repos'))].id
      const t = Math.min(pretAVoir(team) ? team.pret.at : Infinity, ...membres.filter((c) => c.status === 'needs').map((c) => c.since))
      return { team, membres, col, t }
    })
    .filter((b) => b.membres.length || pretAVoir(b.team))
  const seules = consoles.filter((c) => !teams.some((t) => t.id === c.team))
  const colonnes = COLONNES.map((k) => {
    const equipes = blocs.filter((b) => b.col === k.id)
    const cartes = seules.filter((c) => colonneDe(c.status) === k.id)
    const items =
      k.id === 'attend'
        ? [...cartes.map((c) => ({ c, t: c.since })), ...equipes].sort((a, b) => a.t - b.t)
        : [...equipes.sort((a, b) => a.team.createdAt - b.team.createdAt), ...cartes.sort((a, b) => statusOf(a.status).rank - statusOf(b.status).rank || a.since - b.since).map((c) => ({ c }))]
    return { ...k, items }
  }).filter((k) => k.id === 'attend' || k.items.length)
  // « T'attend » un peu plus large : ses cartes portent la question.
  const gabarit = colonnes.map((k) => (k.id === 'attend' ? 'minmax(0, 1.45fr)' : 'minmax(0, 1fr)')).join(' ')
  return (
    <div className="mi-corps" ref={ref}>
      <div className="mi-colonnes" style={{ gridTemplateColumns: gabarit, maxWidth: `${colonnes.length * 440}px` }}>
        {colonnes.map((k) => (
          <Colonne key={k.id} k={k}>
            {k.items.map((it) => (
              <li key={it.team ? it.team.id : it.c.id}>{it.team ? <CarteEquipe team={it.team} membres={it.membres} now={now} onPick={onPick} /> : <Carte c={it.c} now={now} onPick={onPick} />}</li>
            ))}
          </Colonne>
        ))}
      </div>
    </div>
  )
}
