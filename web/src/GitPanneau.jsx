// Panneau Git d'un projet, en carte sur le plateau (volet plateau-etendu, 11/11) : branche, état, derniers commits et
// différences ; commit des fichiers cochés sur demande d'Orkun (message écrit par lui, puis confirmation à l'écran,
// jamais `window.confirm`). Serveur : lib/git-panneau.mjs. Aucun échange avec un autre dépôt : ni bouton, ni texte.
// Plateau du téléphone (`tel`) : une tuile fixe, chargée une seule fois (aucun minuteur, aucun défilement, aucune
// animation). Vue de loin (`far`) : rien dans le corps, le cadre montre le titre en grand.
// Copies (volet copies, 13/11 ; Orkun : « ni push ni PR », fusion LOCALE seulement) : sur PC, une section « Copies »
// (les worktrees du dépôt) avec « Fusionner dans <branche> » (contrôle → ce qui entre et les refus → « Confirmer la
// fusion ») et « Retirer la copie » (deux temps si la branche n'est pas fusionnée) ; au téléphone, un résumé seul.
import { memo, useContext, useEffect, useState } from 'react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { api, cls, shortDir } from './lib.js'
import './carte-git.css'

const nomDe = (dossier) => dossier.split('/').filter(Boolean).at(-1) || dossier
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`
const quand = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const nomBranche = (e) => (e.detache ? `tête détachée ${e.sha.slice(0, 7)}` : e.branche)
const nbChangements = (e) => e.coupe || e.fichiers.length
// Classe du badge de type (lib/git-panneau.mjs : modifié | ajouté | supprimé | renommé | non suivi | conflit).
const BADGE = { modifié: 'mod', ajouté: 'aj', supprimé: 'sup', renommé: 'ren', 'non suivi': 'ns', conflit: 'cf' }
const commitable = (f) => f.type !== 'conflit' && !f.chemin.endsWith('/')

export const GitPanneau = memo(function GitPanneau({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const [choix, setChoix] = useState(false) // « changer de projet » ouvert
  const [tic, setTic] = useState(0) // « rafraîchir » : relit l'état tout de suite
  const [erreurChoix, setErreurChoix] = useState('')
  const choisit = (dossier) => {
    setChoix(false)
    setErreurChoix('')
    actions.patch(id, { dossier }).catch((e) => setErreurChoix(e.message))
  }
  const outils = k.dossier ? (
    <>
      <button type="button" className="et-git-outil nodrag" title="Rafraîchir" aria-label="Rafraîchir" onClick={() => setTic((t) => t + 1)}>
        ↻
      </button>
      <button type="button" className={cls('et-git-outil nodrag', choix && 'est-active')} title="Changer de projet" onClick={() => setChoix((c) => !c)}>
        Projet
      </button>
    </>
  ) : null
  let corps = null
  if (tel) corps = <TuileTel id={id} dossier={k.dossier} actions={actions} />
  else if (far) corps = null
  else if (!k.dossier || choix) corps = <ChoixProjet actuel={k.dossier} erreur={erreurChoix} onChoisi={choisit} onAnnule={k.dossier ? () => setChoix(false) : null} />
  else corps = <Panneau key={k.dossier} id={id} k={k} actions={actions} tic={tic} onProjet={() => setChoix(true)} />
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={k.dossier ? nomDe(k.dossier) : 'Git'} outils={outils}>
      {corps}
    </Carte>
  )
})

// Le choix du projet : la liste de GET /api/projects (les dossiers de ~ qui portent .git, tasks ou package.json ; la
// route ne dit pas lesquels sont des dépôts, un dossier sans git répond « pas la racine d'un dépôt git »).
function ChoixProjet({ actuel, erreur, onChoisi, onAnnule }) {
  const [projets, setProjets] = useState(null)
  const [echec, setEchec] = useState('')
  useEffect(() => {
    let vivant = true
    api('GET', '/api/projects').then(
      (j) => vivant && setProjets(j.projects || []),
      (e) => vivant && setEchec(e.message),
    )
    return () => {
      vivant = false
    }
  }, [])
  return (
    <div className="et-git-defile et-git-choix">
      <p className="et-git-h">Choisis le projet à suivre</p>
      <p className="et-git-aide">Le panneau lit la branche, les changements et les commits du dépôt git à la racine du dossier.</p>
      {(erreur || echec) && (
        <p className="et-git-erreur" role="alert">
          {erreur || echec}
        </p>
      )}
      {!projets && !echec && <p className="et-git-aide">Chargement de la liste…</p>}
      <ul className="et-git-projets">
        {projets?.map((p) => (
          <li key={p.path}>
            <button type="button" className={cls('et-git-projet', p.path === actuel && 'est-actuel')} onClick={() => onChoisi(p.path)}>
              <b>{p.name}</b>
              <span>{shortDir(p.path)}</span>
            </button>
          </li>
        ))}
      </ul>
      {onAnnule && (
        <button type="button" className="et-git-bouton" onClick={onAnnule}>
          Annuler
        </button>
      )}
    </div>
  )
}

// Le panneau d'un dépôt : relu au montage, au retour du focus de la fenêtre et toutes les 10 s (ce composant n'existe
// que hors de la vue de loin et du téléphone).
function Panneau({ id, k, actions, tic, onProjet }) {
  const [etat, setEtat] = useState(null)
  const [erreur, setErreur] = useState('')
  // { fichier } | { commit } : la visionneuse à la place de la liste ; { fusion } | { retrait } : l'écran d'une copie.
  const [vue, setVue] = useState(null)
  useEffect(() => {
    let vivant = true
    let enCours = false
    const charge = () => {
      if (enCours) return
      enCours = true
      actions
        .git(id)
        .then(
          (j) => {
            if (!vivant) return
            setEtat(j)
            setErreur('')
          },
          (e) => vivant && setErreur(e.message),
        )
        .finally(() => {
          enCours = false
        })
    }
    charge()
    const t = setInterval(charge, 10000)
    window.addEventListener('focus', charge)
    return () => {
      vivant = false
      clearInterval(t)
      window.removeEventListener('focus', charge)
    }
  }, [id, tic, actions])

  if (vue?.fichier) return <VueFichier id={id} f={vue.fichier} actions={actions} onRetour={() => setVue(null)} />
  if (vue?.commit) return <VueCommit id={id} c={vue.commit} actions={actions} onRetour={() => setVue(null)} />
  if (vue?.fusion) return <VueFusion id={id} c={vue.fusion} actions={actions} onRetour={() => setVue(null)} onEtat={setEtat} onRetrait={() => setVue({ retrait: vue.fusion })} />
  if (vue?.retrait) return <VueRetrait id={id} c={vue.retrait} actions={actions} onRetour={() => setVue(null)} />
  if (!etat)
    return erreur ? (
      <div className="et-git-defile">
        <div className="et-git-erreur et-git-bloc" role="alert">
          <p>{erreur}</p>
          <button type="button" className="et-git-bouton" onClick={onProjet}>
            Changer de projet
          </button>
        </div>
      </div>
    ) : (
      <p className="et-git-aide et-git-marge">Lecture du dépôt…</p>
    )
  const n = nbChangements(etat)
  return (
    <div className="et-git-defile">
      <p className="et-git-branche">
        <b>{nomBranche(etat)}</b>
        <span className={cls(!etat.propre && 'est-change')}>{etat.propre ? 'propre' : pluriel(n, 'changement')}</span>
        {etat.initial && <span>aucun commit</span>}
      </p>
      {erreur && (
        <p className="et-git-erreur" role="alert">
          {erreur}
        </p>
      )}
      <Changements id={id} etat={etat} actions={actions} onVoir={(f) => setVue({ fichier: f })} onFait={setEtat} />
      <Copies id={id} k={k} actions={actions} tic={tic} onFusion={(c) => setVue({ fusion: c })} onRetrait={(c) => setVue({ retrait: c })} />
      <section>
        <h3 className="et-git-h">Commits</h3>
        {etat.commits.length ? (
          <ul className="et-git-commits">
            {etat.commits.map((c) => (
              <li key={c.sha}>
                <button type="button" className="et-git-commit" onClick={() => setVue({ commit: c })} title="Voir le commit et ses différences">
                  <code>{c.court}</code>
                  <span className="et-git-sujet">{c.sujet}</span>
                  <span className="et-git-meta">
                    {c.auteur} · {quand(c.date)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="et-git-aide">Aucun commit sur cette branche.</p>
        )}
      </section>
    </div>
  )
}

// Les changements, une case par fichier (toutes cochées par défaut), et le commit en deux temps.
function Changements({ id, etat, actions, onVoir, onFait }) {
  // Les fichiers décochés : un fichier nouveau arrive coché ; une case décochée le reste après un commit (choix d'Orkun).
  const [decoches, setDecoches] = useState(() => new Set())
  const [message, setMessage] = useState('')
  const [attente, setAttente] = useState(null) // les fichiers du commit à confirmer
  const [envoi, setEnvoi] = useState(false)
  const [fait, setFait] = useState('')
  const [erreur, setErreur] = useState('')
  const branche = etat.detache ? 'la tête détachée' : etat.branche
  const choisis = etat.fichiers.filter((f) => commitable(f) && !decoches.has(f.chemin)).map((f) => f.chemin)
  const bascule = (c) =>
    setDecoches((s) => {
      const n = new Set(s)
      if (n.has(c)) n.delete(c)
      else n.add(c)
      return n
    })
  const confirme = async () => {
    setEnvoi(true)
    setErreur('')
    try {
      const r = await actions.git(id, '/commit', 'POST', { message, fichiers: attente, confirme: true })
      setFait(`Commit ${r.court} fait sur ${branche}.`)
      setMessage('')
      onFait(r.etat)
    } catch (e) {
      setErreur(e.message)
    } finally {
      setAttente(null)
      setEnvoi(false)
    }
  }
  return (
    <section>
      <h3 className="et-git-h">
        Changements <span>{nbChangements(etat) || ''}</span>
      </h3>
      {etat.propre ? (
        <p className="et-git-aide">Rien à commiter : le dossier de travail est propre.</p>
      ) : (
        <>
          <ul className="et-git-fichiers">
            {etat.fichiers.map((f) => (
              <li key={f.chemin} className="et-git-fichier">
                <input
                  type="checkbox"
                  checked={commitable(f) && !decoches.has(f.chemin)}
                  disabled={!commitable(f) || !!attente}
                  onChange={() => bascule(f.chemin)}
                  aria-label={`Inclure ${f.chemin} dans le commit`}
                  title={commitable(f) ? undefined : f.type === 'conflit' ? 'Conflit à résoudre dans un terminal' : 'Dépôt imbriqué : pas commité par le panneau'}
                />
                <button type="button" className="et-git-lien" onClick={() => onVoir(f)} title="Voir les différences">
                  <span className={`et-git-badge est-${BADGE[f.type] || 'mod'}`}>{f.type}</span>
                  <span className="et-git-chemin">{f.ancien ? `${f.ancien} → ${f.chemin}` : f.chemin}</span>
                </button>
              </li>
            ))}
          </ul>
          {etat.coupe > 0 && <p className="et-git-aide">Liste coupée à {etat.fichiers.length} fichiers sur {etat.coupe}.</p>}
          <div className="et-git-form">
            <textarea
              className="et-git-message-saisie"
              value={message}
              disabled={!!attente}
              maxLength={5000}
              rows={3}
              placeholder="Message du commit (écrit par toi)"
              aria-label="Message du commit (écrit par toi)"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {attente ? (
              <div className="et-git-confirme" role="group" aria-label="Confirmation du commit">
                <span>
                  Confirmer le commit sur <b>{branche}</b> ? ({pluriel(attente.length, 'fichier')})
                </span>
                <button type="button" className="et-git-bouton est-fort" disabled={envoi} onClick={confirme}>
                  {envoi ? 'Commit…' : 'Confirmer'}
                </button>
                <button type="button" className="et-git-bouton" disabled={envoi} onClick={() => setAttente(null)}>
                  Annuler
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="et-git-bouton est-fort"
                disabled={!message.trim() || !choisis.length}
                onClick={() => {
                  setAttente(choisis)
                  setFait('')
                  setErreur('')
                }}
              >
                Commiter {pluriel(choisis.length, 'fichier')}
              </button>
            )}
          </div>
        </>
      )}
      {erreur && (
        <p className="et-git-erreur" role="alert">
          {erreur}
        </p>
      )}
      {fait && (
        <p className="et-git-fait" role="status">
          {fait}
        </p>
      )}
    </section>
  )
}

// La visionneuse : une barre (retour, quoi), puis une zone qui défile dans la carte (molette prise par la carte sur PC :
// le corps porte `nowheel`).
function VueFichier({ id, f, actions, onRetour }) {
  const deuxCotes = !!f.index && !!f.travail && f.type !== 'non suivi' && f.type !== 'conflit'
  const [cote, setCote] = useState(f.travail ? 'travail' : 'index')
  const [r, setR] = useState(null)
  useEffect(() => {
    let vivant = true
    setR(null)
    actions.git(id, `/diff?chemin=${encodeURIComponent(f.chemin)}&cote=${cote}`).then(
      (j) => vivant && setR(j),
      (e) => vivant && setR({ erreur: e.message }),
    )
    return () => {
      vivant = false
    }
  }, [id, f.chemin, cote, actions])
  return (
    <div className="et-git-vue">
      <div className="et-git-vue-tete">
        <button type="button" className="et-git-bouton" onClick={onRetour}>
          ← Retour
        </button>
        <span className={`et-git-badge est-${BADGE[f.type] || 'mod'}`}>{f.type}</span>
        <span className="et-git-chemin" title={f.chemin}>
          {f.chemin}
        </span>
        {deuxCotes && (
          <span className="et-git-cotes">
            {[
              ['travail', 'non indexé'],
              ['index', 'indexé'],
            ].map(([c, nom]) => (
              <button key={c} type="button" className={cls('et-git-cote', cote === c && 'est-active')} onClick={() => setCote(c)}>
                {nom}
              </button>
            ))}
          </span>
        )}
      </div>
      <Diff r={r} />
    </div>
  )
}

function VueCommit({ id, c, actions, onRetour }) {
  const [r, setR] = useState(null)
  useEffect(() => {
    let vivant = true
    actions.git(id, `/commit/${c.sha}`).then(
      (j) => vivant && setR(j),
      (e) => vivant && setR({ erreur: e.message }),
    )
    return () => {
      vivant = false
    }
  }, [id, c.sha, actions])
  return (
    <div className="et-git-vue">
      <div className="et-git-vue-tete">
        <button type="button" className="et-git-bouton" onClick={onRetour}>
          ← Retour
        </button>
        <code className="et-git-court">{c.court}</code>
        <span className="et-git-sujet" title={c.sujet}>
          {c.sujet}
        </span>
      </div>
      <Diff r={r}>
        {r && !r.erreur && (
          <div className="et-git-commit-tete">
            <p className="et-git-meta">
              {r.auteur} · {quand(r.date)} · <code>{r.sha}</code>
            </p>
            <pre className="et-git-message">{r.message}</pre>
            {r.stat && <pre className="et-git-stat">{r.stat.replace(/\n$/, '')}</pre>}
          </div>
        )}
      </Diff>
    </div>
  )
}

// ── Copies (volet copies, 13/11) ──
// Les worktrees du dépôt : relus au montage, au retour du focus, au « ↻ » et toutes les 30 s (chacun coûte quelques git
// sur le serveur, qui partage une liste récente entre cartes et onglets ; « ↻ » la fait refaire : `?relire=1`). Rien
// quand le dépôt n'en a pas ; une ligne quand la carte suit elle-même une copie.
const nonCommitesDe = (c) => (c.nonCommites == null ? '' : c.nonCommites ? `${c.nonCommites}${c.nonCommitesCoupe ? '+' : ''} non commité${c.nonCommites > 1 ? 's' : ''}` : 'rien de non commité')
const brancheDe = (c) => c.branche || `tête détachée ${c.court}`
function Copies({ id, k, actions, tic, onFusion, onRetrait }) {
  const [r, setR] = useState(null)
  const [erreur, setErreur] = useState('')
  const [info, setInfo] = useState('')
  useEffect(() => {
    let vivant = true
    let enCours = false
    const charge = (relire) => {
      if (enCours) return
      enCours = true
      actions
        .git(id, relire === true ? '/copies?relire=1' : '/copies')
        .then(
          (j) => {
            if (!vivant) return
            setR(j)
            setErreur('')
          },
          (e) => vivant && setErreur(e.message),
        )
        .finally(() => {
          enCours = false
        })
    }
    const relue = () => charge(false)
    charge(tic > 0)
    const t = setInterval(relue, 30000)
    window.addEventListener('focus', relue)
    return () => {
      vivant = false
      clearInterval(t)
      window.removeEventListener('focus', relue)
    }
  }, [id, tic, actions])
  // « Ouvrir le panneau de cette copie » : une carte Git posée à droite de celle-ci, sur le dossier de la copie (pour
  // commiter son travail avant de la fusionner). Elle porte le dépôt principal (`depot`) : le serveur en tire le dossier
  // git de la copie, jamais de la copie elle-même (une carte sur une copie sans lui est refusée).
  const ouvre = (c) => {
    setInfo('')
    actions.cree('git', { dossier: c.chemin, depot: k.dossier, x: Math.round(k.x + k.w + 40), y: Math.round(k.y) }).then(
      () => setInfo(`Panneau de ${brancheDe(c)} posé à droite de cette carte.`),
      (e) => setInfo(e.message),
    )
  }
  if (!r)
    return erreur ? (
      <section className="et-git-copies">
        <h3 className="et-git-h">Copies</h3>
        <p className="et-git-erreur">{erreur}</p>
      </section>
    ) : null
  if (r.estCopie)
    return (
      <section className="et-git-copies">
        <h3 className="et-git-h">Copie</h3>
        <p className="et-git-aide">
          Ce dossier est une copie de <b>{shortDir(r.principal.dossier)}</b> : sa fusion et son retrait se font depuis la carte Git de ce dossier.
        </p>
      </section>
    )
  if (!r.copies.length) return null
  const vers = r.principal.branche
  return (
    <section className="et-git-copies">
      <h3 className="et-git-h">
        Copies <span>{r.copies.length}</span>
      </h3>
      {erreur && <p className="et-git-erreur">{erreur}</p>}
      {info && (
        <p className="et-git-aide" role="status">
          {info}
        </p>
      )}
      <ul className="et-git-copies-liste">
        {r.copies.map((c) => (
          <li key={c.chemin} className={cls('et-git-copie', c.prete && 'est-prete', c.disparue && 'est-disparue')}>
            <p className="et-git-copie-tete">
              <b className="et-git-copie-branche">{brancheDe(c)}</b>
              {c.prete && <span className="et-git-tag est-prete">prête</span>}
              {c.equipe && <span className="et-git-tag">équipe</span>}
              {!c.meydan && !c.equipe && <span className="et-git-tag">hors Meydan</span>}
              {c.disparue && <span className="et-git-tag est-alerte">disparue</span>}
              {c.verrou && <span className="et-git-tag">verrouillée</span>}
            </p>
            <p className="et-git-copie-meta">
              {c.avance != null && (
                <span title={`commits de la copie absents de ${vers || 'la tête'}`}>
                  ↑ {c.avance}
                </span>
              )}
              {c.retard != null && (
                <span title={`commits de ${vers || 'la tête'} absents de la copie`}>
                  ↓ {c.retard}
                </span>
              )}
              {nonCommitesDe(c) && <span className={cls(c.nonCommites > 0 && 'est-change')}>{nonCommitesDe(c)}</span>}
              {c.consoles.map((x) => (
                <span key={x.id} className="et-git-copie-console">
                  console « {x.name} »
                </span>
              ))}
            </p>
            <p className="et-git-copie-chemin" title={c.chemin}>
              {shortDir(c.chemin)}
            </p>
            {c.erreur && <p className="et-git-erreur">{c.erreur}</p>}
            {c.equipe && <p className="et-git-aide">Branche d’équipe : elle se livre par le bouton « Livrer » de son équipe.</p>}
            <div className="et-git-copie-actions">
              {!!c.branche && !c.equipe && !c.disparue && (
                <button type="button" className={cls('et-git-bouton et-git-long', c.prete && 'est-fort')} onClick={() => onFusion(c)}>
                  Fusionner dans {vers || 'la tête détachée'}
                </button>
              )}
              {c.meydan && (
                <button type="button" className="et-git-bouton" onClick={() => onRetrait(c)}>
                  Retirer la copie
                </button>
              )}
              {!c.disparue && (
                <button type="button" className="et-git-bouton et-git-long" onClick={() => ouvre(c)}>
                  Ouvrir le panneau de cette copie
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {r.coupe > 0 && <p className="et-git-aide">Liste coupée à {r.copies.length} copies sur {r.coupe}.</p>}
    </section>
  )
}

// Le contrôle d'une copie (POST …/git/copies/controle) : relu à l'ouverture de l'écran ; `null` pendant la lecture.
function useControle(id, c, actions) {
  const [ctl, setCtl] = useState(null)
  useEffect(() => {
    let vivant = true
    actions.git(id, '/copies/controle', 'POST', { chemin: c.chemin }).then(
      (j) => vivant && setCtl(j),
      (e) => vivant && setCtl({ erreur: e.message }),
    )
    return () => {
      vivant = false
    }
  }, [id, c.chemin, actions])
  return ctl
}

function ListeCommits({ commits, coupe }) {
  return (
    <>
      <ul className="et-git-commits">
        {commits.map((x) => (
          <li key={x.sha} className="et-git-commit est-fixe">
            <code>{x.court}</code>
            <span className="et-git-sujet">{x.sujet}</span>
            <span className="et-git-meta">{x.auteur}</span>
          </li>
        ))}
      </ul>
      {coupe > 0 && <p className="et-git-aide">Les {commits.length} plus récents sur {coupe}.</p>}
    </>
  )
}

// « Fusionner dans <branche> » : le contrôle (sans toucher au dossier de travail), ce qui entre et les refus, puis
// « Confirmer la fusion » qui porte les deux têtes vues ici (refus du serveur si l'une a bougé).
function VueFusion({ id, c, actions, onRetour, onEtat, onRetrait }) {
  const ctl = useControle(id, c, actions)
  const [envoi, setEnvoi] = useState(false)
  const [fait, setFait] = useState(null)
  const [erreur, setErreur] = useState('')
  const pret = ctl && !ctl.erreur
  const vers = pret ? ctl.principal.branche || 'la tête détachée' : '…'
  const confirme = async () => {
    setEnvoi(true)
    setErreur('')
    try {
      // Têtes ET noms vus ici : le serveur refuse si l'un a changé depuis ce contrôle.
      const r = await actions.git(id, '/copies/fusion', 'POST', { chemin: c.chemin, principal: ctl.principal.sha, copie: ctl.copie.sha, branche: ctl.principal.branche, brancheCopie: ctl.copie.branche, confirme: true })
      setFait(r)
      if (r.etat) onEtat(r.etat)
    } catch (e) {
      setErreur(e.message)
    } finally {
      setEnvoi(false)
    }
  }
  const regarder = new Set(pret ? ctl.aRegarder : [])
  return (
    <div className="et-git-vue est-pied">
      <div className="et-git-vue-tete">
        <button type="button" className="et-git-bouton" onClick={onRetour}>
          ← Retour
        </button>
        <span className="et-git-sujet" title={`Fusionner ${brancheDe(c)} dans ${vers}`}>
          Fusionner <b>{brancheDe(c)}</b> dans <b>{vers}</b>
        </span>
      </div>
      <div className="et-git-diff et-git-ecran">
        {!ctl && <p className="et-git-aide">Contrôle des conflits…</p>}
        {ctl?.erreur && (
          <p className="et-git-erreur" role="alert">
            {ctl.erreur}
          </p>
        )}
        {pret && (
          <>
            <p className="et-git-tetes">
              <code>{ctl.principal.court || '—'}</code> {vers} ← <code>{ctl.copie.court || '—'}</code> {brancheDe(ctl.copie)}
            </p>
            {ctl.refus.length > 0 && !fait && (
              <div className="et-git-erreur et-git-bloc" role="alert">
                <p>
                  <b>Fusion impossible :</b>
                </p>
                <ul className="et-git-refus">
                  {ctl.refus.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {ctl.conflits.length > 0 && (
              <section>
                <h3 className="et-git-h">
                  Conflits <span>{ctl.conflits.length}</span>
                </h3>
                <ul className="et-git-fichiers">
                  {ctl.conflits.map((f) => (
                    <li key={f} className="et-git-entre">
                      <span className="et-git-badge est-cf">conflit</span>
                      <span className="et-git-chemin">{f}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="et-git-h">
                Ce qui entre <span>{pluriel(ctl.avance || 0, 'commit')}</span>
              </h3>
              {ctl.commits.length ? <ListeCommits commits={ctl.commits} coupe={ctl.commitsCoupe} /> : <p className="et-git-aide">Aucun commit à fusionner.</p>}
            </section>
            {ctl.fichiers.length > 0 && (
              <section>
                <h3 className="et-git-h">
                  Fichiers <span>{ctl.fichiersCoupe || ctl.fichiers.length}</span>
                </h3>
                {regarder.size > 0 && <p className="et-git-regarder">À regarder avant de confirmer : réglages d’agents, hooks, paquets, secrets ou liens ({regarder.size}).</p>}
                <ul className="et-git-fichiers">
                  {ctl.fichiers.map((f) => (
                    <li key={f.chemin} className={cls('et-git-entre', regarder.has(f.chemin) && 'est-regarder')}>
                      <span className={`et-git-badge est-${BADGE[f.type] || 'mod'}`}>{f.type}</span>
                      <span className="et-git-chemin" title={f.ancien ? `${f.ancien} → ${f.chemin}` : f.chemin}>
                        {f.ancien ? `${f.ancien} → ${f.chemin}` : f.chemin}
                      </span>
                      <span className="et-git-lignes-nb">{f.lien ? 'lien' : f.ajouts == null ? 'binaire' : `+${f.ajouts} −${f.retraits}`}</span>
                      {regarder.has(f.chemin) && <span className="et-git-tag est-alerte">à regarder</span>}
                    </li>
                  ))}
                </ul>
                {ctl.fichiersCoupe > 0 && <p className="et-git-aide">Liste coupée à {ctl.fichiers.length} fichiers sur {ctl.fichiersCoupe}.</p>}
              </section>
            )}
          </>
        )}
      </div>
      <div className="et-git-pied">
        {fait ? (
          <>
            <p className="et-git-fait" role="status">
              Fusion faite : {fait.court} sur {fait.branche} ({pluriel(fait.commits, 'commit')} de {fait.copie.branche}).
            </p>
            {c.meydan && (
              <button type="button" className="et-git-bouton" onClick={onRetrait}>
                Retirer la copie
              </button>
            )}
            <button type="button" className="et-git-bouton" onClick={onRetour}>
              Retour aux copies
            </button>
          </>
        ) : (
          <>
            <button type="button" className="et-git-bouton est-fort" disabled={!pret || !ctl.possible || envoi} onClick={confirme}>
              {envoi ? 'Fusion…' : 'Confirmer la fusion'}
            </button>
            <button type="button" className="et-git-bouton" disabled={envoi} onClick={onRetour}>
              Annuler
            </button>
          </>
        )}
        {erreur && (
          <p className="et-git-erreur" role="alert">
            {erreur}
          </p>
        )}
      </div>
    </div>
  )
}

// « Retirer la copie » : son dossier, puis sa branche. Fusionnée : supprimée avec elle. Pas fusionnée : premier temps,
// « la branche n'est pas fusionnée : N commits », retirer le dossier en GARDANT la branche (le défaut) ; ou second temps
// qui dit les commits perdus avant de supprimer aussi la branche.
function VueRetrait({ id, c, actions, onRetour }) {
  const ctl = useControle(id, c, actions)
  const [perte, setPerte] = useState(false) // second temps : suppression de la branche non fusionnée
  const [envoi, setEnvoi] = useState(false)
  const [fait, setFait] = useState(null)
  const [erreur, setErreur] = useState('')
  const pret = ctl && !ctl.erreur
  const t = pret ? ctl.retrait : null
  const retire = async (supprime) => {
    setEnvoi(true)
    setErreur('')
    try {
      setFait(await actions.git(id, '/copies/retrait', 'POST', { chemin: c.chemin, copie: ctl.copie.sha, confirme: true, ...(supprime ? { supprimeBranche: true, perdus: t.perdus } : {}) }))
    } catch (e) {
      setErreur(e.message)
    } finally {
      setEnvoi(false)
    }
  }
  const b = brancheDe(c)
  // Dit avant chaque confirmation de retrait : `worktree remove` efface le dossier entier.
  const ignores = <p className="et-git-aide et-git-note">Les fichiers ignorés par git de la copie (.env, node_modules…) sont effacés avec elle.</p>
  let corps = null
  let pied = null
  if (!ctl) corps = <p className="et-git-aide">Lecture de la copie…</p>
  else if (ctl.erreur)
    corps = (
      <p className="et-git-erreur" role="alert">
        {ctl.erreur}
      </p>
    )
  else if (fait) {
    const fb = fait.branche
    corps = (
      <p className="et-git-fait" role="status">
        Copie retirée.{' '}
        {fb.nom ? (fb.supprimee ? `Branche ${fb.nom} supprimée${fb.commits ? ` (${pluriel(fb.commits, 'commit')} perdu${fb.commits > 1 ? 's' : ''})` : ''}.` : `Branche ${fb.nom} gardée (${pluriel(fb.commits, 'commit')}).`) : ''}
        {fb.raison ? ` ${fb.raison}` : ''}
      </p>
    )
    pied = (
      <button type="button" className="et-git-bouton" onClick={onRetour}>
        Retour aux copies
      </button>
    )
  } else if (!t.possible) {
    corps = (
      <div className="et-git-erreur et-git-bloc" role="alert">
        <p>
          <b>Retrait impossible :</b>
        </p>
        <ul className="et-git-refus">
          {t.refus.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    )
    pied = (
      <button type="button" className="et-git-bouton" onClick={onRetour}>
        Retour
      </button>
    )
  } else if (t.branche && !t.supprimable) {
    corps = (
      <p className="et-git-texte">
        Le dossier de la copie sera retiré. La branche <b>{t.branche}</b> n’est pas une branche de copie de Meydan : elle reste dans le dépôt. <span className="et-git-copie-chemin">{shortDir(c.chemin)}</span>
      </p>
    )
    corps = (
      <>
        {corps}
        {ignores}
      </>
    )
    pied = (
      <>
        <button type="button" className="et-git-bouton est-fort" disabled={envoi} onClick={() => retire(false)}>
          {envoi ? 'Retrait…' : 'Confirmer le retrait'}
        </button>
        <button type="button" className="et-git-bouton" disabled={envoi} onClick={onRetour}>
          Annuler
        </button>
      </>
    )
  } else if (!t.branche || t.fusionnee) {
    corps = (
      <p className="et-git-texte">
        {t.branche ? (
          <>
            La branche <b>{t.branche}</b> est fusionnée dans <b>{ctl.principal.branche || 'la tête'}</b> : le dossier de la copie et la branche seront retirés.
          </>
        ) : (
          <>Copie en tête détachée : son dossier sera retiré.</>
        )}{' '}
        <span className="et-git-copie-chemin">{shortDir(c.chemin)}</span>
      </p>
    )
    corps = (
      <>
        {corps}
        {ignores}
      </>
    )
    pied = (
      <>
        <button type="button" className="et-git-bouton est-fort" disabled={envoi} onClick={() => retire(false)}>
          {envoi ? 'Retrait…' : 'Confirmer le retrait'}
        </button>
        <button type="button" className="et-git-bouton" disabled={envoi} onClick={onRetour}>
          Annuler
        </button>
      </>
    )
  } else if (!perte) {
    corps = (
      <>
        <p className="et-git-avertit">
          La branche <b>{t.branche}</b> n’est pas fusionnée : {pluriel(t.perdus, 'commit')}.
        </p>
        <p className="et-git-texte">
          Par défaut, seul le dossier de la copie est retiré : la branche reste dans le dépôt, avec ses commits. <span className="et-git-copie-chemin">{shortDir(c.chemin)}</span>
        </p>
        {ignores}
      </>
    )
    pied = (
      <>
        <button type="button" className="et-git-bouton est-fort et-git-long" disabled={envoi} onClick={() => retire(false)}>
          {envoi ? 'Retrait…' : 'Retirer le dossier, garder la branche'}
        </button>
        <button type="button" className="et-git-bouton et-git-long" disabled={envoi} onClick={() => setPerte(true)}>
          Supprimer aussi la branche…
        </button>
        <button type="button" className="et-git-bouton" disabled={envoi} onClick={onRetour}>
          Annuler
        </button>
      </>
    )
  } else {
    corps = (
      <>
        <p className="et-git-erreur et-git-avertit">
          Supprimer aussi la branche <b>{t.branche}</b> : {t.perdus > 1 ? `ces ${t.perdus} commits seront perdus` : 'ce commit sera perdu'}.
        </p>
        <ListeCommits commits={ctl.commits} coupe={ctl.commitsCoupe} />
        {ignores}
      </>
    )
    pied = (
      <>
        <button type="button" className="et-git-bouton est-fort est-danger et-git-long" disabled={envoi} onClick={() => retire(true)}>
          {envoi ? 'Retrait…' : `Confirmer : supprimer la branche et ${pluriel(t.perdus, 'commit')}`}
        </button>
        <button type="button" className="et-git-bouton" disabled={envoi} onClick={() => setPerte(false)}>
          Garder la branche
        </button>
      </>
    )
  }
  return (
    <div className="et-git-vue est-pied">
      <div className="et-git-vue-tete">
        <button type="button" className="et-git-bouton" onClick={onRetour}>
          ← Retour
        </button>
        <span className="et-git-sujet" title={`Retirer la copie ${b}`}>
          Retirer la copie <b>{b}</b>
        </span>
      </div>
      <div className="et-git-diff et-git-ecran">{corps}</div>
      <div className="et-git-pied">
        {pied}
        {erreur && (
          <p className="et-git-erreur" role="alert">
            {erreur}
          </p>
        )}
      </div>
    </div>
  )
}

// Une ligne de différence → sa classe : en-tête de fichier (jusqu'au premier @@), bloc @@, ajout +, retrait −.
function classes(lignes) {
  let tete = false
  return lignes.map((l) => {
    if (l.startsWith('diff --git ')) tete = true
    if (l.startsWith('@@')) {
      tete = false
      return 'est-bloc'
    }
    if (tete) return 'est-tete'
    return l[0] === '+' ? 'est-plus' : l[0] === '-' ? 'est-moins' : undefined
  })
}

function Diff({ r, children }) {
  if (!r) return <p className="et-git-aide et-git-marge">Chargement…</p>
  if (r.erreur)
    return (
      <p className="et-git-erreur et-git-marge" role="alert">
        {r.erreur}
      </p>
    )
  const lignes = r.diff ? r.diff.replace(/\n$/, '').split('\n') : []
  const cl = classes(lignes)
  return (
    <div className="et-git-diff">
      {children}
      {lignes.length ? (
        <pre className="et-git-lignes">
          {lignes.map((l, i) => (
            <span key={i} className={cl[i]}>
              {l || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <p className="et-git-aide">Aucune différence de ce côté.</p>
      )}
      {r.coupe && <p className="et-git-coupe">Différence coupée à 200 Ko : la suite se lit dans un terminal.</p>}
    </div>
  )
}

// Plateau du téléphone couché : une tuile fixe, lue une fois. Le projet est le titre du cadre (en grand).
function TuileTel({ id, dossier, actions }) {
  const [etat, setEtat] = useState(null)
  const [erreur, setErreur] = useState('')
  const [copies, setCopies] = useState(null) // résumé « 3 copies · 1 prête » ; aucune action au téléphone
  useEffect(() => {
    if (!dossier) return
    let vivant = true
    actions.git(id).then(
      (j) => vivant && setEtat(j),
      (e) => vivant && setErreur(e.message),
    )
    actions.git(id, '/copies').then(
      (j) => vivant && !j.estCopie && setCopies(j.copies),
      () => {}, // sans copies lisibles, la tuile n'en parle pas
    )
    return () => {
      vivant = false
    }
  }, [id, dossier, actions])
  if (!dossier || erreur || !etat)
    return (
      <div className="et-git-tel">
        <p className={erreur ? 'est-erreur' : 'est-dim'}>{!dossier ? 'Aucun projet choisi' : erreur || '…'}</p>
      </div>
    )
  const dernier = etat.commits[0]
  return (
    <div className="et-git-tel">
      <p className="et-git-tel-branche">{nomBranche(etat)}</p>
      <p className={cls('et-git-tel-etat', !etat.propre && 'est-change')}>{etat.propre ? 'propre' : pluriel(nbChangements(etat), 'changement')}</p>
      {copies?.length > 0 && (
        <p className="et-git-tel-copies">
          {pluriel(copies.length, 'copie')}
          {copies.some((c) => c.prete) && ` · ${copies.filter((c) => c.prete).length} prête${copies.filter((c) => c.prete).length > 1 ? 's' : ''}`}
        </p>
      )}
      {dernier && <p className="et-git-tel-dernier">{dernier.sujet}</p>}
    </div>
  )
}
