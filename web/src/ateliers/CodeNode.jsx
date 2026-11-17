// Ateliers : la carte Code (studio Code de Symvibe : « arbre, aperçu coloré, fichiers épinglés »). Lecture seule :
// arborescence ouverte un niveau à la fois, recherche par nom, fichier numéroté et colorié (coloration.js, écrite à la
// main), épingles gardées avec la carte. Fichiers lourds, binaires, secrets : refusés par le serveur, raison affichée.
import { memo, useContext, useEffect, useState } from 'react'
import { CartesCtx } from '../cartes.js'
import { Carte } from '../Carte.jsx'
import { cls } from '../lib.js'
import { Choix } from './Choix.jsx'
import { Lecteur } from './Lecteur.jsx'
import { Tuile } from './Tuile.jsx'
import { LectureCode } from './Code.jsx'
import { arbre, dossierCourt, nomDe, recherche } from './api.js'
import { NOMS_ATELIERS } from './types.js'
import './ateliers.css'

// L'arborescence : un niveau chargé à l'ouverture d'un dossier.
function Arbre({ projet, chemin = '', ouvert, onFichier, prof = 0 }) {
  const [niveau, setNiveau] = useState(null)
  const [erreur, setErreur] = useState('')
  const [ouverts, setOuverts] = useState(() => new Set())
  useEffect(() => {
    let vivant = true
    arbre(projet, chemin).then(
      (r) => vivant && setNiveau(r),
      (e) => vivant && setErreur(e.message),
    )
    return () => {
      vivant = false
    }
  }, [projet, chemin])
  if (erreur) return <p className="at-erreur">{erreur}</p>
  if (!niveau) return <p className="at-dim">…</p>
  const bascule = (rel) =>
    setOuverts((o) => {
      const n = new Set(o)
      n.has(rel) ? n.delete(rel) : n.add(rel)
      return n
    })
  return (
    <ul className="at-arbre" style={{ '--at-prof': prof }}>
      {niveau.entrees.map((e) => {
        const rel = chemin ? `${chemin}/${e.nom}` : e.nom
        return (
          <li key={e.nom}>
            <button
              type="button"
              className={cls('nodrag', e.dossier ? 'est-dossier' : 'est-fichier', ouvert === rel && 'est-ouvert', e.lourd && 'est-lourd')}
              onClick={() => (e.dossier ? bascule(rel) : onFichier(rel))}
              title={e.lourd ? 'Dossier lourd : ouvert à la demande, jamais parcouru par la recherche' : rel}
            >
              {e.dossier ? (ouverts.has(rel) ? '▾ ' : '▸ ') : ''}
              {e.nom}
            </button>
            {e.dossier && ouverts.has(rel) && <Arbre projet={projet} chemin={rel} ouvert={ouvert} onFichier={onFichier} prof={prof + 1} />}
          </li>
        )
      })}
      {niveau.tronque && <li className="at-dim">… coupé à 1 000 entrées</li>}
    </ul>
  )
}

function Recherche({ projet, texte, onFichier, ouvert }) {
  const [r, setR] = useState(null)
  useEffect(() => {
    let vivant = true
    const t = setTimeout(() => {
      recherche(projet, texte).then(
        (x) => vivant && setR(x),
        (e) => vivant && setR({ erreur: e.message }),
      )
    }, 250)
    return () => {
      vivant = false
      clearTimeout(t)
    }
  }, [projet, texte])
  if (!r) return <p className="at-dim">Recherche…</p>
  if (r.erreur) return <p className="at-erreur">{r.erreur}</p>
  if (!r.resultats.length) return <p className="at-dim">Aucun fichier.</p>
  return (
    <ul className="at-arbre">
      {r.resultats.map((rel) => (
        <li key={rel}>
          <button type="button" className={cls('nodrag est-fichier', ouvert === rel && 'est-ouvert')} onClick={() => onFichier(rel)} title={rel}>
            {nomDe(rel)} <small>{rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''}</small>
          </button>
        </li>
      ))}
      {r.tronque && <li className="at-dim">… d’autres résultats : précise la recherche</li>}
    </ul>
  )
}

export const CodeNode = memo(function CodeNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const [choix, setChoix] = useState(false)
  const [grand, setGrand] = useState(false)
  const [texte, setTexte] = useState('')
  const actif = !far && !tel
  const ouvre = (rel) => actions.patch(id, { fichier: rel }).catch(() => {})
  const epingle = k.fichier && k.epingles.includes(k.fichier)
  const basculeEpingle = () => actions.patch(id, { epingles: epingle ? k.epingles.filter((e) => e !== k.fichier) : [...k.epingles, k.fichier].slice(-12) }).catch(() => {})
  const outils =
    actif && k.projet && !choix ? (
      <>
        {k.fichier && (
          <button type="button" className={cls('at-outil nodrag', epingle && 'est-actif')} title={epingle ? 'Retirer des épingles' : 'Épingler ce fichier (12 au plus)'} onClick={basculeEpingle}>
            {epingle ? 'Épinglé' : 'Épingler'}
          </button>
        )}
        <button type="button" className="at-outil nodrag" title="Lire en grand" onClick={() => setGrand(true)} disabled={!k.fichier}>
          Agrandir
        </button>
        <button type="button" className="at-outil nodrag" title="Changer de projet" onClick={() => setChoix(true)}>
          Projet
        </button>
      </>
    ) : null
  let corps
  if (tel) corps = <Tuile k={k} />
  else if (far) corps = null
  else if (!k.projet || choix)
    corps = (
      <Choix
        mode="dossier"
        aide="Le projet (ou un de ses dossiers) à parcourir"
        onChoisi={({ projet, chemin }) => {
          setChoix(false)
          actions.patch(id, { projet: chemin ? `${projet}/${chemin}` : projet }).catch(() => {})
        }}
        onAnnule={k.projet ? () => setChoix(false) : null}
      />
    )
  else
    corps = (
      <div className="at-code-carte">
        <nav className="at-code-gauche nowheel">
          <input className="at-champ nodrag" type="search" placeholder="Chercher un fichier…" value={texte} onChange={(e) => setTexte(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Chercher un fichier par son nom" />
          {k.epingles.length > 0 && !texte && (
            <ul className="at-arbre at-epingles" aria-label="Épinglés">
              {k.epingles.map((rel) => (
                <li key={rel}>
                  <button type="button" className={cls('nodrag est-fichier', k.fichier === rel && 'est-ouvert')} onClick={() => ouvre(rel)} title={rel}>
                    ★ {nomDe(rel)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {texte.trim() ? <Recherche projet={k.projet} texte={texte.trim()} onFichier={ouvre} ouvert={k.fichier} /> : <Arbre projet={k.projet} ouvert={k.fichier} onFichier={ouvre} />}
        </nav>
        <div className="at-code-droite nowheel">
          {k.fichier && <p className="at-code-chemin">{k.fichier}</p>}
          {grand ? <p className="at-dim at-centre">Lu en grand à droite.</p> : <LectureCode id={id} projet={k.projet} fichier={k.fichier} actif={actif} />}
        </div>
      </div>
    )
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={k.projet ? nomDe(k.projet) : NOMS_ATELIERS.code} outils={outils} className="at-carte">
      {corps}
      {grand && k.fichier && (
        <Lecteur type={NOMS_ATELIERS.code} titre={nomDe(k.fichier)} sousTitre={`${dossierCourt(k.projet)}/${k.fichier}`} onFerme={() => setGrand(false)}>
          <div className="at-code-grand">
            <LectureCode id={id} projet={k.projet} fichier={k.fichier} />
          </div>
        </Lecteur>
      )}
    </Carte>
  )
})
