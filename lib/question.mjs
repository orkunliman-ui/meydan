// La question qu'un agent pose dans son terminal quand il attend un choix, lue sur son écran, et la réponse donnée
// pour Orkun par les boutons de la discussion (10/11 : « Oui go », sur « répondre aux questions par des boutons
// directement dans la discussion, sans passer par le terminal »).
//
// Formes relevées sur de vraies sessions le 10/11 (test/seance-2026-11-10/sonde-questions.mjs et sonde-cases.mjs ;
// Claude Code 2.1.322, Codex 0.167.0) :
//   confiance du dossier (Claude)   « ❯ No, exit » / «   Yes, I trust this folder »      pied « Enter to confirm · Esc to cancel »
//   permission (Claude)             « ❯ 1. Yes » / «   2. Yes, and … » / «   3. No »        pied « Esc to cancel · Tab to amend »
//   choix proposés (Claude)         « ❯ 1. Rouge » + description en retrait, …            pied « Enter to select · ↑/↓ to navigate · Esc to cancel »
//   approbation (Codex)             « › 1. Yes, proceed (y) » / «   2. … » / «   3. No, … » pied « Press enter to confirm or esc to cancel »
//   plusieurs réponses (Claude)     « ❯ 1. [ ] Pomme » / «   2. [✔] Poire » … «   4. [ ] Type something » / «      Submit » /
//                                   «   5. Chat about this » ; Espace coche ou décoche la ligne du curseur ; Entrée sur
//                                   « Submit » mène à la relecture. En-tête « ←  ☐ Fruits  ✔ Submit  → ». Sur un écran
//                                   étroit le pied tient sur DEUX lignes (« … ctrl+g to edit in Vim » / « Esc to cancel »).
//   relecture avant envoi (Claude)  « Review your answers » / « ● question » / « → réponse » / « Ready to submit your
//                                   answers? » / « ❯ 1. Submit answers » / «   2. Cancel » — SANS pied.
// Rien n'est supposé au-delà : un écran qui ne montre pas un menu entier, avec son curseur et son pied (ou la relecture
// entière), ne donne rien (et la discussion renvoie alors au terminal, comme avant).
//
// Relevé le 13/11 sur Codex 0.167.1 (lancé comme Meydan le lance, tmux à part ; sonde de l'intégratrice) : ses boîtes
// de lancement ont un AUTRE pied, que « esc to cancel » ne voyait pas — la console restait « TRAVAILLE » devant elles :
//   mise à jour (Codex)             « › 1. Update now (runs `npm install -g @openai/codex`) » / «   2. Skip » /
//                                   «   3. Skip until next version »                            pied « enter continue · esc skip »
//   confiance du dossier (Codex)    « Trust this folder? Codex can read, edit, and run files here, … » /
//                                   « › 1. Trust and continue » / «   2. Back to Agent Command Center »
//                                                                                               pied « enter continue · esc back »

const PIED = /\besc to cancel\b|\benter continue · esc \w+\b/i
const TRAIT = /^[\s─━╌╍┄┈—-]{6,}$/ // une ligne de séparation
const CURSEUR = /^(\s*)([❯›])\s(.*\S.*)$/ // ce qui suit « curseur + espace » peut commencer par un retrait (« ❯    Submit »)
const NUMERO = /^(\d{1,2})\.\s+(\S.*)$/
const CASE = /^\[([ ✔])\]\s+(\S.*)$/ // la case d'une réponse de Claude Code : « [ ] » vide, « [✔] » cochée
const AUTRE_CASE = /^(\[[^\]]?\]|[☐☑☒◯◉○●])\s/ // d'autres cases à cocher : forme inconnue, on ne devine pas
const ONGLETS = /^\s*←\s.*\bSubmit\s+→\s*$/ // l'en-tête d'une question à plusieurs réponses ou de plusieurs questions
const EN_TETE = /^\s*(←\s+)?[☐☒☑✔]\s/ // toute ligne d'onglets, avec ou sans flèches : pas du texte de la question
const PRET = 'Ready to submit your answers?'
const VALIDER = 'Submit' // la ligne sans numéro qui clôt une question à plusieurs réponses
const debut = (l) => l.length - l.trimStart().length
const net = (s) => s.replace(/\s+/g, ' ').trim()

const lignesDe = (ecran) => {
  const lignes = String(ecran ?? '').split('\n').map((l) => l.trimEnd())
  while (lignes.length && !lignes.at(-1)) lignes.pop()
  return lignes
}

// La relecture avant envoi : l'en-tête à onglets, puis « Ready to submit your answers? ». Rend les réponses données,
// [question, réponse] ; null si l'écran ne montre pas cette boîte.
const relecture = (lignes) => {
  const h = lignes.findLastIndex((l) => ONGLETS.test(l))
  if (h < 0 || lignes.length - h > 40) return null
  const pret = lignes.findIndex((l, i) => i > h && l.trim() === PRET)
  if (pret < 0) return null
  const reponses = []
  let dans = -1 // 0 : on lit une question, 1 : sa réponse (un texte long passe à la ligne)
  for (let i = h + 1; i < pret; i++) {
    const t = lignes[i].trim()
    if (!t || t === 'Review your answers') continue
    if (t.startsWith('● ')) {
      reponses.push([net(t.slice(2)), ''])
      dans = 0
    } else if (t.startsWith('→ ') && reponses.length) {
      reponses.at(-1)[1] = net(t.slice(2))
      dans = 1
    } else if (dans >= 0) reponses.at(-1)[dans] = net(`${reponses.at(-1)[dans]} ${t}`)
  }
  return { reponses }
}

// Un menu ou une boîte de dialogue est-il ouvert à l'écran, qu'on sache le lire ou non ? (« /effort » ouvre un curseur
// horizontal : pas de boutons possibles, mais rien ne doit y être collé ni validé par un message.) La relecture avant
// envoi n'a pas de pied : elle compte quand même (un chiffre tapé y choisirait « Submit answers » ou « Cancel »).
export const menuOuvert = (ecran) => {
  const lignes = lignesDe(ecran)
  const derniere = lignes.at(-1) ?? ''
  return PIED.test(derniere) || (/^\s*[❯›]?\s*\d{1,2}\.\s+\S/.test(derniere) && !!relecture(lignes))
}

// Rend { titre, contexte, options: [{ texte, suite, ici, coche?, valide? }], ici, pied, cases } ou null.
//   coche : true ou false pour une case à cocher (question à plusieurs réponses) ; valide : la ligne « Submit » qui
//   clôt ces cases ; cases : la question accepte plusieurs réponses.
export function lireQuestion(ecran) {
  const lignes = lignesDe(ecran)
  // Le pied du menu est la DERNIÈRE ligne de l'écran : c'est ce qui dit que le menu est ouvert maintenant. Quand Claude
  // sort après « No, exit », sa boîte reste affichée au-dessus de l'invite du shell : ce n'est plus un menu (vu en sondant).
  const p = lignes.length - 1
  if (p < 1) return null
  const aPied = PIED.test(lignes[p])
  const revue = relecture(lignes)
  if (!aPied && !revue) return null
  // Le curseur : la dernière ligne marquée au-dessus du pied (ou jusqu'à la dernière ligne, pour la relecture sans pied).
  let k = -1
  for (let i = aPied ? p - 1 : p; i >= Math.max(0, p - 40); i--) {
    if (CURSEUR.test(lignes[i])) {
      k = i
      break
    }
  }
  if (k < 0) return null
  const [, marge, , apres] = lignes[k].match(CURSEUR)
  const col = marge.length + 2 // la colonne où commence le texte d'une option
  // Où le menu s'arrête : au pied, qui tient sur deux lignes sur un écran étroit (sa première ligne part du bord gauche).
  let fin = aPied ? p : p + 1
  if (aPied && p - 1 > k && lignes[p - 1].trim() && lignes[p - 1].slice(0, col).trim() && !TRAIT.test(lignes[p - 1])) fin = p - 1
  // Le curseur est sur une option (à la colonne des options), ou sur « Submit » (trois colonnes plus loin, sans numéro).
  let numerote
  if (debut(apres) === 0) numerote = NUMERO.test(apres)
  else if (debut(apres) === 3 && apres.trim() === VALIDER) numerote = true
  else return null
  // Ce qu'une ligne est pour le menu : une option (à la colonne des options), la ligne « Submit », la suite de l'option
  // du dessus (plus en retrait), ou une ligne qui n'est pas du menu (elle commence avant la colonne des options).
  const corps = (i) => (i === k ? apres : lignes[i].slice(0, col).trim() ? null : lignes[i].slice(col))
  const genre = (i) => {
    const c = corps(i)
    if (c === null) return 'dehors'
    if (debut(c) === 0) return !numerote || NUMERO.test(c) ? 'option' : 'dehors'
    return debut(c) === 3 && c.trim() === VALIDER ? 'valider' : 'suite'
  }
  // Vers le haut, puis vers le bas. Un menu sans numéros n'a pas de ligne vide ; un menu numéroté peut en avoir (et des traits).
  let haut = k
  for (let i = k - 1; i >= 0; i--) {
    const l = lignes[i]
    if (!l.trim() || TRAIT.test(l)) {
      if (!numerote) break
      continue
    }
    const g = genre(i)
    if (g === 'option') haut = i
    else if (g === 'dehors') break
  }
  const options = []
  let cases = false
  let rang = 0
  for (let i = haut; i < fin; i++) {
    const l = lignes[i]
    if (!l.trim() || TRAIT.test(l)) continue
    const g = genre(i)
    if (g === 'option') {
      let texte = net(corps(i))
      if (numerote) {
        // 1, 2, 3… sans trou : sinon ce n'est pas le menu entier (écran en cours de dessin, liste dans un texte).
        const m = texte.match(NUMERO)
        if (!m || Number(m[1]) !== ++rang) return null
        texte = m[2]
      }
      const o = { texte, suite: '', ici: i === k }
      const c = numerote ? texte.match(CASE) : null
      if (c) {
        o.texte = c[2]
        o.coche = c[1] !== ' '
        cases = true
      } else if (AUTRE_CASE.test(texte)) return null // des cases d'une autre forme : se règle dans le terminal
      options.push(o)
    } else if (g === 'valider' && cases && !options.some((o) => o.valide)) options.push({ texte: VALIDER, suite: '', ici: i === k, valide: true })
    else if (g !== 'dehors' && options.length) options.at(-1).suite = net(`${options.at(-1).suite} ${l}`)
    else return null // une ligne qui n'appartient pas au menu, entre le menu et son pied : on ne devine pas
  }
  if (options.length < 2 || options.length > 12) return null
  const ici = options.findIndex((o) => o.ici)
  if (ici < 0) return null
  if (cases && !options.some((o) => o.valide)) return null // des cases sans leur ligne « Submit » : pas le menu entier
  if (revue && !aPied) {
    // La relecture : ce qui a été répondu, puis envoyer ou annuler.
    return { titre: PRET, contexte: revue.reponses.map(([q, r]) => `${q}\n→ ${r}`).join('\n').slice(0, 700), options, ici, pied: '', cases: false, revue: true }
  }
  // Ce que l'agent écrit au-dessus du menu : jusqu'au bord de sa boîte (un trait plein), dix lignes au plus.
  const dessus = []
  for (let i = haut - 1; i >= 0 && dessus.length < 10; i--) {
    const l = lignes[i]
    if (/^[\s─━]{6,}$/.test(l) && l.trim()) break
    if (!l.trim() || TRAIT.test(l) || EN_TETE.test(l)) continue
    if (/^\s*[❯›●•]\s/.test(l)) break // on est sorti de la boîte : une invite ou une réponse de l'agent
    dessus.unshift(net(l))
  }
  // Le titre : la dernière ligne qui pose une question ; à défaut, la ligne juste au-dessus du menu.
  const pose = dessus.findLastIndex((l) => /\?$/.test(l))
  const t = pose >= 0 ? pose : dessus.length - 1
  return { titre: dessus[t] || '', contexte: dessus.filter((_, i) => i !== t).join('\n').slice(0, 700), options, ici, pied: net(lignes.slice(fin, p + 1).join(' ')), cases }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// La question de confiance du dossier, au lancement d'un agent : rend le rang de l'option « oui », ou -1. Reconnue AU MOT
// PRÈS (Claude Code 2.1.322, relevé le 11/11 dans un dossier jamais approuvé : « Quick safety check: Is this a project you
// created or one you trust? », choix « No, exit » sélectionné d'office, puis « Yes, I trust this folder »). Codex 0.167.1
// (relevé le 13/11) la pose dans un dépôt git qu'il ne connaît pas, même en accès complet (copies de travail, projets
// neufs) : « Trust this folder? Codex can read, edit, and run files here… », « › 1. Trust and continue ».
// Rien d'autre : une question qu'on ne reconnaît pas reste à Orkun (la boîte « Update available » de Codex, entre autres).
export function rangConfiance(ecran) {
  const q = lireQuestion(ecran)
  if (!q) return -1
  const texte = lignesDe(ecran).join(' ').replace(/\s+/g, ' ')
  if (/Is this a project you created or one you trust\?/.test(texte)) return q.options.findIndex((o) => o.texte === 'Yes, I trust this folder')
  if (/Do you trust the contents of this directory\?/.test(texte)) return q.options.findIndex((o) => /^Yes, continue$/.test(o.texte))
  if (/Trust this folder\? Codex can read, edit, and run files here/.test(texte)) return q.options.findIndex((o) => o.texte === 'Trust and continue')
  return -1
}

export const refus = (message, code = 409) => Object.assign(new Error(message), { code })

// Donne la réponse `choix` (rang de l'option) au menu ouvert. `texte` est le libellé qu'Orkun a touché : la réponse ne
// part que si c'est toujours ce libellé-là, à ce rang-là (le menu a pu changer entre l'affichage et le toucher).
// Le curseur est amené sur l'option par les flèches, l'écran est RELU, et la touche ne part que si le curseur y est bien :
//   une option, ou la ligne « Submit » → Entrée ; rend { choisi } ;
//   une case à cocher → Espace, puis l'écran est relu jusqu'à voir la case changée ; rend { coche: son nouvel état } ;
//   la case « Type something » → rien de plus : le curseur y est, le texte se tape dans le terminal ; rend { ecrire: true }.
// `console` : { ecran: async () => texte de l'écran, touche: async (nom de touche tmux) => … }.
export async function repondre(console, choix, texte) {
  const q = lireQuestion(await console.ecran())
  if (!q) throw refus('aucune question à l’écran : rien envoyé')
  const o = q.options[choix]
  if (!Number.isInteger(choix) || !o || o.texte !== texte) throw refus('la question a changé depuis l’affichage : rien envoyé')
  // Un cran à la fois, chaque cran relu : une flèche que le programme n'a pas prise ne fait pas valider le voisin.
  let ici = q.ici
  while (ici !== choix) {
    const sens = choix > ici ? 1 : -1
    await console.touche(sens > 0 ? 'Down' : 'Up')
    let lu = null
    for (let essai = 0; essai < 8; essai++) {
      await sleep(90)
      lu = lireQuestion(await console.ecran())
      if (lu && lu.ici !== ici) break
    }
    if (!lu || lu.ici !== ici + sens || lu.options[choix]?.texte !== texte) throw refus('le curseur n’est pas arrivé sur ce choix : rien validé. Touche-le encore, ou réponds dans le terminal.')
    ici = lu.ici
  }
  const dernier = lireQuestion(await console.ecran())
  const cible = dernier?.options[choix]
  if (!dernier || dernier.ici !== choix || cible?.texte !== texte) throw refus('la question a changé pendant la réponse : rien validé')
  if (cible.coche !== undefined) {
    if (/^Type something/.test(texte)) return { ecrire: true }
    await console.touche('Space')
    for (let essai = 0; essai < 10; essai++) {
      await sleep(90)
      const lu = lireQuestion(await console.ecran())
      if (lu?.ici === choix && lu.options[choix]?.texte === texte && lu.options[choix].coche === !cible.coche) return { coche: !cible.coche }
    }
    throw refus('la case n’a pas changé à l’écran. Touche-la encore, ou réponds dans le terminal.')
  }
  await console.touche('Enter')
  return { choisi: texte }
}
