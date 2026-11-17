// Ateliers : la carte Diagramme (studio Diagramme de Symvibe). Le texte d'un sous-ensemble de Mermaid « flowchart »
// (specs/001-ateliers/contracts/diagramme.md) est écrit dans la carte par Orkun (enregistré comme une note, 700 ms après
// la frappe), ou suivi dans un fichier qu'un agent écrit (.mmd, .mermaid, .txt, ou le premier bloc ```mermaid d'un .md).
// Dessin en SVG, export SVG ou PNG dans le navigateur. Téléphone : image fixe (aucune écriture).
import { memo, useContext, useEffect, useRef, useState } from 'react'
import { CartesCtx } from '../cartes.js'
import { Carte } from '../Carte.jsx'
import { cls } from '../lib.js'
import { Choix } from './Choix.jsx'
import { pngDe, svgDe } from './DiagrammeSvg.jsx'
import { ACCEPTE_DIAGRAMME, useSourceDiagramme, VueDiagramme } from './Diagramme.jsx'
import { Lecteur } from './Lecteur.jsx'
import { Tuile } from './Tuile.jsx'
import { dossierCourt, nomDe, telecharge } from './api.js'
import { NOMS_ATELIERS } from './types.js'
import './ateliers.css'

const octets = (s) => new Blob([s]).size

export const DiagrammeNode = memo(function DiagrammeNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const [grand, setGrand] = useState(false)
  const [choix, setChoix] = useState(false)
  const [ecrit, setEcrit] = useState(null) // texte en cours de frappe (null : celui de la carte)
  const [etat, setEtat] = useState('')
  const svg = useRef(null)
  const minuterie = useRef(0)
  const actif = !far && !tel
  const { source, message } = useSourceDiagramme(id, k, actif)
  const texte = ecrit ?? source
  const nom = (k.titre || (k.source === 'fichier' && k.chemin ? nomDe(k.chemin).replace(/\.[^.]+$/, '') : 'diagramme')).replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'diagramme'
  // Enregistrement 700 ms après la dernière frappe (comme les notes) ; le corps d'une demande est borné à 64 Ko.
  const tape = (v) => {
    setEcrit(v)
    clearTimeout(minuterie.current)
    minuterie.current = setTimeout(() => {
      if (octets(JSON.stringify({ texte: v })) > 60000) return setEtat('Trop long pour être enregistré (60 Ko au plus).')
      actions.patch(id, { texte: v }).then(
        () => setEtat(''),
        (e) => setEtat(e.message),
      )
    }, 700)
  }
  useEffect(() => () => clearTimeout(minuterie.current), [])
  useEffect(() => {
    if (ecrit !== null && ecrit === k.texte) setEcrit(null) // enregistré : la carte fait foi
  }, [k.texte])
  const exporte = async (format) => {
    if (!svg.current) return
    try {
      if (format === 'svg') telecharge(new Blob([svgDe(svg.current)], { type: 'image/svg+xml' }), `${nom}.svg`)
      else telecharge(await pngDe(svg.current), `${nom}.png`)
    } catch (e) {
      setEtat(e.message)
    }
  }
  const outils = actif ? (
    <>
      <button type="button" className={cls('at-outil nodrag', k.source === 'texte' && 'est-actif')} title="Écrire le diagramme dans la carte" onClick={() => actions.patch(id, { source: 'texte' }).catch(() => {})}>
        Texte
      </button>
      <button type="button" className={cls('at-outil nodrag', k.source === 'fichier' && 'est-actif')} title="Suivre un fichier qu’un agent écrit" onClick={() => (k.source === 'fichier' ? setChoix(true) : actions.patch(id, { source: 'fichier' }).catch(() => {}))}>
        Fichier
      </button>
      <button type="button" className="at-outil nodrag" title="Télécharger en SVG" onClick={() => exporte('svg')}>
        SVG
      </button>
      <button type="button" className="at-outil nodrag" title="Télécharger en PNG" onClick={() => exporte('png')}>
        PNG
      </button>
      <button type="button" className="at-outil nodrag" title="Voir en grand" onClick={() => setGrand(true)}>
        Agrandir
      </button>
    </>
  ) : null
  let corps
  if (tel) corps = <Tuile k={k} />
  else if (far) corps = null
  else if (k.source === 'fichier' && (!k.projet || !k.chemin || choix))
    corps = (
      <Choix
        projet={k.projet}
        accepte={ACCEPTE_DIAGRAMME}
        aide="Un fichier .mmd, .mermaid, .txt, ou un .md avec un bloc ```mermaid"
        onChoisi={({ projet, chemin }) => {
          setChoix(false)
          actions.patch(id, { projet, chemin }).catch(() => {})
        }}
        onAnnule={() => (setChoix(false), k.chemin ? null : actions.patch(id, { source: 'texte' }).catch(() => {}))}
      />
    )
  else
    corps = (
      <div className={cls('at-dg', k.source === 'texte' && 'avec-texte')}>
        {k.source === 'texte' && (
          <textarea className="at-dg-texte nodrag nowheel" spellCheck={false} value={texte} onChange={(e) => tape(e.target.value)} aria-label="Texte du diagramme" onKeyDown={(e) => e.stopPropagation()} />
        )}
        {grand ? <p className="at-dim at-centre">Vu en grand à droite.</p> : <VueDiagramme source={texte} svg={svg} id={`dg-${id}`} />}
        {(message || etat) && <p className="at-etat">{message || etat}</p>}
      </div>
    )
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={k.source === 'fichier' && k.chemin ? nomDe(k.chemin) : NOMS_ATELIERS.diagramme} outils={outils} className="at-carte">
      {corps}
      {grand && (
        <Lecteur type={NOMS_ATELIERS.diagramme} titre={k.titre || nom} sousTitre={k.source === 'fichier' ? `${dossierCourt(k.projet)}/${k.chemin}` : 'écrit dans la carte'} onFerme={() => setGrand(false)}>
          <div className="at-dg-grand">
            <VueDiagramme source={texte} svg={svg} id={`dgl-${id}`} />
          </div>
        </Lecteur>
      )}
    </Carte>
  )
})
