import { readFile, writeFile, mkdir, cp, rm, readdir, access, link, rename, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { loadCore } from './core.mts';

const root=dirname(fileURLToPath(import.meta.url));
const {values}=parseArgs({options:{source:{type:'string'},selection:{type:'string'},destination:{type:'string'},work:{type:'string'},apply:{type:'boolean'},rollback:{type:'boolean'},config:{type:'string'},repo:{type:'string'}}});
const task=values.config?JSON.parse(await readFile(resolve(values.config),'utf8')):undefined;
const configRoot=values.config?dirname(resolve(values.config)):root;
const taskPath=(name:string)=>{const v=task[name];return v==='~'?homedir():v.startsWith('~/')?join(homedir(),v.slice(2)):resolve(configRoot,v)};
const taskWork=task?taskPath('workDir'):root;
const repo=resolve(values.repo??(task?taskPath('repo'):join(root,'../../../..')));
const {GenerationService,BOOK_REFERENCES_LOCK,LibraryDisk,readReadyAudio,requireAudioPresentation,VOICEVOX_CAPABILITIES}=await loadCore(repo);
const source=resolve(values.source??join(taskWork,'incoming/library'));
const destination=resolve(values.destination??(task?taskPath('localLibrary'):join(homedir(),'Documents/rsvp-reader-library')));
const work=resolve(values.work??join(taskWork,'import-work'));
if(source===destination||work===destination||source.startsWith(destination+'/')||work.startsWith(destination+'/'))throw Error('Use an isolated source and work directory');
if(work===source||work.startsWith(source+'/')||destination.startsWith(source+'/')||destination.startsWith(join(work,'candidate-library')+'/'))throw Error('Source, candidate and destination must be isolated');
await new LibraryDisk(work).withLock('import-session',async()=>{
const digest=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function exists(p:string){try{await access(p);return true}catch(e:any){if(e.code==='ENOENT')return false;throw e}}
async function json(p:string){return JSON.parse(await readFile(p,'utf8'))}
async function save(name:string,data:any){await mkdir(work,{recursive:true,mode:0o700});const dest=join(work,name),tmp=dest+`.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(tmp,dest)}
await mkdir(destination,{recursive:true,mode:0o700});
if((await lstat(destination)).isSymbolicLink())throw Error('Destination cannot be a symlink');
const disk=new LibraryDisk(destination);
const journalPath=join(work,'journal.json');
async function rollback(journal:any){
 return disk.withLock(BOOK_REFERENCES_LOCK,async()=>{
 const restored:string[]=[];
 for(const entry of (journal.added??[]).filter((e:any)=>e.path.startsWith('books/')).reverse()){
  const path=join(destination,entry.path);if(!await exists(path))continue;
  if(!entry.created){
   const a=await lstat(path),b=await lstat(join(work,'candidate-library',entry.path));
   if(a.ino!==b.ino||a.dev!==b.dev)continue;
  }
  if(digest(await readFile(path))!==entry.hash)throw Error('New book was edited after import; retain it and inspect before rollback');
  const backup=join(work,'rollback',entry.path);await mkdir(dirname(backup),{recursive:true,mode:0o700});
  if(await exists(backup)){
   if(digest(await readFile(backup))!==entry.hash)throw Error('Rollback backup differs; retain both versions');
   await rm(path);
  }else await rename(path,backup);
  restored.push(entry.path);
 }
 journal.status='rolled-back';journal.rolledBackBooks=restored;await save('journal.json',journal);
 return {status:'rolled-back',hiddenBooks:restored.length,note:'Only newly added books were moved to private rollback storage. Shared audio and caches are retained.'};
 });
}
if(values.rollback){console.log(JSON.stringify(await disk.withLock('remote-import-'+digest(source).slice(0,32),async()=>rollback(await json(journalPath)))));return}
const plans=await json(resolve(values.selection??join(source,'../plans.json')));
if(!Array.isArray(plans)||!plans.length)throw Error('Empty import selection');
if(plans.some(p=>!/^book-[a-zA-Z0-9_-]+$/.test(p.bookId)||!/^[a-f0-9]{64}$/.test(p.revision)||!Number.isInteger(p.chunks)||p.chunks<1)||new Set(plans.map(p=>p.bookId+'_'+p.revision)).size!==plans.length)throw Error('Invalid or duplicate selected book identity');
if(task){
 const receipt=await json(join(taskWork,'collection.json')),completion=await json(join(source,'../completion.json')),handoff=await json(join(taskWork,'handoff.json'));
 if(receipt.inputHash!==handoff.inputHash||completion.inputHash!==handoff.inputHash||completion.phase!=='ready-for-import'||completion.warningCount||completion.books!==plans.length||completion.chunks!==plans.reduce((n:number,p:any)=>n+p.chunks,0))throw Error('Collection/completion identity or QA differs');
 if(execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==task.sourceCommit)throw Error('Local core commit differs');
}
const sourceDisk=new LibraryDisk(source);
const selected:any[]=[];const retained:any[]=[];const sourceHashes:any[]=[];
await save('progress.json',{phase:'validating-source',pid:process.pid,books:0,totalBooks:plans.length,updatedAt:new Date().toISOString()});
for(const p of plans){
 const name=`${p.bookId}_${p.revision}.json`,path=join(source,'books',name),bytes=await readFile(path),book=JSON.parse(bytes.toString('utf8'));
 if(book.id!==p.bookId||book.revision!==p.revision||book.totalChunks!==p.chunks||book.completedChunks!==p.chunks||book.chunks.length!==p.chunks||book.options?.provider!=='voicevox')throw Error('Source book identity or completion mismatch');
 requireAudioPresentation(book);sourceHashes.push({path:name,hash:digest(bytes)});
 for(const c of book.chunks){
  const a=await readReadyAudio(sourceDisk,c.speechKey,'mp3');
  if(a?.mimeType!=='audio/mpeg'||a.cache.durationSeconds!==c.durationSeconds)throw Error('Source lacks a verified MP3 or its clock differs');
  if(c.alignment&&c.alignment.audioHash!==a.sourceAudioHash)throw Error('Source alignment refers to another waveform');
  sourceHashes.push({speechKey:c.speechKey,mp3Hash:a.media.hash,sourceAudioHash:a.sourceAudioHash,durationSeconds:a.cache.durationSeconds});
 }
 const target=join(destination,'books',name);
 if(await exists(target)){
  const b=await json(target);requireAudioPresentation(b);
  if(b.id!==p.bookId||b.revision!==p.revision||b.completedChunks!==p.chunks||b.totalChunks!==p.chunks)throw Error('Existing book identity or completion differs; preserve it for explicit recovery');
  for(const key of new Set<string>(b.chunks.map((c:any)=>c.speechKey)))if(!await readReadyAudio(disk,key))throw Error('Existing book has missing audio');
  retained.push(p);continue;
 }
 selected.push({...p,book});
 await save('progress.json',{phase:'validating-source',pid:process.pid,books:selected.length+retained.length,totalBooks:plans.length,updatedAt:new Date().toISOString()});
}
if(!selected.length){const report={status:'complete',addedBooks:0,retainedBooks:retained.length,ttsRequests:0,destination};await save('result.json',report);console.log(JSON.stringify(report));return}
const sourceIdentity=digest(JSON.stringify(sourceHashes));
const priorBooks=new Map<string,string>();
if(await exists(join(destination,'books')))for(const name of await readdir(join(destination,'books')))if(name.endsWith('.json'))priorBooks.set(name,digest(await readFile(join(destination,'books',name))));

const candidate=join(work,'candidate-library');
let built=await exists(join(work,'candidate-ready.json'))?await json(join(work,'candidate-ready.json')):undefined;
if(built&&(built.sourceIdentity!==sourceIdentity||built.destination!==destination))throw Error('Candidate belongs to another input or library');
if(!built){
 await save('progress.json',{phase:'building-candidate',pid:process.pid,books:0,totalBooks:selected.length,updatedAt:new Date().toISOString()});
 await rm(candidate,{recursive:true,force:true});
 const omit=new Set(['locks','owners','alignment-owners','jobs','operations','alignment-jobs','alignment-operations','audio-compression-jobs']);
 await cp(source,candidate,{recursive:true,filter:path=>!omit.has(relative(source,path).split('/')[0])});
 const changed=new Set<string>(),canonical:any[]=[];
 const keys=new Set<string>(selected.flatMap(p=>p.book.chunks.map((c:any)=>c.speechKey)));
 for(const key of keys){
  if(!await exists(join(destination,'cache',key+'.json')))continue;
  const local=await readReadyAudio(disk,key,'mp3');if(local?.mimeType!=='audio/mpeg')throw Error('Existing speech key lacks a verified MP3; preserve it for review');
  const original=await json(join(candidate,'cache',key+'.json'));
  if(original.hash!==local.cache.hash||original.durationSeconds!==local.cache.durationSeconds)changed.add(key);
  for(const rel of [`cache/${key}.json`,`audio-media/${key}.json`,`audio/${key}.mp3`,`audio/${key}.wav`,`voicevox-queries/${key}.json`]){
   const from=join(destination,rel),to=join(candidate,rel);await rm(to,{force:true});
   if(await exists(from)){const bytes=await readFile(from);canonical.push({path:rel,hash:digest(bytes)});await mkdir(dirname(to),{recursive:true,mode:0o700});await writeFile(to,bytes,{mode:0o600})}
  }
 }
 for(const p of selected){const b=p.book;for(const c of b.chunks)if(changed.has(c.speechKey))delete c.alignment;
  await writeFile(join(candidate,'books',`${p.bookId}_${p.revision}.json`),JSON.stringify(b),{mode:0o600});
 }
 let ttsRequests=0;let activeProviderVersion='';
 const adapter={endpoint:'http://127.0.0.1:50021',capabilities:VOICEVOX_CAPABILITIES,
  async fingerprint(){return activeProviderVersion},async voices(){return []},
  async synthesize(){ttsRequests++;throw Error('TTS disabled during library import')}};
 const service=new GenerationService({libraryDir:candidate,localOrigin:'http://127.0.0.1:4173',paidEnabled:false},{voicevox:adapter});await service.ready();
 let rebuiltBooks=0;
 for(const p of selected){
  if(!p.book.chunks.some((c:any)=>changed.has(c.speechKey))){
   await save('progress.json',{phase:'building-candidate',pid:process.pid,books:++rebuiltBooks,totalBooks:selected.length,updatedAt:new Date().toISOString()});continue;
  }
  activeProviderVersion=p.book.providerVersion;
  if(!/^voicevox-engine:[a-zA-Z0-9_.-]{1,80}$/.test(activeProviderVersion))throw Error('Missing VOICEVOX fingerprint');
  const plan=await service.prepareGeneration({document:p.book.document,options:p.book.options});
  if(plan.bookId!==p.bookId||plan.revision!==p.revision||plan.chunks.length!==p.chunks||!plan.chunks.every(c=>c.cacheHit))throw Error('Import plan would require new speech or change identity');
  const job=await service.startGeneration({planId:plan.id,planHash:plan.hash,operationId:digest(`${sourceIdentity}:import:${p.order}`),paidConfirmed:false});
  const result=await service.waitForJob(job.id);if(result.status!=='completed')throw Error('Offline import publication failed');
  const book=await service.getBook(p.bookId,p.revision);requireAudioPresentation(book);
  for(const c of book.chunks){
   const a=await readReadyAudio(new LibraryDisk(candidate),c.speechKey,'mp3');if(a?.mimeType!=='audio/mpeg'||a.cache.durationSeconds!==c.durationSeconds)throw Error('Candidate audio clock mismatch');
   if(c.alignment&&c.alignment.audioHash!==a.sourceAudioHash)throw Error('Candidate alignment refers to another waveform');
  }
  await save('progress.json',{phase:'building-candidate',pid:process.pid,books:++rebuiltBooks,totalBooks:selected.length,currentOrder:p.order,updatedAt:new Date().toISOString()});
 }
 if(ttsRequests)throw Error('Import attempted synthesis');
 built={sourceIdentity,destination,canonical,changedSpeechKeys:[...changed],ttsRequests,at:new Date().toISOString()};await save('candidate-ready.json',built);
}
for(const entry of built.canonical)if(!await exists(join(destination,entry.path))||digest(await readFile(join(destination,entry.path)))!==entry.hash)throw Error('Existing canonical cache changed after planning; rebuild candidate before import');
for(const p of selected){
 const b=await json(join(candidate,'books',`${p.bookId}_${p.revision}.json`));requireAudioPresentation(b);
 if(b.completedChunks!==p.chunks||b.totalChunks!==p.chunks)throw Error('Candidate completion changed');
 for(const c of b.chunks){
  const a=await readReadyAudio(new LibraryDisk(candidate),c.speechKey,'mp3');
  if(a?.mimeType!=='audio/mpeg'||a.cache.durationSeconds!==c.durationSeconds)throw Error('Candidate audio clock/hash mismatch');
  if(c.alignment&&c.alignment.audioHash!==a.sourceAudioHash)throw Error('Candidate alignment waveform differs');
 }
}
const selectedBookNames=new Set(selected.map(p=>`${p.bookId}_${p.revision}.json`));
const selectedSpeechKeys=new Set<string>(selected.flatMap(p=>p.book.chunks.map((c:any)=>c.speechKey)));
const selectedRevisions=new Set(selected.map(p=>p.revision));
const entries:any[]=[];
for(const dir of ['audio','cache','audio-media','sources','plans','voicevox-queries','jobs','books']){
 if(!await exists(join(candidate,dir)))continue;
 for(const name of (await readdir(join(candidate,dir))).sort()){
  if(!/^[a-zA-Z0-9_.-]+$/.test(name)||name.includes('..'))throw Error('Unexpected candidate file name');
  if(dir==='books'&&!selectedBookNames.has(name))continue;
  if(['audio','cache','audio-media','voicevox-queries'].includes(dir)&&!selectedSpeechKeys.has(name.split('.')[0]))continue;
  if(dir==='sources'&&!selectedRevisions.has(name.replace(/\.json$/,'')))continue;
  const from=join(candidate,dir,name);if(!(await lstat(from)).isFile())throw Error('Unexpected candidate file type');
  if(dir==='plans'||dir==='jobs'){const record=await json(from),identity=dir==='plans'?record.plan:record;if(!selectedBookNames.has(`${identity.bookId}_${identity.revision}.json`))continue}
  const rel=dir+'/'+name,hash=digest(await readFile(from)),dest=join(destination,rel);
  if(await exists(dest)){
   if(!(await lstat(dest)).isFile()||(await lstat(dest)).isSymbolicLink())throw Error('Destination entry must be a regular file');
   if(digest(await readFile(dest))!==hash){
    if(dir==='plans'){const a=await json(from),b=await json(dest);if(a.plan?.hash===b.plan?.hash&&a.document?.contentHash===b.document?.contentHash)continue}
    throw Error(`Existing file differs; will not overwrite: ${rel}`);
   }
   continue;
  }
  entries.push({path:rel,hash});
 }
}
const plan={status:'planned',source,destination,sourceIdentity,newBooks:selected.length,retainedBooks:retained.length,
 totalSelectedChunks:plans.reduce((n:any,p:any)=>n+p.chunks,0),filesToAdd:entries.length,canonicalCollisions:built.canonical.length,changedSpeechKeys:built.changedSpeechKeys,
 canonicalQaRequired:selected.flatMap(p=>{const ids=p.book.chunks.filter((c:any)=>built.changedSpeechKeys.includes(c.speechKey)).map((c:any)=>c.id);return ids.length?[{bookId:p.bookId,revision:p.revision,chunkIds:ids}]:[]}),
 rebuiltBooks:selected.filter(p=>p.book.chunks.some((c:any)=>built.changedSpeechKeys.includes(c.speechKey))).length,ttsRequests:0,entries};
await save('plan.json',plan);
if(!values.apply){console.log(JSON.stringify({...plan,entries:undefined}));process.exit(0)}
const report=await disk.withLock('remote-import-'+digest(source).slice(0,32),async()=>{
 const journal=await exists(journalPath)?await json(journalPath):{schemaVersion:1,status:'applying',sourceIdentity,destination,added:[]};
 if(journal.sourceIdentity!==sourceIdentity||journal.destination!==destination)throw Error('Import journal identity mismatch');
 const releases:Array<()=>Promise<void>>=[];
 try{
  // Coordinate with ordinary generation and WAV cleanup in the same library.
  for(const key of [...new Set<string>(selected.flatMap(p=>p.book.chunks.map((c:any)=>c.speechKey)))].sort()){
   const release=await disk.lock('speech-'+key);if(!release)throw Error('A selected speech key is in use; retry the import after that job finishes');releases.push(release);
  }
  // Persist the complete intent once. Atomic hard links prove ownership after
  // a crash, allowing bounded checkpoints instead of rewriting an O(n) journal
  // twice for every one of the thousands of files.
  const rows=new Map<string,any>(journal.added.map((r:any)=>[r.path,r]));
  for(const e of entries)if(!rows.has(e.path)){const row={...e,created:false};journal.added.push(row);rows.set(e.path,row)}
  journal.status='applying';await save('journal.json',journal);
  let published=0;
  for(const e of entries){
   const publish=async()=>{
   const from=join(candidate,e.path),dest=join(destination,e.path);await mkdir(dirname(dest),{recursive:true,mode:0o700});
   const parent=await lstat(dirname(dest));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Destination directory must not be a symlink');
   if(digest(await readFile(from))!==e.hash)throw Error('Candidate changed before commit');
   // Save intent before the atomic hard link. No existing destination is replaced.
   try{await link(from,dest);rows.get(e.path).created=true}catch(error:any){if(error.code!=='EEXIST'||digest(await readFile(dest))!==e.hash)throw error}
   };
   if(e.path.startsWith('books/'))await disk.withLock(BOOK_REFERENCES_LOCK,publish);else await publish();
   published++;
   if(published%128===0||e.path.startsWith('books/')){
    await save('journal.json',journal);
    await save('progress.json',{phase:'committing',pid:process.pid,files:published,totalFiles:entries.length,updatedAt:new Date().toISOString()});
   }
  }
  for(const p of selected){const b=await json(join(destination,'books',`${p.bookId}_${p.revision}.json`));requireAudioPresentation(b);for(const c of b.chunks)if(!await readReadyAudio(disk,c.speechKey,'mp3'))throw Error('Imported book audio missing')}
  for(const [name,hash] of priorBooks)if(digest(await readFile(join(destination,'books',name)))!==hash)throw Error('A pre-existing book changed during import');
  journal.status='complete';journal.completedAt=new Date().toISOString();await save('journal.json',journal);
  return {status:'complete',addedBooks:selected.length,retainedBooks:retained.length,addedFiles:journal.added.length,preservedExistingBooks:priorBooks.size,canonicalSpeechKeys:built.changedSpeechKeys.length,ttsRequests:0,destination};
 }catch(e){journal.error=e instanceof Error?e.message:String(e);await save('journal.json',journal);await rollback(journal);throw e}
 finally{for(const release of releases.reverse())await release()}
});
await save('result.json',report);console.log(JSON.stringify(report));
await save('progress.json',{phase:'complete',pid:process.pid,books:report.addedBooks,totalBooks:selected.length,updatedAt:new Date().toISOString()});
});
