// Fichiers réservés d'une tâche d'équipier (volet livraison-equipes, 17/11) : `meydan lancer … --fichiers 'src/paiements/**'`.
// Meydan refuse de lancer une tâche dont les fichiers chevauchent ceux d'une tâche en cours dans le même projet
// (server.mjs, lancer), et la file de livraison dit au capitaine ce qu'une livraison a changé hors de ses fichiers.
//
// Lecture des motifs reprise de Hangar (hangar-ai/hangar, commit 279d6ee lu le 17/11/2026, licence MIT, Copyright (c) 2026
// simnJS, texte dans LICENCES-TIERCES.md ;
// crates/hangar-core/src/delivery/owns.rs : `expand_braces`, `owned_segments`, `glob_matches`, `covers`, et
// crates/hangar-core/src/board.rs : `owns_overlap`, `sequences_meet`, `segments_meet`, `fixed_ends`), portée en
// JavaScript et adaptée :
//   - un motif est relatif à la racine du projet, en barres obliques, sans `./` ; casse ignorée (comme Hangar : se
//     tromper vers un chevauchement ne coûte qu'un refus qui dit pourquoi) ;
//   - un dossier possède ce qui est dessous (`src/lib` = `src/lib/**`) ; un nom avec une extension se lit comme un
//     fichier ; un dossier dont le nom a un point s'écrit avec une barre finale (`vendor.d/`) ;
//   - `*`, `?`, `[…]` (`[!…]`, `[^…]`, plages) restent dans un nom, `**` traverse les dossiers, `{a,b}` donne deux motifs ;
//   - deux jokers dans le même nom se rencontrent sauf si leurs bouts fixes se contredisent (`*.ts` et `*.tsx` non,
//     `use*.ts` et `*Store.ts` oui) : lecture large, du côté du chevauchement ;
//   - en plus : un motif absolu, avec `..`, un caractère de contrôle, ou plus long que 200 caractères est REFUSÉ (il
//     viendrait d'un agent) ; 20 motifs au plus par tâche ; la comparaison est faite par programmation dynamique (Hangar
//     le fait pour `covers` ; ici aussi pour le chevauchement, que beaucoup de `**` rendraient sinon exponentiel).
import { refus, INVISIBLES } from './equipage.mjs'

// Alternatives d'accolades : 32 au plus pour TOUS les motifs d'une tâche (relecture indépendante du volet : « {,}{,}… »
// donnait 2^66 appels avant la borne, et serveur gelé). L'expansion s'arrête dès la borne atteinte, sans descendre plus.
export const MAX_ALTERNATIVES = 32
// Temps de comparaison d'un lancement : au-delà, la réservation est tenue pour chevauchante (refus qui dit pourquoi).
const BUDGET_MS = 300
const MAX_SEGMENTS = 32
export const MAX_MOTIFS = 20
const MAX_LONGUEUR = 200

// Le refus d'un lancement dont les fichiers chevauchent une tâche en cours (`equipe` : celle de l'autre tâche, si ce
// n'est pas la même), dit au capitaine qui lance.
export const texteChevauche = (paire, qui, equipe) =>
  `fichiers réservés : « ${paire[0]} » chevauche « ${paire[1]} » de ${qui}${equipe ? `, équipe « ${equipe.nom} » (${equipe.id})` : ''}, tâche en cours. Attends qu'elle soit finie (livraison atterrie, ou équipier clos), ou donne à celle-ci d'autres fichiers.`

// Motifs reçus du capitaine (chaîne ou liste, séparés par des blancs) → liste propre, ou refus en français.
export function lisMotifs(x) {
  if (x === undefined || x === null || x === '') return []
  const brut = (Array.isArray(x) ? x : [x]).flatMap((v) => {
    if (typeof v !== 'string') throw refus('fichiers réservés : une liste de motifs (texte) est attendue')
    return v.split(/\s+/).filter(Boolean)
  })
  if (brut.length > MAX_MOTIFS) throw refus(`fichiers réservés : ${MAX_MOTIFS} motifs au plus`)
  const vus = []
  for (const m of brut) {
    if (m.length > MAX_LONGUEUR) throw refus(`fichiers réservés : motif trop long (${MAX_LONGUEUR} caractères au plus)`)
    if (/[\u0000-\u001f\u007f-\u009f]/.test(m) || m.replace(INVISIBLES, '') !== m) throw refus('fichiers réservés : caractère de contrôle ou invisible refusé')
    const n = m.replace(/\\/g, '/')
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw refus(`fichiers réservés : « ${m} » est absolu ; écris-le depuis la racine du projet (par ex. src/paiements/**)`)
    if (n.split('/').includes('..')) throw refus(`fichiers réservés : « .. » refusé dans « ${m} »`)
    if (!segments(n)) throw refus(`fichiers réservés : « ${m} » ne désigne aucun fichier`)
    if (!vus.includes(m)) vus.push(m)
  }
  const alternatives = vus.reduce((n, m) => n + (accolades(m, MAX_ALTERNATIVES + 1).length), 0)
  if (alternatives > MAX_ALTERNATIVES) throw refus(`fichiers réservés : ${MAX_ALTERNATIVES} motifs au plus une fois les accolades dépliées`)
  return vus
}

// `src/{lib,components}/x` → les deux motifs qu'il désigne (owns.rs, expand_braces). Dépliée groupe par groupe, en
// largeur, et arrêtée dès `max` motifs : le travail est borné par `max` × le nombre de groupes, jamais exponentiel.
export function accolades(motif, max = MAX_ALTERNATIVES) {
  const finis = []
  let file = [motif]
  while (file.length && finis.length < max) {
    const suite = []
    for (const m of file) {
      const g = premierGroupe(m)
      if (!g) finis.push(m)
      else for (const a of g.choix) suite.push(g.tete + a + g.queue)
      if (finis.length + suite.length >= max) break
    }
    file = suite.slice(0, Math.max(0, max - finis.length))
  }
  return finis.slice(0, max)
}
// Le premier groupe d'accolades qui offre un choix (`{x}` seul n'en est pas un : ses accolades restent).
function premierGroupe(motif) {
  const c = [...motif]
  let profondeur = 0
  let ouvre = 0
  for (let i = 0; i < c.length; i++) {
    if (c[i] === '{') {
      if (profondeur === 0) ouvre = i
      profondeur++
    } else if (c[i] === '}' && profondeur > 0) {
      profondeur--
      if (profondeur > 0) continue
      const choix = alternatives(c.slice(ouvre + 1, i))
      if (choix.length < 2) continue
      return { tete: c.slice(0, ouvre).join(''), choix, queue: c.slice(i + 1).join('') }
    }
  }
  return null
}
function alternatives(dedans) {
  const parts = ['']
  let profondeur = 0
  for (const ch of dedans) {
    if (ch === '{') profondeur++
    else if (ch === '}') profondeur--
    else if (ch === ',' && profondeur === 0) {
      parts.push('')
      continue
    }
    parts[parts.length - 1] += ch
  }
  return parts
}

// Un motif tel que la règle le compare (owns.rs, owned_segments) : segments en minuscules ; un dossier finit par `**`.
export function segments(motif) {
  const n = String(motif).trim().replace(/\\/g, '/').toLowerCase()
  const s = n.split('/').filter((x) => x && x !== '.').slice(0, MAX_SEGMENTS)
  const dernier = s[s.length - 1]
  if (!dernier) return null
  const fichier = !n.endsWith('/') && [...dernier].some((ch, i) => ch === '.' && i > 0)
  if (!fichier && dernier !== '**') s.push('**')
  return s
}

// Un nom contre un segment de motif : `*`, `?`, `[…]` ; aucun ne traverse une barre (owns.rs, glob_matches).
export function joker(motif, nom) {
  const p = [...motif]
  const n = [...nom]
  const memo = new Map()
  const va = (i, j) => {
    const cle = i * (n.length + 1) + j
    if (memo.has(cle)) return memo.get(cle)
    let r
    if (i === p.length) r = j === n.length
    else if (p[i] === '*') r = va(i + 1, j) || (j < n.length && va(i, j + 1))
    else if (p[i] === '?') r = j < n.length && va(i + 1, j + 1)
    else if (p[i] === '[') {
      const cl = classe(p, i)
      r = cl ? j < n.length && cl.accepte(n[j]) && va(cl.fin, j + 1) : j < n.length && n[j] === '[' && va(i + 1, j + 1)
    } else r = j < n.length && n[j] === p[i] && va(i + 1, j + 1)
    memo.set(cle, r)
    return r
  }
  return va(0, 0)
}
function classe(p, debut) {
  let at = debut + 1
  const nie = p[at] === '!' || p[at] === '^'
  if (nie) at++
  const depart = at
  let ferme = -1
  for (let i = depart; i < p.length; i++) if (p[i] === ']' && i > depart) { ferme = i; break }
  if (ferme < 0) return null
  const membres = p.slice(depart, ferme)
  return {
    fin: ferme + 1,
    accepte: (ch) => {
      let trouve = false
      for (let i = 0; i < membres.length; ) {
        if (i + 2 < membres.length && membres[i + 1] === '-') {
          trouve ||= membres[i] <= ch && ch <= membres[i + 2]
          i += 3
        } else {
          trouve ||= membres[i] === ch
          i++
        }
      }
      return trouve !== nie
    },
  }
}

const JOKERS = /[*?[]/
// Ce qu'un segment à jokers fixe avant son premier joker et après son dernier (board.rs, fixed_ends).
function bouts(s) {
  const m = s.search(JOKERS)
  const premier = m < 0 ? s.length : m
  let dernier = s.length
  for (let i = s.length - 1; i >= 0; i--) if ('*?]'.includes(s[i])) { dernier = i + 1; break }
  dernier = Math.max(dernier, premier)
  return [s.slice(0, premier), s.slice(dernier)]
}
// Un nom peut-il être désigné par les deux segments ? (board.rs, segments_meet)
function segmentsSeRencontrent(a, b) {
  const ja = JOKERS.test(a), jb = JOKERS.test(b)
  if (!ja && !jb) return a === b
  if (ja && !jb) return joker(a, b)
  if (!ja && jb) return joker(b, a)
  const [ta, qa] = bouts(a), [tb, qb] = bouts(b)
  return (ta.startsWith(tb) || tb.startsWith(ta)) && (qa.endsWith(qb) || qb.endsWith(qa))
}
// Un chemin peut-il être désigné par les deux listes de segments, `**` valant tout nombre de segments ?
// (board.rs, sequences_meet, ici mémoïsé.)
function seRencontrent(a, b) {
  const memo = new Map()
  const va = (i, j) => {
    const cle = i * (b.length + 1) + j
    if (memo.has(cle)) return memo.get(cle)
    let r
    if (i === a.length && j === b.length) r = true
    else if (i < a.length && a[i] === '**') r = va(i + 1, j) || (j < b.length && va(i, j + 1))
    else if (j < b.length && b[j] === '**') r = va(i, j + 1) || (i < a.length && va(i + 1, j))
    else if (i < a.length && j < b.length) r = segmentsSeRencontrent(a[i], b[j]) && va(i + 1, j + 1)
    else r = false
    memo.set(cle, r)
    return r
  }
  return va(0, 0)
}
const lis = (motif) => accolades(motif).map(segments).filter(Boolean)

// Chaque paire de motifs, un de chaque liste, qu'un même chemin peut satisfaire (board.rs, owns_overlap). Au-delà de
// BUDGET_MS (`depuis` : début de la comparaison, pour un lancement qui compare plusieurs tâches), la paire en cours est
// tenue pour chevauchante : un refus vaut mieux qu'un serveur figé.
export function chevauchements(miens, leurs, depuis = Date.now()) {
  const eux = leurs.map((m) => [m, lis(m)])
  const paires = []
  for (const m of miens) {
    const nous = lis(m)
    for (const [l, s] of eux) {
      if (Date.now() - depuis > BUDGET_MS) return [...paires, [m.trim(), `${l.trim()} (comparaison trop longue : motifs trop complexes)`]]
      if (nous.some((x) => s.some((y) => seRencontrent(x, y)))) paires.push([m.trim(), l.trim()])
    }
  }
  return paires
}

// Le chemin (relatif à la racine du projet) est-il couvert par l'un des motifs ? (owns.rs, covers et matches_path, sans
// préfixe : le chemin est lu tel quel, un « * » dans un nom de fichier n'y est pas un joker.)
export function couvre(chemin, motifs) {
  const c = String(chemin).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  const correspond = (s) => {
    const memo = new Map()
    const va = (i, j) => {
      const cle = i * (c.length + 1) + j
      if (memo.has(cle)) return memo.get(cle)
      const r = i === s.length ? j === c.length : s[i] === '**' ? va(i + 1, j) || (j < c.length && va(i, j + 1)) : j < c.length && joker(s[i], c[j]) && va(i + 1, j + 1)
      memo.set(cle, r)
      return r
    }
    return va(0, 0)
  }
  return motifs.some((m) => lis(m).some(correspond))
}
