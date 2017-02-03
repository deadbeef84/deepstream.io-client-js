const jsonPath = require('./json-path')
const utils = require('../utils/utils')
const EventEmitter = require('component-emitter')
const C = require('../constants/constants')
const messageParser = require('../message/message-parser')
const xuid = require('xuid')
const invariant = require('invariant')

const Record = function (name, connection, client) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid argument name')
  }

  this.name = name
  this.usages = 0
  this.isDestroyed = false
  this.isReady = false
  this.isSubscribed = true
  this.hasProvider = false
  this.version = null

  this._connection = connection
  this._client = client
  this._eventEmitter = new EventEmitter()

  this._data = undefined
  this._patchQueue = []

  this._handleConnectionStateChange = this._handleConnectionStateChange.bind(this)
  this._client.on('connectionStateChanged', this._handleConnectionStateChange)

  this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.READ, [this.name])
}

EventEmitter(Record.prototype)

Record.prototype.get = function (path) {
  invariant(!this.isDestroyed, `"get" cannot use destroyed record ${this.name}`)

  return jsonPath.get(this._data, path)
}

Record.prototype.set = function (pathOrData, dataOrNil) {
  invariant(!this.isDestroyed, `"set" cannot use destroyed record ${this.name}`)

  if (this.isDestroyed) {
    return
  }

  const path = arguments.length === 1 ? undefined : pathOrData
  const data = arguments.length === 1 ? pathOrData : dataOrNil

  if (path === undefined && typeof data !== 'object') {
    throw new Error('invalid argument data')
  }
  if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
    throw new Error('invalid argument path')
  }

  if (path && this._patchQueue) {
    this._patchQueue.push({ path, data })
  } else {
    this._patchQueue = undefined
  }

  const oldValue = this._data
  const newValue = jsonPath.set(oldValue, path, data)

  if (oldValue === newValue) {
    return Promise.resolve()
  }

  this._applyChange(newValue)

  if (this.isReady) {
    this._dispatchUpdate()
  }

  return Promise.resolve()
}

Record.prototype.subscribe = function (path, callback, triggerNow) {
  invariant(!this.isDestroyed, `"subscribe" cannot use destroyed record ${this.name}`)

  if (this.isDestroyed) {
    return
  }

  const args = this._normalizeArguments(arguments)

  if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length === 0)) {
    throw new Error('invalid argument path')
  }
  if (typeof args.callback !== 'function') {
    throw new Error('invalid argument callback')
  }

  this._eventEmitter.on(args.path, args.callback)

  if (args.triggerNow && this._data) {
    args.callback(this.get(args.path))
  }
}

Record.prototype.unsubscribe = function (pathOrCallback, callback) {
  invariant(!this.isDestroyed, `"unsubscribe" cannot use destroyed record ${this.name}`)

  if (this.isDestroyed) {
    return
  }

  const args = this._normalizeArguments(arguments)

  if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length === 0)) {
    throw new Error('invalid argument path')
  }
  if (args.callback !== undefined && typeof args.callback !== 'function') {
    throw new Error('invalid argument callback')
  }

  this._eventEmitter.off(args.path, args.callback)
}

Record.prototype.whenReady = function () {
  invariant(!this.isDestroyed, `"whenReady" cannot use destroyed record ${this.name}`)

  if (this.isDestroyed) {
    return Promise.reject(new Error('destroyed'))
  }

  return new Promise((resolve, reject) => {
    if (this.isReady) {
      resolve()
    } else {
      this.once('ready', resolve)
      this.once('destroy', () => reject(new Error('destroyed')))
    }
  })
}

Record.prototype.discard = function (silent) {
  invariant(silent || !this.isDestroyed, `"discard" cannot use destroyed record ${this.name}`)

  if (this.isDestroyed) {
    return
  }

  this.usages -= 1
}

Record.prototype.destroy = function () {
  if (this.isSubscribed) {
    this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UNSUBSCRIBE, [this.name])
  }

  this.isDestroyed = true
  this.isSubscribed = false
  this._data = undefined
  this._patchQueue = []
  this._client.off('connectionStateChanged', this._handleConnectionStateChange)
  this._eventEmitter.off()
  this.off()

  this.emit('destroy', this.name)
}

Record.prototype._$onMessage = function (message) {
  invariant(!this.isDestroyed, `"_$onMessage" cannot use destroyed record ${this.name}`)

  if (this.isDestroyed) {
    return
  }

  if (message.action === C.ACTIONS.UPDATE) {
    if (!this.isReady) {
      this._onRead(message)
    } else {
      this._applyUpdate(message)
    }
    return
  }

  if (message.action === C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER) {
    var hasProvider = messageParser.convertTyped(message.data[1], this._client)
    this.hasProvider = hasProvider
    this.emit('hasProviderChanged', hasProvider)
    return
  }
}

Record.prototype._dispatchUpdate = function () {
  const start = this.version ? parseInt(this.version.split('-')[0], 10) : 0
  const version = `${start + 1}-${xuid()}`
  this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [
    this.name,
    version,
    this._data,
    this.version
  ])
  this.version = version
}

Record.prototype._applyUpdate = function (message) {
  const version = message.data[1]

  if (utils.compareVersions(this.version, version)) {
    return
  }

  this.version = version
  this._applyChange(jsonPath.set(this._data, undefined, JSON.parse(message.data[2])))
}

Record.prototype._onRead = function (message) {
  let oldValue = JSON.parse(message.data[2])
  let newValue = this._data || oldValue

  if (this._patchQueue) {
    newValue = oldValue
    for (let i = 0; i < this._patchQueue.length; i++) {
      newValue = jsonPath.set(newValue, this._patchQueue[i].path, this._patchQueue[i].data)
    }
    this._patchQueue = undefined
  }

  this.isReady = true
  this.version = message.data[1]
  this._applyChange(newValue)

  if (newValue !== oldValue) {
    this._dispatchUpdate()
  }

  this.emit('ready')
}

Record.prototype._applyChange = function (newData) {
  if (this.isDestroyed) {
    return
  }

  const oldData = this._data
  this._data = newData

  if (!this._eventEmitter._callbacks) {
    return
  }

  const paths = Object.keys(this._eventEmitter._callbacks)

  for (let i = 0; i < paths.length; i++) {
    const newValue = jsonPath.get(newData, paths[i])
    const oldValue = jsonPath.get(oldData, paths[i])

    if (newValue !== oldValue) {
      this._eventEmitter.emit(paths[i], this.get(paths[i]))
    }
  }
}

Record.prototype._normalizeArguments = function (args) {
  const result = Object.create(null)

  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string') {
      result.path = args[i]
    } else if (typeof args[i] === 'function') {
      result.callback = args[i]
    } else if (typeof args[i] === 'boolean') {
      result.triggerNow = args[i]
    }
  }

  return result
}

Record.prototype._handleConnectionStateChange = function () {
  if (this.isDestroyed) {
    return
  }

  const state = this._client.getConnectionState()

  if (state === C.CONNECTION_STATE.OPEN) {
    if (!this.isSubscribed) {
      this._connection.sendMsg(C.TOPIC.RECORD, C.ACTIONS.READ, [this.name])
      this.isSubscribed = true
    }
  } else if (state === C.CONNECTION_STATE.RECONNECTING) {
    this.isSubscribed = false
  } else if (state === C.CONNECTION_STATE.CLOSED) {
    this.isSubscribed = false
    this._destroy(true)
  }
}

module.exports = Record
