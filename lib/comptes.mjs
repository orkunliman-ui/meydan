// Comptes Claude / Codex (volet « comptes », 11/11). Contrat : docs/volets/comptes-contrat.md (morceau A).
// Demande (BRIEF-VOLET.md) : « Plusieurs comptes Claude / Codex » — « deux comptes Claude Code ou Codex
// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), usage et jetons par compte ».
// Lecture seule des journaux que les agents écrivent eux-mêmes. Les fichiers d'identité (`.credentials.json`, `auth.json`,
// `.claude.json`) ne sont JAMAIS ouverts : « connecté » = le fichier existe, rien de plus.
import fs from 'node:fs'
import path from 'node:path'

export const COMPTES = ['1', '2']
export const autre = (compte) => (compte === '2' ? '1' : '2')
const AGENTS = ['claude', 'codex']

// Valeur reçue d'une requête → '1' | '2' | null (null = refusée).
export function compteValide(v) {
  if (v === undefined || v === '' || v === 1 || v === '1') return '1'
  if (v === 2 || v === '2') return '2'
  return null
}

// ── Prix Claude ──
// USD par million de jetons : entrée, sortie, cache lu, cache écrit 5 min, cache écrit 1 h. Source : référence `claude-api`
// locale (cache du 2026-11-03), recopiée dans le contrat. Un modèle absent : coût inconnu (null), jamais deviné.
const P = (e, s, l, w5, w1) => ({ e, s, l, w5, w1 })
const OPUS5 = P(5, 25, 0.5, 6.25, 10)
const FABLE5 = P(10, 50, 1, 12.5, 20)
const PRIX = new Map([
  ['claude-fable-5-2', P(8, 40, 0.2, 10, 16)],
  ['claude-fable-5-1', FABLE5],
  ['claude-fable-5', FABLE5],
  ['claude-opus-5-5', P(4, 20, 0.2, 5, 8)],
  ['claude-opus-5', OPUS5],
  ['claude-opus-4-8', OPUS5],
  ['claude-opus-4-7', OPUS5],
  ['claude-opus-4-6', OPUS5],
  ['claude-sonnet-5-5', P(2, 10, 0.1, 2.5, 4)],
  ['claude-sonnet-5', P(2, 10, 0.2, 2.5, 4)],
  ['claude-sonnet-4-6', P(3, 15, 0.3, 3.75, 6)],
  ['claude-haiku-5-5', P(0.1, 0.5, 0.01, 0.125, 0.2)],
  ['claude-haiku-4-5', P(1, 5, 0.1, 1.25, 2)],
])
const HAIKU55_LONG = P(0.5, 2.5, 0.05, 0.625, 1) // Haiku 5.5 au-delà de 100 k jetons d'invite
const nb = (x) => (Number.isFinite(x) && x > 0 ? x : 0)

// Prix d'un message Claude (USD) ou null si le modèle est inconnu. `u` = message.usage tel quel. Un nom daté
// (`claude-haiku-4-5-20251001`) ou suffixé `[1m]` est ramené à son nom court.
export function coutClaude(modele, u) {
  const nom = String(modele ?? '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '')
  let p = PRIX.get(nom)
  if (!p) return null
  u = u && typeof u === 'object' ? u : {}
  const entree = nb(u.input_tokens)
  const lu = nb(u.cache_read_input_tokens)
  const ecrit = nb(u.cache_creation_input_tokens)
  if (nom === 'claude-haiku-5-5' && entree + lu + ecrit > 100_000) p = HAIKU55_LONG
  // Cache écrit : le détail 5 min / 1 h quand le journal le donne, sinon tout au tarif 5 min.
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null
  const detail = cc && (Number.isFinite(cc.ephemeral_5m_input_tokens) || Number.isFinite(cc.ephemeral_1h_input_tokens))
  const w5 = detail ? nb(cc.ephemeral_5m_input_tokens) : ecrit
  const w1 = detail ? nb(cc.ephemeral_1h_input_tokens) : 0
  return (entree * p.e + nb(u.output_tokens) * p.s + lu * p.l + w5 * p.w5 + w1 * p.w1) / 1e6
}

// ── Usage d'un message Claude, conseiller compris (volet quota, 17/11) ──
// Relevé sur les vrais journaux (lecture seule, 17/11, 21 693 messages de 3 jours) : le conseiller (`--advisor`, Fable 5.2)
// n'est PAS dans l'`usage` de tête ; il est dans `usage.iterations[]` (`type: 'advisor_message'`, avec son `model`). Les
// quatre champs de tête valent la somme des itérations `type: 'message'` (21 693 sur 21 693). Mais le détail
// `cache_creation` (5 min / 1 h) de tête est celui de la PREMIÈRE itération seulement (628 messages coupés par le
// conseiller sur 628) : le prix de tête se calcule donc itération par itération quand elles redonnent exactement la tête.
// → { parts: [{ modele, entree, sortie, cacheLu, cacheEcrit, total, cout, conseiller }] } : la tête d'abord, puis une
// part par itération `advisor_message`. `cout` null = modèle sans prix connu (jamais deviné).
// Ces journaux sont écrits par des agents : nombres négatifs, non finis ou énormes ignorés (0), nom de modèle tronqué
// AVANT les expressions régulières de coutClaude, nombre d'itérations examinées borné.
const MAX_JETONS = 1e9 // par poste et par message : aucun appel réel n'en porte autant
const borne = (x) => (Number.isFinite(x) && x > 0 && x <= MAX_JETONS ? x : 0)
const MAX_ITERATIONS = 64
const CHAMPS_U = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const nomModele = (m) => (typeof m === 'string' ? m.slice(0, 100) : '') || 'inconnu'
function usagePropre(u) {
  const p = {}
  for (const k of CHAMPS_U) p[k] = borne(u[k])
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null
  if (cc && (Number.isFinite(cc.ephemeral_5m_input_tokens) || Number.isFinite(cc.ephemeral_1h_input_tokens)))
    p.cache_creation = { ephemeral_5m_input_tokens: borne(cc.ephemeral_5m_input_tokens), ephemeral_1h_input_tokens: borne(cc.ephemeral_1h_input_tokens) }
  return p
}
const partDe = (modele, u, cout, conseiller) => {
  const x = { modele, entree: u.input_tokens, sortie: u.output_tokens, cacheLu: u.cache_read_input_tokens, cacheEcrit: u.cache_creation_input_tokens }
  return { ...x, total: x.entree + x.sortie + x.cacheLu + x.cacheEcrit, cout, conseiller }
}
export function usageClaude(message) {
  const u = message && typeof message === 'object' ? message.usage : null
  if (!u || typeof u !== 'object') return { parts: [] }
  const modele = nomModele(message.model)
  const tete = usagePropre(u)
  const its = Array.isArray(u.iterations) ? u.iterations.slice(0, MAX_ITERATIONS).filter((it) => it && typeof it === 'object') : []
  const msgs = its.filter((it) => it.type === 'message').map(usagePropre)
  const memes = msgs.length > 0 && CHAMPS_U.every((k) => msgs.reduce((s, it) => s + it[k], 0) === tete[k])
  let cout = memes ? 0 : coutClaude(modele, tete)
  if (memes) {
    for (const it of msgs) {
      const c = coutClaude(modele, it)
      if (c === null) {
        cout = null
        break
      }
      cout += c
    }
  }
  const parts = [partDe(modele, tete, cout, false)]
  for (const it of its) {
    if (it.type !== 'advisor_message') continue
    const m = nomModele(it.model)
    const v = usagePropre(it)
    parts.push(partDe(m, v, coutClaude(m, v), true))
  }
  return { parts }
}

// ── Limite d'usage lue à l'écran ──
// Textes relevés le 11/11/2026 dans les programmes installés, en lecture seule (`strings` / `grep -a`, aucun agent lancé) :
//
// Claude Code 2.1.322 (`readlink -f "$(command -v claude)"` = ~/.local/share/claude/versions/2.1.322) :
//   function k(e,n,r,s){… return`You've hit your ${e}${n}${d}`}   (apostrophe droite)
//   var A_e={five_hour:"5-hour limit",seven_day:"weekly limit",seven_day_opus:"Opus limit",seven_day_sonnet:"Sonnet limit",
//            seven_day_overage_included:"Fable limit",overage:"usage credit limit"}
//   b=h?` \xB7 resets ${h}`:""          → « You've hit your 5-hour limit · resets 5pm (Europe/Brussels) »
//   c("session limit") (ancien nom de la fenêtre de 5 h, lu par WE()) ; « You've hit your monthly spend limit » ;
//   k("team's shared budget",…) ; k(…"org's monthly usage limit"…) ;
//   var we="Usage limit reached"; `${we} \xB7 limit resets ${s}` ; « Usage limit reached \xB7 continuing automatically {when}
//   \xB7 esc to cancel » ; « Usage limit reached again » ; « You're out of extra usage » ; `You're out of usage credits${w}` ;
//   « Your org is out of usage \xB7 add funds … » ; « Fable limit reached \xB7 continuing on … uses usage credits ».
//   Ce qui n'est PAS une limite du compte (écarté) : « You've used … » / « You're close to … » (avertissements, BWs),
//   « Request rejected (429) », "rate_limit_error", « Repeated 529 Overloaded errors », « Fast limit reached and temporarily
//   disabled » (mode rapide), « Context limit reached », « Budget limit reached ($ », « Concurrent subagent limit reached ».
//   Les anciennes versions écrivaient « 5-hour limit reached ∙ resets 5pm » (puce ∙) : même forme, acceptée aussi.
//
// Codex 0.167.1 (`readlink -f "$(command -v codex)"` = …/@openai/codex/bin/codex.js, lanceur node ; le programme est
// …/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex) :
//   « You’ve hit your usage limit. » (apostrophe COURBE U+2019, vue en octets 342 200 231), « You’ve hit your usage limit for »,
//   « … Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), », « … Upgrade to Pro
//   (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits », « … To get more
//   access now, send a request to your admin », suivis de « or try again at » / « Try again at » ;
//   « Usage limit reached. » + « You've reached your usage limit. Increase your limits to continue using codex. » ;
//   « You're out of credits. » + « Your workspace is out of credits. Add credits to continue using Codex. ».
//   Écarté : « Codex is currently experiencing high load. », « retry limit reached », « Try again later. ».
//
// La ligne doit COMMENCER par le texte (après les signes de l'interface : ⎿ ■ ● ⏺ │ …) : un agent qui CITE ce message dans
// sa réponse (« Le message « You've hit… » ») ou Orkun qui le tape dans le champ (« > You've… ») ne déclenche rien.
const A = "[’']" // les deux apostrophes
const LIMITES = {
  claude: [
    new RegExp(`^you${A}ve hit your (?:(?:5-hour|session|weekly|opus|sonnet|fable|usage credit|monthly spend|org${A}s monthly usage) limit|team${A}s shared budget)`, 'i'),
    /^(?:claude (?:ai )?)?usage limit reached\b/i,
    /^(?:5-hour|session|weekly|opus|sonnet|fable)(?: weekly)? limit reached\b/i,
    new RegExp(`^you${A}re out of (?:extra usage|usage credits)\\b`, 'i'),
    /^your org is out of usage\b/i,
  ],
  codex: [
    new RegExp(`^you${A}ve (?:hit|reached) your usage limit\\b`, 'i'),
    /^usage limit reached\b/i,
    new RegExp(`^(?:you${A}re out of credits|your workspace is out of credits)\\b`, 'i'),
  ],
}
// Signes posés par l'interface en tête de ligne (pas les invites « > », « ❯ », « › » : ce qui suit est tapé par Orkun).
const DECOR = /^[\s─-▟⎿⏺■-◿•·∙✢-✽⚠✗✘×️|]+/u
const nettoie = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(DECOR, '').replace(/\s+/g, ' ').trim()

// Lit un écran de console (`tmux capture-pane -p -J`) → null | { texte } (la ligne trouvée, nettoyée, ≤ 160 caractères).
// Seules les 15 dernières lignes non vides comptent ; la plus basse gagne.
// Tête de ligne propre à chaque agent (relecture indépendante du 11/11, prouvé : retirer « tout retrait et tout signe »
// prenait pour une limite la 2e ligne d'un message d'Orkun, un paragraphe de réponse, une sortie d'essai « ⎿ ✗ … » ou une
// puce « • » de Codex) : Claude écrit l'erreur sous le tour, après UN « ⎿ » (ou en colonne 0) ; Codex la marque d'un « ■ ».
const TETE = { claude: /^(?:[ \t]*⎿[ \t]+)?(?=[^\s⏺•·∙✢-✽✗✘│>❯›■-◿─-▟])/u, codex: /^[ \t]*■[ \t]+/u }
export function quotaEcran(kind, ecran) {
  const motifs = LIMITES[kind === 'claude' || kind === 'codex' ? kind : '']
  if (!motifs || typeof ecran !== 'string') return null
  const lignes = ecran.split('\n').filter((l) => l.trim()).slice(-15)
  for (let i = lignes.length - 1; i >= 0; i--) {
    const brute = lignes[i].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    const tete = TETE[kind].exec(brute)
    if (!tete) continue
    const t = nettoie(brute.slice(tete[0].length))
    if (motifs.some((m) => m.test(t))) return { texte: t.length > 160 ? `${t.slice(0, 159)}…` : t }
  }
  return null
}

// ── Dates locales ──
const QUART = 15 * 60 * 1000 // tous les fuseaux réels sont décalés d'un multiple de 15 min : la date locale ne change qu'au quart
function horloge(fuseau) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' })
  let cache = new Map()
  return (ms) => {
    const q = Math.floor(ms / QUART)
    let j = cache.get(q)
    if (j === undefined) {
      if (cache.size > 5000) cache = new Map()
      j = fmt.format(ms) // « 2026-11-11 »
      cache.set(q, j)
    }
    return j
  }
}
const recule = (jour, n) => {
  const [a, m, j] = jour.split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, j - n)).toISOString().slice(0, 10)
}

// ── Lecture des journaux ──
// On ne cherche que des repères de texte dans les octets bruts : une ligne n'est convertie et lue (JSON.parse) que si elle
// porte l'un d'eux. Dans un texte de conversation, les guillemets sont échappés (\"usage\") : les repères ne visent que la
// structure des lignes.
const MARQUES = {
  claude: [Buffer.from('"usage":')],
  codex: ['"type":"token_usage_record"', '"type":"token_count"', '"type":"turn_context"'].map((m) => Buffer.from(m)),
}
// Appelle `ligne(texte)` pour chaque ligne complète de buf[a, b) qui porte un repère, dans l'ordre du fichier
// (Codex : le modèle de `turn_context` sert aux lignes qui suivent).
export function parcourt(buf, a, b, marques, ligne) {
  const pos = marques.map((m) => buf.indexOf(m, a))
  let p = a
  for (;;) {
    let i = -1
    for (let k = 0; k < marques.length; k++) {
      if (pos[k] !== -1 && pos[k] < p) pos[k] = buf.indexOf(marques[k], p)
      if (pos[k] !== -1 && pos[k] < b && (i === -1 || pos[k] < i)) i = pos[k]
    }
    if (i === -1) return
    const debut = Math.max(a, buf.lastIndexOf(10, i) + 1)
    let fin = buf.indexOf(10, i)
    if (fin === -1 || fin > b) fin = b
    ligne(buf.toString('utf8', debut, fin))
    p = fin + 1
  }
}
// Ouverture sûre, comme lib/budget.mjs (relecture de sécurité du 17/11 : un `*.jsonl` posé par un agent qui était un lien
// symbolique vers un fichier hors des journaux était lu) : O_NOFOLLOW (un lien n'est jamais suivi, même substitué après
// le lstat), O_NONBLOCK (un FIFO ne bloque rien), puis contrôle de CE QUI EST OUVERT : fichier ordinaire à un seul lien,
// et OÙ il est (relecture 2 du 17/11, t5-B) : O_NOFOLLOW ne garde que le dernier élément ; un dossier intermédiaire
// remplacé par un lien entre la liste et l'ouverture (projects/conv → ailleurs) ferait lire un `*.jsonl` hors des
// journaux. Le chemin réel du descripteur doit être `attendu` (chemin réel de la base + chemin relatif sous elle).
// → { fh, st } (à fermer par l'appelant) | null : lien, FIFO, lien physique, ailleurs, disparu : rien n'est lu.
const OUVERTURE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
async function ouvre(chemin, attendu) {
  let fh
  try {
    fh = await fs.promises.open(chemin, OUVERTURE)
    const st = await fh.stat()
    if (!st.isFile() || st.nlink !== 1) throw new Error('pas un fichier ordinaire à un seul lien')
    const reel = await fs.promises.readlink(`/proc/self/fd/${fh.fd}`).catch(() => '')
    if (reel !== attendu) throw new Error('hors des journaux')
    return { fh, st }
  } catch {
    await fh?.close().catch(() => {})
    return null
  }
}
// Bornes de lecture (relecture 2 du 17/11, t5-C : une ligne sans fin n'était pas bornée, 1 Gio creux sans saut de ligne
// = +1 029 Mo de mémoire, relu en entier à chaque calcul). Comme lib/budget.mjs : ligne de 512 Ko au plus (au-delà, ses
// octets sont jetés jusqu'au saut de ligne suivant ; « en train de jeter » est gardé dans l'état du fichier entre deux
// calculs), 64 Mo lus au plus par fichier et par calcul (la suite au calcul suivant), lecture par morceaux de 1 Mo.
const MORCEAU = 1 << 20
const MAX_LIGNE = 512 << 10
const PAR_FICHIER = 64 << 20
// Lit la suite d'un fichier ouvert (`fh`), de f.lu jusqu'à `fin`. f.lu n'avance que sur des lignes finies ou des octets
// jetés : une ligne pas finie attend le calcul suivant. La boucle d'événements respire entre deux morceaux.
async function litSuite(fh, f, fin, marques, lit) {
  // Une ligne prise au milieu d'un morceau peut dépasser la borne (morceau de 1 Mo) : jetée aussi.
  const ligne = (t) => {
    if (!(t.length > MAX_LIGNE / 4 && Buffer.byteLength(t) > MAX_LIGNE)) lit(t)
  }
  const buf = Buffer.allocUnsafe(MORCEAU)
  let pos = f.lu
  let reste = [] // morceaux (copiés) de la ligne commencée
  let resteTaille = 0
  while (pos < fin) {
    let n
    try {
      ;({ bytesRead: n } = await fh.read(buf, 0, Math.min(MORCEAU, fin - pos), pos))
    } catch {
      return // illisible : ce qui a été lu reste lu
    }
    if (!n) return // raccourci pendant la lecture : le calcul suivant le relira depuis 0
    const m = buf.subarray(0, n)
    let a = 0
    if (f.jette) {
      // Suite d'une ligne de plus de 512 Ko : jetée jusqu'à son saut de ligne.
      const nl = m.indexOf(10)
      if (nl === -1) {
        pos += n
        f.lu = pos
        continue
      }
      f.jette = false
      a = nl + 1
      f.lu = pos + a
    }
    const premier = m.indexOf(10, a)
    if (premier === -1) {
      if (resteTaille + n - a > MAX_LIGNE) {
        reste = []
        resteTaille = 0
        f.jette = true
        pos += n
        f.lu = pos
        continue
      }
      reste.push(Buffer.from(m.subarray(a)))
      resteTaille += n - a
      pos += n
      continue
    }
    if (resteTaille + premier - a <= MAX_LIGNE) {
      if (resteTaille) {
        const l = Buffer.concat([...reste, m.subarray(a, premier)])
        parcourt(l, 0, l.length, marques, ligne)
      } else parcourt(m, a, premier, marques, ligne)
    } // sinon : ligne trop longue, jetée
    reste = []
    resteTaille = 0
    const dernier = m.lastIndexOf(10)
    if (dernier > premier) parcourt(m, premier + 1, dernier, marques, ligne)
    f.lu = pos + dernier + 1
    if (dernier + 1 < n) {
      reste = [Buffer.from(m.subarray(dernier + 1))]
      resteTaille = n - dernier - 1
    }
    pos += n
  }
}

// Parcours des journaux (relecture 2 du 17/11, t5-A, t6, t7, t8) : `readdir({ recursive: true })` suivait les liens de
// DOSSIER (boucles, dossiers hors des journaux), gelait la boucle (1,7 s avec 200 000 entrées dans un sous-dossier) et
// échouait en entier sur un seul dossier illisible (usage du compte à 0). Comme lib/budget.mjs : parcours en largeur,
// un `opendir` NON récursif par dossier, type de l'entrée sans suivre de lien (`isDirectory()` pour descendre,
// `isFile()` + `.jsonl` pour lire), profondeur bornée (vrais journaux : 2, 4 et 6 chez Claude, 4 chez Codex), entrées
// examinées bornées par dossier et par COMPTE et par calcul (au-delà : ignorées), un dossier illisible ne saute que lui,
// et la boucle d'événements respire entre deux dossiers.
// Relecture 3 du 17/11 (t15-B) : le budget de 100 000 entrées était partagé par les quatre comptes, dans l'ordre
// claude 1, claude 2, codex 1, codex 2 : Claude 1 inondé (11 × 10 000 entrées) mettait Claude 2 à 0. Il est par compte.
const PROFONDEUR = 8
const MAX_ENTREES_DOSSIER = 10_000
const MAX_ENTREES_COMPTE = 100_000
const MAX_SONDES = 100_000 // fichiers déjà connus sondés hors liste, par compte et par calcul, quand la liste est coupée
const respire = () => new Promise((r) => setImmediate(r))
// → { trouves, coupe } : chemins des `*.jsonl` sous `base` ; `coupe` vrai quand la liste s'arrête avant la fin (borne
// d'un dossier atteinte avec une entrée de plus, ou entrées du compte épuisées). `examen.restant` : entrées encore
// permises pour ce compte et ce calcul.
async function listeJournaux(base, examen) {
  const trouves = []
  let coupe = false
  const file = [{ dossier: base, profondeur: 1 }] // profondeur des entrées du dossier
  let i = 0
  for (; i < file.length && examen.restant > 0; i++) {
    const { dossier, profondeur } = file[i]
    if (i > 0) await respire()
    let d
    try {
      d = await fs.promises.opendir(dossier)
    } catch {
      continue // absent, illisible : ce dossier seulement
    }
    try {
      let n = 0
      for await (const e of d) {
        if (n >= MAX_ENTREES_DOSSIER || examen.restant <= 0) {
          coupe = true // une entrée de plus attendait : ce dossier n'est pas lu jusqu'au bout
          break
        }
        n++
        examen.restant--
        const p = path.join(dossier, e.name)
        if (e.isDirectory()) {
          if (profondeur < PROFONDEUR) file.push({ dossier: p, profondeur: profondeur + 1 })
        } else if (e.isFile() && e.name.endsWith('.jsonl')) trouves.push(p)
      }
    } catch {} // dossier disparu en cours de route : ce qui a été vu reste
    finally {
      await d.close().catch(() => {}) // déjà fermé par la fin de l'itération
    }
  }
  if (i < file.length) coupe = true // entrées du compte épuisées, des dossiers encore en file
  return { trouves, coupe }
}

const vide = (codex) => ({ entree: 0, sortie: 0, cacheLu: 0, cacheEcrit: 0, total: 0, cout: codex ? null : 0, messages: 0 })
const arrondi = (x) => (x === null ? null : Math.round(x * 1e6) / 1e6)

// Le reste est lié à une configuration.
export function ouvreComptes({ home, claudeProjets, codexSessions, compte2Claude, compte2Codex, fuseau = 'Europe/Brussels', maintenant = () => Date.now() }) {
  const deux = (compte) => compteValide(compte) === '2'
  const agent = (kind) => AGENTS.includes(kind)
  // Le dossier de réglages du compte (celui que désignent `CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
  const dossier = (kind, compte) => (kind === 'claude' ? (deux(compte) ? compte2Claude : path.dirname(claudeProjets)) : deux(compte) ? compte2Codex : path.dirname(codexSessions))
  const racine = home ? path.resolve(home) : null
  const court = (p) => (!racine ? p : p === racine ? '~' : p.startsWith(racine + path.sep) ? `~${p.slice(racine.length)}` : p)

  const env = (kind, compte) => (!deux(compte) ? {} : kind === 'claude' ? { CLAUDE_CONFIG_DIR: compte2Claude } : kind === 'codex' ? { CODEX_HOME: compte2Codex } : {})

  // Réglages partagés, identité séparée (contrat, ajout 20:25 UTC) : le compte 2 reçoit des liens vers les éléments SANS
  // identité du compte 1 (gardes `vps-guard` / `secret-guard`, hooks, CLAUDE.md, skills). Liste fermée : rien d'autre
  // n'est jamais lié (ni `.credentials.json`, `.claude.json`, `auth.json`, ni `projects`, `sessions`, historiques).
  const PARTAGES = {
    claude: ['settings.json', 'CLAUDE.md', 'plugins', 'skills', 'rules', 'agents', 'commands'],
    codex: ['config.toml', 'AGENTS.md', 'skills', 'plugins', 'rules', 'prompts'],
  }
  const occupe = (p) => {
    try {
      fs.lstatSync(p) // un lien, même cassé, compte : on n'y touche pas
      return true
    } catch (e) {
      return e.code !== 'ENOENT'
    }
  }
  // Comme env(), et crée d'abord le dossier du compte 2 (récursif, 0700) puis les liens qui manquent. Jamais d'écrasement,
  // jamais de suppression. Rien pour le compte 1.
  function prepare(kind, compte) {
    const e = env(kind, compte)
    if (!Object.keys(e).length) return e
    const ici = dossier(kind, compte)
    const source = dossier(kind, '1')
    fs.mkdirSync(ici, { recursive: true, mode: 0o700 })
    for (const nom of PARTAGES[kind]) {
      const cible = path.join(source, nom)
      const lien = path.join(ici, nom)
      if (!fs.existsSync(cible) || occupe(lien)) continue
      try {
        fs.symlinkSync(cible, lien)
      } catch (err) {
        if (err.code !== 'EEXIST') throw err // posé entre-temps par un autre appel : on le laisse
      }
    }
    return e
  }

  const journaux = (kind, compte) => {
    if (kind !== 'codex') return { projets: deux(compte) ? path.join(compte2Claude, 'projects') : claudeProjets }
    const base = dossier('codex', compte)
    return { sessions: deux(compte) ? path.join(compte2Codex, 'sessions') : codexSessions, index: path.join(base, 'session_index.jsonl'), config: path.join(base, 'config.toml') }
  }

  // Existence du fichier d'identité, jamais ouvert.
  const IDENTITE = { claude: '.credentials.json', codex: 'auth.json' }
  const connecte = (kind, compte) => agent(kind) && fs.existsSync(path.join(dossier(kind, compte), IDENTITE[kind]))

  const liste = () => AGENTS.flatMap((kind) => COMPTES.map((compte) => ({ kind, compte, dossier: court(dossier(kind, compte)), connecte: connecte(kind, compte) })))

  // ── Usage ──
  // Par compte : fichiers déjà lus (octets lus, inode), clés déjà comptées (par jour, pour les oublier avec lui) et
  // agrégats par jour local et par modèle. Seuls les 7 jours de la fenêtre sont gardés.
  const jourDe = horloge(fuseau)
  const etats = new Map()
  const etat = (kind, compte) => {
    const cle = `${kind}:${compte}`
    if (!etats.has(cle)) etats.set(cle, { fichiers: new Map(), vus: new Map(), jours: new Map(), limites: null })
    return etats.get(cle)
  }
  const dejaVu = (e, cle, jour) => {
    for (const s of e.vus.values()) if (s.has(cle)) return true
    if (!e.vus.has(jour)) e.vus.set(jour, new Set())
    e.vus.get(jour).add(cle)
    return false
  }
  // `message` faux : une part de conseiller (volet quota) — ses jetons comptent, pas un message de plus.
  const ajoute = (e, jour, modele, a, message = true) => {
    if (!e.jours.has(jour)) e.jours.set(jour, new Map())
    const parModele = e.jours.get(jour)
    if (!parModele.has(modele)) parModele.set(modele, { ...vide(false), sansPrix: false })
    const g = parModele.get(modele)
    g.entree += a.entree
    g.sortie += a.sortie
    g.cacheLu += a.cacheLu
    g.cacheEcrit += a.cacheEcrit
    g.total += a.total
    if (message) g.messages++
    if (a.cout === null) g.sansPrix = true
    else g.cout += a.cout
  }
  // L'inverse d'ajoute (Codex : un repli `token_count` déjà compté pour un fichier qui se révèle avoir des records).
  const retire = (e, jour, modele, a) => {
    const g = e.jours.get(jour)?.get(modele)
    if (!g) return // jour déjà sorti de la fenêtre
    g.entree -= a.entree
    g.sortie -= a.sortie
    g.cacheLu -= a.cacheLu
    g.total -= a.total
    g.messages--
  }

  // Claude : une ligne par BLOC de contenu, le même message revient avec le même `usage` → clé message.id + requestId.
  function ligneClaude(e, debut, texte) {
    if (!texte.includes('"type":"assistant"')) return
    let j
    try {
      j = JSON.parse(texte)
    } catch {
      return
    }
    const m = j?.message
    const u = m?.usage
    if (j.type !== 'assistant' || !u || typeof u !== 'object') return
    const ms = Date.parse(j.timestamp)
    if (!Number.isFinite(ms)) return
    const jour = jourDe(ms)
    if (jour < debut) return
    if (m.id && dejaVu(e, `${m.id}:${j.requestId ?? ''}`, jour)) return
    // Une part par modèle : la tête (un message), puis chaque passage du conseiller (volet quota, usageClaude).
    usageClaude(m).parts.forEach((p, i) => ajoute(e, jour, p.modele, p, i === 0))
  }

  // Codex : `token_usage_record` une fois par réponse (clé response_id) ; à défaut (anciennes versions, aucun
  // `token_usage_record` dans le fichier), les écarts successifs de `token_count.info.total_token_usage`. Le
  // `token_usage_record` précède le `token_count` de la même réponse (relevé le 11/11) : dès le premier, plus de repli.
  function compteCodex(e, f, ms, cle, u, debut) {
    const jour = jourDe(ms)
    if (jour < debut || (cle && dejaVu(e, cle, jour))) return
    const cache = nb(u.cached_input_tokens)
    const entree = Math.max(0, nb(u.input_tokens) - cache)
    const sortie = nb(u.output_tokens)
    const total = Number.isFinite(u.total_tokens) ? nb(u.total_tokens) : entree + cache + sortie
    const a = { entree, sortie, cacheLu: cache, cacheEcrit: 0, total, cout: null }
    ajoute(e, jour, f.modele || 'inconnu', a)
    return { jour, modele: f.modele || 'inconnu', a }
  }
  const fenetre = (w, ms) =>
    w && typeof w === 'object'
      ? {
          pourcent: Number.isFinite(w.used_percent) ? w.used_percent : null,
          fenetreMin: Number.isFinite(w.window_minutes) ? w.window_minutes : null,
          repart: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : Number.isFinite(w.resets_in_seconds) ? ms + w.resets_in_seconds * 1000 : null,
        }
      : null
  function ligneCodex(e, f, chemin, debut, texte) {
    let j
    try {
      j = JSON.parse(texte)
    } catch {
      return
    }
    const p = j?.payload
    if (!p || typeof p !== 'object') return
    if (j.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) f.modele = p.model
      return
    }
    const ms = Date.parse(j.timestamp)
    if (!Number.isFinite(ms)) return
    if (j.type === 'token_usage_record') {
      // Premier record du fichier : ce que le repli a compté avant lui (un `token_count` écrit avant son record, ou lu
      // dans un tour précédent pendant que le fichier s'écrivait) est retiré — relecture indépendante du 11/11 : sinon
      // la même réponse comptait deux fois.
      if (!f.aRecord) for (const r of f.replis ?? []) retire(e, r.jour, r.modele, r.a)
      f.replis = []
      f.aRecord = true
      if (p.usage && typeof p.usage === 'object') compteCodex(e, f, ms, p.response_id ? `r:${p.response_id}` : null, p.usage, debut)
      return
    }
    if (j.type !== 'event_msg' || p.type !== 'token_count') return
    // Limites : celles du `token_count` le plus récent du compte (par horodatage, tous fichiers confondus).
    const rl = p.rate_limits
    if (rl && typeof rl === 'object' && (!e.limites || ms > e.limites.lu)) {
      const primaire = fenetre(rl.primary, ms)
      const secondaire = fenetre(rl.secondary, ms)
      if (primaire || secondaire) e.limites = { lu: ms, primaire, secondaire }
    }
    const t = p.info?.total_token_usage
    if (f.aRecord || !t || typeof t !== 'object') return
    const avant = nb(t.total_tokens) < f.repli.total_tokens ? {} : f.repli // compteur reparti de zéro : nouvelle base
    const d = {}
    for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens']) d[k] = Math.max(0, nb(t[k]) - nb(avant[k]))
    f.repli = { input_tokens: nb(t.input_tokens), cached_input_tokens: nb(t.cached_input_tokens), output_tokens: nb(t.output_tokens), total_tokens: nb(t.total_tokens) }
    const r = d.total_tokens > 0 ? compteCodex(e, f, ms, `t:${chemin}:${f.repli.total_tokens}`, d, debut) : null
    if (r) (f.replis ??= []).push(r)
  }

  // → { e, coupe } : l'état du compte et, pour CE calcul seulement (jamais gardé dans l'état), « la liste ou la lecture
  // s'est arrêtée avant la fin » ; l'écran dit alors « au moins » (relecture 3 du 17/11, t15-A : rien ne le disait).
  // Entrées de dossier : MAX_ENTREES_COMPTE pour ce compte seul (t15-B).
  async function litCompte(kind, compte, debut, seuil) {
    const e = etat(kind, compte)
    for (const j of [...e.jours.keys()]) if (j < debut) e.jours.delete(j)
    for (const j of [...e.vus.keys()]) if (j < debut) e.vus.delete(j)
    const j = journaux(kind, compte)
    const base = kind === 'claude' ? j.projets : j.sessions
    // Chemin réel de la base, une fois par calcul : celui que doit avoir chaque fichier ouvert (contrôle dans ouvre()).
    const reelle = await fs.promises.realpath(base).catch(() => null)
    // Sous-agents Claude compris (<session>/subagents/, <session>/subagents/workflows/<wf>/). Dossier absent : compte vide.
    const parcours = reelle ? await listeJournaux(base, { restant: MAX_ENTREES_COMPTE }) : { trouves: [], coupe: false }
    const chemins = parcours.trouves
    let coupe = parcours.coupe
    // Liste coupée (t15-A : 20 000 entrées vides à la base de projects/, le vrai dossier au-delà de la 10 000e n'était
    // plus lu, et le même serveur oubliait un journal qu'il lisait) : les fichiers DÉJÀ connus qui n'ont pas été listés
    // sont sondés quand même, par la même boucle (lstat, seuil, ouverture sûre et contrôle de /proc/self/fd), après les
    // listés. Au plus MAX_SONDES, les plus anciennement connus d'abord : le cache reste borné (listés + sondés).
    if (coupe) {
      const listes = new Set(chemins)
      let n = 0
      for (const chemin of e.fichiers.keys()) {
        if (n >= MAX_SONDES) break
        if (!listes.has(chemin)) {
          chemins.push(chemin)
          n++
        }
      }
    }
    const presents = new Set()
    for (const chemin of chemins) {
      let st
      try {
        st = await fs.promises.lstat(chemin) // un lien n'est pas un fichier ordinaire : jamais suivi (relecture du 17/11)
      } catch {
        continue
      }
      if (!st.isFile() || st.mtimeMs < seuil) continue // trop vieux : ignoré, et oublié du cache plus bas
      presents.add(chemin)
      const avant = e.fichiers.get(chemin)
      if (avant && avant.ino === st.ino && avant.lu === st.size) continue // rien de neuf : rien n'est ouvert
      const o = await ouvre(chemin, path.join(reelle, path.relative(base, chemin)))
      if (!o) continue
      try {
        let f = avant
        if (!f || f.ino !== o.st.ino || o.st.size < f.lu) {
          // nouveau, remplacé ou raccourci : relu depuis 0 (les clés déjà comptées ne recomptent pas)
          f = { ino: o.st.ino, lu: 0, jette: false, modele: null, aRecord: false, repli: {} }
          e.fichiers.set(chemin, f)
        }
        if (o.st.size === f.lu) continue
        const ligne = kind === 'claude' ? (t) => ligneClaude(e, debut, t) : (t) => ligneCodex(e, f, chemin, debut, t)
        const fin = Math.min(o.st.size, f.lu + PAR_FICHIER)
        // Rattrapage plafonné à 64 Mo ce calcul-ci : la suite au calcul suivant, l'écran dit « au moins » d'ici là. Testé
        // sur le plafond, pas sur f.lu après lecture : une dernière ligne pas encore finie n'est pas une coupe.
        if (fin < o.st.size) coupe = true
        await litSuite(o.fh, f, fin, MARQUES[kind], ligne)
      } finally {
        await o.fh.close().catch(() => {})
      }
    }
    for (const chemin of [...e.fichiers.keys()]) if (!presents.has(chemin)) e.fichiers.delete(chemin)
    return { e, coupe }
  }

  function resume(kind, compte, e, jour, debut, coupe) {
    const codex = kind === 'codex'
    const r = { jour: vide(codex), semaine: vide(codex) }
    const parModele = new Map()
    const inconnus = new Set()
    const somme = (x, g) => {
      for (const k of ['entree', 'sortie', 'cacheLu', 'cacheEcrit', 'total', 'messages']) x[k] += g[k]
      if (!codex) x.cout += g.cout
    }
    for (const [d, modeles] of e.jours) {
      if (d < debut || d > jour) continue
      for (const [m, g] of modeles) {
        somme(r.semaine, g)
        if (d === jour) somme(r.jour, g)
        if (!parModele.has(m)) parModele.set(m, { modele: m, total: 0, cout: codex ? null : 0, sansPrix: false })
        const pm = parModele.get(m)
        pm.total += g.total
        if (!codex) pm.cout += g.cout
        if (!codex && g.sansPrix) {
          pm.sansPrix = true
          inconnus.add(m)
        }
      }
    }
    r.jour.cout = arrondi(r.jour.cout)
    r.semaine.cout = arrondi(r.semaine.cout)
    const modeles = [...parModele.values()]
      .sort((a, b) => b.total - a.total)
      .map(({ modele, total, cout, sansPrix }) => ({ modele, total, cout: sansPrix ? null : arrondi(cout) }))
    return { kind, compte, dossier: court(dossier(kind, compte)), connecte: connecte(kind, compte), ...r, modeles, prixInconnu: [...inconnus].sort(), limites: codex && e.limites ? { ...e.limites } : null, coupe }
  }

  async function calcule() {
    const t0 = Date.now()
    const calculeLe = maintenant()
    const jour = jourDe(calculeLe)
    const debut = recule(jour, 6) // 7 jours locaux finissant aujourd'hui
    // Minuit local du premier jour, au plus tôt (UTC+14) : un fichier modifié avant ne peut rien contenir de la fenêtre.
    const seuil = Date.parse(`${debut}T00:00:00Z`) - 14 * 3600 * 1000
    const comptes = []
    for (const kind of AGENTS) {
      for (const compte of COMPTES) {
        const { e, coupe } = await litCompte(kind, compte, debut, seuil)
        comptes.push(resume(kind, compte, e, jour, debut, coupe))
      }
    }
    return { calculeLe, dureeMs: Date.now() - t0, fuseau, jour, debutSemaine: debut, comptes }
  }

  // Résultat gardé 60 s ; un seul calcul à la fois (les appels simultanés attendent le même).
  let dernier = null
  let enCours = null
  function usage({ force = false } = {}) {
    if (enCours) return enCours
    if (!force && dernier && maintenant() - dernier.calculeLe < 60_000) return Promise.resolve(dernier)
    enCours = calcule()
      .then((r) => (dernier = r))
      .finally(() => {
        enCours = null
      })
    return enCours
  }

  return { env, prepare, journaux, connecte, liste, usage }
}
