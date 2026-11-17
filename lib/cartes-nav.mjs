// La carte « Navigateur · <console> » (volet copies, 13/11) : ce que voit le navigateur piloté par l'agent d'une console
// (lib/navigateur.mjs), inscrite au registre des types de cartes (lib/cartes.mjs) comme les types du plateau créatif.
// Elle est POSÉE PAR LE SERVEUR seulement (`serveurSeul`) : au premier `meydan nav ouvre` d'une console (creeNav de
// lib/cartes.mjs), retirée avec la console (retireNav). Une page ne la crée pas (POST /api/cartes refusé : une carte
// Navigateur sans console n'a pas de sens, et sa console ne vient jamais de la page) ; Orkun la déplace, la redimensionne
// ou la retire comme les autres, et sa console ne change jamais (aucun champ propre ne se pose par l'API).
export function typesNav() {
  return {
    nav: {
      taille: { w: 820, h: 560, min: { w: 320, h: 220 } },
      serveurSeul: true,
      defaut: () => ({ console: '' }),
      applique() {}, // rien de propre à poser par l'API (la console reste celle que le serveur a posée)
    },
  }
}
