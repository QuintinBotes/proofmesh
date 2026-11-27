import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openInLens, ROOT, startView, traceTo } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView(path.join(ROOT, 'fixtures', 'ts-react', 'repo')) })
test.afterAll(() => view?.stop())

test('FR078 FR060 a framework hop on a traced path opens its evidence', async ({ page }) => {
  await page.goto(view.launchUrl)
  await openInLens(page, 'App', 'src/App:App')
  await page.getByLabel('Follow framework relationships').check()
  await traceTo(page, ['Button', 'src/Button:Button'])
  await expect(page.getByTestId('conclusion')).toContainText('Path found')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('listitem').filter({ hasText: 'App → Button · framework' }).getByRole('button', { name: 'Show evidence' }).click()
  const evidence = page.getByRole('complementary', { name: 'Evidence' })
  await expect(evidence.getByRole('heading')).toHaveText('renders · resolved')
  await expect(evidence).toContainText('src/App.tsx:10')
  await expect(page.getByTestId('evidence-text')).toContainText('<Button label="hello"')
})
