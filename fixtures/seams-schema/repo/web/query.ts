declare function gql(strings: TemplateStringsArray): string

export function loadOne() {
  return gql`query One { order(id: "1") { id } }`
}
