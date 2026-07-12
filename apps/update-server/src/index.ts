import { createApp } from './app.js';
import { config, validateConfig } from './config.js';
import { getReleases, startRefreshInterval } from './github.js';

async function start() {
  // Fail fast on missing required configuration (e.g. PUBLIC_URL in prod).
  try {
    validateConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Initial fetch of releases
  console.log('Fetching initial releases...');
  try {
    const releases = await getReleases();
    console.log(`Loaded ${releases.length} releases`);
  } catch (error) {
    console.error('Failed to fetch initial releases:', error);
    process.exit(1);
  }

  // Start background refresh
  startRefreshInterval();

  // Start server
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Update server running on port ${config.port}`);
    console.log(`App name: ${config.appName}`);
    console.log(`GitHub: ${config.githubOrg}/${config.githubRepo}`);
  });
}

start();
