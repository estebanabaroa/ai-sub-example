import Plebbit from '@plebbit/plebbit-js'
import startIpfs from './start-ipfs.js'
import path from 'path'
import fs from 'fs'
import {fileURLToPath} from 'url'
const rootPath = path.dirname(fileURLToPath(import.meta.url))
const statePath = path.join(rootPath, 'state.json')

// put your name here
const newAddress = 'yourname.eth'

let state = {}
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}
catch (e) {}
if (!state.subplebbitAddress) {
  console.log(`you have no subplebbit created, run node start first`)
  process.exit()
}

await startIpfs()

console.log('changing address', state.subplebbitAddress, 'to', newAddress, '...')

const plebbit = await Plebbit({
  kuboRpcClientsOptions: ['http://127.0.0.1:6001/api/v0'],
  pubsubKuboRpcClientsOptions: ['http://127.0.0.1:6001/api/v0'],
  httpRoutersOptions: [],
  dataPath: path.join(rootPath, '.plebbit'),
  publishUpdate: 1000
})

if (!plebbit.subplebbits.includes(state.subplebbitAddress)) {
  throw Error(`the subplebbitAddress in state.json doesn't exist in your .plebbit data, delete state.json and run node start again`)
}

const subplebbit = await plebbit.createSubplebbit({address: state.subplebbitAddress})
console.log('changing address...')
await subplebbit.edit({address: newAddress})
console.log(subplebbit)
console.log('done changing address')
state.subplebbitAddress = subplebbit.address
fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
process.exit()