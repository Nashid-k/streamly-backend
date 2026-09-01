import { makeProviders, makeStandardFetcher } from '@movie-web/providers';
import fetch from 'node-fetch';

const fetcher = makeStandardFetcher(fetch);
const providers = makeProviders({
  fetcher,
  target: 'any'
});

async function run() {
  const media = {
    type: 'show', // or 'movie'
    title: 'Kalp Atisi',
    releaseYear: 2017,
    tmdbId: '83028',
    season: { number: 1, tmdbId: 'dummy' },
    episode: { number: 1, tmdbId: 'dummy' }
  };
  console.log("Running...");
  const output = await providers.runAll({ media });
  console.log(JSON.stringify(output, null, 2));
}
run().catch(console.error);
