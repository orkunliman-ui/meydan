// Panneau Git d'une carte du plateau (volet plateau-etendu, 11/11) : branche, état, derniers commits et différences, en
// lecture ; un commit des fichiers choisis, sur demande explicite d'Orkun (message écrit par lui, `confirme: true`).
// Rien d'autre : le module ne lance que les sous-commandes de PERMIS (aucun échange avec un autre dépôt), et `rm` pour
// effacer une copie qu'Orkun retire (`effaceArbre`). Seule la fusion confirmée écrit le dossier de travail.
//
// Contrat (lib/cartes.mjs) : ouvreGit({ send, readJson, copiesDir, consoles }) → { api(req, res, url, carte, reste),
// ancre(depot, dossier) } (la carte d'une copie : voir plus bas), `reste` = les morceaux
// du chemin après /api/cartes/<id>/git :
//   GET  …/git                       → { dossier, branche, detache, sha, initial, propre, fichiers, commits, coupe }
//   GET  …/git/diff?chemin=…&cote=…  → { diff, coupe }       (cote : travail | index ; 200 Ko au plus)
//   GET  …/git/commit/<sha>          → { sha, court, auteur, date, message, stat, diff, coupe }
//   POST …/git/commit                → { sha, court, etat }  corps { message, fichiers: [chemins], confirme: true }
// Copies (volet copies, 13/11 ; Orkun : « ni push ni PR », fusion LOCALE seulement) : les worktrees du dépôt, leur
// fusion dans la branche du dossier principal après contrôle des conflits, et le retrait d'une copie de Meydan.
//   GET  …/git/copies                → { estCopie, principal, copies: [...], coupe }
//   POST …/git/copies/controle       → ce qui entrerait, conflits, refus, et ce que perdrait un retrait   corps { chemin }
//   POST …/git/copies/fusion         → { avant, apres, court, branche, copie, commits, etat }
//                                      corps { chemin, principal: <sha vu>, copie: <sha vu>, confirme: true }
//   POST …/git/copies/retrait        → { retire, branche: { nom, supprimee, commits, raison } }
//                                      corps { chemin, copie: <sha vu>, confirme: true [, supprimeBranche: true, perdus: N] }
// `chemin` désigne une entrée de `git worktree list` relue à chaque appel : rien de ce que l'interface envoie n'est passé
// tel quel à git (les têtes confirmées sont comparées, puis la fusion porte sur le SHA relu et confirmé).
//
// Sûreté (leçon du 10/11, « relecture indépendante de l'équipage ») : le dossier d'une carte est un projet où des agents
// écrivent, configuration git du dépôt comprise (.git/config, .gitattributes, .git/hooks). Tout ce que cette
// configuration peut faire exécuter par git est coupé, et chaque piège est prouvé par un dépôt jetable
// (test/volets/plateau-etendu/git-api.mjs : le même piège se déclenche avec un git ordinaire, pas avec le panneau) :
//   - hooks : core.hooksPath=/dev/null partout, et --no-verify au commit ;
//   - programme de surveillance du dépôt : core.fsmonitor=false (lancé par un simple `git status`) ;
//   - différences externes et conversions : diff.external=, --no-ext-diff, --no-textconv ;
//   - filtres clean / smudge / process de .gitattributes : lancés par status, diff ET add, pas seulement au commit.
//     Chaque filtre déclaré dans la configuration est vidé pour l'appel (voir `lireConfig`) ; un fichier qu'un filtre
//     déclaré concerne (LFS, git-crypt…) n'est pas commité par le panneau : son contenu brut partirait à la place ;
//   - signature : commit.gpgSign=false et --no-gpg-sign (gpg.program est une commande) ; log.showSignature=false ;
//   - maintenance lancée après un commit : gc.auto=0, maintenance.auto=false ;
//   - dépôt partiel : rapatrier un objet manquant passe par l'adresse du dépôt promis, et une adresse « ext:: » est une
//     commande (prouvé) : un dépôt partiel est refusé (409), et GIT_NO_LAZY_FETCH=1 pour les git plus récents ;
//   - dépôts imbriqués : --ignore-submodules=all et --submodule=short, et pour l'état que `git commit` calcule lui-même
//     diff.ignoreSubmodules=all, status.submoduleSummary=false (git n'entre jamais dans un dépôt imbriqué, où il lirait
//     une autre configuration) ; refus d'un dossier imbriqué dans un autre dépôt, refus de commiter un dépôt imbriqué ;
//     safe.bareRepository=explicit (un dossier qui imite un dépôt nu n'est pas pris pour un dépôt) ;
//   - chemins : --literal-pathspecs (un fichier nommé « * » ou « :(top) » ne désigne que lui), toujours après « -- ».
// Et pour les copies (chaque piège prouvé par test/volets/copies/fusion-api.mjs, témoin d'abord) :
//   - dossier git ÉPINGLÉ (relecture indépendante du 13/11, course prouvée) : un agent peut faire basculer en boucle le
//     fichier .git de sa copie entre le vrai dossier git et un dépôt à lui (filtre dans sa configuration) ; un git qui
//     relit .git à chaque appel lit la configuration de l'un et lance le filtre de l'autre. Chaque git d'une demande
//     tourne donc avec GIT_DIR et GIT_WORK_TREE fixés : pour une copie, son dossier git est pris dans les métadonnées du
//     DÉPÔT PRINCIPAL (<commun>/worktrees/<id>/gitdir), jamais dans son fichier .git ; pour une carte posée sur un dépôt
//     ordinaire (dossier .git, hors du dossier des copies), à sa première lecture (`racine`), puis gardé pour toute la
//     demande ; puis sa configuration (filtres vidés, dépôt partiel refusé), puis son état ; mêmes réglages que partout ;
//   - carte posée sur une COPIE (son .git est un fichier ou un lien, ou elle est sous le dossier des copies) : l'ancre ne
//     vient JAMAIS de la copie (son agent écrit .git, ou le remplace par un dossier aux `worktrees/*` à lui : seconde
//     relecture du 13/11, course prouvée). Elle vient du dépôt principal enregistré sur la carte à sa création
//     (`depot`, posé par « Ouvrir le panneau de cette copie », vérifié par `ancreDeCopie`, jamais changé ensuite) ; une
//     carte sur une copie sans dépôt enregistré est refusée ;
//   - pilotes de fusion (`merge.<x>.driver`, désignés par `.gitattributes` ou `merge.default`) : des commandes, que
//     `merge-tree --write-tree` lance AUSSI (prouvé le 13/11). Les vider donne un faux conflit : si la configuration en
//     déclare, contrôle et fusion sont refusés (409, « à fusionner dans un terminal ») avant tout merge-tree ;
//   - filtres déclarés : la fusion les lancerait en écrivant le dossier de travail (smudge, prouvé) ; vidés, elle
//     écrirait le contenu brut (LFS) : la fusion est refusée (409) dès qu'un filtre est déclaré ;
//   - stratégie : `pull.twohead` et `branch.<b>.mergeOptions` (« -s <x> ») font lancer `git-merge-<x>` trouvé dans le
//     PATH (prouvé). `-s ort` écarte le premier, PAS le second (les stratégies s'ajoutent) : il est vidé pour l'appel ;
//   - signature : --no-gpg-sign, et --no-verify-signatures (`merge.verifySignatures` lance gpg.program, prouvé) ;
//   - éditeur : -m et --no-edit ; hooks de fusion (pre-merge-commit, commit-msg, post-merge…) : hooksPath et --no-verify ;
//     sous-modules : submodule.recurse=false ; --no-stat, --no-autostash ;
//   - un fichier ignoré du dossier principal (un `.env`) est écrasé sans un mot par une fusion qui l'ajoute, même avec
//     --no-overwrite-ignore (prouvé) : tout chemin ajouté qui existe déjà sur le disque fait refuser la fusion ;
//   - le retrait n'est PLUS fait par `git worktree remove` (seconde relecture du 13/11, prouvé) : git efface chemin par
//     chemin (lstat, puis unlink de <copie>/x/<nom>) et suit un lien qu'un processus laissé par l'agent substitue à un
//     dossier ignoré pendant l'effacement — il effaçait les mêmes noms HORS de la copie (« aucune console vivante » ne
//     veut pas dire « aucun processus de l'agent ») ; et son status interne relisait le .git basculé. La copie est jugée
//     propre par NOTRE status épinglé, refusée si elle porte un sous-module (son dépôt et ses commits jamais poussés
//     partiraient) ou si un processus y a son dossier courant ou un fichier ouvert (un complément, pas la protection) ;
//     puis son dossier est effacé par `rm -rf --one-file-system` (GNU rm : parcours par descripteurs, un lien substitué
//     est effacé comme lien, jamais suivi ; prouvé sous la même course), puis sa trace (son dossier d'administration
//     dans le dépôt principal) de la même façon, elle seule : `worktree prune` effaçait aussi la trace des AUTRES
//     worktrees disparus (prouvé), et `worktree remove` rouvrirait la course si un processus recréait le dossier entre
//     les deux. Aucune commande git n'efface plus rien d'une copie ; `worktree` : `list` seulement.
// LIMITE (décision pour Orkun) : la protection vaut contre un piège POSÉ, pas contre un agent qui récrit la
// configuration COMMUNE du dépôt (<principal>/.git/config, .git/info/attributes, ou le dossier .git lui-même) PENDANT
// l'appel : il peut faire la même course sur tous les git du panneau (prouvé par la relecture sur GET …/git et
// GET …/git/copies). Seul un git isolé, sans droit d'exécuter (bwrap, landlock), fermerait ce cas.
// Et partout : execFile (aucun shell), environnement en liste blanche, délai (15 s en lecture, 60 s au commit), sortie
// bornée, message d'erreur ramené à une ligne sans caractère de contrôle.
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { A_REGARDER } from './equipage.mjs'

const LECTURE_MS = 15000
const COMMIT_MS = 60000
const DIFF_MAX = 200 * 1024 // octets d'une différence rendue (au-delà : `coupe: true`)
const ETAT_MAX = 8 << 20 // sortie de `git status` acceptée
const LISTE_MAX = 1000 // fichiers rendus à l'interface (au-delà : `coupe: N`)
const MESSAGE_MAX = 5000
const CHEMINS_MAX = 256 * 1024 // octets de chemins passés à un commit (la ligne de commande a ses limites)

// Les seules sous-commandes que ce module peut lancer (vérifié à chaque appel, et par les essais sur la source :
// test/volets/plateau-etendu/git-api.mjs, test/volets/copies/fusion-api.mjs).
export const PERMIS = new Set([
  ...['rev-parse', 'config', 'status', 'log', 'diff', 'show', 'check-attr', 'add', 'commit', 'update-index'], // le panneau du 11/11
  // Copies (13/11), une par une, avec ce qui la rend nécessaire et ce qui l'empêche de nuire :
  // `list` : les copies du dépôt. Rien d'autre (FORMES, git()) : le retrait d'une copie n'est plus fait par git (voir
  // l'en-tête). Ni add, ni move, ni remove, ni prune, ni lock, jamais --force.
  'worktree',
  // `--left-right --count` / `--count` : avance, retard, commits non fusionnés. Lecture seule.
  'rev-list',
  // `--write-tree` : contrôle des conflits sans toucher au dossier de travail ni à une référence (seuls des objets sont
  // écrits) ; jamais lancé quand un pilote de fusion est déclaré (il le lancerait).
  'merge-tree',
  // `--no-ff` : la fusion confirmée, du SHA contrôlé, réglages ci-dessus ; `--abort` : seulement si CETTE fusion a
  // laissé un état de fusion en cours.
  'merge',
  // `-d` : supprime une branche fusionnée (git le vérifie lui-même). Jamais `-D` (voir update-ref).
  'branch',
  // `-v` : les marques de l'index (assume-unchanged, skip-worktree) des fichiers qu'une fusion toucherait : git ne voit pas
  // leurs modifications locales, la fusion les écraserait. `-s` : les sous-modules (mode 160000) de l'index d'une copie,
  // qui font refuser son retrait. Lecture seule.
  'ls-files',
  // `-d refs/heads/<b> <sha confirmé>` : supprime une branche non fusionnée seulement si elle est encore au commit qu'Orkun
  // a vu perdre (atomique, refusé si elle a bougé), à la seconde confirmation (`perteConfirmee`, un seul appel).
  'update-ref',
])
// Les formes permises des sous-commandes à plusieurs modes (le mot qui suit la sous-commande), vérifiées à chaque appel
// comme PERMIS : `worktree add`, `worktree prune`, `branch -m`, `branch <nouvelle>`, `merge --continue`… ne passent pas.
const FORMES = { worktree: ['list'], 'merge-tree': ['--write-tree'], merge: ['--no-ff', '--abort'], branch: ['-d'], 'ls-files': ['-v', '-s'], 'update-ref': ['-d'] }
// Le dossier git de chaque dépôt touché par une demande, épinglé dès sa première lecture (voir l'en-tête) : une carte
// → { gitDir, workTree }, valable le temps de la demande seulement.
const demande = new AsyncLocalStorage()
const SURETE = [
  '--literal-pathspecs',
  ...['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.quotePath=false', 'diff.external=', 'log.showSignature=false', 'commit.gpgSign=false', 'gc.auto=0', 'maintenance.auto=false', 'safe.bareRepository=explicit', 'diff.ignoreSubmodules=all', 'status.submoduleSummary=false'].flatMap((c) => ['-c', c]),
]
// Options de toute commande qui produit une différence (diff, show) : `diff.external=` sans --no-ext-diff ferait échouer git.
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--submodule=short']

const refus = (message, code = 400) => Object.assign(new Error(message), { code })
const ligne = (s, max = 600) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const texte = (b) => b.toString('utf8')

// Un appel à git. `neutres` : réglages imposés par l'environnement (GIT_CONFIG_KEY_n / VALUE_n, qui passent devant la
// configuration du dépôt et séparent clé et valeur, quel que soit le nom d'un filtre). `coupable` : une sortie plus
// longue que `max` est rendue coupée au lieu d'échouer. `accepte1` : la sortie 1 est une réponse (merge-tree : conflit),
// pas une erreur. `lignes` : lignes de l'erreur gardées (la fin du message de git). `perteConfirmee` : seul droit de
// passer `update-ref -d`. `epingle` : { gitDir, workTree } imposés (sinon ceux que la demande a épinglés pour `dir`).
function git(dir, args, { ecrit = false, delai = LECTURE_MS, max = 4 << 20, entree = '', neutres = [], coupable = false, accepte1 = false, lignes = 3, perteConfirmee = false, epingle = null } = {}) {
  if (!PERMIS.has(args[0])) return Promise.reject(refus(`sous-commande git refusée par le panneau : ${ligne(args[0], 40)}`, 500))
  const formes = FORMES[args[0]]
  if (formes && !formes.includes(args[1])) return Promise.reject(refus(`forme refusée par le panneau : git ${ligne(args[0], 20)} ${ligne(args[1], 40)}`, 500))
  if (args[0] === 'worktree' && args.some((a) => a === '--force' || /^-[a-z]*f/.test(a))) return Promise.reject(refus('git worktree --force refusé par le panneau', 500))
  if (args[0] === 'update-ref' && !perteConfirmee) return Promise.reject(refus('git update-ref -d refusé sans la confirmation des commits perdus', 500))
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_NO_LAZY_FETCH: '1' }
  if (!ecrit) env.GIT_OPTIONAL_LOCKS = '0' // une lecture ne prend pas le verrou de l'index (un agent peut travailler à côté)
  neutres.forEach(([cle, valeur], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = cle
    env[`GIT_CONFIG_VALUE_${i}`] = valeur
  })
  if (neutres.length) env.GIT_CONFIG_COUNT = String(neutres.length)
  const ep = epingle || demande.getStore()?.get(dir)
  if (ep) {
    env.GIT_DIR = ep.gitDir
    env.GIT_WORK_TREE = ep.workTree
  }
  return lance('git', [...SURETE, '-C', dir, ...args], { env, max, delai, entree }).then(({ err, out, errOut }) => {
    if (err && coupable && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { out, coupe: true }
    if (err && accepte1 && err.code === 1 && !err.killed) return { out, coupe: false, code: 1 }
    if (err) {
      const dit = ligne(texte(errOut || Buffer.alloc(0)).trim().split('\n').slice(-lignes).join(' · '))
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw refus('réponse de git trop longue', 409)
      throw refus(err.killed ? `git n’a pas répondu en ${delai / 1000} s` : `git : ${dit || ligne(err.message)}`, 409)
    }
    return { out, coupe: false }
  })
}
// Le seul lancement de programme du module : git (par `git()`) et rm (par `effaceArbre`). execFile, aucun shell.
function lance(programme, argv, { env, max, delai, entree = '' }) {
  return new Promise((resolve) => {
    const enfant = execFile(programme, argv, { env, encoding: 'buffer', maxBuffer: max, timeout: delai, killSignal: 'SIGKILL' }, (err, out, errOut) => resolve({ err, out, errOut }))
    enfant.stdin.on('error', () => {}) // le programme a pu finir sans lire son entrée
    enfant.stdin.end(entree)
  })
}
const sortie = async (dir, args, o) => texte((await git(dir, args, o)).out).trim()

// Un chemin reçu de l'interface : relatif au dépôt, sans « .. », sans caractère de contrôle. Il doit en plus figurer dans
// l'état courant (vérifié par chaque route) : rien d'autre ne peut être lu ni commité.
function cheminValide(c) {
  if (typeof c !== 'string' || !c || c.length > 4096) throw refus('chemin attendu')
  if (/[\u0000-\u001f\u007f]/.test(c)) throw refus('chemin : caractère de contrôle refusé')
  if (c.startsWith('/') || path.isAbsolute(c)) throw refus('chemin absolu refusé')
  if (c.split('/').includes('..')) throw refus('chemin : « .. » refusé')
  return c
}

// Le dossier de la carte doit être un dépôt git ET sa racine, et pas un dépôt imbriqué dans un autre. Il a été résolu par
// safeDir (dossier réel sous ~) à son choix ; s'il est devenu un lien symbolique depuis, on refuse aussi.
async function racine(dossier, { depot = '', copiesDir = '' } = {}) {
  let reel = ''
  try {
    reel = fs.realpathSync(dossier)
  } catch {
    throw refus('dossier introuvable : choisis un autre projet', 409)
  }
  if (reel !== dossier) throw refus('le dossier de la carte est devenu un lien symbolique : choisis le projet à nouveau', 409)
  // Une copie (worktree) : son `.git` n'est pas un vrai dossier, ou elle est sous le dossier des copies (un `.git`
  // remplacé par un dossier y ferait passer la copie pour un dépôt principal aux `worktrees/*` écrits par son agent).
  const st = fs.lstatSync(path.join(dossier, '.git'), { throwIfNoEntry: false })
  const copies = copiesDir ? reelOu(copiesDir) : ''
  if (depot || (st && !st.isDirectory()) || (copies && dossier.startsWith(copies + path.sep))) {
    if (!depot) throw refus('cette carte suit une copie (un worktree) : ouvre-la depuis le panneau Git de son dépôt (« Ouvrir le panneau de cette copie »)', 409)
    demande.getStore()?.set(dossier, { gitDir: ancreDeCopie(depot, dossier, 409), workTree: dossier })
    return
  }
  // Racine ET dossier git lus d'un seul appel : c'est ce dossier git que tous les git suivants de la demande utilisent.
  const [top, gitDir] = (await sortie(dossier, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).catch(() => '')).split('\n')
  if (!top) throw refus('pas la racine d’un dépôt git (aucun dépôt ici)', 409)
  let topReel = top
  try {
    topReel = fs.realpathSync(top)
  } catch {} // gardé tel quel : il sera différent du dossier
  if (topReel !== dossier) throw refus(`pas la racine d’un dépôt git : sa racine est ${ligne(top, 300)}`, 409)
  const dessus = await sortie(path.dirname(dossier), ['rev-parse', '--show-toplevel']).catch(() => '')
  if (dessus) throw refus(`pas la racine d’un dépôt git : dépôt imbriqué dans un autre dépôt (${ligne(dessus, 300)})`, 409)
  if (!gitDir) throw refus('dossier git illisible', 409)
  demande.getStore()?.set(dossier, { gitDir: reelOu(gitDir), workTree: dossier })
}

// L'ancre d'une carte posée sur une copie : le dossier d'administration de la copie DANS le dépôt principal `depot`
// (enregistré sur la carte par « Ouvrir le panneau de cette copie »). `depot` doit être la racine d'un dépôt principal (un
// vrai dossier .git) dont `worktrees/<id>/gitdir` désigne `<dossier>/.git`. Rien n'est lu dans la copie. Lève sinon.
function ancreDeCopie(depot, dossier, code = 400) {
  if (typeof depot !== 'string' || !path.isAbsolute(depot) || reelOu(depot) !== depot) throw refus('dépôt principal de la copie illisible', code)
  if (depot === dossier) throw refus('une copie n’est pas son propre dépôt principal', code)
  if (!fs.lstatSync(path.join(depot, '.git'), { throwIfNoEntry: false })?.isDirectory()) throw refus('le dépôt principal enregistré n’est plus un dépôt (pas de dossier .git)', code)
  const admin = adminDe(dossier, path.join(depot, '.git'))
  if (!admin) throw refus('ce dossier n’est pas une copie (worktree) du dépôt enregistré', code)
  return admin
}

// La configuration effective du dépôt (fichiers inclus) : les filtres déclarés, vidés pour chaque appel, et le refus
// d'un dépôt partiel. Lire la configuration ne lance rien.
async function lireConfig(dossier, o = {}) {
  const filtres = new Set()
  const pilotes = new Set() // pilotes de fusion déclarés (`merge.<x>.driver`) : la fusion et son contrôle les refusent
  let partiel = false
  for (const e of texte((await git(dossier, ['config', '-z', '--list'], o)).out).split('\0')) {
    const cle = e.split('\n', 1)[0]
    const m = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(cle)
    if (m) filtres.add(m[1])
    const p = /^merge\.(.+)\.driver$/.exec(cle)
    if (p) pilotes.add(p[1])
    if (cle === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(cle)) partiel = true
  }
  if (partiel) throw refus('dépôt partiel (objets à rapatrier d’un autre dépôt) : le panneau ne l’ouvre pas', 409)
  const neutres = [...filtres].flatMap((n) => [[`filter.${n}.clean`, ''], [`filter.${n}.smudge`, ''], [`filter.${n}.process`, ''], [`filter.${n}.required`, 'false']])
  return { filtres, pilotes, neutres }
}

// porcelain v2 : X = index, Y = dossier de travail (« . » : rien).
function typeDe(genre, xy) {
  if (genre === 'u') return 'conflit'
  if (genre === '?') return 'non suivi'
  if (genre === '2') return xy.includes('R') ? 'renommé' : 'ajouté' // C : une copie, donc un fichier ajouté
  if (xy.includes('A')) return 'ajouté'
  if (xy.includes('D')) return 'supprimé'
  return 'modifié'
}
const lettre = (c) => (c === '.' ? '' : c)

async function lireEtat(dossier, cfg) {
  const { out } = await git(dossier, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all', '--find-renames'], { max: ETAT_MAX, neutres: cfg.neutres })
  const morceaux = texte(out).split('\0')
  const tous = []
  let sha = ''
  let branche = ''
  for (let i = 0; i < morceaux.length; i++) {
    const e = morceaux[i]
    if (!e) continue
    if (e.startsWith('# branch.oid ')) sha = e.slice(13)
    else if (e.startsWith('# branch.head ')) branche = e.slice(14)
    else if (e[0] === '?') tous.push({ chemin: e.slice(2), index: '', travail: '?', type: 'non suivi' })
    else if (e[0] === '1' || e[0] === '2' || e[0] === 'u') {
      // Champs séparés par une espace, le chemin en dernier (il peut contenir des espaces) ; un renommé est suivi de
      // son ancien chemin, dans le morceau suivant.
      const champs = e.split(' ')
      const xy = champs[1]
      const f = { chemin: champs.slice({ 1: 8, 2: 9, u: 10 }[e[0]]).join(' '), index: lettre(xy[0]), travail: lettre(xy[1]), type: typeDe(e[0], xy) }
      if (e[0] === '2') f.ancien = morceaux[++i]
      tous.push(f)
    }
  }
  const initial = sha === '(initial)'
  const detache = branche === '(detached)'
  let commits = []
  if (!initial) {
    const champs = texte((await git(dossier, ['log', '-n', '20', '-z', '--format=%H%x00%h%x00%an%x00%aI%x00%s', 'HEAD', '--'])).out).split('\0')
    for (let i = 0; i + 4 < champs.length; i += 5) commits.push({ sha: champs[i], court: champs[i + 1], auteur: champs[i + 2], date: champs[i + 3], sujet: champs[i + 4] })
  }
  return {
    dossier,
    branche: detache ? '' : branche,
    detache,
    sha: initial ? '' : sha,
    initial,
    propre: tous.length === 0,
    fichiers: tous.slice(0, LISTE_MAX),
    coupe: tous.length > LISTE_MAX ? tous.length : 0,
    commits,
    tous,
  }
}
const pourInterface = ({ tous, ...etat }) => etat

// Un fichier non suivi, montré comme entièrement ajouté. Lu par le serveur lui-même (git ne connaît pas encore ce
// fichier) : refus d'un lien symbolique, d'un chemin qui passe par un lien ou sort du dépôt, de tout ce qui n'est pas un
// fichier ordinaire (un tube nommé bloquerait la lecture), et lecture bornée à DIFF_MAX.
function nonSuivi(dossier, chemin) {
  const plein = path.join(dossier, chemin)
  const parent = path.dirname(plein)
  let parentReel = ''
  try {
    parentReel = fs.realpathSync(parent)
  } catch {
    throw refus('fichier introuvable', 404)
  }
  if (parentReel !== parent || (parentReel !== dossier && !parentReel.startsWith(dossier + path.sep))) throw refus('chemin qui passe par un lien symbolique ou sort du dépôt : refusé', 409)
  const st = fs.lstatSync(plein, { throwIfNoEntry: false })
  if (!st) throw refus('fichier introuvable', 404)
  if (st.isSymbolicLink()) throw refus('lien symbolique : son contenu n’est pas montré', 409)
  if (!st.isFile()) throw refus('pas un fichier ordinaire : rien à montrer', 409)
  const fd = fs.openSync(plein, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  let lu
  let taille
  try {
    const st2 = fs.fstatSync(fd)
    if (!st2.isFile()) throw refus('pas un fichier ordinaire : rien à montrer', 409)
    taille = st2.size
    const buf = Buffer.alloc(Math.min(taille, DIFF_MAX))
    lu = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0))
  } finally {
    fs.closeSync(fd)
  }
  const mode = st.mode & 0o111 ? '100755' : '100644'
  const tete = `diff --git a/${chemin} b/${chemin}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${chemin}\n`
  if (lu.subarray(0, 8000).includes(0)) return { diff: `${tete}Fichier binaire (${taille} octets) : contenu non montré\n`, coupe: false }
  const lignes = texte(lu).split('\n')
  const finale = lignes.at(-1) === ''
  if (finale) lignes.pop()
  let diff = `${tete}@@ -0,0 +1,${lignes.length} @@\n${lignes.map((l) => `+${l}`).join('\n')}\n${finale || lu.length < taille ? '' : '\\ No newline at end of file\n'}`
  let coupe = lu.length < taille
  if (Buffer.byteLength(diff) > DIFF_MAX) {
    diff = texte(Buffer.from(diff).subarray(0, DIFF_MAX))
    coupe = true
  }
  return { diff, coupe }
}

// ── Copies (volet copies, 13/11) ──
// Une copie = un worktree du dépôt de la carte autre que le dossier principal (le premier de `git worktree list`). Une
// copie de Meydan vit sous `copiesDir` (lib/copies.mjs : <copiesDir>/<projet>/<nom>, branche meydan/<nom>) ; une branche
// d'équipe (meydan/e<6 hexa>/…) se livre par son équipe ; les autres worktrees sont montrés, jamais retirés.
const COPIES_MAX = 50 // worktrees décrits par liste (au-delà : `coupe`)
const COPIE_MS = 8000 // un git lancé dans une copie pour la liste
const FUSION_MS = 120000
const RETRAIT_MS = 180000 // retirer une copie efface son dossier, node_modules compris
const COMMITS_MAX = 200 // commits rendus par un contrôle
const LISTE_MS = 15000 // une liste des copies est partagée et gardée ce temps (`listeCopies`)
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const EQUIPE = /^meydan\/e[0-9a-f]{6}\//
const TYPE_DIFF = { A: 'ajouté', C: 'ajouté', D: 'supprimé', M: 'modifié', R: 'renommé', T: 'modifié', U: 'conflit' }
const dedans = (p, parent) => p === parent || p.startsWith(parent + path.sep)
const reelOu = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const s = (n) => (n > 1 ? 's' : '')
// « 2 fichiers suivis » : chaque mot du nom prend la marque du pluriel.
const nb = (n, nom) => `${n} ${nom.split(' ').map((m) => m + s(n)).join(' ')}`

// `git worktree list --porcelain -z` : chaque champ « clé[ valeur] » finit par NUL, un NUL vide clôt un worktree.
async function worktrees(dossier) {
  const { out } = await git(dossier, ['worktree', 'list', '--porcelain', '-z'], { max: 1 << 20 })
  const blocs = []
  for (const e of texte(out).split('\0')) {
    if (!e) continue
    const i = e.indexOf(' ')
    const cle = i < 0 ? e : e.slice(0, i)
    const valeur = i < 0 ? true : e.slice(i + 1)
    if (cle === 'worktree') blocs.push({ chemin: valeur })
    else if (blocs.length) blocs.at(-1)[cle] = valeur
  }
  return blocs
}

// Le dossier principal : tête, branche, et ses fichiers SUIVIS modifiés ou indexés (conflits compris). Les non suivis ne
// comptent pas : git refuse lui-même une fusion qui en écraserait un (son message est rendu), sauf un fichier ignoré
// (voir `ecrases`). Une fusion déjà en cours (MERGE_HEAD) est dite : le panneau n'y touche pas.
async function lirePrincipal(dossier, cfg) {
  const { out } = await git(dossier, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no', '--ignore-submodules=all'], { max: ETAT_MAX, neutres: cfg.neutres, coupable: true })
  let sha = ''
  let branche = ''
  let suivis = 0
  const m = texte(out).split('\0')
  for (let i = 0; i < m.length; i++) {
    if (m[i].startsWith('# branch.oid ')) sha = m[i].slice(13)
    else if (m[i].startsWith('# branch.head ')) branche = m[i].slice(14)
    else if (/^[12u] /.test(m[i])) {
      suivis++
      if (m[i][0] === '2') i++ // un renommé : son ancien chemin suit
    }
  }
  const initial = sha === '(initial)'
  const detache = branche === '(detached)'
  const enCours = await sortie(dossier, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')
  return { dossier, sha: initial ? '' : sha, court: initial ? '' : sha.slice(0, 7), branche: detache ? '' : branche, detache, initial, suivis, fusionEnCours: enCours }
}

// L'état complet d'un dossier (fichiers suivis et non suivis), tel quel : deux lectures égales = rien n'a bougé.
async function statutComplet(dossier, cfg) {
  const { out, coupe } = await git(dossier, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all'], { max: ETAT_MAX, neutres: cfg.neutres, coupable: true })
  if (coupe) throw refus('état du dossier principal trop long pour être comparé', 409)
  return texte(out)
}

// Le contexte d'un appel : la carte doit être posée sur le dossier PRINCIPAL du dépôt (sur une copie, le panneau ne
// fusionne ni ne retire rien : il le dit).
async function contexte(dossier, { copiesDir, consoles }) {
  const blocs = await worktrees(dossier)
  if (!blocs.length || reelOu(blocs[0].chemin) !== dossier) return { estCopie: true, chemin: typeof blocs[0]?.chemin === 'string' ? blocs[0].chemin : '' }
  const cfg = await lireConfig(dossier)
  const commun = reelOu(await sortie(dossier, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const principal = await lirePrincipal(dossier, cfg)
  const copies = copiesDir ? reelOu(copiesDir) : ''
  // Les consoles non fermées qui travaillent dans la copie (son dossier ou un sous-dossier), ou AU-DESSUS d'elle sans
  // sortir du dossier des copies (l'agent d'une autre copie qui la contient : relecture du 13/11). Une console de ~ ne
  // compte pas : elle « contient » toutes les copies, et n'y travaille pas.
  const liees = (chemin) => {
    const r = reelOu(chemin)
    const lie = (cwd) => dedans(cwd, chemin) || dedans(cwd, r) || (!!copies && dedans(cwd, copies) && (dedans(chemin, cwd) || dedans(r, cwd)))
    return (consoles?.() || []).filter((c) => c && c.status !== 'closed' && typeof c.cwd === 'string' && lie(c.cwd)).map((c) => ({ id: c.id, name: String(c.name ?? '') }))
  }
  return { estCopie: false, dossier, blocs: blocs.slice(1).filter((b) => !b.bare), cfg, commun, principal, copies, liees }
}

// Le dossier git d'une copie, lu dans les métadonnées du DÉPÔT PRINCIPAL : <commun>/worktrees/<id>/gitdir vaut
// « <copie>/.git » (c'est de là que `git worktree list` tire le chemin de la copie). Jamais dans le fichier .git de la
// copie, que son agent peut faire basculer vers un dépôt à lui pendant l'appel (relecture du 13/11, course prouvée).
function adminDe(chemin, commun) {
  const racineAdmin = path.join(commun, 'worktrees')
  let ids = []
  try {
    ids = fs.readdirSync(racineAdmin)
  } catch {
    return ''
  }
  const attendu = path.join(chemin, '.git')
  for (const id of ids) {
    const f = path.join(racineAdmin, id, 'gitdir')
    const st = fs.lstatSync(f, { throwIfNoEntry: false })
    if (st?.isFile() && st.size < 8192 && fs.readFileSync(f, 'utf8').replace(/\n$/, '') === attendu) return path.join(racineAdmin, id)
  }
  return ''
}

// Ce qu'on lit DANS une copie, écrite par un agent : tous les git y tournent épinglés (GIT_DIR = son dossier git dans le
// principal, GIT_WORK_TREE = la copie) ; puis sa configuration (filtres vidés, dépôt partiel refusé), puis son état.
async function dansLaCopie(chemin, commun) {
  if (reelOu(chemin) !== chemin) throw refus('le dossier de la copie est devenu un lien symbolique', 409)
  const admin = adminDe(chemin, commun)
  if (!admin) throw refus('dossier git de la copie introuvable dans le dépôt principal', 409)
  const epingle = { gitDir: admin, workTree: chemin }
  const cfg = await lireConfig(chemin, { delai: COPIE_MS, epingle })
  const { out, coupe } = await git(chemin, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all'], { max: ETAT_MAX, neutres: cfg.neutres, coupable: true, delai: COPIE_MS, epingle })
  let n = 0
  const m = texte(out).split('\0')
  for (let i = 0; i < m.length; i++)
    if (m[i]) {
      n++
      if (m[i][0] === '2') i++
    }
  return { nonCommites: n, coupe, cfg, epingle }
}

// Une ligne de la liste : rien de ce qui échoue pour une copie n'empêche de lister les autres (`erreur`).
async function decrisCopie(b, ctx) {
  const dansUneAutre = [ctx.dossier, ...ctx.blocs.map((x) => x.chemin)].some((x) => x !== b.chemin && dedans(b.chemin, x))
  const branche = typeof b.branch === 'string' ? b.branch.replace(/^refs\/heads\//, '') : ''
  const sha = typeof b.HEAD === 'string' && SHA.test(b.HEAD) ? b.HEAD : ''
  const c = {
    chemin: b.chemin,
    branche,
    detache: !!b.detached,
    sha,
    court: sha.slice(0, 7),
    verrou: !!b.locked,
    disparue: !!b.prunable || !fs.existsSync(b.chemin),
    // Copie de Meydan : la disposition exacte de lib/copies.mjs (<copiesDir>/<projet>/<nom>), et contenue dans aucun
    // autre worktree (un agent peut créer un worktree DANS sa copie : relecture du 13/11).
    meydan: !!ctx.copies && path.dirname(path.dirname(b.chemin)) === ctx.copies && path.dirname(path.dirname(reelOu(b.chemin))) === ctx.copies && !dansUneAutre,
    equipe: EQUIPE.test(branche),
    consoles: ctx.liees(b.chemin),
    avance: null,
    retard: null,
    nonCommites: null,
    nonCommitesCoupe: false,
    orphelins: 0, // tête détachée : commits de la copie qui ne sont dans aucune branche (perdus si on la retire)
    erreur: '',
  }
  try {
    if (sha && ctx.principal.sha) {
      const [retard, avance] = (await sortie(ctx.dossier, ['rev-list', '--left-right', '--count', `${ctx.principal.sha}...${sha}`, '--'])).split(/\s+/).map(Number)
      Object.assign(c, { avance, retard })
    } else if (sha) Object.assign(c, { avance: Number(await sortie(ctx.dossier, ['rev-list', '--count', sha, '--'])), retard: 0 })
    if (sha && !branche) c.orphelins = Number(await sortie(ctx.dossier, ['rev-list', '--count', sha, '--not', '--branches', '--']))
    if (!c.disparue) {
      const lu = await dansLaCopie(b.chemin, ctx.commun)
      c.nonCommites = lu.nonCommites
      c.nonCommitesCoupe = lu.coupe
      c.cfg = lu.cfg // gardés pour le retrait, retirés avant l'interface
      c.epingle = lu.epingle
    }
  } catch (e) {
    c.erreur = ligne(e.message, 300)
  }
  // « Prête » (résumé du téléphone, liseré de la ligne) : une branche à elle, du travail commité à fusionner, rien de non
  // commité ; la liste y ajoute l'absence de conflit (`listeCopies`).
  c.prete = !!branche && !c.equipe && !c.disparue && !c.erreur && c.avance > 0 && c.nonCommites === 0
  return c
}
const pourListe = ({ cfg, epingle, ...c }) => c

// Les commits de `a` absents de `de` (le plus récent d'abord), et leur nombre exact.
async function commitsEntre(dossier, de, a, total) {
  const champs = texte((await git(dossier, ['log', '-z', `-n${COMMITS_MAX}`, '--format=%H%x00%h%x00%an%x00%s', de ? `${de}..${a}` : a, '--'])).out).split('\0')
  const liste = []
  for (let i = 0; i + 3 < champs.length; i += 4) liste.push({ sha: champs[i], court: champs[i + 1], auteur: champs[i + 2], sujet: champs[i + 3] })
  return { commits: liste, commitsCoupe: total > liste.length ? total : 0 }
}

// Les fichiers d'une différence entre deux commits ou arbres (`revs` : [de, a] ou [« de...a »]) : nom, ancien nom, type,
// lignes ajoutées et retirées (null pour un binaire), et `lien` pour un lien symbolique que la différence pose (mode
// 120000 : à regarder, il peut viser hors du projet). Aucun programme externe (DIFF), filtres vidés.
async function fichiersEntre(dossier, revs, cfg) {
  const base = ['diff', ...DIFF, '-M', '-z']
  const o = { neutres: cfg.neutres, max: 16 << 20 }
  // --raw -z : « :ancien-mode nouveau-mode ancien-sha nouveau-sha STATUT NUL chemin NUL [nouveau chemin NUL] ».
  const ns = texte((await git(dossier, [...base, '--raw', ...revs, '--'], o)).out).split('\0')
  const nu = texte((await git(dossier, [...base, '--numstat', ...revs, '--'], o)).out).split('\0')
  const tous = []
  for (let i = 0; i < ns.length && ns[i]; ) {
    const [, nouveauMode, , , st = ''] = ns[i++].split(' ')
    const f = { chemin: '', type: TYPE_DIFF[st[0]] || 'modifié', ajouts: null, retraits: null }
    if (nouveauMode === '120000') f.lien = true
    if (st[0] === 'R' || st[0] === 'C') {
      f.ancien = ns[i++]
      f.chemin = ns[i++]
    } else f.chemin = ns[i++]
    tous.push(f)
  }
  // numstat -z : « ajouts TAB retraits TAB chemin NUL », ou pour un renommé « ajouts TAB retraits TAB NUL ancien NUL nouveau NUL ».
  for (let i = 0, j = 0; i < nu.length && nu[i] && j < tous.length; j++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(nu[i++])
    if (!m) break
    if (m[3] === '') i += 2
    if (m[1] !== '-') tous[j].ajouts = Number(m[1])
    if (m[2] !== '-') tous[j].retraits = Number(m[2])
  }
  return tous
}

// Un chemin que la fusion AJOUTE au dossier principal ne doit pas y exister déjà, ni passer par un lien ou un fichier
// posé à la place d'un de ses dossiers : git écrase sans un mot un fichier ignoré (un `.env`), et remplace ce qui gêne.
function ecrases(dossier, fichiers) {
  const vus = []
  for (const f of fichiers) {
    if (f.type !== 'ajouté' && f.type !== 'renommé') continue
    const parties = f.chemin.split('/')
    let p = dossier
    for (let i = 0; i < parties.length; i++) {
      p = path.join(p, parties[i])
      const st = fs.lstatSync(p, { throwIfNoEntry: false })
      if (!st) break
      if (i === parties.length - 1 || st.isSymbolicLink() || !st.isDirectory()) {
        vus.push(parties.slice(0, i + 1).join('/'))
        break
      }
    }
    if (vus.length >= 5) break
  }
  return [...new Set(vus)]
}

// Le contrôle d'une copie, relu à chaque appel (contrôle, fusion, retrait) : rien n'est écrit dans le dossier de travail.
// `fusion: false` (retrait) : pas de merge-tree.
async function controler(dossier, chemin, env, { fusion = true } = {}) {
  if (typeof chemin !== 'string' || !chemin) throw refus('chemin de la copie attendu')
  const ctx = await contexte(dossier, env)
  if (ctx.estCopie) throw refus(`cette carte suit une copie : fusion et retrait se font depuis la carte du dossier principal (${ligne(ctx.chemin, 300)})`, 409)
  const b = ctx.blocs.find((x) => x.chemin === chemin)
  if (!b) throw refus('copie inconnue de ce dépôt : relis la liste', 404)
  const c = await decrisCopie(b, ctx)
  const p = ctx.principal
  const cfg = ctx.cfg
  const vers = p.branche || 'la tête détachée'
  const refusF = []
  if (p.detache) refusF.push('le dossier principal est en tête détachée : aucune branche où fusionner')
  if (p.initial) refusF.push('le dossier principal n’a encore aucun commit')
  if (p.fusionEnCours) refusF.push('une fusion est déjà en cours dans le dossier principal : à terminer dans un terminal')
  if (p.suivis) refusF.push(`le dossier principal n’est pas propre : ${nb(p.suivis, 'fichier suivi')} modifié${s(p.suivis)} ou indexé${s(p.suivis)} (commite-les ou mets-les de côté)`)
  if (c.disparue) refusF.push('copie disparue (son dossier n’existe plus)')
  else if (c.erreur) refusF.push(`copie illisible : ${c.erreur}`)
  if (!c.branche) refusF.push('copie en tête détachée : aucune branche à fusionner')
  if (c.equipe) refusF.push('branche d’équipe : elle se livre par le bouton « Livrer » de son équipe')
  if (c.nonCommites) refusF.push(`la copie porte ${nb(c.nonCommites, 'changement')} non commité${s(c.nonCommites)} : commite-les d’abord (« Ouvrir le panneau de cette copie »)`)
  for (const n of cfg.filtres) refusF.push(`filtre « ${ligne(n, 60)} » déclaré dans la configuration git (LFS, chiffrement…) : à fusionner dans un terminal`)
  for (const n of cfg.pilotes) refusF.push(`pilote de fusion « ${ligne(n, 60)} » déclaré dans la configuration git (une commande) : à fusionner dans un terminal`)
  if (c.avance === 0) refusF.push(`rien à fusionner : ${vers} contient déjà tout le travail de la copie`)
  if (c.orphelins) refusF.push(`copie en tête détachée : ${nb(c.orphelins, 'commit')} dans aucune branche`)

  let commits = { commits: [], commitsCoupe: 0 }
  let fichiers = []
  let conflits = []
  let arbre = ''
  if (c.sha && c.avance) commits = await commitsEntre(dossier, p.sha, c.sha, c.avance)
  if (fusion && c.sha && p.sha && c.avance && !cfg.pilotes.size) {
    // Le contrôle : la fusion des deux têtes calculée dans le dépôt (objets), sans dossier de travail ni référence.
    const r = await git(dossier, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', p.sha, c.sha], { accepte1: true, neutres: cfg.neutres, delai: 60000, max: 16 << 20 })
    const [tete, ...noms] = texte(r.out).split('\0')
    if (!SHA.test(tete)) throw refus('contrôle des conflits illisible (merge-tree)', 500)
    if (r.code === 1) {
      for (const n of noms) {
        if (!n) break
        if (!conflits.includes(n)) conflits.push(n)
      }
      if (!conflits.length) conflits.push('(conflit sans nom de fichier)')
    } else arbre = tete
  }
  if (c.sha && p.sha && c.avance) {
    // Ce qui entre : la différence exacte que la fusion appliquerait au dossier principal ; en cas de conflit (ou sans
    // contrôle), ce que la copie a changé depuis son point de départ.
    const tous = await fichiersEntre(dossier, arbre ? [p.sha, arbre] : [`${p.sha}...${c.sha}`], cfg)
    if (arbre) {
      const gene = ecrases(dossier, tous)
      if (gene.length) refusF.push(`la fusion écraserait ${gene.map((x) => `« ${ligne(x, 200)} »`).join(', ')}, déjà sur le disque du dossier principal (fichier ignoré par git ?) : déplace-le d’abord`)
      // Un fichier marqué dans l'index (assume-unchanged : lettre minuscule ; skip-worktree : « S ») cache ses
      // modifications locales à git : une fusion qui le touche les écraserait sans rien dire (relecture du 13/11).
      const marques = await marquesIndex(dossier)
      const touches = tous.flatMap((f) => (f.ancien ? [f.chemin, f.ancien] : [f.chemin])).filter((x) => marques.has(x))
      if (touches.length) refusF.push(`${touches.slice(0, 5).map((x) => `« ${ligne(x, 200)} »`).join(', ')} : marqué assume-unchanged ou skip-worktree dans l’index du dossier principal (ses modifications locales seraient écrasées) : à fusionner dans un terminal`)
    }
    fichiers = tous
  }
  if (conflits.length) refusF.push(`conflit dans ${nb(conflits.length, 'fichier')} : à résoudre dans un terminal (par exemple en fusionnant ${vers} dans la copie)`)

  const refusR = []
  if (!c.meydan) refusR.push(`pas une copie de Meydan (hors de ${ligne(env.copiesDir, 200)}) : à retirer dans un terminal`)
  for (const k of c.consoles) refusR.push(`la console « ${ligne(k.name, 80)} » travaille dans cette copie : ferme-la d’abord`)
  if (c.verrou) refusR.push('copie verrouillée (git worktree lock) : à retirer dans un terminal')
  if (!c.disparue && c.erreur) refusR.push(`copie illisible : ${c.erreur}`)
  if (c.nonCommites) refusR.push(`la copie porte ${nb(c.nonCommites, 'changement')} non commité${s(c.nonCommites)} : rien n’est retiré (commite-les, ou retire-la dans un terminal)`)
  if (c.branche && c.avance === null) refusR.push('avance de la branche illisible : rien n’est retiré')
  if (c.orphelins) refusR.push(`copie en tête détachée avec ${nb(c.orphelins, 'commit')} dans aucune branche : ils seraient perdus, à retirer dans un terminal`)
  if (!c.disparue && c.epingle) {
    c.sousModules = await sousModulesDe(c.chemin, c.epingle)
    if (c.sousModules) refusR.push('la copie porte un sous-module (son dépôt et ses commits jamais poussés partiraient avec elle) : à retirer dans un terminal')
    for (const o of occupants(c.chemin)) refusR.push(`le processus ${o.pid} (${ligne(o.nom, 40)}) a son dossier ou un fichier ouvert dans la copie : arrête-le d’abord`)
  }

  return {
    ctx,
    principal: { dossier, branche: p.branche, detache: p.detache, sha: p.sha, court: p.court },
    copie: pourListe(c),
    avance: c.avance,
    retard: c.retard,
    ...commits,
    fichiers: fichiers.slice(0, LISTE_MAX),
    fichiersCoupe: fichiers.length > LISTE_MAX ? fichiers.length : 0,
    aRegarder: fichiers.filter((f) => f.lien || A_REGARDER.test(f.chemin) || (f.ancien && A_REGARDER.test(f.ancien))).map((f) => f.chemin).slice(0, 50),
    conflits: conflits.slice(0, LISTE_MAX),
    arbre,
    refus: refusF,
    possible: refusF.length === 0,
    // `supprimable` : seule une branche de copie de Meydan (meydan/<nom>, pas une branche d'équipe) est supprimée par le
    // panneau ; une autre branche posée dans la copie (un agent a pu changer de branche) reste, et le retrait le dit.
    retrait: { possible: refusR.length === 0, refus: refusR, fusionnee: !c.branche || c.avance === 0, perdus: c.branche ? c.avance ?? 0 : 0, branche: c.branche, supprimable: /^meydan\//.test(c.branche) && !c.equipe },
    cfgCopie: c.cfg,
    epingleCopie: c.epingle,
  }
}
const pourControle = ({ ctx, arbre, cfgCopie, epingleCopie, ...k }) => k

// Une copie qui porte un sous-module (un gitlink dans son index, ou son dossier `modules` dans le dépôt principal) : son
// dépôt et ses commits jamais poussés partiraient avec elle (`git worktree remove` le refusait ; seconde relecture du
// 13/11). Index trop grand pour être relu : on le tient pour vrai (refus).
async function sousModulesDe(chemin, epingle) {
  if (fs.existsSync(path.join(epingle.gitDir, 'modules'))) return true
  const { out, coupe } = await git(chemin, ['ls-files', '-s', '-z'], { max: 64 << 20, coupable: true, epingle })
  return coupe || texte(out).split('\0').some((e) => e.startsWith('160000 '))
}

// Les processus (ceux qu'on peut lire : le même utilisateur) dont le dossier courant ou un fichier ouvert est dans la
// copie. Un complément du retrait, pas sa protection : un processus peut agir sur la copie sans y être (`effaceArbre`).
function occupants(chemin) {
  const vus = []
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x) && Number(x) !== process.pid)
  } catch {
    return vus
  }
  const lis = (f) => {
    try {
      return fs.readlinkSync(f)
    } catch {
      return ''
    }
  }
  for (const pid of pids) {
    const liens = [lis(`/proc/${pid}/cwd`)]
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) liens.push(lis(`/proc/${pid}/fd/${fd}`))
    } catch {} // processus parti, ou d'un autre utilisateur
    if (!liens.some((l) => l && dedans(l, chemin))) continue
    let nom = '?'
    try {
      nom = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    } catch {}
    vus.push({ pid: Number(pid), nom })
    if (vus.length >= 5) break
  }
  return vus
}

// Efface le dossier d'une copie sans jamais suivre un lien : GNU rm parcourt l'arbre par descripteurs (fts, chaque dossier
// ouvert relativement à son parent) ; un lien posé à la place d'un dossier pendant l'effacement est effacé comme lien,
// jamais suivi (prouvé sous la course de la relecture : test/volets/copies/fusion-api.mjs). --one-file-system : rien sur
// un autre système de fichiers monté dessous. Liste d'arguments, rm par son chemin absolu, environnement minimal.
async function effaceArbre(chemin, quoi) {
  const { err, errOut } = await lance('/usr/bin/rm', ['-rf', '--one-file-system', '--', chemin], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, max: 1 << 20, delai: RETRAIT_MS })
  if (err) {
    const dit = ligne(texte(errOut || Buffer.alloc(0)).trim().split('\n').slice(-3).join(' · '))
    throw refus(`le retrait n’a pas pu effacer tout ${quoi} (${err.killed ? `rm n’a pas fini en ${RETRAIT_MS / 1000} s` : dit || ligne(err.message)}) ; rien n’a été effacé en dehors : à finir dans un terminal`, 409)
  }
}

// Les chemins marqués dans l'index du dossier principal (`ls-files -v` : lettre minuscule = assume-unchanged, « S » =
// skip-worktree). Une liste coupée ne permet pas de conclure : refus.
async function marquesIndex(dossier) {
  const { out, coupe } = await git(dossier, ['ls-files', '-v', '-z'], { max: 64 << 20, coupable: true })
  if (coupe) throw refus('index du dossier principal trop grand pour être relu : à fusionner dans un terminal', 409)
  const marques = new Set()
  for (const e of texte(out).split('\0')) if (e.length > 2 && (/^[a-z]$/.test(e[0]) || e[0] === 'S')) marques.add(e.slice(2))
  return marques
}

export function ouvreGit({ send, readJson, copiesDir = '', consoles = () => [] }) {
  const env = { copiesDir, consoles }
  // Un commit à la fois par dépôt (deux clics rapides, deux onglets) : le second attend le premier.
  const files = new Map()
  const listes = new Map() // dossier → { promesse, fin } : la dernière liste des copies (`listeCopies`)
  const enFile = (dossier, fn) => {
    const suite = (files.get(dossier) ?? Promise.resolve()).then(fn).finally(() => listes.clear())
    const garde = suite.catch(() => {})
    files.set(dossier, garde)
    garde.then(() => files.get(dossier) === garde && files.delete(dossier))
    return suite
  }

  async function etat(res, dossier) {
    const cfg = await lireConfig(dossier)
    return send(res, 200, pourInterface(await lireEtat(dossier, cfg)))
  }

  // ── Copies ──
  // Une liste par dépôt à la fois, gardée LISTE_MS : chaque carte, onglet et tuile la relit (toutes les 30 s sur PC) et
  // chaque copie coûte quelques git. Une demande qui arrive pendant le calcul l'attend ; « ↻ » (`?relire=1`) la refait
  // une fois finie ; une écriture du panneau (commit, fusion, retrait) les oublie toutes (`enFile`).
  async function listeCopies(res, dossier, url) {
    const relire = url.searchParams.get('relire') === '1'
    let l = listes.get(dossier)
    if (!l || (l.fin && (relire || Date.now() > l.fin))) {
      const neuve = { promesse: calculeListe(dossier), fin: 0 }
      listes.set(dossier, neuve)
      neuve.promesse.then(
        () => (neuve.fin = Date.now() + LISTE_MS),
        () => listes.get(dossier) === neuve && listes.delete(dossier),
      )
      l = neuve
    }
    return send(res, 200, await l.promesse)
  }
  async function calculeListe(dossier) {
    const lu = Date.now()
    const ctx = await contexte(dossier, env)
    if (ctx.estCopie) return { estCopie: true, principal: { dossier: ctx.chemin }, copies: [], coupe: 0, lu }
    // Quatre copies décrites à la fois : chacune lance quelques git bornés par leur délai.
    const blocs = ctx.blocs.slice(0, COPIES_MAX)
    const copies = new Array(blocs.length)
    let suivant = 0
    await Promise.all(
      Array.from({ length: Math.min(4, blocs.length) }, async () => {
        while (suivant < blocs.length) {
          const i = suivant++
          copies[i] = pourListe(await decrisCopie(blocs[i], ctx))
        }
      }),
    )
    const p = ctx.principal
    // « Prête » : la fusion passerait. Le même merge-tree que le contrôle le vérifie (dix copies au plus par liste), jamais
    // quand un pilote de fusion ou un filtre est déclaré, ni quand le dossier principal ne peut pas recevoir de fusion.
    const recevable = !p.detache && !p.initial && !p.suivis && !p.fusionEnCours && !ctx.cfg.pilotes.size && !ctx.cfg.filtres.size
    let essais = 0
    for (const c of copies)
      if (c.prete)
        c.prete =
          recevable &&
          essais++ < 10 &&
          (await git(dossier, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', p.sha, c.sha], { accepte1: true, neutres: ctx.cfg.neutres, delai: 20000, max: 1 << 20 }).then(
            (r) => r.code !== 1,
            () => false,
          ))
    return { estCopie: false, principal: { dossier, branche: p.branche, detache: p.detache, sha: p.sha, court: p.court }, copies, coupe: ctx.blocs.length > COPIES_MAX ? ctx.blocs.length : 0, lu }
  }

  async function controle(req, res, dossier) {
    const corps = await readJson(req)
    return send(res, 200, pourControle(await controler(dossier, corps.chemin, env)))
  }

  // La fusion confirmée : le contrôle est refait en entier ; les deux têtes vues par Orkun doivent être celles d'à présent
  // (comme `livrer(…, pret)` de lib/equipage.mjs), et c'est le SHA confirmé de la copie qui est fusionné, pas sa branche.
  // `--no-ff` : un commit de fusion à chaque fois, même quand une avance rapide suffirait — la branche principale garde
  // une étape par copie fusionnée (lisible dans « Commits », annulable d'un bloc par `git revert -m 1`), et la forme du
  // résultat est vérifiable (parents = les deux têtes confirmées, arbre = celui du contrôle).
  async function fusion(req, res, dossier) {
    const corps = await readJson(req)
    if (corps.confirme !== true) throw refus('fusion non confirmée (confirme: true attendu)')
    if (!SHA.test(String(corps.principal)) || !SHA.test(String(corps.copie))) throw refus('les deux têtes vues au contrôle sont attendues (principal, copie)')
    // Les NOMS vus au contrôle aussi : au même commit, le dossier principal peut avoir changé de branche (`git switch -c`)
    // et la fusion irait dans une autre branche que celle confirmée (relecture du 13/11).
    if (typeof corps.branche !== 'string' || !corps.branche || typeof corps.brancheCopie !== 'string' || !corps.brancheCopie) throw refus('les deux branches vues au contrôle sont attendues (branche, brancheCopie)')
    return enFile(dossier, async () => {
      const k = await controler(dossier, corps.chemin, env)
      if (k.principal.sha !== corps.principal || k.copie.sha !== corps.copie)
        throw refus(`a bougé depuis le contrôle (dossier principal ${k.principal.court || '—'}, copie ${k.copie.court || '—'}) : refais le contrôle avant de confirmer`, 409)
      if (k.principal.branche !== corps.branche || k.copie.branche !== corps.brancheCopie)
        throw refus(`une branche a changé depuis le contrôle (dossier principal sur « ${ligne(k.principal.branche, 120) || 'tête détachée'} », copie sur « ${ligne(k.copie.branche, 120) || 'tête détachée'} ») : refais le contrôle avant de confirmer`, 409)
      if (k.refus.length) throw refus(`fusion refusée : ${k.refus.join(' · ')}`, 409)
      if (!k.arbre) throw refus('fusion refusée : contrôle des conflits incomplet', 409)
      const avant = k.principal.sha
      const message = `Fusion de la copie ${k.copie.branche} dans ${k.principal.branche}\n\nFaite depuis le panneau Git de Meydan, après contrôle des conflits.\nCopie : ${k.copie.chemin}\n`
      const neutres = [...k.ctx.cfg.neutres, [`branch.${k.principal.branche}.mergeOptions`, ''], ['submodule.recurse', 'false']]
      const o = { ecrit: true, delai: FUSION_MS, neutres, lignes: 12 }
      // L'état d'avant, complet (fichiers suivis ET non suivis), pour ne dire « revenu à son état d'avant » qu'après l'avoir
      // vérifié. Les fichiers que git ne voit pas (assume-unchanged, skip-worktree) ont fait refuser la fusion plus haut.
      const etatAvant = await statutComplet(dossier, k.ctx.cfg)
      try {
        await git(dossier, ['merge', '--no-ff', '--no-edit', '--no-verify', '--no-gpg-sign', '--no-verify-signatures', '--no-stat', '--no-autostash', '-q', '-s', 'ort', '-m', message, corps.copie], o)
      } catch (e) {
        // Retour à l'état d'avant : `merge --abort` seulement si c'est CETTE fusion qui est restée en cours.
        const enCours = await sortie(dossier, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')
        if (enCours === corps.copie) await git(dossier, ['merge', '--abort'], o).catch(() => {})
        const apres = await lirePrincipal(dossier, k.ctx.cfg).catch(() => null)
        const etatApres = await statutComplet(dossier, k.ctx.cfg).catch(() => null)
        if (!apres || apres.sha !== avant || apres.fusionEnCours || etatApres !== etatAvant)
          throw refus(`la fusion a échoué ET le dossier principal n’est pas revenu à son état d’avant (tête ${apres?.court || '?'}, état ${etatApres === etatAvant ? 'identique' : 'différent'}) : à regarder dans un terminal — ${e.message}`, 500)
        throw refus(`fusion refusée par git ; dossier principal vérifié revenu à son état d’avant (tête, fichiers suivis et non suivis) — ${e.message}`, 409)
      }
      const [apres, parent1, parent2, arbre] = (await sortie(dossier, ['rev-parse', 'HEAD', 'HEAD^1', 'HEAD^2', 'HEAD^{tree}']).catch(() => '')).split('\n')
      if (parent1 !== avant || parent2 !== corps.copie || arbre !== k.arbre)
        throw refus(`après la fusion, la tête ${ligne(apres, 12).slice(0, 7)} n’a pas la forme attendue (parents ${avant.slice(0, 7)} et ${corps.copie.slice(0, 7)}, arbre du contrôle) : à regarder dans un terminal`, 500)
      return send(res, 200, {
        avant,
        apres,
        court: apres.slice(0, 7),
        branche: k.principal.branche,
        copie: { chemin: k.copie.chemin, branche: k.copie.branche, sha: corps.copie },
        commits: k.avance,
        etat: pourInterface(await lireEtat(dossier, k.ctx.cfg)),
      })
    })
  }

  // Le retrait d'une copie de Meydan : son dossier, puis sa branche — `-d` si elle est fusionnée ; si elle ne l'est pas,
  // gardée par défaut, et supprimée seulement si la demande le dit ET redit le nombre exact de commits perdus (`perdus`,
  // montré à Orkun à la seconde confirmation), par `update-ref -d` au SHA confirmé (refusé si elle a bougé entre-temps).
  // Le dossier : jugé propre par le contrôle épinglé refait ici, puis `worktree remove --force` (voir l'en-tête : le
  // `git status` interne de `worktree remove` relirait le fichier .git de la copie, que son agent peut faire basculer).
  async function retrait(req, res, dossier) {
    const corps = await readJson(req)
    if (corps.confirme !== true) throw refus('retrait non confirmé (confirme: true attendu)')
    if (!SHA.test(String(corps.copie)) && corps.copie !== '') throw refus('la tête de la copie vue au contrôle est attendue (copie)')
    const supprime = corps.supprimeBranche === true
    return enFile(dossier, async () => {
      const k = await controler(dossier, corps.chemin, env, { fusion: false })
      const c = k.copie
      if (c.sha !== corps.copie) throw refus('la copie a bougé depuis le contrôle : refais le contrôle avant de confirmer', 409)
      if (!k.retrait.possible) throw refus(`retrait refusé : ${k.retrait.refus.join(' · ')}`, 409)
      const { fusionnee, perdus, supprimable } = k.retrait
      if (c.branche && supprime && !supprimable) throw refus(`la branche ${c.branche} n’est pas une branche de copie de Meydan : le panneau ne la supprime pas (retire la copie en la gardant)`, 409)
      if (c.branche && !fusionnee && supprime && corps.perdus !== perdus)
        throw refus(`la branche ${c.branche} porte ${nb(perdus, 'commit')} non fusionné${s(perdus)}, pas ${ligne(corps.perdus, 12) || '?'} : relis avant de confirmer`, 409)
      // La trace de la copie dans le dépôt principal (lue là, jamais dans la copie), effacée après son dossier.
      const admin = adminDe(c.chemin, k.ctx.commun)
      if (!admin || !fs.lstatSync(admin, { throwIfNoEntry: false })?.isDirectory()) throw refus('trace git de la copie introuvable dans le dépôt principal : à regarder dans un terminal', 409)
      if (fs.lstatSync(c.chemin, { throwIfNoEntry: false })) {
        if (c.disparue) throw refus('copie cassée (son fichier .git manque, son dossier reste) : à retirer dans un terminal', 409)
        if (c.nonCommites !== 0 || !k.epingleCopie || c.sousModules !== false) throw refus('retrait refusé : la copie n’a pas pu être jugée propre', 409)
        await effaceArbre(c.chemin, 'le dossier de la copie')
        if (fs.lstatSync(c.chemin, { throwIfNoEntry: false })) throw refus('le dossier de la copie est encore là après son effacement : à regarder dans un terminal', 500)
      }
      // Ce que `git worktree remove` fait après le dossier, pour cette copie seule : son dossier d'administration.
      await effaceArbre(admin, 'la trace git de la copie')
      if ((await worktrees(dossier)).some((x) => x.chemin === c.chemin)) throw refus('copie effacée, mais git la liste encore : à regarder dans un terminal', 500)
      const branche = { nom: c.branche, supprimee: false, commits: perdus, raison: '' }
      if (c.branche) {
        try {
          if (!supprimable) branche.raison = 'branche hors des copies de Meydan : gardée'
          else if (fusionnee) await git(dossier, ['branch', '-d', '--', c.branche], { ecrit: true })
          else if (supprime) await git(dossier, ['update-ref', '-d', `refs/heads/${c.branche}`, corps.copie], { ecrit: true, perteConfirmee: true })
        } catch (e) {
          branche.raison = `dossier retiré, branche gardée : ${e.message}`
        }
        branche.supprimee = !(await sortie(dossier, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branche}`]).catch(() => ''))
        if (branche.supprimee && (!supprimable || (!fusionnee && !supprime))) throw refus(`la branche ${c.branche} a disparu alors qu’elle devait rester : à regarder dans un terminal`, 500)
      }
      return send(res, 200, { retire: c.chemin, branche })
    })
  }

  async function difference(res, dossier, url) {
    const chemin = cheminValide(url.searchParams.get('chemin'))
    const cote = url.searchParams.get('cote') || 'travail'
    if (cote !== 'travail' && cote !== 'index') throw refus('cote : travail ou index')
    const cfg = await lireConfig(dossier)
    const f = (await lireEtat(dossier, cfg)).tous.find((x) => x.chemin === chemin)
    if (!f) throw refus('fichier absent de l’état du dépôt', 409)
    if (chemin.endsWith('/')) throw refus('dépôt git imbriqué : le panneau n’y entre pas', 409)
    if (f.type === 'non suivi') return send(res, 200, nonSuivi(dossier, chemin))
    const args = ['diff', ...DIFF, '-M', ...(cote === 'index' ? ['--cached'] : []), '--', chemin, ...(f.ancien && cote === 'index' ? [f.ancien] : [])]
    const { out, coupe } = await git(dossier, args, { max: DIFF_MAX, coupable: true, neutres: cfg.neutres })
    return send(res, 200, { diff: texte(out), coupe })
  }

  async function detail(res, dossier, demande) {
    if (!/^[0-9a-f]{4,64}$/.test(demande)) throw refus('sha attendu : 4 à 40 caractères hexadécimaux (64 pour un dépôt en SHA-256)')
    const cfg = await lireConfig(dossier)
    const sha = await sortie(dossier, ['rev-parse', '--verify', '--quiet', `${demande}^{commit}`]).catch(() => '')
    if (!sha) throw refus('commit inconnu dans ce dépôt', 404)
    // -z : champs séparés par NUL, l'enregistrement terminé par NUL (retiré avant de découper).
    const [plein, court, auteur, date, ...message] = texte((await git(dossier, ['log', '-1', '-z', '--format=%H%x00%h%x00%an%x00%aI%x00%B', sha, '--'])).out).replace(/\0$/, '').split('\0')
    // Un commit de fusion se montre par rapport à son premier parent (ce que la branche a reçu).
    const vue = ['show', ...DIFF, '--format=', '--diff-merges=first-parent']
    const stat = texte((await git(dossier, [...vue, '--stat=200', sha, '--'], { neutres: cfg.neutres })).out)
    const { out, coupe } = await git(dossier, [...vue, '--patch', '-M', sha, '--'], { max: DIFF_MAX, coupable: true, neutres: cfg.neutres })
    return send(res, 200, { sha: plein, court, auteur, date, message: message.join('\0').replace(/\n+$/, ''), stat, diff: texte(out), coupe })
  }

  async function commit(req, res, dossier) {
    const corps = await readJson(req)
    if (corps.confirme !== true) throw refus('commit non confirmé (confirme: true attendu)')
    const message = typeof corps.message === 'string' ? corps.message.replace(/\r\n?/g, '\n') : ''
    if (!message.trim()) throw refus('message du commit obligatoire')
    if (message.length > MESSAGE_MAX) throw refus(`message trop long : ${MESSAGE_MAX} caractères au plus`)
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(message)) throw refus('message : caractère de contrôle refusé')
    if (!Array.isArray(corps.fichiers) || !corps.fichiers.length) throw refus('aucun fichier choisi')
    if (corps.fichiers.length > LISTE_MAX) throw refus(`${LISTE_MAX} fichiers au plus par commit`)
    const choisis = [...new Set(corps.fichiers.map(cheminValide))]
    return enFile(dossier, async () => {
      // L'état est relu au moment du commit : seuls des fichiers qui y figurent partent.
      const cfg = await lireConfig(dossier)
      const { tous } = await lireEtat(dossier, cfg)
      const entrees = choisis.map((c) => tous.find((f) => f.chemin === c))
      const absent = entrees.indexOf(undefined)
      if (absent >= 0) throw refus(`fichier absent de l’état du dépôt : ${ligne(choisis[absent], 200)}`, 409)
      const conflit = entrees.find((f) => f.type === 'conflit')
      if (conflit) throw refus(`conflit non résolu : ${ligne(conflit.chemin, 200)} (à résoudre dans un terminal)`, 409)
      const imbrique = entrees.find((f) => f.chemin.endsWith('/'))
      if (imbrique) throw refus(`dépôt git imbriqué : ${ligne(imbrique.chemin, 200)} n’est pas commité par le panneau`, 409)
      const chemins = [...new Set(entrees.flatMap((f) => (f.ancien ? [f.chemin, f.ancien] : [f.chemin])))]
      if (chemins.reduce((n, c) => n + Buffer.byteLength(c) + 1, 0) > CHEMINS_MAX) throw refus('trop de fichiers d’un coup : commite-les en plusieurs fois')
      if (cfg.filtres.size) {
        const attr = texte((await git(dossier, ['check-attr', '-z', 'filter', '--', ...chemins])).out).split('\0')
        for (let i = 0; i + 2 < attr.length; i += 3)
          if (cfg.filtres.has(attr[i + 2])) throw refus(`fichier passé par le filtre « ${ligne(attr[i + 2], 60)} » (LFS, chiffrement…) : à commiter dans un terminal`, 409)
      }
      // Commit des seuls fichiers choisis, dans leur contenu actuel sur le disque (`git commit --only -- <chemins>`,
      // ce que fait `git commit <chemins>`) : un index temporaire = HEAD + ces fichiers. Le reste de l'index est
      // laissé tel quel (indexé reste indexé, non indexé reste non indexé). Un fichier non suivi doit d'abord être
      // connu de l'index : il y est déclaré sans contenu (--intent-to-add), et retiré de l'index si le commit échoue.
      const nouveaux = entrees.filter((f) => f.type === 'non suivi').map((f) => f.chemin)
      const ecrit = { ecrit: true, delai: COMMIT_MS, neutres: cfg.neutres }
      if (nouveaux.length) await git(dossier, ['add', '--intent-to-add', '--', ...nouveaux], ecrit)
      try {
        await git(dossier, ['commit', '--only', '--no-verify', '--no-gpg-sign', '-q', '-F', '-', '--', ...chemins], { ...ecrit, entree: message })
      } catch (e) {
        if (nouveaux.length) await git(dossier, ['update-index', '--force-remove', '--', ...nouveaux], ecrit).catch(() => {})
        throw refus(`commit refusé — ${e.message}`, 409)
      }
      const sha = await sortie(dossier, ['rev-parse', 'HEAD'])
      const court = await sortie(dossier, ['rev-parse', '--short', 'HEAD'])
      return send(res, 200, { sha, court, etat: pourInterface(await lireEtat(dossier, cfg)) })
    })
  }

  return {
    api(req, res, url, carte, reste) {
      return demande.run(new Map(), () => aiguille(req, res, url, carte, reste))
    },
    // lib/cartes.mjs, à la création d'une carte git sur une copie (`depot`) : lève si `depot` n'est pas son dépôt principal.
    ancre: (depot, dossier) => ancreDeCopie(depot, dossier, 400),
  }
  // Chaque demande tourne dans son propre contexte (`demande`) : les dossiers git qu'elle épingle ne valent que pour elle.
  async function aiguille(req, res, url, carte, reste) {
      const [a, b, ...plus] = reste
      const m = req.method
      let route = ''
      if (a === undefined) route = m === 'GET' ? 'etat' : '-'
      else if (a === 'diff' && b === undefined) route = m === 'GET' ? 'diff' : '-'
      else if (a === 'commit' && b === undefined) route = m === 'POST' ? 'commit' : '-'
      else if (a === 'commit' && !plus.length) route = m === 'GET' ? 'detail' : '-'
      else if (a === 'copies' && b === undefined) route = m === 'GET' ? 'copies' : '-'
      else if (a === 'copies' && ['controle', 'fusion', 'retrait'].includes(b) && !plus.length) route = m === 'POST' ? b : '-'
      else return send(res, 404, { error: 'route inconnue' })
      if (route === '-') return send(res, 405, { error: 'méthode refusée' })
      const dossier = carte.dossier
      if (!dossier) return send(res, 409, { error: 'aucun projet choisi pour cette carte' })
      // L'ancre de la demande d'abord, pour toutes les routes (une carte sur une copie : par son dépôt enregistré).
      await racine(dossier, { depot: typeof carte.depot === 'string' ? carte.depot : '', copiesDir })
      if (route === 'commit') return commit(req, res, dossier)
      if (route === 'fusion') return fusion(req, res, dossier)
      if (route === 'retrait') return retrait(req, res, dossier)
      if (route === 'etat') return etat(res, dossier)
      if (route === 'diff') return difference(res, dossier, url)
      if (route === 'copies') return listeCopies(res, dossier, url)
      if (route === 'controle') return controle(req, res, dossier)
      return detail(res, dossier, b)
  }
}
