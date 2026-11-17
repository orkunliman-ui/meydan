import { useEffect, useRef, useState } from 'react'
import { depose, TAILLE_MAX, TAILLE_MIN } from './terminal.js'
import { prechargeTerm, Term } from './differe.js'
import { Envoi } from './Envoi.jsx'
import { Fil } from './Fil.jsx'
import { Age, Signe, Stamp } from './Signe.jsx'
import { statusOf, useEchap, useMedia, useSizeOf } from './lib.js'
import { BoutonPlus, MenuLigne } from './Rail.jsx'
import { CompteBadge, QuotaRelais } from './Comptes.jsx'
import { RepereCopie } from './Copies.jsx'
// Volet quota (17/11) : la pastille d'usage (en-tête ; debout, bandeau d'état), le bandeau « Budget atteint — continuer ? ».
import { BandeauBudget, UsageConsole } from './Budget.jsx'

// Touches absentes du clavier de l'iPhone, indispensables dans un agent en terminal.
const KEYS = [
  ['Échap', '\x1b'],
  ['Tab', '\t'],
  ['⇧Tab', '\x1b[Z'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['Ctrl C', '\x03'],
  ['Entrée', '\r'],
]
// « Réverbère » : deux rangées de cinq, les flèches en T renversé, puis Coller et Entrée au bout.
const KEYS_REV = ['Échap', '↑', 'Tab', '⇧Tab', 'Ctrl C', '←', '↓', '→', 'Entrée'].map((l) => KEYS.find(([k]) => k === l))

// `autres` : toutes les consoles ; le titre devient alors un bouton qui déroule leur liste (téléphone, depuis le 11/11).
// `onBack` absent (deux volets : la liste est à côté) : pas de retour.
export function MobileConsole({ console: c, online = true, actions, onBack, look, waiting = [], onOpen, onRevive, autres }) {
  const [menu, setMenu] = useState(null) // le menu d'actions de la console, ouvert par le « ⋯ » de l'en-tête
  const [boite, setBoite] = useState(null) // l'élément qui porte le terminal, quand il est affiché
  const termApi = useRef(null)
  const size = useSizeOf(boite)
  const rev = look.theme === 'reverbere'
  // Reel « 3 règles » (11/11), téléphone debout : l'état et la question passent dans un bandeau au-dessus du terminal
  // (posé en carte, les touches sur un plateau devant) ; la plaque jaune n'est plus posée sur le terminal. Pas de nom
  // géant ici : sur le terminal il se lisait comme un défaut d'affichage (retenu le 11/11). Couché : console du lot 6.
  const couche = useMedia('(orientation: landscape) and (max-height: 520px)')
  const reel = rev && look.reel === 'oui' && !couche
  const attend = c.status === 'needs'
  // La plaque se replie au premier toucher du terminal, et revient à la question suivante.
  const tag = `${c.id}:${c.since}`
  const [plie, setPlie] = useState(null)
  // Taille du texte du terminal : réglée au pincement à deux doigts, retenue sur l'appareil, montrée un instant.
  const [taille, setTaille] = useState(() => {
    const n = Number(localStorage.getItem('meydan.taille'))
    return n >= TAILLE_MIN && n <= TAILLE_MAX ? n : 12
  })
  const [tailleVue, setTailleVue] = useState(false)
  const tailleFin = useRef(0)
  const pince = (n) => {
    setTaille(n)
    try {
      localStorage.setItem('meydan.taille', String(n))
    } catch {} // navigation privée : la taille vaut pour cette visite
    setColle('') // la pastille montre la dernière action : la taille remplace l'annonce d'un collage
    setTailleVue(true)
    clearTimeout(tailleFin.current)
    tailleFin.current = setTimeout(() => setTailleVue(false), 900)
  }
  // Vue « discussion » : la conversation de l'agent comme dans une messagerie, à la place du terminal. Possible quand
  // Meydan connaît la conversation (agent Claude ou Codex dont un hook est déjà passé). C'est l'affichage par défaut du
  // téléphone (Orkun, 10/11 : « Quand jss en portrait dans un terminal, j'aimerais un affichage equivalent a ce que j'ai
  // la sur l'app native de claude ») ; le terminal reste à un appui, et ce choix est retenu sur l'appareil.
  // Même sans conversation connue (console neuve, rien d'envoyé) : la discussion s'ouvre, vide, avec son champ.
  const filPossible = (c.kind === 'claude' || c.kind === 'codex') && c.status !== 'closed'
  const [vue, setVue] = useState(() => (localStorage.getItem('meydan.vue') === 'terminal' ? 'terminal' : 'fil'))
  // « Répondre dans le terminal » (carte d'une question) et « Voir le terminal » (discussion vide) montrent le terminal de
  // CETTE console, le temps d'y répondre : la préférence n'est pas touchée. Seul le bouton du haut la change. (Orkun,
  // 10/11 : une réponse donnée dans le terminal faisait ensuite ouvrir toutes ses consoles en terminal.)
  const [tempo, setTempo] = useState(null)
  const enFil = filPossible && vue === 'fil' && tempo !== c.id
  const bascule = (v) => {
    setTempo(null)
    setVue(v)
    try {
      localStorage.setItem('meydan.vue', v)
    } catch {} // navigation privée : le choix vaut pour cette visite
  }
  // Le terminal est à un toucher de la discussion : son code (xterm) part une seconde après l'ouverture d'une console,
  // pour que le passage au terminal soit immédiat. Rien ne part tant qu'aucune console n'est ouverte (la liste).
  useEffect(() => void setTimeout(prechargeTerm, 1000), [])
  // La liste des consoles sous le titre : `null` repliée, sinon le haut où elle se pose (le bas de la barre, mesuré au
  // toucher : sa hauteur dépend de la vue et de l'orientation). Elle se replie en changeant de console, de vue ou
  // d'orientation, qui changent cette hauteur.
  const [deroule, setDeroule] = useState(null)
  useEffect(() => setDeroule(null), [c.id, enFil, couche])
  const [ecrit, setEcrit] = useState(false) // le champ de la barre d'envoi a le clavier : les rangées de touches laissent la place
  // Ce qui vient d'être envoyé d'ici : la discussion le montre aussitôt, en attendant que l'agent l'écrive dans son journal.
  const [envoyes, setEnvoyes] = useState([])
  useEffect(() => {
    setEnvoyes([])
    setTempo(null) // autre console : on revient à l'affichage préféré
  }, [c.id])
  const envoi = c.status !== 'closed' && <Envoi key={c.id} brouillon console={c} forme={enFil ? 'fil' : 'terminal'} onCompose={setEcrit} onEnvoye={(texte, pieces) => (texte || pieces.length > 0) && setEnvoyes((l) => [...l.slice(-4), { t: texte, at: Date.now(), pieces }])} />
  const sujet = typeof c.sujet === 'string' ? c.sujet : '' // le sujet que l'agent a donné à sa session, quand il en a un
  const plaque = rev && attend && plie !== tag && !reel
  const question = c.note || "Une question t'attend"
  const n = waiting.length
  const i = waiting.findIndex((w) => w.id === c.id)

  // Coller le presse-papiers du téléphone dans le terminal, SANS valider (Orkun, 10/11 : « je dois pouvoir faire un
  // collage via l'iPhone sur shell »). Safari montre alors sa petite bulle « Coller » : c'est sa demande d'accord.
  // Lecture sur le clic, pas sur l'appui : au doigt, le navigateur n'accorde le presse-papiers qu'au relâchement.
  const [refus, setRefus] = useState(false)
  const [colle, setColle] = useState('') // ce que le dernier collage a déposé (sa longueur), montré un instant sur le terminal
  const colleFin = useRef(0)
  const annonce = (dit) => {
    setTailleVue(false)
    setColle(dit)
    clearTimeout(colleFin.current)
    colleFin.current = setTimeout(() => setColle(''), 2600)
  }
  const coller = async () => {
    // Pas de terminal (pas encore ouvert) : rien n'est lu ni annoncé (chasse du 17/11 : « Collé : 17 caractères » sur une
    // console où rien ne pouvait arriver).
    if (!termApi.current) return annonce('Terminal pas encore prêt : rien collé')
    try {
      const texte = await navigator.clipboard.readText()
      annonce(depose((t) => termApi.current?.paste(t), texte))
      setRefus(false)
      if (attend) setPlie(tag)
    } catch {
      setRefus(true) // presse-papiers refusé ou indisponible : le champ du dessus accepte le collage du système
      setTimeout(() => setRefus(false), 7000)
    }
  }
  const toucheColler = (
    <button key="Coller" type="button" onPointerDown={(e) => e.preventDefault()} onClick={coller}>
      Coller
    </button>
  )

  const key = ([label, seq], extra) => (
    <button
      key={label}
      type="button"
      className={extra}
      onPointerDown={(e) => {
        e.preventDefault() // ne pas retirer le focus du terminal (le clavier resterait fermé)
        termApi.current?.send(seq)
        if (attend) setPlie(tag) // répondre par une touche replie la plaque, comme toucher le terminal
      }}
    >
      {label}
    </button>
  )
  const term =
    c.status === 'closed' ? (
      <div className="slab-gone">
        <p>Session terminée.</p>
        <button type="button" className="relance" onClick={() => onRevive?.(c.id)}>
          Relancer
        </button>
        <small>{c.kind === 'shell' ? 'Rouvre un shell dans le même dossier.' : 'Rouvre l’agent dans le même dossier, sur sa conversation.'}</small>
      </div>
    ) : (
      // xterm n'arrive qu'ici, au premier terminal affiché (differe.js) : en l'attendant, la zone du terminal, vide.
      size && size.w > 0 && <Term id={c.id} width={size.w} height={size.h} base={taille} onTaille={pince} onColle={annonce} active apiRef={termApi} look={rev ? `reverbere-${look.appel}` : 'tapis'} />
    )

  const pastille = (colle || tailleVue) && <span className="taille-vue">{colle || `${taille} px`}</span>
  // Volet copies : « copie · <branche> » (et l'état de l'installation), une ligne fixe sous la barre ; dans le design
  // « 3 plans », dans le bandeau d'état. Rien pour une console hors copie. Le téléphone est l'appareil principal d'Orkun.
  const copie = c.copie?.branche && (
    <p className="sheet-copie">
      <RepereCopie c={c} ligne />
    </p>
  )

  if (!rev)
    return (
      <section className={`sheet is-${c.status}${ecrit ? ' ecrit' : ''}`}>
        <header className="sheet-bar">
          <button type="button" className="sheet-back" onClick={onBack}>
            ‹ Agents
          </button>
          <b>{c.name}</b>
          <CompteBadge c={c} />
          <UsageConsole c={c} ou="tel" />
          <Stamp status={c.status} since={c.since} />
          {actions && <BoutonPlus nom={c.name} onOpen={setMenu} className="sheet-plus" />}
      </header>
      {menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={onOpen} voisines={autres || []} />}
        {copie}
        {/* « Plusieurs comptes Claude / Codex » : limite d'usage atteinte → relancer sur l'autre compte (rien sans `c.quota`). */}
        <QuotaRelais c={c} actions={actions} onPick={onOpen} />
        <BandeauBudget c={c} />
        <div className="sheet-term" ref={setBoite}>
          {term}
          {pastille}
        </div>
        {envoi}
        {c.status !== 'closed' && (
          <nav className="keys" aria-label="Touches spéciales">
            {KEYS.slice(0, -1).map((k) => key(k))}
            {toucheColler}
            {key(KEYS.at(-1))}
          </nav>
        )}
      </section>
    )

  const titre = enFil ? (
    <span className="sheet-titre">
      <b>{c.name}</b>
      <small>
        {/* Avec un sujet, l'agent n'est plus répété (le nom le dit déjà) : la place va au sujet. */}
        {online ? `${sujet ? '' : `${c.kind === 'codex' ? 'Codex' : 'Claude'} · `}${statusOf(c.status).label.toLowerCase()}` : 'liaison coupée…'}
        {sujet && <em> · {sujet}</em>}
      </small>
    </span>
  ) : sujet ? (
    <span className="sheet-titre">
      <b>{c.name}</b>
      <small>
        <em>{sujet}</em>
      </small>
    </span>
  ) : (
    <b>{c.name}</b>
  )

  return (
    <section className={`sheet is-${c.status}${ecrit ? ' ecrit' : ''}${enFil ? ' en-fil' : ''}${reel ? ' reel' : ''}`}>
      <header className="sheet-bar">
        {onBack && (
          <button type="button" className="sheet-back" aria-label="Retour à la liste de Meydan" onClick={onBack}>
            <i aria-hidden="true">‹</i>
            Meydan
          </button>
        )}
        {autres ? (
          // Le titre se touche (le chevron le dit) et garde tout ce qu'il montrait : le nom, et dessous l'agent · l'état ou le sujet.
          <button
            type="button"
            className="sheet-nom"
            aria-expanded={deroule !== null}
            onClick={(e) => {
              const barre = e.currentTarget.parentElement
              const haut = barre.getBoundingClientRect().bottom - barre.parentElement.getBoundingClientRect().top
              setDeroule((d) => (d === null ? haut : null))
            }}
          >
            {titre}
            <i aria-hidden="true">▾</i>
          </button>
        ) : (
          titre
        )}
        {/* « Plusieurs comptes Claude / Codex » : « C2 » après le nom d'une console du compte 2 (rien pour le 1). */}
        <CompteBadge c={c} />
        {/* Debout (reel), l'en-tête n'a pas la place : la pastille va dans le bandeau d'état, sous lui. */}
        {!reel && <UsageConsole c={c} ou="tel" />}
        {!enFil && <Signe status={c.status} />}
        {!enFil && <span className="etat">{online ? statusOf(c.status).label : 'liaison coupée…'}</span>}
        {!filPossible && <Age since={c.since} />}
        {filPossible && (
          <button type="button" className="sheet-vue" aria-label={enFil ? 'Voir le terminal' : 'Voir la discussion'} onClick={() => (tempo === c.id ? setTempo(null) : bascule(enFil ? 'terminal' : 'fil'))}>
            {enFil ? '>_' : 'Chat'}
          </button>
        )}
        {actions && <BoutonPlus nom={c.name} onOpen={setMenu} className="sheet-plus" />}
      </header>
      {menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={onOpen} voisines={autres || []} />}
      {!reel && copie}
      {reel && (
        <div className={`bande${attend ? ' attend' : ''}`}>
          <p className="bande-sur">
            <Signe status={c.status} />
            <span>{online ? statusOf(c.status).label : 'liaison coupée…'}</span>
            <Age since={c.since} />
            <UsageConsole c={c} ou="bande" />
          </p>
          {copie}
          {attend && <p className="bande-q">{question}</p>}
        </div>
      )}
      {autres && deroule !== null && <Passe consoles={autres} waiting={waiting} ici={c.id} haut={deroule} onPick={onOpen} onClose={() => setDeroule(null)} />}
      {c.boucle?.etat === 'active' && (
        <button type="button" className="boucle-puce" onClick={() => actions?.ouvreBoucle(c.id)}>
          <i aria-hidden="true">↻</i>
          Boucle, tour {c.boucle.n} sur {c.boucle.tours}
          {c.boucle.attend && <span> · {c.boucle.attend}</span>}
          <em>Voir ›</em>
        </button>
      )}
      {/* « Plusieurs comptes Claude / Codex » : limite d'usage atteinte → relancer sur l'autre compte. Debout : sous la
          barre et le bandeau d'état ; couché : posé sur le haut du terminal (comptes.css). Rien sans `c.quota`. */}
      <QuotaRelais c={c} actions={actions} onPick={onOpen} />
      <BandeauBudget c={c} />
      {enFil ? (
        <Fil console={c} envoyes={envoyes} onTerminal={() => setTempo(c.id)} />
      ) : (
        <div className="sheet-zone" onPointerDown={() => attend && setPlie(tag)}>
          <div className="sheet-term" ref={setBoite}>
            {term}
            {pastille}
          </div>
          {plaque && (
            <div className="plaque">
              <b>{question}</b>
            </div>
          )}
        </div>
      )}
      {envoi}
      {/* Console terminée : ni touches ni « n t'attendent » (chasse du 17/11 : neuf touches mortes et un faux « Collé » sous
          « Session terminée. Relancer ») ; règle du projet, pas de bouton mort au téléphone. */}
      {!enFil && c.status !== 'closed' && (
        <>
        <div className="suite">
          {refus ? <span className="suite-q">Collage refusé par le navigateur : colle dans le champ au-dessus.</span> : attend && !plaque ? <span className="suite-q">{question}</span> : <span />}
          {attend && n > 1 ? (
            <button type="button" onClick={() => onOpen(waiting[(i + 1) % n].id)}>
              {i + 1} sur {n} · suivante ›
            </button>
          ) : !attend && n > 0 ? (
            <button type="button" onClick={() => onOpen(waiting[0].id)}>
              {n} {n > 1 ? "t'attendent" : "t'attend"} · voir ›
            </button>
          ) : (
            <i>{attend ? "seule à t'attendre" : 'personne ne t’attend'}</i>
          )}
        </div>
        <nav className="keys" aria-label="Touches spéciales">
          {KEYS_REV.slice(0, -1).map((k) => key(k))}
          {toucheColler}
          {key(KEYS_REV.at(-1), attend ? 'allume' : undefined)}
        </nav>
        </>
      )}
    </section>
  )
}

// Passer d'une console à l'autre par le titre : celles qui t'attendent d'abord (la plus ancienne en tête, comme le
// compteur), puis celles qui ont FINI, puis les autres dans l'ordre de toujours. La console ouverte est marquée. Un
// toucher en ouvre une autre (`ouvrir` remplace l'étape de l'historique : « retour » ramène toujours à Meydan).
// Le fond ferme la liste au CLIC, et seulement pour un toucher commencé sur lui (leçon du menu d'appui prolongé, 10/11 :
// fermé à l'appui, le clic tombait sur ce qu'il recouvrait) ; Échap la ferme aussi.
function Passe({ consoles, waiting, ici, haut, onPick, onClose }) {
  useEchap(onClose)
  const pose = useRef(false)
  const reste = consoles.filter((x) => x.status !== 'needs')
  const liste = [...waiting, ...reste.filter((x) => x.status === 'fini'), ...reste.filter((x) => x.status !== 'fini')]
  return (
    <div
      className="passe"
      style={{ top: haut }}
      onPointerDown={(e) => (pose.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (pose.current && e.target === e.currentTarget) onClose()
        pose.current = false
      }}
    >
      <ul aria-label="Consoles">
        {liste.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              data-id={x.id}
              className={x.id === ici ? `is-${x.status} est-ici` : `is-${x.status}`}
              aria-current={x.id === ici || undefined}
              onClick={() => {
                onClose()
                if (x.id !== ici) onPick(x.id)
              }}
            >
              <Signe status={x.status} />
              <b>{x.name}</b>
              <span className="etat">{statusOf(x.status).label}</span>
              <Age since={x.since} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
