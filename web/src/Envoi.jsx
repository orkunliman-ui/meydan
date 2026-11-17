import { useEffect, useRef, useState } from 'react'
import { MAX_AUDIO_S, MAX_FILE, MAX_FILES, record, removeFile, sendMessage, shrinkImage, transcribe, upload } from './envoi.js'
import { api, cls } from './lib.js'
import { atterrit, envole, gardeBrouillon, lisBrouillon } from './brouillons.js'
import { EnvoiRisque, useRisque } from './EnvoiRisque.jsx' // texte risqué : deux appuis (décision d'Orkun du 17/11, ordres-4)

// La barre d'envoi du téléphone : un texte, des pièces jointes, une note vocale, pour la console ouverte.
// Dessin validé par Orkun le 10/11 (docs/specs/2026-11-10-barre-envoi.md).
const Icone = ({ children }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const TROMBONE = <path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5" />
const MICRO = (
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </>
)
const FLECHE = <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
const CROIX = <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />

const chrono = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const garde = (e) => e.preventDefault() // toucher un bouton ne retire pas le focus du champ (le clavier resterait ouvert)

// `key={c.id}` côté appelant : changer de console change de barre (les pièces appartiennent à leur console).
// `brouillon` : le texte de cette console est gardé quand la barre part (autre console, liste, console fermée) et revient
// avec elle (brouillons.js ; chasse du 17/11 : un message long se perdait d'un toucher).
// `onEnvoye(texte, pieces)` : le message vient de partir (la discussion l'affiche tout de suite, sans attendre le
// journal) ; `pieces` : [{ nom reçu du serveur, apercu (blob:) ou null }], le texte peut être vide (photo seule).
// `forme` : 'fil' (discussion) ou 'terminal' ; le champ n'a pas la même taille dans les deux.
// Ordinateur (Discussion.jsx) : `clavier` = Entrée envoie, Maj+Entrée va à la ligne, et le champ garde le focus après
// l'envoi ; `focus` = le champ prend le clavier à l'ouverture ; `jointRef.current` reçoit la fonction qui ajoute des
// pièces jointes (une image collée ou un fichier glissé ailleurs dans la discussion).
export function Envoi({ console: c, onCompose, onEnvoye, forme, clavier = false, focus = false, jointRef, brouillon = false }) {
  const [texte, setTexte] = useState(() => (brouillon ? lisBrouillon(c.id) : ''))
  const [pieces, setPieces] = useState([]) // { cle, nom, apercu, etat: 'envoi' | 'pret' | 'echec', part, recu, erreur }
  const [voix, setVoix] = useState(null) // null | 'ecoute' | 'transcription'
  const [secondes, setSecondes] = useState(0)
  const [erreur, setErreur] = useState('')
  const [part, setPart] = useState(false)
  const champ = useRef(null)
  const rec = useRef(null)
  const cles = useRef(0)
  const envois = useRef(new Map()) // clé → annulation de l'envoi en cours
  const retirees = useRef(new Set())
  const restes = useRef([])
  restes.current = pieces

  // Le champ grandit avec le texte, jusqu'à cinq lignes.
  useEffect(() => {
    const el = champ.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 132)}px`
  }, [texte, voix, forme]) // `forme` : passé de la discussion au terminal, le champ gardait sa hauteur de discussion (rogné)

  // Le brouillon suit le texte de la barre.
  useEffect(() => {
    if (brouillon) gardeBrouillon(c.id, texte)
  }, [texte]) // eslint-disable-line react-hooks/exhaustive-deps

  // En quittant la console : envois en cours annulés, micro coupé, vignettes libérées.
  useEffect(
    () => () => {
      for (const annule of envois.current.values()) annule()
      rec.current?.cancel()
      for (const p of restes.current) if (p.apercu) URL.revokeObjectURL(p.apercu)
      onCompose?.(false)
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    if (focus) champ.current?.focus({ preventScroll: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const maj = (cle, patch) => setPieces((l) => l.map((p) => (p.cle === cle ? { ...p, ...patch } : p)))

  const ajoute = async (files) => {
    setErreur('')
    const place = MAX_FILES - pieces.length
    if (files.length > place) setErreur(`${MAX_FILES} pièces au plus par message`)
    for (const brut of files.slice(0, Math.max(0, place))) {
      const cle = ++cles.current
      const image = brut.type.startsWith('image/')
      setPieces((l) => [...l, { cle, nom: brut.name || 'fichier', apercu: image ? URL.createObjectURL(brut) : null, etat: 'envoi', part: 0 }])
      const f = image ? await shrinkImage(brut) : brut
      if (f.size > MAX_FILE) {
        maj(cle, { etat: 'echec', erreur: 'plus de 25 Mo' })
        continue
      }
      if (retirees.current.has(cle)) continue
      const { promise, abort } = upload(c.id, f, (p) => maj(cle, { part: p }))
      envois.current.set(cle, abort)
      promise
        .then(
          (recu) => (retirees.current.has(cle) ? removeFile(c.id, recu.nom).catch(() => {}) : maj(cle, { etat: 'pret', recu: recu.nom })),
          (e) => maj(cle, { etat: 'echec', erreur: e.message }),
        )
        .finally(() => envois.current.delete(cle))
    }
  }

  if (jointRef) jointRef.current = ajoute

  const retire = (p) => {
    retirees.current.add(p.cle)
    envois.current.get(p.cle)?.()
    if (p.recu) removeFile(c.id, p.recu).catch(() => {})
    if (p.apercu) URL.revokeObjectURL(p.apercu)
    setPieces((l) => l.filter((x) => x.cle !== p.cle))
  }

  // Note vocale : un appui commence, « Terminer » transcrit ; le texte arrive dans le champ, à relire avant d'envoyer.
  const termine = async () => {
    const r = rec.current
    if (!r) return
    rec.current = null
    setVoix('transcription')
    try {
      const { texte: dit } = await transcribe(c.id, await r.stop())
      setTexte((v) => (v.trim() ? `${v.trimEnd()} ${dit}` : dit))
    } catch (e) {
      setErreur(e.message)
    }
    setVoix(null)
  }
  const ecoute = async () => {
    setErreur('')
    try {
      rec.current = await record()
      setSecondes(0)
      setVoix('ecoute')
    } catch (e) {
      setErreur(e.message)
    }
  }
  const annule = () => {
    rec.current?.cancel()
    rec.current = null
    setVoix(null)
  }
  // Pendant la dictée, le champ laisse la place à « Terminer » : il est démonté sans « blur » (Chromium au moins), et
  // l'écran restait en mode « écrit » (touches du terminal cachées, chasse du 17/11). Le champ n'a plus le clavier : on
  // le dit ici, sans compter sur l'événement.
  useEffect(() => {
    if (voix) onCompose?.(false)
  }, [voix]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (voix !== 'ecoute') return
    const t0 = Date.now()
    const t = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000)
      setSecondes(s)
      if (s >= MAX_AUDIO_S) termine() // dix minutes : on transcrit ce qu'on a
    }, 500)
    return () => clearInterval(t)
  }, [voix]) // eslint-disable-line react-hooks/exhaustive-deps

  const pretes = pieces.filter((p) => p.etat === 'pret')
  const risque = useRisque(texte, pretes.map((p) => p.recu))
  // L'agent attend une réponse dans un menu : Entrée y validerait son choix par défaut. Le serveur refuse aussi.
  const bloque = c.status === 'needs' || c.status === 'starting'
  const peut = !bloque && !part && !voix && !pieces.some((p) => p.etat === 'envoi') && (texte.trim() !== '' || pretes.length > 0)
  const envoie = async () => {
    if (!peut || risque.tropTot()) return // second appui trop proche du refus (double-clic) : rien
    setPart(true)
    setErreur('')
    // Ce qui part : le texte et les pièces d'à présent. Une image collée ou un mot tapé pendant l'envoi (il dure une
    // demi-seconde) reste dans la barre : au retour, on ne retire que ce qui est parti (vu au banc le 11/11 : une image
    // collée juste après Entrée disparaissait, son fichier restait sur le VPS).
    const dit = texte
    const parties = pieces.filter((p) => p.etat !== 'envoi')
    // Le texte qui part quitte le brouillon dès maintenant : une barre de la même console montée pendant l'envoi (changer
    // de console puis revenir) ne le reprend pas ; un échec le remet (relecture de sécurité du 17/11).
    if (brouillon) envole(c.id, dit)
    try {
      await sendMessage(
        c.id,
        dit,
        pretes.map((p) => p.recu),
        risque.confirmation,
      )
      // Les photos parties gardent leur aperçu pour la bulle en attente de la discussion, qui le libère quand elle s'en va
      // (Fil.jsx) ; sans discussion à l'écran (terminal), il est libéré tout de suite, comme le reste.
      const confies = new Set(forme === 'fil' ? pretes.map((p) => p.apercu).filter(Boolean) : [])
      for (const p of parties) if (p.apercu && !confies.has(p.apercu)) URL.revokeObjectURL(p.apercu)
      onEnvoye?.(
        dit.trim(),
        pretes.map((p) => ({ nom: p.recu, apercu: confies.has(p.apercu) ? p.apercu : null })),
      )
      const cles = new Set(parties.map((p) => p.cle))
      setPieces((l) => l.filter((p) => !cles.has(p.cle)))
      setTexte((v) => (v.startsWith(dit) ? v.slice(dit.length).trimStart() : v))
      // La barre a pu partir pendant l'envoi (autre console, liste) : son effet ne tourne plus, le brouillon se règle ici,
      // sinon le texte parti reviendrait et partirait deux fois (relecture de sécurité du 17/11).
      if (brouillon) atterrit(c.id, dit, true)
      if (!clavier) champ.current?.blur() // téléphone : le clavier se ferme, on voit l'agent répondre
    } catch (e) {
      if (brouillon) atterrit(c.id, dit, false)
      if (!risque.retient(e, dit, pretes.map((p) => p.recu))) setErreur(e.message)
    }
    setPart(false)
  }

  // Ce qui peut être arrêté : un agent qui travaille (Échap), une commande qui tourne dans un shell (Ctrl C).
  const enTravail = c.status === 'working' || (c.status === 'running' && c.kind === 'shell')
  const arrete = () => api('POST', `/api/consoles/${c.id}/interrompre`).then(() => setErreur(''), (e) => setErreur(e.message))

  return (
    <div className="envoi">
      {bloque && (
        <p className="envoi-avis">
          {/* Console qui démarre : aucune question n'existe encore, rien à donner sur une carte (chasse du 17/11). */}
          {c.status === 'starting'
            ? 'L’agent démarre : l’envoi revient dès qu’il est prêt.'
            : `${forme === 'fil' ? 'L’agent attend une réponse : donne-la sur la carte jaune.' : 'L’agent attend une réponse : donne-la dans le terminal ou avec les touches.'} L’envoi revient juste après.`}
        </p>
      )}
      {erreur && (
        <p className="envoi-erreur" role="alert">
          {erreur}
        </p>
      )}
      {risque.arme && <EnvoiRisque risques={risque.arme.risques} />}
      {pieces.length > 0 && (
        <ul className="envoi-pieces">
          {pieces.map((p) => (
            <li key={p.cle} className={cls('piece', `est-${p.etat}`)}>
              {p.apercu ? <img src={p.apercu} alt="" /> : <span className="piece-type">{(p.nom.includes('.') ? p.nom.split('.').pop() : 'doc').slice(0, 4)}</span>}
              <span className="piece-nom">{p.etat === 'echec' ? p.erreur : p.nom}</span>
              <button type="button" aria-label={`Retirer ${p.nom}`} onPointerDown={garde} onClick={() => retire(p)}>
                <Icone>{CROIX}</Icone>
              </button>
              {p.etat === 'envoi' && <i style={{ width: `${Math.round(p.part * 100)}%` }} />}
            </li>
          ))}
        </ul>
      )}
      {voix ? (
        <div className="envoi-rang">
          <button type="button" className="envoi-b" aria-label="Annuler la note vocale" disabled={voix === 'transcription'} onClick={annule}>
            <Icone>{CROIX}</Icone>
          </button>
          <p className="envoi-note" aria-live="polite">
            {voix === 'transcription' ? (
              'Transcription…'
            ) : (
              <>
                <i className="point" />
                <b>{chrono(secondes)}</b> parle, puis termine
              </>
            )}
          </p>
          <button type="button" className="envoi-b pret" disabled={voix === 'transcription'} onClick={termine}>
            Terminer
          </button>
        </div>
      ) : (
        <div className="envoi-rang">
          <label className="envoi-b" aria-label="Joindre une photo ou un fichier">
            <input
              type="file"
              multiple
              onChange={(e) => {
                const files = [...e.target.files] // copie : vider le champ viderait la liste
                e.target.value = ''
                ajoute(files)
              }}
            />
            <Icone>{TROMBONE}</Icone>
          </label>
          <textarea
            ref={champ}
            name="message"
            rows={1}
            value={texte}
            placeholder={c.status === 'shell' ? 'Commande' : 'Message à l’agent'}
            enterKeyHint={clavier ? 'send' : 'enter'}
            onChange={(e) => setTexte(e.target.value)}
            onKeyDown={(e) => {
              // Ordinateur : Entrée envoie, Maj+Entrée va à la ligne ; rien pendant une saisie composée (accents, IME).
              if (!clavier || e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              if (!e.repeat) envoie() // Entrée maintenue : un seul envoi (sa répétition confirmait un texte risqué, relecture du 17/11)
            }}
            onFocus={() => onCompose?.(true)}
            onBlur={() => onCompose?.(false)}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files || [])]
              if (!files.length) return
              e.preventDefault() // une image collée devient une pièce jointe
              ajoute(files)
            }}
          />
          <button type="button" className="envoi-b" aria-label="Dicter une note vocale" onPointerDown={garde} onClick={ecoute}>
            <Icone>{MICRO}</Icone>
          </button>
          {/* Rien à envoyer pendant que ça travaille : le bouton devient « arrêter », comme dans les applis de discussion. */}
          {enTravail && !peut ? (
            <button type="button" className="envoi-b stop" aria-label={c.kind === 'shell' ? 'Interrompre la commande' : 'Interrompre l’agent'} onPointerDown={garde} onClick={arrete}>
              <i />
            </button>
          ) : (
            <button type="button" className={cls('envoi-b', peut && 'pret', risque.arme && 'est-risque')} aria-label={risque.libelle || 'Envoyer'} disabled={!peut} onPointerDown={garde} onClick={envoie}>
              {risque.arme ? risque.libelle : <Icone>{FLECHE}</Icone>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
