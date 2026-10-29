const { execFileSync } = require('node:child_process');
const packageJson = require('./package.json');

function getRepositorySlug() {
  const candidates = [process.env.GITHUB_REPOSITORY, process.env.PRINTSHOT_GITHUB_REPOSITORY];
  try {
    candidates.push(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {}

  for (const value of candidates) {
    if (!value) continue;
    const slug = value.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
    if (slug) return { owner: slug[1], repo: slug[2] };
    const url = value.trim().match(/github\.com[:/]([^/\s:]+)\/([^/\s?#]+?)(?:\.git)?(?:[?#].*)?$/i);
    if (url) return { owner: url[1], repo: url[2] };
  }
  return null;
}

const config = { ...packageJson.build };
const repository = getRepositorySlug();
config.publish = repository
  ? [{ provider: 'github', ...repository, releaseType: 'release' }]
  : [];

module.exports = config;
