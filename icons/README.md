# Icons

`icon.svg` is the source. `icon-16/32/48/128.png` are rendered from it and are what
`manifest.json` points at.

The mark is a pair of braces framing a lightning bolt: code, and a boost applied to it.
Flat colour on the extension's accent `#5b5bd6`, no gradients or effects, so any
SVG-to-PNG tool will reproduce it. Open `icon.svg` in a browser at the size you want and
export, or run it through whatever converter is to hand.

At 16px the braces are close to the limit of what a stroke that thin can hold. If they
ever look muddy in the toolbar, the two knobs worth turning are the `opacity` on the
brace group and the `stroke-width`, both in `icon.svg`.
