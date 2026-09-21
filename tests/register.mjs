/* Hooks the resolver in, so `node --import ./tests/register.mjs` can run a
 * browser module straight out of web/ with no build step and no npm install. */
import { register } from 'node:module';
register('./resolver.mjs', import.meta.url);
