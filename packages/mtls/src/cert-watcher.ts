import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { Server as TlsServer } from "node:tls";
import { buildSecureContext } from "./server-options";
import type { MtlsCertPaths } from "./types";
import { CertRotationError } from "./errors";

export interface CertWatcherOptions extends MtlsCertPaths {
  /** The running HTTPS/TLS server whose credentials should be hot-swapped on rotation. */
  server: TlsServer;
  /** Called after a successful hot-reload, with the new cert's paths — useful for logging. */
  onRotated?: (paths: MtlsCertPaths) => void;
  /** Called if a rotation attempt fails to load (e.g. rotation left a half-written file). The server keeps its previous, still-valid credentials. */
  onError?: (error: CertRotationError) => void;
  /** Debounce window in ms, since `fs.watch` can fire multiple events for one atomic file replace. Default 300ms. */
  debounceMs?: number;
}

/**
 * Watches this service's own cert/key files (and the CA file) for rotation
 * and hot-reloads a running server's TLS credentials via
 * `server.setSecureContext()` — no process restart, no dropped connections
 * for calls already in flight.
 *
 * Certificate ROTATION here means "this service's own leaf certificate was
 * reissued" (e.g. approaching its `LEAF_DAYS` expiry from
 * generate-dev-certs.sh, or a real PKI's renewal in production) — it does
 * not mean re-running the dev-cert script's CA generation, which is a
 * separate, rarer, manual operation (see that script's own idempotency
 * behavior).
 *
 * Returns a stop function; call it during graceful shutdown to close the
 * underlying `fs.watch` handles.
 */
export function watchCertsForRotation(options: CertWatcherOptions): () => void {
  const { server, certPath, keyPath, caPath, debounceMs = 300 } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const paths = { certPath, keyPath, caPath };

  const reload = () => {
    try {
      const context = buildSecureContext(paths);
      server.setSecureContext(context as unknown as Parameters<TlsServer["setSecureContext"]>[0]);
      options.onRotated?.(paths);
    } catch (cause) {
      options.onError?.(new CertRotationError(certPath, cause));
    }
  };

  const scheduleReload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  };

  const watchers: FSWatcher[] = [];
  // Watch each file individually rather than the directory: on most
  // platforms a cert-rotation tool replaces the file (rename over the old
  // one) rather than editing in place, and watching the specific path
  // catches that reliably across the two files that must change together.
  for (const p of [certPath, keyPath, caPath]) {
    watchers.push(watch(p, { persistent: false }, scheduleReload));
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
