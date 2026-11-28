export interface Reader {
  read(value: number, path: string): string
}
export interface Writer {
  write(value: number, path: string): string
}
