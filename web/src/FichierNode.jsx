// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — la carte
// « fichier ». Brief du volet : « Cartes de fichiers : choisir un fichier d'un projet (dossiers déjà permis par Meydan,
// `safeDir`) → carte avec nom, taille, aperçu du texte ou de l'image, « Ouvrir » (aperçu en grand), « Télécharger » »,
// et au téléphone « chaque carte est une tuile fixe en lecture ». Serveur : lib/cartes-fichier.mjs (tous les contrôles
// y sont : chemin réel, dossiers et fichiers cachés, compte 2, identités, données de Meydan, à chaque lecture).
//   Sans fichier (ou « Changer ») : le sélecteur — la liste des projets (GET /api/projects), puis les dossiers (fil
//   d'Ariane, « ‹ » pour remonter, clic pour entrer) ; un clic sur un fichier le choisit (PATCH { chemin }).
//   Avec fichier : nom, taille, genre, aperçu (texte en police mono, image entière, icône pour un PDF ou un autre
//   fichier), « Ouvrir » (panneau par-dessus la page, porté dans document.body : Échap, clic sur le fond ou « Fermer »),
//   « Télécharger » (lien `download`, réponse `attachment` du serveur), « Changer ». Un fichier disparu ou devenu refusé :
//   le message du serveur dans la carte, sans plantage.
//   Vue de loin (`far`) : le cadre montre le nom en grand, le corps reste vide (aucune demande).
//   Téléphone couché (`tel`) : tuile fixe en lecture — l'instantané enregistré sur la carte (nom, taille, genre), AUCUNE
//   demande, aucun bouton, aucun lien, aucune image, aucun défilement.
import { memo, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { api, cls, shortDir, useEchap } from './lib.js'
import './carte-fichier.css'

const CHEMIN_MAX = 1000 // = lib/cartes-fichier.mjs
const CORPS_MAX = 60 * 1024 // un corps de demande au-delà serait coupé par le serveur (64 Ko) au lieu d'un refus clair
const GENRE = { texte: 'Texte', image: 'Image', pdf: 'PDF', autre: 'Fichier' }
const MARQUE = { texte: 'TXT', image: 'IMG', pdf: 'PDF', autre: 'BIN', dossier: 'DOS' }
const REMPLACE = String.fromCharCode(0xfffd)
// Un nom affiché : caractères de contrôle et de mise en forme (inversion du sens d'écriture…) remplacés.
const propre = (s) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, REMPLACE)
const nombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
export function tailleLisible(o) {
  const n = Number(o) || 0
  if (n < 1024) return `${n} octet${n > 1 ? 's' : ''}`
  if (n < 1024 ** 2) return `${nombre.format(n / 1024)} Ko`
  if (n < 1024 ** 3) return `${nombre.format(n / 1024 ** 2)} Mo`
  return `${nombre.format(n / 1024 ** 3)} Go`
}
const quand = (ms) => new Date(ms).toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
// L'adresse de l'image change avec le fichier (chemin) et son contenu (date de modification) : le navigateur garde les
// images déjà vues d'une adresse, même servies en `no-store`. Une empreinte, pas le chemin lui-même dans l'adresse.
function empreinte(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const adresse = (id, q = '') => `/api/cartes/${id}/contenu${q}`
const dossierDe = (chemin) => chemin.slice(0, Math.max(1, chemin.lastIndexOf('/')))

export const FichierNode = memo(function FichierNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const [choix, setChoix] = useState(false) // le sélecteur à la place de l'aperçu (« Changer », ou un choix en route)
  const [attente, setAttente] = useState(false) // un choix est parti au serveur : l'aperçu attend sa réponse
  const [erreurChoix, setErreurChoix] = useState('')
  const [grand, setGrand] = useState(false)
  const confirme = !!k.nom // un fichier accepté par le serveur (l'envoi optimiste ne pose que `chemin`)
  const choisit = (chemin) => {
    if (chemin.length > CHEMIN_MAX) return setErreurChoix(`Chemin trop long : ${CHEMIN_MAX} caractères au plus`)
    if (new TextEncoder().encode(JSON.stringify({ chemin })).length > CORPS_MAX) return setErreurChoix('Chemin trop lourd pour un envoi')
    setErreurChoix('')
    setChoix(true) // le sélecteur reste monté pendant l'envoi : refusé, on reste dans le même dossier
    setAttente(true)
    actions
      .patch(id, { chemin })
      .then(
        () => setChoix(false),
        (e) => setErreurChoix(e.message),
      )
      .finally(() => setAttente(false))
  }
  let corps = null
  if (tel) corps = <TuileTel k={k} />
  else if (far) corps = null
  else if (!confirme || choix)
    corps = (
      <Selecteur
        id={id}
        depart={confirme ? dossierDe(k.chemin) : ''}
        erreur={erreurChoix}
        attente={attente}
        onChoisi={choisit}
        onAnnule={
          confirme && !attente
            ? () => {
                setChoix(false)
                setErreurChoix('')
              }
            : null
        }
      />
    )
  else corps = <Apercu id={id} k={k} onOuvre={() => setGrand(true)} onChange={() => setChoix(true)} />
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={k.nom ? propre(k.nom) : 'Fichier'}>
      {corps}
      {grand && !tel && confirme && <Grand id={id} k={k} onFerme={() => setGrand(false)} />}
    </Carte>
  )
})

// ── Le sélecteur : projets, puis dossiers ──
function Selecteur({ id, depart, erreur, attente, onChoisi, onAnnule }) {
  const [dossier, setDossier] = useState(depart || null) // null : la liste des projets
  const [projets, setProjets] = useState(null)
  const [vue, setVue] = useState(null) // la réponse du parcours, avec `pour` = le dossier demandé
  const [echec, setEchec] = useState('')
  const liste = useRef(null)
  useEffect(() => {
    if (dossier !== null) return
    let vivant = true
    setEchec('')
    api('GET', '/api/projects').then(
      (j) => vivant && setProjets(Array.isArray(j?.projects) ? j.projects : []),
      (e) => vivant && setEchec(e.message),
    )
    return () => {
      vivant = false
    }
  }, [dossier])
  useEffect(() => {
    if (dossier === null) return
    let vivant = true
    setEchec('')
    api('GET', `/api/cartes/${id}/parcours?dossier=${encodeURIComponent(dossier)}`).then(
      (j) => {
        if (!vivant) return
        setVue({ dossier: String(j?.dossier || dossier), fil: Array.isArray(j?.fil) ? j.fil : [], entrees: Array.isArray(j?.entrees) ? j.entrees : [], reste: Number(j?.reste) || 0, tronque: !!j?.tronque, pour: dossier })
        if (liste.current) liste.current.scrollTop = 0
      },
      (e) => vivant && setEchec(e.message),
    )
    return () => {
      vivant = false
    }
  }, [id, dossier])
  const charge = dossier !== null && vue?.pour !== dossier && !echec
  const fil = dossier !== null && vue ? vue.fil : []
  const remonte = () => setDossier(fil.length > 1 ? fil[fil.length - 2].chemin : null)
  return (
    <div className={cls('cr-fi-choix', (charge || attente) && 'est-occupe')}>
      <nav className="cr-fi-nav" aria-label="Où choisir le fichier">
        <button type="button" className="cr-fi-nav-bouton" disabled={dossier === null} onClick={() => setDossier(null)} title="La liste des projets">
          Projets
        </button>
        {dossier !== null && (
          <>
            <button type="button" className="cr-fi-nav-bouton" onClick={remonte} aria-label="Remonter d’un dossier" title="Remonter d’un dossier">
              ‹
            </button>
            <ol className="cr-fi-fil">
              {fil.map((f, i) => (
                <li key={f.chemin}>
                  <button type="button" className="cr-fi-fil-pas" disabled={i === fil.length - 1} title={propre(f.chemin)} onClick={() => setDossier(f.chemin)}>
                    {propre(f.affiche || f.nom)}
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </nav>
      {(erreur || echec) && (
        <p className="cr-fi-erreur" role="alert">
          {erreur || echec}
        </p>
      )}
      <ul className="cr-fi-liste" ref={liste} aria-busy={charge || attente}>
        {dossier === null &&
          projets?.map((p) => (
            <li key={p.path}>
              <button type="button" className="cr-fi-entree" onClick={() => setDossier(p.path)} title={propre(p.path)}>
                <span className="cr-fi-marque cr-fi-g-dossier">{MARQUE.dossier}</span>
                <span className="cr-fi-nom">{p.name === '~' ? '~ (dossier personnel)' : propre(p.name)}</span>
                <span className="cr-fi-meta">{shortDir(p.path)}</span>
              </button>
            </li>
          ))}
        {dossier !== null &&
          vue?.entrees.map((e) => (
            <li key={e.nom}>
              <button
                type="button"
                className={cls('cr-fi-entree', e.type === 'dossier' && 'est-dossier')}
                disabled={attente}
                title={e.type === 'dossier' ? 'Entrer dans ce dossier' : 'Choisir ce fichier'}
                onClick={() => (e.type === 'dossier' ? setDossier(`${vue.dossier}/${e.nom}`) : onChoisi(`${vue.dossier}/${e.nom}`))}
              >
                <span className={cls('cr-fi-marque', `cr-fi-g-${e.type === 'dossier' ? 'dossier' : e.genre}`)}>{MARQUE[e.type === 'dossier' ? 'dossier' : e.genre] || MARQUE.autre}</span>
                <span className="cr-fi-nom">
                  {propre(e.affiche || e.nom)}
                  {e.type === 'dossier' ? '/' : ''}
                </span>
                <span className="cr-fi-meta">{e.type === 'fichier' && Number.isFinite(e.octets) ? tailleLisible(e.octets) : e.lien ? 'lien' : ''}</span>
              </button>
            </li>
          ))}
      </ul>
      <footer className="cr-fi-pied">
        <span className="cr-fi-pied-texte">
          {attente
            ? 'Choix en cours…'
            : dossier === null
              ? projets
                ? 'Choisis un projet, puis le fichier'
                : echec
                  ? ''
                  : 'Chargement de la liste…'
              : charge
                ? 'Chargement…'
                : vue && !vue.entrees.length
                  ? 'Rien à montrer ici (dossier vide, ou fichiers cachés et refusés)'
                  : vue?.tronque
                    ? `Dossier trop grand : 5 000 premières entrées lues${vue.reste ? `, + ${vue.reste} non montrées` : ''}`
                    : vue?.reste
                      ? `+ ${vue.reste} de plus, non montrés`
                      : ''}
        </span>
        {onAnnule && (
          <button type="button" className="cr-fi-bouton" onClick={onAnnule}>
            Annuler
          </button>
        )}
      </footer>
    </div>
  )
}

// ── La carte avec son fichier ──
function Apercu({ id, k, onOuvre, onChange }) {
  const [a, setA] = useState(null) // la réponse de ?apercu=1 : { nom, octets, modifie, genre, texte?, coupe? }
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    let vivant = true
    setA(null)
    setErreur('')
    api('GET', adresse(id, '?apercu=1')).then(
      (j) => vivant && setA(j && typeof j === 'object' ? j : {}),
      (e) => vivant && setErreur(e.message),
    )
    return () => {
      vivant = false
    }
  }, [id, k.chemin])
  const nom = propre(a?.nom || k.nom)
  const octets = a?.octets ?? k.octets
  const genre = GENRE[a?.genre] ? a.genre : GENRE[k.genre] ? k.genre : 'autre'
  const pret = !!a && !erreur
  let vue
  if (erreur)
    vue = (
      <p className="cr-fi-erreur" role="alert">
        Ce fichier ne peut plus être lu : {erreur}. « Changer » pour en choisir un autre.
      </p>
    )
  else if (!a) vue = <p className="cr-fi-attente">Chargement de l’aperçu…</p>
  else if (genre === 'texte') vue = typeof a.texte === 'string' && a.texte ? <pre className="cr-fi-texte">{a.texte}</pre> : <p className="cr-fi-attente">Fichier vide</p>
  else if (genre === 'image') vue = <img className="cr-fi-image" src={adresse(id, `?f=${empreinte(k.chemin)}&m=${Number(a.modifie) || 0}`)} alt={`Aperçu de ${nom}`} draggable={false} decoding="async" onError={() => setErreur('image illisible')} />
  else
    vue = (
      <div className="cr-fi-icone">
        <span className={cls('cr-fi-marque', 'cr-fi-marque-grande', `cr-fi-g-${genre}`)}>{MARQUE[genre]}</span>
        <p>{genre === 'pdf' ? 'Document PDF : « Ouvrir » pour le lire' : 'Pas d’aperçu pour ce type de fichier'}</p>
      </div>
    )
  return (
    <div className="cr-fi-carte">
      <div className="cr-fi-tete">
        <span className={cls('cr-fi-marque', `cr-fi-g-${genre}`)}>{MARQUE[genre]}</span>
        <div className="cr-fi-titres">
          <b className="cr-fi-nom" title={nom}>
            {nom}
          </b>
          <span className="cr-fi-meta">
            {tailleLisible(octets)} · {GENRE[genre]}
            {a?.modifie ? ` · modifié le ${quand(a.modifie)}` : ''}
          </span>
        </div>
      </div>
      <div className={cls('cr-fi-vue', `cr-fi-vue-${erreur ? 'erreur' : genre}`)}>{vue}</div>
      <div className="cr-fi-actions">
        <button type="button" className="cr-fi-bouton" disabled={!pret} onClick={onOuvre} title="Voir en grand">
          Ouvrir
        </button>
        {pret ? (
          <a className="cr-fi-bouton" href={adresse(id, '?telecharger=1')} download={nom} title="Télécharger le fichier">
            Télécharger
          </a>
        ) : (
          <span className="cr-fi-bouton est-inactif" aria-disabled="true">
            Télécharger
          </span>
        )}
        <button type="button" className="cr-fi-bouton" onClick={onChange} title="Choisir un autre fichier">
          Changer
        </button>
      </div>
    </div>
  )
}

// ── « Ouvrir » : l'aperçu en grand, par-dessus la page ──
function Grand({ id, k, onFerme }) {
  const [a, setA] = useState(null)
  const [erreur, setErreur] = useState('')
  const fermer = useRef(null)
  const depuisFond = useRef(false) // le fond ne ferme qu'un clic COMMENCÉ sur lui
  useEchap(onFerme)
  useEffect(() => {
    let vivant = true
    api('GET', adresse(id, '?apercu=grand')).then(
      (j) => vivant && setA(j && typeof j === 'object' ? j : {}),
      (e) => vivant && setErreur(e.message),
    )
    return () => {
      vivant = false
    }
  }, [id, k.chemin])
  // Le clavier va au panneau ; à la fermeture, il revient où il était (sans faire défiler le plateau).
  useEffect(() => {
    const avant = document.activeElement
    fermer.current?.focus({ preventScroll: true })
    return () => avant?.focus?.({ preventScroll: true })
  }, [])
  const nom = propre(a?.nom || k.nom)
  const genre = GENRE[a?.genre] ? a.genre : GENRE[k.genre] ? k.genre : 'autre'
  let vue
  if (erreur)
    vue = (
      <p className="cr-fi-erreur" role="alert">
        Ce fichier ne peut plus être lu : {erreur}.
      </p>
    )
  else if (!a) vue = <p className="cr-fi-attente">Chargement…</p>
  else if (genre === 'texte')
    vue = (
      <>
        <pre className="cr-fi-texte cr-fi-texte-grand">{typeof a.texte === 'string' && a.texte ? a.texte : 'Fichier vide'}</pre>
        {a.coupe && <p className="cr-fi-note">Aperçu limité au premier Mo : « Télécharger » pour le fichier entier.</p>}
      </>
    )
  else if (genre === 'image') vue = <img className="cr-fi-image-grand" src={adresse(id, `?f=${empreinte(k.chemin)}&m=${Number(a.modifie) || 0}`)} alt={nom} draggable={false} decoding="async" />
  else if (genre === 'pdf')
    vue = (
      <div className="cr-fi-icone">
        <span className="cr-fi-marque cr-fi-marque-grande cr-fi-g-pdf">PDF</span>
        <p>
          <a className="cr-fi-lien" href={adresse(id)} target="_blank" rel="noopener noreferrer">
            Lire le PDF dans un nouvel onglet
          </a>
        </p>
      </div>
    )
  else
    vue = (
      <div className="cr-fi-icone">
        <span className="cr-fi-marque cr-fi-marque-grande cr-fi-g-autre">{MARQUE.autre}</span>
        <p>Pas d’aperçu pour ce type de fichier : « Télécharger » pour l’ouvrir sur l’appareil.</p>
      </div>
    )
  return createPortal(
    <div
      className="cr-fi-fond"
      onPointerDown={(e) => {
        depuisFond.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && depuisFond.current) onFerme()
      }}
    >
      <section className="cr-fi-grand" role="dialog" aria-modal="true" aria-label={`Aperçu : ${nom}`}>
        <header className="cr-fi-grand-tete">
          <span className={cls('cr-fi-marque', `cr-fi-g-${genre}`)}>{MARQUE[genre]}</span>
          <div className="cr-fi-titres">
            <b className="cr-fi-nom" title={nom}>
              {nom}
            </b>
            <span className="cr-fi-meta">
              {tailleLisible(a?.octets ?? k.octets)} · {GENRE[genre]}
              {a?.modifie ? ` · modifié le ${quand(a.modifie)}` : ''}
            </span>
          </div>
          <a className="cr-fi-bouton" href={adresse(id, '?telecharger=1')} download={nom}>
            Télécharger
          </a>
          <button type="button" ref={fermer} className="cr-fi-bouton" onClick={onFerme} title="Fermer (Échap)">
            Fermer
          </button>
        </header>
        {/* Atteignable au clavier (Tab) : les flèches font défiler le texte. */}
        <div className={cls('cr-fi-grand-corps', `cr-fi-vue-${erreur ? 'erreur' : genre}`)} tabIndex={0}>
          {vue}
        </div>
      </section>
    </div>,
    document.body,
  )
}

// ── Téléphone couché : l'instantané de la carte, rien d'autre (aucune demande) ──
function TuileTel({ k }) {
  const genre = GENRE[k.genre] ? k.genre : 'autre'
  return (
    <div className="cr-fi-tel">
      {k.nom ? (
        <>
          <span className={cls('cr-fi-marque', 'cr-fi-marque-tel', `cr-fi-g-${genre}`)}>{MARQUE[genre]}</span>
          <p className="cr-fi-tel-taille">{tailleLisible(k.octets)}</p>
          <p className="cr-fi-tel-genre">{GENRE[genre]}</p>
        </>
      ) : (
        <p className="cr-fi-tel-genre">Aucun fichier choisi</p>
      )}
    </div>
  )
}
