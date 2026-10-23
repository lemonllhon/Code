import { loadSource } from "./main-runtime-test-fixture.mjs";

export const editorAuditState = `
export const state = {
  files: new Set(['C:/Windows/explorer.exe', '/System/Library/CoreServices/Finder.app']),
  directories: {}, contents: {}, commandErrors: {}, syncCalls: [], commands: [], directoryReads: [],
  icons: [], created: [], removed: [], pending: [], pendingIcons: [], logs: [],
  opened: [], revealed: [], statPaths: [], failLaunchCommands: [],
  holdCommands: false, holdIcons: false, failIcon: false, failMkdir: false, invalidIcns: false, failSips: false,
};
export const normalize = value => String(value).replaceAll('\\\\', '/');
export function missing(path) { return Object.assign(new Error('fixture missing'), {code:'ENOENT'}); }
export function releaseCommands() { state.holdCommands=false; for(const run of state.pending.splice(0)) run(); }
export function releaseIcons() { state.holdIcons=false; for(const run of state.pendingIcons.splice(0)) run(); }
`;

const asyncFs = `
import {state,normalize,missing} from 'editor-audit-state';
export async function access(path) { if(!state.files.has(normalize(path))) throw missing(path); }
export async function stat(path) { state.statPaths.push(normalize(path));await access(path); return {isFile:()=>!normalize(path).endsWith('.app')&&!normalize(path).endsWith('/folder'),isDirectory:()=>normalize(path).endsWith('.app')||normalize(path).endsWith('/folder')}; }
export async function readdir(path) {
  state.directoryReads.push(normalize(path));
  return (state.directories[normalize(path)]??[]).map(entry=>({name:entry.name,isDirectory:()=>entry.directory}));
}
export async function readFile(path) {
  const value=state.contents[normalize(path)]; if(value===undefined) throw missing(path);return Buffer.from(value);
}
export async function mkdir() { if(state.failMkdir) throw Error('fixture mkdir failed'); }
export async function mkdtemp(prefix) { const path=normalize(prefix)+state.created.length;state.created.push(path);return path; }
export async function rm(path) { state.removed.push(normalize(path)); }
`;

const syncFs = `
import {state,normalize,missing} from 'editor-audit-state';
export function existsSync(path) { state.syncCalls.push('existsSync');return state.files.has(normalize(path)); }
export function readdirSync() { state.syncCalls.push('readdirSync');return []; }
export function statSync(path) { state.syncCalls.push('statSync');if(!state.files.has(normalize(path)))throw missing(path);return {isFile:()=>true,isDirectory:()=>false}; }
export function readFileSync() { state.syncCalls.push('readFileSync');throw Error('unexpected synchronous read'); }
export function mkdirSync() { state.syncCalls.push('mkdirSync'); }
export function mkdtempSync(prefix) { state.syncCalls.push('mkdtempSync');return prefix+'sync'; }
export function rmSync() { state.syncCalls.push('rmSync'); }
`;

const processes = `
import {state,normalize} from 'editor-audit-state';
export function execFile(file,args,options,callback) {
  if(typeof options==='function'){callback=options;options={};}
  state.commands.push({file,args,options});
  const complete=()=>{
    if(file==='plutil') return callback(null,JSON.stringify({CFBundleIconFile:'app'}),'');
    if(file==='sips') {if(state.failSips)return callback(Error('fixture conversion failed'),'','');state.contents[normalize(args.at(-1))]='converted-png';return callback(null,'','');}
    if(file!=='where.exe')return state.failLaunchCommands.includes(file)?callback(Error('fixture launch failed'),'',''):callback(null,'','');
    if(state.commandErrors[args[0]])return callback(Object.assign(Error('fixture command failed'),state.commandErrors[args[0]]),'','');
    const output=state.contents['command:'+args[0]];
    return output===undefined ? callback(Object.assign(Error('fixture command missing'),{code:1}),'','') : callback(null,output,'');
  };
  if(state.holdCommands) state.pending.push(complete); else queueMicrotask(complete);
  return {};
}
execFile[Symbol.for('nodejs.util.promisify.custom')]=(...args)=>new Promise((resolve,reject)=>execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
export function execFileSync(){state.syncCalls.push('execFileSync');throw Error('unexpected synchronous process');}
`;

const electron = `
import {state} from 'editor-audit-state';
export {state};
const image=()=>({isEmpty:()=>false,toPNG:()=>Buffer.from('fixture-png'),resize(){return this;}});
export const nativeImage={createFromBuffer:image};
export const shell={openPath:async path=>{state.opened.push(path);return '';},showItemInFolder:path=>state.revealed.push(path)};
export const app={getFileIcon(path){
  state.icons.push(path);if(state.failIcon)throw Error('fixture native failure');
  if(state.holdIcons)return new Promise(resolve=>state.pendingIcons.push(()=>resolve(image())));
  return Promise.resolve(image());
}};
`;

export function editorDiscoveryStubs() {
  return {
    "editor-audit-state": editorAuditState,
    "node:fs": syncFs,
    "node:fs/promises": asyncFs,
    "node:child_process": processes,
    electron,
    "@lcode/services/desktop-main": "export const getLCodeDataRootDir=()=>'/fixture/data';",
    "./logger.js": `import {state} from 'editor-audit-state'; export const logger={info:(...args)=>state.logs.push(args),warn(){},error(){}};`,
    "@fiahfy/icns": `import {state} from 'editor-audit-state'; export const Icns={supportedIconTypes:[{osType:'png',format:'PNG',size:32}],from(){if(state.invalidIcns)throw Error('fixture invalid icns');return {images:[{osType:'png',image:Buffer.from('png')}]};}};`,
    "@lcode/server/remote/wsl-detect.js":
      "export const listWSLDistros=async()=>[{name:'Fixture',isDefault:true}];",
  };
}

export function editorDiscoveryDefines(platform = "win32") {
  return {
    "process.platform": JSON.stringify(platform),
    "process.env.WINDIR": '"C:/Windows"',
    "process.env.SystemDrive": '"C:"',
    "process.env.LOCALAPPDATA": '"C:/fixture/Local"',
    "process.env.ProgramFiles": '"C:/fixture/ProgramFiles"',
    'process.env["ProgramFiles(x86)"]': '"C:/fixture/ProgramFilesX86"',
  };
}

export function loadEditorDiscovery(t, platform = "win32") {
  return loadSource(t, "src/main/editors.ts", editorDiscoveryStubs(), {
    define: editorDiscoveryDefines(platform),
  });
}

export async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}
