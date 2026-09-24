import { useMemo, useSyncExternalStore } from 'react';

/**
 * @typedef {import('./store.js').Store} Store
 * @typedef {import('./store.js').StateObject} StateObject
 */

/**
 * Reads a slice of a store's state; the component re-renders only when that slice changes (by `isEqual`).
 * Unchanged subtrees keep their identity between snapshots, so selecting an object or array is as cheap
 * as selecting a primitive. A selector that builds a new object on every call needs `shallowEqual`.
 * @template T
 * @param {Store} store
 * @param {(state: any) => T} selector
 * @param {(a: T, b: T) => boolean} [isEqual]
 * @returns {T}
 */
export function useSelector(store, selector, isEqual = Object.is) {
  // Memoized so React's repeated getSnapshot() calls return the same value, and so an equal selection
  // keeps the previous one's identity (the pattern of React's own useSyncExternalStoreWithSelector).
  const getSelection = useMemo(() => {
    let hasMemo = false;
    /** @type {StateObject} */
    let memoState;
    /** @type {T} */
    let memoSelection;
    return () => {
      const state = store.getSnapshot();
      if (hasMemo && state === memoState) {
        return memoSelection;
      }
      const selection = selector(state);
      memoState = state;
      if (hasMemo && isEqual(memoSelection, selection)) {
        return memoSelection;
      }
      hasMemo = true;
      memoSelection = selection;
      return selection;
    };
  }, [store, selector, isEqual]);

  return useSyncExternalStore(store.subscribe, getSelection);
}

/**
 * Compares two values by their own enumerable keys (or array items), one level deep.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) {
    return false;
  }
  return keysA.every(
    (key) => Object.hasOwn(b, key) && Object.is(/** @type {any} */ (a)[key], /** @type {any} */ (b)[key]),
  );
}
