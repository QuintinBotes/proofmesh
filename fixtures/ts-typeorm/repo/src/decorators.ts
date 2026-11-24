/** A local decorator that shares TypeORM's name; it maps nothing to a table. */
export function Entity(_name?: string) {
  return (_target: unknown) => {}
}
