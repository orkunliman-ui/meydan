// La barre de commande : un ordre tapé (ou dicté) en français, compris SANS modèle de langue, montré avant d'être
// exécuté. C'est l'écart « barre de commande, ordres tapés (spawn 3 claude) » avec Symvibe (docs/specs/2026-11-10-ecart-
// symvibe.md) ; Orkun, 11/11 : « Ok continue ». Deuxième vague (13/11, « On est encore loin de toutes les
// fonctionnalitēs de Symvibe ») : questions d'état, @mentions, texte risqué, confirmation liée à ce qui est montré, plan
// du planificateur validé ici (contrat : docs/specs/2026-11-13-ordres-contrat.md, §1).
//
// Ordres compris (le verbe d'abord, ses variantes et quelques mots anglais) :
//   lance 3 claude dans meydan : relis tasks/todo.md     → trois consoles Claude, chacune reçoit la consigne
//   ouvre un shell                                        → un shell dans ~
//   dis à tous : faites le point                          → le message à chaque agent (remis dès qu'il est au repos)
//   envoie aux codex : …   /   dis à api de …           → par type, par nom ou sujet de console, par état
//   @site relis le README  /  @site @api faites le point  → « dis à … » ; « @slug » exact = cette console seule
//   interromps tout   /   stop les claude                 → Échap aux agents qui travaillent, Ctrl C aux shells occupés
//   ferme les shells  /   ferme les finies                → à confirmer (ce qui tourne dedans s'arrête)
//   relance les finies   /   relance site                → rouvre les consoles terminées
//   qui a fini ?  /  qui m'attend ?  /  où en est site ?  /  statut   → questions d'état, répondues sans modèle
// Cibles : « tous / tout / tout le monde », « les claude / codex / shells », « ceux qui attendent / travaillent / sont
// prêts », « les finies », des @mentions, sinon un morceau du nom ou du sujet d'une console (« api », « page contact »).
//
// `comprendre` ne touche à rien : elle rend le plan, que le serveur exécute seulement sur demande.
import { createHash } from 'node:crypto'
import { plat, mentions } from '../web/src/mention.js'
import { nettoie } from './memoire.mjs'
// « T'ATTEND » et les durées exactement comme à l'écran. web/src/lib.js s'importe sans navigateur (vérifié le 13/11 :
// rien de propre au navigateur ne s'y exécute au chargement) ; il charge `react`, déjà installé pour l'interface.
import { appelAVoir, equipeAttend, pretAVoir, since, VERBE } from '../web/src/lib.js'

export { plat }

const NOMBRES = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6 }
export const MAX_LANCER = 6
export const MAX_ACTIONS = 8 // étapes d'un plan du planificateur
// L'apostrophe de l'iPhone (’) et ses cousines valent « ' » pour comprendre (même longueur : les positions tiennent).
const pl = (s) => plat(s).replace(/[’‘ʼ´]/g, "'")
const VERBES = [
  ['relancer', /^(?:relance[rz]?|redemarre[rz]?|rouvre|rouvrir|restart)\b/],
  ['lancer', /^(?:lance[rz]?|ouvre|ouvrir|demarre[rz]?|cree[rz]?|start|spawn|open)\b/],
  ['envoyer', /^(?:dis|dites|dire|envoie[rz]?|ecris|ecrire|demande[rz]?|transmets|transmettre|send|tell)\b/],
  ['interrompre', /^(?:interromps|interrompt|interrompre|stoppe[rz]?|stop|arrete[rz]?|pause)\b/],
  ['fermer', /^(?:ferme[rz]?|tue[rz]?|supprime[rz]?|close|kill)\b/],
]
export const EXEMPLES = ['lance 2 claude dans meydan : relis tasks/todo.md', 'dis à tous : faites le point en trois lignes', 'interromps tout', 'ferme les shells', 'qui a fini ?']

// Un nom de console peut venir d'un agent (équipier, relais) : invisibles et inversions de direction retirés avant de
// l'afficher dans un résumé (relecture de sécurité du 13/11 : « Équipier · …etis » s'affichait « site »).
const etiquette = (c) => nettoie(String(c.name ?? ''))
// `tous` : chaque nom (fermer : Orkun voit exactement ce qui s'arrête).
const liste = (cs, tous = false) => (tous || cs.length <= 4 ? cs.map(etiquette).join(', ') : `${cs.slice(0, 3).map(etiquette).join(', ')} et ${cs.length - 3} autres`)
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`
const AGENT = (c) => c.kind !== 'shell'
const ids = (cs) => cs.map((c) => c.id)

// Les consoles que désigne `spec` (sans le verbe). Rend { cs, quoi } ; `quoi` dit comment on les a reconnues.
export function cibles(spec, consoles) {
  let s = plat(spec).replace(/[.!?]+$/, '').trim()
  s = s.replace(/^(?:a|au|aux)\s+/, '')
  if (/^(?:tous|tout|toutes|tout le monde|tous les agents|toutes les consoles|les agents|les consoles|everyone|all|everything)$/.test(s)) return { cs: consoles, quoi: 'toutes', vide: 'Aucune console.' }
  const type = s.match(/^(?:les |tous les |toutes les |la |le |l')?(claude|codex|shell|terminal|terminaux)s?$/)
  if (type) {
    const kind = type[1] === 'claude' || type[1] === 'codex' ? type[1] : 'shell'
    return { cs: consoles.filter((c) => c.kind === kind), quoi: `les ${kind === 'shell' ? 'shells' : kind}`, vide: `Aucune console ${kind === 'shell' ? 'shell' : kind}.` }
  }
  const etat = s.match(/^(?:ceux|celles|les consoles|les agents)?\s*qui\s+(attendent|travaillent|sont prets|sont pretes|sont au repos)$/)
  if (etat) {
    const st = { attendent: ['needs'], travaillent: ['working', 'running'], 'sont prets': ['ready', 'shell'], 'sont pretes': ['ready', 'shell'], 'sont au repos': ['ready', 'shell'] }[etat[1]]
    const qui = `qui ${etat[1].replace('prets', 'prêtes').replace('pretes', 'prêtes')}`
    return { cs: consoles.filter((c) => st.includes(c.status)), quoi: `celles ${qui}`, vide: `Aucune console ${qui}.` }
  }
  if (/^(?:les |celles |ceux )?(?:finies|finis|terminees|termines|fermees|fermes|mortes)$/.test(s)) return { cs: consoles.filter((c) => c.status === 'closed'), quoi: 'les terminées', vide: 'Aucune console terminée.' }
  // Un morceau du nom ou du sujet : « la console site », « api », « page contact ».
  const nom = s.replace(/^(?:la |le |les |l')?(?:consoles? |agents? )?/, '').replace(/^(?:la |le |l')/, '').trim()
  if (!nom) return { cs: [], quoi: '' }
  const mots = nom.split(/\s+/)
  const trouve = (c) => {
    const t = `${plat(c.name)} ${plat(typeof c.sujet === 'string' ? c.sujet : '')}`
    return mots.every((m) => t.includes(m))
  }
  return { cs: consoles.filter(trouve), quoi: `« ${spec.trim()} »`, vide: `Aucune console ne correspond à « ${spec.trim()} ».` }
}

// ── @mentions ──
// « @site @api : faites le point » → jetons ['site', 'api'], reste « faites le point ». Mentions en tête seulement.
const MENTION = /^@([\p{L}\p{N}_.-]+)[\s,;:]*/u
function enTete(s) {
  const jetons = []
  let r = s
  for (let m; (m = MENTION.exec(r)); ) {
    jetons.push(m[1].replace(/[._-]+$/, ''))
    r = r.slice(m[0].length).replace(/^et\s+(?=@)/i, '')
  }
  return { jetons, reste: r.trim() }
}
// Chaque mention : le slug exact d'une console (web/src/mention.js) = cette console seule ; sinon un morceau de nom ou de
// sujet, un type, « tous »… comme `cibles` (« - » lu comme une espace). Une mention qui ne désigne rien : erreur.
function parMentions(jetons, consoles) {
  const ms = mentions(consoles)
  const pris = new Set()
  const exactes = []
  for (const j of jetons) {
    const m = ms.find((x) => x.slug === plat(j))
    if (m) {
      pris.add(m.id)
      exactes.push(consoles.find((c) => c.id === m.id))
      continue
    }
    const { cs } = cibles(j.replace(/-/g, ' '), consoles)
    if (!cs.length) return { erreur: `Aucune console ne correspond à « @${j} ».` }
    for (const c of cs) pris.add(c.id)
  }
  const quoi = jetons.map((j) => `@${j}`).join(' ')
  return { cs: consoles.filter((c) => pris.has(c.id)), exactes, quoi, vide: `Aucune console ne correspond à ${quoi}.` }
}
// Des @mentions seules (« @site @api ») ou une phrase (« la page contact »).
function designe(spec, consoles) {
  const { jetons, reste } = enTete(spec.trim())
  return jetons.length && !reste ? parMentions(jetons, consoles) : cibles(spec, consoles)
}

// ── Texte risqué ──
// Ce qui, dans un message ou une consigne, fait faire à un agent quelque chose de grave : le plan se confirme alors en
// citant le passage. Pas un filtre (rien n'est refusé) : une alerte, pour qu'Orkun relise avant d'envoyer.
// Ne nettoie pas : `comprendre` et `depuisActions` lui passent le texte déjà débarrassé des invisibles (`nettoie`), qui
// est aussi celui qui part (un « sudo » coupé par une espace de largeur nulle est vu).
// Préfixe de git : options avant la sous-commande (« git -C ~/site push -f », « git --no-pager reset --hard »).
const GIT = String.raw`\bgit\b(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+`
// Ce qui suit un « | » : un shell ou un interprète, éventuellement par sudo, par son chemin ou par env.
const BIN = String.raw`(?:\/(?:usr\/)?(?:local\/)?bin\/)?`
const VERS_SHELL = String.raw`\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?${BIN}(?:env\s+(?:-\S+\s+)*)?${BIN}(?:(?:ba|z|da|k|fi)?sh|python[\d.]*|perl|ruby|node)\b`
// rm : drapeaux récursif et forcé, où qu'ils soient (-rf, -fr, -Rf, -rfv, -r -f, --recursive --force, « rm x -rf »).
const RM = /\brm\s+([^\n;&|]*)/gi
const recursif = (m) => /(?:^|\s)(?:-[a-z]*r|--recursive\b)/i.test(m[1])
const force = (m) => /(?:^|\s)(?:-[a-z]*f|--force\b)/i.test(m[1])
const MOTIFS = [
  ['rm -rf', RM, (m) => recursif(m) && force(m)],
  ['rm -r', RM, (m) => recursif(m) && !force(m)], // récursif sans -f : tout un dossier quand même
  // Les motifs « mot-clé, puis plus loin sur la ligne » s'arrêtent au mot-clé suivant (`(?!…)`) : sans cela chaque occurrence
  // parcourait toute la ligne, temps quadratique (« find » × 4 000 : 30 ms ; « dd » : 49 ms ; relecture du 17/11).
  ['find -delete', /\bfind\b(?:(?!\bfind\b)[^\n;&|])*?\s-delete\b/gi],
  ['sudo', /\bsudo\b/gi],
  ['curl | sh', new RegExp(String.raw`\b(?:curl|wget)\b(?:(?!\b(?:curl|wget)\b)[^\n;])*?${VERS_SHELL}|\b(?:ba|z|da|k)?sh\s+(?:-c\s+)?["']?(?:\$\(|<\()\s*(?:curl|wget)\b`, 'gi')],
  // .env, .env.local, config/.env ; pas process.env, .envoyer, environment.
  ['.env', /(?<![\w.-])\.env(?:\.[\w-]+)*(?![\w-])/gi],
  // Fichiers de secrets : clés SSH, identifiants de Claude, clé d'accès de Meydan, certificats et clés .pem.
  ['fichier secret', /(?:~|\$HOME|\/home\/[\w.-]+|\/root)\/\.ssh\b\S*|\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)|(?<![\w-])\.credentials\.json\b|\baccess\.key\b|(?<![\w.-])[.-]*\b[\w.-]+?\.pem\b/gi], // .pem : départ en tête de suite (sinon quadratique : 300 ms)
  // « --dangerously… » ; l'iPhone remplace « -- » par un tiret long (— ou –).
  ['--dangerously…', /(?:--|[—–])dangerously[\w-]*/gi],
  ['--yolo', /(?:--|[—–])yolo\b/gi],
  ['git push --force', new RegExp(String.raw`${GIT}push\b(?:(?!\bgit\b)[^\n;&|])*?\s(?:--force(?:-with-lease|-if-includes)?|-f|\+[\w./-]+)(?![\w-])`, 'gi')],
  ['git reset --hard', new RegExp(String.raw`${GIT}reset\b(?:(?!\bgit\b)[^\n;&|])*?\s--hard\b`, 'gi')],
  // 777 (et 0777, 1777…), ou des droits pour tout le monde (a+rwx, o+w).
  ['chmod 777', /\bchmod\s+(?:-[a-z]+\s+)*(?:[0-7]?777\b|(?:a|o|go|ugo)[+=]rwx\b|o\+w\b)/gi],
  ['mkfs', /\bmkfs\b/gi],
  ['dd of=/dev', /\bdd\b(?:(?!\bdd\b)[^\n;&|])*?\bof=\/dev\//gi],
  // Le nom commence au début d'un mot (lookbehind) : sans lui, un long mot (20 000 caractères de base64 collés dans la barre
  // d'envoi) faisait essayer chaque position, temps quadratique (330 ms ; lot sécurité du 17/11).
  ['bombe fork', /(?<![\w:])([\w:]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/g],
]
const PASSAGE = 60
// L'extrait du texte d'origine autour du motif (60 caractères au plus, le motif au milieu ; un motif plus long que 60 :
// son début). Sous-chaîne exacte, sans mot coupé aux bords quand c'est possible, bords nettoyés (blancs, moitié de
// caractère coupée).
function passage(t, debut, fin) {
  let a = fin - debut >= PASSAGE ? debut : Math.max(0, Math.min(debut - Math.floor((PASSAGE - (fin - debut)) / 2), t.length - PASSAGE))
  let b = Math.min(t.length, a + PASSAGE)
  if (a > 0 && /\S/.test(t[a - 1])) {
    const s = t.slice(a, debut).search(/\s/)
    if (s >= 0) a += s + 1
  }
  if (b < t.length && /\S/.test(t[b]) && b > fin) {
    const s = t.slice(fin, b).search(/\s\S*$/)
    if (s >= 0) b = fin + s
  }
  return t.slice(a, b).replace(/\p{Cs}/gu, '').trim()
}
export function risques(texte) {
  const t = String(texte ?? '')
  const vus = new Set()
  const out = []
  for (const [motif, re, garde] of MOTIFS) {
    for (const m of t.matchAll(re)) {
      if (garde && !garde(m)) continue
      const p = passage(t, m.index, m.index + m[0].length)
      if (!vus.has(motif + p) && vus.add(motif + p)) out.push({ motif, passage: p, i: m.index })
    }
  }
  return out.sort((a, b) => a.i - b.i).slice(0, 12).map(({ motif, passage: p }) => ({ motif, passage: p }))
}

// ── Confirmation liée à ce qui est montré ──
// Empreinte de ce que l'écran montre : un plan recalculé qui a changé (autres cibles, autre texte) ne passe plus avec
// l'ancienne. Le serveur ajoute ensuite `cwd` à un « lance » : hors de l'empreinte.
const montre = (p) => [p.ordre, p.question ?? '', p.cibles ?? [], p.message ?? '', p.consigne ?? '', p.kind ?? '', p.n ?? 0, p.dossier ?? '', (p.risques ?? []).map((r) => r.passage), p.ajoute ? 1 : 0]
const empreinte = (p) => createHash('sha1').update(JSON.stringify(p.ordre === 'plusieurs' ? [p.ordre, p.actions.map(montre)] : montre(p))).digest('hex').slice(0, 12)
// Dernière étape de chaque plan : un texte risqué le fait confirmer ; un plan à confirmer porte son empreinte.
function scelle(plan, texte = '') {
  const r = risques(texte)
  if (r.length) Object.assign(plan, { risques: r, confirmer: true })
  if (plan.confirmer) plan.confirmation = empreinte(plan)
  return plan
}
// Le plan peut-il partir avec ce `confirme` ? L'empreinte montrée, toujours. `true` (ancienne forme, celle du smoke
// « ferme … ») seulement pour un plan sans texte risqué et qui ne vient pas du planificateur (même règle que
// lib/ordres-serveur.mjs). Un plan qui n'est pas à confirmer passe.
export function confirmationValide(plan, confirme) {
  if (!plan?.confirmer) return true
  if (typeof confirme === 'string' && confirme === plan.confirmation) return true
  return confirme === true && !plan.risques?.length && plan.ordre !== 'plusieurs'
}

// ── Construction des plans (partagée par `comprendre` et `depuisActions`) ──
// Le type d'un mot (« claude », « codex », un libellé, « terminal » = shell), ou null.
function trouveKind(mot, kinds) {
  const noms = Object.keys(kinds)
  return noms.find((k) => k === mot || plat(kinds[k]?.label || '') === mot) ?? (['terminal', 'terminaux', 'console'].includes(mot) && noms.includes('shell') ? 'shell' : null)
}
function planLancer(kind, n, dossier, consigne, kinds) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LANCER) return { erreur: `De 1 à ${MAX_LANCER} consoles à la fois.` }
  if (kind === 'shell' && consigne) return { erreur: 'Un shell ne reçoit pas de consigne : il exécuterait le texte comme une commande.' }
  const label = kinds[kind]?.label || kind
  return scelle({ ordre: 'lancer', kind, n, dossier, consigne, resume: `Lancer ${n === 1 ? 'un' : n} ${label} dans ${dossier}${consigne ? `, avec la consigne « ${consigne} »` : ''}` }, consigne)
}
// `relancees` (planificateur) : consoles terminées qu'une étape PLUS TÔT du même plan relance ; le serveur exécute dans
// l'ordre, le message attend leur retour au repos.
function planEnvoyer(message, cs, quoi, vide, relancees = new Set()) {
  const vivants = cs.filter((c) => AGENT(c) && (c.status !== 'closed' || relancees.has(c.id)))
  if (!vivants.length) return { erreur: cs.length ? `Aucun agent vivant parmi ${quoi} (un shell ne reçoit pas de message : il l'exécuterait).` : vide || 'Aucune console ne correspond.' }
  const apres = vivants.some((c) => c.status === 'closed') ? ' sera au repos, après la relance' : ' est au repos'
  return scelle({ ordre: 'envoyer', message, cibles: ids(vivants), resume: `Envoyer « ${message} » à ${pluriel(vivants.length, 'agent')} : ${liste(vivants)} — remis à chacun dès qu'il${apres}` }, message)
}
// Un message vers des consoles désignées (phrase ou @mentions). Une console nommée exactement par sa mention n'est
// jamais écartée en silence : un shell (il exécuterait le texte) ou une console terminée font une erreur.
function versAgents(message, d) {
  const shell = d.exactes?.find((c) => !AGENT(c))
  if (shell) return { erreur: `« ${etiquette(shell)} » est un shell : il exécuterait le texte comme une commande. Les messages vont aux agents.` }
  const finie = d.exactes?.find((c) => c.status === 'closed')
  if (finie) return { erreur: `« ${etiquette(finie)} » est terminée : relance-la d'abord.` }
  return planEnvoyer(message, d.cs, d.quoi, d.vide)
}
function planCibles(ordre, cs, quoi, vide) {
  if (!cs.length) return { erreur: vide || 'Aucune console ne correspond.' }
  if (ordre === 'interrompre') {
    const occupees = cs.filter((c) => ['working', 'running'].includes(c.status))
    if (!occupees.length) return { erreur: `Rien à interrompre : aucune console ne travaille parmi ${quoi}.` }
    return { ordre, cibles: ids(occupees), resume: `Interrompre ${pluriel(occupees.length, 'console')} : ${liste(occupees)}` }
  }
  if (ordre === 'relancer') {
    const finies = cs.filter((c) => c.status === 'closed')
    if (!finies.length) return { erreur: `Rien à relancer : aucune console terminée parmi ${quoi}.` }
    // Brief du volet (13/11) : « fermer / relancer confirmé deux fois » — relancer rouvre des agents sur leur conversation.
    return scelle({ ordre, cibles: ids(finies), confirmer: true, resume: `Relancer ${pluriel(finies.length, 'console')} : ${liste(finies, true)}` })
  }
  // fermer : jamais un capitaine (on arrête son équipe entière, depuis la liste).
  const fermables = cs.filter((c) => !c.chief)
  if (!fermables.length) return { erreur: 'C’est un capitaine d’équipe : arrête l’équipe entière depuis la liste.' }
  const capitaines = cs.length - fermables.length
  return scelle({
    ordre,
    cibles: ids(fermables),
    confirmer: true,
    resume: `Fermer ${pluriel(fermables.length, 'console')} : ${liste(fermables, true)} — ce qui tourne dedans s'arrête${capitaines ? ` (${pluriel(capitaines, 'capitaine')} laissé${capitaines > 1 ? 's' : ''} : on arrête son équipe depuis la liste)` : ''}`,
  })
}
const RESUMES = { finies: 'Question : qui a fini ?', attendent: 'Question : qui t’attend ?', statut: 'Question : où en sont les consoles ?' }
function planQuestion(question, cs = []) {
  if (question !== 'ou') return { ordre: 'question', question, resume: RESUMES[question] }
  return { ordre: 'question', question, cibles: ids(cs), resume: `Question : où en ${cs.length > 1 ? 'sont' : 'est'} ${liste(cs)} ?` }
}

// ── Questions d'état (jamais à confirmer) ──
// Sur la phrase entière, sans accents ni casse, « ? » final permis. « point » seul est une question ; « fais le point »
// n'en est pas une (c'est un message à donner aux agents).
const QUESTIONS = [
  ['statut', /^(?:statut|status|etat|point|le point|etat general|statut general|etat des lieux|ou en est tout le monde|ou en sont les consoles|overview)$/],
  ['finies', /^(?:qui (?:a|ont|est|sont) (?:fini|finie|finis|finies|termine|terminee|termines|terminees)|who(?: has| is|'s)? (?:finished|done))$/],
  ['attendent', /^(?:qui (?:m'|m |me |nous |t')?attend(?:ent)?|qui est en attente|who(?: is|'s)? waiting(?: for me)?|whos waiting|who waits)$/],
]
const OU = /^(?:ou en (?:est|sont)|statut (?:de |d')|status of|etat (?:de |d')|where is|where's)\s*(.+)$/d
function question(texte, t, consoles) {
  const q = t.replace(/[\s?!.]+$/, '')
  const qui = QUESTIONS.find(([, re]) => re.test(q))
  if (qui) return planQuestion(qui[0])
  const m = OU.exec(q)
  if (!m) return null
  const d = designe(texte.slice(m.indices[1][0]).replace(/[\s?!.]+$/, ''), consoles)
  if (d.erreur) return d
  if (!d.cs.length) return { erreur: d.vide || 'Aucune console ne correspond.' }
  return planQuestion('ou', d.cs)
}

// Rend le plan : { ordre, resume, ... } ; `erreur` quand l'ordre n'est pas compris ou ne désigne rien (`planifiable` :
// pas compris du tout, le planificateur peut essayer). `kinds` : les types de console de ce serveur ({ claude: { label }, … }).
// Une phrase entière qui commence par un verbe (« relance api et dis-lui de reprendre ») échoue sur sa cible ou son
// type : elle aussi peut aller au planificateur, mais jamais un refus de principe (shell, capitaine, terminée, 1 à 6),
// que le modèle ne lèverait pas. Trois mots au moins : une faute de frappe (« ferme xyz ») reste une simple erreur.
const ECHEC_LECTURE = /^(?:Aucune console ne correspond|Lancer quoi|Je ne connais pas|À qui, et quoi)/
export function comprendre(brut, opts = {}) {
  const r = lis(brut, opts)
  if (r.erreur && !r.planifiable && ECHEC_LECTURE.test(r.erreur) && pl(nettoie(brut)).split(/\s+/).filter(Boolean).length >= 3) return { ...r, planifiable: true }
  return r.erreur ? r : marque(r)
}
// Tout plan rendu porte l'`empreinte` de ce qu'il fait (relecture de sécurité du 13/11, basse 3) : l'écran la renvoie
// (`vu`) à l'exécution, et un plan recalculé qui a changé entre-temps (une console arrivée, « tous » qui vise 4 agents au
// lieu de 3) est refusé au lieu de partir en silence. Celle d'un plan à confirmer est sa `confirmation`.
const marque = (plan) => Object.assign(plan, { empreinte: empreinte(plan) })

// ── Où s'arrête le destinataire d'un « dis à … » (chasse du 17/11, n°14) ──
// « dis à tous les agents de la team de reprendre le travail » partait à TOUS avec « la team de reprendre le travail » :
// la cible s'arrêtait au premier « de ». Une coupe ne se fait plus en silence dans un groupe nominal.
// Les coupes candidates, de gauche à droite : « : », et « de », « d' », « que », « qu' » précédés d'un blanc, en mots
// entiers (« demain », « des tests », « quelque » ne coupent plus au milieu du mot). La première valide l'emporte, comme
// avant pour une phrase sans coupe écartée. « : » est toujours valide ; il ne passe plus derrière un « de » écarté
// (« dis à tous les agents de la team : reprenez » partait à tous avec « la team : reprenez le travail »).
const COUPES = /\s*:|\s(?:(de|que)(?![\p{L}\p{N}])|(d|qu)')/gu
// Après « de » / « d' », un déterminant ouvre un groupe nominal (« de la team », « de l'équipe », « de cette page »,
// « d'une équipe », « de mon site », « de chaque équipe ») : pas la fin du destinataire, la coupe suivante est essayée.
// « de le », « de les » restent des coupes (toujours des pronoms : un nom prendrait « du », « des »), et « la », « l' »,
// « leur », « tous les » devant un infinitif (pronoms : « de la relancer », « de l'arrêter », « de leur écrire », « de tous
// les fermer »), reconnu à sa fin en -er, -ir (-oir), -re. Limites de cette heuristique : un nom ou un adjectif en -er, -ir, -re après la / l' / leur est pris
// pour un infinitif et coupe comme avant, sans confirmation (« de l'autre équipe », « de l'atelier », « de la mémoire ») ;
// un complément sans déterminant aussi (« aux agents de meydan de … », « au codex d'api de … ») ; un « que » relatif
// coupe (« à l'agent que j'ai lancé de … ») ; « de leur en parler », « de la lui donner » sont écartés à tort (coupe
// suivante, sinon le planificateur : jamais un envoi coupé en silence).
const NOMINAL = /^(?:(?:la\s+|l'|leur\s+|(?:tous|toutes)\s+les\s+)(?!\p{L}*(?:er|ir|re)(?![\p{L}\p{N}]))|(?:un|une|ce|cet|cette|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|nos|votre|vos|leurs|chaque|plusieurs|quelques|certaine?s|(?:tous|toutes)\s+ces)(?![\p{L}\p{N}]))/u
// `r` : la phrase après le verbe, forme `pl` (positions alignées sur le texte d'origine). Rend { cible: [début, fin],
// message: début, ecartee } ou null ; `ecartee` : une coupe a été écartée avant celle-ci (destinataire à vérifier).
function destinataire(r) {
  const tete = /^(?:a|au|aux)\s+/.exec(r)
  if (!tete) return null
  let ecartee = false
  for (const c of r.matchAll(COUPES)) {
    if (c.index < tete[0].length) continue // le blanc de « à » lui-même : aucune cible avant
    const apres = c.index + c[0].length
    const blanc = r.slice(apres).search(/\S/)
    if (blanc < 0) continue // rien après : pas un message
    const message = apres + blanc
    if ((c[1] === 'de' || c[2] === 'd') && NOMINAL.test(r.slice(message))) {
      ecartee = true
      continue
    }
    return { cible: [tete[0].length, c.index], message, ecartee }
  }
  return null
}
function lis(brut, { consoles = [], kinds = {} } = {}) {
  const texte = nettoie(brut).slice(0, 4000) // invisibles retirés (leçon 168) : ce qui est montré est ce qui part
  const t = pl(texte)
  if (!t) return { erreur: 'Tape ou dicte un ordre.' }
  const q = question(texte, t, consoles)
  if (q) return q
  const tete = enTete(texte)
  if (tete.jetons.length) {
    if (!tete.reste) return { erreur: `Quoi dire à ${tete.jetons.map((j) => `@${j}`).join(' ')} ? Exemple : « @site relis le README ».` }
    const d = parMentions(tete.jetons, consoles)
    return d.erreur ? d : versAgents(tete.reste, d)
  }
  const verbe = VERBES.find(([, re]) => re.test(t))
  if (!verbe) return { erreur: `Je ne comprends pas cet ordre. Il commence par : lance, dis, interromps, ferme, relance ou @nom, ou c’est une question (qui a fini ?). Exemple : « ${EXEMPLES[0]} ».`, planifiable: true }
  const [ordre, re] = verbe
  const apres = t.replace(re, '')
  const decal = t.length - apres.length
  const reste = texte.slice(decal).trim() // le texte d'origine (majuscules, accents) après le verbe
  const resteP = pl(reste)

  if (ordre === 'lancer') {
    const m = resteP.match(/^(?:(\d+|un|une|deux|trois|quatre|cinq|six)\s+)?(?:nouveaux?\s+|nouvelles?\s+)?(?:consoles?\s+)?([a-z0-9_-]+)/)
    if (!m) return { erreur: `Lancer quoi ? Exemple : « ${EXEMPLES[0]} ».` }
    const n = m[1] ? NOMBRES[m[1]] ?? Number(m[1]) : 1
    const kind = trouveKind(m[2].replace(/s$/, ''), kinds)
    if (!kind) return { erreur: `Je ne connais pas « ${m[2]} ». Types possibles : ${Object.keys(kinds).join(', ')}.` }
    let suite = reste.slice(m[0].length).trim()
    let dossier = '~'
    const d = pl(suite).match(/^(?:dans|sur|en|au projet|pour le projet|du projet)\s+(\S+)/)
    if (d) {
      dossier = suite.slice(d[0].length - d[1].length, d[0].length).replace(/[,;:]$/, '')
      suite = suite.slice(d[0].length).trim()
    }
    const c = pl(suite).match(/^(?::|,|avec la consigne|avec pour consigne|consigne|pour|avec)\s*:?\s*/)
    // Un shell : tout texte restant serait sa « consigne », refusée par planLancer (il l'exécuterait).
    const consigne = kind !== 'shell' && c ? suite.slice(c[0].length).trim() : suite.replace(/^[:,]\s*/, '').trim()
    return planLancer(kind, n, dossier, consigne, kinds)
  }

  if (ordre === 'envoyer') {
    // « dis à tous : … », « dis à tous de … », « envoie aux codex que … », « dis à @site : … »
    const c = destinataire(resteP)
    if (!c) return { erreur: 'À qui, et quoi ? Exemple : « dis à tous : faites le point ».' }
    const d = designe(reste.slice(...c.cible), consoles)
    const plan = d.erreur ? d : versAgents(reste.slice(c.message).trim(), d)
    // Une coupe écartée : le destinataire lu est peut-être trop long ou trop court ; Orkun le vérifie avant que ça parte.
    return plan.erreur || !c.ecartee ? plan : scelle(Object.assign(plan, { confirmer: true, resume: `${plan.resume} — vérifie où s'arrête le destinataire` }))
  }

  if (!reste) return { erreur: `${ordre === 'interrompre' ? 'Interrompre' : ordre === 'fermer' ? 'Fermer' : 'Relancer'} qui ? Exemple : « ${ordre === 'fermer' ? 'ferme les shells' : ordre === 'relancer' ? 'relance les finies' : 'interromps tout'} ».` }
  const d = designe(reste, consoles)
  return d.erreur ? d : planCibles(ordre, d.cs, d.quoi, d.vide)
}

// ── Plan du planificateur ──
// `actions` vient d'un modèle : JSON non fiable. Chaque action est revalidée ici avec les mêmes règles que l'analyse sans
// modèle, et son `resume` est écrit par Meydan (jamais repris d'un texte du modèle). Une action invalide (ou plus de
// MAX_ACTIONS) : tout le plan est refusé, avec le numéro de l'étape ; rien n'est tronqué ni retiré en silence. Des ids
// inconnus parmi les cibles sont écartés, tant qu'il en reste un connu.
const QUESTIONS_NOMS = ['finies', 'attendent', 'ou', 'statut']
const texteDe = (s, max = 4000) => (typeof s === 'string' ? nettoie(s).slice(0, max) : '')
function depuisAction(a, consoles, kinds, relancees) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { erreur: 'action illisible.' }
  const voulues = new Set(Array.isArray(a.cibles) ? a.cibles.filter((x) => typeof x === 'string') : [])
  const cs = consoles.filter((c) => voulues.has(c.id))
  const quoi = 'les consoles choisies'
  const vide = 'aucune console connue parmi les cibles.'
  switch (a.ordre) {
    case 'lancer': {
      const mot = pl(texteDe(a.kind, 40)).replace(/s$/, '')
      const kind = mot && trouveKind(mot, kinds)
      if (!kind) return { erreur: `type de console inconnu « ${texteDe(a.kind, 40)} ».` }
      return planLancer(kind, a.n ?? 1, texteDe(a.dossier, 500) || '~', texteDe(a.consigne), kinds)
    }
    case 'envoyer': {
      const message = texteDe(a.message)
      if (!message) return { erreur: 'message vide.' }
      return planEnvoyer(message, cs, quoi, vide, relancees)
    }
    case 'interrompre':
    case 'relancer':
    case 'fermer':
      return planCibles(a.ordre, cs, quoi, vide)
    case 'question': // seule « ou » se sert des cibles ; ailleurs elles sont ignorées
      if (!QUESTIONS_NOMS.includes(a.question)) return { erreur: 'question inconnue.' }
      if (a.question === 'ou' && !cs.length) return { erreur: vide }
      return planQuestion(a.question, cs)
    default:
      return { erreur: `ordre inconnu « ${texteDe(String(a.ordre ?? ''), 40)} ».` }
  }
}
// Un texte (message, consigne) est-il dans la phrase d'Orkun ? Comparés sans accents, casse, ponctuation ni blancs en
// trop : Haiku qui reprend « reprendre là où elle en était » de « dis-lui de reprendre là où elle en était » ne fait
// rien d'ajouté (vérifié sur les 10 sorties réelles de test/volets/ordres/mesure-planificateur.json : 0 marquée).
const mots = (s) => ` ${pl(nettoie(String(s ?? ''))).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
const dansLaPhrase = (texte, phrase) => mots(phrase).includes(mots(texte))
const AJOUTE = ' — texte proposé par Haiku, pas dans ta phrase'
// `phrase` : la phrase d'Orkun donnée au planificateur. Un message ou une consigne qui n'y figure pas (un nom ou un sujet
// de console écrit par un agent a pu l'inspirer au modèle : relecture de sécurité du 13/11, M1) est marqué `ajoute`, dit
// dans le résumé de l'étape, et rend le plan `grave` (deux appuis).
export function depuisActions(actions, { consoles = [], kinds = {}, phrase } = {}) {
  if (!Array.isArray(actions) || !actions.length) return { erreur: 'Le planificateur n’a proposé aucune action.' }
  if (actions.length > MAX_ACTIONS) return { erreur: `Plan trop long : ${actions.length} étapes, ${MAX_ACTIONS} au plus. Découpe l’ordre.` }
  const plans = []
  const relancees = new Set() // « relance X et dis-lui de reprendre » : X est encore terminée à la validation
  for (const [i, a] of actions.entries()) {
    const p = depuisAction(a, consoles, kinds, relancees)
    if (p.erreur) return { erreur: `Étape ${i + 1} : ${p.erreur}` }
    if (p.ordre === 'relancer') for (const id of p.cibles) relancees.add(id)
    const texte = p.ordre === 'envoyer' ? p.message : p.ordre === 'lancer' ? p.consigne : ''
    if (typeof phrase === 'string' && texte && !dansLaPhrase(texte, phrase)) Object.assign(p, { ajoute: true, resume: p.resume + AJOUTE })
    plans.push(p)
  }
  // Toutes étapes confondues, pas plus de consoles lancées qu'un seul « lance » n'en permet (basse 10 : 8 × 6 = 48).
  const lancees = plans.reduce((n, p) => n + (p.ordre === 'lancer' ? p.n : 0), 0)
  if (lancees > MAX_LANCER) return { erreur: `Plan trop large : ${lancees} consoles à lancer, ${MAX_LANCER} au plus par ordre.` }
  const plan = { ordre: 'plusieurs', actions: plans, resume: `Plan en ${pluriel(plans.length, 'étape')}`, confirmer: true }
  // Fermer, relancer, ou un texte que la phrase ne contient pas : une seconde confirmation à l'écran.
  const ajoutes = plans.filter((p) => p.ajoute).length
  if (ajoutes) plan.ajoutes = ajoutes
  if (ajoutes || plans.some((p) => p.ordre === 'fermer' || p.ordre === 'relancer')) plan.grave = true
  const r = plans.flatMap((p) => p.risques ?? [])
  if (r.length) plan.risques = r
  return marque(scelle(plan))
}

// ── Réponse à une question d'état ──
// `derniere(c)` : la dernière réponse écrite de l'agent (texte, '' si aucune). Les lignes sont nettoyées (texte d'agent :
// invisibles retirés) et bornées comme le fil des ordres (12 lignes de 400 caractères ; au-delà, « … et N autres »).
const STATUTS = { needs: "t'attend", error: 'erreur', fini: 'FINI', working: 'travaille', running: 'travaille', starting: 'démarre', ready: 'au repos', shell: 'shell', closed: 'terminée' }
const RANG = ['needs', 'error', 'fini', 'working', 'running', 'starting', 'ready', 'shell', 'closed'] // urgence, comme la liste
const etatDe = (c) => (c.status === 'fini' || (c.status === 'ready' && c.fini) ? 'fini' : c.status) // FINI = au repos, pas encore vu
const statutFr = (c) => (etatDe(c) === 'needs' && c.note ? `t'attend (${c.note})` : STATUTS[etatDe(c)] || String(etatDe(c) ?? '?'))
const rang = (c) => RANG.indexOf(etatDe(c)) + 1 || 99
const MAX_LIGNES = 12
const MAX_LIGNE = 400
const MAX_LIENS = 20
const coupe = (s, n) => {
  const a = [...s]
  return a.length > n ? `${a.slice(0, n - 1).join('')}…` : s
}
export function repondre(plan, { consoles = [], teams = [], derniere = () => '', maintenant = Date.now() } = {}) {
  const lignes = []
  const liens = []
  const lie = (c) => !liens.some((l) => l.id === c.id) && liens.length < MAX_LIENS && liens.push({ id: c.id, nom: c.name })
  const dit = (c, n) => {
    let t = ''
    try {
      t = String(derniere(c) ?? '')
    } catch {} // journal illisible : rien
    return t.split('\n').map(nettoie).filter(Boolean).slice(0, n)
  }
  const depuis = (ts) => (Number.isFinite(ts) ? ` depuis ${since(ts, maintenant)}` : '')
  const sujet = (c) => (typeof c.sujet === 'string' && c.sujet.trim() ? ` — ${c.sujet}` : '')
  const repos = (c, mot) => {
    const [l] = dit(c, 1)
    lignes.push(`${mot} · ${c.name}${sujet(c)}${l ? ` : ${l}` : ''}`)
    lie(c)
  }
  switch (plan?.question) {
    case 'attendent': {
      // Même compte que « T'ATTEND » : les consoles `needs` et les équipes prêtes pas encore vues ; la plus ancienne d'abord.
      const items = [
        ...consoles.filter((c) => c.status === 'needs').map((c) => ({ t: c.since, ligne: `${c.name} t'attend${depuis(c.since)} : ${c.note || 'une question'}`, c })),
        ...teams.filter(pretAVoir).map((e) => ({ t: e.pret.at, ligne: `Équipe « ${e.nom} » prête à livrer${depuis(e.pret.at)}${e.pret.texte ? ` : ${e.pret.texte}` : ''}`, c: consoles.find((c) => c.id === e.chief) })),
        // 17/11 : l'équipe qui t'appelle (question, blocage, échec du capitaine ; verdict de vérification à lire).
        ...teams.filter((e) => !pretAVoir(e) && appelAVoir(e)).map((e) => ({ t: e.appel.at, ligne: `Équipe « ${e.nom} » t'attend${depuis(e.appel.at)} (${e.appel.de === 'verification' ? 'vérification' : VERBE[e.appel.verbe] || e.appel.verbe})${e.appel.texte ? ` : ${e.appel.texte}` : ''}`, c: consoles.find((c) => c.id === e.chief) })),
      ].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
      if (!items.length) lignes.push("Personne ne t'attend.")
      for (const x of items) {
        lignes.push(x.ligne)
        if (x.c) lie(x.c)
      }
      break
    }
    case 'finies': {
      const finies = consoles.filter((c) => etatDe(c) === 'fini').sort((a, b) => (b.fini ?? 0) - (a.fini ?? 0))
      const auRepos = consoles.filter((c) => etatDe(c) === 'ready').sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
      if (!finies.length && !auRepos.length) lignes.push("Aucune console n'a fini.")
      for (const c of finies) repos(c, 'FINI')
      for (const c of auRepos) repos(c, 'au repos')
      break
    }
    case 'ou': {
      const cs = (Array.isArray(plan.cibles) ? plan.cibles : []).map((id) => consoles.find((c) => c.id === id)).filter(Boolean)
      if (!cs.length) lignes.push('Ces consoles n’existent plus.')
      for (const c of cs) {
        lignes.push(`${c.name} : ${statutFr(c)}${depuis(c.since)}${sujet(c)}`)
        for (const l of dit(c, cs.length === 1 ? 3 : 1)) lignes.push(`› ${l}`)
        lie(c)
      }
      break
    }
    case 'statut': {
      if (!consoles.length) {
        lignes.push('Aucune console.')
        break
      }
      const tri = [...consoles].sort((a, b) => rang(a) - rang(b))
      const compte = new Map()
      for (const c of tri) compte.set(STATUTS[etatDe(c)] || etatDe(c), (compte.get(STATUTS[etatDe(c)] || etatDe(c)) || 0) + 1)
      const pretes = teams.filter(pretAVoir).length
      const appels = teams.filter((e) => !pretAVoir(e) && equipeAttend(e)).length // 17/11 : équipes qui t'appellent
      lignes.push(`${pluriel(consoles.length, 'console')} : ${[...compte].map(([k, n]) => `${k} ${n}`).join(' · ')}${pretes ? ` · ${pluriel(pretes, 'équipe')} prête${pretes > 1 ? 's' : ''} à livrer` : ''}${appels ? ` · ${pluriel(appels, 'équipe')} qui t'attend${appels > 1 ? 'ent' : ''}` : ''}`)
      for (const c of tri) {
        lignes.push(`${c.name} : ${statutFr(c)}${depuis(c.since)}`)
        lie(c)
      }
      break
    }
  }
  const propres = lignes.map((l) => coupe(nettoie(l), MAX_LIGNE)).filter(Boolean)
  const k = propres.length - (MAX_LIGNES - 1)
  return { lignes: k > 1 ? [...propres.slice(0, MAX_LIGNES - 1), `… et ${k} autres.`] : propres, liens }
}
