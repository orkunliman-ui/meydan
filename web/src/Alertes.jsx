import { useEffect, useState } from 'react'
import { api } from './lib.js'

// Notifications de cet appareil : être prévenu quand un agent t'attend, appli fermée (lib/alertes.mjs côté serveur,
// public/sw.js). Sur iPhone, seulement dans Meydan ouvert depuis l'écran d'accueil (Safari seul n'a pas les
// notifications). « Activées » n'est écrit qu'après la notification d'essai acceptée par le service.
const possible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const versCle = (s) => {
  const brut = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(brut, (c) => c.charCodeAt(0))
}

// États : 'lecture' | 'impossible' | 'refusees' | 'non' | 'oui' | 'perdue' (abonné ici, oublié du serveur) | 'occupe' | 'erreur'.
export function useAlertes() {
  const [etat, setEtat] = useState('lecture')
  const [cle, setCle] = useState(null)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    let mort = false
    api('GET', '/api/alertes').then(
      async (j) => {
        if (mort) return
        if (!j.cle || !possible()) return setEtat('impossible')
        setCle(j.cle)
        if (Notification.permission === 'denied') return setEtat('refusees')
        const abo = await navigator.serviceWorker.getRegistration('/').then((r) => r?.pushManager.getSubscription()).catch(() => null)
        if (!abo || Notification.permission !== 'granted') return !mort && setEtat('non')
        // L'abonnement de l'appareil ne suffit pas : le serveur retire une adresse que le service déclare morte (404 / 410),
        // et l'écran disait encore « Activées » alors que plus rien ne partait (chasse du 17/11). On lui demande.
        const { connu } = await api('POST', '/api/alertes/connu', { endpoint: abo.endpoint }).catch(() => ({ connu: true }))
        if (!mort) setEtat(connu ? 'oui' : 'perdue')
      },
      () => !mort && setEtat('impossible'),
    )
    return () => {
      mort = true
    }
  }, [])
  const activer = async () => {
    setEtat('occupe')
    setErreur('')
    try {
      // iPhone : la demande d'accord doit partir du toucher lui-même, avant toute autre attente.
      const accord = await Notification.requestPermission()
      if (accord !== 'granted') return setEtat(accord === 'denied' ? 'refusees' : 'non')
      await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      const reg = await navigator.serviceWorker.ready
      const abo = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: versCle(cle) }))
      try {
        await api('POST', '/api/alertes', { abonnement: abo.toJSON() })
      } catch (e) {
        await abo.unsubscribe().catch(() => {})
        throw e
      }
      setEtat('oui')
    } catch (e) {
      setErreur(e.message)
      setEtat('erreur')
    }
  }
  const couper = async () => {
    setEtat('occupe')
    setErreur('')
    try {
      const abo = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
      if (abo) {
        await api('DELETE', '/api/alertes', { endpoint: abo.endpoint })
        await abo.unsubscribe()
      }
      setEtat('non')
    } catch (e) {
      setErreur(e.message)
      setEtat('erreur')
    }
  }
  return { etat, erreur, activer, couper }
}

const TEXTES = {
  lecture: '',
  non: 'Être prévenu sur cet appareil quand un agent t’attend, même Meydan fermé.',
  occupe: 'Un instant, le téléphone peut demander ton accord.',
  oui: 'Activées sur cet appareil : une notification quand un agent t’attend, qu’une équipe est prête ou qu’une boucle finit. Rien si Meydan est déjà à l’écran.',
  perdue: 'Plus reçues sur cet appareil : le service de notification ne le connaît plus. Réactive-les.',
  refusees: 'Refusées pour Meydan. Pour les rétablir : Réglages du téléphone, Notifications, Meydan.',
  impossible: 'Sur l’iPhone, ouvre Meydan depuis l’écran d’accueil (Partager, « Sur l’écran d’accueil ») pour activer les notifications.',
}

// Le bloc des réglages (avec l'apparence).
export function Alertes() {
  const { etat, erreur, activer, couper } = useAlertes()
  if (etat === 'lecture') return null
  return (
    <div className="alertes" role="group" aria-label="Notifications">
      <b>Notifications</b>
      <p role="status">{etat === 'erreur' ? `Échec : ${erreur}` : TEXTES[etat]}</p>
      {etat === 'oui' ? (
        <button type="button" onClick={couper}>
          Couper sur cet appareil
        </button>
      ) : etat === 'refusees' || etat === 'impossible' ? null : (
        <button type="button" className="est-appel" disabled={etat === 'occupe'} onClick={activer}>
          {etat === 'occupe' ? 'Un instant…' : etat === 'erreur' ? 'Réessayer' : etat === 'perdue' ? 'Réactiver les notifications' : 'Activer les notifications'}
        </button>
      )}
    </div>
  )
}

// Une ligne d'invitation dans la liste, tant que les notifications sont possibles ici et pas encore activées. Elle
// s'efface d'un toucher sur « Plus tard » (retenu sur l'appareil) : les réglages gardent le bouton.
export function InviteAlertes() {
  const { etat, erreur, activer } = useAlertes()
  const [cachee, setCachee] = useState(() => localStorage.getItem('meydan.alertes.invite') === 'non')
  // « perdue » : l'appareil se croyait abonné, le serveur ne l'a plus ; l'invitation revient même après « Plus tard ».
  if ((cachee && etat !== 'perdue') || !['non', 'occupe', 'erreur', 'perdue'].includes(etat)) return null
  const plusTard = () => {
    setCachee(true)
    try {
      localStorage.setItem('meydan.alertes.invite', 'non')
    } catch {} // navigation privée : l'invitation reviendra
  }
  return (
    <p className="alertes-invite">
      <span>{etat === 'erreur' ? `Notifications : échec (${erreur})` : etat === 'perdue' ? 'Notifications plus reçues ici : les réactiver ?' : 'Être prévenu quand un agent t’attend ?'}</span>
      <button type="button" className="est-appel" disabled={etat === 'occupe'} onClick={activer}>
        {etat === 'occupe' ? '…' : 'Activer'}
      </button>
      <button type="button" onClick={plusTard}>
        Plus tard
      </button>
    </p>
  )
}
