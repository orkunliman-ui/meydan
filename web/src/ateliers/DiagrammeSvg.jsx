// Ateliers : le dessin d'un diagramme (web/src/ateliers/diagramme.js : analyse puis disposition) en éléments SVG React —
// jamais de HTML injecté ; le texte des boîtes reste du texte. Couleurs écrites en attributs (pas de variables CSS) :
// l'image exportée (SVG, PNG) se suffit à elle-même, sur fond blanc comme un tableau blanc.
import { memo, useMemo } from 'react'
import { analyse, dispose } from './diagramme.js'

const ENCRE = '#1d2230'
const TRAIT = '#5b6478'
const FOND_BOITE = '#f4f6fb'
const FOND = '#ffffff'

function Forme({ n }) {
  const { x, y, w, h } = n
  const p = { fill: FOND_BOITE, stroke: ENCRE, strokeWidth: 1.4 }
  if (n.forme === 'losange') return <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} {...p} />
  if (n.forme === 'cercle') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...p} />
  return <rect x={x} y={y} width={w} height={h} rx={n.forme === 'stade' ? h / 2 : n.forme === 'rond' ? 10 : 3} {...p} />
}

function Texte({ x, y, texte, taille = 13, gras = false, fond }) {
  const lignes = String(texte).split('\n')
  const haut = lignes.length * 18
  return (
    <g>
      {fond && <rect x={x - fond / 2} y={y - haut / 2 - 2} width={fond} height={haut + 4} rx={3} fill={FOND} />}
      <text x={x} y={y - haut / 2 + 13} textAnchor="middle" fontSize={taille} fontWeight={gras ? 600 : 400} fill={ENCRE} fontFamily="'Host Grotesk', 'Liberation Sans', 'DejaVu Sans', sans-serif">
        {lignes.map((l, i) => (
          <tspan key={i} x={x} dy={i ? 18 : 0}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  )
}

// Le SVG d'une disposition. `id` : préfixe des marqueurs (plusieurs diagrammes dans une même page).
export const Dessin = memo(function Dessin({ d, id = 'dg' }) {
  const fleche = `${id}-fleche`
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="at-dessin" viewBox={`0 0 ${d.largeur} ${d.hauteur}`} width={d.largeur} height={d.hauteur} role="img">
      <defs>
        <marker id={fleche} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={TRAIT} />
        </marker>
      </defs>
      <rect x="0" y="0" width={d.largeur} height={d.hauteur} fill={FOND} />
      {d.aretes.map((a, i) => (
        <polyline
          key={`a${i}`}
          points={a.points.map((p) => p.join(',')).join(' ')}
          fill="none"
          stroke={TRAIT}
          strokeWidth={a.trait === 'epais' ? 3 : 1.5}
          strokeDasharray={a.trait === 'pointille' ? '5 4' : undefined}
          markerEnd={a.fleche ? `url(#${fleche})` : undefined}
        />
      ))}
      {d.noeuds.map((n) => (
        <g key={n.id}>
          <Forme n={n} />
          <Texte x={n.x + n.w / 2} y={n.y + n.h / 2} texte={n.texte} />
        </g>
      ))}
      {d.aretes.map((a, i) => (a.texte ? <Texte key={`e${i}`} x={a.x} y={a.y} texte={a.texte} taille={12} fond={Math.min(220, a.texte.length * 7 + 12)} /> : null))}
    </svg>
  )
})

// Analyse + disposition, mémorisées sur le texte.
export function useDiagramme(source) {
  return useMemo(() => {
    const a = analyse(source || '')
    let d = null
    try {
      d = a.noeuds.length ? dispose(a) : null
    } catch (e) {
      a.erreurs = [...a.erreurs, { ligne: 0, message: `disposition impossible : ${e.message}` }]
    }
    return { a, d }
  }, [source])
}

let n = 0
// Un bloc ```mermaid d'un document (Markdown) : le dessin, et les erreurs en petit dessous.
export function DiagrammeBloc({ source }) {
  const { a, d } = useDiagramme(source)
  const id = useMemo(() => `dgb${++n}`, [])
  return (
    <figure className="at-diagramme">
      {d ? <Dessin d={d} id={id} /> : <pre>{source}</pre>}
      {a.erreurs.length > 0 && <figcaption className="at-dim">{a.erreurs.map((e) => (e.ligne ? `ligne ${e.ligne} : ${e.message}` : e.message)).join(' · ')}</figcaption>}
    </figure>
  )
}

// ── Exports (dans le navigateur) ──
// SVG : le nœud dessiné, sérialisé tel quel (couleurs déjà en attributs, fond blanc, aucune ressource extérieure).
export function svgDe(el) {
  const copie = el.cloneNode(true)
  copie.removeAttribute('class')
  copie.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copie)}`
}
// PNG : le SVG dessiné sur un canevas à deux fois sa taille.
export function pngDe(el) {
  return new Promise((ok, ko) => {
    const w = Number(el.getAttribute('width'))
    const h = Number(el.getAttribute('height'))
    const img = new Image()
    const u = URL.createObjectURL(new Blob([svgDe(el)], { type: 'image/svg+xml' }))
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * 2))
      c.height = Math.max(1, Math.round(h * 2))
      const g = c.getContext('2d')
      g.scale(2, 2)
      g.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(u)
      c.toBlob((b) => (b ? ok(b) : ko(new Error('PNG impossible'))), 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(u)
      ko(new Error('image du diagramme illisible'))
    }
    img.src = u
  })
}
