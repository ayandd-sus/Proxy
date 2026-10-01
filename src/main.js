import { createProxyServer } from './proxy-server.js';
import { getConfig, loadEnvFile } from './config.js';

try {
    loadEnvFile();
    const config = getConfig();
    const server = createProxyServer(config);

    server.on('error', (error) => {
        console.error(`[proxy] server error: ${error.message}`);
        process.exitCode = 1;
    });

    server.listen(config.proxyPort, config.proxyHost, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : config.proxyPort;
        console.info(`[proxy] listening on http://${config.proxyHost}:${port}/v1`);
        console.info(`[proxy] cache mode=${config.cacheMode}, cache TTL=${config.cacheTtl}, session affinity=${config.sessionAffinity ? 'on' : 'off'}`);
    });

    const shutdown = (signal) => {
        console.info(`[proxy] ${signal} received; closing server`);
        const forceExit = setTimeout(() => process.exit(1), 10_000);
        forceExit.unref();
        server.close((error) => {
            clearTimeout(forceExit);
            if (error) {
                console.error(`[proxy] shutdown error: ${error.message}`);
                process.exitCode = 1;
            }
        });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
    console.error(`[proxy] configuration error: ${error.message}`);
    process.exitCode = 1;
}
