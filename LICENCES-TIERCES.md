# Licences tierces

## FirstMate

L'équipage de Meydan (`lib/equipage.mjs`, `agents/*.md`, `bin/meydan`) reprend des idées et des formulations de FirstMate
(`kunchenguid/firstmate`, commit `913bb7a` lu le 10/11/2026) : structure du brief, verbes de statut, définition de fini,
règles de conduite du capitaine et des équipiers. Aucun de ses scripts n'est embarqué.

```
MIT License

Copyright (c) 2026 Kun Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Hangar

Le volet « livraison-equipes » (17/11/2026) reprend trois idées de Hangar (`hangar-ai/hangar`, commit `279d6ee` lu le
17/11/2026) : la file de livraison des équipiers (fusion à part, commande de vérification, relecteur au contexte neuf,
avance rapide ; `lib/livraisons.mjs`, d'après `crates/hangar-core/src/delivery.rs`), les fichiers réservés d'une tâche
(`lib/reserves.mjs` : la lecture des motifs et leur chevauchement sont portés en JavaScript depuis
`crates/hangar-core/src/delivery/owns.rs` et `crates/hangar-core/src/board.rs`, avec leurs tables d'essai) et un bloc de
20 ports par équipier (`lib/ports.mjs`, d'après `crates/hangar-core/src/pty.rs`). Aucun de ses fichiers n'est embarqué.

```
MIT License

Copyright (c) 2026 simnJS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Iosevka (police « Iosevka UI »)

`web/src/fonts/IosevkaUI-Regular.woff` et `IosevkaUI-Bold.woff` sont un sous-ensemble d'Iosevka 22.1.2 (Renzhi Li,
`be5invis/Iosevka`), tiré des fichiers du paquet `@fontsource/iosevka` 5.3.0 par `scripts/police-ui.py` (11/11/2026) :
seuls des caractères et des variantes de style sont retirés, les dessins sont ceux d'origine. C'est une « Modified
Version » au sens de la licence ci-dessous, distribuée sous la même licence. Sa ligne de copyright ne nomme aucun
« Reserved Font Name » : le nom « Iosevka » peut rester. Le copyright et la licence sont aussi gardés dans la table
`name` de chaque fichier (noms 0, 13 et 14). L'Iosevka complète du terminal vient du même paquet, inchangée.

```
Copyright (c) 2015-2023, Renzhi Li (aka. Belleve Invis, belleve@typeof.net)

This Font Software is licensed under the SIL Open Font License, Version 1.1.

This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

--------------------------


SIL Open Font License v1.1
====================================================


Preamble
----------

The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.


Definitions
-------------

`"Font Software"` refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

`"Reserved Font Name"` refers to any names specified as such after the
copyright statement(s).

`"Original Version"` refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

`"Modified Version"` refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

`"Author"` refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.


Permission & Conditions
------------------------

Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1. Neither the Font Software nor any of its individual components,
   in Original or Modified Versions, may be sold by itself.

2. Original or Modified Versions of the Font Software may be bundled,
   redistributed and/or sold with any software, provided that each copy
   contains the above copyright notice and this license. These can be
   included either as stand-alone text files, human-readable headers or
   in the appropriate machine-readable metadata fields within text or
   binary files as long as those fields can be easily viewed by the user.

3. No Modified Version of the Font Software may use the Reserved Font
   Name(s) unless explicit written permission is granted by the corresponding
   Copyright Holder. This restriction only applies to the primary font name as
   presented to the users.

4. The name(s) of the Copyright Holder(s) or the Author(s) of the Font
   Software shall not be used to promote, endorse or advertise any
   Modified Version, except to acknowledge the contribution(s) of the
   Copyright Holder(s) and the Author(s) or with their explicit written
   permission.

5. The Font Software, modified or unmodified, in part or in whole,
   must be distributed entirely under this license, and must not be
   distributed under any other license. The requirement for fonts to
   remain under this license does not apply to any document created
   using the Font Software.



Termination
-----------

This license becomes null and void if any of the above conditions are
not met.


    DISCLAIMER
    
    THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
    OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
    COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
    INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
    DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
    OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Warp — retours d’agents

Les skills `agents/skills/plainte` et `agents/skills/suggestion` adaptent `complain` et `suggestion-box` de [Warp](https://github.com/warpdotdev/common-skills). Copyright (c) 2026 Denver Technologies, Inc. Licence MIT intégrale conservée dans chaque dossier `LICENSE`. Le transport JSON local de Meydan est écrit pour ce lot ; aucun code Paperclip n’est embarqué.
