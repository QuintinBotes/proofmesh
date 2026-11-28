import { double } from './helper'

export function add(a: number, b: number): number {
  return a + b
}

export function rarely(flag: boolean): number {
  if (flag) {
    return 1
  }
  return 0
}

export function viaRegistry(): number {
  return double(2)
}

export function untouched(): number {
  return 3
}

export const registry: Record<string, () => number> = { viaRegistry }
