# Browser support

The site needs **Safari 16.4 or later** (iOS 16.4 / macOS Ventura 13.3): Tailwind CSS v4 relies on
`@property`, `color-mix()` and cascade layers, which arrived in Safari 16.4; and the shelf is
drawn with **WebGL 2** (Safari 15+), with a static list of flat spines if it is unavailable. For
Safari there is also no CSS mask on the shelf's wrapper (a WebGL canvas inside a masked ancestor
composites as opaque black there): the shelf's side and bottom fades are page-colour overlays
drawn over the canvas, the canvas is cleared to transparent explicitly, and `overflow: clip` has
an `overflow: hidden` fallback. Chrome and Edge 111+ and Firefox 128+ are fine.
