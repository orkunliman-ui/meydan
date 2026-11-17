import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { BadgeSilence, ReglageVerification, Veille } from './Veille.jsx'
import { Age, Signe } from './Signe.jsx'
import { MenuDoigt, useAppuiLong } from './appui.jsx'
import { resumeBoucle } from './Boucle.jsx'
import { Alertes, InviteAlertes } from './Alertes.jsx'
import { api, appelAVoir, cls, equipeAttend, LOOKS, pretAVoir, shortDir, since, statusOf, useMedia, useNow, VERBE } from './lib.js'
import { GrandMot } from './GrandMot.jsx'
import { projetDe, projetDeConsole } from './rangement.js'
import { BoutonMemoire } from './Memoire.jsx'
import { CompteBadge, Comptes, QuotaRelais } from './Comptes.jsx'
// Volet quota (17/11) : usage et budget d'une équipe, cartes « Budget atteint » / « Lancement à valider » en tête de ce qui
// t'attend (comptées dans T'ATTEND), case « Valider les lancements » à la création d'une équipe.
import { CaseValider, consoleDeDemande, DemandesBudget, UsageEquipe, useDemandes } from './Budget.jsx'
// Noms des comptes (décision d'Orkun du 17/11, comptes-3 : « Donner des noms ») : « Compte 1 » / « Compte 2 » d'office.
import { useNomsComptes } from './comptes-noms.js'
import { CaseCopie, ContinuerCopie, JournalInstallation, RepereCopie, useCopiable, usePrechargeCopies } from './Copies.jsx'
// Volet « raccourcis » (13/11) : touches seules (T, X), leur réglage, préréglages de groupe et plafond du lancement.
import { useBranche } from './raccourcis.js'
import { useEtape } from './retour.js'
import { BoutonRaccourcis } from './Raccourcis.jsx'
import { Groupes } from './Groupes.jsx'
import { MAX_CONSOLES } from './groupes.js'
// Ateliers (volet du 13/11) : la section « Ateliers » à la fin de la liste du téléphone (web/src/ateliers/AteliersListe.jsx).
import { AteliersListe } from './ateliers/AteliersListe.jsx'

function Summary({ consoles }) {
  const n = (s) => consoles.filter((c) => c.status === s).length
  const demandes = useDemandes() // volet quota : budget atteint, lancement à valider
  const needs = n('needs') + demandes.length, errors = n('error')
  const rest = [
    [n('working'), 'au travail'],
    [n('ready'), n('ready') > 1 ? 'prêts' : 'prêt'],
    [n('starting') + n('running'), 'en route'],
  ].filter(([k]) => k > 0)
  return (
    <div className={cls('summary', needs > 0 && 'has-needs')}>
      {needs > 0 ? (
        <p className="summary-big">
          <b>{needs}</b> {needs > 1 ? "t'attendent" : "t'attend"}
        </p>
      ) : (
        <p className="summary-calm">{consoles.length ? 'Personne ne t’attend.' : 'Aucune console.'}</p>
      )}
      {(errors > 0 || rest.length > 0) && (
        <p className="summary-rest">
          {errors > 0 && <span className="is-error">{errors} en erreur</span>}
          {rest.map(([k, label]) => (
            <span key={label}>
              {k} {label}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

// rev : libellés du thème « Réverbère ». fold : formulaire replié derrière un bouton (téléphone), `extra` s'ouvre avec lui.
// `pied` (pli ouvert seulement) : sous le bouton « Fermer » — l'usage des comptes sur téléphone, qui ne doit pas le pousser
// hors de l'écran d'un petit téléphone (intégration du 11/11).
export function Composer({ onCreated, rev, fold, extra, pied }) {
  const [meta, setMeta] = useState({ projects: [], kinds: [] })
  const [kind, setKind] = useState('claude')
  const [cwd, setCwd] = useState('')
  const [count, setCount] = useState(1)
  const [mission, setMission] = useState('')
  const [verifierFin, setVerifierFin] = useState(false)
  const [validerLancements, setValiderLancements] = useState(false) // volet quota : chaque lancement d'équipier attend ton accord
  // Équipe locale (tâche 18 du 17/11, lib/locale.mjs) : capitaine et équipiers sur le modèle du Mac d'Orkun.
  const [enLocal, setEnLocal] = useState(false)
  const [mac, setMac] = useState(null) // GET /api/locale : { enLigne, raison, modele, max, ouvertes } ; null = pas lu
  const [consigne, setConsigne] = useState('') // premier message donné aux agents lancés (facultatif)
  // « Dans une copie » (volet copies, Copies.jsx) : la demande de copie, ou null ; `tour` remet la case à zéro après un lancement.
  const [copie, setCopie] = useState(null)
  const [tour, setTour] = useState(0)
  const equipe = kind === 'equipe' // une équipe : un projet et une mission, au lieu d'une console
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  useEtape(!!fold && open, () => setOpen(false)) // téléphone : le pli ouvert prend une étape, « retour » le ferme (retour.js)
  // T (touche seule, raccourcis.js) : le formulaire s'ouvre (déplié s'il est replié) et le choix du type prend le clavier.
  const formRef = useRef(null)
  useBranche('nouvelle', () => {
    setOpen(true)
    requestAnimationFrame(() => formRef.current?.querySelector('[role="radio"][aria-checked="true"]')?.focus())
  })
  // « Plusieurs comptes Claude / Codex » (volet « comptes », 11/11) : Claude et Codex se lancent sur le compte 1 (celui
  // d'avant, rien ne change) ou sur le compte 2. `comptes` : ce que dit GET /api/comptes (null = route absente ou en
  // erreur : on ne dit rien). Lu à l'ouverture du formulaire, et relu quand on change de compte (après un /login).
  const parCompte = kind === 'claude' || kind === 'codex'
  const nomCompte = useNomsComptes()
  const [compte, setCompte] = useState('1')
  const [comptes, setComptes] = useState(null)
  const voit = !fold || open
  useEffect(() => {
    if (!voit) return
    let vivant = true
    api('GET', '/api/comptes').then(
      (r) => vivant && setComptes(Array.isArray(r?.comptes) ? r.comptes : null),
      () => vivant && setComptes(null),
    )
    return () => {
      vivant = false
    }
  }, [voit, compte])
  const aConnecter = parCompte && compte === '2' && !!comptes?.some((x) => x.kind === kind && x.compte === '2' && x.connecte === false)
  // Le Mac, relu toutes les 10 s tant que la case « équipe locale » est cochée et le formulaire visible.
  const voitMac = voit && equipe && enLocal
  useEffect(() => {
    if (!voitMac) return
    let vivant = true
    const lis = () => api('GET', '/api/locale').then((r) => vivant && setMac(r?.locale || null), () => vivant && setMac(null))
    lis()
    const t = setInterval(lis, 10000)
    return () => {
      vivant = false
      clearInterval(t)
    }
  }, [voitMac])

  useEffect(() => {
    api('GET', '/api/projects').then((m) => {
      setMeta(m)
      setCwd((v) => v || m.projects[0]?.path || '')
    }, (e) => setError(e.message))
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (equipe) {
        const r = await api('POST', '/api/equipes', { cwd, mission, verifierFin, ...(validerLancements ? { validerLancements } : {}), ...(enLocal ? { locale: true } : {}) })
        onCreated([{ id: r.team.chief }])
        setMission('')
      } else {
        const r = await api('POST', '/api/consoles', { kind, cwd, count, ...(kind !== 'shell' && consigne.trim() ? { consigne } : {}), ...(parCompte && compte === '2' ? { compte: '2' } : {}), ...(parCompte && copie ? { copie } : {}) })
        onCreated(r.consoles)
        setCount(1)
        setConsigne('')
        setTour((t) => t + 1)
      }
      setOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const go = equipe
    ? busy ? 'Lance…' : 'Lancer l’équipe'
    : rev
    ? busy ? 'Entre…' : count > 1 ? `Faire entrer ${count}` : 'Faire entrer'
    : busy ? 'Pose…' : count > 1 ? `Poser ${count} consoles` : 'Poser sur le tapis'

  const form = (
    <form ref={formRef} className={cls('composer', equipe && 'is-equipe')} onSubmit={submit}>
      <p className="composer-title">{equipe ? 'Nouvelle équipe' : 'Nouvelle console'}</p>
      {/* Préréglages de groupe (« 2 Claude + 1 Codex »…), lancés d'un clic dans le dossier choisi (Groupes.jsx). En tête du
          formulaire (décision d'Orkun du 17/11, raccourcis-9 : « Puces en tête du formulaire ») : sur 1366 × 768, en bas du pli
          ouvert, il fallait défiler pour les atteindre. */}
      {!equipe && <Groupes cwd={cwd} onCreated={onCreated} rev={rev} />}
      <div className="seg" role="radiogroup" aria-label="Type de console">
        {[...meta.kinds, ...(meta.kinds.length ? [{ id: 'equipe', label: 'Équipe' }] : [])].map((k) => (
          <button
            key={k.id}
            type="button"
            role="radio"
            aria-checked={kind === k.id}
            className={cls(kind === k.id && 'is-on')}
            onClick={() => {
              setKind(k.id)
              setError('') // l'erreur d'un essai précédent ne reste pas sous un autre choix
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Dossier</span>
        <select name="cwd" aria-label="Dossier" value={cwd} onChange={(e) => setCwd(e.target.value)}>
          {meta.projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {/* « Plusieurs comptes Claude / Codex » : le compte, en petit sélecteur à côté du bouton de lancement, seul jusque-là
          sur sa rangée (`field compte`, rangé par comptes.css) : aucune rangée de plus. Intégration du 11/11 : la rangée
          « Compte 1 | Compte 2 » sous le dossier raccourcissait la liste sur PC et sortait le bouton de lancement de l'écran
          d'un petit téléphone. L'avertissement ne vient, sous le bouton, que pour un compte 2 pas encore connecté. */}
      {parCompte && (
        <label className="field compte">
          <span>Compte</span>
          <select
            name="compte"
            aria-label="Compte"
            value={compte}
            onChange={(e) => {
              setCompte(e.target.value)
              setError('')
            }}
          >
            <option value="1">{nomCompte(kind, '1')}</option>
            <option value="2">{nomCompte(kind, '2')}</option>
          </select>
        </label>
      )}
      {aConnecter && (
        <small className="compte-avis">
          {nomCompte(kind, '2')} pas encore connecté : la console s'ouvrira sur la connexion (
          {kind === 'codex' ? (
            <>
              choisis la connexion par code, ou quitte et tape <code style={{ whiteSpace: 'nowrap' }}>codex login --device-auth</code>
            </>
          ) : (
            <>
              tape <code>/login</code> dans Claude
            </>
          )}
          )
        </small>
      )}
      {equipe && (
        <label className="field mission">
          <span>Mission</span>
          <textarea name="mission" aria-label="Mission" rows={3} maxLength={20000} placeholder="Ce que l’équipe doit livrer, avec tes mots." value={mission} onChange={(e) => setMission(e.target.value)} />
        </label>
      )}
      {equipe && <label className="verification-reglage"><input type="checkbox" checked={verifierFin} onChange={(e) => setVerifierFin(e.target.checked)} /> Vérifier à la fin · Codex</label>}
      {/* Juste après « Vérifier à la fin » : au téléphone debout, les deux cases partagent une rangée (budget.css). */}
      {equipe && <CaseValider checked={validerLancements} onChange={setValiderLancements} />}
      {/* L'état du Mac tient dans la ligne de la case (mesuré le 17/11 : un avis à part tombait sous le bas d'un écran de
          768 px et prenait une rangée de plus à la liste du téléphone) ; la raison détaillée en bulle, et dans le refus. */}
      {equipe && (
        <label className="verification-reglage">
          <input type="checkbox" name="locale" checked={enLocal} onChange={(e) => { setEnLocal(e.target.checked); setError('') }} /> <span title="Capitaine et équipiers sur le Qwen du Mac (oMLX)">Équipe locale · Mac</span>
          {enLocal && mac && (
            <span className={cls('mac-avis', !mac.enLigne && 'est-hors')} role="status" title={mac.enLigne ? `${mac.modele} · ${mac.ouvertes}/${mac.max} consoles locales ouvertes` : `${mac.raison} : réveille le Mac`}>
              {mac.enLigne ? ` · en ligne ${mac.ouvertes}/${mac.max}` : ' · hors ligne'}
            </span>
          )}
        </label>
      )}
      {!equipe && kind !== 'shell' && (
        <label className="field mission consigne">
          <span>Consigne</span>
          <textarea name="consigne" aria-label="Consigne de départ (facultatif)" rows={2} maxLength={20000} placeholder="Facultatif : ce que l’agent doit faire en arrivant." value={consigne} onChange={(e) => setConsigne(e.target.value)} />
        </label>
      )}
      {/* Volet copies : la case n'existe que pour Claude / Codex dans un dépôt git ; ses options seulement cochée. */}
      {voit && <CaseCopie key={tour} kind={kind} cwd={cwd} onChange={setCopie} />}
      <div className="composer-row">
        {!equipe && (
        <div className="stepper" aria-label="Nombre de consoles">
          <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} aria-label="Une de moins">
            −
          </button>
          <output>{count}</output>
          <button type="button" onClick={() => setCount((c) => Math.min(MAX_CONSOLES, c + 1))} aria-label="Une de plus">
            +
          </button>
        </div>
        )}
        <button type="submit" className="go" disabled={busy || !cwd || (equipe && !mission.trim())}>
          {go}
        </button>
      </div>
      {error && <p className="composer-error">{error}</p>}
    </form>
  )

  if (!fold)
    return (
      <>
        {form}
        {extra}
      </>
    )
  return (
    <div className="pli-boite">
      {open && form}
      {open && extra}
      <button type="button" className={cls('pli', open && 'is-ouvert')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Fermer' : 'Nouvelle console'}
      </button>
      {open && pied}
    </div>
  )
}

// Ce qui reste sous le bas visible de la liste : combien de consoles, dont combien t'attendent.
function useSuite(ref, consoles) {
  const [suite, setSuite] = useState({ n: 0, needs: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mesure = () => {
      const bas = el.getBoundingClientRect().bottom + 1
      // Ce qui dépasse : les consoles (une équipe en compte plusieurs) et, parmi elles, ce qui t'attend (carte pleine,
      // ou en-tête d'une équipe prête à livrer).
      const sous = [...el.querySelectorAll('.rang, .carte, .is-prete > .equipe-tete')].filter((x) => x.getBoundingClientRect().bottom > bas)
      const n = sous.filter((x) => !x.matches('.equipe-tete')).length, needs = sous.filter((x) => !x.matches('.rang')).length
      setSuite((s) => (s.n === n && s.needs === needs ? s : { n, needs }))
    }
    mesure()
    el.addEventListener('scroll', mesure, { passive: true })
    const ro = new ResizeObserver(mesure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', mesure)
      ro.disconnect()
    }
  }, [ref, consoles])
  return suite
}

const choix = (label, key, look, setLook, names) => (
  <span role="radiogroup" aria-label={label}>
    {LOOKS[key].map((v) => (
      <button key={v} type="button" role="radio" aria-checked={look[key] === v} onClick={() => setLook({ [key]: v })}>
        {names[v]}
      </button>
    ))}
  </span>
)

// Le choix de l'apparence. La couleur d'appel n'existe que dans « Réverbère ».
function Apparence({ look, setLook }) {
  return (
    <div className="apparence" role="group" aria-label="Apparence">
      {choix('Thème', 'theme', look, setLook, { reverbere: 'Réverbère', tapis: 'Tapis' })}
      {look.theme === 'reverbere' && choix("Couleur d'appel", 'appel', look, setLook, { jaune: 'Jaune', ivoire: 'Ivoire' })}
      <Alertes />
      <BoutonRaccourcis />
      {/* Sous le nom public seulement (https) : ferme la session sur tous les appareils. En local, l'accès tient au lien à clé. */}
      {location.protocol === 'https:' && (
        <button type="button" className="sortie" onClick={() => fetch('/logout', { method: 'POST' }).finally(() => location.assign('/login'))}>
          Se déconnecter
        </button>
      )}
    </div>
  )
}

function RailTapis({ consoles, actions, online, activeId, onPick, onCreated, look, setLook, mobile }) {
  const now = useNow()
  // Thème Tapis : les fermées aussi à part (16/11), derrière « Historique · N » au bas de la liste.
  const [histo, setHisto] = useState(false)
  const fermees = consoles.filter((c) => c.status === 'closed')
  const voit = histo ? fermees : consoles.filter((c) => c.status !== 'closed')
  const sorted = [...voit].sort((a, b) => statusOf(a.status).rank - statusOf(b.status).rank || (histo ? (b.since ?? 0) - (a.since ?? 0) : a.createdAt - b.createdAt))
  return (
    <aside className="rail">
      <header className="brand">
        <h1>Meydan</h1>
        <p>terminaux d’agents · VPS</p>
      </header>
      {!online && <p className="offline">Liaison coupée, reconnexion…</p>}
      <Summary consoles={consoles} />
      <ul className="roll">
        {!histo && <DemandesBudget onPick={onPick} />}
        {sorted.map((c) => (
          <li key={c.id}>
            <button type="button" className={cls('row', `is-${c.status}`, activeId === c.id && 'is-active')} onClick={() => onPick(c.id)}>
              {/* « Plusieurs comptes Claude / Codex » : le nom prend la place libre (flex: 1), le badge du compte 2 se
                  pose donc contre l'état, pas au milieu de la ligne (space-between). */}
              <span className="row-top">
                <b style={{ flex: 1 }}>{c.name}</b>
                <CompteBadge c={c} />
                <em>{statusOf(c.status).label}</em>
              </span>
              <span className="row-meta">
                {shortDir(c.cwd)} · {since(c.since, now)}
              </span>
              <RepereCopie c={c} ligne />

              {c.note && <span className="row-note">{c.note}</span>}
            </button>
            <QuotaRelais c={c} actions={actions} onPick={onPick} />
          </li>
        ))}
        {mobile && <AteliersListe />}
      </ul>
      <button type="button" className="tapis-histo" aria-pressed={histo} onClick={() => setHisto(!histo)}>
        {histo ? '← Consoles ouvertes' : `Historique · ${fermees.length}`}
      </button>
      <Veille consoles={consoles} />
      <Composer
        onCreated={onCreated}
        extra={
          <>
            {mobile && <Comptes compact />}
            <Apparence look={look} setLook={setLook} />
          </>
        }
      />
    </aside>
  )
}

// Une console dans la liste : carte pleine si elle t'attend, ligne sinon. `nom` et `detail` : ce qu'une équipe affiche à la place.
// Appui prolongé au doigt sur une console de la liste : renommer, relancer, fermer. Sur téléphone il n'y avait aucun
// autre moyen (Orkun, 10/11 : « Faudrait mettre des commandes par appuie prolongé »). Fermer se confirme d'un second appui.
// `voisines` : les autres consoles (pour transmettre une réponse) ; `onPick` : ouvrir la console née d'un relais.
// `extra` : des entrées propres à l'endroit où le menu s'ouvre ([{ texte, action }], après « Renommer ») — le plateau du
// téléphone y met « Redimensionner ».
export function MenuLigne({ c, x, y, actions, onClose, onPick, voisines = [], extra = [] }) {
  const nomCompte = useNomsComptes()
  const [mode, setMode] = useState('')
  const [nom, setNom] = useState(c.name)
  const [erreur, setErreur] = useState('')
  // Relais : la conversation passe à un nouvel agent (même dossier), ou la dernière réponse à un agent au repos.
  const relaisPossible = (c.kind === 'claude' || c.kind === 'codex') && !c.team && !!c.agent
  // « Continuer dans une copie » (volet copies) : seulement si le dossier est dans un dépôt git dont on peut faire une copie.
  const copiable = useCopiable(c)
  const cibles = voisines.filter((v) => v.id !== c.id && (v.kind === 'claude' || v.kind === 'codex') && (v.status === 'ready' || v.status === 'fini') && !v.team).slice(0, 3)
  // `compte` : la nouvelle console part sur ce compte (« Plusieurs comptes Claude / Codex ») ; absent = compte 1.
  const passe = (vers, compte) =>
    actions.relais(c.id, vers, compte).then(
      (r) => {
        onClose()
        onPick?.(r.console.id)
      },
      (e) => setErreur(e.message),
    )
  const renomme = (e) => {
    e.preventDefault()
    const neuf = nom.trim()
    if (neuf && neuf !== c.name) actions.patch(c.id, { name: neuf })
    onClose()
  }
  // Dupliquer (Orkun, 11/11 : « Dupliquer une console (même type, dossier, modèle) depuis son menu. ») : une console neuve
  // du même type, dans le même dossier, avec le même modèle et le même mode de permissions (Claude) ; ni la consigne ni la
  // conversation ne sont copiées. Pas pour une console d'équipe (c'est l'équipe qui la lance). Nom : « <nom> (copie) »,
  // sans empiler les « (copie) » d'une copie de copie, coupé à 48 caractères comme tout nom. Place : à droite de
  // l'originale, à sa taille, poussée plus à droite tant qu'elle couvrirait une voisine.
  const [copie, setCopie] = useState(false) // en cours : un second clic ne lance pas une seconde console
  const duplique = async () => {
    setCopie(true)
    setErreur('')
    const name = `${c.name.replace(/ \(copie\)$/, '').slice(0, 40).trimEnd()} (copie)`
    try {
      const r = await api('POST', '/api/consoles', { kind: c.kind, cwd: c.cwd, name, ...(c.modele && { modele: c.modele }), ...(c.permission && { permission: c.permission }) })
      const neuf = r.consoles[0]
      const ECART = 48 // celui des places libres du serveur
      let gauche = c.x + c.w + ECART
      for (let gene; (gene = voisines.filter((v) => v.id !== c.id && gauche < v.x + v.w && v.x < gauche + c.w && c.y < v.y + v.h && v.y < c.y + c.h)).length; )
        gauche = Math.max(...gene.map((v) => v.x + v.w)) + ECART
      actions.patch(neuf.id, { x: gauche, y: c.y, w: c.w, h: c.h })
      onClose()
      onPick?.(neuf.id)
    } catch (e) {
      setErreur(e.message)
      setCopie(false)
    }
  }
  return (
    <MenuDoigt x={x} y={y} onClose={onClose} colonne>
      {mode === 'journal' ? (
        <JournalInstallation c={c} />
      ) : mode === 'copie' ? (
        <ContinuerCopie
          c={c}
          p={copiable}
          onFait={(r) => {
            onClose()
            onPick?.(r.console.id)
          }}
        />
      ) : mode === 'relais' ? (
        <>
          <button type="button" onClick={() => passe('claude')}>
            Relais à un nouveau Claude
          </button>
          <button type="button" onClick={() => passe('codex')}>
            Relais à un nouveau Codex
          </button>
          <button type="button" onClick={() => passe('claude', '2')}>
            Relais à un nouveau Claude · {nomCompte('claude', '2')}
          </button>
          <button type="button" onClick={() => passe('codex', '2')}>
            Relais à un nouveau Codex · {nomCompte('codex', '2')}
          </button>
          {cibles.map((v) => (
            <button key={v.id} type="button" onClick={() => passe(v.id)}>
              Sa dernière réponse → {v.name}
            </button>
          ))}
          {erreur && <b>{erreur}</b>}
        </>
      ) : mode === 'nom' ? (
        <form onSubmit={renomme}>
          <input autoFocus value={nom} maxLength={48} aria-label="Nom de la console" enterKeyHint="done" onChange={(e) => setNom(e.target.value)} />
          <button type="submit">OK</button>
        </form>
      ) : mode === 'ferme' ? (
        <button
          type="button"
          onClick={() => {
            actions.remove(c.id)
            onClose()
          }}
        >
          {c.status === 'closed' ? 'Confirmer le retrait' : 'Confirmer la fermeture'}
        </button>
      ) : (
        <>
          <button type="button" onClick={() => setMode('nom')}>
            Renommer
          </button>
          {extra.map((e) => (
            <button
              key={e.texte}
              type="button"
              onClick={() => {
                onClose()
                e.action()
              }}
            >
              {e.texte}
            </button>
          ))}
          {!c.team && (
            <button type="button" disabled={copie} onClick={duplique}>
              Dupliquer
            </button>
          )}
          {(c.status === 'working' || (c.status === 'running' && c.kind === 'shell')) && (
            <button
              type="button"
              onClick={() => {
                actions.interrompre(c.id).catch(() => {})
                onClose()
              }}
            >
              Interrompre
            </button>
          )}
          {relaisPossible && (
            <button type="button" onClick={() => setMode('relais')}>
              Passer le relais
            </button>
          )}
          {copiable && (
            <button type="button" onClick={() => setMode('copie')}>
              Continuer dans une copie
            </button>
          )}
          {c.copie?.installation && (
            <button type="button" onClick={() => setMode('journal')}>
              Journal de l’installation
            </button>
          )}
          {(c.kind === 'claude' || c.kind === 'codex') && !c.team && c.status !== 'closed' && (
            <button
              type="button"
              onClick={() => {
                onClose()
                actions.ouvreBoucle(c.id)
              }}
            >
              {c.boucle?.etat === 'active' ? `Boucle en cours (${c.boucle.n}/${c.boucle.tours})` : 'Boucle…'}
            </button>
          )}
          {/* Mémoire de projet : le panneau, ouvert sur le projet de cette console (celui de son équipe). */}
          {actions.projetMemoire?.(c) && (
            <button
              type="button"
              onClick={() => {
                onClose()
                actions.ouvreMemoire(actions.projetMemoire(c))
              }}
            >
              Mémoire du projet
            </button>
          )}
          {c.status === 'closed' && (
            <button
              type="button"
              onClick={() => {
                actions.revive(c.id)
                onClose()
              }}
            >
              Relancer
            </button>
          )}
          {!c.chief && (
            <button type="button" onClick={() => setMode('ferme')}>
              {c.status === 'closed' ? 'Retirer de l’historique' : 'Fermer'}
            </button>
          )}
          {erreur && <b>{erreur}</b>}
        </>
      )}
    </MenuDoigt>
  )
}

// Où poser le menu quand il s'ouvre depuis un bouton « ⋯ » plutôt que sous un doigt : juste au-dessus du bouton, ou
// juste dessous près du haut de l'écran (MenuDoigt choisit dessus/dessous selon y). Le menu ne couvre jamais le bouton.
export function posBouton(el) {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + 12 < 260 ? Math.min(r.bottom - 22, 259) : r.top + 12 }
}

// Le bouton « ⋯ » : le même menu que l'appui prolongé, mais visible. Sans lui, rien n'indiquait que la ligne en avait un
// (audit ergonomie du 10/11, constat 1). Frère de la ligne et non son enfant : un bouton dans un bouton n'est pas valide,
// et toucher « ⋯ » ne doit pas ouvrir la console.
export function BoutonPlus({ nom, onOpen, className = '' }) {
  return (
    <button type="button" className={`ligne-plus ${className}`.trim()} aria-label={`Actions de ${nom}`} aria-haspopup="menu" onClick={(e) => onOpen(posBouton(e.currentTarget))}>
      <i aria-hidden="true">⋯</i>
    </button>
  )
}

function Ligne({ c, active, onPick, actions, voisines, nom = c.name, detail = `${c.kind.toUpperCase()} · ${shortDir(c.cwd)}` }) {
  const ref = useRef(null)
  const [menu, setMenu] = useState(null)
  useAppuiLong(ref, setMenu, () => !!actions)
  // Clic droit à la souris : le même menu, posé à la souris (Orkun, 11/11 : « je n'arrive pas à clic droit et renommer »).
  // Au doigt, l'appui prolongé s'en charge déjà (appui.jsx écarte le menu du système) : on ne double pas.
  const clicDroit = (e) => {
    if (!actions || e.nativeEvent.pointerType === 'touch' || e.nativeEvent.pointerType === 'pen') return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }
  const leMenu = menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={onPick} voisines={voisines} />
  // Le sujet que l'agent a donné à sa session prend la place de « CLAUDE · dossier » dès qu'il existe (le nom de la
  // console dit déjà l'agent et le dossier). Dans une équipe, la ligne garde le statut de l'équipier.
  if (!c.team && typeof c.sujet === 'string' && c.sujet) detail = c.sujet
  if (c.boucle?.etat === 'active') detail = `↻ ${resumeBoucle(c.boucle)} · ${detail}` // une boucle tourne : dit en tête de ligne
  // Un message attend d'être remis à cet agent (consigne de départ, message d'équipe) : il part dès qu'il est au repos.
  if (c.attente?.length && c.status !== 'closed') detail = `message en attente · ${detail}`
  // « Plusieurs comptes Claude / Codex » : le badge du compte 2 (`CompteBadge`, rien pour le compte 1) au bout de la zone
  // du nom, contre l'âge (carte) ou l'état (ligne) : seul le nom rétrécit, il garde sa coupure et l'âge reste en place.
  if (c.status === 'needs')
    return (
      <>
      <button ref={ref} onContextMenu={clicDroit} type="button" data-id={c.id} className={cls('carte', active && 'is-active')} onClick={() => onPick(c.id)}>
        <span className="carte-haut">
          <Signe status="needs" />
          <b>{nom}</b>
          <CompteBadge c={c} />
          <Age since={c.since} />
        </span>
        <span className="carte-q">{c.note || "Une question t'attend"}</span>
        <RepereCopie c={c} ligne />
        <span className="carte-bas">
          <span>{detail}</span>
          <em className="va" aria-hidden="true">
            ›
          </em>
        </span>
      </button>
      {actions && <BoutonPlus nom={nom} onOpen={setMenu} />}
      {leMenu}
      </>
    )
  return (
    <>
    <button ref={ref} onContextMenu={clicDroit} type="button" data-id={c.id} className={cls('rang', `is-${c.status}`, active && 'is-active')} title={c.note || undefined} onClick={() => onPick(c.id)}>
      <Signe status={c.status} />
      <span className="rang-nom">
        <b>{nom}</b>
        {['suspecte', 'muette', 'reportee'].includes(c.silence?.etat) ? <BadgeSilence c={c} /> : <small>{(c.status === 'error' && c.note) || detail}</small>}
        <RepereCopie c={c} ligne />
      </span>
      <CompteBadge c={c} />
      <span className="etat">{statusOf(c.status).label}</span>
      <Age since={c.since} />
    </button>
    {actions && <BoutonPlus nom={nom} onOpen={setMenu} />}
    {leMenu}
    </>
  )
}

// Texte venu d'un agent, sur plusieurs lignes : un mot et le signe qui le suit (« prêt : », « fini ? ») restent ensemble.
// Fait par un bloc sans coupure plutôt que par une espace insécable : la police d'interface la dessine sans largeur.
const Insecable = ({ texte }) => texte.split(/(\S+ [:;!?»])/).map((p, i) => (i % 2 ? <span key={i} style={{ whiteSpace: 'nowrap' }}>{p}</span> : p))

// Une équipe : son en-tête (mission, projet, actions), puis son capitaine et ses équipiers. Quand le capitaine a déclaré
// le travail prêt, l'en-tête devient une carte pleine : la livraison attend le go d'Orkun. Livrer et arrêter se
// confirment d'un second appui.
function Equipe({ team, membres, activeId, onPick, actions }) {
  const [arme, setArme] = useState('')
  const [busy, setBusy] = useState(false)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    if (!arme) return
    const t = setTimeout(() => setArme(''), 5000)
    return () => clearTimeout(t)
  }, [arme])
  // Le commit prêt affiché au premier appui : c'est lui, et lui seul, que le second appui livre. Si le capitaine a
  // redéclaré autre chose entre les deux, le serveur refuse et le compte rendu se relit.
  const vu = useRef('')
  const agir = async (quoi) => {
    if (arme !== quoi) {
      vu.current = team.pret?.head || ''
      return setArme(quoi)
    }
    setArme('')
    setBusy(true)
    setErreur('')
    try {
      await actions[quoi](team.id, vu.current)
    } catch (e) {
      setErreur(e.message)
    } finally {
      setBusy(false)
    }
  }
  const crew = membres.filter((c) => !c.chief).length
  const prete = !!team.pret
  const livraison = team.pret?.contenu // ce que la livraison change dans le projet : à lire avant de confirmer
  // 17/11 : l'équipe t'appelle (question, blocage, échec du capitaine ; verdict de vérification sans sa console).
  const appel = !prete && appelAVoir(team) ? team.appel : null
  const dep = team.depart // l'état du dossier du projet au départ de l'équipe (17/11)
  return (
    <li className={cls('equipe', equipeAttend(team) && 'is-prete')}>
      <div className="equipe-tete">
        <span className="equipe-titre">
          <i>{prete ? 'ÉQUIPE PRÊTE' : appel ? 'ÉQUIPE · T’ATTEND' : team.locale ? 'ÉQUIPE LOCALE' : 'ÉQUIPE'}</i>
          <b>{team.nom}</b>
        </span>
        <button type="button" className={cls('arreter', arme === 'arreter' && 'is-arme')} disabled={busy} onClick={() => agir('arreter')}>
          {arme === 'arreter' ? 'Confirmer l’arrêt' : 'Arrêter'}
        </button>
        {prete && <p className="equipe-q">{team.pret.texte ? <Insecable texte={team.pret.texte} /> : 'Le capitaine a déclaré le travail prêt.'}</p>}
        {appel && <p className="equipe-q">{appel.de === 'verification' ? 'Vérification\u00a0: ' : `Capitaine (${VERBE[appel.verbe] || appel.verbe})\u00a0: `}{appel.texte ? <Insecable texte={appel.texte} /> : 'il t’attend.'}</p>}
        <span className="equipe-bas">
          {shortDir(team.projet)}
          {team.git ? (team.branche ? ` · ${team.branche}` : '') : ' · sans git'} · {crew} équipier{crew > 1 ? 's' : ''}
          {team.locale ? ' · sur le Mac' : ''}
          {team.livre ? ` · livrée ${team.livre.apres.slice(0, 7)}` : ''}
        </span>
        {/* Équipe locale : le Mac (oMLX par son tunnel) ne répond plus ; ses consoles attendent, `meydan lancer` refuse. */}
        {team.locale && team.mac?.enLigne === false && (
          <span className="equipe-bas equipe-mac" role="status">
            <b>Mac hors ligne</b> : réveille-le · {team.mac.raison}
          </span>
        )}
        {livraison && (
          <span className="equipe-bas equipe-contenu">
            {livraison.fichiers} fichier{livraison.fichiers > 1 ? 's' : ''} · +{livraison.ajouts} −{livraison.retraits} · {livraison.noms.join(' · ')}
            {livraison.autres > 0 && ` · et ${livraison.autres} de plus`}
            {livraison.sensibles.length > 0 && <b> — à regarder : {livraison.sensibles.join(', ')}</b>}
          </span>
        )}
        {dep?.nonCommites > 0 && <span className="equipe-bas">Au départ : {dep.nonCommites} fichier{dep.nonCommites > 1 ? 's' : ''} non commité{dep.nonCommites > 1 ? 's' : ''} laissé{dep.nonCommites > 1 ? 's' : ''} hors de l’équipe ({dep.fichiers.join(', ')}{dep.nonCommites > dep.fichiers.length ? '…' : ''})</span>}
        {dep?.detachee && <span className="equipe-bas">Projet en tête détachée au départ : la livraison sera impossible.</span>}
        {prete && !team.git && <span className="equipe-bas">Projet sans git : rien à livrer, le travail est déjà dans le dossier. Arrête l’équipe quand tu l’as vu.</span>}
        {prete && team.git && (
          <button type="button" className={cls('livrer', arme === 'livrer' && 'is-arme')} disabled={busy} onClick={() => agir('livrer')}>
            {arme === 'livrer' ? 'Confirmer la livraison' : 'Livrer'}
          </button>
        )}
        <ReglageVerification team={team} />
        <UsageEquipe team={team} />
        {erreur && <p className="equipe-erreur">{erreur}</p>}
      </div>
      <ul>
        {membres.map((c) => (
          <li key={c.id}>
            <Ligne
              c={c}
              active={activeId === c.id}
              onPick={onPick}
              actions={actions}
              nom={c.chief ? 'Capitaine' : c.name}
              detail={`${c.kind.toUpperCase()} · ${c.etat ? `${VERBE[c.etat.verbe] || c.etat.verbe}${c.etat.texte ? ` — ${c.etat.texte}` : ''}` : 'pas encore de statut'}`}
            />
          </li>
        ))}
      </ul>
    </li>
  )
}

// Reel « 3 règles » (11/11) — téléphone : la plus ancienne attente devient LA chose énorme de l'écran, en trois plans :
// le nom de son projet en très grand au fond (règle 1), la question au milieu sur une carte de verre, et « Répondre »
// par-dessus, à cheval sur le bord de la carte. Le jaune n'y est que sur ce qui se touche (règle 2). Tout le reste de
// l'écran est petit (règle 3). Appui prolongé / ⋯ : le même menu que sur sa ligne (elle n'est plus répétée dans la liste).
function Scene({ tete, n, now, onPick, actions, voisines }) {
  const ref = useRef(null)
  const [menu, setMenu] = useState(null)
  useAppuiLong(ref, setMenu, () => !!actions)
  const team = tete.team
  const c = tete.c || tete.membres.find((m) => m.status === 'needs') || tete.membres.find((m) => m.chief) || tete.membres[0]
  const prete = team && pretAVoir(team) && c.status !== 'needs'
  const appel = team && !prete && appelAVoir(team) && c.status !== 'needs' ? team.appel : null // 17/11
  const projet = team ? projetDe(team.projet) : projetDeConsole(c)
  const question = prete ? team.pret.texte || 'Le capitaine a déclaré le travail prêt.' : appel ? appel.texte || 'Le capitaine t’attend.' : c.note || "Une question t'attend"
  const qui = team ? `${team.nom} · ${c.chief ? 'capitaine' : c.name}` : c.name
  const sujet = !team && typeof c.sujet === 'string' ? c.sujet : ''
  return (
    <section className="scene" aria-label="La plus ancienne attente">
      <p className="scene-sur">
        <span>
          {n > 1 ? `${n} t'attendent` : "t'attend"} · depuis {since(tete.t, now)}
        </span>
        {actions && !prete && <BoutonPlus nom={c.name} onOpen={setMenu} className="scene-plus" />}
      </p>
      <GrandMot texte={projet} min={64} max={150} lignes={2} />
      <button ref={ref} type="button" className="scene-carte" data-id={c.id} onClick={() => onPick(c.id)}>
        <span className="scene-qui">
          <Signe status="needs" />
          <b>{qui}</b>
        </span>
        <span className="scene-q">{question}</span>
        {sujet && <small className="scene-sujet">{sujet}</small>}
        <span className="scene-go">
          {prete ? 'Voir le capitaine' : 'Répondre'}
          <i aria-hidden="true">›</i>
        </span>
      </button>
      {menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={onPick} voisines={voisines} />}
    </section>
  )
}

// La liste du téléphone en groupes de projet : l'ordre d'urgence est gardé, un groupe prend la place de sa console la
// plus urgente ; une équipe reste son propre groupe (son en-tête dit déjà le projet).
function parProjet(lignes) {
  const g = new Map()
  for (const l of lignes) {
    const clef = l.team ? `e:${l.team.id}` : `p:${projetDeConsole(l.c)}`
    if (!g.has(clef)) g.set(clef, { clef, nom: l.team ? '' : projetDeConsole(l.c), lignes: [] })
    g.get(clef).lignes.push(l)
  }
  return [...g.values()]
}

// « Réverbère » : le compteur de ce qui t'attend, les cartes pleines de ce qui t'attend, puis une ligne par console.
// Carte de mission : les groupes de la liste, par ce que font les consoles.
const GROUPES = {
  attend: { nom: 'T’attend', etats: ['needs'] },
  fini: { nom: 'Fini', etats: ['fini'] },
  travaille: { nom: 'Travaille', etats: ['working', 'running', 'starting'] },
  repos: { nom: 'Au repos', etats: ['ready', 'shell'] },
  // Une console en erreur reste dans la liste (il faut la voir) ; les fermées vont dans l'onglet « Historique » (16/11).
  erreur: { nom: 'En erreur', etats: ['error'] },
}

// L'onglet « Historique » (Orkun, 16/11 : « tu devrais le mettre dans un onglet historique et non dans tout ») : les
// consoles fermées, la plus récemment fermée en tête. « Vider » les retire toutes, en deux temps (le second appui nomme
// combien) ; chaque ligne garde son menu (Relancer, Retirer de l'historique).
function Historique({ fermees: toutes, ouvertes, actions }) {
  // Un capitaine fermé dont l'équipe a encore des équipiers vivants n'est pas « vidé » (le retirer arrêterait l'équipe).
  const fermees = toutes.filter((c) => !(c.chief && ouvertes.some((m) => m.team === c.team)))
  const [arme, setArme] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!arme) return
    const t = setTimeout(() => setArme(false), 5000)
    return () => clearTimeout(t)
  }, [arme])
  if (!toutes.length)
    return (
      <li className="histo-tete">
        <span>Aucune console fermée pour l’instant. Une console qui se ferme vient ici, la plus récente en tête.</span>
      </li>
    )
  if (!actions?.remove || !fermees.length) return null
  const vide = async () => {
    if (!arme) return setArme(true)
    setArme(false)
    setBusy(true)
    try {
      for (const c of fermees) await actions.remove(c.id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="histo-tete">
      <span>La plus récemment fermée en tête. Un clic l’ouvre pour la relancer.</span>
      <button type="button" className={cls('histo-vide', arme && 'est-arme')} disabled={busy} onClick={vide}>
        {busy ? 'Retrait…' : arme ? `Retirer les ${fermees.length} ?` : 'Vider'}
      </button>
    </li>
  )
}

// `bascule` (téléphone couché) : le sélecteur « Ensemble / Liste », posé sous le compteur.
// `ordreRef` (ordinateur) : reçoit l'ordre des consoles tel que la liste les montre, pour les raccourcis Alt+1…9 (App.jsx).
// `musique` : les commandes du lecteur (Musique.jsx), posées au-dessus du formulaire.
function RailReverbere({ consoles, teams, actions, online, activeId, onPick, onCreated, look, setLook, mobile, waiting, bascule, ordreRef, musique, memoire = [] }) {
  const now = useNow()
  const bas = useMedia('(max-height: 1000px)')
  // Trois règles (`reel3`) : la scène prend ~100 px de plus que le compteur d'avant. Sur un écran de 1080 px, formulaire
  // déplié, la liste des consoles tombait à ~40 px (une ligne : banc apercu-pc du 13/11, colonne fusionnée avec les volets
  // paperclip et comptes). Le formulaire se replie alors jusqu'à 1300 px de haut : la liste retrouve ~260 px.
  const basReel3 = useMedia('(max-height: 1300px)')
  const couche = useMedia('(orientation: landscape) and (max-height: 520px)') // reel : téléphone debout seulement
  const rollRef = useRef(null)
  const suite = useSuite(rollRef, consoles)
  const demandes = useDemandes() // volet quota : budget atteint, lancement à valider
  const n = waiting.length + teams.filter(equipeAttend).length + demandes.length // une équipe prête à livrer, ou qui t'appelle, t'attend aussi ; et les demandes du volet quota
  const aValider = memoire.reduce((s, m) => s + (m.proposes || 0), 0) // propositions de faits, tous projets
  // Les fermées à part (onglet « Historique », 16/11) : la liste, ses groupes, ses compteurs et ses raccourcis ne comptent
  // que les autres.
  const fermees = useMemo(() => consoles.filter((c) => c.status === 'closed').sort((a, b) => (b.since ?? 0) - (a.since ?? 0)), [consoles])
  const ouvertes = useMemo(() => consoles.filter((c) => c.status !== 'closed'), [consoles])
  const k = (...ss) => ouvertes.filter((c) => ss.includes(c.status)).length
  const autres = [
    [k('error'), 'en erreur'],
    [k('fini'), k('fini') > 1 ? 'finies' : 'finie'],
    [k('working'), k('working') > 1 ? 'travaillent' : 'travaille'],
    [k('starting', 'running'), 'en cours'],
    [k('ready'), k('ready') > 1 ? 'prêts' : 'prêt'],
    [k('shell'), 'shell'],
  ].filter(([v]) => v > 0)
  // Une équipe se lit d'un bloc : son capitaine, puis ses équipiers. Ce qui t'attend d'abord (une console qui pose une
  // question, une équipe prête à livrer ou dont un membre pose une question), le plus ancien en tête ; puis les autres
  // équipes ; puis les consoles seules, par urgence et par ordre d'arrivée.
  const blocs = teams
    .map((team) => {
      const membres = ouvertes.filter((c) => c.team === team.id).sort((a, b) => Number(!!b.chief) - Number(!!a.chief) || a.createdAt - b.createdAt)
      return { team, membres, t: Math.min(pretAVoir(team) ? team.pret.at : Infinity, appelAVoir(team) ? team.appel.at : Infinity, ...membres.filter((c) => c.status === 'needs').map((c) => c.since)) }
    })
    .filter((b) => b.membres.length || equipeAttend(b.team)) // une équipe dont tout l'équipage est fermé : dans l'historique
  const seules = ouvertes.filter((c) => !teams.some((t) => t.id === c.team))
  const toutes = [
    ...[...seules.filter((c) => c.status === 'needs').map((c) => ({ c, t: c.since })), ...blocs.filter((b) => b.t < Infinity)].sort((a, b) => a.t - b.t),
    ...blocs.filter((b) => b.t === Infinity).sort((a, b) => a.team.createdAt - b.team.createdAt),
    ...seules.filter((c) => c.status !== 'needs').sort((a, b) => statusOf(a.status).rank - statusOf(b.status).rank || a.createdAt - b.createdAt).map((c) => ({ c })),
  ]
  // Carte de mission : la liste filtrée par ce que font les consoles. Une équipe reste entière dès qu'un des siens y est.
  const [tri, setTri] = useState('tout')
  const dans = (g, c) => GROUPES[g].etats.includes(c.status)
  const compte = (g) => ouvertes.filter((c) => dans(g, c)).length + (g === 'attend' ? teams.filter(equipeAttend).length + demandes.length : 0)
  const groupes = Object.keys(GROUPES).filter((g) => compte(g) > 0)
  // L'onglet est toujours là (Orkun, 16/11 : « je ne vois toujours pas la partie historique » — il n'y avait aucune fermée).
  const historique = tri === 'historique'
  const filtre = tri !== 'tout' && groupes.includes(tri) ? tri : 'tout' // un groupe qui se vide rend la liste entière
  // X (touche seule) n'est plus le filtre suivant : décision d'Orkun du 17/11 (raccourcis-4 : « Vue carte de mission »),
  // une vue à part (Mission.jsx). Les onglets de la liste restent au clic.
  const enCours = filtre === 'tout' ? toutes : toutes.filter((l) => (l.team ? l.membres.some((c) => dans(filtre, c)) || (filtre === 'attend' && equipeAttend(l.team)) : dans(filtre, l.c)))
  const lignes = historique ? fermees.map((c) => ({ c })) : enCours
  // Alt+1…9 : les consoles ouvertes de la liste, même quand l'historique est affiché (une console fermée n'est pas à piloter).
  if (ordreRef) ordreRef.current = enCours.flatMap((l) => (l.team ? l.membres.map((c) => c.id) : [l.c.id]))
  // La plus ancienne attente : la console à ouvrir quand on touche le compteur.
  const tete = toutes[0]
  const premiere = tete?.c?.id ?? tete?.membres?.find((c) => c.status === 'needs')?.id ?? tete?.membres?.[0]?.id
  // Volet quota : la plus ancienne demande compte pour « depuis » ; quand rien d'autre n'attend, le compteur mène à sa console.
  const vieille = demandes.reduce((a, d) => (!a || d.at < a.at ? d : a), null)
  const depuis = Math.min(tete?.t ?? Infinity, vieille?.at ?? Infinity)
  const versAttente = tete?.t < Infinity ? premiere : (consoleDeDemande(vieille) ?? premiere)
  // Reel (11/11) : sur téléphone, la plus ancienne attente prend la scène (et quitte la liste), la liste se range par
  // projet. `?reel=non` rend l'écran d'avant.
  const reel = mobile && look.reel === 'oui' && !couche
  // Volet design-3-plans (`?reel3=oui`) : la même scène et la même liste par projet sur l'ordinateur et le téléphone
  // couché (lot-design/colonne.css, sous `.rail.reel3`). Le téléphone debout reste à `reel`.
  const reel3 = look.reel3 === 'oui' && (!mobile || couche)
  const scene = (reel || reel3) && n > 0 && tete && tete.t < Infinity ? tete : null
  const liste = scene && scene.c ? lignes.filter((l) => l !== scene) : lignes
  // Alt+1…9 suivent l'ordre affiché : la scène d'abord, puis les groupes de projet.
  if (ordreRef && reel3) ordreRef.current = [...(scene?.c ? [scene] : []), ...parProjet(scene?.c ? enCours.filter((l) => l !== scene) : enCours).flatMap((g) => g.lignes)].flatMap((l) => (l.team ? l.membres.map((c) => c.id) : [l.c.id]))
  // Limite d'usage atteinte (« Plusieurs comptes Claude / Codex ») : le bandeau « Relancer sur le compte N » dans une
  // rangée à lui, sous la ligne. Pas dans la rangée de la ligne : le « ⋯ » s'y centre sur la hauteur (lot3-menus.css),
  // il glisserait sous le bandeau. Une console d'équipe n'en a jamais (toujours le compte 1).
  const rendLigne = (l) =>
    l.team ? (
      <Equipe key={l.team.id} team={l.team} membres={l.membres} activeId={activeId} onPick={onPick} actions={actions} />
    ) : (
      <Fragment key={l.c.id}>
        <li>
          <Ligne c={l.c} active={activeId === l.c.id} onPick={onPick} actions={actions} voisines={consoles} />
        </li>
        {l.c.quota && (
          <li>
            <QuotaRelais c={l.c} actions={actions} onPick={onPick} />
          </li>
        )}
      </Fragment>
    )
  return (
    <aside className={cls('rail', reel3 && 'reel3')}>
      <header className="marque">
        <i className="marque-signe" />
        <b>meydan</b>
        {/* Ordinateur : « Ordre » et « Ranger » ne tiennent à côté du texte de liaison que si celui-ci se réduit à son
            point (texte au survol) tant que tout va bien. Coupée, la liaison reprend son texte et « Ranger » se retire
            (rien ne pourrait s'enregistrer). « Mémoire » (11/11) est une icône et son nombre (nom au survol) : mesuré
            au banc, son mot ne tient ni dans les 304 px de l'ordinateur ni dans les 390 du téléphone dès qu'un nombre
            s'y ajoute (8,7 px de reste sans nombre, -2,7 liaison coupée). Sur l'ordinateur, « Ordre » passe aussi à
            l'icône : le carré de la marque était déjà écrasé à 2-3 px avant la mémoire ; « Ranger » garde son mot. */}
        <span className={cls('liaison', !online && 'is-coupee', online && !mobile && 'est-point')} title={online && !mobile ? 'VPS · en ligne' : undefined}>
          {online ? 'VPS · en ligne' : 'liaison coupée…'}
        </span>
        <BoutonOrdre actions={actions} court={!mobile} />
        <BoutonMemoire actions={actions} n={aValider} court />
        {!mobile && online && <BoutonRanger actions={actions} n={ouvertes.length} />}
      </header>
      {scene ? (
        <Scene tete={scene} n={n} now={now} onPick={onPick} actions={actions} voisines={consoles} />
      ) : (
      <button
        type="button"
        className={cls('appel', !n && 'is-vide', n >= 10 && 'is-long')}
        disabled={!n}
        onClick={() => versAttente && onPick(versAttente)}
        title={n ? 'Aller à la plus ancienne attente' : undefined}
      >
        <span className="appel-n">{n}</span>
        <span className="appel-t">
          <b>
            {n ? (
              n > 1 ? "T'ATTENDENT" : "T'ATTEND"
            ) : (
              <>
                PERSONNE
                <br />
                NE T'ATTEND
              </>
            )}
          </b>
          {n > 0 && depuis < Infinity && <em>depuis {since(depuis, now)}</em>}
          {groupes.length < 2 && autres.length > 0 && (
            <small>
              {autres.map(([v, t]) => (
                <span key={t}>
                  {v} {t}
                </span>
              ))}
            </small>
          )}
        </span>
      </button>
      )}
      {bascule}
      {mobile && <InviteAlertes />}
      {consoles.length > 0 && (
        <nav className="tri" aria-label="Filtrer les consoles">
          <button type="button" aria-pressed={!historique && filtre === 'tout'} onClick={() => setTri('tout')}>
            Tout <b>{ouvertes.length}</b>
          </button>
          {groupes.length >= 2 &&
            groupes.map((g) => (
              <button key={g} type="button" className={`tri-${g}`} aria-pressed={!historique && filtre === g} onClick={() => setTri(!historique && filtre === g ? 'tout' : g)}>
                {GROUPES[g].nom} <b>{compte(g)}</b>
              </button>
            ))}
          <button type="button" className="tri-historique" aria-pressed={historique} onClick={() => setTri(historique ? 'tout' : 'historique')}>
            Historique <b>{fermees.length}</b>
          </button>
        </nav>
      )}
      <ul className={cls('roll', (reel || reel3) && !historique && 'par-projet', historique && 'est-historique')} ref={rollRef} data-suite={suite.n > 0 || undefined}>
        {!historique && (filtre === 'tout' || filtre === 'attend') && <DemandesBudget onPick={onPick} />}
        {historique && <Historique fermees={fermees} ouvertes={ouvertes} actions={actions} />}
        {historique
          ? liste.map(rendLigne)
          : reel || reel3
          ? parProjet(liste).flatMap((g) => [
              g.nom && (
                <li key={`t-${g.clef}`} className="projet-tete" aria-hidden="true">
                  <span>{g.nom}</span>
                  <i>{g.lignes.length}</i>
                </li>
              ),
              ...g.lignes.map(rendLigne),
            ])
          : lignes.map(rendLigne)}
        {/* Téléphone : la barre des filtres défile de côté et l'onglet « Historique », rangé au bout, sortait de l'écran
            (essai du 16/11 à 390 px) ; une ligne au bas de la liste y mène. */}
        {mobile && !historique && fermees.length > 0 && (
          <li className="histo-bas-li">
            <button
              type="button"
              className="histo-bas"
              onClick={() => {
                setTri('historique')
                rollRef.current?.scrollTo?.({ top: 0 })
              }}
            >
              Historique · {fermees.length} {fermees.length > 1 ? 'fermées' : 'fermée'}
              <span aria-hidden="true">›</span>
            </button>
          </li>
        )}
        {/* Ateliers (téléphone) : à la fin de la liste, dans son défilement — aucune place prise aux consoles ; la bande
            « + N plus bas » ne compte que les consoles (.rang, .carte), les raccourcis suivent `lignes`. */}
        {mobile && <AteliersListe />}
      </ul>
      {look.repere === 'ligne' && suite.n > 0 && (
        <p className="roll-suite">
          <span>+ {suite.n} plus bas</span>
          {suite.needs > 0 && (
            <b>
              {suite.needs} {suite.needs > 1 ? "t'attendent" : "t'attend"}
            </b>
          )}
        </p>
      )}
      {/* Replié aussi sur un écran d'ordinateur bas (un portable 1366 × 768, ou Chrome sur un 1080p) : la liste sert de
          « switch » à la console agrandie et ne montrait plus qu'une ou deux lignes sous le formulaire (banc du 11/11). */}
      {/* Suggestions, Alertes et Musique : un seul bloc (sur une rangée sous `?agencement=b`, agencement.css). */}
      <div className="rail-utiles">{musique}</div>
      {/* L'usage des comptes (« Plusieurs comptes Claude / Codex ») : sur l'ordinateur, posé sur le plateau (Board.jsx),
          plus dans la colonne — intégration du 11/11 : la liste, qui sert de « switch » à la console agrandie, n'avait plus
          la place. Téléphone : dans le pli ouvert, SOUS le bouton « Fermer » (`pied`) : ouvert sur un petit téléphone
          (375 × 667), il poussait sinon « Fermer » hors de l'écran. */}
      <Composer onCreated={onCreated} rev fold={mobile || bas || (reel3 && basReel3)} extra={<Apparence look={look} setLook={setLook} />} pied={mobile && <Comptes compact />} />
    </aside>
  )
}

// Le bouton de la barre de commande (Ordre.jsx), en tête de la liste et de la colonne du téléphone couché.
export function BoutonOrdre({ actions, court = false }) {
  if (!actions?.ouvreOrdre) return null
  return (
    <button type="button" className={cls('ordre-ouvre', court && 'est-court')} onClick={actions.ouvreOrdre} aria-label="Donner un ordre à tes consoles" title="Donner un ordre (lance, dis à, interromps, ferme, relance)">
      <i aria-hidden="true">›_</i>
      {!court && 'Ordre'}
    </button>
  )
}

// Ordinateur : « Ranger » regroupe les consoles par équipe et par projet, chacune dans son cadre (Board.jsx, rangement.js) (Orkun, 11/11 : « Un bouton pour
// tous les organiser facilement »). Dans la colonne et pas sur le plateau : sur une mosaïque, chaque coin du plateau
// couvre une console. Pendant 10 s il devient « Annuler » (places, tailles et cadrage d'avant) ; « Rangé » 2,5 s quand
// tout était déjà en place (le cadrage seul est remis).
export function BoutonRanger({ actions, n }) {
  const [fait, setFait] = useState(null) // null | { rien: true } | { avant, vue }
  useEffect(() => {
    if (!fait) return
    const t = setTimeout(() => setFait(null), fait.rien ? 2500 : 10000)
    return () => clearTimeout(t)
  }, [fait])
  if (!actions?.ranger || !n) return null
  const annulable = !!fait?.avant
  const clic = () => {
    if (!annulable) return setFait(actions.ranger())
    actions.annuleRange(fait)
    setFait(null)
  }
  return (
    <button
      type="button"
      className={cls('ranger-ouvre', annulable && 'est-annuler')}
      onClick={clic}
      title={annulable ? 'Remettre les consoles comme avant' : 'Ranger : chaque projet et chaque équipe dans son cadre, le capitaine au centre'}
    >
      <i aria-hidden="true" />
      {annulable ? 'Annuler' : fait?.rien ? 'Rangé' : 'Ranger'}
    </button>
  )
}

export function Rail(props) {
  usePrechargeCopies(props.consoles) // « Continuer dans une copie » su avant l'ouverture d'un menu (volet copies)
  return props.look.theme === 'reverbere' ? <RailReverbere {...props} /> : <RailTapis {...props} />
}
