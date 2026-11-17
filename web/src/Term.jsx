import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { garde, MenuDoigt, useAppuiLong } from './appui.jsx'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
// L'Iosevka complète (~1 Mo par graisse) ne sert qu'au terminal : elle est déclarée avec lui. Le reste de l'interface
// écrit en « Iosevka UI », son sous-ensemble (styles.css, scripts/police-ui.py).
import '@fontsource/iosevka/400.css'
import '@fontsource/iosevka/700.css'
import { wsUrl } from './lib.js'
// Entrées gardées pendant une liaison coupée, et ce que la dalle en dit (chasse du 17/11, volet interface-robuste).
import { AGE_REJEU, fileEntrees, texteLiaison } from './liaison.js'
// `depose` et les tailles du texte vivent à part (terminal.js) : la console du téléphone s'en sert sans charger xterm.
import { depose, TAILLE_MAX, TAILLE_MIN } from './terminal.js'
// Rendu par la carte graphique (volet vitesse-term) : qui y a droit, et le code de l'addon chargé à part.
import { chargeWebgl, inscris } from './rendu.js'

const FONT = "'Iosevka', 'Cascadia Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace"
const TAPIS = {
  background: '#0E1211',
  foreground: '#D5DBD3',
  cursor: '#EFE6CF',
  cursorAccent: '#0E1211',
  selectionBackground: 'rgba(239,230,207,.28)',
  black: '#1A201E',
  red: '#F0624D',
  green: '#9BC46A',
  yellow: '#E5C76B',
  blue: '#6FA8DC',
  magenta: '#C792C9',
  cyan: '#6FCFC6',
  white: '#C9CFC7',
  brightBlack: '#5E6B66',
  brightRed: '#FF7F6A',
  brightGreen: '#B6DB85',
  brightYellow: '#F3DB8C',
  brightBlue: '#8FC1EE',
  brightMagenta: '#DDAEDF',
  brightCyan: '#92E3DB',
  brightWhite: '#F2F4EE',
}
// « Réverbère » : fond presque neutre, 16 couleurs réglées pour 4,5:1 dessus.
const REVERBERE = {
  background: '#0a0c12',
  foreground: '#d9dce6',
  cursor: '#d9dce6',
  cursorAccent: '#0a0c12',
  selectionBackground: 'rgba(110,155,255,.3)',
  black: '#131729',
  red: '#f2616e',
  green: '#8ed08a',
  yellow: '#d9a441',
  blue: '#7ca8f2',
  magenta: '#c99aea',
  cyan: '#5ed0c6',
  white: '#c9cdd9',
  brightBlack: '#7f87a3',
  brightRed: '#ff8c95',
  brightGreen: '#b2e5aa',
  brightYellow: '#eaa13a',
  brightBlue: '#a6c6fb',
  brightMagenta: '#dfbcf6',
  brightCyan: '#92e8de',
  brightWhite: '#f5f6fa',
}
// Appel jaune : rien dans le terminal, ni texte ni fond, ne doit ressembler à l'aplat d'appel (#f2e94e).
// Les jaunes ANSI sont déjà ocre ; les sept jaunes de la palette 256 à moins de 0,08 OKLab de l'aplat le deviennent aussi.
// Les verts-jaunes 190 à 192 restent tels quels (autre famille, décision des juges du 10/11).
const OCRE_256 = Array(213) // extendedAnsi commence à l'entrée 16
for (const n of [184, 185, 220, 221, 226, 227, 228]) OCRE_256[n - 16] = '#eaa13a'
const THEMES = {
  tapis: TAPIS,
  'reverbere-jaune': { ...REVERBERE, extendedAnsi: OCRE_256 },
  'reverbere-ivoire': { ...REVERBERE, yellow: '#e8c66a', brightYellow: '#f4de96' },
}
const paint = (term, look) => {
  term.options.theme = THEMES[look] || TAPIS
  term.options.minimumContrastRatio = look === 'tapis' ? 1 : 4.5
}

const CTRL_V = String.fromCharCode(22) // le caractère ^V

// Veille (volet plateau-pc, 11/11 ; qui dort : veille.js). Endormi, ce que tmux envoie est mis de côté jusqu'à cette
// borne (en caractères) ; au-delà, la file est jetée et la liaison fermée : au réveil, une nouvelle liaison, et tmux
// redessine tout l'écran au client qui s'attache.
export const BORNE_VEILLE = 256 * 1024

// Terminal relié à une session tmux du serveur.
// `zs` = zoom stabilisé du canevas : le terminal est rendu à la taille réelle de l'écran
// (police × zs) puis ramené par l'échelle inverse. Net à tout zoom, et la souris tombe juste,
// parce que xterm.js calcule ses coordonnées sans connaître les transformations CSS.
// `onTaille` (téléphone) : le pincement à deux doigts demande une autre taille de texte ; `base` la porte.
// `onColle(dit)` : où annoncer ce que le menu « Coller » vient de déposer (sans lui, le menu le dit lui-même un instant).
// `veille` (plateau de l'ordinateur, à partir de 15 consoles) : ce terminal n'est pas vu. Orkun, 11/11 : « ne plus peindre
// ni écrire dans xterm les dalles hors de l'écran ou sous le zoom des tuiles (garder la connexion et le texte reçu,
// l'afficher au retour) ». Endormi : la liaison reste ouverte, rien n'est écrit dans xterm (donc rien n'est repeint), le
// texte reçu attend dans une file (BORNE_VEILLE), le curseur ne clignote plus, la mise à la taille attend le réveil.
// `.term-host[data-veille]` le dit : « 1 » endormi, « coupe » endormi et liaison fermée (file débordée).
// Sans `veille` (console agrandie, téléphone), rien ne change.
// Mises à la taille en file, étalées sur les images (17/11, sonde `lenteur-pc` d'un PC 5120 × 1440 avec 9 terminaux :
// jusqu'à 166 ms par image quand le zoom se pose). Chaque terminal change alors de police et xterm remesure chaque
// caractère affiché (une mise en page forcée par caractère : ~570 mesures par zoom pour 9 terminaux au banc) ; toutes
// dans la même image, la page gelait. Ici, une image n'en fait que pour 8 ms au plus (au moins une), le terminal actif
// d'abord : les autres se remettent au net dans les images qui suivent.
const fileAjuste = new Set()
let imageAjuste = 0
function planifieAjuste(f, devant) {
  if (devant) {
    const reste = [...fileAjuste].filter((g) => g !== f)
    fileAjuste.clear()
    ;[f, ...reste].forEach((g) => fileAjuste.add(g))
  } else fileAjuste.add(f)
  if (!imageAjuste) imageAjuste = requestAnimationFrame(videAjuste)
}
function videAjuste() {
  imageAjuste = 0
  const t0 = performance.now()
  for (const f of fileAjuste) {
    fileAjuste.delete(f)
    f()
    if (performance.now() - t0 > 8) break
  }
  if (fileAjuste.size) imageAjuste = requestAnimationFrame(videAjuste)
}

export function Term({ id, zs = 1, width, height, active = false, base = 13, apiRef, look = 'tapis', onTaille, onColle, veille = false, gl = false }) {
  const hostRef = useRef(null)
  const st = useRef({})
  // Sa mise à la taille telle que la file la reçoit (même fonction à chaque fois : elle n'y est qu'une fois).
  const ajusteFile = useRef(() => !veilleRef.current && st.current.ajuste?.())
  const zsRef = useRef(zs)
  zsRef.current = zs
  const veilleRef = useRef(veille) // lue à l'ouverture du terminal (il peut naître endormi)
  veilleRef.current = veille
  const activeRef = useRef(active)
  activeRef.current = active
  const lookRef = useRef(look)
  lookRef.current = look
  const baseRef = useRef(base) // lue à la création : changer de taille ne recrée pas le terminal (ni sa liaison)
  baseRef.current = base
  const tailleRef = useRef(onTaille)
  tailleRef.current = onTaille
  const glRef = useRef(gl) // lu à la création : le plateau et la console agrandie de l'ordinateur (rendu.js décide)
  // Copie à la souris (Orkun, 11/11 : « je n'arrive pas a faire de copier coller sur la version pc (copier du text dans
  // le terminal …) »). La souris de tmux est active : glisser sélectionne DANS tmux, qui envoie la sélection au relâchement
  // par une séquence OSC 52 ; xterm l'ignorait, le texte se perdait. Elle est reçue ici et posée dans le presse-papiers,
  // avec une bulle « Copié » là où la souris a été relâchée. Seulement juste après un geste de la souris dans CE
  // terminal : un programme qui tourne dans la console ne peut pas remplir le presse-papiers d'Orkun à son insu.
  const geste = useRef({ x: 0, y: 0, at: 0 })
  const [bulle, setBulle] = useState(null) // { x, y, dit } ou { x, y, texte } (copie refusée : un bouton la refait)
  const [liaison, setLiaison] = useState(null) // { texte, attente, retenue, envoie, jette } : liaison coupée ou frappe retenue (liaison.js)
  const copieRef = useRef(null)
  copieRef.current = (texte) => {
    const { x, y } = geste.current
    navigator.clipboard.writeText(texte).then(
      () => setBulle({ x, y, dit: `Copié · ${texte.length} caractère${texte.length > 1 ? 's' : ''}` }),
      () => setBulle({ x, y, texte }),
    )
  }

  useEffect(() => {
    let dead = false, ws, timer, retry = 0
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: baseRef.current * zsRef.current,
      lineHeight: 1.18,
      fontWeight: 400,
      fontWeightBold: 700,
      theme: THEMES[lookRef.current] || TAPIS,
      minimumContrastRatio: lookRef.current === 'tapis' ? 1 : 4.5,
      cursorBlink: true,
      scrollback: 0, // l'historique est tenu par tmux (molette)
      // Option compose les caractères sur Mac (Orkun, 17/11, à « Quel clavier as-tu sur le MacBook : belge, français ou
      // autre ? » : « belge » ; Option+( = {, Option+Maj+( = [, Option+L = |…). Avec `true`, xterm en faisait un Méta et
      // ces caractères n'arrivaient jamais. Option+Entrée reste ESC CR et Option+flèches ESC[1;3x (xterm 6, Keyboard.ts :
      // ces touches ne passent pas par la composition), prouvé au banc (test/volets/interface-robuste/essai-option-mac.mjs).
      macOptionIsMeta: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Ctrl+V (et Cmd+V) : xterm en ferait le caractère de contrôle ^V et empêcherait le navigateur de coller.
    // En lui disant de ne pas traiter cette touche, le navigateur colle : xterm reçoit alors le texte du presse-papiers
    // par son événement « paste » et l'envoie à la console (collage encadré si le programme le demande).
    // Tous les événements de la touche sont écartés (appui, caractère, relâchement) : en n'écartant que l'appui, le
    // caractère ^V partait quand même, et le shell affichait « ^[[200~ » devant le texte collé (essai du 10/11).
    // AltGr (Ctrl+Alt sous Windows) n'est pas concerné.
    // Ctrl+C (ou Ctrl+Maj+C) quand xterm a une sélection (Maj+glisser, ou un programme qui garde la souris pour lui) :
    // la sélection est copiée au lieu d'interrompre. Sans sélection, Ctrl+C part à la console comme toujours.
    term.attachCustomKeyEventHandler((e) => {
      const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey
      if (ctrl && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V' || e.key === CTRL_V)) return false
      if (ctrl && e.code === 'KeyC' && term.hasSelection()) {
        if (e.type === 'keydown') {
          geste.current = { ...geste.current, at: Date.now() }
          copieRef.current?.(term.getSelection())
          term.clearSelection()
        }
        return false
      }
      return true
    })
    // La sélection que tmux envoie (OSC 52 « c;<base64> ») à la fin d'un glisser, d'un double ou d'un triple clic.
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1)
      if (!b64 || b64 === '?' || Date.now() - geste.current.at > 2000) return true // lecture du presse-papiers, ou sans geste : refusé
      try {
        const texte = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))
        if (texte) copieRef.current?.(texte)
      } catch {} // contenu illisible : rien
      return true
    })
    // Le geste qui autorise la copie, et la sélection propre à xterm (Maj+glisser) copiée au relâchement.
    const souris = (e) => {
      if (e.pointerType !== 'mouse') return
      geste.current = { x: e.clientX, y: e.clientY, at: Date.now() }
      if (e.type === 'pointerup') setTimeout(() => term.hasSelection() && copieRef.current?.(term.getSelection()), 0)
    }
    hostRef.current?.addEventListener('pointerdown', souris, true)
    hostRef.current?.addEventListener('pointerup', souris, true)
    const send = (s) => ws?.readyState === 1 && ws.send(s)
    // Frappe, collage, touches du téléphone : liaison prête, ils partent ; coupée (ou pas encore prête), ils attendent
    // dans `entrees` et partent à la reconnexion (plus bas, premier message), toujours derrière ce qui attend déjà.
    // `coupee` : la liaison est tombée sans qu'on la ferme ; `pret` : ouverte ET tmux a dessiné (attaché, mode brut) ;
    // `retenue` : revenue, la frappe attend « Envoyer » ou « Jeter » (liaison.js dit quand) ; pendant ce temps, ce qui est
    // tapé part directement (l'écran est redessiné : Ctrl C, Échap et les réponses d'xterm ne restent pas bloquées).
    // `recu` : quand le terminal a reçu quelque chose pour la dernière fois (0 : jamais, première liaison).
    const entrees = fileEntrees()
    let coupee = false, pret = false, retenue = false, recu = 0
    const dit = () =>
      !dead &&
      setLiaison(
        coupee || retenue
          ? {
              texte: texteLiaison({ coupee, retenue, poids: entrees.poids, refuse: entrees.refuse, entrees: entrees.entrees }),
              attente: entrees.poids > 0,
              retenue,
              envoie: () => pret && ws?.readyState === 1 && (entrees.vide((d) => ws.send('i' + d)), (retenue = false), dit()),
              jette: () => (entrees.jette(), (retenue = false), dit()),
            }
          : null,
      )
    const entree = (d) => {
      if (pret && ws?.readyState === 1 && (retenue || !entrees.poids)) return ws.send('i' + d)
      entrees.garde(d)
      dit()
    }
    term.onData(entree)
    term.onBinary(entree)
    // data-grid : la grille réelle du pty, lisible de l'extérieur (preuve que l'apparence ne la change pas).
    // --rang : la hauteur réelle d'un rang dans le plan, publiée sur la dalle. La plaque s'y cale (reverbere.css)
    // pour ne jamais trancher une ligne ; xterm arrondit cette hauteur au pixel, elle change donc avec le zoom.
    // data-police : la taille de police posée (police × zoom), lisible quel que soit le rendu (le rendu WebGL n'a pas de
    // `.xterm-rows` où la lire).
    const mark = () => {
      const host = hostRef.current
      if (!host) return
      host.dataset.grid = `${term.cols}x${term.rows}`
      host.dataset.police = term.options.fontSize
      const h = parseFloat(host.querySelector('.xterm-screen')?.style.height)
      if (h) host.closest('.slab')?.style.setProperty('--rang', `${h / term.rows / zsRef.current}px`)
    }
    term.onResize(({ cols, rows }) => {
      send(`r${cols},${rows}`)
      mark()
    })
    // paste : le texte arrive comme un collage (encadré si le programme le demande : les retours à la ligne ne valident rien).
    if (apiRef) apiRef.current = { send: entree, focus: () => term.focus(), paste: (t) => term.paste(t) }
    // La taille de la console suit l'écran actif (tmux : le dernier client qui a tapé, cliqué, pris le focus). Une page qui
    // redevient visible (iPhone sorti de veille, onglet repris) le dit au serveur (« a ») : ce terminal reprend sa taille.
    const revient = () => document.visibilityState === 'visible' && send('a')
    document.addEventListener('visibilitychange', revient)

    // Veille : `dort` (rien n'est écrit dans xterm), `file` / `poids` (ce qui a été reçu pendant ce temps, en caractères),
    // `coupe` (liaison fermée pendant le sommeil : on se reconnecte au réveil), `clignote` (le réglage d'avant le sommeil :
    // un programme peut l'avoir changé par une séquence).
    let dort = false, file = [], poids = 0, coupe = false, clignote = true
    const connect = () => {
      if (dead) return
      coupe = false
      pret = false
      const s = (ws = new WebSocket(wsUrl(`/ws/term/${id}?cols=${term.cols}&rows=${term.rows}`)))
      s.onopen = () => {
        retry = 0
        file = [] // le reste d'une liaison précédente : tmux redessine tout l'écran au client qui s'attache
        poids = 0
        term.reset()
        send(`r${term.cols},${term.rows}`)
      }
      s.onmessage = (e) => {
        // Ce qui a été tapé pendant la coupure part au premier dessin de tmux, pas à l'ouverture : avant son attache, le
        // terminal du serveur est encore en mode ligne (il ferait l'écho lui-même, et le passage en mode brut peut jeter).
        if (!pret) {
          pret = true
          const vieille = entrees.age > AGE_REJEU || (recu && Date.now() - recu > AGE_REJEU) || entrees.refuse > 0
          // Retenue collante (relecture du 17/11) : une seconde coupure juste après ne la fait pas partir seule.
          if (entrees.poids && (vieille || entrees.aConfirmer)) (retenue = true), entrees.retiens()
          else entrees.vide((d) => s.send('i' + d))
          coupee = false
          dit()
        }
        recu = Date.now()
        if (!dort) return term.write(e.data)
        file.push(e.data)
        poids += e.data.length
        if (poids > BORNE_VEILLE) deborde()
      }
      s.onclose = (e) => {
        // `s !== ws` : une liaison que nous avons fermée nous-mêmes (débordement) ou déjà remplacée.
        if (s === ws) pret = false
        if (dead || s !== ws) return
        // Console fermée ou inconnue : plus de liaison possible, ce qui attendait ne partira jamais.
        if (e.code === 4404 || e.code === 4410) return (entrees.jette(), (coupee = retenue = false), dit())
        if (dort) return (coupe = true) // endormi : pas de reconnexion en arrière-plan, le réveil s'en charge
        coupee = true
        retenue = false // de nouveau coupée : la frappe retenue attend la prochaine liaison (elle sera retenue encore)
        dit()
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++))
      }
    }
    // File pleine pendant le sommeil : on la jette et on ferme la liaison (plus rien ne circule) ; le serveur détache
    // alors son client tmux, la session continue.
    const deborde = () => {
      const s = ws
      ws = null
      pret = false
      file = []
      poids = 0
      coupe = true
      s.onmessage = null
      s.close()
      if (host) host.dataset.veille = 'coupe'
    }
    // La mise à la taille (police × zoom, grille), refaite au réveil si elle a été reportée.
    const ajuste = () => {
      if (dead) return
      term.options.fontSize = baseRef.current * zsRef.current
      fit.fit()
      mark()
    }
    const endors = () => {
      if (dort) return
      dort = true
      clignote = term.options.cursorBlink
      term.options.cursorBlink = false
      if (host) host.dataset.veille = '1'
    }
    const reveille = () => {
      if (!dort) return
      dort = false
      term.options.cursorBlink = clignote
      if (host) delete host.dataset.veille
      if (coupe) {
        // Liaison fermée : à la bonne taille d'abord (l'attache s'y fait), puis une nouvelle liaison ; `onopen` vide
        // l'écran et tmux le redessine en entier.
        clearTimeout(timer)
        retry = 0
        ajuste()
        return connect()
      }
      // Le texte reçu pendant le sommeil, d'un coup, morceau par morceau (xterm les découpe entre les images : pas de
      // longue tâche) ; la mise à la taille après le dernier, quand il est lu (il a été produit à l'ancienne taille).
      const morceaux = file
      file = []
      poids = 0
      if (!morceaux.length) return ajuste()
      morceaux.forEach((d, i) => term.write(d, i === morceaux.length - 1 ? ajuste : undefined))
    }

    // La grille se mesure sur la vraie police : on attend qu'elle soit chargée (et le code du rendu WebGL, s'il est voulu :
    // le terminal s'ouvre dans son rendu, sa première grille est la bonne).
    Promise.all([document.fonts.load(`400 ${baseRef.current}px Iosevka`), document.fonts.load(`700 ${baseRef.current}px Iosevka`), glRef.current && chargeWebgl()])
      .catch(() => {})
      .then(() => {
        // Démontée entre-temps : React vide la référence avant le nettoyage, d'où « Terminal requires a parent element »
        // (vu au banc le 11/11 depuis que le plateau du téléphone ne monte plus de terminal derrière ses tuiles).
        if (dead || !host?.isConnected) return
        term.options.fontSize = baseRef.current * zsRef.current
        paint(term, lookRef.current)
        term.open(host)
        // `data-rendu` : le rendu en cours (« webgl » ou « dom »), lisible des essais. Un changement de rendu change la
        // taille des cellules (WebGL les arrondit au pixel) : la grille est refaite, sauf endormi (le réveil la refait).
        host.dataset.rendu = 'dom'
        // `eveille` lit la veille demandée (pas `dort`, posé plus tard par l'effet) : un terminal né endormi est classé
        // endormi dès son inscription. La grille refaite après un changement de rendu passe par la file (planifieAjuste) :
        // douze terminaux qui changent de rendu d'un coup ne gèlent pas une image.
        const rendu = glRef.current
          ? inscris(term, {
              actif: () => activeRef.current,
              eveille: () => !veilleRef.current,
              apres: (r) => {
                host.dataset.rendu = r
                if (st.current.term && !dort) planifieAjuste(ajusteFile.current, activeRef.current)
              },
            })
          : null
        fit.fit() // même endormi : la liaison s'ouvre à la taille de la dalle
        mark()
        st.current = { term, fit, mark, ajuste, endors, reveille, rendu }
        if (activeRef.current) term.focus()
        if (veilleRef.current) endors() // né endormi : la liaison s'ouvre quand même, son texte attend dans la file
        connect()
      })

    const host = hostRef.current
    // Au doigt (iPhone), glisser verticalement sur le terminal = la molette : tmux remonte dans la conversation (son mode
    // copie ; redescendu tout en bas, il en sort). Orkun, 11/11 : « En mode terminal (pas chat) sur l'iphone j'arrive pas a
    // remonter dans la conversation » — l'historique est tenu par tmux (scrollback 0), et rien ne faisait du doigt une molette.
    // Seulement si tmux écoute la souris : sinon xterm ferait de la molette des flèches ↑/↓ envoyées à l'agent.
    const PAS = 40 // px de glissement par cran de molette (tmux remonte de 5 lignes par cran)
    let doigt = null
    const posePouce = (e) => {
      const t = e.touches[0]
      doigt = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, reste: 0, vertical: null } : null
    }
    const glisse = (e) => {
      if (!doigt || e.touches.length !== 1) return
      const t = e.touches[0]
      const [dx, dy] = [t.clientX - doigt.x, t.clientY - doigt.y]
      if (doigt.vertical === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        doigt.vertical = Math.abs(dy) > Math.abs(dx)
      }
      if (!doigt.vertical || term.modes.mouseTrackingMode === 'none') return
      e.preventDefault()
      doigt.reste += dy
      doigt.x = t.clientX
      doigt.y = t.clientY
      const ecran = term.element?.querySelector('.xterm-screen')
      while (Math.abs(doigt.reste) >= PAS) {
        const remonte = doigt.reste > 0 // le doigt descend : on remonte dans ce qui a défilé
        ecran?.dispatchEvent(new WheelEvent('wheel', { deltaY: remonte ? -100 : 100, deltaMode: 0, clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }))
        doigt.reste += remonte ? -PAS : PAS
      }
    }
    const levePouce = () => (doigt = null)
    host?.addEventListener('touchstart', posePouce, { passive: true })
    host?.addEventListener('touchmove', glisse, { passive: false })
    host?.addEventListener('touchend', levePouce)
    return () => {
      dead = true
      st.current.rendu?.quitte() // avant `dispose` : le contexte WebGL est rendu, pas laissé au ramasse-miettes
      host?.removeEventListener('pointerdown', souris, true)
      host?.removeEventListener('pointerup', souris, true)
      host?.removeEventListener('touchstart', posePouce)
      host?.removeEventListener('touchmove', glisse)
      host?.removeEventListener('touchend', levePouce)
      document.removeEventListener('visibilitychange', revient)
      clearTimeout(timer)
      ws?.close()
      term.dispose()
      st.current = {}
      if (apiRef) apiRef.current = null
    }
  }, [id, apiRef])

  // Changement de zoom stabilisé ou de taille de la console : nouvelle police, grille recalculée, par la file
  // (planifieAjuste). Endormi : rien (le réveil refait la mise à la taille, voir `reveille`).
  useEffect(() => {
    const t = setTimeout(() => planifieAjuste(ajusteFile.current, activeRef.current), 90)
    return () => clearTimeout(t)
  }, [zs, width, height, base])
  useEffect(() => () => fileAjuste.delete(ajusteFile.current), [])

  // S'endormir / se réveiller (avant l'ouverture du terminal, rien à faire : l'ouverture lit `veilleRef`).
  // Rendu WebGL : on s'endort AVANT de rendre sa place (rien n'est envoyé à tmux), et on la redemande AVANT de se réveiller :
  // le changement de rendu ne refait pas la grille (encore endormi), `reveille` la refait après le texte reçu en dormant.
  useEffect(() => {
    const s = st.current
    if (!s.term) return
    if (veille) {
      s.endors()
      s.rendu?.maj()
    } else {
      s.rendu?.maj()
      s.reveille()
    }
  }, [veille])

  useEffect(() => {
    if (active) st.current.term?.focus()
    st.current.rendu?.maj() // l'actif passe devant pour le rendu WebGL
  }, [active])

  useEffect(() => {
    if (st.current.term) paint(st.current.term, look)
  }, [look])

  // ── Appui prolongé au doigt dans la fenêtre active : un petit menu Copier / Coller (Orkun, 10/11 : « Mets juste un
  // appuie prolongé dans une fenetre active ca dzclanche copy/past »). Rien à la souris : elle a déjà Ctrl+V et sa sélection.
  const [menu, setMenu] = useState(null) // { x, y, ligne, dit }
  // Les rangs visibles, tels quels. Une ligne trop longue est coupée par tmux en rangs pleins : un rang rempli jusqu'au
  // bord se poursuit au rang suivant (une adresse ou un jeton coupé en deux se recolle ainsi).
  const rangs = () => {
    const term = st.current.term
    if (!term) return []
    const buf = term.buffer.active
    return Array.from({ length: term.rows }, (_, i) => buf.getLine(buf.viewportY + i)?.translateToString(false) ?? '')
  }
  const plein = (rang) => {
    const cols = st.current.term?.cols || 0
    return cols > 0 && rang.length >= cols && rang[cols - 1] !== ' '
  }
  const ligneSous = (clientY) => {
    const ecran = hostRef.current?.querySelector('.xterm-screen')
    const rs = rangs()
    if (!ecran || !rs.length) return ''
    const r = ecran.getBoundingClientRect() // tient compte du zoom du plateau
    let i = Math.max(0, Math.min(rs.length - 1, Math.floor(((clientY - r.top) / r.height) * rs.length)))
    while (i > 0 && plein(rs[i - 1])) i--
    let texte = rs[i]
    while (plein(rs[i]) && i + 1 < rs.length) texte += rs[++i]
    return texte.trim()
  }
  const ecranEntier = () => {
    let texte = ''
    for (const rang of rangs()) texte += plein(rang) ? rang : `${rang.trimEnd()}\n`
    return texte.replace(/\n+$/, '')
  }
  useAppuiLong(hostRef, (p) => setMenu({ ...p, ligne: ligneSous(p.y) }), () => activeRef.current)

  // ── Pincement à deux doigts : taille du texte (Orkun, 10/11 : « difficile d'agrandire/reduire un terminal »).
  // La taille demandée suit l'écartement des doigts, entre 9 et 22 px ; le parent la retient et la rend par `base`.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const doigts = new Map()
    let ecart0 = 0
    let taille0 = 0
    const ecart = () => {
      const [a, b] = [...doigts.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const pose = (e) => {
      if (e.pointerType === 'mouse' || !tailleRef.current) return
      doigts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (doigts.size === 2) {
        ecart0 = ecart()
        taille0 = baseRef.current
      }
    }
    const bouge = (e) => {
      if (!doigts.has(e.pointerId)) return
      doigts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (doigts.size !== 2 || ecart0 < 20) return
      const taille = Math.max(TAILLE_MIN, Math.min(TAILLE_MAX, Math.round((taille0 * ecart()) / ecart0)))
      if (taille !== baseRef.current) tailleRef.current?.(taille)
    }
    const leve = (e) => {
      doigts.delete(e.pointerId)
      ecart0 = 0
    }
    const fins = ['pointerup', 'pointercancel', 'pointerleave']
    host.addEventListener('pointerdown', pose, true)
    host.addEventListener('pointermove', bouge, true)
    for (const f of fins) host.addEventListener(f, leve, true)
    return () => {
      host.removeEventListener('pointerdown', pose, true)
      host.removeEventListener('pointermove', bouge, true)
      for (const f of fins) host.removeEventListener(f, leve, true)
    }
  }, [])
  useEffect(() => {
    if (!bulle) return
    const t = setTimeout(() => setBulle(null), bulle.dit ? 1400 : 6000)
    return () => clearTimeout(t)
  }, [bulle])
  const ferme = (dit) => {
    setMenu((m) => m && { ...m, dit })
    setTimeout(() => setMenu(null), dit === 'Copié' ? 600 : 1600)
  }
  const copie = (texte) => navigator.clipboard.writeText(texte).then(() => ferme('Copié'), () => ferme('Refusé'))
  const colle = () =>
    navigator.clipboard.readText().then(
      (texte) => {
        const dit = depose((t) => st.current.term?.paste(t), texte) // déposé à l'invite, sans valider
        if (!onColle) return ferme(dit)
        onColle(dit) // annoncé hors du menu : il se ferme tout de suite, Entrée peut suivre sans attendre
        setMenu(null)
      },
      () => ferme('Refusé'),
    )

  return (
    <div className="term-box" style={{ width, height }}>
      {/* data-au-pixel : la toile WebGL est posée au plus proche pixel (styles.css), sauf aux bornes du zoom. */}
      <div className="term-scale" data-au-pixel={zs > 0.5 && zs < 3 ? '' : undefined} style={{ width: width * zs, height: height * zs, transform: `scale(${1 / zs})` }}>
        <div ref={hostRef} className={onTaille ? 'term-host pince' : 'term-host'} />
        {/* Liaison coupée : dit sur la dalle, à la taille de l'écran (dans .term-scale), avec ce qui attend (liaison.js). */}
        {liaison && (
          <p className="liaison-coupee nodrag nopan" role="status" data-attente={liaison.attente || undefined}>
            {liaison.texte}
            {liaison.retenue && (
              <button type="button" onPointerDown={garde} onClick={liaison.envoie}>
                Envoyer
              </button>
            )}
            {liaison.attente && (
              <button type="button" onPointerDown={garde} onClick={liaison.jette}>
                Jeter
              </button>
            )}
          </p>
        )}
      </div>
      {/* Au-dessus de la souris, hors du plateau (son zoom déformerait la position). Rien à fermer : elle s'efface seule.
          Copie refusée par le navigateur : la bulle devient un bouton qui la refait (un clic l'autorise toujours). */}
      {bulle &&
        createPortal(
          bulle.dit ? (
            <p className="copie-bulle" role="status" style={{ left: bulle.x, top: bulle.y }}>
              {bulle.dit}
            </p>
          ) : (
            <button
              type="button"
              className="copie-bulle est-bouton"
              style={{ left: bulle.x, top: bulle.y }}
              onPointerDown={garde}
              onClick={() => navigator.clipboard.writeText(bulle.texte).then(() => setBulle({ ...bulle, texte: '', dit: 'Copié' }), () => setBulle({ ...bulle, texte: '', dit: 'Copie refusée par le navigateur' }))}
            >
              Copier
            </button>
          ),
          document.body,
        )}
      {menu && (
        <MenuDoigt x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.dit ? (
            <b>{menu.dit}</b>
          ) : (
            <>
              <button type="button" disabled={!menu.ligne} onPointerDown={garde} onClick={() => copie(menu.ligne)}>
                Copier la ligne
              </button>
              <button type="button" onPointerDown={garde} onClick={() => copie(ecranEntier())}>
                Copier l’écran
              </button>
              <button type="button" onPointerDown={garde} onClick={colle}>
                Coller
              </button>
            </>
          )}
        </MenuDoigt>
      )}
    </div>
  )
}
