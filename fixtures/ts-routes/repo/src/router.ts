/** A local factory that shares Express's name; what it returns registers no route. */
export function Router() {
  return { get: (_path: string, _handler: () => string) => {} }
}
