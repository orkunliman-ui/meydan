// Meydan — pièces jointes et notes vocales envoyées aux consoles par la barre d'envoi.
// Dessin : docs/specs/2026-11-10-barre-envoi.md. Ce module ne connaît ni HTTP ni les sessions :
// server.mjs vérifie l'accès et l'existence de la console, puis appelle ces fonctions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

export const MAX_FILE = 25 * 1024 * 1024 // par fichier, enregistrement vocal compris
export const MAX_FILES = 10 // pièces par message
export const MAX_TEXT = 20000 // caractères par message
export const MAX_AUDIO_S = 600 // 10 minutes par note vocale
export const KEEP_MS = 30 * 24 * 3600 * 1000 // conservation (Orkun, 10/11 : 30 jours, et suppression à la fermeture de la console)

// Moteur de transcription local (transcribe-cli + Parakeet) : rien ne sort du serveur.
const FFMPEG = process.env.MEYDAN_FFMPEG || 'ffmpeg'
const ASR_CLI = process.env.MEYDAN_ASR_CLI || 'transcribe-cli'
const ASR_MODEL = process.env.MEYDAN_ASR_MODEL || ''
// ffmpeg n'ouvre que des formats audio : un fichier déguisé (liste de lecture, image…) est refusé avant tout décodage.
const AUDIO_FORMATS = 'mov,matroska,ogg,mp3,wav,aac,flac,caf,aiff,amr'

const ID = /^c[0-9a-f]{8}$/
const NAME = /^\d{8}-\d{6}-[A-Za-z0-9][A-Za-z0-9._-]{0,83}$/

// Erreur dont le code est le statut HTTP que server.mjs renvoie, et le message un texte montrable.
const fail = (code, message) => Object.assign(new Error(message), { code })

export function dirOf(data, consoleId) {
  if (!ID.test(String(consoleId))) throw fail(400, 'console invalide')
  return path.join(data, 'envois', consoleId)
}

// Nom rangé sur le VPS : date et heure (UTC), puis le nom d'origine réduit à des lettres, chiffres, « . », « - », « _ ».
// Jamais de dossier, jamais de fichier caché : « ../../.bashrc » devient « 20261110-152700-bashrc ».
// `n` : numéro ajouté après l'heure quand le nom est déjà pris (deux « image.jpg » reçues dans la même seconde).
export function safeName(raw, now = new Date(), n = 0) {
  const base =
    String(raw ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // accents retirés, la lettre reste
      .split(/[\\/]/)
      .pop()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(-76)
      .replace(/^[-._]+/, '') || 'fichier'
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  return `${stamp}-${n ? `${n}-` : ''}${base}`
}

// Chemin d'un fichier déjà reçu pour cette console, ou null. Le nom vient du navigateur : il doit avoir la forme
// exacte que safeName produit, et désigner un vrai fichier du dossier de la console.
export function fileOf(data, consoleId, name) {
  if (!NAME.test(String(name))) return null
  const file = path.join(dirOf(data, consoleId), name)
  try {
    return fs.statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

// Écrit le corps de la demande dans `dest`, au fil de l'eau, sans jamais dépasser `max`. Rien n'est laissé en cas d'échec.
function pour(req, dest, max) {
  return new Promise((resolve, reject) => {
    // Demande déjà coupée avant qu'on l'écoute : aucun événement ne viendrait, la promesse ne se réglerait jamais.
    if (req.destroyed) return reject(fail(400, 'envoi interrompu'))
    const out = fs.createWriteStream(dest, { mode: 0o600 })
    let size = 0
    let done = false
    const stop = (err) => {
      if (done) return
      done = true
      req.unpipe(out)
      out.destroy()
      req.resume() // le reste du corps est jeté
      fs.rm(dest, { force: true }, () => reject(err))
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) stop(fail(413, 'fichier trop gros (25 Mo au plus)'))
    })
    req.on('error', () => stop(fail(400, 'envoi interrompu')))
    req.on('close', () => !req.complete && stop(fail(400, 'envoi interrompu')))
    out.on('error', (e) => stop(fail(500, `écriture impossible (${e.code || 'erreur'})`)))
    out.on('finish', () => {
      if (done) return
      done = true
      resolve(size)
    })
    req.pipe(out)
  })
}

// Reçoit un fichier pour une console. `raw` = le nom donné par le navigateur (jamais utilisé comme chemin).
export async function receive(req, data, consoleId, raw) {
  const dir = dirOf(data, consoleId)
  if (Number(req.headers['content-length']) > MAX_FILE) throw fail(413, 'fichier trop gros (25 Mo au plus)')
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.recu-${crypto.randomBytes(6).toString('hex')}`)
  const taille = await pour(req, tmp, MAX_FILE)
  if (!taille) {
    await fs.promises.rm(tmp, { force: true })
    throw fail(400, 'fichier vide')
  }
  // Rangement sous son nom définitif par un lien, qui échoue si le nom est pris : deux fichiers du même nom reçus au
  // même instant ne s'écrasent jamais, le second prend un numéro.
  const now = new Date()
  try {
    for (let n = 0; n < 500; n++) {
      const nom = safeName(raw, now, n)
      const chemin = path.join(dir, nom)
      try {
        await fs.promises.link(tmp, chemin)
        return { nom, taille, chemin }
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    }
    throw fail(500, 'rangement impossible : trop de fichiers du même nom')
  } finally {
    await fs.promises.rm(tmp, { force: true })
  }
}

const run = (cmd, args, timeout) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(Object.assign(err, { errOut: String(errOut).slice(-400) })) : resolve(out))))

// Un seul passage du moteur à la fois dans Meydan (il prend 1,4 Go pour une note courte, jusqu'à 4 Go pour 10 minutes).
// Une autre application qui utiliserait le même moteur a son propre verrou : les deux ne se coordonnent pas (limite connue).
let queue = Promise.resolve()

async function pass(audio) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meydan-voix-'))
  try {
    const wav = path.join(dir, 'audio.wav')
    const out = path.join(dir, 'texte.txt')
    // WAV mono 16 kHz : ce que lit le moteur. Un enregistrement illisible s'arrête ici. `-t` : on ne décode jamais plus
    // que la durée permise (un fichier de silence compressé gonflerait sinon en gigaoctets de WAV).
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-format_whitelist', AUDIO_FORMATS, '-t', String(MAX_AUDIO_S + 1), '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 120000).catch((e) => {
      console.error(`[voix] ffmpeg : ${e.errOut || e.message}`)
      throw fail(422, 'enregistrement illisible')
    })
    const duree = ((await fs.promises.stat(wav)).size - 44) / 32000
    if (duree < 0.3) throw fail(422, 'enregistrement vide')
    if (duree > MAX_AUDIO_S) throw fail(413, 'note trop longue (10 minutes au plus)')
    await run('nice', ['-n', '10', ASR_CLI, '-m', ASR_MODEL, '-l', 'fr', '--threads', '4', '-q', '--timestamps', 'none', '-o', out, wav], 180000).catch((e) => {
      console.error(`[voix] transcription : ${e.errOut || e.message}`)
      throw fail(500, 'transcription impossible')
    })
    const texte = (await fs.promises.readFile(out, 'utf8').catch(() => '')).trim()
    if (!texte) throw fail(422, "rien d'audible dans la note")
    return { texte, duree: Math.round(duree) }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

// Reçoit un enregistrement, le transcrit, rend le texte. L'audio est supprimé dans tous les cas.
export async function transcribe(req, data, consoleId) {
  return transcrireDans(req, dirOf(data, consoleId))
}
// La même chose dans un dossier donné (la barre de commande, qui n'appartient à aucune console).
export async function transcrireDans(req, dir) {
  if (Number(req.headers['content-length']) > MAX_FILE) throw fail(413, 'enregistrement trop gros')
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const audio = path.join(dir, `.voix-${crypto.randomBytes(6).toString('hex')}`)
  try {
    if (!(await pour(req, audio, MAX_FILE))) throw fail(422, 'enregistrement vide')
    const job = queue.then(() => pass(audio))
    queue = job.catch(() => {})
    return await job
  } finally {
    await fs.promises.rm(audio, { force: true })
  }
}

// Texte collé dans la console. Aucun caractère de contrôle ne passe : avec un ESC, une séquence « fin de collage »
// sortirait le texte du collage encadré, et la suite serait tapée comme des touches.
// - devant un agent : le texte, puis la liste des chemins, que l'agent ouvre lui-même ;
// - à l'invite d'un shell (`shell` vrai) : les chemins au bout de la ligne, comme on les taperait.
export function messageText(texte, chemins = [], shell = false) {
  const clean = String(texte ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, MAX_TEXT)
  if (shell) return [clean, ...chemins].filter(Boolean).join(' ')
  const pieces = chemins.length ? `Pièces jointes :\n${chemins.map((c) => `- ${c}`).join('\n')}` : ''
  return [clean, pieces].filter(Boolean).join('\n\n')
}

// Le chemin inverse, pour la discussion : dans le texte d'un message tel que l'agent l'a reçu, la liste « Pièces jointes : »
// de la fin devient { texte, pieces: [noms] } — seulement si chaque chemin désigne un fichier du dossier de CETTE console
// (un texte qui imiterait la liste avec d'autres chemins reste du texte).
export function piecesDe(texte, dir) {
  const t = String(texte ?? '')
  const m = t.match(/(?:^|\n\n)Pièces jointes :\n((?:- [^\n]+(?:\n|$))+)$/)
  if (!m) return { texte: t, pieces: [] }
  const chemins = m[1].trim().split('\n').map((l) => l.slice(2))
  if (!chemins.every((c) => path.dirname(c) === dir && NAME.test(path.basename(c)))) return { texte: t, pieces: [] }
  return { texte: t.slice(0, m.index).trim(), pieces: chemins.map((c) => path.basename(c)) }
}

// Type sous lequel une pièce reçue peut être affichée dans la page : les images courantes seulement (pas le SVG, qui
// peut porter un script). Tout le reste se télécharge.
export const TYPE_IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

// Supprime ce qui a plus de 30 jours, toutes consoles confondues, puis les dossiers vidés. Rend le nombre de fichiers
// supprimés. Volontairement fondé sur l'âge seul : il ne dépend pas de la liste des consoles, donc une liste perdue
// ou illisible n'efface rien d'un coup.
export async function sweep(data, now = Date.now()) {
  const root = path.join(data, 'envois')
  let removed = 0
  for (const d of await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || !ID.test(d.name)) continue
    const dir = path.join(root, d.name)
    for (const n of await fs.promises.readdir(dir).catch(() => [])) {
      const f = path.join(dir, n)
      const st = await fs.promises.stat(f).catch(() => null)
      if (st && now - st.mtimeMs > KEEP_MS) {
        await fs.promises.rm(f, { recursive: true, force: true })
        removed++
      }
    }
    await fs.promises.rmdir(dir).catch(() => {}) // ne part que s'il est vide
  }
  return removed
}

// Fermeture d'une console : ses fichiers partent avec elle.
export async function forget(data, consoleId) {
  await fs.promises.rm(dirOf(data, consoleId), { recursive: true, force: true })
}
