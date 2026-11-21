import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { initRoFormerControls, validRoFormerSong } from '../src/app/roformer-controls.js';

class FakeElement {
  constructor() {
    this.handlers = new Map();
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.disabled = true;
    this.hidden = false;
    this.files = [];
    this.src = '';
    this.clicks = 0;
  }
  addEventListener(name, callback) {
    const list = this.handlers.get(name) || [];
    list.push(callback); this.handlers.set(name, list);
  }
  removeEventListener(name, callback) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter(fn => fn !== callback));
  }
  fire(name, data = {}) { for (const callback of this.handlers.get(name) ?? []) callback(data); }
  click() { this.clicks++; this.fire('click'); }
}
class LocalFile extends Blob {
  constructor(parts, name, opts) { super(parts, opts); this.name = name; }
}
function hostFixture() {
  const names = [
    'stem-roformer-choose-song','stem-roformer-song-file','stem-roformer-download',
    'stem-roformer-separate','stem-roformer-song-name',
    'stem-roformer-control-status','stem-roformer-control-progress',
  ];
  const els = Object.fromEntries(names.map(id => [id, new FakeElement()]));
  const root = { querySelector: (sel) => els[sel.slice(1)] };
  const frame = new FakeElement();
  const sent = [];
  frame.contentWindow = { postMessage(message) { sent.push(message); } };
  const win = new FakeElement();
  win.crypto = { randomUUID: () => 'ead848d1-73d2-445b-bb94-deadbeefc123' };
  const controls = initRoFormerControls({
    root, frame, windowRef: win, FileType: LocalFile, timeoutMs: 1000,
  });
  function state(overrides = {}) {
    win.fire('message', {
      source: frame.contentWindow, origin: 'kindling-roformer://studio',
      data: { type: 'kindling.roformer.control.state.v1', state: {
        modelReady: false, modelLoading: false, downloadDone: 0,
        downloadTotal: 0, separating: false, progressDone: 0,
        progressTotal: 0, songLoaded: false, canSeparate: false,
        stopped: false, text: '', ...overrides,
      }},
    });
  }
  function ack(ok = true) {
    win.fire('message', {
      source: frame.contentWindow, origin: 'kindling-roformer://studio',
      data: { type: 'kindling.roformer.control.ack.v1',
        nonce: sent.at(-1).nonce, ok },
    });
  }
  function ready() {
    frame.src = 'kindling-roformer://studio/index.html';
    frame.fire('load');
    state();
  }
  return {els,win,frame,sent,controls,state,ack,ready};
}
test('Only valid local songs may be queued for RoFormer', () => {
  assert.equal(validRoFormerSong(new LocalFile(['audio'], 'demo.wav'), LocalFile), true);
  assert.equal(validRoFormerSong(new LocalFile(['audio'], 'demo.MP3'), LocalFile), true);
  assert.equal(validRoFormerSong(new LocalFile(['audio'], 'hack.exe'), LocalFile), false);
  assert.equal(validRoFormerSong(new LocalFile([], 'empty.wav'), LocalFile), false);
  assert.equal(validRoFormerSong(new LocalFile(['audio'], 'demo.wav'), Blob), true);
});
test('model requires an explicit click; model ready and song enable separation', () => {
  const f = hostFixture();
  assert.equal(f.els['stem-roformer-download'].disabled, true);
  f.ready();
  assert.equal(f.els['stem-roformer-download'].disabled, false);
  f.els['stem-roformer-download'].click();
  assert.equal(f.sent[0].type, 'kindling.roformer.control.command.v1');
  assert.equal(f.sent[0].action, 'download_model');
  assert.equal(f.els['stem-roformer-download'].disabled, true);
  f.ack();
  f.state({modelReady:true});
  assert.equal(f.els['stem-roformer-download'].disabled, true);
  assert.equal(f.els['stem-roformer-separate'].disabled, true);
  const chosen = new LocalFile(['audio'], 'riff.wav');
  const input = f.els['stem-roformer-song-file'];
  input.files = [chosen];
  input.fire('change');
  assert.equal(f.sent[1].action, 'open_song');
  assert.equal(f.sent[1].file, chosen);
  f.ack();
  f.state({modelReady:true,songLoaded:true,canSeparate:true});
  assert.equal(f.els['stem-roformer-separate'].disabled, false);
  f.els['stem-roformer-separate'].click();
  assert.equal(f.sent[2].action, 'separate');
  f.ack();
  f.state({modelReady:true,songLoaded:true,separating:true,progressDone:2,progressTotal:5});
  assert.equal(f.els['stem-roformer-control-progress'].value, '40');
  assert.equal(f.els['stem-roformer-separate'].disabled, true);
  f.controls.dispose();
});
test('forged state and ack from unrelated window/origin are ignored', () => {
  const f=hostFixture();
  f.ready();
  const current = {type:'kindling.roformer.control.state.v1',state:{
    modelReady:true,songLoaded:true,separating:false,canSeparate:true
  }};
  f.win.fire('message',{source:{},origin:'kindling-roformer://studio',data:current});
  f.win.fire('message',{source:f.frame.contentWindow,origin:'https://evil.invalid',data:current});
  assert.equal(f.els['stem-roformer-separate'].disabled,true);
  f.controls.dispose();
});
test('stemyla child bridge checks parent and queues bounded commands for Rust', () => {
  const source=readFileSync(new URL('../desktop/roformer-transfer-bridge.js',import.meta.url),'utf8');
  const listeners=new Map();
  const posted=[];
  const parent={postMessage:(data)=>posted.push(data)};
  const windowRef={parent,addEventListener:(n,fn)=>{
    const xs=listeners.get(n)??[];xs.push(fn);listeners.set(n,xs);
  }};
  runInNewContext(source, {
    window:windowRef, navigator:{}, Blob, File:LocalFile, Uint8Array,
    performance:{now:()=>1000}, console, String, Array, RegExp, Set,
  });
  const nonce='ead848d1-73d2-445b-bb94-deadbeefc123';
  for(const cb of listeners.get('message'))cb({
    source:{},origin:'kindling://app',
    data:{type:'kindling.roformer.control.command.v1',nonce,action:'separate'},
  });
  assert.equal(windowRef.__kindlingControl.take(), null);
  for(const cb of listeners.get('message'))cb({
    source:parent,origin:'kindling://app',
    data:{type:'kindling.roformer.control.command.v1',nonce,action:'separate'},
  });
  assert.equal(windowRef.__kindlingControl.take().action,'separate');
  for(const cb of listeners.get('message'))cb({
    source:parent,origin:'kindling://app',
    data:{type:'kindling.roformer.control.command.v1',nonce,
      action:'open_song',file:new LocalFile(['data'],'song.wav')},
  });
  assert.equal(windowRef.__kindlingControl.take().action,'open_song');
  windowRef.__kindlingControl.report(true,false,0,0,false,0,0,true,true,false,'Ready');
  assert.equal(posted.at(-1).type,'kindling.roformer.control.state.v1');
  windowRef.__kindlingControl.ack(nonce,true,'ok');
  assert.equal(posted.at(-1).type,'kindling.roformer.control.ack.v1');
});
test('source update contains native Rust poll and invocation of Stemyla methods', () => {
  const patch=readFileSync(new URL('../tools/patch-stemyla-controls.py',import.meta.url),'utf8');
  assert.match(patch,/self\.open_files\(vec!\[\(name, file\)\], ctx\)/);
  assert.match(patch,/sep\.download_model\(\)/);
  assert.match(patch,/self\.start_separation\(ctx\)/);
  assert.match(patch,/self\.kindling_poll\(&ctx\)/);
  const stemPanel=readFileSync(new URL('../src/app/stem-panel.js',import.meta.url),'utf8');
  assert.match(stemPanel,/initRoFormerControls/);
});
