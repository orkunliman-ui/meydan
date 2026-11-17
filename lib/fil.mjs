// Fil d'une conversation d'agent, lu dans le journal que l'agent écrit lui-même : de quoi l'afficher comme une discussion
// (téléphone), sans rien changer à la façon dont l'agent tourne. Orkun, 10/11 : « Quand je suis sur le tel, j'aimerais
// bien avoir l'affichage comme d'un chatbox que j'ai sur l'appli claude ou chatgpt ».
// Lecture seule. Le format de ces journaux n'est pas documenté : tout ce qui n'est pas reconnu est ignoré, jamais deviné.
//
// Éléments du fil, du plus ancien au plus récent :
//   { r: 'toi', t }                         un message d'Orkun (ou de Meydan, pour un membre d'équipe)
//   { r: 'agent', t }                       un texte de l'agent
//   { r: 'outils', outils: [{ nom, quoi }], cree, modifie, plus, moins }   une suite d'outils, repliée
// Chacun porte aussi `at` (l'heure écrite au journal) et `n`, son numéro stable (`numero`, plus bas).
import fs from 'node:fs'
import path from 'node:path'

const MAX_LU = 16 << 20 // première lecture : la fin d'un gros journal seulement (une capture jointe pèse plus d'un Mo)
const MAX_FIL = 150
const MAX_TEXTE = 8000
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/
const coupe = (s, n = MAX_TEXTE) => (s.length > n ? `${s.slice(0, n)}\n[…]` : s)
const court = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const lignes = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0)

// ── Où est le journal ──
// Claude Code : `<projets>/<dossier>/<conversation>.jsonl`. null s'il n'existe pas.
export function journalClaude(projets, agent) {
  if (!ID.test(String(agent ?? ''))) return null
  let dossiers = []
  try {
    dossiers = fs.readdirSync(projets)
  } catch {
    return null
  }
  for (const d of dossiers) {
    const f = path.join(projets, d, `${agent}.jsonl`)
    try {
      if (fs.statSync(f).isFile()) return f
    } catch {} // pas dans ce dossier
  }
  return null
}
// Codex : `<sessions>/<année>/<mois>/<jour>/rollout-<date>-<conversation>.jsonl`.
export function journalCodex(sessions, agent) {
  if (!ID.test(String(agent ?? ''))) return null
  try {
    const nom = fs.readdirSync(sessions, { recursive: true }).find((n) => String(n).endsWith(`-${agent}.jsonl`))
    return nom ? path.join(sessions, String(nom)) : null
  } catch {
    return null
  }
}

// ── Ce que les deux journaux ont en commun ──
// Un message d'Orkun, ou un texte que l'agent glisse lui-même dans la conversation (rappels, contexte, consignes du
// projet, sorties de commandes locales) ? Ces derniers commencent par une balise ou un titre connu : pas montrés.
const interne = (t) => /^\s*<[a-z][a-z0-9_-]*[ >]/i.test(t) || t.startsWith('[Request interrupted') || t.startsWith('Caveat:') || t.startsWith('# AGENTS.md instructions')
// Un texte collé (Meydan colle chaque message) : Claude Code 2.1.322 l'enveloppe dans <pasted_content id="…"> quand il a
// plusieurs lignes (relevé le 11/11 dans les journaux d'Orkun : « texte + Pièces jointes : », envoyé de la barre). C'est
// bien un message d'Orkun : sans l'enveloppe ; avec, il passait pour un texte interne et n'apparaissait jamais.
const deballe = (t) => t.replace(/<pasted_content id="[^"\n]*">\n?|\n?<\/pasted_content id="[^"\n]*">/g, '')
const MAX_RECUS = 300
// Le numéro d'un élément (17/11, chasse, défaut 6) : la place, en octets, de la ligne du journal qui l'a fait naître (+1
// pour un second élément né de la même ligne : une ligne qui en donne k pèse plus de k octets, le numéro reste avant celui
// de la ligne suivante). Il ne dépend que du fichier : le même à chaque relecture, après un redémarrage du moteur, et
// quand la lecture part du milieu d'un gros journal. La discussion s'en sert comme clé : avec le rang dans la fenêtre des
// 150 derniers, chaque nouveau message décalait toutes les bulles d'un cran et le texte relu plus haut glissait.
const numero = (etat) => (etat.n = Math.max(etat.ligne, etat.n + 1))
const texte = (etat, r, t, at) => {
  etat.groupe = null
  const x = { r, t: coupe(t.trim()), at: at || '', n: numero(etat) }
  etat.fil.push(x)
  if (r !== 'toi') return
  etat.recus.push(x)
  if (etat.recus.length > MAX_RECUS * 2) etat.recus = etat.recus.slice(-MAX_RECUS)
}
const outil = (etat, at, nom, quoi, e) => {
  if (!etat.groupe) {
    etat.groupe = { r: 'outils', outils: [], cree: 0, modifie: 0, plus: 0, moins: 0, at: at || '', n: numero(etat) }
    etat.fil.push(etat.groupe)
  }
  etat.groupe.outils.push({ nom: String(nom).slice(0, 60), quoi: court(quoi) })
  if (e) for (const k of ['cree', 'modifie', 'plus', 'moins']) etat.groupe[k] += e[k] || 0
}

// ── Claude Code ──
function ajouteClaude(etat, j) {
  if (j.isSidechain || j.isMeta || (j.type !== 'user' && j.type !== 'assistant')) return
  const contenu = j.message?.content
  const blocs = typeof contenu === 'string' ? [{ type: 'text', text: contenu }] : Array.isArray(contenu) ? contenu : []
  for (const b of blocs) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      const t = j.type === 'user' ? deballe(b.text) : b.text
      if (j.type === 'user' && (interne(t) || !t.trim())) continue
      texte(etat, j.type === 'user' ? 'toi' : 'agent', t, j.timestamp)
    } else if (b.type === 'image' && j.type === 'user') {
      texte(etat, 'toi', '[image jointe]', j.timestamp)
    } else if (b.type === 'tool_use' && j.type === 'assistant' && typeof b.name === 'string') {
      const e = b.input || {}
      const quoi = [e.command, e.file_path, e.path, e.pattern, e.query, e.url, e.description, e.prompt, e.skill].find((x) => typeof x === 'string' && x)
      const ecrit = b.name === 'Write' ? { cree: 1, plus: lignes(e.content) } : b.name === 'Edit' ? { modifie: 1, plus: lignes(e.new_string), moins: lignes(e.old_string) } : null
      outil(etat, j.timestamp, b.name.replace(/^mcp__/, '').replace(/__/g, ' · '), quoi, ecrit)
    }
  }
}

// ── Codex ──
// Un appel d'outil de Codex est un petit programme qui enchaîne `tools.exec_command({cmd:"…"})` et
// `tools.apply_patch("*** Begin Patch…")` : chaque commande et chaque modification devient une ligne.
const CHAINE = '("(?:[^"\\\\]|\\\\.)*")'
const lit = (s) => {
  try {
    return String(JSON.parse(s))
  } catch {
    return ''
  }
}
function ajouteCodex(etat, j) {
  if (j.type !== 'response_item') return
  const p = j.payload || {}
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    for (const b of Array.isArray(p.content) ? p.content : []) {
      if (!b || typeof b !== 'object') continue
      if (typeof b.text === 'string' && b.text.trim()) {
        if (p.role === 'user' && interne(b.text)) continue
        texte(etat, p.role === 'user' ? 'toi' : 'agent', b.text, j.timestamp)
      } else if (p.role === 'user' && String(b.type).includes('image')) {
        texte(etat, 'toi', '[image jointe]', j.timestamp)
      }
    }
  } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
    const source = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : ''
    let vu = 0
    for (const m of source.matchAll(new RegExp(`tools\\.(exec_command\\(\\{\\s*cmd:\\s*|apply_patch\\()${CHAINE}`, 'g'))) {
      vu++
      const valeur = lit(m[2])
      if (m[1].startsWith('exec_command')) outil(etat, j.timestamp, 'commande', valeur)
      else {
        const ls = valeur.split('\n')
        const fichiers = ls.filter((l) => /^\*\*\* (Add|Update|Delete) File: /.test(l)).map((l) => path.basename(l.replace(/^\*\*\* \w+ File: /, '')))
        outil(etat, j.timestamp, 'modification', fichiers.join(', '), {
          cree: ls.filter((l) => l.startsWith('*** Add File: ')).length,
          modifie: ls.filter((l) => l.startsWith('*** Update File: ')).length,
          plus: ls.filter((l) => l.startsWith('+')).length,
          moins: ls.filter((l) => l.startsWith('-')).length,
        })
      }
    }
    if (!vu) outil(etat, j.timestamp, p.name || 'outil', source)
  }
}

// ── Lecture qui suit le journal ──
// La première fois, sa fin (16 Mo au plus) ; ensuite seulement ce qui s'y est ajouté. Une ligne pas encore finie d'écrire
// attend la lecture suivante. Si le fichier a rétréci (remplacé), on repart de zéro. Les 150 derniers éléments sont rendus.
function morceau(file, de, a) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(a - de)
    fs.readSync(fd, buf, 0, buf.length, de)
    return buf
  } finally {
    fs.closeSync(fd)
  }
}
const AJOUTE = { claude: ajouteClaude, codex: ajouteCodex }
const suivis = new Map()
export function lireFil(kind, file) {
  const ajoute = AJOUTE[kind]
  if (!ajoute) return []
  const { size } = fs.statSync(file)
  let s = suivis.get(file)
  if (!s || size < s.pos) {
    const de = Math.max(0, size - MAX_LU)
    s = { pos: de, reste: Buffer.alloc(0), saute: de > 0, fil: [], recus: [], groupe: null, ligne: 0, n: -1 }
    if (suivis.size > 50) suivis.clear()
    suivis.set(file, s)
  }
  if (size > s.pos) {
    const debut = s.pos - s.reste.length // place, dans le fichier, du premier octet de `lu`
    const lu = Buffer.concat([s.reste, morceau(file, s.pos, size)])
    s.pos = size
    const dernier = lu.lastIndexOf(0x0a)
    s.reste = lu.subarray(dernier + 1) // ligne en cours d'écriture
    // Ligne par ligne sur les octets, pas sur le texte décodé (un accent en pèse deux) : la place de chaque ligne dans le
    // fichier fait le numéro de ses éléments.
    for (let de = 0; de <= dernier; ) {
      const fin = lu.indexOf(0x0a, de)
      s.ligne = debut + de
      const ligne = lu.toString('utf8', de, fin)
      de = fin + 1
      if (s.saute) {
        s.saute = false // lecture partie du milieu du fichier : la première ligne est coupée
        continue
      }
      if (!ligne) continue
      let j
      try {
        j = JSON.parse(ligne)
      } catch {
        continue // ligne illisible
      }
      if (j && typeof j === 'object') ajoute(s, j)
    }
    if (s.fil.length > MAX_FIL * 2) s.fil = s.fil.slice(-MAX_FIL)
  }
  return s.fil.slice(-MAX_FIL)
}
// Les messages reçus par l'agent (`r: 'toi'`), du plus ancien au plus récent, hors de la fenêtre du fil : une longue
// mission remplit les 150 éléments d'outils et de textes, et son premier message (la consigne de départ) en sort. Sert à
// savoir si un message de Meydan est déjà arrivé (server.mjs, flush ; 13/11).
export function recus(kind, file) {
  lireFil(kind, file)
  return suivis.get(file)?.recus || []
}

// ── En direct ──
// Ce que l'agent fait à l'instant, lu sur son ÉCRAN de terminal : le mot de son indicateur (« Cogitating », « Working »),
// le temps écoulé, les jetons, et le texte qu'il est en train d'écrire, avant que ce texte n'arrive entier dans le
// journal. Orkun, 10/11 : la discussion « n'a pas l'air vivante ». C'est la lecture d'un écran fait pour des yeux : au
// mieux, jamais une source de vérité. Rien de reconnu → null ; le fil du journal reste seul à faire foi.
const ECRANS = {
  // Claude Code : « ✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt) », textes et outils en « ● », résultats en « ⎿ ».
  claude: { indicateur: /^\s*[✻✢✶✽✳✺·*∗+]\s+(\p{L}[\p{L} -]{1,30})…\s*(?:\((.*)\))?\s*$/u, puce: '● ', outil: /^● [\p{L}_][\p{L}\p{N}_ .:·-]*\(/u, stop: /^(❯|  ⎿|[─━]{6})/ },
  // Codex : « ◦ Working (59s • esc to interrupt) », textes et outils en « • », demandes en « › ».
  codex: { indicateur: /^\s*[◦•]\s+(\p{L}[\p{L} -]{1,30})\s*\((.*)\)\s*$/u, puce: '• ', outil: /^• (Ran|Edited|Explored|Read|Updated|Called|Searched|Added|Deleted|Proposed|Viewed|Listed|Worked)\b/, stop: /^(›|  └|[─━]{6})/, saisie: /^› / },
}
const nu = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
export function direct(kind, ecran, fil = []) {
  const e = ECRANS[kind]
  if (!e || typeof ecran !== 'string') return null
  const ls = ecran.split('\n').map((l) => l.replace(/\s+$/, ''))
  let i = ls.length - 1
  while (i >= 0 && !e.indicateur.test(ls[i])) i--
  let verbe = ''
  let details = ''
  if (i >= 0) [, verbe, details = ''] = e.indicateur.exec(ls[i])
  else if (e.saisie) {
    // Pas d'indicateur : Codex le retire quand il se met à écrire sa réponse. Le texte en cours est alors le dernier bloc
    // au-dessus de son champ de saisie.
    i = ls.length - 1
    while (i >= 0 && !e.saisie.test(ls[i])) i--
  }
  if (i < 0) return null
  const morceaux = details.split(/\s+[·•]\s+/)
  const duree = morceaux.find((m) => /^\d+\s?(s|m\b|m\s?\d+s|min)/.test(m)) || ''
  const jetons = morceaux.find((m) => /tokens?/.test(m)) || ''
  // Le texte en cours : le dernier bloc à puce juste au-dessus de l'indicateur, s'il n'est ni un outil ni déjà au journal.
  const bloc = []
  let texte = ''
  let partiel = false
  const sansRetrait = (x) => x.replace(/^ {1,2}/, '')
  let j = i - 1
  for (; j >= 0 && i - j < 400; j--) {
    const l = ls[j]
    if (e.stop.test(l)) break
    if (l.startsWith(e.puce)) {
      if (!e.outil.test(l)) texte = [l.slice(e.puce.length), ...bloc.reverse().map(sansRetrait)].join('\n').trim()
      break
    }
    bloc.push(l)
  }
  // Codex écrit sa réponse sur un écran sans historique : quand elle dépasse sa hauteur, le début (et sa puce) sort par le
  // haut. Ce qui reste visible est alors la FIN du texte en cours : on la rend comme telle (`partiel`), l'écran de la
  // discussion la recolle à ce qu'il avait déjà.
  // Vu en vrai (console de 30 lignes, réponse de trente phrases) : Codex garde la demande d'Orkun épinglée en haut et
  // fait défiler sa réponse dessous ; la première ligne, avec sa puce, disparaît. On s'arrête donc soit en haut de
  // l'écran, soit sur cette demande épinglée, sans avoir trouvé de puce.
  if (!texte && !verbe && e.saisie && (j < 0 || e.saisie.test(ls[j])) && bloc.some((l) => l.trim()) && !bloc.some((l) => /^\s*(>_ |[╭│╰])/.test(l))) {
    texte = bloc.reverse().map(sansRetrait).join('\n').trim()
    partiel = true
  }
  texte = texte.replace(/\n+Worked for \d[^\n]*$/, '').trim() // la ligne de fin de tour n'est pas du texte
  if (texte) {
    const debut = nu(texte).slice(0, 80)
    const dernier = [...fil].reverse().find((x) => x.r === 'agent')
    if (!debut || (dernier && nu(dernier.t).includes(debut))) texte = '' // déjà écrit en entier dans le journal
  }
  if (!verbe && !texte) return null
  return { verbe: verbe.trim(), duree, jetons: jetons.replace(/\s*tokens?/, '').trim(), texte: coupe(texte, 6000), ...(partiel ? { partiel } : {}) }
}
