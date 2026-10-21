// Task-local scheduling and timeout only. Voice, query, Engine and synthesis parameters remain identical.
export function batchVoicevox(core:any,endpoint='http://127.0.0.1:50021'):any{
 const {voicevoxAdapter,SpeechRequestError}=core;
 const parsed=new URL(endpoint);
 if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/')throw Error('Use a loopback Engine endpoint');
 const VOICEVOX_ENDPOINT=endpoint.replace(/\/$/,'');
 const original=voicevoxAdapter();let tail=Promise.resolve();
 return {...original,endpoint:VOICEVOX_ENDPOINT,
 async fingerprint(){
  const r=await fetch(VOICEVOX_ENDPOINT+'/version',{redirect:'error',signal:AbortSignal.timeout(3000)});
  const v=await r.json();if(!r.ok||typeof v!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(v))throw Error('Invalid Engine version');
  return 'voicevox-engine:'+v;
 },async voices(){
  const r=await fetch(VOICEVOX_ENDPOINT+'/speakers',{redirect:'error',signal:AbortSignal.timeout(3000)});
  const speakers=await r.json();if(!r.ok||!Array.isArray(speakers))throw Error('Invalid voice list');
  return speakers.flatMap((s:any)=>(s.styles??[]).map((v:any)=>({id:String(v.id),name:s.name+' / '+v.name,speakerName:s.name,styleName:v.name})));
 },async synthesize(request:any,beforeSend:any){
  let release!:()=>void;const previous=tail;tail=new Promise<void>(r=>{release=r});await previous;
  const start=Date.now();let stage='audio_query';
  try{
   const query=await fetch(`${VOICEVOX_ENDPOINT}/audio_query?${new URLSearchParams({speaker:request.options.voice,text:request.text})}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000)});
   if(!query.ok)throw Error(`HTTP ${query.status}`);
   const bytes=new Uint8Array(await query.arrayBuffer());if(bytes.length>4*1024*1024)throw Error('Query too large');
   request.captureVoicevoxQuery?.(JSON.parse(Buffer.from(bytes).toString('utf8')));
   await beforeSend();stage='synthesis';
   const response=await fetch(`${VOICEVOX_ENDPOINT}/synthesis?${new URLSearchParams({speaker:request.options.voice})}`,{method:'POST',headers:{'Content-Type':'application/json'},body:bytes,redirect:'error',signal:AbortSignal.timeout(900000)});
   if(!response.ok)throw Error(`HTTP ${response.status}`);
   const reader=response.body!.getReader();const parts:Uint8Array[]=[];let total=0;
   try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>64*1024*1024){await reader.cancel();throw Error('Audio too large')}parts.push(next.value)}}finally{reader.releaseLock()}
   const audio=new Uint8Array(total);let offset=0;for(const p of parts){audio.set(p,offset);offset+=p.length}
   console.log(JSON.stringify({event:'serial-voicevox',milliseconds:Date.now()-start,characters:request.text.length,bytes:total}));return audio;
  }catch(e:any){console.log(JSON.stringify({event:'serial-voicevox-error',stage,milliseconds:Date.now()-start,name:e.name,cause:e.cause?.code,message:e.message}));throw new SpeechRequestError(`VOICEVOX ${stage} failed: ${e.name}`,true)}finally{release()}
 }};
}
