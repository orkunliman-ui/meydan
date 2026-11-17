// Volet « quota » (17/11/2026) — l'interface. Demande d'Orkun, mot pour mot : « Go pour tout », sur « Le quota par
// console et le coût par agent, si tu les veux » (Paperclip : « quota par console avec une alerte à 80 % » et « coût par
// agent avec une validation avant d'exécuter »). Contrat : docs/volets/quota.md ; magasin : budget.js.
// Tout montant est un ÉQUIVALENT prix public de l'API (Orkun est au forfait), écrit « éq. API » partout ; Codex n'a aucun
// prix : il se compte en jetons. Au palier, JAMAIS d'arrêt : une demande dans T'ATTEND, rien de plus.
// Ce fichier vit dans le morceau principal ET dans celui du plateau : il n'importe que react, react-dom, lib.js, Signe.jsx
// et budget.js (jamais Board, Carte ni @xyflow, leçons 200 et 207). Aucune animation. Styles : budget.css.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clamp, cls, useEchap } from './lib.js'
import { Age, Signe } from './Signe.jsx'
import { lisDemande, regleBudget, regleEquipe, repondDemande, useBudget, useDemandes } from './budget.js'
import './budget.css'

export { useDemandes }

// ── Mise en forme (français : virgule décimale, espace insécable avant l'unité) ──
const NB = ' '
const nf = (n) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: n, maximumFractionDigits: n })
const [f0, f1, f2] = [nf(0), nf(1), nf(2)]
// 512 · 8,4 k · 56 k · 1,24 M · 12,4 M · 1 234 M
function jetons(n) {
  n = Number(n) || 0
  if (n >= 999_500) {
    const v = n / 1e6
    return `${(v < 9.995 ? f2 : v < 99.95 ? f1 : f0).format(v)}${NB}M`
  }
  if (n >= 999.5) {
    const v = n / 1e3
    return `${(v < 9.95 ? f1 : f0).format(v)}${NB}k`
  }
  return f0.format(n)
}
// « 3,40 $ » ; sans centimes à partir de 100 $ (« 1 157 $ », comme le panneau des comptes).
const motJetons = (n) => (Number(n) >= 2 ? 'jetons' : 'jeton')
const dollars = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${(n >= 100 ? f0 : f2).format(n)}${NB}$` : '—')
const pourcent = (part) => `${Math.floor((Number(part) || 0) * 100)}${NB}%`
// Orange à 80 %, couleur d'appel à 100 % (budget.css).
const niveau = (b) => (!b ? '' : b.part >= 1 ? 'est-atteint' : b.part >= 0.8 ? 'est-haut' : '')
const montantDe = (b) => (b.unite === 'jetons' ? `${jetons(b.montant)} ${motJetons(b.montant)}` : dollars(b.montant))
const utiliseDe = (b) => (b.unite === 'jetons' ? `${jetons(b.utilise)} ${motJetons(b.utilise)}` : dollars(b.utilise))
// « claude-opus-5-5 » → « Opus 5.5 » ; un autre modèle garde son nom.
function nomModele(m = '') {
  const x = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(m)
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m
}
// Le montant tapé : « 5 », « 5,50 », « 2 000 », et pour des jetons « 2 M » ou « 500 k ». NaN si ce n'est pas un nombre.
function lisMontant(texte, unite) {
  const s = String(texte).replace(/[\s  ]/g, '').replace(',', '.').replace(/\$$/, '')
  const m = /^(\d+(?:\.\d*)?|\.\d+)([kKmM]?)$/.exec(s)
  if (!m || (m[2] && unite !== 'jetons')) return NaN
  return Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1)
}
const ecrisMontant = (b) => (b ? String(b.montant).replace('.', ',') : '')

// La console qu'une demande désigne (toucher sa carte l'ouvre) : la console au budget atteint, ou le capitaine qui demande
// un lancement. Le budget d'une ÉQUIPE ne désigne aucune console (le contrat n'y met pas le capitaine) : rien à ouvrir.
export function consoleDeDemande(d) {
  if (!d) return null
  if (d.type === 'lancement') return d.chef || null
  return typeof d.cible === 'string' && d.cible.startsWith('c:') ? d.cible.slice(2) : null
}

// ── Le panneau qui s'ouvre au clic : posé PAR-DESSUS l'écran (portail dans <body>), jamais dans la colonne ni dans la barre
// (la colonne est une pile de hauteur fixe, leçon 233 ; la barre de la dalle est contre-zoomée et rogne). Ordinateur : sous
// ce qu'on a touché, ou à droite de la colonne (`cote`). Téléphone : en haut de l'écran, sur toute la largeur (le clavier
// vient d'en bas). Se ferme par « Fermer », Échap ou un toucher à côté.
function Panneau({ ancre, cote, titre, onClose, children }) {
  const boite = useRef(null)
  const pose = useRef(false)
  const [pos, setPos] = useState(null)
  useEchap(onClose)
  useLayoutEffect(() => {
    const place = () => {
      const el = boite.current
      const a = ancre?.isConnected ? ancre.getBoundingClientRect() : null
      if (!el) return
      const W = innerWidth, H = window.visualViewport?.height ?? innerHeight
      const w = el.offsetWidth, h = el.offsetHeight
      let left, top
      if (W <= 760 || !a) [left, top] = [12, 12]
      else {
        const rail = cote ? ancre.closest('.rail')?.getBoundingClientRect() : null
        left = rail ? rail.right + 12 : a.left
        top = rail ? a.top : a.bottom + 8 + h <= H - 8 ? a.bottom + 8 : a.top - 8 - h
      }
      const neuf = { left: Math.round(clamp(left, 8, Math.max(8, W - w - 8))), top: Math.round(clamp(top, 8, Math.max(8, H - h - 8))) }
      setPos((p) => (p && p.left === neuf.left && p.top === neuf.top ? p : neuf))
    }
    place()
    addEventListener('resize', place)
    return () => removeEventListener('resize', place)
  })
  // Les événements d'un portail remontent quand même l'arbre React (barre de la dalle, en-tête d'équipe) : arrêtés ici.
  const stop = (e) => e.stopPropagation()
  return createPortal(
    <div
      className="budget-fond"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        pose.current = true
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (pose.current && e.target === e.currentTarget) onClose()
        pose.current = false
      }}
      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())}
    >
      <section ref={boite} className="budget-panneau" role="dialog" aria-label={titre} style={pos ?? { visibility: 'hidden' }} onPointerDown={stop} onClick={stop} onContextMenu={stop} onKeyDown={stop} onDoubleClick={stop}>
        <header className="budget-panneau-tete">
          <h2 title={titre}>{titre}</h2>
          <button type="button" className="budget-ferme" onClick={onClose}>
            Fermer
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  )
}

// Le réglage d'un budget : montant, unité, Enregistrer / Retirer. `unites` : celles que la cible accepte (Codex : jetons).
function ReglageBudget({ cible, b, unites, defaut }) {
  const [texte, setTexte] = useState(() => ecrisMontant(b))
  const [unite, setUnite] = useState(b?.unite || defaut)
  const [busy, setBusy] = useState('')
  const [erreur, setErreur] = useState('')
  const [fait, setFait] = useState('')
  const envoie = async (montant) => {
    setBusy(montant === null ? 'retire' : 'pose')
    setErreur('')
    setFait('')
    try {
      await regleBudget(cible, montant, unite)
      setFait(montant === null ? 'Budget retiré.' : 'Budget enregistré.')
      if (montant === null) setTexte('')
    } catch (e) {
      setErreur(e.message || 'le serveur a refusé')
    } finally {
      setBusy('')
    }
  }
  const pose = (e) => {
    e.preventDefault()
    const v = lisMontant(texte, unite)
    if (!(v > 0) || !Number.isFinite(v)) return setErreur(unite === 'jetons' ? 'Montant invalide : un nombre de jetons plus grand que 0 (ex. 2 M).' : 'Montant invalide : un nombre plus grand que 0 (ex. 5 ou 12,50).')
    envoie(v)
  }
  return (
    <form className="budget-form" onSubmit={pose}>
      <div className="budget-champs">
        <label className="budget-montant">
          <span>Budget</span>
          <input type="text" inputMode="decimal" autoComplete="off" enterKeyHint="done" aria-label="Montant du budget" placeholder={unite === 'jetons' ? 'ex. 2 M' : 'ex. 5'} value={texte} onChange={(e) => setTexte(e.target.value)} />
        </label>
        {unites.length > 1 ? (
          <select aria-label="Unité du budget" value={unite} onChange={(e) => setUnite(e.target.value)}>
            {unites.map((u) => (
              <option key={u} value={u}>
                {u === 'usd' ? '$ éq. API' : 'jetons'}
              </option>
            ))}
          </select>
        ) : (
          <span className="budget-unite">{unite === 'usd' ? '$ éq. API' : 'jetons'}</span>
        )}
      </div>
      <div className="budget-actions">
        <button type="submit" className="budget-oui" disabled={!!busy}>
          {busy === 'pose' ? 'Envoi…' : 'Enregistrer'}
        </button>
        {b && (
          <button type="button" className="budget-non" disabled={!!busy} onClick={() => envoie(null)}>
            {busy === 'retire' ? 'Retrait…' : 'Retirer'}
          </button>
        )}
      </div>
      {b && (
        <p className={cls('budget-etat', niveau(b))}>
          Utilisé : {utiliseDe(b)} sur {montantDe(b)} · {pourcent(b.part)}
          {b.repondu ? ' · « Continuer » déjà donné pour ce montant' : ''}
        </p>
      )}
      {fait && !erreur && (
        <p className="budget-fait" role="status">
          {fait}
        </p>
      )}
      {erreur && (
        <p className="budget-erreur" role="alert">
          {erreur}
        </p>
      )}
      <p className="budget-note">À 80 % : une notification et la pastille orange. À 100 % : « Budget atteint — continuer ? » dans T’ATTEND. Rien n’est jamais arrêté.</p>
    </form>
  )
}

// ── Pastille d'une console : « 1,24 M · 3,40 $ éq. API » (Claude), « 1,24 M jetons » (Codex), « · 68 % » avec un budget.
// `ou` : 'dalle' (barre de la dalle), 'plein' (console agrandie), 'tel' (en-tête de l'écran de la console du téléphone,
// couché ou « Tapis »), 'bande' (bandeau d'état de cet écran, téléphone debout : l'en-tête n'y a pas la place).
// Rien pour un shell, un agent qui n'est ni Claude ni Codex, ou tant que le moteur n'a rien compté (0 jeton, sans budget).
// Les morceaux sont des <i> à classes (pas des <span> : le bandeau d'état du téléphone colore ses `span`) ; budget.css
// retire « éq. API » puis les jetons quand la barre est étroite.
export function UsageConsole({ c, ou = 'dalle' }) {
  const { usages, budgets } = useBudget()
  const [ancre, setAncre] = useState(null)
  const u = c ? usages[c.id] : null
  const b = c ? budgets[`c:${c.id}`] : null
  // Rien compté encore (console neuve, conversation sans réponse) et pas de budget : pas de « 0 · 0,00 $ » partout.
  if (!u || (c.kind !== 'claude' && c.kind !== 'codex') || (!(u.total > 0) && !b)) return null
  const claude = u.kind !== 'codex' && c.kind !== 'codex'
  const cout = dollars(u.cout) // « au moins » : le signe est posé devant les jetons quand l'usage est partiel
  const entier = `${u.partiel ? '≥ ' : ''}${jetons(u.total)}${claude ? ` · ${cout} éq. API` : ` ${motJetons(u.total)}`}${b ? ` · ${pourcent(b.part)}` : ''}`
  return (
    <>
      <button
        type="button"
        className={cls('usage-pastille nodrag nopan', `usage-${ou}`, niveau(b), claude ? 'est-claude' : 'est-codex')}
        aria-label={`Usage : ${entier}${claude ? ' (équivalent prix public de l’API)' : ''}`}
        aria-expanded={!!ancre}
        title={`${entier}${claude ? ' — équivalent prix public de l’API' : ''}${b ? ` — budget ${montantDe(b)}` : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setAncre(ancre ? null : e.currentTarget)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {claude ? (
          <>
            <i className="usage-jetons">{jetons(u.total)}</i>
            <i className="usage-sep"> · </i>
            <i className="usage-cout">{cout}</i>
            <i className="usage-eq"> éq. API</i>
          </>
        ) : (
          <>
            <i className="usage-cout">{jetons(u.total)}</i>
            <i className="usage-eq"> {motJetons(u.total)}</i>
          </>
        )}
        {b && <i className="usage-part"> · {pourcent(b.part)}</i>}
      </button>
      {ancre && (
        <Panneau ancre={ancre} titre={`Usage · ${c.name}`} onClose={() => setAncre(null)}>
          <DetailUsage u={u} claude={claude} />
          <ReglageBudget key={`c:${c.id}`} cible={`c:${c.id}`} b={b} unites={claude ? ['usd', 'jetons'] : ['jetons']} defaut={claude ? 'usd' : 'jetons'} />
        </Panneau>
      )}
    </>
  )
}

// Le détail d'un usage : total, entrée / sortie / cache, modèles (dont le conseiller), conversations.
function DetailUsage({ u, claude }) {
  const modeles = Array.isArray(u.modeles) ? u.modeles.filter((m) => m && m.total > 0) : []
  const n = Number(u.conversations) || 0
  return (
    <div className="usage-detail">
      <p className="usage-total">
        {u.partiel ? 'au moins ' : ''}{jetons(u.total)} {motJetons(u.total)}{claude ? ` · ${dollars(u.cout)} éq. API` : ''}
      </p>
      <dl className="usage-parts">
        {[
          ['Entrée', u.entree],
          ['Sortie', u.sortie],
          ['Cache lu', u.cacheLu],
          ['Cache écrit', u.cacheEcrit],
        ].map(([t, v]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{jetons(v)}</dd>
          </div>
        ))}
      </dl>
      {modeles.length > 0 && (
        <ul className="usage-modeles" aria-label="Modèles">
          {modeles.map((m) => (
            <li key={`${m.modele}-${m.conseiller ? 'c' : 't'}`}>
              <span className="usage-modele" title={m.modele}>
                {nomModele(m.modele)}
                {m.conseiller ? ' · conseiller' : ''}
              </span>
              <span>
                {jetons(m.total)}
                {claude ? ` · ${dollars(m.cout)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="usage-pied">
        {n} conversation{n > 1 ? 's' : ''}
        {Number(u.messages) > 0 ? ` · ${f0.format(u.messages)} réponse${u.messages > 1 ? 's' : ''}` : ''}
        {u.partiel ? ' · au moins : modèle sans prix, ligne illisible, journal raccourci ou trop de sous-agents' : ''}
      </p>
      <p className="usage-note">{claude ? 'Équivalent prix public de l’API, pas ce que tu paies au forfait.' : 'Codex : forfait ChatGPT, aucun prix connu. Compté en jetons.'}</p>
    </div>
  )
}

// ── Une équipe : UNE ligne dans son en-tête (la colonne est une pile de hauteur fixe, leçon 233) — total, budget et %,
// « Codex non chiffré » s'il le faut ; au clic, le budget de l'équipe et « Valider les lancements », à côté de la colonne.
// Visible dès que le moteur a répondu, même sans usage : sinon « Valider les lancements » serait hors d'atteinte.
export function UsageEquipe({ team }) {
  const { pret, equipes, budgets, reglages } = useBudget()
  const [ancre, setAncre] = useState(null)
  if (!pret || !team) return null
  const u = equipes[team.id]
  const b = budgets[`e:${team.id}`]
  const valider = !!reglages[team.id]?.valider
  const total = !(u?.total > 0) ? 'pas encore d’usage' : b?.unite === 'jetons' || u.cout === null ? `${jetons(u.total)} ${motJetons(u.total)}` : `${u.partiel ? '≥ ' : ''}${dollars(u.cout)} éq. API`
  const morceaux = [b ? `${pourcent(b.part)} de ${montantDe(b)}` : null, total, u?.codex ? 'Codex non chiffré' : null, valider ? 'lancements à valider' : null].filter(Boolean)
  const ligne = morceaux.join(' · ')
  return (
    <>
      <button type="button" className={cls('usage-equipe', niveau(b))} aria-expanded={!!ancre} title={`Usage de l’équipe : ${ligne}`} onClick={(e) => setAncre(ancre ? null : e.currentTarget)}>
        <span className="usage-equipe-t">{ligne}</span>
        <i aria-hidden="true">›</i>
      </button>
      {ancre && (
        <Panneau ancre={ancre} cote titre={`Équipe · ${team.nom}`} onClose={() => setAncre(null)}>
          <div className="usage-detail">
            <p className="usage-total">{u ? `${jetons(u.total)} ${motJetons(u.total)} · ${u.cout === null ? 'non chiffré' : `${u.partiel ? '≥ ' : ''}${dollars(u.cout)} éq. API`}` : 'Pas encore d’usage compté.'}</p>
            {u && (
              <p className="usage-pied">
                {Number(u.membres) || 0} membre{u.membres > 1 ? 's' : ''} compté{u.membres > 1 ? 's' : ''}
                {u.codex ? ' · des membres Codex ne sont pas chiffrés (aucun prix)' : ''}
              </p>
            )}
            <p className="usage-note">Équivalent prix public de l’API, pas ce que tu paies au forfait.</p>
          </div>
          <ReglageBudget key={`e:${team.id}`} cible={`e:${team.id}`} b={b} unites={['usd', 'jetons']} defaut="usd" />
          <CaseValiderEquipe team={team} valider={valider} />
        </Panneau>
      )}
    </>
  )
}

function CaseValiderEquipe({ team, valider }) {
  const [busy, setBusy] = useState(false)
  const [erreur, setErreur] = useState('')
  const change = async (v) => {
    setBusy(true)
    setErreur('')
    try {
      await regleEquipe(team.id, v)
    } catch (e) {
      setErreur(e.message || 'le serveur a refusé')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="budget-valider">
      <label>
        <input type="checkbox" checked={valider} disabled={busy} onChange={(e) => change(e.target.checked)} /> Valider les lancements
      </label>
      <small>Chaque équipier que le capitaine veut lancer t’attend d’abord : Accepter ou Refuser.</small>
      {erreur && (
        <p className="budget-erreur" role="alert">
          {erreur}
        </p>
      )}
    </div>
  )
}

// La case du formulaire « Nouvelle équipe » (Rail.jsx, Composer), sur la rangée de « Vérifier à la fin · Codex ».
export function CaseValider({ checked, onChange }) {
  return (
    <label className="verification-reglage budget-case" title="Chaque équipier que le capitaine veut lancer t’attend d’abord dans T’ATTEND : Accepter ou Refuser">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Valider les lancements
    </label>
  )
}

// ── Ce qui t'attend du volet : des cartes pleines, comme celles d'une console qui t'attend (mêmes classes `carte-*`, donc
// les mêmes looks de chaque thème). Les gestes sont des boutons À CÔTÉ de la zone qui ouvre la console (jamais un bouton
// dans un bouton). Aucun élément quand rien n'attend.
export function DemandesBudget({ onPick }) {
  const demandes = useDemandes()
  return demandes.map((d) => (
    <li key={d.id} className="budget-li">
      <CarteDemande d={d} onPick={onPick} />
    </li>
  ))
}

function CarteDemande({ d, onPick }) {
  const [busy, setBusy] = useState('')
  const [erreur, setErreur] = useState('')
  const id = consoleDeDemande(d)
  const lancement = d.type === 'lancement'
  // Relecture de sécurité : « Accepter » ne doit pas valider un texte qu'Orkun ne peut pas lire en entier. Au-delà du
  // résumé (300 caractères), la tâche entière se déplie sous la carte, lue au serveur telle qu'elle partira.
  const [entiere, setEntiere] = useState(null)
  const [lit, setLit] = useState(false)
  const [luEntiere, setLuEntiere] = useState(false) // la FIN de la tâche entière a été vue à l'écran au moins une fois
  // Le résumé est la tâche aux blancs resserrés et coupée à 300 caractères : dès qu'il diffère de la tâche (longueur), la
  // tâche entière se déplie, et « Accepter » attend qu'elle ait été affichée (relecture de sécurité du 17/11 : une
  // consigne pouvait se cacher derrière le résumé, et le résumé coupé à deux lignes ne la montrait pas).
  // Seconde relecture : comparer des longueurs ne suffit pas (la normalisation du résumé allonge certaines lettres) ; le
  // serveur dit lui-même si le résumé est EXACTEMENT la tâche (`complet`). Absent : incomplet.
  const tronquee = lancement && d.complet !== true
  // « Accepter » ne s'ouvre qu'une fois la FIN de la tâche passée à l'écran (repère après le texte), pas au simple dépli :
  // une consigne pouvait se cacher 200 écrans plus bas, derrière des lignes de points (seconde relecture du 17/11).
  const fin = useRef(null)
  useEffect(() => {
    const el = fin.current
    if (!el || luEntiere || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setLuEntiere(true))
    io.observe(el)
    return () => io.disconnect()
  }, [entiere, luEntiere])
  const deplie = async () => {
    if (entiere !== null) return setEntiere(null)
    setLit(true)
    setErreur('')
    try {
      const r = await lisDemande(d.id)
      setEntiere(typeof r?.tache === 'string' ? r.tache : '')
    } catch (e) {
      setErreur(e.message || 'tâche illisible')
    } finally {
      setLit(false)
    }
  }
  const agit = async (choix) => {
    if (busy) return
    setBusy(choix)
    setErreur('')
    try {
      await repondDemande(d.id, choix)
    } catch (e) {
      setErreur(e.message || 'le serveur a refusé')
      setBusy('')
    }
  }
  const corps = (
    <>
      <span className="carte-haut">
        <Signe status="needs" />
        <b>{d.nom}</b>
        <Age since={d.at} />
      </span>
      <span className="carte-q">{lancement ? `Lancer « ${d.equipier} » ?` : d.texte || 'Budget atteint — continuer ?'}</span>
      {/* Rôle, dossier (réel, tel qu'il sera ouvert) et base : en entier, jamais coupés par des points de suspension. */}
      {lancement && (
        <span className="budget-demande-champs">
          rôle {d.role}
          {d.dossier ? ` · dossier ${d.dossierReel || d.dossier}` : ''}
          {d.base ? ` · base ${d.base}` : ''}
        </span>
      )}
      {(lancement ? d.resume : d.detail) && <span className="budget-resume">{lancement ? d.resume : d.detail}</span>}
      <span className="carte-bas">
        <span>{lancement ? 'lancement à valider' : 'budget · rien n’est arrêté'}</span>
      </span>
    </>
  )
  return (
    <div className={cls('carte budget-carte', lancement ? 'est-lancement' : 'est-budget')}>
      {id ? (
        <button type="button" className="budget-ouvre" title={lancement ? 'Ouvrir le capitaine' : 'Ouvrir la console'} onClick={() => onPick?.(id)}>
          {corps}
        </button>
      ) : (
        <div className="budget-ouvre">{corps}</div>
      )}
      {tronquee && (
        <button type="button" className="budget-deplie" aria-expanded={entiere !== null} disabled={lit} onClick={deplie}>
          {entiere !== null ? 'Replier la tâche' : `Lire la tâche entière (${Number(d.longueur).toLocaleString('fr-FR')} caractères)${luEntiere ? '' : ' pour accepter'}`}
        </button>
      )}
      {entiere !== null && (
        <>
          <pre className="budget-tache">{entiere}</pre>
          <span ref={fin} className="budget-tache-fin">{luEntiere ? 'fin de la tâche' : 'fin de la tâche : « Accepter » s’ouvre ici'}</span>
        </>
      )}
      <div className="budget-gestes">
        {lancement ? (
          <>
            <button type="button" className="budget-oui" disabled={!!busy || (tronquee && !luEntiere)} title={tronquee && !luEntiere ? 'Lis la tâche entière avant d’accepter' : undefined} onClick={() => agit('accepter')}>
              {busy === 'accepter' ? 'Lancement…' : 'Accepter'}
            </button>
            <button type="button" className="budget-non" disabled={!!busy} onClick={() => agit('refuser')}>
              {busy === 'refuser' ? 'Refus…' : 'Refuser'}
            </button>
          </>
        ) : (
          <button type="button" className="budget-oui" disabled={!!busy} onClick={() => agit('continuer')}>
            {busy ? 'Envoi…' : 'Continuer'}
          </button>
        )}
      </div>
      {erreur && (
        <p className="budget-erreur" role="alert">
          {lancement ? 'Pas fait' : 'Pas enregistré'} : {erreur}
        </p>
      )}
    </div>
  )
}

// ── Bandeau d'une console dont le budget est atteint : sur la dalle vue de près et sur l'écran de la console du
// téléphone. « Continuer » répond à la demande ; l'agent, lui, n'a jamais été arrêté.
export function BandeauBudget({ c }) {
  const demandes = useDemandes()
  const [busy, setBusy] = useState(false)
  const [erreur, setErreur] = useState('')
  const d = c ? demandes.find((x) => x.type === 'budget' && x.cible === `c:${c.id}`) : null
  if (!d) return null
  const continuer = async () => {
    if (busy) return
    setBusy(true)
    setErreur('')
    try {
      await repondDemande(d.id, 'continuer')
    } catch (e) {
      setErreur(e.message || 'le serveur a refusé')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="budget-bandeau nodrag nopan" aria-label="Budget atteint">
      <div className="budget-bandeau-texte">
        <p className="budget-bandeau-titre">{d.texte || 'Budget atteint — continuer ?'}</p>
        {d.detail && (
          <p className="budget-bandeau-detail" title={d.detail}>
            {d.detail}
          </p>
        )}
      </div>
      <div className="budget-bandeau-geste">
        <button type="button" className="budget-oui" disabled={busy} onClick={continuer}>
          {busy ? 'Envoi…' : 'Continuer'}
        </button>
        {erreur && (
          <p className="budget-erreur" role="alert">
            Pas enregistré : {erreur}
          </p>
        )}
      </div>
    </section>
  )
}
