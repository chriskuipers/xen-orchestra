import forEach from 'lodash.foreach'
import {BaseError} from 'make-error'
import {EventEmitter} from 'events'

import isEmpty from './is-empty'

// ===================================================================

const {hasOwnProperty} = Object

// ===================================================================

export class BufferAlreadyFlushed extends BaseError {
  constructor () {
    super('buffer flush already requested')
  }
}

export class DuplicateIndex extends BaseError {
  constructor (name) {
    super('there is already an index with the name ' + name)
  }
}

export class DuplicateItem extends BaseError {
  constructor (key) {
    super('there is already a item with the key ' + key)
  }
}

export class IllegalTouch extends BaseError {
  constructor (value) {
    super('only an object value can be touched (found a ' + typeof value + ')')
  }
}

export class InvalidKey extends BaseError {
  constructor (key) {
    super('invalid key of type ' + typeof key)
  }
}

export class NoSuchIndex extends BaseError {
  constructor (name) {
    super('there is no index with the name ' + name)
  }
}

export class NoSuchItem extends BaseError {
  constructor (key) {
    super('there is no item with the key ' + key)
  }
}

// -------------------------------------------------------------------

export default class Collection extends EventEmitter {
  constructor () {
    super()

    this._buffer = Object.create(null)
    this._buffering = 0
    this._indexes = Object.create(null)
    this._indexedItems = Object.create(null)
    this._items = {} // Object.create(null)
    this._size = 0
  }

  // Overridable method used to compute the key of an item when
  // unspecified.
  //
  // Default implementation returns the `id` property.
  getKey (value) {
    return value && value.id
  }

  // -----------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------

  get all () {
    return this._items
  }

  get indexes () {
    return this._indexedItems
  }

  get size () {
    return this._size
  }

  // -----------------------------------------------------------------
  // Manipulation
  // -----------------------------------------------------------------

  add (keyOrObjectWithId, valueIfKey = undefined) {
    const [key, value] = this._resolveItem(keyOrObjectWithId, valueIfKey)
    this._assertHasNot(key)

    this._items[key] = value
    this._size++
    this._touch('add', key)
  }

  clear () {
    forEach(this._items, (_, key) => {
      delete this._items[key]
      this._size--
      this._touch('remove', key)
    })
  }

  remove (keyOrObjectWithId) {
    const [key] = this._resolveItem(keyOrObjectWithId)
    this._assertHas(key)

    delete this._items[key]
    this._size--
    this._touch('remove', key)
  }

  set (keyOrObjectWithId, valueIfKey = undefined) {
    const [key, value] = this._resolveItem(keyOrObjectWithId, valueIfKey)

    const action = this.has(key) ? 'update' : 'add'
    this._items[key] = value
    if (action === 'add') {
      this._size++
    }
    this._touch(action, key)
  }

  touch (keyOrObjectWithId) {
    const [key] = this._resolveItem(keyOrObjectWithId)
    this._assertHas(key)
    const value = this.get(key)
    if (typeof value !== 'object' || value === null) {
      throw new IllegalTouch(value)
    }

    this._touch('update', key)

    return this.get(key)
  }

  unset (keyOrObjectWithId) {
    const [key] = this._resolveItem(keyOrObjectWithId)

    if (this.has(key)) {
      delete this._items[key]
      this._size--
      this._touch('remove', key)
    }
  }

  update (keyOrObjectWithId, valueIfKey = undefined) {
    const [key, value] = this._resolveItem(keyOrObjectWithId, valueIfKey)
    this._assertHas(key)

    this._items[key] = value
    this._touch('update', key)
  }

  // -----------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------

  get (key, defaultValue) {
    if (this.has(key)) {
      return this._items[key]
    }

    if (arguments.length > 1) {
      return defaultValue
    }

    // Throws a NoSuchItem.
    this._assertHas(key)
  }

  has (key) {
    return hasOwnProperty.call(this._items, key)
  }

  // -----------------------------------------------------------------
  // Indexes
  // -----------------------------------------------------------------

  createIndex (name, index) {
    const {_indexes: indexes} = this
    if (hasOwnProperty.call(indexes, name)) {
      throw new DuplicateIndex(name)
    }

    indexes[name] = index
    this._indexedItems[name] = index.items

    index._attachCollection(this)
  }

  deleteIndex (name) {
    const {_indexes: indexes} = this
    if (!hasOwnProperty.call(indexes, name)) {
      throw new NoSuchIndex(name)
    }

    const index = indexes[name]
    delete indexes[name]
    delete this._indexedItems[name]

    index._detachCollection(this)
  }

  // -----------------------------------------------------------------
  // Iteration
  // -----------------------------------------------------------------

  * [Symbol.iterator] () {
    const {_items: items} = this

    for (let key in items) {
      yield [key, items[key]]
    }
  }

  * keys () {
    const {_items: items} = this

    for (let key in items) {
      yield key
    }
  }

  * values () {
    const {_items: items} = this

    for (let key in items) {
      yield items[key]
    }
  }

  // -----------------------------------------------------------------
  // Events buffering
  // -----------------------------------------------------------------

  bufferEvents () {
    ++this._buffering

    let called = false
    return () => {
      if (called) {
        throw new BufferAlreadyFlushed()
      }
      called = true

      if (--this._buffering) {
        return
      }

      const {_buffer: buffer} = this

      // Due to deduplication there could be nothing in the buffer.
      if (isEmpty(buffer)) {
        return
      }

      const data = {
        add: Object.create(null),
        remove: Object.create(null),
        update: Object.create(null)
      }

      for (let key in this._buffer) {
        data[buffer[key]][key] = this._items[key]
      }

      forEach(data, (items, action) => {
        if (!isEmpty(items)) {
          this.emit(action, items)
        }
      })

      // Indicates the end of the update.
      //
      // This name has been chosen because it is used in Node writable
      // streams when the data has been successfully committed.
      this.emit('finish')

      this._buffer = Object.create(null)
    }
  }

  // =================================================================

  _assertHas (key) {
    if (!this.has(key)) {
      throw new NoSuchItem(key)
    }
  }

  _assertHasNot (key) {
    if (this.has(key)) {
      throw new DuplicateItem(key)
    }
  }

  _assertValidKey (key) {
    if (!this._isValidKey(key)) {
      throw new InvalidKey(key)
    }
  }

  _isValidKey (key) {
    return typeof key === 'number' || typeof key === 'string'
  }

  _resolveItem (keyOrObjectWithId, valueIfKey = undefined) {
    if (valueIfKey !== undefined) {
      this._assertValidKey(keyOrObjectWithId)

      return [keyOrObjectWithId, valueIfKey]
    }

    if (this._isValidKey(keyOrObjectWithId)) {
      return [keyOrObjectWithId]
    }

    const key = this.getKey(keyOrObjectWithId)
    this._assertValidKey(key)

    return [key, keyOrObjectWithId]
  }

  _touch (action, key) {
    if (this._buffering === 0) {
      const flush = this.bufferEvents()

      process.nextTick(flush)
    }

    if (action === 'add') {
      this._buffer[key] = this._buffer[key] ? 'update' : 'add'
    } else if (action === 'remove') {
      if (this._buffer[key] === 'add') {
        delete this._buffer[key]
      } else {
        this._buffer[key] = 'remove'
      }
    } else { // update
      if (!this._buffer[key]) {
        this._buffer[key] = 'update'
      }
    }
  }
}
