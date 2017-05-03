'use strict'

const BrowserWebSocket = global.WebSocket || global.MozWebSocket
const NodeWebSocket = require('ws')
const messageParser = require('./message-parser')
const messageBuilder = require('./message-builder')
const utils = require('../utils/utils')
const C = require('../constants/constants')

/**
 * Establishes a connection to a deepstream server using websockets
 *
 * @param {Client} client
 * @param {String} url     Short url, e.g. <host>:<port>. Deepstream works out the protocol
 * @param {Object} options connection options
 *
 * @constructor
 */
const Connection = function (client, url, options) {
  this._client = client
  this._options = options
  this._authParams = null
  this._authCallback = null
  this._deliberateClose = false
  this._redirecting = false
  this._tooManyAuthAttempts = false
  this._connectionAuthenticationTimeout = false
  this._challengeDenied = false
  this._queuedMessages = []
  this._parsedMessages = []
  this._rawMessages = []
  this._reconnectTimeout = null
  this._reconnectionAttempt = 0
  this._messageSender = null
  this._endpoint = null
  this._lastHeartBeat = null
  this._heartbeatInterval = null

  this._handleMessages = this._handleMessages.bind(this)
  this._sendQueuedMessages = this._sendQueuedMessages.bind(this)

  this._originalUrl = utils.parseUrl(url, this._options.path)
  this._url = this._originalUrl
  this._idleTimeout = (Math.min(
    options.rpcAckTimeout,
    options.rpcResponseTimeout,
    options.subscriptionTimeout,
    options.heartbeatInterval - 2000,
    1000
  ) || 1000) - 200

  this._state = C.CONNECTION_STATE.CLOSED
  this._createEndpoint()
}

/**
 * Returns the current connection state.
 * (One of constants.CONNECTION_STATE)
 *
 * @public
 * @returns {String} connectionState
 */
Connection.prototype.getState = function () {
  return this._state
}

/**
 * Sends the specified authentication parameters
 * to the server. Can be called up to <maxAuthAttempts>
 * times for the same connection.
 *
 * @param   {Object}   authParams A map of user defined auth parameters. E.g. { username:<String>, password:<String> }
 * @param   {Function} callback   A callback that will be invoked with the authenticationr result
 *
 * @public
 * @returns {void}
 */
Connection.prototype.authenticate = function (authParams, callback) {
  this._authParams = authParams
  this._authCallback = callback

  if (this._tooManyAuthAttempts || this._challengeDenied || this._connectionAuthenticationTimeout) {
    this._client._$onError(C.TOPIC.ERROR, C.EVENT.IS_CLOSED, 'this client\'s connection was closed')
    return
  } else if (this._deliberateClose === true && this._state === C.CONNECTION_STATE.CLOSED) {
    this._createEndpoint()
    this._deliberateClose = false
    return
  }

  if (this._state === C.CONNECTION_STATE.AWAITING_AUTHENTICATION) {
    this._sendAuthParams()
  }
}

/**
 * High level send message method. Creates a deepstream message
 * string and invokes the actual send method.
 *
 * @param   {String} topic  One of C.TOPIC
 * @param   {String} action One of C.ACTIONS
 * @param   {[Mixed]} data   Date that will be added to the message. Primitive values will
 *                          be appended directly, objects and arrays will be serialized as JSON
 *
 * @private
 * @returns {void}
 */
Connection.prototype.sendMsg = function (topic, action, data) {
  this.send(messageBuilder.getMsg(topic, action, data))
}

/**
 * Main method for sending messages. Doesn't send messages instantly,
 * but instead achieves conflation by adding them to the message
 * buffer that will be drained on the next tick
 *
 * @param   {String} message deepstream message
 *
 * @public
 * @returns {void}
 */
Connection.prototype.send = function (message) {
  this._queuedMessages.push(message)
  if (this._queuedMessages.length > this._options.maxMessagesPerPacket) {
    clearTimeout(this._messageSender)
    this._sendQueuedMessages()
  } else if (!this._messageSender) {
    this._messageSender = setTimeout(this._sendQueuedMessages, 40)
  }
}

/**
 * Closes the connection. Using this method
 * sets a _deliberateClose flag that will prevent the client from
 * reconnecting.
 *
 * @public
 * @returns {void}
 */
Connection.prototype.close = function () {
  clearInterval(this._heartbeatInterval)
  this._deliberateClose = true
  this._endpoint.close()
  if (this._messageHandler) {
    utils.cancelIdleCallback(this._messageHandler)
  }
}

/**
 * Creates the endpoint to connect to using the url deepstream
 * was initialised with.
 *
 * @private
 * @returns {void}
 */
Connection.prototype._createEndpoint = function () {
  this._endpoint = BrowserWebSocket ? new BrowserWebSocket(this._url) : new NodeWebSocket(this._url)

  this._endpoint.onopen = this._onOpen.bind(this)
  this._endpoint.onerror = this._onError.bind(this)
  this._endpoint.onclose = this._onClose.bind(this)
  this._endpoint.onmessage = this._onMessage.bind(this)
}

/**
 * Concatenates the messages in the current message queue
 * and sends them as a single package. This will also
 * empty the message queue and conclude the send process.
 *
 * @private
 * @returns {void}
 */
Connection.prototype._sendQueuedMessages = function (deadline) {
  if (this._state !== C.CONNECTION_STATE.OPEN || this._endpoint.readyState !== this._endpoint.OPEN) {
    return
  }

  while (this._queuedMessages.length > 0) {
    this._submit(this._queuedMessages.splice(0, this._options.maxMessagesPerPacket).join(''))
  }

  this._messageSender = null
}

/**
 * Sends a message to over the endpoint connection directly
 *
 * Will generate a connection error if the websocket was closed
 * prior to an onclose event.
 *
 * @private
 * @returns {void}
 */
Connection.prototype._submit = function (message) {
  if (this._endpoint.readyState === this._endpoint.OPEN) {
    this._endpoint.send(message)
  } else {
    this._onError('Tried to send message on a closed websocket connection')
  }
}

/**
 * Sends authentication params to the server. Please note, this
 * doesn't use the queued message mechanism, but rather sends the message directly
 *
 * @private
 * @returns {void}
 */
Connection.prototype._sendAuthParams = function () {
  this._setState(C.CONNECTION_STATE.AUTHENTICATING)
  const authMessage = messageBuilder.getMsg(C.TOPIC.AUTH, C.ACTIONS.REQUEST, [ this._authParams ])
  this._submit(authMessage)
}

/**
 * Ensures that a heartbeat was not missed more than once, otherwise it considers the connection
 * to have been lost and closes it for reconnection.
 * @return {void}
 */
Connection.prototype._checkHeartBeat = function () {
  const heartBeatTolerance = this._options.heartbeatInterval * 2

  if (Date.now() - this._lastHeartBeat > heartBeatTolerance) {
    clearInterval(this._heartbeatInterval)
    this._endpoint.close()
    this._client._$onError(
      C.TOPIC.CONNECTION,
      C.EVENT.CONNECTION_ERROR,
      `heartbeat not received in the last ${heartBeatTolerance} milliseconds`)
  }
}

/**
 * Will be invoked once the connection is established. The client
 * can't send messages yet, and needs to get a connection ACK or REDIRECT
 * from the server before authenticating
 *
 * @private
 * @returns {void}
 */
Connection.prototype._onOpen = function () {
  this._clearReconnect()
  this._lastHeartBeat = Date.now()
  this._heartbeatInterval = utils.setInterval(this._checkHeartBeat.bind(this), this._options.heartbeatInterval)
  this._setState(C.CONNECTION_STATE.AWAITING_CONNECTION)
}

/**
 * Callback for generic connection errors. Forwards
 * the error to the client.
 *
 * The connection is considered broken once this method has been
 * invoked.
 *
 * @param   {String|Error} error connection error
 *
 * @private
 * @returns {void}
 */
Connection.prototype._onError = function (error) {
  clearInterval(this._heartbeatInterval)
  this._setState(C.CONNECTION_STATE.ERROR)

  /*
   * If the implementation isn't listening on the error event this will throw
   * an error. So let's defer it to allow the reconnection to kick in.
   */
  setTimeout(() => {
    let msg
    if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      msg = 'Can\'t connect! Deepstream server unreachable on ' + this._originalUrl
    } else {
      msg = error.toString()
    }
    this._client._$onError(C.TOPIC.CONNECTION, C.EVENT.CONNECTION_ERROR, msg)
  }, 1)
}

/**
 * Callback when the connection closes. This might have been a deliberate
 * close triggered by the client or the result of the connection getting
 * lost.
 *
 * In the latter case the client will try to reconnect using the configured
 * strategy.
 *
 * @private
 * @returns {void}
 */
Connection.prototype._onClose = function () {
  clearInterval(this._heartbeatInterval)

  if (this._redirecting === true) {
    this._redirecting = false
    this._createEndpoint()
  } else if (this._deliberateClose === true) {
    this._setState(C.CONNECTION_STATE.CLOSED)
  } else {
    this._tryReconnect()
  }
}

/**
 * Callback for messages received on the connection.
 *
 * @param   {String} message deepstream message
 *
 * @private
 * @returns {void}
 */
Connection.prototype._onMessage = function (message) {
  this._rawMessages.push(message)
  if (!this._messageHandler) {
    this._messageHandler = utils.requestIdleCallback(this._handleMessages, { timeout: this._idleTimeout })
  }
}

Connection.prototype._handleMessages = function (deadline) {
  const end = Date.now() + (deadline.timeRemaining() || 8)
  do {
    if (this._parsedMessages.length === 0) {
      var message = this._rawMessages.shift()
      if (!message) {
        break
      }
      this._parsedMessages = messageParser.parse(message.data, this._client)
    } else {
      var parsedMessage = this._parsedMessages.shift()
      if (!parsedMessage) {
        continue
      } else if (parsedMessage.topic === C.TOPIC.CONNECTION) {
        this._handleConnectionResponse(parsedMessage)
      } else if (parsedMessage.topic === C.TOPIC.AUTH) {
        this._handleAuthResponse(parsedMessage)
      } else {
        this._client._$onMessage(parsedMessage)
      }
    }
  } while (end - Date.now() > 4)

  if ((this._parsedMessages.length > 0 || this._rawMessages.length > 0) && !this._deliberateClose) {
    this._messageHandler = utils.requestIdleCallback(this._handleMessages, { timeout: this._idleTimeout })
  } else {
    this._messageHandler = null
  }
}

/**
 * The connection response will indicate whether the deepstream connection
 * can be used or if it should be forwarded to another instance. This
 * allows us to introduce load-balancing if needed.
 *
 * If authentication parameters are already provided this will kick of
 * authentication immediately. The actual 'open' event won't be emitted
 * by the client until the authentication is successful.
 *
 * If a challenge is received, the user will send the url to the server
 * in response to get the appropriate redirect. If the URL is invalid the
 * server will respond with a REJECTION resulting in the client connection
 * being permanently closed.
 *
 * If a redirect is received, this connection is closed and updated with
 * a connection to the url supplied in the message.
 *
 * @param   {Object} message parsed connection message
 *
 * @private
 * @returns {void}
 */
Connection.prototype._handleConnectionResponse = function (message) {
  if (message.action === C.ACTIONS.PING) {
    this._lastHeartBeat = Date.now()
    this._submit(messageBuilder.getMsg(C.TOPIC.CONNECTION, C.ACTIONS.PONG))
  } else if (message.action === C.ACTIONS.ACK) {
    this._setState(C.CONNECTION_STATE.AWAITING_AUTHENTICATION)
    if (this._authParams) {
      this._sendAuthParams()
    }
  } else if (message.action === C.ACTIONS.CHALLENGE) {
    this._setState(C.CONNECTION_STATE.CHALLENGING)
    this._submit(messageBuilder.getMsg(C.TOPIC.CONNECTION, C.ACTIONS.CHALLENGE_RESPONSE, [ this._originalUrl ]))
  } else if (message.action === C.ACTIONS.REJECTION) {
    this._challengeDenied = true
    this.close()
  } else if (message.action === C.ACTIONS.REDIRECT) {
    this._url = message.data[ 0 ]
    this._redirecting = true
    this._endpoint.close()
  } else if (message.action === C.ACTIONS.ERROR) {
    if (message.data[ 0 ] === C.EVENT.CONNECTION_AUTHENTICATION_TIMEOUT) {
      this._deliberateClose = true
      this._connectionAuthenticationTimeout = true
      this._client._$onError(C.TOPIC.CONNECTION, message.data[ 0 ], message.data[ 1 ])
    }
  }
}

/**
 * Callback for messages received for the AUTH topic. If
 * the authentication was successful this method will
 * open the connection and send all messages that the client
 * tried to send so far.
 *
 * @param   {Object} message parsed auth message
 *
 * @private
 * @returns {void}
 */
Connection.prototype._handleAuthResponse = function (message) {
  if (message.action === C.ACTIONS.ERROR) {
    if (message.data[ 0 ] === C.EVENT.TOO_MANY_AUTH_ATTEMPTS) {
      this._deliberateClose = true
      this._tooManyAuthAttempts = true
    } else {
      this._setState(C.CONNECTION_STATE.AWAITING_AUTHENTICATION)
    }

    if (this._authCallback) {
      this._authCallback(false, this._getAuthData(message.data[ 1 ]))
    }
  } else if (message.action === C.ACTIONS.ACK) {
    this._setState(C.CONNECTION_STATE.OPEN)

    if (this._authCallback) {
      this._authCallback(true, this._getAuthData(message.data[ 0 ]))
    }

    this._sendQueuedMessages()
  }
}

/**
 * Checks if data is present with login ack and converts it
 * to the correct type
 *
 * @param {Object} message parsed and validated deepstream message
 *
 * @private
 * @returns {object}
 */
Connection.prototype._getAuthData = function (data) {
  if (data === undefined) {
    return null
  } else {
    return messageParser.convertTyped(data, this._client)
  }
}

/**
 * Updates the connection state and emits the
 * connectionStateChanged event on the client
 *
 * @private
 * @returns {void}
 */
Connection.prototype._setState = function (state) {
  this._state = state
  this._client.emit(C.EVENT.CONNECTION_STATE_CHANGED, state)
}

/**
 * If the connection drops or is closed in error this
 * method schedules increasing reconnection intervals
 *
 * If the number of failed reconnection attempts exceeds
 * options.maxReconnectAttempts the connection is closed
 *
 * @private
 * @returns {void}
 */
Connection.prototype._tryReconnect = function () {
  if (this._reconnectTimeout) {
    return
  }

  if (this._reconnectionAttempt < this._options.maxReconnectAttempts) {
    this._setState(C.CONNECTION_STATE.RECONNECTING)
    this._reconnectTimeout = setTimeout(
      this._tryOpen.bind(this),
      Math.min(
        this._options.maxReconnectInterval,
        this._options.reconnectIntervalIncrement * this._reconnectionAttempt
      )
    )
    this._reconnectionAttempt++
  } else {
    this._clearReconnect()
    this.close()
    this._client.emit(C.EVENT.MAX_RECONNECTION_ATTEMPTS_REACHED, this._reconnectionAttempt)
  }
}

/**
 * Attempts to open a errourosly closed connection
 *
 * @private
 * @returns {void}
 */
Connection.prototype._tryOpen = function () {
  if (this._originalUrl !== this._url) {
    this._url = this._originalUrl
  }
  this._createEndpoint()
  this._reconnectTimeout = null
}

/**
 * Stops all further reconnection attempts,
 * either because the connection is open again
 * or because the maximal number of reconnection
 * attempts has been exceeded
 *
 * @private
 * @returns {void}
 */
Connection.prototype._clearReconnect = function () {
  clearTimeout(this._reconnectTimeout)
  this._reconnectTimeout = null
  this._reconnectionAttempt = 0
}

module.exports = Connection
