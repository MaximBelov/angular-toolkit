# @your-org/cordova-esbuild-builders

Angular Architect builders for **Ionic/Cordova** projects that use the modern
**esbuild** pipeline (`@angular-devkit/build-angular:application` +
`@angular-devkit/build-angular:dev-server`) instead of the legacy webpack stack.

Mirrors the logic of `@ionic/angular-toolkit`'s `cordova-serve` / `cordova-build`
webpack builders but targets Angular 17+.

---

## Builders

| Name | Description |
|---|---|
| `cordova-build` | Wraps the esbuild `application` builder and copies Cordova platform assets after every build. |
| `cordova-serve` | Wraps the esbuild `dev-server` builder with **live-reload** and Cordova asset injection. |

---

## Installation

```bash
npm install @your-org/cordova-esbuild-builders --save-dev
```

---

## Quick setup

Add the targets to your `angular.json` (see `angular-json-example.json` for a
complete example):

```jsonc
"ionic-cordova-build": {
  "builder": "@your-org/cordova-esbuild-builders:cordova-build",
  "options": {
    "browserTarget": "app:build",
    "platform": "android"
  },
  "configurations": {
    "production": { "browserTarget": "app:build:production" }
  }
},

"ionic-cordova-serve": {
  "builder": "@your-org/cordova-esbuild-builders:cordova-serve",
  "options": {
    "cordovaBuildTarget": "app:ionic-cordova-build",
    "devServerTarget": "app:serve",
    "host": "0.0.0.0",
    "port": 8100,
    "platform": "android",
    "consolelogs": true
  }
}
```

Then run with the Ionic CLI:

```bash
ionic cordova run android --livereload
# or directly with the Angular CLI:
ng run app:ionic-cordova-serve
ng run app:ionic-cordova-serve --host=0.0.0.0 --port=8100 --platform=ios
```

---

## How live-reload works

```
┌──────────────────────────────────────────────────────────┐
│  ionic cordova run android --livereload                  │
│       │                                                  │
│       ▼                                                  │
│  ng run app:ionic-cordova-serve                          │
│       │                                                  │
│       ▼                                                  │
│  [cordova-serve builder]                                 │
│   ├─ schedules dev-server target (esbuild)  ────────┐    │
│   │   └─ builds app, watches for changes            │    │
│   │                                                 │    │
│   ├─ copies cordova.js + plugin JS to www/     ◄────┘    │
│   │   (on first ready + every rebuild)                   │
│   │                                                 │    │
│   ├─ starts console-log relay (optional)               │ │
│   │                                                     │
│   └─ yields { success, baseUrl } to Ionic CLI           │
│         Ionic CLI configures the Cordova WebView to     │
│         load from http://<host>:<port>                  │
│         → WebView auto-reloads on each rebuild          │
└──────────────────────────────────────────────────────────┘
```

### Key differences from the webpack builder

| | webpack (`@ionic/angular-toolkit`) | esbuild (this package) |
|---|---|---|
| Builder base | `DevServerBuilder` (class extension) | `scheduleTarget` delegation |
| Config patching | Overrides `buildWebpackConfig()` | Passes override options to target |
| Asset serving | webpack-dev-server in-memory | esbuild serves from disk |
| Cordova assets | Injected into webpack config | Copied to output dir on each build |
| Angular version | ≤ 16 | 17+ |

---

## Options

### `cordova-build`

| Option | Type | Default | Description |
|---|---|---|---|
| `browserTarget` | `string` | **required** | The Angular build target to wrap (must use `application` builder). |
| `platform` | `string` | `""` | Cordova platform (`android`, `ios`, `browser`). |
| `cordovaAssets` | `boolean` | `true` | Copy `platform_www` and `plugins` after each build. |
| `cordovaBasePath` | `string` | `""` | Path to the Cordova project root (defaults to workspace root). |

### `cordova-serve`

| Option | Type | Default | Description |
|---|---|---|---|
| `cordovaBuildTarget` | `string` | **required** | The `cordova-build` target (used to read `cordovaBasePath`). |
| `devServerTarget` | `string` | **required** | The Angular dev-server target to wrap. |
| `host` | `string` | `"localhost"` | Dev-server host. Use `0.0.0.0` for device access. |
| `port` | `number` | `4200` | Dev-server port. |
| `ssl` | `boolean` | `false` | Serve over HTTPS. |
| `open` | `boolean` | `false` | Open browser tab. |
| `platform` | `string` | `""` | Cordova platform. |
| `consolelogs` | `boolean` | `false` | Start console-log relay server. |
| `consolelogsPort` | `number` | `53703` | Port for the console-log relay. |

---

## Building the package

```bash
npm install
npx tsc -p tsconfig.json
```

The compiled output in `dist/` is what gets published / symlinked.
