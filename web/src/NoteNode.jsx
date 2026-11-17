// La carte « note » du plateau étendu (volet du 11/11) : un texte en Markdown posé sur le plateau, à côté des consoles.
// Deux états : lecture (le rendu, notes-md.jsx) et écriture (un champ en police mono). « Écrire » ou double-clic pour
// écrire, « Lire » ou Échap pour revenir ; une note neuve s'ouvre en écriture, le curseur dedans.
// Enregistrée 700 ms après la dernière frappe et à la perte du focus, une demande à la fois : deux envois croisés
// pouvaient arriver au serveur dans le désordre et y laisser l'ancien texte.
// Pendant l'écriture, le champ ne reprend jamais le texte qui revient du serveur (la frappe n'est jamais écrasée) ; hors
// écriture, la note montre ce qui arrive (écrit sur un autre appareil).
// Téléphone (`tel`) : tuile fixe, rendu rogné, aucun champ, rien ne défile ni ne bouge. Vue de loin sur l'ordinateur
// (`far`) : le cadre montre le titre en grand, le corps reste vide.
import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { cls } from './lib.js'
import { basculeTache, Markdown, premierTitre } from './notes-md.jsx'
import './carte-note.css'

const TEXTE_MAX = 40000 // = lib/cartes.mjs (TEXTE_MAX)
const PRES = 36000 // le compteur se montre à partir d'ici
// Le corps d'une demande ne passe pas 64 Ko (readJson de server.mjs, nginx `client_max_body_size 64k`) : un texte très
// accentué, plein d'émojis ou de retours à la ligne peut l'atteindre avant 40 000 caractères. Refusé ici, avec un
// message clair, plutôt qu'une liaison coupée par le serveur.
const OCTETS_MAX = 65536
const DELAI = 700
const nombre = (n) => n.toLocaleString('fr-FR')

// Ce qui empêche d'enregistrer ce texte : { message, compte } ; null si rien.
function refusDe(texte) {
  if (texte.length > TEXTE_MAX) return { message: 'Trop longue : rien n’est enregistré au-delà', compte: `${nombre(texte.length)} / ${nombre(TEXTE_MAX)}` }
  if (texte.length > 10000) {
    const octets = new TextEncoder().encode(JSON.stringify({ texte })).length
    if (octets > OCTETS_MAX) return { message: 'Trop lourde pour un envoi (64 Ko au plus) : rien n’est enregistré', compte: `${nombre(octets)} octets` }
  }
  return null
}
// Une note neuve : vide, jamais modifiée, créée il y a un instant (l'horloge du serveur fait foi, à quelques secondes près).
const estNeuve = (k) => !k.texte && k.creeLe === k.modifieLe && Math.abs(Date.now() - k.creeLe) < 20000

// L'état de l'enregistrement, discret ; une erreur se touche pour réessayer.
function Etat({ etat, onReessaie, flottant = false }) {
  if (!etat) return null
  if (etat.startsWith('erreur'))
    return (
      <button type="button" className={cls('et-note-etat est-echec nodrag', flottant && 'est-flottant')} onClick={onReessaie} title="Réessayer l’enregistrement">
        {etat} · réessayer
      </button>
    )
  return (
    <span className={cls('et-note-etat', flottant && 'est-flottant')} role="status">
      {etat === 'envoi' ? 'enregistrement…' : 'enregistré'}
    </span>
  )
}

export const NoteNode = memo(function NoteNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const store = useStoreApi()
  const [ecrit, setEcrit] = useState(() => !tel && estNeuve(k))
  const [brouillon, setBrouillon] = useState('')
  // Le dernier texte écrit ICI, et `t` la date que le serveur lui a donnée (Infinity tant qu'il ne l'a pas enregistré).
  // Il l'emporte sur le texte de la carte tant que la carte n'a pas été modifiée après lui : un envoi plus ancien qui
  // revient par le flux ne le remplace pas, un autre appareil qui écrit ensuite, si.
  const [local, setLocal] = useState(null)
  const [etat, setEtat] = useState('') // '' | 'envoi' | 'ok' | 'erreur : …'
  const affiche = local && local.t >= k.modifieLe ? local.texte : k.texte || ''
  const texte = ecrit ? brouillon : affiche
  const refus = ecrit ? refusDe(brouillon) : null

  const envoye = useRef(k.texte || '') // le dernier texte confié au serveur (null après un échec : le prochain repart)
  const enAttente = useRef(null) // tapé, pas encore confié (la minuterie court)
  const file = useRef(Promise.resolve())
  const numero = useRef(0)
  const enVol = useRef(0) // demandes parties, pas encore revenues
  const minuterie = useRef(0)
  const champ = useRef(null)
  const vise = useRef(ecrit ? { ligne: null } : null) // à l'ouverture du champ : le focus, et la ligne où poser le curseur

  const enregistre = useCallback(
    (v) => {
      clearTimeout(minuterie.current)
      if (refusDe(v)) return // le pied du champ dit pourquoi ; rien ne part
      enAttente.current = null
      if (v === envoye.current) {
        if (!enVol.current) setEtat((e) => (e === 'envoi' ? 'ok' : e)) // rien de neuf (tapé puis effacé)
        return
      }
      envoye.current = v
      const n = ++numero.current
      setLocal({ texte: v, t: Infinity })
      setEtat('envoi')
      enVol.current++
      file.current = file.current
        .then(() => actions.patch(id, { texte: v }))
        .then(
          ({ carte }) => {
            enVol.current--
            if (n !== numero.current) return // un envoi plus récent suit
            setLocal({ texte: carte.texte, t: carte.modifieLe })
            setEtat('ok')
          },
          (e) => {
            enVol.current--
            if (n !== numero.current) return
            envoye.current = null
            setEtat(`erreur : ${e.message}`)
          },
        )
    },
    [actions, id],
  )

  const tape = (e) => {
    const v = e.target.value
    setBrouillon(v)
    setEtat('envoi') // « enregistrement… » dès la frappe : rien n'est encore au serveur
    enAttente.current = v
    clearTimeout(minuterie.current)
    minuterie.current = setTimeout(() => enregistre(v), DELAI)
  }
  const ecrire = (ligne) => {
    if (tel) return
    const base = affiche.replace(/\r\n?/g, '\n')
    if (!local || local.t !== Infinity) envoye.current = base // rien en route : la base est ce que le serveur a
    setBrouillon(base)
    vise.current = { ligne }
    setEcrit(true)
  }
  const lire = () => {
    if (refusDe(brouillon)) return champ.current?.focus({ preventScroll: true })
    enregistre(brouillon)
    setEcrit(false)
  }

  // Une case cochée en lecture : la ligne de la tâche change dans le texte, enregistré tout de suite.
  const afficheRef = useRef(affiche)
  afficheRef.current = affiche
  const basculer = useCallback(
    (n) => {
      const t = basculeTache(afficheRef.current, n)
      if (t !== afficheRef.current) enregistre(t)
    },
    [enregistre],
  )

  // Le champ vient de s'ouvrir : focus (sans faire défiler le plateau), curseur au début de la ligne visée (double-clic)
  // ou à la fin, et le champ défilé jusqu'à lui.
  useEffect(() => {
    const ta = champ.current
    if (far) vise.current = null // ouverte de loin : le focus ne viendra pas plus tard, au zoom
    if (!ecrit || !ta || !vise.current) return
    const { ligne } = vise.current
    vise.current = null
    const v = ta.value
    let pos = v.length
    if (ligne != null) {
      pos = 0
      for (let l = 0; l < ligne; l++) {
        const j = v.indexOf('\n', pos)
        if (j < 0) {
          pos = v.length
          break
        }
        pos = j + 1
      }
    }
    // Hauteur du texte jusqu'au curseur (retours à la ligne automatiques compris) : le champ ne défile pas tout seul
    // pour un curseur posé par le code.
    ta.value = v.slice(0, pos)
    const haut = ta.scrollHeight
    ta.value = v
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(pos, pos)
    ta.scrollTop = Math.max(0, haut - ta.clientHeight / 2)
  }, [ecrit, far])

  // « enregistré » s'efface après un instant ; une erreur reste.
  useEffect(() => {
    if (etat !== 'ok') return
    const t = setTimeout(() => setEtat(''), 2500)
    return () => clearTimeout(t)
  }, [etat])

  // La page se ferme pendant la frappe (avant la fin des 700 ms) : une demande « keepalive » part quand même (elle survit
  // à la page ; actions.patch n'en fait pas). La dalle démontée (carte retirée ailleurs, plateau quitté) enregistre aussi.
  const enregistreRef = useRef(enregistre)
  enregistreRef.current = enregistre
  useEffect(() => {
    const part = () => {
      const v = enAttente.current
      if (v === null || refusDe(v)) return
      enAttente.current = null
      fetch(`/api/cartes/${id}`, { method: 'PATCH', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texte: v }) }).catch(() => {})
    }
    window.addEventListener('pagehide', part)
    return () => {
      window.removeEventListener('pagehide', part)
      clearTimeout(minuterie.current)
      if (enAttente.current !== null) enregistreRef.current(enAttente.current)
    }
  }, [id])

  const outils = ecrit ? (
    <button type="button" className="et-note-bouton nodrag" onClick={lire} disabled={!!refus} title={refus ? refus.message : 'Revenir à la lecture (Échap)'}>
      Lire
    </button>
  ) : (
    <button type="button" className="et-note-bouton nodrag" onClick={() => ecrire(null)} title="Écrire (ou double-clic sur la note)">
      Écrire
    </button>
  )

  let corps = null
  if (tel)
    corps = <div className="et-note-lire">{affiche.trim() ? <Markdown texte={affiche} statique /> : <p className="et-note-vide">Note vide</p>}</div>
  else if (!far && ecrit)
    corps = (
      <div className="et-note-ecrire">
        <textarea
          ref={champ}
          className="et-note-champ"
          value={brouillon}
          onChange={tape}
          onFocus={() => {
            // La note où l'on écrit devient la dalle choisie, comme après un clic (même appel que React Flow) : elle passe
            // devant ses voisines. Une note neuve reçoit le focus sans clic ; posée sur une carte choisie, elle restait dessous.
            const s = store.getState()
            if (s.elementsSelectable && !s.nodeLookup.get(id)?.selected) s.addSelectedNodes([id])
          }}
          onBlur={(e) => enregistre(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation() // le clavier est à la note (aucun raccourci du plateau ni de l'application)
            if (e.key === 'Escape') {
              e.preventDefault()
              lire()
            }
          }}
          placeholder={'# Titre\n\nDu texte, **gras**, *italique*, `code`\n- une liste\n- [ ] une tâche\n[un lien](https://…)'}
          aria-label="Texte de la note, en Markdown"
          spellCheck
        />
        <div className="et-note-pied">
          {refus ? <span className="et-note-refus" role="alert">{refus.message}</span> : <Etat etat={etat} onReessaie={() => enregistre(brouillon)} />}
          <span className={cls('et-note-compte', refus ? 'est-trop' : brouillon.length >= PRES && 'est-pres')}>
            {refus ? refus.compte : brouillon.length >= PRES ? `${nombre(brouillon.length)} / ${nombre(TEXTE_MAX)}` : 'Markdown · Échap : lire'}
          </span>
        </div>
      </div>
    )
  else if (!far)
    corps = (
      <>
        <div
          className="et-note-lire"
          onDoubleClick={(e) => {
            if (e.target.closest('a, input, button')) return
            const bloc = e.target.closest('[data-l]')
            ecrire(bloc ? Number(bloc.dataset.l) : null)
          }}
        >
          {affiche.trim() ? <Markdown texte={affiche} onTache={basculer} /> : <p className="et-note-vide">Note vide. Double-clic ou « Écrire » pour l’écrire.</p>}
        </div>
        <Etat etat={etat} onReessaie={() => enregistre(affiche)} flottant />
      </>
    )

  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={premierTitre(texte) || 'Note'} outils={outils}>
      {corps}
    </Carte>
  )
})
