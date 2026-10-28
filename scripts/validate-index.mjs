// Validate index.json with the same validator DSH itself uses, and cross-check
// it against this package's own manifest. Run: npm run validate:index
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'

// The URL the index will actually be served from: relative icon references and
// the https/same-origin icon rule are resolved against it, so it must be exact.
const INDEX_URL = 'https://raw.githubusercontent.com/Inorysekiro2333/dsh-ide-mode/main/index.json'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = parseMarketIndex(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')), INDEX_URL)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failed = false
const fail = (message) => { failed = true; console.error(`FAIL  ${message}`) }

const entry = index.plugins.find((plugin) => plugin.name === manifest.name)
if (entry === undefined) fail(`index.json does not list ${manifest.name}`)

if (entry !== undefined) {
  if (!entry.versions.some((version) => version.version === manifest.version)) {
    fail(`index.json has no version ${manifest.version} for ${manifest.name}`)
  }
  for (const version of entry.versions) {
    const declared = version.engines.dsh
    if (declared !== manifest.engines?.dsh) {
      fail(`engines.dsh mismatch at ${version.version}: index ${declared ?? '(none)'} vs package.json ${manifest.engines?.dsh ?? '(none)'}`)
    }
    const target = marketInstallTarget(entry.name, version)
    console.log(`${entry.name}@${version.version}\n  spec     ${target.spec}\n  registry ${target.registry ?? '(default)'}\n  icon     ${entry.icon ?? '(none)'}`)
  }
}

console.log(failed ? '\nindex.json is NOT publishable' : `\n${index.plugins.length} plugin(s) in "${JSON.stringify(index.title)}" — index.json is valid`)
process.exitCode = failed ? 1 : 0
