// Volet « quota » (17/11/2026) — moteur : usage par console, budgets et paliers, validation des lancements d'équipe.
// Demande d'Orkun (17/11, mot pour mot) : « Go pour tout », sur « Le quota par console et le coût par agent, si tu les
// veux » — deux idées de Paperclip : « quota par console avec une alerte à 80 % » et « coût par agent avec une validation
// avant d'exécuter ». Dessin et contrat : docs/volets/quota.md (§ 2.2).
//
// Ce que ce module ne fait JAMAIS (règle d'Orkun : aucun frein imposé par le code) : arrêter un agent, lui envoyer une
// touche, changer le statut d'une console, toucher à sa file de messages. Au palier : une notification et une demande
// dans T'ATTEND, rien d'autre. L'usage reste HORS de l'objet console (pas dans state.json) : DATA/budget.json (0600) et
// l'événement { type: 'budget' }.
//
// Lecture seule des journaux que les agents écrivent eux-mêmes (aucun appel réseau, aucun fichier d'identité ouvert).
// Ces fichiers sont écrits par des agents, donc :
// - ouverture par descripteur (O_RDONLY | O_NONBLOCK | O_NOFOLLOW), contrôle de CE QUI EST OUVERT par fstat (fichier
//   ordinaire, un seul lien), lecture depuis le descripteur : un lien symbolique, un FIFO, un lien physique sont ignorés,
//   jamais suivis ni attendus (leçon du 13/11, volet ateliers) ;
// - une ligne sans fin est bornée à 16 Mo : au-delà, ses octets sont jetés jusqu'au saut de ligne suivant ;
// - tout texte est tronqué avant toute expression régulière ; nombres négatifs, non finis ou énormes ignorés ;
// - ce qui est examiné est borné (entrées d'un dossier, conversations, fichiers, modèles par fichier).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { usageClaude, parcourt } from './comptes.mjs'
import { MAX_TASK } from './equipage.mjs'
import { nettoie } from './memoire.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/ // une conversation (même forme que lib/fil.mjs)
const CONSOLE = /^c[0-9a-f]{8}$/
const EQUIPE = /^e[0-9a-f]{6}$/
const DEMANDE = /^d[0-9a-f]{8}$/
const CIBLE = /^(?:c:c[0-9a-f]{8}|e:e[0-9a-f]{6})$/
const BASE = /^[A-Za-z0-9._/-]{1,120}$/ // même règle que lancer() (server.mjs)

// Repères cherchés dans les octets bruts avant tout JSON.parse (lib/comptes.mjs, même tri).
const MARQUES = {
  claude: [Buffer.from('"usage":')],
  codex: ['"type":"token_usage_record"', '"type":"token_count"', '"type":"turn_context"'].map((m) => Buffer.from(m)),
}
const OUVERTURE = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
const MORCEAU = 1 << 20 // lecture en flux : la boucle d'événements respire entre deux morceaux
// Ligne lue au plus : 512 Ko. Relecture de sécurité du 17/11 : une ligne de 16 Mo faite de `{},{},…` gelait la boucle
// 1,6 s dans JSON.parse ; au pire mesuré, 512 Ko = 21 ms, 1 Mo = 78 ms. La plus longue ligne d'usage réelle (7 jours,
// 71 689 lignes) fait 235 Ko. Au-delà : ligne jetée jusqu'à son saut de ligne, comptée dans mesures().lignesIgnorees.
const MAX_LIGNE = 512 << 10
const PAR_FICHIER = 64 << 20 // octets lus au plus par fichier et par tour (un fichier creux de 10 To ne fige rien)
const PAR_TOUR = 256 << 20 // octets lus au plus par tour : les paliers sont évalués au moins toutes les quelques secondes
const ANNEAU = 32 // clés message.id:requestId gardées par fichier (écart relevé entre deux lignes d'un même message : 1)
// Relecture de sécurité du 17/11 (budget.json de 63 Mo réécrit en 304 ms aux bornes du module) : l'anneau garde une
// EMPREINTE de chaque clé (sha1, 12 caractères base64url = 72 bits) et non la clé (jusqu'à 241 caractères) ; les noms de
// modèles gardés sont tronqués à 60 ; les sous-agents suivis sont plafonnés par console ET en tout.
const EMPREINTE = 12
const MAX_NOM_MODELE = 60
const MAX_MODELES = 8 // par fichier ; au-delà : « autres »
const MODELES_MONTRES = 24 // par console ; au-delà : « autres »
const MAX_CONVERSATIONS = 500 // par console (les plus anciennes sortent de la recherche, leurs totaux restent)
// Le journal PRINCIPAL d'une conversation est toujours admis (borné par MAX_CONVERSATIONS) ; seuls les sous-agents sont
// plafonnés (relevé du 17/11 sur toute la machine : 652 fichiers de sous-agents, 69 au plus pour une conversation). Un
// refus rend l'usage de la console « partiel » (l'écran dit « au moins »), jamais juste en silence.
const MAX_SOUS_AGENTS = 1000 // par console
const MAX_SOUS_AGENTS_TOUT = 2000 // toutes consoles
// Seconde relecture du 17/11 (t4-C : deux consoles posaient 1 000 fichiers VIDES chacune et prenaient les 2 000 places) :
// seuls les fichiers qui ont porté au moins une ligne d'usage comptent sous ces plafonds et sont gardés dans budget.json.
// Les autres sont des « candidats » : lus, suivis en mémoire seulement, bornés ici (au-delà : refusés, « partiel »).
const MAX_CANDIDATS = 5000 // par console
const MAX_CANDIDATS_TOUT = 20_000 // toutes consoles
// Planchers par console, que les autres consoles ne peuvent pas prendre (le plafond commun ne joue qu'au-delà) : 4 consoles
// × 5 000 fichiers vides ne refusent pas les vrais sous-agents d'une 5e (au plus 69 par conversation, relevé du 17/11).
const PLANCHER_CANDIDATS = 200
const PLANCHER_SOUS_AGENTS = 100
// Recherche d'un journal Claude introuvable par le dossier déduit : au plus tant de lstat par TOUR, toutes consoles (t4-B :
// 100 conversations introuvables × 5 000 dossiers de projets = un tour de 19 s). La suite au tour suivant.
const MAX_EXAMENS_CLAUDE = 10_000
// Console fermée relue en entier, membre clos : ses fichiers ne gardent qu'un sceau (inode, position) sous une empreinte du
// chemin (t9 : 40 consoles × 500 conversations = budget.json de 51 Mo). Au plus tant de sceaux par console.
const MAX_SCEAUX = 5000
const MAX_WORKFLOWS = 100 // dossiers `subagents/workflows/<wf>/` lus par conversation (au-delà : « partiel »)
// Entrées listées par TOUR dans les dossiers de sous-agents, toutes consoles (relecture n° 3, t14-B : 100 workflows ×
// 5 000 fichiers relus à chaque tour = 1,5-1,8 s par tour et par console). La suite au tour suivant.
const MAX_ENTREES_SOUS = 20_000 // (relevé du 17/11 : au plus 69 sous-agents par conversation réelle)
const MAX_ENTREES = 5000 // entrées examinées dans un dossier (projets, sous-agents, un dossier de jour de Codex)
const MAX_ENTREES_CODEX = 50_000 // entrées examinées par TOUR dans l'arbre des sessions Codex, toutes recherches confondues
const MAX_NOMS_CODEX = 50_000 // noms de journaux Codex gardés d'un tour à l'autre (listes des dossiers de jour)
const JOUR_MS = 86_400_000
const MAX_DEMANDES = 6 // demandes de lancement en attente par équipe
const ECRITURE_MS = 10_000 // au plus une écriture toutes les 10 s pour l'usage
const RECHERCHE_MS = 60_000 // un journal introuvable n'est recherché de nouveau qu'une minute après
const MAX = { usd: 1e6, jetons: 1e12 }
const MAX_CUMUL = 1e13 // compteurs cumulés de Codex
const TEXTE_BUDGET = 'Budget atteint — continuer ?'

const nb = (x, max) => (Number.isFinite(x) && x > 0 && x <= max ? x : 0)
const arrondi = (x) => Math.round(x * 1e6) / 1e6
const fini = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0
const entier = (x) => Number.isSafeInteger(x) && x >= 0
// Texte venu d'un agent, montré à Orkun : tronqué AVANT les expressions régulières, puis nettoyé par catégories Unicode
// (lib/memoire.mjs : contrôles, format, usage privé, non attribués, demi-codets, sélecteurs de variante, remplissages).
const propre = (s, n) => nettoie(String(s ?? '').slice(0, n * 4)).slice(0, n).toWellFormed()
const nomCourt = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 48) : '') // cleanName du serveur
const nouvelId = () => 'd' + crypto.randomBytes(4).toString('hex')
const CHAMPS = ['entree', 'sortie', 'cacheLu', 'cacheEcrit', 'total', 'messages']

// ── Totaux d'un fichier ──
const accu = () => ({ entree: 0, sortie: 0, cacheLu: 0, cacheEcrit: 0, total: 0, messages: 0, cout: 0, partiel: false, modeles: new Map() })
// `p` = une part ({ modele, entree, sortie, cacheLu, cacheEcrit, total, cout, conseiller }) ; `message` faux pour une part
// du conseiller (ses jetons comptent, pas un message de plus) ; `codex` : aucun prix.
function ajoute(a, p, message, codex) {
  for (const k of ['entree', 'sortie', 'cacheLu', 'cacheEcrit', 'total']) a[k] += p[k]
  if (message) a.messages++
  if (!codex) {
    if (p.cout === null) a.partiel ||= p.total > 0 // un `<synthetic>` à 0 jeton ne rend pas le coût partiel
    else a.cout += p.cout
  }
  if (p.total <= 0) return
  const sorte = p.conseiller ? 'c' : 'm'
  let cle = `${sorte}:${String(p.modele).slice(0, MAX_NOM_MODELE)}`
  if (!a.modeles.has(cle) && a.modeles.size >= MAX_MODELES) cle = `${sorte}:autres`
  let g = a.modeles.get(cle)
  if (!g) a.modeles.set(cle, (g = { total: 0, cout: 0, sansPrix: false }))
  g.total += p.total
  if (codex) return
  if (p.cout === null) g.sansPrix = true
  else g.cout += p.cout
}
// Verse les totaux d'un fichier (`src`) dans l'acquis d'une console (`dest`), au plus MODELES_MONTRES noms + « autres » des
// deux sortes (la forme que relit accuLu(x, MODELES_MONTRES) : une console scellée garde le détail de ses modèles).
function verse(dest, src) {
  for (const k of [...CHAMPS, 'cout']) dest[k] += src[k]
  dest.partiel ||= src.partiel
  for (const [k, g] of src.modeles) {
    const cle = dest.modeles.has(k) || dest.modeles.size < MODELES_MONTRES ? k : `${k[0]}:autres`
    const m = dest.modeles.get(cle) ?? { total: 0, cout: 0, sansPrix: false }
    m.total += g.total
    m.cout += g.cout
    m.sansPrix ||= g.sansPrix
    dest.modeles.set(cle, m)
  }
}
const fichierNeuf = (kind, ino) =>
  kind === 'codex'
    ? { kind, ino, lu: 0, jette: false, cles: [], rec: accu(), rep: accu(), aRecord: false, modele: '', cumul: null }
    : { kind, ino, lu: 0, jette: false, cles: [], a: accu() }
// Les totaux qui comptent pour un fichier (Codex : les records s'il en a, sinon le repli) ; « porteur d'usage » : au moins
// un message ou un jeton compté.
const effectif = (f) => (f.kind === 'codex' ? (f.aRecord ? f.rec : f.rep) : f.a)
const aDeLUsage = (f) => effectif(f).total > 0 || effectif(f).messages > 0
// Un fichier repris de son sceau : position, et pour Codex ce qui sert aux lignes suivantes (record vu, modèle, compteur).
const reprend = (kind, x) => (kind === 'codex' ? { ...fichierNeuf(kind, x[0]), lu: x[1], aRecord: x[2], modele: x[3], cumul: x[4] } : { ...fichierNeuf(kind, x[0]), lu: x[1] })
const sceauDe = (f) => (f.kind === 'codex' ? [f.ino, f.lu, f.aRecord, f.modele, f.cumul] : [f.ino, f.lu])
const empreinte = (cle) => crypto.createHash('sha1').update(cle).digest('base64url').slice(0, EMPREINTE)
const vu = (f, cle) => {
  const e = empreinte(cle)
  if (f.cles.includes(e)) return true
  f.cles.push(e)
  if (f.cles.length > ANNEAU) f.cles.shift()
  return false
}

// Claude : une ligne par BLOC de contenu, le même message revient avec le même `usage` → clé message.id + requestId.
function ligneClaude(f, t) {
  if (!t.includes('"type":"assistant"')) return
  let j
  try {
    j = JSON.parse(t)
  } catch {
    return
  }
  const m = j?.message
  if (j?.type !== 'assistant' || !m || typeof m !== 'object' || !m.usage || typeof m.usage !== 'object') return
  if (typeof m.id === 'string' && m.id && vu(f, `${m.id.slice(0, 120)}:${String(j.requestId ?? '').slice(0, 120)}`)) return
  usageClaude(m).parts.forEach((p, i) => ajoute(f.a, p, i === 0, false))
}

// Codex : `token_usage_record` une fois par réponse (clé response_id) ; la somme de leurs `usage` égale le dernier
// `thread_token_usage` du fichier (relevé le 17/11 : 120 conversations sur 120, aucun doublon, aucun compteur qui recule).
// Repli pour un fichier sans record : les écarts de `token_count.info.total_token_usage` (un compteur qui repart de zéro
// est une nouvelle base). Deux totaux tenus à part ; le repli ne sert que tant qu'aucun record n'a été vu. Une relance ne
// recompte rien : position, anneau des clés et totaux sont écrits ensemble dans budget.json.
const partCodex = (modele, u) => {
  const cache = nb(u.cached_input_tokens, MAX_CUMUL)
  const entree = Math.max(0, nb(u.input_tokens, MAX_CUMUL) - cache)
  const sortie = nb(u.output_tokens, MAX_CUMUL)
  const total = Number.isFinite(u.total_tokens) ? nb(u.total_tokens, MAX_CUMUL) : entree + cache + sortie
  return { modele: modele || 'inconnu', entree, sortie, cacheLu: cache, cacheEcrit: 0, total, cout: null, conseiller: false }
}
const CUMUL = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens']
function ligneCodex(f, t) {
  let j
  try {
    j = JSON.parse(t)
  } catch {
    return
  }
  const p = j?.payload
  if (!p || typeof p !== 'object') return
  if (j.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) f.modele = p.model.slice(0, MAX_NOM_MODELE)
    return
  }
  if (j.type === 'token_usage_record') {
    f.aRecord = true
    if (typeof p.response_id === 'string' && p.response_id && vu(f, `r:${p.response_id.slice(0, 120)}`)) return
    if (p.usage && typeof p.usage === 'object') ajoute(f.rec, partCodex(f.modele, p.usage), true, true)
    return
  }
  if (j.type !== 'event_msg' || p.type !== 'token_count') return
  const tt = p.info?.total_token_usage
  if (!tt || typeof tt !== 'object') return
  const cur = Object.fromEntries(CUMUL.map((k) => [k, nb(tt[k], MAX_CUMUL)]))
  const avant = f.cumul && cur.total_tokens >= f.cumul.total_tokens ? f.cumul : null // reparti de zéro : nouvelle base
  f.cumul = cur
  const d = Object.fromEntries(CUMUL.map((k) => [k, Math.max(0, cur[k] - (avant?.[k] ?? 0))]))
  if (d.total_tokens > 0) ajoute(f.rep, partCodex(f.modele, d), true, true)
}

// Lit la suite d'un fichier ouvert (`fh`), de f.lu jusqu'à `fin`. f.lu n'avance que sur des lignes finies (ou des octets
// jetés) : une ligne pas finie attend le tour suivant. Rend le nombre d'octets lus.
async function litSuite(fh, f, fin, mesures) {
  const marques = MARQUES[f.kind]
  const lit = f.kind === 'claude' ? (t) => ligneClaude(f, t) : (t) => ligneCodex(f, t)
  // Ligne trop longue jetée : si c'est un message de l'assistant (« "role":"assistant" » est dans ses 319 premiers octets
  // sur 74 408 lignes réelles, jamais dans une autre ligne d'usage), son usage manque : le coût de ce fichier devient
  // « partiel » (dit à l'écran), jamais silencieusement juste. `debut` : les premiers octets de la ligne.
  const perdue = (debut) => {
    mesures.lignesIgnorees++
    if (f.kind !== 'claude' || !debut.includes('"role":"assistant"')) return
    f.a.partiel = true
    mesures.lignesUsagePerdues++
  }
  const debutDe = (morceaux) => {
    const l = []
    let n = 0
    for (const x of morceaux) {
      l.push(x)
      if ((n += x.length) >= 4096) break
    }
    return Buffer.concat(l).subarray(0, 4096)
  }
  // Une ligne prise au milieu d'un morceau peut dépasser la borne (morceau de 1 Mo) : même règle que pour les autres.
  const ligne = (t) => {
    if (t.length > MAX_LIGNE / 4 && Buffer.byteLength(t) > MAX_LIGNE) perdue(t.slice(0, 4096))
    else lit(t)
  }
  const buf = Buffer.allocUnsafe(MORCEAU)
  let pos = f.lu
  let reste = [] // morceaux (copiés) de la ligne commencée
  let resteTaille = 0
  let lus = 0
  while (pos < fin) {
    const { bytesRead: n } = await fh.read(buf, 0, Math.min(MORCEAU, fin - pos), pos)
    if (!n) break // raccourci pendant la lecture : le tour suivant le relira depuis 0
    lus += n
    const m = buf.subarray(0, n)
    let a = 0
    if (f.jette) {
      // Suite d'une ligne de plus de 16 Mo : jetée jusqu'à son saut de ligne.
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
        perdue(debutDe([...reste, m.subarray(a)]))
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
    } else perdue(debutDe([...reste, m.subarray(a, premier)]))
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
  return lus
}

// ── Relecture de budget.json : chaque entrée contrôlée, une entrée mal formée est ignorée (jamais un plantage) ──
const objet = (o) => o && typeof o === 'object' && !Array.isArray(o)
const entrees = (o) => (objet(o) ? Object.entries(o) : [])
function accuLu(x, max = MAX_MODELES) {
  if (!objet(x) || !Array.isArray(x.modeles) || x.modeles.length > max + 2) return null
  const a = accu()
  for (const k of [...CHAMPS, 'cout']) {
    if (!fini(x[k])) return null
    a[k] = x[k]
  }
  a.partiel = x.partiel === true
  for (const e of x.modeles) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 2 + MAX_NOM_MODELE || !(e[0].startsWith('m:') || e[0].startsWith('c:'))) return null
    if (!objet(e[1]) || !fini(e[1].total) || !fini(e[1].cout)) return null
    a.modeles.set(e[0], { total: e[1].total, cout: e[1].cout, sansPrix: e[1].sansPrix === true })
  }
  return a
}
const accuEcrit = (a) => ({ ...a, modeles: [...a.modeles] })
function fichierLu(x) {
  if (!objet(x) || (x.kind !== 'claude' && x.kind !== 'codex') || !fini(x.ino) || !entier(x.lu) || typeof x.jette !== 'boolean') return null
  if (!Array.isArray(x.cles) || x.cles.length > ANNEAU || !x.cles.every((k) => typeof k === 'string' && k.length === EMPREINTE)) return null
  const f = { kind: x.kind, ino: x.ino, lu: x.lu, jette: x.jette, cles: [...x.cles] }
  if (x.kind === 'claude') return (f.a = accuLu(x.a)) ? f : null
  f.rec = accuLu(x.rec)
  f.rep = accuLu(x.rep)
  if (!f.rec || !f.rep || typeof x.aRecord !== 'boolean' || typeof x.modele !== 'string' || x.modele.length > MAX_NOM_MODELE) return null
  f.aRecord = x.aRecord
  f.modele = x.modele
  if (x.cumul === null) f.cumul = null
  else if (objet(x.cumul) && CUMUL.every((k) => fini(x.cumul[k]))) f.cumul = Object.fromEntries(CUMUL.map((k) => [k, x.cumul[k]]))
  else return null
  return f
}
const fichierEcrit = (f) => (f.kind === 'claude' ? { ...f, a: accuEcrit(f.a) } : { ...f, rec: accuEcrit(f.rec), rep: accuEcrit(f.rep) })

// Contrôle de forme d'une demande de lancement (mêmes bornes que lancer() ; le rôle est vérifié à la demande seulement).
// Ce qu'Orkun valide doit être exactement ce qui part (relecture de sécurité du 17/11, comme la mémoire le 11/11) : une
// tâche ou un dossier qui porte un caractère invisible (contrôle hors saut de ligne et tabulation, format, étiquette,
// usage privé, non attribué, sélecteur de variante, remplissage) est REFUSÉ, jamais nettoyé en silence ; le texte entier
// se lit par GET /api/budget/demandes/<id>. Longueur contrôlée avant l'expression régulière.
const INVISIBLE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u
// Une consigne poussée loin derrière des blancs est hors de ce qu'Orkun lit (relecture du 17/11 : 250 caractères, 19 000
// sauts de ligne, puis la consigne, passait) : REFUSÉE comme les invisibles, jamais nettoyée en silence. Blancs :
// tabulation, espaces Unicode (Zs : insécable, cadratin, idéographique…) et le blanc braille ; sauts de ligne : \n,
// U+2028, U+2029 (les autres contrôles sont déjà refusés). Plus de 3 lignes vides d'affilée = 5 sauts de ligne qui ne
// sont séparés que par des blancs ; plus de 16 blancs d'affilée.
const LIGNES_VIDES = /(?:[\n\u2028\u2029][\t\p{Zs}\u2800]*){5}/u
const BLANCS = /[\t\p{Zs}\u2800]{17}/u
const LOIN = 'de quoi pousser une consigne loin de ce qu’Orkun lit ; resserre-la en texte simple'
function corpsLancement(x, refus) {
  if (!objet(x)) throw refus('demande invalide')
  const role = typeof x.role === 'string' ? x.role : ''
  if (!role || role.length > 40) throw refus(`rôle inconnu : ${propre(role, 40)} (voir « meydan roles »)`)
  const nom = nomCourt(x.nom)
  if (!nom) throw refus('nom manquant')
  if (INVISIBLE.test(nom)) throw refus('nom refusé : caractères invisibles')
  const tache = String(x.tache ?? '').replace(/\r/g, '').trim()
  if (!tache) throw refus('tâche vide')
  if (tache.length > MAX_TASK) throw refus(`tâche trop longue (${MAX_TASK} caractères au plus)`)
  if (INVISIBLE.test(tache)) throw refus('tâche refusée : elle contient des caractères invisibles ; écris-la en texte simple (Orkun doit pouvoir lire tout ce qui sera lancé)')
  if (LIGNES_VIDES.test(tache)) throw refus(`tâche refusée : plus de 3 lignes vides d’affilée (${LOIN})`)
  if (BLANCS.test(tache)) throw refus(`tâche refusée : plus de 16 espaces ou tabulations d’affilée (${LOIN})`)
  const corps = { role, nom, tache }
  if (x.base !== undefined && x.base !== '') {
    if (typeof x.base !== 'string' || !BASE.test(x.base) || x.base.startsWith('-')) throw refus('base refusée')
    corps.base = x.base
  }
  if (x.dossier !== undefined && x.dossier !== '') {
    // Montré EXACT à Orkun (vueLancement) : ni invisible, ni saut ou séparateur de ligne, ni longue suite de blancs.
    if (typeof x.dossier !== 'string' || x.dossier.length > 200 || INVISIBLE.test(x.dossier) || /[\n\t\u2028\u2029]/.test(x.dossier) || BLANCS.test(x.dossier)) throw refus('dossier refusé (200 caractères visibles au plus)')
    corps.dossier = x.dossier
  }
  return corps
}
// Ce que l'écran montre d'une demande de lancement : résumé de la tâche (≤ 300) ; jamais exécuté. `longueur` : celle de la
// tâche entière (le résumé n'en montre que 300 caractères ; le reste par GET …/demandes/<id>). `dossier` et `base` sont
// EXACTS (relecture du 17/11 : nettoyé, « mon  dossier » s'affichait « mon dossier », un autre dossier que celui qui part) :
// corpsLancement a déjà refusé tout invisible, saut de ligne ou tabulation (dossier) et tout ce qui sort de BASE (base).
// `complet` (seconde relecture du 17/11, t1) : vrai seulement si le résumé EST la tâche, comparés tels quels. Le nettoyage
// normalise en NFC, qui ALLONGE certaines lettres (U+1D15E, devanagari à nukta U+0958-095F) : une tâche de 300 unités peut
// donner un résumé de 300 unités qui n'en est pas la fin ; « longueur === résumé » ne le voyait pas. Absent = incomplet.
const vueLancement = (corps) => {
  const resume = propre(corps.tache, 300)
  return { role: propre(corps.role, 40), equipier: propre(corps.nom, 48), dossier: corps.dossier ?? '', base: corps.base ?? '', resume, longueur: corps.tache.length, complet: resume === corps.tache }
}
// Le dossier d'un équipier SANS git, résolu exactement comme lancer() le fera (server.mjs : realpath de la racine du projet,
// path.resolve, realpath, dedans, dossier) : son chemin réel et son dev:ino. Relecture du 17/11 (r7) : résolu à l'accord
// seulement, un lien substitué entre la demande et le clic faisait partir l'équipier à la racine du projet, pas dans le
// sous-dossier qu'Orkun avait lu. Synchrone comme lancer() (demandeLancement rend sa réponse directement au serveur).
function resoutDossier(t, dossier, refus) {
  let racine
  try {
    racine = fs.realpathSync(String(t.projet))
  } catch {
    throw refus('projet de l’équipe introuvable', 409)
  }
  let d
  try {
    d = fs.realpathSync(path.resolve(racine, dossier))
  } catch {
    throw refus(`dossier introuvable : ${dossier}`)
  }
  if (d !== racine && !d.startsWith(racine + path.sep)) throw refus(`dossier hors du projet de l’équipe (${t.projet})`)
  const st = fs.statSync(d, { bigint: true })
  if (!st.isDirectory()) throw refus(`pas un dossier : ${d}`)
  return { reel: d, ident: `${st.dev}:${st.ino}` }
}

const fmt = (v, unite) =>
  unite === 'usd'
    ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v)} $ éq. API`
    : `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v)} jetons`

export function ouvreBudget({ data, consoles, equipes, journaux, alerte, broadcast, lancer, previent, send, readJson, refus, roles = null, maintenant = Date.now, intervalle = 5000, demarre = true }) {
  const FICHIER = path.join(data, 'budget.json')
  const fichiers = new Map() // chemin → état de lecture et totaux de CE fichier (une console = la somme de ses fichiers)
  // console → { kind, compte, equipe, nom, cwd, agents, chemins, fichiers (porteurs d'usage et journaux principaux : comptés,
  // gardés sur disque), candidats (sous-agents encore sans usage : en mémoire seulement), nSous (sous-agents comptés),
  // acquis (totaux des journaux raccourcis, remplacés ou scellés), sceaux (empreinte du chemin → inode, position…),
  // scellees (conversations scellées), partiel (une part de l'usage manque ou a pu être comptée deux fois : « au moins ») }
  const suivis = new Map()
  const budgets = new Map() // cible → { montant, unite, nom, alerte80, demande100, repondu }
  const reglages = new Map() // équipe → { valider: true }
  let demandes = [] // les demandes de lancement gardent leur corps complet ici (jamais diffusé)
  const attente = new Map() // conversation introuvable → heure avant laquelle on ne la recherche pas
  const mesures = { octetsLus: 0, ouverts: 0, dureeMs: 0, tours: 0, lignesIgnorees: 0, lignesUsagePerdues: 0, refuses: 0, examensClaude: 0, entreesSous: 0 }
  let calculeLe = 0
  let usages = new Map() // console → Usage (dernier calcul)
  let parEquipe = new Map() // équipe → UsageEquipe
  const envoye = { usages: new Map(), equipes: new Map(), reste: '' } // ce que le flux a déjà reçu
  let sale = false
  let derniereEcriture = 0

  const racineDe = (s) => {
    const j = journaux(s.kind, s.compte)
    return path.resolve(s.kind === 'claude' ? j.projets : j.sessions)
  }
  // Un chemin sous la racine des journaux, sans « .. » (relu de budget.json : jamais un chemin arbitraire).
  const sous = (racine, p) => typeof p === 'string' && p.length <= 4096 && path.isAbsolute(p) && path.normalize(p) === p && p.startsWith(racine + path.sep)
  // Un fichier de sous-agent : `<projets>/<dossier>/<conversation>/subagents/<x>.jsonl` ou, pour un workflow,
  // `…/subagents/workflows/<wf>/<x>.jsonl` (un dossier de projet de Claude commence par « - », un dossier de jour de Codex
  // est un nombre : jamais « subagents »).
  const estSous = (p) => {
    const d = path.dirname(p)
    return path.basename(d) === 'subagents' || (path.basename(path.dirname(d)) === 'workflows' && path.basename(path.dirname(path.dirname(d))) === 'subagents')
  }
  const totalSous = () => {
    let n = 0
    for (const s of suivis.values()) n += s.nSous
    return n
  }
  const totalCandidats = () => {
    let n = 0
    for (const s of suivis.values()) n += s.candidats.size
    return n
  }
  const refuse = (s) => {
    if (s.partiel) return
    s.partiel = true
    sale = true
  }
  const nouvelleConsole = (c) => ({ kind: c.kind, compte: c.compte, equipe: c.equipe, nom: c.nom, cwd: '', agents: [], chemins: new Map(), fichiers: new Set(), candidats: new Set(), maj: maintenant(), nSous: 0, acquis: null, sceaux: new Map(), scellees: new Set(), partiel: false })
  // Seuls les fichiers dont l'usage est déjà dans l'acquis ont un sceau (scelle) : en faire sortir un, c'est risquer de
  // le relire depuis 0 et de le compter deux fois. Au-delà de MAX_SCEAUX, le plus ancien sort quand même, et c'est dit.
  const ajouteSceau = (s, h, v) => {
    s.sceaux.delete(h)
    s.sceaux.set(h, v)
    if (s.sceaux.size <= MAX_SCEAUX) return
    s.sceaux.delete(s.sceaux.keys().next().value)
    refuse(s)
  }

  // ── Relecture au démarrage ──
  function charge() {
    let b
    try {
      b = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
    } catch {
      return // absent ou illisible : on repart de zéro
    }
    if (!objet(b)) return
    for (const [chemin, x] of entrees(b.fichiers)) {
      const f = path.isAbsolute(chemin) && chemin.length <= 4096 ? fichierLu(x) : null
      if (f) fichiers.set(chemin, f)
    }
    for (const [id, x] of entrees(b.consoles)) {
      if (!CONSOLE.test(id) || !objet(x) || (x.kind !== 'claude' && x.kind !== 'codex') || (x.compte !== '1' && x.compte !== '2')) continue
      if (x.equipe !== null && !(typeof x.equipe === 'string' && EQUIPE.test(x.equipe))) continue
      if (!Array.isArray(x.agents) || !Array.isArray(x.fichiers) || !objet(x.chemins) || !fini(x.maj)) continue
      const s = { ...nouvelleConsole({ kind: x.kind, compte: x.compte, equipe: x.equipe, nom: typeof x.nom === 'string' ? x.nom.slice(0, 100) : '' }), maj: x.maj, partiel: x.partiel === true }
      if (x.acquis != null) s.acquis = accuLu(x.acquis, MODELES_MONTRES) ?? ((s.partiel = true), null) // acquis illisible : perdu, et dit
      const racine = racineDe(s)
      s.agents = x.agents.filter((a) => typeof a === 'string' && ID.test(a)).slice(-MAX_CONVERSATIONS)
      for (const [a, p] of Object.entries(x.chemins)) if (ID.test(a) && sous(racine, p)) s.chemins.set(a, p)
      // Sceaux : [inode, position] (Claude) ou [inode, position, record vu, modèle, compteur] (Codex), contrôlés un à un.
      for (const [h, v] of entrees(x.sceaux).slice(-MAX_SCEAUX)) {
        if (h.length !== EMPREINTE || !Array.isArray(v) || !fini(v[0]) || !entier(v[1])) continue
        if (s.kind === 'claude' && v.length === 2) s.sceaux.set(h, [v[0], v[1]])
        else if (s.kind === 'codex' && v.length === 5 && typeof v[2] === 'boolean' && typeof v[3] === 'string' && v[3].length <= MAX_NOM_MODELE && (v[4] === null || (objet(v[4]) && CUMUL.every((k) => fini(v[4][k])))))
          s.sceaux.set(h, [v[0], v[1], v[2], v[3], v[4] && Object.fromEntries(CUMUL.map((k) => [k, v[4][k]]))])
      }
      if (Array.isArray(x.scellees)) for (const a of x.scellees) if (typeof a === 'string' && s.agents.includes(a)) s.scellees.add(a)
      // Journaux principaux toujours repris ; sous-agents sous leurs plafonds (par console et en tout), comme à l'ajout.
      const principaux = new Set(s.chemins.values())
      for (const p of x.fichiers.slice(0, 4 * (MAX_CONVERSATIONS + MAX_SOUS_AGENTS))) {
        if (!sous(racine, p) || s.fichiers.has(p)) continue
        const sa = !principaux.has(p) && estSous(p)
        if (sa && (s.nSous >= MAX_SOUS_AGENTS || totalSous() >= MAX_SOUS_AGENTS_TOUT)) {
          s.partiel = true
          continue
        }
        s.fichiers.add(p)
        if (sa) s.nSous++
      }
      suivis.set(id, s)
    }
    for (const [cible, x] of entrees(b.budgets)) {
      if (!CIBLE.test(cible) || !objet(x) || (x.unite !== 'usd' && x.unite !== 'jetons')) continue
      if (!fini(x.montant) || x.montant <= 0 || x.montant > MAX[x.unite] || typeof x.alerte80 !== 'boolean' || typeof x.demande100 !== 'boolean') continue
      if (x.repondu !== null && !fini(x.repondu)) continue
      budgets.set(cible, { montant: x.montant, unite: x.unite, nom: typeof x.nom === 'string' ? x.nom.slice(0, 100) : '', alerte80: x.alerte80, demande100: x.demande100, repondu: x.repondu })
    }
    for (const [id, x] of entrees(b.reglages)) if (EQUIPE.test(id) && x?.valider === true) reglages.set(id, { valider: true })
    for (const x of Array.isArray(b.demandes) ? b.demandes.slice(0, 500) : []) {
      if (!objet(x) || typeof x.id !== 'string' || !DEMANDE.test(x.id) || !fini(x.at)) continue
      if (x.type === 'budget' && typeof x.cible === 'string' && CIBLE.test(x.cible)) {
        demandes.push({ id: x.id, type: 'budget', cible: x.cible, nom: propre(x.nom, 100), at: x.at, texte: TEXTE_BUDGET, detail: propre(x.detail, 200) })
      } else if (x.type === 'lancement' && typeof x.equipe === 'string' && EQUIPE.test(x.equipe) && typeof x.chef === 'string' && CONSOLE.test(x.chef)) {
        let corps
        try {
          corps = corpsLancement(x.corps, refus)
        } catch {
          continue
        }
        // Chemin réel et dev:ino relus TELS QUELS (jamais re-résolus ici : c'est ce qu'Orkun a vu) ; mal formés : vides, et
        // l'accord d'un dossier sans eux est refusé (repond).
        const dossierReel = typeof x.dossierReel === 'string' && sous('', x.dossierReel) ? x.dossierReel : ''
        const ident = typeof x.ident === 'string' && /^\d{1,30}:\d{1,30}$/.test(x.ident) ? x.ident : ''
        demandes.push({ id: x.id, type: 'lancement', equipe: x.equipe, nom: propre(x.nom, 100), chef: x.chef, at: x.at, ...vueLancement(corps), dossierReel, corps, ident })
      }
    }
  }

  // ── Écriture : 0600, fichier temporaire puis renommage ──
  function ecris() {
    const tmp = `${FICHIER}.tmp`
    // Seuls les fichiers comptés (journaux principaux, sous-agents porteurs d'usage) gardent leur état sur disque ; les
    // candidats vivent en mémoire (relus depuis 0 après une relance : ils n'avaient rien compté).
    const comptes = new Set()
    for (const s of suivis.values()) for (const p of s.fichiers) comptes.add(p)
    const obj = {
      v: 1,
      fichiers: Object.fromEntries([...fichiers].filter(([k]) => comptes.has(k)).map(([k, f]) => [k, fichierEcrit(f)])),
      consoles: Object.fromEntries([...suivis].map(([id, s]) => [id, { kind: s.kind, compte: s.compte, equipe: s.equipe, nom: s.nom, agents: s.agents, chemins: Object.fromEntries(s.chemins), fichiers: [...s.fichiers], maj: s.maj, partiel: s.partiel, acquis: s.acquis ? accuEcrit(s.acquis) : null, sceaux: Object.fromEntries(s.sceaux), scellees: [...s.scellees] }])),
      budgets: Object.fromEntries(budgets),
      reglages: Object.fromEntries(reglages),
      demandes,
    }
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, FICHIER)
    sale = false
    derniereEcriture = maintenant()
  }
  // `tout` : un budget, un réglage, une demande, un repère de palier → écrit tout de suite. L'usage : au plus toutes les 10 s.
  function garde(tout = false) {
    sale = true
    if (!tout && maintenant() - derniereEcriture < ECRITURE_MS) return
    try {
      ecris()
    } catch (e) {
      console.error(`[budget] écriture de budget.json impossible : ${e.message}`)
    }
  }

  // ── Recherche des journaux d'une conversation ──
  // Claude : `<projets>/<dossier>/<conversation>.jsonl` (comme fil.journalClaude) + `<…>/<conversation>/subagents/*.jsonl`.
  // Codex : `<sessions>/AAAA/MM/JJ/rollout-…-<conversation>.jsonl` (comme fil.journalCodex). Chemin mis en cache ; une
  // recherche manquée attend une minute ; les listes de dossiers sont bornées et faites au plus une fois par tour.
  // JAMAIS d'opendir récursif : Node 22 y lit chaque sous-dossier en SYNCHRONE (relecture du 17/11 : 4,8 s de gel avec
  // 200 000 entrées dans un sous-dossier, refait chaque minute tant que le journal était introuvable).
  // `garde(e)` trie pendant le parcours : seules les entrées retenues sont gardées (borne sur ce qui est EXAMINÉ) ;
  // `coupe` : la borne a arrêté la liste (une entrée utile peut être au-delà) ; `n` : entrées examinées.
  async function liste(dossier, max, garde) {
    const r = { entrees: [], coupe: false, n: 0 }
    let d
    try {
      d = await fs.promises.opendir(dossier)
    } catch {
      return r
    }
    try {
      for await (const e of d) {
        if (r.n >= max) {
          r.coupe = true
          break
        }
        r.n++
        if (garde(e)) r.entrees.push(e)
      }
    } catch {} // dossier disparu en cours de route
    finally {
      await d.close().catch(() => {}) // déjà fermé par la fin de l'itération
    }
    return r
  }
  const respire = () => new Promise((r) => setImmediate(r)) // la boucle d'événements passe entre deux dossiers

  // Codex. L'identifiant de conversation est un UUIDv7 : ses 48 premiers bits sont l'heure de création en millisecondes
  // (relevé du 17/11 : 153 journaux sur 153 rangés au jour de leur identifiant, nom horodaté à moins d'une seconde près).
  // 1. Le nom exact déduit (heure locale et UTC, de -2 s à +1 s) : un lstat chacun, trouvé même dans un dossier inondé.
  // 2. Les dossiers du jour déduit, puis la veille et le lendemain (heure locale et UTC) : liste non récursive, bornée.
  // 3. Sinon année → mois → jour, du plus récent au plus ancien, sans jamais suivre un lien ; une borne d'entrées examinées
  //    par TOUR, partagée par toutes les recherches (`ctx.codex.restant`), et la boucle respire entre deux dossiers.
  // La liste (noms `rollout-*.jsonl` seulement) d'un dossier de jour lu en entier est gardée d'un tour à l'autre tant que
  // le dossier n'a pas changé (inode et date de modification à la nanoseconde) : une recherche répétée chaque minute ne
  // relit que les dossiers qui ont bougé.
  const joursCodex = new Map() // dossier de jour → { cle, noms }
  let nomsCodex = 0
  const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const instantDe = (id) => {
    if (!UUID7.test(id)) return null
    const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    return ms > Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null // date invraisemblable : parcours seulement
  }
  const deux = (n) => String(n).padStart(2, '0')
  const heureDe = (ms, utc) => {
    const d = new Date(ms)
    return utc ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()] : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
  }
  const jourRel = ([a, m, j]) => path.join(String(a), deux(m), deux(j))
  const nomRollout = ([a, m, j, h, mi, s], id) => `rollout-${a}-${deux(m)}-${deux(j)}T${deux(h)}-${deux(mi)}-${deux(s)}-${id}.jsonl`
  function nomsDuJour(dossier, ctx) {
    if (!ctx.jours.has(dossier)) {
      ctx.jours.set(
        dossier,
        (async () => {
          const st = await fs.promises.lstat(dossier, { bigint: true }).catch(() => null)
          if (!st?.isDirectory()) return [] // absent, ou un lien : jamais suivi
          const cle = `${st.ino}:${st.mtimeNs}` // pris AVANT la liste : un ajout pendant la liste change la clé
          const garde = joursCodex.get(dossier)
          if (garde?.cle === cle) return garde.noms
          if (ctx.codex.restant <= 0) return []
          const r = await liste(dossier, Math.min(MAX_ENTREES, ctx.codex.restant), (e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
          ctx.codex.restant -= r.n
          const noms = r.entrees.map((e) => e.name)
          // Gardée seulement si le dossier n'a pas bougé depuis 2 s : les dates des fichiers suivent une horloge grossière,
          // un ajout juste après la liste pourrait laisser la même date (et la liste gardée l'ignorerait).
          if (!r.coupe && Date.now() - Number(st.mtimeMs) > 2000) {
            nomsCodex += noms.length - (garde?.noms.length ?? 0)
            if (nomsCodex > MAX_NOMS_CODEX) {
              joursCodex.clear()
              nomsCodex = noms.length
            }
            joursCodex.set(dossier, { cle, noms })
          }
          return noms
        })(),
      )
    }
    return ctx.jours.get(dossier)
  }
  function sousDossiers(dossier, motif, ctx) {
    if (!ctx.dossiers.has(dossier)) {
      ctx.dossiers.set(
        dossier,
        (async () => {
          if (ctx.codex.restant <= 0) return []
          const r = await liste(dossier, Math.min(MAX_ENTREES, ctx.codex.restant), (e) => e.isDirectory() && motif.test(e.name))
          ctx.codex.restant -= r.n
          return r.entrees.map((e) => e.name).sort().reverse()
        })(),
      )
    }
    return ctx.dossiers.get(dossier)
  }
  async function chercheCodex(racine, agent, ctx) {
    const dansJour = async (rel) => {
      const n = (await nomsDuJour(path.join(racine, rel), ctx)).find((x) => x.endsWith(`-${agent}.jsonl`))
      return n ? path.join(racine, rel, n) : null
    }
    const ms = instantDe(agent)
    if (ms !== null) {
      const exacts = new Set()
      const jours = new Set()
      for (const dt of [0, -1000, -2000, 1000]) {
        for (const utc of [false, true]) {
          const h = heureDe(ms + dt, utc)
          exacts.add(path.join(racine, jourRel(h), nomRollout(h, agent)))
        }
      }
      for (const dt of [0, -JOUR_MS, JOUR_MS]) for (const utc of [false, true]) jours.add(jourRel(heureDe(ms + dt, utc)))
      for (const p of exacts) if ((await fs.promises.lstat(p).catch(() => null))?.isFile()) return p
      for (const rel of jours) {
        const p = await dansJour(rel)
        if (p) return p
        await respire()
      }
    }
    for (const a of await sousDossiers(racine, /^\d{4}$/, ctx))
      for (const m of await sousDossiers(path.join(racine, a), /^\d{2}$/, ctx))
        for (const j of await sousDossiers(path.join(racine, a, m), /^\d{2}$/, ctx)) {
          if (ctx.codex.restant <= 0) return null // la suite à la prochaine recherche (une minute)
          const p = await dansJour(path.join(a, m, j))
          if (p) return p
          await respire()
        }
    return null
  }
  // Claude range une conversation sous `<projets>/<dossier de travail, chaque caractère qui n'est ni lettre ni chiffre
  // remplacé par « - »>/` (relevé du 17/11 : 15 consoles Claude de la production sur 15).
  const dossierProjet = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
  const REMIS = Symbol('remis') // budget de recherche du tour épuisé : ni « introuvable », ni attente d'une minute
  async function cherche(s, agent, ctx) {
    const racine = racineDe(s)
    if (s.kind === 'codex') {
      const p = await chercheCodex(racine, agent, ctx)
      return p && sous(racine, p) ? p : null
    }
    // 1. Le dossier déduit du dossier de travail de la console : un seul lstat, quelle que soit la taille de projects/
    //    (seconde relecture du 17/11, t4a : un dossier de projets inondé coupait la liste avant le vrai dossier).
    //    Le DOSSIER est contrôlé lui-même (lstat) : un lien n'est jamais suivi, et il rend l'usage « partiel » (relecture
    //    n° 3, t16-B : un dossier déduit posé d'avance comme lien était suivi, puis le journal refusé en silence).
    if (s.cwd) {
      const dp = path.join(racine, dossierProjet(s.cwd))
      const sd = sous(racine, dp) ? await fs.promises.lstat(dp).catch(() => null) : null
      if (sd?.isSymbolicLink()) refuse(s)
      else if (sd?.isDirectory()) {
        const f = path.join(dp, `${agent}.jsonl`)
        if ((await fs.promises.lstat(f).catch(() => null))?.isFile()) return f
      }
    }
    // 2. Repli : chaque dossier de projets (liste bornée, faite une fois par tour). Au plus MAX_EXAMENS_CLAUDE lstat par
    //    tour, toutes consoles : une recherche commencée va au bout de la liste, sinon elle est remise au tour suivant.
    const cle = `claude:${racine}`
    if (!ctx.claude.has(cle)) ctx.claude.set(cle, liste(racine, MAX_ENTREES, (e) => e.isDirectory()).then((r) => ({ noms: r.entrees.map((e) => e.name), coupe: r.coupe })))
    const { noms, coupe } = await ctx.claude.get(cle)
    if (ctx.examens.restant < noms.length) return REMIS
    ctx.examens.restant -= noms.length
    for (const d of noms) {
      mesures.examensClaude++
      const f = path.join(racine, d, `${agent}.jsonl`)
      const st = await fs.promises.lstat(f).catch(() => null)
      if (st?.isFile()) return f
    }
    // Liste coupée par sa borne et journal introuvable : il peut être au-delà, c'est dit (« partiel »).
    if (coupe) refuse(s)
    return null
  }
  // Le journal principal d'une conversation est toujours admis et compté. Un sous-agent entre comme CANDIDAT (lu, suivi en
  // mémoire, borné) ; il ne compte, et ne prend place sous les plafonds, qu'une fois porteur d'usage (promeut). Relecture
  // du 17/11 : 999 fichiers vides sous subagents/ aveuglaient la console ; seconde relecture : 2 × 1 000 fichiers vides
  // prenaient les 2 000 places de toutes les consoles.
  function ajouteFichier(s, p, principal) {
    if (s.fichiers.has(p) || s.candidats.has(p)) return
    if (principal) {
      s.fichiers.add(p)
      sale = true
      return
    }
    // Un plancher par console, que les autres consoles ne peuvent pas prendre : le plafond COMMUN ne joue qu'au-delà.
    if (s.candidats.size >= MAX_CANDIDATS || (s.candidats.size >= PLANCHER_CANDIDATS && totalCandidats() >= MAX_CANDIDATS_TOUT)) return refuse(s)
    s.candidats.add(p)
  }
  // Après lecture : un candidat porteur d'usage devient compté, sous les plafonds (plancher par console, puis plafond
  // commun) ; au-delà, il reste candidat (son usage ne compte pas) et c'est dit (« partiel »). Compté, il est gardé sur
  // disque avec sa position : son sceau, s'il en avait un (console relancée), n'a plus lieu d'être.
  function promeut(s) {
    for (const p of s.candidats) {
      const f = fichiers.get(p)
      if (!f || !aDeLUsage(f)) continue
      if (s.nSous >= MAX_SOUS_AGENTS || (s.nSous >= PLANCHER_SOUS_AGENTS && totalSous() >= MAX_SOUS_AGENTS_TOUT)) {
        refuse(s)
        continue
      }
      s.candidats.delete(p)
      s.fichiers.add(p)
      s.nSous++
      s.sceaux.delete(empreinte(p))
      sale = true
    }
  }
  // Scelle des fichiers d'une console fermée relue en entier, ou d'un membre clos (seconde relecture du 17/11, t9 :
  // budget.json sans borne globale). Ce qui était compté passe dans l'acquis ; l'état par fichier est remplacé par un
  // sceau (inode, position ; Codex : record vu, modèle, compteur) gardé sous une empreinte du chemin ; une conversation
  // dont le journal principal est scellé n'est plus cherchée. Relancée (revive reprend la même conversation), elle est
  // retrouvée et chaque fichier reprend à sa position (lis) : rien n'est compté deux fois.
  function scelle(s) {
    const principaux = new Map([...s.chemins].map(([a, p]) => [p, a]))
    for (const p of [...s.fichiers, ...s.candidats]) {
      const f = fichiers.get(p)
      const compte = s.fichiers.delete(p)
      s.candidats.delete(p)
      if (compte && estSous(p) && !principaux.has(p)) s.nSous--
      if (f) {
        if (compte && aDeLUsage(f)) verse((s.acquis ??= accu()), effectif(f))
        // Sceau : seulement si l'usage de ce fichier est déjà dans l'acquis (compté et porteur d'usage, ou candidat repris
        // d'un sceau et pas encore recompté). Un fichier qui n'a jamais rien compté, relu depuis 0, n'ajoute rien
        // (relecture n° 3, t13-D : 5 000 sous-agents sans usage scellés faisaient sortir le sceau du journal compté).
        const h = empreinte(p)
        if (f.lu > 0 && ((compte && aDeLUsage(f)) || s.sceaux.has(h))) ajouteSceau(s, h, sceauDe(f))
        fichiers.delete(p)
      }
      const agent = principaux.get(p)
      if (agent) {
        s.chemins.delete(agent)
        s.scellees.add(agent)
      }
    }
    s.explores?.clear()
    sale = true
  }
  // Liste d'un dossier de sous-agents (subagents/, subagents/workflows/, subagents/workflows/<wf>/), non récursive et
  // bornée, gardée d'un tour à l'autre tant que le dossier n'a pas changé (inode et date de modification) : la
  // conversation en cours est relue à chaque tour, ses dossiers inchangés ne coûtent qu'un lstat. Un lien n'est jamais
  // suivi (lstat). Gardée seulement si le dossier n'a pas bougé depuis 2 s (horloge grossière des dates de fichiers).
  // Relecture n° 3 (t14-B) : au plus MAX_ENTREES_SOUS entrées listées par tour (`ctx.sous`), toutes consoles ; une liste
  // arrêtée par ce budget est REMISE (ni gardée, ni « partiel » : le tour n'est pas complet, la suite au prochain) ; une
  // liste arrêtée par la borne d'un dossier (MAX_ENTREES) est « coupée » (« partiel »). Une liste n'est gardée que si elle
  // tient sous le plafond commun des noms gardés (jamais de remise à zéro : une console ne vide pas celles des autres).
  // Un lien à la place d'un dossier ou parmi les entrées n'est jamais suivi, et c'est dit (`lien`).
  const listesSous = new Map() // dossier → { cle, noms, coupe, lien }
  let nomsSous = 0
  async function listeSous(dossier, garde, ctx) {
    const st = await fs.promises.lstat(dossier, { bigint: true }).catch(() => null)
    if (!st?.isDirectory()) return { noms: [], coupe: false, lien: !!st?.isSymbolicLink(), remis: false } // absent, ou un lien
    const cle = `${st.ino}:${st.mtimeNs}` // pris AVANT la liste : un ajout pendant la liste change la clé
    const g = listesSous.get(dossier)
    if (g?.cle === cle) return g
    if (ctx.sous.restant <= 0) return { noms: [], coupe: false, lien: false, remis: true }
    const max = Math.min(MAX_ENTREES, ctx.sous.restant)
    let lien = false
    const r = await liste(dossier, max, (e) => {
      if (e.isSymbolicLink()) lien = true
      return garde(e)
    })
    ctx.sous.restant -= r.n
    mesures.entreesSous += r.n
    const remis = r.coupe && max < MAX_ENTREES
    const x = { cle, noms: r.entrees.map((e) => e.name), coupe: r.coupe && !remis, lien, remis }
    const plus = x.noms.length - (g?.noms.length ?? 0)
    if (!remis && Date.now() - Number(st.mtimeMs) > 2000 && nomsSous + plus <= MAX_CANDIDATS_TOUT && (g || listesSous.size < MAX_SCEAUX)) {
      nomsSous += plus
      listesSous.set(dossier, x)
    }
    return x
  }
  const jsonl = (x) => x.isFile() && x.name.endsWith('.jsonl') // lien, FIFO, dossier : ignorés (type de l'entrée)
  // Rend vrai si une liste a été remise au tour suivant (budget du tour) : la conversation n'est pas explorée en entier.
  async function sousAgents(s, principal, agent, ctx) {
    const conv = path.join(path.dirname(principal), agent)
    const dossier = path.join(conv, 'subagents')
    const st = await fs.promises.lstat(conv).catch(() => null)
    if (!st?.isDirectory()) {
      if (st?.isSymbolicLink()) refuse(s) // un lien : jamais suivi, et dit
      return false
    }
    let remis = false
    // Liste coupée par la borne, ou lien rencontré : un vrai sous-agent peut manquer, c'est dit (« partiel »).
    const voit = (x) => {
      if (x.coupe || x.lien) refuse(s)
      remis ||= x.remis
      return x.noms
    }
    for (const n of voit(await listeSous(dossier, jsonl, ctx))) ajouteFichier(s, path.join(dossier, n), false)
    // Sous-agents des workflows (demande d'Orkun : « la conversation de chaque console Claude (et ses sous-agents) ») :
    // `subagents/workflows/<wf>/*.jsonl`, profondeur FIXE (relevé du 17/11 : 73 fichiers réels, 3 dossiers <wf>), même
    // régime que les autres sous-agents. Au plus MAX_WORKFLOWS dossiers <wf> par conversation ; au-delà : « partiel ».
    // Départ tournant d'un tour à l'autre : le budget du tour finit par atteindre chaque dossier <wf>.
    const wf = path.join(dossier, 'workflows')
    const noms = voit(await listeSous(wf, (x) => x.isDirectory(), ctx))
    if (noms.length > MAX_WORKFLOWS) refuse(s)
    const retenus = noms.slice(0, MAX_WORKFLOWS)
    const k = retenus.length ? mesures.tours % retenus.length : 0
    for (const n of [...retenus.slice(k), ...retenus.slice(0, k)]) {
      const d = path.join(wf, n)
      for (const m of voit(await listeSous(d, jsonl, ctx))) ajouteFichier(s, path.join(d, m), false)
    }
    return remis
  }
  // Rend vrai si une recherche a été remise au tour suivant (budget épuisé) : le tour de cette console n'est pas complet
  // (une console fermée n'est pas scellée tant que toutes ses conversations n'ont pas été cherchées).
  async function decouvre(s, courant, ferme, ctx) {
    // La conversation en cours d'abord : le budget de recherche du tour va d'abord à elle (seconde relecture, t4-B) ; les
    // autres à partir d'un point qui tourne à chaque tour (sinon, le budget épuisé, les mêmes passeraient toujours avant).
    const autres = s.agents.filter((a) => a !== courant)
    const k = autres.length ? mesures.tours % autres.length : 0
    const ordre = [...(courant && s.agents.includes(courant) ? [courant] : []), ...autres.slice(k), ...autres.slice(0, k)]
    let remis = false
    for (const agent of ordre) {
      if (s.scellees.has(agent)) {
        // Scellée : rien à chercher ni à lire, sauf redevenue la conversation en cours d'une console relancée.
        if (agent !== courant || ferme) continue
        s.scellees.delete(agent)
        sale = true
      }
      let principal = s.chemins.get(agent)
      if (!principal) {
        const cle = `${s.kind}:${s.compte}:${agent}`
        if ((attente.get(cle) ?? 0) > maintenant()) continue
        principal = await cherche(s, agent, ctx)
        if (principal === REMIS) {
          remis = true // la suite au tour prochain, sans attente d'une minute
          continue
        }
        if (!principal) {
          attente.set(cle, maintenant() + RECHERCHE_MS)
          continue
        }
        attente.delete(cle)
        s.chemins.set(agent, principal)
        ajouteFichier(s, principal, true)
      }
      // Sous-agents : la conversation en cours à chaque tour ; les autres une fois par démarrage du moteur (une exploration
      // remise faute de budget est reprise au tour suivant, et le tour n'est pas complet).
      if (s.kind === 'claude' && (agent === courant || !s.explores?.has(agent))) {
        if (await sousAgents(s, principal, agent, ctx)) remis = true
        else (s.explores ??= new Set()).add(agent)
      }
    }
    return remis
  }

  // Un fichier : rien d'ouvert s'il n'a pas bougé (lstat) ; sinon ouvert par descripteur, contrôlé, lu à partir de f.lu.
  // Remplacé (autre inode) ou raccourci : ses totaux sont versés dans l'ACQUIS de la console, puis il est relu depuis 0.
  // `ctx` : { s (la console), racine, reelle (chemin réel de la racine), quota: { restant } (octets encore permis ce tour) }.
  async function lis(chemin, kind, ctx) {
    const avant = fichiers.get(chemin)
    const st = await fs.promises.lstat(chemin).catch(() => null)
    if (!st?.isFile()) {
      // Absent, FIFO : ses totaux déjà lus restent. Un LIEN à la place du journal : jamais suivi, et dit (« partiel »).
      if (st?.isSymbolicLink()) refuse(ctx.s)
      return false
    }
    if (avant && avant.kind === kind && avant.ino === st.ino && avant.lu === st.size) return false
    if (ctx.quota.restant <= 0) {
      ctx.incomplet = true // quota de lecture du tour épuisé : la suite au tour prochain
      return false
    }
    let fh
    try {
      fh = await fs.promises.open(chemin, OUVERTURE)
    } catch {
      return false // remplacé par un lien entre-temps (ELOOP), disparu…
    }
    mesures.ouverts++
    try {
      const sd = await fh.stat()
      if (!sd.isFile() || sd.nlink !== 1) return false // ce qui a été OUVERT : fichier ordinaire à un seul lien
      // Et OÙ il est : O_NOFOLLOW ne garde que le dernier élément ; un dossier parent remplacé par un lien (subagents →
      // ailleurs) ferait lire un autre fichier. Le chemin réel du descripteur doit être celui attendu sous la racine.
      const reel = await fs.promises.readlink(`/proc/self/fd/${fh.fd}`).catch(() => '')
      if (!ctx.reelle || reel !== path.join(ctx.reelle, path.relative(ctx.racine, chemin))) {
        // Le chemin passe par un lien (dossier de projet ou de sous-agents remplacé) : rien n'est lu, et c'est dit
        // (relecture n° 3, t16-A : l'agent qui remplaçait son dossier de projet par un lien rendait sa console aveugle en
        // silence).
        mesures.refuses++
        refuse(ctx.s)
        return false
      }
      let f = fichiers.get(chemin)
      let neuf = false
      if (!f) {
        // Un fichier scellé retrouvé (console relancée) : repris à la position de son sceau si c'est le même fichier (même
        // inode, pas raccourci) ; sinon relu depuis 0 (ses totaux sont déjà acquis : « partiel »).
        // Le sceau d'un CANDIDAT est gardé jusqu'à ce qu'il soit compté (promeut) : un candidat n'est pas écrit sur disque,
        // et après une relance du moteur il serait sinon relu depuis 0 alors que son usage est déjà dans l'acquis.
        const h = empreinte(chemin)
        const x = ctx.s.sceaux.get(h)
        if (x) {
          const meme = x[0] === sd.ino && sd.size >= x[1]
          if (!meme || ctx.s.fichiers.has(chemin)) {
            ctx.s.sceaux.delete(h)
            sale = true
          }
          if (meme) {
            f = reprend(kind, x)
            fichiers.set(chemin, f)
            neuf = true
          } else ctx.s.partiel = true
        }
      }
      if (!f || f.kind !== kind || f.ino !== sd.ino || sd.size < f.lu) {
        const ancien = f?.kind === kind ? f : null
        f = fichierNeuf(kind, sd.ino)
        if (ancien) {
          // L'anneau des dernières clés suit le fichier : un même contenu réécrit ne recompte pas ses derniers messages.
          f.cles = ancien.cles
          // Relecture du 17/11 (r6) : remis à zéro, un journal vidé par son agent effaçait l'usage déjà compté (le palier
          // n'arrivait jamais). Ce qui était COMPTÉ reste acquis à la console (gardé dans budget.json) ; le fichier est relu
          // depuis 0 et l'usage devient « partiel » (l'écran dit « au moins » ; au-delà de l'anneau, un contenu réécrit peut
          // compter deux fois). Un candidat (rien de compté) repart de zéro sans rien dire.
          if (ctx.s.fichiers.has(chemin) && aDeLUsage(ancien)) {
            verse((ctx.s.acquis ??= accu()), effectif(ancien))
            ctx.s.partiel = true
          }
        }
        fichiers.set(chemin, f)
        neuf = true
      }
      if (sd.size === f.lu) return neuf
      const fin = Math.min(sd.size, f.lu + Math.min(PAR_FICHIER, ctx.quota.restant))
      if (fin < sd.size) ctx.incomplet = true
      const lus = await litSuite(fh, f, fin, mesures)
      ctx.quota.restant -= lus
      mesures.octetsLus += lus
      return true
    } finally {
      await fh.close().catch(() => {})
    }
  }

  // ── Calcul ──
  function usageDe(s) {
    const codex = s.kind === 'codex'
    // « partiel » (l'écran dit « au moins ») : un modèle sans prix ou une ligne d'usage perdue (Claude), un sous-agent refusé
    // ou une liste coupée par une borne, un journal raccourci ou remplacé (son acquis) — Claude comme Codex.
    const u = { kind: s.kind, equipe: s.equipe, total: 0, entree: 0, sortie: 0, cacheLu: 0, cacheEcrit: 0, messages: 0, cout: codex ? null : 0, partiel: s.partiel === true }
    const modeles = new Map()
    const accus = []
    for (const chemin of s.fichiers) {
      const f = fichiers.get(chemin)
      if (f && f.kind === s.kind) accus.push(codex ? (f.aRecord ? f.rec : f.rep) : f.a)
    }
    if (s.acquis) accus.push(s.acquis)
    for (const a of accus) {
      for (const k of CHAMPS) u[k] += a[k]
      if (!codex) {
        u.cout += a.cout
        u.partiel ||= a.partiel
      }
      for (const [k, g] of a.modeles) {
        // Borné aussi après la fusion des fichiers (relecture du 17/11 : 1 000 fichiers × 8 noms inventés par un agent).
        const cle = modeles.has(k) || modeles.size < 4 * MODELES_MONTRES ? k : `${k[0]}:autres`
        const m = modeles.get(cle) ?? { total: 0, cout: 0, sansPrix: false }
        m.total += g.total
        m.cout += g.cout
        m.sansPrix ||= g.sansPrix
        modeles.set(cle, m)
      }
    }
    if (!codex) u.cout = arrondi(u.cout)
    const tries = [...modeles].sort((x, y) => y[1].total - x[1].total)
    const reste = tries.slice(MODELES_MONTRES - 1)
    if (tries.length > MODELES_MONTRES) {
      // Les plus petits regroupés en une ligne « autres » : la console n'en montre jamais plus de MODELES_MONTRES.
      const r = { total: 0, cout: 0, sansPrix: false }
      for (const [, g] of reste) Object.assign(r, { total: r.total + g.total, cout: r.cout + g.cout, sansPrix: r.sansPrix || g.sansPrix })
      tries.splice(MODELES_MONTRES - 1, reste.length, ['m:autres', r])
    }
    u.modeles = tries.map(([cle, g]) => ({ modele: cle.slice(2), total: g.total, cout: codex || g.sansPrix ? null : arrondi(g.cout), conseiller: cle[0] === 'c' }))
    u.conversations = s.agents.length
    return u
  }
  function calcule() {
    const u = new Map()
    for (const [id, s] of suivis) {
      const x = usageDe(s)
      const cle = JSON.stringify(x)
      if (s.cle !== undefined && s.cle !== cle) s.maj = maintenant()
      s.cle = cle
      u.set(id, { ...x, maj: s.maj })
    }
    // Équipe = membres présents + membres clos (closeMember retire la console : son usage reste tant que l'équipe vit).
    const e = new Map()
    for (const [id, s] of suivis) {
      if (!s.equipe) continue
      const x = u.get(id)
      let t = e.get(s.equipe)
      if (!t) e.set(s.equipe, (t = { total: 0, cout: null, partiel: false, codex: false, membres: 0 }))
      t.total += x.total
      t.membres++
      t.partiel ||= x.partiel // un membre Codex « au moins » rend aussi les jetons de l'équipe « au moins »
      if (x.kind === 'codex') t.codex = true
      else t.cout = arrondi((t.cout ?? 0) + x.cout)
    }
    usages = u
    parEquipe = e
  }
  // Ce qu'un budget compare : la part chiffrée ($ éq. API) ou les jetons. null = rien de comparable (Codex en $).
  const valeur = (cible, unite) => {
    const x = cible[0] === 'c' ? usages.get(cible.slice(2)) : parEquipe.get(cible.slice(2))
    if (!x) return 0
    if (unite === 'jetons') return x.total
    return cible[0] === 'e' ? (x.cout ?? 0) : x.cout
  }
  const nomDe = (cible, b) => {
    const id = cible.slice(2)
    const x = cible[0] === 'c' ? consoles().find((c) => c?.id === id) : equipes().find((t) => t?.id === id)
    return propre((cible[0] === 'c' ? x?.name : x?.nom) || b?.nom || id, 100) // nettoyé : il part aussi en notification
  }
  const ouvreDe = (cible) => (cible[0] === 'c' ? cible.slice(2) : (consoles().find((c) => c?.team === cible.slice(2) && c.chief)?.id ?? ''))
  const budgetsVue = () =>
    Object.fromEntries(
      [...budgets].map(([cible, b]) => {
        const utilise = valeur(cible, b.unite) ?? 0
        const part = utilise / b.montant
        return [cible, { montant: b.montant, unite: b.unite, nom: nomDe(cible, b), utilise: b.unite === 'usd' ? arrondi(utilise) : utilise, part: Math.round(part * 1e4) / 1e4, palier: part >= 1 ? 100 : part >= 0.8 ? 80 : 0, repondu: b.repondu }]
      }),
    )
  const demandesVue = () => demandes.map(({ corps, ident, ...d }) => d) // corps entier et dev:ino : au serveur seulement
  // Consoles FERMÉES (toujours dans l'Historique) : aucune question ni notification de budget tant qu'elles le sont.
  const fermees = () => new Set(consoles().filter((c) => c?.status === 'closed').map((c) => c.id))
  const avertit = (p) => {
    try {
      alerte(p)
    } catch (e) {
      console.error(`[budget] notification : ${e.message}`)
    }
  }

  // Paliers : à 80 % une notification par montant ; à 100 % une demande « continuer ? » + une notification. Le repère est
  // écrit sur disque AVANT la notification (une relance ne la refait pas), qu'elle parte ou non (aucun abonné, page à
  // l'écran). Rien d'autre : ni touche, ni statut, ni message refusé.
  function paliers() {
    const closes = fermees()
    for (const [cible, b] of budgets) {
      if (cible[0] === 'c' && closes.has(cible.slice(2))) continue // fermée : rien ne part (relancée, elle est réévaluée)
      const v = valeur(cible, b.unite)
      if (v === null) continue
      const part = v / b.montant
      const nom = nomDe(cible, b)
      const tag = `budget-${cible}`
      if (part >= 1 && !b.demande100) {
        b.demande100 = true
        b.alerte80 = true // passé d'un coup de moins de 80 % à 100 % : une seule notification
        const d = { id: nouvelId(), type: 'budget', cible, nom: propre(nom, 100), at: maintenant(), texte: TEXTE_BUDGET, detail: `${fmt(v, b.unite)} sur ${fmt(b.montant, b.unite)}` }
        demandes = demandes.filter((x) => !(x.type === 'budget' && x.cible === cible))
        demandes.push(d)
        garde(true)
        avertit({ title: `${nom} : budget atteint`, body: `${d.detail} — continuer ?`, tag, ouvre: ouvreDe(cible) })
      } else if (part >= 0.8 && !b.alerte80) {
        b.alerte80 = true
        garde(true)
        avertit({ title: `${nom} : 80 % du budget`, body: `${fmt(v, b.unite)} sur ${fmt(b.montant, b.unite)}`, tag, ouvre: ouvreDe(cible) })
      }
    }
  }

  // Oubli : une console retirée hors équipe (son usage, ses budgets) ; une équipe disparue (ses membres clos, son budget,
  // son réglage, ses demandes) ; un fichier qu'aucune console suivie ne porte plus. Lu sur l'état COURANT du serveur.
  function nettoyage() {
    const presentes = new Set(consoles().map((c) => c?.id))
    const vivantes = new Set(equipes().map((t) => t?.id))
    const retires = []
    for (const [id, s] of suivis) {
      if (presentes.has(id)) continue
      if (s.equipe && vivantes.has(s.equipe)) {
        // Membre clos (retiré des consoles, son équipe vit) : ses journaux ne bougent plus, il ne garde que ses totaux.
        if (s.fichiers.size || s.candidats.size) scelle(s)
        continue
      }
      suivis.delete(id)
      retires.push(id)
    }
    let change = retires.length > 0
    for (const cible of [...budgets.keys()]) {
      if (cible[0] === 'c' ? presentes.has(cible.slice(2)) : vivantes.has(cible.slice(2))) continue
      budgets.delete(cible)
      change = true
    }
    for (const id of [...reglages.keys()]) {
      if (vivantes.has(id)) continue
      reglages.delete(id)
      change = true
    }
    // La question « budget atteint » d'une console FERMÉE n'a plus d'objet : effacée, et le palier de 100 % réarmé — relancée,
    // la console est questionnée de nouveau (paliers() la saute tant qu'elle est fermée : rien ne part entre-temps).
    const closes = fermees()
    const close = (d) => d.type === 'budget' && d.cible[0] === 'c' && closes.has(d.cible.slice(2))
    for (const d of demandes) if (close(d) && budgets.has(d.cible)) budgets.get(d.cible).demande100 = false
    const n = demandes.length
    demandes = demandes.filter((d) => (d.type === 'budget' ? budgets.has(d.cible) && !close(d) : vivantes.has(d.equipe)))
    change ||= demandes.length !== n
    const portes = new Set()
    for (const s of suivis.values()) for (const p of [...s.fichiers, ...s.candidats]) portes.add(p)
    for (const p of [...fichiers.keys()]) {
      if (portes.has(p)) continue
      fichiers.delete(p)
      change = true
    }
    if (change) sale = true
    return retires
  }

  // Flux : budgets, réglages, demandes toujours entiers (petits) ; usages et équipes : seulement ceux qui ont changé.
  function diffuse(retires = []) {
    const msg = { type: 'budget' }
    const u = {}
    const presentes = new Set(consoles().map((c) => c?.id))
    for (const [id, x] of usages) {
      if (!presentes.has(id)) continue
      const j = JSON.stringify(x)
      if (envoye.usages.get(id) !== j) {
        envoye.usages.set(id, j)
        u[id] = x
      }
    }
    for (const id of retires) envoye.usages.delete(id)
    for (const id of [...envoye.usages.keys()]) if (!presentes.has(id)) envoye.usages.delete(id)
    const e = {}
    for (const [id, x] of parEquipe) {
      const j = JSON.stringify(x)
      if (envoye.equipes.get(id) !== j) {
        envoye.equipes.set(id, j)
        e[id] = x
      }
    }
    const reste = { budgets: budgetsVue(), reglages: Object.fromEntries(reglages), demandes: demandesVue() }
    const j = JSON.stringify(reste)
    if (!Object.keys(u).length && !Object.keys(e).length && !retires.length && j === envoye.reste) return
    envoye.reste = j
    if (Object.keys(u).length) msg.usages = u
    if (Object.keys(e).length) msg.equipes = e
    if (retires.length) msg.retires = retires
    try {
      broadcast({ ...msg, ...reste })
    } catch (err) {
      console.error(`[budget] diffusion : ${err.message}`)
    }
  }

  // ── Un tour : consoles en série, lecture en flux, un seul à la fois ──
  async function unTour() {
    const t0 = Date.now()
    // Copie prise AVANT les attentes (leçon du 13/11) : une console créée pendant le tour attend le suivant.
    const toutes = consoles()
      .filter((c) => c && typeof c.id === 'string' && CONSOLE.test(c.id) && (c.kind === 'claude' || c.kind === 'codex'))
      .map((c) => ({ id: c.id, kind: c.kind, compte: c.compte === '2' ? '2' : '1', equipe: typeof c.team === 'string' && EQUIPE.test(c.team) ? c.team : null, nom: typeof c.name === 'string' ? c.name.slice(0, 100) : '', agent: typeof c.agent === 'string' && ID.test(c.agent) ? c.agent : '', ferme: c.status === 'closed', cwd: typeof c.cwd === 'string' && path.isAbsolute(c.cwd) && c.cwd.length <= 4096 ? c.cwd : '' }))
    // Point de départ tournant : le quota de lecture d'un tour ne laisse jamais les mêmes consoles derrière.
    const k = toutes.length ? mesures.tours % toutes.length : 0
    const liste = [...toutes.slice(k), ...toutes.slice(0, k)]
    // Listes faites au plus une fois par tour (dossiers de projets Claude, dossiers de jour et années / mois de Codex) et
    // borne d'entrées examinées dans l'arbre de Codex, partagée par toutes les recherches du tour.
    const cache = { claude: new Map(), jours: new Map(), dossiers: new Map(), codex: { restant: MAX_ENTREES_CODEX }, examens: { restant: MAX_EXAMENS_CLAUDE }, sous: { restant: MAX_ENTREES_SOUS } }
    const reelles = new Map() // racine → son chemin réel (une fois par tour)
    const quota = { restant: PAR_TOUR }
    const t = maintenant()
    for (const [k, h] of attente) if (h <= t) attente.delete(k)
    for (const c of liste) {
      let s = suivis.get(c.id)
      if (s && s.kind !== c.kind) s = null
      if (!s) {
        s = nouvelleConsole(c)
        suivis.set(c.id, s)
        sale = true
      }
      if (s.equipe !== c.equipe || s.nom !== c.nom || s.compte !== c.compte) {
        Object.assign(s, { equipe: c.equipe, nom: c.nom, compte: c.compte })
        sale = true
      }
      s.cwd = c.cwd // dossier de travail : sert à déduire le dossier de projet de Claude (pas gardé sur disque)
      if (c.agent && !s.agents.includes(c.agent)) {
        s.agents.push(c.agent)
        if (s.agents.length > MAX_CONVERSATIONS) {
          const sortie = s.agents.shift()
          s.chemins.delete(sortie) // ses fichiers et totaux restent
          s.scellees.delete(sortie)
        }
        sale = true
      }
      // Console fermée déjà relue EN ENTIER : ses journaux ne bougent plus (relancée, elle est relue). Mesure réelle du
      // 17/11 : marquée trop tôt, une console fermée dont la lecture avait été coupée par le quota du tour n'était plus
      // jamais finie (12 Mo relus par le moteur suivant).
      if (c.ferme && s.ferme) continue
      let fini = false
      try {
        const remis = await decouvre(s, c.agent, c.ferme, cache)
        const racine = racineDe(s)
        if (!reelles.has(racine)) reelles.set(racine, await fs.promises.realpath(racine).catch(() => ''))
        const ctx = { s, racine, reelle: reelles.get(racine), quota, incomplet: false }
        for (const p of [...s.fichiers, ...s.candidats]) if (await lis(p, s.kind, ctx)) sale = true
        promeut(s)
        fini = !ctx.incomplet && !remis
      } catch (e) {
        console.error(`[budget] ${c.id} : ${e.message}`)
      }
      s.ferme = c.ferme && fini
      // Fermée et relue en entier : elle ne garde que ses totaux et des sceaux (seconde relecture du 17/11, t9).
      if (s.ferme && (s.fichiers.size || s.candidats.size)) scelle(s)
    }
    const retires = nettoyage()
    calcule()
    paliers()
    diffuse(retires)
    if (sale) garde()
    calculeLe = maintenant()
    mesures.dureeMs = Date.now() - t0
    mesures.tours++
  }
  let enCours = null
  function tour() {
    if (!enCours) {
      enCours = unTour()
        .catch((e) => console.error(`[budget] tour : ${e.stack || e.message}`))
        .finally(() => {
          enCours = null
        })
    }
    return enCours
  }

  // ── Budgets, réglages, demandes ──
  function poseBudget(x) {
    if (!objet(x)) throw refus('demande invalide')
    const cible = typeof x.cible === 'string' ? x.cible : ''
    if (!CIBLE.test(cible)) throw refus('cible invalide')
    const id = cible.slice(2)
    const c = cible[0] === 'c' ? consoles().find((k) => k?.id === id) : null
    const t = cible[0] === 'e' ? equipes().find((k) => k?.id === id) : null
    if (cible[0] === 'c' && (!c || (c.kind !== 'claude' && c.kind !== 'codex'))) throw refus('console inconnue (Claude ou Codex seulement)', 404)
    if (cible[0] === 'e' && !t) throw refus('équipe inconnue', 404)
    if (x.montant === null) {
      if (budgets.delete(cible)) {
        demandes = demandes.filter((d) => !(d.type === 'budget' && d.cible === cible))
        garde(true)
        diffuse()
      }
      return { budgets: budgetsVue() }
    }
    const unite = x.unite
    if (unite !== 'usd' && unite !== 'jetons') throw refus('unité invalide (usd ou jetons)')
    if (unite === 'usd' && c?.kind === 'codex') throw refus('Codex : aucun prix connu, budget en jetons seulement')
    if (typeof x.montant !== 'number' || !Number.isFinite(x.montant) || x.montant <= 0 || x.montant > MAX[unite]) throw refus(`montant invalide (plus de 0, ${MAX[unite]} au plus)`)
    const avant = budgets.get(cible)
    if (avant && avant.montant === x.montant && avant.unite === unite) return { budgets: budgetsVue() } // rien n'est réarmé
    // Nouveau montant : 80 % et 100 % réarmés, l'ancienne question retirée, les paliers évalués tout de suite.
    budgets.set(cible, { montant: x.montant, unite, nom: String((c ? c.name : t.nom) ?? '').slice(0, 100), alerte80: false, demande100: false, repondu: null })
    demandes = demandes.filter((d) => !(d.type === 'budget' && d.cible === cible))
    paliers()
    garde(true)
    diffuse()
    return { budgets: budgetsVue() }
  }
  function regleEquipe(equipe, { valider } = {}) {
    if (!equipes().some((t) => t?.id === equipe)) throw refus('équipe inconnue', 404)
    if (typeof valider !== 'boolean') throw refus('réglage invalide')
    if (valider) reglages.set(equipe, { valider: true })
    else reglages.delete(equipe)
    garde(true)
    diffuse()
    return { reglages: Object.fromEntries(reglages) }
  }
  const aValider = (equipe) => reglages.get(equipe)?.valider === true

  // Le capitaine d'une équipe « à valider » demande un lancement : rien ne se lance, la demande attend Orkun.
  function demandeLancement(chef, x) {
    const corps = corpsLancement(x, refus)
    const r = typeof roles === 'function' ? roles() : null
    if (r && (!Object.hasOwn(r, corps.role) || r[corps.role]?.nom === 'capitaine')) throw refus(`rôle inconnu : ${propre(corps.role, 40)} (voir « meydan roles »)`)
    const equipe = chef?.team
    const t = equipes().find((k) => k?.id === equipe)
    if (!t) throw refus('équipe arrêtée', 409)
    if (demandes.filter((d) => d.type === 'lancement' && d.equipe === equipe).length >= MAX_DEMANDES)
      throw refus(`${MAX_DEMANDES} demandes de lancement attendent déjà la réponse d’Orkun : attends ses messages [Meydan]`, 409)
    // Sans git, le dossier demandé est résolu MAINTENANT, comme lancer() le fera : Orkun lit le chemin réel (`dossierReel`),
    // et l'accord vérifie que c'est toujours lui (chemin réel et dev:ino). Sous git, `dossier` n'est pas utilisé (worktree).
    const r0 = !t.git && corps.dossier ? resoutDossier(t, corps.dossier, refus) : { reel: '', ident: '' }
    const d = { id: nouvelId(), type: 'lancement', equipe, nom: propre(t.nom, 100), chef: chef.id, at: maintenant(), ...vueLancement(corps), dossierReel: r0.reel, corps, ident: r0.ident }
    demandes.push(d)
    garde(true)
    diffuse()
    avertit({ title: `${d.nom} : lancement à valider`, body: `${d.role} « ${d.equipier} » — ${d.resume}`, tag: d.id, ouvre: chef.id })
    return { attente: true, demande: d.id, message: `demande envoyée à Orkun (${d.id}) : il doit l'accepter ; tu recevras sa réponse dans cette console par un message [Meydan]. Ne relance pas la commande.` }
  }

  async function repond(res, id, choix) {
    const i = demandes.findIndex((d) => d.id === id)
    if (i < 0) throw refus('demande inconnue (déjà traitée ?)', 404)
    const d = demandes[i]
    if (d.type === 'budget') {
      if (choix !== 'continuer') throw refus('choix invalide (continuer)')
      demandes.splice(i, 1)
      const b = budgets.get(d.cible)
      if (b) b.repondu = maintenant() // plus de question pour ce montant
      garde(true)
      diffuse()
      return send(res, 200, { ok: true })
    }
    if (choix !== 'accepter' && choix !== 'refuser') throw refus('choix invalide (accepter ou refuser)')
    // Retirée AVANT toute attente : un second appui (PC et téléphone en même temps) reçoit 404, un seul lancement part.
    demandes.splice(i, 1)
    garde(true)
    diffuse()
    const qui = `${d.role} « ${d.equipier} »`
    if (choix === 'refuser') {
      previent(d.equipe, `Orkun a refusé le lancement de ${qui} (${d.id}) : ne le relance pas sans son accord.`)
      return send(res, 200, { ok: true })
    }
    // Sans git avec un dossier : refaire la résolution et refuser si le chemin réel ou son dev:ino a changé depuis la demande
    // (lien substitué, dossier recréé : relecture du 17/11, r7). Rien n'est lancé ; Orkun (réponse) et le capitaine
    // (message [Meydan]) le savent. Sinon c'est le chemin RÉEL validé qui part à lancer() (path.resolve le garde tel quel).
    let corps = d.corps
    const t = equipes().find((k) => k?.id === d.equipe)
    if (t && !t.git && d.corps.dossier) {
      let r = null
      let pourquoi = ''
      try {
        r = resoutDossier(t, d.corps.dossier, refus)
      } catch (e) {
        pourquoi = e.message
      }
      if (!d.dossierReel || !d.ident || !r || r.reel !== d.dossierReel || r.ident !== d.ident) {
        const quoi = `le dossier « ${d.corps.dossier} » a changé depuis la demande (validé : ${d.dossierReel || 'inconnu'} ; maintenant : ${r ? `${r.reel}${r.reel === d.dossierReel ? ', recréé ou remplacé' : ''}` : pourquoi})`
        previent(d.equipe, `Orkun a accepté le lancement de ${qui} (${d.id}), mais ${quoi} : rien n’a été lancé. Refais la demande si ce dossier est bien voulu.`)
        throw refus(`${quoi} : rien n’a été lancé`, 409)
      }
      corps = { ...d.corps, dossier: d.dossierReel, dossierIdent: d.ident } // revérifié par lancer() à son tour (server.mjs)
    }
    let c
    try {
      c = await lancer(d.chef, corps, d.equipe) // le serveur revérifie que le capitaine est toujours de CETTE équipe
    } catch (e) {
      previent(d.equipe, `Orkun a accepté le lancement de ${qui} (${d.id}), mais il a échoué : ${propre(e?.message, 300)}`)
      throw e
    }
    previent(d.equipe, `Orkun a accepté le lancement de ${qui} (${d.id}) : lancé, ${c.id} · ${c.name}, dossier ${c.cwd}${c.branch ? `, branche ${c.branch}` : ''}.`)
    return send(res, 200, { ok: true, console: c })
  }

  // Routes /api/budget (le serveur les place derrière la porte de session et originOk).
  async function api(req, res, url, parts) {
    const m = req.method
    if (parts.length === 2 && m === 'GET') return send(res, 200, etat())
    // Le texte ENTIER d'une demande de lancement, exactement celui qui partira (sans caractère invisible : refusé à la demande).
    if (parts.length === 4 && parts[2] === 'demandes' && m === 'GET') {
      const d = demandes.find((x) => x.id === parts[3] && x.type === 'lancement')
      if (!d) throw refus('demande inconnue (déjà traitée ?)', 404)
      return send(res, 200, { id: d.id, role: d.corps.role, equipier: d.corps.nom, tache: d.corps.tache, dossier: d.corps.dossier ?? '', dossierReel: d.dossierReel, base: d.corps.base ?? '' })
    }
    if (m !== 'POST') return send(res, 404, { error: 'route inconnue' })
    if (parts.length === 3 && parts[2] === 'budget') return send(res, 200, poseBudget(await readJson(req)))
    if (parts.length === 4 && parts[2] === 'equipes') {
      const b = await readJson(req)
      return send(res, 200, regleEquipe(parts[3], { valider: objet(b) ? b.valider : undefined }))
    }
    if (parts.length === 4 && parts[2] === 'demandes') {
      const b = await readJson(req)
      return await repond(res, parts[3], objet(b) ? b.choix : undefined)
    }
    return send(res, 404, { error: 'route inconnue' })
  }

  function etat() {
    const presentes = new Set(consoles().map((c) => c?.id))
    const vivantes = new Set(equipes().map((t) => t?.id))
    return {
      calculeLe,
      usages: Object.fromEntries([...usages].filter(([id]) => presentes.has(id))),
      equipes: Object.fromEntries([...parEquipe].filter(([id]) => vivantes.has(id))),
      budgets: budgetsVue(),
      reglages: Object.fromEntries(reglages),
      demandes: demandesVue(),
    }
  }

  charge()
  calcule() // l'état relu se montre avant le premier tour
  let minuterie = null
  if (demarre) {
    minuterie = setInterval(tour, intervalle)
    minuterie.unref()
  }
  function arrete() {
    if (minuterie) clearInterval(minuterie)
    minuterie = null
    if (sale) garde(true)
  }

  return { api, aValider, demandeLancement, regleEquipe, tour, etat, arrete, mesures: () => ({ ...mesures }) }
}
