import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'lib')
const packageId = 'iteroom'

await mkdir(output, { recursive: true })
await writeFile(join(output, 'index.js'), await readFile(join(root, 'src/index.js')))
await cp(join(root, 'src/host'), join(output, 'host'), { recursive: true })

const result = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  external: ['react', 'react/jsx-runtime'],
  outfile: join(output, 'client.js'),
  plugins: [{
    name: 'iteroom-css-modules',
    setup(compiler) {
      compiler.onResolve({ filter: /\.module\.css$/ }, args => ({
        path: resolve(args.resolveDir, args.path),
        namespace: 'iteroom-css',
      }))
      compiler.onLoad({ filter: /.*/, namespace: 'iteroom-css' }, async args => {
        const source = await readFile(args.path)
        const result = transform({
          filename: args.path,
          code: source,
          cssModules: { pattern: 'iteroom_[local]_[hash]' },
          minify: true,
        })
        const classes = Object.fromEntries(Object.entries(result.exports ?? {})
          .map(([name, value]) => [name, value.name]))
        return {
          contents: `export const stylesheet = ${JSON.stringify(result.code.toString())}; export default ${JSON.stringify(classes)};`,
          loader: 'js',
        }
      })
    },
  }],
})

const script = result.outputFiles.find(file => file.path.endsWith('client.js'))
if (script === undefined) throw new Error('Browser bundle was not produced')
const wrapper = `window.__ModuleLoader__.load({id:${JSON.stringify(packageId)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${script.text}\nreturn module.exports;}});\n`
await writeFile(join(output, 'client.js'), wrapper)
console.log(`Built ${join(output, 'client.js')}`)
