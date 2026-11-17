// Relais entre agents : la conversation d'une console, écrite dans un fichier que l'agent suivant lit en arrivant.
// (Écart avec Symvibe, lot 3 : « transmission d'un agent à un autre » ; Orkun, 10/11 : « tu continues la suite du
// chantier pour qu’on termine ce produit completement ».) Le fichier est fait à partir du journal de l'agent, sans
// rien lui demander : le relais marche aussi quand l'agent d'origine est bloqué, fermé ou à court de quota.

import { NOM } from './nom.mjs'

const MAX = 48000 // caractères de conversation repris, en partant de la fin

const bloc = (x) => {
  if (x.r === 'outils') return `- outils : ${x.outils.map((o) => `${o.nom}${o.quoi ? ` ${o.quoi}` : ''}`).join(' ; ')}${x.plus || x.moins ? ` (+${x.plus} −${x.moins})` : ''}`
  return `## ${x.r === 'toi' ? NOM : 'Agent'}\n\n${x.t.trim()}`
}

// `source` : la console d'origine ; `fil` : sa conversation telle que lib/fil.mjs la lit ; `quand` : la date du relais.
export function passation(source, fil, quand = new Date()) {
  const blocs = []
  let taille = 0
  for (let i = fil.length - 1; i >= 0; i--) {
    const b = bloc(fil[i])
    if (taille + b.length > MAX && blocs.length) break
    blocs.unshift(b.slice(-MAX))
    taille += b.length
  }
  const laisses = fil.length - blocs.length
  return [
    `# Relais de « ${source.name} » (${source.kind}) — ${quand.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Dossier de travail : ${source.cwd}`,
    ...(source.sujet ? [`Sujet de la session : ${source.sujet}`] : []),
    '',
    `Ce fichier est la conversation de l’agent qui te passe le relais, du plus ancien au plus récent. « ${NOM} » est la personne pour qui tu travailles ; « Agent » est l’agent précédent. Ses outils sont résumés en une ligne.`,
    ...(laisses > 0 ? ['', `(Le début n’est pas repris : ${laisses} élément${laisses > 1 ? 's' : ''} plus ancien${laisses > 1 ? 's' : ''}.)`] : []),
    '',
    ...blocs.flatMap((b) => [b, '']),
  ].join('\n')
}

// La dernière réponse de l'agent, pour la transmettre telle quelle à une autre console.
export const derniereReponse = (fil) => fil.findLast((x) => x.r === 'agent')?.t.trim() ?? ''
