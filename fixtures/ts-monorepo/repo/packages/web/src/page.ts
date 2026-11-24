import { cents } from '@core/money'

export function render(total: number): HTMLElement {
  const label = document.createElement('p')
  label.textContent = String(cents(total))
  return label
}
