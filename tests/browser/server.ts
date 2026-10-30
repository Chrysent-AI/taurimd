import { createServer } from 'vite';
export default async function setup() {
  const server = await createServer({
    configFile: false,
    server: {
      host: '127.0.0.1',
      port: 0,
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
      },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
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
