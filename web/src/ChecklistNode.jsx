// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — la carte
// Checklist : « carte de tâches (ajouter, cocher, réordonner, supprimer), compteur « 3/7 » ». Serveur :
// lib/cartes-checklist.mjs (données { taches: [{ id, t, fait }] }, bornes, refus).
//   Ajouter : le champ du bas, Entrée. Cocher : la case. Modifier : double-clic sur le texte (Entrée garde, Échap annule).
//   Supprimer : « × » de la ligne. Réordonner : la poignée glissée au pointeur (souris ou doigt), ou « ↑ » / « ↓ » de la
//   ligne, ou les flèches haut / bas du clavier sur la poignée — le glisser n'est jamais le seul moyen.
//   Le glisser se fait dans une dalle React Flow mise à l'échelle (zoom) : la ligne visée se trouve par
//   `document.elementsFromPoint` en coordonnées d'écran, jamais par un calcul de décalage.
// Téléphone couché (`tel`) : tuile fixe en lecture — compteur, premières tâches avec leur case dessinée ; aucun champ,
// aucun bouton, aucun défilement, aucune animation. Vue de loin (`far`) : le cadre montre le titre en grand, corps vide.
// Contrat : composant de dalle React Flow `({ id, data: k, width, height, selected })`, comme NoteNode.jsx.
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { cls } from './lib.js'
import './carte-checklist.css'

const TACHES_MAX = 150 // = lib/cartes-checklist.mjs
const TACHE_MAX = 110 // caractères par tâche ; = lib/cartes-checklist.mjs
// Le corps d'une demande ne passe pas 64 Ko (readJson de server.mjs, nginx) : au-delà de 60 Ko, refus clair à l'écran
// plutôt qu'une liaison coupée par le serveur. Les bornes du serveur tiennent sous ce seuil (56 788 octets au pire).
const OCTETS_MAX = 60 * 1024
const SEUIL = 5 // points d'écran avant qu'un appui sur la poignée devienne un glisser (le doigt tremble)
const TEL_MAX = 24 // tâches montrées sur la tuile du téléphone (la suite est rognée de toute façon)
const nombre = (n) => n.toLocaleString('fr-FR')
// Même nettoyage que le serveur (ligneDe) : ce qui s'affiche est ce qui sera gardé.
export const ligne = (v) =>
  String(v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cs}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
// Identifiant d'un élément (tâche, entrée) : 12 caractères hexadécimaux (forme fermée du serveur : /^[a-z0-9]{1,16}$/).
export const nouvelId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((o) => o.toString(16).padStart(2, '0')).join('')

// Des champs d'une carte modifiés ICI (liste de tâches, entrées, mois) : à l'écran tout de suite, envoyés au serveur dans
// l'ordre, une demande à la fois (deux envois croisés pouvaient arriver dans le désordre et y laisser l'ancienne liste), et
// préférés à ceux de la carte tant que la carte n'a pas été modifiée après eux — l'écho d'un envoi plus ancien qui revient
// par le flux ne les remplace pas ; un autre appareil qui écrit ensuite, si (même règle que NoteNode.jsx).
// Rend { vue (la carte telle qu'à l'écran), vueRef (la même, à jour dans les gestionnaires), envoie(champs) → bool, erreur }.
export function useChampsLocaux(id, k, actions) {
  const [local, setLocal] = useState(null) // { champs, t } ; t = date du serveur pour ces champs (Infinity : en route)
  const [erreur, setErreur] = useState('')
  const file = useRef(Promise.resolve())
  const numero = useRef(0)
  const modif = k.modifieLe || 0
  const vue = local && local.t >= modif ? { ...k, ...local.champs } : k
  const vueRef = useRef(vue)
  vueRef.current = vue
  const modifRef = useRef(modif)
  modifRef.current = modif
  const envoie = useCallback(
    (champs) => {
      const octets = new TextEncoder().encode(JSON.stringify(champs)).length
      if (octets > OCTETS_MAX) {
        setErreur(`Trop lourd pour un envoi (${nombre(octets)} octets, 60 Ko au plus) : rien n’est enregistré`)
        return false
      }
      setErreur('')
      vueRef.current = { ...vueRef.current, ...champs } // un second geste dans la même image part de celui-ci
      const n = ++numero.current
      setLocal((l) => ({ champs: { ...(l && l.t >= modifRef.current ? l.champs : {}), ...champs }, t: Infinity }))
      file.current = file.current
        .then(() => actions.patch(id, champs))
        .then(
          ({ carte }) => {
            if (n !== numero.current) return // un envoi plus récent suit
            setLocal((l) => l && { champs: Object.fromEntries(Object.keys(l.champs).map((c) => [c, carte[c]])), t: carte.modifieLe })
          },
          (e) => {
            setErreur(`Refusé : ${e.message}`)
            // actions.patch a déjà remis les valeurs d'avant et relu le serveur ; l'écran reprend la carte.
            if (n === numero.current) setLocal(null)
          },
        )
      return true
    },
    [actions, id],
  )
  return { vue, vueRef, envoie, erreur, setErreur }
}

// Une carte neuve : vide, jamais modifiée, créée il y a un instant (l'horloge du serveur fait foi, à quelques secondes près).
const estNeuve = (k) => !(k.taches?.length > 0) && k.creeLe === k.modifieLe && Math.abs(Date.now() - k.creeLe) < 20000

export const ChecklistNode = memo(function ChecklistNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const store = useStoreApi()
  const { vue, vueRef, envoie, erreur, setErreur } = useChampsLocaux(id, k, actions)
  const taches = Array.isArray(vue.taches) ? vue.taches : []
  const faites = taches.filter((x) => x.fait).length
  const [nouveau, setNouveau] = useState('')
  const [edite, setEdite] = useState(null) // l'identifiant de la tâche dont le texte est en cours de modification
  const [glisse, setGlisse] = useState(null) // { id, cible: { id, avant } | null } pendant un glisser
  const porte = useRef(null) // { id, x0, y0, pid, actif, cible } : l'appui en cours sur une poignée
  const liste = useRef(null)
  const champ = useRef(null)
  const refocus = useRef(null) // après un déplacement au clavier : { id, quoi } à refocaliser
  const enBas = useRef(false) // après un ajout : la liste défile jusqu'à la nouvelle tâche
  const tachesDe = () => (Array.isArray(vueRef.current.taches) ? vueRef.current.taches : [])

  // ── Les gestes ──
  const ajoute = () => {
    const t = ligne(nouveau)
    if (!t) return
    const ts = tachesDe()
    if (ts.length >= TACHES_MAX) return setErreur(`${TACHES_MAX} tâches au plus : rien n’est ajouté`)
    if (envoie({ taches: [...ts, { id: nouvelId(), t, fait: false }] })) {
      setNouveau('')
      enBas.current = true
    }
  }
  const bascule = (tid) => envoie({ taches: tachesDe().map((x) => (x.id === tid ? { ...x, fait: !x.fait } : x)) })
  const supprime = (tid) => envoie({ taches: tachesDe().filter((x) => x.id !== tid) })
  const finEdite = (tid, v) => {
    setEdite(null)
    if (v === undefined) return // Échap : rien ne change
    const t = ligne(v)
    const x = tachesDe().find((y) => y.id === tid)
    if (!t || !x || t === x.t) return // vide : l'ancien texte reste (on supprime par « × »)
    envoie({ taches: tachesDe().map((y) => (y.id === tid ? { ...y, t } : y)) })
  }
  // La tâche `tid` va à la place `pos` de la liste d'avant (0 = en tête, longueur = en fin).
  const deplace = (tid, pos, quoi) => {
    const ts = tachesDe()
    const de = ts.findIndex((x) => x.id === tid)
    if (de < 0) return
    const vers = Math.max(0, Math.min(ts.length - 1, pos > de ? pos - 1 : pos))
    if (vers === de) return
    const reste = ts.filter((x) => x.id !== tid)
    reste.splice(vers, 0, ts[de])
    if (quoi) refocus.current = { id: tid, quoi }
    envoie({ taches: reste })
  }

  // ── Le glisser de la poignée (souris ou doigt) ──
  // La ligne sous le pointeur, en coordonnées d'écran (le zoom du plateau n'entre dans aucun calcul) ; au-dessus de la
  // première ligne ou sous la dernière : en tête ou en fin.
  const cibleDe = (x, y) => {
    const ol = liste.current
    if (!ol) return null
    for (const el of document.elementsFromPoint(x, y)) {
      const li = el.closest?.('li[data-ck]')
      if (li && ol.contains(li)) {
        const r = li.getBoundingClientRect()
        return { id: li.dataset.ck, avant: y < r.top + r.height / 2 }
      }
    }
    const r = ol.getBoundingClientRect()
    const lis = ol.querySelectorAll('li[data-ck]')
    if (!lis.length || x < r.left || x > r.right) return null
    if (y < lis[0].getBoundingClientRect().top) return { id: lis[0].dataset.ck, avant: true }
    const der = lis[lis.length - 1]
    if (y > der.getBoundingClientRect().bottom) return { id: der.dataset.ck, avant: false }
    return null
  }
  const poigneeBas = (e, tid) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.stopPropagation()
    e.preventDefault() // pas de sélection de texte ; la poignée a `touch-action: none` (le doigt ne fait pas défiler)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {} // pointeur déjà relâché
    porte.current = { id: tid, x0: e.clientX, y0: e.clientY, pid: e.pointerId, actif: false, cible: null }
  }
  const poigneeBouge = (e) => {
    const p = porte.current
    if (!p || e.pointerId !== p.pid) return
    if (!p.actif && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < SEUIL) return
    p.actif = true
    p.cible = cibleDe(e.clientX, e.clientY) || p.cible
    // Près du bord haut ou bas d'une liste qui défile : elle défile pour atteindre les lignes cachées.
    const ol = liste.current
    if (ol && ol.scrollHeight > ol.clientHeight) {
      const r = ol.getBoundingClientRect()
      if (e.clientY < r.top + 24) ol.scrollTop -= 12
      else if (e.clientY > r.bottom - 24) ol.scrollTop += 12
    }
    setGlisse({ id: p.id, cible: p.cible })
  }
  const poigneeHaut = (e) => {
    const p = porte.current
    if (!p || e.pointerId !== p.pid) return
    porte.current = null
    setGlisse(null)
    if (!p.actif) return // un appui sans glisser ne déplace rien
    const c = cibleDe(e.clientX, e.clientY) || p.cible
    if (!c || c.id === p.id) return
    const ts = tachesDe()
    const i = ts.findIndex((x) => x.id === c.id)
    if (i >= 0) deplace(p.id, c.avant ? i : i + 1)
  }
  const poigneeAnnule = () => {
    porte.current = null
    setGlisse(null)
  }

  // Après un déplacement au clavier, le focus reste sur le même geste de la même tâche (la ligne a changé de place).
  useLayoutEffect(() => {
    const r = refocus.current
    if (!r) return
    refocus.current = null
    const li = liste.current?.querySelector(`li[data-ck="${r.id}"]`)
    const b = li?.querySelector(`[data-geste="${r.quoi}"]`)
    ;(b && !b.disabled ? b : li?.querySelector('[data-geste="poignee"]'))?.focus({ preventScroll: true })
  })
  // Le champ de modification d'une tâche prend le focus à son ouverture (sans faire défiler le plateau).
  useEffect(() => {
    if (edite) liste.current?.querySelector('.cr-ck-champ')?.focus({ preventScroll: true })
  }, [edite])
  // Après un ajout : la liste montre sa fin (la tâche ajoutée), le champ garde le focus.
  useEffect(() => {
    if (!enBas.current || !liste.current) return
    enBas.current = false
    liste.current.scrollTop = liste.current.scrollHeight
  })
  // Une checklist neuve (« Ajouter → Checklist ») : le curseur est dans le champ d'ajout, sans faire défiler le plateau.
  const neuve = useRef(!tel && estNeuve(k))
  useEffect(() => {
    if (!neuve.current || far || tel) return
    neuve.current = false
    champ.current?.focus({ preventScroll: true })
  }, [far, tel])
  // La carte où l'on écrit devient la dalle choisie (même appel que le clic de React Flow) : elle passe devant ses voisines.
  const choisis = () => {
    const s = store.getState()
    if (s.elementsSelectable && !s.nodeLookup.get(id)?.selected) s.addSelectedNodes([id])
  }

  let corps = null
  if (tel)
    corps = (
      <div className="cr-ck cr-ck-tel">
        <div className="cr-ck-tete">
          <b className="cr-ck-compte">
            {faites}/{taches.length}
          </b>
          <span className="cr-ck-jauge" aria-hidden="true">
            <i style={{ width: `${taches.length ? (100 * faites) / taches.length : 0}%` }} />
          </span>
        </div>
        <ul className="cr-ck-liste">
          {taches.slice(0, TEL_MAX).map((x) => (
            <li key={x.id} className={cls('cr-ck-tache', x.fait && 'est-faite')}>
              <span className={cls('cr-ck-case', x.fait && 'est-cochee')} />
              <span className="cr-ck-texte">{x.t}</span>
            </li>
          ))}
        </ul>
        {!taches.length && <p className="cr-ck-vide">Aucune tâche</p>}
      </div>
    )
  else if (!far)
    corps = (
      <div className={cls('cr-ck', glisse && 'est-glisse')}>
        <div className="cr-ck-tete">
          <b className="cr-ck-compte" title={`${faites} faites sur ${taches.length}`}>
            {faites}/{taches.length}
          </b>
          <span className="cr-ck-jauge" aria-hidden="true">
            <i style={{ width: `${taches.length ? (100 * faites) / taches.length : 0}%` }} />
          </span>
        </div>
        <ol className="cr-ck-liste" ref={liste}>
          {taches.map((x, i) => (
            <li
              key={x.id}
              data-ck={x.id}
              className={cls(
                'cr-ck-tache',
                x.fait && 'est-faite',
                glisse?.id === x.id && 'est-portee',
                glisse?.cible?.id === x.id && glisse.cible.id !== glisse.id && (glisse.cible.avant ? 'est-depot-avant' : 'est-depot-apres'),
              )}
            >
              <button
                type="button"
                className="cr-ck-poignee nodrag"
                data-geste="poignee"
                aria-label={`Déplacer « ${x.t} » (flèches haut et bas)`}
                title="Glisser pour déplacer · flèches ↑ ↓ au clavier"
                onPointerDown={(e) => poigneeBas(e, x.id)}
                onPointerMove={poigneeBouge}
                onPointerUp={poigneeHaut}
                onPointerCancel={poigneeAnnule}
                onLostPointerCapture={poigneeAnnule}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    deplace(x.id, e.key === 'ArrowUp' ? i - 1 : i + 2, 'poignee')
                  }
                }}
              />
              <input type="checkbox" className="cr-ck-case nodrag" checked={!!x.fait} onChange={() => bascule(x.id)} aria-label={x.fait ? `Décocher « ${x.t} »` : `Cocher « ${x.t} »`} />
              {edite === x.id ? (
                <input
                  className="cr-ck-champ nodrag"
                  defaultValue={x.t}
                  maxLength={TACHE_MAX}
                  aria-label="Texte de la tâche"
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    e.stopPropagation() // le clavier est à la carte (aucun raccourci du plateau ni de l'application)
                    if (e.key !== 'Enter' && e.key !== 'Escape') return
                    e.currentTarget.dataset.fini = '1' // la perte du focus qui suit (champ retiré) ne refait rien
                    finEdite(x.id, e.key === 'Enter' ? e.currentTarget.value : undefined)
                  }}
                  onBlur={(e) => !e.currentTarget.dataset.fini && finEdite(x.id, e.currentTarget.value)}
                />
              ) : (
                <span className="cr-ck-texte" title="Double-clic : modifier" onDoubleClick={() => setEdite(x.id)}>
                  {x.t}
                </span>
              )}
              <span className="cr-ck-gestes">
                <button type="button" className="nodrag" data-geste="monte" disabled={i === 0} aria-label={`Monter « ${x.t} »`} title="Monter" onClick={() => deplace(x.id, i - 1, 'monte')}>
                  ↑
                </button>
                <button type="button" className="nodrag" data-geste="descend" disabled={i === taches.length - 1} aria-label={`Descendre « ${x.t} »`} title="Descendre" onClick={() => deplace(x.id, i + 2, 'descend')}>
                  ↓
                </button>
                <button type="button" className="cr-ck-suppr nodrag" data-geste="supprime" aria-label={`Supprimer « ${x.t} »`} title="Supprimer" onClick={() => supprime(x.id)}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>
        {!taches.length && <p className="cr-ck-vide">Aucune tâche. Écris-en une ci-dessous, puis Entrée.</p>}
        {erreur && (
          <p className="cr-ck-erreur" role="alert">
            {erreur}
          </p>
        )}
        <div className="cr-ck-ajout">
          <input
            ref={champ}
            className="nodrag"
            value={nouveau}
            maxLength={TACHE_MAX}
            placeholder={taches.length >= TACHES_MAX ? `${TACHES_MAX} tâches au plus` : 'Ajouter une tâche… (Entrée)'}
            aria-label="Nouvelle tâche"
            onChange={(e) => setNouveau(e.target.value)}
            onFocus={choisis}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                ajoute()
              }
              if (e.key === 'Escape') e.currentTarget.blur()
            }}
          />
        </div>
      </div>
    )

  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected}>
      {corps}
    </Carte>
  )
})
