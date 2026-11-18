// Un bloc de ports par équipier (volet livraison-equipes, 17/11, idée reprise de Hangar : « a block of 20 ports for its
// dev servers and tests », hangar-ai/hangar, MIT, crates/hangar-core/src/pty.rs `apply_ports`). Deux équipiers qui
// lancent chacun un serveur de développement ne se battent plus pour le port 3000 : chacun a les siens, dans
// `MEYDAN_PORTS=<début>-<fin>` et `PORT=<début>` (posés sur sa session tmux, server.mjs openSession).
//
// Les blocs sont pris DANS les ports de l'aperçu web (lib/relais-web.mjs, PORTS_APERCU : Orkun voit le serveur d'un
// équipier dans une carte du plateau), alignés sur leur début (3000-3019, 3020-3039…, 8000-8019…), et un bloc est sauté
// dès qu'un de ses ports est :
//   - à l'écoute sur la machine à cet instant (lu dans /proc/net/tcp et tcp6, état LISTEN : ce que `ss -ltn` lit) ;
//   - refusé à l'aperçu (PORTS_REFUSES : bases, outils d'administration…), ou le port de ce Meydan ;
//   - un port de production (PORTS_PRODUCTION) : un service arrêté le temps d'un redémarrage n'écoute pas, son port ne
//     doit pas partir chez un équipier pour autant ;
//   - déjà dans le bloc d'un autre membre (consoles vivantes) ou en cours d'attribution.
// Le bloc vit sur la console de l'équipier (`c.ports`) : il part avec elle quand elle est close (closeMember la retire de
// la liste), et une console relancée (revive) le garde tant qu'aucun autre membre ne l'a pris.
import fs from 'node:fs'
import { PORTS_APERCU, PORTS_REFUSES } from './relais-web.mjs'

export const TAILLE = 20
// Ports de tes services en production, jamais donnés à un équipier même quand le service est arrêté : MEYDAN_PORTS_PROTEGES
// (liste séparée par des virgules, par ex. « 3001,3002,8000 »). Un port à l'écoute est de toute façon sauté.
export const PORTS_PRODUCTION = new Set(String(process.env.MEYDAN_PORTS_PROTEGES || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))

// Les blocs possibles, dans l'ordre : [début, fin] alignés sur le début de chaque plage, entiers dans la plage.
export function blocs(plages = PORTS_APERCU, taille = TAILLE) {
  const out = []
  for (const [a, b] of plages) for (let d = a; d + taille - 1 <= b; d += taille) out.push([d, d + taille - 1])
  return out
}

// Ports à l'écoute (TCP, v4 et v6) : colonne `st` = 0A (LISTEN). Fichier illisible : rien de plus n'est su, on ne
// suppose rien (les autres exclusions tiennent).
export function ecoute(fichiers = ['/proc/net/tcp', '/proc/net/tcp6']) {
  const ports = new Set()
  for (const f of fichiers) {
    let texte = ''
    try {
      texte = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const l of texte.split('\n').slice(1)) {
      const c = l.trim().split(/\s+/)
      if (c[3] === '0A') ports.add(parseInt(c[1].split(':').pop(), 16))
    }
  }
  return ports
}

// Le premier bloc libre, ou null. `pris` : débuts des blocs déjà attribués ; `exclus` : ports à ne jamais donner (port
// de Meydan…) ; `ecoutes` : ports à l'écoute à cet instant.
export function choisit({ pris = new Set(), exclus = new Set(), ecoutes = ecoute(), plages = PORTS_APERCU, taille = TAILLE } = {}) {
  const interdit = (p) => ecoutes.has(p) || exclus.has(p) || PORTS_REFUSES.has(p) || PORTS_PRODUCTION.has(p)
  for (const [d, f] of blocs(plages, taille)) {
    if (pris.has(d)) continue
    let libre = true
    for (let p = d; p <= f && libre; p++) libre = !interdit(p)
    if (libre) return { debut: d, fin: f }
  }
  return null
}

export const texte = (b) => `${b.debut}-${b.fin}`
