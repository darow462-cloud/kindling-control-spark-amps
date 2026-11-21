import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSourceClip } from '../src/app/stem-source-clip.js';
import { initStemExportClip } from '../src/app/stem-export-clip.js';

class Fake {
  constructor() {
    this.handlers=new Map();
    this.disabled=false;
    this.hidden=false;
    this.value='';
    this.max='';
    this.textContent='';
    this.dataset={};
    this.children=[];
    this.width=600;
    this.height=40;
  }
  addEventListener(type,callback) {
    this.handlers.set(type,[...(this.handlers.get(type)||[]),callback]);
  }
  fire(type,data={}) {
    for(const callback of this.handlers.get(type)||[])callback(data);
  }
  click(){this.fire('click');}
  append(...children){this.children.push(...children);}
  setAttribute(){}
  getBoundingClientRect(){return {left:0,width:this.width};}
  setPointerCapture(){}
  getContext(){return {fillStyle:'',strokeStyle:'',lineWidth:0,
    fillRect(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};}
}
class FakeAudio extends Fake {
  constructor() {
    super();
    this.paused = true;
    this.currentTime = 0;
  }
  pause(){this.paused=true;this.fire('pause');}
  load(){}
  removeAttribute(){}
  play(){this.paused=false;this.fire('play');return Promise.resolve();}
}
const data=()=>{
  const channels=2;
  const length=88200;
  const sample=Float32Array.from({length},(_,i)=>Math.sin(i*0.1)*0.5);
  return {
    sampleRate:44100,duration:2,length,numberOfChannels:channels,
    getChannelData:()=>sample,
  };
};
function fakeDoc() {
  return {createElement:(tag)=> tag==='audio'?new FakeAudio():new Fake()};
}
const wait=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function editorRoot(ids) {
  const elements=Object.fromEntries(ids.map(id=>[id,new Fake()]));
  const root=new Fake();
  root.querySelector=(s)=>elements[s.slice(1)];
  return {root,elements};
}
const ctxClass=class {
  constructor(){this.closed=false;}
  async decodeAudioData(){return data();}
  async close(){this.closed=true;}
};
test('source editor blocks unapplied range and stages/clears Demucs temporary clip',async()=>{
  const {root,elements}=editorRoot([
    'stem-source-name','stem-source-trim-status','stem-source-waveform',
    'stem-source-start','stem-source-end','stem-source-start-number',
    'stem-source-end-number','stem-source-duration','stem-source-apply',
    'stem-source-reset','stem-source-export','stem-source-preview','stem-source-preview-stop',
    'stem-source-seek','stem-source-playback-clock',
  ]);
  const events=[];
  const downloads=[];
  let seq=0;
  const sourceAudio = new FakeAudio();
  const doc = { createElement: (tag) => tag === 'audio' ? sourceAudio : new Fake() };
  const editor=initSourceClip({
    root, windowRef:{document:doc,AudioContext:ctxClass},
    urlApi:{createObjectURL:()=> 'blob:source/'+(++seq),revokeObjectURL(){}},
    download:(blob,name)=>downloads.push({blob,name}),
    onDemucsApply:async(blob)=>events.push({type:'apply',blob}),
    onDemucsRestore:async()=>events.push({type:'restore'}),
    onRoFormerApply:async()=>events.push({type:'roformer'}),
  });
  const source=new Blob([new Uint8Array([1,2,3])]);
  source.name='song.wav';
  assert.equal(await editor.loadSource({engine:'demucs',file:source}),true);
  assert.equal(root.hidden,false);
  assert.equal(editor.canSeparate('demucs'),true);
  assert.equal(elements['stem-source-seek'].disabled,false);
  assert.equal(elements['stem-source-playback-clock'].textContent,'0:00.00 / 0:02.00');
  elements['stem-source-seek'].value='500';
  elements['stem-source-seek'].fire('input');
  assert.equal(sourceAudio.currentTime,1);
  assert.equal(elements['stem-source-playback-clock'].textContent,'0:01.00 / 0:02.00');
  elements['stem-source-start-number'].value='0.20';
  elements['stem-source-start-number'].fire('change');
  elements['stem-source-end-number'].value='1.20';
  elements['stem-source-end-number'].fire('change');
  assert.equal(editor.canSeparate('demucs'),false);
  // Seeking past the selected end clamps to the trim, without editing it.
  elements['stem-source-seek'].value='900';
  elements['stem-source-seek'].fire('input');
  assert.equal(sourceAudio.currentTime,1.2);
  elements['stem-source-preview'].click();
  await wait();
  assert.equal(sourceAudio.paused,false);
  assert.equal(sourceAudio.currentTime,0.2,'play from start when cursor is at end');
  sourceAudio.currentTime=0.65;
  sourceAudio.fire('timeupdate');
  assert.equal(elements['stem-source-playback-clock'].textContent,'0:00.65 / 0:02.00');
  elements['stem-source-preview'].click();
  assert.equal(sourceAudio.paused,true,'button toggles pause');
  elements['stem-source-preview'].click();
  await wait();
  assert.equal(sourceAudio.currentTime,0.65,'play resumes where it was paused');
  sourceAudio.currentTime=1.2;
  sourceAudio.fire('timeupdate');
  assert.equal(sourceAudio.paused,true,'stop at selected end');
  assert.equal(elements['stem-source-seek'].value,'600');
  elements['stem-source-preview-stop'].click();
  assert.equal(sourceAudio.currentTime,0.2,'stop returns to selection start');
  elements['stem-source-export'].click();
  await wait();
  assert.equal(downloads.length,1);
  assert.equal(downloads[0].name,'demucs-source-clip.wav');
  assert.equal(downloads[0].blob.type,'audio/wav');
  assert.equal(editor.canSeparate('demucs'),false,'exporting does not silently apply the clip');
  elements['stem-source-apply'].click();
  await wait();
  assert.equal(events.length,1);
  assert.equal(events[0].type,'apply');
  assert.equal(events[0].blob.type,'audio/wav');
  assert.equal(editor.canSeparate('demucs'),true);
  elements['stem-source-end-number'].value='1.50';
  elements['stem-source-end-number'].fire('change');
  assert.equal(editor.canSeparate('demucs'),false,'changing the applied range invalidates it');
  editor.warnNeedsApply();
  assert.match(elements['stem-source-trim-status'].textContent,/Apply clip/);
  elements['stem-source-reset'].click();
  await wait();
  assert.deepEqual(events.map(e=>e.type),['apply','restore']);
  assert.equal(editor.canSeparate('demucs'),true);
  assert.deepEqual(editor.getRange(),{start:0,end:2,duration:2});
  editor.clearSource();
  assert.equal(editor.getSource(),null);
  assert.equal(editor.canSeparate('demucs'),true,'missing preview cannot block a new full song');
  editor.dispose();
});

test('six-stem editor previews the same selected interval and exports WAVs in a single ZIP',async()=>{
  const {root,elements}=editorRoot([
    'stem-mixer-clips-load','stem-mixer-clips-start','stem-mixer-clips-end',
    'stem-mixer-clips-start-number','stem-mixer-clips-end-number',
    'stem-mixer-clips-export','stem-mixer-clips-preview',
    'stem-mixer-clips-status','stem-mixer-clips-selected',
    'stem-mixer-clips-waveforms','stem-mixer-clips-seek',
    'stem-mixer-clips-playback-clock',
  ]);
  const previews=[],downloads=[],seeks=[];
  const listeners = new Set();
  const mixer = {
    time:0,playing:false,
    snapshot(){ return {time:this.time,duration:2,playing:this.playing,mode:'demucs'}; },
    emit(){ for(const callback of listeners)callback(this.snapshot()); },
    subscribeTransport(callback) {
      listeners.add(callback);
      callback(this.snapshot());
      return () => listeners.delete(callback);
    },
    getPosition(){return this.time;},
    isPlaying(){return this.playing;},
    seekTo(time){this.time=time;seeks.push(time);this.emit();return true;},
    previewRange(start,end,from=start){
      previews.push([start,end]);
      this.playing=true;this.time=from;this.emit();
      return true;
    },
    pause(){this.playing=false;this.emit();},
  };
  const sources=['drums','bass','vocals','guitar','piano','other'].map(name=>({
    name,url:'kindling-stem://550e8400-e29b-41d4-a716-446655440000/'+name+'.wav',
  }));
  const win={
    AudioContext:ctxClass,
    fetch:async()=>({
      ok:true,
      headers:{get:()=> '200'},
      arrayBuffer:async()=>new ArrayBuffer(200),
    }),
  };
  const exportEditor=initStemExportClip({
    root,mixer,windowRef:win,documentRef:fakeDoc(),
    download:(zip,name)=>{downloads.push({zip,name});},
  });
  exportEditor.sourcesChanged({mode:'demucs',sources});
  assert.equal(elements['stem-mixer-clips-load'].disabled,false);
  elements['stem-mixer-clips-load'].click();
  await wait();
  assert.match(elements['stem-mixer-clips-status'].textContent,/All six waveforms ready/);
  assert.equal(elements['stem-mixer-clips-export'].disabled,false);
  assert.equal(elements['stem-mixer-clips-seek'].disabled,false);
  assert.equal(elements['stem-mixer-clips-playback-clock'].textContent,'0:00.00 / 0:02.00');
  assert.equal(elements['stem-mixer-clips-waveforms'].children.length,6);
  elements['stem-mixer-clips-start-number'].value='0.25';
  elements['stem-mixer-clips-start-number'].fire('change');
  elements['stem-mixer-clips-end-number'].value='1.25';
  elements['stem-mixer-clips-end-number'].fire('change');
  elements['stem-mixer-clips-preview'].click();
  assert.deepEqual(previews,[[0.25,1.25]]);
  assert.equal(elements['stem-mixer-clips-preview'].textContent,'Pause selected mix');
  elements['stem-mixer-clips-seek'].value='500';
  elements['stem-mixer-clips-seek'].fire('input');
  assert.equal(seeks.at(-1),1);
  assert.equal(elements['stem-mixer-clips-playback-clock'].textContent,'0:01.00 / 0:02.00');
  assert.equal(mixer.playing,true,'scrubbing does not pause all stem players');
  elements['stem-mixer-clips-preview'].click();
  assert.equal(mixer.playing,false);
  elements['stem-mixer-clips-preview'].click();
  assert.equal(mixer.playing,true);
  assert.equal(mixer.time,1,'resume from scrubbed time');
  assert.equal(previews.length,2);
  elements['stem-mixer-clips-export'].click();
  await wait();
  assert.equal(downloads.length,1);
  assert.equal(downloads[0].name,'demucs-six-stems-clip.zip');
  const raw=await downloads[0].zip.arrayBuffer();
  const view=new DataView(raw);
  assert.equal(view.getUint32(raw.byteLength-22,true),0x06054b50);
  assert.equal(view.getUint16(raw.byteLength-12,true),6);
  assert.match(elements['stem-mixer-clips-status'].textContent,/exported as ZIP/);
  exportEditor.sourcesChanged({mode:'roformer',sources:[]});
  assert.equal(elements['stem-mixer-clips-export'].disabled,true);
  exportEditor.dispose();
});
