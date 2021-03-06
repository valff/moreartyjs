var Imm = require('immutable');
var Util = require('./Util');
var ChangesDescriptor = require('./ChangesDescriptor');

/* ---------------- */
/* Private helpers. */
/* ---------------- */

var UNSET_VALUE = {};

var getBackingValue, setBackingValue;

getBackingValue = function (binding) {
  return binding._sharedInternals.backingValue;
};

setBackingValue = function (binding, newBackingValue) {
  binding._sharedInternals.backingValue = newBackingValue;
};

var EMPTY_PATH, PATH_SEPARATOR, getPathElements, getValueAtPath;

EMPTY_PATH = [];
PATH_SEPARATOR = '.';

getPathElements = function (path) {
  return path ? path.split(PATH_SEPARATOR) : [];
};

getValueAtPath = function (backingValue, path) {
  return backingValue && path.length > 0 ? backingValue.getIn(path) : backingValue;
};

var asArrayPath, asStringPath;

asArrayPath = function (path) {
  return typeof path === 'string' ?
    getPathElements(path) :
    (Util.undefinedOrNull(path) ? [] : path);
};

asStringPath = function (path) {
  switch (typeof path) {
    case 'string':
      return path;
    case 'number':
      return path.toString();
    default:
      return Util.undefinedOrNull(path) ? '' : path.join(PATH_SEPARATOR);
  }
};

var setOrUpdate, updateValue, removeValue, merge, clear;

setOrUpdate = function (rootValue, effectivePath, f) {
  return rootValue.updateIn(effectivePath, UNSET_VALUE, function (value) {
    return value === UNSET_VALUE ? f() : f(value);
  });
};

updateValue = function (self, subpath, f) {
  var backingValue = getBackingValue(self);
  var effectivePath = Util.joinPaths(self._path, subpath);
  var newBackingValue = setOrUpdate(backingValue, effectivePath, f);

  setBackingValue(self, newBackingValue);

  if (backingValue.hasIn(effectivePath)) {
    return effectivePath;
  } else {
    return effectivePath.slice(0, effectivePath.length - 1);
  }
};

removeValue = function (self, subpath) {
  var effectivePath = Util.joinPaths(self._path, subpath);
  var backingValue = getBackingValue(self);

  var len = effectivePath.length;
  switch (len) {
    case 0:
      throw new Error('Cannot delete root value');
    default:
      var pathTo = effectivePath.slice(0, len - 1);
      if (backingValue.has(pathTo[0]) || len === 1) {
        var newBackingValue = backingValue.updateIn(pathTo, function (coll) {
          var key = effectivePath[len - 1];
          if (coll instanceof Imm.List) {
            return coll.splice(key, 1);
          } else {
            return coll && coll.remove(key);
          }
        });

        setBackingValue(self, newBackingValue);
      }

      return pathTo;
  }
};

merge = function (preserve, newValue, value) {
  if (Util.undefinedOrNull(value)) {
    return newValue;
  } else {
    if (value instanceof Imm.Iterable && newValue instanceof Imm.Iterable) {
      return preserve ? newValue.mergeDeep(value) : value.mergeDeep(newValue);
    } else {
      return preserve ? value : newValue;
    }
  }
};

clear = function (value) {
  return value instanceof Imm.Iterable ? value.clear() : null;
};

var mkStateTransition =
  function (currentBackingValue, previousBackingValue, currentBackingMeta, previousBackingMeta, metaMetaChanged) {
    return {
      currentBackingValue: currentBackingValue,
      currentBackingMeta: currentBackingMeta,
      previousBackingValue: previousBackingValue,
      previousBackingMeta: previousBackingMeta,
      metaMetaChanged: metaMetaChanged || false
    };
  };

var notifyListeners, notifyGlobalListeners, startsWith, isPathAffected, notifyNonGlobalListeners, notifyAllListeners;

notifyListeners = function (self, samePathListeners, listenerPath, path, stateTransition) {
  var currentBackingValue = stateTransition.currentBackingValue;
  var previousBackingValue = stateTransition.previousBackingValue;
  var currentBackingMeta = stateTransition.currentBackingMeta;
  var previousBackingMeta = stateTransition.previousBackingMeta;

  Util.getPropertyValues(samePathListeners).forEach(function (listenerDescriptor) {
    if (!listenerDescriptor.disabled) {
      var listenerPathAsArray = asArrayPath(listenerPath);

      var valueChanged = currentBackingValue !== previousBackingValue &&
        currentBackingValue.getIn(listenerPathAsArray) !== previousBackingValue.getIn(listenerPathAsArray);
      var metaChanged = stateTransition.metaMetaChanged || (
        previousBackingMeta && currentBackingMeta !== previousBackingMeta &&
          currentBackingMeta.getIn(listenerPathAsArray) !== previousBackingMeta.getIn(listenerPathAsArray));

      if (valueChanged || metaChanged) {
        listenerDescriptor.cb(
          new ChangesDescriptor(
            path, listenerPathAsArray, valueChanged, metaChanged, stateTransition
          )
        );
      }
    }
  });
};

notifyGlobalListeners = function (self, path, stateTransition) {
  var listeners = self._sharedInternals.listeners;
  var globalListeners = listeners[''];
  if (globalListeners) {
    notifyListeners(self, globalListeners, EMPTY_PATH, path, stateTransition);
  }
};

startsWith = function (s1, s2) {
  return s1.indexOf(s2) === 0;
};

isPathAffected = function (listenerPath, changedPath) {
  return changedPath === '' || listenerPath === changedPath ||
    startsWith(changedPath, listenerPath + PATH_SEPARATOR) || startsWith(listenerPath, changedPath + PATH_SEPARATOR);
};

notifyNonGlobalListeners = function (self, path, stateTransition) {
  var listeners = self._sharedInternals.listeners;
  Object.keys(listeners).filter(Util.identity).forEach(function (listenerPath) {
    if (isPathAffected(listenerPath, asStringPath(path))) {
      notifyListeners(self, listeners[listenerPath], listenerPath, path, stateTransition);
    }
  });
};

notifyAllListeners = function (self, path, stateTransition) {
  notifyGlobalListeners(self, path, stateTransition);
  notifyNonGlobalListeners(self, path, stateTransition);
};

var linkMeta, unlinkMeta;

linkMeta = function (self, metaBinding) {
  self._sharedInternals.metaBindingListenerId = metaBinding.addListener(function (changes) {
    var metaNodePath = changes.getPath();
    var changedPath = metaNodePath.slice(0, metaNodePath.length - 1);

    var backingValue = getBackingValue(self);
    var metaMetaChanged = !changes.isValueChanged();
    var previousBackingMeta = metaMetaChanged ? getBackingValue(metaBinding) : changes.getPreviousValue();

    notifyAllListeners(
      self, changedPath,
      mkStateTransition(backingValue, backingValue, getBackingValue(metaBinding), previousBackingMeta, metaMetaChanged)
    );
  });
};

unlinkMeta = function (self, metaBinding) {
  var removed = metaBinding.removeListener(self._sharedInternals.metaBindingListenerId);
  self._sharedInternals.metaBinding = null;
  self._sharedInternals.metaBindingListenerId = null;
  return removed;
};

var findSamePathListeners, setListenerDisabled;

findSamePathListeners = function (self, listenerId) {
  return Util.find(
    Util.getPropertyValues(self._sharedInternals.listeners),
    function (samePathListeners) { return !!samePathListeners[listenerId]; }
  );
};

setListenerDisabled = function (self, listenerId, disabled) {
  var samePathListeners = findSamePathListeners(self, listenerId);
  if (samePathListeners) {
    samePathListeners[listenerId].disabled = disabled;
  }
};

var update, delete_;

update = function (self, subpath, f) {
  var previousBackingValue = getBackingValue(self);
  var affectedPath = updateValue(self, asArrayPath(subpath), f);
  var backingMeta = getBackingValue(self.meta());

  notifyAllListeners(
    self, affectedPath,
    mkStateTransition(getBackingValue(self), previousBackingValue, backingMeta, backingMeta)
  );
};

delete_ = function (self, subpath) {
  var previousBackingValue = getBackingValue(self);
  var affectedPath = removeValue(self, asArrayPath(subpath));
  var backingMeta = getBackingValue(self.meta());

  notifyAllListeners(
    self, affectedPath,
    mkStateTransition(getBackingValue(self), previousBackingValue, backingMeta, backingMeta)
  );
};

/** Binding constructor.
 * @param {String[]} [path] binding path, empty array if omitted
 * @param {Object} [sharedInternals] shared relative bindings internals:
 * <ul>
 *   <li>backingValue - backing value;</li>
 *   <li>metaBinding - meta binding;</li>
 *   <li>metaBindingListenerId - meta binding listener id;</li>
 *   <li>regCount - registration count (used for listener id generation);</li>
 *   <li>listeners - change listeners;</li>
 *   <li>cache - bindings cache.</li>
 * </ul>
 * @public
 * @class Binding
 * @classdesc Wraps immutable collection. Provides convenient read-write access to nested values.
 * Allows to create sub-bindings (or views) narrowed to a subpath and sharing the same backing value.
 * Changes to these bindings are mutually visible.
 * <p>Terminology:
 * <ul>
 *   <li>
 *     (sub)path - path to a value within nested associative data structure, example: 'path.t.0.some.value';
 *   </li>
 *   <li>
 *     backing value - value shared by all bindings created using [sub]{@link Binding#sub} method.
 *   </li>
 * </ul>
 * <p>Features:
 * <ul>
 *   <li>can create sub-bindings sharing same backing value. Sub-binding can only modify values down its subpath;</li>
 *   <li>allows to conveniently modify nested values: assign, update with a function, remove, and so on;</li>
 *   <li>can attach change listeners to a specific subpath;</li>
 *   <li>can perform multiple changes atomically in respect of listener notification.</li>
 * </ul>
 * @see Binding.init */
var Binding = function (path, sharedInternals) {
  /** @private */
  this._path = path || EMPTY_PATH;

  /** @protected
   * @ignore */
  this._sharedInternals = sharedInternals || {};

  if (Util.undefinedOrNull(this._sharedInternals.regCount)) {
    this._sharedInternals.regCount = 0;
  }

  if (!this._sharedInternals.listeners) {
    this._sharedInternals.listeners = {};
  }

  if (!this._sharedInternals.cache) {
    this._sharedInternals.cache = {};
  }
};

/* --------------- */
/* Static helpers. */
/* --------------- */

/** Create new binding with empty listeners set.
 * @param {Immutable.Map} [backingValue] backing value, empty map if omitted
 * @param {Binding} [metaBinding] meta binding
 * @return {Binding} fresh binding instance */
Binding.init = function (backingValue, metaBinding) {
  var binding = new Binding(EMPTY_PATH, {
    backingValue: backingValue || Imm.Map(),
    metaBinding: metaBinding
  });

  if (metaBinding) {
    linkMeta(binding, metaBinding);
  }

  return binding;
};

/** Convert string path to array path.
 * @param {String} pathAsString path as string
 * @return {Array} path as an array */
Binding.asArrayPath = function (pathAsString) {
  return asArrayPath(pathAsString);
};

/** Convert array path to string path.
 * @param {String[]} pathAsAnArray path as an array
 * @return {String} path as a string */
Binding.asStringPath = function (pathAsAnArray) {
  return asStringPath(pathAsAnArray);
};

/** Meta node name.
 * @deprecated Use Util.META_NODE instead.
 * @type {String} */
Binding.META_NODE = Util.META_NODE;

/** @lends Binding.prototype */
var bindingPrototype = {

  /** Get binding path.
   * @returns {Array} binding path */
  getPath: function () {
    return this._path;
  },

  /** Update backing value.
   * @param {Immutable.Map} newBackingValue new backing value
   * @return {Binding} new binding instance, original is unaffected */
  withBackingValue: function (newBackingValue) {
    var newSharedInternals = {};
    Util.assign(newSharedInternals, this._sharedInternals);
    newSharedInternals.backingValue = newBackingValue;
    return new Binding(this._path, newSharedInternals);
  },

  /** Check if binding value is changed in alternative backing value.
   * @param {Immutable.Map} alternativeBackingValue alternative backing value
   * @param {Function} [compare] alternative compare function, does reference equality check if omitted */
  isChanged: function (alternativeBackingValue, compare) {
    var value = this.get();
    var alternativeValue = alternativeBackingValue ? alternativeBackingValue.getIn(this._path) : undefined;
    return compare ?
        !compare(value, alternativeValue) :
        !(value === alternativeValue || (Util.undefinedOrNull(value) && Util.undefinedOrNull(alternativeValue)));
  },

  /** Check if this and supplied binding are relatives (i.e. share same backing value).
   * @param {Binding} otherBinding potential relative
   * @return {Boolean} */
  isRelative: function (otherBinding) {
    return this._sharedInternals === otherBinding._sharedInternals &&
      this._sharedInternals.backingValue === otherBinding._sharedInternals.backingValue;
  },

  /** Get binding's meta binding.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers;
   *                                 b.meta('path') is equivalent to b.meta().sub('path')
   * @returns {Binding} meta binding or undefined */
  meta: function (subpath) {
    if (!this._sharedInternals.metaBinding) {
      var metaBinding = Binding.init(Imm.Map());
      linkMeta(this, metaBinding);
      this._sharedInternals.metaBinding = metaBinding;
    }

    var effectiveSubpath = subpath ? Util.joinPaths([Util.META_NODE], asArrayPath(subpath)) : [Util.META_NODE];
    var thisPath = this.getPath();
    var absolutePath = thisPath.length > 0 ? Util.joinPaths(thisPath, effectiveSubpath) : effectiveSubpath;
    return this._sharedInternals.metaBinding.sub(absolutePath);
  },

  /** Unlink this binding's meta binding, removing change listener and making them totally independent.
   * May be used to prevent memory leaks when appropriate.
   * @return {Boolean} true if binding's meta binding was unlinked */
  unlinkMeta: function () {
    var metaBinding = this._sharedInternals.metaBinding;
    return metaBinding ? unlinkMeta(this, metaBinding) : false;
  },

  /** Get binding value.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @return {*} value at path or null */
  get: function (subpath) {
    return getValueAtPath(getBackingValue(this), Util.joinPaths(this._path, asArrayPath(subpath)));
  },

  /** Convert to JS representation.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @return {*} JS representation of data at subpath */
  toJS: function (subpath) {
    var value = this.sub(subpath).get();
    return value instanceof Imm.Iterable ? value.toJS() : value;
  },

  /** Bind to subpath. Both bindings share the same backing value. Changes are mutually visible.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @return {Binding} new binding instance, original is unaffected */
  sub: function (subpath) {
    var pathAsArray = asArrayPath(subpath);
    var absolutePath = Util.joinPaths(this._path, pathAsArray);
    if (absolutePath.length > 0) {
      var absolutePathAsString = asStringPath(absolutePath);
      var cached = this._sharedInternals.cache[absolutePathAsString];

      if (cached) {
        return cached;
      } else {
        var subBinding = new Binding(absolutePath, this._sharedInternals);
        this._sharedInternals.cache[absolutePathAsString] = subBinding;
        return subBinding;
      }
    } else {
      return this;
    }
  },

  /** Update binding value.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @param {Function} f update function
   * @return {Binding} this binding */
  update: function (subpath, f) {
    var args = Util.resolveArgs(arguments, '?subpath', 'f');
    update(this, args.subpath, args.f);
    return this;
  },

  /** Set binding value.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @param {*} newValue new value
   * @return {Binding} this binding */
  set: function (subpath, newValue) {
    var args = Util.resolveArgs(arguments, '?subpath', 'newValue');
    update(this, args.subpath, Util.constantly(args.newValue));
    return this;
  },

  /** Delete value.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @return {Binding} this binding */
  remove: function (subpath) {
    delete_(this, subpath);
    return this;
  },

  /** Deep merge values.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @param {Boolean} [preserve=false] preserve existing values when merging
   * @param {*} newValue new value
   * @return {Binding} this binding */
  merge: function (subpath, preserve, newValue) {
    var args = Util.resolveArgs(
      arguments,
      function (x) { return Util.canRepresentSubpath(x) ? 'subpath' : null; },
      '?preserve',
      'newValue'
    );
    update(this, args.subpath, merge.bind(null, args.preserve, args.newValue));
    return this;
  },

  /** Clear nested collection. Does '.clear()' on Immutable values, nullifies otherwise.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @return {Binding} this binding */
  clear: function (subpath) {
    var subpathAsArray = asArrayPath(subpath);
    if (!Util.undefinedOrNull(this.get(subpathAsArray))) {
      update(this, subpathAsArray, clear);
    }
    return this;
  },

  /** Add change listener.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @param {Function} cb function receiving changes descriptor
   * @return {String} unique id which should be used to un-register the listener
   * @see ChangesDescriptor */
  addListener: function (subpath, cb) {
    var args = Util.resolveArgs(
      arguments, function (x) { return Util.canRepresentSubpath(x) ? 'subpath' : null; }, 'cb'
    );

    var listenerId = 'reg' + this._sharedInternals.regCount++;
    var pathAsString = asStringPath(Util.joinPaths(this._path, asArrayPath(args.subpath || '')));
    var samePathListeners = this._sharedInternals.listeners[pathAsString];
    var listenerDescriptor = { cb: args.cb, disabled: false };
    if (samePathListeners) {
      samePathListeners[listenerId] = listenerDescriptor;
    } else {
      var listeners = {};
      listeners[listenerId] = listenerDescriptor;
      this._sharedInternals.listeners[pathAsString] = listeners;
    }
    return listenerId;
  },

  /** Add change listener triggered only once.
   * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
   * @param {Function} cb function receiving changes descriptor
   * @return {String} unique id which should be used to un-register the listener
   * @see ChangesDescriptor */
  addOnceListener: function (subpath, cb) {
    var args = Util.resolveArgs(
      arguments, function (x) { return Util.canRepresentSubpath(x) ? 'subpath' : null; }, 'cb'
    );

    var self = this;
    var listenerId = self.addListener(args.subpath, function () {
      self.removeListener(listenerId);
      args.cb();
    });
    return listenerId;
  },

  /** Enable listener.
   * @param {String} listenerId listener id
   * @return {Binding} this binding */
  enableListener: function (listenerId) {
    setListenerDisabled(this, listenerId, false);
    return this;
  },

  /** Disable listener.
   * @param {String} listenerId listener id
   * @return {Binding} this binding */
  disableListener: function (listenerId) {
    setListenerDisabled(this, listenerId, true);
    return this;
  },

  /** Execute function with listener temporarily disabled. Correctly handles functions returning promises.
   * @param {String} listenerId listener id
   * @param {Function} f function to execute
   * @return {Binding} this binding */
  withDisabledListener: function (listenerId, f) {
    var samePathListeners = findSamePathListeners(this, listenerId);
    if (samePathListeners) {
      var descriptor = samePathListeners[listenerId];
      descriptor.disabled = true;
      Util.afterComplete(f, function () { descriptor.disabled = false; });
    } else {
      f();
    }
    return this;
  },

  /** Un-register the listener.
   * @param {String} listenerId listener id
   * @return {Boolean} true if listener removed successfully, false otherwise */
  removeListener: function (listenerId) {
    var samePathListeners = findSamePathListeners(this, listenerId);
    return samePathListeners ? delete samePathListeners[listenerId] : false;
  },

  /** Create transaction context.
   * If promise is supplied, transaction will be automatically
   * cancelled and reverted (if already committed) on promise failure.
   * @param {Promise} [promise] ES6 promise
   * @return {TransactionContext} transaction context */
  atomically: function (promise) {
    return new TransactionContext(this, promise);
  }

};

bindingPrototype['delete'] = bindingPrototype.remove;

Binding.prototype = bindingPrototype;

/** Transaction context constructor.
 * @param {Binding} binding binding
 * @param {Promise} [promise] ES6 promise
 * @public
 * @class TransactionContext
 * @classdesc Transaction context. */
var TransactionContext = function (binding, promise) {
  /** @private */
  this._binding = binding;

  /** @private */
  this._queuedUpdates = [];
  /** @private */
  this._finishedUpdates = [];

  /** @private */
  this._committed = false;
  /** @private */
  this._cancelled = false;

  /** @private */
  this._hasChanges = false;
  /** @private */
  this._hasMetaChanges = false;

  if (promise) {
    var self = this;
    promise.then(Util.identity, function () {
      if (!self.isCancelled()) {
        self.cancel();
      }
    });
  }
};

TransactionContext.prototype = (function () {

  var UPDATE_TYPE = Object.freeze({
    UPDATE: 'update',
    DELETE: 'delete'
  });

  var registerUpdate, hasChanges;

  registerUpdate = function (self, binding) {
    if (!self._hasChanges) {
      self._hasChanges = binding.isRelative(self._binding);
    }

    if (!self._hasMetaChanges) {
      self._hasMetaChanges = !binding.isRelative(self._binding);
    }
  };

  hasChanges = function (self) {
    return self._hasChanges || self._hasMetaChanges;
  };

  var addUpdate, addDeletion, areSiblings, filterRedundantPaths, commitSilently;

  addUpdate = function (self, binding, update, subpath) {
    registerUpdate(self, binding);
    self._queuedUpdates.push({ binding: binding, update: update, subpath: subpath, type: UPDATE_TYPE.UPDATE });
  };

  addDeletion = function (self, binding, subpath) {
    registerUpdate(self, binding);
    self._queuedUpdates.push({ binding: binding, subpath: subpath, type: UPDATE_TYPE.DELETE });
  };

  areSiblings = function (path1, path2) {
    var path1Length = path1.length, path2Length = path2.length;
    return path1Length === path2Length &&
      (path1Length === 1 || path1[path1Length - 2] === path2[path1Length - 2]);
  };

  filterRedundantPaths = function (affectedPaths) {
    if (affectedPaths.length < 2) {
      return affectedPaths;
    } else {
      var sortedPaths = affectedPaths.sort();
      var previousPath = sortedPaths[0], previousPathAsString = asStringPath(previousPath);
      var result = [previousPath];
      for (var i = 1; i < sortedPaths.length; i++) {
        var currentPath = sortedPaths[i], currentPathAsString = asStringPath(currentPath);
        if (!startsWith(currentPathAsString, previousPathAsString)) {
          if (areSiblings(currentPath, previousPath)) {
            var commonParentPath = currentPath.slice(0, currentPath.length - 1);
            result.pop();
            result.push(commonParentPath);
            previousPath = commonParentPath;
            previousPathAsString = asStringPath(commonParentPath);
          } else {
            result.push(currentPath);
            previousPath = currentPath;
            previousPathAsString = currentPathAsString;
          }
        }
      }
      return result;
    }
  };

  commitSilently = function (self) {
    var finishedUpdates = self._queuedUpdates.map(function (update) {
      var previousBackingValue = getBackingValue(update.binding);
      var affectedPath = update.type === UPDATE_TYPE.UPDATE ?
        updateValue(update.binding, update.subpath, update.update) :
        removeValue(update.binding, update.subpath);

      return {
        affectedPath: affectedPath,
        binding: update.binding,
        previousBackingValue: previousBackingValue
      };
    });

    self._committed = true;
    self._queuedUpdates = null;

    return finishedUpdates;
  };

  var revert = function (self) {
    var finishedUpdates = self._finishedUpdates;
    if (finishedUpdates.length > 0) {
      var tx = self._binding.atomically();

      for (var i = finishedUpdates.length; i-- > 0;) {
        var update = finishedUpdates[i];
        var binding = update.binding, affectedPath = update.affectedPath;
        var relativeAffectedPath =
          binding.getPath().length === affectedPath.length ?
            affectedPath :
            affectedPath.slice(binding.getPath().length);

        tx.set(binding, relativeAffectedPath, update.previousBackingValue.getIn(affectedPath));
      }

      tx.commit();
    }

    self._finishedUpdates = null;
  };

  var cancel = function (self) {
    if (self.isCommitted()) {
      revert(self);
    }

    self._cancelled = true;
  };

  /** @lends TransactionContext.prototype */
  var transactionContextPrototype = {

    /** Update binding value.
     * @param {Binding} [binding] binding to apply update to
     * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
     * @param {Function} f update function
     * @return {TransactionContext} updated transaction */
    update: function (binding, subpath, f) {
      var args = Util.resolveArgs(
        arguments,
        function (x) { return x instanceof Binding ? 'binding' : null; }, '?subpath', 'f'
      );
      addUpdate(this, args.binding || this._binding, args.f, asArrayPath(args.subpath));
      return this;
    },

    /** Set binding value.
     * @param {Binding} [binding] binding to apply update to
     * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
     * @param {*} newValue new value
     * @return {TransactionContext} updated transaction context */
    set: function (binding, subpath, newValue) {
      var args = Util.resolveArgs(
        arguments,
        function (x) { return x instanceof Binding ? 'binding' : null; }, '?subpath', 'newValue'
      );
      return this.update(args.binding, args.subpath, Util.constantly(args.newValue));
    },

    /** Remove value.
     * @param {Binding} [binding] binding to apply update to
     * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
     * @return {TransactionContext} updated transaction context */
    remove: function (binding, subpath) {
      var args = Util.resolveArgs(
        arguments,
        function (x) { return x instanceof Binding ? 'binding' : null; }, '?subpath'
      );
      addDeletion(this, args.binding || this._binding, asArrayPath(args.subpath));
      return this;
    },

    /** Deep merge values.
     * @param {Binding} [binding] binding to apply update to
     * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
     * @param {Boolean} [preserve=false] preserve existing values when merging
     * @param {*} newValue new value
     * @return {TransactionContext} updated transaction context */
    merge: function (binding, subpath, preserve, newValue) {
      var args = Util.resolveArgs(
        arguments,
        function (x) { return x instanceof Binding ? 'binding' : null; },
        function (x) { return Util.canRepresentSubpath(x) ? 'subpath' : null; },
        function (x) { return typeof x === 'boolean' ? 'preserve' : null; },
        'newValue'
      );
      return this.update(args.binding, args.subpath, merge.bind(null, args.preserve, args.newValue));
    },

    /** Clear collection or nullify nested value.
     * @param {Binding} [binding] binding to apply update to
     * @param {String|Array} [subpath] subpath as a dot-separated string or an array of strings and numbers
     * @return {TransactionContext} updated transaction context */
    clear: function (binding, subpath) {
      var args = Util.resolveArgs(
        arguments,
        function (x) { return x instanceof Binding ? 'binding' : null; }, '?subpath'
      );
      addUpdate(this, args.binding || this._binding, clear, asArrayPath(args.subpath));
      return this;
    },

    /** Commit transaction (write changes and notify listeners).
     * @param {Object} [options] options object
     * @param {Boolean} [options.notify=true] should listeners be notified
     * @return {TransactionContext} updated transaction context */
    commit: function (options) {
      if (!this.isCommitted()) {
        if (!this.isCancelled() && hasChanges(this)) {
          var effectiveOptions = options || {};
          var binding = this._binding;
          var metaBinding = binding.meta();

          var previousBackingValue = null, previousBackingMeta = null;
          if (effectiveOptions.notify !== false) {
            previousBackingValue = getBackingValue(binding);
            previousBackingMeta = getBackingValue(metaBinding);
          }

          this._finishedUpdates = commitSilently(this);
          var affectedPaths = this._finishedUpdates.map(function (update) { return update.affectedPath; });

          if (effectiveOptions.notify !== false) {
            var filteredPaths = filterRedundantPaths(affectedPaths);

            var stateTransition = mkStateTransition(
              getBackingValue(binding), previousBackingValue, getBackingValue(metaBinding), previousBackingMeta
            );

            notifyGlobalListeners(binding, filteredPaths[0], stateTransition);
            filteredPaths.forEach(function (path) {
              notifyNonGlobalListeners(binding, path, stateTransition);
            });
          }
        }

        return this;
      } else {
        throw new Error('Morearty: transaction already committed');
      }
    },

    /** Cancel this transaction.
     * Committing cancelled transaction won't have any effect.
     * For committed transactions affected paths will be reverted to original values,
     * overwriting any changes made after transaction has been committed. */
    cancel: function () {
      if (!this.isCancelled()) {
        cancel(this);
      } else {
        throw new Error('Morearty: transaction already cancelled');
      }
    },

    /** Check if transaction was committed.
     * @return {Boolean} committed flag */
    isCommitted: function () {
      return this._committed;
    },

    /** Check if transaction was cancelled, either manually or due to promise failure.
     * @return {Boolean} cancelled flag */
    isCancelled: function () {
      return this._cancelled;
    }

  };

  transactionContextPrototype['delete'] = transactionContextPrototype.remove;

  return transactionContextPrototype;
})();

module.exports = Binding;
