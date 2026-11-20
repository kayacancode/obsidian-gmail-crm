import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GmailCrmSettingTab} from '../src/settings-tab';
import {DEFAULT_SETTINGS} from '../src/types';
function setup(refreshToken = '') {
 let saves = 0;
 const plugin = {settings: {...DEFAULT_SETTINGS, refreshToken}, saveSettings: async () => {saves++;}};
 const tab = new GmailCrmSettingTab({} as any, plugin as any);
 const rows = () => tab.getSettingDefinitions().flatMap((group: any) => group.items ?? [group]);
 return {plugin, tab, rows, saves: () => saves};
}
function render(row: any) {
 let change: ((value: boolean) => Promise<void>) | undefined;
 let click: (() => Promise<void>) | undefined;
 const component: any = new Proxy({}, {get: (_target, key) => (...args: any[]) => {
  if(key === 'onChange') change = args[0];
  if(key === 'onClick') click = args[0];
  return component;
 }});
 const setting: any = new Proxy({}, {get: (_target, key) => (...args: any[]) => {
  if(String(key).startsWith('add')) args[0](component);
  return setting;
 }});
 row.render(setting);
 return {change: (value: boolean) => change!(value), click: () => click!()};
}
test('settings expose searchable names without rendering or changing saved values', () => {
 const {rows, saves} = setup();
 const names = rows().map((row: any) => row.name);
 for(const name of ['Connection status', 'Use custom Google credentials', 'Sync interval', 'Blocked domains']) assert.ok(names.includes(name), name);
 assert.equal(saves(), 0);
 assert.ok(!names.includes('Client ID'));
});
test('custom credential toggle persists and refreshes searchable fields', async () => {
 const {tab, plugin, rows, saves} = setup();
 await render(rows().find((row: any) => row.name === 'Use custom Google credentials')).change(true);
 assert.equal(plugin.settings.useCustomOAuth, true);
 assert.equal(saves(), 1);
 assert.equal((tab as any).updates, 1);
 assert.ok(rows().some((row: any) => row.name === 'Client ID'));
});
test('disconnect clears authentication and refreshes settings definitions', async () => {
 const {tab, plugin, rows, saves} = setup('refresh');
 plugin.settings.accessToken = 'access'; plugin.settings.tokenExpiry = 123;
 await render(rows().find((row: any) => row.name === 'Disconnect')).click();
 assert.equal(plugin.settings.refreshToken, ''); assert.equal(plugin.settings.accessToken, ''); assert.equal(plugin.settings.tokenExpiry, 0);
 assert.equal(saves(), 1); assert.equal((tab as any).updates, 1);
 assert.ok(!rows().some((row: any) => row.name === 'Disconnect'));
});
