// Préréglages de groupe dans le formulaire « Nouvelle console » (volet « raccourcis », lot C, 13/11 ; Orkun : « On est
// encore loin de toutes les fonctionnalitēs de Symvibe », puis « Go »). Les groupes enregistrés sont en puces : le nom
// au-dessus, « 2 Claude + 1 Codex » dessous ; toucher une puce lance le groupe dans le dossier choisi du formulaire, puis
// pose ses consoles en rangée sous tout ce qui est sur le plateau. « … » (modifier) et « + Groupe » ouvrent l'éditeur :
// un panneau par-dessus l'écran, pas une rangée de plus dans la colonne (la liste des consoles garde sa place).
// Calcul et stockage : groupes.js.
//
// Props : `cwd` (le dossier choisi dans le formulaire), `onCreated(consoles)` (cadre dessus sur l'ordinateur ; ferme le
// panneau « Nouvelle console » du téléphone couché), `rev` (thème Réverbère, inutile ici : les teintes suivent le thème).
//
// Pas de <form> ici : la puce est DANS le formulaire de Composer (Rail.jsx) et l'éditeur, rendu ailleurs dans la page,
// reste dans son arbre React ; un « submit » remonterait jusqu'à Composer et lancerait une console. Tout bouton est
// `type="button"`, et Entrée dans un champ de l'éditeur ne fait rien.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, cls, shortDir } from './lib.js'
import { MAX_CONSIGNE, MAX_CONSOLES, MAX_NOM, MAX_ROLE, MODELES, corpsDe, ecris, groupeValide, lis, nomDuType, nouvelId, rangee, refus, resume, total } from './groupes.js'

let cles = 0 // clé d'affichage d'une ligne de l'éditeur (pas enregistrée)
const ligne = (kind = 'claude', nombre = 1) => ({ k: ++cles, kind, nombre, modele: '', role: '', consigne: '' })
// Un groupe neuf part de l'exemple de la demande, « 2 Claude + 1 Codex » : rien n'est enregistré ni lancé sans « Enregistrer ».
const neuf = () => ({ id: nouvelId(), nom: '', lignes: [ligne('claude', 2), ligne('codex', 1)] })
const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`
// Le titre d'une puce : ce qui part, où, et le début de chaque consigne (rien n'est caché derrière le clic).
const titreDe = (g, kinds, cwd) =>
  [`Lancer ${resume(g, kinds)} dans ${shortDir(cwd) || 'le dossier choisi'}`, ...g.lignes.filter((l) => l.kind !== 'shell' && l.consigne).map((l) => `${l.role || nomDuType(l.kind, kinds)} : « ${l.consigne.slice(0, 120)}${l.consigne.length > 120 ? '…' : ''} »`)].join('\n')

export function Groupes({ cwd, onCreated }) {
  const [groupes, setGroupes] = useState(lis)
  const [kinds, setKinds] = useState([]) // les types que propose le serveur (GET /api/projects), comme le formulaire
  const [edite, setEdite] = useState(null) // { brouillon, existe } : l'éditeur ouvert
  const [enCours, setEnCours] = useState('') // l'id du groupe qui se lance
  const [avis, setAvis] = useState(null) // { texte, erreur } : ce qui vient de se passer, dit à l'écran
  const occupe = useRef(false) // un seul lancement à la fois, même sur un double clic plus rapide que l'affichage

  useEffect(() => {
    let vivant = true
    api('GET', '/api/projects').then(
      (m) => vivant && setKinds(Array.isArray(m?.kinds) ? m.kinds : []),
      () => {}, // liaison coupée : lancer le dira (« liste des types pas encore lue »)
    )
    return () => {
      vivant = false
    }
  }, [])

  const garde = (liste) => {
    setGroupes(liste)
    setAvis(ecris(liste) ? null : { erreur: true, texte: "Le stockage de l'appareil est refusé : les groupes ne valent que pour cette page." })
  }
  const ouvre = (g) => {
    setAvis(null)
    setEdite(g ? { existe: true, brouillon: { ...g, lignes: g.lignes.map((l) => ({ ...l, k: ++cles })) } } : { existe: false, brouillon: neuf() })
  }
  const enregistre = (b) => {
    const g = groupeValide({ ...b, nom: b.nom.trim() || resume(b, kinds) })
    if (!g || total(g) > MAX_CONSOLES) return // l'éditeur l'a déjà dit, et son bouton est éteint
    garde(groupes.some((x) => x.id === g.id) ? groupes.map((x) => (x.id === g.id ? g : x)) : [...groupes, g])
    setEdite(null)
  }
  const supprime = (id) => {
    garde(groupes.filter((x) => x.id !== id))
    setEdite(null)
  }

  // Lancer : une POST /api/consoles par ligne, à la suite (pas en parallèle), puis la rangée, puis le cadrage. Le
  // lancement va jusqu'au bout même si le formulaire se referme pendant ce temps.
  const lance = async (g) => {
    if (occupe.current) return
    const nom = g.nom || resume(g, kinds)
    const non = refus(g, kinds, cwd)
    if (non) return setAvis({ erreur: true, texte: `« ${nom} » n'est pas lancé : ${non}` })
    occupe.current = true
    setEnCours(g.id)
    setAvis({ texte: `« ${nom} » : lancement…` })
    const fin = (a) => {
      occupe.current = false
      setEnCours('')
      setAvis(a)
    }
    let avant
    try {
      avant = new Set((await api('GET', '/api/consoles')).consoles.map((c) => c.id)) // pour retrouver ce qu'une ligne refusée a lancé
    } catch (e) {
      return fin({ erreur: true, texte: `« ${nom} » n'est pas lancé : ${e.message}` })
    }
    const faites = []
    let echec = null
    for (const [i, l] of g.lignes.entries()) {
      // Comme entre deux agents d'une même demande (server.mjs) : une demi-seconde avant une ligne d'agents qui en suit une
      // autre, pour que deux lignes ne démarrent pas leurs agents d'affilée (seconde relecture du 13/11).
      if (i && l.kind !== 'shell') await new Promise((r) => setTimeout(r, 500))
      try {
        faites.push(...((await api('POST', '/api/consoles', corpsDe(l, cwd))).consoles || []))
      } catch (e) {
        echec = { i, l, message: e.message }
        break
      }
    }
    // Le plateau tel qu'il est maintenant : consoles (places et tailles du serveur) et cartes.
    let etat = null
    try {
      const [c, k] = await Promise.all([api('GET', '/api/consoles'), api('GET', '/api/cartes').catch(() => ({ cartes: [] }))])
      etat = { consoles: c.consoles || [], cartes: k.cartes || [] }
    } catch {} // liaison coupée : les consoles restent là où le serveur les a posées
    // Une ligne refusée en cours de route (la 3e de 4 consoles…) a pu en lancer avant l'erreur : le serveur ne les rend pas
    // avec l'erreur, on les retrouve parmi les consoles nouvelles depuis le départ.
    const ids = new Set(faites.map((c) => c.id))
    const toutes = echec && etat ? [...faites, ...etat.consoles.filter((c) => !avant.has(c.id) && !ids.has(c.id))] : faites
    let posees = false
    if (toutes.length && etat) {
      const neuves = new Set(toutes.map((c) => c.id))
      const places = rangee(
        [...etat.consoles.filter((c) => !neuves.has(c.id)), ...etat.cartes],
        toutes.map((c) => etat.consoles.find((x) => x.id === c.id) || c),
      )
      try {
        for (const p of places) await api('PATCH', `/api/consoles/${p.id}`, { x: p.x, y: p.y })
        posees = true
      } catch {} // dit plus bas
    }
    const range = posees ? ', posées en rangée' : toutes.length ? ' (pas rangées : liaison coupée)' : ''
    if (echec) {
      const deja = toutes.length ? `Déjà lancées : ${pluriel(toutes.length, 'console', 'consoles')} (${toutes.map((c) => `« ${c.name} »`).join(', ')})${range}.` : "Rien n'a été lancé."
      return fin({ erreur: true, texte: `« ${nom} » : la ligne ${echec.i + 1} (${echec.l.nombre} ${nomDuType(echec.l.kind, kinds)}) est refusée (${echec.message}). ${deja}` })
    }
    fin({ texte: `« ${nom} » : ${pluriel(toutes.length, 'console lancée', 'consoles lancées')}${range}.` })
    onCreated(toutes)
  }

  return (
    <div className="gr" role="group" aria-label="Préréglages de groupe">
      {/* Où partira un groupe, avant le clic (relecture de sécurité du 13/11 : la puce ne disait pas le dossier, et un clic
          lance jusqu'à 12 vrais agents, consigne comprise). La consigne est dans le titre de la puce. */}
      {groupes.length > 0 && (
        <p className="gr-dossier" title={cwd}>
          Lancés dans <b>{shortDir(cwd) || '…'}</b>
        </p>
      )}
      <div className="gr-puces">
        {groupes.map((g) => (
          <span key={g.id} className={cls('gr-puce', enCours === g.id && 'is-en-cours')}>
            <button type="button" className="gr-lance" disabled={!!enCours} onClick={() => lance(g)} title={titreDe(g, kinds, cwd)}>
              <span className="gr-nom">{g.nom || 'Groupe'}</span>
              <span className="gr-resume">{enCours === g.id ? 'Lancement…' : resume(g, kinds)}</span>
            </button>
            <button type="button" className="gr-modifie" disabled={!!enCours} onClick={() => ouvre(g)} aria-label={`Modifier le groupe « ${g.nom} »`} title="Modifier le groupe">
              …
            </button>
          </span>
        ))}
        <button type="button" className="gr-plus" disabled={!!enCours} onClick={() => ouvre(null)}>
          + Groupe
        </button>
      </div>
      {avis && (
        <p className={cls('gr-avis', avis.erreur && 'is-erreur')} role="status">
          {avis.texte}
        </p>
      )}
      {edite && createPortal(<Editeur key={edite.brouillon.id} {...edite} kinds={kinds} onFerme={() => setEdite(null)} onEnregistre={enregistre} onSupprime={supprime} />, document.body)}
    </div>
  )
}

// L'éditeur d'un groupe : son nom, ses lignes (type, nombre, modèle pour Claude, rôle, consigne pour un agent), ajoutables
// et retirables ; « Enregistrer » ; « Supprimer » en deux temps. Le panneau des boucles (styles.css `.boucle`) : feuille
// du bas sur le téléphone, fenêtre au milieu sur l'ordinateur, défilement en lui-même.
function Editeur({ brouillon, existe, kinds, onFerme, onEnregistre, onSupprime }) {
  const [g, setG] = useState(brouillon)
  const [confirme, setConfirme] = useState(false)
  const t = total(g)
  const trop = t > MAX_CONSOLES
  const maj = (k, champs) => setG((x) => ({ ...x, lignes: x.lignes.map((l) => (l.k === k ? { ...l, ...champs } : l)) }))
  const types = kinds.length ? kinds : [...new Set(g.lignes.map((l) => l.kind))].map((id) => ({ id, label: id }))
  const titre = existe ? 'Modifier le groupe' : 'Nouveau groupe'
  return (
    <div
      className="boucle-fond gr-fond"
      onClick={(e) => e.target === e.currentTarget && onFerme()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onFerme()
      }}
    >
      <section className="boucle gr-editeur" role="dialog" aria-modal="true" aria-label={titre}>
        <header>
          <b>{titre}</b>
          <span>{resume(g, kinds)}</span>
          <button type="button" className="boucle-x" aria-label="Fermer" onClick={onFerme}>
            ×
          </button>
        </header>
        <label className="boucle-champ">
          <span>Nom</span>
          <input name="gr-nom" value={g.nom} maxLength={MAX_NOM} autoFocus placeholder={resume(g, kinds)} onChange={(e) => setG((x) => ({ ...x, nom: e.target.value }))} />
        </label>
        {g.lignes.map((l, i) => (
          <fieldset key={l.k} className="gr-ligne">
            <legend>Ligne {i + 1}</legend>
            <div className="gr-ligne-tete">
              <select aria-label={`Type, ligne ${i + 1}`} value={l.kind} onChange={(e) => maj(l.k, { kind: e.target.value })}>
                {!types.some((k) => k.id === l.kind) && <option value={l.kind}>{l.kind} (absent)</option>}
                {types.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <span className="gr-pas" role="group" aria-label={`Nombre, ligne ${i + 1}`}>
                <button type="button" aria-label="Une de moins" disabled={l.nombre <= 1} onClick={() => maj(l.k, { nombre: l.nombre - 1 })}>
                  −
                </button>
                <output>{l.nombre}</output>
                <button type="button" aria-label="Une de plus" disabled={l.nombre >= MAX_CONSOLES} onClick={() => maj(l.k, { nombre: l.nombre + 1 })}>
                  +
                </button>
              </span>
              {g.lignes.length > 1 && (
                <button type="button" className="gr-retire" aria-label={`Retirer la ligne ${i + 1}`} onClick={() => setG((x) => ({ ...x, lignes: x.lignes.filter((m) => m.k !== l.k) }))}>
                  ×
                </button>
              )}
            </div>
            {l.kind === 'claude' && (
              <select aria-label={`Modèle, ligne ${i + 1}`} value={l.modele} onChange={(e) => maj(l.k, { modele: e.target.value })}>
                {MODELES.map(([id, nom]) => (
                  <option key={id} value={id}>
                    {nom}
                  </option>
                ))}
              </select>
            )}
            <input aria-label={`Rôle, ligne ${i + 1}`} value={l.role} maxLength={MAX_ROLE} placeholder="Rôle : le nom des consoles (facultatif)" onChange={(e) => maj(l.k, { role: e.target.value })} />
            {l.kind !== 'shell' && (
              <textarea aria-label={`Consigne, ligne ${i + 1}`} rows={2} maxLength={MAX_CONSIGNE} value={l.consigne} placeholder="Consigne de départ (facultative)" onChange={(e) => maj(l.k, { consigne: e.target.value })} />
            )}
          </fieldset>
        ))}
        <button type="button" className="gr-ajoute" disabled={t >= MAX_CONSOLES} onClick={() => setG((x) => ({ ...x, lignes: [...x.lignes, ligne()] }))}>
          + Ligne
        </button>
        <p className={cls('gr-total', trop && 'is-erreur')} role="status">
          {trop ? `${t} consoles : ${MAX_CONSOLES} au plus par groupe. Retires-en ${t - MAX_CONSOLES} pour enregistrer.` : `Total : ${pluriel(t, 'console', 'consoles')}.`}
        </p>
        <div className="gr-actions">
          {existe && (
            <button type="button" className={cls('gr-supprime', confirme && 'is-confirme')} onClick={() => (confirme ? onSupprime(g.id) : setConfirme(true))}>
              {confirme ? 'Supprimer vraiment' : 'Supprimer'}
            </button>
          )}
          <button type="button" className="boucle-go gr-enregistre" disabled={trop} onClick={() => onEnregistre(g)}>
            Enregistrer
          </button>
        </div>
      </section>
    </div>
  )
}
