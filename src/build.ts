import { mkdir, rm } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import glob from 'fast-glob'
import micromatch from 'micromatch'
import { reporter } from 'vfile-reporter'

import { assets } from './assets'
import { resolveConfig } from './config'
import { VeliteFile } from './file'
import { logger } from './logger'
import { outputAssets, outputData, outputEntry } from './output'

import type { LogLevel } from './logger'
import type { Schema } from './schemas'
import type { Config } from './types'

// cache resolved result for rebuild
const resolved = new Map<string, VeliteFile[]>()

/**
 * Load file and parse data with given schema
 * @param config resolved config
 * @param path file path
 * @param schema data schema
 * @param changed changed file path (relative to content root)
 */
const load = async (config: Config, path: string, schema: Schema, changed?: string): Promise<VeliteFile> => {
  path = normalize(path)

  if (changed != null && path !== changed) {
    const exists = VeliteFile.get(path)
    // skip file if changed file not match
    if (exists) return exists
  }

  const meta = await VeliteFile.create({ path, config })

  // may be one or more records in one file, such as yaml array or json array
  const isArr = Array.isArray(meta.records)
  const list = isArr ? meta.records : [meta.records]

  const parsed = await Promise.all(
    list.map(async (item, index) => {
      // push index in path if file is array
      const path = isArr ? [index] : []
      // parse data with given schema
      const result = await schema.safeParseAsync(item, { path, meta } as any)
      if (result.success) return result.data
      // report error if parsing failed
      result.error.issues.forEach(issue => meta.message(issue.message, { source: issue.path.join('.') }))
    })
  )

  // logger.log(`loaded '${path}' with ${parsed.length} records`)
  meta.result = isArr ? parsed : parsed[0]

  return meta
}

/**
 * Resolve collections from content root
 * @param config resolved config
 * @param changed changed file path (relative to content root)
 * @returns resolved result
 */
const resolve = async (config: Config, changed?: string): Promise<Record<string, unknown>> => {
  const { root, output, collections, prepare, complete } = config
  const begin = performance.now()

  logger.log(`resolving collections from '${root}'`)

  const entries = await Promise.all(
    Object.entries(collections).map(async ([name, { pattern, schema }]): Promise<[string, VeliteFile[]]> => {
      if (changed != null && !micromatch.contains(changed, pattern) && resolved.has(name)) {
        // skip collection if changed file not match
        logger.log(`skipped resolve '${name}', using previous resolved`)
        return [name, resolved.get(name)!]
      }
      const begin = performance.now()
      const paths = await glob(pattern, { cwd: root, absolute: true, onlyFiles: true, ignore: ['**/_*'] })
      const files = await Promise.all(paths.map(path => load(config, path, schema, changed)))
      logger.log(`resolve ${paths.length} files matching '${pattern}'`, begin)
      resolved.set(name, files)
      return [name, files]
    })
  )

  const allFiles = entries.flatMap(([, files]) => files)
  const report = reporter(allFiles, { quiet: true })

  if (report.length > 0) {
    logger.warn(`issues:\n${report}`)
    if (config.strict) throw new Error('Schema validation failed.')
  }

  const result = Object.fromEntries(
    entries.map(([name, files]): [string, any | any[]] => {
      const data = files.flatMap(file => file.result).filter(Boolean)
      if (collections[name].single) {
        if (data.length === 0) throw new Error(`no data resolved for '${name}'`)
        if (data.length > 1) logger.warn(`resolved ${data.length} ${name}, but expected single, using first one`)
        else logger.log(`resolved 1 ${name}`)
        return [name, data[0]]
      }
      logger.log(`resolved ${data.length} ${name}`)
      return [name, data]
    })
  )

  let shouldOutput = true
  // apply prepare hook
  if (typeof prepare === 'function') {
    const begin = performance.now()
    shouldOutput = (await prepare(result)) ?? true
    logger.log(`executed 'prepare' callback got ${shouldOutput}`, begin)
  }

  if (shouldOutput) {
    // emit result if not prevented
    await outputData(output.data, result)
  } else {
    logger.warn(`prevent output by 'prepare' callback`)
  }

  // output all assets
  await outputAssets(output.assets, assets)

  // call complete hook
  if (typeof complete === 'function') {
    const begin = performance.now()
    await complete(result)
    logger.log(`executed 'complete' callback`, begin)
  }

  logger.log(`resolved ${Object.keys(result).length} collections`, begin)

  return result
}

/**
 * Watch files and rebuild on changes
 * @param config resolved config
 */
const watch = async (config: Config) => {
  const { watch } = await import('chokidar')
  const { root, collections, configImports } = config

  logger.info(`watching for changes in '${root}'`)

  const files = Object.values(collections).flatMap(({ pattern }) => pattern)
  files.push(...configImports) // watch config file and its dependencies

  const watcher = watch(files, {
    cwd: root,
    ignored: /(^|[\/\\])[\._]./, // ignore dot & underscore files
    ignoreInitial: true, // ignore initial scan
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 }
  }).on('all', async (event, filename) => {
    if (event === 'addDir' || event === 'unlinkDir') return // ignore dir changes
    if (filename == null) return

    filename = join(root, filename)

    try {
      // remove changed file cache
      for (const [key, value] of config.cache.entries()) {
        if (value === filename) config.cache.delete(key)
      }

      if (configImports.includes(filename)) {
        logger.info('velite config changed, restarting...')
        watcher.close()
        return build({ config: config.configPath, clean: false, watch: true })
      }

      const begin = performance.now()
      logger.info(`changed: '${filename}', rebuilding...`)
      await resolve(config, filename)
      logger.info(`rebuild finished`, begin)
    } catch (err) {
      logger.warn(err)
    }
  })
}

/**
 * Build options
 */
export interface Options {
  /**
   * Specify config file path, relative to cwd
   * if not specified, will try to find `velite.config.{js,ts,mjs,mts,cjs,cts}` in cwd or parent directories
   */
  config?: string
  /**
   * Clean output directories before build
   * @default false
   */
  clean?: boolean
  /**
   * Watch files and rebuild on changes
   * @default false
   */
  watch?: boolean
  /**
   * Log level
   * @default 'info'
   */
  logLevel?: LogLevel
  /**
   * If true, throws error and terminates process if any schema validation fails.
   * @default false
   */
  strict?: boolean
}

/**
 * Build contents
 * @param options build options
 */
export const build = async (options: Options = {}): Promise<Record<string, unknown>> => {
  const { config: configFile, clean, logLevel, strict } = options

  logLevel != null && logger.set(logLevel)

  const begin = performance.now()

  const timer = setTimeout(() => logger.info('building...'), 1000)

  const config = await resolveConfig(configFile, { clean, strict })

  const { configPath, output, collections } = config

  if (output.clean) {
    await rm(output.data, { recursive: true, force: true })
    logger.log(`cleaned data output dir '${output.data}'`)

    await rm(output.assets, { recursive: true, force: true })
    logger.log(`cleaned assets output dir '${output.assets}'`)
  }

  // create output directories if not exists
  await mkdir(output.data, { recursive: true })
  await mkdir(output.assets, { recursive: true })

  await outputEntry(output.data, configPath, collections)

  logger.log('initialized', begin)

  const result = await resolve(config)

  clearTimeout(timer)

  logger.info(`build finished`, begin)

  options.watch && watch(config)
  return result
}
