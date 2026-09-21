/* Lets Node run the browser modules unchanged.
 *
 * web/clip.js says `import * as THREE from 'three'`, which the browser
 * resolves through the import map in index.html. Node has no import map, so
 * this hook answers the same two names with the same vendored files. The
 * tests therefore exercise the real file the browser loads, not a copy.
 */

export function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: new URL('../web/vendor/three.module.js', import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith('three/addons/')) {
    const rest = specifier.slice('three/addons/'.length);
    return { url: new URL('../web/vendor/' + rest, import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith('/web/')) {
    return { url: new URL('..' + specifier, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
