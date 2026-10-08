import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareDocument} from '../src/reader/segmentation';
import {importText} from '../src/reader/text-import';
import {GenerationService} from '../src/generation/core/service';
import type {AlignmentAdapter} from '../src/generation/core/alignment-adapter';
import type {GenerationOptions} from '../src/generation/contracts';
import {digest} from '../src/generation/core/disk';

function wav() { const b=Buffer.alloc(32044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);return b; }
const routes:GenerationOptions[]=[{provider:'voicevox',voice:'3',transport:'direct',readings:[]},{provider:'gemini',voice:'Puck',transport:'direct',model:'gemini-3.8-flash-lite-tts',readings:[]},{provider:'gemini',voice:'Kore',transport:'gateway',model:'gemini-3.8-flash-lite-tts',readings:[]}];
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},mode:'available'|'unavailable'|'failure'|'unconfigured'|'cancel'='available') {
 const root=await mkdtemp(join(tmpdir(),'rsvp-auto-correction-'));t.after(()=>rm(root,{recursive:true,force:true}));let speechCalls=0,alignmentCalls=0;
 let signalStarted!:()=>void;const started=new Promise<void>(resolve=>{signalStarted=resolve;});
 const adapter:AlignmentAdapter={version:'reazon-rs35kh-46afc596-ctc-v2',async available(){return mode!=='unavailable';},async align(request,signal){alignmentCalls++;if(mode==='failure')throw Error('secret runtime detail');if(mode==='cancel'){signalStarted();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});}
  let offset=0;const characters=[...request.normalizedText];return {schemaVersion:1,alignerVersion:request.alignerVersion,normalizeVersion:request.normalizeVersion,offsetUnit:'utf16',normalizedText:request.normalizedText,durationSeconds:1,speechActivity:{version:'pcm-rms-v1',frameSeconds:.01,thresholdRms:.002,intervals:[{startSeconds:.1,endSeconds:.4},{startSeconds:.6,endSeconds:.95}]},segments:characters.map((ch,index)=>{const start=offset;offset+=ch.length;const confidence=index<2?.95:.65;return {start,end:offset,startSeconds:.1+index/characters.length*.8,endSeconds:.1+(index+1)/characters.length*.8,confidence,status:index<2?'aligned':'low-confidence'};})};}};
 const speech={async voices(){return [{id:'3',name:'mock'}];},async synthesize(_input:unknown,before:()=>Promise<void>){await before();speechCalls++;return wav();}};
 const config={libraryDir:join(root,'library'),localOrigin:'http://127.0.0.1:4173',paidEnabled:true,geminiApiKey:'test-placeholder',gateway:{mode:'rest' as const,accountId:'a'.repeat(32),gatewayId:'fixture',token:'test-placeholder'},...(mode!=='unconfigured'?{alignmentPython:'/fixture/python',alignmentModelDir:'/fixture/model'}:{})};
 const service=new GenerationService(config,{voicevox:speech,gemini:speech,alignment:adapter});const document=await prepareDocument(importText('<ruby>東京<rt>とうきょう</rt></ruby>の図書館で本を読みます。次の頁を静かに開きます。','md','自作の新規生成'));
 return {service,document,config,started,speechCalls:()=>speechCalls,alignmentCalls:()=>alignmentCalls};
}

for(const options of routes)test(`normal new ${options.provider}/${options.transport} generation automatically persists sound estimates and reuses both caches`,async t=>{
 const f=await fixture(t);const plan=await f.service.prepareGeneration({document:f.document,options});const job=await f.service.startGeneration({planId:plan.id,planHash:plan.hash,operationId:'normal-new',paidConfirmed:true});const completed=await f.service.waitForJob(job.id);assert.equal(completed.status,'completed');assert.equal(completed.automaticAlignment?.status,'completed');assert.equal(f.speechCalls(),2);assert.equal(f.alignmentCalls(),2);
 const book=await f.service.getBook(job.bookId,job.revision);assert.ok(book.presentation!.acousticEstimatedUnits!>0);assert.ok(book.chunks.every(chunk=>chunk.alignment?.acoustic));assert.deepEqual(book.document.units,f.document.units);
 const hashes=await Promise.all(book.chunks.map(c=>f.service.getAudio(c.speechKey).then(v=>digest(v.bytes))));const persisted=JSON.parse(await readFile(join(f.config.libraryDir,'books',job.bookId+'_'+job.revision+'.json'),'utf8'));assert.ok(persisted.presentation.acousticEstimatedUnits>0);
 const cached=await f.service.prepareGeneration({document:f.document,options});assert.equal(cached.sendingText,'');const second=await f.service.startGeneration({planId:cached.id,planHash:cached.hash,operationId:'normal-reuse',paidConfirmed:true});const reused=await f.service.waitForJob(second.id);assert.equal(reused.automaticAlignment?.status,'completed');assert.equal((await f.service.getAlignmentJob(reused.automaticAlignment!.jobId!)).reusedChunks,2);assert.equal(f.speechCalls(),2);assert.equal(f.alignmentCalls(),2);assert.deepEqual(await Promise.all(book.chunks.map(c=>f.service.getAudio(c.speechKey).then(v=>digest(v.bytes)))),hashes);
});

for(const mode of ['unconfigured','unavailable','failure'] as const)test(`automatic correction ${mode} preserves completed speech without synthesis retry`,async t=>{
 const f=await fixture(t,mode);const plan=await f.service.prepareGeneration({document:f.document,options:routes[1]});const job=await f.service.startGeneration({planId:plan.id,planHash:plan.hash,operationId:'fallback',paidConfirmed:true});const completed=await f.service.waitForJob(job.id);assert.equal(completed.status,'completed');assert.equal(completed.automaticAlignment?.status,mode==='failure'?'failed':'unavailable');assert.equal(f.speechCalls(),2);const book=await f.service.getBook(job.bookId,job.revision);assert.equal(book.presentation!.displayedUnits,book.presentation!.expectedUnits);assert.equal(book.presentation!.acousticEstimatedUnits,undefined);assert.equal(JSON.stringify(completed).includes('secret runtime detail'),false);
});

test('stopping automatic correction cancels its local job and keeps all completed speech',async t=>{
 const f=await fixture(t,'cancel');const plan=await f.service.prepareGeneration({document:f.document,options:routes[1]});const job=await f.service.startGeneration({planId:plan.id,planHash:plan.hash,operationId:'cancel-local-correction',paidConfirmed:true});await f.started;await f.service.cancelJob(job.id);const completed=await f.service.waitForJob(job.id);assert.equal(completed.status,'completed');assert.equal(completed.automaticAlignment?.status,'cancelled');assert.equal(f.speechCalls(),2);assert.equal((await f.service.getBook(job.bookId,job.revision)).completedChunks,2);
});
