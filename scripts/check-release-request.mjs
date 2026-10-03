import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePackages } from './release-contract.mjs';
const packages = releasePackages(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REPOSITORY !== 'Super-Solution/super-editor' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Use workflow_dispatch on Super-Solution/super-editor main.');
if (process.env.RELEASE_VERSION !== packages[0].version || process.env.RELEASE_CHANNEL !== packages[0].channel) throw new Error('Requested version/channel must exactly match the committed package metadata.');
console.log(`Release request matches ${packages[0].version} / ${packages[0].channel}.`);
