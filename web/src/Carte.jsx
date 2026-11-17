// Le cadre commun des cartes du plateau étendu (note, web, git) : une barre qui sert de poignée (déplacer), un titre
// (double-clic : renommer), les outils propres à la carte, « × » en deux temps (retirer), la poignée de taille, et le
// corps. Sur le plateau du téléphone (`tel`) : tuile fixe, rien ne se déplace ni ne défile, aucun outil.
import { useContext, useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import { CartesCtx } from './cartes.js'
import { cls } from './lib.js'
import { TYPES_CARTES } from './cartes-types.js'
import './cartes.css'

// Nom de chaque type et bornes de taille : cartes-types.js (mêmes bornes que le serveur, lib/cartes.mjs et ses modules).
const NOM = Object.fromEntries(Object.entries(TYPES_CARTES).map(([t, d]) => [t, d.nom]))
export const MIN = Object.fromEntries(Object.entries(TYPES_CARTES).map(([t, d]) => [t, d.min || { w: 40, h: 24 }]))

export function Carte({ id, k, width, height, selected, titre, outils, children, className }) {
  const { far, tel, rev, actions } = useContext(CartesCtx)
  const [retire, setRetire] = useState(false) // premier clic sur « × » : il demande ; le second retire
  const [renomme, setRenomme] = useState(false)
  const w = width ?? k.w
  const h = height ?? k.h
  const nom = k.titre || titre || NOM[k.type]
  const finRenomme = (v) => {
    setRenomme(false)
    if (v !== undefined && v.trim() !== (k.titre || '')) actions.patch(id, { titre: v.trim() }).catch(() => {})
  }
  return (
    <div className={cls('et-carte', `et-${k.type}`, far && 'est-loin', tel && 'est-tel', selected && 'est-choisie', className)} style={{ width: w, height: h }}>
      {!tel && (
        <NodeResizer
          isVisible={!!selected}
          minWidth={MIN[k.type].w}
          minHeight={MIN[k.type].h}
          color={rev ? undefined : '#ECE4A0'} // Réverbère : couleurs dans cartes.css (la prop écrit un style en ligne qui passe devant)
          onResizeEnd={(_, p) => actions.patch(id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }).catch(() => {})}
        />
      )}
      <header className="et-barre">
        <span className="et-type">{NOM[k.type]}</span>
        {renomme ? (
          <input
            className="et-renomme nodrag"
            autoFocus
            defaultValue={k.titre || ''}
            placeholder={titre || NOM[k.type]}
            maxLength={80}
            aria-label="Nom de la carte"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') finRenomme(e.currentTarget.value)
              if (e.key === 'Escape') finRenomme()
            }}
            onBlur={(e) => finRenomme(e.currentTarget.value)}
          />
        ) : (
          <span className="et-titre" title={tel ? undefined : 'Double-clic : renommer'} onDoubleClick={tel ? undefined : () => setRenomme(true)}>
            {nom}
          </span>
        )}
        {!tel && !far && outils}
        {!tel && (
          <button
            type="button"
            className={cls('et-retire nodrag', retire && 'est-armee')}
            aria-label={retire ? 'Confirmer : retirer la carte' : 'Retirer la carte'}
            title={retire ? 'Cliquer encore pour retirer la carte' : 'Retirer la carte'}
            onClick={() => (retire ? actions.retire(id).catch(() => setRetire(false)) : setRetire(true))}
            onBlur={() => setRetire(false)}
          >
            {retire ? 'Retirer ?' : '×'}
          </button>
        )}
      </header>
      <div className={cls('et-corps', !tel && 'nodrag nopan nowheel')}>{children}</div>
    </div>
  )
}
