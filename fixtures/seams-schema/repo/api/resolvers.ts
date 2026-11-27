declare function load(id: string): unknown

export const resolvers = {
  Query: {
    order: (_: unknown, a: { id: string }) => load(a.id),
  },
}
