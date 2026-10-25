import net from 'node:net';

export interface TcpProxy {
  port: number;
  /** Derruba todas as conexões abertas e recusa as novas: para o cliente, o banco some. */
  cut(): void;
  /** Volta a aceitar conexões (o banco "volta"). */
  restore(): void;
  close(): Promise<void>;
}

/** Encaminhador TCP mínimo na frente do Postgres, usado para deixar o banco indisponível sob demanda para um processo filho. */
export async function startTcpProxy(target = { host: '127.0.0.1', port: 5432 }): Promise<TcpProxy> {
  let up = true;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    if (!up) {
      client.destroy();
      return;
    }
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    cut() {
      up = false;
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    restore() {
      up = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        up = false;
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
