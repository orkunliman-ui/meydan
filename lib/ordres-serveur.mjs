// La barre d'ordres côté serveur (volet « ordres », 13/11/2026) : routes `/api/ordre`, fil des ordres gardé sur disque,
// réponses aux questions d'état, suivi des « dis à X » jusqu'à la réponse de l'agent, ordres retenus pendant une
// permission, plans du planificateur gardés sous un jeton. Orkun, 13/11 : « On est encore loin de toutes les
// fonctionnalitēs de Symvibe ». Contrat : docs/specs/2026-11-13-ordres-contrat.md.
//
// Fabrique à la manière de `ouvreCartes` : server.mjs garde `planOrdre` et `executeOrdre` (ils touchent aux consoles) et
// les donne ici avec le reste (getters, file d'attente, journal). Rend { api, remis, tick } :
//   api(req, res, parts, m)  la route, appelée par le routeur `api()` de server.mjs APRÈS `originOk` et la porte de session ;
//   remis(c, lot, t0)        appelé par `flush` après un collage réussi : les ordres contenus dans ce lot sont remis ;
//   tick()                   appelé à chaque réconciliation (3 s) : retenue, expiration, lecture des réponses.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as ordres from './ordres.mjs'
import * as envois from './envois.mjs'
import * as fil from './fil.mjs'
import { ouvreFilOrdres } from './fil-ordres.mjs'
import { planifie as planifieModele } from './planificateur.mjs'
import { verifie as plafondMemoire } from './plafond.mjs'

const duree = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`)
// Un ordre retenu pendant qu'une console attend une permission : au plus 15 min (Symvibe fait de même), puis abandonné.
const RETENUE_MS = Number(process.env.MEYDAN_ORDRES_RETENUE_MS) > 0 ? Number(process.env.MEYDAN_ORDRES_RETENUE_MS) : 15 * 60 * 1000
const REPOS_MS = 4000 // la réponse se lit 4 s après le retour au repos (leçon des boucles, 10/11 : jamais pendant que la décision bouge encore)
const GRACE_MS = 15000 // l'entrée de l'ordre introuvable dans le journal : on relit pendant 15 s avant de conclure
const SANS_REPONSE_MS = 2 * 3600 * 1000
const JETON_MS = 10 * 60 * 1000
const EN_FILE = new Set(['attend', 'retenu'])
const SUIVIS = new Set(['attend', 'retenu', 'remis'])
const sansBlancs = (s) => String(s ?? '').replace(/\s+/g, '')
// Ce qui part vers l'écran : le texte remis (celui de l'ordre, déjà dans le message « ordre ») reste au serveur.
const publie = (m) => {
  if (!m) return m
  const { texteRemis, ...reste } = m
  return reste
}

// L'entrée `toi` du journal porte-t-elle ce texte remis ? À un DÉBUT de ligne (un lot collé d'un coup = plusieurs
// messages séparés par « \n »), blancs retirés (le champ de l'agent et le collage les changent). Jamais au milieu d'une
// ligne : l'ordre « ok » ne s'ancre pas dans « look at this file » tapé ensuite (relecture de sécurité du 13/11, M2).
function porte(t, cle) {
  const s = String(t ?? '')
  for (let i = 0; ; ) {
    if (sansBlancs(s.slice(i, i + cle.length * 4 + 400)).startsWith(cle)) return true
    const j = s.indexOf('\n', i)
    if (j < 0) return false
    i = j + 1
  }
}
// La réponse de l'agent À CET ORDRE, dans ce qu'on a lu de son journal (`lu` : le fil ; `recus` : tous les messages
// reçus, au-delà de la fenêtre du fil) : la dernière entrée `agent` placée APRÈS la dernière entrée `toi` qui porte le
// texte remis et AVANT l'entrée `toi` suivante. Jamais la réponse d'avant (conseil du 13/11 : `derniereReponse`
// rendrait l'ancienne si le tour finit sans texte), ni celle à un ordre arrivé après (M2 : A remis, B collé avant la
// lecture de A → chacun la sienne). Hors de la fenêtre du fil (150 éléments, une longue mission) : l'entrée `toi` est
// cherchée dans `recus` et la réponse par l'heure, entre elle et le message reçu suivant.
export function reponseDans(lu, recus, texte) {
  const cle = sansBlancs(texte).slice(0, 200)
  if (!cle) return { trouve: false }
  const toi = (x) => x?.r === 'toi'
  const i = lu.findLastIndex((x) => toi(x) && porte(x.t, cle))
  if (i >= 0) {
    const j = lu.findIndex((x, k) => k > i && toi(x))
    return { trouve: true, rep: lu.slice(i + 1, j < 0 ? undefined : j).findLast((x) => x.r === 'agent') }
  }
  const k = recus.findLastIndex((x) => toi(x) && porte(x.t, cle))
  if (k < 0) return { trouve: false }
  const t0 = Date.parse(recus[k].at)
  const t1 = k + 1 < recus.length ? Date.parse(recus[k + 1].at) : Infinity
  if (!Number.isFinite(t0)) return { trouve: true, rep: undefined }
  return { trouve: true, rep: lu.findLast((x) => x.r === 'agent' && Date.parse(x.at) >= t0 && !(Date.parse(x.at) >= t1)) }
}

export function ouvreOrdres({ DATA, HOME, send, readJson, broadcast, consoles, teams, find, save, journalDe, planOrdre, executeOrdre, safeDir, kinds, enRemise = () => false, planifie = planifieModele }) {
  const filOrdres = ouvreFilOrdres(DATA, { quand: (m) => broadcast({ type: 'ordres', message: publie(m) }) })
  const DOSSIER_PLANIF = path.join(DATA, 'planificateur') // dossier de travail neutre du modèle : vide, rien à lire
  const jetons = new Map() // jeton → { texte, actions, expire } : un plan du planificateur, montré, en attente de confirmation
  let planifieEnCours = false

  const lien = (c) => (c ? { id: c.id, nom: c.name } : null)
  const lu = (c) => {
    const f = journalDe(c)
    return f ? { f, lu: fil.lireFil(c.kind, f) } : null
  }
  // La dernière réponse écrite de l'agent (pour les questions d'état) : rien de lisible → ''.
  const derniere = (c) => {
    try {
      return lu(c)?.lu.findLast((x) => x.r === 'agent')?.t.trim() ?? ''
    } catch {
      return ''
    }
  }
  // La réponse de l'agent À CET ORDRE (voir `reponseDans`).
  function reponseApres(c, texte) {
    const j = lu(c)
    return j ? reponseDans(j.lu, fil.recus(c.kind, j.f), texte) : { trouve: false }
  }
  // Les premières lignes d'une réponse : 6 au plus, 600 caractères au plus (le lien « ouvrir » mène au reste).
  function extrait(t) {
    const out = []
    let n = 0
    for (const l of t.split('\n').map((x) => x.trimEnd()).filter((x) => x.trim())) {
      if (out.length >= 6 || n >= 600) break
      const x = l.length > 600 - n ? `${l.slice(0, 600 - n)}…` : l
      out.push(x)
      n += x.length
    }
    return out
  }
  const ligne = (etat, m) =>
    ({
      attend: `${m.nom} : en file, remis dès qu’il sera au repos`,
      retenu: `${m.nom} attend une permission : ordre retenu, remis à son retour au repos${m.lancement ? '' : ` (${duree(RETENUE_MS)} au plus)`}`,
      remis: `${m.nom} : remis, sa réponse arrive à son retour au repos`,
      expire: `Non remis : ${m.nom} attend toujours une permission après ${duree(RETENUE_MS)}.`,
      perdu: `${m.nom} : console fermée avant de répondre.`,
      'sans-reponse': `${m.nom} : pas revenu au repos depuis ${duree(SANS_REPONSE_MS)}.`,
    })[etat]
  const passe = (m, etat, plus = {}) => filOrdres.modifie(m.id, { etat, lignes: [ligne(etat, m)], ...plus })

  // Une réponse « agent » par console visée : son état suit l'ordre jusqu'à la réponse.
  function suit(c, texte, de, { lancement = false, depuis = Date.now() } = {}) {
    const retenu = c.status === 'needs'
    const m = { r: 'reponse', de, genre: 'agent', console: c.id, nom: c.name, etat: retenu ? 'retenu' : 'attend', texteRemis: texte, depuis, liens: [lien(c)], ...(retenu ? { retenuDepuis: Date.now() } : {}), ...(lancement ? { lancement: true } : {}) }
    return filOrdres.ajoute({ ...m, lignes: [ligne(m.etat, m)] })
  }

  // Exécute UN plan simple (ou une question) et écrit ses réponses au fil.
  async function executeUn(p, ordre) {
    if (p.ordre === 'question') {
      const rep = ordres.repondre(p, { consoles: consoles(), teams: teams(), derniere })
      const msg = filOrdres.ajoute({ r: 'reponse', de: ordre.id, genre: 'question', lignes: rep.lignes, liens: rep.liens })
      return { fait: rep.lignes, creees: [], reponses: [msg] }
    }
    const reponses = []
    // « dis à » : les suivis AVANT la mise en file (rien ne peut être collé entre les deux : enqueue est synchrone).
    if (p.ordre === 'envoyer') {
      const texte = envois.messageText(p.message) // exactement ce que executeOrdre met dans la file
      for (const id of p.cibles) {
        const c = find(id)
        if (c) reponses.push(suit(c, texte, ordre.id))
      }
    }
    const r = await executeOrdre(p)
    if (p.ordre === 'lancer' && p.consigne) {
      const texte = envois.messageText(p.consigne)
      for (const id of r.creees) {
        const c = find(id)
        // Une consigne de lancement n'expire pas : elle attend la réponse à la question de confiance aussi longtemps
        // qu'aujourd'hui.
        if (c) reponses.push(suit(c, texte, ordre.id, { lancement: true, depuis: c.createdAt || Date.now() }))
      }
    }
    if (p.ordre !== 'envoyer') reponses.unshift(filOrdres.ajoute({ r: 'reponse', de: ordre.id, genre: 'fait', lignes: r.fait.length ? r.fait : ['Fait.'], liens: r.creees.map((id) => lien(find(id))).filter(Boolean) }))
    return { ...r, reponses }
  }

  // `apresControle` : appelé une fois le plafond passé, avant la première action (le jeton du planificateur n'est
  // consommé qu'à ce moment : un refus du plafond le laisse valable).
  async function execute(res, plan, texte, source, { apresControle } = {}) {
    const ordre = filOrdres.ajoute({ r: 'ordre', texte, source })
    const tout = { fait: [], creees: [], reponses: [] }
    try {
      // Plafond de mémoire (décision d'Orkun du 17/11, raccourcis-3 : « refuser sous 4 Go de mémoire disponible », lib/plafond.mjs) : UNE fois, avant la première action d'un plan qui lance des
      // consoles (« lance 3 claude », ou un plan à plusieurs actions) : rien n'est fait si c'est refusé. Rouvrir PLUSIEURS
      // consoles fermées d'un coup (« relance les finies ») est aussi un lancement de plusieurs (relecture du 17/11) ;
      // rouvrir une seule console reste libre.
      const etapes = plan.ordre === 'plusieurs' ? plan.actions : [plan]
      const rouvertes = new Set(etapes.filter((p) => p.ordre === 'relancer').flatMap((p) => p.cibles || []).filter((id) => find(id)?.status === 'closed'))
      if (etapes.some((p) => p.ordre === 'lancer') || rouvertes.size > 1) plafondMemoire()
      apresControle?.()
      // Dans l'ordre du plan : une étape « relancer » passe avant le « dis à » qui vise la même console (depuisActions).
      for (const p of plan.ordre === 'plusieurs' ? plan.actions : [plan]) {
        const r = await executeUn(p, ordre)
        tout.fait.push(...r.fait)
        tout.creees.push(...r.creees)
        tout.reponses.push(...r.reponses)
      }
    } catch (e) {
      filOrdres.ajoute({ r: 'reponse', de: ordre.id, genre: 'erreur', lignes: [String(e?.message || e)] })
      throw e
    }
    return send(res, 200, { plan, fait: tout.fait, creees: tout.creees, ordre: publie(ordre), reponses: tout.reponses.map(publie) })
  }

  // Un plan à confirmer ne part que si l'écran renvoie ce qu'il a montré (contrat §1) : l'empreinte du plan RECALCULÉ
  // (`confirmationValide` de lib/ordres.mjs : `true` n'y vaut que pour un plan sans texte risqué et sans modèle, le
  // « ferme … » d'avant).
  // L'écran renvoie `vu` = l'empreinte du plan qu'il a montré (relecture de sécurité du 13/11, basse 3) : recalculé
  // différent (une console arrivée entre l'aperçu et l'appui), il ne part pas. `vu` absent : comme avant (smoke).
  const change = (plan, vu) => typeof vu === 'string' && vu !== plan.empreinte
  const refusConfirmation = (plan, confirme) =>
    confirme === undefined || confirme === false || confirme === null ? 'à confirmer' : plan.risques?.length && confirme === true ? 'texte risqué : confirme le passage cité' : 'le plan a changé : relis-le'

  // Le dossier d'un « lance » vérifié comme planOrdre le fait (« ~/site » et « site » = le dossier site du répertoire
  // personnel), pour chaque action d'un plan du planificateur.
  function dossiers(plan) {
    for (const a of plan.actions || []) {
      if (a.ordre !== 'lancer') continue
      const rel = !a.dossier || a.dossier === '~' ? HOME : String(a.dossier).replace(/^~\//, '')
      try {
        a.cwd = safeDir(rel)
      } catch (e) {
        return { erreur: `Dossier « ${a.dossier} » : ${e.code === 'ENOENT' ? 'introuvable' : e.message}.` }
      }
    }
    return plan
  }
  // `phrase` : la phrase d'Orkun ; un message ou une consigne qu'elle ne contient pas est marqué « ajouté » (M1).
  const planDepuis = (actions, phrase) => {
    const p = ordres.depuisActions(actions, { consoles: consoles(), kinds: kinds(), phrase })
    return p.erreur ? p : dossiers(p)
  }
  const purge = () => {
    for (const [j, g] of jetons) if (g.expire < Date.now()) jetons.delete(j)
  }

  async function planifier(res, texte) {
    if (planifieEnCours) return send(res, 409, { error: 'Le planificateur réfléchit déjà à une autre phrase : attends sa réponse.' })
    planifieEnCours = true
    try {
      fs.mkdirSync(DOSSIER_PLANIF, { recursive: true, mode: 0o700 })
      let r
      try {
        r = await planifie(texte, { consoles: consoles(), kinds: kinds(), home: HOME, dossier: DOSSIER_PLANIF })
      } catch (e) {
        return send(res, 502, { error: `Le planificateur n’a pas répondu : ${String(e?.message || e).replace(/[.\s]+$/, '')}. Tape l’ordre avec un verbe (lance, dis à…).` })
      }
      const mesure = { source: 'planificateur', duree_ms: r.duree_ms, cout_usd: r.cout_usd, modeles: r.modeles }
      // Le texte du modèle n'est jamais montré : seul ce que Meydan reconstruit depuis des actions validées l'est.
      if (!Array.isArray(r.actions) || !r.actions.length) return send(res, 200, { plan: { erreur: 'Le planificateur n’a trouvé aucune action dans cette phrase.', ...mesure } })
      const plan = planDepuis(r.actions, texte)
      if (plan.erreur) return send(res, 200, { plan: { ...plan, ...mesure } })
      purge()
      const jeton = `p${crypto.randomBytes(9).toString('hex')}`
      jetons.set(jeton, { texte, actions: r.actions, expire: Date.now() + JETON_MS })
      return send(res, 200, { plan: { ...plan, jeton, ...mesure } })
    } finally {
      planifieEnCours = false
    }
  }

  async function api(req, res, parts, m) {
    if (parts.length === 3 && parts[2] === 'fil' && m === 'GET') return send(res, 200, { messages: filOrdres.liste().map(publie) })
    if (parts.length !== 2 || m !== 'POST') return send(res, 404, { error: 'route inconnue' })
    const body = await readJson(req)
    const source = ['tape', 'voix'].includes(body.source) ? body.source : 'tape'

    // Un plan du planificateur, déjà montré : relu contre l'état du moment, exécuté sans nouvel appel au modèle.
    if (body.jeton !== undefined) {
      purge()
      const g = typeof body.jeton === 'string' ? jetons.get(body.jeton) : null
      if (!g) return send(res, 409, { error: 'Plan expiré ou inconnu : redemande-le.' })
      const plan = planDepuis(g.actions, g.texte)
      if (plan.erreur) return send(res, 409, { plan, error: plan.erreur })
      if (!body.executer) return send(res, 200, { plan: { ...plan, jeton: body.jeton } })
      if (change(plan, body.vu)) return send(res, 409, { plan: { ...plan, jeton: body.jeton }, error: 'le plan a changé : relis-le' })
      if (!ordres.confirmationValide(plan, body.confirme)) return send(res, 409, { plan: { ...plan, jeton: body.jeton }, error: refusConfirmation(plan, body.confirme) })
      // Un plan ne part qu'une fois : le jeton est retiré dès le plafond passé, avant tout `await` (deux demandes
      // simultanées ne le prennent pas toutes deux).
      return await execute(res, plan, g.texte, 'planificateur', { apresControle: () => jetons.delete(body.jeton) })
    }

    const texte = typeof body.texte === 'string' ? body.texte.normalize('NFC').trim().slice(0, 4000) : ''
    const plan = planOrdre(texte)
    // Haiku seulement pour une phrase que l'analyse sans modèle ne comprend pas (`planifiable`, lib/ordres.mjs) : un
    // ordre compris part tel quel, une erreur de cible (« aucune console ne correspond ») reste une erreur.
    if (body.planifier === true) {
      if (!plan.erreur) return send(res, 200, { plan })
      if (!plan.planifiable || !texte) return send(res, 409, { plan, error: plan.erreur })
      return await planifier(res, texte)
    }
    if (!body.executer || plan.erreur) return send(res, body.executer && plan.erreur ? 409 : 200, plan.erreur ? { plan, error: plan.erreur } : { plan })
    if (change(plan, body.vu)) return send(res, 409, { plan, error: 'le plan a changé : relis-le' })
    if (!ordres.confirmationValide(plan, body.confirme)) return send(res, 409, { plan, error: refusConfirmation(plan, body.confirme) })
    return await execute(res, plan, texte, source)
  }

  // Après un collage réussi par `flush` : les ordres de la barre contenus dans ce lot sont remis à l'heure `t0` (prise
  // AVANT le collage : un agent très rapide ne peut pas revenir au repos avant elle).
  function remis(c, lot, t0 = Date.now()) {
    if (!lot?.length) return
    for (const m of filOrdres.liste()) if (m.genre === 'agent' && m.console === c.id && EN_FILE.has(m.etat) && lot.includes(m.texteRemis)) passe(m, 'remis', { remisA: t0 })
  }

  // À chaque réconciliation (3 s).
  function tick() {
    const maintenant = Date.now()
    for (const m of filOrdres.liste()) {
      if (m.r !== 'reponse' || m.genre !== 'agent' || !SUIVIS.has(m.etat)) continue
      const c = find(m.console)
      if (!c || c.status === 'closed') {
        passe(m, 'perdu', { finA: maintenant })
        continue
      }
      if (EN_FILE.has(m.etat)) {
        // Plus en file, ni dans le champ (collé sans Entrée), ni en cours de collage : l'agent l'a reçu par un autre
        // chemin que le crochet de `flush` (déjà reçu à la main, collage achevé au repos suivant). Ancré sur la mise en
        // file : la réponse est de toute façon cherchée APRÈS l'entrée de l'ordre dans le journal.
        const enAttente = !!c.attente?.includes(m.texteRemis)
        const enFile = enAttente || (typeof c.suspens?.texte === 'string' && c.suspens.texte.includes(m.texteRemis)) || enRemise(c.id)
        if (!enFile) passe(m, 'remis', { remisA: m.depuis })
        else if (c.status === 'needs') {
          if (!m.retenuDepuis) passe(m, 'retenu', { retenuDepuis: maintenant })
          // Jamais tapé dans la boîte de permission : `flush` ne colle qu'au repos. Après la retenue, l'ordre sort de la
          // file (seulement s'il y est encore : un texte déjà collé dans le champ est réglé par `acheve` au repos suivant).
          else if (!m.lancement && enAttente && maintenant - m.retenuDepuis >= RETENUE_MS) {
            c.attente.splice(c.attente.indexOf(m.texteRemis), 1)
            if (!c.attente.length) delete c.attenteDepuis
            save()
            passe(m, 'expire', { finA: maintenant })
          }
        } else if (m.etat === 'retenu') passe(m, 'attend', { retenuDepuis: 0 })
        continue
      }
      // Remis : la réponse se lit une fois l'agent revenu au repos APRÈS la remise, depuis 4 s.
      if (c.status === 'ready' && c.since > m.remisA && maintenant - c.since >= REPOS_MS) {
        let r
        try {
          r = reponseApres(c, m.texteRemis)
        } catch {
          continue // journal illisible à l'instant : tour suivant
        }
        if (!r.trouve && maintenant - c.since < GRACE_MS) continue
        const t = r.rep?.t?.trim()
        filOrdres.modifie(m.id, { etat: 'repondu', finA: maintenant, lignes: t ? extrait(t) : [`${m.nom} : au repos, pas de réponse écrite.`] })
      } else if (maintenant - m.remisA > SANS_REPONSE_MS) passe(m, 'sans-reponse', { finA: maintenant })
    }
  }

  return { api, remis, tick }
}
