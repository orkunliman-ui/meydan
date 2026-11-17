// Consoles « locales » : Claude Code piloté par le modèle local du Mac d'Orkun (oMLX, joint par le tunnel launchd du Mac).
// Demande d'Orkun (17/11), mot pour mot : « pk pas rajouter un nouveau plateau "locale" sur Meydan en tunnel avec le mac
// pour le faire directement avec notre interface au lieu d'utiliser OpenCode ? » But : le même principe capitaine +
// consoles par volet, pour contourner la limite de contexte (100 000 jetons) du modèle local. Tâche :
// data/equipes/e1edef0/tache-18-plateau-locale.md ; compte rendu : docs/volets/locale.md.
//
// Une console locale EST une console Claude (`kind: 'claude'` : mêmes hooks, même lecture d'écran, même discussion), marquée
// `local: true`. Seuls changent, dans server.mjs : son environnement (oMLX au lieu d'Anthropic, un dossier de configuration
// à elle, jamais ~/.claude), sa ligne de lancement (restrictions d'un équipier, modèle `local` (MEYDAN_LOCAL_MODELE), aucun serveur MCP) et le
// dossier où lire sa conversation. Ce module ne connaît ni HTTP entrant ni tmux.
//
// Contrat :
//   ouvreLocale({ DATA, env, actif }) → { MODELE, MAX, dossier(id), journaux(id), prepare(id), envSession(id), aideCle,
//     sonde({ fraiche }), etat(), prend(consoles, n), surChangement(f), arret() }
//   prend(consoles, n) : réserve n places de consoles locales TOUT DE SUITE (avant le moindre `await` : deux lancements
//     simultanés ne passent pas le plafond à deux), puis sonde le Mac ; rend `libere()`, à appeler une fois les consoles
//     créées (elles comptent alors par elles-mêmes) ou abandonnées. Lève { code: 409 } au-delà du plafond, { code: 503 }
//     Mac hors ligne, avec une phrase en français dite telle quelle par l'écran et par `meydan lancer`.
//
// Réglages (environnement du moteur ; les essais les remplacent) :
//   MEYDAN_LOCAL_URL (http://127.0.0.1:18000 : le port 8000 du Mac, renvoyé sur le VPS par son tunnel), MEYDAN_LOCAL_CLE
//   (~/.config/omlx-mac/cle, 0600 : jamais affichée ni journalisée, jamais sur une ligne de commande), MEYDAN_LOCAL_MODELE
//   (local), MEYDAN_LOCAL_CONTEXTE (100000), MEYDAN_LOCAL_MAX (4 consoles locales ouvertes à la fois, capitaines compris :
//   chacune est un client d'oMLX, qui en sert 8 au plus et met les autres en file).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const entier = (v, defaut, min = 1) => (/^\d+$/.test(String(v ?? '').trim()) && Number(v) >= min ? Number(v) : defaut)
// Le chemin de la clé part dans la commande `apiKeyHelper` (lancée par un shell) : caractères sûrs seulement. Sinon la
// fonction locale est coupée (dit au journal, chaque lancement refusé), jamais tout Meydan (relecture du 17/11).
const cheminSur = (v) => /^[A-Za-z0-9._\/@:=+-]+$/.test(v)

// Qui tient le port d'écoute de 127.0.0.1:<port> ? Relecture de sécurité du 17/11 : quand le Mac dort, son tunnel lâche le
// port ; n'importe quel compte de la machine peut alors l'ouvrir, recevoir la clé de la sonde, se faire passer pour le Mac
// et dicter des commandes Bash exécutées sous le compte de Meydan. La clé ne part que vers un port tenu par le compte de Meydan
// (celui du sshd du tunnel). Lu dans /proc/net/tcp (et tcp6) : `local_address` en hexadécimal, état 0A = LISTEN, uid.
// Rend [] (personne n'écoute), ou la liste des uid qui écoutent sur ce port (toutes adresses locales).
export function uidsALEcoute(port, lire = (f) => fs.readFileSync(f, 'utf8')) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const uids = []
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let t = ''
    try {
      t = lire(f)
    } catch {
      continue // pas d'IPv6 : rien à lire
    }
    for (const l of t.split('\n').slice(1)) {
      const c = l.trim().split(/\s+/)
      if (c.length > 7 && c[1].endsWith(`:${hex}`) && c[3] === '0A') uids.push(Number(c[7]))
    }
  }
  return uids
}

export function ouvreLocale({ DATA, env = process.env, actif = () => false, uid = process.getuid?.() ?? -1, lireProc } = {}) {
  const URL_LOCALE = String(env.MEYDAN_LOCAL_URL || 'http://127.0.0.1:18000').replace(/\/+$/, '')
  const CLE_BRUT = path.resolve(env.MEYDAN_LOCAL_CLE || path.join(os.homedir(), '.config', 'omlx-mac', 'cle'))
  const CLE = cheminSur(CLE_BRUT) ? CLE_BRUT : ''
  if (!CLE) console.error(`[locale] MEYDAN_LOCAL_CLE impossible à passer à un shell (${CLE_BRUT.slice(0, 120)}) : équipes locales coupées`)
  let cible = null
  try {
    cible = new URL(URL_LOCALE)
  } catch {
    console.error(`[locale] MEYDAN_LOCAL_URL illisible : équipes locales coupées`)
  }
  const boucleLocale = cible && ['127.0.0.1', 'localhost'].includes(cible.hostname) && cible.protocol === 'http:'
  const MODELE = /^[A-Za-z0-9._-]{1,60}$/.test(env.MEYDAN_LOCAL_MODELE ?? '') ? env.MEYDAN_LOCAL_MODELE : 'local'
  const CONTEXTE = entier(env.MEYDAN_LOCAL_CONTEXTE, 100000, 8000)
  const MAX = entier(env.MEYDAN_LOCAL_MAX, 4)
  const RACINE = path.join(DATA, 'locale')

  // Le dossier de configuration de Claude Code d'UNE console locale (CLAUDE_CONFIG_DIR) : ses conversations, son historique,
  // ses réglages de session. Sous les données de Meydan, hors des dossiers ouverts à l'agent (`--add-dir`), jamais
  // ~/.claude (identifiants Anthropic d'Orkun, connecteurs claude.ai). Gardé tant que Meydan existe : la conversation sert à
  // la discussion et à la reprise, comme ~/.claude/projects pour les autres consoles.
  const dossier = (id) => {
    if (!/^c[0-9a-f]{8}$/.test(id)) throw new Error(`identifiant de console invalide : ${id}`)
    return path.join(RACINE, id)
  }
  const journaux = (id) => path.join(dossier(id), 'projects')

  // Prépare le dossier avant le lancement. Premier lancement : un `.claude.json` qui dit l'accueil déjà fait. Sans lui, un
  // dossier neuf ouvre le choix du thème puis les « Security notes » (sondé le 17/11, Claude Code 2.1.326) : chaque
  // équipier local attendrait Orkun avant de lire son brief. C'est un fichier de Meydan, propre à cette console : le
  // ~/.claude.json d'Orkun n'est ni lu ni écrit. La confiance du dossier n'y est PAS posée : Meydan y répond à l'écran
  // comme pour toute console Claude (accepteConfiance, ordre d'Orkun du 11/11).
  function prepare(id) {
    const d = dossier(id)
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const f = path.join(d, '.claude.json')
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }) + '\n', { mode: 0o600, flag: 'wx' })
    return d
  }

  // Environnement de la SESSION tmux (comme le compte 2) : un `claude` relancé à la main dans cette console reste sur le
  // Mac, jamais sur Anthropic. Aucun secret : la clé passe par `apiKeyHelper` (réglages de la console, aideCle), lue par
  // Claude Code à chaque besoin ; elle n'est ni dans l'environnement du Bash de l'agent, ni dans une ligne de commande
  // (le serveur tmux garde les arguments de la commande qui l'a démarré, lisibles par `ps`).
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS : sans lui, Claude Code suppose 1 M de jetons pour un modèle qu'il ne connaît pas et
  // ne compacte jamais (sondé le 17/11 : « context assumed to be 1m tokens ») ; avec lui, /context dit 100k et la
  // compaction part à ~67k (réserve de 33k pour la réponse, max_tokens 32 000 : sondé avec une fenêtre de 45k).
  // Tous les alias de modèle pointent sur le local : sous-agents, petites tâches et classifieur du mode « auto » compris.
  const envSession = (id) => ({
    CLAUDE_CONFIG_DIR: dossier(id),
    ANTHROPIC_BASE_URL: URL_LOCALE,
    ANTHROPIC_MODEL: MODELE,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODELE,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODELE,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODELE,
    CLAUDE_CODE_SUBAGENT_MODEL: MODELE,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CONTEXTE),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  })
  const aideCle = CLE ? `/bin/cat ${CLE}` : '/bin/false' // chemin invalide : aucune console locale ne passe `prend` de toute façon

  // ── Le Mac est-il joignable ? GET /v1/models d'oMLX, avec la clé. Dans le processus (jamais un curl : la clé serait sur
  // sa ligne de commande), 3 s au plus ; le tunnel se reconnecte seul quand le Mac se réveille (KeepAlive de launchd).
  let etatMac = { enLigne: null, raison: 'pas encore sondé', depuis: 0, lu: 0 }
  const abonnes = new Set()
  const pourquoi = (e) => {
    const code = e?.cause?.code || e?.code || ''
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'le tunnel du Mac ne répond pas'
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'le Mac ne répond pas (en veille ?)'
    return `oMLX injoignable (${String(code || e?.message || e).slice(0, 80)})`
  }
  async function interroge() {
    if (!CLE) return { enLigne: false, raison: 'chemin de la clé d’oMLX invalide (MEYDAN_LOCAL_CLE)' }
    if (!boucleLocale) return { enLigne: false, raison: 'MEYDAN_LOCAL_URL doit viser http://127.0.0.1:<port> (le tunnel du Mac)' }
    const tenu = uidsALEcoute(Number(cible.port || 80), lireProc)
    if (!tenu.length) return { enLigne: false, raison: 'le tunnel du Mac ne répond pas' }
    const autre = tenu.find((u) => u !== uid)
    if (autre !== undefined) {
      console.error(`[locale] port ${cible.port} tenu par l’uid ${autre}, pas par Meydan (uid ${uid}) : clé non envoyée`)
      return { enLigne: false, raison: `le port ${cible.port} est tenu par un autre compte de la machine (uid ${autre}) : clé non envoyée` }
    }
    let cle = ''
    try {
      cle = fs.readFileSync(CLE, 'utf8').trim()
    } catch {
      return { enLigne: false, raison: 'clé d’oMLX illisible sur le VPS' }
    }
    if (!cle) return { enLigne: false, raison: 'clé d’oMLX vide sur le VPS' }
    try {
      // `redirect: 'error'` : la clé ne suit jamais une redirection vers une autre adresse.
      const r = await fetch(`${URL_LOCALE}/v1/models`, { headers: { authorization: `Bearer ${cle}` }, redirect: 'error', signal: AbortSignal.timeout(3000) })
      if (r.status === 401 || r.status === 403) return { enLigne: false, raison: 'oMLX refuse la clé' }
      if (!r.ok) return { enLigne: false, raison: `oMLX répond ${r.status}` }
      const j = await r.json().catch(() => null)
      const ids = Array.isArray(j?.data) ? j.data.map((m) => String(m?.id ?? '')) : []
      if (!ids.includes(MODELE)) return { enLigne: false, raison: `le modèle « ${MODELE} » n’est pas chargé dans oMLX` }
      return { enLigne: true, raison: '' }
    } catch (e) {
      return { enLigne: false, raison: pourquoi(e) }
    }
  }
  let enVol = null
  async function sonde({ fraiche = false } = {}) {
    if (!fraiche && Date.now() - etatMac.lu < 5000) return etatMac
    if (!enVol)
      enVol = interroge().then((r) => {
        const change = r.enLigne !== etatMac.enLigne || r.raison !== etatMac.raison
        etatMac = { ...r, depuis: change ? Date.now() : etatMac.depuis, lu: Date.now() }
        if (change) for (const f of abonnes) try { f(etat()) } catch (e) { console.error(`[locale] ${e.message}`) }
        return etatMac
      }).finally(() => (enVol = null))
    return enVol
  }
  const etat = () => ({ enLigne: etatMac.enLigne, raison: etatMac.raison, depuis: etatMac.depuis, modele: MODELE, max: MAX, contexte: CONTEXTE })
  const surChangement = (f) => abonnes.add(f)
  // Sondé toutes les 30 s pour l'écran (l'indicateur « Mac hors ligne »), SEULEMENT tant qu'une équipe locale existe
  // (`actif`) ; frais à chaque lancement et à l'ouverture du formulaire (GET /api/locale). Sans équipe locale, rien ne
  // part vers le Mac : ni la production, ni les bancs d'essai n'envoient la clé pour rien.
  const minuteur = setInterval(() => actif() && sonde().catch(() => {}), 30000)
  minuteur.unref()

  // ── Plafond et Mac, avant tout lancement d'une console locale ──
  let reservees = 0
  const ouvertes = (consoles) => consoles.filter((c) => c.local && c.status !== 'closed').length
  async function prend(consoles, n = 1) {
    const deja = ouvertes(consoles) + reservees
    if (deja + n > MAX)
      throw Object.assign(new Error(`${MAX} consoles locales ouvertes au plus (le Mac partage son débit entre elles) : ${deja} déjà ouverte${deja > 1 ? 's' : ''}. Clos-en une, puis relance.`), { code: 409 })
    reservees += n
    let rendue = false
    const libere = () => {
      if (!rendue) reservees -= n
      rendue = true
    }
    try {
      const m = await sonde({ fraiche: true })
      if (!m.enLigne) throw Object.assign(new Error(`Mac hors ligne (${m.raison}) : réveille le Mac, attends que son tunnel se reconnecte, puis relance.`), { code: 503 })
    } catch (e) {
      libere()
      throw e
    }
    return libere
  }

  return { MODELE, MAX, CONTEXTE, URL: URL_LOCALE, dossier, journaux, prepare, envSession, aideCle, sonde, etat, prend, surChangement, arret: () => clearInterval(minuteur) }
}
