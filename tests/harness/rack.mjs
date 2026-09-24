// Helpers for driving the fixture rack page from tests.
import { launchBrowser, openWithScript } from './userscript.mjs';
import { FixtureServer, RACK_URL } from './server.mjs';

export async function openRack(browser, options = {}) {
  const server = options.server || new FixtureServer();
  const tm = await openWithScript(browser, RACK_URL, server, options);
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'tracker panel' });
  await tm.waitFor(async () => Object.keys((await tm.eval('__eve.state()')).previousStates).length === 6,
    { message: 'baseline of 6 slots' });
  return { tm, server };
}

const EVE_COLUMN = { EVE01: 1, EVE02: 2 };

// Change a slot in the live DOM the way the real page does (bgcolor attribute).
export async function setSlot(tm, eve, unit, { color, serial } = {}) {
  await tm.page.evaluate(({ col, unit, color, serial }) => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.cells[0].textContent.trim() === unit);
    const cell = row.cells[col];
    if (serial) {
      const a = cell.querySelector('a');
      a.textContent = a.textContent.replace(/^\S+/, serial);
    }
    if (color) cell.setAttribute('bgcolor', color);
  }, { col: EVE_COLUMN[eve], unit, color, serial });
}

export async function cards(tm) {
  return tm.page.$$eval('.eve-alert', els => els.map(e => ({
    title: e.querySelector('.eve-alert-header span')?.textContent.trim() || '',
    serial: e.querySelector('.eve-alert-serial-value')?.textContent.trim() || '',
    location: e.querySelector('.eve-alert-loc')?.textContent.trim() || '',
    className: e.className
  })));
}

export { launchBrowser };
