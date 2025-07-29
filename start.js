import Plebbit from '@plebbit/plebbit-js'
import startIpfs from './start-ipfs.js'
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
const rootPath = path.dirname(fileURLToPath(import.meta.url))

// save state to disk every 1s
let state = {}
const statePath = path.join(rootPath, 'state.json')
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}
catch (e) {}
setInterval(() => fs.writeFileSync(statePath, JSON.stringify(state, null, 2)), 1000)

await startIpfs()

const plebbit = await Plebbit({
  kuboRpcClientsOptions: ['http://127.0.0.1:6001/api/v0'],
  pubsubKuboRpcClientsOptions: ['http://127.0.0.1:6001/api/v0'],
  httpRoutersOptions: [],
  dataPath: path.join(rootPath, '.plebbit')
})
plebbit.on('error', error => {
  console.log(error) // logging plebbit errors are only useful for debugging, not production
})

// create subplebbit
const createSubplebbitOptions = state.subplebbitAddress ? {address: state.subplebbitAddress} : undefined
const subplebbit = await plebbit.createSubplebbit(createSubplebbitOptions)
state.subplebbitAddress = subplebbit.address
console.log('subplebbit', subplebbit.address)
subplebbit.on('error', (...args) => console.log('subplebbit error', ...args))
// subplebbit.on('challengerequest', (...args) => console.log('challengerequest', ...args))
// subplebbit.on('challenge', (...args) => console.log('challenge', ...args))
// subplebbit.on('challengeanswer', (...args) => console.log('challengeanswer', ...args))
// subplebbit.on('challengeverification', (...args) => console.log('challengeverification', ...args))

// create bot author
const createSignerOptions = state.botPrivateKey ? {privateKey: state.botPrivateKey, type: 'ed25519'} : undefined
const botSigner = await plebbit.createSigner(createSignerOptions)
state.botPrivateKey = botSigner.privateKey
console.log('bot', botSigner.address)

// whitelist the bot
await subplebbit.edit({
  settings: {challenges: []}
})

// make the bot answer every comment
subplebbit.on('challengeverification', async (challengeVerification) => {
  if (!challengeVerification.challengeSuccess) {
    console.log('failed challenge verification')
    return
  }
  if (!challengeVerification.comment) {
    console.log('succeeded challenge verification, not a comment')
    return
  }
  if (challengeVerification.comment.author.address === botSigner.address) {
    console.log('succeeded challenge verification, is the bot')
    return
  }
  const content = `${challengeVerification.comment.title || ''}\n\n${challengeVerification.comment.content || ''}`.trim()
  console.log('new comment:', {content})

  // get reply from AI
  const reply = 'this is the reply'

  const comment = await plebbit.createComment({
    parentCid: challengeVerification.commentUpdate.cid,
    postCid: challengeVerification.commentUpdate.cid,
    content: reply,
    subplebbitAddress: subplebbit.address,
    signer: botSigner,
    author: {address: botSigner.address, displayName: 'bot'},
  })
  comment.publish()
})

// start subplebbit
console.log('starting...')
await subplebbit.start()
console.log('started')

console.log('publish test comment')
const signer = await plebbit.createSigner()
const comment = await plebbit.createComment({
  title: 'comment title',
  content: 'comment content',
  subplebbitAddress: subplebbit.address,
  signer: signer,
  author: {address: signer.address},
})
comment.once('challenge', () => comment.publishChallengeAnswers(['']))
await comment.publish()
