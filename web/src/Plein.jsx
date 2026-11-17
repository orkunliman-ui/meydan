import { useRef, useState } from 'react'
import { Term } from './differe.js' // xterm à part (differe.js)
import { Barre, Terminee } from './Board.jsx'
import { aUnFil, Discussion } from './Discussion.jsx'
import { MenuLigne } from './Rail.jsx'
import { useDepot } from './envoi.js'
import { useTaille } from './tailles.jsx'
import { cls, useSizeOf } from './lib.js'

// Une console agrandie, sur l'ordinateur : toute la place à droite de la colonne, qui sert alors à passer d'une console
// à l'autre (Orkun, 11/11 : « mettre en grand écran une fenetre dans le meydan […] que ca couvre toute la partie hors
// barre latérale qui servira de switch »). Même barre que sa dalle, avec « Réduire » ; discussion ou terminal comme sur
// le plateau (le même choix, retenu par console). Sa dalle se retire du plateau pendant ce temps : deux affichages d'une
// même console se disputeraient sa taille (tmux n'en garde qu'une, celle du dernier qui a parlé).
// `voisines` : les autres consoles (le menu du clic droit peut leur passer la dernière réponse).
export function Plein({ c, actions, look, vue, voisines = [] }) {
  const rev = look.theme === 'reverbere'
  // `?reel3=oui` (volet design-3-plans, à l'essai) : la console posée en carte, la barre à cheval sur son bord haut, et
  // quand l'agent attend, une touche Entrée jaune à cheval sur son bord bas (le seul jaune qui se touche dans la console).
  const reel3 = rev && look.reel3 === 'oui'
  const [menu, setMenu] = useState(null) // clic droit sur la barre : le menu de la console
  const [boite, setBoite] = useState(null)
  const taille = useSizeOf(boite)
  // Coller (Ctrl+V) ou glisser un fichier sur le terminal : il part au VPS et son chemin s'écrit dans la console.
  const termApi = useRef(null)
  const depot = useDepot(c.id, termApi)
  // La taille du texte de cette console (A− / A+ de la barre), la même que sur sa dalle (Orkun, 11/11 : « Taille du
  // texte par console (A− / A+ dans la barre de la dalle, retenue par console). »).
  const base = useTaille(c.id)
  const v = aUnFil(c) && c.status !== 'closed' ? vue : undefined
  const enFil = v === 'fil' && c.status !== 'closed'
  return (
    <section className={cls('plein slab is-active', `is-${c.status}`, enFil && 'en-fil')} data-id={c.id} aria-label={`${c.name}, agrandie`}>
      <Barre c={c} active actions={actions} rev={rev} plein vue={v} onMenu={setMenu} />
      {menu && <MenuLigne c={c} x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} onPick={(id) => actions.agrandit(id)} voisines={voisines} />}
      {c.status === 'closed' ? (
        <div className="slab-body">
          <Terminee c={c} actions={actions} />
        </div>
      ) : enFil ? (
        <div className="slab-body">
          <Discussion key={c.id} c={c} actions={actions} focus />
        </div>
      ) : (
        <div className="slab-body" onPasteCapture={depot.onPasteCapture} onDragOver={depot.onDragOver} onDrop={depot.onDrop}>
          <div className="plein-term" ref={setBoite}>
            {taille && taille.w > 0 && <Term key={c.id} id={c.id} width={taille.w} height={taille.h} active look={rev ? `reverbere-${look.appel}` : 'tapis'} apiRef={termApi} base={base} gl />}
          </div>
          {depot.etat && <p className={cls('depot', depot.etat.echec && 'est-echec')}>{depot.etat.texte}</p>}
        </div>
      )}
      {reel3 && c.status === 'needs' && !enFil && (
        // Même chemin que la touche Entrée du téléphone (MobileConsole.jsx) : `send('\r')` à l'appui, sans prendre le
        // focus au terminal ; à la souris, le bouton principal seulement (un clic droit n'envoie rien). Au clavier (Tab
        // puis Entrée/Espace), le clic sans pointeur (`detail` 0) fait la même chose.
        <button
          type="button"
          className="plein-entree"
          title="Entrée : valide le choix surligné dans le terminal"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            termApi.current?.send('\r')
          }}
          onClick={(e) => e.detail === 0 && termApi.current?.send('\r')}
        >
          Entrée
        </button>
      )}
    </section>
  )
}
