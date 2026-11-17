import { LIENS } from './vie.js'

// Copie améliorée de `Liens` (Board.jsx) : mêmes liens capitaine → équipier. Variantes à l'essai :
// - ?liens=a|b (lot 4, calques cachés par lot4-vie.css hors de leur variante) ;
// - ?liens=c|d|e (lot 5, Orkun : « un meilleur lien. La c'est moche ») : un fil fin et net avec une aura discrète, et
//   ce qui circule le dit (particules qui voyagent capitaine → équipier, l'inverse pour un retour ; rien au calme).
//   c = fibre (courbe + particules), d = circuit (coudes arrondis + traits de lumière), e = onde (courbe + lumière douce
//   qui glisse le long du fil). Le mouvement est en SMIL (animateMotion le long du tracé exact) ; les rayons sont
//   regrossis au dézoom par `--zb` (lot5-liens.css).
// Sans paramètre, le lien actuel reste.
const tonDuLien = (c) =>
  c.status === 'needs' ? 'appel' : c.status === 'working' ? 'travail' : ['blocked', 'needs-decision', 'failed'].includes(c.etat?.verbe) ? 'retour' : c.etat?.verbe === 'done' ? 'fait' : 'calme'
const BOUGE = new Set(['travail', 'appel', 'retour'])
const NOUVEAUX = new Set(['c', 'd', 'e'])

// Tracé en coudes arrondis (variante d) : sortie dans l'axe de la prise, un seul changement de direction à mi-chemin.
function coude(x1, y1, x2, y2, cote) {
  const R = 28
  if (cote) {
    const [mx, s, sy] = [(x1 + x2) / 2, Math.sign(x2 - x1) || 1, Math.sign(y2 - y1)]
    const r = Math.min(R, Math.abs(y2 - y1) / 2, Math.abs(mx - x1))
    if (!sy || r < 1) return `M ${x1} ${y1} L ${x2} ${y2}`
    return `M ${x1} ${y1} L ${mx - s * r} ${y1} Q ${mx} ${y1} ${mx} ${y1 + sy * r} L ${mx} ${y2 - sy * r} Q ${mx} ${y2} ${mx + s * r} ${y2} L ${x2} ${y2}`
  }
  const [my, s, sx] = [(y1 + y2) / 2, Math.sign(y2 - y1) || 1, Math.sign(x2 - x1)]
  const r = Math.min(R, Math.abs(x2 - x1) / 2, Math.abs(my - y1))
  if (!sx || r < 1) return `M ${x1} ${y1} L ${x2} ${y2}`
  return `M ${x1} ${y1} L ${x1} ${my - s * r} Q ${x1} ${my} ${x1 + sx * r} ${my} L ${x2 - sx * r} ${my} Q ${x2} ${my} ${x2} ${my + s * r} L ${x2} ${y2}`
}

// Ce qui voyage sur un lien : deux passages par cycle, décalés d'un demi-cycle (et d'un lien à l'autre).
function Voyages({ t, d, i, forme }) {
  const dur = t.ton === 'travail' ? 2.6 : 1.9
  const sens = t.ton === 'retour' ? '1;0' : '0;1'
  const arrivee = t.ton === 'retour' ? [t.x1, t.y1] : [t.x2, t.y2]
  return [0, 1].map((k) => {
    const debut = `${(-(k * dur) / 2 - ((i * 0.37) % dur)).toFixed(2)}s`
    const commun = { dur: `${dur}s`, begin: debut, repeatCount: 'indefinite' }
    return (
      <g key={k}>
        <g className={forme === 'trait' ? 'lx-trait' : 'lx-paquet'} opacity="0">
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.82;1" {...commun} />
          <animateMotion path={d} keyPoints={sens} keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.3 1" rotate={forme === 'trait' ? 'auto' : undefined} {...commun} />
          {forme === 'trait' ? (
            <>
              <rect className="lx-trait-corps" x={t.ton === 'retour' ? -2 : -40} y="-1.5" width="42" height="3" rx="1.5" style={{ fill: `url(#lxt-${t.id})` }} />
              <circle className="lx-paquet-halo lx-petit" style={{ fill: `url(#lxg-${t.id})` }} />
            </>
          ) : (
            <>
              <circle className="lx-paquet-halo" style={{ fill: `url(#lxg-${t.id})` }} />
              <circle className="lx-paquet-coeur" />
            </>
          )}
        </g>
        {/* À l'arrivée, la prise s'allume d'un anneau qui s'ouvre (même horloge que le voyage). */}
        <g transform={`translate(${arrivee[0]} ${arrivee[1]})`}>
          <circle className="lx-ping" opacity="0">
            <animate attributeName="opacity" values="0;0;0.75;0" keyTimes="0;0.8;0.86;1" {...commun} />
            <animateTransform attributeName="transform" type="scale" values="1;1;1;2.8" keyTimes="0;0.8;0.84;1" {...commun} />
          </circle>
        </g>
      </g>
    )
  })
}

// Fibre (lien c, choisi par Orkun le 11/11 : « plus de particule et […] absolument moins pixelisé ») : un flux continu de
// six particules par lien, de tailles et d'éclats variés, chacune un éclat en dégradé doux traînant une courte traîne,
// à vitesse constante (le dégradé est lissé par le navigateur : plus rien n'accroche la grille des pixels). Un seul
// anneau à l'arrivée par cycle. Sens : capitaine → équipier ; l'inverse pour un retour.
const PARTICULES = [
  { t: 0, s: 1, o: 1 },
  { t: 0.15, s: 0.7, o: 0.75 },
  { t: 0.32, s: 0.86, o: 0.95 },
  { t: 0.49, s: 0.66, o: 0.7 },
  { t: 0.65, s: 0.95, o: 1 },
  { t: 0.82, s: 0.7, o: 0.8 },
]
function Fibre({ t, d, i }) {
  const dur = t.ton === 'travail' ? 4.2 : 3
  const retour = t.ton === 'retour'
  const arrivee = retour ? [t.x1, t.y1] : [t.x2, t.y2]
  const decal = (i * 0.37) % dur
  const horloge = (part) => ({ dur: `${dur}s`, begin: `${(-(part * dur) - decal).toFixed(2)}s`, repeatCount: 'indefinite' })
  return (
    <>
      {PARTICULES.map((p, k) => (
        <g key={k} className="lx-paquet" opacity="0">
          <animate attributeName="opacity" values={`0;${p.o};${p.o};0`} keyTimes="0;0.07;0.9;1" {...horloge(p.t)} />
          <animateMotion path={d} keyPoints={retour ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" rotate={retour ? 'auto-reverse' : 'auto'} {...horloge(p.t)} />
          <g className="lx-echelle">
            <g transform={`scale(${p.s})`}>
              <ellipse cx="-20" cy="0" rx="22" ry="2.6" style={{ fill: `url(#lxq-${t.id})` }} />
              <circle r="13" style={{ fill: `url(#lxg-${t.id})` }} />
            </g>
          </g>
        </g>
      ))}
      <g transform={`translate(${arrivee[0]} ${arrivee[1]})`}>
        <circle className="lx-ping" opacity="0">
          <animate attributeName="opacity" values="0;0;0.6;0" keyTimes="0;0.9;0.93;1" {...horloge(0)} />
          <animateTransform attributeName="transform" type="scale" values="1;1;1;2.6" keyTimes="0;0.9;0.92;1" {...horloge(0)} />
        </circle>
      </g>
    </>
  )
}

function LienNeuf({ t, i, immobile }) {
  const d = LIENS === 'd' ? t.dCoude : t.d
  const bouge = BOUGE.has(t.ton) && !immobile // téléphone : rien ne voyage (les animations SVG tournent même cachées)
  const pad = 140
  const xs = [t.x1, t.x2, t.c1[0], t.c2[0]]
  const ys = [t.y1, t.y2, t.c1[1], t.c2[1]]
  return (
    <g className={`ve-lien lx est-${t.ton}`}>
      <defs>
        <linearGradient id={`lv-${t.id}`} gradientUnits="userSpaceOnUse" x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}>
          <stop offset="0" className="lv-s0" />
          <stop offset="1" className="lv-s1" />
        </linearGradient>
        {/* L'éclat d'une particule : aucun cœur dur (un disque de 2 px ressortait en pixel carré sur un écran de densité 1),
            une décroissance douce du blanc à la couleur de l'état puis à rien. */}
        <radialGradient id={`lxg-${t.id}`}>
          <stop offset="0" className="lx-g0" />
          <stop offset="0.12" className="lx-g05" />
          <stop offset="0.3" className="lx-g1" />
          <stop offset="0.58" className="lx-g15" />
          <stop offset="1" className="lx-g2" />
        </radialGradient>
        {/* La traîne, derrière l'éclat dans le sens du mouvement. */}
        <linearGradient id={`lxq-${t.id}`}>
          <stop offset="0" className="lx-g2" />
          <stop offset="0.6" className="lx-q1" />
          <stop offset="1" className="lx-q2" />
        </linearGradient>
        <linearGradient id={`lxt-${t.id}`} x1={t.ton === 'retour' ? 1 : 0} x2={t.ton === 'retour' ? 0 : 1}>
          <stop offset="0" className="lx-g2" />
          <stop offset="0.7" className="lx-g1" />
          <stop offset="1" className="lx-g0" />
        </linearGradient>
        {LIENS === 'e' && bouge && (
          <mask id={`lxm-${t.id}`} maskUnits="userSpaceOnUse" x={Math.min(...xs) - pad} y={Math.min(...ys) - pad} width={Math.max(...xs) - Math.min(...xs) + 2 * pad} height={Math.max(...ys) - Math.min(...ys) + 2 * pad}>
            {[0, 1].map((k) => {
              const dur = t.ton === 'travail' ? 3.2 : 2.3
              const commun = { dur: `${dur}s`, begin: `${(-(k * dur) / 2 - ((i * 0.37) % dur)).toFixed(2)}s`, repeatCount: 'indefinite' }
              return (
                <circle key={k} r="110" style={{ fill: 'url(#lx-onde-masque)' }}>
                  <animateMotion path={d} keyPoints={t.ton === 'retour' ? '1;0' : '0;1'} keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.4 1" {...commun} />
                </circle>
              )
            })}
          </mask>
        )}
      </defs>
      <path className="lx-aura" d={d} />
      <path className="lx-fil" d={d} stroke={`url(#lv-${t.id})`} />
      {LIENS === 'e' && bouge && (
        <g mask={`url(#lxm-${t.id})`}>
          <path className="lx-onde-aura" d={d} />
          <path className="lx-onde" d={d} />
        </g>
      )}
      {LIENS === 'c' && bouge && <Fibre t={t} d={d} i={i} />}
      {LIENS === 'd' && bouge && <Voyages t={t} d={d} i={i} forme="trait" />}
      <circle className="lx-prise-chef" cx={t.x1} cy={t.y1} />
      <circle className="lx-prise" cx={t.x2} cy={t.y2} />
    </g>
  )
}

export function LiensVivants({ nodes, immobile = false }) {
  const boite = (n) => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.data.w, h: n.height ?? n.data.h })
  const traits = []
  for (const chef of nodes.filter((n) => n.data.chief && n.data.team && n.data.status !== 'closed')) {
    const a = boite(chef)
    for (const m of nodes.filter((n) => n.data.team === chef.data.team && !n.data.chief && n.data.status !== 'closed')) {
      const b = boite(m)
      const [dx, dy] = [b.x + b.w / 2 - (a.x + a.w / 2), b.y + b.h / 2 - (a.y + a.h / 2)]
      const cote = Math.abs(dx) >= Math.abs(dy)
      const [x1, y1] = cote ? [dx > 0 ? a.x + a.w : a.x, a.y + a.h / 2] : [a.x + a.w / 2, dy > 0 ? a.y + a.h : a.y]
      const [x2, y2] = cote ? [dx > 0 ? b.x : b.x + b.w, b.y + b.h / 2] : [b.x + b.w / 2, dy > 0 ? b.y : b.y + b.h]
      const k = Math.max(40, (cote ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) * 0.5)
      const [c1, c2] = cote ? [[x1 + Math.sign(dx || 1) * k, y1], [x2 - Math.sign(dx || 1) * k, y2]] : [[x1, y1 + Math.sign(dy || 1) * k], [x2, y2 - Math.sign(dy || 1) * k]]
      traits.push({ id: m.id, ton: tonDuLien(m.data), d: `M ${x1} ${y1} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${x2} ${y2}`, dCoude: coude(x1, y1, x2, y2, cote), x1, y1, x2, y2, c1, c2 })
    }
  }
  if (!traits.length) return null
  if (NOUVEAUX.has(LIENS))
    return (
      <svg className="liens-plateau" aria-hidden="true">
        <defs>
          <radialGradient id="lx-onde-masque">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </radialGradient>
        </defs>
        {traits.map((t, i) => (
          <LienNeuf key={t.id} t={t} i={i} immobile={immobile} />
        ))}
      </svg>
    )
  return (
    <svg className="liens-plateau" aria-hidden="true">
      {traits.map((t, i) => (
        <g key={t.id} className={`ve-lien est-${t.ton}`} style={{ '--decal': `${-((i * 0.37) % 1.6).toFixed(2)}s` }}>
          <defs>
            <linearGradient id={`lv-${t.id}`} gradientUnits="userSpaceOnUse" x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}>
              <stop offset="0" className="lv-s0" />
              <stop offset="1" className="lv-s1" />
            </linearGradient>
          </defs>
          <path className="ve-lien-fond" d={t.d} />
          <path className="ve-lien-flux" d={t.d} />
          {/* variante a : halo large, trait épais en dégradé, flux de lumière */}
          <path className="lv-halo" d={t.d} />
          <path className="lv-corps" d={t.d} stroke={`url(#lv-${t.id})`} />
          <path className="lv-eclat" d={t.d} />
          {/* variante b : fil fin et comètes (trois longueurs de traîne, têtes alignées) */}
          <path className="lv-fil" d={t.d} stroke={`url(#lv-${t.id})`} />
          <path className="lv-comete lv-c1" d={t.d} />
          <path className="lv-comete lv-c2" d={t.d} />
          <path className="lv-comete lv-c3" d={t.d} />
          <path className="lv-tete" d={t.d} />
          <circle className="ve-port" cx={t.x1} cy={t.y1} r="7" />
          <circle cx={t.x2} cy={t.y2} r="7" />
        </g>
      ))}
    </svg>
  )
}
