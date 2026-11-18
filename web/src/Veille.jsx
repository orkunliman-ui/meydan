import { useEffect, useRef, useState } from 'react'
import { api, shortDir } from './lib.js'
import './veille.css'
import { useEtape } from './retour.js'

export function BadgeSilence({ c }) {
  const etat = c.silence?.etat
  if (!['suspecte', 'muette', 'reportee'].includes(etat)) return null
  return <span className={`silence-badge silence-${etat}`}>{etat === 'muette' ? 'MUETTE · 15 min' : etat === 'suspecte' ? 'SUSPECTE · 5 min' : 'Alerte reportée'}</span>
}

export function ReglageVerification({ team }) {
  const [erreur, setErreur] = useState('')
  const [busy, setBusy] = useState(false)
  const change = async (active) => {
    setBusy(true); setErreur('')
    try { await api('PATCH', `/api/equipes/${team.id}/verification`, { active }) }
    catch (e) { setErreur(e.message) } finally { setBusy(false) }
  }
  const v = team.verification
  return <div className="verification-reglage">
    <label title="Quand le capitaine déclare le travail fini, Codex le relit avant la livraison : une vérification, 2 relances par équipier au plus. File de livraison active : Codex relit aussi chaque livraison d’équipier avant qu’elle entre dans l’intégration"><input type="checkbox" checked={!!team.verifierFin} disabled={busy} onChange={(e) => change(e.target.checked)} /> Contrôle Codex avant livraison</label>
    <small>Codex relit le travail fini avant que tu livres</small>
    {v && <p role="status">{v.etat === 'active' ? 'Vérification en cours' : v.etat === 'acceptee' ? 'Vérification acceptée' : 'Vérification à reprendre'}{v.verdict ? ` — ${v.verdict}` : ''}</p>}
    {team.git && <ReglageFile team={team} />}
    {erreur && <p role="alert">{erreur}</p>}
  </div>
}

// File de livraison d'une équipe sous git (volet livraison-equipes, 17/11) : Orkun l'active et règle sa commande de
// vérification ici, à côté du contrôle Codex ; l'état de la file tient sur une ligne, sous le réglage.
const ETATS_FILE = { attente: 'en attente', fusion: 'en fusion', verification: 'en vérification', relecture: 'en relecture', atterrissage: 'atterrit' }
const FINS_FILE = { atterrie: 'atterrie', refusee: 'refusée', retenue: 'retenue pour le capitaine', annulee: 'annulée', erreur: 'en erreur' }
function ReglageFile({ team }) {
  const [commande, setCommande] = useState(team.file?.commande || '')
  const [erreur, setErreur] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setCommande(team.file?.commande || ''), [team.file?.commande])
  const regle = async (corps) => {
    setBusy(true); setErreur('')
    try { await api('PATCH', `/api/equipes/${team.id}/livraison`, corps) }
    catch (e) { setErreur(e.message) } finally { setBusy(false) }
  }
  const active = !!team.file?.active
  const liste = team.livraisons || []
  const enCours = liste.filter((l) => ETATS_FILE[l.etat])
  const derniere = [...liste].reverse().find((l) => FINS_FILE[l.etat])
  return <>
    <label className="file-case" title="Le « done » d’un équipier qui écrit : sa branche est fusionnée à part, vérifiée par ta commande, relue par Codex si le contrôle est coché, puis posée sur la branche d’intégration de l’équipe (jamais sur le projet : « Livrer » reste à toi)"><input type="checkbox" checked={active} disabled={busy} onChange={(e) => regle({ active: e.target.checked })} /> File de livraison</label>
    {active && <input className="file-commande" type="text" aria-label="Commande de vérification de l’équipe" placeholder="Commande de vérification (npm test…)" maxLength={500} value={commande} disabled={busy} onChange={(e) => setCommande(e.target.value)} onBlur={() => commande.trim() !== (team.file?.commande || '') && regle({ commande })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />}
    {(enCours.length > 0 || derniere) && <p role="status" className="file-etat">File : {enCours.length ? enCours.map((l) => `${l.nom} ${ETATS_FILE[l.etat]}`).join(' · ') : 'vide'}{derniere ? ` — dernière : ${derniere.nom} ${FINS_FILE[derniere.etat]}${derniere.etat === 'atterrie' && derniere.merge ? ` ${derniere.merge.slice(0, 7)}` : ''}` : ''}</p>}
    {erreur && <p role="alert">{erreur}</p>}
  </>
}

export function Veille({ consoles }) {
  const [onglet, setOnglet] = useState(null)
  const [entrees, setEntrees] = useState([])
  const [revues, setRevues] = useState([])
  const [fiable, setFiable] = useState(true)
  const [projet, setProjet] = useState('')
  const [archives, setArchives] = useState(false)
  const [lecon, setLecon] = useState('')
  const [erreur, setErreur] = useState('')
  const [busy, setBusy] = useState(false)
  const dialog = useRef(null)
  // Téléphone : le panneau prend une étape d'historique, « retour » le ferme par la fermeture du dialogue (son `onClose`
  // remet aussi la leçon à zéro) ; passer de Suggestions à Agents bloqués n'en ajoute pas (retour.js).
  useEtape(!!onglet, () => (dialog.current?.open ? dialog.current.close() : setOnglet(null)))
  const lireRevues = () => api('GET', '/api/revues').then((r) => { setRevues(r.revues); setFiable(r.fiable) }, (e) => setErreur(e.message))
  useEffect(() => {
    lireRevues()
    const t = setInterval(lireRevues, 120_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!onglet) return
    dialog.current?.showModal()
    if (dialog.current) dialog.current.scrollTop = 0
    api('GET', '/api/suggestions').then((r) => setEntrees(r.suggestions), (e) => setErreur(e.message))
    lireRevues()
  }, [onglet])
  const silencieuses = consoles.filter((c) => ['suspecte', 'muette', 'reportee'].includes(c.silence?.etat))
  const alertes = silencieuses.filter((c) => c.silence.etat !== 'reportee').length + revues.length
  const agir = async (f) => {
    setBusy(true); setErreur('')
    try { await f() } catch (e) { setErreur(e.message) } finally { setBusy(false) }
  }
  return <>
    <nav className="veille-acces" aria-label="Veille des agents">
      <button type="button" onClick={() => setOnglet('suggestions')}>Suggestions des agents</button>
      <button type="button" className={alertes ? 'veille-a-voir' : ''} title="Agents qui « travaillent » sans plus rien écrire depuis 5 min (suspect) ou 15 min (muet), et revues Claude + Codex arrêtées en route" onClick={() => setOnglet('alertes')}>Agents bloqués{alertes > 0 ? ` · ${alertes}` : ''}</button>
    </nav>
    {onglet && <dialog ref={dialog} className="veille-dialog" onCancel={() => setOnglet(null)} onClose={() => { setOnglet(null); setLecon('') }}>
      <header><h2>{onglet === 'suggestions' ? 'Suggestions des agents' : 'Agents bloqués'}</h2><button type="button" onClick={() => dialog.current.close()}>Fermer</button></header>
      <nav aria-label="Écran de veille"><button type="button" aria-pressed={onglet === 'suggestions'} onClick={() => setOnglet('suggestions')}>Suggestions</button><button type="button" aria-pressed={onglet === 'alertes'} onClick={() => setOnglet('alertes')}>Agents bloqués · {alertes}</button></nav>
      {erreur && <p role="alert">{erreur}</p>}
      {onglet === 'suggestions' ? <>
        <div className="veille-filtres"><label>Projet <select aria-label="Filtrer par projet" value={projet} onChange={(e) => setProjet(e.target.value)}><option value="">Tous les projets</option>{[...new Set(entrees.map((x) => x.projet))].map((p) => <option key={p} value={p}>{shortDir(p)}</option>)}</select></label><label><input type="checkbox" checked={archives} onChange={(e) => setArchives(e.target.checked)} /> Voir les entrées classées</label></div>
        {entrees.filter((x) => (!projet || x.projet === projet) && (archives || !x.classee)).map((x) => <article className="veille-carte" key={x.id}>
          <small>{x.type === 'plainte' ? 'PLAINTE' : 'SUGGESTION'} · {shortDir(x.projet)} · {x.date.slice(0, 10)}{x.classee ? ' · classée' : ''}</small>
          <p>{x.texte}</p><small>Session {x.session}</small>
          <div className="veille-actions"><button type="button" disabled={busy} onClick={() => agir(async () => setLecon((await api('GET', `/api/suggestions/${x.id}/lecon`)).texte))}>Garder comme leçon</button><button type="button" disabled={busy || x.classee} onClick={() => agir(async () => { await api('POST', `/api/suggestions/${x.id}/classer`, {}); setEntrees((l) => l.map((e) => e.id === x.id ? { ...e, classee: true } : e)) })}>Classer</button></div>
        </article>)}
        {!entrees.some((x) => (!projet || x.projet === projet) && (archives || !x.classee)) && <p>Aucune suggestion à lire pour ce filtre.</p>}
        {lecon && <section className="veille-lecon"><h3>Texte à coller dans tasks/lessons.md</h3><p>Vérifie la cause et complète la règle avant de garder cette leçon.</p><textarea aria-label="Leçon à copier" readOnly value={lecon} rows={5} onFocus={(e) => e.target.select()} /><small>Meydan n’écrit pas dans le projet.</small></section>}
      </> : <>
        {!fiable && <p role="status">Lecture des processus incomplète : impossible de confirmer de nouvelles revues mortes.</p>}
        {silencieuses.map((c) => <article className="veille-carte" key={c.id}><small>CONSOLE</small><h3>{c.name}</h3><BadgeSilence c={c} /><p>{c.silence.etat === 'reportee' ? 'Alerte mise de côté pendant 30 minutes.' : 'Aucune nouvelle sortie. Vérifie si le travail avance encore.'}</p><button type="button" disabled={busy || c.silence.etat === 'reportee'} onClick={() => agir(() => api('POST', `/api/consoles/${c.id}/silence`, {}))}>Plus tard · 30 min</button></article>)}
        {revues.map((r) => <article className="veille-carte" key={r.id}><small>REVUE MORTE</small><h3>claudex-loop</h3><p>{r.fichier}</p><p>{r.raison}</p></article>)}
        {!silencieuses.length && !revues.length && <p>Aucune alerte en cours.</p>}
      </>}
    </dialog>}
  </>
}
