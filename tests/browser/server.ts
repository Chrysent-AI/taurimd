import { createServer } from 'vite';
export default async function setup() {
  const server = await createServer({
    configFile: false,
    // Pre-optimize the worker's runtime imports so its first parse cannot
    // trigger a dev-server reload that discards the queued native double.
    optimizeDeps: {
      include: [
        'marked',
        'marked-footnote',
        'highlight.js/lib/common',
        'js-yaml',
        'mermaid',
      ],
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src reader-media: http://reader-media.localhost; media-src reader-media: http://reader-media.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
      },
    },
  });
  // Vite 8's server.listen treats port 0 as its default port. Its exposed
  // Node server retains Vite's initialization wrapper and honors kernel port 0.
  const httpServer = server.httpServer;
  if (!httpServer) {
    await server.close();
    throw new Error('Browser fixture HTTP server missing');
  }
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('Browser fixture did not bind a TCP port');
  }
  process.env.MDVIEWERRSX_TEST_URL = `http://127.0.0.1:${String(address.port)}`;
  return async () => {
    await server.close();
    if (server.httpServer?.listening)
      throw new Error('Browser fixture server was not reaped');
  };
}
