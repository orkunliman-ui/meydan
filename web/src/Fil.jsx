import { createContext, memo, useContext, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, cls, filBus } from './lib.js'
import { Ecouter } from './Voix.jsx'
// Ateliers (volet du 13/11) : « Ouvrir » un document ou un texte cité, au lieu de le télécharger.
import { OuvrirFichier, ouvrable } from './ateliers/OuvrirFichier.jsx'

// La conversation d'un agent montrée comme une discussion (téléphone) : ses messages, les tiens, ses outils repliés en
// une ligne. Orkun, 10/11 : « Quand jss en portrait dans un terminal, j'aimerais un affichage equivalent a ce que j'ai
// la sur l'app native de claude ». Le serveur lit le journal que l'agent écrit lui-même ; le terminal reste à un appui.

// Dans une ligne : `code`, **gras**, *italique*, [lien](https://…) et adresses nues. Les liens ne sont faits que pour
// http(s) (jamais un autre schéma). Pas de « lookbehind » dans l'expression : d'anciens Safari ne la liraient pas.
const EN_LIGNE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?»'"])|(^|[\s(«"'’])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?=$|[\s.,;:!?)»"'’])/g
const lien = (href, texte, cle) => (
  <a key={cle} href={href} target="_blank" rel="noopener noreferrer">
    {texte}
  </a>
)
// Un chemin du VPS vers un fichier à récupérer (un document, une image, une archive…), cité en `code` par l'agent.
const FICHIER = /^\/[^\s`]+\.(pdf|png|jpe?g|gif|webp|svg|csv|tsv|xlsx?|docx?|pptx?|odt|ods|zip|tar|gz|tgz|7z|txt|md|json|html?|mp3|m4a|wav|mp4|mov|webm|ics|vcf|eml)$/i
function enLigne(s) {
  const out = []
  let fin = 0
  for (const m of s.matchAll(EN_LIGNE)) {
    if (m.index > fin) out.push(s.slice(fin, m.index))
    const k = out.length
    if (m[1] && FICHIER.test(m[1].slice(1, -1))) out.push(<Fichier key={k} chemin={m[1].slice(1, -1)} code />)
    // Ateliers (13/11) : un chemin de source cité (js, py, sh…) reste du code dans la phrase, suivi d'un petit « Ouvrir ».
    else if (m[1] && ouvrable(m[1].slice(1, -1)))
      out.push(
        <span key={k} className="at-code-ouvrir">
          <code>{m[1].slice(1, -1)}</code>
          <OuvrirFichier chemin={m[1].slice(1, -1)} />
        </span>,
      )
    else if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<b key={k}>{enLigne(m[2].slice(2, -2))}</b>) // un lien en gras reste un lien (Codex : **[Télécharger…](/home/…pdf)**)
    else if (m[4]?.startsWith('/')) out.push(<Fichier key={k} chemin={m[4]} texte={m[3]} />)
    else if (m[4]) out.push(lien(m[4], m[3], k))
    else if (m[5]) out.push(lien(m[5], m[5], k))
    else out.push(m[6], <em key={k}>{m[7]}</em>)
    fin = m.index + m[0].length
  }
  if (fin < s.length) out.push(s.slice(fin))
  return out
}
const PUCE = /^(\s*)(?:[-*•]|(\d+)[.)])\s+/ // retrait, numéro (rien pour une puce)
// Une liste et ses sous-listes (17/11, chasse, défaut 8) : « 1. premier / "   - imbriqué un" / 2. second » sortait en
// puces plates, numéros perdus (une liste qui mêlait numéros et puces partait en <ul>, sans retrait). Chaque ligne est
// lue avec son retrait : plus en retrait que l'élément du dessus, elle va dans une sous-liste DANS cet élément. Une liste
// est numérotée, à partir de son premier numéro, quand son premier élément l'est ; au même retrait, passer des numéros
// aux puces (ou l'inverse) ouvre une liste voisine, comme en Markdown (« 1. un / - puce / 2. deux » : le « 2. » reste 2).
function liste(ls, cle) {
  const els = ls.map((l) => {
    const m = l.match(PUCE)
    return { retrait: m[1].replace(/\t/g, '    ').length, num: m[2], t: l.slice(m[0].length) }
  })
  let i = 0
  const niveau = (base, key) => {
    const premier = els[i]
    const numerotee = premier.num !== undefined
    const lis = []
    while (i < els.length && els[i].retrait >= base && (els[i].num !== undefined) === numerotee) {
      const x = els[i++]
      const sous = []
      while (i < els.length && els[i].retrait > x.retrait) sous.push(niveau(els[i].retrait, sous.length))
      lis.push(
        <li key={lis.length}>
          {enLigne(x.t)}
          {sous}
        </li>,
      )
    }
    return numerotee ? <ol key={key} start={Number(premier.num)}>{lis}</ol> : <ul key={key}>{lis}</ul>
  }
  const base = Math.min(...els.map((x) => x.retrait))
  const listes = []
  while (i < els.length) listes.push(niveau(base, `${cle}-${listes.length}`))
  return listes
}
const cellules = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

// Un fichier que l'agent a produit sur le VPS et qu'il cite (Orkun, 11/11 : « fait en sorte que je puisse le telecharger
// comme quand je suis en remote via l'application natif de Codex »). Le bouton récupère le fichier lui-même (avec la
// session) : un lien ouvert hors de Meydan (appli de l'écran d'accueil → Safari) tombait sur la page de connexion.
// Téléphone : la feuille de partage d'iOS (Enregistrer dans Fichiers, AirDrop, Mail…). Ordinateur : un PDF ou une image
// s'ouvre dans un onglet, le reste se télécharge. Le serveur ne donne qu'un fichier cité dans la conversation de CETTE
// console (route /fichier de server.mjs).
const ConsoleId = createContext(null)
function Fichier({ chemin, texte, code = false }) {
  const id = useContext(ConsoleId)
  const [etat, setEtat] = useState('') // '' | 'charge' | 'pret' (fichier en main, un toucher pour le partager) | message d'erreur
  const pret = useRef(null)
  const nom = chemin.split('/').pop()
  const partage = (f) => navigator.share({ files: [f], title: nom })
  const clic = async () => {
    if (!id || etat === 'charge') return
    if (pret.current) {
      // Second toucher : le fichier est déjà là, le partage part tout de suite (iOS exige un geste tout frais).
      return partage(pret.current).then(() => setEtat(''), () => {})
    }
    setEtat('charge')
    // Ordinateur, PDF ou image : l'onglet s'ouvre AU CLIC (ouvert après le chargement, l'anti-popup le bloquerait), le
    // fichier y arrive ensuite.
    const tactile = matchMedia('(pointer: coarse)').matches
    const onglet = !tactile && /\.(pdf|png|jpe?g|gif|webp)$/i.test(nom) ? window.open('', '_blank') : null
    if (onglet) onglet.opener = null
    try {
      const r = await fetch(`/api/consoles/${id}/fichier?chemin=${encodeURIComponent(chemin)}`, { credentials: 'same-origin' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `refusé (${r.status})`)
      const blob = await r.blob()
      const f = new File([blob], nom, { type: blob.type || 'application/octet-stream' })
      if (tactile && navigator.canShare?.({ files: [f] })) {
        pret.current = f
        try {
          await partage(f)
          setEtat('')
        } catch (e) {
          setEtat(e?.name === 'AbortError' ? '' : 'pret') // geste trop ancien après le chargement : un toucher de plus
        }
        return
      }
      const u = URL.createObjectURL(blob)
      if (onglet) onglet.location.href = u
      else Object.assign(document.createElement('a'), { href: u, download: nom }).click()
      setTimeout(() => URL.revokeObjectURL(u), 60000)
      setEtat('')
    } catch (e) {
      onglet?.close()
      setEtat(e.message || 'fichier indisponible')
    }
  }
  const dit = etat === 'charge' ? 'Chargement…' : etat === 'pret' ? 'Toucher pour enregistrer' : etat
  return (
    <>
      <button type="button" className={cls('fil-fichier', code && 'est-code', etat && etat !== 'charge' && etat !== 'pret' && 'est-echec')} title={chemin} onClick={clic}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
        </svg>
        <span>{dit || (code ? chemin : texte || nom)}</span>
      </button>
      <OuvrirFichier chemin={chemin} />
    </>
  )
}

// Copier d'un toucher, comme dans les applis natives (Orkun, 11/11 : « ce serait bien de mettre le ptit bouton copier
// juste a coté comme dan les apps natives »), mais seulement sur un bloc de code : « pas besoin de mettre le boutton
// copier a coté de chaque message en format "Chat", juste le mettre quand y a quelque chose comme une commande a copier.
// Sinon laisse moi juste selectionner avec la souris » (Orkun, 11/11).
function Copier({ texte, nom }) {
  const [fait, setFait] = useState('')
  useEffect(() => {
    if (!fait) return
    const t = setTimeout(() => setFait(''), 1500)
    return () => clearTimeout(t)
  }, [fait])
  return (
    <button
      type="button"
      className={cls('fil-copier', fait && 'est-fait')}
      aria-label={nom}
      title={nom}
      onClick={() => navigator.clipboard.writeText(texte).then(() => setFait('Copié'), () => setFait('Refusé'))}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        {fait === 'Copié' ? <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" /> : <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5V14A1.5 1.5 0 0 0 6 15.5h1" /></>}
      </svg>
      <span>{fait || 'Copier'}</span>
    </button>
  )
}

// Le Markdown qui compte dans une réponse d'agent : blocs de code, listes (à puces ou numérotées), titres, citations,
// tableaux (défilables de côté sur téléphone), filets.
// Mémorisé sur son texte (16/11) : quand le journal grandit d'une bulle, les anciennes ne repassent plus par la mise en forme.
const Texte = memo(function Texte({ t }) {
  return t.split('```').map((morceau, i) => {
    if (i % 2) {
      const code = morceau.replace(/^[A-Za-z0-9_+-]*\n/, '').replace(/\n$/, '')
      return (
        <div key={i} className="fil-code">
          <pre>{code}</pre>
          <Copier texte={code} nom="Copier le code" />
        </div>
      )
    }
    return (
      morceau
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p, j) => {
          const ls = p.split('\n').filter((l) => l.trim())
          const cle = `${i}-${j}`
          if (ls.every((l) => PUCE.test(l))) return liste(ls, cle)
          if (ls.length >= 2 && ls.every((l) => l.trim().startsWith('|')) && /^[\s|:-]+$/.test(ls[1]) && ls[1].includes('-')) {
            const [tete, , ...rangs] = ls.map(cellules)
            return (
              <div key={cle} className="fil-table">
                <table>
                  <thead>
                    <tr>
                      {tete.map((c, n) => (
                        <th key={n}>{enLigne(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rangs.map((r, n) => (
                      <tr key={n}>
                        {r.map((c, k) => (
                          <td key={k}>{enLigne(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
          if (ls.every((l) => l.trim().startsWith('|'))) return <pre key={cle}>{ls.join('\n')}</pre>
          if (ls.every((l) => /^\s*>/.test(l)))
            return (
              <blockquote key={cle}>
                {ls.map((l, n) => (
                  <span key={n}>
                    {n > 0 && <br />}
                    {enLigne(l.replace(/^\s*>\s?/, ''))}
                  </span>
                ))}
              </blockquote>
            )
          if (ls.length === 1 && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ls[0])) return <hr key={cle} />
          if (ls.length === 1 && /^#{1,6}\s/.test(ls[0])) return <h4 key={cle}>{enLigne(ls[0].replace(/^#+\s*/, ''))}</h4>
          return (
            <p key={cle}>
              {ls.map((l, n) => (
                <span key={n}>
                  {n > 0 && <br />}
                  {enLigne(l.replace(/^#{1,6}\s+/, ''))}
                </span>
              ))}
            </p>
          )
        })
    )
  })
})

// Quand l'écran de l'agent ne montre plus que la FIN du texte qu'il écrit (le début est sorti par le haut), on la
// recolle à ce qu'on avait déjà : les dernières lignes connues doivent ouvrir la fin reçue (la toute dernière pouvait
// être en cours d'écriture, donc plus courte).
function recolle(avant, queue) {
  const a = avant.split('\n')
  const q = queue.split('\n')
  for (let k = 0; k < a.length; k++) {
    const reste = a.slice(k)
    if (reste.length <= q.length && reste.every((l, i) => (i === reste.length - 1 ? q[i].startsWith(l) : q[i] === l))) return [...a.slice(0, k), ...q].join('\n')
  }
  return queue // aucun recouvrement : on montre ce qui se voit
}

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`
// Deux petits dessins au trait : une invite de commande (un outil), trois lignes (plusieurs).
const Trait = ({ d }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const INVITE = 'M4 5.5h16v13H4z M8 10l3 2.2L8 14.4 M13 14.6h3.5'
const LISTE = 'M5 7h14 M5 12h14 M5 17h9'

// Une suite d'outils, repliée en une ligne ; un appui la déplie.
function Outils({ x }) {
  const [ouvert, setOuvert] = useState(false)
  const n = x.outils.length
  const seul = n === 1 && x.outils[0]
  const titre = seul ? `A utilisé ${seul.nom}` : [x.cree && `${pluriel(x.cree, 'fichier')} créé${x.cree > 1 ? 's' : ''}`, x.modifie && pluriel(x.modifie, 'modification'), pluriel(n, 'outil')].filter(Boolean).join(', ')
  return (
    <div className={ouvert ? 'fil-outils est-ouvert' : 'fil-outils'} data-n={x.n}>
      <button type="button" aria-expanded={ouvert} onClick={() => setOuvert((o) => !o)}>
        <Trait d={seul ? INVITE : LISTE} />
        <span className="fil-outils-t">{titre}</span>
        {seul && seul.quoi && !ouvert && <span className="fil-outils-q">{seul.quoi}</span>}
        {(x.plus > 0 || x.moins > 0) && (
          <span className="fil-diff">
            <i>+{x.plus}</i>
            <em>−{x.moins}</em>
          </span>
        )}
        <span className="fil-va" aria-hidden="true">
          ›
        </span>
      </button>
      {ouvert && (
        <ul>
          {x.outils.map((o, i) => (
            <li key={i}>
              <b>{o.nom}</b>
              {o.quoi && <span>{o.quoi}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Les pièces jointes d'un message parti de la barre d'envoi : les images en vignettes, le reste par son nom. Une pièce
// de plus de 30 jours n'existe plus sur le serveur : sa vignette laisse alors la place à son nom.
// `apercus` (bulle en attente) : nom reçu → aperçu pris sur l'appareil (blob:), montré tout de suite ; un aperçu déjà
// libéré (discussion quittée puis rouverte) n'est plus demandé : l'image vient du VPS, comme pour la vraie bulle.
const LIBERES = new Set()
const libere = (u) => {
  URL.revokeObjectURL(u)
  LIBERES.add(u)
}
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const nomCourt = (n) => n.replace(/^\d{8}-\d{6}-(\d+-)?/, '')
function Pieces({ id, noms, apercus = {} }) {
  const [perdues, setPerdues] = useState([])
  return (
    <span className="fil-pieces">
      {noms.map((n) => {
        const adresse = `/api/envois/${id}/fichier/${encodeURIComponent(n)}`
        const src = apercus[n] && !perdues.includes(apercus[n]) ? apercus[n] : adresse
        return IMAGE.test(n) && !perdues.includes(n) ? (
          <a key={n} href={adresse} target="_blank" rel="noopener noreferrer">
            <img src={src} alt={nomCourt(n)} loading="lazy" onError={() => setPerdues((l) => [...l, src === adresse ? n : src])} />
          </a>
        ) : (
          <a key={n} className="fil-piece" href={adresse} target="_blank" rel="noopener noreferrer">
            {nomCourt(n)}
          </a>
        )
      })}
    </span>
  )
}

// Libellés connus des questions de Claude Code et de Codex, dits en français (le dernier élément : la suite du libellé,
// coupée par la largeur de l'écran, n'est alors pas montrée). Tout autre libellé reste tel que l'agent l'écrit. La réponse
// envoyée au serveur porte toujours le libellé d'origine : c'est lui qui est vérifié avant de valider.
const LIBELLES = [
  [/^Yes$/, 'Oui'],
  [/^No$/, 'Non'],
  [/^No, exit$/, 'Non, quitter'],
  [/^Yes, I trust this folder$/, 'Oui, je fais confiance à ce dossier'],
  [/^Yes, proceed( \(y\))?$/, 'Oui, lancer'],
  [/^Yes, and switch to accept edits\b/, 'Oui, et accepter les modifications de fichiers pour cette session', true],
  [/^No, and tell (Claude|Codex) what to do differently\b/, 'Non, et lui dire quoi faire à la place', true],
  [/^Type something\.?$/, 'Écrire autre chose (dans le terminal)'],
  [/^Chat about this$/, 'En discuter'],
  [/^Submit answers$/, 'Envoyer les réponses'],
  [/^Cancel$/, 'Annuler'],
]
const libelle = (o) => {
  const connu = LIBELLES.find(([re]) => re.test(o.texte))
  return connu ? { texte: connu[1], suite: connu[2] ? '' : o.suite } : o
}

// La question de l'agent, avec un bouton par réponse (Orkun, 10/11 : « Oui go »). Le menu est lu sur l'écran de l'agent
// par le serveur ; un toucher envoie le rang et le libellé touché, et le serveur ne valide que si c'est toujours ce menu.
// Question à plusieurs réponses (`q.cases`) : chaque case se coche ou se décoche d'un toucher (le serveur relit la case
// à l'écran avant de répondre), puis « Valider » mène à la relecture de l'agent (`q.revue`) : envoyer ou annuler.
function Question({ console: c, q, onTerminal, onRepondu, onRelire }) {
  const [envoi, setEnvoi] = useState(null) // rang de la réponse en cours d'envoi
  const [erreur, setErreur] = useState('')
  const confiance = /Accessing workspace/i.test(q.contexte) && q.options.some((o) => /trust this folder/i.test(o.texte))
  const dossier = confiance ? (q.contexte.split('\n').find((l) => l.startsWith('/')) ?? '') : ''
  const note = c.note && c.note !== 'Question au démarrage' ? c.note : ''
  const cochees = q.options.filter((o) => o.coche).length
  const repond = async (i, o) => {
    setEnvoi(i)
    setErreur('')
    try {
      const fait = await api('POST', `/api/consoles/${c.id}/reponse`, { choix: i, texte: o.texte })
      if (/^Type something/.test(o.texte)) onTerminal() // l'agent attend maintenant un texte, dans sa boîte
      if (fait.coche !== undefined) {
        await onRelire() // une case : la question reste, relue telle que l'agent l'affiche maintenant
        setEnvoi(null)
      } else onRepondu()
    } catch (e) {
      setErreur(e.message)
      setEnvoi(null)
    }
  }
  const titre = confiance ? 'Faire confiance à ce dossier ?' : q.revue ? 'Envoyer ces réponses ?' : note || q.titre || "Une question t'attend"
  return (
    <div className={cls('fil-attend fil-question', q.cases && 'a-cases')}>
      <small>{q.cases ? 'T’ATTEND · PLUSIEURS RÉPONSES POSSIBLES' : 'T’ATTEND'}</small>
      <b>{titre}</b>
      {confiance ? (
        <p className="fil-contexte">
          {dossier}
          {'\n'}Claude pourra lire, modifier et exécuter les fichiers de ce dossier.
        </p>
      ) : (
        (q.contexte || (note && q.titre)) && <p className="fil-contexte">{[q.contexte, note && q.titre].filter(Boolean).join('\n')}</p>
      )}
      <div className="fil-choix">
        {q.options.map((o, i) => {
          const l = libelle(o)
          const ecrire = /^Type something/.test(o.texte)
          if (o.valide)
            return (
              <button key={i} type="button" disabled={envoi !== null || !cochees} className={cls('fil-valide', envoi === i && 'part')} onClick={() => repond(i, o)}>
                {cochees ? `Valider · ${cochees} choisi${cochees > 1 ? 's' : ''}` : 'Coche au moins une réponse'}
              </button>
            )
          // Une case (sauf « Écrire autre chose », qui renvoie au terminal) : sa coche dit son état à l'écran de l'agent.
          const caseACocher = o.coche !== undefined && !ecrire
          return (
            <button
              key={i}
              type="button"
              disabled={envoi !== null}
              role={caseACocher ? 'checkbox' : undefined}
              aria-checked={caseACocher ? o.coche : undefined}
              className={cls(caseACocher && 'fil-case', caseACocher && o.coche && 'est-cochee', envoi === i && 'part')}
              onClick={() => repond(i, o)}
            >
              {caseACocher && <i aria-hidden="true" />}
              <span>
                {l.texte}
                {l.suite && <small>{l.suite}</small>}
              </span>
            </button>
          )
        })}
      </div>
      {erreur && <p role="alert">{erreur}</p>}
      <button type="button" className="fil-lien" onClick={onTerminal}>
        Voir dans le terminal ›
      </button>
    </div>
  )
}

// `envoyes` : les messages partis de la barre d'envoi, montrés aussitôt (en attente) jusqu'à ce que le journal les porte.
// Les messages du journal, mis en forme. Mémorisés (16/11, Orkun sur son MacBook : « c'est hyper lent ») : un agent qui
// travaille fait relire sa discussion toutes les 0,7 s (ce que son écran montre : indicateur, texte en cours), et chaque
// relecture redessinait TOUTE la conversation, mise en forme comprise, même quand rien n'avait changé. La liste ne se
// refait plus que si le journal a changé (`fil`, remplacé seulement quand le serveur en renvoie un neuf) ou la console.
// Clé de chaque élément : son numéro stable donné par le serveur (`n`, lib/fil.mjs), pas son rang (17/11, chasse, défaut
// 6). Le serveur ne rend que les 150 derniers éléments : au rang, chaque nouveau message décalait toutes les clés, chaque
// bulle était réécrite avec le texte de la suivante (mise en forme refaite, outil déplié qui changeait de bulle) et le
// texte relu plus haut glissait de la hauteur de l'élément sorti. `data-n` sert au recalage du défilement (plus bas).
const Messages = memo(function Messages({ fil, c, derniere }) {
  return fil.map((x, i) =>
    x.r === 'outils' ? (
      <Outils key={x.n} x={x} />
    ) : x.r === 'toi' ? (
      <div key={x.n} data-n={x.n} className={x.t.startsWith('[Meydan]') ? 'fil-toi de-meydan' : 'fil-toi'}>
        {x.t}
        {x.pieces?.length > 0 && <Pieces id={c.id} noms={x.pieces} />}
      </div>
    ) : (
      <div key={x.n} data-n={x.n} className="fil-agent">
        <Texte t={x.t} />
        {i === derniere && <Ecouter console={c} texte={x.t} />}
      </div>
    ),
  )
})

// Garder en place ce qu'Orkun relit (17/11, chasse, défaut 6). Quand un message arrive, les plus anciens sortent par le
// haut de la fenêtre des 150 : le contenu remonte de leur hauteur et, sans recalage, le texte lu glisse. Chrome recale
// seul (`overflow-anchor`), Safari non : on note la place du premier message visible qui reste, on remplace le fil, et on
// le remet à la même hauteur dans la boîte — un recalage nul si le navigateur l'a déjà fait. En points de la page : sur le
// plateau du PC, la boîte est zoomée et getBoundingClientRect rend des points d'écran.
const hauteurDans = (boite, e) => ((e.getBoundingClientRect().top - boite.getBoundingClientRect().top) * boite.offsetHeight) / boite.getBoundingClientRect().height
function repere(boite, neuf) {
  if (!boite?.offsetHeight || !neuf.length) return null
  const haut = boite.getBoundingClientRect().top
  for (const e of boite.querySelectorAll(':scope > [data-n]'))
    if (e.getBoundingClientRect().bottom > haut && Number(e.dataset.n) >= neuf[0].n) return { e, y: hauteurDans(boite, e) }
  return null
}
function recale(boite, { e, y }) {
  if (!e.isConnected || !boite.offsetHeight) return
  const d = hauteurDans(boite, e) - y
  if (Math.abs(d) >= 0.5) boite.scrollTop += d
}

export function Fil({ console: c, envoyes = [], onTerminal }) {
  const [fil, setFil] = useState(null)
  const [question, setQuestion] = useState(null) // le menu que l'agent affiche, s'il attend un choix
  const [menu, setMenu] = useState(false) // une boîte est ouverte dans le terminal, lisible en boutons ou non
  const relit = useRef(() => {})
  const [direct, setDirect] = useState(null) // ce que l'agent fait à l'instant, lu sur son écran : indicateur, temps, texte en cours
  const [inconnue, setInconnue] = useState(false) // Meydan ne connaît pas encore la conversation de cette console
  const boite = useRef(null)
  const auBas = useRef(true) // tant qu'on est en bas, la discussion suit les nouveaux messages
  const tenu = useRef({ texte: '', n: 0, at: 0 }) // le dernier texte vu en cours d'écriture, gardé jusqu'à ce que le journal le porte

  // La conversation n'est renvoyée que si elle a changé (`cle`, l'empreinte que le serveur donne) : une relecture sans
  // nouveauté pèse quelques centaines d'octets au lieu de 60 à 70 Ko. Rien du tout quand Meydan est en arrière-plan
  // (batterie de l'iPhone).
  // Les bulles arrivent par le serveur : il surveille le journal de l'agent et dit sur /ws/events quand le fil a changé
  // (`filBus`, lib.js), la discussion relit alors aussitôt. Brief du volet du 11/11 : « Remplace par une poussée […] ;
  // `Fil.jsx` recharge à l'événement, avec un sondage lent de secours (10 s) ».
  const cleRef = useRef({ id: null, cle: '' })
  useEffect(() => {
    let mort = false
    let n = 0 // numéro de la dernière lecture lancée
    let applique = 0 // numéro de la dernière réponse appliquée : une réponse plus ancienne arrivée après elle est jetée
    let enVol = 0 // lectures parties, pas encore revenues
    const lit = () => {
      if (mort || document.visibilityState === 'hidden') return Promise.resolve()
      const k = ++n
      const perimee = () => mort || k < applique
      enVol++
      const cle = cleRef.current.id === c.id ? cleRef.current.cle : ''
      return api('GET', `/api/consoles/${c.id}/fil${cle ? `?cle=${encodeURIComponent(cle)}` : ''}`)
        .then(
          (j) => {
            if (perimee()) return
            applique = k
            // Orkun relit plus haut dans CETTE conversation : le fil est remplacé tout de suite (flushSync), entre la
            // mesure et le recalage, avant que l'écran ne soit redessiné (`repere`, plus haut).
            const garde = j.fil !== undefined && cleRef.current.id === c.id && !auBas.current ? repere(boite.current, j.fil) : null
            if (garde) {
              flushSync(() => setFil(j.fil))
              recale(boite.current, garde)
            } else if (j.fil !== undefined) setFil(j.fil)
            cleRef.current = { id: c.id, cle: j.cle || '' }
            setDirect(j.direct || null)
            setQuestion(j.question || null)
            setMenu(!!j.menu)
            setInconnue(false)
          },
          () => {
            if (perimee()) return
            applique = k
            setInconnue(true)
            setDirect(null)
            setQuestion(null)
            setMenu(false)
          },
        )
        .finally(() => enVol--)
    }
    lit()
    relit.current = lit
    // Sondage de secours, lent (10 s), au repos comme en attente : une poussée perdue se rattrape. Vif (0,7 s) tant que
    // l'agent travaille : la réponse porte aussi ce que son ÉCRAN montre à l'instant (indicateur, temps écoulé, texte que
    // Codex écrit), qu'aucun surveillant de fichier ne voit. Le sondage passe son tour tant qu'une lecture est en route ;
    // une poussée, elle, relit tout de suite (attendre une lecture lente doublait le délai d'une bulle).
    const t = setInterval(() => enVol || lit(), c.status === 'working' || c.status === 'running' ? 700 : 10000)
    // Le fil de cette console a changé (empreinte différente de celle qu'on a), ou la liaison vient de se rouvrir.
    const pousse = ({ detail: d }) => {
      if (d.tout || (d.id === c.id && d.cle !== (cleRef.current.id === c.id ? cleRef.current.cle : ''))) lit()
    }
    filBus.addEventListener('fil', pousse)
    // Retour au premier plan (iPhone déverrouillé, onglet repris) : relu tout de suite, sans attendre le prochain tour.
    const revient = () => document.visibilityState === 'visible' && lit()
    document.addEventListener('visibilitychange', revient)
    return () => {
      mort = true
      clearInterval(t)
      filBus.removeEventListener('fil', pousse)
      document.removeEventListener('visibilitychange', revient)
    }
  }, [c.id, c.status, c.since, c.agent])

  useEffect(() => {
    const el = boite.current
    if (el && auBas.current) el.scrollTop = el.scrollHeight
  }, [fil, direct, envoyes, c.status, question, menu])
  // La place change sans que la conversation change (téléphone tourné, clavier ouvert, champ d'envoi qui grandit) :
  // si on était en bas, on y reste. Sinon le dernier message passait sous le champ.
  useEffect(() => {
    const el = boite.current
    if (!el || !window.ResizeObserver) return
    const ro = new ResizeObserver(() => {
      if (auBas.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // En attente : pas encore dans le journal. Comparé au début du texte, parmi les derniers (les pièces jointes y ajoutent
  // leurs chemins) ; un message avec pièces se reconnaît aussi aux noms que le serveur leur a donnés (uniques : date et
  // heure) : une photo seule n'a pas de texte au journal, sa bulle en attente restait 90 s à côté de la vraie.
  const porte = (e, x, recent) => x.r === 'toi' && ((e.pieces?.length > 0 && e.pieces.every((p) => x.pieces?.includes(p.nom) || x.t.includes(p.nom))) || (recent && !!e.t && x.t.includes(e.t.slice(0, 60))))
  const pendants = envoyes.filter((e) => Date.now() - e.at < 90000 && !fil?.some((x, i) => porte(e, x, i >= fil.length - 12)))
  // Les aperçus (blob:) des photos d'un message en attente vivent tant que sa bulle est là : libérés quand elle s'en va
  // (journal arrivé, 90 s passées, autre console), et quand la discussion se ferme ; rouverte, elle prend l'image du VPS.
  const apercus = useRef(new Set())
  const vivants = pendants.flatMap((e) => (e.pieces || []).map((p) => p.apercu).filter((u) => u && !LIBERES.has(u)))
  useEffect(() => {
    const garde = new Set(vivants)
    for (const u of apercus.current) if (!garde.has(u)) libere(u)
    apercus.current = garde
  })
  useEffect(() => () => apercus.current.forEach(libere), [])
  // Entre la fin de l'écriture à l'écran et l'arrivée du texte entier dans le journal, il y a un instant sans rien :
  // le dernier texte vu reste affiché tant que le fil n'a pas grandi (douze secondes au plus).
  const n = fil?.length || 0
  if (direct?.texte) tenu.current = { texte: direct.partiel && tenu.current.n === n ? recolle(tenu.current.texte, direct.texte) : direct.texte, n, at: Date.now() }
  const enCoursTexte = (direct?.texte && tenu.current.texte) || (tenu.current.texte && tenu.current.n === n && Date.now() - tenu.current.at < 12000 ? tenu.current.texte : '')
  const actif = c.status === 'working' || !!direct
  const vide = (inconnue || (fil && fil.length === 0)) && pendants.length === 0 && !question && !menu
  const dernier = fil?.at(-1)
  const enCours = dernier?.r === 'outils' ? dernier.outils.at(-1)?.nom : ''
  const derniere = fil ? fil.findLastIndex((x) => x.r === 'agent') : -1 // la réponse que « Écouter » lit (Voix.jsx)
  return (
    <ConsoleId.Provider value={c.id}>
    <div
      className="fil"
      ref={boite}
      onLoadCapture={() => {
        // Une vignette chargée après le texte agrandit le contenu sans redimensionner la boîte.
        const el = boite.current
        if (el && auBas.current) el.scrollTop = el.scrollHeight
      }}
      onScroll={(e) => {
        const el = e.currentTarget
        auBas.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {fil === null && !inconnue && <p className="fil-note">Lecture de la conversation…</p>}
      {vide && c.status !== 'needs' && (
        <p className="fil-note">
          <b>Aucun message pour l’instant.</b>
          Écris à l’agent ci-dessous : la discussion s’affichera ici.
          <button type="button" onClick={onTerminal}>
            Voir le terminal
          </button>
        </p>
      )}
      {!inconnue && fil && <Messages fil={fil} c={c} derniere={derniere} />}
      {pendants.map((e) => (
        <div key={e.at} className="fil-toi en-attente">
          {e.t}
          {e.pieces?.length > 0 && <Pieces id={c.id} noms={e.pieces.map((p) => p.nom)} apercus={Object.fromEntries(e.pieces.filter((p) => p.apercu && !LIBERES.has(p.apercu)).map((p) => [p.nom, p.apercu]))} />}
        </div>
      ))}
      {enCoursTexte && (
        <div className={direct?.texte ? 'fil-agent en-direct' : 'fil-agent'}>
          <Texte t={enCoursTexte} />
        </div>
      )}
      {actif && (
        <p className="fil-travaille" aria-live="polite">
          <i />
          <i />
          <i />
          <span>{direct?.verbe ? `${direct.verbe}…` : direct?.texte ? 'Écrit…' : 'Travaille…'}</span>
          <small>{(direct?.verbe ? [direct.duree, direct.jetons] : [!direct?.texte && enCours]).filter(Boolean).join(' · ')}</small>
        </p>
      )}
      {question ? (
        <Question
          key={`${c.since}:${question.titre}:${question.options.length}`}
          console={c}
          q={question}
          onTerminal={onTerminal}
          onRelire={() => relit.current()}
          onRepondu={() => {
            setQuestion(null)
            setMenu(false)
            setTimeout(() => relit.current(), 600)
          }}
        />
      ) : (
        (c.status === 'needs' || menu) && (
          <button type="button" className="fil-attend" onClick={onTerminal}>
            <small>T’ATTEND</small>
            <b>{(c.status === 'needs' && c.note) || (menu ? 'Un menu est ouvert dans le terminal' : "Une question t'attend")}</b>
            <span>Répondre dans le terminal ›</span>
          </button>
        )
      )}
    </div>
    </ConsoleId.Provider>
  )
}
