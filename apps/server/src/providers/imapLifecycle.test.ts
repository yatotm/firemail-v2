import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';

type Scenario = 'auth-close' | 'command-close' | 'late-errors' | 'ok';

async function runScenario(t: TestContext, scenario: Scenario): Promise<void> {
  const sockets = new Set<Socket>();
  let authentications = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR NAMESPACE] test ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const [tag, command] = buffer.slice(0, end).split(' ');
        buffer = buffer.slice(end + 2);
        switch (command) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR NAMESPACE\r\n${tag} OK complete\r\n`);
            break;
          case 'AUTHENTICATE':
            authentications++;
            if (scenario === 'auth-close') socket.destroy();
            else socket.write(`${tag} OK authenticated\r\n`);
            break;
          case 'NAMESPACE':
            socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK complete\r\n`);
            break;
          case 'NOOP':
            socket.write(`${tag} OK complete\r\n`);
            break;
          case 'LIST':
            socket.destroy();
            break;
          case 'LOGOUT':
            socket.end(`* BYE closing\r\n${tag} OK complete\r\n`);
            break;
          default:
            socket.write(`${tag} BAD unexpected command\r\n`);
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  // 子进程让迟到的未处理错误真正导致退出，不被测试运行器的监听器遮住。
  const source = `
    import assert from 'node:assert/strict';
    import { GenericImapProvider } from ${JSON.stringify(new URL('./genericImap.ts', import.meta.url).href)};
    const provider = new GenericImapProvider({
      credentials: { resolve: async () => ({ kind: 'password', user: 'test@example.invalid', pass: 'test-only' }) },
      timeouts: { connectionMs: 3000, greetingMs: 3000, socketMs: 3000 },
    });
    const account = { id: 1, email: 'test@example.invalid', provider: 'imap', authType: 'password',
      imapHost: '127.0.0.1', imapPort: ${address.port}, imapSecure: false };
    const scenario = ${JSON.stringify(scenario)};
    if (scenario === 'auth-close') {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(provider.connectImap(account), { name: 'ProviderError', credentialsResolved: true });
      }
    } else {
      const client = await provider.connectImap(account);
      try {
        assert.equal(client.usable, true);
        if (scenario === 'command-close') {
          await assert.rejects(client.list({ listOnly: true }), { code: 'NoConnection' });
        } else if (scenario === 'late-errors') {
          client.close();
          client.emit('error', new Error('first delayed error'));
          client.emit('error', new Error('second delayed error'));
          await assert.rejects(client.noop(), { code: 'NoConnection' });
        } else {
          await client.noop();
          await client.logout();
        }
      } finally {
        client.close();
      }
    }
    console.log('completed');
  `;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // 不把库的错误对象或认证帧带进断言输出。
  assert.equal(exit.code, 0, `IMAP 子进程异常退出:signal=${exit.signal}, NoConnection=${stderr.includes('NoConnection')}`);
  assert.equal(stdout.trim(), 'completed');
  assert.equal(authentications, scenario === 'auth-close' ? 2 : 1);
}

for (const [scenario, title] of [
  ['auth-close', '认证中断的 Promise 保留失败标记，迟到错误不退出进程且可继续重试'],
  ['command-close', '认证后的命令断连仍然拒绝 Promise'],
  ['late-errors', '关闭后多次迟到错误仍由同一连接承接'],
  ['ok', '正常认证、命令和退出保持可用'],
] as const) {
  test(title, { timeout: 15_000 }, async (t) => runScenario(t, scenario));
}
