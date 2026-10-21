import { readFile, writeFile, rename, mkdir, statfs, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadCore } from './core.mts';
import { batchVoicevox } from './voicevox-adapter.mts';

const runtime=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));
const root=resolve(runtime.root);
if(runtime.engineVersion==='0.25.2'&&runtime.engineEndpoint!=='http://127.0.0.1:50021')throw Error('Core phoneme timing requires port 50021');
const {prepareDocument,importText,requireAudioPresentation,GenerationService,LibraryDisk,AudioInspectionService,readReadyAudio,cleanupSavedWavs,encodeVerifiedMp3}=await loadCore(runtime.repo);
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function read(name:string):Promise<any>{try{return JSON.parse(await readFile(join(root,name),'utf8'))}catch(e:any){if(e.code==='ENOENT')return;throw e}}
async function save(name:string,value:any){const dest=join(root,name);await mkdir(dirname(dest),{recursive:true,mode:0o700});const tmp=dest+`.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,dest)}
const input=await read('input.json');
if(!input||input.target!==runtime.jobId||!input.parts.length)throw Error('Unexpected batch identity');
const inputHash=hash(await readFile(join(root,'input.json')));
if(inputHash!==runtime.inputHash)throw Error('Input changed after staging');
if(execFileSync('git',['-C',runtime.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==runtime.sourceCommit)throw Error('Remote core commit differs');
const config={libraryDir:join(root,'library'),localOrigin:'http://127.0.0.1:4173',paidEnabled:false};
let phase='starting',currentOrder:number|undefined,currentJobId:string|undefined,currentAlignmentId:string|undefined;
let plans:any[]=(await read('plans.json'))??[],parts:any[]=(await read('progress.json'))?.parts??[];
let lastCount=-1,lastPhase='',lastProgressAt=new Date().toISOString(),lastError:string|undefined;
let statusTail=Promise.resolve();
let service:any;
function event(event:string,extra:any={}){console.log(JSON.stringify({at:new Date().toISOString(),event,...extra}))}
function status(){
 statusTail=statusTail.then(async()=>{
  const job=currentJobId&&service?await service.getJob(currentJobId):undefined;
  const alignment=currentAlignmentId&&service?await service.getAlignmentJob(currentAlignmentId):undefined;
  const completed=parts.reduce((n,p)=>n+(p.generatedChunks??0),0)+(currentOrder&&!parts.some(p=>p.order===currentOrder)?job?.completedChunks??0:0);
  if(completed!==lastCount||phase!==lastPhase){lastCount=completed;lastPhase=phase;lastProgressAt=new Date().toISOString()}
  const fs=await statfs(root);
  await save('progress.json',{schemaVersion:1,inputHash,pid:process.pid,phase,updatedAt:new Date().toISOString(),lastProgressAt,
   completedChunks:completed,totalChunks:plans.reduce((n,p)=>n+p.chunks,0),completedParts:parts.filter(p=>p.phase==='verified').length,totalParts:input.parts.length,
   currentOrder,currentJobId,currentJobStatus:job?.status,currentAlignmentId,alignmentCompleted:alignment?.completedChunks,
   alignmentTotal:alignment?.totalChunks,freeBytes:fs.bavail*fs.bsize,error:lastError,parts});
 }).catch(e=>{event('status-error',{message:String(e)});throw e});
 return statusTail;
}
async function waitEngine(){
 for(let attempt=0;attempt<30;attempt++){
  try{const v=await(await fetch(runtime.engineEndpoint+'/version',{signal:AbortSignal.timeout(3000)})).json();if(v!==runtime.engineVersion)throw Error('Unexpected Engine version');return}catch(e){if(attempt===29)throw e;await new Promise(r=>setTimeout(r,2000))}
 }
}
async function planAll(){
 const existing=await read('plan-input.json');
 if(existing&&existing.inputHash!==inputHash)throw Error('Input changed after planning');
 for(const part of input.parts){if(hash(await readFile(join(root,'inputs',part.file)))!==part.sha256)throw Error('Staged manuscript changed')}
 if(plans.length){if(!existing||plans.length!==input.parts.length)throw Error('Incomplete saved plan list');return}
 phase='planning';await status();
 for(const part of input.parts){
  const raw=await readFile(join(root,'inputs',part.file));if(hash(raw)!==part.sha256)throw Error(`Input checksum mismatch: ${part.order}`);
  const document=await prepareDocument(importText(raw.toString('utf8'),'md',part.title));
  const p=await service.prepareGeneration({document,options:{provider:'voicevox',voice:input.voice,transport:'direct',readings:input.readings}});
  if(!p.available)throw Error(p.unavailableReason);
  const summary={order:part.order,title:part.title,bookId:p.bookId,revision:p.revision,planId:p.id,planHash:p.hash,chunks:p.chunks.length,
   characters:p.chunks.reduce((n,c)=>n+c.spokenText.length,0),maxChunkCharacters:Math.max(...p.chunks.map(c=>c.spokenText.length)),speechKeysHash:hash(JSON.stringify(p.chunks.map(c=>c.speechKey)))};
  plans.push(summary);event('planned',{order:part.order,chunks:p.chunks.length});
 }
 await save('plan-input.json',{inputHash,engine:runtime.engineVersion,sourceCommit:input.sourceCommit,createdAt:new Date().toISOString()});
 await save('plans.json',plans);phase='planned';await status();
}
async function run(){
 await planAll();
 const inspection=new AudioInspectionService(new LibraryDisk(config.libraryDir));
 for(const p of plans){
  const previous=parts.find(r=>r.order===p.order);if(previous?.phase==='verified'){
   const saved=await service.getBook(p.bookId,p.revision);requireAudioPresentation(saved);
   for(const c of saved.chunks)if(!await readReadyAudio(new LibraryDisk(config.libraryDir),c.speechKey,'mp3'))throw Error('Completed audio cache changed');
   continue;
  }
  currentOrder=p.order;currentAlignmentId=undefined;phase='generating';
  const fs=await statfs(root);if(fs.bavail*fs.bsize<runtime.minFreeBytes)throw Error(`Less than ${runtime.minFreeBytes} bytes free; retain outputs and stop`);
  let job=await service.startGeneration({planId:p.planId,planHash:p.planHash,operationId:hash(`${runtime.jobId}:generate:${p.order}`),paidConfirmed:false});
  currentJobId=job.id;
  if(['cancelled','failed'].includes(job.status))job=await service.resumeJob(job.id,false);
  await status();event('part-start',{order:p.order,jobId:job.id,completed:job.completedChunks,total:job.totalChunks});
  const result=await service.waitForJob(job.id);await save(`results/generation-${p.order}.json`,result);
  if(result.status!=='completed')throw Error(`Generation ${p.order}: ${result.status}: ${result.error??''}`);
  let book=await service.getBook(p.bookId,p.revision);
  if(book.completedChunks!==p.chunks||book.totalChunks!==p.chunks)throw Error(`Incomplete book ${p.order}`);
  if(result.automaticCompression?.status!=='completed'){
   phase='compressing-saved-audio';await status();
   const disk=new LibraryDisk(config.libraryDir),seen=new Set<string>();
   for(const c of book.chunks){
    if(seen.has(c.speechKey))continue;seen.add(c.speechKey);
    const audio=await readReadyAudio(disk,c.speechKey);if(!audio)throw Error('Compression recovery needs the saved source');
    await encodeVerifiedMp3(disk,c.speechKey,audio.cache);
    if(!await readReadyAudio(disk,c.speechKey,'mp3'))throw Error('Compression recovery verification failed');
   }
   await save(`results/compression-recovery-${p.order}.json`,{status:'completed',files:seen.size,ttsRequests:0,at:new Date().toISOString()});
  }
  phase='checking-audio';await status();
  const qa=await inspection.inspect({bookId:p.bookId,revision:p.revision});
  await save(`results/inspection-${p.order}.json`,qa);
  if(qa.chunks.length!==p.chunks||qa.chunks.some((c:any)=>c.status==='fatal'||c.lightweight?.status==='indeterminate'))throw Error(`Audio QA incomplete or fatal ${p.order}`);
  const issues=qa.chunks.flatMap((c:any)=>c.issues.map((i:any)=>({chunkId:c.chunkId,...i})));
  phase='aligning';
  // Reused MP3s may already have lost their source WAV after an earlier part.
  // Preserve their estimated display clock; never resynthesize just for timing.
  let selection=await read(`results/alignment-selection-${p.order}.json`);
  if(!selection){selection={ids:[],missingOriginal:[]};for(const c of book.chunks){
   if(c.alignment)continue;try{await access(join(config.libraryDir,'audio',c.speechKey+'.wav'));selection.ids.push(c.id)}catch{selection.missingOriginal.push(c.id)}
  }await save(`results/alignment-selection-${p.order}.json`,selection)}
  let alignment:any={status:'completed',completedChunks:0,totalChunks:0};
  if(selection.ids.length&&runtime.engineVersion==='0.25.2'){
   let aj=await service.startAlignment({bookId:p.bookId,revision:p.revision,selectedChunkIds:selection.ids,operationId:hash(`${runtime.jobId}:align:${p.order}`)});
   currentAlignmentId=aj.id;
   if(['failed','cancelled'].includes(aj.status))aj=await service.resumeAlignmentJob(aj.id);
   await status();alignment=await service.waitForAlignmentJob(aj.id);
  }
  await save(`results/alignment-${p.order}.json`,alignment);
  if(alignment.status!=='completed')throw Error(`Alignment ${p.order}: ${alignment.status}`);
  book=await service.getBook(p.bookId,p.revision);const structure=requireAudioPresentation(book);
  phase='cleaning-wav';await status();
  const cleanup=await cleanupSavedWavs(new LibraryDisk(config.libraryDir),{bookId:p.bookId,revision:p.revision,operationId:hash(`${runtime.jobId}:cleanup:${p.order}`),apply:true});
  await save(`results/cleanup-${p.order}.json`,cleanup);
  if(cleanup.files.some((f:any)=>f.status==='failed'))throw Error('WAV cleanup verification failed');
  const record={order:p.order,bookId:p.bookId,revision:p.revision,phase:'verified',generatedChunks:p.chunks,durationSeconds:book.durationSeconds,
   structure:structure.status,qaIssues:issues,engineAlignedChunks:book.chunks.filter(c=>c.alignment?.method==='voicevox-mora').length,
   fallbackChunks:book.chunks.filter(c=>c.alignment?.method!=='voicevox-mora').length,missingOriginalForAlignment:selection.missingOriginal,wavCleanup:{status:cleanup.status,removedFiles:(alignment.wavCleanup?.removedFiles??0)+cleanup.removedFiles,removedWavBytes:(alignment.wavCleanup?.removedWavBytes??0)+cleanup.removedWavBytes,retainedWavFiles:cleanup.retainedWavFiles},
   timingNote:runtime.engineVersion==='0.25.2'?'captured-query verification with explicit fallback':'This core does not support phoneme timing for this Engine version; display estimates and needed WAVs are retained',completedAt:new Date().toISOString()};
  parts=parts.filter(r=>r.order!==p.order);parts.push(record);currentJobId=undefined;currentAlignmentId=undefined;
  await status();event('part-verified',{order:p.order,chunks:p.chunks,issues:issues.length});
 }
 currentOrder=undefined;phase='verifying-artifacts';await status();
 const keys=new Set<string>();let bytes=0;
 for(const p of plans){
  const book=await service.getBook(p.bookId,p.revision);requireAudioPresentation(book);
  for(const c of book.chunks){if(keys.has(c.speechKey))continue;keys.add(c.speechKey);
   const media=await readFile(join(config.libraryDir,'audio-media',c.speechKey+'.json'),'utf8').then(JSON.parse);
   const cache=await readFile(join(config.libraryDir,'cache',c.speechKey+'.json'),'utf8').then(JSON.parse);
   const audio=await readFile(join(config.libraryDir,'audio',c.speechKey+'.mp3'));
   if(hash(audio)!==media.hash||audio.length!==media.bytes||media.sourceAudioHash!==cache.hash)throw Error('Final audio hash mismatch');bytes+=audio.length;
  }
 }
 const warnings=parts.flatMap(p=>p.qaIssues);
 phase=warnings.length?'review-required':'ready-for-import';
 await save('completion.json',{schemaVersion:1,inputHash,jobId:runtime.jobId,engineVersion:runtime.engineVersion,sourceCommit:runtime.sourceCommit,at:new Date().toISOString(),phase,books:plans.length,chunks:plans.reduce((n,p)=>n+p.chunks,0),
  uniqueMp3Files:keys.size,mp3Bytes:bytes,durationSeconds:parts.reduce((n,p)=>n+p.durationSeconds,0),warningCount:warnings.length,
  sourceOcrUnresolved:input.unresolvedOcrCount,libraryDir:config.libraryDir,scope:'generation, MP3 compression, captured VOICEVOX timing, lightweight QA; no ASR or deployment',parts});
 await status();event('batch-completed',{phase,books:plans.length,mp3Files:keys.size,warnings:warnings.length});
}

const mode=process.argv[3]??'status';
if(mode==='status'){console.log(JSON.stringify(await read('progress.json')));process.exit(0)}
await mkdir(root,{recursive:true,mode:0o700});
let timer:ReturnType<typeof setInterval>|undefined;
try{
 await waitEngine();service=new GenerationService(config,{voicevox:batchVoicevox(await loadCore(runtime.repo),runtime.engineEndpoint)});await service.ready();
 // Completed audio remains in its durable core cache across process restarts.
 if(mode==='plan')await planAll();else if(mode==='run'){
  timer=setInterval(()=>{void status().catch(e=>{event('fatal-status',{message:String(e)});process.exit(1)})},10000);
  await run();
 }else throw Error('Usage: runner.mts runtime.json plan|run|status');
}catch(e){lastError=e instanceof Error?e.message:String(e);phase='failed';await status();event('batch-failed',{message:lastError});process.exitCode=1}
finally{if(timer)clearInterval(timer);await statusTail;}
