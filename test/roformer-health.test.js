import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  initRoFormerHealth, isValidHealth, formatRoFormerHealth,
  ROFORMER_HEALTH_REQUEST, ROFORMER_HEALTH_RESULT,
} from '../src/app/roformer-health.js';

const valid = {
  bridge: true, nativeReports: true,
  webgpuApi: true, opfsApi: true, studioCanvas: true,
};
class Element {
  constructor() {
    this.disabled = false;
    this.textContent = '';
    this.dataset = {};
    this.src = '';
    this.handlers = new Map();
  }
  addEventListener(name, cb) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]);
  }
  removeEventListener(name, cb) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((fn) => fn !== cb));
  }
  fire(name, arg={}) {
    for (const fn of this.handlers.get(name) ?? []) fn(arg);
  }
  click() { this.fire('click'); }
}
function hostFixture() {
  const ids=['stem-roformer-check-health','stem-roformer-copy-health',
    'stem-roformer-health-report','stem-roformer-health-status'];
  const els=Object.fromEntries(ids.map((id)=>[id,new Element()]));
  const root={querySelector:(s)=>els[s.slice(1)]};
  const frame=new Element();
  const sent=[];
  frame.contentWindow={postMessage(msg){sent.push(msg);}};
  const win=new Element();
  win.crypto={randomUUID:()=> 'ead848d1-73d2-445b-bb94-deadbeefc123'};
  const copied=[];
  const controls={
    getState:()=>({modelReady:true,separating:false,modelLoading:false,
      text:'C:\\Users\\Sensitive\\song.wav'}),
    getLastStateAt:()=>Date.now()-500,
  };
  const mixer={getLoadedNames:()=>['drums','bass','vocals','guitar','piano','other']};
  const health=initRoFormerHealth({root,frame,windowRef:win,
    clipboardRef:{writeText:(text)=>{copied.push(text);return Promise.resolve();}},
    controls,mixer,timeoutMs:500});
  const received=(message,source=frame.contentWindow,origin='kindling-roformer://studio')=>{
    win.fire('message',{data:message,source,origin});
  };
  return {els,frame,sent,win,health,copied,received};
}
test('diagnostic format contains only permitted flags and no song paths or IDs',()=>{
  assert.equal(isValidHealth(valid),true);
  assert.equal(isValidHealth({...valid, opfsApi:'yes'}),false);
  assert.equal(isValidHealth(null),false);
  const report=formatRoFormerHealth({
    health:valid, state:{modelReady:true,separating:true,text:'C:\\secret\\metal.wav'},
    lastStateAt:1000,now:1500,loadedTracks:6,version:'0.7.7',
  });
  assert.match(report,/Studio JavaScript bridge: yes/);
  assert.match(report,/Native Rust reports: recent/);
  assert.match(report,/RoFormer mixer tracks: 6\/6/);
  assert.match(report,/Processing: processing/);
  assert.doesNotMatch(report,/secret|metal\.wav|session|username|GPU adapter/);
  const missing=formatRoFormerHealth({health:{...valid,opfsApi:false,webgpuApi:false}});
  assert.match(missing,/manual WAV import/);
  assert.match(missing,/GPU acceleration/);
});
test('host rejects unrelated window, origin, nonce and malformed payload', async()=>{
  const f=hostFixture();
  assert.equal(f.els['stem-roformer-copy-health'].disabled,true);
  f.els['stem-roformer-check-health'].click();
  assert.equal(f.sent.length,0,'must not send until the correct embedded frame loads');
  f.frame.src='kindling-roformer://studio/index.html';
  f.frame.fire('load');
  f.els['stem-roformer-check-health'].click();
  assert.equal(f.sent[0].type,ROFORMER_HEALTH_REQUEST);
  const nonce=f.sent[0].nonce;
  const result={type:ROFORMER_HEALTH_RESULT,nonce,health:valid};
  f.received(result,{},'kindling-roformer://studio');
  f.received(result,f.frame.contentWindow,'https://evil.invalid');
  f.received({...result,nonce:'wrong'});
  assert.equal(f.health.getReport(),'');
  f.received({...result,health:{...valid,webgpuApi:1}});
  assert.equal(f.health.getReport(),'');
  assert.equal(f.els['stem-roformer-copy-health'].disabled,true);
  f.els['stem-roformer-check-health'].click();
  const nextNonce=f.sent.at(-1).nonce;
  f.received({...result,nonce:nextNonce});
  assert.match(f.health.getReport(),/Native Rust reports: recent/);
  assert.equal(f.els['stem-roformer-copy-health'].disabled,false);
  f.els['stem-roformer-copy-health'].click();
  await Promise.resolve();
  assert.equal(f.copied.length,1);
  assert.equal(f.copied[0],f.health.getReport());
  assert.doesNotMatch(f.copied[0],/Sensitive|song\.wav/);
  f.health.dispose();
});
test('frame reload invalidates old health probe and strips obsolete report',()=>{
  const f=hostFixture();
  f.frame.src='kindling-roformer://studio/index.html';
  f.els['stem-roformer-check-health'].click();
  const req=f.sent[0];
  f.frame.fire('load');
  f.received({type:ROFORMER_HEALTH_RESULT,nonce:req.nonce,health:valid});
  assert.equal(f.health.getReport(),'');
  assert.equal(f.els['stem-roformer-copy-health'].disabled,true);
  f.health.dispose();
});
test('studio child health response discloses only booleans, not local OPFS contents',()=>{
  const source=readFileSync(
    new URL('../desktop/roformer-transfer-bridge.js',import.meta.url),'utf8');
  const messages=[];
  let listeners=new Map();
  const parent={postMessage:(data)=>messages.push(data)};
  const windowRef={parent,addEventListener:(n,fn)=>{
    listeners.set(n,[...(listeners.get(n)??[]),fn]);
  }};
  let opfsRead=0;
  const navigatorRef={
    gpu:{},
    storage:{getDirectory(){opfsRead++; throw Error('must not read storage');}},
  };
  const documentRef={getElementById:(id)=> id==='stem_explorer'?{}:null};
  runInNewContext(source,{
    window:windowRef,navigator:navigatorRef,document:documentRef,
    performance:{now:()=>200},File:class {},Blob,Array,Set,String,Uint8Array,
  });
  const nonce='ead848d1-73d2-445b-bb94-deadbeefc123';
  function send(source,origin,validNonce=nonce) {
    for (const cb of listeners.get('message')??[]) cb({
      source,origin,data:{type:ROFORMER_HEALTH_REQUEST,nonce:validNonce},
    });
  }
  send({},'kindling://app');
  send(parent,'https://evil.invalid');
  send(parent,'kindling://app','short');
  assert.equal(messages.length,0);
  send(parent,'kindling://app');
  assert.equal(messages.length,1);
  assert.equal(messages[0].type,ROFORMER_HEALTH_RESULT);
  assert.deepEqual(Object.keys(messages[0].health).sort(),
    ['bridge','nativeReports','webgpuApi','opfsApi','studioCanvas'].sort());
  assert.equal(messages[0].health.bridge,true);
  assert.equal(messages[0].health.nativeReports,false);
  assert.equal(messages[0].health.opfsApi,true);
  assert.equal(opfsRead,0);
  windowRef.__kindlingControl.report(true,false,0,0,false,0,0,true,false,false,'song-title.flac');
  send(parent,'kindling://app');
  assert.equal(messages.at(-1).health.nativeReports,true);
  assert.equal(opfsRead,0);
  assert.equal(JSON.stringify(messages.at(-1)).includes('song-title.flac'),false);
});
test('Stems exposes diagnostic UI and initializes health reader without extra privileges',()=>{
  const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
  const panel=readFileSync(new URL('../src/app/stem-panel.js',import.meta.url),'utf8');
  assert.match(html,/id="stem-roformer-check-health"/);
  assert.match(html,/id="stem-roformer-health-report"/);
  assert.match(html,/id="stem-roformer-copy-health"/);
  assert.match(panel,/initRoFormerHealth/);
});
