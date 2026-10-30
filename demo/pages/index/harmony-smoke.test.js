/* HarmonyOS real-device smoke. Native event acceptance uses the separate device/collector record. */
describe('HarmonyOS showcase startup', () => {
  it('renders the complete home page after loading the SDK', async () => {
    const page = await program.reLaunch('/pages/index/index')
    await page.waitFor(1000)
    expect(await (await page.$('.title')).text()).toBe('GrowingIO uni-app SDK')
    expect(await page.data('items')).toHaveLength(6)
  })

  it('can navigate to the actual autotrack page and execute its business handler', async () => {
    await program.switchTab('/pages/autotrack/autotrack')
    const page = await program.currentPage()
    await page.waitFor(500)
    const before = await page.data('actionCount')
    await (await page.$('#plain-action')).tap()
    expect(await page.data('actionCount')).toBe(before + 1)
  })
})
