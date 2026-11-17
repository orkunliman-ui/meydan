// Comptes Claude / Codex (volet « comptes », 11/11). Demande d'Orkun : « Plusieurs comptes Claude / Codex » — « deux comptes
// Claude Code ou Codex (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), usage et jetons par compte ». Contrat entre les morceaux :
// docs/volets/comptes-contrat.md (noms et props des exports ci-dessous, forme du `Resume` de GET /api/comptes/usage).
// Styles : comptes.css (classes `cpt-…`). Couleurs : encre et papier ; le jaune seulement sur « Relancer sur le compte N »
// (à toi de toucher, reel.css) ; le rouge seulement pour un relais qui échoue. Aucune animation.
import { useEffect, useId, useState } from 'react'
import { api, cls } from './lib.js'
import { NOM_MAX, nomDonne, renommeCompte, useNomsComptes } from './comptes-noms.js'

export const libelleCompte = (kind, compte) => `${kind === 'codex' ? 'Codex' : 'Claude'} · compte ${compte || '1'}`

// ── Mise en forme (français : virgule décimale, « $ » après le nombre, M / k pour les jetons) ──
const NB = '\u00a0' // espace insécable : « 12,40 $ » ou « 3,1 M jetons » ne se coupent jamais en fin de ligne
const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
// Sans centimes à partir de 100 $ : « 1 157 $ » (vrais chiffres d'Orkun le 11/11) tient dans la ligne repliée de la colonne.
const dollars = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${(n >= 100 ? nf0 : nf2).format(n)}${NB}$` : '—')
// 512 · 8,4 k · 56 k · 3,1 M · 42 M · 1 234 M (une décimale sous 10, aucune au-delà).
function jetons(n, unite = true) {
  n = Number(n) || 0
  const un = (v, u) => `${v < 9.95 ? nf1.format(v) : nf0.format(v)}${NB}${u}`
  const t = n >= 999_500 ? un(n / 1e6, 'M') : n >= 999.5 ? un(n / 1e3, 'k') : nf0.format(n)
  return unite ? `${t}${NB}${n >= 2 ? 'jetons' : 'jeton'}` : t
}
// Jetons « à part » du cache (Claude : entrée + sortie ; Codex : entrée hors cache + sortie), et le cache lui-même.
const horsCache = (p) => (p?.entree || 0) + (p?.sortie || 0)
const enCache = (p) => (p?.cacheLu || 0) + (p?.cacheEcrit || 0)
const somme = (liste, f) => liste.reduce((s, k) => s + (Number(f(k)) || 0), 0)

// Heures et dates dans le fuseau du calcul (Europe/Brussels), quel que soit l'appareil.
function morceaux(ms, fuseau, opts) {
  let f
  try {
    f = new Intl.DateTimeFormat('fr-FR', { ...opts, hourCycle: 'h23', timeZone: fuseau })
  } catch {
    f = new Intl.DateTimeFormat('fr-FR', { ...opts, hourCycle: 'h23' }) // fuseau inconnu du navigateur : heure de l'appareil
  }
  return Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, p.value]))
}
const heure = (ms, fuseau) => {
  const p = morceaux(ms, fuseau, { hour: '2-digit', minute: '2-digit' })
  return `${p.hour}:${p.minute}`
}
// « jeu. 14 nov. 09:00 »
const quand = (ms, fuseau) => {
  const p = morceaux(ms, fuseau, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`
}
const fenetre = (min) => (min % 1440 === 0 ? `${min / 1440}${NB}j` : min % 60 === 0 ? `${min / 60}${NB}h` : `${min}${NB}min`)
// Une limite que Codex écrit dans son journal : « limite 7 j : 53 % · repart jeu. 14 nov. 09:00 ». Passée l'heure de
// remise à zéro, le pourcentage lu ne vaut plus rien : on dit la remise à zéro à la place.
function ligneLimite(l, fuseau) {
  if (!l || !l.fenetreMin) return null
  const f = `limite ${fenetre(l.fenetreMin)}`
  if (l.repart && l.repart <= Date.now()) return `${f} : remise à zéro le ${quand(l.repart, fuseau)}`
  const pc = Number.isFinite(l.pourcent) ? `${Math.round(l.pourcent)}${NB}%` : '?'
  return `${f} : ${pc}${l.repart ? ` · repart ${quand(l.repart, fuseau)}` : ''}`
}
// « claude-opus-5-5 » → « Opus 5.5 » (le nom tient dans la colonne) ; un autre modèle garde son nom.
function nomModele(m = '') {
  const x = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(m)
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m
}

// ── Lecture de l'usage : au montage, puis toutes les 60 s tant que la page est à l'écran ──
// Le premier calcul du serveur peut prendre plusieurs secondes : un seul appel à la fois. Une lecture ratée garde les
// derniers chiffres (le pied dit l'heure du calcul) ; sans chiffres du tout, le panneau tient en une ligne discrète.
const PERIODE = 60_000
function useUsage() {
  const [etat, setEtat] = useState({ resume: null, erreur: null })
  useEffect(() => {
    let mort = false, enCours = false, dernier = 0
    const lis = () => {
      if (mort || enCours) return
      enCours = true
      dernier = Date.now()
      api('GET', '/api/comptes/usage')
        .then(
          (r) => !mort && setEtat(Array.isArray(r?.comptes) ? { resume: r, erreur: null } : (s) => ({ ...s, erreur: 'réponse inattendue' })),
          (e) => !mort && setEtat((s) => ({ ...s, erreur: e.message || 'erreur' })),
        )
        .finally(() => {
          enCours = false
        })
    }
    const siVisible = () => document.visibilityState === 'visible' && Date.now() - dernier >= PERIODE - 2000 && lis()
    lis()
    const t = setInterval(siVisible, PERIODE)
    document.addEventListener('visibilitychange', siVisible) // revenu à l'écran après plus d'une minute : tout de suite
    return () => {
      mort = true
      clearInterval(t)
      document.removeEventListener('visibilitychange', siVisible)
    }
  }, [])
  return etat
}

// Une case « aujourd'hui » ou « 7 j » : le coût (Claude), les jetons, le cache à part en plus petit.
function Case({ k, p }) {
  const cache = enCache(p)
  const inconnu = k.prixInconnu?.length ? `Coût non compté pour : ${k.prixInconnu.join(', ')}` : undefined
  return (
    <td>
      {k.kind === 'claude' && (
        <span className="cpt-somme" title={inconnu}>
          {dollars(p?.cout)}
        </span>
      )}
      <span className={k.kind === 'claude' ? 'cpt-jetons' : 'cpt-somme'}>{jetons(horsCache(p))}</span>
      {cache > 0 && <span className="cpt-cache">+ {jetons(cache, false)} cache</span>}
    </td>
  )
}

// Un compte : son nom et le premier modèle de la semaine, aujourd'hui et 7 j, puis (Codex) les limites lues.
// Décision d'Orkun du 17/11, comptes-3 : « Donner des noms ». Un clic (ou un toucher) sur le nom ouvre un champ à sa place,
// sur toute la largeur du tableau : Entrée ou OK valide, Échap ou Annuler annule (pas de fermeture au départ du focus :
// sur l'iPhone, toucher OK enlève le focus du champ avant le clic) ; vide = « Compte N ». Un nom donné prend la place de
// « Claude 1 », qui passe sur la ligne du modèle (« Claude 1 · Opus 5.5 ») : on sait toujours de quel compte il s'agit.
function Rangee({ k, fuseau }) {
  useNomsComptes() // relu quand un nom change (ici ou sur un autre écran)
  const [nomme, setNomme] = useState(null) // le champ ouvert : { nom, erreur, envoi }
  const absent = k.compte === '2' && !k.connecte
  const modele = absent ? null : k.modeles?.find((m) => m.total > 0)?.modele
  const limites = k.kind === 'codex' && !absent ? [k.limites?.primaire, k.limites?.secondaire].map((l) => ligneLimite(l, fuseau)).filter(Boolean) : []
  const type = `${k.kind === 'codex' ? 'Codex' : 'Claude'} ${k.compte}`
  const donne = nomDonne(k.kind, k.compte)
  const sous = [donne && type, modele && nomModele(modele)].filter(Boolean).join(' · ')
  const valide = async (e) => {
    e.preventDefault()
    if (nomme.envoi) return
    setNomme({ ...nomme, envoi: true, erreur: '' })
    try {
      await renommeCompte(k.kind, k.compte, nomme.nom.trim())
      setNomme(null)
    } catch (err) {
      setNomme((x) => x && { ...x, envoi: false, erreur: err.message || 'nom refusé' })
    }
  }
  return (
    <tbody className="cpt-compte">
      {nomme ? (
        <tr>
          <th scope="row" colSpan={3}>
            <form className="cpt-renomme" onSubmit={valide}>
              <input
                autoFocus
                value={nomme.nom}
                placeholder={`Compte ${k.compte}`}
                aria-label={`Nom du compte ${type} (vide : « Compte ${k.compte} »)`}
                enterKeyHint="done"
                autoComplete="off"
                onChange={(e) => setNomme({ ...nomme, nom: [...e.target.value].slice(0, NOM_MAX).join(''), erreur: '' })} // points de code : un émoji compte pour 1, jamais coupé en deux
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNomme(null))}
              />
              <button type="submit" disabled={nomme.envoi}>
                OK
              </button>
              <button type="button" className="cpt-renomme-non" onClick={() => setNomme(null)}>
                Annuler
              </button>
            </form>
            {nomme.erreur && (
              <p className="cpt-renomme-erreur" role="alert">
                {nomme.erreur}
              </p>
            )}
          </th>
        </tr>
      ) : (
      <tr>
        <th scope="row">
          <button type="button" className="cpt-nom" title={`${donne ? `« ${donne} » (${type}) : ` : ''}renommer ce compte`} onClick={() => setNomme({ nom: donne, erreur: '', envoi: false })}>
            {donne || type}
          </button>
          {sous && (
            <span className="cpt-modele" title={[donne && type, modele].filter(Boolean).join(' · ')}>
              {sous}
            </span>
          )}
        </th>
        {absent ? (
          <td colSpan={2} className="cpt-absent">
            pas connecté
          </td>
        ) : (
          <>
            <Case k={k} p={k.jour} />
            <Case k={k} p={k.semaine} />
          </>
        )}
      </tr>
      )}
      {limites.length > 0 && (
        <tr className="cpt-limites">
          <td colSpan={3}>
            {limites.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </td>
        </tr>
      )}
    </tbody>
  )
}

// Le panneau « Usage des comptes ». Replié (par défaut) : une ligne, le jour. Déplié : une rangée par compte.
// `compact` : le téléphone (390 px de large, marges de 16 px) — mêmes informations, en plus serré.
export function Comptes({ compact }) {
  const { resume, erreur } = useUsage()
  const [ouvert, setOuvert] = useState(false)
  const id = useId()
  const classe = cls('cpt-comptes', compact && 'cpt-compact')
  if (!resume)
    return (
      <p className={cls(classe, 'cpt-muet')} title={erreur || undefined}>
        {erreur ? 'Usage des comptes : indisponible' : 'Usage des comptes · calcul…'}
      </p>
    )
  const { comptes, fuseau } = resume
  const claude = comptes.filter((k) => k.kind === 'claude')
  const codex = comptes.filter((k) => k.kind === 'codex')
  // « Aujourd'hui · Claude 12,40 $ · Codex 3,1 M jetons »
  const parts = []
  if (claude.length) parts.push(['Claude', dollars(somme(claude, (k) => k.jour?.cout))])
  if (codex.length) parts.push(['Codex', jetons(somme(codex, (k) => horsCache(k.jour)))])
  const ligne = ["Aujourd'hui", ...parts.map(([n, v]) => `${n} ${v}`)].join(' · ')
  const aConnecter = comptes.some((k) => k.compte === '2' && !k.connecte)
  return (
    <section className={classe} aria-label="Usage des comptes">
      <button type="button" className="cpt-ligne" aria-expanded={ouvert} aria-controls={ouvert ? id : undefined} title={ligne} onClick={() => setOuvert((o) => !o)}>
        <span className="cpt-resume">
          {/* « Auj. » (intégration du 11/11) : avec de vrais montants (« Claude 1 157 $ · Codex 443 M jetons »), la ligne
              entière ne tenait plus dans la colonne ; le mot entier reste dans l'infobulle de la ligne. */}
          <span className="cpt-quand">Auj.</span>
          {parts.map(([n, v]) => (
            <span key={n}> · {n} {comptes.some((k) => k.coupe && k.kind === n.toLowerCase()) && '≥ '}<span className="cpt-val">{v}</span></span>
          ))}
        </span>
        <i className="cpt-chevron" aria-hidden="true" />
      </button>
      {ouvert && (
        <div id={id} className="cpt-detail">
          <table className="cpt-table">
            <thead>
              <tr>
                <td />
                <th scope="col">Aujourd'hui</th>
                <th scope="col">7 j</th>
              </tr>
            </thead>
            {comptes.map((k) => (
              <Rangee key={`${k.kind}-${k.compte}`} k={k} fuseau={fuseau} />
            ))}
          </table>
          {aConnecter && <p className="cpt-rappel">Ouvre une console sur le compte 2 pour te connecter</p>}
          <p className="cpt-pied">
            Équivalent prix public de l'API · calculé à {heure(resume.calculeLe, fuseau)}
            {codex.length > 0 && (
              <>
                <br />
                Codex : forfait ChatGPT, pas de prix
              </>
            )}
          </p>
        </div>
      )}
    </section>
  )
}

// Bandeau d'une console bloquée par la limite d'usage de son compte (`c.quota`, posé par le serveur) : l'agent n'est pas
// en panne, c'est son forfait qui l'arrête. Le relais existant ouvre une nouvelle console sur l'AUTRE compte, dans le même
// dossier, qui lit la conversation de celle-ci. `onPick(id)` : ouvrir la nouvelle console.
export function QuotaRelais({ c, actions, onPick }) {
  useNomsComptes() // « le compte 2 » ou « « Max pro » » (décision d'Orkun du 17/11, comptes-3 : « Donner des noms »)
  const [relais, setRelais] = useState(null) // { id, enCours } puis { id, erreur } : l'appel de CETTE console seulement
  if (!c?.quota) return null
  const ici = relais?.id === c.id ? relais : null
  const de = c.compte === '2' ? '2' : '1'
  const vers = de === '2' ? '1' : '2'
  const lance = async () => {
    if (ici?.enCours) return
    setRelais({ id: c.id, enCours: true })
    try {
      const r = await actions.relais(c.id, c.kind, vers)
      setRelais(null)
      if (r?.console?.id) onPick?.(r.console.id)
    } catch (e) {
      setRelais({ id: c.id, erreur: e.message || 'le relais n’a pas abouti' })
    }
  }
  return (
    <section className="cpt-quota nodrag nopan" aria-label="Limite d'usage atteinte">
      <div className="cpt-quota-texte">
        <p className="cpt-quota-titre">Limite d'usage atteinte · {nomDonne(c.kind, de) ? `«${NB}${nomDonne(c.kind, de)}${NB}»` : `compte ${de}`}</p>
        {c.quota.texte && (
          <p className="cpt-quota-lu" title={c.quota.texte}>
            {c.quota.texte}
          </p>
        )}
        {actions?.relais && <p className="cpt-quota-dit">Une nouvelle console reprend la conversation sur l'autre compte.</p>}
      </div>
      {actions?.relais && (
        <div className="cpt-quota-geste">
          {/* Un nom donné (24 caractères au plus) se coupe dans le bouton (…), entier dans l'infobulle. */}
          <button type="button" className="cpt-relance" disabled={!!ici?.enCours} onClick={lance} title={nomDonne(c.kind, vers) ? `Relancer sur « ${nomDonne(c.kind, vers)} »` : undefined}>
            {ici?.enCours ? (
              'Relance…'
            ) : nomDonne(c.kind, vers) ? (
              <>
                Relancer sur{' '}
                <span className="cpt-relance-nom">«{NB}{nomDonne(c.kind, vers)}{NB}»</span>
              </>
            ) : (
              `Relancer sur le compte ${vers}`
            )}
          </button>
          {ici?.erreur && (
            <p className="cpt-quota-erreur" role="alert">
              Relais impossible : {ici.erreur}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// La pastille du compte, à côté du nom d'une console : rien pour le compte 1 (rien ne change pour lui), « C2 » sinon.
// Son infobulle porte le nom donné par Orkun (décision du 17/11, comptes-3 : « Donner des noms ») : « « Max pro » (compte 2) ».
export function CompteBadge({ c }) {
  useNomsComptes() // avant le retour anticipé : un crochet est appelé à chaque rendu
  if (!c?.compte || c.compte === '1') return null
  const donne = nomDonne(c.kind, c.compte)
  return (
    <span className="cpt-badge" title={donne ? `« ${donne} » (compte ${c.compte})` : `Compte ${c.compte}`}>
      C{c.compte}
    </span>
  )
}
