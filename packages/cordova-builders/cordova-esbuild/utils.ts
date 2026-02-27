import type { BuilderContext, Target } from '@angular-devkit/architect';
import { targetFromTargetString } from '@angular-devkit/architect';
import * as path from 'path';
import * as fs from 'fs';

export interface CordovaTargetOptions {
  platform?: string;
  cordovaBasePath?: string;
  cordovaAssetsDir?: string;
}

/**
 * Returns the path to Cordova platform assets directory.
 * e.g. platforms/ios/platform_www
 */
export function getCordovaAssetsDir(
  options: CordovaTargetOptions,
  workspaceRoot: string,
): string {
  if (options.cordovaAssetsDir) {
    return path.resolve(workspaceRoot, options.cordovaAssetsDir);
  }
  const platform = options.platform ?? 'ios';
  return path.resolve(workspaceRoot, 'platforms', platform, 'platform_www');
}

/**
 * Returns the Cordova base path (project root for cordova CLI).
 */
export function getCordovaBasePath(
  options: CordovaTargetOptions,
  workspaceRoot: string,
): string {
  return options.cordovaBasePath
    ? path.resolve(workspaceRoot, options.cordovaBasePath)
    : workspaceRoot;
}

/**
 * Parse a target string like "project:target:config" into its parts.
 */
export function parseTarget(targetStr: string): Target {
  return targetFromTargetString(targetStr);
}

/**
 * Merge overrides into the target options retrieved from the builder context.
 */
export async function getOptionsWithOverrides<T extends object>(
  context: BuilderContext,
  target: Target,
  overrides: Partial<T> = {},
): Promise<T> {
  const rawOptions = await context.getTargetOptions(target);
  return { ...rawOptions, ...overrides } as unknown as T;
}

/**
 * Check whether the Cordova platform directory exists.
 */
export function checkCordovaPlatformExists(
  platform: string,
  workspaceRoot: string,
): boolean {
  const platformDir = path.resolve(workspaceRoot, 'platforms', platform);
  return fs.existsSync(platformDir);
}

/**
 * Get all extra asset entries from the Cordova platform_www directory
 * so they can be injected into the Angular build's `assets` option.
 *
 * Returns entries compatible with @angular-devkit/build-angular AssetPattern.
 */
export function getCordovaAssetEntries(
  cordovaAssetsDir: string,
  outputPath: string,
): { input: string; output: string; glob: string }[] {
  if (!fs.existsSync(cordovaAssetsDir)) {
    return [];
  }
  return [
    {
      glob: '**/*',
      input: cordovaAssetsDir,
      output: outputPath,
    },
  ];
}

/**
 * Build the livereload URL from host/port/ssl settings.
 */
export function buildLivereloadUrl(
  host: string,
  port: number,
  ssl: boolean,
  overrideUrl?: string,
): string {
  if (overrideUrl) return overrideUrl;
  const scheme = ssl ? 'https' : 'http';
  const h = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `${scheme}://${h}:${port}`;
}
