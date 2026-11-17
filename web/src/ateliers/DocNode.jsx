// Ateliers : la carte Document du plateau (studio Document de Symvibe : « aperçu qui se remplit pendant que l'agent écrit,
// PDF paginé »). Choix du fichier (.md, .markdown, .html, .htm), lecture suivie en direct, « PDF », « Agrandir ».
// Plateau du téléphone et vue de loin : tuile fixe, rien de lu (Tuile.jsx).
import { memo, useContext, useState } from 'react'
import { CartesCtx } from '../cartes.js'
import { Carte } from '../Carte.jsx'
import { Choix } from './Choix.jsx'
import { LectureDoc, useExportPdf } from './Document.jsx'
import { Lecteur } from './Lecteur.jsx'
import { Tuile } from './Tuile.jsx'
import { dossierCourt, nomDe } from './api.js'
import { NOMS_ATELIERS } from './types.js'
import './ateliers.css'

export const ACCEPTE_DOC = (nom) => /\.(md|markdown|html?)$/i.test(nom)

export const DocNode = memo(function DocNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const [choix, setChoix] = useState(false)
  const [grand, setGrand] = useState(false)
  const titre = k.chemin ? nomDe(k.chemin) : NOMS_ATELIERS.doc
  const { etat, exporte } = useExportPdf({ projet: k.projet, chemin: k.chemin, titre: k.titre || titre })
  const pret = k.projet && k.chemin && !choix
  // La barre d'outils de la carte : l'export a besoin du contenu et de l'article rendus (passés par LectureDoc).
  const [vue, setVue] = useState({ contenu: null, article: null })
  const pdf = (
    <button type="button" className="at-outil nodrag" title="Exporter en PDF (A4, paginé)" disabled={!vue.contenu || !!vue.contenu.refus} onClick={() => exporte(vue.contenu, vue.article?.current)}>
      PDF
    </button>
  )
  const outils = pret ? (
    <>
      {pdf}
      <button type="button" className="at-outil nodrag" title="Lire en grand" onClick={() => setGrand(true)}>
        Agrandir
      </button>
      <button type="button" className="at-outil nodrag" title="Choisir un autre fichier" onClick={() => setChoix(true)}>
        Fichier
      </button>
    </>
  ) : null
  let corps
  if (tel || far) corps = tel ? <Tuile k={k} /> : null
  else if (!pret)
    corps = (
      <Choix
        projet={k.projet}
        depart={k.chemin.includes('/') ? k.chemin.slice(0, k.chemin.lastIndexOf('/')) : ''}
        accepte={ACCEPTE_DOC}
        aide="Un document Markdown ou HTML qu’un agent écrit"
        onChoisi={({ projet, chemin }) => {
          setChoix(false)
          actions.patch(id, { projet, chemin }).catch(() => {})
        }}
        onAnnule={k.chemin ? () => setChoix(false) : null}
      />
    )
  else
    corps = (
      <>
        {grand ? <p className="at-dim at-centre">Lu en grand à droite.</p> : <LectureDoc id={id} projet={k.projet} chemin={k.chemin} surContenu={setVue} />}
        {etat && <p className="at-etat" role="status">{etat}</p>}
      </>
    )
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={titre} outils={outils} className="at-carte">
      {corps}
      {grand && (
        <Lecteur type={NOMS_ATELIERS.doc} titre={k.titre || titre} sousTitre={`${dossierCourt(k.projet)}/${k.chemin}`} onFerme={() => setGrand(false)} outils={pdf}>
          <LectureDoc id={id} projet={k.projet} chemin={k.chemin} surContenu={setVue} />
          {etat && <p className="at-etat" role="status">{etat}</p>}
        </Lecteur>
      )}
    </Carte>
  )
})
