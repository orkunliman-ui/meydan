import { createRoot } from 'react-dom/client'
// Les feuilles de React Flow et de xterm restent ici, avant celles de l'application, qui les surchargent à spécificité
// égale (lot5-memoire.css, entre autres) ; leurs scripts n'arrivent qu'à l'affichage du plateau ou d'un terminal (differe.js).
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import '@fontsource-variable/archivo/wdth.css'
import './styles.css'
import './reverbere.css'
// Lot du 11/11 après-midi : une feuille par chantier (fusionnées plus tard si besoin), chargées après le thème.
import './lot3-menus.css'
import './lot3-tel.css'
import './musique.css'
import './lot4-rangement.css'
import './lot4-vie.css'
import './lot5-liens.css'
import './lot5-memoire.css'
import './lot6-fini.css'
// Mémoire de projet (volet du 11/11, Memoire.jsx) : rien à voir avec lot5-memoire.css (mémoire graphique du plateau).
import './memoire-projet.css'
// Volet « comptes » (11/11) : choix du compte, usage par compte, limite d'usage atteinte.
import './comptes.css'
// Réponses parlées (11/11, volet voix) : le bouton « Écouter » du Chat et la pastille d'arrêt.
import './voix.css'
// Reel « 3 règles » (11/11) : chargée en dernier, active sous ?reel=oui (défaut), ?reel=non = l'écran d'avant.
import './reel.css'
// Volet a-iphone (11/11) : sélecteur de console dans le titre ; contexte de la question et photo en attente dans le Chat.
import './a-iphone-titre.css'
import './a-iphone-fil.css'
// Volet plateau-pc (11/11) : une feuille par lot, ordinateur seulement.
import './pc-disposition.css'
import './pc-taille.css'
// Les trois règles sur l'ordinateur et le téléphone couché (volet design-3-plans, en service depuis le 13/11), sous
// `reel3=oui` : chargée après reel.css et les feuilles des volets.
import './lot-design.css'
// Volet « raccourcis » (13/11) : touches seules et leur réglage, dispositions prêtes et repères, préréglages de groupe.
import './raccourcis.css'
import './dispositions.css'
import './groupes.css'
import './polish.css'
import './agencement.css'
import './robuste.css'
// Cibles au doigt (chasse du 17/11, téléphone) : en dernier, elle l'emporte à spécificité égale.
import './doigt.css'
import { App } from './App.jsx'
import { ecoute, Garde } from './journal.jsx'

ecoute()

createRoot(document.getElementById('root')).render(
  <Garde>
    <App />
  </Garde>,
)
