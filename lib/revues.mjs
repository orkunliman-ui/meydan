// Lecture seule des artefacts et de /proc. Les données d'un result.json ne deviennent jamais une commande.
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export async function racinesRevues(home) {
  const racines = new Set([path.join(home, 'quant-wt', 'artifacts')])
  for (const d of await fs.readdir(home, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    racines.add(path.join(home, d.name, 'artifacts'))
    const wt = path.join(home, d.name, '.claude', 'worktrees')
    for (const w of await fs.readdir(wt, { withFileTypes: true }).catch(() => [])) {
      if (w.isDirectory()) racines.add(path.join(wt, w.name, 'artifacts'))
    }
  }
  return [...racines]
}

export function dossierRunner(argv, cwd) {
  // Un shell qui cite runner.py n'est pas un runner. Les arguments sont séparés par NUL dans /proc.
  const i = argv.findIndex((x, n) => n <= 1 && path.basename(x) === 'runner.py')
  if (i < 0 || (i === 1 && !/^python(?:3(?:\.\d+)?)?$/.test(path.basename(argv[0])))) return null
  const a = argv.slice(i + 1)
  const egal = a.find((x) => x.startsWith('--artifacts='))
  const j = a.indexOf('--artifacts')
  const dir = egal?.slice(12) || (j >= 0 ? a[j + 1] : null)
  return dir && !dir.startsWith('-') ? path.resolve(cwd, dir) : null
}

export async function runnersVivants(proc = '/proc') {
  const vivants = []
  let fiable = true
  for (const pid of (await fs.readdir(proc)).filter((x) => /^\d+$/.test(x))) {
    try {
      const [raw, stat] = await Promise.all([fs.readFile(path.join(proc, pid, 'cmdline'), 'utf8'), fs.readFile(path.join(proc, pid, 'stat'), 'utf8')])
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) continue
      const argv = raw.split('\0').filter(Boolean)
      if (!argv.slice(0, 2).some((x) => path.basename(x) === 'runner.py')) continue
      const cwd = await fs.readlink(path.join(proc, pid, 'cwd'))
      const d = dossierRunner(argv, cwd)
      if (d) vivants.push(d)
      else fiable = false // runner vivant mais impossible de l'attribuer : ne pas affirmer qu'une revue est morte
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) fiable = false }
  }
  return { vivants, fiable }
}

export async function scanneRevues(racines, { proc = '/proc', processus, now = Date.now() } = {}) {
  const { vivants, fiable } = processus || await runnersVivants(proc)
  if (!fiable) return { revues: [], fiable: false }
  const revues = [], vus = new Set()
  let visites = 0
  async function parcourt(dir, profondeur = 0) {
    if (profondeur > 8 || ++visites > 10_000) return
    // Ne suit pas les liens, y compris pour les racines configurées.
    const st = await fs.lstat(dir).catch(() => null)
    if (!st?.isDirectory() || st.isSymbolicLink()) return
    const reel = await fs.realpath(dir)
    if (vus.has(reel)) return
    vus.add(reel)
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) await parcourt(f, profondeur + 1)
      else if (e.isFile() && e.name === 'result.json') {
        let fd
        try {
          fd = await fs.open(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const stat = await fd.stat()
          if (!stat.isFile() || stat.size > 1_048_576) continue
          const x = JSON.parse(await fd.readFile('utf8'))
          if (x.status !== 'running') continue
          // runner.py crée un sous-dossier claudex-* sous --artifacts : parent OU dossier exact.
          const vivant = vivants.some((d) => reel === d || path.dirname(reel) === d)
          if (vivant) continue
          revues.push({ id: crypto.createHash('sha256').update(f).digest('hex').slice(0, 24), fichier: f, projet: typeof x.repo === 'string' ? x.repo.slice(0, 1000) : '', detectee: now, relancable: false,
            raison: 'Commande d’origine incomplète dans result.json : relance manuelle depuis la session d’origine.' })
        } catch {} finally { await fd?.close() }
      }
    }
  }
  for (const r of racines) await parcourt(path.resolve(r))
  return { revues, fiable: true }
}
