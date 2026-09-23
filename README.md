# Biomaterial Samplebook

An interactive samplebook: a cover, then the sample photograph as a plate. Hover a specimen to lift it off the plate, click it to open its slide. Specimens with a film get a pair of arms that pop up from the bottom of the screen holding the material, followed by the description.

## Open it

- Double-click `index.html` (Chrome, Edge or Firefox), or
- `node tools/serve.mjs` and visit <http://localhost:8080>

The films are transparent VP9 WebM, which Safari does not play. Use Chrome, Edge or Firefox.

## Edit

| What | Where |
| --- | --- |
| Names, tape labels, descriptions, which specimens have a film | `js/materials.js` |
| Films (transparent `.webm`) | `assets/films/` |
| Colours, type sizes, layout | `css/style.css` |

`assets/films/*.webm` are copies of `roughtomato.webm` / `roughscoby.webm` with the faint alpha noise zeroed. To clean a new film the same way:

```bash
ffmpeg -c:v libvpx-vp9 -i input.webm -vf "format=yuva420p,lutyuv=a='if(lt(val\,18)\,0\,val)'" -c:v libvpx-vp9 -pix_fmt yuva420p -crf 28 -b:v 0 -row-mt 1 -auto-alt-ref 0 -c:a copy assets/films/output.webm
```

## Rebuild generated files

After changing `Bioimmersion Background Photo masks.svg` or the photo:

```bash
python tools/build_shapes.py
```

This smooths the traced paths into the hover outlines, cuts out each specimen (`assets/specimens/`), writes `js/shapes.js`, and resizes the plate (`assets/plate.jpg`). Add `--debug` to also write `tools/outlines_debug.jpg`.

`python tools/build_fonts.py` re-embeds Libertinus Serif (Regular + Italic) into `css/fonts.css`.
