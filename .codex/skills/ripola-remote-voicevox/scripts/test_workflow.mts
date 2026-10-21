import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCore } from './core.mts';

// Self-authored text + synthetic PCM, an ephemeral loopback Engine protocol double.
// No external Linux, real VOICEVOX process, existing bookshelf, ASR or model download.
const scripts=dirname(fileURLToPath(import.meta.url)),repo=resolve(scripts,'../../../..');
const temp=await mkdtemp(join(tmpdir(),'ripola-remote-workflow-'));
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
async function save(p:string,v:any){await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(v)+'\n')}
const run=promisify(execFile);
async function node(script:string,...args:string[]){return run(process.execPath,['--import','tsx',join(scripts,script),...args],{cwd:repo,timeout:120000,maxBuffer:1024*1024})}
function wav(seconds=1,frequency=440){
 const samples=Math.round(24000*seconds),b=Buffer.alloc(44+samples*2);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);
 b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);
 let state=12345+frequency,filtered=0;
 for(let i=0;i<samples;i++){
  state=(Math.imul(state,1664525)+1013904223)>>>0;
  filtered=filtered*.97+(state/2**32-.5)*.03;
  const time=i/24000,envelope=.6+.35*Math.sin(time*6.71)**2;
  b.writeInt16LE(Math.round((filtered+.01*Math.sin(time*time*37))*envelope*150000),44+i*2);
 }
 return b;
}
let syntheses=0;
const server=createServer(async(req,res)=>{
 for await(const _ of req){};
 res.setHeader('Content-Type','application/json');
 if(req.url==='/version')res.end(JSON.stringify('fixture-1'));
 else if(req.url==='/speakers')res.end(JSON.stringify([{name:'検証声',styles:[{id:7,name:'検証'}]}]));
 else if(req.url?.startsWith('/audio_query?'))res.end('{}');
 else if(req.url?.startsWith('/synthesis?')){res.setHeader('Content-Type','audio/wav');res.end(wav(1,440+ ++syntheses*20))}
 else{res.statusCode=404;res.end('{}')}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
try{
 const address=server.address();if(!address||typeof address==='string')throw Error('Missing fixture port');
 const root=join(temp,'remote'),library=join(root,'library');await mkdir(join(root,'inputs'),{recursive:true});
 const texts=['朝の光が部屋に差します。窓辺の花が揺れます。','夜には静かに本を読みます。'];
 const input={target:'fixture-lantern',voice:'7',readings:[],unresolvedOcrCount:0,parts:texts.map((text,index)=>({order:index+1,title:'自作検証'+(index+1),file:`${index+1}.md`,sha256:hash(text)}))};
 for(let i=0;i<texts.length;i++)await writeFile(join(root,'inputs',`${i+1}.md`),texts[i]);
 const raw=JSON.stringify(input)+'\n';await writeFile(join(root,'input.json'),raw);
 const runtime=join(root,'runtime.json');
 await save(runtime,{root,repo,jobId:input.target,inputHash:hash(raw),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),engineVersion:'fixture-1',engineEndpoint:`http://127.0.0.1:${address.port}`,minFreeBytes:1});
 await node('runner.mts',runtime,'run');
 const completion=await json(join(root,'completion.json'));assert.equal(completion.phase,'ready-for-import');assert.equal(completion.books,2);assert.equal(completion.warningCount,0);assert.ok(syntheses>=3);
 const firstSyntheses=syntheses;
 await node('runner.mts',runtime,'run');assert.equal(syntheses,firstSyntheses,'Verified parts must not synthesize again');
 // Simulate interruption between a completed core job and the part checkpoint.
 const progress=await json(join(root,'progress.json'));progress.parts=progress.parts.slice(0,1);await save(join(root,'progress.json'),progress);
 await node('runner.mts',runtime,'run');assert.equal(syntheses,firstSyntheses,'Completed core operation must resume from cache');
 // A codec failure is recovered from the durable WAV, without another provider call.
 const savedPlans=await json(join(root,'plans.json'));
 const savedJob=await json(join(root,'results/generation-1.json'));
 const savedBook=await json(join(library,'books',`${savedPlans[0].bookId}_${savedPlans[0].revision}.json`));
 const recoverKey=savedBook.chunks[0].speechKey;
 const sourceWavBefore=hash(await readFile(join(library,'audio',recoverKey+'.wav')));
 savedJob.automaticCompression.status='partial';await save(join(library,'jobs',savedJob.id+'.json'),savedJob);
 await rm(join(library,'audio',recoverKey+'.mp3'));await rm(join(library,'audio-media',recoverKey+'.json'));
 const interrupted=await json(join(root,'progress.json'));interrupted.parts=interrupted.parts.filter((p:any)=>p.order!==1);await save(join(root,'progress.json'),interrupted);
 await rm(join(root,'completion.json'));
 await node('runner.mts',runtime,'run');assert.equal(syntheses,firstSyntheses);
 assert.equal(hash(await readFile(join(library,'audio',recoverKey+'.wav'))),sourceWavBefore);
 assert.equal((await json(join(root,'results/compression-recovery-1.json'))).ttsRequests,0);
 const core=await loadCore(repo),sourceDisk=new core.LibraryDisk(library);
 const plans=await json(join(root,'plans.json'));
 const bookPath=(p:any,base=library)=>join(base,'books',`${p.bookId}_${p.revision}.json`);
 const first=await json(bookPath(plans[0])),key=first.chunks[0].speechKey;
 const sourceAudio=await core.readReadyAudio(sourceDisk,key,'mp3');
 // A valid sentence fallback referencing the old waveform must disappear on collision.
 first.chunks[0].alignment={schemaVersion:1,key:'a'.repeat(64),audioHash:sourceAudio.sourceAudioHash,normalizeVersion:'ctc-ja-nfkc-v1',alignerVersion:'fixture',precision:'sentence',method:'sentence-fallback',status:'unmatched',cues:[],units:[],warnings:[]};
 await save(bookPath(plans[0]),first);core.requireAudioPresentation(first);
 const selection=join(root,'plans.json');
 const dest=join(temp,'shelf'),work=join(temp,'import-work');
 const args=['--source',library,'--selection',selection,'--destination',dest,'--work',work,'--repo',repo];
 await node('import-library.mts',...args);let plan=await json(join(work,'plan.json'));
 assert.equal(plan.newBooks,2);assert.equal(plan.rebuiltBooks,0,'Unchanged books must not be rebuilt');assert.equal(plan.ttsRequests,0);
 await node('import-library.mts',...args,'--apply');
 const result=await json(join(work,'result.json'));assert.equal(result.addedBooks,2);assert.equal(result.ttsRequests,0);
 const before=await readFile(bookPath(plans[0],dest));
 await node('import-library.mts',...args,'--apply');assert.equal((await json(join(work,'result.json'))).addedBooks,0);assert.deepEqual(await readFile(bookPath(plans[0],dest)),before);
 await node('import-library.mts',...args,'--rollback');assert.equal((await readdir(join(dest,'books'))).length,0);assert.ok((await readdir(join(dest,'audio'))).length>0,'Rollback retains shared audio');

 const collisionDest=join(temp,'collision-shelf'),collisionWork=join(temp,'collision-work');await cp(library,collisionDest,{recursive:true});
 await rm(bookPath(plans[0],collisionDest));const retainedBefore=await readFile(bookPath(plans[1],collisionDest));
 const disk=new core.LibraryDisk(collisionDest),pcm=wav(1.25,700);
 await writeFile(join(collisionDest,'audio',key+'.wav'),pcm);
 const cache={schemaVersion:1,status:'ready',provider:'voicevox',hash:hash(pcm),durationSeconds:1.25};await save(join(collisionDest,'cache',key+'.json'),cache);
 await rm(join(collisionDest,'audio',key+'.mp3'));await rm(join(collisionDest,'audio-media',key+'.json'));
 const {encodeVerifiedMp3}=await import(pathToFileURL(join(repo,'apps/web/src/generation/core/audio-compression.ts')).href);
 await encodeVerifiedMp3(disk,key,cache);const mp3Before=hash(await readFile(join(collisionDest,'audio',key+'.mp3')));
 const collisionArgs=['--source',library,'--selection',selection,'--destination',collisionDest,'--work',collisionWork,'--repo',repo];
 await node('import-library.mts',...collisionArgs);
 plan=await json(join(collisionWork,'plan.json'));assert.equal(plan.rebuiltBooks,1);assert.equal(plan.changedSpeechKeys.length,1);assert.equal(plan.retainedBooks,1);
 await node('import-library.mts',...collisionArgs,'--apply');
 const imported=await json(bookPath(plans[0],collisionDest));core.requireAudioPresentation(imported);
 assert.equal(imported.chunks[0].alignment,undefined);assert.equal(imported.chunks[0].durationSeconds,1.25);
 assert.equal(hash(await readFile(join(collisionDest,'audio',key+'.mp3'))),mp3Before);assert.deepEqual(await readFile(bookPath(plans[1],collisionDest)),retainedBefore);
 assert.equal((await json(join(collisionWork,'result.json'))).ttsRequests,0);
 await node('import-library.mts',...collisionArgs,'--rollback');assert.deepEqual(await readFile(bookPath(plans[1],collisionDest)),retainedBefore);

 // Exercise the documented shared job.json entrypoint and its collection binding.
 const configFile=join(root,'job.json');
 await save(configFile,{repo,workDir:'.',localLibrary:'../config-shelf',sourceCommit:(await json(runtime)).sourceCommit});
 await save(join(root,'handoff.json'),{inputHash:hash(raw)});await save(join(root,'collection.json'),{inputHash:hash(raw)});
 const configArgs=['--config',configFile,'--source',library,'--selection',selection];
 await node('import-library.mts',...configArgs);
 await save(join(root,'collection.json'),{inputHash:'b'.repeat(64)});
 await assert.rejects(node('import-library.mts',...configArgs,'--apply'));
 await save(join(root,'collection.json'),{inputHash:hash(raw)});
 await node('import-library.mts',...configArgs,'--apply');assert.equal((await json(join(root,'import-work/result.json'))).addedBooks,2);

 const corruptDest=join(temp,'corrupt-shelf'),corruptWork=join(temp,'corrupt-work');
 const corruptArgs=['--source',library,'--selection',selection,'--destination',corruptDest,'--work',corruptWork,'--repo',repo];
 await node('import-library.mts',...corruptArgs);
 await writeFile(join(corruptWork,'candidate-library/audio',key+'.mp3'),Buffer.from('corrupt candidate'));
 await assert.rejects(node('import-library.mts',...corruptArgs,'--apply'));
 await assert.rejects(readFile(bookPath(plans[0],corruptDest)));
 const stable=await readFile(join(library,'audio',key+'.mp3'));
 await writeFile(join(library,'audio',key+'.mp3'),Buffer.from('corrupt source'));
 await assert.rejects(node('import-library.mts',...corruptArgs));await writeFile(join(library,'audio',key+'.mp3'),stable);
 console.log(JSON.stringify({status:'passed',books:2,chunks:completion.chunks,syntheticTtsCalls:firstSyntheses,resumeReusedAllSpeech:true,compressionRecoveredWithoutTts:true,importTtsRequests:0,rebuiltOnlyAffectedBook:true,existingBookAndMp3Preserved:true,corruptSourceAndCandidateRejected:true,rollbackPreservedSharedAudio:true,jobConfigAndReceiptBindingVerified:true}));
}finally{
 await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 await rm(temp,{recursive:true,force:true});
}
