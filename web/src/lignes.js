// La question d'une tuile du plateau vu de loin (Board.jsx) : autant de lignes ENTIÈRES que la place en laisse, la
// dernière finie par « … » quand le texte continue. Chasse du 17/11 : « Une question t'attend » tranchée à mi-ligne.
// La hauteur en lignes entières est posée en CSS (plateau.css, couche.css : max-height arrondi à la ligne) ; mais une
// question coupée net, sans « … », se lirait comme entière. CSS ne sait pas donner à -webkit-line-clamp un nombre
// calculé : ici, le rognage de la feuille de style est rendu un instant, les lignes ENTIÈRES que la grille laisse sont
// comptées, et ce nombre est posé (les « … » tombent alors au bout de la dernière ligne vue). Refait quand la tuile ou une
// rangée change de taille (zoom : les textes suivent --zoom).
// Référence par fonction (React 19 : la fonction rendue est le nettoyage) : à poser telle quelle, `ref={lignesEntieres}`.
export function lignesEntieres(p) {
  const t = p?.parentElement
  if (!t || typeof ResizeObserver === 'undefined') return
  const pose = () => {
    const avant = p.style.webkitLineClamp
    p.style.webkitLineClamp = '' // le rognage de la feuille de style : la grille donne alors toute la place qu'elle a
    const lh = parseFloat(getComputedStyle(p).lineHeight)
    const n = lh > 0 ? String(Math.max(1, Math.round(p.clientHeight / lh))) : avant
    p.style.webkitLineClamp = n
  }
  const ro = new ResizeObserver(pose)
  ro.observe(t)
  for (const e of t.children) ro.observe(e)
  pose()
  return () => ro.disconnect()
}
