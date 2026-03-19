import { loadConfig } from './config.js';
import { createPool, verifyConnection, shutdownPool } from './db/client.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: 'main', message: 'Configuration loaded' }));

  const pool = createPool(config);

  try {
    await verifyConnection(pool);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: 'main', message: 'Database connected' }));

    const result = await runMigrations(pool);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'main',
      message: `Migrations complete: ${result.applied.length} applied, ${result.total} total`,
      applied: result.applied,
    }));

    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: 'main', message: 'Ready' }));

    // Keep process alive until shutdown signal
    const shutdown = async (signal: string) => {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: 'main', message: `Received ${signal}, shutting down` }));
      await shutdownPool(pool);
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'main',
      message: `Startup failed: ${err instanceof Error ? err.message : err}`,
    }));
    await shutdownPool(pool);
    process.exit(1);
  }
}

main();
