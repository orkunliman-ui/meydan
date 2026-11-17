// Garde des commandes Bash d'un membre d'équipe Claude : hook « PreToolUse » de Claude Code, branché par server.mjs.
// Rapport de chasse du 17/11, n°13 : les refus `permissions.deny` d'un membre (`Bash(pm2:*)`, `Bash(git push:*)`…) sont
// des PRÉFIXES ; `git -C x push`, `/usr/bin/sudo`, `env pm2`, `bash -c 'pm2 …'`, `npx pm2`, `node_modules/.bin/pm2`
// passaient. Cette garde relit la commande entière comme bash la découpe (mots, guillemets, séparateurs, substitutions,
// heredocs) et juge chaque programme EN POSITION DE COMMANDE, enveloppes comprises (env, timeout, xargs, sh -c, npx…).
//
// Ce que c'est, honnêtement : une garde de COMMODITÉ, pas une barrière. Le membre tourne sous le même utilisateur Unix
// qu'Orkun, son Bash n'a pas de bac à sable (`~/.pm2/rpc.sock` lui est inscriptible). Passent encore, entre autres : un
// script écrit puis lancé (le contenu d'un fichier n'est jamais lu), un texte décodé (base64…) envoyé à un shell, un nom
// construit par une variable (`p=pm; ${p}2 kill`), un interprète qui fabrique le nom, un enveloppeur absent des listes
// ci-dessous. Elle arrête l'agent qui oublie la règle 5 ou la contourne par réflexe, pas celui qui s'y acharne. La vraie
// barrière (le bac à sable de Claude Code, `sandbox` + bubblewrap, qui demande `socat`, absent de la machine) est une
// décision d'Orkun.
//
// Contrat du hook (lu dans le binaire installé, 2.1.326) : le JSON de l'appel sur l'entrée standard ; sortie 0 = la
// commande part, sortie 2 = refus (stderr montré au modèle), TOUTE autre sortie laisse partir la commande. La garde échoue
// donc FERMÉE : code 2 posé d'entrée, remis à 0 seulement sur un passage explicite ; entrée illisible, `command` absent,
// exception → refus.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MAX_COMMANDE = 64 * 1024 // caractères relus ; au-delà, refus
export const MAX_ENTREE = 1024 * 1024 // octets lus sur l'entrée standard ; au-delà, refus
const PROF_MAX = 32 // imbrications ($(…), `…`, sh -c, eval, enveloppes)
const BUDGET = 4_000_000 // pas de lecture et de jugement pour toute la commande : temps borné quoi qu'on lui donne
const NUL = '\u0000' // tient la place d'une expansion ($x, $(…)) dans la valeur d'un mot : ne ressemble à aucun nom

class Refus {
  constructor(raison) {
    this.raison = raison
  }
}
const refus = (raison) => new Refus(raison)
const FIN = Symbol('fin') // texte fini dans un guillemet, un $( ou un ${ : mal formé (bash le refuserait aussi)
const AMBIGU = Symbol('ambigu') // « (( » qui ne se ferme pas par « )) » : bash le relit comme deux parenthèses
const MALFORME = 'commande mal formée'
const TROP_IMBRIQUEE = 'commande trop imbriquée pour être relue'
const TROP_COMPLIQUEE = 'commande trop compliquée pour être relue'
const XARGS = 'programme lu sur l’entrée de xargs'

// ── Ce qui est refusé ──
const INTERDITS = new Map([
  ['pm2', 'pm2'], ['pm2-runtime', 'pm2'], ['pm2-dev', 'pm2'], ['pm2-docker', 'pm2'],
  ['sudo', 'sudo'], ['sudoedit', 'sudo'], ['su', 'su'], ['doas', 'doas'], ['pkexec', 'pkexec'], ['run0', 'run0'],
  ['systemctl', 'systemctl'], ['systemd-run', 'systemd-run'], ['service', 'service'],
  ['git-push', 'git push'], ['git-send-pack', 'git push'], ['git-http-push', 'git push'],
])
const GIT_ENVOI = new Set(['push', 'send-pack', 'http-push'])

// Dans un texte qui n'est pas relu comme du shell (code python ou node en ligne, programme awk, touches tmux, texte d'une
// substitution en tête de commande) : un nom interdit comme mot. `su` et `service`, mots courants dans du code, seulement
// en tête d'une chaîne, sous leur forme de commande (« 'service nginx restart' », « 'su -' », « ['service', … »).
const RE_NOM = /(?<![\w.-])(pm2(?:-runtime|-dev|-docker)?|sudo(?:edit)?|doas|pkexec|run0|systemctl|systemd-run|git-(?:push|send-pack|http-push))(?![\w-])/
const RE_COURT = /["'`]\s*(?:\/[^\s"'`]*\/)?(?:(service)\s+[\w@.-]+\s+(?:start|stop|restart|reload|status|force-reload|try-restart)\b|(su)\s+(?:-|root\b))|["'`](?:\/[^\s"'`]*\/)?(su|service)["'`]\s*,/
const RE_GIT = /(?<![\w.-])git(?![\w-])[^\n;|&]{0,80}?(?<![\w-])(?<!stash[\s'",]{1,9})(?:push|send-pack|http-push)(?![\w-])/
// Le fichier de pm2 lancé par node : …/node_modules/pm2/…, ou ${X}/pm2/… derrière une expansion, ou …/pm2/bin/…
const RE_PM2 = /(?:node_modules|\0)\/pm2\/|\/pm2\/(?:bin|lib\/binaries)\//
function dansLeTexte(t) {
  let m = RE_NOM.exec(t)
  if (m) return INTERDITS.get(m[1])
  m = RE_COURT.exec(t)
  if (m) return m[1] || m[2] || m[3]
  return RE_GIT.test(t) ? 'git push' : null
}
const code = (t) => {
  const r = dansLeTexte(String(t ?? ''))
  if (r) throw refus(r)
}
const subsSures = (w) => w.subs.forEach(code)

// ── Lecture : la commande découpée en mots et en commandes simples, comme bash ──
// Un mot : `v` sa valeur, guillemets ôtés (chaque expansion y vaut NUL) ; `cite` s'il a une partie citée ; `dyn` s'il
// contient une expansion ; `subs` le texte de ses substitutions de commande ; `joker` et `motif` (expression régulière de
// son dernier composant) s'il a un * ? […] non cité ; `acc` s'il porte une expansion d'accolades ({a,b}, {a..b}) ;
// `affect` si c'est une affectation (X=…).
// Une commande simple : ses mots (redirections ôtées), `entrees` les textes reçus sur l'entrée standard (heredoc, <<<),
// `prec` la commande d'avant quand un tube les relie, `motifCase` si ce n'est qu'un motif de `case` (des données).
const nouveauMot = () => ({ v: '', cite: false, dyn: false, subs: [], joker: false, motif: '', acc: false, affect: false })
const simple = (w) => !w.cite && !w.dyn
const base = (v) => v.slice(v.lastIndexOf('/') + 1)
const ESPECES = /[\\^$.*+?()[\]{}|]/
function lit(w, ch, cite) {
  w.v += ch
  if (ch === '/') w.motif = ''
  else w.motif += ESPECES.test(ch) ? '\\' + ch : ch
  if (cite) w.cite = true
}
function expansion(w, texte) {
  w.v += NUL
  w.motif += NUL
  w.dyn = true
  if (texte !== undefined) w.subs.push(texte)
}
const nouvelleCommande = (prec = null) => ({ mots: [], entrees: [], prec, motifCase: false, tete: true })
const OPERATEURS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>&', '>|', '>', '&>>', '&>']
const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

class Lecteur {
  constructor(s, e, cmds) {
    this.s = s
    this.i = 0
    this.e = e // { budget, prof } partagés par toute la relecture
    this.cmds = cmds
    this.attente = [] // heredocs annoncés, lus après la fin de la ligne
  }
  pas(n = 1) {
    if ((this.e.budget -= n) < 0) throw refus(TROP_COMPLIQUEE)
  }
  entre() {
    if (++this.e.prof > PROF_MAX) throw refus(TROP_IMBRIQUEE)
  }
  sort() {
    this.e.prof--
  }

  // Une suite de commandes, jusqu'à la fin du texte, ou jusqu'à la parenthèse qui ferme un $( ou un <( (fin = ')').
  liste(fin) {
    const s = this.s
    let seg = nouvelleCommande()
    let paren = 0 // sous-shells ( … ) ouverts
    let enCase = 0 // `case` ouverts : leur `)` ferme un motif
    // Un tube après `)` ou `}` part d'un groupe : sa dernière commande tient lieu de commande d'avant.
    const coupe = (tube) => {
      if (seg.mots.length) this.cmds.push(seg)
      seg = nouvelleCommande(tube ? (seg.mots.length ? seg : (this.cmds.at(-1) ?? null)) : null)
    }
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) {
        if (fin) throw FIN
        return coupe()
      }
      if (c === ' ' || c === '\t') this.i++
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2 // ligne continuée : un blanc
      else if (c === '\n') {
        this.i++
        coupe()
        this.heredocs()
      } else if (c === '#') {
        const j = s.indexOf('\n', this.i)
        this.i = j < 0 ? s.length : j
      } else if (c === ';') {
        this.i++
        while (s[this.i] === ';' || s[this.i] === '&') this.i++
        coupe()
      } else if (c === '&' && s[this.i + 1] !== '>') {
        this.i += s[this.i + 1] === '&' ? 2 : 1
        coupe()
      } else if (c === '|') {
        const ou = s[this.i + 1] === '|'
        this.i += ou || s[this.i + 1] === '&' ? 2 : 1
        coupe(!ou)
      } else if (c === '(') {
        const debut = this.i
        const p = this.e.prof
        let arith = s[this.i + 1] === '(' && seg.tete // (( … )), aussi après if, while, for : de l'arithmétique
        if (arith) {
          try {
            this.i += 2
            this.arith(nouveauMot())
          } catch (x) {
            if (x !== AMBIGU) throw x
            this.e.prof = p
            this.i = debut
            arith = false
          }
        }
        if (!arith) {
          this.i++
          paren++
          coupe()
        }
      } else if (c === ')') {
        this.i++
        if (paren > 0) {
          paren--
          coupe()
        } else if (enCase > 0) {
          seg.motifCase = true
          coupe()
        } else {
          coupe()
          if (fin) return
        }
      } else if ((c === '<' || c === '>' || c === '&') && s[this.i + 1] !== '(') this.redirection(seg)
      else {
        const debut = this.i
        const w = this.mot()
        if (this.i === debut) throw FIN
        if (!w.v && simple(w)) continue // rien (une ligne continuée seule) : pas un mot
        const d = s[this.i]
        if ((d === '<' || d === '>') && simple(w) && /^(\d+|\{[A-Za-z_]\w*\})$/.test(w.v)) continue // 2>…, {fd}>…
        if (simple(w) && (w.v === '{' || w.v === '}')) {
          coupe()
          continue
        }
        seg.mots.push(w)
        if (seg.tete) {
          if (simple(w) && w.v === 'case') enCase++
          else if (simple(w) && w.v === 'esac' && enCase > 0) enCase--
          seg.tete = simple(w) && MOTS_CLES.has(w.v)
        }
      }
    }
  }

  // Un mot, jusqu'au premier blanc ou opérateur non cité.
  mot() {
    const s = this.s
    const w = nouveauMot()
    let ouv = 0 // accolades ouvertes, et leur séparateur `,` ou `..` : {a,b} devient deux mots
    let sep = false
    let ext = null // dernier @ ! + * ? non cité : suivi d'une parenthèse, c'est un motif étendu
    if ((s[this.i] === '<' || s[this.i] === '>') && s[this.i + 1] === '(') {
      this.i += 2 // <( … ) : substitution de processus
      expansion(w, this.sous())
    }
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined || ' \t\n;&|)<>'.includes(c)) return w
      if (c === '(') {
        if (w.affect && w.v.endsWith('=')) this.tableau(w) // a=( … )
        else if (ext && ext.i === this.i) this.extglob(w, ext.avant) // @( … ) !( … ) +( … ) *( … ) ?( … )
        else return w
        continue
      }
      if (c === '\\') {
        const d = s[this.i + 1]
        this.i += d === undefined ? 1 : 2
        if (d === undefined) lit(w, '\\', true)
        else if (d !== '\n') lit(w, d, true)
        continue
      }
      if (c === "'") {
        const j = s.indexOf("'", this.i + 1)
        if (j < 0) throw FIN
        this.pas(j - this.i)
        for (let x = this.i + 1; x < j; x++) lit(w, s[x], true)
        w.cite = true
        this.i = j + 1
        continue
      }
      if (c === '"') {
        this.i++
        this.guillemets(w, '"')
        continue
      }
      if (c === '$' && this.dollar(w, false)) continue
      if (c === '`') {
        this.backtick(w)
        continue
      }
      const avant = w.motif.length
      this.i++
      if ('@!+*?'.includes(c)) ext = { i: this.i, avant }
      if (c === '[' && this.indice(w)) continue
      if (c === '=' && !w.affect && simple(w) && w.v.length < 256 && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?$/.test(w.v)) {
        lit(w, c, false)
        w.affect = true
      } else if (c === '*' || c === '?') {
        w.v += c
        w.motif += c === '*' ? '[^/]*' : '[^/]'
        w.joker = true
      } else if (!(c === '[' && this.crochet(w))) {
        if (c === '{') ouv++
        else if (ouv && (c === ',' || (c === '.' && s[this.i] === '.'))) sep = true
        else if (ouv && c === '}') {
          ouv--
          if (sep) w.acc = true
        }
        lit(w, c, false)
      }
    }
  }

  // […] non cité (this.i juste après le `[`) : classe d'un motif, si elle se ferme dans le mot.
  crochet(w) {
    const s = this.s
    // Le prochain `]` est gardé d'un appel à l'autre : 64 Ko de `[` sans `]` restent linéaires.
    if (!(this.ferme >= this.i)) {
      const k = s.indexOf(']', this.i)
      this.ferme = k < 0 ? Infinity : k
    }
    if (this.ferme - this.i > 64) return false
    // Classe POSIX ([:alpha:], [=a=], [.a.]) comprise : elle ne ferme pas le crochet.
    const m = /^[!^]?\]?(?:\[([:=.])[\w-]*\1\]|[^\]\s;&|()<>'"\\$`])*\]/.exec(s.slice(this.i, this.i + 96))
    if (!m) return false
    const classe = m[0].slice(0, -1)
    w.v += `[${classe}]`
    w.motif += /\[[:=.]/.test(classe) ? '[^/]' : `[${classe.replace(/^!/, '^').replace(/\\/g, '\\\\').replace(/^(\^?)\]/, '$1\\]')}]`
    w.joker = true
    this.i += m[0].length
    return true
  }

  // nom[ … ]= (this.i après le `[`) : indice d'une affectation, de l'arithmétique où 1<<2 n'est pas un heredoc. Faux (et
  // rien de lu) si ce n'est pas un indice suivi de = ou +=.
  indice(w) {
    if (!simple(w) || w.v.length > 255 || !/^[A-Za-z_]\w*$/.test(w.v)) return false
    const s = this.s
    const debut = this.i
    const p = this.e.prof
    const t = nouveauMot()
    let prof = 0
    try {
      this.entre()
      for (;;) {
        this.pas()
        const c = s[this.i]
        if (c === undefined || ' \t\n;&|'.includes(c)) throw AMBIGU
        if (c === '[') prof++
        if (c === ']' && prof-- === 0) break
        if (!this.interieur(t, true)) this.i++
      }
      if (s[this.i + 1] !== '=' && !(s[this.i + 1] === '+' && s[this.i + 2] === '=')) throw AMBIGU
    } catch (x) {
      if (x !== AMBIGU) throw x
      this.e.prof = p
      this.i = debut
      return false
    }
    this.sort()
    this.i++
    w.v += `[${NUL}]`
    w.motif += NUL
    w.subs.push(...t.subs)
    return true
  }

  // @( … ) et ses cousins (this.i sur la parenthèse) : un joker dans le mot ; son contenu est aussi lu comme des
  // commandes (sans extglob, bash lirait `!(pm2 ls)` autrement : la lecture la plus prudente).
  extglob(w, avant) {
    const s = this.s
    const t = nouveauMot()
    let prof = 0
    const debut = ++this.i
    this.entre()
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) throw FIN
      if (c === '(') prof++
      if (c === ')' && prof-- === 0) break
      if (!this.interieur(t, false)) this.i++
    }
    try {
      new Lecteur(s.slice(debut, this.i), this.e, this.cmds).liste(null)
    } catch (x) {
      if (x !== FIN) throw x
    }
    this.i++
    this.sort()
    w.v += `(${NUL})`
    w.motif = w.motif.slice(0, avant) + '[^/]*'
    w.joker = true
    w.subs.push(...t.subs)
  }

  // a=( … ) : des valeurs, pas une commande ; leurs substitutions sont lues (et jugées avec les autres commandes).
  tableau(w) {
    const s = this.s
    this.i++
    this.entre()
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined || ';&|<>('.includes(c)) throw FIN
      if (c === ' ' || c === '\t') this.i++
      else if (c === '\n') {
        this.i++
        this.heredocs() // bash lit ici le corps d'un heredoc annoncé plus haut sur la ligne
      } else if (c === ')') {
        this.i++
        break
      } else w.subs.push(...this.mot().subs)
    }
    this.sort()
    expansion(w)
  }

  // $( … ) ou <( … ) (this.i après la parenthèse) : liste lue à la suite ; rend son texte.
  sous() {
    const debut = this.i
    this.entre()
    this.liste(')')
    this.sort()
    return this.s.slice(debut, this.i - 1)
  }

  // Ce qui suit un `$` (this.i sur le `$`) ; faux si ce `$` n'est qu'un caractère.
  dollar(w, dq) {
    const s = this.s
    const d = s[this.i + 1]
    if (d === "'" && !dq) {
      this.i += 2
      for (const ch of this.ansi()) lit(w, ch, true)
      w.cite = true
    } else if (d === '"' && !dq) {
      this.i += 2
      this.guillemets(w, '"')
    } else if (d === '(' && s[this.i + 2] === '(') {
      const debut = this.i
      const p = this.e.prof
      const t = nouveauMot()
      try {
        this.i += 3
        this.arith(t)
        expansion(w)
        w.subs.push(...t.subs)
      } catch (x) {
        if (x !== AMBIGU) throw x
        this.e.prof = p // $((cd a && ls) | wc -l) : une substitution de commande, comme bash
        this.i = debut + 2
        expansion(w, this.sous())
      }
    } else if (d === '(') {
      this.i += 2
      expansion(w, this.sous())
    } else if (d === '[' || d === '{') {
      this.i += 2
      const t = nouveauMot()
      if (d === '[') this.crochets(t)
      else this.parametre(t, dq)
      expansion(w)
      w.subs.push(...t.subs)
    } else if (d !== undefined && /[A-Za-z_]/.test(d)) {
      this.i += 2
      while (this.i < s.length && /\w/.test(s[this.i])) this.i++
      expansion(w)
    } else if (d !== undefined && /[0-9@*#?$!-]/.test(d)) {
      this.i += 2
      expansion(w)
    } else return false
    return true
  }

  // $'…' (this.i après l'apostrophe) : échappements à la C ; rend le texte décodé.
  ansi() {
    const s = this.s
    let t = ''
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) throw FIN
      this.i++
      if (c === "'") return t
      if (c !== '\\') {
        t += c
        continue
      }
      const d = s[this.i++]
      let m
      if (d === undefined) throw FIN
      if (Object.hasOwn(ANSI, d)) t += ANSI[d]
      else if ((d === 'x' && (m = /^[0-9A-Fa-f]{1,2}/.exec(s.slice(this.i, this.i + 2)))) || (d === 'u' && (m = /^[0-9A-Fa-f]{1,4}/.exec(s.slice(this.i, this.i + 4)))) || (d === 'U' && (m = /^[0-9A-Fa-f]{1,8}/.exec(s.slice(this.i, this.i + 8))))) {
        t += String.fromCodePoint(Math.min(parseInt(m[0], 16), 0x10ffff))
        this.i += m[0].length
      } else if (/[0-7]/.test(d)) {
        m = /^[0-7]{0,2}/.exec(s.slice(this.i, this.i + 2))
        t += String.fromCharCode(parseInt(d + m[0], 8) & 0xff)
        this.i += m[0].length
      } else if (d === 'c' && s[this.i] !== undefined) t += String.fromCharCode(s.charCodeAt(this.i++) & 0x1f)
      else t += '\\' + d
    }
  }

  // "…" (fermant '"', this.i après le guillemet), ou corps d'un heredoc non cité (fermant null : jusqu'au bout).
  guillemets(w, fermant) {
    const s = this.s
    w.cite = true
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) {
        if (fermant) throw FIN
        return
      }
      if (c === fermant) {
        this.i++
        return
      }
      if (c === '\\') {
        const d = s[this.i + 1]
        if (d === '\n') this.i += 2
        else if (d === '$' || d === '`' || d === '\\' || (fermant && d === '"')) {
          this.i += 2
          lit(w, d, true)
        } else {
          this.i++
          lit(w, '\\', true)
        }
      } else if (c === '$' && this.dollar(w, true)) continue
      else if (c === '`') this.backtick(w, fermant === '"')
      else {
        this.i++
        lit(w, c, true)
      }
    }
  }

  // `…` (this.i sur l'accent grave) : le texte, échappements \` \$ \\ ôtés (et \" entre guillemets), relu comme une
  // liste de commandes.
  backtick(w, dq = false) {
    const s = this.s
    let j = this.i + 1
    let t = ''
    for (;;) {
      const c = s[j]
      if (c === undefined) throw FIN
      if (c === '`') break
      if (c === '\\' && s[j + 1] !== undefined && ('`$\\'.includes(s[j + 1]) || (dq && s[j + 1] === '"'))) {
        t += s[j + 1]
        j += 2
      } else {
        t += c
        j++
      }
    }
    this.pas(j - this.i)
    this.i = j + 1
    this.entre()
    new Lecteur(t, this.e, this.cmds).liste(null)
    this.sort()
    expansion(w, t)
  }

  // Dans $(( … )), $[ … ] et ${ … } : guillemets, échappements et expansions, lus pour leurs substitutions.
  interieur(t, dq) {
    const s = this.s
    const c = s[this.i]
    if (c === '\\') this.i += 2
    else if (c === "'" && !dq) {
      const j = s.indexOf("'", this.i + 1)
      if (j < 0) throw FIN
      this.i = j + 1
    } else if (c === '"') {
      this.i++
      this.guillemets(t, '"')
    } else if (c === '`') this.backtick(t)
    else return c === '$' && this.dollar(t, dq)
    return true
  }
  // (( … )) et $(( … )) (this.i après les deux parenthèses) : ni redirection ni heredoc dedans (1<<2 est un décalage).
  arith(t) {
    const s = this.s
    let prof = 0
    this.entre()
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) throw FIN
      if (c === '(') {
        prof++
        this.i++
      } else if (c === ')' && prof > 0) {
        prof--
        this.i++
      } else if (c === ')') {
        if (s[this.i + 1] !== ')') throw AMBIGU
        this.i += 2
        break
      } else if (!this.interieur(t, true)) this.i++ // l'apostrophe n'y est pas un guillemet : $(( '$(cmd)' )) lance cmd
    }
    this.sort()
  }
  // $[ … ] (this.i après le crochet).
  crochets(t) {
    const s = this.s
    let prof = 0
    this.entre()
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) throw FIN
      if (c === ']' && prof === 0) {
        this.i++
        break
      }
      if (c === '[' || c === ']') {
        prof += c === '[' ? 1 : -1
        this.i++
      } else if (!this.interieur(t, true)) this.i++
    }
    this.sort()
  }
  // ${ … } (this.i après l'accolade). Entre guillemets, une apostrophe y reste un caractère (lecture la plus prudente).
  parametre(t, dq) {
    const s = this.s
    this.entre()
    for (;;) {
      this.pas()
      const c = s[this.i]
      if (c === undefined) throw FIN
      if (c === '}') {
        this.i++
        break
      }
      if (!this.interieur(t, dq)) this.i++
    }
    this.sort()
  }

  // Redirection (this.i sur l'opérateur) : sa cible n'est pas un mot de la commande ; << annonce un heredoc, <<< donne
  // un texte sur l'entrée standard.
  redirection(seg) {
    const s = this.s
    const op = OPERATEURS.find((o) => s.startsWith(o, this.i))
    this.i += op.length
    while (s[this.i] === ' ' || s[this.i] === '\t') this.i++
    const c = s[this.i]
    if (c === undefined || '\n;&|()'.includes(c) || ((c === '<' || c === '>') && s[this.i + 1] !== '(')) throw FIN
    const debut = this.i
    const w = this.mot()
    if (op === '<<' || op === '<<-') {
      // Le délimiteur est pris à la lettre, guillemets ôtés, sans expansion (`<<$X` se ferme sur la ligne « $X »).
      const brut = s.slice(debut, this.i)
      const fin = brut.replace(/\$(["'])/g, '$1').replace(/\\([\s\S])/g, '$1').replace(/["']/g, '')
      this.attente.push({ seg, fin, tabs: op === '<<-', cite: /["'\\]/.test(brut) })
    } else if (op === '<<<') seg.entrees.push(w.v)
  }

  // Corps des heredocs annoncés sur la ligne (this.i au début de la ligne suivante). Un corps est un texte pour la
  // commande qui le reçoit, pas une commande ; s'il n'est pas cité, ses substitutions ($(…), `…`) sont lancées par bash :
  // elles sont lues et jugées.
  heredocs() {
    const s = this.s
    for (const h of this.attente.splice(0)) {
      const lignes = []
      while (this.i < s.length) {
        this.pas()
        let j = s.indexOf('\n', this.i)
        if (j < 0) j = s.length
        const l = h.tabs ? s.slice(this.i, j).replace(/^\t+/, '') : s.slice(this.i, j)
        this.i = Math.min(j + 1, s.length)
        if (l === h.fin) break
        lignes.push(l)
      }
      const corps = lignes.join('\n')
      h.seg.entrees.push(corps)
      if (!h.cite) {
        this.entre()
        new Lecteur(corps, this.e, this.cmds).guillemets(nouveauMot(), null)
        this.sort()
      }
    }
  }
}

// ── Jugement ──
const MOTS_CLES = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'coproc', 'function', 'esac', 'for', 'select', 'case'])
const DONNEES = new Set(['for', 'select', 'case']) // la suite n'est que des mots, pas une commande

// Un texte qu'un shell lancera (sh -c, eval, ssh, watch…) : lu puis jugé comme une commande. `valeur` (valeur de
// PAGER, git -c core.pager, -o ProxyCommand…) : mal formé, il passe (le programme qui le lancerait échouerait aussi) ;
// sinon un texte mal formé est refusé. Les commandes lues avant l'erreur sont jugées dans les deux cas.
function texte(t, e, o = {}, valeur = false) {
  const p0 = e.prof
  if (++e.prof > PROF_MAX) throw refus(TROP_IMBRIQUEE)
  const cmds = []
  let malforme = false
  try {
    new Lecteur(String(t), e, cmds).liste(null)
  } catch (x) {
    if (x !== FIN) throw x
    malforme = true
  }
  e.prof = p0 + 1
  for (const seg of cmds) if (!seg.motifCase) juge(seg.mots, 0, seg, e, o)
  e.prof = p0
  if (malforme && !valeur) throw refus(MALFORME)
}

// Des mots qu'un shell relira joints (eval, ssh, watch, sh -c…) ; le texte de leurs substitutions aussi (« eval
// "$(echo pm2 kill)" » lance ce que la substitution écrit).
function lance(ms, e, o = {}, valeur = false) {
  ms.forEach(subsSures)
  texte(ms.map((w) => w.v).join(' '), e, o, valeur)
}
// Un texte où bash fait ses substitutions sans le relire comme commande (arithmétique de `let`) : elles sont jugées.
function substitutions(t, e) {
  const cmds = []
  try {
    new Lecteur(t, e, cmds).guillemets(nouveauMot(), null)
  } catch (x) {
    if (x !== FIN) throw x
  }
  for (const seg of cmds) juge(seg.mots, 0, seg, e)
}

// Une commande simple, à partir du mot k. `o.xargs` : les arguments viendront de l'entrée de xargs ; `o.lu` : une
// chaîne (`{}` de xargs -I ou de find -exec) qui, en tête de commande, fait lancer un programme lu ailleurs ;
// `o.valeur` : la valeur d'une variable ou d'une option, où bash ne développe ni motif ni accolades.
function juge(mots, k, seg, e, o = {}) {
  if ((e.budget -= 1) < 0) throw refus(TROP_COMPLIQUEE)
  if (++e.prof > PROF_MAX) throw refus(TROP_IMBRIQUEE)
  try {
    while (k < mots.length && simple(mots[k]) && MOTS_CLES.has(mots[k].v)) {
      if (DONNEES.has(mots[k].v)) return
      k += mots[k].v === 'function' ? 2 : 1
    }
    while (k < mots.length && mots[k].affect) affectation(mots[k++], e)
    if (k >= mots.length) {
      if (o.xargs) throw refus(XARGS)
      return
    }
    const w = mots[k]
    tete(w, o)
    const nom = base(w.v)
    // Nom construit (`$X`, `$(…)`) : inconnu. Mais `${PREFIX:-/usr}/bin/pm2` a un dernier composant écrit en clair.
    if (nom.includes(NUL)) return inconnu(mots, k + 1, seg, e, o, true)
    const r = INTERDITS.get(nom)
    if (r) throw refus(r)
    const f = programme(nom)
    if (f && o.xargs && k + 1 >= mots.length) throw refus(XARGS) // `xargs git`, `xargs sh` : la suite vient de l'entrée
    f?.(mots, k + 1, seg, e, o)
  } finally {
    e.prof--
  }
}

// Le mot en tête de commande : une substitution qui écrit un nom interdit (`$(which pm2) ls`), des accolades
// (`{pm2,ls}`), un motif qui désigne un programme connu (`/usr/bin/su?o`), la chaîne remplacée par xargs ou find.
function tete(w, o) {
  subsSures(w)
  if (w.acc && !o.valeur) throw refus('accolades en tête de commande')
  if (w.joker && !o.valeur) {
    const re = motifRe(w)
    if (sensibles().some((n) => re.test(n))) throw refus('motif en tête de commande')
  }
  if (o.lu && w.v.includes(o.lu.chaine)) throw refus(o.lu.raison)
}
function motifRe(w) {
  try {
    return new RegExp(`^${w.motif}$`)
  } catch {
    return /(?:)/ // motif illisible : il désigne tout
  }
}
let SENSIBLES = null
const sensibles = () => (SENSIBLES ??= [...INTERDITS.keys(), ...Object.keys(PROGRAMMES), ...SHELLS, 'python', 'python3', 'node', 'nodejs', 'perl', 'ruby', 'php'])

// X=… : seules les variables qui portent une commande (GIT_SSH_COMMAND, PAGER, EDITOR, LESSOPEN, PS4…) voient leur
// valeur jugée comme une commande (un message ou un motif de grep qui cite pm2 passe) ; GIT_CONFIG_* ne déclare ni alias
// ni inclusion git (un alias peut cacher un push), et ses valeurs sont jugées.
const VAR_COMMANDE = /(^|_)(COMMAND|CMD|EDITOR|PAGER|SHELL|ASKPASS|PROGRAM|EXEC)$|^(VISUAL|LESSOPEN|LESSCLOSE|PS4|PROMPT_COMMAND|BASH_ENV|GIT_SSH|GIT_EXTERNAL_DIFF|BROWSER|GIT_CONFIG_VALUE_\d+)$/
function affectation(w, e) {
  const i = w.v.indexOf('=')
  const nom = w.v.slice(0, i).replace(/\+$/, '')
  const val = w.v.slice(i + 1)
  if (/^GIT_CONFIG/.test(nom) && /(^|[^\w.])(alias|include|includeif)\./i.test(val)) throw refus('git : alias déclaré par GIT_CONFIG')
  if (nom === 'GIT_CONFIG_PARAMETERS') code(val)
  if (VAR_COMMANDE.test(nom)) texte(val, e, { valeur: true }, true)
}

// Programme inconnu d'avance ($SHELL, "$NODE", un enveloppeur sans grammaire connue, une option qu'on ne sait pas lire) :
// chaque mot suivant est essayé comme tête de commande, et le mot après un `-c` ou un `-e` comme un texte de shell et
// comme du code. Une tête construite (`tete`) peut aussi être git (`${GIT:-git} push`) ou lire son entrée.
function inconnu(mots, j, seg, e, o, tete = false) {
  if (o.xargs && j >= mots.length) throw refus(XARGS)
  for (let x = j; x < mots.length; x++) juge(mots, x, seg, e, o)
  for (let x = j; x < mots.length - 1; x++) {
    if (!/^-[A-Za-z]*[ce][A-Za-z]*$/.test(mots[x].v)) continue
    code(mots[x + 1].v)
    lance([mots[x + 1]], e, { lu: o.lu }, true)
  }
  if (!tete) return
  if (mots.slice(j).some((w) => GIT_ENVOI.has(w.v))) throw refus('git push')
  executeEntree(seg, e, {}, false)
}

// Ce qu'une commande reçoit sur l'entrée standard, quand on le sait : heredoc, <<<, ou ce qu'écrit un echo, un printf
// ou un cat qui la précède dans un tube (« echo 'pm2 kill' | sh »).
const entreesDe = (seg) => [...seg.entrees, sortie(seg.prec, 0)].filter((t) => t != null)
// Échappements de printf et d'echo -e (\n, \t, \x70…) : `printf 'cd x\npm2 kill' | sh` lance deux lignes.
const decode = (t) => t.replace(/\\(x[0-9A-Fa-f]{1,2}|0?[0-7]{1,3}|.)/gs, (_, c) => (c[0] === 'x' ? String.fromCharCode(parseInt(c.slice(1), 16)) : /^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8) & 0xff) : (ANSI[c] ?? c)))
function sortie(seg, n) {
  if (!seg || n > 8) return null
  const m = seg.mots
  let k = 0
  while (k < m.length && m[k].affect) k++
  const p = m[k] && base(m[k].v)
  if (p === 'echo') {
    k++
    while (k < m.length && /^-[neE]+$/.test(m[k].v)) k++
    return decode(m.slice(k).map((w) => w.v).join(' '))
  }
  // printf : le format et chaque argument sur sa ligne, plus les arguments joints (« printf '%s %s' git push »).
  if (p === 'printf') return [...m.slice(k + 1).map((w) => decode(w.v)), m.slice(k + 2).map((w) => w.v).join(' ')].join('\n')
  if (p !== 'cat' && p !== 'tee') return null
  const t = [...seg.entrees, sortie(seg.prec, n + 1)].filter((x) => x != null)
  return t.length ? t.join('\n') : null
}
// Une commande qui EXÉCUTE ce qu'elle reçoit (shell sans -c, interprète, at, sed e…) : ses entrées connues sont jugées
// (comme du shell, ou comme du code) ; et quand ce qui la précède dans le tube est inconnu (head, tr…), aucun mot du
// tube ne doit nommer un programme interdit (`echo 'pm2 kill' | head -1 | sh`). Un texte encodé passe encore (limite).
function executeEntree(seg, e, o, shell) {
  for (const t of entreesDe(seg)) {
    if (shell) texte(t, e, o)
    else code(t)
  }
  for (let p = seg.prec, n = 0; p && n < 64; p = p.prec, n++) {
    for (const w of p.mots) {
      code(w.v)
      subsSures(w)
    }
  }
}

// ── Enveloppes : la commande qu'elles lancent est jugée ──
// Grammaire : options courtes avec argument (`a`), sans (`f`), à argument collé facultatif (`opt`) ; longues avec
// argument (`la`), sans (`lf`), à `=valeur` facultatif (`lopt`) ; `stop` : rien n'est lancé (command -v) ; `tiret` : `-`
// seul est une option (env -) ; `env` : des affectations suivent ; `saute` : mots avant la commande (la durée de
// timeout) ; `defaut` : sans commande, rien d'interdit (xargs lance echo) ; `val(nom, valeur, e, o, st)` reçoit les
// valeurs ; `suite(o, st)` le contexte de la commande enveloppée. Option inconnue : on ne devine pas si elle prend un
// argument, chaque mot suivant est essayé comme tête.
function enveloppe(g) {
  return (mots, j, seg, e, o) => {
    const st = {}
    for (; j < mots.length; j++) {
      const w = mots[j]
      const v = w.v
      if (w.dyn) return inconnu(mots, j, seg, e, o)
      if (v === '--') {
        j++
        break
      }
      if (v === '-' && g.tiret) continue
      if (v.startsWith('--')) {
        const x = v.indexOf('=')
        const n = v.slice(2, x < 0 ? undefined : x)
        if (g.la?.includes(n)) g.val?.(n, x < 0 ? (mots[++j]?.v ?? '') : v.slice(x + 1), e, o, st)
        else if (x >= 0 && g.lopt?.includes(n)) g.val?.(n, v.slice(x + 1), e, o, st)
        else if (!g.lf?.includes(n) && !g.lopt?.includes(n)) return inconnu(mots, j + 1, seg, e, o)
        continue
      }
      if (v.length < 2 || v[0] !== '-') break
      const r = court(v, g, mots, j, e, o, st)
      if (r === null) return inconnu(mots, j + 1, seg, e, o)
      if (r < 0) return
      j = r
    }
    if (g.env) while (j < mots.length && mots[j].affect) affectation(mots[j++], e)
    j += g.saute ?? 0
    if (g.defaut && j >= mots.length) return
    juge(mots, j, seg, e, g.suite ? g.suite(o, st) : o)
  }
}
// Un paquet d'options courtes (`-iu X`, `-n10`) : l'indice du dernier mot lu, -1 pour « rien n'est lancé », null pour
// une lettre inconnue.
function court(v, g, mots, j, e, o, st) {
  for (let x = 1; x < v.length; x++) {
    const ch = v[x]
    if (g.stop?.includes(ch)) return -1
    if (g.a?.includes(ch) || g.opt?.includes(ch)) {
      let val = v.slice(x + 1)
      if (!val && g.a?.includes(ch)) val = mots[++j]?.v ?? ''
      g.val?.(ch, val, e, o, st)
      return j
    }
    if (!g.f?.includes(ch)) return null
  }
  return j
}

const AIDE = ['help', 'version']
const XARGS_G = {
  a: 'IdELnPsa', opt: 'iel', f: '0rtpxo', defaut: true,
  la: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'],
  lopt: ['replace', 'eof', 'max-lines'],
  lf: ['null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty', 'show-limits', ...AIDE],
  val: (n, v, e, o, st) => {
    if (n === 'I') st.r = v
    else if (n === 'i' || n === 'replace') st.r = v || '{}'
  },
  suite: (o, st) => ({ ...o, xargs: true, lu: st.r ? { chaine: st.r, raison: XARGS } : o.lu }),
}

// flock [options] <fichier> <commande…>, ou flock [options] <fichier> -c <texte>.
function flock(mots, j, seg, e, o) {
  let fichier = false
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (v === '--command' || /^-[A-Za-z]*c$/.test(v)) return lance([mots[j + 1] ?? nouveauMot()], e, { lu: o.lu })
    if (v.startsWith('--command=')) return texte(v.slice(10), e, { lu: o.lu })
    if (v === '--') {
      j++
      break
    }
    if (v.length > 1 && v[0] === '-') {
      if (/^-[A-Za-z]*[wE]$/.test(v) || v === '--timeout' || v === '--conflict-exit-code') j++
    } else if (!fichier) fichier = true
    else break
  }
  juge(mots, j, seg, e, o)
}

// find … -exec|-execdir|-ok|-okdir <commande> ; (ou +). `-exec {} …` lance le fichier trouvé : refusé si find cherche
// un nom interdit (« find ~/.nvm -name pm2 -exec {} kill \; »).
function find(mots, j, seg, e, o) {
  const nomme = mots.slice(j).some((w) => INTERDITS.has(base(w.v.toLowerCase())) || dansLeTexte(w.v.toLowerCase())) // -iname PM2
  const oo = nomme ? { ...o, lu: { chaine: '{}', raison: 'programme trouvé par find' } } : o
  for (; j < mots.length; j++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(mots[j].v)) continue
    let fin = j + 1
    while (fin < mots.length && mots[fin].v !== ';' && mots[fin].v !== '+') fin++
    juge(mots.slice(j + 1, fin), 0, seg, e, oo)
    j = fin
  }
}

// ssh [options] <hôte> [commande…] : la commande, jointe, part dans le shell distant. Les options -o *Command
// (ProxyCommand, LocalCommand…) sont des commandes lancées.
const SSH_A = 'BbcDEeFIiJLlmOopQRSWw'
const SSH_F = '46AaCfGgKkMNnqsTtVvXxYy'
// ssh relit les options placées après l'hôte ; sans commande (ou avec un shell pour commande), le shell distant lit
// ses commandes sur l'entrée standard (`ssh h <<EOF`, `echo … | ssh h`).
function ssh(mots, j, seg, e) {
  let hote = false
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (v === '--') {
      j += hote ? 1 : 2
      break
    }
    if (v.length < 2 || v[0] !== '-') {
      if (hote) break
      hote = true
      continue
    }
    for (let x = 1; x < v.length; x++) {
      if (SSH_A.includes(v[x])) {
        const val = v.slice(x + 1) || (mots[++j]?.v ?? '')
        if (v[x] === 'o') optionSsh(val, e)
        break
      }
      if (!SSH_F.includes(v[x])) break
    }
  }
  if (j < mots.length) {
    lance(mots.slice(j), e)
    if (!SHELLS.has(base(mots[j].v))) return
  }
  executeEntree(seg, e, {}, true)
}
function optionSsh(val, e) {
  const m = /^\s*([A-Za-z]+)\s*(?:=|\s)\s*([\s\S]*)$/.exec(val)
  if (m && /command$/i.test(m[1])) texte(m[2], e, {}, true)
}
// scp, sftp, rsync : le programme qui ouvre la connexion (-e, --rsh, -S, --rsync-path, -o *Command) est une commande.
function copieDistante(mots, j, seg, e) {
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (/^--(rsh|rsync-path)=/.test(v)) texte(v.slice(v.indexOf('=') + 1), e, {}, true)
    else if (v === '--rsh' || v === '--rsync-path' || /^-[A-Za-z]*[eS]$/.test(v)) texte(mots[++j]?.v ?? '', e, {}, true)
    else if (/^-[A-Za-z]*o$/.test(v)) optionSsh(mots[++j]?.v ?? '', e)
    else if (/^-o./.test(v)) optionSsh(v.slice(2), e)
  }
}

// watch [options] <commande…> : jointe, passée à `sh -c`.
function watch(mots, j, seg, e) {
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (v === '--') {
      j++
      break
    }
    if (v.length < 2 || v[0] !== '-') break
    if (/^-[A-Za-z]*[nq]$/.test(v) || v === '--interval') j++
  }
  if (j < mots.length) lance(mots.slice(j), e)
}

// sh, bash… : `-c <texte>` est relu ; un fichier de script n'est pas lu (limite) ; sans l'un ni l'autre, le shell lit ses
// commandes sur l'entrée standard (heredoc, <<<, echo … |).
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'rbash', 'fish', 'csh', 'tcsh'])
const ENTREE_STD = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
function shell(mots, j, seg, e, o) {
  let c = false
  let s = false // -s : les commandes viennent de l'entrée, les mots suivants sont des arguments
  const oo = { lu: o.lu }
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (v === '--' || v === '-') {
      j++
      break
    }
    if (v.startsWith('--command=')) return texte(v.slice(10), e, oo)
    if (v === '--command') c = true
    else if (v === '--rcfile' || v === '--init-file') j++
    else if (v.length > 1 && (v[0] === '-' || v[0] === '+')) {
      if (v[0] === '-' && !v.startsWith('--')) {
        c ||= v.includes('c')
        s ||= v.includes('s')
      }
      if (/^[-+][A-Za-z]*[oO]$/.test(v)) j++
    } else break
  }
  if (c) {
    if (j >= mots.length) {
      if (o.xargs) throw refus(XARGS) // `xargs sh -c` : le texte vient de l'entrée
      return
    }
    lance([mots[j]], e, oo)
    // sh -c '"$@"' _ pm2 kill : les arguments suivants deviennent la commande (de même si le texte est construit)
    if (mots[j].dyn || /\$\{?[@*0-9]/.test(mots[j].v)) inconnu(mots, j + 1, seg, e, oo)
    return
  }
  // Un fichier de script n'est pas lu (limite) ; `bash <(echo …)` lance ce que la substitution écrit.
  if (j < mots.length && !s && !ENTREE_STD.has(mots[j].v)) return subsSures(mots[j])
  executeEntree(seg, e, oo, true) // sinon le shell lit ses commandes sur l'entrée standard
}

// Interprètes avec du code en ligne (`python -c`, `node -e`…) ou lu sur l'entrée standard : le code ne doit nommer aucun
// programme interdit. Le fichier lancé non plus : pm2 est un script node (`node …/node_modules/pm2/bin/pm2`).
// Par interprète : lettres du code en ligne, options longues du code, lettres et options longues qui prennent un argument.
// Tous les mots sont parcourus (une option à argument inconnue ne cache pas un `-e` plus loin) ; le premier mot hors
// option est le fichier lancé.
const INTERPRETES = [
  [/^(python[\d.]*|pypy3?)$/, 'c', [], 'WXQm', []],
  [/^(node|nodejs)$/, 'ep', ['eval', 'print'], 'r', ['require', 'import', 'loader', 'experimental-loader', 'input-type', 'conditions', 'title', 'env-file']],
  [/^perl[\d.]*$/, 'eE', [], '', []],
  [/^ruby[\d.]*$/, 'e', [], '', []],
  [/^php[\d.]*$/, 'rBRE', [], '', []],
  [/^(lua[\d.]*|luajit)$/, 'e', [], '', []],
  [/^Rscript$/, 'e', [], '', []],
]
function interprete(lettres, longues, arg = '', largs = []) {
  return (mots, j, seg, e) => {
    let codes = 0
    let script = null
    for (const w of mots.slice(j)) if (w.v.includes('/') && (INTERDITS.has(base(w.v)) || RE_PM2.test(w.v))) throw refus(INTERDITS.get(base(w.v)) ?? 'pm2')
    for (; j < mots.length; j++) {
      const v = mots[j].v
      if (v === '--') {
        script ??= mots[j + 1] ?? null
        break
      }
      if (v.startsWith('--')) {
        const x = v.indexOf('=')
        const n = v.slice(2, x < 0 ? undefined : x)
        if (longues.includes(n)) {
          code(x < 0 ? mots[++j]?.v : v.slice(x + 1))
          codes++
        } else if (x < 0 && largs.includes(n)) j++
        continue
      }
      if (v.length > 1 && v[0] === '-') {
        for (let x = 1; x < v.length; x++) {
          if (lettres.includes(v[x])) {
            // `-pe CODE` : la suite du paquet n'est faite que de lettres de code, le code est le mot suivant
            const reste = v.slice(x + 1)
            code([...reste].every((ch) => lettres.includes(ch)) ? mots[++j]?.v : reste)
            codes++
            break
          }
          if (arg.includes(v[x])) {
            if (x === v.length - 1) j++
            break
          }
        }
        continue
      }
      script ??= mots[j]
    }
    if (script) {
      subsSures(script)
      if (INTERDITS.has(base(script.v))) throw refus(INTERDITS.get(base(script.v)))
    }
    if (!codes && (!script || ENTREE_STD.has(script.v))) executeEntree(seg, e, {}, false)
  }
}

// awk : le programme lance des commandes par system(), « print | "cmd" », « "cmd" | getline » ; avec system($0), ce
// qu'il lit sur l'entrée aussi.
function awk(mots, j, seg, e) {
  let prog = null
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (v === '--') {
      j++
      break
    }
    if (v === '-f' || v.startsWith('--file')) return // programme dans un fichier : pas lu
    if (v === '-e' || v === '--source') prog = (prog ?? '') + (mots[++j]?.v ?? '')
    else if (/^-[Fv]$/.test(v) || v === '--assign' || v === '--field-separator') j++
    else if (v.length < 2 || v[0] !== '-') break
  }
  prog ??= mots[j]?.v ?? ''
  if (/system\s*\(|\|\s*["$]|\|&|getline/.test(prog)) {
    code(prog)
    executeEntree(seg, e, {}, false)
  }
}
// sed de GNU lance une commande par sa commande `e` ou le drapeau `e` de s/// (s ancré en tête de commande sed) ; un
// texte inséré (i, a, c) qui porte `exec` et un nom interdit vise un éditeur de rebase (GIT_SEQUENCE_EDITOR).
const SED_E = /(?:^|[;\n{}0-9$/!])\s*e(?:\s|;|$)|(?:^|[;\n{}0-9$/!]\s*)s([^\w\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImMw0-9]*e/
function sed(mots, j, seg, e) {
  for (const w of mots.slice(j)) {
    const execute = w.v.length > 4096 || SED_E.test(w.v)
    if (dansLeTexte(w.v) && (execute || /(?<![\w-])exec(?![\w-])/.test(w.v))) code(w.v)
    if (execute && !w.v.startsWith('-')) executeEntree(seg, e, {}, false)
  }
}

// tmux, screen : ce qu'ils lancent (new-session 'cmd', run-shell) ou tapent dans une autre console (send-keys, stuff) ;
// les touches tapées sont jointes (`'pm' '2 kill' Enter`) et relues comme une ligne de shell.
const TOUCHES = { Space: ' ', Enter: '\n', 'C-m': '\n', 'C-j': '\n', KPEnter: '\n', Tab: '\t' }
function touches(mots, j, seg, e) {
  for (const w of mots.slice(j)) {
    code(w.v)
    subsSures(w)
  }
  let x = mots.findIndex((w, n) => n >= j && /^(send-keys|send|stuff)$/.test(w.v))
  if (x < 0) return
  for (x++; x < mots.length && mots[x].v.startsWith('-'); x++) if (/^-[A-Za-z]*[tNc]$/.test(mots[x].v)) x++
  const t = mots.slice(x).map((w) => (Object.hasOwn(TOUCHES, w.v) ? TOUCHES[w.v] : w.v.replace(/\^M/g, '\n'))).join('')
  code(t)
  texte(t, e, { valeur: true }, true)
}

// npx, bunx, npm exec, pnpm dlx… : un paquet (`pm2@latest`, `github:x/pm2`) ou un programme de node_modules/.bin, puis
// ses arguments ; `-c` / `--call` / `--shell-mode` : un texte de shell.
const paquet = (v) => {
  const r = INTERDITS.get(base(String(v)).replace(/^[a-z+]+:/, '').replace(/(.)@.*$/, '$1'))
  if (r) throw refus(r)
}
const LANCEUR_F = ['-y', '--yes', '--no', '--no-install', '--ignore-existing', '-q', '--quiet', '--silent', '--prefer-offline', '--prefer-online', '--offline']
function lanceur(mots, j, seg, e, o) {
  let douteux = false
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (v === '--') {
      j++
      break
    }
    if (v === '--call' || v === '--shell-mode' || /^-[A-Za-z]*c$/.test(v)) return lance(mots.slice(j + 1), e)
    if (v.startsWith('--call=')) return texte(v.slice(7), e)
    if (v === '-p' || v === '--package') paquet(mots[++j]?.v ?? '')
    else if (v.startsWith('--package=')) paquet(v.slice(10))
    else if (v.length > 1 && v[0] === '-') douteux ||= !v.includes('=') && !LANCEUR_F.includes(v)
    else break
  }
  if (douteux) mots.slice(j).forEach((w) => paquet(w.v))
  if (j >= mots.length) {
    if (o.xargs) throw refus(XARGS)
    return
  }
  paquet(mots[j].v)
  juge(mots, j, seg, e, o)
}
// npm, pnpm, yarn, bun : `exec`, `x`, `dlx` lancent un paquet comme npx ; pnpm, yarn et bun lancent aussi un programme
// de node_modules/.bin donné comme sous-commande (`pnpm pm2 ls`, `yarn run pm2`) ; `npm explore <paquet> -- <commande>`.
const LANCE = { npm: ['exec', 'x'], pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'], bun: ['x'] }
function gestionnaire(nom) {
  return (mots, j, seg, e, o) => {
    if (nom === 'bun') interprete('ep', ['eval', 'print'])(mots, j, seg)
    let douteux = false
    for (; j < mots.length; j++) {
      const v = mots[j].v
      if (/^-[CFw]$/.test(v) || ['--prefix', '--dir', '--cwd', '--filter', '--workspace'].includes(v)) j++
      else if (v.startsWith('--') && !v.includes('=')) douteux = true
      else if (v.length < 2 || v[0] !== '-') break
    }
    if (j >= mots.length && o.xargs) throw refus(XARGS)
    // Option longue inconnue avant la sous-commande : elle a peut-être avalé un mot, on essaie les suivants.
    for (let x = j; x < mots.length && (douteux || x === j); x++) {
      const sous = mots[x].v
      if (LANCE[nom].includes(sous)) return lanceur(mots, x + 1, seg, e, o)
      if (nom === 'npm' && sous === 'explore') {
        const t = mots.findIndex((w, n) => n > x && w.v === '--')
        return t > 0 ? lance(mots.slice(t + 1), e) : undefined
      }
      if (sous === 'run' || sous === 'run-script') {
        const w = mots.slice(x + 1).find((m) => !m.v.startsWith('-'))
        return w ? paquet(w.v) : undefined
      }
      if (nom !== 'npm') paquet(sous)
    }
  }
}

// git : options globales (`-C x`, `-c k=v`, `--git-dir=…`…), puis la sous-commande. Refusés : push, send-pack,
// http-push (et `subtree push`, `lfs push`) ; tout alias ou inclusion déclaré par `-c`, `--config-env` ou `git config`
// (un alias peut cacher un push). Les valeurs de `-c` et les options qui lancent une commande (rebase --exec, clone -u,
// fetch --upload-pack, filter-branch --tree-filter…, submodule foreach, bisect run) sont jugées comme des commandes.
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source', '--list-cmds'])
const GIT_CMD = /^--(exec|upload-pack|receive-pack|extcmd|[a-z-]+-filter)$/
// Clés de configuration dont la valeur est une commande lancée par git (core.sshCommand, core.pager, core.fsmonitor…).
const CLE_COMMANDE = /(^|\.)(sshcommand|pager|editor|fsmonitor|askpass|program|cmd|command|textconv|clean|smudge|process|driver|helper|external|receivepack|uploadpack|gitproxy|packobjectshook)$|^pager\./
// Clés refusées : alias et inclusions (un alias peut cacher un push), correction automatique (`psuh` lancerait push),
// protocoles autorisés (ext:: lance une commande).
function gitCle(cle) {
  if (/^(alias|include|includeif)\./.test(cle) || /[\0*?[]/.test(cle)) throw refus('git -c alias')
  if (cle === 'help.autocorrect' || /^protocol\.([^.]+\.)?allow$/.test(cle)) throw refus(`git ${cle}`)
}
function gitOption(n, val, e) {
  if (n !== '-c' && n !== '--config-env' && n !== '--config') return
  const x = val.indexOf('=')
  const cle = (x < 0 ? val : val.slice(0, x)).toLowerCase()
  gitCle(cle)
  if (n !== '--config-env' && x >= 0 && CLE_COMMANDE.test(cle)) texte(val.slice(x + 1), e, { valeur: true }, true)
}
// git config : une écriture de clé (pas une lecture : --get, --list, --unset…) passe par les mêmes contrôles que -c.
const GIT_CONFIG_LECTURE = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--unset|--unset-all|--remove-section|--rename-section|--edit|-e)$/
function gitConfig(reste, e) {
  const args = []
  for (let x = 0; x < reste.length; x++) {
    const v = reste[x].v
    if (GIT_CONFIG_LECTURE.test(v)) return
    if (/^(-f|--file|--blob|--type|--default|--comment|--value)$/.test(v)) x++
    else if (!v.startsWith('-')) args.push(v)
  }
  if (['get', 'list', 'unset', 'remove-section', 'rename-section', 'edit'].includes(args[0])) return
  const [cle, val] = args[0] === 'set' ? args.slice(1) : args
  if (cle === undefined) return
  gitCle(cle.toLowerCase())
  if (val !== undefined && CLE_COMMANDE.test(cle.toLowerCase())) texte(val, e, { valeur: true }, true)
}
function git(mots, j, seg, e, o) {
  for (; j < mots.length; j++) {
    const v = mots[j].v
    if (GIT_OPT_ARG.has(v)) gitOption(v, mots[++j]?.v ?? '', e)
    else if (v.startsWith('--') && v.includes('=')) gitOption(v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1), e)
    else if (v.startsWith('-c')) gitOption('-c', v.slice(2), e)
    else if (v.length < 2 || v[0] !== '-') break
  }
  const w = mots[j]
  if (!w) {
    if (o.xargs) throw refus(XARGS)
    return
  }
  for (const t of w.subs) if (/(?<![\w-])(push|send-pack|http-push)(?![\w-])/.test(t)) throw refus('git push')
  if (w.acc) throw refus('accolades en tête de commande')
  if (w.joker && [...GIT_ENVOI].some((n) => motifRe(w).test(n))) throw refus('git push')
  const sous = w.v
  if (GIT_ENVOI.has(sous)) throw refus('git push')
  const reste = mots.slice(j + 1)
  if ((sous === 'subtree' || sous === 'lfs') && reste.some((m) => m.v === 'push')) throw refus('git push')
  if (sous === 'config') gitConfig(reste, e)
  if (sous === 'submodule') {
    const f = reste.findIndex((m) => m.v === 'foreach')
    if (f >= 0) lance(reste.slice(f + 1).filter((m) => !/^(--recursive|-q|--quiet)$/.test(m.v)), e)
  }
  if (sous === 'bisect') {
    const r = reste.findIndex((m) => m.v === 'run')
    if (r >= 0) juge(reste, r + 1, seg, e, o)
  }
  for (let x = 0; x < reste.length; x++) {
    const v = reste[x].v
    const m = /^(--[a-z-]+)=([\s\S]*)$/.exec(v)
    if (m && GIT_CMD.test(m[1])) texte(m[2], e, {}, true)
    else if (GIT_CMD.test(v) || (v === '-x' && (sous === 'rebase' || sous === 'difftool')) || (v === '-u' && sous === 'clone')) texte(reste[++x]?.v ?? '', e, {}, true)
    else if (sous === 'clone' && (v === '-c' || v === '--config')) gitOption('-c', reste[++x]?.v ?? '', e)
    else if (sous === 'clone' && v.startsWith('--config=')) gitOption('-c', v.slice(9), e)
  }
}

// source / . : le fichier n'est pas lu (limite), sauf l'entrée standard (`source /dev/stdin <<< …`) et ce qu'écrit une
// substitution (`source <(echo …)`).
function source(w, seg, e) {
  if (!w) return
  subsSures(w)
  if (ENTREE_STD.has(w.v)) executeEntree(seg, e, {}, true)
}

// Enveloppeurs dont on ne lit pas la grammaire : chaque mot suivant est essayé comme tête (inconnu).
const LIBRES = ['strace', 'ltrace', 'taskset', 'ionice', 'chrt', 'unbuffer', 'chronic', 'numactl', 'cgexec', 'firejail', 'unshare', 'nsenter', 'chroot', 'systemd-inhibit', 'faketime', 'proxychains', 'proxychains4', 'torsocks', 'valgrind', 'xvfb-run', 'dbus-run-session', 'ssh-agent', 'sshpass', 'catchsegv', 'setpriv', 'prlimit', 'runuser', 'daemonize', 'dtach', 'eatmydata', 'fakeroot', 'corepack', 'sg', 'gdb', 'nocache', 'cpulimit']
const affectations = (mots, j, seg, e) => mots.slice(j).forEach((w) => w.affect && affectation(w, e))
const PROGRAMMES = {
  ...Object.fromEntries(LIBRES.map((n) => [n, inconnu])),
  env: enveloppe({ a: 'uCS', f: 'i0v', tiret: true, env: true, la: ['unset', 'chdir', 'split-string'], lf: ['ignore-environment', 'null', 'debug', 'list-signal-handling', ...AIDE], lopt: ['block-signal', 'default-signal', 'ignore-signal'], val: (n, v, e, o) => (n === 'S' || n === 'split-string') && texte(v, e, { lu: o.lu }) }),
  nice: enveloppe({ a: 'n', f: '0123456789', la: ['adjustment'], lf: AIDE }),
  nohup: enveloppe({ lf: AIDE }),
  timeout: enveloppe({ a: 'sk', f: 'v', la: ['signal', 'kill-after'], lf: ['preserve-status', 'foreground', 'verbose', ...AIDE], saute: 1 }),
  stdbuf: enveloppe({ a: 'ioe', la: ['input', 'output', 'error'], lf: AIDE }),
  setsid: enveloppe({ f: 'cfw', lf: ['ctty', 'fork', 'wait', ...AIDE] }),
  exec: enveloppe({ a: 'a', f: 'cl' }),
  command: enveloppe({ f: 'p', stop: 'vV' }),
  builtin: enveloppe({}),
  time: enveloppe({ a: 'fo', f: 'pavq', la: ['format', 'output'], lf: ['portability', 'append', 'verbose', 'quiet', ...AIDE] }),
  xargs: enveloppe(XARGS_G),
  busybox: (mots, j, seg, e, o) => juge(mots, j, seg, e, o),
  flock, find, ssh, watch, git, awk, sed,
  scp: copieDistante, sftp: copieDistante, rsync: copieDistante,
  npx: lanceur, bunx: lanceur, npm: gestionnaire('npm'), pnpm: gestionnaire('pnpm'), yarn: gestionnaire('yarn'), bun: gestionnaire('bun'),
  gawk: awk, mawk: awk, nawk: awk, tmux: touches, screen: touches,
  eval: (mots, j, seg, e, o) => lance(mots.slice(j), e, { lu: o.lu }),
  trap: (mots, j, seg, e) => {
    while (j < mots.length && /^(-[lp]*|--)$/.test(mots[j].v)) j++
    if (j < mots.length) lance([mots[j]], e)
  },
  alias: (mots, j, seg, e) => mots.slice(j).forEach((w) => w.v.includes('=') && texte(w.v.slice(w.v.indexOf('=') + 1), e, {}, true)),
  export: affectations, declare: affectations, typeset: affectations, local: affectations, readonly: affectations,
  source: (mots, j, seg, e) => source(mots[j], seg, e), '.': (mots, j, seg, e) => source(mots[j], seg, e),
  script: (mots, j, seg, e) => {
    for (; j < mots.length; j++) {
      const v = mots[j].v
      if (v.startsWith('--command=')) return texte(v.slice(10), e)
      if (v === '--command' || /^-[A-Za-z]*c$/.test(v)) return lance([mots[j + 1] ?? nouveauMot()], e)
    }
  },
  at: (mots, j, seg, e) => executeEntree(seg, e, {}, true),
  batch: (mots, j, seg, e) => executeEntree(seg, e, {}, true),
  crontab: (mots, j, seg, e) => executeEntree(seg, e, {}, false), // `echo '* * * * * pm2 kill' | crontab -`
  hash: (mots, j) => {
    for (let x = j; x < mots.length - 1; x++) if (/^-[A-Za-z]*p$/.test(mots[x].v)) paquet(mots[x + 1].v) // hash -p /usr/bin/sudo s
  },
  let: (mots, j, seg, e) => mots.slice(j).forEach((w) => substitutions(w.v, e)), // let 'a[$(cmd)]=1'
  tar: (mots, j, seg, e) => {
    for (let x = j; x < mots.length; x++) {
      const v = mots[x].v
      const m = /^--(?:checkpoint-action=exec|to-command|use-compress-program|rsh-command|info-script|new-volume-script)=([\s\S]*)$/.exec(v)
      if (m) texte(m[1], e, { valeur: true }, true)
      else if (/^(-[A-Za-z]*[IF]|--to-command|--use-compress-program|--rsh-command|--info-script|--new-volume-script)$/.test(v)) texte(mots[++x]?.v ?? '', e, { valeur: true }, true)
    }
  },
  'cross-env': enveloppe({ env: true }),
  'cross-env-shell': (mots, j, seg, e) => lance(mots.slice(j).filter((w) => !w.affect), e),
  concurrently: (mots, j, seg, e) => mots.slice(j).forEach((w) => w.v.startsWith('-') || lance([w], e, {}, true)),
  nodemon: (mots, j, seg, e) => {
    for (let x = j; x < mots.length - 1; x++) if (mots[x].v === '-x' || mots[x].v === '--exec') lance([mots[x + 1]], e, {}, true)
  },
  dotenv: inconnu,
}
// vim et ses cousins : `-c '!cmd'`, `+'!cmd'`, `--cmd …` lancent une commande du shell.
for (const n of ['vim', 'vi', 'nvim', 'ex', 'view', 'vimdiff']) {
  PROGRAMMES[n] = (mots, j) => {
    for (let x = j; x < mots.length; x++) {
      const v = mots[x].v
      const c = v === '-c' || v === '--cmd' ? mots[++x]?.v : v.startsWith('+') ? v.slice(1) : null
      if (c != null && /^\s*!|system\s*\(|:!/.test(c)) code(c)
    }
  }
}
function programme(nom) {
  if (Object.hasOwn(PROGRAMMES, nom)) return PROGRAMMES[nom]
  if (SHELLS.has(nom)) return shell
  const i = INTERPRETES.find(([re]) => re.test(nom))
  return i ? interprete(i[1], i[2], i[3], i[4]) : null
}

// La commande passe : null ; sinon la raison du refus, courte. Pure, sans entrée ni sortie, temps borné.
export function analyse(commande) {
  try {
    if (typeof commande !== 'string') return 'commande illisible'
    if (commande.length > MAX_COMMANDE) return 'commande trop longue pour être relue'
    texte(commande, { budget: BUDGET, prof: 0 })
    return null
  } catch (x) {
    return x instanceof Refus ? x.raison : 'erreur interne de la garde' // y compris une pile débordée : refus
  }
}

// ── Le hook ──
export const message = (raison) =>
  `Meydan refuse cette commande à un membre d'équipe (${raison}). Règle 5 de ton brief : jamais de git push, de déploiement, de pm2, de sudo. Si ta tâche l'exige, déclare \`needs-decision\` et arrête-toi.`

function principal() {
  // Échoue FERMÉE : toute sortie autre que 0 ou 2 laisserait passer la commande. Le code 2 est posé d'entrée et ne
  // redevient 0 que sur un passage explicite ; une exception non rattrapée sort aussi en 2 (Node sortirait en 1).
  process.exitCode = 2
  const refuse = (raison) => {
    process.exitCode = 2
    process.stderr.write(message(raison) + '\n')
  }
  process.on('uncaughtException', () => {
    try {
      process.stderr.write(message('erreur interne de la garde') + '\n')
    } finally {
      process.exit(2)
    }
  })
  const morceaux = []
  let taille = 0
  // Au-delà de MAX_ENTREE, l'entrée est lue jusqu'au bout mais oubliée (s'arrêter en route donnerait EPIPE à Claude).
  process.stdin.on('data', (b) => {
    taille += b.length
    if (taille <= MAX_ENTREE) morceaux.push(b)
    else morceaux.length = 0
  })
  process.stdin.on('error', () => refuse('entrée illisible'))
  process.stdin.on('end', () => {
    if (taille > MAX_ENTREE) return refuse('entrée trop longue pour être relue')
    let appel
    try {
      appel = JSON.parse(Buffer.concat(morceaux).toString('utf8'))
    } catch {
      return refuse('entrée illisible')
    }
    if (!appel || typeof appel.tool_name !== 'string') return refuse('entrée illisible')
    if (appel.tool_name !== 'Bash') {
      process.exitCode = 0
      return
    }
    const commande = appel.tool_input?.command
    if (typeof commande !== 'string') return refuse('commande absente')
    const raison = analyse(commande)
    if (raison) return refuse(raison)
    process.exitCode = 0
  })
}

// Lancé comme programme (`node lib/garde-bash.mjs`), y compris par un lien : Node donne à import.meta.url le chemin réel.
let estLeProgramme = false
try {
  estLeProgramme = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch {}
if (estLeProgramme) principal()
