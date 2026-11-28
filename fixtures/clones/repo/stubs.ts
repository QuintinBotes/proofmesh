export interface Reader {
  read(value: number, path: string): string
}
export interface Writer {
  write(value: number, path: string): string
}

export declare function decode(value: number, path: string): string;
export declare function encode(value: number, path: string): string;
