// Faux agent pour les essais : dessine dans le terminal un menu de la forme exacte de ceux de Claude Code (formes
// relevées le 10/11, voir lib/question.mjs), déplace son curseur aux flèches, et écrit « CHOISI: <libellé> » à Entrée
// (« ANNULE » à Échap). Ensuite il se tait et laisse le terminal afficher ce qu'on tape, comme le faux agent habituel.
// Usage : node menu-factice.mjs confiance|permission|sourd|cases   (« sourd » : un menu qui ignore les flèches ;
//         « cases » : une question à plusieurs réponses, avec sa relecture avant envoi)
const forme = process.argv[2] || 'confiance'
const FORMES = {
  confiance: {
    tete: ['─'.repeat(60), ' Accessing workspace:', '', ' ~/essai-de-confiance', '', ' Quick safety check: Is this a project you created or one you', ' trust? (Like your own code, a well-known open source project,', ' or work from your team).', '', " Claude Code'll be able to read, edit, and execute files here.", '', ' Security guide', ''],
    options: ['No, exit', 'Yes, I trust this folder'],
    pied: ' Enter to confirm · Esc to cancel',
    ligne: (o, i, ici) => ` ${ici ? '❯' : ' '} ${o}`,
  },
  permission: {
    tete: ['● Write(essai.txt)', '', '─'.repeat(60), ' Create file', ' essai.txt', '╌'.repeat(60), '  1 OK', '╌'.repeat(60), ' Do you want to create essai.txt?'],
    options: ['Yes', 'Yes, and switch to accept edits (auto-approve file edits\n      and common file commands) for this session (shift+tab)', 'No'],
    pied: '\n Esc to cancel · Tab to amend',
    ligne: (o, i, ici) => ` ${ici ? '❯' : ' '} ${i + 1}. ${o}`,
  },
}
FORMES.sourd = FORMES.permission
// « cases » : la question à plusieurs réponses de Claude Code (forme relevée le 10/11, sonde-cases.mjs). Espace ou
// Entrée coche la ligne du curseur ; Entrée sur « Submit » mène à la relecture (sans pied) ; « Submit answers » écrit
// « CHOISI: <fruits cochés> ». Le pied passe sur deux lignes quand le curseur est sur « Type something » ou « Submit ».
if (forme === 'cases') {
  const FRUITS = ['Pomme', 'Poire', 'Raisin']
  const T = '─'.repeat(60)
  const coche = [false, false, false]
  let ici = 0 // 0 à 2 : les fruits ; 3 : Type something ; 4 : Submit ; 5 : Chat about this
  let revue = -1 // -1 : la question ; 0 ou 1 : le curseur de la relecture
  const c = (i) => (ici === i ? '❯' : ' ')
  const choisis = () => FRUITS.filter((_, i) => coche[i]).join(', ')
  const dessine = () => {
    const lignes =
      revue < 0
        ? ['❯ Essai de cases', T, `←  ${coche.some(Boolean) ? '☒' : '☐'} Fruits  ✔ Submit  →`, '', 'Quels fruits veux-tu ?', '', ...FRUITS.flatMap((n, i) => [`${c(i)} ${i + 1}. [${coche[i] ? '✔' : ' '}] ${n}`, `         Un fruit : ${n.toLowerCase()}.`]), `${c(3)} 4. [ ] Type something`, `${c(4)}    Submit`, T, `${c(5)} 5. Chat about this`, '', ...(ici === 3 || ici === 4 ? ['Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim', 'Esc to cancel'] : ['Enter to select · ↑/↓ to navigate · Esc to cancel'])]
        : ['❯ Essai de cases', '', T, '←  ☒ Fruits  ✔ Submit  →', '', 'Review your answers', '', ' ● Quels fruits veux-tu ?', `   → ${choisis()}`, '', 'Ready to submit your answers?', '', `${revue === 0 ? '❯' : ' '} 1. Submit answers`, `${revue === 1 ? '❯' : ' '} 2. Cancel`]
    process.stdout.write('\x1b[2J\x1b[H' + lignes.join('\n'))
  }
  const fin = (mot) => {
    process.stdout.write(`\x1b[2J\x1b[H\n  ${mot}\n\n`)
    process.stdin.setRawMode(false)
    process.stdin.removeAllListeners('data')
    process.stdin.on('data', () => {})
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (d) => {
    const s = d.toString('latin1')
    const bas = s === '\x1b[B' || s === '\x1bOB'
    const haut = s === '\x1b[A' || s === '\x1bOA'
    const entree = s === '\r' || s === '\n'
    if (s === '\x03') process.exit(0)
    if (s === '\x1b') return fin('ANNULE')
    if (revue >= 0) {
      if (entree) return fin(revue === 0 ? `CHOISI: ${choisis()}` : 'ANNULE')
      if (bas) revue = 1
      if (haut) revue = 0
    } else {
      if (bas) ici = Math.min(5, ici + 1)
      if (haut) ici = Math.max(0, ici - 1)
      if ((entree || s === ' ') && ici < 3) coche[ici] = !coche[ici]
      else if (entree && ici === 4) revue = 0
      else if (entree && ici === 5) return fin('CHOISI: Chat about this')
    }
    dessine()
  })
  dessine()
} else {
  const f = FORMES[forme]
  if (!f) {
    console.error(`forme inconnue : ${forme}`)
    process.exit(2)
  }
  let ici = 0
  const dessine = () => process.stdout.write('\x1b[2J\x1b[H' + [...f.tete, ...f.options.map((o, i) => f.ligne(o, i, i === ici)), f.pied].join('\n'))
  const fin = (mot) => {
    process.stdout.write(`\x1b[2J\x1b[H\n  ${mot}\n\n`)
    process.stdin.setRawMode(false) // le terminal réaffiche ce qu'on tape (« ^[[B » pour une flèche), comme sous `cat`
    process.stdin.removeAllListeners('data')
    process.stdin.on('data', () => {})
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (d) => {
    const s = d.toString('latin1')
    if (s === '\x03') process.exit(0)
    if (s === '\r' || s === '\n') return fin(`CHOISI: ${f.options[ici].split('\n')[0]}`)
    if (s === '\x1b') return fin('ANNULE')
    if (forme !== 'sourd') {
      if (s === '\x1b[B' || s === '\x1bOB') ici = Math.min(f.options.length - 1, ici + 1)
      if (s === '\x1b[A' || s === '\x1bOA') ici = Math.max(0, ici - 1)
    }
    dessine()
  })
  dessine()
}
