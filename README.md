# finitecurve — TSP art on a CPU budget

> **Fork** of [koalaman/finitecurve.com](https://github.com/koalaman/finitecurve.com)
> by [vidar holen](https://www.vidarholen.net).
> A hosted version of the original runs at [finitecurve.com](https://www.finitecurve.com).
> This fork is deployed to [parttimenerd.github.io/finitecurve](https://parttimenerd.github.io/finitecurve).

TSP art style generator without the NP-hard complexity.
Upload a photo and see it drawn as a single, non-crossing line.

![A long, non-intersecting line drawing a guinea pig](public/splash.jpg)

For the algorithm details see [the blog post](https://www.vidarholen.net/contents/blog/?p=1062).

## Changes from upstream

- The C++ core has been ported to plain JavaScript (`public/oneline.js`), removing the Emscripten/WASM dependency entirely
- Added color picker UI for foreground/background colors (`material-ui-color`)
- Added pan/zoom interaction via `react-map-interaction`)
- Full React frontend implementation (upstream repo shipped only the C++ core and a stub `App.js`)

## Building

```sh
npm install
npm run build
```

Dev server:

```sh
npm start
```

## License

GNU Affero General Public License v3 (AGPL3) — same as upstream.
