import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BadgeSilence } from './Veille.jsx'
import { Age, Signe } from './Signe.jsx'
import { BoutonOrdre, Composer, MenuLigne } from './Rail.jsx'
import { useAppuiLong } from './appui.jsx'
import { Plateau } from './differe.js'
import { resumeBoucle } from './Boucle.jsx'
import { GrandMot } from './GrandMot.jsx'
import { projetDe, projetDeConsole } from './rangement.js'
import { api, appelAVoir, cls, equipeAttend, shortDir, since, statusOf, useNow, VERBE } from './lib.js'
import { useEtape } from './retour.js'

// Vue d'ensemble, pour un téléphone couché : le « meydan » vu de haut. Une tuile par console, avec ce qu'elle fait à
// l'instant ; les équipes regroupées dans leur cadre ; ce qui t'attend en aplat d'appel, en tête. Un toucher ouvre la
// console. (Orkun, 10/11 : « ameliorer aussi le visuel pour le mode paysage si on veut voir une vue d’ensemble des
// differents agents qui travaillent ensemble ».) Le plateau d'ordinateur n'est pas repris ici : ses terminaux réduits
// étaient illisibles sur un téléphone, et il n'avait ni touches ni barre d'envoi.

// Ce que chaque console fait, relu toutes les trois secondes tant que la vue est à l'écran.
function useApercus(actif) {
  const [apercus, setApercus] = useState({})
  useEffect(() => {
    if (!actif) return // le plateau montre les vrais terminaux : pas besoin d'aperçus
    let mort = false
    const lit = () => api('GET', '/api/apercus').then((j) => !mort && setApercus(j.apercus || {}), () => {})
    lit()
    const t = setInterval(lit, 3000)
    return () => {
      mort = true
      clearInterval(t)
    }
  }, [actif])
  return apercus
}

// Un extrait lisible d'un texte d'agent : sans les signes du Markdown.
const extrait = (t) => t.replace(/```[a-z]*|\*\*|`|^#+\s*|^\s*[-*•]\s+/gm, '').replace(/\s+/g, ' ').trim()

// La question d'une console qui attend : sa note, sinon celle que l'aperçu a lue sur son écran (question au démarrage).
const questionDe = (c, a) => (c.note && c.note !== 'Question au démarrage' ? c.note : a?.question) || c.note || "Une question t'attend"

function Tuile({ c, a, onPick, nom = c.name, role, actions, voisines }) {
  // Appui prolongé : le menu de la console (renommer, interrompre, relais, boucle, fermer), comme dans la liste.
  const ref = useRef(null)
  const [menu, setMenu] = useState(null)
  useAppuiLong(ref, setMenu, () => !!actions)
  const attend = c.status === 'needs'
  const travaille = c.status === 'working'
  // Le sujet de la session, sinon le dossier (un shell montre déjà le sien dans son invite ; une équipe a le sien en tête).
  const sujet = (typeof c.sujet === 'string' && c.sujet) || (c.team || c.kind === 'shell' ? '' : shortDir(c.cwd))
  // Le corps : la question si elle attend ; sinon ce qu'un équipier a déclaré ; sinon son dernier message ou son dernier
  // outil ; pour un shell, la fin de son écran.
  let corps = null
  if (attend) corps = <b className="vt-question">{questionDe(c, a)}</b>
  else if (a?.lignes) corps = <span className="vt-ecran">{a.lignes.join('\n')}</span>
  else if (c.etat && c.team) corps = <span className="vt-texte">{`${VERBE[c.etat.verbe] || c.etat.verbe}${c.etat.texte ? ` — ${c.etat.texte}` : ''}`}</span>
  else if (a?.dernier) corps = <span className={cls('vt-texte', `de-${a.dernier.r}`)}>{a.dernier.r === 'toi' ? `→ ${extrait(a.dernier.t)}` : extrait(a.dernier.t)}</span>
  else if (!(travaille && a?.direct?.verbe)) corps = <span className="vt-texte est-vide">{c.status === 'starting' ? 'Démarre…' : 'Pas encore de message.'}</span>
  return (
    <>
    <button ref={ref} type="button" className={cls('vt', `is-${c.status}`)} data-role={role} data-id={c.id} onClick={() => onPick(c.id)}>
      <span className="vt-haut">
        <Signe status={c.status} />
        <b>{nom}</b>
      </span>
      {sujet && <span className="vt-sujet">{sujet}</span>}
      {travaille && a?.direct?.verbe && (
        <span className="vt-direct">
          {a.direct.verbe}… {a.direct.duree}
        </span>
      )}
      {corps}
      <BadgeSilence c={c} />
      <span className="vt-pied">
        <span className="etat">{statusOf(c.status).label}</span>
        <Age since={c.since} />
        {c.boucle?.etat === 'active' && <em>↻ {resumeBoucle(c.boucle)}</em>}
        {c.attente?.length > 0 && <em>message en attente</em>}
        {attend && <i>Répondre ›</i>}
      </span>
    </button>
    {menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={onPick} voisines={voisines} />}
    </>
  )
}

// Le ton d'un lien entre le capitaine et un équipier : il dit ce qui passe entre eux à l'instant.
//   travail : l'équipier travaille (le flux va du capitaine vers lui) ; retour : il a quelque chose pour le capitaine
//   (bloqué, décision à prendre : le flux revient) ; appel : il attend Orkun ; fait : il a fini ; calme : rien ne passe.
const tonDe = (c) =>
  c.status === 'needs' ? 'appel' : c.status === 'working' ? 'travail' : ['blocked', 'needs-decision', 'failed'].includes(c.etat?.verbe) ? 'retour' : c.etat?.verbe === 'done' ? 'fait' : 'calme'

// Une équipe dans la vue d'ensemble : le capitaine à gauche, ses équipiers à droite, et un lien du capitaine à chacun
// (Orkun, 10/11 : « mettre un lien stylé qui connecte les agents qui travaillent ensemble […] comme le projet qu’on
// fork »). Les liens sont tracés d'après la place réelle des tuiles, et retracés quand elle change.
function Equipe({ team, membres, tuile }) {
  const corps = useRef(null)
  const [liens, setLiens] = useState(null)
  const chef = membres.find((c) => c.chief)
  const equipiers = membres.filter((c) => !c.chief)
  const cle = equipiers.map((c) => c.id).join()
  useLayoutEffect(() => {
    const el = corps.current
    if (!el || !window.ResizeObserver) return
    const mesure = () => {
      const o = el.getBoundingClientRect()
      const cap = el.querySelector('[data-role=chef]')?.getBoundingClientRect()
      if (!cap) return setLiens(null)
      const bouts = [...el.querySelectorAll('[data-role=membre]')].map((m) => {
        const r = m.getBoundingClientRect()
        return { id: m.dataset.id, x: Math.round(r.left - o.left), y: Math.round(r.top + r.height / 2 - o.top) }
      })
      setLiens({ x: Math.round(cap.right - o.left), y: Math.round(cap.top + cap.height / 2 - o.top), bouts })
    }
    mesure()
    const ro = new ResizeObserver(mesure)
    ro.observe(el)
    for (const t of el.querySelectorAll('.vt')) ro.observe(t)
    return () => ro.disconnect()
  }, [cle, !!chef])
  return (
    <section className={cls('ve-equipe', equipeAttend(team) && 'est-prete')}>
      <header>
        <i>{team.pret ? 'ÉQUIPE PRÊTE' : appelAVoir(team) ? 'ÉQUIPE · T’ATTEND' : 'ÉQUIPE'}</i>
        <b>{team.nom}</b>
        <span>
          {equipiers.length} équipier{equipiers.length > 1 ? 's' : ''}
        </span>
      </header>
      <div className={cls('ve-arbre', !equipiers.length && 'est-seul')} ref={corps}>
        {liens && equipiers.length > 0 && (
          <svg className="ve-liens" aria-hidden="true">
            {liens.bouts.map((b) => {
              const c = equipiers.find((x) => x.id === b.id)
              if (!c) return null
              const dx = Math.max(14, (b.x - liens.x) * 0.55)
              const d = `M ${liens.x} ${liens.y} C ${liens.x + dx} ${liens.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
              return (
                <g key={b.id} className={`ve-lien est-${tonDe(c)}`}>
                  <path className="ve-lien-fond" d={d} />
                  <path className="ve-lien-flux" d={d} />
                  <circle cx={b.x} cy={b.y} r="3" />
                </g>
              )
            })}
            <circle className="ve-port" cx={liens.x} cy={liens.y} r="3.5" />
          </svg>
        )}
        <div className="ve-chef">{chef && tuile(chef, 'Capitaine', 'chef')}</div>
        {equipiers.length > 0 && <div className="ve-membres">{equipiers.map((c) => tuile(c, c.name, 'membre'))}</div>}
      </div>
    </section>
  )
}

// Reel « 3 règles » proposé sur le téléphone couché (`?reel3=oui`, volet design-3-plans, 11/11) : la colonne porte les
// trois plans de la plus ancienne attente, comme l'accueil debout — le nom du projet en très grand au fond, la question
// sur une carte, « Répondre » (le seul jaune de la colonne) à cheval sur son bord. Personne n'attend : l'étiquette seule.
function Scene({ c, team, n, question, onPick }) {
  const now = useNow()
  const sur = n ? `${n > 1 ? `${n} t'attendent` : "t'attend"}${c ? ` · depuis ${since(c.since, now)}` : ''}` : 'personne ne t’attend'
  if (!c) return <p className="ve-sur">{sur}</p>
  return (
    <section className="ve-scene" aria-label="La plus ancienne attente">
      <p className="ve-sur">{sur}</p>
      <GrandMot texte={team ? projetDe(team.projet) : projetDeConsole(c)} min={34} max={72} lignes={2} className="ve-mot" />
      <button type="button" className="ve-carte" data-id={c.id} onClick={() => onPick(c.id)}>
        <span className="ve-qui">
          <Signe status="needs" />
          <b>{c.name}</b>
        </span>
        <span className="ve-q">{question}</span>
        <span className="ve-go">
          Répondre
          <i aria-hidden="true">›</i>
        </span>
      </button>
    </section>
  )
}

// `mode` : 'plateau' (le plateau de l'ordinateur : les dalles et leurs terminaux, qu'on parcourt au doigt ; Orkun, 10/11 :
// « la vue comme sur pc en paysage […] Je la trouve plus stylé »), 'mosaique' (tuiles par équipes et par urgence) ou
// 'colonnes' (t'attend, travaille, au repos). `bascule` : le sélecteur d'affichage, rendu dans la colonne de gauche.
export function Ensemble({ consoles, teams, waiting, online, onPick, onCreated, mode = 'mosaique', bascule, actions, look }) {
  const apercus = useApercus(mode !== 'plateau')
  const rien = useRef(() => {}).current
  const [nouveau, setNouveau] = useState(false)
  useEtape(nouveau, () => setNouveau(false)) // « retour » ferme la fenêtre Nouvelle console (retour.js)
  const n = waiting.length + teams.filter(equipeAttend).length
  const vivantes = consoles.filter((c) => c.status !== 'closed')
  const fermees = consoles.length - vivantes.length
  const tuile = (c, nom, role) => <Tuile key={c.id} c={c} a={apercus[c.id]} onPick={onPick} nom={nom} role={role} actions={actions} voisines={consoles} />
  const seules = vivantes.filter((c) => !teams.some((t) => t.id === c.team))
  const parUrgence = (a, b) => statusOf(a.status).rank - statusOf(b.status).rank || a.createdAt - b.createdAt
  const k = (...ss) => vivantes.filter((c) => ss.includes(c.status)).length
  const premiere = waiting[0]?.id
  const tete = waiting[0]
  // Trois règles (`reel3`) : la plus ancienne attente est sur la scène de la colonne ; elle quitte la grille des tuiles,
  // comme elle quitte la liste sur le téléphone debout (Orkun le 13/11 : « A6 retirer »). Membre d'une équipe, elle reste
  // dans le cadre de son équipe.
  const surScene = look?.reel3 === 'oui' ? tete?.id : null
  return (
    <div className="ve">
      <aside className="ve-rail">
        <header className="ve-marque">
          <i className="marque-signe" />
          <b>meydan</b>
          <span className={cls('ve-liaison', !online && 'is-coupee')} title={online ? 'VPS en ligne' : 'Liaison coupée'} />
          <BoutonOrdre actions={actions} court />
        </header>
        {look?.reel3 === 'oui' ? (
          <Scene c={tete} team={tete && teams.find((t) => t.id === tete.team)} n={n} question={tete && questionDe(tete, apercus[tete.id])} onPick={onPick} />
        ) : (
        <button type="button" className={cls('ve-appel', !n && 'is-vide')} disabled={!premiere} onClick={() => onPick(premiere)}>
          <b>{n}</b>
          <span>{n > 1 ? "T'ATTENDENT" : n ? "T'ATTEND" : 'NE T’ATTEND'}</span>
        </button>
        )}
        <p className="ve-compte">
          {[[k('fini'), k('fini') > 1 ? 'finies' : 'finie'], [k('working', 'running', 'starting'), 'au travail'], [k('ready', 'shell'), 'au repos'], [fermees, fermees > 1 ? 'fermées' : 'fermée']].filter(([v]) => v > 0).map(([v, t]) => (
            <span key={t}>
              <b>{v}</b> {t}
            </span>
          ))}
        </p>
        {bascule}
        <button type="button" className="ve-plus" onClick={() => setNouveau(true)}>
          + Nouvelle console
        </button>
      </aside>
      {mode === 'plateau' ? (
        <main className="ve-plateau mat">
          {/* Le plateau arrive à part (differe.js) : en l'attendant, le fond du plateau, vide. */}
          {/* Les consoles fermées n'y sont plus posées (16/11, onglet « Historique » de la liste). */}
          <Plateau consoles={vivantes} activeId={null} setActiveId={rien} actions={actions} look={look} onOuvre={onPick} />
        </main>
      ) : mode === 'colonnes' ? (
        <main className="ve-colonnes">
          {[
            ['T’attend', ['needs']],
            ['Travaille', ['working', 'running', 'starting']],
            ['Au repos', ['fini', 'ready', 'shell']],
          ].map(([titre, etats]) => {
            const dedans = vivantes.filter((c) => etats.includes(c.status)).sort((a, b) => a.since - b.since)
            return (
              <section key={titre} className={cls('ve-colonne', etats[0] === 'needs' && 'est-appel')}>
                <header>
                  {titre} <b>{dedans.length}</b>
                </header>
                <div>{dedans.map((c) => tuile(c, c.chief ? `Capitaine · ${teams.find((t) => t.id === c.team)?.nom ?? ''}` : c.name))}</div>
              </section>
            )
          })}
        </main>
      ) : (
        <main className="ve-plan">
          {seules.filter((c) => c.status === 'needs' && c.id !== surScene).sort((a, b) => a.since - b.since).map((c) => tuile(c))}
          {teams.map((team) => {
            const membres = vivantes.filter((c) => c.team === team.id).sort((a, b) => Number(!!b.chief) - Number(!!a.chief) || a.createdAt - b.createdAt)
            if (!membres.length) return null
            return <Equipe key={team.id} team={team} membres={membres} tuile={tuile} />
          })}
          {seules.filter((c) => c.status !== 'needs').sort(parUrgence).map((c) => tuile(c))}
          {vivantes.length === 0 && <p className="ve-vide">Aucune console ouverte. « + Nouvelle console » pour en lancer une.</p>}
        </main>
      )}
      {nouveau &&
        createPortal(
          <div className="boucle-fond" onClick={(e) => e.target === e.currentTarget && setNouveau(false)}>
            <section className="boucle ve-nouveau" role="dialog" aria-label="Nouvelle console">
              <header>
                <b>Nouvelle console</b>
                <span />
                <button type="button" className="boucle-x" aria-label="Fermer" onClick={() => setNouveau(false)}>
                  ×
                </button>
              </header>
              <Composer
                rev
                onCreated={(made) => {
                  setNouveau(false)
                  onCreated(made)
                }}
              />
            </section>
          </div>,
          document.body,
        )}
    </div>
  )
}
