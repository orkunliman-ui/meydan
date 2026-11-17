import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { record, transcribe } from './envoi.js'
import { api, cls, statusOf, useEchap, useMedia } from './lib.js'
import { filtre, insere, mentionEnCours, mentions } from './mention.js'
import './ordres.css'
import { useEtape } from './retour.js'

// La barre de commande : un ordre tapé ou dicté (« lance 2 claude dans meydan : relis tasks/todo.md », « dis à tous :
// faites le point », « interromps tout », « ferme les shells », « qui a fini ? », « @site relis le README »). Le serveur
// le comprend sans modèle de langue (lib/ordres.mjs) et montre ce qu'il va faire AVANT de le faire ; fermer, un texte
// risqué ou un plan qui ferme se confirment par un second appui. Une phrase qu'il ne comprend pas peut partir au
// planificateur (Haiku, sur demande seulement : jamais pendant la frappe).
//
// Volet « ordres » (13/11). Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe » ; « Go ». Au-dessus
// du champ, le fil des ordres (gardé par le serveur, le même sur l'ordinateur et le téléphone) : chaque ordre et ce qu'il
// a rendu, jusqu'à la réponse écrite par l'agent à qui on a parlé.
const EXEMPLES = ['qui a fini ?', 'lance 2 claude dans meydan : relis tasks/todo.md', 'dis à tous : faites le point en trois lignes', 'interromps tout', 'ferme les shells']
const MAX_FIL = 500
const PAGE_TEL = 60 // téléphone : messages montrés d'un coup (« plus anciens » en montre d'autres)
const MAINTIEN_MS = 350 // micro tenu au moins ce temps : relâcher termine la dictée
const ETATS = { attend: 'en file', retenu: 'retenu · permission', remis: 'remis', repondu: 'réponse', expire: 'non remis', perdu: 'console fermée', 'sans-reponse': 'sans réponse' }
const SOURCES = { voix: 'dicté', planificateur: 'Haiku' }

// L'exécution d'un ordre : comme `api` (lib.js), mais un refus garde le plan relu que le serveur joint (409 « le plan a
// changé : relis-le »).
async function envoie(corps) {
  const r = await fetch('/api/ordre', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps) }).catch(() => {
    throw new Error('Liaison coupée : réessaie dans un instant.')
  })
  if (r.status === 401) location.reload() // session finie
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || `erreur ${r.status}`), { plan: j.plan, statut: r.status })
  return j
}

// Le fil a trois sources (relecture, flux du serveur, réponse d'un ordre exécuté ici) : une seule fusion, par
// identifiant, dans l'ordre du temps. Une relecture arrivée en retard complète, elle ne remplace jamais.
const version = (m) => Number(m.maj ?? m.at) || 0 // `maj` croît à chaque modification côté serveur
function fusionne(liste, arrivees) {
  const ok = (arrivees || []).filter((m) => m && typeof m === 'object' && typeof m.id === 'string')
  if (!ok.length) return liste
  const index = new Map(liste.map((m, i) => [m.id, i]))
  const out = liste.slice()
  for (const m of ok) {
    const i = index.get(m.id)
    if (i === undefined) {
      index.set(m.id, out.length)
      out.push(m)
    } else if (version(m) >= version(out[i])) out[i] = { ...out[i], ...m } // une relecture en retard ne fait jamais reculer un état
  }
  out.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0)) // tri stable : un ordre et ses réponses du même instant gardent leur rang
  return out.length > MAX_FIL ? out.slice(-MAX_FIL) : out
}

// Chaque ordre suivi de ses réponses ; une réponse dont l'ordre est hors de la fenêtre reste seule.
function groupes(messages) {
  const g = []
  const parOrdre = new Map()
  for (const m of messages) {
    if (m.r === 'ordre') {
      const x = { ordre: m, reps: [] }
      parOrdre.set(m.id, x)
      g.push(x)
    } else {
      const x = parOrdre.get(m.de)
      if (x) x.reps.push(m)
      else g.push({ ordre: null, reps: [m] })
    }
  }
  return g
}

function heure(at) {
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  const h = d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? h : `${d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit' })} ${h}`
}

// Deux appuis : fermer, un texte risqué, un plan qui ferme ou relance, et tout ce que le serveur dit « à confirmer »
// (sauf un plan du planificateur sans gravité : ses étapes sont montrées, un appui suffit).
const deuxAppuis = (p) => !!p && !p.erreur && (p.ordre === 'fermer' || p.grave || p.risques?.length > 0 || (p.confirmer && p.ordre !== 'plusieurs'))

function libelle(p, { arme, haiku }) {
  if (haiku?.attente) return 'Haiku réfléchit…'
  if (!p) return 'Exécuter'
  if (p.erreur) return p.planifiable && !haiku ? 'Demander à Haiku' : 'Exécuter'
  if (p.ordre === 'fermer') return arme ? 'Confirmer : fermer' : 'Fermer…'
  if (p.ordre === 'relancer' && deuxAppuis(p)) return arme ? 'Confirmer : relancer' : 'Relancer…'
  if (p.ordre === 'plusieurs') {
    const n = p.actions?.length || 0
    const quoi = n > 1 ? `les ${n} étapes` : 'l’étape'
    if (deuxAppuis(p)) return arme ? `Confirmer ${quoi}` : `Exécuter ${quoi}…`
    return `Exécuter ${quoi}`
  }
  if (p.risques?.length) return arme ? `Confirmer : ${p.risques[0].motif}` : 'Exécuter…'
  if (deuxAppuis(p)) return arme ? 'Confirmer' : 'Exécuter…'
  return p.ordre === 'question' ? 'Demander' : 'Exécuter'
}

// Ce que dit le second appui, en citant ce qui sera fait.
function Confirme({ p }) {
  if (p.risques?.length)
    return (
      <p className="ordre-confirme" role="alert">
        Envoyer tel quel, avec {[...new Set(p.risques.map((r) => r.motif))].join(', ')} (passage{p.risques.length > 1 ? 's' : ''} cité{p.risques.length > 1 ? 's' : ''} ci-dessus) ? Appuie encore pour confirmer.
      </p>
    )
  if (p.ordre === 'fermer') return <p className="ordre-confirme">Ce qui tourne dans ces consoles s’arrête. Appuie encore pour fermer.</p>
  if (p.ordre === 'relancer') return <p className="ordre-confirme">Ces consoles terminées repartent dans leur dossier, l’agent sur sa conversation. Appuie encore pour relancer.</p>
  if (p.grave) {
    const actions = Array.isArray(p.actions) ? p.actions : []
    const ajoutes = Number(p.ajoutes) || actions.filter((a) => a?.ajoute).length
    const ferme = actions.some((a) => a?.ordre === 'fermer' || a?.ordre === 'relancer')
    const dit = [ajoutes > 0 && `${ajoutes > 1 ? `${ajoutes} étapes portent` : 'une étape porte'} un texte proposé par Haiku, pas dans ta phrase`, ferme && 'ce plan ferme ou relance des consoles'].filter(Boolean)
    return <p className="ordre-confirme">{dit.length ? `${dit.join(' ; ').replace(/^./, (c) => c.toUpperCase())}. ` : ''}Appuie encore pour confirmer.</p>
  }
  return <p className="ordre-confirme">Appuie encore pour confirmer.</p>
}

// Le moteur ajoute la mention au résumé d'une étape `ajoute` ; l'écran la dit sur sa propre ligne, surlignée.
const sansAjoute = (t) => (typeof t === 'string' ? t.replace(/\s*—\s*texte proposé par Haiku, pas dans ta phrase\.?$/, '') : t)

// Le plan montré avant d'agir : son résumé (le texte de `.ordre-plan` COMMENCE par lui), les passages risqués cités, les
// étapes d'un plan du planificateur, ce qu'il a coûté.
function Plan({ p, ancien }) {
  const etapes = p.ordre === 'plusieurs' && Array.isArray(p.actions) ? p.actions : []
  const risques = !p.erreur && Array.isArray(p.risques) ? p.risques : []
  const mesure = [Number(p.duree_ms) > 0 && `${(Number(p.duree_ms) / 1000).toFixed(1).replace('.', ',')} s`, Number(p.cout_usd) > 0 && `${Number(p.cout_usd).toFixed(4).replace('.', ',')} $`].filter(Boolean)
  return (
    <>
      <p className={cls('ordre-plan', p.erreur && 'est-erreur', !p.erreur && deuxAppuis(p) && 'est-grave', ancien && 'est-ancien')}>{p.erreur || p.resume}</p>
      {etapes.length > 0 && (
        <ol className="ordre-etapes" aria-label="Étapes du plan">
          {etapes.map((a, i) => (
            <li key={i} className={cls((a?.ordre === 'fermer' || a?.ordre === 'relancer') && 'est-grave', a?.risques?.length > 0 && 'est-risque', a?.erreur && 'est-erreur', a?.ajoute && 'est-ajoute')}>
              {a?.erreur || (a?.ajoute ? sansAjoute(a?.resume) : a?.resume) || a?.ordre}
              {a?.ajoute && <small className="ordre-ajoute">texte proposé par Haiku, pas dans ta phrase</small>}
            </li>
          ))}
        </ol>
      )}
      {risques.length > 0 && (
        <ul className="ordre-risques" aria-label="Passages risqués">
          {risques.map((r, i) => (
            <li key={i} className="ordre-risque">
              <b>{r.motif}</b>
              <q>{r.passage}</q>
            </li>
          ))}
        </ul>
      )}
      {p.jeton && <p className="ordre-meta">{['Plan de Haiku', ...mesure].join(' · ')}</p>}
    </>
  )
}

// Une réponse du fil. `fait` : le compte rendu du dernier ordre donné ici (`.ordre-fait`).
function Reponse({ r, fait, existe, onOuvre }) {
  const lignes = Array.isArray(r.lignes) ? r.lignes.filter((l) => typeof l === 'string') : []
  const liens = Array.isArray(r.liens) ? r.liens.filter((l) => l && typeof l.id === 'string') : []
  const lien = (id, nom, k) =>
    existe(id) ? (
      <button key={k} type="button" className="ordre-lien" onClick={() => onOuvre(id)} title={nom}>
        <span>{nom}</span> ↗
      </button>
    ) : (
      <span key={k} className="ordre-lien est-parti" title={nom}>
        <span>{nom}</span>
      </span>
    )
  // Une ligne qui nomme une console (le nom le plus long qu'elle contient) devient le lien vers elle ; les liens qu'aucune
  // ligne ne nomme restent en puces compactes dessous.
  const parLigne = lignes.map((l) => liens.filter((x) => x.nom && l.includes(x.nom)).sort((a, b) => b.nom.length - a.nom.length)[0] || null)
  const restants = liens.filter((x) => !parLigne.includes(x))
  if (r.genre === 'agent') {
    const etat = Object.hasOwn(ETATS, r.etat) ? r.etat : 'autre'
    return (
      <div className={cls('ordre-rep', 'est-agent', `etat-${etat}`)}>
        <div className="ordre-rep-tete">
          <b>{r.nom || r.console || 'console'}</b>
          <em className="ordre-etat">{ETATS[etat] || r.etat || '…'}</em>
          {typeof r.console === 'string' && existe(r.console) && (
            <button type="button" className="ordre-lien" onClick={() => onOuvre(r.console)} aria-label={`Ouvrir ${r.nom || 'la console'}`}>
              <span>ouvrir</span> ↗
            </button>
          )}
        </div>
        {lignes.length > 0 && (
          <div className="ordre-rep-texte">
            {lignes.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        )}
      </div>
    )
  }
  const genre = ['fait', 'question', 'erreur'].includes(r.genre) ? r.genre : 'autre'
  return (
    <div className={cls('ordre-rep', `est-${genre}`, fait && 'ordre-fait')} role={fait ? 'status' : undefined}>
      <ul>
        {lignes.length ? (
          lignes.map((l, i) =>
            parLigne[i] && existe(parLigne[i].id) ? (
              <li key={i} className="a-lien">
                <button type="button" className="ordre-lien est-ligne" onClick={() => onOuvre(parLigne[i].id)}>
                  {l} <i aria-hidden="true">↗</i>
                </button>
              </li>
            ) : (
              <li key={i}>{l}</li>
            ),
          )
        ) : (
          <li>{genre === 'erreur' ? 'Échec.' : 'Fait.'}</li>
        )}
      </ul>
      {restants.length > 0 && <div className="ordre-liens">{restants.map((l, i) => lien(l.id, l.nom || l.id, i))}</div>}
    </div>
  )
}

// Le fil : le plus récent en bas, près du champ ; il reste collé en bas tant qu'on n'est pas remonté le lire.
const FilOrdres = memo(function FilOrdres({ messages, dernier, existe, onOuvre, tel }) {
  const boite = useRef(null)
  const colle = useRef(true)
  const garde = useRef(null) // « plus anciens » : distance au bas gardée, la vue ne saute pas
  const [montre, setMontre] = useState(PAGE_TEL)
  const visibles = tel ? messages.slice(-montre) : messages
  const caches = messages.length - visibles.length
  // Sa hauteur change (un plan s'affiche sous lui, la liste des @mentions s'ouvre, le clavier se lève) : collé en bas,
  // il y reste.
  const vide = !messages.length
  useEffect(() => {
    const el = boite.current
    if (!el) return
    const ro = new ResizeObserver(() => colle.current && (el.scrollTop = el.scrollHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [vide])
  useLayoutEffect(() => {
    const el = boite.current
    if (!el) return
    if (garde.current != null) {
      el.scrollTop = el.scrollHeight - garde.current
      garde.current = null
    } else if (colle.current) el.scrollTop = el.scrollHeight
  })
  if (vide)
    return (
      <div className="ordre-fil est-vide">
        <p>Chaque ordre et ce qu’il rend s’affichent ici, sur l’ordinateur comme sur le téléphone.</p>
      </div>
    )
  return (
    <div
      className="ordre-fil"
      ref={boite}
      role="log"
      aria-label="Fil des ordres"
      onScroll={(e) => {
        const el = e.currentTarget
        colle.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
    >
      {caches > 0 && (
        <button
          type="button"
          className="ordre-plus"
          onClick={() => {
            const el = boite.current
            if (el) garde.current = el.scrollHeight - el.scrollTop
            setMontre((n) => n + PAGE_TEL)
          }}
        >
          {caches} plus ancien{caches > 1 ? 's' : ''}
        </button>
      )}
      <ol>
        {groupes(visibles).map((x) => {
          const premier = x.ordre && x.ordre.id === dernier ? x.reps.findIndex((r) => r.genre !== 'agent') : -1
          return (
            <li key={x.ordre?.id || x.reps[0].id} className="ordre-g">
              {x.ordre && (
                <p className="ordre-dit">
                  <span>{typeof x.ordre.texte === 'string' ? x.ordre.texte : ''}</span>
                  <small>{[SOURCES[x.ordre.source], heure(x.ordre.at)].filter(Boolean).join(' · ')}</small>
                </p>
              )}
              {x.reps.map((r, i) => (
                <Reponse key={r.id} r={r} fait={i === premier} existe={existe} onOuvre={onOuvre} />
              ))}
            </li>
          )
        })}
      </ol>
    </div>
  )
})

export function Ordre({ onClose, onPick, consoles = [], initial = '', source: sourceInitiale = 'tape' }) {
  const [texte, setTexte] = useState(typeof initial === 'string' ? initial : '')
  const [calcul, setCalcul] = useState(null) // { texte, plan } : le plan calculé pour ce texte-là
  const [rev, setRev] = useState(0) // relire le plan sans que le texte change (après un refus du serveur)
  const [haiku, setHaiku] = useState(null) // null | { attente } | { plan } : le planificateur, sur demande
  const [arme, setArme] = useState(false) // second appui attendu
  const [part, setPart] = useState(false)
  const [fait, setFait] = useState(false) // un ordre vient d'être exécuté ici (les exemples se retirent)
  const [erreur, setErreur] = useState('')
  const [voix, setVoix] = useState(null) // null | 'ecoute' | 'transcription'
  const [fil, setFil] = useState([])
  const [dernier, setDernier] = useState(null) // l'ordre exécuté ici en dernier : son compte rendu est `.ordre-fait`
  const [curseur, setCurseur] = useState(typeof initial === 'string' ? initial.length : 0)
  const [masque, setMasque] = useState(null) // début de la @mention dont la liste a été fermée par Échap
  const [choix, setChoix] = useState(0)
  const rec = useRef(null) // { pret: promesse de l'enregistreur }
  const geste = useRef(null) // micro : { t0 } pendant un appui, { fin } sur « Terminer », { avale } jusqu'au clic
  const source = useRef(sourceInitiale === 'voix' ? 'voix' : 'tape')
  const champ = useRef(null)
  const caret = useRef(typeof initial === 'string' && initial ? initial.length : null) // curseur à poser (texte dicté, complétion)
  const demande = useRef(0) // numéro de la demande au planificateur en cours
  const tel = useMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)')
  const bas = useMedia('(max-height: 520px)')

  // Le fil : relu à l'ouverture et à chaque instantané du serveur (reconnexion), tenu à jour par le flux. Un moteur qui
  // n'a pas encore la route (404) : fil vide, rien ne casse.
  useEffect(() => {
    let mort = false
    const relis = () =>
      api('GET', '/api/ordre/fil').then(
        (j) => !mort && setFil((f) => fusionne(f, Array.isArray(j?.messages) ? j.messages : [])),
        () => {}, // pas de fil (moteur d'avant) : les comptes rendus d'ici restent le temps du panneau
      )
    relis()
    const flux = (e) => {
      const m = e.detail
      if (m?.type === 'ordres' && m.message) setFil((f) => fusionne(f, [m.message]))
      else if (m?.type === 'snapshot') relis()
    }
    window.addEventListener('meydan:flux', flux)
    return () => {
      mort = true
      window.removeEventListener('meydan:flux', flux)
    }
  }, [])

  // Ce que l'ordre ferait, relu à chaque frappe (un instant après la dernière). Jamais le planificateur ici.
  useEffect(() => {
    setArme(false)
    setHaiku(null)
    demande.current++
    if (!texte.trim()) return setCalcul(null)
    let mort = false
    const t = setTimeout(() => {
      api('POST', '/api/ordre', { texte }).then(
        (j) => !mort && setCalcul({ texte, plan: j?.plan || { erreur: 'Réponse vide du serveur.' } }),
        (e) => !mort && setCalcul({ texte, plan: { erreur: e.message } }),
      )
    }, 220)
    return () => {
      mort = true
      clearTimeout(t)
    }
  }, [texte, rev])

  // Le curseur après une complétion de @mention.
  useLayoutEffect(() => {
    if (caret.current == null || !champ.current) return
    champ.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [texte])

  const annuleVoix = () => {
    const s = rec.current
    rec.current = null
    s?.pret.then((r) => r.cancel(), () => {})
    setVoix(null)
  }
  useEffect(() => () => rec.current?.pret.then((r) => r.cancel(), () => {}), []) // panneau fermé : la dictée s'arrête

  // @mention : la liste des consoles quand le curseur est dans un « @… ». Les shells et les consoles terminées viennent
  // après, grisées (on peut encore les fermer, les relancer ou demander où elles en sont ; un shell ne reçoit pas de message).
  const toutes = useMemo(() => mentions(consoles), [consoles])
  const enCours = useMemo(() => (voix ? null : mentionEnCours(texte, curseur)), [texte, curseur, voix])
  const propositions = useMemo(() => {
    if (!enCours) return []
    const f = filtre(toutes, enCours.requete) || []
    const vivant = (m) => m.kind !== 'shell' && m.status !== 'closed'
    return [...f.filter(vivant), ...f.filter((m) => !vivant(m))].slice(0, bas ? 3 : 6)
  }, [toutes, enCours, bas])
  const ouverte = !!enCours && enCours.debut !== masque && propositions.length > 0
  useEffect(() => {
    setChoix(0)
    if (!enCours) setMasque(null)
  }, [enCours?.debut, enCours?.requete, !enCours])
  useEffect(() => {
    if (ouverte) document.getElementById(`ordre-mention-${choix}`)?.scrollIntoView({ block: 'nearest' }) // la liste défile (clavier levé)
  }, [choix, ouverte])
  const complete = (m) => {
    const r = insere(texte, curseur, m)
    caret.current = r.curseur
    setTexte(r.texte)
    setCurseur(r.curseur)
    setFait(false)
    champ.current?.focus()
  }

  // Échap : ferme d'abord la liste des @mentions, puis le panneau (la dictée en cours s'arrête avec lui).
  useEchap(() => (ouverte ? setMasque(enCours.debut) : onClose()))
  useEtape(true, onClose) // téléphone : une étape d'historique, « retour » ferme le panneau (retour.js)

  const fermeRef = useRef(onClose)
  fermeRef.current = onClose
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const ouvre = useCallback((id) => {
    fermeRef.current()
    pickRef.current?.(id)
  }, [])
  const ids = useMemo(() => new Set(consoles.map((c) => c.id)), [consoles])
  const existe = useCallback((id) => ids.has(id), [ids])

  const pret = !!calcul && calcul.texte === texte
  const p = haiku?.plan ?? (pret ? calcul.plan : null) // le plan qui partira
  const montre = haiku?.plan ?? calcul?.plan ?? null // le plan à l'écran (l'ancien, pâli, pendant la frappe)
  // Pendant le choix d'une @mention, Entrée complète : le bouton attend la phrase entière (ni plan partiel, ni Haiku).
  const peut = !part && !voix && !haiku?.attente && !ouverte && !!p && (!p.erreur || (!!p.planifiable && !haiku))

  const demandeHaiku = () => {
    const dit = texte
    const n = ++demande.current
    setErreur('')
    setHaiku({ attente: true })
    api('POST', '/api/ordre', { texte: dit, planifier: true }).then(
      (j) => n === demande.current && setHaiku(j?.plan ? { plan: j.plan } : null),
      (e) => {
        if (n !== demande.current) return
        setHaiku(null)
        setErreur(e.message)
      },
    )
  }

  const execute = async () => {
    if (!peut) return
    if (p.erreur) return demandeHaiku()
    if (deuxAppuis(p) && !arme) return setArme(true)
    setPart(true)
    setErreur('')
    const dit = texte
    // `vu` : l'empreinte du plan montré (cibles comprises). Le serveur refuse (409 « le plan a changé ») si ce qu'il
    // exécuterait n'est plus ce qu'Orkun a vu ; un moteur d'avant n'en pose pas : rien n'est envoyé.
    const vu = typeof p.empreinte === 'string' ? { vu: p.empreinte } : {}
    const corps = p.jeton
      ? { jeton: p.jeton, executer: true, confirme: p.confirmation, ...vu }
      : { texte: dit, executer: true, source: source.current, ...(p.confirmer ? { confirme: p.confirmation ?? true } : {}), ...vu }
    try {
      const j = await envoie(corps)
      if (j.ordre?.id) {
        setFil((f) => fusionne(f, [j.ordre, ...(Array.isArray(j.reponses) ? j.reponses : [])]))
        setDernier(j.ordre.id)
      } else {
        // Moteur sans fil : le compte rendu s'affiche ici, le temps du panneau.
        const id = `local-${Date.now().toString(36)}`
        const at = Date.now()
        setFil((f) => fusionne(f, [{ id, at, r: 'ordre', texte: dit, source: source.current }, { id: `${id}-r`, at, r: 'reponse', de: id, genre: 'fait', lignes: Array.isArray(j.fait) ? j.fait : [] }]))
        setDernier(id)
      }
      setFait(true)
      setTexte('')
      source.current = 'tape'
      // Des consoles lancées : le panneau se ferme sur la première (avant, avec deux ou plus, il restait ouvert et le
      // clavier n'allait nulle part).
      if (j.creees?.length) {
        onClose()
        onPick?.(j.creees[0])
      } else champ.current?.focus()
    } catch (e) {
      setErreur(e.message)
      // Le plan a changé (console partie, cibles qui ont bougé) : le plan relu par le serveur est montré à la place, à
      // confirmer de nouveau ; sans lui, relu ici (sans le modèle).
      const relu = e.plan && typeof e.plan === 'object' && (typeof e.plan.resume === 'string' || typeof e.plan.erreur === 'string') ? e.plan : null
      if (relu && p.jeton && relu.jeton) setHaiku({ plan: relu })
      else if (relu && !p.jeton) setCalcul({ texte: dit, plan: relu })
      else setRev((r) => r + 1)
    }
    setPart(false)
    setArme(false)
  }

  // Micro de la barre. Toucher bref : l'écoute commence, « Terminer » la finit. Maintenu (≥ 350 ms) : relâcher la finit.
  const ecoute = () => {
    if (voix) return
    setErreur('')
    const s = { pret: record() }
    rec.current = s
    setVoix('ecoute')
    s.pret.catch((e) => {
      if (rec.current !== s) return
      rec.current = null
      setVoix(null)
      setErreur(e.message)
    })
  }
  const termine = async () => {
    const s = rec.current
    if (!s) return
    rec.current = null
    setVoix('transcription')
    try {
      const r = await s.pret
      const { texte: dit } = await transcribe(null, await r.stop())
      source.current = 'voix'
      setFait(false)
      setTexte(String(dit || '').replace(/[.!]$/, ''))
    } catch (e) {
      setErreur(e.message)
    }
    setVoix(null)
  }
  useEffect(() => {
    if (!voix) champ.current?.focus() // dictée finie : le clavier revient au champ
  }, [voix])

  const go = libelle(ouverte ? null : p, { arme, haiku })
  const grave = !!p && deuxAppuis(p)
  return createPortal(
    <div className="boucle-fond ordre-fond" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="boucle ordre" role="dialog" aria-label="Donner un ordre">
        <header>
          <b>Ordre</b>
          <span>à toutes tes consoles</span>
          <button type="button" className="boucle-x" aria-label="Fermer" onClick={onClose}>
            ×
          </button>
        </header>
        <FilOrdres messages={fil} dernier={dernier} existe={existe} onOuvre={ouvre} tel={tel} />
        <div className="ordre-bas">
          {ouverte && (
            <ul className="ordre-mentions" id="ordre-mentions" role="listbox" aria-label="Consoles">
              {propositions.map((m, i) => (
                <li
                  key={m.id}
                  id={`ordre-mention-${i}`}
                  role="option"
                  aria-selected={i === choix}
                  className={cls(i === choix && 'est-choisie', (m.kind === 'shell' || m.status === 'closed') && 'est-grise')}
                  onMouseDown={(e) => e.preventDefault()} // le champ garde le clavier (souris, et doigt : iOS passe par mousedown)
                  onClick={() => complete(m)}
                >
                  <b>{m.nom}</b>
                  <span>@{m.slug}</span>
                  <em>{m.kind === 'shell' ? 'shell' : statusOf(m.status).label}</em>
                </li>
              ))}
            </ul>
          )}
          <div className="ordre-champ">
            <textarea
              ref={champ}
              autoFocus
              rows={2}
              value={texte}
              maxLength={4000}
              placeholder="lance 2 claude dans meydan : …  ·  @console …  ·  qui a fini ?"
              enterKeyHint="go"
              aria-label="Ordre"
              aria-autocomplete="list"
              aria-controls={ouverte ? 'ordre-mentions' : undefined}
              aria-expanded={ouverte}
              aria-activedescendant={ouverte ? `ordre-mention-${choix}` : undefined}
              disabled={!!voix}
              onChange={(e) => {
                setFait(false)
                source.current = 'tape'
                setCurseur(e.target.selectionStart ?? e.target.value.length)
                setTexte(e.target.value)
              }}
              onSelect={(e) => setCurseur(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (ouverte) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const n = propositions.length
                    return setChoix((c) => (c + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
                  }
                  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                    e.preventDefault()
                    return complete(propositions[Math.min(choix, propositions.length - 1)])
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  execute()
                }
              }}
            />
            <button
              type="button"
              className={cls('ordre-micro', voix === 'ecoute' && 'is-ecoute')}
              disabled={voix === 'transcription'}
              aria-label={voix === 'ecoute' ? 'Terminer la dictée' : 'Dicter l’ordre (maintenir pour parler)'}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                if (voix === 'ecoute') return (geste.current = { fin: true })
                if (voix) return
                e.currentTarget.setPointerCapture?.(e.pointerId)
                geste.current = { t0: performance.now() }
                ecoute()
              }}
              onPointerUp={() => {
                const g = geste.current
                if (!g || g.avale) return
                geste.current = { avale: true } // le clic qui suit ce geste ne compte pas
                if (g.fin || performance.now() - g.t0 >= MAINTIEN_MS) termine()
              }}
              onPointerCancel={() => {
                if (geste.current?.t0 != null) annuleVoix() // geste repris par le système : rien n'est transcrit
                geste.current = null
              }}
              onClick={() => {
                if (geste.current?.avale) return (geste.current = null)
                if (voix === 'ecoute') termine() // clavier (Entrée ou Espace sur le bouton)
                else ecoute()
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {voix === 'ecoute' ? (
                'Terminer'
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
                </svg>
              )}
            </button>
          </div>
          {voix === 'ecoute' && (
            <p className="ordre-ecoute" role="status">
              <i aria-hidden="true" />
              J’écoute — relâche le micro, ou touche « Terminer »
            </p>
          )}
          {voix === 'transcription' && <p className="ordre-plan">Transcription…</p>}
          {haiku?.attente && !voix && <p className="ordre-plan est-attente">Haiku réfléchit… (quelques secondes)</p>}
          {montre && !voix && !haiku?.attente && !ouverte && texte.trim() && <Plan p={montre} ancien={!pret && !haiku?.plan} />}
          {!texte && !fait && !voix && (
            <div className="ordre-exemples">
              {EXEMPLES.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => {
                    source.current = 'tape'
                    setTexte(x)
                    setCurseur(x.length)
                    champ.current?.focus()
                  }}
                >
                  {x}
                </button>
              ))}
            </div>
          )}
          {erreur && <p role="alert">{erreur}</p>}
          {arme && p && <Confirme p={p} />}
          <button
            type="button"
            className={cls('ordre-go', !ouverte && grave && 'est-grave', !ouverte && p?.erreur && p.planifiable && !haiku && 'est-haiku', (part || haiku?.attente) && 'part')}
            disabled={!peut}
            onClick={execute}
          >
            {go}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
