import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initRoFormerControls } from '../src/app/roformer-controls.js';
import { initRoFormerTransfer, ROFORMER_TRANSFER_REQUEST } from '../src/app/roformer-transfer.js';

class FakeFile extends Blob {
  constructor(parts, name, opts) { super(parts, opts); this.name = name; }
}
class El {
  constructor() {
    this.handlers = new Map(); this.disabled = true; this.hidden = false;
    this.dataset = {}; this.value = ''; this.textContent = ''; this.src = '';
    this.classList = { toggle() {} };
  }
  addEventListener(n,cb) {
    this.handlers.set(n, [...(this.handlers.get(n) ?? []), cb]);
  }
  removeEventListener(n,cb) {
    this.handlers.set(n, (this.handlers.get(n) ?? []).filter(fn=>fn!==cb));
  }
  fire(n,data={}) { for(const fn of this.handlers.get(n)??[]) fn(data); }
  click() {this.fire('click');}
}
const NAMES=[
  'stem-roformer-choose-song','stem-roformer-song-file','stem-roformer-download',
  'stem-roformer-separate','stem-roformer-song-name','stem-roformer-control-status',
  'stem-roformer-control-progress', 'stem-mixer-import-direct',
  'stem-mixer-transfer-status',
];
function fixture() {
  const els=Object.fromEntries(NAMES.map(n=>[n,new El()]));
  const root={querySelector:(s)=>els[s.slice(1)]};
  const frame=new El();
  const commands=[];
  frame.contentWindow={postMessage(data){commands.push(data);}};
  const win=new El();
  let uuid=0;
  win.crypto={randomUUID:()=>String(++uuid).padStart(8,'0')+'-4444-4444-aaaa-123456789012'};
  const imported=[];
  const transfer=initRoFormerTransfer({
    root,frame,windowRef:win,FileType:FakeFile,BlobType:Blob,timeoutMs:800,
    onFiles:(files)=>{imported.push(files);return files.length;},
  });
  const controls=initRoFormerControls({
    root,frame,windowRef:win,FileType:FakeFile,timeoutMs:800,
    onCompleted:({session})=>transfer.importCompleted(session),
  });
  function event(data,source=frame.contentWindow,origin='kindling-roformer://studio') {
    win.fire('message',{data,source,origin});
  }
  function state() {
    event({type:'kindling.roformer.control.state.v1',state:{
      modelReady:true,modelLoading:false,downloadDone:0,downloadTotal:0,
      separating:false,progressDone:0,progressTotal:0,songLoaded:true,
      canSeparate:true,stopped:false,text:'Ready',
    }});
  }
  function load(){ frame.src='kindling-roformer://studio/index.html';frame.fire('load');state(); }
  function start(){
    els['stem-roformer-separate'].click();
    const command=commands.at(-1);
    assert.equal(command.action,'separate');
    event({type:'kindling.roformer.control.ack.v1',nonce:command.nonce,ok:true});
    return command;
  }
  function finished(nonce,session='1763730000000') {
    event({type:'kindling.roformer.stems.completed.v1',nonce,session});
  }
  function dispose(){controls.dispose();transfer.dispose();}
  return {els,frame,win,commands,imported,load,start,finished,event,dispose};
}
const makeWav=()=>new Blob([new Uint8Array(48)],{type:'audio/wav'});
const SIX=['drums','bass','vocals','guitar','piano','other'];
const tracks=()=>SIX.map(name=>({name,file:makeWav()}));

test('Auto import occurs once after an acknowledged native job completes, not on load',async()=>{
  const f=fixture();
  f.load();
  assert.equal(f.commands.length,0);
  f.finished('fake-nonce');
  assert.equal(f.commands.length,0);
  const accepted=f.start();
  f.finished('wrong-nonce');
  assert.equal(f.commands.length,1);
  f.finished(accepted.nonce,'1763730000000');
  assert.equal(f.commands.length,2);
  assert.equal(f.commands[1].type,ROFORMER_TRANSFER_REQUEST);
  assert.equal(f.commands[1].expectedSession,'1763730000000');
  f.finished(accepted.nonce,'1763730000000');
  assert.equal(f.commands.length,2,'duplicate completion ignored');
  f.event({type:'kindling.roformer.stems.result.v1',
    nonce:f.commands[1].nonce,session:'1763730000000',stems:tracks()});
  await Promise.resolve();
  assert.equal(f.imported.length,1);
  assert.deepEqual(f.imported[0].map(file=>file.name),SIX.map(n=>n+'.wav'));
  f.dispose();
});

test('Auto import never accepts another current song or an incomplete six-stem bank',async()=>{
  const f=fixture();f.load();
  const accepted=f.start();f.finished(accepted.nonce,'1763730000000');
  const req=f.commands.at(-1);
  f.event({type:'kindling.roformer.stems.result.v1',
    nonce:req.nonce,session:'1763730000001',stems:tracks()});
  await Promise.resolve();
  assert.equal(f.imported.length,0);
  assert.match(f.els['stem-mixer-transfer-status'].textContent,/changed songs/);
  f.dispose();

  const g=fixture();g.load();
  const command=g.start();g.finished(command.nonce,'1763730000000');
  const req2=g.commands.at(-1);
  g.event({type:'kindling.roformer.stems.result.v1',nonce:req2.nonce,
    session:'1763730000000',stems:tracks().slice(0,5)});
  assert.equal(g.imported.length,0);
  assert.match(g.els['stem-mixer-transfer-status'].textContent,/all six/);
  g.dispose();
});

test('A frame reload invalidates a pending Kindling run and manual import still works',()=>{
  const f=fixture();f.load();
  const command=f.start();
  f.frame.fire('load'); // Stemyla navigated/restarted
  f.finished(command.nonce,'1763730000000');
  assert.equal(f.commands.length,1);
  f.els['stem-mixer-import-direct'].click();
  assert.equal(f.commands.length,2);
  assert.equal(f.commands[1].expectedSession,undefined);
  f.dispose();
});

test('Only native Kindling runs are tagged by Rust, storage success is the completion gate',()=>{
  const patch=readFileSync(new URL('../tools/patch-stemyla-controls.py',import.meta.url),'utf8');
  assert.match(patch,/kindling_run: Option<\(String, String\)>/);
  assert.match(patch,/self\.kindling_run = None/);
  assert.match(patch,/kc_completed\(&nonce, &id\)/);
  assert.match(patch,/if kept/);
  assert.match(patch,/store::save_stems\(&id, SEPARATION_RATE, &to_save\)\.await/);
  assert.match(patch,/keep_stored_stems/);
});

test('Advanced Studio is collapsible while its loaded iframe remains in the DOM',()=>{
  const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/app/styles.css',import.meta.url),'utf8');
  const inline=readFileSync(new URL('../src/app/roformer-inline.js',import.meta.url),'utf8');
  assert.match(html,/id="stem-roformer-advanced-toggle"/);
  assert.match(html,/id="stem-roformer-frame-shell"/);
  assert.match(css,/\.stem-roformer-frame-shell:not\(\.expanded\)/);
  assert.match(inline,/toggleAdvanced/);
  assert.doesNotMatch(inline,/advancedShell\.remove\(/);
});
