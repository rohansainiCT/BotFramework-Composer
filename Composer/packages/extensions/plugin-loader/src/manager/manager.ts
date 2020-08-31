// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'path';
import childProcess from 'child_process';
import { promisify } from 'util';
import glob from 'globby';

import { readJson } from 'fs-extra';

import { pluginLoader } from '../loader';
import logger from '../logger';
import { ExtensionManifestStore, PluginBundle } from '../storage/extensionManifestStore';
import { PackageJSON, PluginInfo } from '../types/types';

const log = logger.extend('plugins');

const exec = promisify(childProcess.exec);

let manager: PluginManager;

export class PluginManager {
  private builtinPluginsDir;
  private remotePluginsDir;
  private searchCache = new Map<string, PluginInfo>();
  private manifest: ExtensionManifestStore;

  public static getInstance() {
    if (!manager) {
      manager = new PluginManager();
    }
    return manager;
  }

  // singleton
  private constructor() {
    console.log(
      `PluginManager initializing with the following values: \n${process.env.COMPOSER_BUILTIN_PLUGINS_DIR} \n${process.env.COMPOSER_REMOTE_PLUGINS_DIR}`
    );
    this.manifest = new ExtensionManifestStore();
    this.builtinPluginsDir = process.env.COMPOSER_BUILTIN_PLUGINS_DIR;
    this.remotePluginsDir = process.env.COMPOSER_REMOTE_PLUGINS_DIR;
  }

  /**
   * Returns all extensions currently in the extension manifest
   */
  public getAll() {
    const extensions = this.manifest.getExtensions();
    return Object.keys(extensions).map((extId) => extensions[extId]);
  }

  /**
   * Returns the extension manifest entry for the specified extension ID
   * @param id Id of the extension to search for
   */
  public find(id: string) {
    return this.manifest.getExtensions()[id];
  }

  /**
   * Installs a remote plugin via NPM
   * @param name The name of the plugin to install
   * @param version The version of the plugin to install
   */
  public async installRemote(name: string, version?: string) {
    const packageNameAndVersion = version ? `${name}@${version}` : name;
    const cmd = `npm install --no-audit --prefix ${this.remotePluginsDir} ${packageNameAndVersion}`;
    log('Installing %s@%s to %s', name, version, this.remotePluginsDir);
    log(cmd);

    const { stdout, stderr } = await exec(cmd);

    log('%s', stdout);
    log('%s', stderr);

    const packageJson = await this.getPackageJson(name);

    if (packageJson) {
      const pluginPath = path.resolve(this.remotePluginsDir, 'node_modules', name);
      await this.manifest.updateExtensionConfig(name, {
        id: name,
        name: packageJson.name,
        version: packageJson.version,
        enabled: true,
        // TODO: plugins can provide default configuration
        configuration: {},
        path: pluginPath,
        bundles: this.processBundles(pluginPath, packageJson.composer?.bundles ?? []),
        contributes: packageJson.composer?.contributes,
      });
    } else {
      throw new Error(`Unable to install ${packageNameAndVersion}`);
    }
  }

  /**
   * Loads all the plugins that are checked into the Composer project (1P plugins)
   */
  public async loadBuiltinPlugins() {
    log('Loading inherent plugins from: ', this.builtinPluginsDir);

    // get all plugins with a package.json in the plugins dir
    const plugins = await glob('*/package.json', { cwd: this.builtinPluginsDir, dot: true });
    for (const p in plugins) {
      // go through each plugin, make sure to add it to the manager store then load it as usual
      const pluginPackageJsonPath = plugins[p];
      const fullPath = path.join(this.builtinPluginsDir, pluginPackageJsonPath);
      const pluginInstallPath = path.dirname(fullPath);
      const packageJson = (await readJson(fullPath)) as PackageJSON;
      if (packageJson && (!!packageJson.composer || !!packageJson.extendsComposer)) {
        await this.manifest.updateExtensionConfig(packageJson.name, {
          id: packageJson.name,
          name: packageJson.name,
          version: packageJson.version,
          enabled: true,
          // TODO: plugins can provide default configuration
          configuration: {},
          path: pluginInstallPath,
          bundles: this.processBundles(pluginInstallPath, packageJson.composer?.bundles ?? []),
          contributes: packageJson.composer?.contributes,
          builtIn: true,
        });
        await pluginLoader.loadPluginFromFile(fullPath);
      }
    }
  }

  /**
   * Loads all installed remote plugins
   * TODO (toanzian / abrown): Needs to be implemented
   */
  public async loadRemotePlugins() {
    // should perform the same function as loadBuiltInPlugins but from the
    // location that remote / 3P plugins are installed
  }

  public async load(id: string) {
    try {
      const modulePath = require.resolve(id, {
        paths: [`${this.remotePluginsDir}/node_modules`],
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires, security/detect-non-literal-require
      const plugin = require(modulePath);
      console.log('got plugin: ', plugin);

      if (!plugin) {
        throw new Error('Plugin not found');
      }

      await pluginLoader.loadPlugin(id, '', plugin);
    } catch (err) {
      log('Unable to load plugin `%s`', id);
      log('%O', err);
      await this.remove(id);
      throw err;
    }
  }

  /**
   * Enables a plugin
   * @param id Id of the plugin to be enabled
   */
  public async enable(id: string) {
    await this.manifest.updateExtensionConfig(id, { enabled: true });

    // re-load plugin
  }

  /**
   * Disables a plugin
   * @param id Id of the plugin to be disabled
   */
  public async disable(id: string) {
    await this.manifest.updateExtensionConfig(id, { enabled: false });

    // tear down plugin?
  }

  /**
   * Removes a remote plugin via NPM
   * @param id Id of the plugin to be removed
   */
  public async remove(id: string) {
    const cmd = `npm uninstall --no-audit --prefix ${this.remotePluginsDir} ${id}`;
    log('Removing %s', id);
    log(cmd);

    const { stdout } = await exec(cmd);

    log('%s', stdout);

    this.manifest.removeExtension(id);
  }

  /**
   * Searches for a plugin via NPM's search function
   * @param query The search query
   */
  public async search(query: string) {
    const cmd = `npm search --json "keywords:botframework-composer ${query}"`;
    log(cmd);

    const { stdout } = await exec(cmd);

    try {
      const result = JSON.parse(stdout);
      if (Array.isArray(result)) {
        result.forEach((searchResult) => {
          const { name, keywords = [], version, description, links } = searchResult;
          if (keywords.includes('botframework-composer')) {
            const url = links?.npm ?? '';
            this.searchCache.set(name, {
              id: name,
              version,
              description,
              keywords,
              url,
            });
          }
        });
      }
    } catch (err) {
      log('%O', err);
    }

    return Array.from(this.searchCache.values());
  }

  /**
   * Returns a list of all of an extension's bundles
   * @param id The ID of the extension for which we will fetch the list of bundles
   */
  public async getAllBundles(id: string) {
    const info = this.find(id);

    if (!info) {
      throw new Error('plugin not found');
    }

    return info.bundles ?? [];
  }

  /**
   * Returns a specific bundle for an extension
   * @param id The id of the desired extension
   * @param bundleId The id of the desired extension's bundle
   */
  public getBundle(id: string, bundleId: string): string | null {
    const info = this.find(id);

    if (!info) {
      throw new Error('plugin not found');
    }

    const bundle = info.bundles.find((b) => b.id === bundleId);

    if (!bundle) {
      throw new Error('bundle not found');
    }

    return bundle.path;
  }

  private async getPackageJson(id: string): Promise<PackageJSON | undefined> {
    try {
      const pluginPackagePath = path.resolve(this.remotePluginsDir, 'node_modules', id, 'package.json');
      log('fetching package.json for %s at %s', id, pluginPackagePath);
      const packageJson = await readJson(pluginPackagePath);
      return packageJson as PackageJSON;
    } catch (err) {
      log('Error getting package json for %s', id);
      console.error(err);
    }
  }

  private processBundles(pluginPath: string, bundles: PluginBundle[]) {
    return bundles.map((b) => ({
      ...b,
      path: path.resolve(pluginPath, b.path),
    }));
  }
}
