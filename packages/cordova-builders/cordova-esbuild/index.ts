/**
 * cordova-serve builder
 *
 * Wraps @angular-devkit/build-angular:dev-server (esbuild-based) and adds:
 *   - Cordova platform asset injection (cordova.js, plugins, etc.)
 *   - LiveReload URL injection into index.html so native WebViews reload on change
 *   - Optional consolelogs server that forwards browser logs to the terminal
 *
 * Flow (mirrors the webpack-based ionic cordova-serve but adapted for esbuild):
 *   1. Resolve devServerTarget and cordovaBuildTarget options.
 *   2. Patch index.html to inject cordova.js + livereload/HMR script.
 *   3. Start the devServerTarget (esbuild dev server).
 *   4. Keep the dev server observable alive and relay its output.
 *   5. On teardown: remove patched file, stop servers.
 *
 * Usage in angular.json:
 *
 *   "ionic-cordova-serve": {
 *     "builder": "@your-org/cordova-esbuild-builders:cordova-serve",
 *     "options": {
 *       "cordovaBuildTarget": "app:ionic-cordova-build",
 *       "devServerTarget": "app:serve",
 *       "platform": "ios"
 *     },
 *     "configurations": {
 *       "production": {
 *         "cordovaBuildTarget": "app:ionic-cordova-build:production",
 *         "devServerTarget": "app:serve:production"
 *       }
 *     }
 *   }
 */

import type {
  BuilderContext,
  BuilderOutput,
  BuilderRun,
} from '@angular-devkit/architect';
import { createBuilder, targetFromTargetString } from '@angular-devkit/architect';
import type { json } from '@angular-devkit/core';
import * as net from 'net';
import * as path from 'path';
import { Observable } from 'rxjs';
import {
  checkCordovaPlatformExists,
  buildLivereloadUrl,
} from './utils';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export interface CordovaServeSchema {
  cordovaBuildTarget: string;
  devServerTarget: string;
  platform?: string;
  host?: string;
  port?: number;
  ssl?: boolean;
  livereload?: boolean;
  livereloadUrl?: string;
  consolelogs?: boolean;
  consolelogsPort?: number;
  cordovaBasePath?: string;
  cordovaAssetsDir?: string;
  proxyConfig?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Console log server
// ─────────────────────────────────────────────────────────────────────────────

function startConsoleLogsServer(port: number, context: BuilderContext): net.Server {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as { type?: string; message?: string };
          const type = msg.type ?? 'log';
          const message = msg.message ?? trimmed;
          if (type === 'error') context.logger.error(`[app] ${message}`);
          else if (type === 'warn') context.logger.warn(`[app] ${message}`);
          else context.logger.info(`[app] ${message}`);
        } catch {
          context.logger.info(`[app] ${trimmed}`);
        }
      }
    });
    socket.on('error', () => socket.destroy());
  });

  server.listen(port, '0.0.0.0', () => {
    context.logger.info(`Console log server listening on port ${port}`);
  });
  server.on('error', (err) => {
    context.logger.warn(`Console log server error: ${err.message}`);
  });
  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Index.html patching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the HTML snippet injected into index.html:
 *  - cordova.js script (resolved by native WebView)
 *  - livereload via esbuild EventSource (__esbuild_hmr) with polling fallback
 *  - optional consolelogs forwarder
 */
function buildInjectedHeadContent(opts: {
  livereload: boolean;
  livereloadUrl: string;
  consolelogs: boolean;
  consolelogsPort: number;
  platform: string;
}): string {
  const lines: string[] = [
    `    <!-- Injected by @your-org/cordova-esbuild-builders (${opts.platform}) -->`,
    `    <script src="cordova.js"></script>`,
  ];

  if (opts.livereload) {
    lines.push(`    <script>
      /* cordova-esbuild livereload */
      (function() {
        var LR_URL = '${opts.livereloadUrl}';
        var POLL_MS = 2000;
        var lastEtag = null;

        /* ── EventSource / HMR (esbuild dev server) ── */
        function connectHMR() {
          var es = new EventSource(LR_URL + '/__esbuild_hmr');
          es.addEventListener('change', function(e) {
            var data;
            try { data = JSON.parse(e.data); } catch(ex) { data = {}; }
            if (data.added || data.removed || data.updated) {
              window.location.reload();
            }
          });
          es.onerror = function() {
            es.close();
            setTimeout(connectHMR, POLL_MS);
          };
        }

        /* ── Polling fallback (for devices that don't support EventSource well) ── */
        function startPolling() {
          setInterval(function() {
            fetch(LR_URL + '/', { method: 'HEAD', cache: 'no-store' })
              .then(function(r) {
                var etag = r.headers.get('ETag') || r.headers.get('Last-Modified') || '';
                if (lastEtag !== null && etag !== lastEtag) {
                  window.location.reload();
                }
                lastEtag = etag;
              })
              .catch(function() { /* server not ready */ });
          }, POLL_MS);
        }

        if (typeof EventSource !== 'undefined') {
          connectHMR();
        } else {
          startPolling();
        }
      })();
    </script>`);
  }

  if (opts.consolelogs) {
    lines.push(`    <script>
      /* cordova-esbuild consolelogs forwarder */
      (function() {
        var _c = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
        var host = location.hostname;
        var port = ${opts.consolelogsPort};

        function send(type, args) {
          var msg = JSON.stringify({ type: type, message: Array.prototype.join.call(args, ' ') });
          try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'http://' + host + ':' + port, true);
            xhr.send(msg);
          } catch(e) {}
        }

        console.log   = function() { _c.log.apply(console, arguments);   send('log',   arguments); };
        console.warn  = function() { _c.warn.apply(console, arguments);  send('warn',  arguments); };
        console.error = function() { _c.error.apply(console, arguments); send('error', arguments); };
      })();
    </script>`);
  }

  return lines.join('\n');
}

export function patchIndexHtml(html: string, injection: string): string {
  if (html.includes('</head>')) {
    return html.replace('</head>', `${injection}\n  </head>`);
  }
  if (html.includes('<body>')) {
    return html.replace('<body>', `<body>\n${injection}`);
  }
  return injection + '\n' + html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main builder
// ─────────────────────────────────────────────────────────────────────────────

export function serveCordova(
  options: CordovaServeSchema,
  context: BuilderContext,
): Observable<BuilderOutput> {
  return new Observable<BuilderOutput>((subscriber) => {
    const platform        = options.platform        ?? 'ios';
    const host            = options.host            ?? 'localhost';
    const port            = options.port            ?? 8100;
    const ssl             = options.ssl             ?? false;
    const livereload      = options.livereload      ?? true;
    const consolelogs     = options.consolelogs     ?? false;
    const consolelogsPort = options.consolelogsPort ?? 53703;
    const workspaceRoot   = context.workspaceRoot;

    // Validate platform
    if (!checkCordovaPlatformExists(platform, workspaceRoot)) {
      context.logger.warn(
        `Cordova platform 'platforms/${platform}' not found. ` +
        `Run 'ionic cordova platform add ${platform}' first.`,
      );
    }

    const livereloadUrl = buildLivereloadUrl(host, port, ssl, options.livereloadUrl);

    context.logger.info(`Starting Cordova esbuild dev server for platform: ${platform}`);
    context.logger.info(`LiveReload URL: ${livereloadUrl}`);

    // Optional console log server
    let consoleServer: net.Server | undefined;
    if (consolelogs) {
      consoleServer = startConsoleLogsServer(consolelogsPort, context);
    }

    const devServerTarget = targetFromTargetString(options.devServerTarget);
    let devServerRun: BuilderRun | undefined;
    let patchedIndexPath: string | undefined;

    const cleanup = async () => {
      if (patchedIndexPath) {
        try {
          const fs = await import('fs/promises');
          await fs.unlink(patchedIndexPath);
          context.logger.debug(`Removed patched index.html: ${patchedIndexPath}`);
        } catch { /* ignore */ }
      }
      consoleServer?.close();
      await devServerRun?.stop();
    };

    // Async bootstrap
    (async () => {
      try {
        const fs = await import('fs/promises');

        // ── Resolve devServer options ──────────────────────────────────────
        const rawDevServerOptions = (await context.getTargetOptions(devServerTarget)) as Record<string, unknown>;

        const devServerOverrides: Record<string, unknown> = { host, port, ssl };
        if (options.proxyConfig) {
          devServerOverrides['proxyConfig'] = options.proxyConfig;
        }

        // ── Find the referenced browser/application builder target ─────────
        // Angular 17 dev-server uses 'buildTarget'; older versions use 'browserTarget'.
        const browserTargetStr =
          (rawDevServerOptions['buildTarget'] as string | undefined) ??
          (rawDevServerOptions['browserTarget'] as string | undefined);

        if (browserTargetStr) {
          const browserTarget = targetFromTargetString(browserTargetStr);
          const rawBrowserOptions = (await context.getTargetOptions(browserTarget)) as Record<string, unknown>;

          // Find the index.html source path
          // 'index' may be a string path or an object { input, output }
          let indexSourceRelative: string;
          const indexOption = rawBrowserOptions['index'];
          if (typeof indexOption === 'string') {
            indexSourceRelative = indexOption;
          } else if (indexOption && typeof indexOption === 'object' && 'input' in (indexOption as object)) {
            indexSourceRelative = (indexOption as { input: string }).input;
          } else {
            indexSourceRelative = 'src/index.html';
          }

          const absoluteIndexPath = path.resolve(workspaceRoot, indexSourceRelative);
          const injection = buildInjectedHeadContent({
            livereload, livereloadUrl, consolelogs, consolelogsPort, platform,
          });

          try {
            const originalContent = await fs.readFile(absoluteIndexPath, 'utf8');
            const patched = patchIndexHtml(originalContent, injection);

            // Write patched file alongside the original
            const dir = path.dirname(absoluteIndexPath);
            patchedIndexPath = path.join(dir, '_cordova_dev_index.html');
            await fs.writeFile(patchedIndexPath, patched, 'utf8');

            context.logger.debug(`Patched index written to: ${patchedIndexPath}`);

            // Point the dev server at the patched index
            // Angular 17+ application builder uses the 'index' option on both
            // the build target and dev-server (via buildTarget reference).
            // The safest way is to override it on the devServer level.
            const relPatchedPath = path.relative(workspaceRoot, patchedIndexPath);
            devServerOverrides['index'] = relPatchedPath;
          } catch (e) {
            context.logger.warn(
              `Could not patch index.html (${(e as Error).message}). ` +
              `Add <script src="cordova.js"></script> to index.html manually.`,
            );
          }
        } else {
          context.logger.warn(
            'Could not determine buildTarget/browserTarget from devServerTarget. ' +
            'Cordova injection skipped.',
          );
        }

        // ── Start the dev server ───────────────────────────────────────────
        devServerRun = await context.scheduleTarget(
          devServerTarget,
          devServerOverrides as json.JsonObject,
        );

        context.logger.info(`Dev server started. Point Cordova WebView to: ${livereloadUrl}`);

        devServerRun.output.subscribe({
          next: (result) => {
            if (result.success) {
              context.logger.info(`✓ Live at ${livereloadUrl}`);
            }
            subscriber.next(result);
          },
          error: async (err) => {
            await cleanup();
            subscriber.error(err);
          },
          complete: async () => {
            await cleanup();
            subscriber.complete();
          },
        });
      } catch (err) {
        await cleanup();
        subscriber.error(err);
      }
    })();

    // Teardown
    return () => { void cleanup(); };
  });
}

export default createBuilder<CordovaServeSchema>(serveCordova);
