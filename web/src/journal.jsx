import { Component } from 'react'

// Ce que la page vit sur l'appareil d'Orkun, écrit au journal du moteur (POST /api/journal-client). Né le 11/11 :
// « en version iphone, quand je mets le mode paysage la page crash et n'affiche plus rien », sans Safari au VPS pour le
// voir. Trois choses : toute erreur JavaScript, un écran d'erreur lisible au lieu d'une page blanche, et des repères de
// vie quand le téléphone est couché (si la page meurt, le repère manque : c'est Safari qui l'a tuée, pas une erreur).
const ecran = () => `${innerWidth}x${innerHeight}@${devicePixelRatio}${matchMedia('(orientation: landscape)').matches ? ' paysage' : ''}`
let envoyes = 0
// Bruit connu des navigateurs, sans effet (Chrome et Safari le lèvent quand un ResizeObserver relance une mesure) :
// il ne doit pas épuiser les 30 envois d'une page avant la vraie erreur.
const BRUIT = /ResizeObserver loop/
export function journal(quoi, message, ou = '') {
  if (BRUIT.test(String(message)) || ++envoyes > 30) return // une erreur qui boucle ne doit pas inonder le journal
  try {
    fetch('/api/journal-client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoi, message: String(message ?? '').slice(0, 500), ou: String(ou ?? '').slice(0, 900), ecran: ecran() }),
      keepalive: true,
    }).catch(() => {})
  } catch {}
}

export function ecoute() {
  addEventListener('error', (e) => journal('erreur', e.message, `${e.filename}:${e.lineno}:${e.colno} ${e.error?.stack || ''}`))
  addEventListener('unhandledrejection', (e) => journal('promesse', e.reason?.message ?? e.reason, e.reason?.stack))
  // Téléphone couché : un repère à 1 s, 5 s et 20 s (combien de dalles, de terminaux et de calques visibles).
  const couche = matchMedia('(orientation: landscape) and (max-height: 520px) and (pointer: coarse)')
  const reperes = () => {
    if (!couche.matches) return
    for (const s of [1, 5, 20])
      setTimeout(() => {
        if (couche.matches) journal('vivant', `${s} s couché`, `dalles=${document.querySelectorAll('.react-flow__node').length} xterm=${document.querySelectorAll('.xterm').length} tuiles=${document.querySelectorAll('.tuile').length}`)
      }, s * 1000)
  }
  reperes()
  couche.addEventListener?.('change', reperes)
  // Fluidité réelle de l'appareil, téléphone couché (11/11 : « c'est vrmt pas fluide ») : les intervalles entre deux
  // images, résumés toutes les 10 s (images par seconde, 95e centile, pire, saccades > 50 ms), 12 envois au plus.
  let ints = []
  let prec = 0
  let resumes = 0
  let tourne = false // la boucle ne tourne que téléphone couché : rien ne coûte ailleurs
  const image = (t) => {
    if (!couche.matches) {
      tourne = false
      prec = 0
      return
    }
    if (prec && document.visibilityState === 'visible') ints.push(t - prec)
    prec = t
    requestAnimationFrame(image)
  }
  const demarre = () => {
    if (couche.matches && !tourne) {
      tourne = true
      requestAnimationFrame(image)
    }
  }
  demarre()
  couche.addEventListener?.('change', demarre)
  // Ordinateur (16/11, sur son MacBook Pro M5 Max : « c'est hyper lent ») : ce que Chrome mesure lui-même, sans boucle
  // d'images (rien ne tourne au repos) — les longues images (> 50 ms, avec les scripts en cause et leur position dans le
  // fichier, à relire avec la carte des sources de la même construction) et les gestes lents (> 100 ms entre le geste et
  // l'image qui le montre). Un résumé toutes les 30 s s'il s'est passé quelque chose, 20 au plus par page.
  const pc = matchMedia('(pointer: fine)')
  if (pc.matches && typeof PerformanceObserver !== 'undefined') {
    let images = []
    let gestes = []
    try {
      new PerformanceObserver((l) => images.push(...l.getEntries())).observe({ type: 'long-animation-frame' })
    } catch {} // navigateur sans cette mesure : rien
    try {
      new PerformanceObserver((l) => gestes.push(...l.getEntries().filter((e) => e.interactionId))).observe({ type: 'event', durationThreshold: 104 })
    } catch {}
    let envoisPc = 0
    const fichier = (u) => String(u || '').split('/').pop()
    setInterval(() => {
      const [im, ge] = [images, gestes]
      images = []
      gestes = []
      if ((!im.length && !ge.length) || envoisPc >= 20 || document.visibilityState !== 'visible') return
      envoisPc++
      const scripts = new Map()
      for (const e of im)
        for (const s of e.scripts || []) {
          const k = `${s.invoker || s.invokerType}·${s.sourceFunctionName || '?'}@${fichier(s.sourceURL)}:${s.sourceCharPosition}`
          scripts.set(k, (scripts.get(k) || 0) + s.duration)
        }
      const haut = [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, ms]) => `${Math.round(ms)}ms ${k}`)
      const pire = (l) => Math.round(Math.max(0, ...l.map((e) => e.duration)))
      const g = ge.sort((a, b) => b.duration - a.duration)[0]
      journal(
        'lenteur-pc',
        `${im.length} images > 50 ms (pire ${pire(im)} ms, ${Math.round(im.reduce((s, e) => s + e.duration, 0))} ms en 30 s) · ${ge.length} gestes lents${g ? ` (pire ${Math.round(g.duration)} ms : ${g.name} sur ${String(g.target?.className || g.target?.tagName || '?').slice(0, 40)}, attente ${Math.round(g.processingStart - g.startTime)} ms, traitement ${Math.round(g.processingEnd - g.processingStart)} ms)` : ''}`,
        `${haut.join(' | ')} · noeuds=${document.getElementsByTagName('*').length} dalles=${document.querySelectorAll('.react-flow__node').length} xterm=${document.querySelectorAll('.xterm').length} webgl=${document.querySelectorAll('.term-host[data-rendu="webgl"]').length}`,
      )
    }, 30000)
  }
  setInterval(() => {
    if (ints.length < 30 || resumes >= 12) return (ints = [])
    const tri = [...ints].sort((x, y) => x - y)
    const somme = tri.reduce((x, y) => x + y, 0)
    journal('fluidite', `${((1000 * tri.length) / somme).toFixed(0)} ips`, `p95=${tri[Math.floor(tri.length * 0.95)].toFixed(0)}ms pire=${tri[tri.length - 1].toFixed(0)}ms saccades=${tri.filter((x) => x > 50).length}/${tri.length} dalles=${document.querySelectorAll('.react-flow__node').length}`)
    resumes++
    ints = []
  }, 10000)
}

// Une erreur de rendu démontait toute l'application (page blanche) : on montre ce qui s'est passé, et on le note.
export class Garde extends Component {
  state = { erreur: null }
  static getDerivedStateFromError(erreur) {
    return { erreur }
  }
  componentDidCatch(erreur, info) {
    journal('rendu', erreur?.message, `${erreur?.stack || ''} ${info?.componentStack || ''}`)
  }
  render() {
    if (!this.state.erreur) return this.props.children
    return (
      <div style={{ padding: 24, color: '#e8ecf8', background: '#080b18', minHeight: '100dvh', font: '15px/1.45 system-ui' }}>
        <p style={{ fontWeight: 700, fontSize: 18 }}>Meydan a rencontré une erreur.</p>
        <p style={{ opacity: 0.8 }}>Elle est notée au VPS. Copie : {String(this.state.erreur?.message || this.state.erreur)}</p>
        <button type="button" onClick={() => location.reload()} style={{ marginTop: 12, padding: '12px 18px', fontSize: 16 }}>
          Recharger
        </button>
      </div>
    )
  }
}
