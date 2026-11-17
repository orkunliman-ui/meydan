// Plateau créatif (volet du 13/11) — Formes et texte libre : rectangle, ellipse, texte. Demande d'Orkun (brief du volet) :
// « Formes et texte : rectangle, ellipse, flèche (qui peut relier deux éléments du plateau), texte libre ; couleur dans la
// palette du thème (jaune = seulement ce qui attend Orkun, règle du design : pas de jaune décoratif). »
// Sans le cadre commun (cartes-types.js `sansCadre`) : la forme se prend et se déplace par toute sa surface.
//   Choisie (clic) : poignées de taille, et une petite barre au-dessus (NodeToolbar : elle ne suit pas le zoom) — couleur,
//   plein / contour, taille du texte, « Écrire », « × » en deux temps.
//   Double-clic (ou « Écrire ») : écrire le texte dans la forme ; Échap ou un clic ailleurs : fini, enregistré. Un texte
//   libre neuf s'ouvre en écriture, le curseur dedans.
//   Vue de loin (`far`) : la forme reste visible (son trait ne descend pas sous 1,5 point d'écran) ; on n'y écrit pas.
//   Téléphone couché (`tel`) : tuile fixe peinte — ni barre, ni poignée, ni champ ; rien ne se prend au doigt.
import { memo, useContext, useEffect, useRef, useState } from 'react'
import { NodeResizer, NodeToolbar, Position, useStoreApi } from '@xyflow/react'
import { CartesCtx } from './cartes.js'
import { COULEURS, NOM_COULEUR, TYPES_CARTES } from './cartes-types.js'
import { cls } from './lib.js'
import './carte-formes.css'

const TEXTE_MAX = 2000 // = lib/cartes-formes.mjs (TEXTE_FORME_MAX)
const TAILLES = [12, 14, 18, 24, 32, 48, 64, 96] // = lib/cartes-formes.mjs (TAILLES_TEXTE)
const PRES = 1800 // le compteur se montre à partir d'ici
// Un corps de demande ne passe pas 64 Ko (readJson, nginx) : mesuré en octets avant l'envoi. 2 000 unités de texte n'y
// arrivent jamais (6 Ko au pire), la mesure reste comme garde-fou si la borne bouge un jour.
const OCTETS_MAX = 60 * 1024
const MIN = TYPES_CARTES.forme.min
const nombre = (n) => n.toLocaleString('fr-FR')
const couleurDe = (c) => (COULEURS.includes(c) ? c : 'papier')
const formeDe = (f) => (['rect', 'ellipse', 'texte'].includes(f) ? f : 'rect')

// Ce qui empêche d'enregistrer ce texte, ou ''.
function refusTexte(texte) {
  if (texte.length > TEXTE_MAX) return `Trop long : ${nombre(TEXTE_MAX)} caractères au plus, rien n’est enregistré`
  if (new TextEncoder().encode(JSON.stringify({ texte })).length > OCTETS_MAX) return 'Trop lourd pour un envoi (60 Ko au plus)'
  return ''
}
// Un texte libre neuf (vide, jamais modifié, créé il y a un instant) s'ouvre en écriture, comme une note neuve — sur
// l'appareil qui vient de le créer seulement : là, « Ajouter » le rend aussitôt choisi (Cartes.jsx) ; ailleurs il arrive
// par le flux sans être choisi, et ne prend pas le clavier (il l'aurait pris à un terminal).
const estNeuve = (k) => k.forme === 'texte' && !k.texte && k.creeLe === k.modifieLe && Math.abs(Date.now() - k.creeLe) < 20000

export const FormeNode = memo(function FormeNode({ id, data: k, width, height, selected }) {
  const { far, tel, actions } = useContext(CartesCtx)
  const store = useStoreApi()
  const [ecrit, setEcrit] = useState(false)
  const texteK = typeof k.texte === 'string' ? k.texte : '' // un fichier abîmé ne fait pas tomber la page
  const [brouillon, setBrouillon] = useState(texteK)
  const [retire, setRetire] = useState(false) // premier clic sur « × » : il demande ; le second retire
  const [erreur, setErreur] = useState('')
  const champ = useRef(null)
  const forme = formeDe(k.forme)
  const couleur = couleurDe(k.couleur)
  const taille = TAILLES.includes(k.tailleTexte) ? k.tailleTexte : 18
  const refus = ecrit ? refusTexte(brouillon) : ''

  const envoie = (champs) => {
    setErreur('')
    actions.patch(id, champs).catch((e) => setErreur(e.message))
  }
  const ecrire = () => {
    if (tel || far || ecrit) return
    setBrouillon(texteK)
    setErreur('')
    setEcrit(true)
  }
  const neuveOuverte = useRef(false)
  useEffect(() => {
    if (neuveOuverte.current || tel || far || !selected || !estNeuve(k)) return
    neuveOuverte.current = true
    ecrire()
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  // Fin de l'écriture (Échap, clic ailleurs) : enregistré si le texte a changé. Trop long : on reste dans le champ.
  const fin = () => {
    if (refusTexte(brouillon)) return
    setEcrit(false)
    if (brouillon !== texteK) envoie({ texte: brouillon })
  }
  // Ouverture du champ : focus (sans faire défiler le plateau), curseur au bout ; la forme devient la dalle choisie (posée
  // sur une autre, elle passe devant, comme après un clic).
  useEffect(() => {
    const ta = champ.current
    if (!ecrit || !ta) return
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(ta.value.length, ta.value.length)
    const s = store.getState()
    if (s.elementsSelectable && !s.nodeLookup.get(id)?.selected) s.addSelectedNodes([id])
  }, [ecrit, id, store])
  // Passée de loin ou au téléphone pendant l'écriture : on la ferme (ce qui est tapé est gardé par `fin`).
  useEffect(() => {
    if ((far || tel) && ecrit) fin()
  }, [far, tel]) // eslint-disable-line react-hooks/exhaustive-deps
  // La page se ferme pendant l'écriture : le texte part quand même (demande « keepalive », comme la note).
  const enCours = useRef(null)
  enCours.current = ecrit && brouillon !== texteK && !refusTexte(brouillon) ? brouillon : null
  useEffect(() => {
    if (!ecrit) return
    const part = () => {
      const v = enCours.current
      if (v === null) return
      fetch(`/api/cartes/${id}`, { method: 'PATCH', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texte: v }) }).catch(() => {})
    }
    window.addEventListener('pagehide', part)
    return () => window.removeEventListener('pagehide', part)
  }, [ecrit, id])

  const i = TAILLES.indexOf(taille)
  const libre = forme === 'texte'
  return (
    <div
      className={cls('cr-fo-forme', `cr-fo-${libre ? 'libre' : forme}`, `cr-coul-${couleur}`, k.plein && !libre && 'est-plein', selected && !tel && 'est-choisie', ecrit && 'est-ecrite', far && 'est-loin', tel && 'est-tel')}
      style={{ width: width ?? k.w, height: height ?? k.h, '--cr-fo-taille': `${taille}px` }}
      title={tel || far || ecrit ? undefined : 'Double-clic : écrire'}
      onDoubleClick={tel || far ? undefined : ecrire}
    >
      {!tel && (
        <NodeResizer
          isVisible={!!selected}
          minWidth={MIN.w}
          minHeight={MIN.h}
          handleClassName="cr-fo-poignee"
          lineClassName="cr-fo-ligne"
          // Sans la prop `color` : elle écrit un style en ligne qui passe devant la feuille du thème (leçon du 10/11).
          onResizeEnd={(_, p) => envoie({ x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
        />
      )}
      {!tel && (
        <NodeToolbar className="cr-fo-barre nopan nodrag nowheel" position={Position.Top} offset={12} onDoubleClick={(e) => e.stopPropagation()}>
          <span className="cr-fo-couleurs" role="group" aria-label="Couleur">
            {COULEURS.map((c) => (
              <button key={c} type="button" className={cls('cr-fo-pastille', `cr-coul-${c}`, couleur === c && 'est-prise')} aria-pressed={couleur === c} aria-label={NOM_COULEUR[c]} title={NOM_COULEUR[c]} onClick={() => envoie({ couleur: c })} />
            ))}
          </span>
          {!libre && (
            <button type="button" className={cls('cr-fo-bouton', k.plein && 'est-pris')} aria-pressed={!!k.plein} title={k.plein ? 'Fond léger : cliquer pour le contour seul' : 'Contour seul : cliquer pour un fond léger'} onClick={() => envoie({ plein: !k.plein })}>
              Plein
            </button>
          )}
          <button type="button" className="cr-fo-bouton" disabled={i <= 0} aria-label="Texte plus petit" title={`Texte plus petit (${taille})`} onClick={() => envoie({ tailleTexte: TAILLES[i - 1] })}>
            A−
          </button>
          <button type="button" className="cr-fo-bouton" disabled={i >= TAILLES.length - 1} aria-label="Texte plus grand" title={`Texte plus grand (${taille})`} onClick={() => envoie({ tailleTexte: TAILLES[i + 1] })}>
            A+
          </button>
          {!ecrit && !far && (
            <button type="button" className="cr-fo-bouton" title="Écrire dans la forme (ou double-clic)" onClick={ecrire}>
              Écrire
            </button>
          )}
          <button
            type="button"
            className={cls('cr-fo-retire', retire && 'est-armee')}
            aria-label={retire ? 'Confirmer : retirer la forme' : 'Retirer la forme'}
            title={retire ? 'Cliquer encore pour retirer la forme' : 'Retirer la forme'}
            onClick={() => (retire ? actions.retire(id).catch((e) => (setRetire(false), setErreur(e.message))) : setRetire(true))}
            onBlur={() => setRetire(false)}
          >
            {retire ? 'Retirer ?' : '×'}
          </button>
        </NodeToolbar>
      )}
      <div className="cr-fo-corps">
        {ecrit ? (
          <textarea
            ref={champ}
            className="cr-fo-champ nodrag nopan nowheel"
            value={brouillon}
            onChange={(e) => setBrouillon(e.target.value)}
            onBlur={fin}
            onKeyDown={(e) => {
              e.stopPropagation() // le clavier est à la forme (aucun raccourci du plateau ni de l'application)
              if (e.key === 'Escape') {
                e.preventDefault()
                fin()
              }
            }}
            placeholder={libre ? 'Texte' : 'Étiquette'}
            aria-label="Texte de la forme"
            spellCheck
          />
        ) : texteK ? (
          <p className="cr-fo-texte">{texteK}</p>
        ) : (
          libre && !tel && !far && <p className="cr-fo-texte cr-fo-vide">Texte vide · double-clic pour écrire</p>
        )}
      </div>
      {!tel && ecrit && (refus || brouillon.length >= PRES) && (
        <p className={cls('cr-fo-compte', refus && 'est-trop')} role={refus ? 'alert' : undefined}>
          {refus || `${nombre(brouillon.length)} / ${nombre(TEXTE_MAX)}`}
        </p>
      )}
      {!tel && !ecrit && erreur && (
        <p className="cr-fo-compte est-trop" role="alert">
          {erreur}
        </p>
      )}
    </div>
  )
})
