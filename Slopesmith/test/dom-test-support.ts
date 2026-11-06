import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as database from 'fake-indexeddb';

/** DOM behavior in Node, retaining native byte, fetch and crypto APIs used by actual app modules. */
export function installTestDom(url = 'https://dom.test/') {
  const native = {
    fetch,
    Request,
    Response,
    Headers,
    Blob,
    File,
    URL,
    URLSearchParams,
    crypto,
    structuredClone,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    WritableStream,
    TransformStream,
  };
  const indexedKeys = Object.keys(database).filter(key => key.startsWith('IDB') || key === 'indexedDB');
  const previous = new Map(indexedKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  GlobalRegistrator.register({ url, width: 1280, height: 900 });
  const errors: unknown[] = [];
  const capture = (event: ErrorEvent) => {
    errors.push(event.error ?? event.message);
    event.preventDefault();
  };
  window.addEventListener('error', capture);
  // happy-dom omits the browser's convenience constructor; use its real option element implementation.
  Object.defineProperty(globalThis, 'Option', {
    configurable: true,
    value: function Option(text = '', value = text, defaultSelected = false, selected = false) {
      const option = document.createElement('option');
      option.text = text;
      option.value = value;
      option.defaultSelected = defaultSelected;
      option.selected = selected;
      return option;
    },
  });
  for (const [key, value] of Object.entries(native))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  for (const key of indexedKeys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'indexedDB' ? new database.IDBFactory() : database[key as keyof typeof database],
    });
  return async () => {
    await GlobalRegistrator.unregister();
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption);
    else Reflect.deleteProperty(globalThis, 'Option');
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (errors.length) throw new AggregateError(errors, 'Unhandled errors in DOM fixture');
  };
}
