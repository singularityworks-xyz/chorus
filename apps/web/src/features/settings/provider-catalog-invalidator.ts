type Listener = () => void;

export function createProviderCatalogInvalidator() {
  const listeners = new Set<Listener>();

  return {
    invalidate() {
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const providerCatalogInvalidator = createProviderCatalogInvalidator();
