// Ateliers (volet du 13/11) : le registre des cartes d'atelier pour le plateau (`nodeTypes` de Board.jsx, par Cartes.jsx).
// On les pose depuis le menu « Ajouter ▴ » du plateau (section « Ateliers », AJOUTS de Cartes.jsx, volet plateau-creatif) ;
// leurs noms et tailles sont dans TYPES_CARTES (cartes-types.js).
import { DocNode } from './DocNode.jsx'
import { CodeNode } from './CodeNode.jsx'
import { CoffreNode } from './CoffreNode.jsx'
import { DiagrammeNode } from './DiagrammeNode.jsx'

export const nodeTypesAteliers = { 'carte-doc': DocNode, 'carte-code': CodeNode, 'carte-coffre': CoffreNode, 'carte-diagramme': DiagrammeNode }
