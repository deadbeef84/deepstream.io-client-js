const utils = require('../utils/utils')
const PARTS_REG_EXP = /([^.[\]\s]+)/g

const cache = new Map()
const EMPTY = utils.deepFreeze({})

function get (data, path) {
  const tokens = tokenize(path)

  data = data || EMPTY

  for (let i = 0; i < tokens.length; i++) {
    if (data === undefined) {
      return undefined
    }
    if (typeof data !== 'object' || data === null) {
      throw new Error('invalid data or path')
    }
    data = data[tokens[i]]
  }

  return data
}

function set (data, path, value) {
  const tokens = tokenize(path)

  if (tokens.length === 0) {
    return patch(data, value)
  }

  const oldValue = get(data, path)
  const newValue = patch(oldValue, value)

  if (newValue === oldValue) {
    return data
  }

  const result = data ? utils.shallowCopy(data) : {}

  let node = result
  for (let i = 0; i < tokens.length; i++) {
    if (i === tokens.length - 1) {
      node[tokens[i]] = newValue
    } else if (node[tokens[i]] !== undefined) {
      node = node[tokens[i]] = utils.shallowCopy(node[tokens[i]])
    } else if (tokens[i + 1] && !isNaN(tokens[i + 1])) {
      node = node[tokens[i]] = []
    } else {
      node = node[tokens[i]] = {}
    }
  }
  return result
}

function patch (oldValue, newValue) {
  if (oldValue === null || newValue === null) {
    return newValue
  } else if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    // TODO (perf): Return newValue when possible...
    let arr = newValue.length === oldValue.length ? null : []
    for (let i = 0; i < newValue.length; i++) {
      const value = patch(oldValue[i], newValue[i])

      if (!arr) {
        if (value === oldValue[i]) {
          continue
        }
        arr = []
        for (let j = 0; j < i; ++j) {
          arr[j] = oldValue[j]
        }
      }

      arr[i] = value
    }

    return arr || oldValue
  } else if (!Array.isArray(newValue) && typeof oldValue === 'object' && typeof newValue === 'object') {
    // TODO (perf): Return newValue when possible...
    const newKeys = Object.keys(newValue)
    const oldKeys = Object.keys(oldValue)

    let obj = newKeys.length === oldKeys.length ? null : {}

    for (let i = 0; i < newKeys.length; ++i) {
      const key = newKeys[i]
      const val = patch(oldValue[key], newValue[key])

      if (!obj) {
        if (val === oldValue[key] && key === oldKeys[i]) {
          continue
        }
        obj = {}
        for (let j = 0; j < i; ++j) {
          obj[newKeys[j]] = oldValue[newKeys[j]]
        }
      }

      obj[key] = val
    }

    return obj || oldValue
  } else {
    return newValue === oldValue ? oldValue : newValue
  }
}

function tokenize (path) {
  if (!path) {
    return []
  }

  let parts = cache.get(path)

  if (parts) {
    return parts
  }

  parts = path && String(path) !== 'undefined' ? String(path).match(PARTS_REG_EXP) : []

  if (!parts) {
    throw new Error('invalid path ' + path)
  }

  cache.set(path, parts)

  return parts
}

module.exports = {
  EMPTY,
  get,
  set
}
