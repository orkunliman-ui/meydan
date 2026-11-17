// Carte « Aperçu web » (plateau étendu, volet du 11/11) : un serveur local du VPS (http://127.0.0.1:<port>) vu dans une
// carte du plateau, par le relais à jeton de Meydan (lib/relais-web.mjs).
//   - sans port : un petit formulaire (port, chemin) ;
//   - avec port : le site dans un cadre ISOLÉ (sandbox sans allow-same-origin : origine opaque, ni cookie ni API de
//     Meydan ; le serveur pose la même isolation par sa CSP), et dans la barre : recharger, ouvrir dans un onglet,
//     changer de port ;
//   - plateau du téléphone (`tel`) : JAMAIS de cadre (mémoire graphique de l'iPhone), la tuile dit « Aperçu · 127.0.0.1:<port> ».
// Jeton : l'adresse est gardée jusqu'à sa fin de validité (12 h au plus, jamais au-delà de la session), et reprise une
// minute avant (le cadre se recharge alors), ou tout de suite par « Recharger ». Vue de loin sur l'ordinateur : le cadre
// reste monté, caché, pour retrouver la page telle qu'on l'a laissée.
import { memo, useContext, useEffect, useState } from 'react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { cls } from './lib.js'
import './carte-web.css'

export const WebNode = memo(function WebNode({ id, data: k, width, height, selected }) {
  const { tel, actions } = useContext(CartesCtx)
  const port = Number.isInteger(k.port) ? k.port : null
  const [regle, setRegle] = useState(false) // formulaire rouvert sur une carte qui a déjà un port (« Port »)
  const [envoi, setEnvoi] = useState(false) // modification en vol : pas d'adresse demandée avant que le serveur ait le port
  const [apercu, setApercu] = useState(null) // { adresse, fin } donnés par le serveur
  const [erreur, setErreur] = useState('')
  const [tour, setTour] = useState(0) // « Recharger » : nouvelle adresse et nouveau cadre

  useEffect(() => {
    setApercu(null)
    if (tel || envoi || port === null) return
    let vivant = true
    let minuterie
    const prend = () =>
      actions.apercu(id).then(
        (a) => {
          if (!vivant) return
          setErreur('')
          setApercu(a)
          // Une minute avant la fin ; si la fin est plus proche (session qui se termine), à la fin même : pas de boucle.
          const reste = a.fin - Date.now()
          minuterie = setTimeout(prend, reste > 120000 ? reste - 60000 : Math.max(1000, reste))
        },
        (e) => vivant && setErreur(e.message),
      )
    prend()
    return () => {
      vivant = false
      clearTimeout(minuterie)
    }
  }, [id, port, k.chemin, tel, envoi, tour, actions])

  const envoie = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setErreur('')
    setEnvoi(true)
    try {
      await actions.patch(id, { port: Number(f.get('port')), chemin: String(f.get('chemin') || '').trim() || '/' })
      setRegle(false)
    } catch (err) {
      setErreur(err.message)
    } finally {
      setEnvoi(false)
    }
  }

  const titre = port === null ? 'Aperçu web' : `Aperçu · 127.0.0.1:${port}`
  const formulaire = !tel && (port === null || regle)
  const outils = port !== null && !regle && (
    <>
      <button type="button" className="et-web-outil nodrag" title="Recharger l’aperçu (nouvelle adresse)" aria-label="Recharger l’aperçu" onClick={() => setTour((t) => t + 1)}>
        ↻
      </button>
      <button type="button" className="et-web-outil nodrag" title="Ouvrir dans un onglet (isolé lui aussi)" aria-label="Ouvrir dans un onglet" disabled={!apercu} onClick={() => apercu && window.open(apercu.adresse, '_blank', 'noopener')}>
        ↗
      </button>
      <button type="button" className="et-web-outil et-web-outil-mot nodrag" title="Changer de port ou de chemin" onClick={() => setRegle(true)}>
        Port
      </button>
    </>
  )

  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={titre} outils={outils}>
      {tel ? null : formulaire ? (
        <form className="et-web-form" onSubmit={envoie} onKeyDown={(e) => e.stopPropagation()}>
          <p className="et-web-aide">Un serveur de ce VPS, vu par Meydan sur 127.0.0.1 (isolé : il n’atteint ni Meydan ni ses cookies). Ports permis : 3000–3999, 5173, 8000–8099.</p>
          <label className="et-web-champ">
            <span>Port</span>
            {/* Bornes de la liste permise (lib/relais-web.mjs, PORTS_APERCU) ; le serveur refuse le reste avec la liste. */}
            <input name="port" type="number" min="3000" max="8099" required defaultValue={port ?? ''} placeholder="5173" autoFocus={regle} />
          </label>
          <label className="et-web-champ">
            <span>Chemin</span>
            <input name="chemin" type="text" maxLength={500} defaultValue={k.chemin || '/'} spellCheck={false} />
          </label>
          <div className="et-web-actions">
            <button type="submit" className="et-web-bouton" disabled={envoi}>
              {envoi ? 'Un instant…' : 'Afficher'}
            </button>
            {regle && (
              <button type="button" className="et-web-bouton et-web-discret" onClick={() => {
                  setRegle(false)
                  setErreur('')
                }}>
                Annuler
              </button>
            )}
          </div>
          {erreur && (
            <p className="et-web-erreur" role="alert">
              {erreur}
            </p>
          )}
        </form>
      ) : (
        <div className={cls('et-web-vue', !apercu && 'est-vide')}>
          {apercu ? (
            <iframe className="et-web-cadre" src={apercu.adresse} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" title={`Aperçu de 127.0.0.1:${port}`} />
          ) : (
            <p className={cls('et-web-etat', erreur && 'est-erreur')} role={erreur ? 'alert' : undefined}>
              {erreur || 'Ouverture de l’aperçu…'}
            </p>
          )}
        </div>
      )}
    </Carte>
  )
})
