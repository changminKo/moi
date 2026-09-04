/**
 * Listening, waiting and stopping: the process and socket plumbing the e2e
 * harness needs around the system under test, lifted out of `start-system.ts`
 * to keep that file's size in hand (Codex review of #25). Pure moves — no
 * behaviour changed, and nothing here reads harness state.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

/** Binds on loopback, rejecting rather than hanging when the port is taken. */
export async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

/**
 * Fails the run at startup rather than midway through a journey. A peer's
 * harness on the same machine is the usual cause of a collision.
 */
export async function assertPortFree(port: number): Promise<void> {
  const probe = createServer();
  await listen(probe, port);
  await new Promise<void>((resolveClose, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClose())),
  );
}

export async function runPnpm(
  workspaceRoot: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('pnpm', [...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        VITE_MOI_ALLOW_LOCAL_HTTP: 'true',
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`pnpm ${args.join(' ')} exited ${code}`)),
    );
  });
}

export async function waitForWeb(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The condition is polled until the bounded readiness deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`web server at ${origin} did not become ready`);
}

/** SIGTERM, then SIGKILL after a grace period. */
export async function stopChild(
  child: ChildProcess | undefined,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    child.once('exit', () => resolveExit()),
  );
  child.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), 5_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!graceful) {
    child.kill('SIGKILL');
    await exited;
  }
}

/** Teardown never aborts on one failed step; it reports and carries on. */
export async function settle(
  work: (() => Promise<unknown>) | undefined,
): Promise<void> {
  if (!work) return;
  try {
    await work();
  } catch (error) {
    console.error('E2E teardown step failed', error);
  }
}
