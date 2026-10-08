import type { Page } from '@playwright/test';
/** Real playback samples include ruby glyphs, frame geometry and scrolling. */
export async function inspectWrapping(page: Page, durationMs: number) {
 return page.evaluate(duration=>new Promise<{frames:number;phrases:number;maximumLines:number;samePhraseSizeChanges:number;frameHeightDelta:number;stageTopDelta:number;stageHeightDelta:number;stageScrollDelta:number;pageScrollDelta:number;maxGlyphOverflow:number;minSize:number;progressIncreases:number}>(resolve=>{
  const frames:Array<{text:string;size:number;height:number;top:number;stageHeight:number;scroll:number;page:number;overflow:number;lines:number;progress:number}>=[];const start=performance.now();
  const sample=()=>{
   const phrase=document.querySelector<HTMLElement>('.phrase'),frame=document.querySelector<HTMLElement>('.phrase-container'),stage=document.querySelector<HTMLElement>('[data-testid="reader-stage"],[data-testid="audio-stage"]');
   if(phrase&&frame&&stage){const s=stage.getBoundingClientRect(),css=getComputedStyle(phrase),bounds:DOMRect[]=[];const walker=document.createTreeWalker(phrase,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){if(!walker.currentNode.textContent?.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);bounds.push(...range.getClientRects());}
    const overflow=Math.max(0,...bounds.flatMap(b=>[s.left+1-b.left,b.right-(s.right-1),s.top+1-b.top,b.bottom-(s.bottom-1)]));
    const progress=Number((document.querySelector('#audio-position')as HTMLInputElement)?.value??(document.querySelector('.reading-track')as HTMLElement)?.dataset.progress??0);
    frames.push({text:phrase.textContent??'',size:parseFloat(css.fontSize),height:frame.getBoundingClientRect().height,top:s.top,stageHeight:s.height,scroll:stage.scrollTop,page:scrollY,overflow,lines:Math.max(1,Math.round(phrase.getBoundingClientRect().height/parseFloat(css.lineHeight))),progress});
   }
   if(performance.now()-start<duration)requestAnimationFrame(sample);else{const delta=(key:'height'|'top'|'stageHeight'|'scroll'|'page')=>Math.max(...frames.map(f=>f[key]))-Math.min(...frames.map(f=>f[key]));resolve({frames:frames.length,phrases:new Set(frames.map(f=>f.text)).size,maximumLines:Math.max(...frames.map(f=>f.lines)),samePhraseSizeChanges:frames.slice(1).filter((f,i)=>f.text===frames[i].text&&f.size!==frames[i].size).length,frameHeightDelta:delta('height'),stageTopDelta:delta('top'),stageHeightDelta:delta('stageHeight'),stageScrollDelta:delta('scroll'),pageScrollDelta:delta('page'),maxGlyphOverflow:Math.max(...frames.map(f=>f.overflow)),minSize:Math.min(...frames.map(f=>f.size)),progressIncreases:frames.slice(1).filter((f,i)=>f.progress>frames[i].progress).length});}
  };requestAnimationFrame(()=>requestAnimationFrame(sample));
 }),durationMs);
}
