import { render } from '@testing-library/svelte'
import App from './App.svelte'

export function testAppRenders() {
  render(App)
}
