import { useEffect } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { Board } from './Board.jsx'
import { Plein } from './Plein.jsx'

// Le plateau, chargé à la demande (differe.js) avec tout ce qui ne sert qu'à lui : React Flow et son fournisseur, la
// console agrandie de l'ordinateur (Plein), les liens d'équipe. xterm reste à part (le plateau du téléphone n'en monte
// aucun) ; sur l'ordinateur, App le fait venir en même temps.
// `cadreRef` (ordinateur) : le cadrage du plateau (`fitView` de React Flow), posé ici pour la colonne (App.jsx : choisir
// une console la centre). Avant l'arrivée du plateau, App y garde le dernier cadrage demandé (ses options) : il est fait
// ici en arrivant. Vidée quand le plateau s'en va.
// `enGrand` (ordinateur) : la console agrandie, par-dessus le plateau. Le reste va tel quel à Board.
export default function Plateau({ cadreRef, enGrand, ...board }) {
  return (
    <ReactFlowProvider>
      {cadreRef && <Cadre cadreRef={cadreRef} />}
      <Board {...board} />
      {enGrand && <Plein c={enGrand} actions={board.actions} look={board.look} vue={board.vues[enGrand.id] ?? 'terminal'} voisines={board.consoles} />}
    </ReactFlowProvider>
  )
}

function Cadre({ cadreRef }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    const attente = cadreRef.current // un cadrage demandé avant l'arrivée du plateau, ou rien
    cadreRef.current = fitView
    if (attente && typeof attente === 'object') fitView(attente) // React Flow le fait dès que les dalles sont mesurées
    return () => {
      cadreRef.current = null
    }
  }, [cadreRef, fitView])
  return null
}
