// Copies de travail (volet « copies », 13/11, rattrapage de Symvibe 1.1.0 : « New worktree » par agent ; Orkun : « On est
// encore loin de toutes les fonctionnalitēs de Symvibe », puis « Go »). Le serveur : lib/copies.mjs.
//   - CaseCopie : la case « Dans une copie » du formulaire « Nouvelle console » (Claude et Codex, dossier dans un dépôt
//     git) ; une seule rangée, les options (fichiers ignorés à copier, installation) n'apparaissent que cochée ;
//   - ContinuerCopie / useCopiable : « Continuer dans une copie » dans le menu d'une console ;
//   - RepereCopie : « copie · <branche> » sur la dalle, dans la ligne de la liste, et l'état de l'installation.
// Les fichiers ignorés ne sont montrés que par leur NOM (cases à cocher), jamais leur contenu.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, cls, useMedia } from './lib.js'
import { MenuDoigt } from './appui.jsx'
import './copies.css'

const MOTIFS = '.env .env.*'
const motifsDe = (texte) => texte.split(/[\s,]+/).filter(Boolean)

// Ce que le serveur propose pour un dossier : { git, branche, depot, sousDossier, fichiers, ecartes, refus? } ou
// { git: false, raison }. `null` tant qu'on ne sait pas (rien n'est affiché). Les motifs relisent la liste après une pause.
function useProposition(dossier, actif, motifs = MOTIFS) {
  const [p, setP] = useState(null)
  useEffect(() => {
    if (!actif || !dossier) return setP(null)
    let vivant = true
    const t = setTimeout(() => {
      api('GET', `/api/copies/proposition?dossier=${encodeURIComponent(dossier)}&motifs=${encodeURIComponent(motifsDe(motifs).join(','))}`).then(
        (r) => vivant && setP(r),
        (e) => vivant && setP({ git: true, refus: e.message, fichiers: [], ecartes: [] }),
      )
    }, 250)
    return () => {
      vivant = false
      clearTimeout(t)
    }
  }, [dossier, actif, motifs])
  return p
}

// Les options d'une copie, serrées : motifs des fichiers ignorés proposés, les fichiers (noms seulement, cochés d'office,
// un nom trop long coupé, entier dans sa bulle), l'installation, et la phrase qui dit d'où part la copie.
function Options({ p, motifs, setMotifs, choisis, setChoisis, installation, setInstallation }) {
  const fichiers = p?.fichiers ?? []
  const bascule = (nom) => setChoisis((s) => (s.includes(nom) ? s.filter((x) => x !== nom) : [...s, nom]))
  return (
    <div className="copie-options">
      <label className="copie-champ">
        <span>Fichiers</span>
        <input value={motifs} maxLength={200} spellCheck={false} autoCapitalize="off" title="Motifs des fichiers ignorés par git à copier (noms, * et ?)" aria-label="Motifs des fichiers ignorés à copier" onChange={(e) => setMotifs(e.target.value)} />
      </label>
      {p?.refus ? (
        <small className="copie-vide">{p.refus}</small>
      ) : fichiers.length ? (
        <ul className="copie-fichiers" aria-label="Fichiers ignorés copiés dans la copie (0600)">
          {fichiers.map((nom) => (
            <li key={nom} title={nom}>
              <label>
                <input type="checkbox" checked={choisis.includes(nom)} onChange={() => bascule(nom)} />
                <code>{nom}</code>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <small className="copie-vide">{p ? 'aucun fichier ignoré ne répond à ces motifs' : '…'}</small>
      )}
      {!!p?.ecartes?.length && (
        <small className="copie-vide copie-ecartes" title={p.ecartes.map((e) => `${e.nom} : ${e.raison}`).join('\n')}>
          non copiables : {p.ecartes.map((e) => `${e.nom} (${e.raison})`).join(', ')}
        </small>
      )}
      <label className="copie-champ">
        <span>Installation</span>
        <input className="copie-install" value={installation} maxLength={300} spellCheck={false} autoCapitalize="off" placeholder="facultatif : npm ci" title="Lancée dans la copie avant l’agent (sans shell : une commande et ses arguments)" aria-label="Commande d’installation (facultatif)" onChange={(e) => setInstallation(e.target.value)} />
      </label>
      {/* Relecture du 13/11 : l'installation tourne par le serveur, hors de tout bac à sable (même pour Codex). */}
      <small className="copie-avert">S’exécute avec tes droits, scripts du dépôt compris.</small>
      <small className="copie-note" title={`La copie part du dernier commit de ${p?.branche || 'la tête détachée'} : les changements non commités restent dans le dossier d’origine.`}>
        Le <b>non commité</b> reste dans le dossier d’origine.
      </small>
    </div>
  )
}

// Ordinateur : les options dans un panneau à côté de la colonne, posé sur le plateau, contre le bas du formulaire. La
// liste de la colonne ne rétrécit pas quand on coche (13/11 : cochée en place, elle tombait à 0 px sur 1920 × 1080).
function Cote({ ancre, children }) {
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    const place = () => {
      const el = ancre.current?.closest('.composer') ?? ancre.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const bord = el.closest('.rail')?.getBoundingClientRect().right ?? r.right // contre le bord de la colonne, pas sur lui
      const neuf = { left: Math.round(Math.max(bord, r.right) + 12), bottom: Math.max(8, Math.round(innerHeight - r.bottom)) }
      setPos((v) => (v && v.left === neuf.left && v.bottom === neuf.bottom ? v : neuf))
    }
    place()
    const t = setInterval(place, 400) // la colonne peut bouger (bandeaux, liste) : on suit, sans animation
    addEventListener('resize', place)
    return () => {
      clearInterval(t)
      removeEventListener('resize', place)
    }
  }, [ancre])
  return pos && createPortal(<div className="copie-cote" style={pos}>{children}</div>, document.body)
}

// L'état des options et la demande qui part au serveur ({ motifs, fichiers, installation }).
function useOptions(p) {
  const [motifs, setMotifs] = useState(MOTIFS)
  const [choisis, setChoisis] = useState([])
  const [installation, setInstallation] = useState('')
  const liste = (p?.fichiers ?? []).join('\0')
  useEffect(() => setChoisis(liste ? liste.split('\0') : []), [liste]) // une liste nouvelle : tout coché d'office
  const demande = { motifs: motifsDe(motifs), fichiers: choisis.filter((n) => p?.fichiers?.includes(n)), installation: installation.trim() }
  return { motifs, setMotifs, choisis, setChoisis, installation, setInstallation, demande }
}

// Formulaire « Nouvelle console » : la case, puis ses options quand elle est cochée. `onChange(demande | null)`.
export function CaseCopie({ kind, cwd, onChange }) {
  const agent = kind === 'claude' || kind === 'codex'
  const tel = useMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)') // la mesure du téléphone d'App.jsx
  const ancre = useRef(null)
  const [coche, setCoche] = useState(false)
  const [motifsVus, setMotifsVus] = useState(MOTIFS)
  const p = useProposition(cwd, agent, motifsVus)
  const o = useOptions(p)
  useEffect(() => {
    const t = setTimeout(() => setMotifsVus(o.motifs), 400)
    return () => clearTimeout(t)
  }, [o.motifs])
  const possible = agent && p?.git && !p.refus
  const cle = JSON.stringify(possible && coche ? o.demande : null)
  useEffect(() => {
    onChange(JSON.parse(cle))
  }, [cle]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!agent || !p?.git) return null // pas Claude / Codex, ou dossier hors de tout dépôt git : la case n'existe pas
  return (
    <>
      <label ref={ancre} className={cls('copie-case', !possible && 'est-grise')} title={p.refus || `Une copie de travail (git worktree) sur une branche neuve, partie du dernier commit de ${p.branche || 'la tête détachée'}`}>
        <input type="checkbox" checked={possible && coche} disabled={!possible} onChange={(e) => setCoche(e.target.checked)} />
        <span>Dans une copie</span>
        <small>{p.refus || `depuis ${p.branche || 'la tête détachée'}`}</small>
      </label>
      {possible && coche && (tel ? <Options p={p} {...o} /> : (
        <Cote ancre={ancre}>
          <b className="copie-titre">Dans une copie · depuis {p.branche || 'la tête détachée'}</b>
          <Options p={p} {...o} />
        </Cote>
      ))}
    </>
  )
}

// Menu d'une console : « Continuer dans une copie » n'existe que pour une console Claude / Codex hors équipe dont le
// dossier est dans un dépôt git dont on peut faire une copie.
// Le menu d'une console doit savoir AVANT de s'ouvrir si son dossier permet une copie : la ligne « Continuer dans une
// copie » arrivait ~300 ms après l'ouverture (demande au serveur) et décalait les lignes du dessous sous le doigt (vu au
// banc le 13/11 : un toucher visé sur « Mémoire du projet » tombait sur elle ; le menu se recale aussi à chaque rendu).
// La réponse est donc préparée une fois par dossier, dès que la liste des consoles s'affiche (`usePrechargeCopies`), et
// gardée pour la page : le menu lit ce qui est déjà su. Un dossier jamais vu (rare) la demande à l'ouverture, comme avant.
const connus = new Map() // dossier → proposition, ou la promesse de la demande en cours
function propositionDe(dossier) {
  if (!connus.has(dossier))
    connus.set(
      dossier,
      api('GET', `/api/copies/proposition?dossier=${encodeURIComponent(dossier)}&motifs=${encodeURIComponent(motifsDe(MOTIFS).join(','))}`).then(
        (r) => (connus.set(dossier, r), r),
        // Un échec (réseau coupé un instant sur le téléphone, session finie) n'est pas gardé : l'ouverture suivante du menu
        // redemande. Pour celle-ci, pas de « Continuer dans une copie » (on ne sait pas).
        (e) => {
          connus.delete(dossier)
          return { git: true, refus: e.message, fichiers: [], ecartes: [] }
        },
      ),
    )
  return connus.get(dossier)
}
const copiable = (c) => (c.kind === 'claude' || c.kind === 'codex') && !c.team && !!c.cwd

// Appelé par la liste des consoles (Rail.jsx) : une demande par dossier distinct, une seule fois pour la page.
export function usePrechargeCopies(consoles) {
  const cle = [...new Set(consoles.filter(copiable).map((c) => c.cwd))].sort().join('\n')
  useEffect(() => {
    if (cle) for (const d of cle.split('\n')) propositionDe(d)
  }, [cle])
}

export function useCopiable(c) {
  const actif = copiable(c)
  const su = actif ? connus.get(c.cwd) : null
  const [p, setP] = useState(su && !(su instanceof Promise) ? su : null)
  useEffect(() => {
    if (!actif) return setP(null)
    let vivant = true
    Promise.resolve(propositionDe(c.cwd)).then((r) => vivant && setP(r))
    return () => {
      vivant = false
    }
  }, [actif, c.cwd])
  return p?.git && !p.refus ? p : null
}

export function ContinuerCopie({ c, p, onFait }) {
  const [motifsVus, setMotifsVus] = useState(MOTIFS)
  const relue = useProposition(c.cwd, true, motifsVus)
  const vue = relue ?? p
  const o = useOptions(vue)
  const [occupe, setOccupe] = useState(false)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setMotifsVus(o.motifs), 400)
    return () => clearTimeout(t)
  }, [o.motifs])
  const lance = async () => {
    setOccupe(true)
    setErreur('')
    try {
      onFait(await api('POST', `/api/consoles/${c.id}/copie`, o.demande))
    } catch (e) {
      setErreur(e.message)
      setOccupe(false)
    }
  }
  return (
    <div className="copie-continuer">
      <p className="copie-note">
        Une console {c.kind === 'codex' ? 'Codex' : 'Claude'} neuve (même modèle, même compte) dans une copie neuve, sur une branche partie du dernier commit de <b>{vue?.branche || 'la tête détachée'}</b>
        {c.agent ? ', avec la conversation de celle-ci' : ''}. Les changements <b>non commités</b> de ce dossier restent dans le dossier d’origine. Cette console reste ouverte.
      </p>
      <Options p={vue} {...o} />
      <button type="button" className="copie-go" disabled={occupe} onClick={lance}>
        {occupe ? 'Copie…' : 'Continuer dans une copie'}
      </button>
      {erreur && <b>{erreur}</b>}
    </div>
  )
}

// L'installation d'une copie, en mots : « installation… », « installation échouée (code 1) »…
function motInstallation(inst) {
  if (!inst) return ''
  if (inst.etat === 'en cours') return `installation · ${String(inst.commande?.[0] ?? '').split('/').pop()}…` // « npm », pas son chemin
  if (inst.etat === 'réussie') return ''
  const detail = inst.code !== undefined ? `code ${inst.code}` : inst.signal || inst.raison || ''
  return `installation ${inst.etat}${detail ? ` (${detail})` : ''}`
}

// Les dernières lignes du journal de l'installation, relues toutes les 2 s tant qu'elle tourne.
function Journal({ id, etat }) {
  const [r, setR] = useState(null)
  useEffect(() => {
    let vivant = true
    let t
    const lis = () =>
      api('GET', `/api/copies/installation/${id}`).then(
        (x) => {
          if (!vivant) return
          setR(x)
          if (x.etat === 'en cours') t = setTimeout(lis, 2000)
        },
        (e) => vivant && setR({ lignes: [e.message] }),
      )
    lis()
    return () => {
      vivant = false
      clearTimeout(t)
    }
  }, [id, etat])
  return <pre className="copie-journal">{r ? r.lignes.slice(-24).join('\n') || '(rien encore)' : '…'}</pre>
}

// Le journal de l'installation dans le menu d'une console (« Journal de l'installation ») : le seul chemin vers lui au
// téléphone, où la barre de la dalle n'est pas sous le doigt.
export function JournalInstallation({ c }) {
  const inst = c.copie?.installation
  if (!inst) return null
  return (
    <>
      <b className="copie-titre-journal" title={inst.commande?.join(' ')}>
        Installation · {motInstallation(inst) || 'réussie'}
      </b>
      <Journal id={c.id} etat={inst.etat} />
    </>
  )
}

// Le repère d'une console dans une copie. `ligne` : dans une ligne de la liste (déjà un bouton : aucun bouton de plus,
// le détail est dans la bulle et dans le menu) ; sinon (barre de la dalle) l'état de l'installation ouvre la fin de son
// journal.
export function RepereCopie({ c, ligne = false }) {
  const [voit, setVoit] = useState(null) // { x, y } : la fin du journal est ouverte sous (ou sur) le bouton
  const k = c.copie
  if (!k?.branche) return null
  const inst = k.installation
  const mot = motInstallation(inst)
  const echec = inst && inst.etat !== 'en cours' && inst.etat !== 'réussie'
  const bulle = [
    `Copie de travail : ${k.dossier}`,
    `branche ${k.branche}, partie de ${k.depuis || 'la tête détachée'} (${String(k.base).slice(0, 7)})`,
    k.fichiers?.length ? `fichiers copiés : ${k.fichiers.join(', ')}` : 'aucun fichier ignoré copié',
    ...(k.ecartes?.length ? [`non copiés : ${k.ecartes.map((e) => `${e.nom} (${e.raison})`).join(', ')}`] : []),
    ...(k.filtres?.length ? [`filtres non appliqués (fichiers bruts) : ${k.filtres.join(', ')}`] : []),
    ...(inst ? [`installation : ${inst.commande?.join(' ')} — ${inst.etat}${inst.raison ? ` : ${inst.raison}` : ''}`, ...(inst.extrait ? [inst.extrait] : [])] : []),
  ].join('\n')
  // Dans la liste : la branche sur sa ligne, l'installation sur la sienne (un échec s'y lit en entier : son code et ses
  // dernières lignes, sur deux lignes au plus, le reste dans la bulle et dans « Journal de l'installation » du menu).
  if (ligne)
    return (
      <>
        <span className="copie-repere est-ligne" title={bulle}>
          <span className="copie-branche">copie · {k.branche}</span>
        </span>
        {mot && (
          <span className={cls('copie-inst-ligne', echec && 'est-echec')} title={bulle}>
            {echec && inst.extrait ? `${mot} · ${inst.extrait}` : mot}
          </span>
        )}
      </>
    )
  return (
    <span className="copie-repere nodrag" title={bulle}>
      <span className="copie-branche">copie · {k.branche}</span>
      {mot && (
        <button
          type="button"
          className={cls('copie-inst', echec && 'est-echec')}
          aria-expanded={!!voit}
          title="Voir la fin du journal de l’installation"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setVoit((v) => (v ? null : { x: r.left + r.width / 2, y: r.top + 12 < 260 ? Math.min(r.bottom - 22, 259) : r.top + 12 }))
          }}
        >
          {mot}
        </button>
      )}
      {voit && inst && (
        <MenuDoigt x={voit.x} y={voit.y} onClose={() => setVoit(null)} colonne>
          <b className="copie-titre-journal" title={inst.commande?.join(' ')}>
            Installation · {inst.commande?.join(' ')}
          </b>
          <Journal id={c.id} etat={inst.etat} />
        </MenuDoigt>
      )}
    </span>
  )
}
