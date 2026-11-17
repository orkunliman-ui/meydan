// Ateliers : la lecture d'un document (Markdown ou HTML) qu'un agent écrit, suivie en direct ; commune à la carte du
// plateau (DocNode.jsx) et à la lecture en grand (Lecteur.jsx : « Agrandir », téléphone, Chat).
// Markdown : le rendu des notes (notes-md.jsx) avec tableaux et blocs ```mermaid dessinés. HTML : sur l'ordinateur, sa
// propre mise en page dans un cadre isolé (`sandbox` vide : ni script, ni même origine ; CSP sans aucun réseau en tête du
// document — constitution 1.1.0, principe III) ; au téléphone, aucun cadre : texte et structure par liste blanche.
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../notes-md.jsx'
import { HtmlLecture } from './html-lecture.jsx'
import { DiagrammeBloc } from './DiagrammeSvg.jsx'
import { ditRefus, exportePdf, nomDe, useContenu } from './api.js'
import '../carte-note.css'

// Le document HTML d'un agent, borné : rien ne se charge (ni image distante, ni feuille, ni police, ni cadre), rien ne
// s'exécute (le cadre est en `sandbox` vide). Placée AVANT le document : une politique ne peut que s'ajouter.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
// Les indications de ressources (`<link rel="preconnect">`…) ouvrent des connexions que la CSP ne gouverne pas : prouvé
// au banc avec le Chromium du snap (13/11 : 2 connexions TCP vers un témoin, sans aucune requête HTTP) ; une `<iframe src>`
// imbriquée en ouvre une aussi (préconnexion de sa navigation, avant le refus de la CSP : sonde-cadre.mjs, une connexion
// avec le snap, aucune avec le headless-shell). Tout `<link>`, `<meta http-equiv>` et contexte imbriqué (`iframe`,
// `frame`, `object`, `embed`) est donc retiré avant l'affichage — la CSP les bloque déjà : rien de visible n'est perdu.
// Le document est lu par DOMParser (inerte : rien n'est chargé ni exécuté).
export function htmlIsole(texte) {
  let propre = ''
  try {
    const doc = new DOMParser().parseFromString(texte, 'text/html')
    for (const e of doc.querySelectorAll('link, meta[http-equiv], iframe, frame, frameset, object, embed')) e.remove()
    propre = `<!doctype html>${doc.documentElement.outerHTML}`
  } catch {
    propre = '' // illisible : rien plutôt qu'un document non nettoyé
  }
  return `<!doctype html>${CSP}<meta charset="utf-8">${propre}`
}
function CadreIsole({ texte, titre }) {
  const srcDoc = useMemo(() => htmlIsole(texte), [texte])
  return <iframe className="at-doc-cadre" title={titre} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc} />
}

// Un bloc ```mermaid (flowchart / graph) dessiné ; tout autre bloc reste du code (spec FR-044).
export const blocDessine = (langage, code) => (langage === 'mermaid' && /^\s*(%%[^\n]*\n\s*)*(flowchart|graph)\b/.test(code) ? <DiagrammeBloc source={code} /> : null)

// Le corps rendu d'un document (sans la carte autour). `article` reçoit l'élément rendu (export PDF du Markdown).
export const CorpsDocument = forwardRef(function CorpsDocument({ contenu, chemin, telephone }, article) {
  if (!contenu) return null
  if (contenu.refus) return <p className="at-refus">{ditRefus(contenu)}</p>
  if (contenu.type === 'html')
    return telephone ? (
      <article className="at-doc at-doc-html" ref={article}>
        <HtmlLecture html={contenu.texte} />
      </article>
    ) : (
      <CadreIsole texte={contenu.texte} titre={nomDe(chemin)} />
    )
  if (contenu.type === 'md')
    return (
      <article className="at-doc" ref={article}>
        <Markdown texte={contenu.texte} tableaux bloc={blocDessine} statique={telephone} />
      </article>
    )
  // Le Document ne lit que du Markdown ou du HTML (FR-013) : un autre fichier (posé par l'API) se refuse en clair.
  return <p className="at-refus">Le Document lit un fichier Markdown ou HTML ; « {nomDe(chemin)} » s’ouvre dans un atelier Code.</p>
})

// Un document suivi, dans un conteneur qui défile : la position de lecture est gardée quand le texte change, et si l'on
// était au bas, on y reste (on suit l'écriture de l'agent). `id` : la carte (suivi par le flux) ; sans carte, relu toutes
// les 2 s. `surContenu({ contenu, article })` : l'appelant reçoit ce qui est affiché (pour l'export PDF).
export function LectureDoc({ id, projet, chemin, actif = true, telephone = false, surContenu }) {
  const { contenu, erreur } = useContenu({ id, projet, chemin, actif })
  const boite = useRef(null)
  const article = useRef(null)
  const auBas = useRef(false) // relevé à chaque défilement (pas pendant le rendu)
  const defile = (e) => {
    const b = e.currentTarget
    auBas.current = b.scrollTop > 0 && b.scrollHeight - b.scrollTop - b.clientHeight < 40
  }
  useLayoutEffect(() => {
    const b = boite.current
    if (b && auBas.current) b.scrollTop = b.scrollHeight
  }, [contenu])
  const prevenir = useRef(surContenu)
  prevenir.current = surContenu
  useEffect(() => {
    prevenir.current?.({ contenu, article })
  }, [contenu])
  return (
    <div className="at-doc-boite nowheel" ref={boite} onScroll={defile}>
      {erreur && <p className="at-erreur">{erreur}</p>}
      {!contenu && !erreur && <p className="at-dim">Chargement…</p>}
      <CorpsDocument contenu={contenu} chemin={chemin} telephone={telephone} ref={article} />
    </div>
  )
}

// Le bouton « PDF » : HTML → le serveur imprime le fichier ; Markdown → l'article rendu à l'écran part avec la demande.
export function useExportPdf({ projet, chemin, titre }) {
  const [etat, setEtat] = useState('')
  const exporte = useCallback(
    async (contenu, article) => {
      if (!contenu || contenu.refus) return
      setEtat('Fabrication du PDF…')
      try {
        const html = contenu.type === 'md' ? article?.innerHTML || '' : undefined
        if (html && new Blob([html]).size > 8 * 1024 * 1024) throw new Error('document trop lourd pour l’export (8 Mo de rendu au plus)')
        const { nom } = await exportePdf({ projet, chemin, html, titre })
        setEtat(`PDF prêt : ${nom}`)
        setTimeout(() => setEtat(''), 4000)
      } catch (e) {
        setEtat(e.message)
      }
    },
    [projet, chemin, titre],
  )
  return { etat, exporte }
}
