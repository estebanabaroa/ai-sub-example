import Plebbit from '@plebbit/plebbit-js'
import startIpfs from './start-ipfs.js'
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
const rootPath = path.dirname(fileURLToPath(import.meta.url))

// whitelist your own posters addresses here (your normal users)
const whitelist = [
  '12D3KooWLZ17hgteXM78HzMftG7JFypGXqkwVTwdab8EqxgKJp1t'
]

// add your own admins here
const admins = [

]

// add your own moderators here
const moderators = [
  'estebanabaroa.eth',
  'plebeius.eth'
]

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
  dataPath: path.join(rootPath, '.plebbit'),
  publishUpdate: 1000
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
whitelist.push(botSigner.address)
console.log('bot', botSigner.address)

// create test author
const testSigner = await plebbit.createSigner()
whitelist.push(testSigner.address)

const roles = {}
moderators.forEach(moderatorAddress => {
  roles[moderatorAddress] = {role: 'moderator'}
})
admins.forEach(adminAddress => {
  roles[adminAddress] = {role: 'admin'}
})

// set roles, antispam challenges and whitelist the bot
await subplebbit.edit({
  roles,
  settings: {challenges: [
    {
      name: 'publication-match',
      options: {
        matches: JSON.stringify([{'propertyName':'author.address','regexp':'\\.(sol|eth)$'}]),
        error: 'Posting in this community requires a username (author address) that ends with .eth or .sol. Go to the settings to set your username.'
      },
      exclude: [
        // exclude mods
        {role: ['moderator', 'admin', 'owner']},
        // exclude old users
        {
          firstCommentTimestamp: 60 * 60 * 24 * 30, // 1 month
          postScore: 3,
          rateLimit: 2,
          replyScore: 0
        },
        {challenges: [1]}
      ]
    },
    {
      name: 'whitelist',
      options: {
        addresses: whitelist.join(','),
        urls: 'https://raw.githubusercontent.com/plebbit/lists/refs/heads/master/whitelist-challenge.json',
        error: 'Or posting in this community requires being whitelisted. Go to https://t.me/plebbit and ask to be whitelisted.'
      },
      exclude: [
        // exclude mods
        {role: ['moderator', 'admin', 'owner']},
        // exclude old users
        {
          firstCommentTimestamp: 60 * 60 * 24 * 30, // 1 month
          postScore: 3,
          rateLimit: 2,
          replyScore: 0
        },
        {challenges: [0]}
      ]
    }
  ]}
})

// make the bot answer every comment
subplebbit.on('challengeverification', async (challengeVerification) => {
  if (!challengeVerification.challengeSuccess) {
    console.log('failed challenge verification', challengeVerification.reason, challengeVerification.challengeErrors)
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
  const cid = challengeVerification.commentUpdate.cid
  const postCid = challengeVerification.comment.postCid || challengeVerification.commentUpdate.cid
  console.log('new comment:', {cid, content})

  // get reply from AI
  const fullPostContext = await getFullPostReplies(postCid)
  const parentComments = await getParentComments(cid)
  const reply = 'this is the reply'

  const comment = await plebbit.createComment({
    parentCid: cid,
    postCid,
    content: reply,
    subplebbitAddress: subplebbit.address,
    signer: botSigner,
    author: {address: botSigner.address, displayName: 'bot'},
  })
  comment.on('error', (error) => console.log('error publishing bot reply', error))
  comment.publish()
})

// start subplebbit
console.log('starting...')
await subplebbit.start()
console.log('started')
// console.log('ipnsPubsubTopicRoutingCid:', subplebbit.ipnsPubsubTopicRoutingCid)
// console.log(subplebbit.roles, subplebbit.settings.challenges)

console.log('publishing test comment...')
const comment = await plebbit.createComment({
  title: 'comment title',
  content: 'comment content',
  subplebbitAddress: subplebbit.address,
  signer: testSigner
})
comment.once('challenge', () => comment.publishChallengeAnswers(['']))
comment.once('challengeverification', (challengeVerification) => {
  console.log('published test comment success', challengeVerification.challengeSuccess)
  if (challengeVerification.challengeErrors) {
    console.log(challengeVerification.challengeErrors)
  }
})
comment.on('error', (error) => console.log('error publishing test comment', error))
await comment.publish()

// util functions to get the post context for the ai
async function getFullPostReplies(postCid) {
  const comment = await plebbit.createComment({cid: postCid})
  const updatePromise = new Promise(resolve => {
    comment.on('update', () => {
      if (comment.updatedAt) resolve()
    })
    comment.on('error', resolve)
  })
  await comment.update()
  await updatePromise
  await comment.stop()
  const rawReplies = comment.replies?.pages?.best?.comments || []
  return extractCommentValues(rawReplies)
}

function extractCommentValues(comments = []) {
  return comments.map(function(comment) {
    const {cid, content, author, depth, replies} = comment
    return {
      cid,
      content,
      author,
      depth,
      replies: replies?.pages?.best?.comments
        ? extractCommentValues(replies.pages.best.comments)
        : []
    }
  })
}

// util functions to get the full parent discussion only
async function getParentComments(_parentCid) {
  const parents = []
  while (true) {
    const comment = await plebbit.getComment(_parentCid)
    const {title, content, cid, parentCid, depth, author} = comment
    parents.push({title, content, depth, author})
    _parentCid = parentCid
    if (comment.depth === 0) {
      break
    }
  }
  return parents
}
