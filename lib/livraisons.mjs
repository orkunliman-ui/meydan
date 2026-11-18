// File de livraison des équipiers (volet livraison-equipes, 17/11). Idée reprise de Hangar (hangar-ai/hangar, licence MIT,
// crates/hangar-core/src/delivery.rs : « Each one is merged onto the branch as it is now in a worktree of its own,
// checked with the workspace's command, read by a reviewer agent with a fresh context, and only then landed, or handed
// back to its worker with what failed. Nothing is ever pushed. »), adaptée à Meydan :
//   - la branche visée est la branche d'INTÉGRATION de l'équipe (extraite dans le dossier du capitaine), jamais le projet
//     d'Orkun ni `main` : la livraison au projet reste sur son go (bouton « Livrer ») ;
//   - (a) la fusion est calculée dans le dépôt, sans dossier de travail ni référence (`merge-tree --write-tree`, puis
//     `commit-tree`), et n'est extraite dans un worktree temporaire (equipage.addWorktree : détaché, rempli sans la
//     configuration du dépôt) que pour la vérification et la relecture ; un dépôt qui déclare un filtre ou un pilote de
//     fusion (des commandes que la fusion lancerait, leçons du 13/11 n°221-222) n'entre pas dans la file : rassemblé à
//     la main par le capitaine, comme avant ;
//   - (b) la commande de vérification réglée par Orkun pour l'équipe, lancée dans ce worktree, environnement minimal
//     (jamais le jeton d'une console), délai borné, groupe de processus tué par son PID ;
//   - (c) la relecture (server.mjs) : console Codex en lecture seule de lib/verification.mjs ;
//   - (d) l'atterrissage : avance rapide du dossier du capitaine, avec les contrôles de `equipage.livrer` (fichiers
//     modifiés, nouveaux ou ignorés que la fusion changerait : leçon du 17/11 n°261) ; jamais de remise de côté.
// Ce module ne fait que le git et la commande ; la suite d'un résultat (renvoi à l'équipier, réveil du capitaine) est
// décidée par server.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { refus, ligne, tete, ancetre, git, local } from './equipage.mjs'
import { NOM } from './nom.mjs'

const SHA = /^[0-9a-f]{40,64}$/
export const MAX_COMMANDE = 500
export const DELAI_VERIFICATION = 20 * 60 * 1000 // Hangar : 30 min ; ici 20, une suite d'essais de projet tient dedans
const JOURNAL_MAX = 1 << 20 // octets gardés dans le journal de la vérification
const FIN_MAX = 6 * 1024 // fin de sortie rendue (Hangar : 60 lignes, 6 Ko)
const FIN_LIGNES = 60
// Identité fixe des commits de fusion de la file : ne dépend d'aucune configuration.
const IDENTITE = { GIT_AUTHOR_NAME: 'Meydan', GIT_AUTHOR_EMAIL: 'meydan@localhost', GIT_COMMITTER_NAME: 'Meydan', GIT_COMMITTER_EMAIL: 'meydan@localhost' }

// Textes que la file envoie aux agents (capitaine, équipier), réunis ici pour être produits et éprouvés hors du serveur
// (test/volets/nom-reglable : identité pour Orkun, aucun « Orkun » sous un autre nom).
export const texteFileCoupee = (branche) => `file désactivée par ${NOM} : rassemble-la à la main (git merge ${branche})`
export const TEXTE_ARRET = `équipe arrêtée par ${NOM}`
export const texteAnnonce = (lignes) => `File de livraison :\n${lignes.map((l) => `- ${l}`).join('\n')}`
export const texteRenvoi = ({ etape, raison, consigne, branche }) =>
  `[Meydan] Ta livraison est refusée à l'étape « ${etape} » : ${raison}.\n${consigne}\nCorrige sur ta branche (${branche}), puis redonne \`statut done\` avec tes preuves, ou \`blocked\` si tu ne peux pas.`

// La commande d'Orkun : une ligne, bornée, sans caractère de contrôle. Vide = pas de vérification.
export function lisCommande(x) {
  if (typeof x !== 'string') throw refus('commande de vérification : texte attendu')
  const c = x.trim()
  if (c.length > MAX_COMMANDE) throw refus(`commande de vérification trop longue (${MAX_COMMANDE} caractères au plus)`)
  if (/[\u0000-\u001f\u007f-\u009f]/.test(c)) throw refus('commande de vérification : une seule ligne, sans caractère de contrôle')
  return c
}

// git avec un code de sortie lu (merge-tree : 1 = conflit) : mêmes réglages que equipage.gitAvec.
function gitCode(cwd, args, { env = {}, neutres = [] } = {}) {
  const vars = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }
  neutres.forEach(([cle, valeur], i) => {
    vars[`GIT_CONFIG_KEY_${i}`] = cle
    vars[`GIT_CONFIG_VALUE_${i}`] = valeur
  })
  if (neutres.length) vars.GIT_CONFIG_COUNT = String(neutres.length)
  return new Promise((resolve) =>
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-C', cwd, ...args], { env: vars, maxBuffer: 16 << 20, timeout: 120000 }, (err, out, errOut) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out), err: ligne(String(errOut || err?.message || '').trim().split('\n').slice(-3).join(' · '), 600) }),
    ),
  )
}

// Ce que la configuration du dépôt ferait lancer par une fusion : filtres et pilotes de fusion (git-panneau, lireConfig).
export async function configGenante(projet) {
  const r = await gitCode(projet, ['config', '-z', '--list'])
  if (r.code !== 0) return `configuration git illisible (${r.err})`
  const noms = []
  for (const e of r.out.split('\0')) {
    const cle = e.split('\n', 1)[0]
    const m = /^filter\.(.+)\.(clean|smudge|process)$/.exec(cle) || /^merge\.(.+)\.driver$/.exec(cle)
    if (m && !noms.includes(cle)) noms.push(cle)
  }
  return noms.length ? `le dépôt déclare ${noms.slice(0, 3).join(', ')} (des commandes qu’une fusion lancerait)` : ''
}

// (a) La fusion de `tip` (branche de l'équipier) sur `base` (tête de l'intégration), calculée sans dossier de travail.
// Rend { deja } (déjà contenue), { merge } (avance rapide possible : merge = tip, ou commit de fusion), ou { conflits }.
export async function fusionne(projet, base, tip, message) {
  if (!SHA.test(base) || !SHA.test(tip)) throw refus('fusion : commit illisible', 500)
  if (await ancetre(projet, tip, base)) return { deja: true, merge: base }
  if (await ancetre(projet, base, tip)) return { merge: tip, avance: true }
  const r = await gitCode(projet, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', base, tip])
  const [arbre, ...noms] = r.out.split('\0')
  if (r.code === 1) {
    const conflits = [...new Set(noms.filter(Boolean))]
    return { conflits: conflits.length ? conflits : ['(conflit sans nom de fichier)'] }
  }
  if (r.code !== 0 || !SHA.test(arbre)) throw refus(`fusion impossible : ${r.err || 'merge-tree illisible'}`, 409)
  const c = await gitCode(projet, ['commit-tree', '--no-gpg-sign', arbre, '-p', base, '-p', tip, '-m', message], { env: IDENTITE })
  const merge = c.out.trim()
  if (c.code !== 0 || !SHA.test(merge)) throw refus(`commit de fusion impossible : ${c.err}`, 409)
  return { merge }
}

// Les fichiers que la livraison change (de la tête d'intégration au commit de fusion).
export async function changes(projet, base, merge) {
  const r = await gitCode(projet, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', base, merge])
  return r.code === 0 ? r.out.split('\0').filter(Boolean) : []
}

// Le texte de la différence, borné, pour le relecteur.
export async function difference(projet, base, merge, max = 200 * 1024) {
  const r = await gitCode(projet, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', base, merge])
  const t = r.out
  return t.length > max ? `${t.slice(0, max)}\n[… différence coupée à ${max} octets : lis le reste avec git diff ${base.slice(0, 12)} ${merge.slice(0, 12)}]\n` : t
}

// (b) La commande de vérification, dans `dossier`. `env` : environnement complet de l'enfant (le serveur le compose).
// Le journal entier (borné à 1 Mo) va dans `journal` ; rend { ok, code, signal, delai, duree, fin }. `suivi(enfant)` :
// le serveur garde l'enfant pour pouvoir l'arrêter (arrêt de l'équipe).
export function verifie({ dossier, commande, env, journal, delai = DELAI_VERIFICATION, suivi = () => {} }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(journal, 'w', 0o600)
    fs.writeSync(fd, `$ ${commande}\n(dans ${dossier})\n\n`)
    let ecrits = 0
    let queue = ''
    const enfant = spawn('/bin/sh', ['-c', commande], { cwd: dossier, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    suivi(enfant)
    let fini = false
    const recoit = (d) => {
      if (fini) return // arrivé après la fin (journal fermé)
      const s = d.toString('utf8')
      if (ecrits < JOURNAL_MAX) {
        const morceau = d.subarray(0, JOURNAL_MAX - ecrits)
        fs.writeSync(fd, morceau)
        ecrits += morceau.length
      }
      queue = (queue + s).slice(-FIN_MAX * 2)
    }
    enfant.stdout.on('data', recoit)
    enfant.stderr.on('data', recoit)
    // Le groupe entier (un serveur lancé par les essais, un sous-processus) : par le PID du groupe, jamais par un motif.
    const tueGroupe = () => {
      try {
        process.kill(-enfant.pid, 'SIGKILL')
      } catch {} // groupe déjà vide
    }
    let delaiDepasse = false
    const minuteur = setTimeout(() => {
      delaiDepasse = true
      tueGroupe()
    }, delai)
    const termine = (code, signal) => {
      if (fini) return
      fini = true
      clearTimeout(minuteur)
      tueGroupe() // ce qui tourne encore en arrière-plan après la commande
      try {
        fs.writeSync(fd, `\n[fin : ${delaiDepasse ? `délai de ${Math.round(delai / 60000)} min dépassé` : signal ? `signal ${signal}` : `code ${code}`}${ecrits >= JOURNAL_MAX ? ' ; journal coupé à 1 Mo' : ''}]\n`)
        fs.closeSync(fd)
      } catch {}
      const lignes = queue.replace(/\r/g, '').split('\n')
      const fin = lignes.slice(-FIN_LIGNES).join('\n').slice(-FIN_MAX)
      resolve({ ok: !delaiDepasse && code === 0, code, signal, delai: delaiDepasse, duree: Date.now() - t0, fin })
    }
    enfant.on('error', (e) => {
      queue += `\n${e.message}`
      termine(-1, null)
    })
    // « exit » et non « close » : un processus laissé en arrière-plan (serveur d'essai) garderait la sortie ouverte, et
    // « close » n'arriverait qu'à sa mort. Le groupe est tué, puis la fin de sortie encore en route est lue.
    enfant.on('exit', (code, signal) => {
      tueGroupe()
      setTimeout(() => termine(code, signal), 150)
    })
  })
}

// Heure de départ d'un processus (champ 22 de /proc/<pid>/stat) : avec son PID, elle le désigne sans erreur possible
// (un PID est réutilisé après la mort de son processus). Repris de Hangar (delivery.rs, `started_at`).
export function debutProcessus(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || ''
  } catch {
    return ''
  }
}
// Une vérification restée d'un Meydan arrêté (son groupe ne meurt pas avec le serveur) : tuée par le PID de son groupe,
// seulement si c'est bien elle (même heure de départ).
export function tueVerificationRestee(v) {
  if (!v?.pid || !v.debut || debutProcessus(v.pid) !== v.debut) return false
  try {
    process.kill(-v.pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

// (d) L'atterrissage : le dossier du capitaine (sur la branche d'intégration) avance jusqu'au commit de fusion, en avance
// rapide seulement. Rend { ok }, { bouge } (la tête n'est plus `base` : à refaire), ou lève un refus dont `cote` vaut
// 'capitaine' (son dossier : autre branche, fusion en cours, fichiers que la livraison changerait).
export async function atterrit(dossier, branche, base, merge) {
  const courante = await git(dossier, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')
  if (courante !== branche) throw Object.assign(refus(`ton dossier est sur « ${courante || 'une tête détachée'} », pas sur « ${branche} » : la livraison n’a pas atterri`, 409), { cote: 'capitaine' })
  const avant = await tete(dossier)
  if (avant !== base) return { bouge: true }
  const enCours = await git(dossier, 'rev-parse', '--git-path', 'MERGE_HEAD').then((p) => fs.existsSync(path.resolve(dossier, p)), () => false)
  if (enCours) throw Object.assign(refus('une fusion est en cours dans ton dossier : termine-la (ou `git merge --abort`), la livraison n’a pas atterri', 409), { cote: 'capitaine' })
  const touches = await local(dossier, base, merge)
  if (touches.length)
    throw Object.assign(refus(`ton dossier a ${touches.length} fichier${touches.length > 1 ? 's' : ''} modifié${touches.length > 1 ? 's' : ''}, nouveau${touches.length > 1 ? 'x' : ''} ou ignoré${touches.length > 1 ? 's' : ''} que la livraison change (${ligne(touches.slice(0, 6).join(', '), 300)}) : rien n’a été touché`, 409), { cote: 'capitaine', fichiers: touches })
  // Avance rapide seule, sans remise de côté. `-s ort` écarte `pull.twohead`, et `branch.<b>.mergeOptions` est vidé (il
  // AJOUTE ses options, « -s <x> » compris, à la ligne de commande : leçon du 13/11 n°222). Vider `pull.twohead` ne va
  // pas : git y lit alors une stratégie « '' » introuvable (vu au banc).
  const r = await gitCode(dossier, ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '-s', 'ort', '--no-stat', '--no-verify-signatures', '-q', merge], { neutres: [[`branch.${branche}.mergeOptions`, ''], ['submodule.recurse', 'false']], env: { GIT_OPTIONAL_LOCKS: '1' } })
  const apres = await tete(dossier)
  if (apres === merge) return { ok: true }
  if (apres !== avant) return { bouge: true }
  if (/not possible to fast-forward/i.test(r.err)) return { bouge: true }
  throw Object.assign(refus(`l’avance rapide de ton dossier a échoué (${r.err || `code ${r.code}`}) : rien n’a été touché`, 409), { cote: 'capitaine' })
}
