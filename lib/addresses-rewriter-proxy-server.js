import http from 'node:http'
import https from 'node:https'
import {parse as parseUrl} from 'url'
import Debug from 'debug'

// debug
const debug = Debug('plebbit-js:addresses-rewriter')
// const debug = console.log
// import {inspect} from 'node:util'
// inspect.defaultOptions.depth = null

export default class AddressesRewriterProxyServer {
  constructor({plebbitOptions, port, hostname, proxyTargetUrl}) {
    this.addresses = {}
    this.plebbitOptions = plebbitOptions
    this.port = port
    this.hostname = hostname || '127.0.0.1'
    this.proxyTarget = parseUrl(proxyTargetUrl)
    this.server = http.createServer((req, res) => this._proxyRequestRewrite(req, res))
  }

  listen(callback) {
    this._startUpdateAddressesLoop()
    this.server.listen(this.port, this.hostname, callback) 
  }

  _proxyRequestRewrite(req, res) {
    // get post body
    let reqBody = ''
    req.on('data', chunk => {reqBody += chunk.toString()})

    // wait for full post body
    req.on('end', () => {

      // rewrite body with up to date addresses
      let rewrittenBody = reqBody
      let rewrittenBodyJson
      if (rewrittenBody) {
        try {
          rewrittenBodyJson = JSON.parse(rewrittenBody)
          for (const provider of rewrittenBodyJson.Providers) {
            const peerId = provider.Payload.ID
            if (this.addresses[peerId]) {
              provider.Payload.Addrs = this.addresses[peerId]
            }
          }
          rewrittenBody = JSON.stringify(rewrittenBodyJson)
        }
        catch (e) {
          debug('proxy body rewrite error:', e.message)
        }
      }

      // proxy the request
      const {request: httpRequest} = this.proxyTarget.protocol === 'https:' ? https : http
      const requestOptions = {
        hostname: this.proxyTarget.hostname,
        port: this.proxyTarget.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'Content-Length': Buffer.byteLength(rewrittenBody),
          'content-length': Buffer.byteLength(rewrittenBody),
          host: this.proxyTarget.host
        }
      }
      const proxyReq = httpRequest(requestOptions, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        proxyRes.pipe(res, {end: true})
      })
      proxyReq.on('error', (e) => {
        debug('proxy error:', e.message)
        res.writeHead(500)
        res.end('Internal Server Error')
      })
      debug({method: req.method, url: req.url, headers: req.headers, body: rewrittenBodyJson})
      proxyReq.write(rewrittenBody)
      proxyReq.end()
    })
  }

  // get up to date listen addresses from kubo every x minutes
  _startUpdateAddressesLoop() {
    const tryUpdateAddresses = async () => {
      if (!this.plebbitOptions.kuboRpcClientsOptions?.length) {
        throw Error('no plebbitOptions.kuboRpcClientsOptions')
      }
      for (const ipfsHttpClientOptions of this.plebbitOptions.kuboRpcClientsOptions) {
        const kuboApiUrl = ipfsHttpClientOptions.url || ipfsHttpClientOptions
        try {
          const idRes = await fetch(`${kuboApiUrl}/id`, {method: 'POST'}).then(res => res.json())
          const peerId = idRes.ID
          const swarmRes = await fetch(`${kuboApiUrl}/swarm/addrs/listen`, {method: 'POST'}).then(res => res.json())
          // merge id and swarm addresses to make sure no addresses are missing
          this.addresses[peerId] = [...new Set([...swarmRes.Strings, ...idRes.Addresses])]
        }
        catch (e) {
          debug('tryUpdateAddresses error:', e.message, {kuboApiUrl})
        }
      }      
    }
    tryUpdateAddresses()
    setInterval(tryUpdateAddresses, 2000)
  }
}

/* example of how to use in plebbit-js

const httpRouterProxyUrls = []
if (isNodeJs && plebbitOptions.kuboRpcClientsOptions?.length && plebbitOptions.httpRoutersOptions?.length) {
  let addressesRewriterStartPort = 19575 // use port 19575 as first port, looks like IPRTR (IPFS ROUTER)
  for (const httpRoutersOptions of plebbitOptions.httpRoutersOptions) {
    // launch the proxy server
    const port = addressesRewriterStartPort++
    const hostname = '127.0.0.1'
    const addressesRewriterProxyServer = new AddressesRewriterProxyServer({
      plebbitOptions: plebbitOptions,
      port, 
      hostname,
      proxyTargetUrl: httpRoutersOptions.url || httpRoutersOptions,
    })
    addressesRewriterProxyServer.listen()

    // save the proxy urls to use them later
    httpRouterProxyUrls.push(`http://${hostname}:${port}`)
  }

  // set kubo to the new routers with the proxy urls
  setKuboHttpRouterUrls(httpRouterProxyUrls)
}
*/
