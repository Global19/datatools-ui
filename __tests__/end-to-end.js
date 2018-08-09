// @flow

import os from 'os'
import path from 'path'

import fs from 'fs-extra'
import fetch from 'isomorphic-fetch'
import {safeLoad} from 'js-yaml'
import md5File from 'md5-file/promise'
import moment from 'moment'
import puppeteer from 'puppeteer'
import SimpleNodeLogger from 'simple-node-logger'

const config: {
  username: string,
  password: string
} = safeLoad(fs.readFileSync('configurations/end-to-end/env.yml'))

let browser
let page
const gtfsUploadFile = './configurations/end-to-end/test-gtfs-to-upload.zip'
const testTime = moment().format()
const testProjectName = `test-project-${testTime}`
const testFeedSourceName = `test-feed-source-${testTime}`
let testProjectId
let feedSourceId
let scratchFeedSourceId
let routerId
const log = SimpleNodeLogger.createSimpleFileLogger(`e2e-run-${testTime}.log`)
const testResults = {}
const defaultTestTimeout = 60000

function makeMakeTest (defaultDependentTests: Array<string> | string = []) {
  if (!(defaultDependentTests instanceof Array)) {
    defaultDependentTests = [defaultDependentTests]
  }
  return (
    name: string,
    fn: Function,
    timeout?: number,
    dependentTests: Array<string> | string = []
  ) => {
    it(name, async () => {
      log.info(`Begin test: "${name}"`)

      // first make sure all dependent tests have passed
      if (!(dependentTests instanceof Array)) {
        dependentTests = [dependentTests]
      }
      dependentTests = [...defaultDependentTests, ...dependentTests]

      dependentTests.forEach(test => {
        if (!testResults[test]) {
          log.error(`Dependent test "${test}" has not completed yet`)
          throw new Error(`Dependent test "${test}" has not completed yet`)
        }
      })

      // do actual test
      try {
        await fn()
      } catch (e) {
        log.error(`test "${name}" failed due to error: ${e}`)
        throw e
      }

      // note successful completion
      testResults[name] = true
      log.info(`successful test: "${name}"`)
    }, timeout)
  }
}

const makeTest = makeMakeTest()
const makeTestPostLogin = makeMakeTest('should login')
const makeTestPostFeedSource = makeMakeTest(['should login', 'should create feed source'])
const makeEditorEntityTest = makeMakeTest([
  'should login',
  'should create feed source',
  'should edit a feed from scratch'
])

// this can be turned off in development mode to skip some tests that do not
// need to be run in order for other tests to work properly
const doNonEssentialSteps = true

async function expectSelectorToContainHtml (selector: string, html: string) {
  const innerHTML = await page.$eval(selector, e => e.innerHTML)
  expect(innerHTML).toContain(html)
}

async function expectSelectorToNotContainHtml (selector: string, html: string) {
  const innerHTML = await page.$eval(selector, e => e.innerHTML)
  expect(innerHTML).not.toContain(html)
}

async function createProject (projectName: string) {
  log.info(`creating project with name: ${projectName}`)
  await click('#context-dropdown')
  await waitForSelector('a[href="/project"]')
  await click('a[href="/project"]')
  await waitForSelector('[data-test-id="create-new-project-button"]')
  log.info('waiting for projects to load')
  // wait for for projects to load
  await page.waitFor(5000)
  await click('[data-test-id="create-new-project-button"]')
  await waitForSelector('.project-name-editable input')
  await page.type('.project-name-editable input', projectName)
  await click('.project-name-editable button')
  log.info('saving new project')
  // wait for project to get saved
  await page.waitFor(5000)
  // verify that the project is listed
  await expectSelectorToContainHtml('[data-test-id="project-list-table"]', projectName)
  log.info(`confirmed successful creation of project with name: ${projectName}`)
}

async function deleteProject (projectId: string) {
  log.info(`deleting project with id: ${projectId}`)
  // navigate to that project's settings
  await page.goto(
    `http://localhost:9966/project/${projectId}/settings`,
    {
      waitUntil: 'networkidle0'
    }
  )

  // delete that project
  await click('[data-test-id="delete-project-button"]')
  await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
  await click('[data-test-id="modal-confirm-ok-button"]')
  log.info('deleted project')

  // verify deletion
  await page.goto(
    `http://localhost:9966/project/${projectId}`,
    {
      waitUntil: 'networkidle0'
    }
  )
  await expectSelectorToContainHtml('.modal-body', 'Project ID does not exist')
  await click('[data-test-id="status-modal-close-button"]')
  log.info(`confirmed successful deletion of project with id ${projectId}`)
}

async function uploadGtfs () {
  log.info('uploading gtfs')
  // create new feed version by clicking on dropdown and upload link
  await click('#bg-nested-dropdown')
  // TODO replace with more specific selector
  await waitForSelector('[data-test-id="upload-feed-button"]')
  await click('[data-test-id="upload-feed-button"]')

  // set file to upload in modal dialog
  // TODO replace with more specific selector
  await waitForSelector('.modal-body input')
  const uploadInput = await page.$('.modal-body input')
  await uploadInput.uploadFile(gtfsUploadFile)

  // confirm file upload
  // TODO replace with more specific selector
  const footerButtons = await page.$$('.modal-footer button')
  await footerButtons[0].click()

  await waitAndClearCompletedJobs()
  log.info('completed gtfs upload')
}

async function createFeedSourceViaProjectHeaderButton (feedSourceName) {
  log.info(`create Feed Source with name: ${feedSourceName} via project header button`)
  // go to project page
  await page.goto(
    `http://localhost:9966/project/${testProjectId}`,
    {
      waitUntil: 'networkidle0'
    }
  )
  await waitForSelector('[data-test-id="project-header-create-new-feed-source-button"]')
  await click('[data-test-id="project-header-create-new-feed-source-button"]')

  // TODO replace with less generic selector
  await waitForSelector('h4 input')
  await page.type('h4 input', feedSourceName + String.fromCharCode(13))

  // wait for feed source to be created and saved
  await page.waitFor(5000)
  log.info(`created Feed Source with name: ${feedSourceName} via project header button`)
}

async function createStop ({
  code,
  description,
  id,
  lat,
  locationType = '0',
  lon,
  name,
  timezone = { initalText: 'america/lo', option: 1 },
  url,
  wheelchairBoarding = '1',
  zoneId = '1'
}: {
  code: string,
  description: string,
  id: string,
  lat: string,
  locationType?: string,  // make optional due to https://github.com/facebook/flow/issues/183
  lon: string,
  name: string,
  timezone?: {  // make optional due to https://github.com/facebook/flow/issues/183
    initalText: string,
    option: number
  },
  url: string,
  wheelchairBoarding?: string,  // make optional due to https://github.com/facebook/flow/issues/183
  zoneId?: string  // make optional due to https://github.com/facebook/flow/issues/183
}) {
  log.info(`creating stop with name: ${name}`)
  // right click on map to create stop
  await page.mouse.click(700, 200, { button: 'right' })

  // wait for entity details sidebar to appear
  await waitForSelector('[data-test-id="stop-stop_id-input-container"]')

  // wait for initial data to load
  await page.waitFor(5000)

  // fill out form

  // set stop_id
  await clearAndType(
    '[data-test-id="stop-stop_id-input-container"] input',
    id
  )

  // code
  await page.type(
    '[data-test-id="stop-stop_code-input-container"] input',
    code
  )

  // set stop name
  await clearAndType(
    '[data-test-id="stop-stop_name-input-container"] input',
    name
  )

  // description
  await page.type(
    '[data-test-id="stop-stop_desc-input-container"] input',
    description
  )

  // lat
  await clearAndTypeNumber(
    '[data-test-id="stop-stop_lat-input-container"] input',
    lat
  )

  // lon
  await clearAndTypeNumber(
    '[data-test-id="stop-stop_lon-input-container"] input',
    lon
  )

  // zone
  const zoneIdSelector = '[data-test-id="stop-zone_id-input-container"]'
  await click(
    `${zoneIdSelector} .Select-control`
  )
  await page.type(`${zoneIdSelector} input`, zoneId)
  await page.keyboard.press('Enter')

  // stop url
  await page.type(
    '[data-test-id="stop-stop_url-input-container"]',
    url
  )

  // stop location type
  await page.select(
    '[data-test-id="stop-location_type-input-container"] select',
    locationType
  )

  // timezone
  await reactSelectOption(
    '[data-test-id="stop-stop_timezone-input-container"]',
    timezone.initalText,
    timezone.option
  )

  // wheelchair boarding
  await page.select(
    '[data-test-id="stop-wheelchair_boarding-input-container"] select',
    wheelchairBoarding
  )

  // save
  await click('[data-test-id="save-entity-button"]')

  // wait for save to happen
  await page.waitFor(5000)
  log.info(`created stop with name: ${name}`)
}

async function clearInput (inputSelector: string) {
  await page.$eval(inputSelector, input => { input.value = '' })
}

async function pickColor (containerSelector: string, color: string) {
  await click(`${containerSelector} button`)
  await waitForSelector(`${containerSelector} .sketch-picker`)
  await clearAndType(`${containerSelector} input`, color)
}

async function reactSelectOption (
  containerSelector: string,
  initalText: string,
  optionToSelect: number,
  virtualized: boolean = false
) {
  log.info(`selecting option from react-select container: ${containerSelector}`)
  await click(`${containerSelector} .Select-control`)
  await page.type(`${containerSelector} input`, initalText)
  const optionSelector =
    `.${virtualized ? 'VirtualizedSelectOption' : 'Select-option'}:nth-child(${optionToSelect})`
  await waitForSelector(optionSelector)
  await click(optionSelector)
  log.info('selected option')
}

async function waitAndClearCompletedJobs () {
  // wait for jobs to get completed
  log.info('waiting 15 seconds for jobs to complete')
  await page.waitFor(15000)
  await waitForSelector('[data-test-id="clear-completed-jobs-button"]')
  await click('[data-test-id="clear-completed-jobs-button"]')
  log.info('cleared completed jobs')
}

async function clearAndType (selector: string, text: string) {
  await clearInput(selector)
  await page.type(selector, text)
}

async function clearAndTypeNumber (selector: string, text: string) {
  await clearAndType(selector, text)

  if (parseFloat(text) < 0) {
    for (let i = 0; i < text.length; i++) {
      await page.keyboard.press('ArrowLeft')
    }
    await page.keyboard.type('-')
  }
}

async function appendText (selector: string, text: string) {
  await page.focus(selector)
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

async function waitForSelector (selector: string, options?: any) {
  log.info(`waiting for selector: ${selector}`)
  await page.waitForSelector(selector, options)
}

async function click (selector: string) {
  log.info(`clicking selector: ${selector}`)
  await page.click(selector)
}

describe('end-to-end', () => {
  beforeAll(async () => {
    browser = await puppeteer.launch({headless: true})
    page = await browser.newPage()
    page._client.send(
      'Page.setDownloadBehavior',
      { behavior: 'allow', downloadPath: './' }
    )
  })

  afterAll(async () => {
    // delete test project
    await deleteProject(testProjectId)

    // close browser
    browser.close()
  })

  makeTest('should load the page', async () => {
    await page.goto('http://localhost:9966')
    await expectSelectorToContainHtml('h1', 'Conveyal Datatools')
    testResults['should load the page'] = true
  })

  makeTest('should login', async () => {
    await page.goto('http://localhost:9966')
    await click('[data-test-id="header-log-in-button"]')
    await waitForSelector('button[class="auth0-lock-submit"]')
    await page.type('input[class="auth0-lock-input"][name="email"]', config.username)
    await page.type('input[class="auth0-lock-input"][name="password"]', config.password)
    await click('button[class="auth0-lock-submit"]')
    await waitForSelector('#context-dropdown')
    // wait for 10 seconds for projects to load
    await page.waitFor(10000)
  }, defaultTestTimeout, 'should load the page')

  describe('project', () => {
    makeTestPostLogin('should create a project', async () => {
      await createProject(testProjectName)

      // go into the project page and verify that it looks ok-ish
      const projectEls = await page.$$('.project-name-editable a')

      let projectFound = false
      for (const projectEl of projectEls) {
        const innerHtml = await page.evaluate(el => el.innerHTML, projectEl)
        if (innerHtml.indexOf(testProjectName) > -1) {
          const href = await page.evaluate(el => el.href, projectEl)
          testProjectId = href.match(/\/project\/([\w-]*)/)[1]
          await projectEl.click()
          projectFound = true
          break
        }
      }
      if (!projectFound) throw new Error('Created project not found')

      await waitForSelector('#project-viewer-tabs')
      await expectSelectorToContainHtml('#project-viewer-tabs', 'What is a feed source?')
    }, defaultTestTimeout)

    makeTestPostLogin('should update a project by adding a otp server', async () => {
      // open settings tab
      await click('#project-viewer-tabs-tab-settings')

      // navigate to deployments
      await waitForSelector('[data-test-id="deployment-settings-link"]', { visible: true })
      await click('[data-test-id="deployment-settings-link"]')
      await waitForSelector('[data-test-id="add-server-button"]')

      // add a server
      await click('[data-test-id="add-server-button"]')
      await waitForSelector('input[name="otpServers.$index.name"]')
      await page.type('input[name="otpServers.$index.name"]', 'test-otp-server')
      await page.type('input[name="otpServers.$index.publicUrl"]', 'http://localhost:8080')
      await page.type('input[name="otpServers.$index.internalUrl"]', 'http://localhost:8080/otp')
      await click('[data-test-id="save-settings-button"]')

      // reload page an verify test server persists
      await page.reload({ waitUntil: 'networkidle0' })
      await expectSelectorToContainHtml('#project-viewer-tabs', 'test-otp-server')
    }, defaultTestTimeout)

    if (doNonEssentialSteps) {
      makeTestPostLogin('should delete a project', async () => {
        const testProjectToDeleteName = `test-project-that-will-get-deleted-${testTime}`

        // navigate to home project view
        await page.goto(
          `http://localhost:9966/home/${testProjectId}`,
          {
            waitUntil: 'networkidle0'
          }
        )
        await waitForSelector('#context-dropdown')

        // create a new project
        await createProject(testProjectToDeleteName)

        // get the created project id
        // go into the project page and verify that it looks ok-ish
        const projectEls = await page.$$('.project-name-editable a')

        let projectFound = false
        let projectToDeleteId = ''
        for (const projectEl of projectEls) {
          const innerHtml = await page.evaluate(el => el.innerHTML, projectEl)
          if (innerHtml.indexOf(testProjectToDeleteName) > -1) {
            const href = await page.evaluate(el => el.href, projectEl)
            projectToDeleteId = href.match(/\/project\/([\w-]*)/)[1]
            projectFound = true
            break
          }
        }
        if (!projectFound) throw new Error('Created project not found')

        await deleteProject(projectToDeleteId)
      }, defaultTestTimeout)
    }
  })

  describe('feed source', () => {
    makeTestPostLogin('should create feed source', async () => {
      // go to project page
      await page.goto(
        `http://localhost:9966/project/${testProjectId}`,
        {
          waitUntil: 'networkidle0'
        }
      )
      await waitForSelector('[data-test-id="create-first-feed-source-button"]')
      await click('[data-test-id="create-first-feed-source-button"]')

      // TODO replace with less generic selector
      await waitForSelector('h4 input')
      await page.type('h4 input', testFeedSourceName)

      // TODO replace with less generic selector
      await click('h4 button')

      // wait for feed source to be created and saved
      await page.waitFor(5000)

      // verify that the feed source is listed
      await expectSelectorToContainHtml('#project-viewer-tabs', testFeedSourceName)

      // find feed source id
      // enter into feed source
      const feedSourceEls = await page.$$('h4 a')
      let feedSourceFound = false
      feedSourceId = ''
      for (const feedSourceEl of feedSourceEls) {
        const innerHtml = await page.evaluate(el => el.innerHTML, feedSourceEl)
        if (innerHtml.indexOf(testFeedSourceName) > -1) {
          const href = await page.evaluate(el => el.href, feedSourceEl)
          feedSourceId = href.match(/\/feed\/([\w-]*)/)[1]
          feedSourceFound = true
          await feedSourceEl.click()
          break
        }
      }
      if (!feedSourceFound) throw new Error('Created feedSource not found')

      await waitForSelector('#feed-source-viewer-tabs')
      // wait for 2 seconds for feed versions to load
      await page.waitFor(5000)
      expectSelectorToContainHtml(
        '#feed-source-viewer-tabs',
        'No versions exist for this feed source.'
      )
    }, defaultTestTimeout, 'should create a project')

    makeTestPostFeedSource('should process uploaded gtfs', async () => {
      await uploadGtfs()

      // verify feed was uploaded
      await expectSelectorToContainHtml(
        '#feed-source-viewer-tabs',
        'Valid from Jan. 01, 2014 to Dec. 31, 2018'
      )
    }, defaultTestTimeout)

    // this test also sets the feed source as deployable
    makeTestPostFeedSource('should process fetched gtfs', async () => {
      // navigate to feed source settings
      await click('#feed-source-viewer-tabs-tab-settings')

      // make feed source deployable
      await waitForSelector(
        '[data-test-id="make-feed-source-deployable-button"]',
        { visible: true }
      )
      await click('[data-test-id="make-feed-source-deployable-button"]')

      // set fetch url
      await page.type(
        '[data-test-id="feed-source-url-input-group"] input',
        'https://github.com/catalogueglobal/datatools-ui/raw/end-to-end/configurations/end-to-end/test-gtfs-to-fetch.zip'
      )
      await click('[data-test-id="feed-source-url-input-group"] button')

      // wait for feed source to update
      await page.waitFor(5000)

      // go back to feed source GTFS tab
      await click('#feed-source-viewer-tabs-tab-')
      await waitForSelector(
        '#bg-nested-dropdown',
        { visible: true }
      )

      // create new version by fetching
      await click('#bg-nested-dropdown')
      await waitForSelector(
        '[data-test-id="fetch-feed-button"]',
        { visible: true }
      )
      await click('[data-test-id="fetch-feed-button"]')

      // wait for gtfs to be fetched and processed
      await waitAndClearCompletedJobs()

      // verify that feed was fetched and processed
      await expectSelectorToContainHtml(
        '#feed-source-viewer-tabs',
        'Valid from Apr. 08, 2018 to Jun. 30, 2018'
      )
    }, defaultTestTimeout)

    if (doNonEssentialSteps) {
      makeTestPostLogin('should delete feed source', async () => {
        const testFeedSourceToDeleteName = `test-feed-source-to-delete-${testTime}`

        // create a new feed source to delete
        await createFeedSourceViaProjectHeaderButton(testFeedSourceToDeleteName)

        // find created feed source
        const listItemEls = await page.$$('.list-group-item')
        let feedSourceFound = false
        for (const listItemEl of listItemEls) {
          const feedSourceNameEl = await listItemEl.$('h4 a')
          const innerHtml = await page.evaluate(el => el.innerHTML, feedSourceNameEl)
          if (innerHtml.indexOf(testFeedSourceToDeleteName) > -1) {
            // hover over container to display FeedSourceDropdown
            // I tried to use the puppeteer hover method, but that didn't trigger
            // a mouseEnter event.  I needed to simulate the mouse being outside
            // the element and then moving inside
            const listItemBBox = await listItemEl.boundingBox()
            await page.mouse.move(
              listItemBBox.x - 10,
              listItemBBox.y
            )
            await page.mouse.move(
              listItemBBox.x + listItemBBox.width / 2,
              listItemBBox.y + listItemBBox.height / 2
            )
            await waitForSelector('#feed-source-action-button')

            // click dropdown and delete menu item button
            await click('#feed-source-action-button')
            await waitForSelector('[data-test-id="feed-source-dropdown-delete-project-button"]')
            await click('[data-test-id="feed-source-dropdown-delete-project-button"]')

            // confirm action in modal
            await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
            await click('[data-test-id="modal-confirm-ok-button"]')

            // wait for data to refresh
            await page.waitFor(5000)
            feedSourceFound = true
            break
          }
        }
        if (!feedSourceFound) throw new Error('Created feedSource not found')

        // verify deletion
        const feedSourceEls = await page.$$('h4 a')
        let deletedFeedSourceFound = false
        for (const feedSourceEl of feedSourceEls) {
          const innerHtml = await page.evaluate(el => el.innerHTML, feedSourceEl)
          if (innerHtml.indexOf(testFeedSourceToDeleteName) > -1) {
            deletedFeedSourceFound = true
            break
          }
        }
        if (deletedFeedSourceFound) throw new Error('Feed source did not get deleted!')
      }, defaultTestTimeout)
    }
  })

  describe('feed version', () => {
    makeTestPostFeedSource('should download a feed version', async () => {
      await page.goto(`http://localhost:9966/feed/${feedSourceId}`)

      // for whatever reason, waitUntil: networkidle0 was not working with the
      // above goto, so wait for a few seconds here
      await page.waitFor(5000)

      await waitForSelector('[data-test-id="decrement-feed-version-button"]')
      await click('[data-test-id="decrement-feed-version-button"]')

      // wait for previous version to be active
      await page.waitFor(5000)
      await click('[data-test-id="download-feed-version-button"]')

      // wait for file to download
      await page.waitFor(5000)

      // file should get saved to the current root directory, go looking for it
      // verify that file exists
      const downloadsDir = './'
      const files = await fs.readdir(downloadsDir)
      let feedVersionDownloadFile = ''
      // assume that this file will be the only one matching the feed source ID
      for (const file of files) {
        if (file.indexOf(feedSourceId.replace(/:/g, '')) > -1) {
          feedVersionDownloadFile = file
          break
        }
      }
      if (!feedVersionDownloadFile) {
        throw new Error('Feed Version gtfs file not found in Downloads folder!')
      }

      // verify that file has same hash as gtfs file that was uploaded
      const filePath = path.join(downloadsDir, feedVersionDownloadFile)
      expect(await md5File(filePath)).toEqual(await md5File(gtfsUploadFile))

      // delete file
      await fs.remove(filePath)
    }, defaultTestTimeout)

    if (doNonEssentialSteps) {
      // this uploads a feed source again because we want to end up with 2
      // feed versions after this test takes place
      makeTestPostLogin('should delete a feed version', async () => {
        // browse to feed source page
        await page.goto(`http://localhost:9966/feed/${feedSourceId}`)

        // for whatever reason, waitUntil: networkidle0 was not working with the
        // above goto, so wait for a few seconds here
        await page.waitFor(5000)

        // upload gtfs
        await uploadGtfs()

        // click delete button
        await click('[data-test-id="delete-feed-version-button"]')

        // confirm action in modal
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for data to refresh
        await page.waitFor(5000)

        // verify that the previous feed is now the displayed feed
        await expectSelectorToContainHtml(
          '#feed-source-viewer-tabs',
          'Valid from Apr. 08, 2018 to Jun. 30, 2018'
        )
      }, defaultTestTimeout)
    }
  })

  describe('editor', () => {
    makeTestPostFeedSource('should load a feed version into the editor', async () => {
      // click edit feed button
      await click('[data-test-id="edit-feed-version-button"]')

      // wait for editor to get ready and show starting dialog
      await waitForSelector('[data-test-id="import-latest-version-button"]')
      await click('[data-test-id="import-latest-version-button"]')

      // wait for snapshot to get created
      await waitForSelector('[data-test-id="begin-editing-button"]')

      // close jobs dialog
      await click('[data-test-id="clear-completed-jobs-button"]')

      // begin editing
      await click('[data-test-id="begin-editing-button"]')

      // wait for dialog to close
      await page.waitFor(5000)
    }, defaultTestTimeout)

    // prepare a new feed source to use the editor from scratch
    makeTestPostFeedSource('should edit a feed from scratch', async () => {
      // browse to feed source page
      const feedSourceName = `feed-source-to-edit-from-scratch-${testTime}`
      await createFeedSourceViaProjectHeaderButton(feedSourceName)

      // find created feed source
      const listItemEls = await page.$$('.list-group-item')
      let feedSourceFound = false
      for (const listItemEl of listItemEls) {
        const feedSourceNameEl = await listItemEl.$('h4 a')
        const innerHtml = await page.evaluate(el => el.innerHTML, feedSourceNameEl)
        if (innerHtml.indexOf(feedSourceName) > -1) {
          feedSourceFound = true
          const href = await page.evaluate(el => el.href, feedSourceNameEl)
          scratchFeedSourceId = href.match(/\/feed\/([\w-]*)/)[1]
          await feedSourceNameEl.click()
          // apparently the first click does not work entirely, it may trigger
          // a load of the FeedSourceDropdown, but the event for clicking the link
          // needs a second try I guess
          await feedSourceNameEl.click()
          break
        }
      }
      if (!feedSourceFound) throw new Error('Created feedSource not found')

      // wait for navigation to feed source
      await waitForSelector('#feed-source-viewer-tabs')

      // wait for feed versions to load
      await page.waitFor(5000)

      // click edit feed button
      await click('[data-test-id="edit-feed-version-button"]')

      // wait for editor to get ready and show starting dialog
      await waitForSelector('[data-test-id="edit-from-scratch-button"]')
      await click('[data-test-id="edit-from-scratch-button"]')

      // wait for snapshot to get created
      await waitForSelector('[data-test-id="begin-editing-button"]')

      // close jobs dialog
      await click('[data-test-id="clear-completed-jobs-button"]')

      // wait for jobs dialog to close
      await page.waitFor(5000)

      // begin editing
      await click('[data-test-id="begin-editing-button"]')

      // wait for welcome dialog to close
      await page.waitFor(5000)
    }, defaultTestTimeout)

    // all of the following editor tests assume the use of the scratch feed
    describe('feed info', () => {
      makeEditorEntityTest('should create feed info data', async () => {
        // open feed info sidebar
        await click('[data-test-id="editor-feedinfo-nav-button"]')

        // wait for feed info sidebar form to appear
        await waitForSelector('#feed_publisher_name')

        // fill out form
        await page.type('#feed_publisher_name', 'end-to-end automated test')
        await page.type('#feed_publisher_url', 'example.test')
        await reactSelectOption(
          '[data-test-id="feedinfo-feed_lang-input-container"]',
          'eng',
          2
        )
        await clearAndType(
          '[data-test-id="feedinfo-feed_start_date-input-container"] input',
          '05/29/18'
        )
        await clearAndType(
          '[data-test-id="feedinfo-feed_end_date-input-container"] input',
          '05/29/38'
        )
        await pickColor(
          '[data-test-id="feedinfo-default_route_color-input-container"]',
          '3D65E2'
        )
        await page.select(
          '[data-test-id="feedinfo-default_route_type-input-container"] select',
          '6'
        )
        await page.type(
          '[data-test-id="feedinfo-feed_version-input-container"] input',
          testTime
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector('#feed_publisher_name')

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="feedinfo-feed_publisher_name-input-container"]',
          'end-to-end automated test'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update feed info data', async () => {
        // update publisher name by appending to end
        await appendText('#feed_publisher_name', ' runner')

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector('#feed_publisher_name')

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="feedinfo-feed_publisher_name-input-container"]',
          'end-to-end automated test runner'
        )
      }, defaultTestTimeout, 'should create feed info data')
    })

    // all of the following editor tests assume the use of the scratch feed
    describe('agencies', () => {
      makeEditorEntityTest('should create agency', async () => {
        // open agency sidebar
        await click('[data-test-id="editor-agency-nav-button"]')

        // wait for agency sidebar form to appear
        await waitForSelector('[data-test-id="create-first-agency-button"]')

        // click button to open form to create agency
        await click('[data-test-id="create-first-agency-button"]')

        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="agency-agency_id-input-container"]')

        // fill out form
        await page.type(
          '[data-test-id="agency-agency_id-input-container"] input',
          'test-agency-id'
        )
        await page.type(
          '[data-test-id="agency-agency_name-input-container"] input',
          'test agency name'
        )
        await page.type(
          '[data-test-id="agency-agency_url-input-container"] input',
          'example.test'
        )
        await reactSelectOption(
          '[data-test-id="agency-agency_timezone-input-container"]',
          'america/lo',
          1
        )
        // the below doesn't save the language unless chrome debugger is on.
        // Don't know why, spent way too much time trying to figure out.
        await reactSelectOption(
          '[data-test-id="agency-agency_lang-input-container"]',
          'eng',
          2
        )
        await page.type(
          '[data-test-id="agency-agency_phone-input-container"] input',
          '555-555-5555'
        )
        await page.type(
          '[data-test-id="agency-agency_fare_url-input-container"] input',
          'example.fare.test'
        )
        await page.type(
          '[data-test-id="agency-agency_email-input-container"] input',
          'test@example.com'
        )
        await page.type(
          '[data-test-id="agency-agency_branding_url-input-container"] input',
          'example.branding.url'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for agency sidebar form to appear
        await waitForSelector(
          '[data-test-id="agency-agency_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="agency-agency_id-input-container"]',
          'test-agency-id'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update agency data', async () => {
        // update agency name by appending to end
        await appendText(
          '[data-test-id="agency-agency_name-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for agency sidebar form to appear
        await waitForSelector(
          '[data-test-id="agency-agency_name-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="agency-agency_name-input-container"]',
          'test agency name updated'
        )
      }, defaultTestTimeout, 'should create agency')

      makeEditorEntityTest('should delete agency data', async () => {
        // create a new agency that will get deleted
        await click('[data-test-id="clone-agency-button"]')

        // update agency id by appending to end
        await appendText(
          '[data-test-id="agency-agency_id-input-container"] input',
          '-copied'
        )

        // update agency name
        await appendText(
          '[data-test-id="agency-agency_name-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for agency sidebar form to appear
        await waitForSelector(
          '[data-test-id="agency-agency_name-input-container"] input'
        )

        // verify that agency to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test agency name updated to delete'
        )

        // delete the agency
        await click('[data-test-id="delete-agency-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that agency to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test agency name updated to delete'
        )
      }, defaultTestTimeout)
    })

    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the agencies test suite
    describe('routes', () => {
      makeEditorEntityTest('should create route', async () => {
        // open routes sidebar
        await click('[data-test-id="editor-route-nav-button"]')

        // wait for route sidebar form to appear
        await waitForSelector('[data-test-id="create-first-route-button"]')

        // click button to open form to create route
        await click('[data-test-id="create-first-route-button"]')

        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="route-route_id-input-container"]')

        // fill out form
        // set status to approved
        await page.select(
          '[data-test-id="route-status-input-container"] select',
          '2'
        )

        // set public to yes
        await page.select(
          '[data-test-id="route-publicly_visible-input-container"] select',
          '1'
        )

        // set route_id
        await clearAndType(
          '[data-test-id="route-route_id-input-container"] input',
          'test-route-id'
        )

        // set route short name
        await clearAndType(
          '[data-test-id="route-route_short_name-input-container"] input',
          'test1'
        )

        // long name
        await page.type(
          '[data-test-id="route-route_long_name-input-container"] input',
          'test route 1'
        )

        // description
        await page.type(
          '[data-test-id="route-route_desc-input-container"] input',
          'test route 1 description'
        )

        // route type
        await page.select(
          '[data-test-id="route-route_type-input-container"] select',
          '3'
        )

        // route color
        await pickColor(
          '[data-test-id="route-route_color-input-container"]',
          '1cff32'
        )

        // route text color
        await page.select(
          '[data-test-id="route-route_text_color-input-container"] select',
          '000000'
        )

        // wheelchair accessible
        await page.select(
          '[data-test-id="route-wheelchair_accessible-input-container"] select',
          '1'
        )

        // branding url
        await page.type(
          '[data-test-id="route-route_branding_url-input-container"] input',
          'example.branding.test'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for routes sidebar form to appear
        await waitForSelector(
          '[data-test-id="route-route_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="route-route_id-input-container"]',
          'test-route-id'
        )
      }, defaultTestTimeout, 'should create agency')

      makeEditorEntityTest('should update route data', async () => {
        // update route name by appending to end
        await appendText(
          '[data-test-id="route-route_long_name-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for routes sidebar form to appear
        await waitForSelector(
          '[data-test-id="route-route_long_name-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="route-route_long_name-input-container"]',
          'test route 1 updated'
        )
      }, defaultTestTimeout, ['should create agency', 'should create route'])

      makeEditorEntityTest('should delete route data', async () => {
        // create a new route that will get deleted
        await click('[data-test-id="clone-route-button"]')

        // update route id by appending to end
        await appendText(
          '[data-test-id="route-route_id-input-container"] input',
          '-copied'
        )

        // update route name
        await appendText(
          '[data-test-id="route-route_long_name-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for routes sidebar form to appear
        await waitForSelector(
          '[data-test-id="route-route_long_name-input-container"] input'
        )

        // verify that route to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test route 1 updated to delete'
        )

        // delete the route
        await click('[data-test-id="delete-route-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that route to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test route 1 updated to delete'
        )
      }, defaultTestTimeout, 'should create agency')
    })

    // all of the following editor tests assume the use of the scratch feed
    describe('stops', () => {
      makeEditorEntityTest('should create stop', async () => {
        // open stop info sidebar
        await click('[data-test-id="editor-stop-nav-button"]')

        // wait for stop sidebar form to appear
        await waitForSelector('[data-test-id="create-stop-instructions"]')

        await createStop({
          code: '1',
          description: 'test 1',
          id: 'test-stop-1',
          lat: '37.04671717',
          lon: '-122.07529759',
          name: 'Laurel Dr and Valley Dr',
          url: 'example.stop/1'
        })

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector(
          '[data-test-id="stop-stop_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="stop-stop_id-input-container"]',
          'test-stop-1'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update stop data', async () => {
        // create a 2nd stop
        await createStop({
          code: '2',
          description: 'test 2',
          id: 'test-stop-2',
          lat: '37.04783038',
          lon: '-122.07521176',
          name: 'Russell Ave and Valley Dr',
          url: 'example.stop/2'
        })

        // update stop name by appending to end
        await appendText(
          '[data-test-id="stop-stop_desc-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector(
          '[data-test-id="stop-stop_desc-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="stop-stop_desc-input-container"]',
          'test 2 updated'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should delete stop data', async () => {
        // create a new stop that will get deleted
        await click('[data-test-id="clone-stop-button"]')

        // update stop id by appending to end
        await appendText(
          '[data-test-id="stop-stop_id-input-container"] input',
          '-copied'
        )

        // update stop code
        await clearAndType(
          '[data-test-id="stop-stop_code-input-container"] input',
          '3'
        )

        // update stop name
        await appendText(
          '[data-test-id="stop-stop_name-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector(
          '[data-test-id="stop-stop_name-input-container"] input'
        )

        // verify that stop to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'Russell Ave and Valley Dr to delete (3)'
        )

        // delete the stop
        await click('[data-test-id="delete-stop-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that stop to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'Russell Ave and Valley Dr to delete (3)'
        )
      }, defaultTestTimeout, 'should create stop')
    })

    // all of the following editor tests assume the use of the scratch feed
    describe('calendars', () => {
      makeEditorEntityTest('should create calendar', async () => {
        // open calendar sidebar
        await click('[data-test-id="editor-calendar-nav-button"]')

        // wait for calendar sidebar form to appear
        await waitForSelector('[data-test-id="create-first-calendar-button"]')

        // click button to open form to create calendar
        await click('[data-test-id="create-first-calendar-button"]')

        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="calendar-service_id-input-container"]')

        // fill out form

        // service_id
        await page.type(
          '[data-test-id="calendar-service_id-input-container"] input',
          'test-service-id'
        )

        // description
        await page.type(
          '[data-test-id="calendar-description-input-container"] input',
          'test calendar'
        )

        // monday
        await click(
          '[data-test-id="calendar-monday-input-container"] input'
        )

        // tuesday
        await click(
          '[data-test-id="calendar-tuesday-input-container"] input'
        )

        // start date
        await clearAndType(
          '[data-test-id="calendar-start_date-input-container"] input',
          '05/29/18'
        )

        // end date
        await clearAndType(
          '[data-test-id="calendar-end_date-input-container"] input',
          '05/29/28'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for calendar sidebar form to appear
        await waitForSelector(
          '[data-test-id="calendar-service_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="calendar-service_id-input-container"]',
          'test-service-id'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update calendar data', async () => {
        // update calendar name by appending to end
        await appendText(
          '[data-test-id="calendar-description-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for calendar sidebar form to appear
        await waitForSelector(
          '[data-test-id="calendar-description-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="calendar-description-input-container"]',
          'test calendar updated'
        )
      }, defaultTestTimeout, 'should create calendar')

      makeEditorEntityTest('should delete calendar data', async () => {
        // create a new calendar that will get deleted
        await click('[data-test-id="clone-calendar-button"]')

        // update service id by appending to end
        await appendText(
          '[data-test-id="calendar-service_id-input-container"] input',
          '-copied'
        )

        // update description
        await appendText(
          '[data-test-id="calendar-description-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for calendar sidebar form to appear
        await waitForSelector(
          '[data-test-id="calendar-description-input-container"] input'
        )

        // verify that calendar to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test-service-id-copied (test calendar updated to delete)'
        )

        // delete the calendar
        await click('[data-test-id="delete-calendar-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that calendar to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test-service-id-copied (test calendar updated to delete)'
        )
      }, defaultTestTimeout)
    })

    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the calendars test suite
    describe('exceptions', () => {
      makeEditorEntityTest('should create exception', async () => {
        // open exception sidebar
        await click('[data-test-id="exception-tab-button"]')

        // wait for exception sidebar form to appear
        await waitForSelector('[data-test-id="create-first-scheduleexception-button"]')

        // click button to open form to create exception
        await click('[data-test-id="create-first-scheduleexception-button"]')

        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="exception-name-input-container"]')

        // fill out form

        // name
        await page.type(
          '[data-test-id="exception-name-input-container"] input',
          'test exception'
        )

        // exception type
        await page.select(
          '[data-test-id="exception-type-input-container"] select',
          '7' // no service
        )

        // add exception date
        await click('[data-test-id="exception-add-date-button"]')
        await waitForSelector(
          '[data-test-id="exception-dates-container"] input'
        )
        await clearAndType(
          '[data-test-id="exception-dates-container"] input',
          '07/04/18'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for exception sidebar form to appear
        await waitForSelector(
          '[data-test-id="exception-name-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="exception-name-input-container"]',
          'test exception'
        )
      }, defaultTestTimeout, 'should create calendar')

      makeEditorEntityTest('should update exception data', async () => {
        // update exception name by appending to end
        await appendText(
          '[data-test-id="exception-name-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for exception sidebar form to appear
        await waitForSelector(
          '[data-test-id="exception-name-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="exception-name-input-container"]',
          'test exception updated'
        )
      }, defaultTestTimeout, 'should create exception')

      makeEditorEntityTest('should delete exception data', async () => {
        // create a new exception that will get deleted
        await click('[data-test-id="clone-scheduleexception-button"]')

        // update description
        await appendText(
          '[data-test-id="exception-name-input-container"] input',
          ' to delete'
        )

        // set new date
        await clearAndType(
          '[data-test-id="exception-dates-container"] input',
          '07/05/18'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for exception sidebar form to appear
        await waitForSelector(
          '[data-test-id="exception-name-input-container"] input'
        )

        // verify that exception to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test exception updated to delete'
        )

        // delete the exception
        await click('[data-test-id="delete-scheduleexception-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that exception to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test exception updated to delete'
        )
      }, defaultTestTimeout, 'should create calendar')
    })

    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the routes test suite
    describe('fares', () => {
      makeEditorEntityTest('should create fare', async () => {
        // open fare sidebar
        await click('[data-test-id="editor-fare-nav-button"]')

        // wait for fare sidebar form to appear
        await waitForSelector('[data-test-id="create-first-fare-button"]')

        // click button to open form to create fare
        await click('[data-test-id="create-first-fare-button"]')

        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="fare-fare_id-input-container"]')

        // fill out form

        // fare_id
        await page.type(
          '[data-test-id="fare-fare_id-input-container"] input',
          'test-fare-id'
        )

        // price
        await page.type(
          '[data-test-id="fare-price-input-container"] input',
          '1'
        )

        // currency
        await page.select(
          '[data-test-id="fare-currency_type-input-container"] select',
          'USD'
        )

        // payment method
        await page.select(
          '[data-test-id="fare-payment_method-input-container"] select',
          '0'
        )

        // transfers
        await page.select(
          '[data-test-id="fare-transfers-input-container"] select',
          '2'
        )

        // transfer duration
        await page.type(
          '[data-test-id="fare-transfer_duration-input-container"] input',
          '12345'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="fare-fare_id-input-container"]',
          'test-fare-id'
        )

        // add a fare rule
        await click('[data-test-id="fare-rules-tab-button"]')
        await waitForSelector('[data-test-id="add-fare-rule-button"]')
        await click('[data-test-id="add-fare-rule-button"]')

        // select route type
        await waitForSelector('input[name="fareRuleType-0-route_id"]')
        await click('input[name="fareRuleType-0-route_id"]')

        // select route
        await waitForSelector('[data-test-id="fare-rule-selections"] input')
        await reactSelectOption(
          '[data-test-id="fare-rule-selections"]',
          '1',
          1,
          true
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"]'
        )

        // go to rules tab
        await click('[data-test-id="fare-rules-tab-button"]')
        await waitForSelector('[data-test-id="add-fare-rule-button"]')

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="fare-rule-selections"]',
          'test route 1 updated'
        )
      }, defaultTestTimeout, 'should create route')

      makeEditorEntityTest('should update fare data', async () => {
        // browse back to fare attributes tab
        await click('[data-test-id="fare-attributes-tab-button"]')
        await waitForSelector('[data-test-id="fare-fare_id-input-container"]')

        // update fare id by appending to end
        await appendText(
          '[data-test-id="fare-fare_id-input-container"] input',
          '-updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="fare-fare_id-input-container"]',
          'test-fare-id-updated'
        )
      }, defaultTestTimeout, 'should create fare')

      makeEditorEntityTest('should delete fare data', async () => {
        // create a new fare that will get deleted
        await click('[data-test-id="clone-fare-button"]')

        // update service id by appending to end
        await appendText(
          '[data-test-id="fare-fare_id-input-container"] input',
          '-copied'
        )

        // save
        await click('[data-test-id="save-entity-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"] input'
        )

        // verify that fare to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test-fare-id-updated-copied'
        )

        // delete the fare
        await click('[data-test-id="delete-fare-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that fare to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test-fare-id-updated-copied'
        )
      }, defaultTestTimeout, 'should create fare')
    })

    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the routes test suite
    describe('patterns', () => {
      makeEditorEntityTest('should create pattern', async () => {
        // open route sidebar
        await click('[data-test-id="editor-route-nav-button"]')

        // wait for route sidebar form to appear
        await waitForSelector('.entity-list-row')

        // select first route
        await click('.entity-list-row')

        // wait for route details sidebar to appear
        await waitForSelector('[data-test-id="trippattern-tab-button"]')

        // go to trip pattern tab
        await click('[data-test-id="trippattern-tab-button"]')

        // wait for tab to load
        await waitForSelector('[data-test-id="new-pattern-button"]')

        // click button to create pattern
        await click('[data-test-id="new-pattern-button"]')

        // wait for new pattern to appear
        await waitForSelector('[data-test-id="pattern-title-New Pattern"]')

        // toggle the FeedInfoPanel in case it gets in the way of panel stuff
        await click('[data-test-id="FeedInfoPanel-visibility-toggle"]')

        // wait for page to catch up with itself
        await page.waitFor(5000)

        // click add stop by name
        await click('[data-test-id="add-stop-by-name-button"]')

        // wait for stop selector to show up
        await waitForSelector('.pattern-stop-card .Select-control')

        // add 1st stop
        await reactSelectOption('.pattern-stop-card', 'la', 1, true)

        // wait for 1st stop to save
        await page.waitFor(5000)

        // add 2nd stop
        await reactSelectOption('.pattern-stop-card', 'ru', 1, true)

        // wait for auto-save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for pattern sidebar form to appear
        await waitForSelector(
          '[data-test-id="pattern-title-New Pattern"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '.trip-pattern-list',
          'Russell Av'
        )
      }, defaultTestTimeout, 'should create route')

      makeEditorEntityTest('should update pattern data', async () => {
        // change pattern name by appending to end
        // begin editing
        await click('[data-test-id="editable-text-field-edit-button"]')

        // wait for text field to appear
        await waitForSelector('[data-test-id="editable-text-field-edit-container"]')
        await appendText(
          '[data-test-id="editable-text-field-edit-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="editable-text-field-edit-container"] button')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for pattern sidebar form to appear
        await waitForSelector(
          '[data-test-id="pattern-title-New Pattern updated"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="pattern-title-New Pattern updated"]',
          'New Pattern updated'
        )
      }, defaultTestTimeout, 'should create pattern')

      makeEditorEntityTest('should delete pattern data', async () => {
        // create a new pattern that will get deleted
        await click('[data-test-id="duplicate-pattern-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // verify that pattern to delete is listed
        await expectSelectorToContainHtml(
          '.trip-pattern-list',
          'New Pattern updated copy'
        )

        // delete the pattern
        await click('[data-test-id="delete-pattern-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')

        // wait for page to catch up?
        await page.waitFor(5000)
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that pattern to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.trip-pattern-list',
          'New Pattern updated copy'
        )
      }, defaultTestTimeout, 'should create pattern')
    })

    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the patterns and calendars test suites
    describe('timetables', () => {
      makeEditorEntityTest('should create trip', async () => {
        // expand pattern
        await click('[data-test-id="pattern-title-New Pattern updated"]')

        // wait for edit schedules button to appear
        await waitForSelector('[data-test-id="edit-schedules-button"]')

        // click edit schedules
        await click('[data-test-id="edit-schedules-button"]')

        // wait for calendar selector to appear
        await waitForSelector('[data-test-id="calendar-select-container"]')

        // select first calendar
        await reactSelectOption(
          '[data-test-id="calendar-select-container"]',
          'te',
          1
        )

        // wait for new trip button to appear
        await waitForSelector('[data-test-id="add-new-trip-button"]')

        // wait for page to catch up with iteself?
        await page.waitFor(5000)

        // click button to create trip
        await click('[data-test-id="add-new-trip-button"]')

        // wait for new trip to appear
        await waitForSelector('[data-test-id="timetable-area"]')

        // click first cell to begin editing
        await click('.editable-cell')

        // enter block id
        await page.keyboard.type('test-block-id')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // trip id
        await page.keyboard.type('test-trip-id')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // trip headsign
        await page.keyboard.type('test-headsign')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Laurel Dr arrival
        await page.keyboard.type('1234')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Laurel Dr departure
        await page.keyboard.type('1235')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Russell Av arrival
        await page.keyboard.type('1244')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Russell Av departure
        await page.keyboard.type('1245')
        await page.keyboard.press('Enter')

        // save
        await click('[data-test-id="save-trip-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for trip sidebar form to appear
        await waitForSelector(
          '[data-test-id="timetable-area"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-id'
        )
      }, defaultTestTimeout, ['should create calendar', 'should create pattern'])

      makeEditorEntityTest('should update trip data', async () => {
        // click first editable cell to begin editing
        await click('.editable-cell')

        // advance to right to trip id
        await page.keyboard.press('Tab')

        // change trip id by appending to end
        // begin editing
        await page.keyboard.press('Enter')
        await page.keyboard.press('End')
        await page.keyboard.type('-updated')
        await page.keyboard.press('Enter')

        // save
        await click('[data-test-id="save-trip-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for timetable  to appear
        await waitForSelector(
          '[data-test-id="timetable-area"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-id-updated'
        )
      }, defaultTestTimeout, 'should create trip')

      makeEditorEntityTest('should delete trip data', async () => {
        // create a new trip that will get deleted
        await click('[data-test-id="duplicate-trip-button"]')

        // wait for new trip to appear
        await page.waitFor(5000)

        // click first editable cell to begin editing
        await click('.editable-cell')

        // advance down and to right to trip id
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowRight')

        // change trip id by appending to end
        // begin editing
        await page.keyboard.press('Enter')
        await page.keyboard.type('test-trip-to-delete')
        await page.keyboard.press('Enter')

        // wait for save to happen
        await page.waitFor(5000)

        // save
        await click('[data-test-id="save-trip-button"]')

        // wait for save to happen
        await page.waitFor(5000)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for timetable  to appear
        await waitForSelector(
          '[data-test-id="timetable-area"]'
        )

        // verify that trip to delete is listed
        await expectSelectorToContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-to-delete'
        )

        // select the row
        await click('.timetable-left-grid .text-center:nth-child(2)')

        // delete the trip
        await click('[data-test-id="delete-trip-button"]')

        // confirm delete
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await click('[data-test-id="modal-confirm-ok-button"]')

        // wait for delete to happen
        await page.waitFor(5000)

        // verify that trip to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-to-delete'
        )
      }, defaultTestTimeout, 'should create trip')
    })

    // all of the following tests depend on the editor tests completing successfully
    describe('snapshot', () => {
      makeEditorEntityTest('should create snapshot', async () => {
        // open create snapshot dialog
        await click('[data-test-id="take-snapshot-button"]')

        // wait for dialog to appear
        await waitForSelector('[data-test-id="snapshot-dialog-name"]')

        // enter name
        await page.type('[data-test-id="snapshot-dialog-name"]', 'test-snapshot')

        // confrim snapshot creation
        await click('[data-test-id="confirm-snapshot-create-button"]')

        // wait for jobs to complete
        await waitAndClearCompletedJobs()
      }, defaultTestTimeout, 'should create trip')
    })
  })

  describe('feed source snapshot', () => {
    makeEditorEntityTest('should make snapshot active version', async () => {
      // go back to feed
      // not sure why, but clicking on the nav home button doesn't work
      await page.goto(
        `http://localhost:9966/feed/${scratchFeedSourceId}`,
        {
          waitUntil: 'networkidle0'
        }
      )

      // wait for page to be visible
      await waitForSelector('#feed-source-viewer-tabs-tab-snapshots')

      // go to snapshots tab
      await click('#feed-source-viewer-tabs-tab-snapshots')

      // wait for page to load?
      await page.waitFor(5000)

      // wait for snapshots tab to load
      await waitForSelector('[data-test-id="publish-snapshot-button"]')

      // publish snapshot
      await click('[data-test-id="publish-snapshot-button"]')

      // wait for version to get created
      await waitAndClearCompletedJobs()

      // go to main feed tab
      await click('#feed-source-viewer-tabs-tab-')

      // wait for main tab to show up
      await waitForSelector('#feed-source-viewer-tabs-pane-')

      // verify that feed was fetched and processed
      await expectSelectorToContainHtml(
        '#feed-source-viewer-tabs',
        'Valid from May. 29, 2018 to May. 29, 2028'
      )
    }, defaultTestTimeout, 'should create snapshot')

    // TODO: download and validate gtfs??
  })

  // the following tests depend on the snapshot test suite to have passed
  // successfully and also assumes a local instance of OTP is running
  describe('deployment', () => {
    makeTestPostFeedSource('should create deployment', async () => {
      // open create snapshot dialog
      await click('[data-test-id="deploy-feed-version-button"]')

      // wait for deployment to get created
      await page.waitFor(5000)

      // wait for deploy dropdown buttun to appear
      await waitForSelector('#deploy-server-dropdown')

      // open dropdown
      await click('#deploy-server-dropdown')

      // wait for dropdown to open
      await waitForSelector('[data-test-id="deploy-server-0-button"]')

      // click to deploy to server
      await click('[data-test-id="deploy-server-0-button"]')

      // wait for deployment dialog to appear
      await waitForSelector('[data-test-id="confirm-deploy-server-button"]')

      // get the router name
      const innerHTML = await page.$eval(
        '[data-test-id="deployment-router-id"]',
        e => e.innerHTML
      )
      // get rid of router id text and react tags
      routerId = innerHTML.replace('Router ID: ', '').replace(/<!--[\s\w-:/]*-->/g, '')

      // confirm deployment
      await click('[data-test-id="confirm-deploy-server-button"]')

      // wait for jobs to complete
      await waitAndClearCompletedJobs()
    }, defaultTestTimeout)

    makeEditorEntityTest('should be able to do a trip plan on otp', async () => {
      // hit the otp endpoint
      const response = await fetch(
        `http://localhost:8080/otp/routers/${routerId}/plan?fromPlace=37.04532992924222%2C-122.07542181015015&toPlace=37.04899494106061%2C-122.07432746887208&time=12%3A32am&date=07-24-2018&mode=TRANSIT%2CWALK&maxWalkDistance=804.672&arriveBy=false&wheelchair=false&locale=en`,
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8'
          }
        }
      )

      // expect response to be successful
      expect(response.status).toBe(200)

      // expect response to include text of a created stop
      const text = await response.text()
      expect(text).toContain('Laurel Dr and Valley Dr')
    }, defaultTestTimeout, 'should create snapshot')
  })
})
