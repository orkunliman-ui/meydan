// Trace les changements de statut d'une console pendant N secondes (preuve des hooks).
// node scripts/watch-status.mjs <id> [secondes]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [id, secs = '30'] = process.argv.slice(2)
const file = path.join(root, 'data', 'state.json')
const t0 = Date.now()
let last = ''
const tick = () => {
  let status = '?'
  try {
    status = JSON.parse(fs.readFileSync(file, 'utf8')).consoles.find((c) => c.id === id)?.status ?? 'absente'
  } catch {} // fichier en cours de remplacement : on relira au tour suivant
  if (status !== last) {
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${status}`)
    last = status
  }
  if (Date.now() - t0 > Number(secs) * 1000) process.exit(0)
}
setInterval(tick, 100)
tick()
