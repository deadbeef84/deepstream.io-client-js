const BrowserWebSocket = global.WebSocket || global.MozWebSocket
const NodeWebSocket = require('ws')
const messageParser = require('./message-parser')
const messageBuilder = require('./message-builder')
const utils = require('../utils/utils')
const C = require('../constants/constants')

const Connection = function (client, url, options) {
  this._client = client
  this._options = options
  this._logger = options.logger
  this._authParams = null
  this._authCallback = null
  this._deliberateClose = false
  this._redirecting = false
  this._tooManyAuthAttempts = false
  this._connectionAuthenticationTimeout = false
  this._challengeDenied = false
  this._queuedMessages = []
  this._message = {
    raw: null,
    topic: null,
    action: null,
    data: null
  }
  this._messages = []
  this._messagesIndex = 0
  this._reconnectTimeout = null
  this._reconnectionAttempt = 0
  this._messageSender = null
  this._endpoint = null
  this._lastHeartBeat = null
  this._heartbeatInterval = null

  this._sendQueuedMessages = this._sendQueuedMessages.bind(this)
  this._processMessages = this._processMessages.bind(this)
  this._processIdleCallback = null

  this._originalUrl = utils.parseUrl(url, this._options.path)
  this._url = this._originalUrl
  this._idleTimeout = this._options.maxIdleTime

  this._state = C.CONNECTION_STATE.CLOSED
  this._createEndpoint()
}

Connection.prototype.getState = function () {
  return this._state
}

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

Connection.prototype.sendMsg = function (topic, action, data) {
  this.send(messageBuilder.getMsg(topic, action, data))
}

Connection.prototype.sendMsg1 = function (topic, action, p0) {
  this.send(messageBuilder.getMsg1(topic, action, p0))
}

Connection.prototype.sendMsg2 = function (topic, action, p0, p1) {
  this.send(messageBuilder.getMsg2(topic, action, p0, p1))
}

Connection.prototype.send = function (message) {
  this._queuedMessages.push(message)
  if (this._queuedMessages.length > this._options.maxMessagesPerPacket) {
    clearTimeout(this._messageSender)
    this._sendQueuedMessages()
  } else if (!this._messageSender) {
    this._messageSender = setTimeout(this._sendQueuedMessages, this._options.sendDelay)
  }
}

Connection.prototype.flush = function () {
  this._sendQueuedMessages()
}

Connection.prototype.close = function () {
  this._sendQueuedMessages()
  this._reset()
  this._deliberateClose = true
  this._endpoint.close()
}

Connection.prototype._createEndpoint = function () {
  this._endpoint = BrowserWebSocket ? new BrowserWebSocket(this._url) : new NodeWebSocket(this._url)

  this._endpoint.onopen = this._onOpen.bind(this)
  this._endpoint.onerror = this._onError.bind(this)
  this._endpoint.onclose = this._onClose.bind(this)
  this._endpoint.onmessage = this._onMessage.bind(this)
}

Connection.prototype._sendQueuedMessages = function () {
  if (this._state !== C.CONNECTION_STATE.OPEN || this._endpoint.readyState !== this._endpoint.OPEN) {
    return
  }

  while (this._queuedMessages.length > 0) {
    this._submit(this._queuedMessages.splice(0, this._options.maxMessagesPerPacket).join(''))
  }

  this._messageSender = null
}

Connection.prototype._submit = function (message) {
  if (this._endpoint.readyState === this._endpoint.OPEN) {
    this._endpoint.send(message)
  } else {
    this._onError(new Error('Tried to send message on a closed websocket connection'))
  }
}

Connection.prototype._sendAuthParams = function () {
  this._setState(C.CONNECTION_STATE.AUTHENTICATING)
  const authMessage = messageBuilder.getMsg(C.TOPIC.AUTH, C.ACTIONS.REQUEST, [this._authParams])
  this._submit(authMessage)
}

Connection.prototype._checkHeartBeat = function () {
  const heartBeatTolerance = this._options.heartbeatInterval * 3

  if (Date.now() - this._lastHeartBeat > heartBeatTolerance) {
    clearInterval(this._heartbeatInterval)
    this._endpoint.close()
    this._client._$onError(
      C.TOPIC.CONNECTION,
      C.EVENT.CONNECTION_ERROR,
      `heartbeat not received in the last ${heartBeatTolerance} milliseconds`)
  } else {
    this._submit(messageBuilder.getMsg(C.TOPIC.CONNECTION, C.ACTIONS.PING))
  }
}

Connection.prototype._onOpen = function () {
  this._clearReconnect()
  this._lastHeartBeat = Date.now()
  this._heartbeatInterval = utils.setInterval(this._checkHeartBeat.bind(this), this._options.heartbeatInterval)
  this._setState(C.CONNECTION_STATE.AWAITING_CONNECTION)
}

Connection.prototype._onError = function (err) {
  this._reset()

  this._setState(C.CONNECTION_STATE.ERROR)

  if (err.error) {
    const { message, error } = err
    err = error
    err.message = message
  }

  if (!err.message) {
    err.message = 'socket error'
  }

  // NOTE: If the implementation isn't listening on the error event this will throw
  // an error. So let's defer it to allow the reconnection to kick in.
  setTimeout(() => {
    let msg
    if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
      msg = 'Can\'t connect! Deepstream server unreachable on ' + this._originalUrl
    } else {
      msg = err.message
    }
    this._client._$onError(C.TOPIC.CONNECTION, C.EVENT.CONNECTION_ERROR, msg)
  }, 1)
}

Connection.prototype._onClose = function () {
  this._reset()

  if (this._redirecting === true) {
    this._redirecting = false
    this._createEndpoint()
  } else if (this._deliberateClose === true) {
    this._setState(C.CONNECTION_STATE.CLOSED)
  } else {
    this._tryReconnect()
  }
}

Connection.prototype._onMessage = function (message) {
  Array.prototype.push.apply(this._messages, message.data.split(C.MESSAGE_SEPERATOR))
  if (!this._processIdleCallback) {
    this._processIdleCallback = utils.requestIdleCallback(this._processMessages)
  }
}

Connection.prototype._processMessages = function (deadline) {
  while (true) {
    if (deadline.timeRemaining() <= 0) {
      this._processIdleCallback = utils.requestIdleCallback(this._processMessages)
      return
    }

    if (this._messages.length === 0) {
      this._processIdleCallback = null
      return
    }

    if (this._messagesIndex > 1024) {
      this._messages.splice(this._messagesIndex)
      this._messagesIndex = 0
    }

    const message = this._messages[this._messagesIndex]
    this._messages[this._messagesIndex++] = null

    if (message.length <= 2) {
      continue
    }

    if (this._logger) {
      this._logger.trace(message, 'receive')
    }

    messageParser.parseMessage(message, this._client, this._message)

    if (this._message.topic === C.TOPIC.CONNECTION) {
      this._handleConnectionResponse(this._message)
    } else if (this._message.topic === C.TOPIC.AUTH) {
      this._handleAuthResponse(this._message)
    } else {
      this._client._$onMessage(this._message)
    }
  }
}

Connection.prototype._reset = function () {
  if (this._heartbeatInterval) {
    clearInterval(this._heartbeatInterval)
    this._heartbeatInterval = null
    this._lastHeartBeat = null
  }

  if (this._messageSender) {
    clearTimeout(this._messageSender)
    this._messageSender = null
    this._queuedMessages.length = 0
  }
}

Connection.prototype._handleConnectionResponse = function (message) {
  if (message.action === C.ACTIONS.PING) {
    this._lastHeartBeat = Date.now()
    this._submit(messageBuilder.getMsg(C.TOPIC.CONNECTION, C.ACTIONS.PONG))
  } else if (message.action === C.ACTIONS.PONG) {
    this._lastHeartBeat = Date.now()
  } else if (message.action === C.ACTIONS.ACK) {
    this._setState(C.CONNECTION_STATE.AWAITING_AUTHENTICATION)
    if (this._authParams) {
      this._sendAuthParams()
    }
  } else if (message.action === C.ACTIONS.CHALLENGE) {
    this._setState(C.CONNECTION_STATE.CHALLENGING)
    this._submit(messageBuilder.getMsg(C.TOPIC.CONNECTION, C.ACTIONS.CHALLENGE_RESPONSE, [this._originalUrl]))
  } else if (message.action === C.ACTIONS.REJECTION) {
    this._challengeDenied = true
    this.close()
  } else if (message.action === C.ACTIONS.REDIRECT) {
    this._url = message.data[0]
    this._redirecting = true
    this._endpoint.close()
  } else if (message.action === C.ACTIONS.ERROR) {
    if (message.data[0] === C.EVENT.CONNECTION_AUTHENTICATION_TIMEOUT) {
      this._deliberateClose = true
      this._connectionAuthenticationTimeout = true
      this._client._$onError(C.TOPIC.CONNECTION, message.data[0], message.data[1])
    }
  }
}

Connection.prototype._handleAuthResponse = function (message) {
  if (message.action === C.ACTIONS.ERROR) {
    if (message.data[0] === C.EVENT.TOO_MANY_AUTH_ATTEMPTS) {
      this._deliberateClose = true
      this._tooManyAuthAttempts = true
    } else {
      this._setState(C.CONNECTION_STATE.AWAITING_AUTHENTICATION)
    }

    if (this._authCallback) {
      this._authCallback(false, this._getAuthData(message.data[1]))
    }
  } else if (message.action === C.ACTIONS.ACK) {
    this._setState(C.CONNECTION_STATE.OPEN)

    if (this._authCallback) {
      this._authCallback(true, this._getAuthData(message.data[0]))
    }

    this._sendQueuedMessages()
  }
}

Connection.prototype._getAuthData = function (data) {
  if (data === undefined) {
    return null
  } else {
    return messageParser.convertTyped(data, this._client)
  }
}

Connection.prototype._setState = function (state) {
  if (this._state === state) {
    return
  }
  this._state = state
  this._client.emit(C.EVENT.CONNECTION_STATE_CHANGED, state)
}

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

Connection.prototype._tryOpen = function () {
  if (this._originalUrl !== this._url) {
    this._url = this._originalUrl
  }
  this._createEndpoint()
  this._reconnectTimeout = null
}

Connection.prototype._clearReconnect = function () {
  clearTimeout(this._reconnectTimeout)
  this._reconnectTimeout = null
  this._reconnectionAttempt = 0
}

module.exports = Connection
